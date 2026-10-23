// Focused tests for AuthZ Wave A / A3 durable access-policy store
// (app/src/access-policy/store.js). Deterministic: fault injection uses a fake
// io + explicit gates, never sleeps. Contract: scratch/authz/INTERFACE.md §8.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACCESS_POLICY_LIMITS,
  newPolicyId,
  parseAccessPolicyDocument,
  serializeAccessPolicyDocument,
} from "../src/access-policy/schema.js";
import { createAccessPolicyStore } from "../src/access-policy/store.js";

const DIR = path.join(os.tmpdir(), "access-policy-store-fixture");
const FILE = path.join(DIR, "access-policy.json");

function validPolicy(overrides = {}) {
  return {
    id: newPolicyId(),
    label: "work hours",
    enabled: true,
    subjects: ["oauth-user:u1"],
    mode: "suspend",
    capabilities: ["scope:obsidian.write"],
    timezone: "Asia/Shanghai",
    weekly: { mon: [["09:00", "18:00"]] },
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

function documentOf(revision, policies) {
  return { schemaVersion: 1, revision, policies };
}

function createFakeIo(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = { stat: [], readFile: [], writeFile: [], rename: [], mkdir: [], unlink: [] };
  const failures = {};
  const io = {
    files,
    calls,
    failures,
    async stat(file) {
      calls.stat.push(file);
      if (failures.stat) throw failures.stat;
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return { size: Buffer.byteLength(files.get(file), "utf8") };
    },
    async readFile(file) {
      calls.readFile.push(file);
      if (failures.readFile) throw failures.readFile;
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return files.get(file);
    },
    async mkdir(directory, options) {
      calls.mkdir.push([directory, options]);
      if (failures.mkdir) throw failures.mkdir;
    },
    async writeFile(file, data, options) {
      calls.writeFile.push([file, data, options]);
      if (failures.writeFile) throw failures.writeFile;
      files.set(file, data);
    },
    async rename(from, to) {
      calls.rename.push([from, to]);
      if (failures.rename) throw failures.rename;
      files.set(to, files.get(from));
      files.delete(from);
    },
    async unlink(file) {
      calls.unlink.push(file);
      if (failures.unlink) throw failures.unlink;
      files.delete(file);
    },
  };
  return io;
}

test("a missing file is a ready revision-0 empty store", async () => {
  const store = createAccessPolicyStore({ file: FILE, io: createFakeIo() });
  assert.deepEqual(await store.ready, { ok: true, status: "ready", revision: 0 });
  assert.deepEqual(store.snapshot(), { status: "ready", revision: 0, policies: [] });
});

test("a valid file loads ready with its policies", async () => {
  const policy = validPolicy();
  const io = createFakeIo({ [FILE]: serializeAccessPolicyDocument(documentOf(7, [policy])) });
  const store = createAccessPolicyStore({ file: FILE, io });
  assert.deepEqual(await store.ready, { ok: true, status: "ready", revision: 7 });
  assert.equal(store.snapshot().revision, 7);
  assert.deepEqual(store.snapshot().policies, [policy]);
});

test("persisted policies survive a store restart", async () => {
  const io = createFakeIo();
  const first = createAccessPolicyStore({ file: FILE, io });
  await first.ready;
  await first.replace(0, [validPolicy()]);
  const second = createAccessPolicyStore({ file: FILE, io });
  await second.ready;
  assert.equal(second.snapshot().revision, 1);
  assert.deepEqual(second.snapshot().policies, first.snapshot().policies);
});

test("invalid files are broken, never an empty policy set", async (t) => {
  const cases = [
    ["corrupt JSON", "{ nope", "invalid_access_policy"],
    ["unsupported schema", JSON.stringify({ schemaVersion: 2, revision: 0, policies: [] }), "unsupported_access_policy_schema"],
    ["unknown field", JSON.stringify({ schemaVersion: 1, revision: 0, policies: [], extra: 1 }), "invalid_access_policy"],
    ["too many policies", JSON.stringify(documentOf(0, Array.from({ length: 513 }, () => validPolicy()))), "access_policy_limit_exceeded"],
    ["oversize file", "x".repeat(ACCESS_POLICY_LIMITS.fileBytes + 1), "access_policy_limit_exceeded"],
  ];
  for (const [name, text, code] of cases) {
    await t.test(name, async () => {
      const store = createAccessPolicyStore({ file: FILE, io: createFakeIo({ [FILE]: text }) });
      const ready = await store.ready;
      assert.equal(ready.ok, false);
      assert.equal(ready.status, "broken");
      assert.equal(ready.revision, null);
      assert.equal(ready.errorCode, code);
      const snapshot = store.snapshot();
      assert.equal(snapshot.status, "broken");
      assert.equal(snapshot.revision, null);
      assert.deepEqual(snapshot.policies, []);
      assert.equal(snapshot.errorCode, code);
    });
  }
  await t.test("unreadable file", async () => {
    const io = createFakeIo({ [FILE]: "{}" });
    io.failures.readFile = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const store = createAccessPolicyStore({ file: FILE, io });
    assert.equal((await store.ready).errorCode, "access_policy_store_io_error");
    assert.equal(store.snapshot().status, "broken");
  });
});

test("replace commits the next revision through an atomic 0600 temp", async () => {
  const io = createFakeIo();
  const store = createAccessPolicyStore({ file: FILE, io });
  await store.ready;
  const policy = validPolicy();
  assert.deepEqual(await store.replace(0, [policy]), { ok: true, revision: 1 });
  assert.equal(store.snapshot().revision, 1);
  assert.deepEqual(store.snapshot().policies, [policy]);

  const [temp, payload, options] = io.calls.writeFile[0];
  assert.deepEqual(options, { mode: 0o600 });
  assert.equal(path.dirname(temp), DIR);
  assert.match(path.basename(temp), /^\.access-policy\.\d+-[0-9a-f]+\.tmp$/);
  assert.deepEqual(io.calls.rename, [[temp, FILE]]);
  assert.deepEqual(io.calls.mkdir, [[DIR, { recursive: true, mode: 0o700 }]]);
  // Durable content and committed memory are the same document.
  assert.equal(io.files.get(FILE), payload);
  const reloaded = parseAccessPolicyDocument(payload);
  assert.equal(reloaded.ok, true);
  assert.deepEqual(reloaded.document, { schemaVersion: 1, revision: 1, policies: store.snapshot().policies });
});

test("on a real filesystem the policy file is 0600 (POSIX) and parses back", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "access-policy-store-"));
  const file = path.join(directory, "access-policy.json");
  try {
    const store = createAccessPolicyStore({ file });
    await store.ready;
    const policy = validPolicy();
    assert.deepEqual(await store.replace(0, [policy]), { ok: true, revision: 1 });
    assert.deepEqual(parseAccessPolicyDocument(await readFile(file, "utf8")).document.policies, [policy]);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale revisions are rejected without touching memory or disk", async () => {
  const io = createFakeIo();
  const store = createAccessPolicyStore({ file: FILE, io });
  await store.ready;
  const first = validPolicy();
  await store.replace(0, [first]);
  const committed = io.files.get(FILE);
  const stale = await store.replace(0, [validPolicy()]);
  assert.deepEqual(stale, { ok: false, code: "stale_policy_revision", current: { status: "ready", revision: 1 } });
  assert.equal(store.snapshot().revision, 1);
  assert.deepEqual(store.snapshot().policies, [first]);
  assert.equal(io.files.get(FILE), committed);
});

