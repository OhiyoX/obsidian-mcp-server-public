// Focused tests for the Wave A / A6 per-vault GitRuntime factory (app/src/git-runtime/*).
// Deterministic: fake clock/scheduler + fake exec; no sleeps, no git binary, no network, no ambient config.
// Contract §13/§16/§21 MV-I04/§26 A6/§38.2/§44-8; frozen behavior: docs/multi-vault/W0-D-git-characterization.md §1-§10.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pushObservability, resetPushObservability } from "../src/git-push-observability.js";
import { GitPendingBatches } from "../src/git-runtime/pending.js";
import {
  GIT_RUNTIME_STATES,
  MCP_COMMIT_MESSAGE,
  SWEEP_MESSAGE,
  createGitRuntime,
} from "../src/git-runtime/runtime.js";
// Deterministic fixtures now live in `helpers/git-runtime-fixtures.js` (extracted for the line budget
// in #436; behavior unchanged).
import {
  AUTHOR,
  FakeClock,
  OTHER_AUTHOR,
  T0,
  VAULT_ROOT,
  defaultRespond,
  enabledConfig,
  fakeGit,
  gitError,
  setup,
} from "./helpers/git-runtime-fixtures.js";

test("pending: dedupe, per-author order, oldest pendingSince, no immediate commit", async () => {
  const { runtime, clock, git } = setup({ config: enabledConfig({ debounceSeconds: 3600, maxDelaySeconds: 3600 }) });
  await runtime.start();
  await clock.advance(1000);
  const tracked = runtime.trackMutation({ paths: ["b.md", "a.md", "b.md", "./dir/x.md"], author: AUTHOR });
  assert.deepEqual(tracked, { tracked: true, pendingPaths: ["a.md", "b.md", "dir/x.md"] });
  assert.equal(git.commits().length, 0, "tracking must not commit immediately");
  assert.equal(runtime.status().pending.pendingSince, clock.iso(), "the first track opens the oldest start");
  await clock.advance(5000); runtime.trackMutation({ paths: ["c.md"], author: OTHER_AUTHOR });
  // oldest start, not the newest one; first-seen author order is preserved
  assert.equal(runtime.status().pending.pendingSince, new Date(T0 + 1000).toISOString());
  assert.deepEqual(runtime.status().pending.authors, [AUTHOR, OTHER_AUTHOR]);
  assert.throws(() => runtime.trackMutation({ paths: ["a.md"] }), (error) => error.code === "git_runtime_author_required");
  assert.throws(() => runtime.trackMutation({ paths: ["../escape.md"], author: AUTHOR }), /inside the vault/);
  assert.throws(() => runtime.trackMutation({ paths: ["D:/elsewhere/x.md"], author: AUTHOR }), /traversal denied/);
  // The drive-letter rejection is a cross-platform contract, not a Windows-only escape probe: it runs
  // before posix normalization, so the error reports the caller's literal (`D:/./x.md`, unnormalized).
  const pending = new GitPendingBatches(VAULT_ROOT);
  assert.throws(() => pending.normalize("D:/x.md"), /traversal denied/);
  assert.throws(() => runtime.trackMutation({ paths: ["D:\\elsewhere\\x.md"], author: AUTHOR }), /traversal denied/);
  assert.throws(() => pending.normalize("D:/./x.md"), (error) => error.code === "git_runtime_invalid_path" && error.message.includes("D:/./x.md"));
  const result = await runtime.flushNow();
  assert.equal(result.committed, true);
  assert.equal(git.commits().length, 2, "one commit per pending author bucket");
  assert.deepEqual(runtime.status().pending, { paths: [], authors: [], pendingSince: null });
  await clock.advance(120_000);
  assert.equal(git.commits().length, 2, "a flushed batch is never re-committed");
});

test("debounce: one commit per quiet window, re-armed by a new mutation", async () => {
  const { runtime, clock, git } = setup({ config: enabledConfig({ debounceSeconds: 5, maxDelaySeconds: 3600 }) });
  await runtime.start();
  runtime.trackMutation({ paths: ["a.md"], author: AUTHOR });
  await clock.advance(3000);
  runtime.trackMutation({ paths: ["a.md"], author: AUTHOR }); // same path, new quiet window
  await clock.advance(4999);
  assert.equal(git.commits().length, 0, "the debounce restarts on every write");
  await clock.advance(1);
  assert.equal(git.commits().length, 1);
  assert.equal(runtime.status().timers.commit, false);
  assert.equal(runtime.status().timers.maxDelay, false);
  await clock.advance(120_000);
  assert.equal(git.commits().length, 1, "exactly one debounce commit");
});

