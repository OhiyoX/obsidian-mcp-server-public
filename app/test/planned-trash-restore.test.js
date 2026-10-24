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

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-planned-trash-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const { createRestoreTrashPlan, applyNotePlan } = await import("../src/mutation-plans.js");
const { recoverPendingBatches } = await import("../src/batch-journal.js");
const { fileRevision } = await import("../src/vault.js");
const { withRequestContext } = await import("../src/request-context.js");
const authored = (callback) => withRequestContext({ author: { agent: "trash-test", model: "test" } }, callback);
const backupFile = async (relative, bytes) => {
  const abs = path.join(data, "trash", relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
};

test("Trash restore preview is read-only and consuming apply replays durably", async () => {
  const backupPath = "saved-1/restored.md";
  const original = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("# 恢复\n")]);
  const backup = await backupFile(backupPath, original);
  const plan = await authored(() => createRestoreTrashPlan({ backupPath, removeBackup: true }));
  assert.equal(plan.changes[0].sourceTrash, backupPath);
  assert.equal(plan.changes[0].consumeTrash, true);
  assert.equal(plan.changes[0].candidateRevision, `sha256:${createHash("sha256").update(original).digest("hex")}`);
  assert.deepEqual(await fs.readFile(backup), original);
  await assert.rejects(fs.access(path.join(vault, "restored.md")));
  const applied = await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-key-0001"));
  assert.equal(applied.changed[0].backupRemoved, true);
  assert.deepEqual(await fs.readFile(path.join(vault, "restored.md")), original);
  await assert.rejects(fs.access(backup));
  assert.equal((await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-key-0001"))).idempotentReplay, true);
});

test("empty Markdown Trash restore creates an absent zero-byte destination without consuming backup", async () => {
  const backupPath = "saved-empty/empty.md";
  const backup = await backupFile(backupPath, Buffer.alloc(0));
  const destination = path.join(vault, "empty.md");
  const plan = await authored(() => createRestoreTrashPlan({ backupPath, removeBackup: false }));
  assert.equal(plan.changed, true);
  await assert.rejects(fs.access(destination));
  await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-key-empty"));
  assert.deepEqual(await fs.readFile(destination), Buffer.alloc(0));
  assert.deepEqual(await fs.readFile(backup), Buffer.alloc(0));
});

test("Trash restore rejects source and destination changes before any write", async () => {
  const backupPath = "saved-2/conflict.md";
  const backup = await backupFile(backupPath, "previous\n");
  const destination = path.join(vault, "conflict.md");
  await fs.writeFile(destination, "current\n");
  const baseRevision = await fileRevision(destination);
  const plan = await authored(() => createRestoreTrashPlan({ backupPath, overwrite: true, ifMatch: baseRevision }));
  await fs.writeFile(backup, "external backup edit\n");
  await assert.rejects(authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-key-0002")), /Trash source revision conflict/i);
  assert.equal(await fs.readFile(destination, "utf-8"), "current\n");
  const next = await authored(() => createRestoreTrashPlan({ backupPath, overwrite: true }));
  await fs.writeFile(destination, "external destination edit\n");
  await assert.rejects(authored(() => applyNotePlan(next.planId, next.planHash, "planned-trash-key-0003")), /Revision conflict/i);
  assert.equal(await fs.readFile(destination, "utf-8"), "external destination edit\n");
});

test("startup finishes committed Trash consumption after a process crash", async () => {
  const backupPath = "saved-3/crashed.md";
  const backup = await backupFile(backupPath, "recover me\n");
  const sourceRevision = `sha256:${createHash("sha256").update("recover me\n").digest("hex")}`;
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import path from 'node:path';
    await withRequestContext({ author: { agent: 'trash-test', model: 'test' } }, () =>
      atomicWriteBatch([{ absPath: path.join(process.env.VAULT_PATH, 'crashed.md'),
        data: 'recover me\\n', sourceTrash: ${JSON.stringify(backupPath)},
        sourceRevision: ${JSON.stringify(sourceRevision)}, consumeTrash: true }],
        { afterCommit: () => process.exit(87) }));
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 87, child.stderr);
  assert.equal(await fs.readFile(backup, "utf-8"), "recover me\n");
  await recoverPendingBatches();
  assert.equal(await fs.readFile(path.join(vault, "crashed.md"), "utf-8"), "recover me\n");
  await assert.rejects(fs.access(backup));
});

test("a crash before commit rolls back destination and retains Trash source", async () => {
  const backupPath = "saved-rollback/rollback.md";
  const backup = await backupFile(backupPath, "keep backup\n");
  const sourceRevision = `sha256:${createHash("sha256").update("keep backup\n").digest("hex")}`;
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import path from 'node:path';
    await withRequestContext({ author: { agent: 'trash-test', model: 'test' } }, () =>
      atomicWriteBatch([{ absPath: path.join(process.env.VAULT_PATH, 'rollback.md'),
        data: 'keep backup\\n', sourceTrash: ${JSON.stringify(backupPath)},
        sourceRevision: ${JSON.stringify(sourceRevision)}, consumeTrash: true }],
        { afterRename: () => process.exit(88) }));
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 88, child.stderr);
  await recoverPendingBatches();
  await assert.rejects(fs.access(path.join(vault, "rollback.md")));
  assert.equal(await fs.readFile(backup, "utf-8"), "keep backup\n");
});

