// #693 — the durable metadata writer for upload handles, plus the observability it owes a caller.
//
// WHY THIS MODULE EXISTS: `<uploadId>.json` is the ONLY durable record of what a resumable upload is
// doing. On Windows a concurrent reader of the rename target (editor, AV scanner, indexer) makes
// `fs.rename` answer EPERM/EACCES/EBUSY; before this, two writers caught the resulting failure as
// `markFailed(...).catch(() => {})`, so the process believed a handle was `failed-retryable` while the
// disk still said `uploading` — and no counter, log line or audit line recorded anything. A transient
// error was never retried either.
//
// The policy this module implements (one place, so it cannot drift):
//   * bounded retry on exactly those three errno codes, counted in `diagnostics().metadataWriteRetries`;
//     a write that heals is a count, never a warning;
//   * a write that still fails is counted, warned once and emitted as one audit line, then thrown
//     unchanged so the caller keeps deciding the answer (a raw errno may not replace a structured code);
//   * the failure is stamped on the error (`persistRecorded`) so an outer wrapper cannot count it twice.
//
// Extracted from `transfer-runtime.js` on purpose: that module is pinned to ≤500 lines, must not hold
// module-level mutable state, and the §43-5 rule says a Vault-dependent runtime must not own policy.

import fs from "node:fs/promises";
import path from "node:path";
import { emitAuditLine } from "../audit-sink.js";

/** `attempts` counts the first try too; `baseDelayMs` grows 1x, 2x, 4x … up to `maxDelayMs`. */
export const DEFAULT_PERSIST_RETRY = Object.freeze({ attempts: 4, baseDelayMs: 5, maxDelayMs: 40 });

/**
 * `EPERM`/`EBUSY` are what Windows answers when the rename target is open; `EACCES` is the POSIX
 * equivalent. Deliberately an allowlist: a real failure (ENOSPC, EROFS, EXDEV) is never retried.
 */
const RETRYABLE_RENAME_CODES = Object.freeze(["EPERM", "EACCES", "EBUSY"]);

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * @param {object} [options]
 * @param {(from: string, to: string) => Promise<void>} [options.renameFile] deterministic test seam; defaults to `fs.rename`
 * @param {object} [options.log] `warn` receiver; defaults to `console`
 * @param {(line: object) => void} [options.audit] audit emitter; defaults to the process audit sink
 * @param {object} [options.retry] `{ attempts, baseDelayMs, maxDelayMs }` overrides
 * @param {string|null} [options.vaultId] echoed into the audit line so a failure is attributable
 */
export function createMetadataWriter({ renameFile, log = console, audit, retry = {}, vaultId = null } = {}) {
  const rename = typeof renameFile === "function" ? renameFile : fs.rename;
  const emit = typeof audit === "function" ? audit : (line) => emitAuditLine(line, { log });
  const policy = {
    attempts: Math.max(1, Math.trunc(Number(retry?.attempts ?? DEFAULT_PERSIST_RETRY.attempts))),
    baseDelayMs: Math.max(0, Number(retry?.baseDelayMs ?? DEFAULT_PERSIST_RETRY.baseDelayMs)),
    maxDelayMs: Math.max(0, Number(retry?.maxDelayMs ?? DEFAULT_PERSIST_RETRY.maxDelayMs)),
  };
  const counters = { metadataWriteRetries: 0, metadataWriteFailures: 0, lastFailure: null };

  async function renameWithRetry(from, to) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        if (!RETRYABLE_RENAME_CODES.includes(error?.code) || attempt >= policy.attempts) throw error;
        counters.metadataWriteRetries += 1;
        await delay(Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }

  /** Count + warn + audit one failed metadata write. Never throws: a logger may not change an outcome. */
  function recordPersistFailure({ stage, uploadId = null, reason = null, error }) {
    const code = error?.code ?? null;
    counters.metadataWriteFailures += 1;
    counters.lastFailure = { stage, uploadId, reason, code, at: new Date().toISOString() };
    if (error !== null && typeof error === "object" && Object.isExtensible(error)) error.persistRecorded = true;
    try {
      log?.warn?.(`[transfer-runtime] metadata write failed during ${stage}${reason ? ` (${reason})` : ""}: ${code || error?.message || error}; the durable handle keeps its previous status. Counted in diagnostics().metadataWriteFailures and emitted as an audit line.`);
    } catch { /* a logger must never change an outcome */ }
    try {
      emit({
        event: "direct-upload",
        requestId: null,
        operation: "metadata-persist",
        uploadId: typeof uploadId === "string" && uploadId ? uploadId.slice(0, 8) : null,
        vaultId,
        credentialId: null,
        decision: "failed",
        status: null,
        code: code || "persist-failed",
        durationMs: 0,
        bytes: null,
        digest: null,
        stage,
        reason,
        persistFailures: counters.metadataWriteFailures,
      });
    } catch { /* an audit sink must never change an outcome either */ }
  }

  /**
   * mkdir → write temp → rename, with the retry/record policy above. `stage`/`reason` are the only
   * attribution an operator gets, so callers pass what the write was for ("mark-failed", …).
   */
  async function writeJsonAtomic(target, value, { stage = "write-metadata", reason = null } = {}) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await renameWithRetry(temporary, target);
    } catch (error) {
      recordPersistFailure({ stage, uploadId: value?.uploadId ?? null, reason, error });
      throw error;
    }
  }

  /** Per-instance counters. A copy: a caller can never mutate the writer's own numbers. */
  function diagnostics() {
    return {
      vaultId,
      metadataWriteRetries: counters.metadataWriteRetries,
      metadataWriteFailures: counters.metadataWriteFailures,
      lastFailure: counters.lastFailure ? { ...counters.lastFailure } : null,
    };
  }

  /**
   * Wrap the state machine's `markFailed` so a failed metadata write is recorded instead of thrown
   * away. `false` = "the state machine moved on, the disk could not record it".
   */
  function safeMarkFailed(markFailed) {
    return async (paths, metadata, reason, terminal = false) => {
      try {
        await markFailed(paths, metadata, reason, terminal);
        return true;
      } catch (error) {
        // A metadata write already recorded itself; anything else (mkdir, an injected writer) is
        // recorded here, so one event is never counted twice and never silently lost.
        if (error?.persistRecorded !== true) recordPersistFailure({ stage: "mark-failed", uploadId: metadata?.uploadId ?? null, reason, error });
        return false;
      }
    };
  }

  return Object.freeze({ writeJsonAtomic, safeMarkFailed, diagnostics });
}
