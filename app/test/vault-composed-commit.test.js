import { approveConfirmedVault } from "../src/vault-runtime/explicit-enrollment.js";
// W2FIX2 (#437 RETURN items 3/4/5) — the composed commit, the operation gate and failure isolation.
//
// Independent negative controls for the response-seat's remaining counterexamples:
//   * item 3 — "publish clears the sticky refusals and treats an id absent from `decisions` as
//     servable; delete + runtime-commit failure leaves `refusal=null` while the old map runtime is
//     still obtainable": the committed allow-set must be explicit (unknown/deleted/unprepared
//     default-deny) and registry + runtime map + gate must swap as ONE snapshot.
//   * item 4 — "a durable revoke only triggers a possibly-coalesced scan; a captured old runtime
//     still answers a NEW read": revoke must tighten the gate before returning, and captured handles
//     must carry an identity/generation lease.
//   * item 5 — "one Vault's constructor failure aborts the whole round, permanently blocking healthy
//     additions": the failing Vault must be isolated while the healthy ones commit, round after round.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdmissionStore } from "../src/vault-runtime/admission-store.js";
import { CAPABILITY_KEYS, unavailable } from "../src/vault-runtime/descriptor.js";
import { resolveVaultIdentity } from "../src/vault-runtime/identity.js";
import { createControlledReplacement } from "./helpers/controlled-replacement.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createReconciliationService } from "../src/vault-runtime/reconciliation.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";
import { VAULT_RUNTIME_LEASE_REVOKED } from "../src/vault-runtime/runtime-lease.js";

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

/** A real temp world: serving gate + registry + store + runtime map (+ optional fault injection). */
async function makeWorld({ vaults = [], confirm = null, createRuntime, activate, resolveIdentity, retryDelayMs = 10_000, faults = {} } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2-composed-"));
  const primaryRoot = path.join(base, "primary");
  const vaultsRoot = path.join(base, "vaults");
  await fs.mkdir(primaryRoot, { recursive: true });
  await fs.mkdir(vaultsRoot, { recursive: true });
  for (const id of vaults) await fs.mkdir(path.join(vaultsRoot, id), { recursive: true });
  const file = path.join(base, "data", "vault-admissions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });

  const servingGate = createVaultServingGate();
  servingGate.arm();
  const serviceHolder = { service: null };
  const registry = createVaultRegistry({
    primaryRoot,
    primaryId: "vault",
    vaultsRoot,
    capabilitiesFor: allCaps,
    gate: (descriptor) => serviceHolder.service.gate(descriptor),
    servingGate,
  });
  const store = createAdmissionStore({ file, logger: quiet });
  await store.load();
  const primaryRuntime = { id: "vault", root: primaryRoot, primary: true, localFs: { dispose() {} } };
  const map = createVaultRuntimeMap({
    registry,
    dataRoot: path.join(base, "data"),
    primaryRuntime,
    createRuntime: createRuntime ?? (({ descriptor }) => ({
      id: descriptor.id,
      root: descriptor.root,
      primary: false,
      descriptor,
      localFs: {
        async readLimitedText() { return `${descriptor.id}-body`; },
        async writeText() { return { ok: true, id: descriptor.id }; },
        drain() {},
        dispose() {},
      },
    })),
  });
  const service = createReconciliationService({ registry, runtimeMap: map, admissions: store, activate, resolveIdentity, retryDelayMs, logger: quiet });
  serviceHolder.service = service;

  // Fault injection: wrap exactly ONE call of the requested stage, leaving the real object intact.
  const fault = (target, method, code) => {
    const original = target[method].bind(target);
    let fired = false;
    return { ...target, [method]: (...args) => { if (!fired) { fired = true; throw Object.assign(new Error(`${method} fault`), { code }); } return original(...args); } };
  };
  const faultedRegistry = faults.registry === true ? fault(registry, "commit", "E_PUBLISH") : registry;
  const faultedStore = faults.commit === true ? fault(store, "commit", "E_PERSIST") : store;
  const faultedMap = faults.map === true ? fault(map, "commit", "E_RUNTIME_COMMIT") : map;
  const faultedService = (faults.registry || faults.commit || faults.map)
    ? createReconciliationService({ registry: faultedRegistry, runtimeMap: faultedMap, admissions: faultedStore, activate, resolveIdentity, retryDelayMs, logger: quiet })
    : service;

  const world = {
    base, vaultsRoot, file, registry, store, service, map, servingGate, faultedService,
    id: (name) => path.join(vaultsRoot, name),
    async cleanup() { service.stop(); faultedService.stop(); await fs.rm(base, { recursive: true, force: true }); },
  };
  if (confirm !== null) await service.initializeVaults({ confirm, actor: ACTOR, source: "test-admin-list" });
  return world;
}

test("ITEM 3: the committed serving set is an explicit allow-list — an unknown id is refused by default", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    assert.equal(world.registry.get("alpha")?.id, "alpha");
    assert.equal(world.servingGate.isServable("ghost"), false, "an unknown id is never servable");
    assert.equal(world.registry.get("ghost"), undefined);
    assert.equal(world.registry.refusal("ghost").httpStatus, 503);
    assert.equal(world.registry.refusal("ghost").reason, "not-servable");
    // The allow-set is published from the committed snapshot, not inferred from "anything not refused".
    assert.deepEqual([...world.servingGate.allowed()].sort(), ["alpha", "vault"]);
  } finally {
    await world.cleanup();
  }
});

