import { initializeIncarnation } from "../src/vault-runtime/incarnation.js";
// W2 (#437) — unified reconciliation service, contract §1 / §4 / §5 / §6.
//
// Acceptance evidence this file must produce:
//   * 单飞 + 最多一个待重跑标记 + 禁止队列积压 (single flight / one pending rerun / no queue);
//   * 有界枚举 + 5s 逻辑期限: a breach aborts the round and publishes NOTHING;
//   * prepare publishes nothing; commit is the only publisher and refuses a late candidate;
//   * 失败隔离: a persist failure leaves the PREVIOUS visible set in place (no rollback of a tightened
//     refusal gate) and a post-commit activation failure degrades + retries instead of rolling back;
//   * 生命周期: delete ⇒ unavailable (admission untouched) / rename ⇒ old unavailable + new pending /
//     restore only when the identity matches / a replaced directory is refused and the id is not reusable;
//   * 可观测性: per-Vault admission+status+timing projection;
//   * the persistent gate blocks an ungated publish from a refresh path this wave does not own.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdmissionStore, ADMISSION_IDENTITY_CONFLICT, ADMISSION_APPROVED, ADMISSION_PENDING } from "../src/vault-runtime/admission-store.js";
import { CAPABILITY_KEYS, unavailable } from "../src/vault-runtime/descriptor.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createReconciliationService, computeReconciliationDiff } from "../src/vault-runtime/reconciliation.js";
import { createVaultRegistry, SKIP_REASONS, VAULT_REGISTRY_BOUND_EXCEEDED, VAULT_REGISTRY_ROUND_TIMEOUT } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";
import { resolveVaultIdentity } from "../src/vault-runtime/identity.js";
import { createControlledReplacement } from "./helpers/controlled-replacement.js";

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

/**
 * A real temp world: primary + `vaultsRoot` with optional secondary directories, the real A2
 * registry (with the production-style persistent gate), the real admission store and the real
 * reconciliation service. `runtimeMap: true` also wires the real D0 runtime map.
 */
