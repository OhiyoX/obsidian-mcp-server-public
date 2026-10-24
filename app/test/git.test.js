import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";

const execFileAsync = promisify(execFile);
const vault = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-git-"));
process.env.VAULT_PATH = vault;
process.env.GIT_ENABLED = "true";
process.env.GIT_AUTO_COMMIT = "true";
// The debounce stays far above every write gap in these cases, yet small enough that the recovered
// batch's fallback retry (after a persistent failure) can still be observed in a bounded test.
process.env.GIT_COMMIT_DEBOUNCE_SECONDS = "5";
process.env.GIT_COMMIT_MAX_DELAY_SECONDS = "1";

const { commitGit, flushAutoCommit, getGitDiff, getGitLog, getGitStatus, gitConfiguration, trackGitMutation } = await import("../src/git.js");
const { withRequestContext } = await import("../src/request-context.js");
const { readNote, writeNoteFile } = await import("../src/obsidian.js");
after(() => fs.rm(vault, { recursive: true, force: true }));

async function git(...args) {
  return execFileAsync("git", ["-C", vault, ...args], { encoding: "utf-8" });
}

test("Git integration commits explicit MCP paths without including unrelated changes", async (t) => {
  await git("init");
  await fs.writeFile(path.join(vault, "tracked.md"), "initial\n");
  await git("add", "tracked.md");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");

  await fs.writeFile(path.join(vault, "tracked.md"), "changed by MCP\n");
  await fs.writeFile(path.join(vault, "external.md"), "unrelated\n");
  await fs.writeFile(path.join(vault, "中文笔记.md"), "readable path\n");
  await git("add", "external.md");
  const committed = await withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, async () => {
    trackGitMutation("tracked.md");
    return commitGit({ message: "test MCP commit", paths: ["tracked.md"] });
  });
  assert.equal(committed.committed, true);

  const status = await getGitStatus();
  assert.equal(status.clean, false);
  assert.ok(status.changes.some((change) => change.path === "external.md" && change.index === "A"));
  assert.ok(status.changes.some((change) => change.path === "中文笔记.md"));
  assert.ok(!status.changes.some((change) => change.path === "tracked.md"));
  assert.equal((await getGitLog(1))[0].subject, "test MCP commit");
  assert.equal(committed.author.agent, "test-agent");
  assert.equal(committed.author.model, "test-model");
  const commitBody = (await git("show", "-s", "--format=%B")).stdout;
  assert.match(commitBody, /MCP-Agent: test-agent/);
  assert.match(commitBody, /MCP-Model: test-model/);
  assert.match((await getGitDiff({ path: "external.md" })).diff, /^$/);
});

test("Git integration rejects path traversal", async () => {
  await assert.rejects(() => withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, () => commitGit({ message: "bad", paths: ["../outside.md"] })), /inside the vault|traversal/);
});

test("Git integration clears pending child paths after committing their parent folder", async () => {
  await fs.mkdir(path.join(vault, "managed"), { recursive: true });
  await fs.writeFile(path.join(vault, "managed", "decision.md"), "managed decision\n");
  const committed = await withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, async () => {
    trackGitMutation("managed/decision.md");
    return commitGit({ message: "commit managed folder", paths: ["managed"] });
  });
  assert.equal(committed.committed, true);

  const status = await getGitStatus();
  assert.deepEqual(status.pendingAutoCommitPaths, []);
});

test("MCP author is required and stamped into new notes", async () => {
  const notePath = path.join(vault, "authored.md");
  await assert.rejects(() => writeNoteFile(notePath, {}, "without author\n"), /MCP writes require/);
  await withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, () => writeNoteFile(notePath, {}, "with author\n"));
  const note = await readNote(notePath);
  assert.deepEqual(note.frontmatter.mcp_author, { agent: "test-agent", model: "test-model" });
});

