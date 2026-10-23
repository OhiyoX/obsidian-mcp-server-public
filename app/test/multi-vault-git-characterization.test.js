/**
 * W0-D Git characterization — freezes the *current* #255/#265 semantics (zero behavior change).
 *
 * Contract: `Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置` §1.9, §15, §16, §25 W0-D,
 * §38, §44 item 8. Evidence doc: `docs/multi-vault/W0-D-git-characterization.md`.
 *
 * Isolation choice (brief §1.2): every case runs in a **child process** via
 * `test/helpers/git-characterization-child.mjs`. `config.js:45-55` reads `GIT_*` at import time and
 * `git.js:28-42,495` holds module-level pending/timer/queue state plus arms a process-global sweep
 * timer on import; neither can be reset or re-read per case inside one module instance. One fresh
 * `node` process per scenario gives a genuinely fresh module state and lets each case own its env.
 *
 * Every assertion below is a **current-fact** freeze, annotated with the contract clause it anchors
 * and the "B4 must keep/improve" note. When Wave B4 moves this state into a per-vault GitRuntime,
 * update this file together with the doc.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(APP_ROOT, "test", "helpers", "git-characterization-child.mjs");
const MARKER = "__CHARACTERIZATION__";
const MCP_MESSAGE = "chore(obsidian): save MCP changes";
const SWEEP_MESSAGE = "chore(obsidian): sweep vault working-tree changes";
const AUTHOR_A = { agent: "char-agent-a", model: "char-model-a" };

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-w0d-git-"));
after(() => fs.rm(root, { recursive: true, force: true }));

// Explicit GIT_* for every child: the scenario decides the env, never the host running `npm test`.
const BASE_ENV = {
  GIT_ENABLED: "true",
  GIT_AUTO_COMMIT: "true",
  GIT_AUTO_PUSH: "false",
  GIT_AUTO_COMMIT_SWEEP: "true",
  GIT_COMMIT_DEBOUNCE_SECONDS: "300",
  GIT_COMMIT_MAX_DELAY_SECONDS: "900",
  GIT_SWEEP_INTERVAL_SECONDS: "900",
  GIT_AUTHOR_NAME: "Obsidian MCP",
  GIT_AUTHOR_EMAIL: "obsidian-mcp@local",
  GIT_REMOTE: "origin",
  GIT_BRANCH: "",
};

function runScenario(scenario, env = {}) {
  const vault = path.join(root, scenario);
  const timeoutMs = 30_000;
  const childEnv = { ...process.env, ...BASE_ENV, ...env, VAULT_PATH: vault };
  // `null` means "delete this variable for the child", so a case can freeze the unset-env rule
  // without inheriting BASE_ENV or the host environment.
  for (const [key, value] of Object.entries(childEnv)) if (value === null) delete childEnv[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, scenario], {
      cwd: APP_ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`scenario ${scenario} exceeded ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(MARKER));
      if (!line) {
        reject(new Error(`scenario ${scenario} produced no report (exit ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      const report = JSON.parse(line.slice(MARKER.length));
      report.exitCode = code;
      report.stderr = stderr;
      resolve(report);
    });
  });
}

// Contract §1.9 + §16.4: GIT_ENABLED is the hard gate; GIT_AUTO_COMMIT only narrows it.
// B4 must keep: a disabled Git vault produces zero commits and no pending state.
test("GIT_ENABLED=false makes trackGitMutation a no-op (no pending state, no commit)", async () => {
  const report = await runScenario("disabled", { GIT_ENABLED: "false", GIT_AUTO_COMMIT: "true", GIT_COMMIT_DEBOUNCE_SECONDS: "5" });
  assert.equal(report.exitCode, 0, report.stderr);
  assert.equal(report.enabled, false);
  assert.equal(report.autoCommit, true, "GIT_AUTO_COMMIT is irrelevant while GIT_ENABLED is false (git.js:138)");
  assert.equal(report.noContextThrew, false, "the GIT_ENABLED gate returns before requireRequestAuthor() (git.js:138)");
  assert.equal(report.noContextThrewWithAuthor, false);
  assert.deepEqual(report.pendingPaths, [], "no pending path may be recorded (git.js:28)");
  assert.deepEqual(report.pendingAuthors, []);
  assert.equal(report.pendingSince, null, "no debounce/max-delay timer may be armed (git.js:34)");
  assert.match(report.disabledError, /Git integration is disabled/);
  assert.equal(report.commitsAfter, report.commitsBefore, "no commit appeared");
  assert.deepEqual(report.porcelainBefore, ["?? x.md"]);
  assert.deepEqual(report.porcelainAfter, ["?? x.md"], "the file stays untracked");
});

// Contract §1.9 + §16.4: debounce commit keeps the frozen message + author template.
// B4 must keep: identical message and `MCP-Agent`/`MCP-Model` trailers. Current fact: because
// `.env`/compose export GIT_AUTHOR_NAME, git's own GIT_AUTHOR_NAME env wins over the per-commit
// `-c user.name="${agent} (${model})"` (git.js:272) and every auto-commit's Git author becomes the
// env value; the real MCP agent/model survives only in the message trailers. The next case freezes
// the env-unset half of that rule.
test("auto-commit debounce lands the MCP batch with the frozen message/author template", async () => {
  const report = await runScenario("debounce-commit", {
    GIT_COMMIT_DEBOUNCE_SECONDS: "5", // config.js:48 floors this at 5 s
    GIT_COMMIT_MAX_DELAY_SECONDS: "900",
    GIT_AUTHOR_NAME: "Obsidian MCP", // production-like: GIT_AUTHOR_NAME is exported by .env/compose
  });
  assert.equal(report.exitCode, 0, report.stderr);
  assert.equal(report.debounceSeconds, 5);
  assert.equal(report.maxDelaySeconds, 900);
  assert.equal(report.committed, true, "the debounce timer must commit the batch");
  assert.equal(typeof report.pendingSinceAtTrack, "string");
  assert.ok(!Number.isNaN(Date.parse(report.pendingSinceAtTrack)));
  // The batch only commits after the 5 s debounce and long before the 900 s max-delay, so the
  // debounce timer (commitTimer, git.js:174-179) is what fired.
  assert.ok(report.elapsedMs >= 4_500, `committed after ${report.elapsedMs}ms — too early for a 5 s debounce`);
  assert.equal(report.subject, MCP_MESSAGE, "message template frozen at git.js:269");
  assert.equal(report.authorName, "Obsidian MCP", "GIT_AUTHOR_NAME env overrides `-c user.name` (git.js:272)");
  assert.equal(report.authorEmail, "obsidian-mcp@local", "GIT_AUTHOR_EMAIL default (config.js:53)");
  assert.ok(report.body.startsWith(`${MCP_MESSAGE}\n\nMCP-Agent: char-agent-a\nMCP-Model: char-model-a`), report.body);
  assert.deepEqual(report.pendingPathsAfter, []);
  assert.equal(report.pendingSinceAfter, null, "pendingSince resets once the batch commits (git.js:433-441)");
  assert.deepEqual(report.porcelainAfter, [], "working tree clean after the batch commit");
});

// Contract §1.9 + §16.4: the hard deadline is anchored on the oldest pending start, not per write.
// B4 must keep: a batch lands within maxDelay even while the debounce is still counting down.
test("max-delay forces a flush before the debounce expires", async () => {
  const report = await runScenario("max-delay", {
    GIT_COMMIT_DEBOUNCE_SECONDS: "5",
    GIT_COMMIT_MAX_DELAY_SECONDS: "1",
  });
  assert.equal(report.exitCode, 0, report.stderr);
  assert.equal(report.debounceSeconds, 5);
  assert.equal(report.maxDelaySeconds, 1);
  assert.equal(report.committed, true, "the max-delay timer must flush the batch");
  assert.ok(report.elapsedMs < 5_000, `committed after ${report.elapsedMs}ms — that is the debounce, not the deadline`);
  assert.ok(report.elapsedMs >= 900, `committed after ${report.elapsedMs}ms — earlier than the 1 s deadline`);
  assert.equal(report.subject, MCP_MESSAGE);
  assert.deepEqual(report.pendingPathsAfter, []);
  assert.deepEqual(report.porcelainAfter, []);
});

// Contract §1.9 / §25 W0-D / §38.4 (sweep, current #265 semantics — recorded as fact, not as the
// desired end state). Current fact: sweepAutoCommit() commits the whole working tree, including
// changes no MCP tool wrote, and folds an in-flight MCP batch into its own sweep commit and author.
// B4 must keep: sweep covers non-MCP writers and reports `lastSweep`; the process-global timer is the
// item §44 old-red #8 wants per-vault.
test("sweep commits the whole working tree and the distinct author/message (current #265 behavior)", async () => {
  const report = await runScenario("sweep", {
    GIT_AUTO_COMMIT_SWEEP: "true",
    GIT_SWEEP_INTERVAL_SECONDS: "30",
    GIT_COMMIT_DEBOUNCE_SECONDS: "300",
    // Unset so the Git author shows git.js's own sweep identity instead of the env override.
    GIT_AUTHOR_NAME: null,
    GIT_AUTHOR_EMAIL: null,
  });
  assert.equal(report.exitCode, 0, report.stderr);
  assert.equal(report.committed, true);
  assert.deepEqual(report.paths, ["*"], "the sweep commits the whole tree (git.js:357-365)");
  assert.equal(report.subject, SWEEP_MESSAGE, "sweep message frozen at git.js:47 (wording neutralised by #436; scope unchanged)");
  assert.equal(report.authorName, "Obsidian MCP (auto-sweep)", "sweep author is `GIT_AUTHOR_NAME (auto-sweep)` (git.js:362), visible only with GIT_AUTHOR_NAME unset");
  assert.equal(report.externalUntrackedCommitted, true, "an untracked Syncthing-style file is committed by the sweep");
  assert.equal(report.externalModificationCommitted, true, "a modification no MCP tool made is committed by the sweep");
  assert.equal(report.mcpPendingFoldedInto, true, "`consumePending` folds an in-flight MCP batch into the sweep commit");
  assert.deepEqual(report.pendingBefore, ["mcp-pending.md"]);
  assert.deepEqual(report.pendingPathsAfter, []);
  assert.deepEqual(report.porcelainAfter, []);
  assert.equal(report.lastSweep.committed, true);
  assert.equal(report.lastSweep.pushed, null, "GIT_AUTO_PUSH=false → the sweep records pushed:null (git.js:369)");
  assert.ok(typeof report.lastSweep.hash === "string" && report.lastSweep.hash.length >= 7);
  assert.equal(report.autoCommitSweep, true);
  assert.equal(report.sweepIntervalSeconds, 30, "config.js:51 floors the sweep interval at 30 s");
  assert.ok(report.warnings.some((line) => /Git sweep committed/.test(line)), report.warnings.join("\n"));
});

// Contract §1.9 / §25 W0-D / §38.4 (push observability, current #255 semantics). Current fact: a
// failed push is reported, classified and counted, and never rolls back the commit.
// B4 must keep: classification, scrubbed summary, `git_status.configuration.push`, counting.
test("a failing push is classified, logged and counted without undoing the commit (#255)", async () => {
  const report = await runScenario("push-failure", {
    GIT_AUTO_PUSH: "true",
    GIT_REMOTE: "origin", // deliberately never configured: `git push origin` fails locally, no network
    GIT_BRANCH: "",
    GIT_COMMIT_DEBOUNCE_SECONDS: "300",
  });
  assert.equal(report.exitCode, 0, report.stderr);
  assert.equal(report.survived, true, "a push failure must not crash or reject the commit flow");
  assert.equal(report.firstCommitted, true);
  assert.equal(report.firstPushed, false);
  assert.equal(report.firstPush.failureClass, "unreachable", "absent remote with an upstream configured (git-push-observability.js:39)");
  assert.equal(report.firstPush.remote, "origin");
  assert.equal(report.secondCommitted, true);
  assert.equal(report.secondPushed, false);
  assert.equal(report.secondPush.failureClass, "no-upstream", "missing upstream is checked before unreachable (git-push-observability.js:37)");
  assert.equal(report.lastOutcome.pushed, false);
  assert.equal(report.lastOutcome.failureClass, "no-upstream");
  assert.equal(report.consecutiveFailures, 2, "consecutive failures are counted (git-push-observability.js:48-51)");
  assert.equal(report.warnings.length, 2, "each failed push logs exactly once (git.js:481)");
  assert.match(report.warnings[0], /Git push failed \[unreachable\] remote=origin/);
  assert.match(report.warnings[1], /Git push failed \[no-upstream\] remote=origin/);
  for (const line of report.warnings) assert.match(line, /consecutive=\d+/);
  assert.ok(report.subjects.includes("push one") && report.subjects.includes("push two"), "the commits are kept, not rolled back");
  assert.deepEqual(report.porcelainAfter, [], "the tree is clean — only the push failed");
});

// Contract §25 W0-D / §16.4: pendingPaths dedup, per-author buckets, and the flush commit order.
// B4 must keep: dedup by normalized path, one bucket per `<agent>\0<model>`, first-seen author order,
// and prefix-expansion when a tracked folder covers its children.
test("pending state dedups paths and preserves first-seen author order at flush", async () => {
  const report = await runScenario("pending-model", {
    GIT_COMMIT_DEBOUNCE_SECONDS: "300",
    // Unset so the Git author is git.js's own `${agent} (${model})` rather than the env override.
    GIT_AUTHOR_NAME: null,
    GIT_AUTHOR_EMAIL: null,
  });
  assert.equal(report.exitCode, 0, report.stderr);
  assert.deepEqual(
    report.pendingPathsAfterTrack,
    ["a.md", "b.md", "c.md", "dir", "dir/x.md"],
    "pendingPaths is a Set (deduped) and gitConfiguration() sorts it (git.js:131)",
  );
  assert.deepEqual(report.pendingAuthorsAfterTrack, [AUTHOR_A, { agent: "char-agent-b", model: "char-model-b" }], "one bucket per author, first-seen order (git.js:29,140)");
  assert.equal(report.pendingSinceIsIso, true, "pendingSince is the oldest start (git.js:149)");
  assert.equal(report.flushCommitted, true);
  assert.equal(report.flushCommits.length, 2, "one commit per author bucket");
  assert.equal(report.flushCommits[0].agent, AUTHOR_A.agent);
  assert.deepEqual(
    report.flushCommits[0].paths,
    ["b.md", "a.md", "dir/x.md", "dir"],
    "bucket order is Set insertion order, deduped (b.md tracked twice)",
  );
  assert.equal(report.flushCommits[1].agent, "char-agent-b");
  assert.deepEqual(report.flushCommits[1].paths, ["c.md"]);
  assert.deepEqual(report.pendingPathsAfterFlush, []);
  assert.deepEqual(report.commitOrderOldestFirst, ["char-agent-a (char-model-a)", "char-agent-b (char-model-b)"], "commits are emitted in bucket order");
  assert.deepEqual(report.porcelainAfter, []);
});
