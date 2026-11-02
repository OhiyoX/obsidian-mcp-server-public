// Protocol-neutral note-context builder.
//
// This module owns the Context API Phase 0/1 contract. It performs no MCP
// registration and returns a plain object; `tools/context.js` is the thin MCP
// adapter. Vault-derived text is always reference data (`untrusted_reference`),
// never instructions. Server policy is returned separately and cannot be
// overridden by note content.
//
// Budget rule: every Vault-derived textual payload/excerpt/metadata value is
// counted in Unicode codepoints. Paths, revisions, structural flags, budget
// counters, warning codes and server policy are excluded.

import fs from "node:fs/promises";
import { MAX_READ_BYTES } from "./config.js";
import { hashBuffer, readFileWithinCap } from "./bounded-read.js";
import { documentMap, parseFrontmatter } from "./obsidian.js";
import { relatedWithFallback, boundedErrorMessage } from "./related-notes.js";
// Wave D / D-intelligence (§29 context lane): root-bound primitives come from the request-aware
// facade (D-files seam) and index/retrieval facts from the selected Vault's composed search
// runtime (D-search seam); a `vaultId=secondary` call never touches the primary Vault (§47).
import { resolveSearchRuntime } from "./search-runtimes.js";
import { assertCanonicalInsideVault, normalizeNotePath, resolveVaultPath, stripMarkdownExtension } from "./vault-runtime/request-vault.js";

export const CONTEXT_POLICY_VERSION = "1.0.0";
export const CONTEXT_COUNTING = "vault-text-codepoints";
export const CONTEXT_TRUST = "untrusted_reference";
export const DEFAULT_MAX_CHARS = 12000;
export const HARD_MAX_CHARS = 32000;
export const DEFAULT_MAX_ITEMS = 20;
export const HARD_MAX_ITEMS = 64;

// Internal adapter ceiling. Never larger than the existing read limit so a
// target note is never read past the configured server maximum.
export const TARGET_READ_CEILING_BYTES = Math.min(128 * 1024, MAX_READ_BYTES);

const MAX_EXCERPT_CODEPOINTS = 400;
const MAX_METADATA_HEADINGS = 12;
const MAX_METADATA_TAGS = 12;
const MAX_METADATA_FIELD_CHARS = 120;
const MAX_FRONTMATTER_FIELDS = 24;
const MAX_WARNINGS = 8;
const MAX_LINK_SCAN = 100000;

const POLICY = Object.freeze({ source: "server", version: CONTEXT_POLICY_VERSION });

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function clip(value, maxChars) {
  const text = String(value ?? "").trim();
  const points = [...text];
  return points.length <= maxChars ? text : points.slice(0, maxChars).join("");
}

function baseName(notePath) {
  return stripMarkdownExtension(String(notePath).split("/").pop() || "");
}

function spendText(value, state) {
  const text = value == null ? "" : String(value);
  if (!text) return "";
  const remaining = state.maxChars - state.usedChars;
  if (remaining <= 0) {
    state.truncated = true;
    state.budgetExhausted = true;
    return "";
  }
  const points = [...text];
  if (points.length <= remaining) {
    state.usedChars += points.length;
    return text;
  }
  state.truncated = true;
  state.budgetExhausted = true;
  const clipped = points.slice(0, remaining).join("");
  state.usedChars += [...clipped].length;
  return clipped;
}

function spendList(values, maxCount, maxChars, state) {
  const output = [];
  for (const value of (values || []).slice(0, maxCount)) {
    const spent = spendText(clip(value, maxChars), state);
    if (!spent && state.usedChars >= state.maxChars) break;
    output.push(spent);
  }
  return output;
}

function addWarning(warnings, code, message) {
  if (warnings.length >= MAX_WARNINGS) return;
  warnings.push({ code, message });
}