test("Git auto-commit honors the max-delay deadline when writes never leave a debounce gap", async () => {
  // Clear any pending batch from earlier cases so this case owns the pending state.
  await flushAutoCommit();
  await git("init");
  const notePath = path.join(vault, "continuous.md");
  await fs.writeFile(notePath, "seed\n");
  await git("add", "continuous.md");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed continuous");

  const startedAt = Date.now();
  let pendingSinceAtFirstTrack = null;
  let deadlineFiredWhileWritesContinued = false;
  await withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, async () => {
    for (let i = 0; i < 16; i += 1) {
      // A fixed deadline clears the pending batch while writes are still arriving; a per-write reset
      // would keep it pending until maxDelay after the last write, so it never clears mid-loop.
      if (i > 0 && gitConfiguration().pendingPaths.length === 0) deadlineFiredWhileWritesContinued = true;
      await fs.writeFile(notePath, `write ${i}\n`);
      trackGitMutation("continuous.md");
      if (i === 0) pendingSinceAtFirstTrack = gitConfiguration().pendingSince;
      // Gaps stay far below the configured debounce, so only the hard deadline can commit the batch.
      if (i < 15) await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });
  const writesEndedAt = Date.now();

  assert.equal(gitConfiguration().maxDelaySeconds, 1);
  assert.equal(typeof pendingSinceAtFirstTrack, "string");
  assert.ok(!Number.isNaN(Date.parse(pendingSinceAtFirstTrack)), "pendingSince should be an ISO timestamp after the first track");
  assert.ok(deadlineFiredWhileWritesContinued, "the deadline must not be deferred by later writes");

  const pollDeadline = Date.now() + 6000;
  let status = await getGitStatus();
  while (
    Date.now() < pollDeadline
    && (status.pendingAutoCommitPaths.length > 0 || status.changes.some((change) => change.path === "continuous.md"))
  ) {
    // pendingPaths clears when the flush starts; keep polling until the queued commit lands.
    await new Promise((resolve) => setTimeout(resolve, 150));
    status = await getGitStatus();
  }
  const waitedMs = Date.now() - startedAt;
  assert.deepEqual(status.pendingAutoCommitPaths, [], `deadline flush did not happen within ${waitedMs}ms`);
  assert.equal(status.configuration.maxDelaySeconds, 1);
  assert.equal(status.configuration.pendingSince, null);
  assert.ok(!status.changes.some((change) => change.path === "continuous.md"), "continuous.md should be committed, not left dirty");
  assert.ok(waitedMs < writesEndedAt - startedAt + 6000, `deadline flush took ${waitedMs}ms`);
  const pathLog = (await git("log", "--format=%s", "--", "continuous.md")).stdout.trim().split("\n");
  assert.equal(pathLog[0], "chore(obsidian): save MCP changes");
});

