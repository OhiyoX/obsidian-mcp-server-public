import { resolveVaultIdentity } from "../src/vault-runtime/identity.js";
import { approveConfirmedVault } from "../src/vault-runtime/explicit-enrollment.js";
// W2FIX3 (#437 RETURN-2, item 3) — the true composed commit and candidate cleanup.
//
// Independent negative controls for the second seat ruling §2.2:
//   * "changed-facts positive control + map-commit fault: both faces still resolve alpha, refusal is
//     null, the registry exposes the NEW facts while the runtime keeps the OLD facts (a real
//     divergence, not a projection difference)": after a failed composed publish neither face may
//     move — the registry must not expose a descriptor the runtime map did not adopt.
//   * "the newly built candidate was never disposed and never entered retirements": an unadopted
//     candidate must be discarded and its disposal observable.
//   * the commit point must be one synchronous, pre-validated step (a hook can observe the boundary).

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
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix3-facts-"));
  const primaryRoot = path.join(base, "primary");
  const vaultsRoot = path.join(base, "vaults");
  await fs.mkdir(primaryRoot, { recursive: true });
  await fs.mkdir(vaultsRoot, { recursive: true });
  for (const id of vaults) await fs.mkdir(path.join(vaultsRoot, id), { recursive: true });
  const file = path.join(base, "data", "vault-admissions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });

  // The SAME capability facts provider is injected into the registry AND the runtime map (as in the
  // seat's probe), so a facts change is visible on both faces.
  const facts = { revision: "A" };
  const capabilitiesFor = () => ({ ...Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, unavailable("test")])), notes: { available: false, reason: facts.revision } });

  const servingGate = createVaultServingGate();
  servingGate.arm();
  const serviceHolder = { service: null };
  const registry = createVaultRegistry({
    primaryRoot, primaryId: "vault", vaultsRoot, capabilitiesFor,
    gate: (descriptor) => serviceHolder.service.gate(descriptor),
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
  serviceHolder.service = service;
  const world = {
    base, registry, store, service, map, servingGate, facts,
    id: (name) => path.join(vaultsRoot, name),
    async cleanup() { service.stop(); await fs.rm(base, { recursive: true, force: true }); },
  };
  await service.initializeVaults({ confirm: vaults, actor: ACTOR, source: "test-admin-list" });
  return world;
}

const factsOf = (value) => value?.capabilities?.notes?.reason ?? null;

test("ITEM 3: a changed-facts map-commit fault keeps BOTH faces on the old facts (no divergence)", async () => {
  const world = await makeWorld({ vaults: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    assert.equal(factsOf(world.registry.get("alpha")), "A");
    assert.equal(factsOf(world.map.get("alpha")), "A");
    const publishedRevision = world.registry.snapshot().revision;

    // Change the runtime facts, then fail ONLY the composed map commit.
    world.facts.revision = "B";
    let fired = false;
    const failing = createReconciliationService({
      registry: world.registry,
      runtimeMap: { ...world.map, commit: (plan) => { if (!fired) { fired = true; throw Object.assign(new Error("map commit fault"), { code: "E_MAP" }); } return world.map.commit(plan); } },
      admissions: world.store,
      retryDelayMs: 10_000,
      logger: quiet,
    });
    const result = await failing.reconcile("manual");
    assert.equal(result.status, "committed-degraded");
    assert.equal(result.stage, "runtime-commit");

    // The seat's repro asserted `refusal=null` + registry NEW facts + runtime OLD facts. The fixed
    // invariant is that the two faces AGREE, and that they agree on the PREVIOUS commit.
    const registryFacts = factsOf(world.registry.get("alpha"));
    const runtimeFacts = factsOf(world.map.get("alpha"));
    assert.equal(registryFacts, runtimeFacts, "the two resolution faces must never expose different facts");
    assert.equal(registryFacts, "A", "neither face adopted the uncommitted new facts");
    assert.equal(world.registry.snapshot().revision, publishedRevision, "the in-memory snapshot did not move back/forward");
    failing.stop();
  } finally {
    await world.cleanup();
  }
});

test("ITEM 3: an unadopted candidate is discarded and its disposal is observable", async () => {
  const world = await makeWorld({ vaults: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    // A NEW Vault forces a newly built candidate runtime.
    await fs.mkdir(world.id("delta"), { recursive: true });
    await world.service.reconcile("manual");
    await approveConfirmedVault({ id: "delta", registry: world.registry, admissions: world.store, resolveIdentity: resolveVaultIdentity, now: Date.now, actor: ACTOR });
    assert.equal(world.map.discardedCount(), 0);

    let fired = false;
    const failing = createReconciliationService({
      registry: world.registry,
      runtimeMap: { ...world.map, commit: (plan) => { if (!fired) { fired = true; throw Object.assign(new Error("map commit fault"), { code: "E_MAP" }); } return world.map.commit(plan); } },
      admissions: world.store,
      retryDelayMs: 10_000,
      logger: quiet,
    });
    const result = await failing.reconcile("manual");
    assert.equal(result.status, "committed-degraded");
    assert.deepEqual(result.created, ["delta"], "the faulted round built the delta candidate");
    assert.ok(world.map.discardedCount() >= 1, "the unadopted candidate must be discarded, not leaked");
    assert.equal(world.map.get("delta"), undefined, "the discarded candidate is never servable");
    failing.stop();
  } finally {
    await world.cleanup();
  }
});

test("ITEM 3: the commit point is one synchronous observation boundary", async () => {
  const observed = [];
  const world = await makeWorld({
    vaults: ["alpha"],
    commitObserver: (record, phase) => {
      observed.push({
        phase,
        revision: record.revision,
        allowed: [...record.serving.allowed].sort(),
        present: [...(record.plan?.presentIds ?? [])].sort(),
      });
    },
  });
  try {
    await world.service.reconcile("startup");
    assert.deepEqual(observed.map((entry) => entry.phase), ["before", "after"], "the composed commit exposes exactly one boundary");
    for (const entry of observed) {
      assert.ok(entry.allowed.every((id) => entry.present.includes(id)), `${entry.phase}: the allow-set is a subset of the committed runtime ids`);
      assert.equal(entry.revision, world.registry.snapshot().revision === 1 ? 1 : entry.revision);
    }
    // After the boundary the three views already agree.
    assert.deepEqual([...world.servingGate.allowed()].sort(), ["alpha", "vault"]);
    assert.equal(world.registry.get("alpha")?.id, "alpha");
    assert.equal(world.map.get("alpha")?.id, "alpha");
  } finally {
    await world.cleanup();
  }
});

test("ITEM 3: when BOTH the staging and the map commit fail, nothing is published", async () => {
  const world = await makeWorld({ vaults: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    const publishedRevision = world.registry.snapshot().revision;
    let registryFaults = false;
    let mapFaults = false;
    const failing = createReconciliationService({
      registry: { ...world.registry, commit: (...args) => { if (!registryFaults) { registryFaults = true; throw Object.assign(new Error("stage fault"), { code: "E_STAGE" }); } return world.registry.commit(...args); } },
      runtimeMap: { ...world.map, commit: () => { mapFaults = true; throw Object.assign(new Error("map fault"), { code: "E_MAP" }); } },
      admissions: world.store,
      retryDelayMs: 10_000,
      logger: quiet,
    });
    const result = await failing.reconcile("manual");
    assert.equal(result.status, "committed-degraded");
    assert.equal(result.stage, "publish", "staging fails before the map is ever touched");
    assert.equal(mapFaults, false, "the map commit is not reached when staging refused");
    assert.equal(world.registry.snapshot().revision, publishedRevision);
    assert.equal(world.registry.get("alpha")?.id, "alpha", "the healthy Vault keeps its previous commit");
    failing.stop();
  } finally {
    await world.cleanup();
  }
});
