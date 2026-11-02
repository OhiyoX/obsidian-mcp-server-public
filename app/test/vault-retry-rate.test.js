import { approveConfirmedVault } from "../src/vault-runtime/explicit-enrollment.js";
// W2FIX3 (#437 RETURN-2, item 6) — the current self-retry rate is bounded.
//
// Independent negative control for the second seat ruling §2.5: with default parameters the service
// scanned and wrote the record 19 times in 250 ms because `retryDelayMs = 0` re-scheduled a
// zero-delay pending rerun after every degraded round. The fix: a validated bounded base delay, a
// geometric backoff with a single scheduled retry, and `stop()` cancelling it. A controllable
// scheduler makes the cadence deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdmissionStore } from "../src/vault-runtime/admission-store.js";
import { CAPABILITY_KEYS, unavailable } from "../src/vault-runtime/descriptor.js";
import { resolveVaultIdentity } from "../src/vault-runtime/identity.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import {
  DEFAULT_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  MIN_RETRY_DELAY_MS,
  RECONCILIATION_CONFIG_INVALID,
  createReconciliationService,
} from "../src/vault-runtime/reconciliation.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";

const ACTOR = "admin:test-session";
const quiet = { info() {}, warn() {}, log() {} };
const allCaps = () => Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, unavailable("test")]));

/** A scheduler whose timers only run when the test chooses. */
function manualScheduler() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(fn, ms) { const handle = { fn, ms, cleared: false }; scheduled.push(handle); return handle; },
    clearTimeout(handle) { handle.cleared = true; },
    fire() { const handle = scheduled.find((entry) => !entry.cleared); if (!handle) return null; handle.cleared = true; return handle.fn(); },
    pending: () => scheduled.filter((entry) => !entry.cleared),
  };
}

async function makeWorld({ vaults = [], retryDelayMs, scheduler } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix3-retry-"));
  const primaryRoot = path.join(base, "primary");
  const vaultsRoot = path.join(base, "vaults");
  await fs.mkdir(primaryRoot, { recursive: true });
  await fs.mkdir(vaultsRoot, { recursive: true });
  for (const id of vaults) await fs.mkdir(path.join(vaultsRoot, id), { recursive: true });
  const file = path.join(base, "data", "vault-admissions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });

  let betaBuilds = 0;
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
  const primaryRuntime = { id: "vault", root: primaryRoot, primary: true, localFs: { async readLimitedText() { return "primary-body"; }, drain() {}, dispose() {} } };
  const map = createVaultRuntimeMap({
    registry, dataRoot: path.join(base, "data"), primaryRuntime,
    createRuntime: ({ descriptor }) => {
      if (descriptor.id === "beta") { betaBuilds += 1; throw Object.assign(new Error("constructor failed"), { code: "E_BUILD" }); }
      return { id: descriptor.id, root: descriptor.root, primary: false, descriptor, localFs: { async readLimitedText() { return `${descriptor.id}-body`; }, drain() {}, dispose() {} } };
    },
  });
  const service = createReconciliationService({ registry, runtimeMap: map, admissions: store, resolveIdentity: resolveVaultIdentity, retryDelayMs, scheduler, logger: quiet });
  holder.service = service;
  const world = {
    base, registry, store, service, map,
    builds: () => betaBuilds,
    id: (name) => path.join(vaultsRoot, name),
    async cleanup() { service.stop(); await fs.rm(base, { recursive: true, force: true }); },
  };
  await service.initializeVaults({ confirm: vaults, actor: ACTOR, source: "test-admin-list" });
  return world;
}

test("ITEM 6: the default retry delay is bounded and 0/NaN/negative are refused", () => {
  assert.ok(DEFAULT_RETRY_DELAY_MS >= MIN_RETRY_DELAY_MS, "the default is a real delay, never 0");
  const registry = { prepare() {}, commit() {}, snapshot() {} };
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "50"]) {
    assert.throws(
      () => createReconciliationService({ registry, retryDelayMs: value, logger: quiet }),
      (error) => error.code === RECONCILIATION_CONFIG_INVALID,
      `retryDelayMs=${String(value)} must be refused`,
    );
  }
  assert.doesNotThrow(() => createReconciliationService({ registry, retryDelayMs: MIN_RETRY_DELAY_MS, logger: quiet }));
  assert.equal(MAX_RETRY_DELAY_MS, 900_000);
});

