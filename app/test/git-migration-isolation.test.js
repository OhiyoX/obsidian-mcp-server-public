/**
 * B4 — façade ↔ per-vault GitRuntime isolation (contract §16.1/§16.4, §38.2, §44 item 8).
 *
 * The `src/git.js` façade must keep the exact pre-migration surface while every piece of Git state
 * belongs to a runtime instance. This file proves that through the façade: a persisted store record
 * reaches the primary runtime, a `vault.js` write routes its mutation into the primary runtime's
 * pending batch, and a second runtime sharing nothing with it (pending, flush, push counters).
 *
 * Env is set before the dynamic imports because `config.js` reads it at import time; the primary
 * record is written to the store file first so the façade's durable load→reconcile path is
 * exercised for real.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createGitRuntime } from "../src/git-runtime/runtime.js";
import { createPushHistory, pushObservability, resetPushObservability } from "../src/git-push-observability.js";

const execFileAsync = promisify(execFile);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTHOR = { agent: "b4-agent", model: "b4-model" };
const SECOND_AUTHOR = { agent: "b4-second", model: "b4-model" };

const root = await fs.mkdtemp(path.join(os.tmpdir(), "b4-isolation-"));
const primaryVault = path.join(root, "primary-vault");
const secondVault = path.join(root, "second-vault");
const dataRoot = path.join(root, "data");
after(() => fs.rm(root, { recursive: true, force: true }));

async function gitIn(dir, ...args) {
  return execFileAsync("git", ["-C", dir, ...args], { encoding: "utf-8" });
}

async function seedRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await gitIn(dir, "init", "-q", "-b", "master");
  await fs.writeFile(path.join(dir, "seed.md"), "seed\n");
  await gitIn(dir, "add", "seed.md");
  await gitIn(dir, "-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-q", "-m", "seed");
}

await seedRepo(primaryVault);
await seedRepo(secondVault);
await fs.mkdir(dataRoot, { recursive: true });
// A persisted primary record: proves the store → provider → runtime path through the façade and
// that persisted values beat the `GIT_*` baseline (remote `backup`, debounce 42). Nothing writes
// this file in production yet — Wave E's Admin does.
await fs.writeFile(path.join(dataRoot, "git-vaults.json"), `${JSON.stringify({
  schema: 1,
  revision: 1,
  vaults: {
    default: {
      enabled: true,
      autoCommit: true,
      autoPush: false,
      autoCommitSweep: false,
      debounceSeconds: 42,
      maxDelaySeconds: 900,
      sweepIntervalSeconds: 900,
      remote: "backup",
      branch: "",
      updatedAt: "2026-10-05T00:00:00.000Z",
    },
  },
})}\n`);

process.env.VAULT_PATH = primaryVault;
process.env.DATA_PATH = dataRoot;
process.env.GIT_ENABLED = "true";
process.env.GIT_AUTO_COMMIT = "true";
process.env.GIT_AUTO_PUSH = "false";
process.env.GIT_AUTO_COMMIT_SWEEP = "false";
process.env.GIT_COMMIT_DEBOUNCE_SECONDS = "300";
process.env.GIT_COMMIT_MAX_DELAY_SECONDS = "900";
process.env.GIT_REMOTE = "origin";
process.env.GIT_BRANCH = "";
process.env.GIT_AUTHOR_NAME = "Obsidian MCP";
process.env.GIT_AUTHOR_EMAIL = "obsidian-mcp@local";

const facade = await import("../src/git.js");
const vault = await import("../src/vault.js");
const { withRequestContext } = await import("../src/request-context.js");

// A second runtime for a different vault: its own root, its own config, its own state.
const secondLogs = [];
function createSecondRuntime({ enabled = true } = {}) {
  return createGitRuntime({
    vaultId: "secondary-b",
    root: secondVault,
    configProvider: () => ({
      enabled,
      autoCommit: enabled,
      autoPush: false,
      autoCommitSweep: false,
      debounceSeconds: 300,
      maxDelaySeconds: 900,
      sweepIntervalSeconds: 900,
      remote: "origin",
      branch: "",
    }),
    execFile: execFileAsync,
    execEnv: () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" }),
    authorEmail: "obsidian-mcp@local",
    sweepAuthor: { agent: "Obsidian MCP", model: "auto-sweep" },
    logger: { warn: (message) => secondLogs.push(message), error: () => {} },
  });
}

test("façade surface is frozen: names and arity", () => {
  const expected = {
    gitConfiguration: 0,
    trackGitMutation: 1,
    getGitStatus: 0,
    getGitDiff: 0,
    getGitLog: 0,
    commitGit: 0,
    flushAutoCommit: 0,
    sweepAutoCommit: 0,
    startSweepTimer: 0,
    stopSweepTimer: 0,
    pullGit: 0,
    pushGit: 0,
    reloadGitConfig: 0,
  };
  for (const [name, arity] of Object.entries(expected)) {
    assert.equal(typeof facade[name], "function", `${name} must still be exported`);
    assert.equal(facade[name].length, arity, `${name} arity changed`);
  }
});

test("the façade's primary reads the persisted record out of the store file", async () => {
  const status = await facade.reloadGitConfig();
  assert.equal(status.vaultId, "default");
  assert.equal(status.config.source, "persisted");
  assert.equal(status.config.remote, "backup", "persisted remote beats GIT_REMOTE=origin");
  assert.equal(status.config.debounceSeconds, 42, "persisted timing beats GIT_COMMIT_DEBOUNCE_SECONDS=300");
  const configuration = facade.gitConfiguration();
  assert.equal(configuration.remote, "backup");
  assert.equal(configuration.enabled, true);
  assert.equal(configuration.autoCommitSweep, false);
});

test("§16.4: a vault.js write routes the mutation into the primary runtime only", async () => {
  const second = createSecondRuntime();
  await fs.writeFile(path.join(secondVault, "untouched.md"), "second\n");
  await withRequestContext({ author: AUTHOR }, () => vault.atomicWriteFile(path.join(primaryVault, "routed.md"), "routed\n"));
  const configuration = facade.gitConfiguration();
  assert.deepEqual(configuration.pendingPaths, ["routed.md"], "the write is pending in the primary runtime");
  assert.deepEqual(configuration.pendingAuthors, [AUTHOR], "with the request author attached");
  assert.deepEqual(second.status().pending.paths, [], "the write never reached another runtime");
  second.stop();
});

test("two runtimes never share pending or flush state (façade primary + an independent runtime)", async () => {
  await facade.flushAutoCommit(); // own the pending state: no earlier case may contribute to this batch
  const second = createSecondRuntime();
  await second.start();
  await fs.writeFile(path.join(primaryVault, "primary-only.md"), "A\n");
  await fs.writeFile(path.join(secondVault, "second-only.md"), "B\n");
  await withRequestContext({ author: AUTHOR }, () => facade.trackGitMutation("primary-only.md"));
  second.trackMutation({ paths: ["second-only.md"], author: SECOND_AUTHOR });

  assert.deepEqual(facade.gitConfiguration().pendingPaths, ["primary-only.md"]);
  assert.deepEqual(second.status().pending.paths, ["second-only.md"]);

  const primaryFlush = await facade.flushAutoCommit();
  assert.equal(primaryFlush.committed, true);
  assert.deepEqual(facade.gitConfiguration().pendingPaths, [], "the primary flush consumed its own batch");
  assert.deepEqual(second.status().pending.paths, ["second-only.md"], "the primary flush never consumed B's batch");
  assert.equal((await gitIn(secondVault, "rev-parse", "HEAD:second-only.md").then(() => true, () => false)), false);

  const secondFlush = await second.flushNow();
  assert.equal(secondFlush.committed, true);
  assert.deepEqual(second.status().pending.paths, []);
  assert.equal((await gitIn(secondVault, "show", "HEAD:second-only.md")).stdout, "B\n");
  assert.equal((await gitIn(primaryVault, "rev-parse", "HEAD:second-only.md").then(() => true, () => false)), false, "B's commit landed in B's repository");
  second.stop();
});

test("push observability is per runtime; the module view is the primary's (#255, §16)", async () => {
  resetPushObservability();
  const second = createSecondRuntime();
  await second.start();

  // B fails twice (no remote configured in B's repo) — A must not move at all.
  await second.manualPush().catch(() => {});
  await second.manualPush().catch(() => {});
  assert.equal(second.pushObservability().consecutiveFailures, 2);
  assert.equal(secondLogs.filter((line) => /Git push failed/.test(line)).length, 2, "each failure is logged once, by its own runtime");
  assert.deepEqual(pushObservability(), { lastOutcome: null, consecutiveFailures: 0 }, "B's failures never reach the module (primary) view");
  assert.equal(facade.gitConfiguration().push.consecutiveFailures, 0);

  // The primary fails once through the façade: only the primary's history changes.
  const error = await facade.pushGit().then(() => null, (thrown) => thrown);
  assert.ok(error, "an absent remote must reject");
  const primaryPush = facade.gitConfiguration().push;
  assert.equal(primaryPush.consecutiveFailures, 1);
  assert.equal(primaryPush.lastOutcome.pushed, false);
  assert.equal(primaryPush.lastOutcome.remote, "backup", "the persisted remote is the one that was attempted");
  assert.deepEqual(pushObservability(), primaryPush, "the legacy module view is exactly the primary runtime's history");
  assert.equal(second.pushObservability().consecutiveFailures, 2, "the primary's failure never counted in B");
  second.stop();
});

test("no process-global Git state remains in the façade or the observability module", async () => {
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const gitSource = stripComments(await fs.readFile(path.join(APP_ROOT, "src/git.js"), "utf8"));
  assert.doesNotMatch(gitSource, /^(?:let|var)\s/m, "src/git.js must declare no module-level mutable binding");
  assert.doesNotMatch(gitSource, /^(?:const|let)\s+\w+\s*=\s*new (?:Set|Map)\b/m, "src/git.js must hold no module-level collection");
  for (const anchor of [
    "const pendingPaths = new Set();",
    "const pendingAuthors = new Map();",
    "let commitTimer;",
    "let maxDelayTimer;",
    "let sweepTimer;",
    "let pendingSince = null;",
    "let lastSweep = null;",
    "let operationQueue = Promise.resolve();",
    "let imminentFlushFor = null;",
  ]) {
    assert.ok(!gitSource.includes(anchor), `pre-migration module state must be gone: ${anchor}`);
  }
  const observabilitySource = stripComments(await fs.readFile(path.join(APP_ROOT, "src/git-push-observability.js"), "utf8"));
  assert.doesNotMatch(observabilitySource, /^let lastOutcome = null;/m, "the push singleton must be gone");
  assert.doesNotMatch(observabilitySource, /^let consecutiveFailures = 0;/m, "the failure counter singleton must be gone");
  // The helpers that #255 froze are still exported verbatim.
  const observability = await import("../src/git-push-observability.js");
  assert.equal(typeof observability.classifyPushFailure, "function");
  assert.equal(typeof observability.scrubCredentials, "function");
  assert.equal(typeof observability.formatPushFailureLog, "function");
});

test("createPushHistory isolates counters per instance", () => {
  const a = createPushHistory();
  const b = createPushHistory();
  a.record({ pushed: false, remote: "origin", branch: null, exitCode: 128, failureClass: "auth", summary: "denied", head: "h1" });
  a.record({ pushed: false, remote: "origin", branch: null, exitCode: 128, failureClass: "auth", summary: "denied", head: "h1" });
  assert.equal(a.snapshot().consecutiveFailures, 2);
  assert.equal(a.snapshot().lastOutcome.failureClass, "auth");
  assert.deepEqual(b.snapshot(), { lastOutcome: null, consecutiveFailures: 0 }, "a fresh history starts empty");
  b.record({ pushed: true, remote: "origin", branch: null, exitCode: 0, failureClass: null, summary: null, head: "h2" });
  assert.equal(b.snapshot().consecutiveFailures, 0, "a success resets only its own counter");
  assert.equal(a.snapshot().consecutiveFailures, 2);
  a.reset();
  assert.deepEqual(a.snapshot(), { lastOutcome: null, consecutiveFailures: 0 });
  assert.equal(b.snapshot().lastOutcome.pushed, true);
});
