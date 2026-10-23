import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const CHILD_PROCESS_TIMEOUT_MS = 15_000;

function spawnNodeSync(args, options = {}) {
  const child = spawnSync(process.execPath, args, {
    ...options,
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  assert.notEqual(child.error?.code, "ETIMEDOUT", child.error?.message || "child process must not time out");
  assert.equal(child.signal, null, `unexpected child signal: ${child.signal}`);
  return child;
}
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Wave 2: post-commit Trash cleanup must fail closed when the reviewed backup
// revision drifts before the unlink. The truth source is the SHA-256 revision
// recorded in the durable journal, not path existence or naming.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-trash-cleanup-conflict-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const { createRestoreTrashPlan, applyNotePlan } = await import("../src/mutation-plans.js");
const { finishBatchJournal, recoverPendingBatches } = await import("../src/batch-journal.js");
const { withRequestContext } = await import("../src/request-context.js");

const authored = (callback) => withRequestContext({ author: { agent: "trash-cleanup-conflict", model: "test" } }, callback);
const backupFile = async (relative, bytes) => {
  const abs = path.join(data, "trash", relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
};
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const journalRoot = path.join(data, "mutation-journal");
const idempotencyRecord = (key) => path.join(data, "mutation-idempotency", `${createHash("sha256").update(key).digest("hex")}.json`);

const removeJournal = async () => {
  for (const name of await fs.readdir(journalRoot).catch(() => [])) {
    await fs.rm(path.join(journalRoot, name), { recursive: true, force: true });
  }
};

test("cleanup never unlinks a Trash source that drifted before unlink and keeps a conflict journal", async () => {
  await removeJournal();
  const backupPath = "cleanup-conflict/note.md";
  const reviewed = "reviewed bytes\n";
  const external = "external writer bytes\n";
  const backup = await backupFile(backupPath, reviewed);
  const destinationRel = "cleanup-conflict.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "trash-cleanup-conflict-0001";
  const recordedRevision = sha(reviewed);

  const plan = await authored(() => createRestoreTrashPlan({ backupPath, destination: destinationRel, removeBackup: true }));
  assert.equal(plan.changes[0].sourceTrash, backupPath);
  assert.equal(plan.changes[0].sourceRevision, recordedRevision);
  assert.equal(plan.changes[0].consumeTrash, true);

  // Deterministic injection of an external writer that rewrites the reviewed
  // backup in the window between the pre-commit guard and the cleanup unlink.
  await assert.rejects(
    authored(() => applyNotePlan(plan.planId, plan.planHash, idempotencyKey, {
      beforeConsumedTrashUnlink: () => fs.writeFile(backup, external),
    })),
    /cleanup conflict|recovery journal remains/i,
  );

  // The committed Vault destination is never rolled back by a cleanup conflict.
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  // The unexpected content now occupying the recorded Trash path is preserved.
  assert.equal(await fs.readFile(backup, "utf-8"), external);

  // A diagnosable committed journal keeps the pending completion intent and the
  // exact revision that was reviewed, so recovery can decide what to do.
  const journals = await fs.readdir(journalRoot);
  assert.equal(journals.length, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(journalRoot, journals[0], "manifest.json"), "utf-8"));
  assert.equal(manifest.state, "committed");
  assert.equal(manifest.entries[0].consumeTrash.path, backupPath);
  assert.equal(manifest.entries[0].consumeTrash.revision, recordedRevision);
  // The unfinished cleanup is not claimed as an applied idempotent result.
  await assert.rejects(fs.access(idempotencyRecord(idempotencyKey)));

  // Replaying recovery in the same runtime fails closed and must not silently
  // delete the drifted source or roll back the committed destination.
  await assert.rejects(recoverPendingBatches(), /cleanup conflict/i);
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  assert.equal(await fs.readFile(backup, "utf-8"), external);
  assert.deepEqual(await fs.readdir(journalRoot), journals);

  await removeJournal();
});

test("a restarted runtime fails closed on a Trash cleanup conflict without deleting or rolling back", async () => {
  await removeJournal();
  const backupPath = "restart-drift/note.md";
  const reviewed = "restart reviewed bytes\n";
  const external = "restart external bytes\n";
  const backup = await backupFile(backupPath, reviewed);
  const destinationRel = "restart-drift.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "trash-cleanup-restart-0001";

  const plan = await authored(() => createRestoreTrashPlan({ backupPath, destination: destinationRel, removeBackup: true }));
  await assert.rejects(
    authored(() => applyNotePlan(plan.planId, plan.planHash, idempotencyKey, {
      beforeConsumedTrashUnlink: () => fs.writeFile(backup, external),
    })),
    /cleanup conflict|recovery journal remains/i,
  );

  // The old process is gone; the durable journal is the only restart input.
  const script = `
    import { recoverPendingBatches } from './src/batch-journal.js';
    try {
      await recoverPendingBatches();
      console.log('UNEXPECTED_RECOVERY');
      process.exit(0);
    } catch (error) {
      console.log('CONFLICT:' + error.message);
      process.exit(7);
    }
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 7, child.stderr || child.stdout);
  assert.match(child.stdout, /CONFLICT:.*cleanup conflict/i);

  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  assert.equal(await fs.readFile(backup, "utf-8"), external);
  const journals = await fs.readdir(journalRoot);
  assert.equal(journals.length, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(journalRoot, journals[0], "manifest.json"), "utf-8"));
  assert.equal(manifest.state, "committed");

  await removeJournal();
});

test("cleanup without drift still consumes the Trash source and clears the journal", async () => {
  await removeJournal();
  const backupPath = "no-drift/note.md";
  const reviewed = "clean restore bytes\n";
  await backupFile(backupPath, reviewed);
  const destinationRel = "no-drift.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "trash-cleanup-no-drift-0001";

  const plan = await authored(() => createRestoreTrashPlan({ backupPath, destination: destinationRel, removeBackup: true }));
  const applied = await authored(() => applyNotePlan(plan.planId, plan.planHash, idempotencyKey));
  assert.equal(applied.changed[0].backupRemoved, true);
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  await assert.rejects(fs.access(path.join(data, "trash", backupPath)));
  assert.deepEqual(await fs.readdir(journalRoot), []);

  const replay = await authored(() => applyNotePlan(plan.planId, plan.planHash, idempotencyKey));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
});

test("an external writer that recreates the Trash source after the atomic detach is never deleted", async () => {
  await removeJournal();
  const backupPath = "post-detach-race/note.md";
  const reviewed = "reviewed bytes\n";
  const external = "external writer bytes\n";
  const backup = await backupFile(backupPath, reviewed);
  const destinationRel = "post-detach-race.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "trash-cleanup-post-detach-race-0001";

  const plan = await authored(() => createRestoreTrashPlan({ backupPath, destination: destinationRel, removeBackup: true }));
  // The reviewed entry is already atomically detached when this hook runs, so
  // the writer replaces the source path, not the private quarantine. The old
  // check-then-unlink code would have deleted these new bytes; the quarantine
  // delete must not touch them.
  const applied = await authored(() => applyNotePlan(plan.planId, plan.planHash, idempotencyKey, {
    beforeConsumeQuarantineUnlink: () => fs.writeFile(backup, external),
  }));

  assert.equal(applied.changed[0].backupRemoved, true);
  // The committed destination is untouched and cleanup finished successfully.
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  assert.deepEqual(await fs.readdir(journalRoot), []);
  // The reviewed inode was consumed, while the bytes an external writer put at
  // the Trash path after detach are preserved rather than unlinked.
  assert.equal(await fs.readFile(backup, "utf-8"), external);
  // No quarantine artifact is left behind by the successful cleanup.
  assert.deepEqual(await fs.readdir(path.dirname(backup)), ["note.md"]);

  await removeJournal();
});

test("recovery finishes consuming a detached reviewed source after a crash at the quarantine unlink", async () => {
  await removeJournal();
  const backupPath = "detach-crash/note.md";
  const reviewed = "detached reviewed bytes\n";
  const backup = await backupFile(backupPath, reviewed);
  const destinationRel = "detach-crash.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "trash-cleanup-detach-crash-0001";
  const planInfo = path.join(root, "detach-crash-plan.json");

  const script = `
    import fs from 'node:fs';
    import { createRestoreTrashPlan, applyNotePlan } from './src/mutation-plans.js';
    import { withRequestContext } from './src/request-context.js';
    await withRequestContext({ author: { agent: 'trash-cleanup-conflict', model: 'test' } }, async () => {
      const plan = await createRestoreTrashPlan({ backupPath: ${JSON.stringify(backupPath)},
        destination: ${JSON.stringify(destinationRel)}, removeBackup: true });
      fs.writeFileSync(${JSON.stringify(planInfo)}, JSON.stringify({ planId: plan.planId, planHash: plan.planHash }));
      await applyNotePlan(plan.planId, plan.planHash, ${JSON.stringify(idempotencyKey)},
        { beforeConsumeQuarantineUnlink: () => process.exit(94) });
    });
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 94, child.stderr || child.stdout);

  // Crash happened after the atomic detach: the source path is gone and only
  // the revision-bound quarantine holds the reviewed bytes.
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  await assert.rejects(fs.access(backup));
  const leftovers = await fs.readdir(path.dirname(backup));
  assert.equal(leftovers.length, 1);
  assert.match(leftovers[0], /obsidian-mcp-consume-[0-9a-f]+-[0-9a-f]+\.quarantine$/);
  assert.equal(await fs.readFile(path.join(path.dirname(backup), leftovers[0]), "utf-8"), reviewed);
  assert.equal((await fs.readdir(journalRoot)).length, 1);

  // Recovery recognizes the deterministic quarantine, deletes the reviewed
  // bytes once, and finishes the committed transaction.
  await recoverPendingBatches();
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  await assert.rejects(fs.access(backup));
  assert.deepEqual(await fs.readdir(path.dirname(backup)), []);
  assert.deepEqual(await fs.readdir(journalRoot), []);
  const { planId, planHash } = JSON.parse(await fs.readFile(planInfo, "utf-8"));
  const replay = await authored(() => applyNotePlan(planId, planHash, idempotencyKey));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.changed[0].backupRemoved, true);

  await removeJournal();
});

