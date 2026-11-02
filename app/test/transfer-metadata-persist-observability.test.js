// Issue #693 — a metadata write that fails must never be silent.
//
// The reported shape: under a read-while-write race, `writeJsonAtomic`'s `fs.rename` answers EPERM on
// Windows; two writers caught that as `markFailed(...).catch(() => {})`, so the process believed the
// handle was `failed-retryable` while the durable metadata still said `uploading` — and nothing (no
// counter, no log, no audit line) recorded that the write had failed at all.
//
// These tests pin the three things the issue asks for, from the outside (the runtime's own answers and
// the files it writes), with a deterministic rename seam instead of a real Windows race:
//   1. EPERM/EACCES/EBUSY are retried a bounded number of times and the retries are counted;
//   2. a write that still fails is COUNTED + WARNED + AUDITED, and the caller's answer is unchanged
//      (the body error still wins, a structured code still wins) — no double counting either;
//   3. other errno values are not retried, so the policy cannot hide a real failure behind 4 attempts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";

import { vaultDataKey } from "../src/vault-runtime/descriptor.js";
import { vaultDataPaths } from "../src/vault-runtime/paths.js";
import { createVaultRuntime } from "../src/vault-runtime/runtime.js";
import {
  UPLOAD_INTEGRITY_MISMATCH,
  createTransferRuntime,
} from "../src/vault-runtime/transfer-runtime.js";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "transfer-persist-693-"));
const DEPS = Object.freeze({ requireRequestAuthor: () => ({ agent: "issue-693", model: "test" }) });
const LIMITS = Object.freeze({ maxTransferBytes: 1_000_000, chunkBytes: 1024, ttlMs: 60_000 });
const PROTECTED_ROOTS = new Set([".git", ".obsidian"]);

after(() => fs.rm(scratch, { recursive: true, force: true }));

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

let vaultCounter = 0;
async function makeVaultRuntime() {
  vaultCounter += 1;
  const id = `persist-${vaultCounter}`;
  const root = path.join(scratch, id, "vault");
  const dataRoot = path.join(scratch, id, "data");
  await fs.mkdir(root, { recursive: true });
  return createVaultRuntime({
    descriptor: { id, name: id, root, primary: false },
    paths: vaultDataPaths({ primary: false, dataRoot, dataKey: vaultDataKey(id) }),
    deps: DEPS,
  });
}

/**
 * A `renameFile` with a switch: while `state.fail` is on it answers `state.code` instead of renaming,
 * and it records the exact number of attempts so a test can assert the bound (not just "it worked").
 */
function renameSeam(overrides = {}) {
  const state = { fail: false, calls: 0, code: "EPERM", ...overrides };
  const fn = async (from, to) => {
    state.calls += 1;
    if (state.fail) {
      const error = new Error(`${state.code}: cannot rename '${path.basename(from)}' -> '${path.basename(to)}'`);
      error.code = state.code;
      throw error;
    }
    await fs.rename(from, to);
  };
  return { state, fn };
}

/** Capture warn/audit output: a unit test must not write into the real `DATA_PATH/audit` stream. */
function observers() {
  const warnings = [];
  const lines = [];
  return {
    warnings,
    lines,
    log: { warn: (message) => warnings.push(String(message)), log: () => {}, error: () => {} },
    audit: (line) => lines.push(line),
  };
}

async function harness({ retry, rename } = {}) {
  const vault = await makeVaultRuntime();
  const seam = rename ? { state: rename.state, fn: rename.fn } : renameSeam();
  const seen = observers();
  const runtime = createTransferRuntime({
    vaultRuntime: vault,
    deps: {
      limits: LIMITS,
      protectedRoots: PROTECTED_ROOTS,
      directUploadMaxBytes: 500_000,
      renameFile: seam.fn,
      log: seen.log,
      audit: seen.audit,
      // Zero backoff: what is under test is the attempt bound, not the wall clock.
      persistRetry: { baseDelayMs: 0, maxDelayMs: 0, ...retry },
    },
  });
  return { runtime, state: seam.state, vault, ...seen };
}

