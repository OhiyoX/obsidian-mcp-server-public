// Issue #734 — a mutation item whose basename begins with `.` at the Vault ROOT used to be rejected as
// "Path traversal denied" by the journal's containment guard, because the batch temp name is built as
// `"." + basename` (`..gitignore….tmp`) and the guard tested `relative.startsWith("..")`.
//
// What must be true afterwards, asserted from the outside (files on disk, Trash contents, journal dirs):
//   1. a root-level dotfile can be created, updated and deleted like any other file, with the same
//      durable Trash backup `delete_note`/`delete_file` promise;
//   2. the rejected-guard false positive never leaves a journal behind, so one attempt cannot poison
//      every later mutation;
//   3. a *real* escape is still refused (the guard must not be loosened into uselessness);
//   4. a file literally named `..weird` (its own name starts with two dots) is ordinary content.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-dotfile-734-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const { createNotePlan, createDeletePlan, createDeleteFilePlan, applyNotePlan } = await import("../src/mutation-plans.js");
const { fileRevision } = await import("../src/vault.js");
const { withRequestContext } = await import("../src/request-context.js");
const authored = (callback) => withRequestContext({ author: { agent: "dotfile-734", model: "test" } }, callback);

const journalEntries = () => fs.readdir(path.join(data, "mutation-journal")).catch(() => []);
const exists = (p) => fs.access(p).then(() => true, () => false);
const sha256ish = (await import("node:crypto")).createHash;

// A refusal must be clean: no journal directory may survive it.
async function assertNoJournalLeft(context) {
  assert.deepEqual(await journalEntries(), [], `${context}: refused/aborted batch left a journal behind`);
}

test("#734: a root-level dotfile is created through the journal", async () => {
  const plan = await authored(() =>
    createNotePlan([{ path: ".gitignore", operation: "raw", raw: "node_modules\n", opaque: true, mustNotExist: true }]),
  );
  const applied = await authored(() => applyNotePlan(plan.planId, plan.planHash, "dotfile-create-0001"));
  assert.deepEqual(applied.changed.map((c) => c.path), [".gitignore"]);
  assert.equal(await fs.readFile(path.join(vault, ".gitignore"), "utf-8"), "node_modules\n");
  assert.deepEqual(await journalEntries(), []);
});

test("#734: a root-level dotfile is updated through the journal", async () => {
  const baseRevision = await fileRevision(path.join(vault, ".gitignore"));
  const plan = await authored(() =>
    createNotePlan([{ path: ".gitignore", operation: "raw", raw: "node_modules\ndist\n", opaque: true, baseRevision }]),
  );
  await authored(() => applyNotePlan(plan.planId, plan.planHash, "dotfile-update-0001"));
  assert.equal(await fs.readFile(path.join(vault, ".gitignore"), "utf-8"), "node_modules\ndist\n");
  assert.deepEqual(await journalEntries(), []);
});

test("#734: deleting a root-level dotfile keeps a byte-identical Trash backup", async () => {
  const plan = await authored(() => createDeleteFilePlan({ path: ".gitignore" }));
  const applied = await authored(() => applyNotePlan(plan.planId, plan.planHash, "dotfile-delete-0001"));
  assert.equal(await exists(path.join(vault, ".gitignore")), false);
  const backup = applied.changed[0].backup;
  assert.equal(typeof backup, "string");
  const trashed = path.join(data, "trash", ...backup.split("/"));
  const expected = sha256ish("sha256").update("node_modules\ndist\n").digest("hex");
  const actual = sha256ish("sha256").update(await fs.readFile(trashed)).digest("hex");
  assert.equal(actual, expected, "Trash backup must be byte-identical to the deleted dotfile");
  assert.deepEqual(await journalEntries(), []);
});

// Follow-up (issue #735, NOT fixed here): a file literally named `..weird.md` is still unreachable, because
// `assertInsideVault` in `vault-runtime/local-fs.js` carries the same `startsWith("..")` false positive.
// That path cannot be created through MCP today, so it carries no data-loss risk — kept out of this fix
// so the journal change stays one knife.

