// W2FIX4 (#437 W2FIX4 item A) — the synchronous consumer must never pair a NEW runtime with an OLD
// descriptor (or the reverse), not even mid-publish and not after a late publish/observer fault.
//
// Independent negative controls for the seat's extended checks
// (`scratch/multi-vault/I437-W2/seat-w2fix3-extended-contract-checks.log`, probes `3-sync-middle`,
// `3-after-observer-throw`, `3-serving-publish-throw`):
//   * the observation point INSIDE `runtimeMap.commit(plan)` — after the map swap and before any
//     serving publish — must already show the same facts on both faces;
//   * a fault raised by the serving publish (`setServedIds`) or by the commit observer's `after`
//     seam must not leave one face on the new revision and the other on the old one;
//   * the reverse control: a fault raised by `runtimeMap.commit` itself must leave BOTH faces on the
//     previous commit (the registry assignment is undone), never a new descriptor + old runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdmissionStore } from "../src/vault-runtime/admission-store.js";
import { CAPABILITY_KEYS, unavailable } from "../src/vault-runtime/descriptor.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createReconciliationService } from "../src/vault-runtime/reconciliation.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";

const ACTOR = "admin:test-session";
const quiet = { info() {}, warn() {}, log() {} };

async function makeWorld({ vaults = [], commitObserver } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix4-sync-"));
  const primaryRoot = path.join(base, "primary");
  const vaultsRoot = path.join(base, "vaults");
  await fs.mkdir(primaryRoot, { recursive: true });
  await fs.mkdir(vaultsRoot, { recursive: true });
  for (const id of vaults) await fs.mkdir(path.join(vaultsRoot, id), { recursive: true });
  const file = path.join(base, "data", "vault-admissions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });

  // One mutable facts revision, read by the registry descriptor AND by the runtime factory (as in the
  // seat's probe), so a facts change is observable on both faces.
  const facts = { revision: "A" };
  const capabilitiesFor = () => ({
    ...Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, unavailable("test")])),
    notes: { available: false, reason: facts.revision },
  });

  const servingGate = createVaultServingGate();
  servingGate.arm();
  const holder = { service: null };
  const registry = createVaultRegistry({
    primaryRoot, primaryId: "vault", vaultsRoot, capabilitiesFor,
    gate: (descriptor) => holder.service.gate(descriptor),
    servingGate,
  });
  const store = createAdmissionStore({ file, logger: quiet });
  await store.load();
  const primaryRuntime = { id: "vault", root: primaryRoot, primary: true, localFs: { async readLimitedText() { return "primary-body"; }, drain() {}, dispose() {} } };
  const map = createVaultRuntimeMap({
    registry, dataRoot: path.join(base, "data"), primaryRuntime, capabilitiesFor,
    createRuntime: ({ descriptor }) => ({
      id: descriptor.id, root: descriptor.root, primary: false, descriptor,
      capabilities: capabilitiesFor(descriptor),
      localFs: { async readLimitedText() { return `${descriptor.id}-body`; }, async writeText() { return { ok: true }; }, drain() {}, dispose() {} },
    }),
  });
  const service = createReconciliationService({ registry, runtimeMap: map, admissions: store, retryDelayMs: 10_000, logger: quiet, commitObserver });
  holder.service = service;
  const world = { base, registry, store, service, map, servingGate, facts, cleanupServices: [], id: (name) => path.join(vaultsRoot, name) };
  world.cleanup = async function cleanup() {
    service.stop();
    for (const extra of world.cleanupServices) extra.stop();
    await fs.rm(base, { recursive: true, force: true });
  };
  await service.initializeVaults({ confirm: vaults, actor: ACTOR, source: "test-admin-list" });
  return world;
}

const factsOf = (value) => value?.capabilities?.notes?.reason ?? null;
const bothFacts = (world, id) => ({ registry: factsOf(world.registry.get(id)), runtime: factsOf(world.map.get(id)) });

