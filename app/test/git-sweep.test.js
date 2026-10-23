import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";

const execFileAsync = promisify(execFile);
const vault = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-git-sweep-"));
process.env.VAULT_PATH = vault;
process.env.GIT_ENABLED = "true";
process.env.GIT_AUTO_COMMIT = "true";
process.env.GIT_AUTO_COMMIT_SWEEP = "true";
process.env.GIT_SWEEP_INTERVAL_SECONDS = "2";
process.env.GIT_COMMIT_DEBOUNCE_SECONDS = "300";
process.env.GIT_COMMIT_MAX_DELAY_SECONDS = "900";

const {
  flushAutoCommit,
  getGitStatus,
  gitConfiguration,
  startSweepTimer,
  stopSweepTimer,
  sweepAutoCommit,
  trackGitMutation,
} = await import("../src/git.js");
const { withRequestContext } = await import("../src/request-context.js");
after(() => fs.rm(vault, { recursive: true, force: true }));

async function git(...args) {
  return execFileAsync("git", ["-C", vault, ...args], { encoding: "utf-8" });
}

async function resetVault() {
  await fs.rm(path.join(vault, ".git"), { recursive: true, force: true });
  for (const entry of await fs.readdir(vault)) await fs.rm(path.join(vault, entry), { recursive: true, force: true });
  await git("init", "-q", "-b", "master");
  await fs.writeFile(path.join(vault, "seed.md"), "seed\n");
  await git("add", "seed.md");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "seed");
}

function withAuthor(fn) {
  return withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, fn);
}

// The interval timer is armed at import time; tests that drive the sweep directly stop it so a
// background tick cannot commit half-way through their assertions, and re-arm it where the timer
// itself is under test.
stopSweepTimer();
after(() => stopSweepTimer());

test("Tree sweep commits changes that never went through MCP", async () => {
  await resetVault();
  await fs.writeFile(path.join(vault, "synced-in.md"), "arrived through syncthing\n");

  const swept = await sweepAutoCommit();
  assert.equal(swept.committed, true);
  assert.deepEqual(swept.paths, ["*"]);
  assert.equal((await git("log", "-1", "--format=%s")).stdout.trim(), "chore(obsidian): sweep vault working-tree changes");
  const externalBody = (await git("log", "-1", "--format=%B")).stdout;
  assert.match(externalBody, /MCP-Model: auto-sweep/);
  // #436: the sweep message/log must name the executor, never claim the content's origin.
  assert.doesNotMatch(externalBody, /non-MCP/);
  assert.equal((await git("show", "-s", "--format=%at", "HEAD")).stdout.trim().length > 0, true);

  const status = await getGitStatus();
  assert.equal(status.clean, true, "the whole tree is committed after a sweep");
  assert.deepEqual(status.pendingAutoCommitPaths, [], "a sweep clears the MCP pending paths it commits");

  const { lastSweep, autoCommitSweep, sweepIntervalSeconds } = status.configuration;
  assert.equal(autoCommitSweep, true);
  assert.equal(sweepIntervalSeconds, 30, "GIT_SWEEP_INTERVAL_SECONDS is clamped to a 30 s floor");
  assert.equal(lastSweep.committed, true);
  assert.equal(lastSweep.hash, (await git("rev-parse", "HEAD")).stdout.trim());
  assert.ok(!Number.isNaN(Date.parse(lastSweep.at)));
});

test("Tree sweep is a no-op on a clean tree", async () => {
  await resetVault();
  const swept = await sweepAutoCommit();
  assert.equal(swept.committed, false);
  assert.equal(swept.reason, "No staged changes");
  assert.equal(gitConfiguration().lastSweep.committed, false);
  assert.equal((await git("log", "--format=%s")).stdout.trim().split("\n").length, 1, "no extra commit");
});

test("Tree sweep records deletions that MCP never performed", async () => {
  await resetVault();
  await fs.writeFile(path.join(vault, "moved-away.md"), "old home\n");
  await sweepAutoCommit();
  await fs.rm(path.join(vault, "moved-away.md"));

  const swept = await sweepAutoCommit();
  assert.equal(swept.committed, true);
  const stillTracked = await git("cat-file", "-e", "HEAD:moved-away.md").then(() => true, () => false);
  assert.equal(stillTracked, false, "the deletion is part of the sweep commit");
});

test("flushAutoCommit still commits only MCP paths; the sweep covers the rest", async () => {
  await resetVault();
  await fs.writeFile(path.join(vault, "via-mcp.md"), "written through MCP\n");
  await fs.writeFile(path.join(vault, "external.md"), "written by something else\n");

  const flushed = await withAuthor(async () => {
    trackGitMutation("via-mcp.md");
    return flushAutoCommit();
  });
  assert.equal(flushed.committed, true);

  let status = await getGitStatus();
  assert.ok(!status.changes.some((change) => change.path === "via-mcp.md"), "the MCP path is committed by the batch");
  assert.ok(status.changes.some((change) => change.path === "external.md"), "the non-MCP path is left for the sweep");
  assert.equal(status.clean, false);

  const swept = await sweepAutoCommit();
  assert.equal(swept.committed, true);
  status = await getGitStatus();
  assert.equal(status.clean, true);
  assert.equal(status.configuration.lastSweep.committed, true);
});