/** A body whose first read turns the rename failure ON — i.e. after the handle's own write, before the failing step. */
function bodyThatFlips(buffer, state, { failWith = null } = {}) {
  let pushed = false;
  return new Readable({
    read() {
      if (failWith) {
        state.fail = true;
        this.destroy(failWith);
        return;
      }
      if (!pushed) {
        pushed = true;
        state.fail = true;
        this.push(buffer);
      }
      this.push(null);
    },
  });
}

async function readMetadata(vault, uploadId) {
  return JSON.parse(await fs.readFile(path.join(vault.paths.transfersUploads, `${uploadId}.json`), "utf8"));
}

test("#693: a transient EPERM is retried, the handle is written, and the retry is counted", async () => {
  const seam = renameSeam({ fail: true });
  // Heal after the first attempt: the shape of "an editor briefly held the file open".
  const original = seam.fn;
  let attempts = 0;
  const healing = async (from, to) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("EPERM: resource busy or locked");
      error.code = "EPERM";
      throw error;
    }
    await fs.rename(from, to);
  };
  void original;
  const { runtime, vault, warnings, lines } = await harness({ rename: { state: seam.state, fn: healing } });

  const payload = Buffer.from("retry-me");
  const handle = await runtime.startDirectUpload(
    { vaultPath: "attachments/retry.bin", totalBytes: payload.length, expectedSha256: digest(payload) },
    vault.id,
  );

  assert.match(handle.uploadId, /^[0-9a-f-]{36}$/, "the retried rename landed: the handle is real");
  assert.equal(attempts, 2, "one failed attempt + one successful retry");
  assert.deepEqual(
    { retries: runtime.diagnostics().metadataWriteRetries, failures: runtime.diagnostics().metadataWriteFailures },
    { retries: 1, failures: 0 },
    "a retry that heals is counted as a retry and NOT as a failure",
  );
  assert.deepEqual(warnings, [], "a healed retry is not a warning");
  assert.deepEqual(lines, [], "a healed retry writes no audit line");
  assert.equal((await readMetadata(vault, handle.uploadId)).status, "uploading");
});

test("#693: a failed markFailed is counted once, warned and audited, and the body error still wins", async () => {
  const { runtime, state, vault, warnings, lines } = await harness();
  const payload = Buffer.alloc(32, 7);
  const handle = await runtime.startDirectUpload(
    { vaultPath: "attachments/f.bin", totalBytes: payload.length, expectedSha256: digest(payload) },
    vault.id,
  );

  const bodyFailure = new Error("client vanished mid-body");
  const error = await runtime
    .receiveDirectUpload(
      { uploadId: handle.uploadId, stream: bodyThatFlips(payload, state, { failWith: bodyFailure }), contentLength: payload.length },
      vault.id,
    )
    .then(
      () => assert.fail("expected the interrupted body to reject"),
      (rejection) => rejection,
    );

  assert.equal(error, bodyFailure, "the body error is the error the caller sees — a persist failure may not replace it");

  const diagnostics = runtime.diagnostics();
  assert.equal(diagnostics.metadataWriteFailures, 1, "exactly one failure: the write is not counted twice by its wrapper");
  assert.equal(diagnostics.lastFailure.stage, "mark-failed");
  assert.equal(diagnostics.lastFailure.reason, "interrupted");
  assert.equal(diagnostics.lastFailure.code, "EPERM");
  assert.equal(diagnostics.lastFailure.uploadId, handle.uploadId);

  assert.equal(warnings.length, 1, "exactly one warning — not zero (the old `.catch(() => {})`), not a flood");
  assert.match(warnings[0], /metadata write failed during mark-failed \(interrupted\)/);
  assert.match(warnings[0], /EPERM/);

  assert.equal(lines.length, 1, "exactly one audit line for the failure");
  assert.deepEqual(
    {
      event: lines[0].event, operation: lines[0].operation, decision: lines[0].decision,
      code: lines[0].code, stage: lines[0].stage, reason: lines[0].reason,
      vaultId: lines[0].vaultId, persistFailures: lines[0].persistFailures,
    },
    {
      event: "direct-upload", operation: "metadata-persist", decision: "failed",
      code: "EPERM", stage: "mark-failed", reason: "interrupted",
      vaultId: vault.id, persistFailures: 1,
    },
    "the audit line carries the stage, the errno and the running counter",
  );
  assert.equal(lines[0].uploadId, handle.uploadId.slice(0, 8), "short id, like every other direct-upload line");
  assert.equal(JSON.stringify(lines[0]).includes("client vanished"), false, "no free-text error prose in the line");

  // The phenomenon itself, still true and now observable: the disk cannot record the failure, so the
  // handle keeps its previous status. That is exactly why the counter/audit path has to exist.
  assert.equal((await readMetadata(vault, handle.uploadId)).status, "uploading");
  assert.equal(runtime.diagnostics().metadataWriteFailures, 1, "reading a status never bumps the counter");
});