test("max-delay: the oldest-start deadline fires ahead of the debounce", async () => {
  const { runtime, clock, git } = setup({ config: enabledConfig({ debounceSeconds: 30, maxDelaySeconds: 1 }) });
  await runtime.start();
  runtime.trackMutation({ paths: ["a.md"], author: AUTHOR });
  const since = runtime.status().pending.pendingSince;
  for (let index = 0; index < 4; index += 1) {
    await clock.advance(200);
    runtime.trackMutation({ paths: [`f${index}.md`], author: AUTHOR });
  }
  assert.equal(clock.now(), T0 + 800);
  await clock.advance(199);
  assert.equal(git.commits().length, 0, "the 30 s debounce is still counting");
  await clock.advance(1);
  assert.equal(git.commits().length, 1);
  assert.equal(clock.now() - Date.parse(since), 1000, "the flush landed on the oldest-start deadline");
  const message = git.commits()[0].args[git.commits()[0].args.indexOf("-m") + 1];
  assert.equal(message, `${MCP_COMMIT_MESSAGE}\n\nMCP-Agent: cursor\nMCP-Model: composer`);
  await clock.advance(60_000);
  assert.equal(git.commits().length, 1);
});

test("imminent floor: an expired deadline retries once, then the debounce cadence takes over", async () => {
  const { runtime, clock, git, logs } = setup({
    config: enabledConfig({ debounceSeconds: 5, maxDelaySeconds: 1 }),
    respond: (args) => (args.includes("commit") ? gitError({ code: 1, stderr: "hook declined" }) : defaultRespond(args)),
  });
  await runtime.start();
  runtime.trackMutation({ paths: ["a.md"], author: AUTHOR });
  await clock.advance(1000);
  assert.equal(git.commits().length, 1, "the max-delay deadline fires first");
  await clock.advance(24);
  assert.equal(git.commits().length, 1, "the imminent retry waits for the 25 ms floor");
  await clock.advance(1);
  assert.equal(git.commits().length, 2, "the expired deadline retries exactly once at the floor");
  await clock.advance(4999);
  assert.equal(git.commits().length, 2, "the one retry is not repeated while the debounce counts");
  await clock.advance(1);
  assert.equal(git.commits().length, 3, "after the floor retry only the debounce cadence retries");
  assert.deepEqual(runtime.status().pending.paths, ["a.md"], "a failed commit keeps its batch pending");
  assert.ok(logs.some((entry) => entry.level === "error" && entry.message.startsWith("Git auto-commit failed")));
});

test("timer lifecycle: exactly one sweep timer, replaced on interval change, cleared on stop", async () => {
  let config = enabledConfig({ autoCommitSweep: true, sweepIntervalSeconds: 30 });
  const { runtime, clock, git } = setup({ config: () => config });
  assert.equal(clock.intervals().length, 0);
  await runtime.start();
  assert.equal(clock.intervals().length, 1, "enable sweep arms exactly one timer");
  assert.equal(runtime.status().timers.sweep, true);
  await runtime.start();
  assert.equal(clock.intervals().length, 1, "repeated start does not stack a timer");
  await runtime.reloadConfig();
  assert.equal(clock.intervals().length, 1);
  config = enabledConfig({ autoCommitSweep: true, sweepIntervalSeconds: 60 });
  await runtime.reloadConfig();
  assert.equal(clock.intervals().length, 1, "interval change replaces the old timer");
  assert.deepEqual(clock.intervals().map((entry) => entry.interval), [60_000]);
  await clock.advance(30_000);
  assert.equal(git.commits().length, 0, "the replaced 30 s timer never fires");
  await clock.advance(30_000);
  assert.equal(git.commits().length, 1);
  runtime.stop();
  assert.equal(clock.intervals().length, 0);
  assert.equal(runtime.status().timers.sweep, false);
  await clock.advance(600_000);
  assert.equal(git.commits().length, 1);
  config = enabledConfig({ enabled: false, autoCommitSweep: true, sweepIntervalSeconds: 30 });
  await runtime.start();
  assert.equal(clock.intervals().length, 0, "a disabled vault arms nothing");
  // Contract §15.2 floors are re-applied even when configProvider hands over raw values.
  const floored = createGitRuntime({
    vaultId: "primary", root: VAULT_ROOT, execFile: fakeGit().exec, clock: new FakeClock(),
    configProvider: () => ({ enabled: true, autoCommit: true, autoPush: false, autoCommitSweep: false, debounceSeconds: 0, maxDelaySeconds: 0, sweepIntervalSeconds: 5 }),
  });
  assert.deepEqual([floored.config().debounceSeconds, floored.config().maxDelaySeconds, floored.config().sweepIntervalSeconds], [5, 1, 30]);
  assert.equal(floored.config().remote, "origin", "a missing remote falls back to the frozen default");
});