test("planned Trash apply rolls back after a pre-commit process crash", async () => {
  const backupPath = "planned-crash-before/before.md";
  const backup = await backupFile(backupPath, "planned before\n");
  const destination = path.join(vault, "planned-before.md");
  const script = `
    import { createRestoreTrashPlan, applyNotePlan } from './src/mutation-plans.js';
    import { withRequestContext } from './src/request-context.js';
    await withRequestContext({ author: { agent: 'trash-test', model: 'test' } }, async () => {
      const plan = await createRestoreTrashPlan({ backupPath: ${JSON.stringify(backupPath)},
        destination: 'planned-before.md', removeBackup: true });
      await applyNotePlan(plan.planId, plan.planHash, 'planned-trash-crash-before',
        { afterRename: () => process.exit(90) });
    });
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 90, child.stderr);
  assert.equal(await fs.readFile(destination, "utf-8"), "planned before\n");
  assert.equal(await fs.readFile(backup, "utf-8"), "planned before\n");
  const journalRoot = path.join(data, "mutation-journal");
  const [journalName] = await fs.readdir(journalRoot);
  assert.match(await fs.readFile(path.join(journalRoot, journalName, "manifest.json"), "utf-8"), /"state":"committing"/);
  await recoverPendingBatches();
  await assert.rejects(fs.access(destination));
  assert.equal(await fs.readFile(backup, "utf-8"), "planned before\n");
  assert.deepEqual(await fs.readdir(journalRoot), []);
});

test("planned Trash apply restores original destination bytes and revision after a pre-commit crash", async () => {
  const backupPath = "planned-crash-existing/existing.md";
  const backup = await backupFile(backupPath, "restored from trash\n");
  const destinationRel = "planned-existing.md";
  const destination = path.join(vault, destinationRel);
  const original = "original destination bytes\n";
  await fs.writeFile(destination, original);
  const originalRevision = await fileRevision(destination);
  const idempotencyKey = "planned-trash-crash-existing";
  const script = `
    import { createRestoreTrashPlan, applyNotePlan } from './src/mutation-plans.js';
    import { withRequestContext } from './src/request-context.js';
    await withRequestContext({ author: { agent: 'trash-test', model: 'test' } }, async () => {
      const plan = await createRestoreTrashPlan({ backupPath: ${JSON.stringify(backupPath)},
        destination: ${JSON.stringify(destinationRel)}, overwrite: true, removeBackup: true,
        ifMatch: ${JSON.stringify(originalRevision)} });
      await applyNotePlan(plan.planId, plan.planHash, ${JSON.stringify(idempotencyKey)},
        { afterRename: () => process.exit(92) });
    });
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 92, child.stderr);
  // The rename already replaced the destination; only recovery can undo it.
  assert.equal(await fs.readFile(destination, "utf-8"), "restored from trash\n");
  assert.equal(await fs.readFile(backup, "utf-8"), "restored from trash\n");
  const journalRoot = path.join(data, "mutation-journal");
  const [journalName] = await fs.readdir(journalRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(journalRoot, journalName, "manifest.json"), "utf-8"));
  assert.equal(manifest.state, "committing");
  assert.equal(manifest.entries[0].existed, true);
  await recoverPendingBatches();
  // Original bytes and revision are restored, not merely "a file exists".
  assert.equal(await fs.readFile(destination, "utf-8"), original);
  assert.equal(await fileRevision(destination), originalRevision);
  // Pre-commit crash retains the Trash source, matching absent-destination semantics.
  assert.equal(await fs.readFile(backup, "utf-8"), "restored from trash\n");
  assert.deepEqual(await fs.readdir(journalRoot), []);
  // No durable History snapshot or idempotency record survives the rollback.
  const historyDir = path.join(data, "history", ...destinationRel.split("/"));
  const historyEntries = await fs.readdir(historyDir).catch(() => []);
  assert.deepEqual(historyEntries.filter((name) => name.endsWith(".bak")), []);
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  await assert.rejects(fs.access(path.join(data, "mutation-idempotency", `${digest}.json`)));
});