test("writes against a broken store are stale", async () => {
  const store = createAccessPolicyStore({ file: FILE, io: createFakeIo({ [FILE]: "{ nope" }) });
  await store.ready;
  assert.deepEqual(await store.replace(0, [validPolicy()]), {
    ok: false, code: "stale_policy_revision", current: { status: "broken", revision: null },
  });
});

test("mutate validates the callback result and bumps the revision", async () => {
  const io = createFakeIo();
  const store = createAccessPolicyStore({ file: FILE, io });
  await store.ready;
  const first = validPolicy();
  const second = validPolicy();
  await store.replace(0, [first]);
  assert.deepEqual(await store.mutate(1, (policies) => [...policies, second]), { ok: true, revision: 2 });
  assert.deepEqual(store.snapshot().policies, [first, second]);
  await assert.rejects(store.mutate(2, "not a function"), TypeError);
});

test("an invalid mutation candidate leaves memory and disk unchanged", async () => {
  const io = createFakeIo();
  const store = createAccessPolicyStore({ file: FILE, io });
  await store.ready;
  await store.replace(0, [validPolicy()]);
  const committed = io.files.get(FILE);
  const writes = io.calls.writeFile.length;
  const result = await store.mutate(1, () => [{ id: "not-a-uuid" }]);
  assert.deepEqual(result, { ok: false, code: "invalid_access_policy_record", current: { status: "ready", revision: 1 } });
  assert.equal(store.snapshot().revision, 1);
  assert.equal(io.files.get(FILE), committed);
  assert.equal(io.calls.writeFile.length, writes);
});

test("a throwing mutation callback rejects and leaves state unchanged", async () => {
  const io = createFakeIo();
  const store = createAccessPolicyStore({ file: FILE, io });
  await store.ready;
  await store.replace(0, [validPolicy()]);
  await assert.rejects(store.mutate(1, () => { throw new Error("boom"); }), /boom/);
  assert.equal(store.snapshot().revision, 1);
  assert.deepEqual(store.snapshot().policies.length, 1);
});

test("same-revision concurrent writers: exactly one commits", async () => {
  const io = createFakeIo();
  const store = createAccessPolicyStore({ file: FILE, io });
  await store.ready;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = io.writeFile.bind(io);
  let first = true;
  io.writeFile = async (file, data, options) => {
    if (first) { first = false; await gate; }
    return write(file, data, options);
  };
  const results = Promise.all([store.replace(0, [validPolicy()]), store.replace(0, [validPolicy()])]);
  release();
  const [a, b] = await results;
  assert.equal([a, b].filter((result) => result.ok).length, 1);
  assert.equal(b.code, "stale_policy_revision");
  assert.equal(store.snapshot().revision, 1);
});

