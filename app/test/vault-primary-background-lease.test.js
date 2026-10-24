// W2FIX4 (#437 W2FIX4 item B) — the PRIMARY Vault's background lifecycle is bound to the lease too.
//
// Independent negative controls for the seat's extended checks
// (`scratch/multi-vault/I437-W2/seat-w2fix3-background-extended.log`, probe `5-real-git-primary-normal`):
//   * after a durable revoke of the PRIMARY, the captured sweep-timer callback must not commit
//     (`headChangedAfterRevoke:false`, `workerStopped:true`, `timerCleared:true`);
//   * after a re-approval the OLD worker must stay dead (`oldWorkerChangedHeadAfterReapprove:false`),
//     while a CURRENT handle may resume the process-shared runtime.
//
// The secondary cases already passed before this fix; the primary was the gap: `gitRuntimeFor()`
// returned the process-shared primary runtime UNGUARDED, so its sweep timer kept committing and a
// rebind would have resurrected the previous generation's callbacks. The repository, the commits and
// the `git` process here are real; only the scheduler/clock are injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { configureGitRuntimes, gitRuntimeFor, releaseGitRuntime } from "../src/git-runtimes.js";
import { createGitRuntime } from "../src/git-runtime/runtime.js";
import { createAdmissionStore } from "../src/vault-runtime/admission-store.js";
import { createVaultRuntimeMap } from "../src/vault-runtime/instances.js";
import { createReconciliationService } from "../src/vault-runtime/reconciliation.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";
import { createVaultServingGate } from "../src/vault-runtime/serving-gate.js";

const execFile = promisify(execFileCallback);
const quiet = { info() {}, warn() {}, error() {}, log() {} };
const ACTOR = "admin:test-session";
const CONFIG = Object.freeze({
  enabled: true, autoCommit: true, autoCommitSweep: true, autoPush: false,
  debounceSeconds: 60, maxDelaySeconds: 600, sweepIntervalSeconds: 30, remote: "origin", branch: "",
});