test("ITEM 3: publish can never clear a refusal into a grant (explicit allow-set after re-baseline)", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    // Drop the allow-set explicitly (simulating a committed snapshot that serves nothing) and re-publish.
    world.registry.setServedIds([], {});
    assert.equal(world.servingGate.isServable("alpha"), false, "clearing the allow-set refuses, never opens");
    assert.equal(world.registry.get("alpha"), undefined);
    assert.equal(world.registry.structural("alpha")?.id, "alpha", "the structural description may stay");
    assert.equal(world.registry.refusal("alpha").httpStatus, 503);
  } finally {
    await world.cleanup();
  }
});

const CLASSES = {
  new: {
    label: "new Vault",
    affected: "delta",
    async prepare(world) {
      await fs.mkdir(world.id("delta"), { recursive: true });
      await world.service.reconcile("manual"); // discover it as pending
      await approveConfirmedVault({ id: "delta", registry: world.registry, admissions: world.store, resolveIdentity: resolveVaultIdentity, now: Date.now, actor: ACTOR });
    },
  },
  delete: { label: "deleted directory", affected: "alpha", async prepare(world) { await fs.rm(world.id("alpha"), { recursive: true, force: true }); } },
  revoke: { label: "revoked approval", affected: "alpha", async prepare(world) { await world.store.revoke("alpha", { actor: ACTOR }); } },
  replace: {
    label: "replaced identity",
    affected: "alpha",
    async prepare(world) {
      await fs.rm(world.id("alpha"), { recursive: true, force: true });
      await fs.mkdir(world.id("alpha"));
      if (world.replacementTracker) world.replacementTracker.markReplaced(world.id("alpha"));
    },
  },
};

const FAULTS = {
  persist: { faults: { commit: true }, stage: "persist", status: "not-published" },
  publish: { faults: { registry: true }, stage: "publish", status: "committed-degraded" },
  "runtime-commit": { faults: { map: true }, stage: "runtime-commit", status: "committed-degraded" },
};

for (const [clsName, cls] of Object.entries(CLASSES)) {
  for (const [faultName, fault] of Object.entries(FAULTS)) {
    test(`ITEM 3: ${cls.label} × ${faultName} fault — the three views stay consistent and the refusal holds`, async () => {
      const replacementTracker = createControlledReplacement();
      const world = await makeWorld({ vaults: ["alpha", "gamma"], confirm: ["alpha", "gamma"], faults: fault.faults, resolveIdentity: replacementTracker.resolve });
      world.replacementTracker = replacementTracker;
      try {
        await world.service.reconcile("startup");
        assert.equal(world.registry.get("gamma")?.id, "gamma", "the healthy control Vault is served before the fault");
        if (clsName === "new") assert.equal(world.registry.get("delta"), undefined, "delta is not admitted yet");

        await cls.prepare(world);
        const result = await world.faultedService.reconcile("manual");
        assert.equal(result.status, fault.status, `${clsName} × ${faultName}: honest status`);
        assert.equal(result.stage, fault.stage, `${clsName} × ${faultName}: honest stage`);

        // The affected id is refused on BOTH resolution faces and the refusal is non-null.
        assert.equal(world.registry.get(cls.affected), undefined, `${cls.affected} must not resolve`);
        assert.equal(world.map.get(cls.affected), undefined, `${cls.affected} must not be obtainable from the runtime map`);
        assert.equal(world.map.has(cls.affected), false);
        assert.notEqual(world.registry.refusal(cls.affected), null, `${cls.affected} must carry a structured refusal`);
        // The frozen degrade contract distinguishes 403 (initialized but not approved) from 503
        // (unavailable / deleted / replaced / unprepared); both are refusals, neither is a grant.
        assert.ok([403, 503].includes(world.registry.refusal(cls.affected).httpStatus), `unexpected refusal status ${world.registry.refusal(cls.affected).httpStatus}`);
        // The unaffected healthy Vault keeps serving (failure isolation / no collateral removal).
        assert.equal(world.registry.get("gamma")?.id, "gamma");
        assert.equal(world.map.get("gamma")?.id, "gamma");
      } finally {
        await world.cleanup();
      }
    });
  }
}

