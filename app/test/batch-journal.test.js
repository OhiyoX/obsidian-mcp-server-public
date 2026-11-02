import assert from "node:assert/strict";
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

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-batch-journal-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const { recoverPendingBatches } = await import("../src/batch-journal.js");
const { atomicWriteBatch } = await import("../src/batch-write.js");
const { fileRevision } = await import("../src/vault.js");
const { withRequestContext } = await import("../src/request-context.js");
const authored = (callback) => withRequestContext({ author: { agent: "journal-test", model: "test" } }, callback);

test("a process crash after the first rename is recovered before serving", async () => {
  const first = path.join(vault, "first.md");
  const second = path.join(vault, "second.md");
  await fs.writeFile(first, "original");
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { fileRevision } from './src/vault.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import path from 'node:path';
    const first = path.join(process.env.VAULT_PATH, 'first.md');
    const second = path.join(process.env.VAULT_PATH, 'second.md');
    await withRequestContext({ author: { agent: 'journal-test', model: 'test' } }, () =>
      atomicWriteBatch([
        { absPath: first, data: 'candidate-secret', ifMatch: awaitRevision },
        { absPath: second, data: 'new-secret', mustNotExist: true },
      ], { afterRename: (index) => { if (index === 0) process.exit(77); } }));
  `.replace("awaitRevision", JSON.stringify(await fileRevision(first)));
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data },
    encoding: "utf-8",
  });
  assert.equal(child.status, 77, child.stderr);
  assert.equal(await fs.readFile(first, "utf-8"), "candidate-secret");
  await assert.rejects(fs.access(second));

  const journalRoot = path.join(data, "mutation-journal");
  const [id] = await fs.readdir(journalRoot);
  const manifest = await fs.readFile(path.join(journalRoot, id, "manifest.json"), "utf-8");
  assert.doesNotMatch(manifest, /candidate-secret|new-secret|original/);
  assert.match(manifest, /"state":"committing"/);

  await fs.writeFile(first, "external-edit");
  await assert.rejects(recoverPendingBatches(), /Recovery conflict/);
  assert.equal(await fs.readFile(first, "utf-8"), "external-edit");
  await fs.writeFile(first, "candidate-secret");
  const restarted = spawnNodeSync( ["--input-type=module", "-e",
    "import { recoverPendingBatches } from './src/batch-journal.js'; await recoverPendingBatches();"], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(await fs.readFile(first, "utf-8"), "original");
  await assert.rejects(fs.access(second));
  assert.deepEqual(await fs.readdir(journalRoot), []);
  await assert.rejects(fs.access(path.join(data, "history", "first.md")));
});

test("ordinary commit errors roll back the entire batch", async () => {
  const first = path.join(vault, "first.md");
  const second = path.join(vault, "second.md");
  const before = await fileRevision(first);
  await assert.rejects(
    authored(() => atomicWriteBatch([
      { absPath: first, data: "changed", ifMatch: before },
      { absPath: second, data: "new", mustNotExist: true },
    ], { afterRename: () => { throw new Error("injected failure"); } })),
    /injected failure/,
  );
  assert.equal(await fs.readFile(first, "utf-8"), "original");
  await assert.rejects(fs.access(second));
  await assert.rejects(fs.access(path.join(data, "history", "first.md")));
});

test("successful batches publish one pre-write history version", async () => {
  const first = path.join(vault, "first.md");
  const before = await fileRevision(first);
  await authored(() => atomicWriteBatch([{ absPath: first, data: "committed", ifMatch: before }]));
  const names = await fs.readdir(path.join(data, "history", "first.md"));
  assert.equal(names.filter((name) => name.endsWith(".bak")).length, 1);
  assert.equal(await fs.readFile(path.join(data, "history", "first.md", names[0]), "utf-8"), "original");
});

test("a delete and a write roll back together after a process crash", async () => {
  const source = path.join(vault, "delete-source.md");
  const destination = path.join(vault, "delete-destination.md");
  await fs.writeFile(source, "source-secret");
  const before = await fileRevision(source);
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import path from 'node:path';
    await withRequestContext({ author: { agent: 'journal-test', model: 'test' } }, () =>
      atomicWriteBatch([
        { absPath: path.join(process.env.VAULT_PATH, 'delete-source.md'), delete: true,
          ifMatch: ${JSON.stringify(before)} },
        { absPath: path.join(process.env.VAULT_PATH, 'delete-destination.md'),
          data: 'destination-secret', mustNotExist: true },
      ], { afterRename: (index) => { if (index === 0) process.exit(80); } }));
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 80, child.stderr);
  await assert.rejects(fs.access(source));
  await recoverPendingBatches();
  assert.equal(await fs.readFile(source, "utf-8"), "source-secret");
  await assert.rejects(fs.access(destination));
  await assert.rejects(fs.access(path.join(data, "history", "delete-source.md")));
});

test("a committed delete stays deleted and retains its pre-write version", async () => {
  const source = path.join(vault, "committed-delete.md");
  await fs.writeFile(source, "before-delete");
  const before = await fileRevision(source);
  const result = await authored(() => atomicWriteBatch([{ absPath: source, delete: true, ifMatch: before }]));
  assert.deepEqual(result, [{ path: "committed-delete.md", deleted: true, created: false, size: 0, revision: null,
    previousSizeInBytes: Buffer.byteLength("before-delete"), backup: null }]);
  await assert.rejects(fs.access(source));
  const names = await fs.readdir(path.join(data, "history", "committed-delete.md"));
  assert.equal(await fs.readFile(path.join(data, "history", "committed-delete.md", names[0]), "utf-8"), "before-delete");
});

test("a delete and create commit as one batch", async () => {
  const source = path.join(vault, "moved-source.md");
  const destination = path.join(vault, "moved-destination.md");
  await fs.writeFile(source, "moved-content");
  const before = await fileRevision(source);
  const result = await authored(() => atomicWriteBatch([
    { absPath: source, delete: true, ifMatch: before },
    { absPath: destination, data: "moved-content", mustNotExist: true },
  ]));
  assert.equal(result[0].deleted, true);
  assert.equal(result[1].created, true);
  await assert.rejects(fs.access(source));
  assert.equal(await fs.readFile(destination, "utf-8"), "moved-content");
});

test("a committed delete remains deleted after a crash before journal cleanup", async () => {
  const source = path.join(vault, "crashed-committed-delete.md");
  await fs.writeFile(source, "delete-me");
  const before = await fileRevision(source);
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import path from 'node:path';
    await withRequestContext({ author: { agent: 'journal-test', model: 'test' } }, () =>
      atomicWriteBatch([{ absPath: path.join(process.env.VAULT_PATH, 'crashed-committed-delete.md'),
        delete: true, ifMatch: ${JSON.stringify(before)} }],
        { afterCommit: () => process.exit(81) }));
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 81, child.stderr);
  await recoverPendingBatches();
  await assert.rejects(fs.access(source));
  const names = await fs.readdir(path.join(data, "history", "crashed-committed-delete.md"));
  assert.equal(await fs.readFile(path.join(data, "history", "crashed-committed-delete.md", names[0]), "utf-8"), "delete-me");
});

test("startup finishes a committed deletion's Trash backup after a crash", async () => {
  const source = path.join(vault, "crashed-trash-delete.md");
  await fs.writeFile(source, "trash-copy\n");
  const before = await fileRevision(source);
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import path from 'node:path';
    await withRequestContext({ author: { agent: 'journal-test', model: 'test' } }, () =>
      atomicWriteBatch([{ absPath: path.join(process.env.VAULT_PATH, 'crashed-trash-delete.md'),
        delete: true, trash: true, ifMatch: ${JSON.stringify(before)} }],
        { afterCommit: () => process.exit(82) }));
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 82, child.stderr);
  await assert.rejects(fs.access(source));
  await recoverPendingBatches();
  const { listTrashEntries } = await import("../src/vault.js");
  const entry = (await listTrashEntries()).find((item) => item.originalPath === "crashed-trash-delete.md");
  assert.ok(entry);
  assert.equal(await fs.readFile(path.join(data, "trash", entry.backupPath), "utf-8"), "trash-copy\n");
  await assert.rejects(fs.access(source));
});

test("a committed marker survives a crash and finishes history on restart", async () => {
  const target = path.join(vault, "third.md");
  await fs.writeFile(target, "prior");
  const before = await fileRevision(target);
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import path from 'node:path';
    await withRequestContext({ author: { agent: 'journal-test', model: 'test' } }, () =>
      atomicWriteBatch([{ absPath: path.join(process.env.VAULT_PATH, 'third.md'),
        data: 'final', ifMatch: ${JSON.stringify(before)} }],
        { afterCommit: () => process.exit(78) }));
  `;
  const crashed = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(crashed.status, 78, crashed.stderr);
  assert.equal(await fs.readFile(target, "utf-8"), "final");
  await recoverPendingBatches();
  assert.equal(await fs.readFile(target, "utf-8"), "final");
  const names = await fs.readdir(path.join(data, "history", "third.md"));
  assert.equal(names.filter((name) => name.endsWith(".bak")).length, 1);
  assert.equal(await fs.readFile(path.join(data, "history", "third.md", names[0]), "utf-8"), "prior");
});