test("The interval timer sweeps without any MCP write arming a timer", async () => {
  await resetVault();
  await fs.writeFile(path.join(vault, "timer-only.md"), "no MCP write happened here\n");
  assert.deepEqual(gitConfiguration().pendingPaths, [], "nothing was tracked through MCP");
  assert.equal((await getGitStatus()).clean, false);

  // The production interval is clamped to >= 30 s; arm a 1 s timer here so the tick itself is
  // exercised instead of waiting out the floor.
  startSweepTimer(1);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(await getGitStatus()).clean) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  stopSweepTimer();

  const { lastSweep } = gitConfiguration();
  assert.ok(lastSweep && lastSweep.committed, "the interval timer must sweep on its own");
  assert.equal((await getGitStatus()).clean, true);
  assert.equal((await git("log", "-1", "--format=%s")).stdout.trim(), "chore(obsidian): sweep vault working-tree changes");
});

// #436 (Codex seat ruling, option 2): a sweep that consumed pending MCP writes must not describe its
// content as "non-MCP", and must not impersonate the agent that wrote those paths. The sweep keeps
// its own executor trailer (`auto-sweep`); scope/competition semantics stay exactly as frozen.
test("Tree sweep keeps the executor trailer and a neutral message for MCP pending content", async () => {
  await resetVault();
  await fs.writeFile(path.join(vault, "via-mcp.md"), "written through MCP\n");
  await withAuthor(async () => trackGitMutation("via-mcp.md"));
  assert.deepEqual(gitConfiguration().pendingPaths, ["via-mcp.md"], "the MCP write is pending before the sweep");

  const swept = await sweepAutoCommit();
  assert.equal(swept.committed, true, "the sweep consumes the pending MCP batch");
  assert.deepEqual(swept.paths, ["*"]);

  const body = (await git("log", "-1", "--format=%B")).stdout;
  assert.equal((await git("log", "-1", "--format=%s")).stdout.trim(), "chore(obsidian): sweep vault working-tree changes");
  assert.match(body, /MCP-Model: auto-sweep/, "the sweep is the committer of record");
  assert.doesNotMatch(body, /MCP-Agent: test-agent/, "the sweep never impersonates the MCP writer");
  assert.doesNotMatch(body, /non-MCP/, "pending MCP content must not be described as non-MCP");
  assert.equal((await getGitStatus()).clean, true);
});

// #436: mixed sources land in the same neutral sweep commit, still tagged as executed by the sweep.
test("Tree sweep commits mixed MCP and external changes under the same neutral message", async () => {
  await resetVault();
  await fs.writeFile(path.join(vault, "via-mcp.md"), "written through MCP\n");
  await fs.writeFile(path.join(vault, "external.md"), "written by something else\n");
  await withAuthor(async () => trackGitMutation("via-mcp.md"));

  const swept = await sweepAutoCommit();
  assert.equal(swept.committed, true);
  const body = (await git("log", "-1", "--format=%B")).stdout;
  assert.equal((await git("log", "-1", "--format=%s")).stdout.trim(), "chore(obsidian): sweep vault working-tree changes");
  assert.match(body, /MCP-Model: auto-sweep/);
  assert.doesNotMatch(body, /non-MCP/);
  assert.equal(await git("cat-file", "-e", "HEAD:via-mcp.md").then(() => true, () => false), true);
  assert.equal(await git("cat-file", "-e", "HEAD:external.md").then(() => true, () => false), true);
  assert.equal((await getGitStatus()).clean, true);
});

// #436: the sweep failure path must stay honest — the error reaches the caller, the instance log never
// claims a success it did not have, the failure is reported (timer path), and the pending MCP batch is
// restored instead of being lost. A held `.git/index.lock` is the deterministic cross-platform failure.
test("Tree sweep failure: error surfaces, no success log, pending survives, retry commits", async () => {
  await resetVault();
  await fs.writeFile(path.join(vault, "pending-mcp.md"), "written through MCP\n");
  await withAuthor(async () => trackGitMutation("pending-mcp.md"));
  const headBefore = (await git("rev-parse", "HEAD")).stdout.trim();
  const sweepBefore = gitConfiguration().lastSweep;
  await fs.writeFile(path.join(vault, ".git", "index.lock"), "");

  const warns = [];
  const errors = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...args) => warns.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const failure = await sweepAutoCommit().then(() => null, (error) => error);
    assert.ok(failure, "a failed sweep must reject its caller so the tool reports the error");
    assert.match(String(failure.message), /index\.lock/);
    assert.equal(warns.some((line) => /Git sweep committed/.test(line)), false, "a failed sweep logs no success line");
    // The interval timer path reports the failure through the instance logger instead of swallowing it.
    startSweepTimer(1);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !errors.some((line) => /Git sweep failed/.test(line))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    stopSweepTimer();
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
  const reported = errors.filter((line) => /Git sweep failed/.test(line));
  assert.ok(reported.length >= 1, `expected a sweep failure log, got ${JSON.stringify(errors)}`);
  assert.match(reported[0], /index\.lock/);
  assert.deepEqual(gitConfiguration().lastSweep, sweepBefore, "a failed sweep records no new lastSweep");

  await fs.rm(path.join(vault, ".git", "index.lock"));
  assert.equal((await git("rev-parse", "HEAD")).stdout.trim(), headBefore, "no commit landed while the lock was held");
  assert.deepEqual(gitConfiguration().pendingPaths, ["pending-mcp.md"], "the pending MCP batch survives the failure");
  const retried = await sweepAutoCommit();
  assert.equal(retried.committed, true, "the retry commits once the failure is gone");
  assert.deepEqual(gitConfiguration().pendingPaths, []);
  assert.equal((await getGitStatus()).clean, true);
});