test("W2FIX4-A: the synchronous consumer sees one generation inside runtimeMap.commit (no old+new pairing)", async () => {
  const world = await makeWorld({ vaults: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    assert.deepEqual(bothFacts(world, "alpha"), { registry: "A", runtime: "A" });

    world.facts.revision = "B";
    let during = null;
    const observing = createReconciliationService({
      registry: world.registry,
      runtimeMap: { ...world.map, commit: (plan) => { const applied = world.map.commit(plan); during = bothFacts(world, "alpha"); return applied; } },
      admissions: world.store,
      retryDelayMs: 10_000,
      logger: quiet,
    });
    world.cleanupServices.push(observing);
    const result = await observing.reconcile("manual");
    assert.equal(result.status, "committed");
    assert.deepEqual(during, { registry: "B", runtime: "B" }, "mid-composed-commit the two faces already agree on ONE generation");
    assert.deepEqual(bothFacts(world, "alpha"), { registry: "B", runtime: "B" });
  } finally {
    await world.cleanup();
  }
});

test("W2FIX4-A: a late commit-observer fault leaves both faces on the NEW revision (never mixed)", async () => {
  const world = await makeWorld({
    vaults: ["alpha"],
    commitObserver: (_record, phase) => { if (phase === "after") throw Object.assign(new Error("seat after observer fault"), { code: "SEAT_AFTER_OBSERVER" }); },
  });
  try {
    await world.service.reconcile("startup");
    world.facts.revision = "B";
    const result = await world.service.reconcile("manual");
    assert.equal(result.status, "committed-degraded");
    assert.equal(result.stage, "runtime-commit");
    assert.deepEqual(bothFacts(world, "alpha"), { registry: "B", runtime: "B" }, "an observer fault after the map adopted the revision must not revert one face only");
  } finally {
    await world.cleanup();
  }
});

test("W2FIX4-A: a serving-publish fault leaves both faces on the NEW revision (never mixed)", async () => {
  const world = await makeWorld({ vaults: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    world.facts.revision = "B";
    const failing = createReconciliationService({
      registry: { ...world.registry, setServedIds() { throw Object.assign(new Error("seat serving publish fault"), { code: "SEAT_SERVING_PUBLISH" }); } },
      runtimeMap: world.map,
      admissions: world.store,
      retryDelayMs: 10_000,
      logger: quiet,
    });
    world.cleanupServices.push(failing);
    const result = await failing.reconcile("manual");
    assert.equal(result.status, "committed-degraded");
    assert.equal(result.stage, "runtime-commit");
    assert.deepEqual(bothFacts(world, "alpha"), { registry: "B", runtime: "B" }, "a serving-publish fault after the map adopted the revision must not revert one face only");
  } finally {
    await world.cleanup();
  }
});

test("W2FIX4-A control: a map-commit fault leaves BOTH faces on the PREVIOUS commit", async () => {
  const world = await makeWorld({ vaults: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    const publishedRevision = world.registry.snapshot().revision;
    world.facts.revision = "B";
    const failing = createReconciliationService({
      registry: world.registry,
      runtimeMap: { ...world.map, commit: () => { throw Object.assign(new Error("seat map commit fault"), { code: "SEAT_MAP_COMMIT" }); } },
      admissions: world.store,
      retryDelayMs: 10_000,
      logger: quiet,
    });
    world.cleanupServices.push(failing);
    const result = await failing.reconcile("manual");
    assert.equal(result.status, "committed-degraded");
    assert.equal(result.stage, "runtime-commit");
    assert.deepEqual(bothFacts(world, "alpha"), { registry: "A", runtime: "A" }, "the unadopted candidate must not leave a new descriptor beside the old runtime");
    assert.equal(world.registry.snapshot().revision, publishedRevision, "the in-memory registry was rolled back to the previous commit");
  } finally {
    await world.cleanup();
  }
});