async function makeWorld({ vaults = [], confirm = null, limits, activate = null, runtimeMap = false, load = true, capabilitiesFor, resolveIdentity, now, retryDelayMs, storeOptions = {} } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2-recon-"));
  const primaryRoot = path.join(base, "primary");
  const vaultsRoot = path.join(base, "vaults");
  await fs.mkdir(primaryRoot, { recursive: true });
  await fs.mkdir(vaultsRoot, { recursive: true });
  for (const id of vaults) await fs.mkdir(path.join(vaultsRoot, id), { recursive: true });

  const caps = capabilitiesFor ?? (() => allCaps());
  let service = null;
  // W2 fix (#437 RETURN, item 1): mirror the production composition — the registry gets the ONE
  // serving gate, armed because these worlds have admission management configured.
  const servingGate = createVaultServingGate();
  servingGate.arm();
  const registry = createVaultRegistry({
    primaryRoot,
    primaryId: "vault",
    vaultsRoot,
    capabilitiesFor: caps,
    gate: (descriptor) => service.gate(descriptor),
    servingGate,
  });
  const file = path.join(base, "data", "vault-admissions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const store = createAdmissionStore({ file, logger: quiet, ...storeOptions });
  if (load) await store.load();

  let map = null;
  const disposed = [];
  if (runtimeMap) {
    const primaryRuntime = { id: "vault", root: primaryRoot, primary: true, localFs: { dispose() { disposed.push("primary"); } } };
    map = createVaultRuntimeMap({
      registry,
      dataRoot: path.join(base, "data"),
      primaryRuntime,
      createRuntime: ({ descriptor }) => ({
        id: descriptor.id,
        root: descriptor.root,
        primary: false,
        descriptor,
        drain() { disposed.push(`drain:${descriptor.id}`); },
        dispose() { disposed.push(`dispose:${descriptor.id}`); },
      }),
    });
  }

  service = createReconciliationService({ registry, runtimeMap: map, admissions: store, activate, limits, resolveIdentity, now, retryDelayMs, logger: quiet });
  const world = {
    base, primaryRoot, vaultsRoot, file, registry, store, service, map, disposed, servingGate,
    id: (name) => path.join(vaultsRoot, name),
    async cleanup() { await fs.rm(base, { recursive: true, force: true }); },
  };
  if (confirm !== null) {
    await service.initializeVaults({ confirm, actor: ACTOR, source: "test-admin-list" });
  }
  return world;
}

test("uninitialized: a missing admission record admits nothing, not even the structural primary (item 1)", async () => {
  const world = await makeWorld({ vaults: ["alpha", "beta"] });
  try {
    const result = await world.service.reconcile("startup");
    assert.equal(result.status, "committed");
    // The primary stays in the STRUCTURAL description but has no service right (item 1).
    assert.deepEqual(world.registry.structuralList().map((vault) => vault.id), ["vault"]);
    assert.deepEqual(ids(world.registry), [], "nothing is servable before initialization");
    assert.equal(world.registry.get("vault"), undefined, "the primary must not bypass admission");
    assert.equal(world.registry.refusal("vault").httpStatus, 503);
    assert.equal(world.registry.refusal("vault").code, "VAULT_ADMISSION_NOT_INITIALIZED");
    const snapshot = world.registry.snapshot();
    assert.equal(snapshot.admissions.vault.status, "pending");
    assert.equal(snapshot.admissions.vault.reason, "admissions-not-initialized");
    assert.equal(snapshot.admissions.alpha.status, "pending");
    assert.equal(snapshot.skipped.find((entry) => entry.name === "alpha").reason, SKIP_REASONS.NOT_ADMITTED);
    const status = world.service.status();
    assert.equal(status.vaults.alpha.admission, null);
    assert.equal(status.vaults.alpha.status, "pending");
    assert.equal(status.vaults.alpha.reason, "admissions-not-initialized");
    assert.equal(world.store.isInitialized(), false);
    await assert.rejects(fs.stat(world.file), "an uninitialized round must not create the record");

    // Explicit administrator initialization: only the confirmed list becomes approved.
    const approved = await world.service.initializeVaults({ confirm: ["alpha"], actor: ACTOR, source: "test-admin-list" });
    assert.deepEqual(approved.sort(), ["alpha", "vault"]);
    await world.service.reconcile("manual");
    assert.deepEqual(ids(world.registry), ["alpha", "vault"]);
    assert.equal(world.store.entryFor("alpha").admission, ADMISSION_APPROVED);
    assert.equal(world.store.entryFor("alpha").approvedBy, ACTOR);
    assert.equal(world.service.status().vaults.beta.status, "pending");
    assert.equal(world.service.status().vaults.beta.reason, "awaiting-approval");
    assert.equal(world.registry.refusal("beta").httpStatus, 403, "initialized but unapproved is 403");
    const document = JSON.parse(await fs.readFile(world.file, "utf8"));
    assert.equal(document.migration.done, true);
    assert.equal(document.migration.source, "test-admin-list");
    assert.equal(document.entries.alpha.admission, ADMISSION_APPROVED);
    assert.equal(document.entries.beta.admission, ADMISSION_PENDING, "a discovered-but-unconfirmed Vault is persisted as pending");

    // A second initialization is refused and the already-persisted decisions stay in force.
    await assert.rejects(world.service.initializeVaults({ confirm: ["beta"], actor: ACTOR, source: "again" }));
    assert.equal(world.store.entryFor("beta").admission, ADMISSION_PENDING);
    world.service.stop();
  } finally {
    await world.cleanup();
  }
});

test("prepare publishes nothing; commit is the only publisher and refuses a late candidate", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"] });
  try {
    const gate = (descriptor) => (descriptor.primary ? { admitted: true, status: "ready", identity: null } : { admitted: true, status: "ready", identity: null });
    const candidate = await world.registry.prepare({ gate, deadlineAt: Date.now() + 10_000 });
    assert.equal(world.registry.snapshot().ready, false, "prepare must not publish");
    assert.deepEqual(world.registry.list(), []);
    const published = world.registry.commit(candidate);
    assert.equal(published.ready, true);
    assert.deepEqual(ids(world.registry), ["alpha", "vault"]);

    // A candidate whose logical round deadline already passed must never enter the visible set.
    const stale = { ...candidate, deadlineAt: Date.now() - 1 };
    assert.throws(() => world.registry.commit(stale), (error) => error.code === VAULT_REGISTRY_ROUND_TIMEOUT);
    assert.equal(world.registry.snapshot(), published, "a refused late publish leaves the visible snapshot untouched");
  } finally {
    await world.cleanup();
  }
});