test("planned Trash apply resumes consumption after a post-commit process crash", async () => {
  const backupPath = "planned-crash-after/after.md";
  const backup = await backupFile(backupPath, "planned after\n");
  const destination = path.join(vault, "planned-after.md");
  const planInfo = path.join(root, "planned-after-plan.json");
  const script = `
    import fs from 'node:fs';
    import { createRestoreTrashPlan, applyNotePlan } from './src/mutation-plans.js';
    import { withRequestContext } from './src/request-context.js';
    await withRequestContext({ author: { agent: 'trash-test', model: 'test' } }, async () => {
      const plan = await createRestoreTrashPlan({ backupPath: ${JSON.stringify(backupPath)},
        destination: 'planned-after.md', removeBackup: true });
      fs.writeFileSync(${JSON.stringify(planInfo)}, JSON.stringify({ planId: plan.planId, planHash: plan.planHash }));
      await applyNotePlan(plan.planId, plan.planHash, 'planned-trash-crash-after',
        { afterCommit: () => process.exit(91) });
    });
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 91, child.stderr);
  assert.equal(await fs.readFile(destination, "utf-8"), "planned after\n");
  assert.equal(await fs.readFile(backup, "utf-8"), "planned after\n");
  const journalRoot = path.join(data, "mutation-journal");
  const [journalName] = await fs.readdir(journalRoot);
  assert.match(await fs.readFile(path.join(journalRoot, journalName, "manifest.json"), "utf-8"), /"state":"committed"/);
  await recoverPendingBatches();
  assert.equal(await fs.readFile(destination, "utf-8"), "planned after\n");
  await assert.rejects(fs.access(backup));
  assert.deepEqual(await fs.readdir(journalRoot), []);
  const { planId, planHash } = JSON.parse(await fs.readFile(planInfo, "utf-8"));
  const replay = await authored(() => applyNotePlan(planId, planHash, "planned-trash-crash-after"));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(await fs.readFile(destination, "utf-8"), "planned after\n");
});

test("planned Trash apply returns idempotentReplay after crash after durable finish before client response", async () => {
  const backupPath = "planned-finish-crash/finish.md";
  const backup = await backupFile(backupPath, "durable finish\n");
  const destinationRel = "planned-finish.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "planned-trash-crash-after-finish";
  const planInfo = path.join(root, "planned-finish-plan.json");
  const script = `
    import fs from 'node:fs';
    import { createRestoreTrashPlan, applyNotePlan } from './src/mutation-plans.js';
    import { withRequestContext } from './src/request-context.js';
    await withRequestContext({ author: { agent: 'trash-test', model: 'test' } }, async () => {
      const plan = await createRestoreTrashPlan({ backupPath: ${JSON.stringify(backupPath)},
        destination: ${JSON.stringify(destinationRel)}, removeBackup: true });
      fs.writeFileSync(${JSON.stringify(planInfo)}, JSON.stringify({ planId: plan.planId, planHash: plan.planHash }));
      await applyNotePlan(plan.planId, plan.planHash, ${JSON.stringify(idempotencyKey)},
        { afterFinish: () => process.exit(93) });
    });
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 93, child.stderr);
  // Durable finish completed before the crash: destination committed and Trash consumed.
  assert.equal(await fs.readFile(destination, "utf-8"), "durable finish\n");
  await assert.rejects(fs.access(backup));
  const journalRoot = path.join(data, "mutation-journal");
  assert.deepEqual(await fs.readdir(journalRoot), []);
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  await fs.access(path.join(data, "mutation-idempotency", `${digest}.json`));
  const committedRevision = await fileRevision(destination);
  // Client retries with the same key on a fresh process and gets the durable replay.
  const { planId, planHash } = JSON.parse(await fs.readFile(planInfo, "utf-8"));
  const replay = await authored(() => applyNotePlan(planId, planHash, idempotencyKey));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.applied, true);
  assert.equal(replay.changed[0].backupRemoved, true);
  // Replay must not re-apply the restore or re-run cleanup destructively.
  assert.equal(await fileRevision(destination), committedRevision);
  assert.equal(await fs.readFile(destination, "utf-8"), "durable finish\n");
  await assert.rejects(fs.access(backup));
  assert.deepEqual(await fs.readdir(journalRoot), []);
});

