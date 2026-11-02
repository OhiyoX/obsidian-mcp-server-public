// W4 (#437) — integration: the automatic triggers drive the REAL unified reconciliation service in
// this process. No stub for discovery, admission, persistence, publishing or the runtime map: the
// only things injected are the scheduling numbers (short, to keep the suite fast) and, in the
// "missed event" case, a silent watch handle.
//
// Acceptance evidence this file must produce:
//   * a directory created while the process runs reaches `pending` (visible to Admin only) and only
//     after an explicit approve does it become servable/`ready` — discovery ≠ authorization;
//   * a watcher that delivers NOTHING still converges through the bounded periodic scan;
//   * an invisible/unmounted discovery parent produces a diagnostic and no Vault;
//   * a refresh triggered by the watcher does not reset an unrelated Vault's admission decision or
//     its already-materialized runtime handle.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVaultAdmissionController } from "../src/app/vault-admission.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";
import { VAULT_WATCH_PARENT_MISSING } from "../src/vault-runtime/vault-watcher.js";

const ACTOR = "admin:fixture";
const quiet = { info() {}, warn() {}, log() {} };
const FAST = { debounceMs: 60, maxCoalesceMs: 300, periodicMs: 150, maxBackoffMs: 600 };

// The waits below are "this converges EVENTUALLY" properties, so the deadline only decides when we
// give up — it never weakens what is asserted. 8 s was tuned on an idle machine; a full-suite run on a
// busy host (4000+ tests in flight) can stretch one reconcile round past it and produced a false red
// (`initializing` at the deadline). The failure message now carries the projection so the next reader
// can tell "round still in flight" from "stuck" instead of re-deriving it.
/** Compact projection for a timeout message: states + round counters, no history (it can be thousands of entries). */
function describeProjection(status) {
  const vaults = Object.fromEntries(Object.entries(status.vaults || {}).map(([id, vault]) => [id, `${vault.admission}/${vault.status}${vault.reason ? `(${vault.reason})` : ""}`]));
  return JSON.stringify({
    vaults,
    inFlight: status.inFlight,
    running: status.scheduled?.running,
    triggers: status.scheduled?.triggers,
    reconciles: status.reconciles,
    lastFailureCode: status.scheduled?.lastFailureCode,
    diagnostics: (status.scheduled?.diagnostics || []).slice(0, 3),
  });
}

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function makeWorld({ base = null, vaults = [], confirm = null, discovery = {}, automaticDiscovery = true, initialized = true } = {}) {
  const owned = base === null;
  const root = base ?? (await fs.mkdtemp(path.join(os.tmpdir(), "mv-w4-watch-")));
  const primaryRoot = path.join(root, "primary");
  const vaultsRoot = path.join(root, "vaults");
  const dataRoot = path.join(root, "data");
  await fs.mkdir(primaryRoot, { recursive: true });
  await fs.mkdir(vaultsRoot, { recursive: true });
  await fs.mkdir(dataRoot, { recursive: true });
  for (const id of vaults) await fs.mkdir(path.join(vaultsRoot, id), { recursive: true });

  let controller = null;
  const servingGate = createVaultServingGate();
  servingGate.arm();
  const registry = createVaultRegistry({
    primaryRoot, primaryId: "vault", vaultsRoot, servingGate,
    gate: (descriptor) => controller.gate(descriptor),
  });
  controller = createVaultAdmissionController({
    registry,
    file: path.join(dataRoot, "vault-admissions.json"),
    enrollmentFile: path.join(dataRoot, "vault-admission-enrollment.json"),
    automaticDiscovery,
    discovery: { ...FAST, ...discovery },
    logger: quiet,
  });
  await controller.load();
  const primaryRuntime = { id: "vault", root: primaryRoot, primary: true, localFs: {} };
  const map = createVaultRuntimeMap({
    registry, primaryRuntime, dataRoot,
    createRuntime: ({ descriptor }) => ({ id: descriptor.id, root: descriptor.root, primary: false, descriptor, dispose() {} }),
  });
  const service = controller.install({ runtimeMap: map });
  if (initialized) await controller.initialize({ confirm, actor: ACTOR, source: "w4-fixture" });
  else await controller.reconcile("startup");

  return {
    base: root, primaryRoot, vaultsRoot, dataRoot, registry, controller, service, map,
    id: (name) => path.join(vaultsRoot, name),
    async cleanup() {
      controller.stopDiscovery();
      service.stop();
      map.dispose();
      await map.settleRetirements();
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Windows: a handle the just-stopped watcher/runtime still holds makes `fs.rm` fail with
      // ENOTEMPTY/EBUSY (observed 1/20 isolated runs of this file, issue #602); Node's own bounded
      // retry is the documented mitigation and it weakens no assertion.
      if (owned) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("a directory created at runtime converges to pending, then to ready only after an explicit approve", async () => {
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"] });
  try {
    await world.controller.startDiscovery();
    const armed = world.controller.status().scheduled;
    assert.equal(armed.watcher, true, "the watcher must be subscribed to the configured discovery parent");
    assert.equal(armed.periodic, true, "the bounded periodic fallback must be armed");
    assert.equal(armed.parents, 1);
    assert.ok(!JSON.stringify(armed).includes(world.vaultsRoot), "the scheduled projection must not leak the absolute parent path");

    // The unrelated, already-approved Vault: its decision AND its materialized runtime handle.
    const before = world.controller.store.entryFor("alpha");
    const handleBefore = world.map.get("alpha");
    assert.equal(before.admission, "approved");
    assert.ok(handleBefore, "the approved Vault has a runtime handle before the new directory appears");

    await fs.mkdir(world.id("newcomer"), { recursive: true });
    const discovered = await waitFor(() => world.controller.status().vaults.newcomer?.status === "pending");
    assert.ok(discovered, `the watcher must converge on the new directory (status: ${JSON.stringify(world.controller.status().vaults.newcomer ?? null)})`);
    const projection = world.controller.status().vaults.newcomer;
    assert.equal(projection.admission, "pending", "discovery must never produce a positive admission decision");
    assert.equal(projection.reason, "awaiting-approval", "a discovered directory is pending, not approved");
    assert.equal(world.controller.store.entryFor("newcomer")?.admission, "pending");
    assert.equal(world.registry.get("newcomer"), undefined, "a pending Vault must not be servable");
    assert.equal(world.registry.refusal("newcomer").httpStatus, 403);

    // The refresh must not have reset the unrelated Vault.
    const after = world.controller.store.entryFor("alpha");
    assert.equal(after.admission, "approved");
    assert.equal(after.approvedAt, before.approvedAt, "an unrelated Vault's approval time must survive a watcher round");
    assert.equal(world.map.get("alpha"), handleBefore, "an unrelated Vault's runtime handle must not be replaced by a watcher round");
    assert.equal(world.controller.store.entryFor("newcomer").approvedAt, null);

    // Explicit administrator decision — the ONLY way to authorize.
    await world.controller.approve("newcomer", { actor: ACTOR });
    const ready = await waitFor(() => world.registry.get("newcomer") !== undefined && world.controller.status().vaults.newcomer?.status === "ready");
    assert.ok(ready, `after approval the Vault must be servable and ready; at the deadline: ${describeProjection(world.controller.status())}`);
    assert.equal(world.controller.store.entryFor("newcomer").admission, "approved");
    assert.equal(world.controller.store.entryFor("newcomer").approvedBy, ACTOR);
    assert.equal(world.controller.status().scheduled.triggers.watcher >= 1, true, "the round must be observable as watcher-triggered");

    // A note written INSIDE an approved Vault is not a discovery fact. On this platform the parent
    // watch may report the containing directory's own entry (`alpha`) as changed — a legitimate direct
    // child — so the contract is not "zero rounds" but BOUNDED rounds and NO state change: the round
    // must collapse into at most one, and the unrelated Vault's decision/status must be untouched.
    const watcherRoundsBefore = world.controller.status().scheduled.triggers.watcher;
    const approvedAtBefore = world.controller.store.entryFor("alpha").approvedAt;
    const newcomerHandle = world.map.get("newcomer");
    assert.ok(newcomerHandle, "the approved Vault has a materialized runtime handle before the note write");
    await fs.writeFile(path.join(world.id("alpha"), "note.md"), "# note");
    await new Promise((resolve) => setTimeout(resolve, FAST.debounceMs * 4));
    const roundsAfter = world.controller.status().scheduled.triggers.watcher;
    assert.ok(roundsAfter - watcherRoundsBefore <= 1, `a note write may cause at most one coalesced round, got ${roundsAfter - watcherRoundsBefore}`);
    assert.equal(world.controller.store.entryFor("alpha").approvedAt, approvedAtBefore, "a note write must not touch the admission decision");
    assert.equal(world.map.get("newcomer"), newcomerHandle, "a note write must not replace another Vault's runtime handle");
    // Readiness is asserted as a CONVERGED fact, not as a snapshot taken at an arbitrary instant.
    // A note write is allowed to trigger one round (bounded just above), and while any round is in
    // flight the service projects every candidate Vault as `initializing` before re-publishing
    // `ready` (`reconciliation-status.js#observeRoundStart`, contract §2.1) — so reading the
    // projection at a fixed `debounceMs * 4` measured whether a round happened to be in flight, and
    // produced a 30 % (6/20 isolated runs) false red on an idle host and on CI alike (issue #602).
    // The deadline below still fails the test if the round never converges back to `ready`, and the
    // durable runtime handle is asserted above, which is the disturbance this check is about.
    const readyAgain = await waitFor(() => world.controller.status().vaults.newcomer?.status === "ready");
    assert.ok(readyAgain, `a note write must not disturb another Vault's readiness; at the deadline: ${describeProjection(world.controller.status())}`);
    assert.equal(world.controller.status().vaults.newcomer.admission, "approved");
    assert.equal(world.controller.status().scheduled.triggers.periodic >= 0, true);
  } finally {
    await world.cleanup();
  }
});

test("a watcher that delivers no event at all still converges through the bounded periodic scan", async () => {
  // A silent handle: this is `fs.watch` losing/coalescing every event (inotify overflow, NAS, rename).
  const silent = { on() { return silent; }, close() {} };
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"], discovery: { watch: () => silent } });
  try {
    await world.controller.startDiscovery();
    const scheduled = world.controller.status().scheduled;
    assert.equal(scheduled.subscribed, 1, "the subscription exists — it simply never fires");
    await fs.mkdir(world.id("silent-arrival"), { recursive: true });
    const converged = await waitFor(() => world.controller.status().vaults["silent-arrival"]?.status === "pending");
    assert.ok(converged, "a missed watcher event must not lose the Vault: the periodic scan is the correctness path");
    assert.equal(world.controller.status().scheduled.triggers.watcher, 0, "no watcher event was delivered");
    assert.ok(world.controller.status().scheduled.triggers.periodic >= 1, "the convergence must be attributed to the periodic scan");
  } finally {
    await world.cleanup();
  }
});

test("an invisible/unmounted discovery parent is a diagnostic, never a false discovery", async () => {
  const missingParent = path.join(os.tmpdir(), `mv-w4-absent-${process.pid}-${Date.now()}`);
  const world = await makeWorld({ vaults: ["alpha"], confirm: ["alpha"], discovery: { parents: [missingParent] } });
  try {
    await world.controller.startDiscovery();
    const scheduled = world.controller.status().scheduled;
    assert.equal(scheduled.watcher, false, "an invisible parent must not produce a live subscription");
    assert.equal(scheduled.periodic, true, "the periodic fallback must still run (and keep looking)");
    assert.equal(scheduled.diagnostics.at(-1).code, VAULT_WATCH_PARENT_MISSING);
    assert.ok(!JSON.stringify(scheduled).includes(missingParent), "the diagnostic must not record the absolute path");
    assert.deepEqual(Object.keys(world.controller.status().vaults), ["vault", "alpha"], "an invisible parent must never be reported as a Vault");
    // The bounded scan still converges for the parent that IS visible (the registry root).
    const stillRunning = await waitFor(() => world.controller.status().scheduled.triggers.periodic >= 1);
    assert.ok(stillRunning, "the fallback scan must keep converging with one unsubscribable parent");
  } finally {
    await world.cleanup();
  }
});

test("with the discovery switch off no automatic trigger runs, and the manual Admin refresh still works", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w4-switch-"));
  try {
    // Phase 1: the switch on — discovery runs, the instance becomes managed (durable record + sentinel).
    const on = await makeWorld({ base, vaults: ["alpha"], confirm: ["alpha"] });
    await on.controller.startDiscovery();
    assert.equal(on.controller.status().scheduled.watcher, true);
    await on.cleanup();

    // Phase 2: the SAME data root restarted with the switch off. Enforcement must NOT be lifted
    // (W2 item 2), but neither the watcher nor the periodic scan may start (W4 / contract §10).
    let touched = 0;
    const off = await makeWorld({ base, vaults: ["alpha"], automaticDiscovery: false, initialized: false,
      discovery: { watch: () => { touched += 1; return { on() { return undefined; }, close() {} }; }, statApi: async () => { touched += 1; return { isDirectory: () => true }; } } });
    try {
      assert.equal(off.controller.enforced(), true, "an existing managed record must stay enforced with the switch off");
      assert.equal(await off.controller.startDiscovery(), null, "with the switch off there is nothing to start");
      assert.equal(touched, 0, "no filesystem handle may be created with the discovery switch off");
      const scheduled = off.controller.status().scheduled;
      assert.equal(scheduled.watcher, false);
      assert.equal(scheduled.periodic, false);
      // The automatic path is provably inert: a new directory appears and nothing happens on its own,
      // even after more than one configured period has elapsed.
      await fs.mkdir(off.id("later"), { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, FAST.periodicMs * 2));
      assert.equal(off.controller.status().vaults.later, undefined, "no automatic round may run with the switch off");
      assert.equal(touched, 0);
      // The manual Admin refresh is a different trigger and keeps working.
      await off.controller.reconcile("manual", { actor: ACTOR });
      assert.equal(off.controller.status().vaults.later.status, "pending", "the manual Admin refresh must keep working with the switch off");
      assert.equal(off.controller.store.entryFor("later").admission, "pending");
      assert.equal(off.controller.store.entryFor("alpha").admission, "approved", "the previously approved Vault stays approved");
    } finally {
      await off.cleanup();
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
