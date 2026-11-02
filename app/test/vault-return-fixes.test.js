// W2 fix (#437 RETURN, 2026-10-09) — negative controls for the response-seat's 7 must-fix items.
//
// Each test reproduces the seat's counterexample FIRST, then asserts the repaired behaviour. The
// item number is in the test name:
//   ITEM 1  primary cannot bypass admission (structural description ≠ service right)
//   ITEM 3  a stale scan round cannot revert an administrator revoke (revision CAS)
//   ITEM 4  `initialize(force:true)` is gone; no rebinding / generation lowering
//   ITEM 5  a failed persist cannot restore a refused Vault (independent, sticky refusal gate)
//   ITEM 6  one authoritative persisted revision + a consistent composed snapshot
//   ITEM 7  prepare failure cleans its candidate up; retirement failure stays retryable
// (ITEM 2 — the discovery switch only controls the automatic trigger — is covered by the real
// subprocess probes in `vault-discovery-fail-closed.test.js`.)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ADMISSION_APPROVED,
  ADMISSION_IDENTITY_CONFLICT,
  ADMISSION_PENDING,
  ADMISSIONS_INVALID_OPERATION,
  createAdmissionStore,
  emptyAdmissionState,
  validateAdmissionState,
} from "../src/vault-runtime/admission-store.js";
import { CAPABILITY_KEYS, unavailable } from "../src/vault-runtime/descriptor.js";
import { computeIdentityDigest, resolveVaultIdentity } from "../src/vault-runtime/identity.js";
import { createControlledReplacement } from "./helpers/controlled-replacement.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createReconciliationService } from "../src/vault-runtime/reconciliation.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";