// A poisoned install (journal written by the old naming, `.gitignore` already gone) must heal on
// upgrade: recovery has to accept the legacy `..name…tmp` temp and finish the Trash backup instead of
// aborting again with "Invalid journal temp" / "Path traversal denied". The journal is planted in the
// same data root the module bound at import (config resolves once per process).
test("#734: a journal written before the fix is still recovered on upgrade", async () => {
  const { recoverPendingBatches } = await import("../src/batch-journal.js");
  const bytes = "node_modules\n";
  const before = sha256ish("sha256").update(bytes).digest("hex");
  const stamp = "2026-10-31T03-57-42-822Z";
  const trashRel = `${stamp}-979cbd89-fe49-4d32-81b9-d7a592d0f3e5/.gitignore`;
  const journalDir = path.join(data, "mutation-journal", "11111111-2222-3333-4444-555555555555");
  await fs.mkdir(journalDir, { recursive: true });
  await fs.writeFile(path.join(journalDir, "backup-0"), bytes);
  const manifest = {
    schema: 2,
    vaultId: null,
    state: "committed",
    idempotency: {
      digest: "626612b5be0418c2292701bae66518c56a7a41f3395dccc4561b639d29ee4fad",
      vaultId: null,
      planId: "117dfed4-d61c-4abc-90f6-78ce3afe0fbb",
      planHash: `sha256:${before}`,
      author: { agent: "dotfile-734", model: "test", authClientId: null, authUserId: null },
      unchanged: [],
      appliedAt: "2026-10-31T03:57:42.819Z",
      expiresAtMs: Date.now() + 86400000,
    },
    entries: [{
      path: ".gitignore",
      existed: true,
      delete: true,
      trash: trashRel,
      consumeTrash: null,
      before: `sha256:${before}`,
      after: null,
      backup: "backup-0",
      // The old writer prefixed a dot: `.gitignore` became `..gitignore…`, which the old guard read as
      // a parent-directory escape. This exact shape is what real poisoned installs contain.
      temp: "..gitignore.obsidian-mcp-batch-204f79d1-ecb0-44c7-90e7-b52da803d58c.tmp",
      history: false,
      historyName: null,
    }],
    result: {
      planId: "117dfed4-d61c-4abc-90f6-78ce3afe0fbb",
      planHash: `sha256:${before}`,
      applied: true,
      idempotentReplay: false,
      changed: [{ path: ".gitignore", deleted: true, created: false, size: 0, revision: null, previousSizeInBytes: bytes.length, backup: trashRel }],
      unchanged: [],
      appliedAt: "2026-10-31T03:57:42.819Z",
    },
  };
  await fs.writeFile(path.join(journalDir, "manifest.json"), JSON.stringify(manifest));

  await recoverPendingBatches();

  const trashed = path.join(data, "trash", ...trashRel.split("/"));
  assert.equal(await fs.readFile(trashed, "utf-8"), bytes, "recovery must materialise the promised Trash backup");
  assert.deepEqual(await journalEntries(), []);
});

// The reviewer's blocker (scratch/review-735/REVIEW.md, B1): an interrupted batch can leave the legacy
// `..name….tmp` staging file ON DISK with the journal in `prepared`/`committing`. Fixing only the
// journal's own guard is not enough for that shape — `finishBatchJournal` also passes the staging path
// through `assertCanonicalInsideRoot`, which carried the same `startsWith("..")` false positive and made
// `server.js` exit before it ever listened. This plant is the exact shape that was measured there.
test("#734: an interrupted batch whose legacy staging file still exists recovers and starts serving", async () => {
  const { recoverPendingBatches } = await import("../src/batch-journal.js");
  const bytes = "half-written\n";
  const original = "original\n";
  const before = sha256ish("sha256").update(original).digest("hex");
  const stamp = "2026-10-31T04-00-00-000Z";
  const trashRel = `${stamp}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/.b.md`;
  const tempName = "..b.md.obsidian-mcp-batch-5118aaa3-1111-2222-3333-444455556666.tmp";
  const journalDir = path.join(data, "mutation-journal", "99999999-8888-7777-6666-555555555555");
  await fs.mkdir(journalDir, { recursive: true });
  await fs.writeFile(path.join(journalDir, "backup-0"), original);
  // The staging file survives in the Vault exactly where the old writer left it.
  await fs.writeFile(path.join(vault, tempName), bytes);
  await fs.writeFile(path.join(vault, ".b.md"), bytes);
  const manifest = {
    schema: 2,
    vaultId: null,
    state: "committing",
    idempotency: {
      digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      vaultId: null,
      planId: "00000000-0000-0000-0000-000000000001",
      planHash: `sha256:${before}`,
      author: { agent: "dotfile-734", model: "test", authClientId: null, authUserId: null },
      unchanged: [],
      appliedAt: "2026-10-31T04:00:00.000Z",
      expiresAtMs: Date.now() + 86400000,
    },
    entries: [{
      path: ".b.md",
      existed: true,
      delete: false,
      trash: null,
      consumeTrash: null,
      before: `sha256:${before}`,
      after: `sha256:${sha256ish("sha256").update(bytes).digest("hex")}`,
      backup: "backup-0",
      temp: tempName,
      history: false,
      historyName: null,
    }],
  };
  await fs.writeFile(path.join(journalDir, "manifest.json"), JSON.stringify(manifest));

  await recoverPendingBatches();

  // Recovery must not throw, must clear the staging file, and must leave the batch reconciled.
  assert.equal(await exists(path.join(vault, tempName)), false, "recovery must consume/remove the staging file");
  assert.deepEqual(await journalEntries(), []);
  // The write path still works afterwards (the old failure poisoned it).
  const plan = await authored(() =>
    createNotePlan([{ path: "after-recovery.txt", operation: "raw", raw: "ok\n", opaque: true, mustNotExist: true }]),
  );
  await authored(() => applyNotePlan(plan.planId, plan.planHash, "after-recovery-0001"));
  assert.equal(await fs.readFile(path.join(vault, "after-recovery.txt"), "utf-8"), "ok\n");
  assert.equal(trashRel.includes("unused"), false);
});

