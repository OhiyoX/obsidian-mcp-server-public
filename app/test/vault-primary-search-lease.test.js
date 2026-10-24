// W2FIX5 (#437 W2FIX4 item B / R2) — the PROCESS-SHARED PRIMARY search consumer is bound to the
// consumer handle's lease/generation, including an ALREADY-ARMED retrieval callback.
//
// The seat's W2FIX4 counterexample used the real primary index/retrieval and the production
// `scheduleRetrievalRefresh`: after a durable revoke the captured debounce callback still wrote the
// index and completed the job, because `searchRuntimeFor` unwrapped the leased primary handle and
// returned the process-shared raw search instance, and `releaseSearchRuntime` ignored the primary.
//
// This test arms a REAL production callback, durably revokes, and invokes the captured callback
// directly: nothing may be written and no new job may start. After a re-approval the OLD callback
// stays refused while a fresh handle's facade can do real work. The retrieval runtime uses the bare
// global timer functions, so the test swaps only those to make the callback invocation deterministic.
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-w2fix5-searchlease-"));
const VAULT_ROOT = path.join(ROOT, "vaults");
const DATA_ROOT = path.join(ROOT, "data");
const PRIMARY_ROOT = path.join(VAULT_ROOT, "primary");
const INDEX_PATH = path.join(DATA_ROOT, "index", "retrieval-index.json");

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULT_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.HISTORY_PATH = path.join(DATA_ROOT, "history");
process.env.TRASH_PATH = path.join(DATA_ROOT, "trash");
process.env.RETRIEVAL_INDEX_PATH = INDEX_PATH;
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.RETRIEVAL_AUTO_EMBED = "false";

await fs.mkdir(PRIMARY_ROOT, { recursive: true });
await fs.mkdir(DATA_ROOT, { recursive: true });
await fs.writeFile(path.join(PRIMARY_ROOT, "note.md"), "# Note\n\nprimary alpha body\n", "utf8");

const { primaryRuntime } = await import("../src/vault.js");
const { primaryRetrievalRuntime } = await import("../src/retrieval.js");
const { searchRuntimeFor, releaseSearchRuntime } = await import("../src/search-runtimes.js");
const { createLeasedRuntime, createRuntimeLease, revokeRuntimeLease } = await import("../src/vault-runtime/runtime-lease.js");

const exists = (file) => fs.access(file).then(() => true, () => false);

/** Swap the bare global timers so an armed debounce callback can be invoked deterministically. */
function captureTimers() {
  const captured = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false, unref() {} };
    captured.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle !== null && typeof handle === "object" && "cleared" in handle) handle.cleared = true;
    else realClear(handle);
  };
  return { captured, restore() { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; } };
}

test.after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

test("R2: a durable revoke stops the process-shared primary search, and an armed callback cannot write", async () => {
  const lease = createRuntimeLease(primaryRuntime.id, { generation: 1 });
  const facade = createLeasedRuntime(primaryRuntime, lease, () => lease.revoked !== true);
  const search = searchRuntimeFor(facade);
  assert.notEqual(search, primaryRuntime, "a leased primary handle must not receive the raw process instance");
  assert.equal(search.vaultId, primaryRuntime.id);

  const timers = captureTimers();
  let pending;
  let healthyJob;
  try {
    // Healthy positive control: a live handle's armed callback really writes this Vault's index.
    search.retrieval.scheduleRetrievalRefresh({ embeddings: false });
    const healthy = timers.captured.at(-1);
    assert.equal(typeof healthy?.fn, "function", "the production scheduleRetrievalRefresh armed a callback");
    healthy.fn();
    await primaryRetrievalRuntime.drainRetrievalIndex();
    assert.equal(await exists(INDEX_PATH), true, "the live callback wrote the index (control)");
    healthyJob = (await primaryRetrievalRuntime.retrievalIndexStatus())?.indexJob ?? null;

    // Arm a NEW pending refresh while the handle is current, then durably revoke.
    search.retrieval.scheduleRetrievalRefresh({ embeddings: false });
    pending = timers.captured.at(-1);
    revokeRuntimeLease(lease, "revoked");
    assert.equal(releaseSearchRuntime(facade), true, "the primary handle is released (the seat's old false)");
    assert.equal(pending.cleared, true, "the revoke clears the armed primary retrieval timer");
  } finally {
    timers.restore();
  }

  await fs.rm(INDEX_PATH, { force: true });
  await fs.writeFile(path.join(PRIMARY_ROOT, "after-revoke.md"), "# after revoke\n", "utf8");
  // The seat invoked the captured callback directly after the revoke. It must not write.
  pending.fn();
  await primaryRetrievalRuntime.drainRetrievalIndex();
  assert.equal(await exists(INDEX_PATH), false, "a revoked primary callback never writes the index");
  assert.equal(((await primaryRetrievalRuntime.retrievalIndexStatus())?.indexJob ?? null)?.id, healthyJob?.id ?? null, "no NEW retrieval job was started by the revoked callback");

  // Re-approval: the OLD callback stays refused; a fresh handle's facade can do real work.
  const freshLease = createRuntimeLease(primaryRuntime.id, { generation: 2 });
  const freshFacade = createLeasedRuntime(primaryRuntime, freshLease, () => freshLease.revoked !== true);
  const freshSearch = searchRuntimeFor(freshFacade);
  assert.notEqual(freshSearch, search, "each generation gets its own facade");
  pending.fn();
  await primaryRetrievalRuntime.drainRetrievalIndex();
  assert.equal(await exists(INDEX_PATH), false, "the previous generation's callback never revives");
  freshSearch.retrieval.startRetrievalIndex({ embeddings: false, force: true });
  await primaryRetrievalRuntime.drainRetrievalIndex();
  assert.equal(await exists(INDEX_PATH), true, "a current handle's facade can still start a real job");
});