test("单飞: one round at a time, at most one pending rerun, coalesced triggers are answered immediately", async () => {
  let gateDelayMs = 40;
  const world = await makeWorld({
    vaults: ["alpha"],
    confirm: ["alpha"],
    resolveIdentity: async (options) => {
      await new Promise((resolve) => setTimeout(resolve, gateDelayMs));
      return resolveVaultIdentity(options);
    },
  });
  try {
    const first = world.service.reconcile("manual");
    assert.equal(world.service.status().inFlight, true);
    const coalescedA = await world.service.reconcile("manual");
    const coalescedB = await world.service.reconcile("watcher");
    assert.equal(coalescedA.status, "coalesced");
    assert.equal(coalescedB.status, "coalesced");
    assert.equal(coalescedB.trigger, "watcher", "the W4 trigger classes are already accepted by the seam");
    assert.equal(world.service.status().coalesced, 2);
    await first;
    assert.ok(await waitFor(() => world.service.status().runs >= 2 && !world.service.status().inFlight), "the single pending rerun must finish");
    const status = world.service.status();
    assert.equal(status.runs, 2, "exactly one rerun for any number of coalesced triggers (no queue)");
    assert.equal(status.pendingRerun, false);
    assert.equal(status.coalesced, 2);
    gateDelayMs = 0;
    world.service.stop();
  } finally {
    await world.cleanup();
  }
});

test("bounded enumeration: exceeding the per-parent cap aborts the round and publishes nothing", async () => {
  const world = await makeWorld({ vaults: ["a", "b", "c", "d"], limits: { maxEntriesPerParent: 3 }, confirm: [] });
  try {
    const result = await world.service.reconcile("manual");
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "discover");
    assert.equal(world.service.status().lastError.code, VAULT_REGISTRY_BOUND_EXCEEDED);
    assert.equal(world.registry.snapshot().ready, false, "a scan storm must never publish a partial inventory");
    assert.equal(world.service.status().failures, 1);
  } finally {
    await world.cleanup();
  }
});

test("the logical round deadline aborts the round before publish (a late result never enters the visible set)", async () => {
  let ticks = 0;
  const world = await makeWorld({
    vaults: ["alpha"],
    limits: { roundBudgetMs: 5 },
    now: () => 1_000_000 + (ticks += 100),
  });
  try {
    const result = await world.service.reconcile("startup");
    assert.equal(result.status, "failed");
    assert.equal(world.service.status().lastError.code, VAULT_REGISTRY_ROUND_TIMEOUT);
    assert.equal(world.registry.snapshot().ready, false);
    assert.equal(world.service.status().lastSuccessAt, null);
  } finally {
    await world.cleanup();
  }
});