test("runtime isolation: pending, flush and push counters are per instance", async () => {
  resetPushObservability();
  let releasePush;
  const gate = new Promise((resolve) => { releasePush = resolve; });
  const failing = setup({
    respond: (args) => (args.includes("push") ? gate.then(() => gitError({ code: 128, stderr: "Permission denied (publickey)." })) : defaultRespond(args)),
  });
  const healthy = setup();
  await failing.runtime.start(); await healthy.runtime.start();
  failing.runtime.trackMutation({ paths: ["A-only.md"], author: AUTHOR });
  assert.deepEqual(healthy.runtime.status().pending.paths, [], "A pending never appears in B");
  await failing.clock.advance(10_000);
  assert.equal(failing.git.commits().length, 1, "A's debounce flushes A");
  assert.equal(healthy.git.commits().length, 0, "A's debounce never commits B");
  const blocked = failing.runtime.manualPush().catch((error) => error);
  assert.equal(healthy.runtime.status().state, GIT_RUNTIME_STATES.READY);
  assert.equal((await healthy.runtime.manualPush()).pushed, true, "B manual push resolves while A's queue is blocked");
  releasePush();
  const failure = await blocked;
  assert.equal(failure.pushOutcome.failureClass, "auth");
  assert.equal(failing.runtime.pushObservability().consecutiveFailures, 1);
  assert.equal(failing.runtime.pushObservability().lastOutcome.failureClass, "auth");
  assert.equal(healthy.runtime.pushObservability().consecutiveFailures, 0, "A's failure never counts in B");
  assert.equal(healthy.runtime.pushObservability().lastOutcome.pushed, true);
  assert.deepEqual(pushObservability(), { lastOutcome: null, consecutiveFailures: 0 }, "the module singleton stays untouched");
  await assert.rejects(() => healthy.runtime.manualPush({ branch: "-bad" }), (error) => error.code === "git_runtime_invalid_ref");
});

test("operation queue: a failing operation never poisons the next one", async () => {
  let failing = true;
  const { runtime, git } = setup({
    respond: (args) => (args.includes("commit") && failing ? gitError({ code: 1, stderr: "index.lock exists" }) : defaultRespond(args)),
  });
  await runtime.start();
  const first = await runtime.manualCommit({ paths: ["a.md"], author: AUTHOR }).then(() => null, (error) => error);
  assert.match(first.message, /index\.lock/);
  failing = false;
  const second = await runtime.manualCommit({ paths: ["a.md"], author: AUTHOR });
  assert.equal(second.committed, true, "the queue continues after a failed operation");
  assert.equal(git.commits().length, 2);
  await assert.rejects(() => runtime.manualPush({ remote: "-bad" }), (error) => error.code === "git_runtime_invalid_ref");
  assert.equal(git.pushes().length, 0, "an invalid remote is rejected before any git command");
});
test("manual pull: refuses a dirty work tree, otherwise pulls fast-forward only", async () => {
  const dirty = setup({ respond: (args) => (args.includes("status") ? { stdout: "## main\n M a.md\n" } : defaultRespond(args)) });
  await dirty.runtime.start();
  const refusal = await dirty.runtime.manualPull().then(() => null, (error) => error);
  assert.match(refusal.message, /Refusing to pull with uncommitted changes/);
  assert.equal(dirty.git.calls.some((call) => call.args.includes("pull")), false, "a dirty tree never reaches git pull");
  const clean = setup({ respond: (args) => (args.includes("status") ? { stdout: "## main\n" } : defaultRespond(args)) });  await clean.runtime.start();
  assert.equal((await clean.runtime.manualPull()).pulled, true);
  assert.deepEqual(clean.git.calls.find((call) => call.args.includes("pull")).args.slice(6), ["pull", "--ff-only", "origin"]);
});

