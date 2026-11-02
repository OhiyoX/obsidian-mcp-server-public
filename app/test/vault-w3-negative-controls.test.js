// #437 W3: mutation driver injects real violations; assertions stay unchanged.
// Contract: sha256:5240077f57b8dea1ac815b5c028f4797380ed7d495a9e7bf85f6020075895534.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { managedAdmin } from "./helpers/vault-w3-admin-harness.js";
import { INCARNATION_FILE } from "../src/vault-runtime/incarnation.js";
import { leaseOfHandle } from "../src/vault-runtime/runtime-lease.js";

const revoked = error => error.code === "VAULT_RUNTIME_LEASE_REVOKED";
async function reader(w) {
  const file = path.join(w.vaultsRoot, "alpha", "probe.md");
  await fs.writeFile(file, "authorized-body");
  const old = w.vaultRuntimeMap.get("alpha");
  assert.equal(await old.localFs.readLimitedText(file), "authorized-body");
  return { file, old, read: handle => handle.localFs.readLimitedText(file) };
}

test("NC1 map callback cannot write back into the published public facts", async t => {
  const w = await managedAdmin(t);
  const view = w.registry.composedCommit.current().instances;
  const before = [...view]; let callback; let attempted = false;
  view.forEach((_value, id, third) => {
    callback = third;
    // Try the leak before checking shape: writable third argument changes facts
    // even when the top-level view has no set/delete methods.
    // Mutate once: a writable forEach visits appended entries, so delete/reinsert
    // on every callback would loop instead of yielding an assertion counterexample.
    if (attempted) return;
    attempted = true; third.delete?.(id); third.set?.("injected", { generation: 999 });
  });
  assert.deepEqual([...view], before, "forEach must not expose writable membership");
  assert.equal(callback, view);
  assert.equal(view.get("alpha").runtime, undefined, "no raw runtime entries");
  assert.equal(Reflect.set(view.get("alpha"), "generation", 999), false);
  assert.equal(view.get("alpha").generation, 1);
  assert.equal(w.vaultRuntimeMap.has("alpha"), true);
});

test("NC2 set callback cannot write back into the serving allow-set", async t => {
  const w = await managedAdmin(t);
  const view = w.registry.composedCommit.current().serving.allowedSet;
  const before = [...view]; let callback; let attempted = false;
  view.forEach((id, _key, third) => {
    callback = third;
    if (attempted) return;
    attempted = true; third.delete?.(id); third.add?.("injected");
  });
  assert.deepEqual([...view], before, "forEach must not expose writable serving membership");
  assert.equal(callback, view); assert.equal(view.has("injected"), false);
  await w.controller.revoke("alpha", { actor: "admin:fixture" });
  const refusals = w.registry.composedCommit.current().serving.refusals;
  const denied = [...refusals];
  refusals.forEach((value, id, third) => {
    third.delete?.(id); assert.equal(Reflect.set(value, "httpStatus", 200), false);
  });
  assert.deepEqual([...refusals], denied);
});

test("NC3 captured old handle cannot inherit a new approved handle's lease", async t => {
  const w = await managedAdmin(t); const r = await reader(w);
  await w.controller.approve("alpha", { actor: "admin:fixture" });
  const fresh = w.vaultRuntimeMap.get("alpha");
  assert.notEqual(fresh, r.old); assert.equal(await r.read(fresh), "authorized-body");
  assert.throws(() => r.read(r.old), revoked, "old consumer remains permanently refused");
});

test("NC4 generation boundary refuses a captured consumer before re-resolution", async t => {
  const w = await managedAdmin(t); const r = await reader(w);
  await w.controller.approve("alpha", { actor: "admin:fixture" });
  assert.equal(w.registry.admission("alpha").generation, 2);
  assert.throws(() => r.read(r.old), revoked, "consumer checks committed generation itself");
});

test("NC5 equal numeric generations after proof recovery must remint a live handle", async t => {
  const w = await managedAdmin(t); const r = await reader(w);
  const proof = path.join(w.vaultsRoot, "alpha", INCARNATION_FILE);
  const bytes = await fs.readFile(proof); await fs.rm(proof);
  assert.throws(() => r.read(r.old), revoked);
  assert.equal(leaseOfHandle(r.old).revoked, true);
  await fs.writeFile(proof, bytes);
  await w.controller.approve("alpha", { actor: "admin:fixture" });
  assert.equal(w.registry.admission("alpha").generation, leaseOfHandle(r.old).generation,
    "authority and local revoked counter really collide");
  const fresh = w.vaultRuntimeMap.get("alpha");
  assert.notEqual(fresh, r.old, "equal numbers cannot resurrect a revoked object");
  assert.equal(await r.read(fresh), "authorized-body");
  assert.throws(() => r.read(r.old), revoked);
  assert.equal(w.vaultRuntimeMap.get("alpha"), fresh, "healthy resolution stays idempotent");
});

test("NC6 missing identity proof refuses captured consumer I/O before any scan", async t => {
  const w = await managedAdmin(t); const r = await reader(w);
  const revision = w.registry.snapshot().revision;
  await fs.rm(path.join(w.vaultsRoot, "alpha", INCARNATION_FILE));
  assert.throws(() => r.read(r.old), revoked, "consumer checks actual proof, not stored id");
  assert.equal(w.registry.snapshot().revision, revision);
});

test("NC7 runtime-map caller cannot resolve a refused id still in private membership", async t => {
  const w = await managedAdmin(t); const r = await reader(w);
  w.registry.refuse("alpha", { code: "NOT_APPROVED", httpStatus: 403, reason: "awaiting-approval" });
  assert.ok(w.vaultRuntimeMap.ids().includes("alpha"), "entry really remains materialized");
  assert.equal(w.vaultRuntimeMap.get("alpha"), undefined, "presence is not authorization");
  assert.throws(() => r.read(r.old), revoked);
});
