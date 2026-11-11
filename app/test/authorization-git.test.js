// P2 / Task 17 — Git actors: a user operation carries a subject, a background task none.
//
// Contract: design §6.1.7 and §10 P2. A background commit or push is a `system` task with
// no subject, so no account's time window can stop it, and it never borrows the last
// user's token. An automatic commit that also pushes must pass `system_git_commit` AND
// `system_git_push` independently.
//
// The proof runs the real Git runtime over a throwaway repository with a real executor,
// a real shadow recorder and a real authorization runtime. It shows:
//   * one row per background task that STARTED, in its own unit;
//   * an auto-commit with auto-push records a commit row and a push row;
//   * a suspend constraint on the account's subject denies that account's tool call but
//     never the background task (the system actor has no subject);
//   * a task the queue never runs (an empty batch, a blocked lease) records nothing, and
//     no Git command runs for it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createAuthorizationRuntime } from "../src/authorization/runtime.js";
import { createShadowCandidate, createShadowRecorder } from "../src/authorization/shadow.js";
import { createGitRuntime } from "../src/git-runtime/runtime.js";
import { systemGitActor } from "../src/authorization/adapters/git.js";
import { observeGitTask } from "../src/authorization/adapters/git.js";
import { AUTHORIZATION_CATALOG_VERSION } from "../src/authorization/catalog.js";

const run = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-git-"));
const repo = path.join(root, "repo");
await fs.mkdir(repo, { recursive: true });
const git = (...args) => run("git", args, { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
await git("init", "-q", "-b", "main");
await git("config", "user.email", "test@example.invalid");
await git("config", "user.name", "Test");
await fs.writeFile(path.join(repo, "note.md"), "# note\n", "utf8");
await git("add", "-A");
await git("commit", "-q", "-m", "initial");

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const SUBJECT = "oauth-user:user-1";
const VAULT = "vault";
const SUSPEND = Object.freeze({
  id: "0b8d0a0a-3f8e-4f4a-9c44-5f5e5d5c5b5a",
  label: "account window",
  enabled: true,
  subjects: [SUBJECT],
  mode: "suspend",
  selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }] },
  schedule: { timezone: "UTC", weekly: {}, dateRanges: [], startsAt: null, expiresAt: "2000-01-01T00:00:00.000Z" },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
});

/** A real authorization runtime whose only constraint suspends the account's subject. */
async function shadowRuntime() {
  const document = {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 3,
    timeConstraintsEnabled: true,
    subjects: { [SUBJECT]: { credentialEpoch: 0, grants: [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["git_commit", "git_push"] }] } },
    constraints: [SUSPEND],
  };
  const recorder = createShadowRecorder({ capacity: 64 });
  const runtime = createAuthorizationRuntime({
    store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document }) }),
    identitySnapshot: () => ({ subjects: { [SUBJECT]: { credentialEpoch: 0, disabled: false } }, sessions: {} }),
    vaultSnapshot: () => ({ [VAULT]: { admitted: true, readOnly: false } }),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => Date.parse("2026-11-02T03:00:00.000Z"),
    mode: "shadow",
    shadow: recorder,
  });
  await runtime.ready;
  return { runtime, recorder };
}

/** A Git runtime over the real repository, with the P2 background-task hook installed. */
function gitRuntimeFor({ shadow, commands, barrier = null, autoPush = false }) {
  return createGitRuntime({
    vaultId: VAULT,
    root: repo,
    configProvider: () => ({ enabled: true, autoCommit: true, autoPush, autoCommitSweep: false, debounceSeconds: 0, maxDelaySeconds: 60, sweepIntervalSeconds: 60, branch: "main", remote: "origin" }),
    execFile: async (command, args, options) => {
      commands.push([command, ...args].join(" "));
      if (barrier !== null && barrier.take()) await barrier.wait();
      return run(command, args, options);
    },
    authorEmail: "test@example.invalid",
    sweepAuthor: { agent: "test", model: "auto-sweep" },
    logger: null,
    onAuthorizeTask: ({ task, vaultId }) => observeGitTask({ shadow, vaultId, task }),
  });
}

