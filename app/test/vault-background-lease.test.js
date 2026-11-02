// W2FIX3 (#437 RETURN-2, item 5) — background consumers are actually wired into lease/retirement.
//
// Independent negative controls for the second seat ruling §2.4: the Git sweep timer of a secondary
// Vault kept running after a durable revoke and produced a NEW commit ("HEAD changed, lastSweep
// .committed=true"), because the timer callback closed over the runtime and never re-checked the
// consumer handle's lease. The fix has two halves, both exercised here with a REAL Git binary:
//   * the production resolver passes the handle's lease guard into `createSecondaryRuntime`;
//   * the Git runtime re-checks that guard on EVERY new operation (including a captured timer
//     callback invoked directly after the revoke) and refuses to commit.
//
// The scheduler is injected so the sweep callback can be captured and invoked deterministically; the
// repository, the commits and the `git` process are real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { configureGitRuntimes, gitRuntimeFor, releaseGitRuntime } from "../src/git-runtimes.js";
import { createGitRuntime } from "../src/git-runtime/runtime.js";
import { createLeasedRuntime, createRuntimeLease, revokeRuntimeLease } from "../src/vault-runtime/runtime-lease.js";

const execFile = promisify(execFileCallback);
const quiet = { info() {}, warn() {}, error() {}, log() {} };
const CONFIG = Object.freeze({
  enabled: true, autoCommit: true, autoCommitSweep: true, autoPush: false,
  debounceSeconds: 60, maxDelaySeconds: 600, sweepIntervalSeconds: 30, remote: "origin", branch: "",
});

async function git(root, args) {
  const { stdout } = await execFile("git", ["-C", root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}

/** A scheduler whose sweep interval callback can be captured and fired by hand. */
function captureScheduler() {
  const intervals = [];
  const timeouts = [];
  return {
    intervals, timeouts,
    setTimeout(fn, ms) { const handle = { fn, ms, kind: "timeout" }; timeouts.push(handle); return handle; },
    clearTimeout(handle) { const index = timeouts.indexOf(handle); if (index >= 0) timeouts.splice(index, 1); },
    setInterval(fn, ms) { const handle = { fn, ms, kind: "interval" }; intervals.push(handle); return handle; },
    clearInterval(handle) { const index = intervals.indexOf(handle); if (index >= 0) intervals.splice(index, 1); },
  };
}

async function makeRepo(base) {
  const repo = path.join(base, "alpha");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "baseline.md"), "# baseline\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "baseline"]);
  return repo;
}

/** Wire the production resolver to a REAL secondary Git runtime with an injected clock/scheduler. */
function wire(primaryRuntime, build) {
  configureGitRuntimes({
    primaryGitRuntime: () => primaryRuntime,
    createSecondaryRuntime: ({ vaultId, root, guard }) => build({ vaultId, root, guard }),
    logger: quiet,
  });
}

test("ITEM 5: a real Git sweep timer cannot commit after a durable revoke (normal revoke)", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix3-git-"));
  const repo = await makeRepo(base);
  const scheduler = captureScheduler();
  const primaryRuntime = { vaultId: "vault", root: base, primary: true };
  wire(primaryRuntime, ({ vaultId, root, guard }) => createGitRuntime({
    vaultId, root, guard, configProvider: () => CONFIG, execFile: (file, args, options) => execFile(file, args, options),
    authorEmail: "test@example.com", scheduler, logger: quiet,
  }));
  const lease = createRuntimeLease("alpha", { generation: 1 });
  let allowed = true;
  const facade = createLeasedRuntime({ id: "alpha", root: repo, primary: false }, lease, () => allowed && lease.revoked !== true);
  try {
    const gitRuntime = gitRuntimeFor(facade);
    assert.equal(gitRuntime.root, repo);
    await gitRuntime.start();
    const sweepCallback = scheduler.intervals[0]?.fn;
    assert.equal(typeof sweepCallback, "function", "the sweep interval is armed");

    // Durable revoke: latch the lease and run the composition-root drain (the server wires these).
    allowed = false;
    revokeRuntimeLease(lease, "revoked");
    releaseGitRuntime(facade);
    assert.equal(gitRuntime.status().started, false, "the retirement stops the runtime");

    // The seat invoked the captured callback directly after the revoke. It must not commit.
    const headBefore = await git(repo, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repo, "after-revoke.md"), "# after revoke\n", "utf8");
    const sweepResult = await sweepCallback();
    assert.equal(sweepResult.committed, false, "a revoked handle never commits");
    assert.equal(sweepResult.reason, "git_runtime_lease_revoked");
    assert.equal(await git(repo, ["rev-parse", "HEAD"]), headBefore, "HEAD is unchanged after the revoked sweep");
    await assert.rejects(git(repo, ["show", "HEAD:after-revoke.md"]), "the post-revoke file was never committed");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("ITEM 5: a paused-scan revoke stops the background window; a re-approved generation can work again", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix3-git2-"));
  const repo = await makeRepo(base);
  const scheduler = captureScheduler();
  const primaryRuntime = { vaultId: "vault", root: base, primary: true };
  wire(primaryRuntime, ({ vaultId, root, guard }) => createGitRuntime({
    vaultId, root, guard, configProvider: () => CONFIG, execFile: (file, args, options) => execFile(file, args, options),
    authorEmail: "test@example.com", scheduler, logger: quiet,
  }));
  const lease = createRuntimeLease("alpha", { generation: 1 });
  let allowed = true;
  const facade = createLeasedRuntime({ id: "alpha", root: repo, primary: false }, lease, () => allowed && lease.revoked !== true);
  try {
    const oldRuntime = gitRuntimeFor(facade);
    await oldRuntime.start();
    const oldSweep = scheduler.intervals[0]?.fn;
    assert.equal(typeof oldSweep, "function");

    // Revoke DURING a coalesced scan: the lease is latched immediately (no wait for the scan) but the
    // runtime is not retired by a commit in this test.
    allowed = false;
    revokeRuntimeLease(lease, "revoked");
    await fs.writeFile(path.join(repo, "paused-revoke.md"), "# x\n", "utf8");
    const headBefore = await git(repo, ["rev-parse", "HEAD"]);
    const blocked = await oldSweep();
    assert.equal(blocked.committed, false, "the coalesced-scan window is closed");
    assert.equal(await git(repo, ["rev-parse", "HEAD"]), headBefore);

    // Re-approval mints a NEW generation/facade; the old callback stays dead, the new runtime works.
    const newLease = createRuntimeLease("alpha", { generation: 2 });
    const newFacade = createLeasedRuntime({ id: "alpha", root: repo, primary: false }, newLease, () => newLease.revoked !== true);
    const newRuntime = gitRuntimeFor(newFacade);
    await newRuntime.start();
    const newSweep = scheduler.intervals.at(-1)?.fn;
    assert.equal(typeof newSweep, "function");
    const committed = await newSweep();
    assert.equal(committed.committed, true, "the new generation's sweep may commit");
    assert.equal(await git(repo, ["show", `HEAD:paused-revoke.md`]).then((value) => value.includes("# x")), true);
    assert.equal(await oldSweep().then((result) => result.committed), false, "the old callback never revives");
    releaseGitRuntime(newFacade);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