test("a committed plan replays by key after a process restart", async () => {
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { createNotePlan, applyNotePlan } from './src/mutation-plans.js';
    import { fileRevision } from './src/vault.js';
    import path from 'node:path';
    const target = path.join(process.env.VAULT_PATH, 'third.md');
    const outcome = await withRequestContext({ author: { agent: 'journal-test', model: 'test' } }, async () => {
      const plan = await createNotePlan([{ path: 'third.md', operation: 'append',
        content: 'once-only', baseRevision: await fileRevision(target) }]);
      await applyNotePlan(plan.planId, plan.planHash, 'durable-replay-key-0001');
      return { planId: plan.planId, planHash: plan.planHash };
    });
    console.log(JSON.stringify(outcome));
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 0, child.stderr);
  const plan = JSON.parse(child.stdout.trim());
  const { applyNotePlan } = await import("../src/mutation-plans.js");
  const replay = await authored(() => applyNotePlan(plan.planId, plan.planHash, "durable-replay-key-0001"));
  assert.equal(replay.idempotentReplay, true);
  assert.equal((await fs.readFile(path.join(vault, "third.md"), "utf-8")).match(/once-only/g).length, 1);
  await assert.rejects(
    withRequestContext({ author: { agent: "other-agent", model: "test" } },
      () => applyNotePlan(plan.planId, plan.planHash, "durable-replay-key-0001")),
    /another MCP author/,
  );
});

