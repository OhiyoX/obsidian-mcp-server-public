// Issue #470 acceptance gap (C) — append-only audit persistence.
//
// Why this module exists: every data-plane decision already emitted one structured line
// (`console.log("[direct-upload] {...}")`), but production could not read it. The container's stdout
// is unreachable on the documented NAS deployment (`docker` needs root, `/volume1/@docker` is 700),
// and the only durable copy was the 2000-entry ring in `DATA_PATH/oauth/state.json -> audit[]`
// (~8 h of traffic, and a deleted credential's UUID is no longer resolvable there). So "the audit
// trail is queryable" was false in production even though every request was audited.
//
// This module adds the missing durable copy and NOTHING else:
//
//   <DATA_PATH>/audit/YYYY-MM-DD.jsonl   one JSON object per line, appended, never rewritten
//
// Rules (brief §1 A — these are the review points, not decoration):
//   * additive only. stdout keeps its exact `[direct-upload] {...}` shape and the provider ring in
//     `oauth/state.json` is untouched, so nothing that reads them today changes;
//   * a sink failure NEVER changes a request's outcome. It is COUNTED (`sinkFailures`, surfaced on
//     `/healthz` as `audit.sinkFailures`), timestamped, and logged once per error code — no
//     `.catch(() => {})` swallowing (that is exactly the #693 lesson: an invisible failure is a bug);
//   * rotation is by UTC day. Retention (`AUDIT_RETENTION_DAYS`, default 14) is pruned at startup and
//     on a day roll ONLY — never a directory scan on the request path;
//   * only files matching `YYYY-MM-DD.jsonl` are ever deleted, so a hand-placed note inside the
//     directory is never collateral damage, and a newer/derived file is never mistaken for a day file.
//
// Scope note: the provider ring (`recordAudit`) is deliberately NOT mirrored here. It is written by
// `oauth-provider.js`, which this batch must not touch; adding a second writer there would change a
// hot path the brief did not put in scope. What this module persists is the audit LINE — the
// data-plane detail (`bytes`/`digest`/`durationMs`/`rateWaived`) that existed nowhere durable.

import fs from "node:fs";
import path from "node:path";
import { DATA_PATH, parseBool, parseInteger } from "./config.js";

/** Absolute sink directory. `AUDIT_SINK_DIR` exists so a test can point at an isolated tree. */
export const AUDIT_SINK_DIR = path.resolve(process.env.AUDIT_SINK_DIR || path.join(DATA_PATH, "audit"));
/** Days of `YYYY-MM-DD.jsonl` files to keep, today included. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 14;
export const AUDIT_RETENTION_DAYS = (() => {
  const value = parseInteger(process.env.AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_DAYS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_AUDIT_RETENTION_DAYS;
})();
/** `AUDIT_SINK_ENABLED=false` disables the file copy only; stdout and the ring are unaffected. */
export const AUDIT_SINK_ENABLED = process.env.AUDIT_SINK_ENABLED === undefined
  ? true
  : parseBool(process.env.AUDIT_SINK_ENABLED);

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

/** UTC day of `at`, the rotation key and the file name. UTC on purpose: the container's TZ is not
 *  part of the deployment contract, and a local-time name would make one day two files after a DST
 *  or TZ change. `/healthz` exposes the live name (`audit.currentFile`), so an operator never has to
 *  guess. */