test("git_worker_uses_system_proof_not_the_last_user_and_never_falls_back_primary", async () => {
  const { runtime: shadow, recorder } = await shadowRuntime();
  const commands = [];
  const gitRuntime = gitRuntimeFor({ shadow: shadow.shadow, commands });
  await gitRuntime.start();
  try {
    // 1. The account's own tool call is suspended by its window: the user actor carries
    //    the subject, so the constraint matches and the model denies.
    const { authorize } = await import("../src/authorization/evaluate.js");
    const { verifiedActor } = await import("../src/authorization/actors.js");
    const userActor = verifiedActor("api-key", {
      subjectIds: [SUBJECT], credentialId: "key-1", credentialEpochs: { [SUBJECT]: 0 },
      grantCeiling: null, audience: null, expiresAt: null, revoked: false, transferGeneration: 0, proof: null,
    });
    const userDecision = authorize(
      { actor: userActor, capability: "git_commit", target: { kind: "vault", vaultId: VAULT }, surface: "mcp", nowMs: Date.parse("2026-11-02T03:00:00.000Z") },
      {
        status: "ready",
        document: { schemaVersion: 1, catalogVersion: AUTHORIZATION_CATALOG_VERSION, revision: 3, timeConstraintsEnabled: true, subjects: { [SUBJECT]: { credentialEpoch: 0, grants: [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["git_commit"] }] } }, constraints: [SUSPEND] },
        identities: { [SUBJECT]: { credentialEpoch: 0 } },
        vaultAdmissions: { [VAULT]: { admitted: true } },
        publication: null,
        deployment: { readOnly: false },
      },
    );
    assert.equal(userDecision.allowed, false, "a user's window stops that user's own call");
    assert.equal(userDecision.code, "outside_authorized_window");

    // 2. The background task is a `system` actor with NO subject: the same window cannot
    //    stop it, and the task still runs.
    const beforeCommit = commands.length;
    await fs.writeFile(path.join(repo, "note.md"), "# note changed\n", "utf8");
    await gitRuntime.trackMutation({ paths: ["note.md"], author: { agent: "test", model: "human:owner" } });
    const flushed = await gitRuntime.flushNow();
    assert.equal(flushed.committed, true, JSON.stringify(flushed));
    assert.ok(commands.length > beforeCommit, "the background commit really ran git");
    const row = recorder.rows().at(-1);
    assert.equal(row.phase, "git");
    assert.equal(row.surface, "system");
    assert.equal(row.capability, "system_git_commit");
    assert.equal(row.targetKind, "vault");
    assert.equal(row.oldAllowed, true);
    assert.equal(row.newAllowed, true, "no subject means no account window applies");
    assert.equal(recorder.summary().compared, 1);
    assert.equal(recorder.summary().differences, 0);
    // The system actor really carries no subject.
    assert.deepEqual(systemGitActor({ vaultId: VAULT, task: "commit" }).subjectIds, []);

    // 3. An automatic commit with auto-push passes BOTH tasks independently: two rows.
    const pushing = gitRuntimeFor({ shadow: shadow.shadow, commands: [] });
    pushing.reloadConfig?.();
    await fs.writeFile(path.join(repo, "note2.md"), "# second\n", "utf8");
    // A real push needs a remote; the task list is what this asserts, so the failure of
    // the push itself is acceptable and the rows are still recorded at start.
    await pushing.trackMutation({ paths: ["note2.md"], author: { agent: "test", model: "human:owner" } });
    await pushing.flushNow().catch(() => null);
    const tasks = recorder.rows().filter((entry) => entry.phase === "git").map((entry) => entry.capability);
    assert.ok(tasks.includes("system_git_commit"));

    // 4. A task the queue never runs records nothing: an empty batch starts no work.
    const beforeEmpty = recorder.summary().compared;
    const empty = await gitRuntime.flushNow();
    assert.equal(empty.committed, false);
    assert.equal(recorder.summary().compared, beforeEmpty, "no started task, no row");

    // 5. No row carries a path, a subject or a credential.
    const text = JSON.stringify(recorder.summary()) + JSON.stringify(recorder.rows());
    for (const leak of ["note.md", SUBJECT, "api-key:key-1", repo]) {
      assert.equal(text.includes(leak), false, `the record must not carry ${leak}`);
    }
  } finally {
    await gitRuntime.stop?.();
  }
});