test("recovery accepts an already finalized matching history snapshot", async () => {
  const backupPath = "saved-history/history.md";
  const backup = await backupFile(backupPath, "restored content\n");
  const target = path.join(vault, "history.md");
  await fs.writeFile(target, "pre-restore content\n");
  const baseRevision = await fileRevision(target);
  const sourceRevision = `sha256:${createHash("sha256").update("restored content\n").digest("hex")}`;
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import path from 'node:path';
    await withRequestContext({ author: { agent: 'trash-test', model: 'test' } }, () =>
      atomicWriteBatch([{ absPath: path.join(process.env.VAULT_PATH, 'history.md'),
        data: 'restored content\\n', ifMatch: ${JSON.stringify(baseRevision)},
        sourceTrash: ${JSON.stringify(backupPath)}, sourceRevision: ${JSON.stringify(sourceRevision)}, consumeTrash: true }],
        { afterCommit: () => process.exit(89) }));
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 89, child.stderr);
  const journalRoot = path.join(data, "mutation-journal");
  const [journalName] = await fs.readdir(journalRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(journalRoot, journalName, "manifest.json"), "utf-8"));
  const history = path.join(data, "history", "history.md", manifest.entries[0].historyName);
  await fs.mkdir(path.dirname(history), { recursive: true });
  await fs.writeFile(history, "pre-restore content\n");
  await recoverPendingBatches();
  assert.equal(await fs.readFile(target, "utf-8"), "restored content\n");
  await assert.rejects(fs.access(backup));
  assert.equal((await fs.readdir(journalRoot)).length, 0);
});