test("ITEM 3: a publish failure AFTER persist reports 'committed but degraded' and keeps refusing", async () => {
  const world = await makeWorld({ vaults: ["alpha", "gamma"], confirm: ["alpha", "gamma"], faults: { registry: true } });
  try {
    await world.service.reconcile("startup");
    const committedRevision = world.registry.snapshot().revision;
    const persistedBefore = world.store.revision();
    // Revoke alpha; the persist succeeds, then the registry/gate publish faults.
    await world.store.revoke("alpha", { actor: ACTOR });
    const result = await world.faultedService.reconcile("manual");
    assert.equal(result.status, "committed-degraded", "the record IS committed: the report must not claim 'nothing'");
    assert.equal(result.stage, "publish");
    // The durable record advanced while the in-memory snapshot/gate did not: honestly degraded.
    assert.ok(world.store.revision() > persistedBefore, "the durable record advanced");
    assert.equal(world.registry.snapshot().revision, committedRevision, "the in-memory snapshot did not");
    // The refusal holds: the revoked id stays refused and the healthy one keeps serving.
    assert.equal(world.registry.get("alpha"), undefined);
    assert.equal(world.map.get("alpha"), undefined);
    assert.notEqual(world.registry.refusal("alpha"), null);
    assert.equal(world.registry.get("gamma")?.id, "gamma");
    // A later (unfaulted) round converges to the persisted revision and serves the same decision.
    const converged = await world.service.reconcile("manual");
    assert.equal(converged.status, "committed");
    assert.equal(world.registry.snapshot().revision, world.store.revision());
    assert.equal(world.registry.get("alpha"), undefined);
    assert.equal(world.registry.get("gamma")?.id, "gamma");
  } finally {
    await world.cleanup();
  }
});

test("ITEM 3: the composed commit is one snapshot — registry, runtime map and gate never disagree", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    assert.equal(world.registry.snapshot().revision, world.store.revision(), "the persisted revision is the one authority");
    for (const id of ["alpha", "vault"]) {
      assert.equal(world.registry.get(id)?.id, id);
      assert.equal(world.map.get(id)?.id, id, `the runtime map holds what the gate allows (${id})`);
    }
    assert.equal(world.registry.refusal("ghost").httpStatus, 503);
  } finally {
    await world.cleanup();
  }
});

test("ITEM 4: a durable revoke tightens the gate BEFORE it returns (no coalesced-scan window)", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let barrierActive = false;
  let paused = false;
  const world = await makeWorld({
    vaults: ["alpha", "gamma"],
    confirm: ["alpha", "gamma"],
    resolveIdentity: async (options) => {
      if (barrierActive && !paused) { paused = true; await barrier; }
      return resolveVaultIdentity(options);
    },
  });
  try {
    await world.service.reconcile("startup");
    assert.equal(world.service.status().runs, 1);
    // Pause a scan round on the identity resolution barrier, then revoke while it is in flight.
    barrierActive = true;
    const pausedRound = world.service.reconcile("manual");
    assert.ok(await waitFor(() => paused), "the scan must be paused");
    const revokeResult = await world.service.revoke("alpha", { actor: ACTOR });
    assert.equal(revokeResult.status, "coalesced", "the revoke did not wait for the paused scan");
    // BEFORE the scan is released: the caller already observes the refusal on every face.
    assert.equal(world.registry.get("alpha"), undefined);
    assert.equal(world.map.get("alpha"), undefined);
    assert.equal(world.registry.refusal("alpha").reason, "awaiting-approval");
    release();
    const staleRound = await pausedRound;
    // The revoke bumped the authoritative revision while the round was paused: the round's CAS must
    // discard its candidate (it can never revert the administrator's decision).
    assert.equal(staleRound.status, "not-published", "the stale round discarded its candidate");
    assert.equal(staleRound.stage, "persist");
    assert.ok(await waitFor(() => !world.service.status().inFlight), "the paused round completes");
    assert.equal(world.registry.get("alpha"), undefined, "the revoke survived the scan");
    assert.equal(world.store.entryFor("alpha").admission, "pending");
  } finally {
    world.service.stop();
    await world.cleanup();
  }
});

