import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beginBatchJournal, durableFile, finishBatchJournal, recoverPendingBatchesUnlocked, setBatchJournalState, syncBatchDirectory } from "./batch-journal.js";
import { readAppliedRecord } from "./mutation-idempotency.js";
import { requireRequestAuthor } from "./request-context.js";
// Root-free helpers stay on the facade; every root-bound primitive follows the request's
// VaultRuntime (Wave D / D-files, contract §10.1/§10.2: the mutation lock and the trash/vault
// containment checks must be the selected Vault's, not the primary's).
import { assertCanonicalInsideRoot, assertWritable, exists } from "./vault.js";
import {
  assertCanonicalInsideVault,
  assertInsideVault,
  assertRevision,
  currentLocalFs,
  ensureVaultParent,
  fileRevision,
  resolveTrashPath,
  toVaultPath,
  withMutationLock,
} from "./vault-runtime/request-vault.js";

export async function atomicWriteBatch(entries, { afterRename, afterCommit, beforeConsumedTrashUnlink, beforeConsumeQuarantineUnlink, afterRestoreQuarantineLink, afterConsumeQuarantineUnlink, afterFinish, idempotency } = {}) {
  return withMutationLock(async () => {
    assertWritable();
    requireRequestAuthor();
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("Batch must include at least one file");
    await recoverPendingBatchesUnlocked();
    if (idempotency && await readAppliedRecord(idempotency.digest)) {
      const error = new Error("idempotencyKey was already committed");
      error.code = "IDEMPOTENCY_ALREADY_APPLIED";
      throw error;
    }
    const prepared = await prepareEntries(entries);
    const journal = await beginBatchJournal(prepared, idempotency);
    let results;
    try {
      for (const entry of prepared) {
        if (!entry.delete) {
          await durableFile(entry.tempPath, entry.data);
          await syncBatchDirectory(path.dirname(entry.tempPath));
        }
      }
      for (const entry of prepared) {
        if (entry.existed) await assertRevision(entry.absPath, entry.ifMatch);
        else if (await exists(entry.absPath)) throw new Error(`Revision conflict: ${entry.rel} already exists`);
        if (entry.sourceTrash) await assertTrashSource(entry);
      }
      await setBatchJournalState(journal, "committing");
      for (const [index, entry] of prepared.entries()) {
        if (entry.delete) await fs.unlink(entry.absPath);
        else await fs.rename(entry.tempPath, entry.absPath);
        await syncBatchDirectory(path.dirname(entry.absPath));
        if (afterRename) await afterRename(index);
      }
      const collected = await collectResults(prepared);
      await setBatchJournalState(journal, "committed", idempotency ? {
        planId: idempotency.planId,
        planHash: idempotency.planHash,
        applied: true,
        idempotentReplay: false,
        changed: collected,
        unchanged: idempotency.unchanged,
        appliedAt: idempotency.appliedAt,
      } : undefined);
      if (afterCommit) await afterCommit();
      await finishBatchJournal(journal, { beforeConsumedTrashUnlink, beforeConsumeQuarantineUnlink, afterRestoreQuarantineLink, afterConsumeQuarantineUnlink });
      results = collected;
    } catch (error) {
      try { await finishBatchJournal(journal, { beforeConsumedTrashUnlink }); }
      catch (recoveryError) {
        throw new AggregateError([error, recoveryError],
          `Batch write failed; recovery journal remains at ${journal.dir}: ${recoveryError.message}`);
      }
      throw error;
    }
    // Durable finish is complete (journal removed, idempotency persisted). A
    // failure here must not enter the rollback path above.
    if (afterFinish) await afterFinish();
    return results;
  });
}

async function assertTrashSource(entry) {
  const source = resolveTrashPath(entry.sourceTrash);
  try {
    await assertCanonicalInsideRoot(currentLocalFs().trashRoot, source);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Trash source must be a regular file: ${entry.sourceTrash}`);
    const revision = `sha256:${createHash("sha256").update(await fs.readFile(source)).digest("hex")}`;
    if (revision !== entry.sourceRevision) throw new Error(`Trash source revision conflict: ${entry.sourceTrash}`);
  } catch (error) {
    // Missing/removed backup after planning is the same concurrency failure as a revision mismatch.
    if (error?.code === "ENOENT") throw new Error(`Trash source revision conflict: ${entry.sourceTrash}`);
    throw error;
  }
}

async function prepareEntries(entries) {
  const seen = new Set();
  const prepared = [];
  for (const entry of entries) {
    const absPath = path.resolve(entry.absPath);
    assertInsideVault(absPath);
    const rel = toVaultPath(absPath);
    if (seen.has(rel)) throw new Error(`Batch contains duplicate path: ${rel}`);
    seen.add(rel);
    await ensureVaultParent(absPath);
    const existed = await exists(absPath);
    if (entry.trash && !entry.delete) throw new Error(`Trash backup requires a delete entry: ${rel}`);
    if (entry.delete && !existed) throw new Error(`Revision conflict: ${rel} does not exist`);
    if (entry.delete && (entry.mustNotExist || entry.data !== undefined)) throw new Error(`Invalid delete entry: ${rel}`);
    if (!entry.delete && entry.data === undefined) throw new Error(`Batch write data is required: ${rel}`);
    if (entry.mustNotExist && existed) throw new Error(`Revision conflict: ${rel} already exists`);
    if (entry.consumeTrash && !entry.sourceTrash) throw new Error(`Trash consumption requires a source: ${rel}`);
    if (entry.sourceTrash && !entry.sourceRevision) throw new Error(`Trash source revision is required: ${rel}`);
    if (entry.sourceTrash) await assertTrashSource(entry);
    if (existed) {
      await assertCanonicalInsideVault(absPath);
      if (!entry.ifMatch) throw new Error(`baseRevision is required for existing file: ${rel}`);
      await assertRevision(absPath, entry.ifMatch);
    } else if (entry.ifMatch) {
      throw new Error(`Revision conflict: expected ${entry.ifMatch}, but ${rel} does not exist`);
    }
    prepared.push({
      ...entry,
      absPath,
      rel,
      existed,
      original: existed ? await fs.readFile(absPath) : null,
      trashRel: entry.trash ? `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}/${rel}` : null,
      tempPath: path.join(path.dirname(absPath), `.${path.basename(absPath)}.obsidian-mcp-batch-${randomUUID()}.tmp`),
    });
  }
  return prepared;
}

async function collectResults(prepared) {
  const results = [];
  for (const entry of prepared) {
    if (entry.delete) {
      results.push({ path: entry.rel, deleted: true, created: false, size: 0, revision: null,
        previousSizeInBytes: entry.original.length, backup: entry.trashRel });
      continue;
    }
    const stat = await fs.stat(entry.absPath);
    const revision = await fileRevision(entry.absPath);
    results.push({ path: entry.rel, created: !entry.existed, size: stat.size, revision,
      ...(entry.sourceTrash ? { backupPath: entry.sourceTrash, backupRemoved: Boolean(entry.consumeTrash) } : {}) });
  }
  return results;
}
