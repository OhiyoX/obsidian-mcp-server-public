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
 * @param {{ uploadsRoots?: string[], now?: number }} input
 * @returns {Promise<{ scanned: number, kept: number, orphanParts: number, failures: number,
 *   removed: Array<{ uploadId: string, vaultId: string|null, expiresAt: string, bytes: number|null }> }>}
 */
export async function sweepExpiredUploads({ uploadsRoots = [], now = Date.now() } = {}) {
  const report = { scanned: 0, kept: 0, orphanParts: 0, failures: 0, removed: [] };
  for (const root of [...new Set(uploadsRoots.filter((value) => typeof value === "string" && value !== ""))]) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
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
        metadata = JSON.parse(await fs.readFile(path.join(root, entry.name), "utf8"));
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
      const bytes = await fs.stat(part).then((stat) => stat.size, () => null);
      try {
        await fs.rm(path.join(root, entry.name), { force: true });
        await fs.rm(part, { force: true });
      } catch {
        report.failures += 1;
        continue;
      }
      const removed = { uploadId, vaultId: typeof metadata?.vaultId === "string" ? metadata.vaultId : null, expiresAt: metadata.expiresAt, bytes };
      report.removed.push(removed);
      // The FULL uploadId on purpose: after the metadata is gone, this line is the only trace left.
      emitAuditLine({
        event: "direct-upload", requestId: null, operation: "expired-sweep", uploadId,
        vaultId: removed.vaultId, credentialId: null, decision: "expired-sweep", status: null,
        code: "upload_expired", durationMs: 0, bytes, digest: null, expiresAt: removed.expiresAt,
      });
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
  return { retention, ...report };
}
