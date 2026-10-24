import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRetrievalRuntime } from "../src/vault-runtime/retrieval-runtime.js";

test("F4: queued sync/job rechecks generation at execution; entered work drains safely", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "w2-retrieval-queue-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  let allowed = true; let token = {}; let scans = 0;
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const indexPath = path.join(base, "index.json");
  const runtime = createRetrievalRuntime({ vaultRuntime: { id: "vault", paths: { retrievalIndex: indexPath } },
    deps: { authorization: { allowed: () => allowed, token: () => token },
      getVaultIndex: async () => { scans++; entered(); await barrier; return { records: [], stats: {} }; } } });
  const active = runtime.syncRetrievalIndex({ embeddings: false });
  await started; // this operation has actually begun and can finish after revoke
  const queued = runtime.syncRetrievalIndex({ embeddings: false });
  runtime.startRetrievalIndex({ embeddings: false });
  allowed = false; token = {};
  release();
  await active;
  await fs.rm(indexPath); // distinguish a fresh queued write from the entered operation's write
  const refused = await queued;
  await runtime.drainRetrievalIndex();
  assert.equal(refused.unavailable, true);
  assert.equal(refused.reason, "vault_runtime_lease_revoked");
  assert.equal(scans, 1, "queued work never reaches the index provider after revoke");
  await assert.rejects(fs.stat(indexPath), { code: "ENOENT" });
  assert.equal((await runtime.retrievalIndexStatus()).indexJob.status, "cancelled");
  // A generation change also cancels a queued operation if reapproval happened before it ran.
  allowed = true;
  const oldQueued = runtime.syncRetrievalIndex(); token = {};
  assert.equal((await oldQueued).unavailable, true);
  await assert.rejects(fs.stat(indexPath), { code: "ENOENT" });
  await runtime.syncRetrievalIndex();
  assert.equal(scans, 2, "current generation positive control");
});
