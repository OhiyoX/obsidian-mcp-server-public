// Issue #470 acceptance gap (A) — the append-only audit sink itself, in isolation.
//
// The end-to-end proof that a real request lands here lives in `direct-upload-audit-file.test.js`;
// this file pins the sink's own contract, which is what the sweep/retention/health wiring depends on:
//
//   * one JSON object per line, appended in order, field names and order untouched;
//   * rotation by UTC day;
//   * retention (`AUDIT_RETENTION_DAYS`) pruned at startup and on a day roll only, and ONLY for
//     files that match `YYYY-MM-DD.jsonl` (a hand-placed note is never deleted);
//   * an unwritable directory is COUNTED (`sinkFailures`) and never thrown at the caller;
//   * `emitAuditLine` writes the unchanged `[direct-upload] {json}` stdout line AND the file line.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditDayKey, createAuditSink, emitAuditLine } from "../src/audit-sink.js";

const SILENT = { warn() {} };

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `audit-sink-${name}-`));
}

function dayFile(dir, day) {
  return path.join(dir, `${day}.jsonl`);
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").replace(/\n$/, "").split("\n").map((line) => JSON.parse(line));
}

test("appends one JSON object per line in order, with the fields untouched", () => {
  const dir = tempDir("append");
  const sink = createAuditSink({ dir, log: SILENT });
  const first = {
    event: "direct-upload",
    requestId: "req-1",
    operation: "put",
    uploadId: "cbb36c3b",
    vaultId: "vault",
    credentialId: "api-key:configured-env",
    decision: "allow",
    status: 201,
    code: "complete",
    durationMs: 12,
    bytes: 4096,
    digest: "a".repeat(64),
  };
  const second = { event: "direct-upload", requestId: "req-2", operation: "put", decision: "limited", status: 429, code: "rate_limited", durationMs: 1, bytes: null, digest: null, retryAfterSeconds: 10, limit: "rate" };

  assert.equal(sink.record(first), true);
  assert.equal(sink.record(second), true);

  const file = dayFile(dir, auditDayKey());
  const text = fs.readFileSync(file, "utf8");
  // Append-only layout: exactly one line per record, trailing newline, nothing rewritten.
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.trimEnd().split("\n").length, 2);
  assert.deepEqual(readLines(file), [first, second]);
  // Key order is the caller's, so a line diff against stdout can never be a false alarm.
  assert.deepEqual(Object.keys(readLines(file)[0]), Object.keys(first));
  assert.equal(sink.health().written, 2);
  assert.equal(sink.health().sinkFailures, 0);
});

test("rotates by UTC day and prunes on the crossing only", () => {
  const dir = tempDir("rotate");
  let clock = Date.parse("2026-10-24T23:59:00Z");
  const sink = createAuditSink({ dir, retentionDays: 14, now: () => clock, log: SILENT });

  assert.equal(sink.record({ n: 1 }), true);
  clock = Date.parse("2026-10-25T00:00:01Z"); // day roll while the process is running
  assert.equal(sink.record({ n: 2 }), true);

  const previous = dayFile(dir, "2026-10-24");
  const current = dayFile(dir, "2026-10-25");
  assert.deepEqual(readLines(previous), [{ n: 1 }]);
  assert.deepEqual(readLines(current), [{ n: 2 }]);
  assert.equal(sink.health().currentFile, current);
});

test("startup retention keeps the window, deletes older day files, and never touches other files", () => {
  const dir = tempDir("retention");
  fs.mkdirSync(dir, { recursive: true });
  const today = "2026-10-24";
  // retentionDays = 14 ⇒ the window is today and the 13 previous UTC days (cutoff 2026-10-11).
  const cases = {
    "2020-01-01": "expired",
    "2026-10-10": "expired", // one day older than the cutoff
    "2026-10-11": "kept",
    [today]: "kept",
  };
  for (const [day, verdict] of Object.entries(cases)) fs.writeFileSync(dayFile(dir, day), `{"day":"${day}"}\n`);
  fs.writeFileSync(path.join(dir, "notes.md"), "hand-placed, must survive\n");
  fs.writeFileSync(path.join(dir, "2020-01-01.jsonl.bak"), "not a day file\n");

  const sink = createAuditSink({ dir, retentionDays: 14, now: () => Date.parse(`${today}T08:00:00Z`), log: SILENT });
  const report = sink.startup();

  assert.deepEqual(report, { ok: true, removed: 2 });
  for (const [day, verdict] of Object.entries(cases)) {
    assert.equal(fs.existsSync(dayFile(dir, day)), verdict === "kept", `${day} should be ${verdict}`);
  }
  assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), "hand-placed, must survive\n");
  assert.equal(fs.existsSync(path.join(dir, "2020-01-01.jsonl.bak")), true);
  // Kept files keep their exact bytes: retention deletes whole day files, it never rewrites them.
  assert.equal(fs.readFileSync(dayFile(dir, today), "utf8"), `{"day":"${today}"}\n`);
  assert.equal(sink.health().removedFiles, 2);
  assert.equal(sink.health().retentionFailures, 0);
});

