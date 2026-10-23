import { createHash, randomUUID } from "node:crypto";
import {
  allTagsForNote,
  applyStringReplacement,
  assertFrontmatterKeyIsLiteral,
  extractLinks,
  frontmatterTags,
  inlineTags,
  normalizeTagList,
  parseFrontmatter,
  parseHeadings,
  patchBodySection,
  readNote,
  replaceVaultLinks,
  removeInlineTags,
  appendInlineTags,
  stringifyFrontmatter,
} from "./obsidian.js";
import { requestContext, requireRequestAuthor, stampFrontmatter } from "./request-context.js";
import { assertVaultBinding, currentMutationVaultScope, idempotencyDigest, readAppliedRecord, saveAppliedRecord } from "./mutation-idempotency.js";
import { atomicWriteBatch } from "./batch-write.js";
// Wave D / D-plans: the post-commit invalidation resolves the *selected* Vault's index instance
// through this lane's seam (never the primary facade, §11/§21 MV-I03).
import { invalidateSelectedVaultIndex } from "./plan-runtimes.js";
// Plan creation must resolve paths/revisions/versions against the request's VaultRuntime, not the
// primary facade, or a `vaultId=secondary` plan would target primary storage (Wave D / D-files,
// contract §10.1/§13.1). `exists` is root-free and stays on the facade.
import { exists } from "./vault.js";
import {
  allMarkdownFiles,
  fileRevision,
  readFileVersion,
  readTrashEntry,
  readLimitedText,
  resolveVaultPath,
  toVaultPath,
} from "./vault-runtime/request-vault.js";

const plans = new Map();
const appliedIdempotency = new Map();
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_PLANS = 200;

function hashText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sameAuthor(left, right) {
  return left?.agent === right?.agent && left?.model === right?.model
    && (left?.authClientId || null) === (right?.authClientId || null)
    && (left?.authUserId || null) === (right?.authUserId || null);
}

function currentIdentity() {
  return {
    ...requireRequestAuthor(),
    authClientId: requestContext()?.authClientId || null,
    authUserId: requestContext()?.authUserId || null,
  };
}

function cleanExpired() {
  const now = Date.now();
  for (const [id, plan] of plans) if (plan.expiresAtMs <= now) plans.delete(id);
  while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value);
  for (const [key, item] of appliedIdempotency) if (item.expiresAtMs <= now) appliedIdempotency.delete(key);
}

function diffValues(before = {}, after = {}) {
  const added = {};
  const removed = {};
  const modified = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (!Object.hasOwn(before, key)) added[key] = after[key];
    else if (!Object.hasOwn(after, key)) removed[key] = before[key];
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) modified[key] = { before: before[key], after: after[key] };
  }
  return { added, removed, modified };
}

function multisetDiff(before, after) {
  const left = new Map();
  const right = new Map();
  for (const value of before) left.set(value, (left.get(value) || 0) + 1);
  for (const value of after) right.set(value, (right.get(value) || 0) + 1);
  const added = [];
  const removed = [];
  for (const [value, count] of right) for (let i = left.get(value) || 0; i < count; i += 1) added.push(value);
  for (const [value, count] of left) for (let i = right.get(value) || 0; i < count; i += 1) removed.push(value);
  return { added, removed };
}

function headingKey(item) {
  return `${item.level}:${item.title}`;
}

function linkKey(item) {
  return `${item.type || item.syntax || "link"}:${item.target || item.link || item.raw || ""}`;
}

function tasks(content) {
  const output = [];
  const pattern = /^\s*[-*+]\s+\[([^\]])\]\s+(.*)$/gm;
  for (const match of content.matchAll(pattern)) output.push(`${match[1]}:${match[2].trim()}`);
  return output;
}