test("execEnv injection, sweep consumption and the empty-sweep result", async () => {
  // The no-prompt credential mechanism is the caller's injection: the runtime
  // reads no ambient environment but passes the supplied child env through.
  const { runtime, git } = setup({ config: enabledConfig({ autoCommitSweep: true }), execEnv: () => ({ GIT_TERMINAL_PROMPT: "0" }) });
  await runtime.start();
  assert.deepEqual(git.calls[0].options.env, { GIT_TERMINAL_PROMPT: "0" });
  runtime.trackMutation({ paths: ["mcp-written.md"], author: AUTHOR });
  const swept = await runtime.sweepNow();
  assert.equal(swept.committed, true);
  assert.deepEqual(runtime.status().pending.paths, [], "the sweep consumes pre-existing pending batches");
  assert.equal(git.commits().length, 1, "the pending path lands in the sweep commit, not a second MCP commit");
  assert.equal(swept.message, `${SWEEP_MESSAGE}\n\nMCP-Agent: Obsidian MCP\nMCP-Model: auto-sweep`);
  assert.equal(runtime.status().lastSweep.committed, true);
  const empty = setup({ config: enabledConfig({ autoCommitSweep: true }), respond: (args) => (args.includes("--quiet") ? { stdout: "" } : defaultRespond(args)) });
  await empty.runtime.start();
  assert.deepEqual(await empty.runtime.sweepNow(), { committed: false, reason: "No staged changes", paths: [] });
  assert.equal(empty.runtime.status().lastSweep.committed, false);
  assert.equal(empty.git.commits().length, 0);
  const disabled = setup({ config: enabledConfig({ autoCommitSweep: false }) });
  assert.deepEqual(await disabled.runtime.sweepNow(), { committed: false, reason: "Automatic tree sweep is disabled", paths: [] });
  assert.equal(disabled.git.calls.length, 0, "a disabled sweep runs no git command");
});

// #436 coverage: the seat ruled that the sweep's *scope and competition* semantics must not change,
// only its wording. A write that lands while the sweep is already in flight must remain the later
// batch that the in-flight commit does not touch (W0-D §6 / `pending.js` `take()`).
test("sweep competition: a path tracked while the sweep is in flight stays pending", async () => {
  let releaseCommit;
  const gate = new Promise((resolve) => { releaseCommit = resolve; });
  let gateCommit = true;
  const { runtime, git } = setup({
    config: enabledConfig({ autoCommitSweep: true, debounceSeconds: 3600, maxDelaySeconds: 3600 }),
    respond: (args) => {
      if (gateCommit && args.includes("commit")) { gateCommit = false; return gate.then(() => defaultRespond(args)); }
      return defaultRespond(args);
    },
  });
  await runtime.start();
  runtime.trackMutation({ paths: ["before.md"], author: AUTHOR });
  const sweeping = runtime.sweepNow();
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(predicate(), "the sweep must reach its commit before the race is injected");
  };
  await waitFor(() => git.commits().length === 1);
  // The sweep has already detached the pre-existing batch, so this write is a new, later batch.
  runtime.trackMutation({ paths: ["during.md"], author: AUTHOR });
  releaseCommit();
  assert.equal((await sweeping).committed, true);
  assert.deepEqual(runtime.status().pending.paths, ["during.md"], "a write during the sweep survives into the next batch");
  assert.deepEqual(runtime.status().pending.authors, [AUTHOR]);
  assert.equal((await runtime.flushNow()).committed, true);
  assert.deepEqual(runtime.status().pending.paths, []);
  assert.equal(git.commits().length, 2, "the surviving path lands in its own MCP batch commit");
});

