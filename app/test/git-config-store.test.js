// Focused tests for the Wave A / A5 durable per-vault GitConfig store
// (app/src/git-config/store.js). Deterministic: fault injection uses a fake io
// with explicit gates, never sleeps. Contract:
// `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置` §15.3/§15.4, §42 SEC-MV04.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GIT_CONFIG_CODES,
  GIT_CONFIG_LIMITS,
  GIT_CONFIG_RECORD_DEFAULTS,
  GIT_CONFIG_SCHEMA,
  buildGitConfigRecord,
  serializeGitConfigDocument,
} from "../src/git-config/schema.js";
import { createGitConfigStore } from "../src/git-config/store.js";

const DIR = path.join(os.tmpdir(), "git-config-store-fixture");
const FILE = path.join(DIR, "git-vaults.json");
const INSTANT = "2026-10-05T00:00:00.000Z";
const clock = () => new Date(INSTANT);
const expectedRecord = (patch = {}) => ({ ...GIT_CONFIG_RECORD_DEFAULTS, ...patch, updatedAt: INSTANT });

function createFakeIo(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = { stat: [], readFile: [], open: [], sync: [], mkdir: [], rename: [], unlink: [] };
  const failures = {};
  const io = {
    files,
    calls,
    failures,
    async stat(file) {
      calls.stat.push(file);
      if (failures.stat) throw failures.stat;
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return { size: Buffer.byteLength(String(files.get(file)), "utf8") };
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
    async open(file, flags, mode) {
      calls.open.push([file, flags, mode]);
      if (flags === "r" && failures.openDirectory) throw failures.openDirectory;
      if (flags !== "r" && failures.open) throw failures.open;
      return {
        async writeFile(data) {
          if (failures.writeFile) throw failures.writeFile;
          files.set(file, String(data));
        },
        async sync() {
          calls.sync.push(file);
          if (failures.sync) throw failures.sync;
        },
        async close() {
          if (failures.close) throw failures.close;
        },
      };
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

test("a missing file is a ready revision-0 empty store, not an error", async () => {
  const io = createFakeIo();
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  assert.deepEqual(await store.ready, { ok: true, status: "ready", revision: 0 });
  assert.deepEqual(store.snapshot(), { status: "ready", revision: 0, vaults: {} });
  assert.deepEqual(await store.read(), { status: "ready", revision: 0, vaults: {} });
  assert.deepEqual(io.calls.stat, [FILE]);
});

test("real filesystem round trip: 0600, restart-safe, no credential material", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "git-config-store-"));
  const file = path.join(directory, "git-vaults.json");
  try {
    const store = createGitConfigStore({ dataRoot: directory, clock });
    assert.equal(store.file, file, "dataRoot derives <dataRoot>/git-vaults.json");
    assert.equal((await store.read()).revision, 0);
    assert.deepEqual(
      await store.upsertVault("vault", { enabled: true, debounceSeconds: 30 }, { expectedRevision: 0 }),
      { ok: true, revision: 1 },
    );
    const payload = await readFile(file, "utf8");
    assert.match(payload, /"schema": 1/);
    assert.match(payload, /"revision": 1/);
    assert.deepEqual(JSON.parse(payload).vaults.vault, expectedRecord({ enabled: true, debounceSeconds: 30 }));
    assert.doesNotMatch(payload, /token|password|secret|userinfo|@/i, "SEC-MV04: the store holds no credentials");
    if (process.platform === "win32") {
      console.log("SKIP 0600 assertion: win32 has no POSIX mode bits (documented best-effort)");
    } else {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    const restarted = createGitConfigStore({ dataRoot: directory, clock });
    assert.deepEqual(await restarted.read(), {
      status: "ready",
      revision: 1,
      vaults: { vault: expectedRecord({ enabled: true, debounceSeconds: 30 }) },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every mutation bumps the revision by exactly one and persists the document", async () => {
  const io = createFakeIo();
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  await store.read();
  assert.deepEqual(await store.upsertVault("vault", {}, { expectedRevision: 0 }), { ok: true, revision: 1 });
  assert.deepEqual(await store.upsertVault("other", { enabled: true }, { expectedRevision: 1 }), { ok: true, revision: 2 });
  assert.deepEqual(await store.upsertVault("vault", { autoCommit: true }, { expectedRevision: 2 }), { ok: true, revision: 3 });
  assert.deepEqual(await store.removeVault("other", { expectedRevision: 3 }), { ok: true, revision: 4 });
  const committed = JSON.parse(io.files.get(FILE));
  assert.equal(committed.schema, GIT_CONFIG_SCHEMA);
  assert.equal(committed.revision, 4);
  assert.deepEqual(Object.keys(committed.vaults), ["vault"]);
  assert.deepEqual(committed.vaults.vault, expectedRecord({ autoCommit: true }));
  // The upsert merged the patch over defaults and stamped `updatedAt` from the
  // injected clock, not from the patch.
  assert.equal((await store.upsertVault("vault", { updatedAt: "2000-01-01T00:00:00.000Z" }, { expectedRevision: 4 })).ok, true);
  assert.equal(io.files.get(FILE).includes("2000-01-01"), false);
  assert.equal(JSON.parse(io.files.get(FILE)).vaults.vault.updatedAt, INSTANT);
});

test("write() replaces the whole map and validates complete records", async () => {
  const io = createFakeIo();
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  await store.read();
  const full = { alpha: buildGitConfigRecord({ patch: { enabled: true }, updatedAt: INSTANT }) };
  assert.deepEqual(await store.write(full, { expectedRevision: 0 }), { ok: true, revision: 1 });
  assert.deepEqual(store.snapshot().vaults, full);
  assert.deepEqual(await store.write({}, { expectedRevision: 1 }), { ok: true, revision: 2 });
  assert.deepEqual(store.snapshot().vaults, {});
  const partial = await store.write({ bad: { enabled: true } }, { expectedRevision: 2 });
  assert.equal(partial.ok, false);
  assert.equal(partial.code, GIT_CONFIG_CODES.INVALID_RECORD);
  assert.equal(store.snapshot().revision, 2, "an invalid candidate never becomes committed state");
});

test("CAS conflict is an explicit structure and never a last-write-wins overwrite", async () => {
  const io = createFakeIo();
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  await store.read();
  await store.upsertVault("vault", { enabled: true }, { expectedRevision: 0 });
  const committed = io.files.get(FILE);
  const opens = io.calls.open.length;
  const stale = { ok: false, code: GIT_CONFIG_CODES.STALE_REVISION, current: { status: "ready", revision: 1 } };
  assert.deepEqual(await store.upsertVault("vault", { enabled: false }, { expectedRevision: 0 }), stale);
  assert.deepEqual(await store.removeVault("vault", { expectedRevision: 0 }), stale);
  assert.deepEqual(await store.write({}, { expectedRevision: 0 }), stale);
  assert.deepEqual(await store.upsertVault("vault", {}, {}), stale, "a missing expectedRevision is stale, not implicit");
  assert.deepEqual(store.snapshot().vaults, { vault: expectedRecord({ enabled: true }) });
  assert.equal(io.files.get(FILE), committed, "the file is untouched by a rejected writer");
  assert.equal(io.calls.open.length, opens, "a rejected writer performs no I/O");
  assert.deepEqual(await store.upsertVault("vault", { enabled: false }, { expectedRevision: 1 }), { ok: true, revision: 2 });
});

test("a corrupt file fails closed on read, and mutations never reset it", async (t) => {
  const cases = [
    ["garbage JSON", "{ nope", GIT_CONFIG_CODES.INVALID_DOCUMENT],
    ["unsupported schema", JSON.stringify({ schema: 2, revision: 0, vaults: {} }), GIT_CONFIG_CODES.UNSUPPORTED_SCHEMA],
    ["unknown document key", JSON.stringify({ schema: 1, revision: 0, vaults: {}, extra: 1 }), GIT_CONFIG_CODES.INVALID_DOCUMENT],
    ["unknown record field", JSON.stringify({ schema: 1, revision: 0, vaults: { vault: { ...expectedRecord(), token: "x" } } }), GIT_CONFIG_CODES.INVALID_RECORD],
    ["oversize document", "x".repeat(GIT_CONFIG_LIMITS.fileBytes + 1), GIT_CONFIG_CODES.LIMIT_EXCEEDED],
  ];
  for (const [name, text, code] of cases) {
    await t.test(name, async () => {
      const io = createFakeIo({ [FILE]: text });
      const store = createGitConfigStore({ filePath: FILE, io, clock });
      await store.ready;
      const snapshot = store.snapshot();
      assert.equal(snapshot.status, "broken");
      assert.equal(snapshot.revision, null);
      assert.deepEqual(snapshot.vaults, {});
      assert.equal(snapshot.errorCode, code);
      await assert.rejects(store.read(), (error) => {
        assert.equal(error.code, code);
        assert.match(error.message, /not readable/);
        return true;
      });
      const mutation = await store.upsertVault("vault", { enabled: true }, { expectedRevision: 0 });
      assert.deepEqual(mutation, { ok: false, code, current: { status: "broken", revision: null } });
      assert.equal(io.files.get(FILE), text, "the corrupt file is preserved verbatim, never reset");
      assert.equal(io.calls.open.length, 0, "no write was attempted");
    });
  }
  await t.test("unreadable file", async () => {
    const io = createFakeIo({ [FILE]: "{}" });
    io.failures.readFile = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const store = createGitConfigStore({ filePath: FILE, io, clock });
    await store.ready;
    assert.equal(store.snapshot().errorCode, GIT_CONFIG_CODES.STORE_IO);
    await assert.rejects(store.read(), (error) => error.code === GIT_CONFIG_CODES.STORE_IO);
  });
});

test("a corrupt real file stays byte-identical after a failed read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "git-config-corrupt-"));
  const file = path.join(directory, "git-vaults.json");
  const garbage = '{"schema":1,"revision":3,"vaults":{"vault":{"enabled":';
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, garbage, "utf8");
    const store = createGitConfigStore({ filePath: file, clock });
    await assert.rejects(store.read(), (error) => error.code === GIT_CONFIG_CODES.INVALID_DOCUMENT);
    assert.equal(await readFile(file, "utf8"), garbage);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable write is temp + fsync + atomic rename with 0600 and 0700", async () => {
  const io = createFakeIo();
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  await store.read();
  assert.deepEqual(await store.upsertVault("vault", { enabled: true }, { expectedRevision: 0 }), { ok: true, revision: 1 });
  const [temp, flags, mode] = io.calls.open[0];
  assert.equal(flags, "w");
  assert.equal(mode, 0o600);
  assert.equal(path.dirname(temp), DIR);
  assert.match(path.basename(temp), /^\.git-vaults\.\d+-[0-9a-f]{12}\.tmp$/);
  assert.deepEqual(io.calls.mkdir, [[DIR, { recursive: true, mode: 0o700 }]]);
  assert.deepEqual(io.calls.sync[0], temp, "the temp file is fsynced before the rename");
  assert.deepEqual(io.calls.rename, [[temp, FILE]]);
  assert.equal(io.calls.open[1][0], DIR, "the directory fsync is attempted best-effort");
  assert.deepEqual(io.files.get(FILE), serializeGitConfigDocument({ schema: GIT_CONFIG_SCHEMA, revision: 1, vaults: { vault: expectedRecord({ enabled: true }) } }));
});

test("every persist failure point leaves committed state and the file intact", async (t) => {
  for (const point of ["open", "writeFile", "sync", "rename"]) {
    await t.test(point, async () => {
      const io = createFakeIo();
      const store = createGitConfigStore({ filePath: FILE, io, clock });
      await store.read();
      await store.upsertVault("vault", { enabled: true }, { expectedRevision: 0 });
      const committed = io.files.get(FILE);
      const revision = store.snapshot().revision;
      io.failures[point] = Object.assign(new Error(`EIO:${point}`), { code: "EIO" });
      assert.deepEqual(
        await store.upsertVault("vault", { enabled: false }, { expectedRevision: 1 }),
        { ok: false, code: GIT_CONFIG_CODES.STORE_IO, current: { status: "ready", revision } },
      );
      assert.equal(store.snapshot().revision, revision);
      assert.deepEqual(store.snapshot().vaults, { vault: expectedRecord({ enabled: true }) });
      assert.equal(io.files.get(FILE), committed);
      if (point !== "open") {
        const temp = io.calls.open.at(-1)[0];
        assert.ok(io.calls.unlink.includes(temp), `temp ${temp} must be unlinked`);
        assert.equal(io.files.has(temp), false);
      }
    });
  }
});

test("a directory fsync failure is non-fatal (Windows posture)", async () => {
  const io = createFakeIo();
  io.failures.openDirectory = Object.assign(new Error("EISDIR"), { code: "EISDIR" });
  const messages = [];
  const store = createGitConfigStore({ filePath: FILE, io, clock, logger: { debug: (message) => messages.push(message) } });
  await store.read();
  assert.deepEqual(await store.upsertVault("vault", { enabled: true }, { expectedRevision: 0 }), { ok: true, revision: 1 });
  assert.equal(store.snapshot().revision, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /directory fsync unavailable \(EISDIR\)/);
});

test("a leftover temp file never becomes committed state", async () => {
  const io = createFakeIo({
    [FILE]: serializeGitConfigDocument({ schema: GIT_CONFIG_SCHEMA, revision: 4, vaults: { vault: expectedRecord() } }),
    [path.join(DIR, ".git-vaults.999-deadbeef1234.tmp")]: "garbage",
  });
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  assert.equal((await store.read()).revision, 4);
  assert.deepEqual(store.snapshot().vaults, { vault: expectedRecord() });
});

test("the registry bound fails closed instead of truncating", async () => {
  const io = createFakeIo();
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  await store.read();
  const record = buildGitConfigRecord({ updatedAt: INSTANT });
  const over = Object.fromEntries(Array.from({ length: GIT_CONFIG_LIMITS.maxVaultRecords + 1 }, (_, index) => [`vault-${index}`, record]));
  const result = await store.write(over, { expectedRevision: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_CONFIG_CODES.LIMIT_EXCEEDED);
  assert.equal(store.snapshot().revision, 0);
  assert.equal(io.files.has(FILE), false);
  const full = Object.fromEntries(Array.from({ length: GIT_CONFIG_LIMITS.maxVaultRecords }, (_, index) => [`vault-${index}`, record]));
  assert.deepEqual(await store.write(full, { expectedRevision: 0 }), { ok: true, revision: 1 });
});

test("credential-shaped fields are rejected before any I/O (SEC-MV04)", async () => {
  const io = createFakeIo();
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  await store.read();
  for (const patch of [{ token: "x" }, { password: "x" }, { credential: "x" }, { remote: "https://x:y@host/r.git" }, { remote: "git@host:r.git" }, { remote: "-oProxyCommand=touch /tmp/pwned" }]) {
    const result = await store.upsertVault("vault", patch, { expectedRevision: 0 });
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.ok([GIT_CONFIG_CODES.INVALID_RECORD].includes(result.code), result.code);
  }
  assert.equal(io.calls.open.length, 0);
  assert.equal(io.files.has(FILE), false);
});

test("an invalid vaultId is rejected without touching the store", async () => {
  const io = createFakeIo();
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  await store.read();
  for (const vaultId of ["", ".", "..", "a/b", "a".repeat(81)]) {
    const result = await store.upsertVault(vaultId, {}, { expectedRevision: 0 });
    assert.deepEqual(result, { ok: false, code: GIT_CONFIG_CODES.INVALID_VAULT_ID, current: { status: "ready", revision: 0 } });
    assert.deepEqual(await store.removeVault(vaultId, { expectedRevision: 0 }), result);
  }
  assert.equal(io.calls.open.length, 0);
});

test("same-revision concurrent writers: exactly one commits", async () => {
  const io = createFakeIo();
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  await store.read();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const open = io.open.bind(io);
  let first = true;
  io.open = async (file, flags, mode) => {
    if (flags !== "r" && first) {
      first = false;
      await gate;
    }
    return open(file, flags, mode);
  };
  const results = Promise.all([
    store.upsertVault("alpha", { enabled: true }, { expectedRevision: 0 }),
    store.upsertVault("beta", { enabled: true }, { expectedRevision: 0 }),
  ]);
  release();
  const [a, b] = await results;
  assert.equal([a, b].filter((result) => result.ok).length, 1);
  assert.equal([a, b].find((result) => !result.ok).code, GIT_CONFIG_CODES.STALE_REVISION);
  assert.equal(store.snapshot().revision, 1);
  assert.equal(Object.keys(store.snapshot().vaults).length, 1);
});

test("drain() waits for in-flight writes", async () => {
  const io = createFakeIo();
  const store = createGitConfigStore({ filePath: FILE, io, clock });
  await store.read();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const open = io.open.bind(io);
  io.open = async (file, flags, mode) => {
    if (flags !== "r") await gate;
    return open(file, flags, mode);
  };
  const pending = store.upsertVault("vault", { enabled: true }, { expectedRevision: 0 });
  let drained = false;
  const drainedPromise = store.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false, "drain must not resolve while a write is in flight");
  release();
  assert.deepEqual(await pending, { ok: true, revision: 1 });
  await drainedPromise;
  assert.equal(drained, true);
});