// Reviewer B2: a name that literally starts with two dots is ordinary content once the containment
// predicate is shared — the same `local-fs.js` copy used to reject it at plan time.
test("#734: a file whose own name starts with two dots is ordinary content", async () => {
  const plan = await authored(() =>
    createNotePlan([{ path: "..weird", operation: "raw", raw: "dots\n", opaque: true, mustNotExist: true }]),
  );
  await authored(() => applyNotePlan(plan.planId, plan.planHash, "dotdot-create-0001"));
  assert.equal(await fs.readFile(path.join(vault, "..weird"), "utf-8"), "dots\n");
  const del = await authored(() => createDeleteFilePlan({ path: "..weird" }));
  const applied = await authored(() => applyNotePlan(del.planId, del.planHash, "dotdot-delete-0001"));
  assert.equal(await exists(path.join(vault, "..weird")), false);
  const trashed = path.join(data, "trash", ...applied.changed[0].backup.split("/"));
  assert.equal(await fs.readFile(trashed, "utf-8"), "dots\n");
  assert.deepEqual(await journalEntries(), []);
});

// Reviewer 735b's blocker: with Git tracking on (the compose default), a `..weird.md` write reached
// `trackGitMutation()` → `git-runtime/pending.js`, which carried a fifth `startsWith("..")` copy and threw
// `Git path traversal denied` AFTER the file landed — journal left behind, every later mutation failing,
// `server.js` refusing to boot. Runs in a child process because `config.js` resolves GIT_* at import.
test("#734: with Git tracking on, a two-dot name writes and commits without poisoning the journal", async () => {
  const { spawnSync } = await import("node:child_process");
  const gitVault = path.join(root, "git-vault");
  const gitData = path.join(root, "git-data");
  await fs.mkdir(gitVault, { recursive: true });
  const git = (args) => spawnSync("git", args, { cwd: gitVault, encoding: "utf-8" });
  const init = git(["init", "-q"]);
  if (init.status !== 0) {
    console.log("# git unavailable, skipping the Git-tracked variant:", init.stderr?.trim());
    return;
  }
  git(["config", "user.email", "dotfile-734@example.invalid"]);
  git(["config", "user.name", "dotfile-734"]);

  const script = `
    import { createNotePlan, applyNotePlan } from "./src/mutation-plans.js";
    import { withRequestContext } from "./src/request-context.js";
    const authored = (f) => withRequestContext({ author: { agent: "dotfile-734", model: "test" } }, f);
    const write = async (path, raw, key) => {
      const plan = await authored(() => createNotePlan([{ path, operation: "raw", raw, opaque: true, mustNotExist: true }]));
      await authored(() => applyNotePlan(plan.planId, plan.planHash, key));
    };
    await write("..weird.md", "# dots\\n", "git-dot-0001");
    // The old failure left a journal behind, so this second write is the poisoning check.
    await write("after-git.txt", "ok\\n", "git-dot-0002");
    console.log("WROTE-BOTH");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      VAULT_PATH: gitVault,
      DATA_PATH: gitData,
      TRASH_PATH: path.join(gitData, "trash"),
      HISTORY_PATH: path.join(gitData, "history"),
      RETRIEVAL_INDEX_PATH: path.join(gitData, "index"),
      GIT_ENABLED: "true",
      GIT_AUTO_COMMIT: "true",
    },
  });
  assert.equal(child.status, 0, `child failed:\n${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /WROTE-BOTH/);
  assert.equal(await fs.readFile(path.join(gitVault, "..weird.md"), "utf-8"), "# dots\n");
  assert.equal(await fs.readFile(path.join(gitVault, "after-git.txt"), "utf-8"), "ok\n");
  const journals = await fs.readdir(path.join(gitData, "mutation-journal")).catch(() => []);
  assert.deepEqual(journals, [], "a Git-tracked dotfile write must not leave a journal behind");
  // No `git log` assertion here: auto-commit is debounced/flushed on its own schedule, so an empty log
  // right after the apply is expected and is not evidence either way. The poison-free property above is
  // what the reviewer's blocker was about.
});

test("#734: a real escape is still refused", async () => {
  await assert.rejects(
    authored(() =>
      createNotePlan([{ path: "../escape.md", operation: "raw", raw: "x", mustNotExist: true }]),
    ),
    /traversal|outside/i,
  );
  await assert.rejects(
    authored(() =>
      createNotePlan([{ path: "sub/../../escape.md", operation: "raw", raw: "x", mustNotExist: true }]),
    ),
    /traversal|outside/i,
  );
  assert.equal(await exists(path.join(root, "escape.md")), false);
  await assertNoJournalLeft("escape attempts");
});