// #436 coverage: on the sweep failure path the log must stay honest (no success line) and the error
// must be visible — to the caller directly, and to the instance logger for a timer-triggered sweep.
test("sweep failure: the caller sees the error, no success log, pending batches survive", async () => {
  const { runtime, clock, logs } = setup({
    config: enabledConfig({ autoCommitSweep: true, debounceSeconds: 3600, maxDelaySeconds: 3600, sweepIntervalSeconds: 30 }),
    respond: (args) => (args.includes("commit") ? gitError({ code: 1, stderr: "index.lock exists" }) : defaultRespond(args)),
  });
  await runtime.start();
  runtime.trackMutation({ paths: ["pending-mcp.md"], author: AUTHOR });
  const failure = await runtime.sweepNow().then(() => null, (error) => error);
  assert.ok(failure, "a failed sweep must reject its caller so the tool reports the error");
  assert.match(failure.message, /index\.lock/);
  assert.deepEqual(runtime.status().pending.paths, ["pending-mcp.md"], "the consumed batch is restored, not lost");
  assert.equal(runtime.status().lastSweep, null, "a failed sweep records no lastSweep success");
  assert.equal(logs.some((entry) => /Git sweep committed/.test(entry.message)), false, "a failed sweep logs no success line");

  // The interval timer reports the failure through the instance logger instead of swallowing it.
  await clock.advance(30_000);
  const reported = logs.filter((entry) => entry.level === "error" && /Git sweep failed/.test(entry.message));
  assert.equal(reported.length, 1, `expected exactly one sweep-failure log: ${JSON.stringify(logs)}`);
  assert.match(reported[0].message, /index\.lock/);
});

test("push failures: classification, scrubbed summary, counters, push-failing state", async () => {
  const cases = [
    ["non-fast-forward", "! [rejected] main -> main (non-fast-forward)", 1],
    ["no-upstream", "fatal: The current branch main has no upstream branch.", 128],
    ["auth", "git@github.com: Permission denied (publickey).", 128],
    ["unreachable", "fatal: unable to access 'https://user:ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGG1234@github.com/o/r.git/': Could not resolve host: github.com", 128],
    ["rejected", "remote: error: [rejected] protected branch update failed", 1],
    ["unknown", "something else entirely", 1],
  ];
  for (const [expected, stderr, code] of cases) {
    const { runtime, logs } = setup({ respond: (args) => (args.includes("push") ? gitError({ code, stderr }) : defaultRespond(args)) });
    await runtime.start();
    const error = await runtime.manualPush().then(() => null, (thrown) => thrown);
    assert.ok(error, `${expected}: manual push must reject`);
    assert.equal(error.pushOutcome.failureClass, expected);
    const push = runtime.pushObservability();
    assert.equal(push.consecutiveFailures, 1);
    assert.equal(push.lastOutcome.pushed, false);
    assert.equal(push.lastOutcome.remote, "origin");
    const warn = logs.filter((entry) => entry.level === "warn").map((entry) => entry.message);
    assert.equal(warn.length, 1, `${expected}: exactly one non-silent WARN line`);
    assert.match(warn[0], new RegExp(`^Git push failed \\[${expected}\\] remote=origin exit=${code} consecutive=1: `));
  }
  // Credential scrubbing: the token never reaches the outcome, the log line or a summary.
  const tokenCase = cases.find(([name]) => name === "unreachable")[1];
  const scrubbed = setup({ respond: (args) => (args.includes("push") ? gitError({ code: 128, stderr: tokenCase }) : defaultRespond(args)) });
  await scrubbed.runtime.start(); await scrubbed.runtime.manualPush().catch(() => {});
  const summary = scrubbed.runtime.pushObservability().lastOutcome.summary;
  assert.ok(!summary.includes("ghp_") && /\*\*\*@github\.com/.test(summary), "URL userinfo is masked");
  assert.doesNotMatch(scrubbed.logs[0].message, /ghp_/);
  // A failing push never undoes the commit: the batch stays committed and reports pushed=false.
  const kept = setup({ respond: (args) => (args.includes("push") ? gitError({ code: 1, stderr: "! [rejected] non-fast-forward" }) : defaultRespond(args)) });
  await kept.runtime.start();
  const committed = await kept.runtime.manualCommit({ paths: ["note.md"], author: AUTHOR, push: true });
  assert.deepEqual([committed.committed, committed.pushed], [true, false]);
  assert.equal(committed.push.failureClass, "non-fast-forward");
  assert.equal(kept.git.commits().length, 1, "a failed push keeps the commit");
  // A later success resets the counter and leaves the push-failing state.
  let failing = true;
  const toggle = setup({ respond: (args) => (args.includes("push") && failing ? gitError({ code: 1, stderr: "[rejected] hook declined" }) : defaultRespond(args)) });
  await toggle.runtime.start();
  await toggle.runtime.manualPush().catch(() => {});
  assert.equal(toggle.runtime.state(), GIT_RUNTIME_STATES.PUSH_FAILING);
  failing = false;
  assert.equal((await toggle.runtime.manualPush()).pushed, true);
  assert.equal(toggle.runtime.pushObservability().consecutiveFailures, 0);
  assert.equal(toggle.runtime.state(), GIT_RUNTIME_STATES.READY);
});