export function auditDayKey(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * `createAuditSink({ dir, retentionDays, enabled, now, log })` → `{ startup, record, health,
 * noteExpiredSweep }`.
 *
 * All file I/O is synchronous by design: an audit line must land in the order it was decided, and an
 * async append would both reorder lines and turn a failed write into an unhandled rejection. The
 * cost is one small `appendFileSync` per audited request (~tens of microseconds), not a scan.
 */
export function createAuditSink({
  dir = AUDIT_SINK_DIR,
  retentionDays = AUDIT_RETENTION_DAYS,
  enabled = AUDIT_SINK_ENABLED,
  now = Date.now,
  log = console,
} = {}) {
  const keepDays = Number.isInteger(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULT_AUDIT_RETENTION_DAYS;
  const stats = {
    written: 0,
    sinkFailures: 0,
    retentionFailures: 0,
    removedFiles: 0,
    lastError: null,
    lastFailureAt: null,
    lastSweepAt: null,
  };
  let currentDay = null;
  let warnedKey = null;
  let expiredSweep = null;

  const fileFor = (day) => path.join(dir, `${day}.jsonl`);

  function noteFailure(phase, error) {
    stats.sinkFailures += 1;
    stats.lastError = `${phase}: ${error?.code || error?.message || String(error)}`;
    stats.lastFailureAt = new Date(now()).toISOString();
    // One warning per distinct failure kind: a full disk must be visible, and must not turn into one
    // log line per request. The counter keeps counting regardless.
    const key = `${phase}:${error?.code || "unknown"}`;
    if (warnedKey !== key) {
      warnedKey = key;
      log?.warn?.(`[audit-sink] ${phase} failed (${error?.code || error?.message || error}); audit lines are not persisted. Counting for /healthz audit.sinkFailures.`);
    }
  }

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Delete day files older than the retention window that ends today (inclusive). */
  function prune(today = auditDayKey(now())) {
    const cutoff = auditDayKey(Date.parse(`${today}T00:00:00Z`) - (keepDays - 1) * DAY_MS);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        stats.retentionFailures += 1;
        log?.warn?.(`[audit-sink] retention scan failed (${error?.code || error?.message}); keeping what is on disk`);
      }
      stats.lastSweepAt = new Date(now()).toISOString();
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const match = DAY_FILE.exec(name);
      // `match[1] >= cutoff` is a string comparison of ISO dates: lexicographic order == date order.
      if (!match || match[1] >= cutoff) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        removed += 1;
      } catch (error) {
        stats.retentionFailures += 1;
        log?.warn?.(`[audit-sink] retention delete of ${name} failed (${error?.code || error?.message})`);
      }
    }
    stats.removedFiles += removed;
    stats.lastSweepAt = new Date(now()).toISOString();
    return removed;
  }

  /**
   * Startup hook: create the directory (failures counted, never thrown) and prune expired day files.
   * Called once from `server.js`; also the only place the directory is created eagerly.
   */
  function startup() {
    if (!enabled) return { skipped: "disabled", removed: 0 };
    try {
      ensureDir();
    } catch (error) {
      noteFailure("startup", error);
      return { ok: false, removed: 0 };
    }
    return { ok: true, removed: prune() };
  }

  /**
   * Append one audit record. Returns true when it landed. Never throws: the caller (a request that
   * has already answered or decided) must not be affected by a full/read-only disk.
   */
  function record(line) {
    if (!enabled) return false;
    const at = now();
    const day = auditDayKey(at);
    try {
      if (currentDay !== day) {
        ensureDir();
        prune(day);
        currentDay = day;
      }
      fs.appendFileSync(fileFor(day), `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
      stats.written += 1;
      return true;
    } catch (error) {
      noteFailure("append", error);
      return false;
    }
  }

  /** Record the startup handle sweep in `/healthz` (the per-handle audit lines go through `record`). */
  function noteExpiredSweep(report) {
    expiredSweep = report && typeof report === "object"
      ? {
        scanned: report.scanned ?? 0,
        removed: report.removed?.length ?? 0,
        kept: report.kept ?? 0,
        orphanParts: report.orphanParts ?? 0,
        failures: report.failures ?? 0,
        at: new Date(now()).toISOString(),
      }
      : null;
    return expiredSweep;
  }

  function health() {
    return {
      enabled,
      dir,
      retentionDays: keepDays,
      currentFile: currentDay ? fileFor(currentDay) : null,
      written: stats.written,
      // The counter the brief and the operator contract name: `audit.sinkFailures` on /healthz.
      sinkFailures: stats.sinkFailures,
      retentionFailures: stats.retentionFailures,
      removedFiles: stats.removedFiles,
      lastError: stats.lastError,
      lastFailureAt: stats.lastFailureAt,
      lastSweepAt: stats.lastSweepAt,
      expiredUploadSweep: expiredSweep,
    };
  }

  return Object.freeze({ startup, record, health, noteExpiredSweep });
}

/** The process's one sink. Modules import this; tests exercise a child process, not an injection seam. */
export const auditSink = createAuditSink();

/**
 * Write one audit line to its TWO existing destinations plus the new file: stdout (unchanged shape)
 * and the append-only day file. Callers build the object; this function owns the byte layout so the
 * two copies can never drift.
 */
export function emitAuditLine(line, { log = console, sink = auditSink } = {}) {
  log?.log?.(`[direct-upload] ${JSON.stringify(line)}`);
  return sink.record(line);
}
