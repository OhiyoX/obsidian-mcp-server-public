#!/usr/bin/env node
/**
 * W0-D Git characterization child harness (NEW, characterization only).
 *
 * Why a child process: `app/src/config.js` reads `process.env.GIT_*` at import time, and
 * `app/src/git.js` (plus `app/src/git-push-observability.js`) holds module-level pending/timer/
 * observability state and arms a process-global sweep timer as an import side effect
 * (`app/src/git.js:495`). Both make per-scenario env changes and state resets impossible inside one
 * module instance, so every scenario runs in a *fresh* Node process and reports one JSON line.
 *
 * Usage: node git-characterization-child.mjs <scenario>            (VAULT_PATH must be set)
 * Output: a single stdout line `__CHARACTERIZATION__<json>`; diagnostics go to stderr.
 *
 * Contract: docs/multi-vault/W0-D-git-characterization.md (frozen BASE 6dc8154c).
 * This file is a test helper, never a production entry point. It never contacts a network remote:
 * all repos are local `git init` working trees and the push-failure case uses a *missing* remote.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scenario = process.argv[2] || "";

// Safety: if `node --test` discovery ever picks this helper up as a test file it has no scenario.
if (!scenario) process.exit(0);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..", "..");
process.chdir(APP_ROOT);

const MARKER = "__CHARACTERIZATION__";
const AUTHOR_A = { agent: "char-agent-a", model: "char-model-a" };
const AUTHOR_B = { agent: "char-agent-b", model: "char-model-b" };
const VAULT = process.env.VAULT_PATH;

const warnings = [];
const errors = [];
const originalWarn = console.warn;
const originalError = console.error;
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
console.error = (...args) => { errors.push(args.map(String).join(" ")); };

async function git(...args) {
  return execFileAsync("git", ["-C", VAULT, ...args], { encoding: "utf-8" });
}

async function setupRepo() {
  await fs.mkdir(VAULT, { recursive: true });
  await git("init", "-q", "-b", "master");
  await fs.writeFile(path.join(VAULT, "seed.md"), "seed\n");
  await git("add", "seed.md");
  await git("-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-q", "-m", "seed");
}

async function write(relPath, content) {
  const abs = path.join(VAULT, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function headContent(relPath) {
  try {
    return (await git("show", `HEAD:${relPath}`)).stdout;
  } catch {
    return null;
  }
}

async function lastSubject() {
  return (await git("log", "-1", "--format=%s")).stdout.trim();
}

async function commitCount() {
  return Number((await git("rev-list", "--count", "HEAD")).stdout.trim());
}

async function porcelain() {
  return (await git("status", "--porcelain=v1")).stdout.trim().split("\n").filter(Boolean);
}

async function pollUntil(check, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return { ok: true, value };
    if (Date.now() >= deadline) return { ok: false, value: await check() };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const { trackGitMutation, commitGit, flushAutoCommit, getGitStatus, gitConfiguration, sweepAutoCommit, stopSweepTimer } = await import("../../src/git.js");
const { withRequestContext } = await import("../../src/request-context.js");

const scenarios = {
  // Contract §1.9 + §16.4 (GIT_ENABLED gate): disabled Git must make trackGitMutation a no-op and
  // leave no commit, not merely suppress the timer.
  async disabled() {
    await setupRepo();
    await write("x.md", "written while git is disabled\n");
    // No request context on purpose: the GIT_ENABLED gate returns before requireRequestAuthor().
    let noContextThrew = false;
    try { trackGitMutation("x.md"); } catch { noContextThrew = true; }
    let noContextThrewWithAuthor = false;
    try { await withRequestContext({ author: AUTHOR_A }, () => trackGitMutation("x.md")); } catch { noContextThrewWithAuthor = true; }
    const config = gitConfiguration();
    const disabledError = await getGitStatus().then(() => null, (error) => error.message);
    const before = { commits: await commitCount(), porcelain: await porcelain() };
    // The debounce floor is 5 s (config.js:48); waiting is not the evidence here — the empty pending
    // state proves no timer was ever armed, and the unchanged tree proves no commit happened.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      enabled: config.enabled,
      autoCommit: config.autoCommit,
      noContextThrew,
      noContextThrewWithAuthor,
      pendingPaths: config.pendingPaths,
      pendingAuthors: config.pendingAuthors,
      pendingSince: config.pendingSince,
      disabledError,
      commitsBefore: before.commits,
      commitsAfter: await commitCount(),
      porcelainBefore: before.porcelain,
      porcelainAfter: await porcelain(),
      debounceSeconds: config.debounceSeconds,
    };
  },

  // Contract §1.9 + §16.4: debounce commits the MCP batch with the frozen message/author template.
  async "debounce-commit"() {
    await setupRepo();
    await write("note.md", "debounced write\n");
    const startedAt = Date.now();
    await withRequestContext({ author: AUTHOR_A }, () => trackGitMutation("note.md"));
    const pendingSinceAtTrack = gitConfiguration().pendingSince;
    const polled = await pollUntil(async () => (await headContent("note.md")) === "debounced write\n", 9000);
    return {
      committed: polled.ok,
      elapsedMs: Date.now() - startedAt,
      pendingSinceAtTrack,
      subject: await lastSubject(),
      authorName: (await git("log", "-1", "--format=%an")).stdout.trim(),
      authorEmail: (await git("log", "-1", "--format=%ae")).stdout.trim(),
      body: (await git("log", "-1", "--format=%B")).stdout.trimEnd(),
      pendingPathsAfter: gitConfiguration().pendingPaths,
      pendingSinceAfter: gitConfiguration().pendingSince,
      porcelainAfter: await porcelain(),
      debounceSeconds: gitConfiguration().debounceSeconds,
      maxDelaySeconds: gitConfiguration().maxDelaySeconds,
    };
  },

  // Contract §1.9 + §16.4 (max-delay): the hard deadline flushes even while the debounce is still
  // counting down, because the deadline is anchored on the oldest pending start, not per write.
  async "max-delay"() {
    await setupRepo();
    await write("deadline.md", "hard deadline write\n");
    const startedAt = Date.now();
    await withRequestContext({ author: AUTHOR_A }, () => trackGitMutation("deadline.md"));
    const polled = await pollUntil(async () => (await headContent("deadline.md")) === "hard deadline write\n", 4500);
    return {
      committed: polled.ok,
      elapsedMs: Date.now() - startedAt,
      subject: await lastSubject(),
      debounceSeconds: gitConfiguration().debounceSeconds,
      maxDelaySeconds: gitConfiguration().maxDelaySeconds,
      pendingPathsAfter: gitConfiguration().pendingPaths,
      porcelainAfter: await porcelain(),
    };
  },

  // Contract §1.9 / §25 W0-D (sweep, current #265 semantics): the sweep is the only mechanism that
  // covers non-MCP writers, and it also folds any pending MCP batch into its own commit.
  async sweep() {
    stopSweepTimer();
    await setupRepo();
    await write("external-untracked.md", "arrived through Syncthing\n");
    await write("seed.md", "seed modified outside MCP\n");
    await write("mcp-pending.md", "written through MCP\n");
    await withRequestContext({ author: AUTHOR_A }, () => trackGitMutation("mcp-pending.md"));
    const pendingBefore = gitConfiguration().pendingPaths;
    const swept = await sweepAutoCommit();
    return {
      committed: swept.committed,
      paths: swept.paths,
      subject: await lastSubject(),
      authorName: (await git("log", "-1", "--format=%an")).stdout.trim(),
      authorEmail: (await git("log", "-1", "--format=%ae")).stdout.trim(),
      externalUntrackedCommitted: (await headContent("external-untracked.md")) === "arrived through Syncthing\n",
      externalModificationCommitted: (await headContent("seed.md")) === "seed modified outside MCP\n",
      mcpPendingFoldedInto: (await headContent("mcp-pending.md")) === "written through MCP\n",
      pendingBefore,
      pendingPathsAfter: gitConfiguration().pendingPaths,
      porcelainAfter: await porcelain(),
      lastSweep: gitConfiguration().lastSweep,
      autoCommitSweep: gitConfiguration().autoCommitSweep,
      sweepIntervalSeconds: gitConfiguration().sweepIntervalSeconds,
      warnings,
    };
  },

  // Contract §1.9 / §25 W0-D (push observability, current #255 semantics): a failed push must not
  // undo the commit, must classify the failure, log once, and count consecutive failures. Both
  // failing shapes are frozen: an absent remote *with* an upstream configured (unreachable), and the
  // upstream itself missing (no-upstream) — the classifier checks no-upstream before unreachable
  // (git-push-observability.js:35-39).
  async "push-failure"() {
    await setupRepo();
    // An upstream makes `git push origin` attempt the (never added) remote instead of failing
    // earlier on the missing upstream.
    await git("config", "branch.master.remote", "origin");
    await git("config", "branch.master.merge", "refs/heads/master");
    await write("push.md", "commit one\n");
    const first = await withRequestContext({ author: AUTHOR_A }, () => commitGit({ message: "push one", paths: ["push.md"], push: true }));
    // Drop the upstream; the still-absent remote is then reported as no-upstream.
    await git("config", "--unset", "branch.master.remote");
    await git("config", "--unset", "branch.master.merge");
    await write("push2.md", "commit two\n");
    const second = await withRequestContext({ author: AUTHOR_A }, () => commitGit({ message: "push two", paths: ["push2.md"], push: true }));
    const status = await getGitStatus();
    return {
      survived: true,
      firstCommitted: first.committed,
      firstPushed: first.pushed,
      firstPush: first.push,
      secondCommitted: second.committed,
      secondPushed: second.pushed,
      secondPush: second.push,
      lastOutcome: status.configuration.push.lastOutcome,
      consecutiveFailures: status.configuration.push.consecutiveFailures,
      subjects: (await git("log", "--reverse", "--format=%s")).stdout.trim().split("\n"),
      porcelainAfter: await porcelain(),
      warnings,
    };
  },

  // Contract §25 W0-D / §16.4: pendingPaths dedup + the per-author bucket order that decides the
  // order of the commits flushAutoCommit() emits.
  async "pending-model"() {
    await setupRepo();
    await withRequestContext({ author: AUTHOR_A }, () => {
      trackGitMutation(["b.md", "a.md", "b.md"]);
      trackGitMutation("dir/x.md");
      trackGitMutation("dir");
    });
    await withRequestContext({ author: AUTHOR_B }, () => trackGitMutation("c.md"));
    const config = gitConfiguration();
    await write("a.md", "a\n");
    await write("b.md", "b\n");
    await write("c.md", "c\n");
    await write("dir/x.md", "x\n");
    const flushed = await flushAutoCommit();
    return {
      pendingPathsAfterTrack: config.pendingPaths,
      pendingAuthorsAfterTrack: config.pendingAuthors,
      pendingSinceIsIso: typeof config.pendingSince === "string" && !Number.isNaN(Date.parse(config.pendingSince)),
      flushCommitted: flushed.committed,
      flushCommits: (flushed.commits || []).map((entry) => ({ agent: entry.author.agent, paths: entry.paths })),
      pendingPathsAfterFlush: gitConfiguration().pendingPaths,
      commitOrderOldestFirst: (await git("log", "--reverse", "--format=%an")).stdout.trim().split("\n").slice(1),
      porcelainAfter: await porcelain(),
    };
  },
};

async function main() {
  const run = scenarios[scenario];
  if (!run) throw new Error(`unknown scenario: ${scenario}`);
  const report = { scenario, ...(await run()) };
  process.stdout.write(`${MARKER}${JSON.stringify(report)}\n`);
}

try {
  await main();
} catch (error) {
  console.warn = originalWarn;
  console.error = originalError;
  process.stderr.write(`__CHARACTERIZATION_ERROR__ ${scenario}: ${error?.stack || error}\n`);
  process.exitCode = 1;
} finally {
  console.warn = originalWarn;
  console.error = originalError;
}

// Keep the process alive only for the scenario work above; the module-level sweep timer is unref'd
// by git.js, so nothing keeps the event loop open once main() settles.