test("ITEM 4: a captured runtime handle refuses NEW operations after a revoke (lease)", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    const handle = world.map.get("alpha");
    const lease = world.map.leaseOf("alpha");
    assert.equal(handle.id, "alpha");
    // Positive control: before the revoke the captured handle answers.
    assert.equal(await handle.localFs.readLimitedText("a.md"), "alpha-body");

    await world.service.revoke("alpha", { actor: ACTOR });
    // The captured handle must fail a NEW operation even though the caller never re-resolves it.
    await assert.rejects(async () => handle.localFs.readLimitedText("a.md"), (error) => error.code === VAULT_RUNTIME_LEASE_REVOKED);
    await assert.rejects(async () => handle.localFs.writeText("a.md", "x"), (error) => error.code === VAULT_RUNTIME_LEASE_REVOKED);
    assert.equal(world.map.get("alpha"), undefined, "and the map refuses to hand it out again");
    assert.equal(lease.revoked, true, "the per-instance lease is revoked");
  } finally {
    await world.cleanup();
  }
});

test("ITEM 4: replacing the directory also invalidates an already-captured handle", async () => {
  const replacementTracker = createControlledReplacement();
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"], resolveIdentity: replacementTracker.resolve });
  try {
    await world.service.reconcile("startup");
    const handle = world.map.get("alpha");
    assert.equal(await handle.localFs.readLimitedText("a.md"), "alpha-body");
    await fs.rm(world.id("alpha"), { recursive: true, force: true });
    await fs.mkdir(world.id("alpha"));
    replacementTracker.markReplaced(world.id("alpha"));
    await world.service.reconcile("manual");
    await assert.rejects(async () => handle.localFs.readLimitedText("a.md"), (error) => error.code === VAULT_RUNTIME_LEASE_REVOKED);
    assert.equal(world.registry.refusal("alpha").reason, "identity-changed");
  } finally {
    await world.cleanup();
  }
});

test("ITEM 5: two consecutive rounds keep committing healthy items while one Vault keeps failing", async () => {
  let betaBuilds = 0;
  const world = await makeWorld({
    vaults: ["alpha", "beta", "gamma"],
    confirm: ["alpha", "beta", "gamma"],
    createRuntime: ({ descriptor }) => {
      if (descriptor.id === "beta") { betaBuilds += 1; throw Object.assign(new Error("constructor failed"), { code: "E_BUILD" }); }
      return {
        id: descriptor.id,
        root: descriptor.root,
        primary: false,
        descriptor,
        localFs: { async readLimitedText() { return `${descriptor.id}-body`; }, dispose() {} },
      };
    },
  });
  try {
    const round1 = await world.service.reconcile("startup");
    assert.equal(round1.status, "committed-degraded");
    assert.equal(round1.stage, "prepare-runtime");
    for (const id of ["alpha", "gamma"]) {
      assert.equal(world.registry.get(id)?.id, id, `${id} is served despite beta failing`);
      assert.equal(world.map.get(id)?.id, id);
    }
    assert.equal(world.registry.get("beta"), undefined);
    assert.equal(world.store.entryFor("beta").admission, "approved", "beta keeps its identity + decision");
    const commitsAfter1 = world.registry.commits();

    // Round 2 with a NEW healthy addition: delta must still be admitted while beta keeps failing.
    await fs.mkdir(world.id("delta"), { recursive: true });
    await world.service.reconcile("manual"); // discover delta as pending
    await approveConfirmedVault({ id: "delta", registry: world.registry, admissions: world.store, resolveIdentity: resolveVaultIdentity, now: Date.now, actor: ACTOR });
    const round2 = await world.faultedService.reconcile("manual");
    assert.equal(round2.status, "committed-degraded");
    assert.equal(round2.stage, "prepare-runtime");
    for (const id of ["alpha", "gamma", "delta"]) {
      assert.equal(world.registry.get(id)?.id, id, `${id} is served in round 2`);
      assert.equal(world.map.get(id)?.id, id);
    }
    assert.equal(world.registry.get("beta"), undefined, "the persistent failure still does not block others");
    assert.ok(world.registry.commits() > commitsAfter1, "the healthy additions were committed");
    assert.ok(betaBuilds >= 2, "beta was retried in the second round");
  } finally {
    await world.cleanup();
  }
});