test("recovery after a detached crash ignores a source recreated by an external writer", async () => {
  await removeJournal();
  const backupPath = "detach-crash-recreate/note.md";
  const reviewed = "detached reviewed bytes\n";
  const recreated = "external writer recreated bytes\n";
  const backup = await backupFile(backupPath, reviewed);
  const destinationRel = "detach-crash-recreate.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "trash-cleanup-detach-crash-recreate-0001";
  const planInfo = path.join(root, "detach-crash-recreate-plan.json");

  const script = `
    import fs from 'node:fs';
    import { createRestoreTrashPlan, applyNotePlan } from './src/mutation-plans.js';
    import { withRequestContext } from './src/request-context.js';
    await withRequestContext({ author: { agent: 'trash-cleanup-conflict', model: 'test' } }, async () => {
      const plan = await createRestoreTrashPlan({ backupPath: ${JSON.stringify(backupPath)},
        destination: ${JSON.stringify(destinationRel)}, removeBackup: true });
      fs.writeFileSync(${JSON.stringify(planInfo)}, JSON.stringify({ planId: plan.planId, planHash: plan.planHash }));
      await applyNotePlan(plan.planId, plan.planHash, ${JSON.stringify(idempotencyKey)},
        { beforeConsumeQuarantineUnlink: () => process.exit(94) });
    });
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 94, child.stderr || child.stdout);

  // Crash happened after the atomic detach: only the revision-bound quarantine
  // holds the reviewed bytes and the old source path is gone.
  await assert.rejects(fs.access(backup));
  const leftovers = await fs.readdir(path.dirname(backup));
  assert.equal(leftovers.length, 1);
  assert.match(leftovers[0], /obsidian-mcp-consume-[0-9a-f]+-[0-9a-f]+\.quarantine$/);

  // An external writer recreates a brand-new object at the old Trash path.
  await fs.writeFile(backup, recreated);

  // Recovery consumes the leftover reviewed bytes, preserves the recreated
  // object, and clears the journal so server startup can continue.
  await recoverPendingBatches();
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  assert.equal(await fs.readFile(backup, "utf-8"), recreated);
  assert.deepEqual(await fs.readdir(path.dirname(backup)), ["note.md"]);
  assert.deepEqual(await fs.readdir(journalRoot), []);

  // The finished cleanup is claimed once and replays idempotently.
  const { planId, planHash } = JSON.parse(await fs.readFile(planInfo, "utf-8"));
  const replay = await authored(() => applyNotePlan(planId, planHash, idempotencyKey));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.changed[0].backupRemoved, true);
  assert.equal(await fs.readFile(backup, "utf-8"), recreated);

  await removeJournal();
});

test("restoring unexpected quarantined bytes keeps their last copy when a writer replaces the source mid-restore", async () => {
  await removeJournal();
  const backupPath = "restore-race/note.md";
  const reviewed = "restore-race reviewed bytes\n";
  const external = "restore-race unexpected bytes\n";
  const backup = await backupFile(backupPath, reviewed);
  const destinationRel = "restore-race.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "trash-cleanup-restore-race-0001";

  const plan = await authored(() => createRestoreTrashPlan({ backupPath, destination: destinationRel, removeBackup: true }));
  // The writer rewrites the source after the pre-rename guard, so rename moves
  // the unexpected bytes into the quarantine and the restore path runs. The
  // second injection fires inside the restore, after the unexpected bytes are
  // linked back to the free source path but before the quarantine cleanup.
  // An external writer replacing the source in that window must not turn the
  // quarantine into the last link that is then deleted.
  await assert.rejects(
    authored(() => applyNotePlan(plan.planId, plan.planHash, idempotencyKey, {
      beforeConsumedTrashUnlink: () => fs.writeFile(backup, external),
      afterRestoreQuarantineLink: () => fs.rm(backup, { force: true }),
    })),
    /cleanup conflict/i,
  );

  // The committed destination is untouched, and the unexpected bytes still
  // exist somewhere under the Trash root instead of being destroyed.
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  const directory = path.dirname(backup);
  const contents = await Promise.all((await fs.readdir(directory)).map((name) => fs.readFile(path.join(directory, name), "utf-8")));
  assert.ok(contents.includes(external), `unexpected bytes were destroyed; surviving files: ${JSON.stringify(contents)}`);

  await removeJournal();
});

test("recovery that already consumed a verified quarantine does not conflict when a writer recreates the source", async () => {
  await removeJournal();
  const backupPath = "consumed-then-recreated/note.md";
  const reviewed = "consumed reviewed bytes\n";
  const recreated = "writer recreated after consumption\n";
  const backup = await backupFile(backupPath, reviewed);
  const destinationRel = "consumed-then-recreated.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "trash-cleanup-consumed-then-recreated-0001";
  const planInfo = path.join(root, "consumed-then-recreated-plan.json");

  // Leave a detached-crash committed journal: the source path is gone and only
  // the revision-bound quarantine holds the reviewed bytes.
  const script = `
    import fs from 'node:fs';
    import { createRestoreTrashPlan, applyNotePlan } from './src/mutation-plans.js';
    import { withRequestContext } from './src/request-context.js';
    await withRequestContext({ author: { agent: 'trash-cleanup-conflict', model: 'test' } }, async () => {
      const plan = await createRestoreTrashPlan({ backupPath: ${JSON.stringify(backupPath)},
        destination: ${JSON.stringify(destinationRel)}, removeBackup: true });
      fs.writeFileSync(${JSON.stringify(planInfo)}, JSON.stringify({ planId: plan.planId, planHash: plan.planHash }));
      await applyNotePlan(plan.planId, plan.planHash, ${JSON.stringify(idempotencyKey)},
        { beforeConsumeQuarantineUnlink: () => process.exit(94) });
    });
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 94, child.stderr || child.stdout);
  await assert.rejects(fs.access(backup));
  const [journalName] = await fs.readdir(journalRoot);

  // The next recovery deletes the verified quarantine and then crashes before
  // the journal cleanup. The durable manifest must already record that this
  // item's consumption is committed.
  await assert.rejects(
    finishBatchJournal({ dir: path.join(journalRoot, journalName) }, {
      afterConsumeQuarantineUnlink: () => { throw new Error("simulated crash after quarantine unlink"); },
    }),
    /simulated crash after quarantine unlink/,
  );
  await assert.rejects(fs.access(backup));

  // A writer repopulates the old Trash path after consumption completed.
  await fs.writeFile(backup, recreated);

  // The second recovery must finish the committed transaction instead of
  // treating the recreated object as a drift of the already-consumed entry.
  await recoverPendingBatches();
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  assert.equal(await fs.readFile(backup, "utf-8"), recreated);
  assert.deepEqual(await fs.readdir(journalRoot), []);

  await removeJournal();
});