test("an unwritable directory counts sinkFailures and never throws at the caller", () => {
  const dir = tempDir("failure");
  // Cross-platform injection: the sink's directory path is occupied by a regular FILE, so
  // mkdir -p cannot succeed on any OS (no reliance on POSIX permission bits).
  const blocked = path.join(dir, "audit");
  fs.writeFileSync(blocked, "not a directory\n");

  const sink = createAuditSink({ dir: blocked, log: SILENT });
  const startup = sink.startup();
  assert.equal(startup.ok, false); // startup cannot create the directory
  assert.equal(sink.health().sinkFailures, 1);

  assert.doesNotThrow(() => sink.record({ event: "direct-upload", decision: "allow" }));
  assert.equal(sink.record({ event: "direct-upload", decision: "deny" }), false);
  const health = sink.health();
  assert.equal(health.sinkFailures, 3); // 1 startup + 2 appends, each counted
  assert.equal(health.written, 0);
  assert.match(health.lastError, /^append: /);
  assert.equal(typeof health.lastFailureAt, "string");
  // The operator-facing counter is exactly the name the brief and the operator contract use.
  assert.equal(typeof health.sinkFailures, "number");
});

test("AUDIT_SINK_ENABLED=false disables the file copy without failing anything", () => {
  const dir = tempDir("disabled");
  const sink = createAuditSink({ dir, enabled: false, log: SILENT });
  assert.deepEqual(sink.startup(), { skipped: "disabled", removed: 0 });
  assert.equal(sink.record({ event: "direct-upload" }), false);
  assert.equal(sink.health().sinkFailures, 0);
  assert.deepEqual(fs.readdirSync(dir), []); // nothing written, nothing created
});

test("emitAuditLine keeps the stdout line byte-identical to the file line", () => {
  const dir = tempDir("emit");
  const sink = createAuditSink({ dir, log: SILENT });
  const logged = [];
  const line = { event: "direct-upload", requestId: "req-9", operation: "expired-sweep", uploadId: "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f", decision: "expired-sweep", status: null, code: "upload_expired", durationMs: 0, bytes: 7, digest: null, expiresAt: "2020-01-01T00:00:00.000Z" };

  assert.equal(emitAuditLine(line, { log: { log: (message) => logged.push(message) }, sink }), true);

  assert.equal(logged.length, 1);
  assert.equal(logged[0], `[direct-upload] ${JSON.stringify(line)}`);
  const fileLine = fs.readFileSync(dayFile(dir, auditDayKey()), "utf8");
  assert.equal(fileLine, `${JSON.stringify(line)}\n`);
});

test("noteExpiredSweep records the startup sweep shape exposed on /healthz", () => {
  const sink = createAuditSink({ dir: tempDir("sweep"), log: SILENT });
  const report = { scanned: 3, kept: 1, orphanParts: 17, failures: 0, removed: [{ uploadId: "x" }, { uploadId: "y" }] };
  const noted = sink.noteExpiredSweep(report);
  assert.deepEqual(noted, { scanned: 3, removed: 2, kept: 1, orphanParts: 17, failures: 0, at: noted.at });
  assert.equal(typeof noted.at, "string");
  assert.deepEqual(sink.health().expiredUploadSweep, noted);
});

test("an invalid retentionDays is normalized to the 14-day default instead of deleting everything", () => {
  const dir = tempDir("retention-guard");
  fs.mkdirSync(dir, { recursive: true });
  const today = auditDayKey();
  fs.writeFileSync(dayFile(dir, today), "{\"keep\":true}\n");
  const sink = createAuditSink({ dir, retentionDays: 0, log: SILENT });
  assert.equal(sink.health().retentionDays, 14);
  sink.startup();
  // A 0/negative window would delete today's file too; the guard keeps it.
  assert.equal(fs.existsSync(dayFile(dir, today)), true);
  assert.equal(fs.readFileSync(dayFile(dir, today), "utf8"), "{\"keep\":true}\n");
});
