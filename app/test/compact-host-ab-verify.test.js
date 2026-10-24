// Synthetic fixtures only: these unit tests verify the W3-B evaluator,
// and MUST NEVER be reported as observed Agent/Host experiment results.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { W3B_CELLS, verifyCompactHostAB } from "../scripts/compact-host-ab-verify.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");

async function fixture({ deferSupported = true } = {}) {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "w3b-evidence-unit-"));
  const expected = hash("expected fixture result");
  const report = {
    schemaVersion: "1.0.0",
    source: {
      commitSha: "a".repeat(40),
      serverVersion: "test-only", fixtureManifestSha256: hash("manifest"),
      startedAt: "2026-10-20T00:00:00.000Z",
    },
    host: { name: "unit-test", version: "0.0-synthetic", model: "synthetic", deferSupported },
    repeats: 3,
    tasks: [{
      id: "read-note", promptSha256: hash("prompt"), fixtureSha256: hash("fixture"),
      expectedResultSha256: expected,
    }],
    trials: [],
  };
  report.source.fixtureManifestSha256 = hash(JSON.stringify(report.tasks));
  for (const cell of W3B_CELLS) for (let repeat = 0; repeat < report.repeats; repeat++) {
    const unsupported = cell.endsWith("-defer") && !deferSupported;
    const trace = {
      taskId: "read-note", cell, repeat, fixtureSha256: hash("fixture"),
      hostVersion: "0.0-synthetic", modelId: "synthetic", provenance: "real-host",
      status: unsupported ? "unsupported" : "ok",
      observedResultSha256: unsupported ? null : expected,
      wallMs: unsupported ? 0 : 320,
      inputTokens: unsupported ? 0 : 25,
      outputTokens: unsupported ? 0 : 12,
      descriptorTokens: unsupported ? 0 : 18,
      unauthorizedCalls: 0, unexpectedMutations: 0,
      calls: unsupported ? [] : [{ tool: "obsidian_read_read", action: "get_note", ok: true, denied: false }],
    };
    const file = cell + "-" + repeat + ".json";
    const raw = JSON.stringify(trace);
    await writeFile(path.join(evidenceRoot, file), raw);
    report.trials.push({ taskId: trace.taskId, cell, repeat, traceFile: file, traceSha256: hash(raw) });
  }
  return {
    evidenceRoot, report,
    async close() { await rm(evidenceRoot, { recursive: true, force: true }); },
  };
}

test("W3-B accepts fully matched four-cell synthetic matrix but never returns W3 GO", async () => {
  const f = await fixture();
  try {
    const result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.verdict, "EVIDENCE_VALID_PENDING_W3_GO");
    for (const cell of W3B_CELLS) {
      assert.equal(result.summary[cell].observed, 3);
      assert.equal(result.summary[cell].usable, 3);
      assert.equal(result.summary[cell].success, 3);
    }
  } finally { await f.close(); }
});

test("W3-B records unsupported deferred profiles without false completed trials", async () => {
  const f = await fixture({ deferSupported: false });
  try {
    const result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.summary["full-defer"].unsupported, 3);
    assert.equal(result.summary["compact-defer"].usable, 0);
  } finally { await f.close(); }
});

test("W3-B fails closed on missing trial and duplicate trial", async () => {
  const f = await fixture();
  try {
    f.report.trials.pop();
    let result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((x) => x.startsWith("Missing trial")));
    f.report.trials.push({ ...f.report.trials[0] });
    result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.ok(result.errors.some((x) => x.startsWith("Duplicate trial")));
  } finally { await f.close(); }
});

test("W3-B rejects trace tampering, fake success, unexpected mutations and secret-bearing fields", async () => {
  const f = await fixture();
  try {
    const trial = f.report.trials[0];
    const file = path.join(f.evidenceRoot, trial.traceFile);
    const trace = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(file, "utf8")));
    trace.unauthorizedCalls = 1;
    let raw = JSON.stringify(trace);
    await writeFile(file, raw);
    let result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.ok(result.errors.some((x) => x.includes("SHA-256 mismatch")));
    trial.traceSha256 = hash(raw);
    result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.ok(result.errors.some((x) => x.includes("security gate failed")));

    trace.unauthorizedCalls = 0;
    trace.observedResultSha256 = hash("wrong response");
    trace.apiKey = "DO-NOT-PERSIST";
    raw = JSON.stringify(trace);
    await writeFile(file, raw);
    trial.traceSha256 = hash(raw);
    result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((x) => x.includes("fields missing/unknown")));
  } finally { await f.close(); }
});

test("W3-B blocks trace path traversal and fabricated unsupported flags", async () => {
  const f = await fixture();
  try {
    const trial = f.report.trials[0];
    trial.traceFile = "../secret.json";
    let result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.ok(result.errors.some((x) => x.includes("missing/unsafe trace")));
    trial.traceFile = "full-eager-0.json";
    f.report.host.deferSupported = false;
    result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.ok(result.errors.some((x) => x.includes("claimed deferred run")));
  } finally { await f.close(); }
});


test("W3-B rejects a matching-hash symlink whose resolved target escapes evidenceRoot", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink privileges on Windows are runner-dependent; enforced by server on POSIX");
    return;
  }
  const f = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "w3b-external-"));
  try {
    const trial = f.report.trials[0];
    const externalPath = path.join(outside, "external.json");
    const raw = JSON.stringify({
      taskId: trial.taskId, cell: trial.cell, repeat: trial.repeat,
      fixtureSha256: hash("fixture"), hostVersion: "0.0-synthetic",
      modelId: "synthetic", provenance: "real-host", status: "ok",
      observedResultSha256: hash("expected fixture result"), wallMs: 1,
      inputTokens: 1, outputTokens: 1, descriptorTokens: 1,
      unauthorizedCalls: 0, unexpectedMutations: 0, calls: [],
    });
    await writeFile(externalPath, raw);
    await symlink(externalPath, path.join(f.evidenceRoot, "escape.json"));
    trial.traceFile = "escape.json";
    trial.traceSha256 = hash(raw);
    const result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((line) => line.includes("missing/unsafe trace")));
  } finally {
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
});


test("W3-B detects forged task edits even when every trace digest still matches", async () => {
  const f = await fixture();
  try {
    f.report.tasks[0].promptSha256 = hash("changed-after-freeze");
    const result = await verifyCompactHostAB(f.report, { evidenceRoot: f.evidenceRoot });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((line) => line.includes("Task manifest SHA-256")));
  } finally { await f.close(); }
});