test("recovery after a durable completion marker still only removes the verified quarantine", async () => {
  await removeJournal();
  const backupPath = "mark-then-unlink/note.md";
  const reviewed = "mark-then-unlink reviewed bytes\n";
  const external = "external writer bytes at the old source\n";
  const backup = await backupFile(backupPath, reviewed);
  const destinationRel = "mark-then-unlink.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "trash-cleanup-mark-then-unlink-0001";
  const planInfo = path.join(root, "mark-then-unlink-plan.json");

  // Detached crash: the reviewed entry was atomically renamed into its
  // revision-bound quarantine, and no completion marker is durable yet.
  const script = `
    import fs from 'node:fs';
    import { createRestoreTrashPlan, applyNotePlan } from './src/mutation-plans.js';
    import { withRequestContext } from './src/request-context.js';
    await withRequestContext({ author: { agent: 'trash-cleanup-conflict', model: 'test' } }, async () => {
      const plan = await createRestoreTrashPlan({ backupPath: ${JSON.stringify(backupPath)},
        destination: ${JSON.stringify(destinationRel)}, removeBackup: true });
      fs.writeFileSync(${JSON.stringify(planInfo)}, JSON.stringify({ planId: plan.planId, planHash: plan.planHash }));
      await applyNotePlan(plan.planId, plan.planHash, ${JSON.stringify(idempotencyKey)},
        { beforeConsumeQuarantineUnlink: () => process.exit(95) });
    });
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 95, child.stderr || child.stdout);
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  await assert.rejects(fs.access(backup));
  const [journalName] = await fs.readdir(journalRoot);
  const journalDir = path.join(journalRoot, journalName);
  const [quarantineName] = await fs.readdir(path.dirname(backup));
  assert.match(quarantineName, /obsidian-mcp-consume-[0-9a-f]+-[0-9a-f]+\.quarantine$/);
  const quarantinePath = path.join(path.dirname(backup), quarantineName);
  const crashed = JSON.parse(await fs.readFile(path.join(journalDir, "manifest.json"), "utf-8"));
  assert.equal(crashed.state, "committed");
  assert.equal(crashed.entries[0].consumeTrash.path, backupPath);
  assert.equal(crashed.entries[0].consumeTrash.revision, sha(reviewed));
  assert.equal(Boolean(crashed.entries[0].consumeCompleted), false);

  // Simulate an exit between persisting the per-entry completion marker and the
  // quarantine unlink: the durable marker is written by real recovery code, and
  // the hook restores the quarantine the interrupted unlink would have left, so
  // the on-disk state matches that crash window exactly.
  await assert.rejects(
    finishBatchJournal({ dir: journalDir }, {
      afterConsumeQuarantineUnlink: async () => {
        await fs.writeFile(quarantinePath, reviewed);
        throw new Error("simulated crash after durable completion marker");
      },
    }),
    /simulated crash after durable completion marker/,
  );
  const marked = JSON.parse(await fs.readFile(path.join(journalDir, "manifest.json"), "utf-8"));
  assert.equal(marked.state, "committed");
  assert.equal(marked.entries[0].consumeCompleted, true);
  assert.equal(await fs.readFile(quarantinePath, "utf-8"), reviewed);

  // An external writer repopulates the old Trash path with unknown bytes. A
  // restarted runtime must delete only the revision-verified quarantine and
  // never the unknown object now at the source path.
  await fs.writeFile(backup, external);
  const recovery = spawnNodeSync( ["--input-type=module", "-e",
    "import { recoverPendingBatches } from './src/batch-journal.js'; await recoverPendingBatches();"], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(recovery.status, 0, recovery.stderr || recovery.stdout);
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  assert.equal(await fs.readFile(backup, "utf-8"), external);
  assert.deepEqual(await fs.readdir(path.dirname(backup)), ["note.md"]);
  assert.deepEqual(await fs.readdir(journalRoot), []);

  // Completion survives the restart and the same key replays idempotently
  // without consuming anything a second time.
  await fs.access(idempotencyRecord(idempotencyKey));
  const { planId, planHash } = JSON.parse(await fs.readFile(planInfo, "utf-8"));
  const replay = await authored(() => applyNotePlan(planId, planHash, idempotencyKey));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.changed[0].backupRemoved, true);
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  assert.equal(await fs.readFile(backup, "utf-8"), external);

  await removeJournal();
});

test("an operator-resolved cleanup conflict recovers and the same key replays idempotently", async () => {
  await removeJournal();
  const backupPath = "operator-resolved/note.md";
  const reviewed = "operator reviewed bytes\n";
  const external = "operator external bytes\n";
  const backup = await backupFile(backupPath, reviewed);
  const destinationRel = "operator-resolved.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "trash-cleanup-operator-resolved-0001";

  // Commit the Vault restore, then drift the reviewed Trash source so cleanup
  // fails closed and leaves the committed journal for an operator.
  const plan = await authored(() => createRestoreTrashPlan({ backupPath, destination: destinationRel, removeBackup: true }));
  await assert.rejects(
    authored(() => applyNotePlan(plan.planId, plan.planHash, idempotencyKey, {
      beforeConsumedTrashUnlink: () => fs.writeFile(backup, external),
    })),
    /cleanup conflict/i,
  );
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  assert.equal(await fs.readFile(backup, "utf-8"), external);

  // The conflict left an unexpected quarantine artifact beside the source. The
  // operator discards that artifact and restores the reviewed bytes to the
  // source path; the committed destination is never touched by recovery.
  const trashDirectory = path.dirname(backup);
  for (const name of await fs.readdir(trashDirectory)) {
    if (name !== path.basename(backup)) await fs.rm(path.join(trashDirectory, name), { force: true });
  }
  await fs.writeFile(backup, reviewed);
  await recoverPendingBatches();
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  await assert.rejects(fs.access(backup));
  assert.deepEqual(await fs.readdir(journalRoot), []);

  // A replay with the original key returns the recorded result instead of
  // restoring or consuming anything a second time.
  const replay = await authored(() => applyNotePlan(plan.planId, plan.planHash, idempotencyKey));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.changed[0].backupRemoved, true);
  assert.equal(await fs.readFile(destination, "utf-8"), reviewed);
  await assert.rejects(fs.access(path.join(data, "trash", backupPath)));

  await removeJournal();
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