test("state machine: disabled, repository-missing, config-invalid, push-failing", async () => {
  const disabled = setup({ config: enabledConfig({ enabled: false }) });
  assert.equal(disabled.runtime.state(), GIT_RUNTIME_STATES.DISABLED);
  assert.deepEqual(disabled.runtime.trackMutation({ paths: ["a.md"] }), { tracked: false, reason: "disabled" });
  await disabled.runtime.start();
  assert.equal(disabled.clock.intervals().length, 0);
  assert.equal(disabled.runtime.status().repository, "unprobed");

  const missing = setup({ respond: (args) => (args.includes("--is-inside-work-tree") ? { stdout: "false\n" } : defaultRespond(args)) });
  await missing.runtime.start();
  assert.equal(missing.runtime.state(), GIT_RUNTIME_STATES.REPOSITORY_MISSING);
  const unreachableRepo = setup({ respond: (args) => (args.includes("--is-inside-work-tree") ? gitError({ code: 128, stderr: "fatal: not a git repository" }) : defaultRespond(args)) });
  await unreachableRepo.runtime.start();
  assert.equal(unreachableRepo.runtime.state(), GIT_RUNTIME_STATES.REPOSITORY_MISSING);

  const clock = new FakeClock();
  const broken = createGitRuntime({
    vaultId: "primary", root: VAULT_ROOT, clock, execFile: fakeGit().exec,
    configProvider: () => { throw new Error("config boom"); },
  });
  assert.equal(broken.state(), GIT_RUNTIME_STATES.CONFIG_INVALID);
  assert.equal(broken.status().config, null);
  assert.throws(() => broken.flushNow(), (error) => error.code === "git_runtime_config_invalid");
  assert.equal(broken.trackMutation({ paths: ["a.md"], author: AUTHOR }).tracked, false);
  await broken.start();
  assert.equal(clock.intervals().length, 0);

  const failing = setup({ respond: (args) => (args.includes("push") ? gitError({ code: 1, stderr: "! [rejected] non-fast-forward" }) : defaultRespond(args)) });
  await failing.runtime.start();
  await failing.runtime.manualPush().catch(() => {});
  assert.equal(failing.runtime.state(), GIT_RUNTIME_STATES.PUSH_FAILING);
});

test("config reload: enable/disable, pending preserved, autoPush never retroactive", async () => {
  let config = enabledConfig({ enabled: false });
  const { runtime, clock, git } = setup({ config: () => config });
  await runtime.start();
  assert.equal(runtime.state(), GIT_RUNTIME_STATES.DISABLED);
  assert.equal(clock.intervals().length, 0);
  config = enabledConfig({ autoCommitSweep: true });
  await runtime.reloadConfig();
  assert.equal(runtime.state(), GIT_RUNTIME_STATES.READY);
  assert.equal(clock.intervals().length, 1, "false -> true arms the sweep timer");
  runtime.trackMutation({ paths: ["a.md"], author: AUTHOR });
  config = enabledConfig({ enabled: false, autoCommitSweep: true });
  await runtime.reloadConfig();
  assert.equal(clock.intervals().length, 0);
  assert.equal(runtime.status().timers.commit, false);
  assert.deepEqual(runtime.status().pending.paths, ["a.md"], "disable keeps committed-free pending state");
  assert.throws(() => runtime.flushNow(), (error) => error.code === "git_runtime_disabled");
  config = enabledConfig();
  await runtime.reloadConfig();
  assert.equal(runtime.status().timers.commit, true, "re-enable re-arms the pending timers");
  const committed = await runtime.flushNow();
  assert.equal(committed.committed, true);
  assert.equal(git.pushes().length, 0, "autoPush=false commits without pushing");
  config = enabledConfig({ autoPush: true });
  await runtime.reloadConfig();
  assert.equal(git.pushes().length, 0, "enabling autoPush never pushes an existing commit");
  await runtime.manualPush();
  assert.equal(git.pushes().length, 1, "only an explicit push reaches the remote");
});