test("Git auto-commit flush keeps a same-path batch tracked while the old commit is in flight", async () => {
  // Own the pending state: the previous case may still hold a pending batch.
  await flushAutoCommit();
  await git("init");
  const notePath = path.join(vault, "race.md");
  await fs.writeFile(notePath, "seed\n");
  await git("add", "race.md");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed race");

  await withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, async () => {
    await fs.writeFile(notePath, "in-flight revision\n");
    trackGitMutation("race.md");

    // flushAutoCommit() detaches the pending batch synchronously and only then enqueues the commit,
    // so this synchronous re-track is a deterministic barrier: it lands after the detach and before
    // the queued commit can touch the index. The later batch owns this pending entry and its timers.
    const flushing = flushAutoCommit();
    trackGitMutation("race.md");

    await flushing;

    // The in-flight commit takes the working-tree content of its paths (git commit --only), so it
    // consumes the first revision; the re-tracked batch must still be pending afterwards.
    assert.equal((await git("show", "HEAD:race.md")).stdout, "in-flight revision\n");
    const pending = gitConfiguration();
    assert.deepEqual(pending.pendingPaths, ["race.md"], "the in-flight commit consumed the later same-path batch");
    assert.equal(typeof pending.pendingSince, "string");
    assert.ok(!Number.isNaN(Date.parse(pending.pendingSince)), "pendingSince must survive for the later batch");

    // A later write is now dirty and must be picked up by the surviving batch.
    await fs.writeFile(notePath, "later revision\n");
    const midStatus = await getGitStatus();
    assert.ok(midStatus.changes.some((change) => change.path === "race.md"), "the later revision must still be dirty");

    await flushAutoCommit();
  });

  // The explicit follow-up flush and the second batch's own 1s hard deadline can both land the later
  // revision; whichever runs second may observe an already-empty pending set while the first commit
  // is still in flight, so an immediate check races that commit. Poll a read-only criterion (never
  // `git status`, which would contend with the flush's `git add` for index.lock) until the revision
  // lands, then assert the terminal state.
  const commitDeadline = Date.now() + 6000;
  let headContent = (await git("show", "HEAD:race.md")).stdout;
  while (Date.now() < commitDeadline && headContent !== "later revision\n") {
    await new Promise((resolve) => setTimeout(resolve, 150));
    headContent = (await git("show", "HEAD:race.md")).stdout;
  }
  assert.equal(headContent, "later revision\n", "later revision should be committed by the follow-up flush or the batch deadline");
  assert.deepEqual(gitConfiguration().pendingPaths, []);
  const finalStatus = await getGitStatus();
  assert.ok(!finalStatus.changes.some((change) => change.path === "race.md"), "later revision should be committed, not left dirty");
  assert.deepEqual(finalStatus.pendingAutoCommitPaths, []);
  const pathLog = (await git("log", "--format=%s", "--", "race.md")).stdout.trim().split("\n");
  assert.equal(pathLog[0], "chore(obsidian): save MCP changes");
  assert.equal(pathLog.filter((subject) => subject === "chore(obsidian): save MCP changes").length, 2);
});

test("Git manual commit keeps a same-path mutation tracked while the commit is in flight", async () => {
  await flushAutoCommit();
  await git("init");
  const notePath = path.join(vault, "manual-race.md");
  await fs.writeFile(notePath, "seed\n");
  await git("add", "manual-race.md");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed manual race");

  await withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, async () => {
    await fs.writeFile(notePath, "first revision\n");
    trackGitMutation("manual-race.md");
    const committing = commitGit({ message: "manual race", paths: ["manual-race.md"] });

    // The manual commit detaches the batch it owns before touching the index. Waiting for that
    // observable transition keeps the same-path track below strictly inside the commit window.
    const detachDeadline = Date.now() + 5000;
    while (gitConfiguration().pendingPaths.length > 0) {
      assert.ok(Date.now() < detachDeadline, "manual commit never detached its pending batch");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await fs.writeFile(notePath, "second revision\n");
    trackGitMutation("manual-race.md");

    await committing;

    const pending = gitConfiguration();
    assert.deepEqual(pending.pendingPaths, ["manual-race.md"], "the manual commit consumed the later same-path mutation");
    assert.equal(typeof pending.pendingSince, "string");
    assert.ok(!Number.isNaN(Date.parse(pending.pendingSince)), "pendingSince must survive for the later mutation");

    await flushAutoCommit();
  });

  const finalStatus = await getGitStatus();
  assert.ok(!finalStatus.changes.some((change) => change.path === "manual-race.md"));
  assert.deepEqual(finalStatus.pendingAutoCommitPaths, []);
  assert.equal((await git("show", "HEAD:manual-race.md")).stdout, "second revision\n");
});

