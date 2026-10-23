import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_PATH, HISTORY_PATH, MAX_VERSIONS_PER_FILE, TRASH_PATH, VAULT, VERSION_HISTORY_ENABLED } from "./config.js";
import { trackGitMutation } from "./git.js";
import {
  assertVaultBinding,
  currentMutationVaultScope,
  primaryMutationVaultScope,
  pruneExpiredAppliedRecords,
  resolveMutationJournalScope,
  saveAppliedRecord,
  vaultContextMismatch,
} from "./mutation-idempotency.js";
// `assertCanonicalInsideRoot` / `exists` are root-free; the startup recovery lock stays the primary
// one (§20.1). The trash-relative path follows the request's Vault so a secondary journal reports
// its own quarantine location (Wave D / D-files, contract §10.1).
import { assertCanonicalInsideRoot, exists, withMutationLock } from "./vault.js";
import { toTrashPath } from "./vault-runtime/request-vault.js";

const root = path.join(DATA_PATH, "mutation-journal");
const digest = (data) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

// §13.3 schema bump: the manifest records its owning Vault so recovery can never
// interpret a secondary journal against primary roots. Legacy schema 1 stays
// readable and is primary-only (§22.4, §49.4 rollback safety).
export const JOURNAL_SCHEMA = 2;

function journalRootFor(scope) {
  if (scope?.journalRoot) return scope.journalRoot;
  if (!scope || scope.primary || !scope.key) return root;
  return path.join(root, scope.key);
}

// Primary keeps today's legacy roots; a registered secondary supplies its own.
function scopeRoots(scope) {
  return {
    vaultRoot: scope?.vaultRoot || VAULT,
    trashRoot: scope?.trashRoot || TRASH_PATH,
    historyRoot: scope?.historyRoot || HISTORY_PATH,
  };
}