test("frozen command shape: -C root, safe.directory, author/message templates", async () => {
  const { runtime, clock, git } = setup({ config: enabledConfig({ autoPush: true, autoCommitSweep: true }) });
  await runtime.start();
  runtime.trackMutation({ paths: ["note.md"], author: AUTHOR });
  await runtime.flushNow();
  await runtime.sweepNow();
  assert.ok(git.calls.length >= 8);
  for (const call of git.calls) {
    assert.equal(call.file, "git");
    const index = call.args.indexOf("-C");
    assert.notEqual(index, -1, "every command carries -C");
    assert.equal(call.args[index + 1], VAULT_ROOT, "-C is bound to this runtime's root");
    assert.ok(call.args.includes(`safe.directory=${VAULT_ROOT}`), "safe.directory matches the same root");
    assert.equal(call.args.includes("-c"), true);
    assert.equal(call.options.env, undefined, "no ambient env is injected unless the caller supplies execEnv");
  }
  const [batch, sweep] = git.commits();
  assert.equal(batch.args[batch.args.indexOf("-m") + 1], `${MCP_COMMIT_MESSAGE}\n\nMCP-Agent: cursor\nMCP-Model: composer`);
  assert.ok(batch.args.includes("user.name=cursor (composer)"));
  assert.ok(batch.args.includes("user.email=obsidian-mcp@local"));
  assert.deepEqual(batch.args.slice(batch.args.indexOf("--only")), ["--only", "--", "note.md"]);
  assert.equal(sweep.args[sweep.args.indexOf("-m") + 1], `${SWEEP_MESSAGE}\n\nMCP-Agent: Obsidian MCP\nMCP-Model: auto-sweep`);
  assert.ok(sweep.args.includes("user.name=Obsidian MCP (auto-sweep)"));
  assert.equal(sweep.args.includes("--only"), false);
  const sweepAdd = git.calls.filter((call) => call.args.includes("add")).at(-1);
  assert.deepEqual(sweepAdd.args.slice(6), ["add", "--all"], "the sweep stages the whole tree");
  assert.deepEqual(git.pushes()[0].args.slice(6), ["push", "origin"]);
  assert.equal(runtime.status().lastSweep.committed, true);
  assert.equal(runtime.status().lastSweep.pushed, true);
  await clock.advance(1000);
});

test("sources: no ambient config/env, no module-level mutable state, no ALS", () => {
  const patterns = [
    [/from\s+["'][^"']*config\.js["']/, "config.js import"],
    [/process\.env/, "process.env read"],
    [/request-context|requireRequestAuthor|AsyncLocalStorage/, "request context / ALS dependency"],
    [/^(?:let|var)\s/m, "module-level mutable binding"],
    [/^(?:const|let)\s+\w+\s*=\s*new (?:Set|Map)\b/m, "module-level mutable collection"],
  ];
  // Comments legitimately name the forbidden dependencies, so only code is scanned; the control below proves the matchers still bite.
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const directory = fileURLToPath(new URL("../src/git-runtime/", import.meta.url));
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".js"));
  // Wave B / B4 added `timers.js` (per-instance debounce/max-delay/sweep controller) and
  // `config-source.js` (A5 store + `GIT_*` baseline → `configProvider()`), both of which must obey
  // the same no-ambient-state rules.
  // Wave W2 F3 added `authorization.js` (per-instance authorization seam), which must obey the same rules.
  assert.deepEqual(files.sort(), ["authorization.js", "config-source.js", "operations.js", "pending.js", "runtime.js", "support.js", "timers.js"]);
  for (const file of files) {
    const source = stripComments(fs.readFileSync(path.join(directory, file), "utf8"));
    for (const [pattern, label] of patterns) assert.doesNotMatch(source, pattern, `${file}: ${label}`);
  }
  // Non-vacuous negative control: the same matchers must flag a violating module.
  const violating = 'import { VAULT } from "../config.js";\nlet lastOutcome = null;\nconst pendingPaths = new Set();\nconst x = process.env.GIT_ENABLED;\nrequireRequestAuthor();\n';
  for (const [pattern, label] of patterns) assert.match(violating, pattern, `negative control: ${label}`);
});