test("ITEM 6: a degraded round schedules exactly ONE retry with a bounded delay (no hot loop)", async () => {
  const scheduler = manualScheduler();
  const world = await makeWorld({ vaults: ["alpha", "beta"], retryDelayMs: 50, scheduler });
  try {
    const result = await world.service.reconcile("startup");
    assert.equal(result.status, "committed-degraded");
    assert.equal(result.stage, "prepare-runtime");
    assert.equal(world.builds(), 1, "beta was built once");
    // No dense sampling loop: the only scheduled timer is the ONE pending rerun, at the base delay.
    assert.equal(scheduler.pending().length, 1, "exactly one retry is scheduled");
    assert.equal(scheduler.pending()[0].ms, 50, "the retry uses the configured base delay, not 0");

    // Firing that ONE retry runs exactly one more round and schedules exactly one more retry: there is
    // no burst of zero-delay rounds (the seat measured 19 rounds / 250 ms before this fix).
    await scheduler.fire();
    assert.equal(world.builds(), 2, "exactly one additional round ran");
    assert.equal(scheduler.pending().length, 1, "still exactly one pending rerun (no stacking)");
    assert.equal(scheduler.pending()[0].ms, 100, "the next retry backs off");
  } finally {
    await world.cleanup();
  }
});

test("ITEM 6: consecutive failures back off geometrically and a clean round resets it", async () => {
  const scheduler = manualScheduler();
  const world = await makeWorld({ vaults: ["alpha", "beta"], retryDelayMs: 50, scheduler });
  try {
    await world.service.reconcile("startup");
    assert.equal(world.builds(), 1);
    await scheduler.fire(); // round 2 (retry)
    assert.equal(world.builds(), 2);
    assert.equal(scheduler.pending().length, 1);
    assert.equal(scheduler.pending()[0].ms, 100, "the second failure backs off to 2x");
    await scheduler.fire(); // round 3
    assert.equal(world.builds(), 3);
    assert.equal(scheduler.pending()[0].ms, 200, "the third failure backs off to 4x");

    // A clean round resets the backoff: fix beta by admitting a healthy delta and removing beta.
    await fs.rm(world.id("beta"), { recursive: true, force: true });
    await fs.mkdir(world.id("delta"), { recursive: true });
    await world.service.reconcile("manual");
    await approveConfirmedVault({ id: "delta", registry: world.registry, admissions: world.store, resolveIdentity: resolveVaultIdentity, now: Date.now, actor: ACTOR });
    const clean = await world.service.reconcile("manual");
    assert.equal(clean.status, "committed");
    assert.equal(world.registry.get("delta")?.id, "delta", "a healthy addition is admitted while beta keeps failing");
    assert.equal(scheduler.pending().length, 0, "a clean round schedules no retry");
  } finally {
    await world.cleanup();
  }
});

test("ITEM 6: stop() cancels the pending retry and nothing runs afterwards", async () => {
  const scheduler = manualScheduler();
  const world = await makeWorld({ vaults: ["alpha", "beta"], retryDelayMs: 50, scheduler });
  try {
    await world.service.reconcile("startup");
    assert.equal(scheduler.pending().length, 1);
    world.service.stop();
    assert.equal(scheduler.pending().length, 0, "stop() clears the pending retry timer");
    assert.equal(await scheduler.fire(), null, "nothing is left to fire");
    assert.equal(world.builds(), 1);
  } finally {
    await world.cleanup();
  }
});