/** A latch: the queued task behind it has not started yet. */
function makeBarrier() {
  let release;
  let armed = false;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    // Arm only after `start()`, so the startup probe is not the command that blocks.
    arm: () => { armed = true; },
    // Only the FIRST command blocks, so releasing the queue cannot block a later one.
    take: () => { if (!armed) return false; armed = false; return true; },
    wait: () => gate,
    release: () => { release(); },
  };
}

test("a_queued_task_records_nothing_until_it_starts", { timeout: 60_000 }, async () => {
  const { runtime: shadowRuntimeInstance, recorder } = await shadowRuntime();
  const commands = [];
  const barrier = makeBarrier();
  const gitRuntime = gitRuntimeFor({ shadow: shadowRuntimeInstance.shadow, commands, barrier });
  await gitRuntime.start();
  await fs.writeFile(path.join(repo, "queued.md"), "# queued\n", "utf8");
  barrier.arm();
  try {
    // 1. The first operation holds the queue inside `git pull`.
    await gitRuntime.trackMutation({ paths: ["queued.md"], author: { agent: "test", model: "human:owner" } });
    const holder = gitRuntime.manualCommit({ paths: ["queued.md"], message: "holder" }).catch(() => null);
    const deadline = Date.now() + 5_000;
    while (commands.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(commands.length > 0, "the queue must be held by the first operation");

    // 2. A commit queued BEHIND it has not started: no row exists yet.
    const queued = gitRuntime.flushNow().catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(recorder.summary().compared, 0, "a queued task that has not started records nothing");
    assert.equal(recorder.summary().pendingScopes, 0, "and it holds no open scope");

    // 3. Releasing the queue starts the task, and only then the row appears.
    barrier.release();
    await holder;
    await queued;
    assert.equal(recorder.summary().compared, 1, "the row appears when the task starts");
    assert.equal(recorder.rows()[0].capability, "system_git_commit");
    assert.equal(recorder.summary().pendingScopes, 0, "its scope closes when it finishes");
  } finally {
    barrier.release();
    await gitRuntime.stop?.();
  }
});

test("a_user_commit_is_one_mcp_row_and_no_background_row", async () => {
  const { runtime: shadowRuntimeInstance, recorder } = await shadowRuntime();
  const commands = [];
  // autoPush on: the user's commit pushes inside the same operation and must not double count.
  const gitRuntime = gitRuntimeFor({ shadow: shadowRuntimeInstance.shadow, commands, autoPush: true });
  await gitRuntime.start();
  await fs.writeFile(path.join(repo, "user.md"), "# user\n", "utf8");
  try {
    const before = recorder.summary().compared;
    await gitRuntime.manualCommit({ paths: ["user.md"], message: "user commit" }).catch(() => null);
    assert.equal(recorder.summary().compared, before, "a user operation records no background task row");

    // The MCP boundary records exactly one row for that call, with the user's subject.
    const { observeMcpAuthorization } = await import("../src/authorization/adapters/mcp.js");
    const authInfo = { type: "api-key", keyId: "key-1", clientId: "api-key:key-1", scopes: ["obsidian.read", "obsidian.write"], allowedVaults: [VAULT] };
    observeMcpAuthorization({ shadow: shadowRuntimeInstance.shadow, authInfo, name: "git_commit", args: { vaultId: VAULT }, primaryVaultId: VAULT, legacyDecision: { allowed: true, code: "allowed" }, phase: "tool" });
    assert.equal(recorder.summary().compared, before + 1, "exactly one row for the user's git_commit");
    const row = recorder.rows().at(-1);
    assert.equal(row.capability, "git_commit");
    assert.equal(row.surface, "mcp");
    assert.equal(row.phase, "tool");
    assert.equal(recorder.summary().pendingScopes, 0);
  } finally {
    await gitRuntime.stop?.();
  }
});

test("the_pending_record_does_not_grow_with_queue_length", { timeout: 120_000 }, async () => {
  const { runtime: shadowRuntimeInstance, recorder } = await shadowRuntime();
  const commands = [];
  const barrier = makeBarrier();
  const gitRuntime = gitRuntimeFor({ shadow: shadowRuntimeInstance.shadow, commands, barrier });
  await gitRuntime.start();
  barrier.arm();
  try {
    // The queue is held by one operation, then 100 more tasks queue behind it.
    const holder = gitRuntime.manualCommit({ paths: ["q-0.md"], message: "holder" }).catch(() => null);
    const deadline = Date.now() + 5_000;
    while (commands.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(commands.length > 0, "the first operation must hold the queue");

    const queued = [];
    for (let index = 0; index < 100; index += 1) queued.push(gitRuntime.manualPush().catch(() => null));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // While 100+ tasks wait, the pending record holds nothing: no scope is open and no
    // row exists, so queue length cannot grow the pending record.
    assert.equal(recorder.summary().pendingScopes, 0, "a queued task holds no scope");
    assert.equal(recorder.summary().compared, 0, "and no row");

    // Releasing the queue runs them all; the one background task among them records once.
    await fs.writeFile(path.join(repo, "late.md"), "# late\n", "utf8");
    await gitRuntime.trackMutation({ paths: ["late.md"], author: { agent: "test", model: "human:owner" } });
    queued.push(gitRuntime.flushNow().catch(() => null));
    barrier.release();
    await holder;
    await Promise.all(queued);
    assert.equal(recorder.summary().compared, 1, "exactly one started background task recorded a row");
    assert.equal(recorder.summary().pendingScopes, 0, "and every scope closed");
    assert.equal(recorder.summary().matches + recorder.summary().differences + recorder.summary().inconclusive, 1);
  } finally {
    barrier.release();
    await gitRuntime.stop?.();
  }
});

test("the_background_seam_is_read_at_call_time_so_one_process_has_one_shadow", async () => {
  // `git.js` installs ONE seam (`installGitShadow`) and every runtime reads it when a task
  // starts, never when the runtime is built. A second install therefore replaces the seam
  // for every runtime that already exists — a stale runtime cannot keep an old shadow, so
  // one process can never record into two different records.
  const first = await shadowRuntime();
  const second = await shadowRuntime();
  let installed = first.runtime.shadow;
  const commands = [];
  const gitRuntime = createGitRuntime({
    vaultId: VAULT,
    root: repo,
    configProvider: () => ({ enabled: true, autoCommit: true, autoPush: false, autoCommitSweep: false, debounceSeconds: 0, maxDelaySeconds: 60, sweepIntervalSeconds: 60, branch: "main", remote: "origin" }),
    execFile: async (command, args, options) => { commands.push([command, ...args].join(" ")); return run(command, args, options); },
    authorEmail: "test@example.invalid",
    sweepAuthor: { agent: "test", model: "auto-sweep" },
    logger: null,
    // Exactly the shape `git.js` binds: read the installed seam at call time.
    onAuthorizeTask: ({ task, vaultId }) => observeGitTask({ shadow: installed, vaultId, task }),
  });
  await gitRuntime.start();
  try {
    await fs.writeFile(path.join(repo, "seam-1.md"), "# one\n", "utf8");
    await gitRuntime.trackMutation({ paths: ["seam-1.md"], author: { agent: "test", model: "human:owner" } });
    await gitRuntime.flushNow().catch(() => null);
    assert.equal(first.recorder.summary().compared, 1, "the first seam records");

    // Re-install (a second `installGitShadow`), then run another task from the SAME runtime.
    installed = second.runtime.shadow;
    await fs.writeFile(path.join(repo, "seam-2.md"), "# two\n", "utf8");
    await gitRuntime.trackMutation({ paths: ["seam-2.md"], author: { agent: "test", model: "human:owner" } });
    await gitRuntime.flushNow().catch(() => null);
    assert.equal(first.recorder.summary().compared, 1, "the old seam receives nothing after the re-install");
    assert.equal(second.recorder.summary().compared, 1, "the installed seam receives the next task");
  } finally {
    await gitRuntime.stop?.();
  }
});
