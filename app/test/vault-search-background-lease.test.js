// W2FIX3 (#437 RETURN-2, item 5) — the SEARCH / index background consumer is wired into the lease.
//
// The Git half of item 5 is covered by `vault-background-lease.test.js` (a real sweep timer). This
// file closes the equivalent hole on the retrieval side, which is the one remaining place a Vault
// consumer can arm NEW background work by itself:
//
//   * the per-Vault index runtime calls `scheduleRetrievalRefresh()` whenever it invalidates
//     (`vault-index-runtime.js` `invalidate()`); in `search-runtime.js` that dep is wired to this
//     Vault's retrieval runtime.
//   * `drain()` promotes a PENDING timer, but an in-flight index build that completes AFTER the
//     drain would call `scheduleRetrievalRefresh()` again and resurrect a timer for a Vault whose
//     authorization was already revoked.
//
// The fix re-checks the consumer handle's lease on every arm (`mayScheduleWork`). The write itself is
// already gated one level deeper (the facade wraps `localFs` as a nested leased service, so a
// revoked build cannot touch the filesystem), but WITHOUT the arm guard a revoked handle still arms a
// doomed background timer and runs a failing job on every index invalidation. This test isolates that
// effect deterministically: the positive control shows a live arm produces a completed job + the
// index file; the negative control shows an armed-but-revoked handle produces NO job at all. The
// negative control genuinely goes red when the guard is removed (the job then appears as `failed`).
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load), the
// same shape `search-runtime-composition.test.js` uses.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-w2fix3-searchlease-"));
const VAULT_ROOT = path.join(ROOT, "vaults");
const DATA_ROOT = path.join(ROOT, "data");
const PRIMARY_ROOT = path.join(VAULT_ROOT, "primary");

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULT_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.HISTORY_PATH = path.join(DATA_ROOT, "history");
process.env.TRASH_PATH = path.join(DATA_ROOT, "trash");
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA_ROOT, "index", "retrieval-index.json");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.RETRIEVAL_AUTO_EMBED = "false";

await fs.mkdir(PRIMARY_ROOT, { recursive: true });
await fs.mkdir(DATA_ROOT, { recursive: true });

const { MAX_READ_BYTES } = await import("../src/config.js");
const { allTagsForNote, documentMap, extractLinks, parseFrontmatter } = await import("../src/obsidian.js");
const { createVaultRuntime } = await import("../src/vault-runtime/runtime.js");
const { secondaryVaultDataPaths } = await import("../src/vault-runtime/paths.js");
const { vaultDataKey } = await import("../src/vault-runtime/descriptor.js");
const { createVaultSearchRuntime } = await import("../src/vault-runtime/search-runtime.js");
const { createLeasedRuntime, createRuntimeLease, mayScheduleWork, revokeRuntimeLease } = await import("../src/vault-runtime/runtime-lease.js");

const INDEX_DEPS = Object.freeze({ parseFrontmatter, documentMap, extractLinks, allTagsForNote, maxReadBytes: MAX_READ_BYTES });
const exists = (file) => fs.access(file).then(() => true, () => false);

test.after(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

/** A real secondary search runtime whose consumer handle is a LEASED facade (the shape D0's map hands out). */
async function makeSecondary(id) {
  const root = path.join(VAULT_ROOT, id);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "one.md"), `# One\n\n${id} alpha\n`, "utf8");
  const dataKey = vaultDataKey(id);
  const runtime = createVaultRuntime({
    descriptor: { id, name: id, root, primary: false, writable: true },
    paths: secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey }),
    dataRoot: path.join(DATA_ROOT, "vaults", dataKey),
  });
  const lease = createRuntimeLease(id, { generation: 1 });
  const facade = createLeasedRuntime(runtime, lease, () => lease.revoked !== true);
  const search = createVaultSearchRuntime({ vaultRuntime: facade, deps: { ...INDEX_DEPS } });
  return { search, lease, facade };
}

test("ITEM 5 (control): a live handle's index invalidation really arms and completes a retrieval job", async () => {
  const { search } = await makeSecondary("live");
  assert.equal(await exists(search.retrieval.indexPath), false, "no index before the first refresh");
  search.index.invalidate();
  assert.equal(await exists(search.retrieval.indexPath), false, "the debounced refresh is still pending, not yet written");
  await search.drain();
  assert.equal((await search.retrieval.retrievalIndexStatus())?.indexJob?.status, "completed", "a live handle's scheduled refresh runs to completion — the observation is valid");
  assert.equal(await exists(search.retrieval.indexPath), true, "the completed refresh wrote this Vault's index");
});

test("ITEM 5: a revoked handle never arms a background refresh (no post-drain resurrection)", async () => {
  const { search, lease, facade } = await makeSecondary("revoked");
  revokeRuntimeLease(lease, "revoked");
  assert.equal(mayScheduleWork(facade), false, "a revoked facade may not schedule new work");
  // An invalidation arriving AFTER the revoke (e.g. from a build that outlived `drain()`) must be inert:
  // no timer is armed, so no doomed job is started and nothing is written.
  await search.drain();
  search.index.invalidate();
  await search.drain();
  assert.equal((await search.retrieval.retrievalIndexStatus())?.indexJob ?? null, null, "a revoked handle never starts a background retrieval job");
  assert.equal(await exists(search.retrieval.indexPath), false, "a revoked handle never writes the retrieval index");
});