export function structuredDocumentDiff(beforeRaw, afterRaw, sourcePath = "") {
  const before = parseFrontmatter(beforeRaw);
  const after = parseFrontmatter(afterRaw);
  const beforeNote = { content: before.content, frontmatter: before.data };
  const afterNote = { content: after.content, frontmatter: after.data };
  return {
    frontmatter: diffValues(before.data, after.data),
    headings: multisetDiff(parseHeadings(before.content).map(headingKey), parseHeadings(after.content).map(headingKey)),
    links: multisetDiff(extractLinks(before.content, sourcePath).map(linkKey), extractLinks(after.content, sourcePath).map(linkKey)),
    tags: multisetDiff(allTagsForNote(beforeNote), allTagsForNote(afterNote)),
    tasks: multisetDiff(tasks(before.content), tasks(after.content)),
  };
}

export function unifiedDocumentDiff(beforeRaw, afterRaw, path, maxChars = 100000) {
  if (beforeRaw === afterRaw) return { diff: "", truncated: false };
  const before = beforeRaw.split("\n");
  const after = afterRaw.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const context = 3;
  const beforeStart = Math.max(0, prefix - context);
  const afterStart = Math.max(0, prefix - context);
  const beforeEnd = Math.min(before.length, before.length - suffix + context);
  const afterEnd = Math.min(after.length, after.length - suffix + context);
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -${beforeStart + 1},${beforeEnd - beforeStart} +${afterStart + 1},${afterEnd - afterStart} @@`];
  for (let index = beforeStart; index < prefix; index += 1) lines.push(` ${before[index]}`);
  for (let index = prefix; index < before.length - suffix; index += 1) lines.push(`-${before[index]}`);
  for (let index = prefix; index < after.length - suffix; index += 1) lines.push(`+${after[index]}`);
  const commonTail = Math.min(context, suffix);
  for (let index = 0; index < commonTail; index += 1) lines.push(` ${after[after.length - suffix + index]}`);
  const full = `${lines.join("\n")}\n`;
  if (full.length <= maxChars) return { diff: full, truncated: false };
  return { diff: `${full.slice(0, maxChars)}\n... diff truncated ...\n`, truncated: true };
}

export function compareDocuments(beforeRaw, afterRaw, path, maxChars = 100000) {
  const line = unifiedDocumentDiff(beforeRaw, afterRaw, path, maxChars);
  return {
    changed: beforeRaw !== afterRaw,
    beforeRevision: hashText(beforeRaw),
    afterRevision: hashText(afterRaw),
    ...line,
    summary: structuredDocumentDiff(beforeRaw, afterRaw, path),
  };
}

function candidateForChange(change, note, author) {
  if (change.operation === "delete") return { raw: null, details: null };
  if (change.operation === "raw") return { raw: change.raw, details: null };
  const existingFrontmatter = note?.frontmatter || {};
  const existingContent = note?.content || "";
  let frontmatter = existingFrontmatter;
  let content = existingContent;
  let details = null;

  if (change.operation === "write") {
    frontmatter = change.frontmatter || {};
    content = change.content || "";
  } else if (change.operation === "append") {
    content = change.section
      ? patchBodySection(existingContent, "heading", change.section, "append", change.content || "", Boolean(change.createTargetIfMissing))
      : `${existingContent.trimEnd()}\n${change.content || ""}\n`;
  } else if (change.operation === "patch") {
    if (change.targetType === "frontmatter") {
      assertFrontmatterKeyIsLiteral(change.target, { existing: existingFrontmatter });
      const current = existingFrontmatter[change.target];
      const value = change.patchOperation === "append" && current !== undefined
        ? `${current}${change.content || ""}`
        : change.patchOperation === "prepend" && current !== undefined
          ? `${change.content || ""}${current}`
          : change.content || "";
      frontmatter = { ...existingFrontmatter, [change.target]: value };
    } else {
      content = patchBodySection(existingContent, change.targetType, change.target, change.patchOperation || "append", change.content || "", Boolean(change.createTargetIfMissing));
    }
  } else if (change.operation === "replace") {
    const replaced = applyStringReplacement(existingContent, change.replacements || []);
    content = replaced.output;
    details = { replacements: replaced.details };
  } else if (change.operation === "frontmatter") {
    frontmatter = { ...existingFrontmatter };
    if (change.action === "set") {
      if (change.updates) frontmatter = { ...frontmatter, ...change.updates };
      if (change.key) {
        assertFrontmatterKeyIsLiteral(change.key, { existing: existingFrontmatter });
        frontmatter[change.key] = change.value;
      }
    } else if (change.action === "delete") {
      if (!change.key) throw new Error("key is required for frontmatter delete");
      assertFrontmatterKeyIsLiteral(change.key, { existing: existingFrontmatter, removing: true });
      delete frontmatter[change.key];
    } else if (change.action === "replace") {
      frontmatter = change.updates || {};
    } else {
      throw new Error(`Unsupported frontmatter action: ${change.action}`);
    }
  } else if (change.operation === "tags") {
    const normalized = normalizeTagList(change.tags || []);
    frontmatter = { ...existingFrontmatter };
    if (change.location === "frontmatter" || change.location === "both" || !change.location) {
      const current = frontmatterTags(existingFrontmatter);
      if (change.action === "add") frontmatter.tags = [...new Set([...current, ...normalized])];
      else if (change.action === "remove") frontmatter.tags = current.filter((tag) => !normalized.includes(tag));
      else if (change.action === "set") frontmatter.tags = normalized;
      else throw new Error(`Unsupported tag action: ${change.action}`);
    }
    if (change.location === "inline" || change.location === "both") {
      const current = inlineTags(existingContent);
      if (change.action === "add") content = appendInlineTags(existingContent, normalized);
      else if (change.action === "remove") content = removeInlineTags(existingContent, normalized);
      else if (change.action === "set") content = appendInlineTags(removeInlineTags(existingContent, current), normalized);
    }
  } else {
    throw new Error(`Unsupported note operation: ${change.operation}`);
  }

  return { raw: stringifyFrontmatter(stampFrontmatter(frontmatter, author), content), details };
}

function publicPlan(plan) {
  return {
    planId: plan.planId,
    planHash: plan.planHash,
    vaultId: plan.vaultId ?? null,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    changed: plan.changes.some((change) => change.changed),
    changes: plan.changes.map(({ candidateRaw: _candidateRaw, absPath: _absPath, ...change }) => change),
    warnings: plan.warnings,
  };
}

export async function createNotePlan(changes, options = {}) {
  cleanExpired();
  const author = currentIdentity();
  const maxDiffChars = options.maxDiffChars || 100000;
  const planned = [];
  const seen = new Set();
  for (const change of changes) {
    const absPath = resolveVaultPath(change.path, { assumeMarkdown: true });
    const vaultPath = toVaultPath(absPath);
    if (seen.has(vaultPath)) throw new Error(`Plan contains duplicate path: ${vaultPath}`);
    seen.add(vaultPath);
    const existed = await exists(absPath);
    if (existed && change.mustNotExist) throw new Error(`Revision conflict: ${vaultPath} already exists`);
    if (!existed && !change.mustNotExist) throw new Error(`mustNotExist=true is required to create ${vaultPath}`);
    if (existed && !change.baseRevision) throw new Error(`baseRevision is required for existing note: ${vaultPath}`);
    const note = existed ? await readNote(absPath) : null;
    if (note && note.revision !== change.baseRevision) throw new Error(`Revision conflict: expected ${change.baseRevision}, current ${note.revision}`);
    const candidate = candidateForChange(change, note, author);
    const beforeRaw = note?.raw || "";
    const comparison = compareDocuments(beforeRaw, candidate.raw ?? "", vaultPath, maxDiffChars);
    planned.push({
      path: vaultPath,
      operation: change.operation,
      existed,
      mustNotExist: Boolean(change.mustNotExist),
      baseRevision: note?.revision || null,
      candidateRevision: change.operation === "delete" ? null : comparison.afterRevision,
      changed: change.operation === "delete" || !existed || comparison.changed || Boolean(change.consumeTrash),
      deleted: change.operation === "delete",
      trash: Boolean(change.trash),
      sourceTrash: change.sourceTrash || null,
      sourceRevision: change.sourceRevision || null,
      consumeTrash: Boolean(change.consumeTrash),
      diff: comparison.diff,
      truncated: comparison.truncated,
      summary: comparison.summary,
      details: candidate.details,
      candidateRaw: candidate.raw,
      absPath,
    });
  }
  const planId = randomUUID();
  const createdAtMs = Date.now();
  const expiresAtMs = createdAtMs + Math.max(60_000, Math.min(30 * 60 * 1000, options.ttlMs || DEFAULT_TTL_MS));
  const planHash = hashText(JSON.stringify(planned.map((item) => ({ path: item.path, baseRevision: item.baseRevision,
    candidateRevision: item.candidateRevision, sourceTrash: item.sourceTrash,
    sourceRevision: item.sourceRevision, consumeTrash: item.consumeTrash }))));
  const plan = {
    planId,
    planHash,
    vaultId: currentMutationVaultScope().vaultId,
    author,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    changes: planned,
    warnings: planned.some((item) => item.truncated) ? ["One or more line diffs were truncated; candidate hashes cover the complete content."] : [],
  };
  plans.set(planId, plan);
  return publicPlan(plan);
}

export async function createMovePlan({ from, to, overwrite = false, updateLinks = true, ifMatch }, options = {}) {
  const fromAbs = resolveVaultPath(from, { assumeMarkdown: true });
  const toAbs = resolveVaultPath(to, { assumeMarkdown: true });
  const fromRel = toVaultPath(fromAbs);
  const toRel = toVaultPath(toAbs);
  if (fromRel === toRel) throw new Error("Move source and destination must differ");
  const source = await readNote(fromAbs);
  if (ifMatch && ifMatch !== source.revision) throw new Error(`Revision conflict: expected ${ifMatch}, current ${source.revision}`);
  const destinationExists = await exists(toAbs);
  if (destinationExists && !overwrite) throw new Error("Destination exists. Set overwrite=true to replace it.");
  const changes = [
    { path: fromRel, operation: "delete", baseRevision: source.revision },
    { path: toRel, operation: "raw", raw: source.raw,
      ...(destinationExists ? { baseRevision: await fileRevision(toAbs) } : { mustNotExist: true }) },
  ];
  if (updateLinks) {
    for (const abs of await allMarkdownFiles()) {
      const rel = toVaultPath(abs);
      if (rel === fromRel || rel === toRel) continue;
      const raw = await readLimitedText(abs);
      const next = replaceVaultLinks(raw, fromRel, toRel, rel);
      if (next !== raw) changes.push({ path: rel, operation: "raw", raw: next, baseRevision: await fileRevision(abs) });
      if (changes.length > 25) throw new Error("Move affects more than 25 notes; narrow the move before applying");
    }
  }
  return createNotePlan(changes, options);
}

export async function createDeletePlan({ path: notePath, backup = true, ifMatch }, options = {}) {
  const abs = resolveVaultPath(notePath, { assumeMarkdown: true });
  const note = await readNote(abs);
  if (ifMatch && ifMatch !== note.revision) throw new Error(`Revision conflict: expected ${ifMatch}, current ${note.revision}`);
  return createNotePlan([{ path: toVaultPath(abs), operation: "delete", baseRevision: note.revision, trash: backup }], options);
}

export async function createRestoreVersionPlan({ versionId, destination, overwrite = false, ifMatch }, options = {}) {
  // A planned restore must preserve the exact version bytes. Reject malformed
  // UTF-8 instead of showing a lossy preview and writing replacement glyphs.
  const source = await readFileVersion(versionId);
  const abs = resolveVaultPath(destination || source.path, { assumeMarkdown: true });
  const path = toVaultPath(abs);
  if (!path.toLowerCase().endsWith(".md")) throw new Error("Planned version restore supports Markdown notes only");
  const version = await readFileVersion(versionId, { strictText: true });
  const existed = await exists(abs);
  if (existed && !overwrite) throw new Error("Restore destination exists. Set overwrite=true to replace it.");
  const currentRevision = existed ? await fileRevision(abs) : null;
  if (ifMatch && currentRevision !== ifMatch) throw new Error(`Revision conflict: expected ${ifMatch}, current ${currentRevision}`);
  return createNotePlan([{ path, operation: "raw", raw: version.content,
    ...(existed ? { baseRevision: currentRevision } : { mustNotExist: true }) }], options);
}

export async function createRestoreTrashPlan({ backupPath, destination, overwrite = false, removeBackup = false, ifMatch }, options = {}) {
  const source = await readTrashEntry(backupPath);
  const abs = resolveVaultPath(destination || source.originalPath, { assumeMarkdown: true });
  const path = toVaultPath(abs);
  if (!path.toLowerCase().endsWith(".md")) throw new Error("Planned Trash restore supports Markdown notes only");
  const backup = await readTrashEntry(backupPath, { strictText: true });
  const existed = await exists(abs);
  if (existed && !overwrite) throw new Error("Restore destination exists. Set overwrite=true to replace it.");
  const currentRevision = existed ? await fileRevision(abs) : null;
  if (ifMatch && currentRevision !== ifMatch) throw new Error(`Revision conflict: expected ${ifMatch}, current ${currentRevision}`);
  return createNotePlan([{ path, operation: "raw", raw: backup.content,
    sourceTrash: backup.backupPath, sourceRevision: backup.revision, consumeTrash: removeBackup,
    ...(existed ? { baseRevision: currentRevision } : { mustNotExist: true }) }], options);
}

export function getNotePlan(planId) {
  cleanExpired();
  const plan = plans.get(planId);
  if (!plan) throw new Error("Plan not found or expired");
  // §13.1 P0 gate: the selected request Vault must equal the plan's Vault. Checked
  // before the author check and before any I/O, so a cross-Vault get reaches no file.
  assertVaultBinding(plan.vaultId, currentMutationVaultScope().vaultId);
  if (!sameAuthor(plan.author, currentIdentity())) throw new Error("Plan belongs to another MCP author");
  return publicPlan(plan);
}

// Internal batch hooks support isolated crash tests; MCP callers supply only the first three arguments.
export async function applyNotePlan(planId, planHash, idempotencyKey, batchHooks = {}) {
  cleanExpired();
  if (!idempotencyKey) throw new Error("idempotencyKey is required");
  const author = currentIdentity();
  const scope = currentMutationVaultScope();
  const digest = idempotencyDigest(idempotencyKey);
  // §13.1 P0 gate: a still-live plan must belong to the selected request Vault.
  // Checked before the durable replay read, so a cross-Vault apply performs 0 I/O.
  const livePlan = plans.get(planId);
  if (livePlan) assertVaultBinding(livePlan.vaultId, scope.vaultId);
  const replayKey = `${scope.vaultId ?? ""}\u0000${idempotencyKey}`;
  const replay = appliedIdempotency.get(replayKey) || await readAppliedRecord(digest, { scope });
  if (replay) {
    assertVaultBinding(replay.vaultId, scope.vaultId);
    if (replay.planId !== planId || replay.planHash !== planHash) throw new Error("idempotencyKey was already used for another plan");
    if (!sameAuthor(replay.author, author)) throw new Error("idempotencyKey belongs to another MCP author");
    return { ...replay.result, idempotentReplay: true };
  }
  const plan = plans.get(planId);
  if (!plan) throw new Error("Plan not found or expired");
  assertVaultBinding(plan.vaultId, scope.vaultId);
  if (plan.planHash !== planHash) throw new Error("Plan hash mismatch");
  if (!sameAuthor(plan.author, author)) throw new Error("Plan belongs to another MCP author");
  for (const item of plan.changes.filter((change) => !change.changed)) {
    const currentExists = await exists(item.absPath);
    if (item.mustNotExist ? currentExists : !currentExists) throw new Error(`Revision conflict: ${item.path} existence changed`);
    if (currentExists && await fileRevision(item.absPath) !== item.baseRevision) {
      throw new Error(`Revision conflict: ${item.path} changed after planning`);
    }
    if (item.sourceTrash) {
      let source;
      try {
        source = await readTrashEntry(item.sourceTrash);
      } catch (error) {
        if (error?.code === "ENOENT") throw new Error(`Trash source revision conflict: ${item.sourceTrash}`);
        throw error;
      }
      if (source.revision !== item.sourceRevision) throw new Error(`Trash source revision conflict: ${item.sourceTrash}`);
    }
  }
  const changed = plan.changes.filter((item) => item.changed);
  const unchanged = plan.changes.filter((item) => !item.changed).map((item) => item.path);
  const appliedAt = new Date().toISOString();
  const record = { digest, vaultId: scope.vaultId, planId, planHash, author, unchanged, appliedAt, expiresAtMs: Date.now() + 24 * 60 * 60 * 1000 };
  let results = [];
  try {
    results = changed.length ? await atomicWriteBatch(changed.map((item) => ({
    absPath: item.absPath,
    ...(item.deleted ? { delete: true, trash: item.trash } : { data: item.candidateRaw }),
    encoding: "utf-8",
    ifMatch: item.baseRevision || undefined,
    mustNotExist: item.mustNotExist,
    sourceTrash: item.sourceTrash || undefined,
    sourceRevision: item.sourceRevision || undefined,
    consumeTrash: item.consumeTrash,
    })), { ...batchHooks, idempotency: record }) : [];
  } catch (error) {
    if (error?.code !== "IDEMPOTENCY_ALREADY_APPLIED") throw error;
    const committed = await readAppliedRecord(digest, { scope });
    if (!committed || committed.planId !== planId || committed.planHash !== planHash ||
        !sameAuthor(committed.author, author)) throw error;
    return { ...committed.result, idempotentReplay: true };
  }
  invalidateSelectedVaultIndex(results.map((item) => item.path));
  const result = {
    planId,
    planHash,
    applied: true,
    idempotentReplay: false,
    changed: results,
    unchanged,
    appliedAt,
  };
  if (!changed.length) await saveAppliedRecord({ ...record, result }, { scope });
  appliedIdempotency.set(replayKey, { ...record, result });
  plans.delete(planId);
  return result;
}

export async function getNoteVersion(versionId, maxChars = 100000) {
  const version = await readFileVersion(versionId);
  const truncated = version.content.length > maxChars;
  return {
    ...version,
    content: truncated ? version.content.slice(0, maxChars) : version.content,
    revision: hashText(version.content),
    truncated,
  };
}

async function resolveComparisonSource(source) {
  if (source.kind === "current") {
    const note = await readNote(resolveVaultPath(source.path, { assumeMarkdown: true }));
    return { path: note.path, raw: note.raw, revision: note.revision };
  }
  if (source.kind === "version") {
    const version = await readFileVersion(source.versionId);
    return { path: version.path, raw: version.content, revision: hashText(version.content), versionId: version.versionId };
  }
  if (source.kind === "candidate") {
    const raw = stringifyFrontmatter(source.frontmatter || {}, source.content || "");
    return { path: source.path || "candidate.md", raw, revision: hashText(raw) };
  }
  throw new Error(`Unsupported comparison source: ${source.kind}`);
}

export async function compareNoteSources(left, right, maxChars = 100000) {
  const [before, after] = await Promise.all([resolveComparisonSource(left), resolveComparisonSource(right)]);
  const path = after.path || before.path;
  return {
    path,
    left: { kind: left.kind, path: before.path, revision: before.revision, versionId: before.versionId },
    right: { kind: right.kind, path: after.path, revision: after.revision, versionId: after.versionId },
    ...compareDocuments(before.raw, after.raw, path, maxChars),
  };
}