function metadataFromNote(note, stat) {
  const frontmatter = note.frontmatter || {};
  const map = documentMap(note);
  return {
    title: frontmatter.title || baseName(note.path),
    type: frontmatter.type || "",
    tags: map.tags,
    headings: map.headings.map((heading) => heading.title),
    frontmatterFields: Object.keys(frontmatter),
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

function metadataFromRecord(record, stat) {
  const frontmatter = record.frontmatter || {};
  return {
    title: frontmatter.title || baseName(record.path),
    type: frontmatter.type || "",
    tags: record.tags || [],
    headings: (record.headings || []).map((heading) => heading.title),
    frontmatterFields: Object.keys(frontmatter),
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

function spendMetadata(metadata, state) {
  return {
    title: spendText(clip(metadata.title, MAX_METADATA_FIELD_CHARS), state),
    type: spendText(clip(metadata.type, 80), state),
    tags: spendList(metadata.tags, MAX_METADATA_TAGS, 60, state),
    headings: spendList(metadata.headings, MAX_METADATA_HEADINGS, MAX_METADATA_FIELD_CHARS, state),
    frontmatterFields: spendList(metadata.frontmatterFields, MAX_FRONTMATTER_FIELDS, 60, state),
    size: metadata.size ?? null,
    modified: metadata.modified ?? null,
  };
}

function collectBacklinks(index, targetPath, limit) {
  const links = [];
  let omittedAmbiguous = 0;
  let scanned = 0;
  let scanCapped = false;
  for (const record of index.records) {
    if (record.path === targetPath) continue;
    for (const link of record.links) {
      scanned += 1;
      if (scanned > MAX_LINK_SCAN) {
        scanCapped = true;
        break;
      }
      const resolution = index.resolveLink(link, record.path);
      const candidates = Array.isArray(resolution.candidates) ? resolution.candidates : [];
      // Ambiguity is checked before the provisional best-match path: an
      // ambiguous link that names the target among its candidates is omitted
      // even when the resolver's provisional `path` picked a different note.
      const referencesTarget = resolution.path === targetPath || candidates.includes(targetPath);
      if (!referencesTarget) continue;
      if (resolution.status === "ambiguous") {
        omittedAmbiguous += 1;
        continue;
      }
      links.push({ path: record.path, revision: record.revision, record, link });
      break;
    }
    if (scanCapped || links.length >= limit) break;
  }
  return { links, omittedAmbiguous, scanCapped };
}

function buildBacklinkItem(candidate, state, warnings) {
  const excerptStart = candidate.link?.start ?? 0;
  const excerpt = candidate.record.content.slice(excerptStart, excerptStart + MAX_EXCERPT_CODEPOINTS);
  const revision = candidate.revision || null;
  if (!revision) addWarning(warnings, "source_revision_unavailable", `No snapshot revision was available for ${candidate.path}.`);
  return {
    id: `backlink:${candidate.path}`,
    kind: "backlink",
    path: candidate.path,
    revision,
    revisionSource: revision ? "vault_index_snapshot" : null,
    trust: CONTEXT_TRUST,
    reason: "incoming_link",
    score: null,
    linkType: candidate.link?.type || "link",
    excerpt: spendText(clip(excerpt, MAX_EXCERPT_CODEPOINTS), state),
    metadata: spendMetadata({
      title: candidate.record.frontmatter?.title || candidate.record.basename,
      type: candidate.record.frontmatter?.type || "",
      tags: candidate.record.tags || [],
      headings: [],
      frontmatterFields: [],
      size: candidate.record.stat?.size ?? null,
      modified: candidate.record.stat?.modified ?? null,
    }, state),
  };
}

function buildRelatedItem(result, state, revision, warnings) {
  const chunk = Array.isArray(result.chunks) ? result.chunks[0] : null;
  const resolvedRevision = revision || result.revision || null;
  if (!resolvedRevision) addWarning(warnings, "source_revision_unavailable", `No snapshot revision was available for ${result.path}.`);
  return {
    id: `related:${result.path}`,
    kind: "related",
    path: result.path,
    revision: resolvedRevision,
    revisionSource: resolvedRevision ? "vault_index_snapshot" : null,
    trust: CONTEXT_TRUST,
    reason: "content_similarity",
    score: typeof result.score === "number" ? result.score : null,
    directlyLinked: Boolean(result.directlyLinked),
    excerpt: spendText(clip(chunk?.text || "", MAX_EXCERPT_CODEPOINTS), state),
    metadata: spendMetadata({
      title: result.metadata?.title || baseName(result.path),
      type: result.metadata?.type || "",
      tags: result.metadata?.tags || [],
      headings: chunk?.heading ? [chunk.heading] : [],
      frontmatterFields: [],
      size: null,
      modified: result.metadata?.updated || null,
    }, state),
  };
}

async function defaultLoadRelated(targetPath, options, runtime) {
  const { index, targetRecord, ...rest } = options;
  if (!index || !targetRecord) {
    return { path: targetPath, results: [], semanticRequested: rest.semantic !== false, semanticUsed: false, lexicalFallback: false, semanticError: null, error: "Vault index snapshot unavailable" };
  }
  // The snapshot-only recall of *this* Vault, so a related lookup can never rank another Vault's
  // chunks (the compatibility facade would silently use the primary instance).
  return relatedWithFallback(targetRecord, index, rest, { recall: runtime.retrieval.recallFromSnapshot });
}

// Per-Vault dependencies: every Vault-derived fact (cached index snapshot, related ranking,
// retrieval status) is read from this runtime; only the read primitives/`MAX_READ_BYTES` are shared.
function dependenciesFor(runtime) {
  return {
    stat: (absPath) => fs.stat(absPath),
    // *This* Vault's canonical opener: the shared facade is primary-bound (§10.1).
    readTargetBounded: (absPath, capBytes) => readFileWithinCap(absPath, capBytes, runtime.vaultRuntime.localFs.openCanonicalVaultFile),
    loadCachedIndex: () => runtime.index.getCachedVaultIndex(),
    loadRelated: (targetPath, options) => defaultLoadRelated(targetPath, options, runtime),
    indexStatus: () => runtime.retrieval.retrievalIndexStatusSnapshot(),
  };
}

function notFoundResult(targetPath, state) {
  return {
    status: "not_found",
    path: targetPath,
    resolvedPath: null,
    revision: null,
    items: [],
    sources: [],
    warnings: [],
    truncated: false,
    budget: {
      maxChars: state.maxChars,
      usedChars: state.usedChars,
      maxItems: state.maxItems,
      usedItems: state.usedItems,
      counting: CONTEXT_COUNTING,
    },
    index: null,
    policy: POLICY,
  };
}

export async function buildNoteContext(input = {}, overrides = {}) {
  // Resolved before any dependency runs: a Vault selection this process has no runtime for is
  // refused structurally (never served by the primary Vault) and performs zero Vault I/O (§47).
  const dependencies = { ...dependenciesFor(resolveSearchRuntime()), ...overrides };
  const rawPath = String(input.path ?? "").trim();
  if (!rawPath) throw new Error("Note context requires a vault-relative path");

  const state = {
    maxChars: clampInteger(input.maxChars, DEFAULT_MAX_CHARS, 1, HARD_MAX_CHARS),
    usedChars: 0,
    truncated: false,
    budgetExhausted: false,
    maxItems: clampInteger(input.maxItems, DEFAULT_MAX_ITEMS, 1, HARD_MAX_ITEMS),
    usedItems: 0,
  };
  const includeBacklinks = input.includeBacklinks !== false;
  const includeRelated = input.includeRelated === true;
  const semantic = input.semantic !== false;
  const warnings = [];
  const items = [];
  const sources = [];

  const targetPath = normalizeNotePath(rawPath);
  const targetAbs = resolveVaultPath(targetPath);
  // Canonical boundary before any target stat/open: a final-name symlink or an
  // intermediate directory symlink that resolves outside the Vault must never
  // be stat'd, read or hashed. `allowMissing` keeps a genuinely missing note on
  // the not_found path instead of turning it into a traversal error.
  await assertCanonicalInsideVault(targetAbs, { allowMissing: true });

  let stat;
  try {
    stat = await dependencies.stat(targetAbs);
  } catch (error) {
    if (error?.code === "ENOENT") return notFoundResult(targetPath, state);
    throw error;
  }
  if (!stat.isFile()) return notFoundResult(targetPath, state);

  let index = null;
  if (includeBacklinks || includeRelated) {
    try {
      index = await dependencies.loadCachedIndex();
    } catch {
      index = null;
    }
    if (!index) addWarning(warnings, "index_unavailable", "Vault index snapshot unavailable; backlinks and related notes were omitted.");
  }
  const revisionByPath = index ? new Map(index.records.map((entry) => [entry.path, entry.revision])) : new Map();

  let read;
  try {
    read = await dependencies.readTargetBounded(targetAbs, TARGET_READ_CEILING_BYTES);
  } catch (error) {
    if (error?.code === "ENOENT") return notFoundResult(targetPath, state);
    throw error;
  }
  const tooLarge = read.tooLarge === true;
  if (tooLarge) addWarning(warnings, "target_note_too_large", `Target note exceeds the ${TARGET_READ_CEILING_BYTES}-byte read ceiling; only bounded metadata was read.`);

  const changed = read.changed === true;
  const snapshotStat = read.stat ?? stat;
  const record = index?.records?.find((entry) => entry.path === targetPath) || null;
  let targetNote = null;
  let revision = null;
  if (!tooLarge) {
    const raw = read.data.toString("utf8");
    const parsed = parseFrontmatter(raw);
    // Hash only a complete, mutation-free read; a handle that changed during
    // the read must not claim a full-content revision.
    if (!changed) revision = hashBuffer(read.data);
    targetNote = { path: targetPath, raw, content: parsed.content, frontmatter: parsed.data };
  } else {
    addWarning(warnings, "revision_unavailable", "The target note was not read in full, so no exact revision is reported.");
  }
  if (changed) {
    addWarning(warnings, "target_changed_during_read", "The target note changed while it was being read; no complete-content revision is reported and metadata reflects the read-time handle snapshot.");
  }

  // Metadata always uses the handle-level fstat snapshot, never the earlier
  // path-level stat, so a concurrent mutation cannot yield stale size/mtime.
  const metadata = targetNote ? metadataFromNote(targetNote, snapshotStat)
    : record ? metadataFromRecord(record, snapshotStat)
      : { title: baseName(targetPath), type: "", tags: [], headings: [], frontmatterFields: [], size: snapshotStat.size, modified: snapshotStat.mtime.toISOString() };
  items.push({
    id: `target:${targetPath}`,
    kind: "target",
    path: targetPath,
    revision,
    revisionSource: revision ? "bounded_note_read" : null,
    trust: CONTEXT_TRUST,
    reason: "target",
    score: null,
    metadata: spendMetadata(metadata, state),
  });
  state.usedItems = 1;

  if (includeBacklinks && index) {
    const remaining = Math.max(0, state.maxItems - state.usedItems);
    const { links, omittedAmbiguous, scanCapped } = collectBacklinks(index, targetPath, remaining + 1);
    if (omittedAmbiguous) addWarning(warnings, "ambiguous_link_omitted", `${omittedAmbiguous} ambiguous link(s) to the target were omitted.`);
    if (scanCapped) {
      state.truncated = true;
      addWarning(warnings, "index_scan_truncated", "Link scan cap reached before all backlinks were examined.");
    }
    if (links.length > remaining) {
      state.truncated = true;
      addWarning(warnings, "backlinks_truncated", "Backlink limit reached; some backlinks were omitted.");
    }
    for (const candidate of links) {
      if (state.usedItems >= state.maxItems) break;
      items.push(buildBacklinkItem(candidate, state, warnings));
      state.usedItems += 1;
    }
  }

  let related = null;
  let relatedError = false;
  if (includeRelated) {
    const targetRecord = index?.records?.find((entry) => entry.path === targetPath) || null;
    try {
      related = await dependencies.loadRelated(targetPath, {
        semantic,
        limit: Math.max(1, state.maxItems - state.usedItems) + 1,
        snippetLength: MAX_EXCERPT_CODEPOINTS,
        index,
        targetRecord,
      });
      if (!related || !Array.isArray(related.results)) throw new Error("Related result is invalid");
    } catch {
      related = null;
    }
    relatedError = !related || Boolean(related.error);
    if (relatedError) {
      state.truncated = true;
      addWarning(warnings, "related_unavailable", "Related notes could not be computed; the note and backlinks are still returned.");
    } else {
      if (related.semanticRequested && related.semanticUsed === false) {
        addWarning(warnings, "semantic_degraded_to_lexical", "Semantic retrieval was unavailable; deterministic lexical ranking was used.");
      }
      const remaining = related.results.filter((result) => result.path !== targetPath);
      if (remaining.length > Math.max(0, state.maxItems - state.usedItems)) {
        state.truncated = true;
        addWarning(warnings, "related_truncated", "Related-note limit reached; some related notes were omitted.");
      }
      for (const result of remaining) {
        if (state.usedItems >= state.maxItems) break;
        items.push(buildRelatedItem(result, state, revisionByPath.get(result.path), warnings));
        state.usedItems += 1;
      }
    }
  }

  // Provenance only: one entry per emitted item, no duplicated item text.
  for (const item of items) {
    sources.push({
      id: item.id,
      kind: item.kind,
      path: item.path,
      revision: item.revision ?? null,
      revisionSource: item.revisionSource ?? null,
      trust: CONTEXT_TRUST,
      reason: item.reason,
      score: item.score ?? null,
    });
  }

  if (state.budgetExhausted) {
    if (warnings.length >= MAX_WARNINGS) warnings.splice(MAX_WARNINGS - 1, 1);
    addWarning(warnings, "budget_exhausted", "Character budget reached; some Vault-derived text was truncated.");
  }

  let indexMetadata = null;
  if (includeRelated) {
    const relatedMeta = related && !relatedError ? related : {
      semanticRequested: related?.semanticRequested ?? semantic !== false,
      semanticUsed: related?.semanticUsed === true,
      lexicalFallback: related?.lexicalFallback === true,
      semanticError: related?.semanticError ?? related?.error ?? null,
    };
    let status = null;
    try {
      status = await dependencies.indexStatus();
    } catch {
      status = null;
    }
    indexMetadata = {
      available: Boolean(status),
      updatedAt: status?.updatedAt ?? null,
      notes: status?.notes ?? null,
      chunks: status?.chunks ?? null,
      embeddedChunks: status?.embeddedChunks ?? null,
      embeddingModel: status?.embeddingModel ?? null,
      semanticEnabled: status ? status.semantic?.enabled === true : null,
      semanticRequested: relatedMeta.semanticRequested === true,
      semanticUsed: relatedMeta.semanticUsed === true,
      lexicalFallback: relatedMeta.lexicalFallback === true,
      semanticError: boundedErrorMessage(relatedMeta.semanticError),
    };
  }

  const status = tooLarge || state.truncated || warnings.length ? "partial" : "ok";
  return {
    status,
    path: targetPath,
    resolvedPath: targetPath,
    revision,
    items,
    sources,
    warnings,
    truncated: state.truncated,
    budget: {
      maxChars: state.maxChars,
      usedChars: state.usedChars,
      maxItems: state.maxItems,
      usedItems: state.usedItems,
      counting: CONTEXT_COUNTING,
    },
    index: indexMetadata,
    policy: POLICY,
  };
}