test("diff: added / removed / changed / unchanged against the previously published snapshot", async () => {
  const versions = new Map();
  const world = await makeWorld({
    vaults: ["alpha"],
    confirm: ["alpha"],
    capabilitiesFor: ({ id }) => allCaps(`caps-${versions.get(id) ?? 1}`),
  });
  try {
    const first = await world.service.reconcile("startup");
    assert.deepEqual([...first.diff.added].sort(), ["alpha", "vault"]);
    assert.deepEqual(first.diff.removed, []);
    assert.deepEqual(first.diff.changed, []);

    const second = await world.service.reconcile("manual");
    assert.deepEqual(second.diff.added, []);
    assert.deepEqual(second.diff.removed, []);
    assert.deepEqual(second.diff.changed, []);
    assert.deepEqual([...second.diff.unchanged].sort(), ["alpha", "vault"]);

    await fs.mkdir(world.id("beta"));
    world.service.stop();
    const afterBetaAppears = await world.service.reconcile("manual");
    assert.deepEqual(afterBetaAppears.diff.added, []);
    assert.equal(world.service.status().vaults.beta.status, "pending", "a new directory is discovered but not admitted");

    await initializeIncarnation(world.id("beta")); // explicit test approval setup, never a scan write
    await world.store.commit({
      entries: { ...world.store.entries(), beta: { ...world.store.entries().alpha, identity: (await resolveVaultIdentity({ root: world.id("beta") })) } },
      registry: world.store.registrySnapshot(),
    });
    const afterBetaApproved = await world.service.reconcile("manual");
    assert.deepEqual(afterBetaApproved.diff.added, ["beta"]);

    versions.set("alpha", 2);
    const afterCapabilityChange = await world.service.reconcile("manual");
    assert.deepEqual(afterCapabilityChange.diff.changed, ["alpha"], "a runtime-fact change is a change");
    assert.deepEqual([...afterCapabilityChange.diff.unchanged].sort(), ["beta", "vault"]);

    await fs.rm(world.id("beta"), { recursive: true, force: true });
    const afterRemoval = await world.service.reconcile("manual");
    assert.deepEqual(afterRemoval.diff.removed, ["beta"]);
    world.service.stop();

    // The pure diff helper is the same function the service uses.
    assert.deepEqual(computeReconciliationDiff(null, { vaults: [{ id: "x" }] }).added, ["x"]);
  } finally {
    await world.cleanup();
  }
});

test("lifecycle: deletion ⇒ unavailable with the admission decision untouched", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    const before = world.store.entryFor("alpha");
    await fs.rm(world.id("alpha"), { recursive: true, force: true });
    const result = await world.service.reconcile("manual");
    assert.deepEqual(result.diff.removed, ["alpha"]);
    assert.equal(world.registry.get("alpha"), undefined, "a deleted Vault is not served");
    assert.equal(world.service.status().vaults.alpha.status, "unavailable");
    assert.equal(world.service.status().vaults.alpha.reason, "directory-missing");
    assert.equal(world.store.entryFor("alpha").admission, ADMISSION_APPROVED, "unavailable must not overwrite the admission decision");
    assert.equal(world.store.entryFor("alpha").identity.digest, before.identity.digest, "the identity binding is kept");
    world.service.stop();
  } finally {
    await world.cleanup();
  }
});

test("lifecycle: rename ⇒ old unavailable + new pending (no automatic authorization transfer)", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    await fs.rename(world.id("alpha"), world.id("alpha2"));
    await world.service.reconcile("manual");
    assert.equal(world.service.status().vaults.alpha.status, "unavailable");
    assert.equal(world.registry.get("alpha2"), undefined, "a renamed directory is NOT auto-approved under a new id");
    assert.equal(world.service.status().vaults.alpha2.status, "pending");
    assert.equal(world.store.entryFor("alpha2").admission, ADMISSION_PENDING);
    assert.equal(world.store.entryFor("alpha").admission, ADMISSION_APPROVED);
    world.service.stop();
  } finally {
    await world.cleanup();
  }
});