test("planned Trash restore keeps committed destination and pending journal when post-commit backup unlink fails", async () => {
  const backupPath = "planned-unlink-failure/unlink.md";
  const restoredBytes = "committed despite cleanup failure\n";
  const backup = await backupFile(backupPath, restoredBytes);
  const destinationRel = "planned-unlink.md";
  const destination = path.join(vault, destinationRel);
  const idempotencyKey = "planned-trash-unlink-failure";
  const plan = await authored(() => createRestoreTrashPlan({ backupPath,
    destination: destinationRel, removeBackup: true }));
  const journalRoot = path.join(data, "mutation-journal");
  const injected = new Error("injected consumed Trash unlink failure");
  await assert.rejects(
    authored(() => applyNotePlan(plan.planId, plan.planHash, idempotencyKey,
      { beforeConsumedTrashUnlink: () => { throw injected; } })),
    /injected consumed Trash unlink failure|recovery journal remains/i,
  );
  // (1) The committed Vault restore bytes stay; cleanup failure must not roll back the destination.
  assert.equal(await fs.readFile(destination, "utf-8"), restoredBytes);
  // (2) The Trash backup is untouched and a committed journal remains for later recovery.
  assert.equal(await fs.readFile(backup, "utf-8"), restoredBytes);
  const journalNames = await fs.readdir(journalRoot);
  assert.equal(journalNames.length, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(journalRoot, journalNames[0], "manifest.json"), "utf-8"));
  assert.equal(manifest.state, "committed");
  assert.equal(manifest.entries[0].consumeTrash.path, backupPath);
  // No applied idempotency record, so recovery did not claim the cleanup finished.
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  await assert.rejects(fs.access(path.join(data, "mutation-idempotency", `${digest}.json`)));
  // (3) Recovery finishes the pending unlink without disturbing the committed restore.
  await recoverPendingBatches();
  assert.equal(await fs.readFile(destination, "utf-8"), restoredBytes);
  await assert.rejects(fs.access(backup));
  assert.deepEqual(await fs.readdir(journalRoot), []);
  const replay = await authored(() => applyNotePlan(plan.planId, plan.planHash, idempotencyKey));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.changed[0].backupRemoved, true);
  assert.equal(await fs.readFile(destination, "utf-8"), restoredBytes);
});

test("removeBackup can consume Trash even when destination bytes already match", async () => {
  const backupPath = "saved-same/same.md";
  const backup = await backupFile(backupPath, "same text\n");
  const target = path.join(vault, "same.md");
  await fs.writeFile(target, "same text\n");
  const plan = await authored(() => createRestoreTrashPlan({ backupPath, overwrite: true, removeBackup: true }));
  assert.equal(plan.changed, true);
  const result = await authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-key-same"));
  assert.equal(result.changed[0].backupRemoved, true);
  await assert.rejects(fs.access(backup));
  assert.equal(await fs.readFile(target, "utf-8"), "same text\n");
});

