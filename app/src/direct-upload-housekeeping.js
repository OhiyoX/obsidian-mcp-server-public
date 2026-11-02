// Issue #470 acceptance gap (B) — startup housekeeping for the transfer staging area.
//
// Why this module exists at all: `server.js` has a hard line budget (≤498 lines, asserted by
// `multi-vault-full-matrix.test.js`) and `vault-runtime/transfer-runtime.js` has its own (≤500,
// `transfer-runtime.test.js`), while `direct-upload.js` owns the direct-upload feature and should not
// grow a second concern. The sweep needs pieces from three planes — the handle-id grammar from the
// transfer runtime, the per-Vault A7 layout from `vault-runtime/paths.js`, and the audit line from
// `audit-sink.js` — so it gets its own seam and both line gates stay honest.
//
// What it does (once per process start, never on a request path):
//
//   1. `auditSink.startup()` — create `<DATA_PATH>/audit/` and prune day files outside the retention
//      window (issue #470 gap A). Failures are counted, not thrown.
//   2. Sweep expired transfer handles over the primary uploads root and every secondary Vault's A7
//      root: remove `<uploadId>.json` + `<uploadId>.part` only when the metadata says `expiresAt` is
//      already in the past. A bare `.part` with no metadata is NOT attributable to any handle and is
//      left in place (production carries 17 such pre-durable files); it is only counted.
//
// Deletion order (review 6.4): the `.part` goes FIRST and the metadata SECOND. The old order could
// delete the metadata and then fail on the `.part`, which erased the only attributable trace (the
// `expired-sweep` audit line) while leaving the bytes on disk, and also dropped the leftover `.part`
// out of `orphanParts` because the sweep-time snapshot still listed `<uploadId>.json`. Now a failed
// `.part` removal KEEPS the metadata (so the next start retries the whole handle) and any partial
// deletion leaves an audit line, because "could not delete" must never look like "nothing to delete".
//
// Everything here is best-effort: a read-only or full disk, a corrupt metadata file or a missing
// directory increments a counter and lets the server start.

import fs from "node:fs/promises";
import path from "node:path";

import { auditSink, emitAuditLine } from "./audit-sink.js";
import { TRANSFER_ID } from "./vault-runtime/transfer-runtime.js";
import { isVaultDataKey, secondaryVaultDataPaths } from "./vault-runtime/paths.js";

/**
 * Delete expired transfer handles from the given uploads roots.
 *
 * Only handles with parsable metadata whose own `expiresAt` is in the past are removed. Nothing here
 * throws: a problem is recorded in the report (`failures`) so the caller can expose it.
 *
 * @param {{ uploadsRoots?: string[], now?: number, fsPromises?: typeof fs, emit?: typeof emitAuditLine }} input
 * @returns {Promise<{ scanned: number, kept: number, orphanParts: number, failures: number,
 *   partRemovalFailures: number, metadataRemovalFailures: number,
 *   removed: Array<{ uploadId: string, vaultId: string|null, expiresAt: string, bytes: number|null }> }>}
 */
