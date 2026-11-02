import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { managedAdmin, TAB, httpEvidence } from "./helpers/vault-w3-admin-harness.js";

test("W3 real Admin refresh uses the managed publication and retains inventory on failure", async t => {
  const w = await managedAdmin(t);
  const before = w.registry.snapshot().revision;
  assert.equal((await w.request()).response.status, 200);
  assert.equal(w.registry.snapshot().revision, before, "GET never scans");
  await w.beta();
  const bad = await w.request(`${TAB}/refresh`, {}, { csrf: "invalid" });
  httpEvidence(`${TAB}/refresh`, bad, "invalid");
  assert.equal(bad.response.status, 403);
  assert.equal(w.registry.snapshot().revision, before);
  const good = await w.request(`${TAB}/refresh`, {});
  httpEvidence(`${TAB}/refresh`, good);
  assert.equal(good.response.status, 200);
  const snapshot = w.registry.snapshot();
  const record = w.registry.composedCommit.current();
  assert.ok(snapshot.revision > before);
  assert.equal(record.snapshot, snapshot, "registry reads the one publication record");
  assert.equal(record.revision, w.controller.store.revision(), "durable commit revision matches");
  assert.deepEqual([...record.instances.keys()].sort(), w.vaultRuntimeMap.ids().sort());
  assert.deepEqual([...record.serving.allowedSet].sort(), w.registry.list().map(v => v.id).sort());
  assert.equal(w.controller.store.entryFor("beta").admission, "pending");
  assert.equal(w.vaultRuntimeMap.has("beta"), false);
  assert.equal(w.primaryAuthorized(), true);
  const inventory = (await w.vaultGitAdmin.model()).vaults.map(v => v.id).sort();
  assert.ok(inventory.includes("alpha"));
  console.log("PUBLICATION", JSON.stringify({ before, revision: record.revision,
    durableRevision: w.controller.store.revision(), instances: [...record.instances.keys()],
    serving: [...record.serving.allowedSet], primaryAuthorized: w.primaryAuthorized() }));
  await fs.rename(w.vaultsRoot, `${w.vaultsRoot}-offline`);
  await fs.writeFile(w.vaultsRoot, "not a directory");
  const failed = await w.request(`${TAB}/refresh`, {});
  httpEvidence(`${TAB}/refresh`, failed);
  assert.equal(failed.response.status, 503);
  assert.equal(w.registry.snapshot().revision, snapshot.revision);
  assert.deepEqual((await w.vaultGitAdmin.model()).vaults.map(v => v.id).sort(), inventory,
    "failure must not demote a managed inventory to primary only");
  assert.equal((await w.request()).response.status, 200);
  await fs.rm(w.vaultsRoot);
  await fs.rename(`${w.vaultsRoot}-offline`, w.vaultsRoot);
  const recovered = await w.request(`${TAB}/refresh`, {});
  httpEvidence(`${TAB}/refresh`, recovered);
  assert.equal(recovered.response.status, 200);
});
