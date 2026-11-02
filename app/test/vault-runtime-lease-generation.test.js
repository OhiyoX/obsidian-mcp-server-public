// W2FIX3 (#437 RETURN-2, item 4) — every outward handle is bound to a real identity AND generation.
//
// Independent negative controls for the second seat ruling §2.3:
//   * "paused scan → revoke → approve ⇒ the OLD secondary handle is reused and reads again; its lease
//     generation is 0 while the admission generation is 3": the handle must be bound to the admission
//     generation, and a re-approval must mint a NEW generation/facade; the old facade never revives.
//   * "capture the real primary runtime, revoke the primary, and its captured handle still reads
//     primary-body": the PRIMARY consumer handle is under the same operation gate.
//   * "cache reuse key / current predicate must check identity+generation, not just id + boolean":
//     an unchanged generation returns the SAME facade; a moved generation returns a different one.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdmissionStore } from "../src/vault-runtime/admission-store.js";
import { CAPABILITY_KEYS, unavailable } from "../src/vault-runtime/descriptor.js";
import { resolveVaultIdentity } from "../src/vault-runtime/identity.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createReconciliationService } from "../src/vault-runtime/reconciliation.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";
import { VAULT_RUNTIME_LEASE_REVOKED, leaseOfHandle } from "../src/vault-runtime/runtime-lease.js";

const ACTOR = "admin:test-session";
const quiet = { info() {}, warn() {}, log() {} };
const allCaps = () => Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, unavailable("test")]));

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function makeWorld({ vaults = [], resolveIdentity, retryDelayMs = 100 } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix3-lease-"));
  const primaryRoot = path.join(base, "primary");
  const vaultsRoot = path.join(base, "vaults");
  await fs.mkdir(primaryRoot, { recursive: true });
  await fs.mkdir(vaultsRoot, { recursive: true });
  for (const id of vaults) await fs.mkdir(path.join(vaultsRoot, id), { recursive: true });
  const file = path.join(base, "data", "vault-admissions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });

  const servingGate = createVaultServingGate();
  servingGate.arm();
  const holder = { service: null };
  const registry = createVaultRegistry({
    primaryRoot, primaryId: "vault", vaultsRoot, capabilitiesFor: allCaps,
    gate: (descriptor) => holder.service.gate(descriptor),
    servingGate,
  });
  const store = createAdmissionStore({ file, logger: quiet });
  await store.load();
  const primaryRuntime = {
    id: "vault", root: primaryRoot, primary: true,
    localFs: { async readLimitedText() { return "primary-body"; }, async writeText() { return { ok: true }; }, drain() {}, dispose() {} },
  };
  const map = createVaultRuntimeMap({
    registry, dataRoot: path.join(base, "data"), primaryRuntime,
    createRuntime: ({ descriptor }) => ({
      id: descriptor.id, root: descriptor.root, primary: false, descriptor,
      localFs: { async readLimitedText() { return `${descriptor.id}-body`; }, async writeText() { return { ok: true }; }, drain() {}, dispose() {} },
    }),
  });
  const service = createReconciliationService({ registry, runtimeMap: map, admissions: store, resolveIdentity: resolveIdentity ?? resolveVaultIdentity, retryDelayMs, logger: quiet });
  holder.service = service;
  const world = {
    base, registry, store, service, map, servingGate,
    id: (name) => path.join(vaultsRoot, name),
    async cleanup() { service.stop(); await fs.rm(base, { recursive: true, force: true }); },
  };
  await service.initializeVaults({ confirm: vaults, actor: ACTOR, source: "test-admin-list" });
  return world;
}

test("ITEM 4: paused scan → revoke → approve never revives the old secondary handle", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let barrierActive = false;
  let paused = false;
  const world = await makeWorld({
    vaults: ["alpha"],
    resolveIdentity: async (options) => {
      if (barrierActive && !paused) { paused = true; await barrier; }
      return resolveVaultIdentity(options);
    },
  });
  try {
    await world.service.reconcile("startup");
    const oldHandle = world.map.get("alpha");
    const oldLease = world.map.leaseOf("alpha");
    assert.equal(await oldHandle.localFs.readLimitedText("a.md"), "alpha-body");
    const generationBefore = world.registry.admission("alpha").generation;
    assert.equal(oldLease.generation, generationBefore, "the handle is bound to the admission generation, not a local 0");
    assert.equal(world.map.get("alpha"), oldHandle, "an unchanged generation reuses the SAME facade");

    // Pause a scan, revoke then re-approve while it is in flight (both coalesce).
    barrierActive = true;
    const pausedRound = world.service.reconcile("manual");
    assert.ok(await waitFor(() => paused), "the scan is paused");
    assert.equal((await world.service.revoke("alpha", { actor: ACTOR })).status, "coalesced");
    // Immediately after the revoke the captured handle is dead (no dependence on the scan).
    await assert.rejects(async () => oldHandle.localFs.readLimitedText("a.md"), (error) => error.code === VAULT_RUNTIME_LEASE_REVOKED);
    assert.equal(oldLease.revoked, true, "the old lease is irreversibly latched");
    assert.equal((await world.service.approve("alpha", { actor: ACTOR })).status, "coalesced");
    release();
    const stale = await pausedRound;
    assert.equal(stale.status, "not-published", "the paused round discards its candidate (revision CAS)");
    assert.ok(await waitFor(() => !world.service.status().inFlight), "the round completes");
    assert.ok(await waitFor(() => world.registry.get("alpha") !== undefined), "the re-run converges and re-publishes the re-approved Vault");

    // A NEW approval mints a NEW generation and a DIFFERENT facade; the old one never revives.
    const currentGeneration = world.registry.admission("alpha").generation;
    assert.ok(currentGeneration > generationBefore, "the re-approval advanced the generation");
    const newHandle = world.map.get("alpha");
    assert.notEqual(newHandle, oldHandle, "the old facade is never handed out again");
    assert.equal(leaseOfHandle(newHandle).generation, currentGeneration);
    assert.equal(await newHandle.localFs.readLimitedText("a.md"), "alpha-body", "the new generation serves");
    await assert.rejects(async () => oldHandle.localFs.readLimitedText("a.md"), (error) => error.code === VAULT_RUNTIME_LEASE_REVOKED, "the old facade is dead for good");
  } finally {
    world.service.stop();
    await world.cleanup();
  }
});