test("Git manual commit failure re-arms the automatic flush for the recovered batch", async () => {
  // Own the pending state so no earlier case can consume the hook's first invocation.
  await flushAutoCommit();
  await git("init");
  const notePath = path.join(vault, "recover.md");
  await fs.writeFile(notePath, "seed\n");
  await git("add", "recover.md");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed recover");

  // Real Git barrier: the first pre-commit call blocks until the marker appears, then fails, so the
  // manual commit is guaranteed to still be in flight when the old max-delay timer fires. Later calls
  // pass, so only the recovery flush can produce the final commit.
  const hookDir = path.join(vault, ".git", "hooks");
  await fs.mkdir(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, "pre-commit");
  const countPath = path.join(vault, "hook-count");
  const releasePath = path.join(vault, "hook-release");
  await fs.writeFile(hookPath, [
    "#!/bin/sh",
    "count=0",
    "[ -f hook-count ] && count=$(cat hook-count)",
    "count=$((count + 1))",
    'printf "%s" "$count" > hook-count',
    'if [ "$count" -eq 1 ]; then',
    "  i=0",
    '  while [ ! -f hook-release ] && [ "$i" -lt 1000 ]; do',
    "    sleep 0.05",
    "    i=$((i + 1))",
    "  done",
    '  echo "pre-commit barrier: first invocation fails" >&2',
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  await fs.chmod(hookPath, 0o755);

  try {
    await withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, async () => {
      await fs.writeFile(notePath, "recovered revision\n");
      // Pending batch with the debounce/max-delay timers armed (debounce 5s, max-delay 1s).
      trackGitMutation("recover.md");
      const committing = commitGit({ message: "manual commit that fails", paths: ["recover.md"] });
      committing.catch(() => {});

      const startDeadline = Date.now() + 5000;
      for (;;) {
        try {
          await fs.access(countPath);
          break;
        } catch {
          assert.ok(Date.now() < startDeadline, "the manual commit never reached the pre-commit hook");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      // The manual commit has detached its batch, so an empty pending set plus a null pendingSince is
      // only reachable once the old max-delay timer has fired and drained into a no-op flush.
      const firedDeadline = Date.now() + 5000;
      while (gitConfiguration().pendingPaths.length > 0 || gitConfiguration().pendingSince !== null) {
        assert.ok(Date.now() < firedDeadline, "the old max-delay timer never fired while the commit was blocked");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal((await fs.readFile(countPath, "utf-8")), "1");

      await fs.writeFile(releasePath, "go\n");
      await assert.rejects(() => committing, /pre-commit barrier|failed/);
    });

    // Recovery must restore data *and* scheduling.
    const recovered = gitConfiguration();
    assert.deepEqual(recovered.pendingPaths, ["recover.md"], "the failed commit did not restore its pending batch");
    assert.equal(typeof recovered.pendingSince, "string");
    assert.ok(!Number.isNaN(Date.parse(recovered.pendingSince)), "pendingSince must be the original timestamp");
    const recoveredStatus = await getGitStatus();
    assert.ok(recoveredStatus.changes.some((change) => change.path === "recover.md"), "recover.md must still be dirty");

    // No further trackGitMutation(): the recovered scheduling alone has to land the commit. Poll via
    // `git show` (read-only, never touches the index lock) so the poll cannot race the flush's git add.
    const flushDeadline = Date.now() + 6000;
    let headContent = (await git("show", "HEAD:recover.md")).stdout;
    while (Date.now() < flushDeadline && headContent !== "recovered revision\n") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      headContent = (await git("show", "HEAD:recover.md")).stdout;
    }
    assert.deepEqual(gitConfiguration().pendingPaths, [], "recovery did not schedule a future automatic flush");
    assert.equal(headContent, "recovered revision\n", "the recovered batch was never auto-committed");
    const finalStatus = await getGitStatus();
    assert.deepEqual(finalStatus.pendingAutoCommitPaths, []);
    assert.ok(!finalStatus.changes.some((change) => change.path === "recover.md"), "recover.md was left dirty after recovery");
    assert.equal((await fs.readFile(countPath, "utf-8")), "2", "the recovery flush must go through the real hook again");
    const pathLog = (await git("log", "--format=%s", "--", "recover.md")).stdout.trim().split("\n");
    assert.equal(pathLog[0], "chore(obsidian): save MCP changes");
  } finally {
    await fs.rm(hookPath, { force: true });
  }
});

test("Git persistent commit failure retries on a bounded cadence and self-heals without a new write", async () => {
  // Own the pending state so a leftover batch from an earlier case cannot absorb the retries.
  await flushAutoCommit();
  await git("init");
  const notePath = path.join(vault, "storm.md");
  await fs.writeFile(notePath, "seed\n");
  await git("add", "storm.md");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed storm");

  // Real Git barrier that never passes: every commit attempt is rejected and counted. If the expired
  // deadline were re-armed at the 25ms floor on every recovery this would spin at ~40 calls/second.
  const hookDir = path.join(vault, ".git", "hooks");
  await fs.mkdir(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, "pre-commit");
  const countPath = path.join(vault, "storm-count");
  await fs.writeFile(hookPath, [
    "#!/bin/sh",
    "count=0",
    "[ -f storm-count ] && count=$(cat storm-count)",
    "count=$((count + 1))",
    'printf "%s" "$count" > storm-count',
    'echo "persistent pre-commit rejection" >&2',
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  await fs.chmod(hookPath, 0o755);

  try {
    await withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, async () => {
      await fs.writeFile(notePath, "revision that keeps failing\n");
      trackGitMutation("storm.md");
    });

    // Bounded observation window: the max-delay deadline fails once (~1s) and the batch's single
    // imminent retry fails once at the floor; anything beyond that must wait for the debounce
    // cadence, never the floor. The window ends well before the first debounce retry (~6s).
    const windowEnd = Date.now() + 3500;
    while (Date.now() < windowEnd) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const callsWhileFailing = Number((await fs.readFile(countPath, "utf-8")).trim());
    assert.ok(
      callsWhileFailing <= 2,
      `a persistently failing commit retried ${callsWhileFailing} times in 3.5s; the imminent retry must be one-shot and the rest debounce-bounded`,
    );
    assert.deepEqual(gitConfiguration().pendingPaths, ["storm.md"], "the failing batch must not be dropped");
    assert.equal(typeof gitConfiguration().pendingSince, "string");

    // Drop the failure source and never track again: the surviving future trigger (the debounce
    // cadence re-armed by recovery) is the only thing that can land this commit.
    await fs.rm(hookPath, { force: true });
    const healDeadline = Date.now() + 10000;
    let headContent = (await git("show", "HEAD:storm.md")).stdout;
    while (Date.now() < healDeadline && headContent !== "revision that keeps failing\n") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      headContent = (await git("show", "HEAD:storm.md")).stdout;
    }
    assert.equal(headContent, "revision that keeps failing\n", "the recovered batch was never retried after the failure source was removed");
    assert.deepEqual(gitConfiguration().pendingPaths, []);
    const finalStatus = await getGitStatus();
    assert.ok(!finalStatus.changes.some((change) => change.path === "storm.md"), "storm.md was left dirty after recovery");
    const pathLog = (await git("log", "--format=%s", "--", "storm.md")).stdout.trim().split("\n");
    assert.equal(pathLog[0], "chore(obsidian): save MCP changes");
  } finally {
    await fs.rm(hookPath, { force: true });
  }
});

test("Git commit failure restoring an older batch keeps the oldest hard deadline and flushes imminently", async () => {
  // Own the pending state so an earlier case cannot consume the hook's first invocation.
  await flushAutoCommit();
  await git("init");
  const aPath = path.join(vault, "restore-a.md");
  const bPath = path.join(vault, "restore-b.md");
  await fs.writeFile(aPath, "seed a\n");
  await git("add", "restore-a.md");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed restore-a");

  // Real Git barrier: the first pre-commit call blocks until released, then fails; later calls pass.
  const hookDir = path.join(vault, ".git", "hooks");
  await fs.mkdir(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, "pre-commit");
  const countPath = path.join(vault, "restore-hook-count");
  const releasePath = path.join(vault, "restore-hook-release");
  await fs.writeFile(hookPath, [
    "#!/bin/sh",
    "count=0",
    "[ -f restore-hook-count ] && count=$(cat restore-hook-count)",
    "count=$((count + 1))",
    'printf "%s" "$count" > restore-hook-count',
    'if [ "$count" -eq 1 ]; then',
    "  i=0",
    '  while [ ! -f restore-hook-release ] && [ "$i" -lt 1000 ]; do',
    "    sleep 0.05",
    "    i=$((i + 1))",
    "  done",
    '  echo "pre-commit barrier: first invocation fails" >&2',
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  await fs.chmod(hookPath, 0o755);

  let oldPendingSince = null;
  let newPendingSince = null;
  let bDeadlineAt = null;
  let restoreAt = null;
  try {
    await withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, async () => {
      // 1) Batch A at t0, with its own max-delay deadline armed.
      await fs.writeFile(aPath, "A revision\n");
      trackGitMutation("restore-a.md");
      oldPendingSince = gitConfiguration().pendingSince;
      assert.equal(typeof oldPendingSince, "string");

      // 2) Manual commit detaches A and blocks inside the pre-commit hook.
      const committing = commitGit({ message: "manual blocked commit", paths: ["restore-a.md"] });
      committing.catch(() => {});
      const startedDeadline = Date.now() + 5000;
      for (;;) {
        try {
          await fs.access(countPath);
          break;
        } catch {
          assert.ok(Date.now() < startedDeadline, "the manual commit never reached the pre-commit hook");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      // 3) A's original max-delay deadline fires as a no-op flush while the commit is still blocked.
      const noopDeadline = Date.now() + 5000;
      while (gitConfiguration().pendingSince !== null) {
        assert.ok(Date.now() < noopDeadline, "A's original max-delay timer never fired while the commit was blocked");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // 4) A real new write B while the commit is still blocked: newer start, later deadline.
      await fs.writeFile(bPath, "B revision\n");
      trackGitMutation("restore-b.md");
      newPendingSince = gitConfiguration().pendingSince;
      assert.equal(typeof newPendingSince, "string");
      assert.ok(Date.parse(newPendingSince) > Date.parse(oldPendingSince), "B must get a newer start than A");
      bDeadlineAt = Date.parse(newPendingSince) + gitConfiguration().maxDelaySeconds * 1000;

      // 5) Release the hook: the manual commit fails and restores A.
      await fs.writeFile(releasePath, "go\n");
      await assert.rejects(() => committing, /pre-commit barrier|failed/);
      restoreAt = Date.now();

      // 6) A and B are both pending again.
      assert.deepEqual(gitConfiguration().pendingPaths, ["restore-a.md", "restore-b.md"]);
      // 7) The global start is the OLDEST one (A), so A's already-expired hard deadline is not
      //    dragged out to B's later one.
      assert.equal(gitConfiguration().pendingSince, oldPendingSince, "restoring A must pull pendingSince back to its older start");
    });

    // 8) No further trackGitMutation(): the expired oldest deadline gets its one imminent flush, so
    //    A+B land before B's later max-delay would have fired (not after a full fresh max-delay).
    const settleDeadline = Date.now() + 6000;
    const headOf = async (file) => (await git("show", `HEAD:${file}`).catch(() => ({ stdout: "" }))).stdout;
    let aContent = await headOf("restore-a.md");
    let bContent = await headOf("restore-b.md");
    while (Date.now() < settleDeadline && (aContent !== "A revision\n" || bContent !== "B revision\n")) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      aContent = await headOf("restore-a.md");
      bContent = await headOf("restore-b.md");
    }
    const settledAt = Date.now();
    assert.equal(aContent, "A revision\n", "the restored older batch was never auto-committed");
    assert.equal(bContent, "B revision\n", "the later batch was never auto-committed");
    assert.ok(
      settledAt < bDeadlineAt,
      `A's expired deadline must flush imminently, not wait for B's later max-delay (settled ${settledAt - restoreAt}ms after restore, B's deadline was ${bDeadlineAt - restoreAt}ms after restore)`,
    );
    assert.deepEqual(gitConfiguration().pendingPaths, []);
    const finalStatus = await getGitStatus();
    assert.deepEqual(finalStatus.pendingAutoCommitPaths, []);
    assert.ok(!finalStatus.changes.some((change) => change.path === "restore-a.md" || change.path === "restore-b.md"));
    assert.equal((await fs.readFile(countPath, "utf-8")), "2", "the manual failure and the imminent flush are the only two hook calls");
  } finally {
    await fs.rm(hookPath, { force: true });
  }
});