const ACTOR = "admin:test-session";
const quiet = { info() {}, warn() {}, log() {} };
const allCaps = (reason = "test") => Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, unavailable(reason)]));
const ids = (registry) => registry.list().map((vault) => vault.id).sort();

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** A real temp world mirroring production composition: serving gate + registry + store + runtime map. */
async function makeWorld({ vaults = [], confirm = null, retryDelayMs = 10_000, resolveIdentity, createRuntime, activate, disposed = [] } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2-return-"));
  const primaryRoot = path.join(base, "primary");
  const vaultsRoot = path.join(base, "vaults");
  await fs.mkdir(primaryRoot, { recursive: true });
  await fs.mkdir(vaultsRoot, { recursive: true });
  for (const id of vaults) await fs.mkdir(path.join(vaultsRoot, id), { recursive: true });
  const file = path.join(base, "data", "vault-admissions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });

  const servingGate = createVaultServingGate();
  servingGate.arm();
  let service = null;
  const registry = createVaultRegistry({
    primaryRoot,
    primaryId: "vault",
    vaultsRoot,
    capabilitiesFor: () => allCaps(),
    gate: (descriptor) => service.gate(descriptor),
    servingGate,
  });
  const store = createAdmissionStore({ file, logger: quiet });
  await store.load();

  const primaryRuntime = { id: "vault", root: primaryRoot, primary: true, localFs: { dispose() { disposed.push("primary"); } } };
  const map = createVaultRuntimeMap({
    registry,
    dataRoot: path.join(base, "data"),
    primaryRuntime,
    createRuntime: createRuntime ?? (({ descriptor }) => ({
      id: descriptor.id,
      root: descriptor.root,
      primary: false,
      descriptor,
      drain() { disposed.push(`drain:${descriptor.id}`); },
      dispose() { disposed.push(`dispose:${descriptor.id}`); },
    })),
  });
  service = createReconciliationService({ registry, runtimeMap: map, admissions: store, activate, resolveIdentity, retryDelayMs, logger: quiet });
  const world = {
    base, primaryRoot, vaultsRoot, file, registry, store, service, map, disposed, servingGate,
    id: (name) => path.join(vaultsRoot, name),
    async cleanup() { service.stop(); await fs.rm(base, { recursive: true, force: true }); },
  };
  if (confirm !== null) await service.initializeVaults({ confirm, actor: ACTOR, source: "test-admin-list" });
  return world;
}

test("ITEM 1: the runtime map obeys the same refusal as the registry (no primary fallback)", async () => {
  const world = await makeWorld({ vaults: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    assert.equal(world.registry.get("vault"), undefined, "the canonical resolve refuses the uninitialized primary");
    assert.equal(world.map.get("vault"), undefined, "the runtime map refuses the uninitialized primary too");
    assert.equal(world.map.has("vault"), false);
    assert.equal(world.map.refusalOf("vault").httpStatus, 503);
    assert.deepEqual(ids(world.registry), []);
    // After an explicit initialization the same instances become reachable.
    await world.service.initializeVaults({ confirm: [], actor: ACTOR, source: "admin-list" });
    await world.service.reconcile("manual");
    assert.equal(world.map.get("vault")?.id, "vault");
    assert.deepEqual(ids(world.registry), ["vault"]);
  } finally {
    await world.cleanup();
  }
});

test("ITEM 3: a stale scan round cannot revert an administrator revoke (revision CAS)", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let barrierActive = false;
  let paused = false;
  const world = await makeWorld({
    vaults: ["alpha"],
    confirm: ["alpha"],
    // item 6: the bounded self-retry default is 1 s; this test needs the ONE pending re-run within its
    // 3 s wait, so it asks for a small (still >= MIN_RETRY_DELAY_MS) delay explicitly.
    retryDelayMs: 100,
    resolveIdentity: async (options) => {
      // `initializeVaults` also resolves identities; only pause the RECONCILIATION round.
      if (barrierActive && !paused) { paused = true; await barrier; }
      return resolveVaultIdentity(options);
    },
  });
  try {
    barrierActive = true;
    const round = world.service.reconcile("manual");
    assert.ok(await waitFor(() => paused), "the scan must be paused before the decision lands");
    // The protected administrator decision lands while the round is paused.
    await world.store.revoke("alpha", { actor: ACTOR });
    assert.equal(world.store.entryFor("alpha").admission, ADMISSION_PENDING);
    assert.equal(world.store.entryFor("alpha").generation, 2);
    release();

    const stale = await round;
    assert.equal(stale.status, "not-published", "the stale round must discard its candidate, not publish");
    assert.equal(stale.stage, "persist");
    assert.equal(world.service.status().lastError.code, "VAULT_ADMISSIONS_REVISION_CONFLICT");
    // The revoke was NOT reverted: no `approved`/generation-1 regression.
    assert.equal(world.store.entryFor("alpha").admission, ADMISSION_PENDING);
    assert.equal(world.store.entryFor("alpha").generation, 2);
    assert.equal(world.registry.get("alpha"), undefined);
    // The scheduled re-run converges to the administrator's decision.
    assert.ok(await waitFor(() => world.service.status().runs >= 2 && !world.service.status().inFlight));
    assert.equal(world.store.entryFor("alpha").admission, ADMISSION_PENDING);
    assert.equal(world.service.status().runs, 2, "exactly one re-run for the discarded candidate");
  } finally {
    await world.cleanup();
  }
});

test("ITEM 4: initialize() refuses a replaced id and rewrites nothing (no force escape hatch)", async () => {
  const replacementTracker = createControlledReplacement();
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"], resolveIdentity: replacementTracker.resolve });
  try {
    const original = world.store.entryFor("alpha").identity;
    const bytesBefore = await fs.readFile(world.file, "utf8");
    await fs.rm(world.id("alpha"), { recursive: true, force: true });
    await fs.mkdir(world.id("alpha"));
    replacementTracker.markReplaced(world.id("alpha"));
    const replacementIdentity = await replacementTracker.resolve({ root: world.id("alpha") });
    assert.notEqual(replacementIdentity.digest, original.digest, "the replacement directory has a new identity");

    const approvedReplacement = { id: "alpha", root: world.id("alpha"), identity: replacementIdentity, primary: false, writable: true };
    await assert.rejects(
      world.store.initialize({ source: "force", configDigest: "cfg", approved: [approvedReplacement], actor: ACTOR, force: true }),
      (error) => error.code === ADMISSIONS_INVALID_OPERATION,
      "the removed force path is refused",
    );
    await assert.rejects(
      world.service.initializeVaults({ confirm: ["alpha"], actor: ACTOR, source: "force" }),
      (error) => error.code === ADMISSIONS_INVALID_OPERATION || error.code === ADMISSION_IDENTITY_CONFLICT,
    );
    await assert.rejects(
      world.store.approve("alpha", { actor: ACTOR, identity: replacementIdentity }),
      (error) => error.code === ADMISSION_IDENTITY_CONFLICT,
    );
    assert.equal(await fs.readFile(world.file, "utf8"), bytesBefore, "every refusal leaves the file untouched");
    assert.equal(world.store.entryFor("alpha").identity.digest, original.digest, "the binding is never overwritten");
  } finally {
    await world.cleanup();
  }
});

test("ITEM 4: initialize() never rebinds or lowers a generation on a persisted entry", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2-rebind-"));
  try {
    const file = path.join(base, "data", "vault-admissions.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const identity = (seed) => ({
      identityVersion: 1,
      digest: computeIdentityDigest({ canonicalRoot: `/fake/${seed}`, volumeId: "1", fileId: String(seed) }),
      canonicalRoot: `/fake/${seed}`,
      volumeId: "1",
      fileId: String(seed),
    });
    // A well-formed document that is NOT migrated but already carries a binding (the recovery case).
    const document = emptyAdmissionState();
    document.revision = 1;
    document.registry = { revision: 1, vaults: { alpha: { id: "alpha", root: "/fake/alpha", canonicalRoot: "/fake/1", primary: false, writable: true, identity: identity(1) } }, skipped: [] };
    document.entries.alpha = { identity: identity(1), admission: ADMISSION_PENDING, firstSeenAt: null, lastSeenAt: null, approvedAt: null, approvedBy: null, generation: 3, note: null, identityConflict: false };
    validateAdmissionState(document);
    await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");

    const store = createAdmissionStore({ file, logger: quiet });
    await store.load();
    await assert.rejects(
      store.initialize({ source: "recovery", configDigest: "cfg", approved: [{ id: "alpha", root: "/fake/alpha", identity: identity(9) }], actor: ACTOR }),
      (error) => error.code === ADMISSION_IDENTITY_CONFLICT,
    );
    // The same-identity recovery is allowed and only ever bumps the generation.
    await store.initialize({ source: "recovery", configDigest: "cfg", approved: [{ id: "alpha", root: "/fake/alpha", identity: identity(1) }], actor: ACTOR });
    assert.equal(store.entryFor("alpha").generation, 4, "recovery bumps, never lowers, the generation");
    assert.equal(store.entryFor("alpha").identity.digest, identity(1).digest);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("ITEM 5: a failed persist cannot restore a refused Vault (sticky, persistent refusal gate)", async () => {
  const replacementTracker = createControlledReplacement();
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"], resolveIdentity: replacementTracker.resolve });
  try {
    await world.service.reconcile("startup");
    assert.equal(world.map.get("alpha")?.id, "alpha");
    const original = world.store.entryFor("alpha").identity;
    const failingStore = { ...world.store, commit: async () => { throw Object.assign(new Error("rename failed"), { code: "VAULT_ADMISSIONS_WRITE_FAILED" }); } };
    // The faulted round must use the same controlled replacement identity as initialization;
    // falling back to real stat here makes delete + recreate depend on inode allocation again.
    const failing = createReconciliationService({ registry: world.registry, runtimeMap: world.map, admissions: failingStore, resolveIdentity: replacementTracker.resolve, logger: quiet });

    await fs.rm(world.id("alpha"), { recursive: true, force: true });
    await fs.mkdir(world.id("alpha"));
    replacementTracker.markReplaced(world.id("alpha"));
    const result = await failing.reconcile("manual");
    assert.equal(result.status, "not-published");
    assert.equal(result.stage, "persist");
    // The refusal gate is independent of persistence: the old descriptor AND the old runtime are gone.
    assert.equal(world.registry.get("alpha"), undefined);
    assert.equal(world.map.get("alpha"), undefined);
    assert.equal(world.map.has("alpha"), false);
    assert.equal(world.registry.refusal("alpha").httpStatus, 503);
    assert.equal(world.registry.refusal("alpha").reason, "identity-changed");
    assert.equal(world.store.entryFor("alpha").identity.digest, original.digest, "the persisted binding is unchanged");
    failing.stop();
  } finally {
    await world.cleanup();
  }
});

test("ITEM 6: one authoritative persisted revision and a consistent composed snapshot", async () => {
  let failNext = true;
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"], retryDelayMs: 10_000 });
  try {
    await world.service.reconcile("startup");
    const publishedRevision = world.registry.snapshot().revision;
    assert.equal(publishedRevision, world.store.revision(), "the file revision is the ONE authority");
    assert.equal(world.registry.commits(), 1, "the commit counter records successful combined commits");

    // Revoke: the durable record advances, then the composed runtime commit fails. W2FIX3 item 3: the
    // registry snapshot and the serving gate must NOT move on their own — a new descriptor must never
    // be paired with an old runtime, and the two resolution faces must stay consistent.
    const wrapped = {
      ...world.map,
      commit: (plan) => {
        if (failNext) { failNext = false; throw Object.assign(new Error("runtime commit failed"), { code: "E_RUNTIME" }); }
        return world.map.commit(plan);
      },
    };
    const failing = createReconciliationService({ registry: world.registry, runtimeMap: wrapped, admissions: world.store, logger: quiet });
    const result = await failing.revoke("alpha", { actor: ACTOR });
    assert.equal(result.status, "committed-degraded", "the durable revision is honestly reported as degraded");
    assert.equal(result.stage, "runtime-commit");
    assert.ok(world.store.revision() > publishedRevision, "the durable record advanced");
    assert.equal(world.registry.snapshot().revision, publishedRevision, "the in-memory snapshot did NOT move with a failed composed publish");
    assert.equal(world.registry.commits(), 1, "no partial publish was counted");
    // The revoked id is refused on BOTH faces (sticky refusal from the durable revoke), and the two
    // faces agree; the old instance is retained only for its retirement, never handed out.
    assert.equal(world.registry.get("alpha"), undefined);
    assert.equal(world.map.get("alpha"), undefined, "the stale runtime is not obtainable through the map");
    assert.equal(world.registry.refusal("alpha")?.reason, "awaiting-approval");
    assert.ok(world.map.ids().includes("alpha"), "the old instance is retained for its retirement, not handed out");
    // A later (unfaulted) round converges to the persisted revision and serves the same decision.
    const converged = await world.service.reconcile("manual");
    assert.equal(converged.status, "committed");
    assert.equal(world.registry.snapshot().revision, world.store.revision());
    assert.equal(world.registry.get("alpha"), undefined);
    failing.stop();
  } finally {
    await world.cleanup();
  }
});

test("ITEM 7① (W2FIX2 item 5): a failing runtime is ISOLATED — the healthy Vaults still commit", async () => {
  const disposed = [];
  let calls = 0;
  const world = await makeWorld({
    vaults: ["alpha", "beta"],
    confirm: ["alpha", "beta"],
    disposed,
    retryDelayMs: 10_000,
    createRuntime: ({ descriptor }) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("runtime build failed"), { code: "E_BUILD" });
      return {
        id: descriptor.id,
        root: descriptor.root,
        primary: false,
        descriptor,
        drain() { disposed.push(`drain:${descriptor.id}`); },
        dispose() { disposed.push(`dispose:${descriptor.id}`); },
      };
    },
  });
  try {
    const result = await world.service.reconcile("startup");
    // The round is a visible degradation, NOT a total failure: the healthy Vault is committed.
    assert.equal(result.status, "committed-degraded");
    assert.equal(result.stage, "prepare-runtime");
    assert.equal(world.registry.get("alpha")?.id, "alpha", "the healthy Vault is served");
    assert.equal(world.map.get("alpha")?.id, "alpha");
    // The failing Vault is isolated from the servable set but keeps its identity binding + error.
    assert.equal(world.registry.get("beta"), undefined);
    assert.equal(world.registry.refusal("beta").httpStatus, 503);
    assert.equal(world.registry.refusal("beta").reason, "runtime-prepare-failed");
    assert.equal(world.store.entryFor("beta").admission, "approved", "the identity binding and decision are retained");
    assert.equal(world.service.status().vaults.beta.status, "error");
    assert.equal(world.service.status().vaults.beta.reason, "runtime-prepare-failed");
    assert.equal(world.map.ids().includes("beta"), false, "the failing Vault has no published runtime");
    await world.map.settleRetirements();
    assert.equal(world.map.pendingRetirements(), 0, "no leaked candidate runtime");
  } finally {
    await world.cleanup();
  }
});