test("ITEM 4: the PRIMARY consumer handle is under the same operation gate", async () => {
  const world = await makeWorld({ vaults: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    const primaryHandle = world.map.get("vault");
    assert.ok(primaryHandle, "the primary resolves while approved");
    assert.equal(await primaryHandle.localFs.readLimitedText("note.md"), "primary-body", "positive control: the raw primary bytes are reachable through the handle");

    await world.service.revoke("vault", { actor: ACTOR });
    await assert.rejects(async () => primaryHandle.localFs.readLimitedText("note.md"), (error) => error.code === VAULT_RUNTIME_LEASE_REVOKED, "a captured primary handle must refuse a NEW operation after the revoke");
    assert.equal(world.map.get("vault"), undefined, "and the map refuses to hand it out again");
    assert.equal(world.registry.get("vault"), undefined);
    assert.equal(world.map.unguarded("vault")?.localFs?.readLimitedText !== undefined, true, "the raw instance is retained only as an internal diagnostic");
  } finally {
    await world.cleanup();
  }
});

test("ITEM 4: the currency predicate checks identity/generation, not just id + a boolean", async () => {
  const world = await makeWorld({ vaults: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    const handleA = world.map.get("alpha");
    assert.equal(world.map.get("alpha"), handleA, "unchanged generation ⇒ stable handle identity");
    assert.equal(leaseOfHandle(handleA).identityDigest, world.registry.admission("alpha").identityDigest, "the lease carries the bound identity");

    await world.service.revoke("alpha", { actor: ACTOR });
    await assert.rejects(async () => handleA.localFs.readLimitedText("a.md"), (error) => error.code === VAULT_RUNTIME_LEASE_REVOKED);
    await world.service.approve("alpha", { actor: ACTOR });
    assert.ok(await waitFor(() => world.registry.get("alpha") !== undefined), "the re-approval converges");
    const handleB = world.map.get("alpha");
    assert.notEqual(handleB, handleA);
    assert.notEqual(leaseOfHandle(handleB).generation, leaseOfHandle(handleA).generation);
    assert.equal(await handleB.localFs.readLimitedText("a.md"), "alpha-body");
  } finally {
    world.service.stop();
    await world.cleanup();
  }
});