test("lifecycle: restore is admitted only when the identity matches and the original admission allowed it", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"], runtimeMap: true });
  try {
    await world.service.reconcile("startup");
    const original = world.store.entryFor("alpha").identity;
    const parked = path.join(world.base, "alpha-parked");
    await fs.rename(world.id("alpha"), parked);
    await world.service.reconcile("manual");
    assert.equal(world.registry.get("alpha"), undefined);

    await fs.rename(parked, world.id("alpha"));
    await world.service.reconcile("manual");
    assert.equal(world.registry.get("alpha")?.id, "alpha", "the same directory (same identity) is served again");
    assert.equal(world.store.entryFor("alpha").identity.digest, original.digest);
    assert.equal(world.service.status().vaults.alpha.status, "ready");
    assert.ok(world.disposed.some((entry) => entry.startsWith("drain:")), "the displaced runtime was drained, not merely dropped from the map");
    world.service.stop();
  } finally {
    await world.cleanup();
  }
});

test("a replaced directory is refused, the conflict is persisted and the old id is not re-approvable", async () => {
  const replacementTracker = createControlledReplacement();
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"], resolveIdentity: replacementTracker.resolve });
  try {
    await world.service.reconcile("startup");
    const originalDigest = world.store.entryFor("alpha").identity.digest;
    await fs.rm(world.id("alpha"), { recursive: true, force: true });
    await fs.mkdir(world.id("alpha"));
    replacementTracker.markReplaced(world.id("alpha"));
    await world.service.reconcile("manual");

    assert.equal(world.registry.get("alpha"), undefined, "a replaced directory must not be served");
    assert.equal(world.service.status().vaults.alpha.status, "unavailable");
    assert.equal(world.service.status().vaults.alpha.reason, "identity-changed");
    const entry = world.store.entryFor("alpha");
    assert.equal(entry.identity.digest, originalDigest, "the ORIGINAL identity binding is never overwritten");
    assert.equal(entry.identityConflict, true);
    assert.equal(entry.admission, ADMISSION_APPROVED, "the admission decision itself is untouched");

    const replacementIdentity = await resolveVaultIdentity({ root: world.id("alpha") });
    await assert.rejects(world.service.approve("alpha", { actor: ACTOR }), (error) => error.code === ADMISSION_IDENTITY_CONFLICT);
    assert.equal(world.store.entryFor("alpha").identityConflict, true);

    // Restart: the refusal is enforced by the persisted binding.
    const restarted = createAdmissionStore({ file: world.file, logger: quiet });
    await restarted.load();
    assert.equal(restarted.entryFor("alpha").identityConflict, true);
    await assert.rejects(restarted.approve("alpha", { actor: ACTOR, identity: replacementIdentity }), (error) => error.code === ADMISSION_IDENTITY_CONFLICT);
    world.service.stop();
  } finally {
    await world.cleanup();
  }
});

test("a persist failure publishes nothing and never rolls back a tightened refusal gate", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    const published = world.registry.snapshot();
    const failingStore = {
      ...world.store,
      commit: async () => { throw Object.assign(new Error("admissions write failed"), { code: "VAULT_ADMISSIONS_WRITE_FAILED" }); },
    };
    const failingService = createReconciliationService({ registry: world.registry, admissions: failingStore, logger: quiet });
    await fs.rm(world.id("alpha"), { recursive: true, force: true });
    const result = await failingService.reconcile("manual");
    assert.equal(result.status, "not-published");
    assert.equal(result.stage, "persist");
    assert.equal(failingService.status().lastError.code, "VAULT_ADMISSIONS_WRITE_FAILED");
    assert.equal(world.registry.snapshot(), published, "the previous visible snapshot is kept when the record cannot be persisted");
    assert.equal(world.store.entryFor("alpha").admission, ADMISSION_APPROVED, "the persisted decision was not rewritten");
    failingService.stop();

    // The next successful round still applies the tightened removal gate.
    const recovered = await world.service.reconcile("manual");
    assert.equal(recovered.status, "committed");
    assert.deepEqual(recovered.diff.removed, ["alpha"]);
    assert.equal(world.registry.get("alpha"), undefined);
    world.service.stop();
  } finally {
    await world.cleanup();
  }
});