test("#693: a persist failure during a structured answer keeps the structured code", async () => {
  const { runtime, state, vault, lines } = await harness();
  const payload = Buffer.alloc(16, 3);
  const handle = await runtime.startDirectUpload(
    // Deliberately wrong digest: the publish step must answer UPLOAD_INTEGRITY_MISMATCH, not a raw errno.
    { vaultPath: "attachments/bad-sha.bin", totalBytes: payload.length, expectedSha256: digest(Buffer.from("other")) },
    vault.id,
  );

  await assert.rejects(
    runtime.receiveDirectUpload(
      { uploadId: handle.uploadId, stream: bodyThatFlips(payload, state), contentLength: payload.length },
      vault.id,
    ),
    (error) => error.code === UPLOAD_INTEGRITY_MISMATCH,
    "the SHA-256 answer survives a failed metadata write",
  );
  assert.equal(runtime.diagnostics().metadataWriteFailures, 1);
  assert.equal(lines[0].stage, "mark-failed");
  assert.equal(lines[0].reason, "sha256-mismatch");
});

test("#693: the retry is bounded (attempts total tries) and then the failure surfaces", async () => {
  const { runtime, state, vault, warnings } = await harness({ retry: { attempts: 3 } });
  state.fail = true;

  const payload = Buffer.from("never-written");
  await assert.rejects(
    runtime.startDirectUpload({ vaultPath: "attachments/x.bin", totalBytes: payload.length, expectedSha256: digest(payload) }, vault.id),
    (error) => error.code === "EPERM",
    "a handle whose metadata cannot be recorded is not silently handed out",
  );
  assert.equal(state.calls, 3, "attempts=3 means three total tries, i.e. two retries");
  assert.equal(runtime.diagnostics().metadataWriteRetries, 2);
  assert.equal(runtime.diagnostics().metadataWriteFailures, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /during write-metadata/);
});

test("#693 negative control: a non-retryable errno is not retried", async () => {
  const seam = renameSeam({ fail: true, code: "ENOSPC" });
  const { runtime, vault } = await harness({ rename: seam });

  const payload = Buffer.from("nope");
  await assert.rejects(
    runtime.startDirectUpload({ vaultPath: "attachments/y.bin", totalBytes: payload.length, expectedSha256: digest(payload) }, vault.id),
    (error) => error.code === "ENOSPC",
  );
  assert.equal(seam.state.calls, 1, "ENOSPC is a real failure, not a lock to wait out");
  assert.equal(runtime.diagnostics().metadataWriteRetries, 0);
  assert.equal(runtime.diagnostics().metadataWriteFailures, 1);
});

test("#693: diagnostics() hands out a copy, never the runtime's own counters", async () => {
  const { runtime } = await harness();
  const snapshot = runtime.diagnostics();
  snapshot.metadataWriteFailures = 99;
  snapshot.lastFailure = { stage: "forged" };
  assert.deepEqual(
    { failures: runtime.diagnostics().metadataWriteFailures, lastFailure: runtime.diagnostics().lastFailure },
    { failures: 0, lastFailure: null },
  );
});