async function git(root, args) {
  const { stdout } = await execFile("git", ["-C", root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}

function captureScheduler() {
  const intervals = [];
  const timeouts = [];
  return {
    intervals, timeouts,
    setTimeout(fn, ms) { const handle = { fn, ms, kind: "timeout", cleared: false }; timeouts.push(handle); return handle; },
    clearTimeout(handle) { handle.cleared = true; },
    setInterval(fn, ms) { const handle = { fn, ms, kind: "interval", cleared: false }; intervals.push(handle); return handle; },
    clearInterval(handle) { handle.cleared = true; },
  };
}

async function makeRepo(base, name) {
  const repo = path.join(base, name);
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "baseline.md"), "# baseline\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "baseline"]);
  return repo;
}

/** A registry + admission store + runtime map whose ONLY Vault is the primary. */
async function makePrimaryWorld(primaryGit, primaryRepo) {
  const base = path.dirname(primaryRepo);
  const vaultsRoot = path.join(base, "vaults");
  await fs.mkdir(vaultsRoot, { recursive: true });
  const file = path.join(base, "data", "vault-admissions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const servingGate = createVaultServingGate();
  servingGate.arm();
  const holder = { service: null };
  const registry = createVaultRegistry({
    primaryRoot: primaryRepo, primaryId: "vault", vaultsRoot, servingGate,
    gate: (descriptor) => holder.service.gate(descriptor),
  });
  const store = createAdmissionStore({ file, logger: quiet });
  await store.load();
  const primaryRuntime = {
    id: "vault", root: primaryRepo, primary: true,
    localFs: { async readLimitedText() { return "primary-body"; }, async writeText() { return { ok: true }; }, drain() {}, dispose() {} },
  };
  const map = createVaultRuntimeMap({
    registry, dataRoot: path.join(base, "data"), primaryRuntime,
    drainFor: (_descriptor, handle) => releaseGitRuntime(handle),
    createRuntime: () => { throw new Error("this world materializes no secondary runtime"); },
  });
  const service = createReconciliationService({ registry, runtimeMap: map, admissions: store, retryDelayMs: 100_000, logger: quiet });
  holder.service = service;
  await service.initializeVaults({ confirm: [], actor: ACTOR, source: "test-admin-list" });
  await service.reconcile("startup");
  return { base, registry, store, service, map, primaryRepo };
}

test("W2FIX4-B: a durable revoke stops the process-shared PRIMARY sweep; the old worker stays dead after re-approval", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix4-primary-"));
  const primaryRepo = await makeRepo(base, "vault");
  const scheduler = captureScheduler();
  const primaryGit = createGitRuntime({
    vaultId: "vault", root: primaryRepo, configProvider: () => CONFIG,
    execFile: (file, args, options) => execFile(file, args, options),
    authorEmail: "test@example.com", scheduler, logger: quiet,
  });
  configureGitRuntimes({
    primaryGitRuntime: () => primaryGit,
    createSecondaryRuntime: () => { throw new Error("this test materializes no secondary runtime"); },
    logger: quiet,
  });
  const world = await makePrimaryWorld(primaryGit, primaryRepo);
  try {
    const handle = world.map.get("vault");
    const worker = gitRuntimeFor(handle);
    // W2FIX5 R3: the resolver must hand out a fixed-generation FACADE, never the shared raw worker.
    assert.notEqual(worker, primaryGit, "the primary resolver hands out a per-generation facade, not the shared raw worker");
    assert.equal(worker.vaultId, "vault", "the facade still describes the same Vault");
    await worker.start();
    const timer = scheduler.intervals.filter((entry) => entry.kind === "interval" && !entry.cleared).at(-1);
    assert.equal(typeof timer?.fn, "function", "the primary sweep interval is armed");

    // Healthy positive control: the timer commits while the handle is current.
    await fs.writeFile(path.join(primaryRepo, "healthy.md"), "# healthy\n", "utf8");
    await timer.fn();
    const baseline = await git(primaryRepo, ["rev-parse", "HEAD"]);
    assert.notEqual(baseline, "", "the healthy control committed");

    // Durable revoke of the PRIMARY: the lease is latched and the composition-root drain stops it.
    await world.service.revoke("vault", { actor: ACTOR });
    await world.map.settleRetirements();
    assert.equal(worker.status().started, false, "the primary runtime is stopped by the revoke");
    assert.equal(timer.cleared, true, "the primary sweep interval is cleared");

    // The seat invoked the captured callback directly after the revoke. It must not commit.
    await fs.writeFile(path.join(primaryRepo, "after-revoke.md"), "# after revoke\n", "utf8");
    const revokedResult = await timer.fn();
    assert.equal(revokedResult.committed, false, "a revoked primary handle never commits");
    const after = await git(primaryRepo, ["rev-parse", "HEAD"]);
    assert.equal(after, baseline, "HEAD is unchanged after the revoked primary sweep");
    await assert.rejects(git(primaryRepo, ["show", "HEAD:after-revoke.md"]), "the post-revoke file was never committed");

    // Re-approval: the old worker (and its captured callback) must remain dead.
    await world.service.approve("vault", { actor: ACTOR });
    await fs.writeFile(path.join(primaryRepo, "after-reapprove.md"), "# old worker must stay dead\n", "utf8");
    const reapprovedResult = await timer.fn();
    assert.equal(reapprovedResult.committed, false, "the previous generation's callback never revives");
    assert.equal(await git(primaryRepo, ["rev-parse", "HEAD"]), after, "the old worker cannot move HEAD after re-approval");

    // The old FACADE's direct operations must stay dead after the re-approval (the seat's R3 gap:
    // a raw worker inherited the new guard).
    await assert.rejects(async () => worker.sweepNow(), (error) => error.code === "git_runtime_lease_revoked", "the old facade's direct sweep is refused after re-approval");

    // A CURRENT handle may resume the process-shared runtime and its new generation commits.
    const freshHandle = world.map.get("vault");
    assert.notEqual(freshHandle, handle, "re-approval mints a new consumer handle");
    const resumed = gitRuntimeFor(freshHandle);
    assert.notEqual(resumed, worker, "each generation gets its own facade");
    assert.equal(resumed.vaultId, "vault");
    const freshTimer = scheduler.intervals.filter((entry) => entry.kind === "interval" && !entry.cleared).at(-1);
    assert.equal(typeof freshTimer?.fn, "function", "binding a current handle resumes the primary sweep");
    await freshTimer.fn();
    const resumedHead = await git(primaryRepo, ["rev-parse", "HEAD"]);
    assert.notEqual(resumedHead, after, "the current generation commits again");
    assert.equal((await git(primaryRepo, ["show", "HEAD:after-reapprove.md"])).includes("old worker must stay dead"), true);
  } finally {
    releaseGitRuntime(world.map.get("vault") ?? {});
    world.service.stop();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("W2FIX5-R4: resolving the SAME current primary handle twice keeps the live sweep timer", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix5-r4-idempotent-"));
  const primaryRepo = await makeRepo(base, "vault");
  const scheduler = captureScheduler();
  const primaryGit = createGitRuntime({
    vaultId: "vault", root: primaryRepo, configProvider: () => CONFIG,
    execFile: (file, args, options) => execFile(file, args, options),
    authorEmail: "test@example.com", scheduler, logger: quiet,
  });
  configureGitRuntimes({
    primaryGitRuntime: () => primaryGit,
    createSecondaryRuntime: () => { throw new Error("this test materializes no secondary runtime"); },
    logger: quiet,
  });
  const world = await makePrimaryWorld(primaryGit, primaryRepo);
  try {
    const handle = world.map.get("vault");
    const worker = gitRuntimeFor(handle);
    await worker.start();
    const timer = scheduler.intervals.filter((entry) => entry.kind === "interval" && !entry.cleared).at(-1);
    const guardBefore = primaryGit.leaseGuard;

    // A NORMAL repeat resolve of the SAME current handle must be idempotent: no new guard function
    // (the timers' token), so the already-armed interval is not falsely invalidated (the seat's R4).
    const again = gitRuntimeFor(handle);
    assert.equal(again, worker, "the same handle returns the same facade");
    assert.equal(primaryGit.leaseGuard, guardBefore, "the same lease never replaces the guard/token");

    await fs.writeFile(path.join(primaryRepo, "still-live.md"), "# still live\n", "utf8");
    const result = await timer.fn();
    assert.equal(result.committed, true, "the live timer still commits after a repeat resolve");
    assert.notEqual(await git(primaryRepo, ["rev-parse", "HEAD"]), "", "the repeat resolve did not strand the timer");
  } finally {
    releaseGitRuntime(world.map.get("vault") ?? {});
    world.service.stop();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("W2FIX4-B: rebinding the primary to a NEW generation makes the previous callback stale even without a stop", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix4-primary-rebind-"));
  const primaryRepo = await makeRepo(base, "vault");
  const scheduler = captureScheduler();
  const primaryGit = createGitRuntime({
    vaultId: "vault", root: primaryRepo, configProvider: () => CONFIG,
    execFile: (file, args, options) => execFile(file, args, options),
    authorEmail: "test@example.com", scheduler, logger: quiet,
  });
  configureGitRuntimes({
    primaryGitRuntime: () => primaryGit,
    createSecondaryRuntime: () => { throw new Error("this test materializes no secondary runtime"); },
    logger: quiet,
  });
  const world = await makePrimaryWorld(primaryGit, primaryRepo);
  try {
    const handle = world.map.get("vault");
    const worker = gitRuntimeFor(handle);
    await worker.start();
    const oldTimer = scheduler.intervals.filter((entry) => entry.kind === "interval" && !entry.cleared).at(-1);
    await fs.writeFile(path.join(primaryRepo, "healthy.md"), "# healthy\n", "utf8");
    await oldTimer.fn();
    const baseline = await git(primaryRepo, ["rev-parse", "HEAD"]);

    // Revoke + re-approve, then resolve Git with the CURRENT handle: the guard is rebound to a NEW
    // closure object, so the old callback is refused by the token check (no `stop()` involved here).
    await world.service.revoke("vault", { actor: ACTOR });
    await world.service.approve("vault", { actor: ACTOR });
    const freshHandle = world.map.get("vault");
    gitRuntimeFor(freshHandle);
    await fs.writeFile(path.join(primaryRepo, "after-rebind.md"), "# stale\n", "utf8");
    const stale = await oldTimer.fn();
    assert.equal(stale.committed, false, "a callback armed under the previous guard is stale");
    assert.equal(await git(primaryRepo, ["rev-parse", "HEAD"]), baseline, "the stale callback cannot move HEAD");
  } finally {
    releaseGitRuntime(world.map.get("vault") ?? {});
    world.service.stop();
    await fs.rm(base, { recursive: true, force: true });
  }
});