test("recovery records a committed result when the process dies before replying", async () => {
  const target = path.join(vault, "fourth.md");
  await fs.writeFile(target, "before");
  const before = await fileRevision(target);
  const planId = "00000000-0000-4000-8000-000000000001";
  const planHash = "sha256:" + "a".repeat(64);
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import { idempotencyDigest } from './src/mutation-idempotency.js';
    import path from 'node:path';
    const idempotency = { digest: idempotencyDigest('durable-crash-key-0001'),
      planId: ${JSON.stringify(planId)}, planHash: ${JSON.stringify(planHash)},
      author: { agent: 'journal-test', model: 'test', authClientId: null },
      unchanged: [], appliedAt: new Date().toISOString(), expiresAtMs: Date.now() + 86400000 };
    await withRequestContext({ author: { agent: 'journal-test', model: 'test' } }, () =>
      atomicWriteBatch([{ absPath: path.join(process.env.VAULT_PATH, 'fourth.md'),
        data: 'after', ifMatch: ${JSON.stringify(before)} }],
        { idempotency, afterCommit: () => process.exit(79) }));
  `;
  const child = spawnNodeSync( ["--input-type=module", "-e", script], {
    cwd: path.resolve("."), env: { ...process.env, VAULT_PATH: vault, DATA_PATH: data }, encoding: "utf-8",
  });
  assert.equal(child.status, 79, child.stderr);
  await recoverPendingBatches();
  const { applyNotePlan } = await import("../src/mutation-plans.js");
  const replay = await authored(() => applyNotePlan(planId, planHash, "durable-crash-key-0001"));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.changed[0].revision, await fileRevision(target));
  assert.equal(await fs.readFile(target, "utf-8"), "after");
});

test("concurrent plans cannot reuse one idempotency key for two commits", async () => {
  const { createNotePlan, applyNotePlan } = await import("../src/mutation-plans.js");
  const one = await authored(() => createNotePlan([{ path: "fifth-a.md", operation: "write",
    content: "A", mustNotExist: true }]));
  const two = await authored(() => createNotePlan([{ path: "fifth-b.md", operation: "write",
    content: "B", mustNotExist: true }]));
  const outcomes = await Promise.allSettled([
    authored(() => applyNotePlan(one.planId, one.planHash, "concurrent-key-0001")),
    authored(() => applyNotePlan(two.planId, two.planHash, "concurrent-key-0001")),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  const a = await fs.access(path.join(vault, "fifth-a.md")).then(() => true, () => false);
  const b = await fs.access(path.join(vault, "fifth-b.md")).then(() => true, () => false);
  assert.notEqual(a, b);
});

test("durable replay is bound to the authenticated client", async () => {
  const { createNotePlan, applyNotePlan } = await import("../src/mutation-plans.js");
  const context = (authClientId, callback) => withRequestContext({
    author: { agent: "journal-test", model: "test" }, authClientId,
  }, callback);
  const plan = await context("client-a", () => createNotePlan([{ path: "client-bound.md",
    operation: "write", content: "bound", mustNotExist: true }]));
  await context("client-a", () => applyNotePlan(plan.planId, plan.planHash, "client-bound-key-0001"));
  await assert.rejects(
    context("client-b", () => applyNotePlan(plan.planId, plan.planHash, "client-bound-key-0001")),
    /another MCP author/,
  );
});

test("durable replay is bound to the OAuth user within one client", async () => {
  const { createNotePlan, applyNotePlan } = await import("../src/mutation-plans.js");
  const context = (authUserId, callback) => withRequestContext({
    author: { agent: "journal-test", model: "test" }, authClientId: "shared-client", authUserId,
  }, callback);
  const plan = await context("user-a", () => createNotePlan([{ path: "user-bound.md",
    operation: "write", content: "bound", mustNotExist: true }]));
  await context("user-a", () => applyNotePlan(plan.planId, plan.planHash, "user-bound-key-0001"));
  await assert.rejects(
    context("user-b", () => applyNotePlan(plan.planId, plan.planHash, "user-bound-key-0001")),
    /another MCP author/,
  );
});

test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
