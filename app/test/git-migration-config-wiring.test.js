/**
 * B4 — A5 store + `GIT_*` baseline → per-vault GitRuntime wiring (contract §15.4, §16.3, §38.1/§38.3).
 *
 * Focused and deterministic: hand-built `configProvider`s, a counting scheduler and a fake exec, so
 * nothing here needs the real git binary, a network remote, or the process environment. The
 * runtime behavior itself is frozen by `git-runtime-factory.test.js`; the pre-migration semantics by
 * `multi-vault-git-characterization.test.js`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { createGitConfigStore } from "../src/git-config/store.js";
import { createGitConfigProvider } from "../src/git-runtime/config-source.js";
import { createGitRuntime } from "../src/git-runtime/runtime.js";

// The deployment's `GIT_*` baseline, exactly as `src/git.js` hands it over.
const ENV_DEFAULTS = {
  enabled: true,
  autoCommit: true,
  autoPush: false,
  autoCommitSweep: true,
  debounceSeconds: 180,
  maxDelaySeconds: 900,
  sweepIntervalSeconds: 900,
  remote: "origin",
  branch: "",
};
const VAULT_ROOT = path.resolve(os.tmpdir(), "b4-config-wiring-vault");
const createdDataRoots = [];
// The store fixtures live in the OS temp dir and are removed with the test process.
after(() => Promise.all(createdDataRoots.map((root) => fs.rm(root, { recursive: true, force: true }))));

// The provider learns that the durable store load settled on a microtask. The façade covers the
// same window with its post-load `reloadConfig()`; a test must not read the store earlier.
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function tempDataRoot(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `b4-${name}-`));
  createdDataRoots.push(root);
  return root;
}

function countingScheduler() {
  const counters = { setTimeout: 0, clearTimeout: 0, setInterval: 0, clearInterval: 0 };
  return {
    counters,
    setTimeout(fn, ms) { counters.setTimeout += 1; const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
    clearTimeout(handle) { counters.clearTimeout += 1; if (handle) clearTimeout(handle); },
    setInterval(fn, ms) { counters.setInterval += 1; const handle = setInterval(fn, ms); handle.unref?.(); return handle; },
    clearInterval(handle) { counters.clearInterval += 1; if (handle) clearInterval(handle); },
  };
}

function repoExec() {
  return async () => ({ stdout: "true\n", stderr: "" });
}

test("primary with no record resolves to the env baseline (source=env-default)", async () => {
  const store = createGitConfigStore({ dataRoot: await tempDataRoot("env-baseline") });
  await store.read();
  const provider = createGitConfigProvider({ vaultId: "default", primary: true, store, envDefaults: ENV_DEFAULTS });
  await settle();
  const effective = provider();
  assert.equal(effective.source, "env-default");
  assert.equal(effective.enabled, true);
  assert.equal(effective.autoCommit, true);
  assert.equal(effective.autoPush, false);
  assert.equal(effective.autoCommitSweep, true);
  assert.equal(effective.debounceSeconds, 180);
  assert.equal(effective.maxDelaySeconds, 900);
  assert.equal(effective.sweepIntervalSeconds, 900);
  assert.equal(effective.remote, "origin");
  assert.equal(effective.branch, "");
  // §38.1: primary + no record ⇒ effective == env baseline for the runtime too.
  const runtime = createGitRuntime({ vaultId: "default", root: VAULT_ROOT, configProvider: provider, execFile: repoExec() });
  assert.equal(runtime.config().source, "env-default");
  assert.equal(runtime.config().debounceSeconds, 180);
  runtime.stop();
});

test("secondary with no record is default-disabled and records nothing without an author", async () => {
  const store = createGitConfigStore({ dataRoot: await tempDataRoot("secondary-default") });
  await store.read();
  const provider = createGitConfigProvider({ vaultId: "other", primary: false, store, envDefaults: ENV_DEFAULTS });
  await settle();
  const effective = provider();
  assert.equal(effective.source, "default-disabled");
  assert.equal(effective.enabled, false, "a secondary must not inherit GIT_ENABLED=true");
  assert.equal(effective.autoCommit, false);
  assert.equal(effective.autoPush, false);
  assert.equal(effective.autoCommitSweep, false);
  assert.equal(effective.debounceSeconds, 180, "timing/remote values stay displayable for the Admin view");
  // The engine is proven by never running: a disabled secondary touches no exec at all.
  const runtime = createGitRuntime({
    vaultId: "other",
    root: VAULT_ROOT,
    configProvider: provider,
    execFile: () => { throw new Error("a disabled vault must not run git"); },
    scheduler: countingScheduler(),
  });
  assert.equal(runtime.state(), "disabled");
  assert.equal(runtime.config().enabled, false);
  // §16.4 / W0-D §1: the gate returns before an author is required.
  assert.deepEqual(runtime.trackMutation({ paths: ["a.md"] }), { tracked: false, reason: "disabled" });
  await runtime.probe();
  assert.equal(runtime.status().repository, "unprobed", "a disabled vault has no repo state to report");
  assert.equal(runtime.status().config.source, "default-disabled");
});

test("a persisted record wins over the env baseline and survives a reload (§38.1, §16.3)", async () => {
  const dataRoot = await tempDataRoot("persisted");
  const store = createGitConfigStore({ dataRoot });
  await store.read();
  const written = await store.upsertVault("other", {
    enabled: true,
    autoCommit: true,
    autoPush: true,
    autoCommitSweep: true,
    debounceSeconds: 30,
    maxDelaySeconds: 5,
    sweepIntervalSeconds: 60,
    remote: "backup",
    branch: "main",
  }, { expectedRevision: 0 });
  assert.equal(written.ok, true);
  const provider = createGitConfigProvider({ vaultId: "other", primary: false, store, envDefaults: ENV_DEFAULTS });
  await settle();
  const runtime = createGitRuntime({ vaultId: "other", root: VAULT_ROOT, configProvider: provider, execFile: repoExec() });
  assert.equal(runtime.config().source, "persisted");
  assert.equal(runtime.config().enabled, true, "persisted beats the default-disabled secondary rule");
  assert.equal(runtime.config().remote, "backup");
  assert.equal(runtime.config().branch, "main");
  assert.equal(runtime.config().debounceSeconds, 30);
  // Restart-equivalent: a fresh runtime over the same store sees the same record.
  const restarted = createGitRuntime({ vaultId: "other", root: VAULT_ROOT, configProvider: provider, execFile: repoExec() });
  assert.equal(restarted.config().remote, "backup");
  await runtime.start();
  assert.equal(runtime.state(), "ready", "the persisted enable is live at start");
  // §16.3: a later Admin write is picked up by `reloadConfig()`, atomically, without a restart.
  const off = await store.upsertVault("other", { enabled: false }, { expectedRevision: written.revision });
  assert.equal(off.ok, true);
  await runtime.reloadConfig();
  assert.equal(runtime.state(), "disabled");
  assert.equal(runtime.status().config.enabled, false);
  assert.equal(runtime.status().timers.sweep, false, "disable clears the sweep timer");
  runtime.stop();
  restarted.stop();
});

test("a broken store fails closed once its load settles, and only then", async () => {
  const dataRoot = await tempDataRoot("broken");
  await fs.writeFile(path.join(dataRoot, "git-vaults.json"), "{ this is not the schema\n");
  const store = createGitConfigStore({ dataRoot });
  const provider = createGitConfigProvider({ vaultId: "default", primary: true, store, envDefaults: ENV_DEFAULTS });
  const runtime = createGitRuntime({ vaultId: "default", root: VAULT_ROOT, configProvider: provider, execFile: repoExec(), scheduler: countingScheduler() });
  assert.equal(runtime.config().enabled, true, "before the load settles the primary still has its env baseline");
  await store.ready;
  await settle();
  await runtime.reloadConfig();
  assert.equal(runtime.state(), "config-invalid", "a corrupt store must never look like an empty configuration");
  assert.equal(runtime.config(), null);
  assert.throws(() => runtime.flushNow(), (error) => error.code === "git_runtime_config_invalid");
  assert.deepEqual(runtime.trackMutation({ paths: ["a.md"], author: { agent: "a", model: "m" } }), { tracked: false, reason: "config-invalid" });
});

test("§16.3 reload reconcile: one sweep interval, replaced on change, cleared on disable", async () => {
  const scheduler = countingScheduler();
  let config = { ...ENV_DEFAULTS, enabled: false, autoCommit: false };
  const runtime = createGitRuntime({
    vaultId: "default",
    root: VAULT_ROOT,
    configProvider: () => ({ ...config }),
    execFile: repoExec(),
    scheduler,
  });
  await runtime.start();
  assert.equal(scheduler.counters.setInterval, 0, "a disabled vault arms nothing");
  assert.equal(runtime.status().timers.sweep, false);

  config = { ...ENV_DEFAULTS };
  await runtime.reloadConfig();
  assert.equal(scheduler.counters.setInterval, 1, "enable arms exactly one sweep interval");
  assert.equal(runtime.status().timers.sweep, true);

  await runtime.reloadConfig();
  assert.equal(scheduler.counters.setInterval, 2, "a reload replaces the interval instead of stacking a second");
  assert.equal(scheduler.counters.clearInterval, 1);

  config = { ...config, sweepIntervalSeconds: 120 };
  await runtime.reloadConfig();
  assert.equal(scheduler.counters.setInterval, 3, "an interval change replaces the old timer");
  assert.equal(runtime.status().config.sweepIntervalSeconds, 120);
  assert.equal(runtime.status().timers.sweep, true);

  config = { ...config, enabled: false };
  await runtime.reloadConfig();
  assert.equal(scheduler.counters.setInterval, 3, "disable arms nothing new");
  assert.equal(scheduler.counters.clearInterval, 3);
  assert.equal(runtime.status().timers.sweep, false);

  config = { ...ENV_DEFAULTS };
  await runtime.reloadConfig();
  assert.equal(runtime.status().timers.sweep, true, "re-enabling arms the sweep again");
  await runtime.stop();
  assert.equal(runtime.status().timers.sweep, false, "stop clears it");
});

test("provider resolves without a store record lookup when the id has no record", async () => {
  const store = createGitConfigStore({ dataRoot: await tempDataRoot("unknown-id") });
  await store.read();
  const provider = createGitConfigProvider({ vaultId: "some-vault", primary: false, store, envDefaults: ENV_DEFAULTS });
  await settle();
  assert.equal(provider().source, "default-disabled");
  assert.throws(() => createGitConfigProvider({ vaultId: "some-vault", primary: false, store: null }), TypeError);
});