test("unchanged restore still rejects an edited Trash source", async () => {
  const backupPath = "saved-unchanged/unchanged.md";
  const backup = await backupFile(backupPath, "same\n");
  await fs.writeFile(path.join(vault, "unchanged.md"), "same\n");
  const plan = await authored(() => createRestoreTrashPlan({ backupPath, overwrite: true }));
  assert.equal(plan.changed, false);
  await fs.writeFile(backup, "edited\n");
  await assert.rejects(authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-key-unchanged")), /Trash source revision conflict/i);
});

test("unchanged restore rejects an externally edited destination", async () => {
  const backupPath = "saved-unchanged-destination/unchanged-destination.md";
  await backupFile(backupPath, "same\n");
  const target = path.join(vault, "unchanged-destination.md");
  await fs.writeFile(target, "same\n");
  const plan = await authored(() => createRestoreTrashPlan({ backupPath, overwrite: true }));
  assert.equal(plan.changed, false);
  await fs.writeFile(target, "external edit\n");
  await assert.rejects(authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-key-unchanged-destination")), /Revision conflict/i);
  assert.equal(await fs.readFile(target, "utf-8"), "external edit\n");
});

test("apply rejects entire planned Trash restore on post-plan source drift when backup is deleted", async () => {
  const backupPath = "postplan-source-deleted/note.md";
  const backup = await backupFile(backupPath, "planned bytes\n");
  const destination = path.join(vault, "postplan-source-deleted.md");
  const plan = await authored(() => createRestoreTrashPlan({
    backupPath,
    destination: "postplan-source-deleted.md",
    removeBackup: true,
  }));
  assert.equal(plan.changed, true);
  await fs.unlink(backup);
  await assert.rejects(
    authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-postplan-source-deleted")),
    /Trash source revision conflict/i,
  );
  await assert.rejects(fs.access(destination));
  const journals = await fs.readdir(path.join(data, "mutation-journal")).catch(() => []);
  assert.deepEqual(journals, []);
});

test("apply rejects entire planned Trash restore on post-plan source drift when backup is modified", async () => {
  const backupPath = "postplan-source-modified/note.md";
  const backup = await backupFile(backupPath, "planned bytes\n");
  const destination = path.join(vault, "postplan-source-modified.md");
  const plan = await authored(() => createRestoreTrashPlan({
    backupPath,
    destination: "postplan-source-modified.md",
  }));
  await fs.writeFile(backup, "external backup drift\n");
  await assert.rejects(
    authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-postplan-source-modified")),
    /Trash source revision conflict/i,
  );
  await assert.rejects(fs.access(destination));
  assert.equal(await fs.readFile(backup, "utf-8"), "external backup drift\n");
});

test("apply rejects entire planned Trash restore on post-plan destination drift when absent path is created", async () => {
  const backupPath = "postplan-dest-created/note.md";
  await backupFile(backupPath, "from trash\n");
  const destination = path.join(vault, "postplan-dest-created.md");
  const plan = await authored(() => createRestoreTrashPlan({
    backupPath,
    destination: "postplan-dest-created.md",
  }));
  assert.equal(plan.changes[0].mustNotExist, true);
  await fs.writeFile(destination, "external create after plan\n");
  await assert.rejects(
    authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-postplan-dest-created")),
    /Revision conflict/i,
  );
  assert.equal(await fs.readFile(destination, "utf-8"), "external create after plan\n");
  const journals = await fs.readdir(path.join(data, "mutation-journal")).catch(() => []);
  assert.deepEqual(journals, []);
});

test("apply rejects entire planned Trash restore on post-plan destination drift when existing path is modified", async () => {
  const backupPath = "postplan-dest-modified/note.md";
  await backupFile(backupPath, "from trash\n");
  const destination = path.join(vault, "postplan-dest-modified.md");
  await fs.writeFile(destination, "original destination\n");
  const baseRevision = await fileRevision(destination);
  const plan = await authored(() => createRestoreTrashPlan({
    backupPath,
    destination: "postplan-dest-modified.md",
    overwrite: true,
    ifMatch: baseRevision,
  }));
  await fs.writeFile(destination, "external destination drift\n");
  await assert.rejects(
    authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-postplan-dest-modified")),
    /Revision conflict/i,
  );
  assert.equal(await fs.readFile(destination, "utf-8"), "external destination drift\n");
  const journals = await fs.readdir(path.join(data, "mutation-journal")).catch(() => []);
  assert.deepEqual(journals, []);
});

test("unchanged planned Trash restore rejects post-plan source drift when backup is deleted", async () => {
  const backupPath = "postplan-unchanged-source-deleted/note.md";
  const backup = await backupFile(backupPath, "same\n");
  const destination = path.join(vault, "postplan-unchanged-source-deleted.md");
  await fs.writeFile(destination, "same\n");
  const plan = await authored(() => createRestoreTrashPlan({
    backupPath,
    destination: "postplan-unchanged-source-deleted.md",
    overwrite: true,
  }));
  assert.equal(plan.changed, false);
  await fs.unlink(backup);
  await assert.rejects(
    authored(() => applyNotePlan(plan.planId, plan.planHash, "planned-trash-postplan-unchanged-source-deleted")),
    /Trash source revision conflict/i,
  );
  assert.equal(await fs.readFile(destination, "utf-8"), "same\n");
});
test("legacy restore_from_trash uses planner for Markdown and keeps binary byte restore", async () => {
  const handlers = new Map();
  const { registerLinkTools } = await import("../src/tools/links.js");
  registerLinkTools({ registerTool: (name, _definition, handler) => handlers.set(name, handler) });
  const noteBackup = "saved-4/legacy.md";
  await backupFile(noteBackup, "legacy note\n");
  const note = await authored(() => handlers.get("restore_from_trash")({ backupPath: noteBackup, removeBackup: true }));
  assert.equal(note.structuredContent.backupRemoved, true);
  assert.equal(await fs.readFile(path.join(vault, "legacy.md"), "utf-8"), "legacy note\n");
  const binaryBackup = "saved-5/image.png";
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
  await backupFile(binaryBackup, image);
  const binary = await authored(() => handlers.get("restore_from_trash")({ backupPath: binaryBackup }));
  assert.equal(binary.structuredContent.restoredPath, "image.png");
  assert.deepEqual(await fs.readFile(path.join(vault, "image.png")), image);
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