function assertInsideScopeRoot(rootPath, candidate) {
  const relative = path.relative(rootPath, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path traversal denied");
}

// `fileRevision` from the vault façade is bound to the primary root, so a
// secondary Vault needs its own containment-checked revision.
async function scopeFileRevision(absPath, vaultRoot) {
  const canonical = await assertCanonicalInsideRoot(vaultRoot, absPath);
  return `sha256:${createHash("sha256").update(await fs.readFile(canonical)).digest("hex")}`;
}

function assertManifestVault(manifest, scope) {
  if (manifest.schema === 1 && (manifest.vaultId ?? null) !== null) throw vaultContextMismatch(null, manifest.vaultId);
  assertVaultBinding(manifest.vaultId ?? null, scope.vaultId ?? null);
}

async function syncDir(dir) {
  if (process.platform === "win32") return;
  const handle = await fs.open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function durableFile(file, data) {
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

async function save(dir, manifest) {
  const temp = path.join(dir, `manifest-${randomUUID()}.tmp`);
  await durableFile(temp, JSON.stringify(manifest));
  await fs.rename(temp, path.join(dir, "manifest.json"));
  await syncDir(dir);
}

export async function beginBatchJournal(entries, idempotency, options = {}) {
  const scope = options.scope || currentMutationVaultScope();
  const journalRoot = journalRootFor(scope);
  await fs.mkdir(journalRoot, { recursive: true, mode: 0o700 });
  if (journalRoot !== root) await syncDir(root);
  const dir = path.join(journalRoot, randomUUID());
  const historyName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${path.basename(dir)}.bak`;
  await fs.mkdir(dir, { mode: 0o700 });
  await syncDir(journalRoot);
  const manifest = {
    schema: JOURNAL_SCHEMA, vaultId: scope.vaultId ?? null, state: "prepared",
    idempotency: idempotency || null,
    entries: entries.map((item, index) => ({
      path: item.rel,
      existed: item.existed,
      delete: Boolean(item.delete),
      trash: item.trashRel,
      consumeTrash: item.consumeTrash ? { path: item.sourceTrash, revision: item.sourceRevision } : null,
      before: item.original === null ? null : digest(item.original),
      after: item.delete ? null : digest(Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data, item.encoding || "utf-8")),
      backup: `backup-${index}`,
      temp: path.basename(item.tempPath),
      history: Boolean(item.existed && VERSION_HISTORY_ENABLED && !item.skipHistory),
      historyName,
    })),
  };
  try {
    for (const [index, item] of entries.entries()) {
      if (item.existed) await durableFile(path.join(dir, `backup-${index}`), item.original);
    }
    await syncDir(dir);
    // No Vault file may be staged or renamed until this manifest is durable.
    await save(dir, manifest);
    return { dir, manifest, scope };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function setBatchJournalState(journal, state, result) {
  if (!["committing", "committed"].includes(state)) throw new Error("Invalid journal state");
  await save(journal.dir, { ...journal.manifest, state, ...(result ? { result } : {}) });
  journal.manifest.state = state;
  if (result) journal.manifest.result = result;
}

function itemPaths(dir, item, scope) {
  if (typeof item.path !== "string" || !item.path || item.path.includes("\\") || path.isAbsolute(item.path)) throw new Error("Invalid journal path");
  if (typeof item.temp !== "string" || !/^\.[^/\\]+\.obsidian-mcp-batch-[0-9a-f-]+\.tmp$/.test(item.temp)) throw new Error("Invalid journal temp");
  if (typeof item.backup !== "string" || !/^backup-\d+$/.test(item.backup)) throw new Error("Invalid journal backup");
  if (item.history && (typeof item.historyName !== "string" || !/^[0-9TZ-]+-[0-9a-f-]{36}\.bak$/.test(item.historyName))) throw new Error("Invalid history name");
  if (item.delete && (!item.existed || item.after !== null)) throw new Error("Invalid journal delete entry");
  if (item.trash && (!item.delete || typeof item.trash !== "string" ||
      item.trash.includes("\\") || path.isAbsolute(item.trash) ||
      item.trash.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error("Invalid journal trash path");
  if (item.consumeTrash && (item.delete || typeof item.consumeTrash.path !== "string" ||
      item.consumeTrash.path.includes("\\") || path.isAbsolute(item.consumeTrash.path) ||
      item.consumeTrash.path.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^sha256:[0-9a-f]{64}$/.test(item.consumeTrash.revision))) throw new Error("Invalid journal consumed Trash source");
  const { vaultRoot, trashRoot } = scopeRoots(scope);
  const target = path.resolve(vaultRoot, item.path);
  const temp = path.join(path.dirname(target), item.temp);
  assertInsideScopeRoot(vaultRoot, target);
  assertInsideScopeRoot(vaultRoot, temp);
  const trashTarget = item.trash ? path.resolve(trashRoot, item.trash) : null;
  const relativeTrash = trashTarget ? path.relative(trashRoot, trashTarget) : null;
  if (relativeTrash && (relativeTrash === ".." || relativeTrash.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTrash))) throw new Error("Journal trash path escapes trash root");
  const consumeTarget = item.consumeTrash ? path.resolve(trashRoot, item.consumeTrash.path) : null;
  if (consumeTarget) {
    const relative = path.relative(trashRoot, consumeTarget);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Consumed Trash source escapes root");
  }
  return { ...item, target, temp, backup: path.join(dir, item.backup), trashTarget, consumeTarget };
}

function cleanupConflict(item, detail) {
  const error = new Error(`Trash cleanup conflict: ${item.consumeTrash.path} ${detail}`);
  error.code = "TRASH_CLEANUP_CONFLICT";
  return error;
}

// Same-directory quarantine name derived from the reviewed revision and the
// source basename, so an interrupted pass that already performed the atomic
// detach can be recognized and resolved by the next recovery pass. Both the
// revision and the path are journal-validated; hashing keeps the name bounded
// for long source names and avoids leaking the original name into a filename.
function consumeQuarantinePath(item) {
  const revision = item.consumeTrash.revision.slice("sha256:".length, "sha256:".length + 16);
  const basename = createHash("sha256").update(path.basename(item.consumeTarget)).digest("hex").slice(0, 16);
  return path.join(path.dirname(item.consumeTarget), `.obsidian-mcp-consume-${basename}-${revision}.quarantine`);
}

// true: the path holds exactly the reviewed regular-file bytes.
// false: the path is present but is not that regular file.
// null: the path is absent.
async function reviewedTrashState(absPath, revision, trashRoot = TRASH_PATH) {
  await assertCanonicalInsideRoot(trashRoot, absPath, { allowMissing: true });
  let stat;
  try {
    stat = await fs.lstat(absPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  return digest(await fs.readFile(absPath)) === revision;
}

// Put unexpected quarantined bytes back at the source path only while it is
// still free. fs.link is atomic and refuses an existing destination, so content
// an external writer creates during cleanup is never overwritten. Returns false
// when the bytes must remain in quarantine.
//
// The quarantine is never unlinked here. A link followed by an unlink is not
// atomic: an external writer can unlink or replace the source path between the
// two steps, which would leave the quarantine as the last remaining link to the
// unexpected bytes and the unlink would destroy them. Keeping the quarantine is
// what preserves the "never delete unknown content" invariant; it remains the
// authoritative copy of the bytes that did not match the reviewed revision.
async function restoreQuarantinedBytes(quarantinePath, consumeTarget, hooks = {}) {
  try {
    await fs.link(quarantinePath, consumeTarget);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    // Hard links are unavailable on some filesystems. An exclusive copy is
    // still non-destructive: the quarantined bytes remain until it succeeds.
    try {
      await fs.copyFile(quarantinePath, consumeTarget, fsConstants.COPYFILE_EXCL);
    } catch (copyError) {
      if (copyError?.code === "EEXIST") return false;
      throw copyError;
    }
  }
  // Internal test hook: fires after the unexpected bytes are reachable at the
  // source path but before the quarantine would otherwise be cleaned up.
  if (hooks.afterRestoreQuarantineLink) await hooks.afterRestoreQuarantineLink(quarantinePath);
  await syncDir(path.dirname(consumeTarget));
  return true;
}

// Durably record that this item's committed Trash consumption is complete.
// Persisting the marker before deleting the verified quarantine is what makes a
// crash between the quarantine unlink and the journal cleanup unambiguous:
// recovery no longer has to infer completion from a source path that an
// external writer may have repopulated in the meantime.
async function markConsumeCompleted(journal, item) {
  journal.manifest.entries[item.entryIndex].consumeCompleted = true;
  await save(journal.dir, journal.manifest);
}

async function finalizeConsumedTrash(journal, items, hooks = {}, trashRoot = TRASH_PATH) {
  const stateOf = (absPath, revision) => reviewedTrashState(absPath, revision, trashRoot);
  for (const item of items.filter((entry) => entry.consumeTarget)) {
    const quarantinePath = consumeQuarantinePath(item);

    if (journal.manifest.entries[item.entryIndex].consumeCompleted) {
      // Consumption is already durably committed. A verified quarantine can
      // remain if the process exited after the marker but before the unlink;
      // those are the reviewed bytes we already committed to delete, so
      // removing them completes the step. Never re-examine the source path: an
      // object an external writer created after the detach must not be mistaken
      // for the reviewed entry and reported as a fresh conflict.
      const leftover = await stateOf(quarantinePath, item.consumeTrash.revision);
      if (leftover === false) throw cleanupConflict(item, `unexpected content preserved at ${toTrashPath(quarantinePath)}`);
      if (leftover === true) {
        await fs.unlink(quarantinePath);
        await syncDir(path.dirname(item.consumeTarget));
        if (hooks.afterConsumeQuarantineUnlink) await hooks.afterConsumeQuarantineUnlink(item.consumeTrash.path);
      }
      continue;
    }

    // Resolve a quarantine left by an interrupted pass first. Its bytes were
    // atomically detached from the source path, so they are the authoritative
    // evidence of what the previous attempt saw there.
    const leftover = await stateOf(quarantinePath, item.consumeTrash.revision);
    if (leftover === true) {
      // The reviewed entry was already atomically detached by the interrupted
      // pass. Make that consumption durable before deleting the reviewed
      // quarantine, so a later crash cannot confuse "already consumed" with a
      // source an external writer recreated. The source path is not
      // re-examined: it now either is free or belongs to an external writer.
      await markConsumeCompleted(journal, item);
      await fs.unlink(quarantinePath);
      await syncDir(path.dirname(item.consumeTarget));
      if (hooks.afterConsumeQuarantineUnlink) await hooks.afterConsumeQuarantineUnlink(item.consumeTrash.path);
      continue;
    }
    if (leftover === false) {
      const restored = await restoreQuarantinedBytes(quarantinePath, item.consumeTarget, hooks);
      throw cleanupConflict(item, restored
        ? "changed during removal; unexpected content preserved"
        : `unexpected content preserved at ${toTrashPath(quarantinePath)}`);
    }

    // Truth source is the SHA-256 revision persisted from the protected Trash
    // bytes at planning time, never the path or its existence.
    const sourceState = await stateOf(item.consumeTarget, item.consumeTrash.revision);
    if (sourceState === null) {
      // The expected source is already absent, so consumption is complete.
      // Record that durably so a restart after an external writer repopulates
      // the path cannot manufacture a conflict.
      await markConsumeCompleted(journal, item);
      continue;
    }
    if (sourceState === false) throw cleanupConflict(item, "changed before removal");
    // Internal test hook: the Vault restore is already committed when this runs,
    // so a failing unlink must leave the journal in place for later recovery.
    if (hooks.beforeConsumedTrashUnlink) await hooks.beforeConsumedTrashUnlink(item.consumeTrash.path);
    // Atomically detach the reviewed entry before deleting it. rename() acts on
    // a single directory entry, so an external writer that replaces the source
    // path during cleanup can no longer make us unlink bytes we never verified.
    try {
      await fs.rename(item.consumeTarget, quarantinePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        // The source vanished between the revision check and the detach, so
        // there is nothing left to consume. Record completion so a writer that
        // repopulates the path before journal cleanup is not mistaken for a
        // fresh conflict.
        await markConsumeCompleted(journal, item);
        continue;
      }
      throw error;
    }
    await syncDir(path.dirname(item.consumeTarget));
    const quarantinedState = await stateOf(quarantinePath, item.consumeTrash.revision);
    if (quarantinedState !== true) {
      const restored = quarantinedState === false && await restoreQuarantinedBytes(quarantinePath, item.consumeTarget, hooks);
      throw cleanupConflict(item, restored
        ? "changed during removal; unexpected content preserved"
        : `unexpected content preserved at ${toTrashPath(quarantinePath)}`);
    }
    // Internal test hook: fires while the reviewed bytes are already detached
    // from the source path and only the private quarantine remains to delete.
    if (hooks.beforeConsumeQuarantineUnlink) await hooks.beforeConsumeQuarantineUnlink(item.consumeTrash.path);
    // Persist completion before deleting the verified quarantine, so a crash at
    // the unlink or before the journal cleanup stays unambiguously recoverable.
    await markConsumeCompleted(journal, item);
    await fs.unlink(quarantinePath);
    await syncDir(path.dirname(item.consumeTarget));
    if (hooks.afterConsumeQuarantineUnlink) await hooks.afterConsumeQuarantineUnlink(item.consumeTrash.path);
  }
}

async function finalizeTrash(items, trashRoot = TRASH_PATH) {
  for (const item of items.filter((entry) => entry.trashTarget)) {
    await fs.mkdir(trashRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = await fs.realpath(trashRoot);
    let existingParent = path.dirname(item.trashTarget);
    while (!(await exists(existingParent))) existingParent = path.dirname(existingParent);
    const canonicalParent = await fs.realpath(existingParent);
    const relativeParent = path.relative(canonicalRoot, canonicalParent);
    if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
      throw new Error(`Trash path escapes configured root: ${item.path}`);
    }
    await fs.mkdir(path.dirname(item.trashTarget), { recursive: true });
    const verifyBackup = async () => {
      const stat = await fs.lstat(item.trashTarget);
      if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(item.trashTarget)) !== item.before) {
        throw new Error(`Trash checksum mismatch: ${item.path}`);
      }
    };
    if (await exists(item.trashTarget)) {
      await verifyBackup();
      continue;
    }
    const temp = `${item.trashTarget}.tmp`;
    await fs.rm(temp, { force: true });
    await durableFile(temp, await fs.readFile(item.backup));
    try { await fs.link(temp, item.trashTarget); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await verifyBackup();
    } finally { await fs.rm(temp, { force: true }); }
    await syncDir(path.dirname(item.trashTarget));
  }
}

async function finalizeHistory(items, historyRoot = HISTORY_PATH) {
  for (const item of items.filter((entry) => entry.history)) {
    const directory = path.join(historyRoot, ...item.path.split("/"));
    const destination = path.join(directory, item.historyName);
    await fs.mkdir(historyRoot, { recursive: true, mode: 0o700 });
    await assertCanonicalInsideRoot(historyRoot, directory, { allowMissing: true });
    await fs.mkdir(directory, { recursive: true });
    await assertCanonicalInsideRoot(historyRoot, directory);
    if (await exists(destination)) {
      await assertCanonicalInsideRoot(historyRoot, destination);
      if (digest(await fs.readFile(destination)) !== item.before) throw new Error(`History checksum mismatch: ${item.path}`);
    } else {
      const temp = `${destination}.tmp`;
      await fs.rm(temp, { force: true });
      await durableFile(temp, await fs.readFile(item.backup));
      await fs.rename(temp, destination);
      await syncDir(directory);
    }
    const versions = (await fs.readdir(directory)).filter((name) => name.endsWith(".bak")).sort().reverse();
    for (const stale of versions.slice(Math.max(1, MAX_VERSIONS_PER_FILE))) await fs.rm(path.join(directory, stale));
  }
}

export async function finishBatchJournal(journal, hooks = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(journal.dir, "manifest.json"), "utf-8"));
  if (![1, JOURNAL_SCHEMA].includes(manifest.schema) || !["prepared", "committing", "committed"].includes(manifest.state) ||
      !Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error("Invalid mutation journal");
  // Live writes carry the request scope; recovery re-resolves the owning runtime
  // from the manifest (§13.3) and fails closed on an unregistered Vault.
  const scope = journal.scope || resolveMutationJournalScope(manifest);
  assertManifestVault(manifest, scope);
  const { vaultRoot, trashRoot, historyRoot } = scopeRoots(scope);
  const revisionOf = async (absPath) => (await exists(absPath) ? scopeFileRevision(absPath, vaultRoot) : null);
  const items = manifest.entries.map((item, entryIndex) => ({ ...itemPaths(journal.dir, item, scope), entryIndex }));
  for (const item of items) {
    if (await exists(item.target)) await assertCanonicalInsideRoot(vaultRoot, item.target);
    if (await exists(item.temp)) await assertCanonicalInsideRoot(vaultRoot, item.temp);
  }
  if (manifest.state !== "committed") {
    // Check the whole batch before touching a target. A concurrent external
    // edit leaves the journal in place and prevents startup from serving.
    for (const item of items) {
      const current = await revisionOf(item.target);
      if (current !== item.before && current !== item.after) throw new Error(`Recovery conflict: ${item.path}`);
      if (item.existed) {
        const backup = await fs.readFile(item.backup);
        if (digest(backup) !== item.before) throw new Error(`Backup checksum mismatch: ${item.path}`);
      }
    }
    for (const item of [...items].reverse()) {
      const current = await revisionOf(item.target);
      if (current !== item.after) continue;
      if (item.existed) {
        const restore = `${item.temp}.rollback`;
        await durableFile(restore, await fs.readFile(item.backup));
        await fs.rename(restore, item.target);
      } else {
        await fs.rm(item.target);
      }
      await syncDir(path.dirname(item.target));
    }
  }
  if (manifest.state === "committed") {
    for (const item of items) {
      const current = await revisionOf(item.target);
      if (current !== item.after) throw new Error(`Committed mutation changed externally: ${item.path}`);
    }
    await finalizeHistory(items, historyRoot);
    await finalizeTrash(items, trashRoot);
    await finalizeConsumedTrash({ dir: journal.dir, manifest }, items, hooks, trashRoot);
    if (manifest.idempotency) {
      if (!manifest.result || manifest.result.planId !== manifest.idempotency.planId ||
          manifest.result.planHash !== manifest.idempotency.planHash) throw new Error("Committed mutation result is missing");
      await saveAppliedRecord({ ...manifest.idempotency, result: manifest.result }, { scope });
    }
    for (const item of items) trackGitMutation(item.path);
  }
  for (const item of items) await fs.rm(item.temp, { force: true });
  await fs.rm(journal.dir, { recursive: true });
  await syncDir(path.dirname(journal.dir));
}

// §13.3 recovery: parse each manifest first, then resolve its owning runtime.
// A journal that lives in a per-Vault namespace must belong to that namespace and
// be registered; anything else fails closed and is preserved for the operator.
const JOURNAL_ID = /^[0-9a-f-]{36}$/;
const VAULT_NAMESPACE = /^[0-9a-f]{64}$/;

async function recoverJournal(dir, namespaceKey) {
  if (!(await exists(path.join(dir, "manifest.json")))) {
    // No Vault writes begin before publishing the manifest.
    await fs.rm(dir, { recursive: true });
    return;
  }
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf-8"));
  const scope = resolveMutationJournalScope(manifest);
  if (namespaceKey === null) {
    if (!scope.primary) throw vaultContextMismatch(null, scope.vaultId);
  } else if (scope.primary || scope.key !== namespaceKey) {
    throw vaultContextMismatch(null, manifest.vaultId ?? null);
  }
  await finishBatchJournal({ dir, scope });
}

async function recoverUnlocked() {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await pruneExpiredAppliedRecords(primaryMutationVaultScope());
  for (const name of (await fs.readdir(root)).sort()) {
    const dir = path.join(root, name);
    if (!(await fs.lstat(dir)).isDirectory()) throw new Error(`Invalid mutation journal directory: ${name}`);
    if (VAULT_NAMESPACE.test(name)) {
      for (const child of (await fs.readdir(dir)).sort()) {
        if (!JOURNAL_ID.test(child)) throw new Error(`Unexpected mutation journal entry: ${child}`);
        await recoverJournal(path.join(dir, child), name);
      }
      continue;
    }
    if (!JOURNAL_ID.test(name)) throw new Error(`Unexpected mutation journal entry: ${name}`);
    await recoverJournal(dir, null);
  }
}

export async function recoverPendingBatches() {
  return withMutationLock(recoverUnlocked);
}

// atomicWriteBatch already holds the mutation lock.
export { recoverUnlocked as recoverPendingBatchesUnlocked, syncDir as syncBatchDirectory };