export async function sweepExpiredUploads({
  uploadsRoots = [],
  now = Date.now(),
  // Test seams, the same idea as `startupHousekeeping({ sink, log, now })`: production passes neither,
  // and the deletion branches below are otherwise only reachable with a genuinely broken filesystem.
  fsPromises = fs,
  emit = emitAuditLine,
} = {}) {
  const report = {
    scanned: 0, kept: 0, orphanParts: 0, failures: 0,
    partRemovalFailures: 0, metadataRemovalFailures: 0, removed: [],
  };
  for (const root of [...new Set(uploadsRoots.filter((value) => typeof value === "string" && value !== ""))]) {
    let entries;
    try {
      entries = await fsPromises.readdir(root, { withFileTypes: true });
    } catch (error) {
      // A Vault that never uploaded anything has no directory yet: not a failure.
      if (error?.code !== "ENOENT") report.failures += 1;
      continue;
    }
    const present = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const uploadId = entry.name.slice(0, -".json".length);
      if (!TRANSFER_ID.test(uploadId)) continue;
      report.scanned += 1;
      let metadata;
      try {
        metadata = JSON.parse(await fsPromises.readFile(path.join(root, entry.name), "utf8"));
      } catch {
        // Unparsable metadata: keep it. Deleting on a guess is worse than leaving a file behind.
        report.failures += 1;
        continue;
      }
      const expiresAt = typeof metadata?.expiresAt === "string" ? Date.parse(metadata.expiresAt) : Number.NaN;
      if (!Number.isFinite(expiresAt) || expiresAt > now) {
        report.kept += 1;
        continue;
      }
      const part = path.join(root, `${uploadId}.part`);
      // Best effort, and only for a real file: a directory sitting where the `.part` should be has a
      // filesystem-dependent `stat.size`, which is not this upload's byte count.
      const bytes = await fsPromises.stat(part).then((stat) => (stat.isFile() ? stat.size : null), () => null);
      const attachment = {
        event: "direct-upload", requestId: null, operation: "expired-sweep", uploadId,
        vaultId: typeof metadata?.vaultId === "string" ? metadata.vaultId : null, credentialId: null,
        decision: "expired-sweep", status: null, code: null, durationMs: 0, bytes, digest: null,
        expiresAt: metadata.expiresAt,
      };
      // Step 1: the bytes. If they cannot go, the handle stays fully attributable — metadata KEPT so
      // the next start retries the whole handle, plus an explicit "not deleted" line instead of silence.
      try {
        await fsPromises.rm(part, { force: true });
      } catch {
        report.failures += 1;
        report.partRemovalFailures += 1;
        emit({ ...attachment, code: "sweep_part_removal_failed" });
        continue;
      }
      // Step 2: the metadata. The bytes are already gone here, so a later sweep cannot retry it; the
      // audit line is the only thing that keeps the leftover explainable.
      try {
        await fsPromises.rm(path.join(root, entry.name), { force: true });
      } catch {
        report.failures += 1;
        report.metadataRemovalFailures += 1;
        emit({ ...attachment, code: "sweep_metadata_removal_failed" });
        continue;
      }
      const removed = { uploadId, vaultId: attachment.vaultId, expiresAt: metadata.expiresAt, bytes };
      report.removed.push(removed);
      // The FULL uploadId on purpose: after the metadata is gone, this line is the only trace left.
      // `upload_expired` keeps meaning "removed"; the two failure codes above are NOT reused for it.
      emit({ ...attachment, code: "upload_expired" });
    }
    // Counting only: a `.part` without metadata stays on disk by design (see the header).
    for (const name of present) {
      if (!name.endsWith(".part")) continue;
      const uploadId = name.slice(0, -".part".length);
      if (!TRANSFER_ID.test(uploadId) || present.has(`${uploadId}.json`)) continue;
      report.orphanParts += 1;
    }
  }
  return report;
}

/**
 * Every uploads root this process may own: the primary legacy root plus each secondary Vault's A7
 * root (`<dataRoot>/vaults/<dataKey>/transfers/uploads`), discovered from the directory layout so a
 * Vault that is not instantiated yet is still swept.
 */
export async function transferUploadsRoots({ dataRoot }) {
  const roots = [path.join(dataRoot, "transfers", "uploads")];
  try {
    for (const entry of await fs.readdir(path.join(dataRoot, "vaults"), { withFileTypes: true })) {
      if (!entry.isDirectory() || !isVaultDataKey(entry.name)) continue;
      roots.push(secondaryVaultDataPaths({ dataRoot, dataKey: entry.name }).transfersUploads);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`[transfers] expired-sweep: cannot enumerate secondary Vault roots (${error?.code || error?.message}); primary root only`);
  }
  return roots;
}

/**
 * `/healthz` view of the audit sink. Exposed here (not imported directly by `server.js`) so the
 * wiring seam stays in one module and `server.js` keeps its ≤498 line budget: this is the counter
 * surface the operator contract names — `audit.sinkFailures`.
 */
export function auditHealth() {
  return auditSink.health();
}

/**
 * `server.js` call site: retention prune for the audit directory, then the expired-handle sweep.
 * Returns the report (also recorded on `/healthz` as `audit.expiredUploadSweep`). Never throws.
 */
export async function startupHousekeeping({ dataRoot, sink = auditSink, log = console, now = Date.now } = {}) {
  const retention = sink.startup();
  const roots = await transferUploadsRoots({ dataRoot });
  const report = await sweepExpiredUploads({ uploadsRoots: roots, now: now() });
  sink.noteExpiredSweep(report);
  if (report.removed.length > 0) {
    log?.log?.(`[transfers] expired-sweep removed ${report.removed.length} handle(s); ${report.orphanParts} bare .part file(s) kept`);
  }
  if (report.failures > 0) {
    log?.warn?.(`[transfers] expired-sweep could not delete ${report.failures} handle(s) (part ${report.partRemovalFailures}, metadata ${report.metadataRemovalFailures}); each failure has an audit line`);
  }
  return { retention, ...report };
}