test("post-commit activation failure degrades and retries without rolling back the new snapshot", async () => {
  const activated = [];
  let failed = false;
  const world = await makeWorld({
    vaults: ["alpha"],
    confirm: ["alpha"],
    retryDelayMs: 60,
    activate: async ({ id }) => {
      activated.push(id);
      if (id === "alpha" && !failed) {
        failed = true;
        throw Object.assign(new Error("index unavailable"), { code: "E_INDEX" });
      }
    },
  });
  try {
    const first = await world.service.reconcile("startup");
    assert.equal(first.status, "committed-degraded");
    assert.equal(first.stage, "activate");
    assert.equal(world.registry.get("alpha")?.id, "alpha", "a post-commit activation failure must NOT roll back the published Vault");
    assert.equal(world.service.status().vaults.alpha.status, "error");
    assert.equal(world.service.status().vaults.alpha.reason, "activation-failed");
    assert.ok(activated.includes("alpha"), "the newly published secondary is activated");
    assert.equal(world.store.entryFor("alpha").admission, ADMISSION_APPROVED, "the admission decision is untouched by an activation failure");
    assert.ok(await waitFor(() => activated.filter((id) => id === "alpha").length >= 2), "the degraded Vault is retried");
    assert.ok(await waitFor(() => world.service.status().vaults.alpha.status === "ready"));
    assert.equal(world.service.status().vaults.alpha.failureCount, 1);
    world.service.stop();
  } finally {
    await world.cleanup();
  }
});

test("runtime retirement drains then disposes a displaced instance and is observable", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"], runtimeMap: true });
  try {
    await world.service.reconcile("startup");
    assert.equal(world.map.get("alpha")?.id, "alpha");
    assert.equal(world.map.pendingRetirements(), 0);
    await world.service.revoke("alpha", { actor: ACTOR });
    assert.equal(world.map.get("alpha"), undefined, "a revoked Vault is no longer served");
    assert.ok(await waitFor(() => world.map.pendingRetirements() === 0));
    const drainIndex = world.disposed.indexOf("drain:alpha");
    const disposeIndex = world.disposed.indexOf("dispose:alpha");
    assert.ok(drainIndex >= 0 && disposeIndex > drainIndex, `drain must precede dispose: ${world.disposed.join(",")}`);
    world.service.stop();
  } finally {
    await world.cleanup();
  }
});

test("the persistent gate blocks an ungated publish from a refresh path this wave does not own", async () => {
  const world = await makeWorld({ vaults: ["alpha", "beta"] });
  try {
    // No reconciliation round has run; this is the shape of the Admin "refresh inventory" route.
    const snapshot = await world.registry.refresh();
    assert.deepEqual(snapshot.vaults.map((vault) => vault.id), ["vault"], "registry.refresh() must be gated too");
    assert.equal(snapshot.admissions.alpha.status, "pending");
    assert.equal(snapshot.skipped.filter((entry) => entry.reason === SKIP_REASONS.NOT_ADMITTED).length, 2);
  } finally {
    await world.cleanup();
  }
});

test("observability: per-Vault admission/status/timing projection, and W4 triggers are not scheduled", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"] });
  try {
    await world.service.reconcile("startup");
    const status = world.service.status();
    const alpha = status.vaults.alpha;
    assert.equal(alpha.admission, ADMISSION_APPROVED);
    assert.equal(alpha.status, "ready");
    assert.equal(typeof alpha.discoveryMs, "number");
    assert.ok(alpha.discoveryMs >= 0);
    assert.ok(Number.isFinite(Date.parse(alpha.lastSeenAt)));
    assert.equal(alpha.identityDigest, world.store.entryFor("alpha").identity.digest);
    assert.equal(status.vaults.vault.admission, ADMISSION_APPROVED);
    assert.equal(status.scheduled.watcher, false, "watcher/periodic scheduling is W4");
    assert.equal(status.scheduled.periodic, false);
    assert.equal(status.scheduled.debounceMs, 500);
    assert.equal(status.lastSuccessAt !== null, true);
    assert.ok(status.history.length >= 1);
    world.service.stop();
  } finally {
    await world.cleanup();
  }
});
