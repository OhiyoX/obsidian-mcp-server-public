import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-idempotency-path-safety-"));
const data = path.join(root, "data");
const outside = path.join(root, "outside");
const idempotencyRoot = path.join(data, "mutation-idempotency");

await fs.mkdir(data, { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.symlink(outside, idempotencyRoot, process.platform === "win32" ? "junction" : "dir");

process.env.DATA_PATH = data;

const {
  idempotencyDigest,
  pruneExpiredAppliedRecords,
  readAppliedRecord,
  saveAppliedRecord,
} = await import("../src/mutation-idempotency.js");

function recordFor(digest, { expiresAtMs = Date.now() + 60_000 } = {}) {
  return {
    digest,
    planId: `plan-${digest.slice(0, 8)}`,
    planHash: `hash-${digest.slice(0, 8)}`,
    author: { agent: "idempotency-path-test", model: "test" },
    result: { applied: true, changed: [], unchanged: [] },
    expiresAtMs,
  };
}

test("prune rejects a mutation-idempotency root that canonically escapes DATA_PATH", async () => {
  const digest = idempotencyDigest("expired-outside-record");
  const file = path.join(outside, `${digest}.json`);
  await fs.writeFile(file, JSON.stringify({ schema: 1, ...recordFor(digest, { expiresAtMs: Date.now() - 1_000 }) }));

  await assert.rejects(
    () => pruneExpiredAppliedRecords(),
    /idempotency storage escapes DATA_PATH/i,
  );

  assert.equal((await fs.stat(file)).isFile(), true);
});

test("read rejects a mutation-idempotency root that canonically escapes DATA_PATH", async () => {
  const digest = idempotencyDigest("read-outside-record");
  const file = path.join(outside, `${digest}.json`);
  const record = recordFor(digest);
  await fs.writeFile(file, JSON.stringify({ schema: 1, ...record }));

  await assert.rejects(
    () => readAppliedRecord(digest),
    /idempotency storage escapes DATA_PATH/i,
  );

  assert.equal((await fs.stat(file)).isFile(), true);
});

test("save rejects a mutation-idempotency root that canonically escapes DATA_PATH without writing outside", async () => {
  const digest = idempotencyDigest("write-outside-record");
  const file = path.join(outside, `${digest}.json`);

  await assert.rejects(
    () => saveAppliedRecord(recordFor(digest)),
    /idempotency storage escapes DATA_PATH/i,
  );

  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  assert.equal(
    (await fs.readdir(outside)).some((name) => name.startsWith(`.${digest}.`) && name.endsWith(".tmp")),
    false,
  );
});

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
