// #476: the startup warm-up must be invisible to requests. It reports a successful build, and on
// any failure it logs and resolves — never a rejection at the top level, because `server.js` calls
// it without a catch and a warm-up failure must not take the listener down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { warmVaultIndex } from "../src/vault-index-warmup.js";

function recorder() {
  const lines = [];
  return {
    lines,
    log: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}

test("a successful warm-up reports the build and returns the snapshot", async () => {
  const log = recorder();
  const snapshot = { stats: { files: 1048, durationMs: 9770 } };
  let calls = 0;
  const index = { getVaultIndex: async () => { calls += 1; return snapshot; } };

  assert.equal(await warmVaultIndex({ index, log }), snapshot);
  assert.equal(calls, 1, "the warm-up performs exactly one build");
  assert.deepEqual(log.lines, ["[vault-index] warm-up: 1048 notes in 9770 ms"]);
});

test("a failing warm-up logs the reason and resolves, so startup continues", async () => {
  const log = recorder();
  const index = { getVaultIndex: async () => { throw new Error("EACCES: /vault"); } };

  assert.equal(await warmVaultIndex({ index, log }), null);
  assert.deepEqual(log.lines, ["[vault-index] warm-up failed: EACCES: /vault"]);
});

test("a missing index runtime is a wiring error, not a silent no-op", async () => {
  await assert.rejects(warmVaultIndex({ index: {}, log: recorder() }), /getVaultIndex/);
});