test("ITEM 7②: a failed retirement stays retryable and reports a degradation (never a silent committed)", async () => {
  const disposed = [];
  let drainFails = true;
  const world = await makeWorld({
    vaults: ["alpha"],
    confirm: ["alpha"],
    disposed,
    createRuntime: ({ descriptor }) => ({
      id: descriptor.id,
      root: descriptor.root,
      primary: false,
      descriptor,
      drain() { if (drainFails) throw Object.assign(new Error("drain failed"), { code: "E_DRAIN" }); },
      dispose() { disposed.push(`dispose:${descriptor.id}`); },
    }),
  });
  try {
    await world.service.reconcile("startup");
    const result = await world.service.revoke("alpha", { actor: ACTOR });
    assert.equal(result.status, "committed-degraded", "a failed retirement is a visible degradation");
    assert.equal(result.stage, "retire");
    assert.ok(world.map.pendingRetirements() >= 1, "the record, handle and error are kept for a retry");
    assert.equal(disposed.includes("dispose:alpha"), false, "a failed drain must not be followed by dispose");

    drainFails = false;
    await world.map.settleRetirements();
    assert.equal(world.map.pendingRetirements(), 0, "the retained record is retried and cleared");
    assert.ok(disposed.includes("dispose:alpha"));
  } finally {
    await world.cleanup();
  }
});