test("a failed temp write keeps the previous snapshot and cleans up", async () => {
  const io = createFakeIo();
  const store = createAccessPolicyStore({ file: FILE, io });
  await store.ready;
  const first = validPolicy();
  await store.replace(0, [first]);
  const committed = io.files.get(FILE);
  io.failures.writeFile = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
  assert.deepEqual(await store.replace(1, [validPolicy()]), {
    ok: false, code: "access_policy_store_io_error", current: { status: "ready", revision: 1 },
  });
  assert.equal(store.snapshot().revision, 1);
  assert.deepEqual(store.snapshot().policies, [first]);
  assert.equal(io.files.get(FILE), committed);
  assert.ok(io.calls.unlink.includes(io.calls.writeFile.at(-1)[0]), "temp must be unlinked");
});

test("a failed rename keeps the previous snapshot and cleans up the temp", async () => {
  const io = createFakeIo();
  const store = createAccessPolicyStore({ file: FILE, io });
  await store.ready;
  const first = validPolicy();
  await store.replace(0, [first]);
  const committed = io.files.get(FILE);
  io.failures.rename = Object.assign(new Error("EIO"), { code: "EIO" });
  assert.equal((await store.replace(1, [validPolicy()])).code, "access_policy_store_io_error");
  assert.equal(store.snapshot().revision, 1);
  assert.deepEqual(store.snapshot().policies, [first]);
  assert.equal(io.files.get(FILE), committed);
  const temp = io.calls.writeFile.at(-1)[0];
  assert.ok(io.calls.unlink.includes(temp));
  assert.equal(io.files.has(temp), false);
});

test("a leftover temp file does not become committed state", async () => {
  const policy = validPolicy();
  const io = createFakeIo({
    [FILE]: serializeAccessPolicyDocument(documentOf(4, [policy])),
    [path.join(DIR, ".access-policy.999-deadbeef.tmp")]: "garbage",
  });
  const store = createAccessPolicyStore({ file: FILE, io });
  assert.equal((await store.ready).ok, true);
  assert.equal(store.snapshot().revision, 4);
  assert.deepEqual(store.snapshot().policies, [policy]);
});

test("repairBroken writes a valid document and clears the broken state", async () => {
  const io = createFakeIo({ [FILE]: "{ nope" });
  const store = createAccessPolicyStore({ file: FILE, io });
  await store.ready;
  assert.equal(store.snapshot().status, "broken");
  const policy = validPolicy();
  assert.deepEqual(await store.repairBroken({ policies: [policy] }), { ok: true, revision: 1 });
  const snapshot = store.snapshot();
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.errorCode, undefined);
  assert.deepEqual(snapshot.policies, [policy]);
  assert.deepEqual(parseAccessPolicyDocument(io.files.get(FILE)).document.policies, [policy]);
});

test("a failed or invalid repair keeps the store broken", async (t) => {
  await t.test("io failure", async () => {
    const io = createFakeIo({ [FILE]: "{ nope" });
    io.failures.rename = Object.assign(new Error("EIO"), { code: "EIO" });
    const store = createAccessPolicyStore({ file: FILE, io });
    await store.ready;
    const result = await store.repairBroken({ policies: [validPolicy()] });
    assert.equal(result.code, "access_policy_store_io_error");
    assert.equal(store.snapshot().status, "broken");
    assert.equal(store.snapshot().revision, null);
    assert.deepEqual(store.snapshot().policies, []);
  });
  await t.test("invalid candidate", async () => {
    const store = createAccessPolicyStore({ file: FILE, io: createFakeIo({ [FILE]: "{ nope" }) });
    await store.ready;
    const result = await store.repairBroken({ policies: [{ id: "bad" }] });
    assert.equal(result.code, "invalid_access_policy_record");
    assert.equal(store.snapshot().status, "broken");
  });
});

test("snapshot() exposes frozen, non-mutable state", async () => {
  const store = createAccessPolicyStore({ file: FILE, io: createFakeIo() });
  await store.ready;
  await store.replace(0, [validPolicy()]);
  const snapshot = store.snapshot();
  assert.equal(Object.isFrozen(snapshot.policies), true);
  assert.equal(Object.isFrozen(snapshot.policies[0]), true);
  assert.throws(() => snapshot.policies.push({}), TypeError);
  assert.throws(() => { snapshot.policies[0].label = "changed"; }, TypeError);
  assert.equal(store.snapshot().policies.length, 1);
  assert.notEqual(store.snapshot().policies[0].label, "changed");
});

test("drain() waits for in-flight writes", async () => {
  const io = createFakeIo();
  const store = createAccessPolicyStore({ file: FILE, io });
  await store.ready;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = io.writeFile.bind(io);
  io.writeFile = async (file, data, options) => {
    await gate;
    return write(file, data, options);
  };
  const pending = store.replace(0, [validPolicy()]);
  let drained = false;
  const drainedPromise = store.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false, "drain must not resolve while a write is in flight");
  release();
  assert.deepEqual(await pending, { ok: true, revision: 1 });
  await drainedPromise;
  assert.equal(drained, true);
});
