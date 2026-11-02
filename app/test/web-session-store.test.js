import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_WEB_SESSION_FILE_BYTES,
  WEB_SESSION_CHECKPOINT_MS,
  WEB_SESSION_SCHEMA_VERSION,
  WebSessionStoreError,
  createWebSessionStore,
  hashWebSessionToken,
  isValidWebSessionToken,
  resolveWebSession,
} from "../src/app/web-session-store.js";

const RAW_TOKEN = "A".repeat(43);
const OTHER_TOKEN = Buffer.alloc(32, 7).toString("base64url");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** io wrapper whose current tmp-file write can be held at an entered barrier. */
function barrierIo() {
  const state = { blockNext: false, entered: deferred(), release: deferred() };
  const io = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      return {
        writeFile: async (...values) => {
          if (state.blockNext) {
            state.blockNext = false;
            state.entered.resolve();
            await state.release.promise;
          }
          return handle.writeFile(...values);
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  };
  return { io, state };
}

function makeClock(start = 1_000_000) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms) => { state.t += ms; }, state };
}

function validRecord(overrides = {}) {
  const now = 1_000_000;
  return {
    userId: "user-1",
    userUpdatedAt: "2026-10-03T00:00:00.000Z",
    csrf: "c".repeat(43),
    vaultId: "default",
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + 8 * 60 * 60 * 1000,
    ...overrides,
  };
}

async function tempDir(prefix = "obsidian-web-session-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readyStore(file, options = {}) {
  const store = createWebSessionStore({ file, ...options });
  await store.ready;
  return store;
}

test("ENOENT is an empty store and does not create a file until the first write", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "web", "sessions.json");
  const store = await readyStore(file);
  assert.equal(store.activeCount(), 0);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  await fs.rm(dir, { recursive: true, force: true });
});

test("corrupt JSON fails closed instead of resetting to an empty store", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  await fs.writeFile(file, "{ not json");
  await assert.rejects(readyStore(file), (error) => error instanceof WebSessionStoreError && error.code === "corrupt_json");
  assert.equal(await fs.readFile(file, "utf8"), "{ not json");
  await fs.rm(dir, { recursive: true, force: true });
});

test("unsupported schema version and malformed records fail closed", async () => {
  const dir = await tempDir();
  const cases = [
    { version: 2, sessions: {} },
    { version: WEB_SESSION_SCHEMA_VERSION, sessions: [] },
    { version: WEB_SESSION_SCHEMA_VERSION, sessions: { nothex: validRecord() } },
    { version: WEB_SESSION_SCHEMA_VERSION, sessions: { [hashWebSessionToken(RAW_TOKEN)]: { ...validRecord(), extra: "x" } } },
    { version: WEB_SESSION_SCHEMA_VERSION, sessions: { [hashWebSessionToken(RAW_TOKEN)]: { ...validRecord(), csrf: undefined } } },
    { version: WEB_SESSION_SCHEMA_VERSION, sessions: { [hashWebSessionToken(RAW_TOKEN)]: { ...validRecord(), lastSeenAt: 999 } } },
  ];
  for (const [index, payload] of cases.entries()) {
    const file = path.join(dir, `case-${index}.json`);
    await fs.writeFile(file, JSON.stringify(payload));
    await assert.rejects(readyStore(file), (error) => error instanceof WebSessionStoreError, `case ${index}`);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("oversized state files fail closed at startup", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  await fs.writeFile(file, JSON.stringify({ version: WEB_SESSION_SCHEMA_VERSION, sessions: {}, pad: "x".repeat(4096) }));
  await assert.rejects(readyStore(file, { maxFileBytes: 1024 }), (error) => error instanceof WebSessionStoreError && error.code === "file_too_large");
  await fs.rm(dir, { recursive: true, force: true });
});

test("active records beyond the cap fail closed and expired records are pruned at load", async () => {
  const clock = makeClock(2_000_000);
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const expired = validRecord({ createdAt: 1, lastSeenAt: 1, expiresAt: 2 });
  const active = validRecord();
  const sessions = {};
  for (let index = 0; index < 3; index += 1) sessions[hashWebSessionToken(String(index).padEnd(43, "B"))] = { ...active };
  sessions[hashWebSessionToken("Z".repeat(43))] = { ...expired };
  await fs.writeFile(file, JSON.stringify({ version: WEB_SESSION_SCHEMA_VERSION, sessions }));
  await assert.rejects(readyStore(file, { now: clock.now, maxRecords: 2 }), (error) => error instanceof WebSessionStoreError && error.code === "too_many_records");
  const store = await readyStore(file, { now: clock.now, maxRecords: 3 });
  assert.equal(store.activeCount(), 3);
  await fs.rm(dir, { recursive: true, force: true });
});

test("create persists only hashed keys and the allowed record fields, and Linux mode is 0600", async (t) => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "web", "sessions.json");
  const store = await readyStore(file, { now: clock.now });
  const created = await store.createSession(RAW_TOKEN, validRecord());
  assert.equal(created.ok, true);
  const raw = await fs.readFile(file, "utf8");
  assert.equal(raw.includes(RAW_TOKEN), false);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, WEB_SESSION_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(parsed.sessions), [hashWebSessionToken(RAW_TOKEN)]);
  assert.deepEqual(Object.keys(parsed.sessions[hashWebSessionToken(RAW_TOKEN)]).sort(), ["createdAt", "csrf", "expiresAt", "lastSeenAt", "userId", "userUpdatedAt", "vaultId"]);
  assert.equal(raw.includes("allowedScopes"), false);
  assert.equal(raw.includes("allowedVaults"), false);
  assert.equal(raw.includes("bearer"), false);
  if (process.platform !== "win32") {
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
  } else {
    t.diagnostic("POSIX mode assertion skipped on win32; Linux gate asserts 0600");
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("a failed durable create leaves no committed memory session and the queue recovers", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  let failNext = true;
  const io = {
    ...fs,
    open: async (...args) => {
      if (failNext) {
        failNext = false;
        const error = new Error("simulated ENOSPC");
        error.code = "ENOSPC";
        throw error;
      }
      return fs.open(...args);
    },
  };
  const store = await readyStore(file, { now: clock.now, io });
  const failed = await store.createSession(RAW_TOKEN, validRecord());
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "persist");
  assert.equal(store.snapshot(RAW_TOKEN), null);
  const recovered = await store.createSession(RAW_TOKEN, validRecord());
  assert.equal(recovered.ok, true);
  assert.equal(store.snapshot(RAW_TOKEN).version, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a failed foreground update keeps the previous committed record and a later checkpoint succeeds", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  let failNext = false;
  const io = {
    ...fs,
    rename: async (...args) => {
      if (failNext) {
        failNext = false;
        const error = new Error("simulated EIO");
        error.code = "EIO";
        throw error;
      }
      return fs.rename(...args);
    },
  };
  const store = await readyStore(file, { now: clock.now, io });
  await store.createSession(RAW_TOKEN, validRecord());
  const snapshot = store.snapshot(RAW_TOKEN);
  failNext = true;
  const updated = await store.updateIfCurrent(snapshot.tokenHash, snapshot.version, (record) => ({ ...record, vaultId: "other" }));
  assert.equal(updated.ok, false);
  assert.equal(store.snapshot(RAW_TOKEN).record.vaultId, "default");
  const checkpoint = await store.checkpoint();
  assert.equal(checkpoint.ok, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("logout denies immediately even when the durable delete fails, and the dirty deletion is retried", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  let failNext = false;
  const io = {
    ...fs,
    open: async (...args) => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
      }
      return fs.open(...args);
    },
  };
  const store = await readyStore(file, { now: clock.now, io });
  await store.createSession(RAW_TOKEN, validRecord());
  failNext = true;
  const revoked = await store.revoke(RAW_TOKEN);
  assert.equal(revoked.ok, false);
  assert.equal(store.snapshot(RAW_TOKEN), null);
  const afterFailure = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(Object.keys(afterFailure.sessions).length, 1);
  const retry = await store.checkpoint();
  assert.equal(retry.ok, true);
  const afterRetry = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(Object.keys(afterRetry.sessions).length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("request-side overdue fence: no checkpoint before the window, required at the window", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const store = await readyStore(file, { now: clock.now });
  await store.createSession(RAW_TOKEN, validRecord());
  const first = store.snapshot(RAW_TOKEN);
  const early = store.touchIfCurrent(first.tokenHash, first.version, (record) => ({ ...record, lastSeenAt: clock.now() }));
  assert.equal(early.ok, true);
  assert.equal(early.checkpointRequired, false);
  clock.advance(WEB_SESSION_CHECKPOINT_MS);
  const second = store.snapshot(RAW_TOKEN);
  const due = store.touchIfCurrent(second.tokenHash, second.version, (record) => ({ ...record, lastSeenAt: clock.now() }));
  assert.equal(due.ok, true);
  assert.equal(due.checkpointRequired, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("drain persists the last dirty TTL and stops the background timer", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const store = await readyStore(file, { now: clock.now });
  await store.createSession(RAW_TOKEN, validRecord());
  const snapshot = store.snapshot(RAW_TOKEN);
  clock.advance(5_000);
  store.touchIfCurrent(snapshot.tokenHash, snapshot.version, (record) => ({ ...record, lastSeenAt: clock.now(), expiresAt: clock.now() + 8 * 60 * 60 * 1000 }));
  const drained = await store.drain();
  assert.equal(drained.ok, true);
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(parsed.sessions[snapshot.tokenHash].lastSeenAt, clock.now());
  await fs.rm(dir, { recursive: true, force: true });
});

test("expired records can never be revived by touch and stale versions fail closed", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const store = await readyStore(file, { now: clock.now });
  await store.createSession(RAW_TOKEN, validRecord());
  const snapshot = store.snapshot(RAW_TOKEN);
  const stale = store.touchIfCurrent(snapshot.tokenHash, snapshot.version + 99, (record) => ({ ...record }));
  assert.equal(stale.reason, "stale");
  clock.advance(9 * 60 * 60 * 1000);
  const expired = store.touchIfCurrent(snapshot.tokenHash, snapshot.version, (record) => ({ ...record }));
  assert.equal(expired.reason, "expired");
  store.deleteSession(RAW_TOKEN);
  const missing = store.touchIfCurrent(snapshot.tokenHash, snapshot.version, (record) => ({ ...record }));
  assert.equal(missing.reason, "missing");
  await fs.rm(dir, { recursive: true, force: true });
});

test("10,000 worst-case valid records serialize within the 32 MiB hard cap", () => {
  const clock = makeClock();
  const sessions = {};
  for (let index = 0; index < 10_000; index += 1) {
    const key = createHash("sha256").update(`worst-${index}`).digest("hex");
    sessions[key] = {
      userId: "u".repeat(1024),
      userUpdatedAt: "2".repeat(64),
      csrf: "c".repeat(256),
      vaultId: "v".repeat(1024),
      createdAt: clock.now(),
      lastSeenAt: clock.now(),
      expiresAt: clock.now() + 8 * 60 * 60 * 1000,
    };
  }
  const bytes = Buffer.byteLength(JSON.stringify({ version: WEB_SESSION_SCHEMA_VERSION, sessions }), "utf8");
  assert.ok(bytes < MAX_WEB_SESSION_FILE_BYTES, `worst-case payload ${bytes} must stay below ${MAX_WEB_SESSION_FILE_BYTES}`);
});

test("token validator matches the current base64url 32-byte cookie generator", () => {
  assert.equal(isValidWebSessionToken(RAW_TOKEN), true);
  assert.equal(isValidWebSessionToken(OTHER_TOKEN), true);
  assert.equal(isValidWebSessionToken("short"), false);
  assert.equal(isValidWebSessionToken(`${RAW_TOKEN}!`), false);
  assert.equal(isValidWebSessionToken("A".repeat(42)), false);
});

test("token validator rejects non-canonical base64url encodings that decode to 32 bytes", () => {
  const nonCanonical = `${"A".repeat(42)}B`;
  assert.equal(Buffer.from(nonCanonical, "base64url").length, 32);
  assert.equal(Buffer.from(nonCanonical, "base64url").toString("base64url"), RAW_TOKEN);
  assert.equal(isValidWebSessionToken(nonCanonical), false);
});

test("unknown top-level state fields fail closed", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  await fs.writeFile(file, JSON.stringify({ version: WEB_SESSION_SCHEMA_VERSION, sessions: {}, extra: true }));
  await assert.rejects(readyStore(file), (error) => error instanceof WebSessionStoreError && error.code === "invalid_record");
  await fs.rm(dir, { recursive: true, force: true });
});

test("candidate mutations are strictly validated and leave committed state unchanged", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const store = await readyStore(file, { now: clock.now });
  await store.createSession(RAW_TOKEN, validRecord());
  const before = store.snapshot(RAW_TOKEN);

  const invalidCreate = await store.createSession(OTHER_TOKEN, { ...validRecord(), extra: "nope" });
  assert.equal(invalidCreate.ok, false);
  assert.equal(invalidCreate.reason, "invalid_record");
  assert.equal(store.activeCount(), 1);

  const invalidUpdate = await store.updateIfCurrent(before.tokenHash, before.version, (record) => ({ ...record, expiresAt: 1 }));
  assert.equal(invalidUpdate.reason, "invalid_record");
  assert.equal(store.snapshot(RAW_TOKEN).record.vaultId, "default");
  assert.equal(store.snapshot(RAW_TOKEN).version, before.version);

  const invalidTouch = store.touchIfCurrent(before.tokenHash, before.version, (record) => ({ ...record, userId: "x".repeat(2_000) }));
  assert.equal(invalidTouch.reason, "invalid_record");
  assert.equal(store.snapshot(RAW_TOKEN).version, before.version);

  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(disk.sessions[before.tokenHash].vaultId, "default");
  assert.equal(disk.sessions[before.tokenHash].userId, before.record.userId);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a foreground update that loses a concurrent touch race preserves the committed touch", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const { io, state } = barrierIo();
  const store = await readyStore(file, { now: clock.now, io });
  await store.createSession(RAW_TOKEN, validRecord());
  const snapshot = store.snapshot(RAW_TOKEN);
  state.blockNext = true;
  const update = store.updateIfCurrent(snapshot.tokenHash, snapshot.version, (record) => ({ ...record, vaultId: "research" }));
  await state.entered.promise;
  // The foreground candidate must not be visible before its durable ack.
  assert.equal(store.snapshot(RAW_TOKEN).record.vaultId, "default");
  const touchedAt = clock.now() + 5;
  const touch = store.touchIfCurrent(snapshot.tokenHash, snapshot.version, (record) => ({ ...record, lastSeenAt: touchedAt }));
  assert.equal(touch.ok, true);
  state.release.resolve();
  const result = await update;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale");
  const after = store.snapshot(RAW_TOKEN);
  assert.equal(after.record.vaultId, "default");
  assert.equal(after.record.lastSeenAt, touchedAt);
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(disk.sessions[snapshot.tokenHash].vaultId, "default");
  assert.equal(disk.sessions[snapshot.tokenHash].lastSeenAt, touchedAt);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a foreground update that loses to a concurrent logout never resurrects the deletion", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const { io, state } = barrierIo();
  const store = await readyStore(file, { now: clock.now, io });
  await store.createSession(RAW_TOKEN, validRecord());
  const snapshot = store.snapshot(RAW_TOKEN);
  state.blockNext = true;
  const update = store.updateIfCurrent(snapshot.tokenHash, snapshot.version, (record) => ({ ...record, vaultId: "research" }));
  await state.entered.promise;
  const revocation = store.revoke(RAW_TOKEN);
  assert.equal(store.snapshot(RAW_TOKEN), null);
  state.release.resolve();
  const result = await update;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing");
  const revoked = await revocation;
  assert.equal(revoked.ok, true);
  assert.equal(store.snapshot(RAW_TOKEN), null);
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(Object.keys(disk.sessions), []);
  await fs.rm(dir, { recursive: true, force: true });
});

function providerFor(record, overrides = {}) {
  return {
    async oauthUserSessionRecord() {
      return {
        updatedAt: record.userUpdatedAt,
        username: "synthetic-user",
        displayName: "Synthetic User",
        allowedScopes: ["obsidian.read"],
        allowedVaults: [record.vaultId],
        ...overrides,
      };
    },
  };
}

async function durableExpiryGap(store, file, rawToken) {
  const memory = store.snapshot(rawToken);
  const disk = JSON.parse(await fs.readFile(file, "utf8")).sessions[memory.tokenHash];
  return { memory, disk, gap: memory.record.expiresAt - disk.expiresAt };
}

// Root probe case 1: an unrelated foreground create/write must not reset a global
// checkpoint clock and let this record's durable expiry lag past the 60s fence.
test("per-record fence: an unrelated foreground write does not renew another record's durable budget", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const store = await readyStore(file, { now: clock.now });
  const recordA = validRecord();
  await store.createSession(RAW_TOKEN, recordA);
  clock.advance(59_000);
  await store.createSession(OTHER_TOKEN, validRecord({
    userId: "user-2",
    createdAt: clock.now(),
    lastSeenAt: clock.now(),
    expiresAt: clock.now() + 8 * 60 * 60 * 1000,
  }));
  clock.advance(59_000);
  const session = await resolveWebSession({ store, provider: providerFor(recordA), rawToken: RAW_TOKEN });
  assert.equal(Boolean(session), true);
  const { memory, disk, gap } = await durableExpiryGap(store, file, RAW_TOKEN);
  assert.equal(memory.record.expiresAt, disk.expiresAt);
  assert.ok(gap < WEB_SESSION_CHECKPOINT_MS, `durable expiry gap ${gap} must be below ${WEB_SESSION_CHECKPOINT_MS}`);
  await fs.rm(dir, { recursive: true, force: true });
});

// Root probe case 2: reopening an old file must baseline the fence on the loaded
// durable record, never on the startup wall clock.
test("per-record fence: first auth after a long idle restart checkpoints against the loaded durable expiry", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  let store = await readyStore(file, { now: clock.now });
  const recordA = validRecord();
  await store.createSession(RAW_TOKEN, recordA);
  store.close();
  clock.advance(3_600_000 + 118_000);
  store = await readyStore(file, { now: clock.now });
  // The loaded durable marker is exactly the old disk record, not startup now.
  const loaded = store.snapshot(RAW_TOKEN);
  const loadedTouch = store.touchIfCurrent(loaded.tokenHash, loaded.version, (record) => ({
    ...record,
    lastSeenAt: clock.now(),
    expiresAt: clock.now() + 8 * 60 * 60 * 1000,
  }));
  assert.equal(loadedTouch.checkpointRequired, true);
  // A fresh load + real resolve must await the checkpoint before authenticating.
  store.close();
  store = await readyStore(file, { now: clock.now });
  const session = await resolveWebSession({ store, provider: providerFor(recordA), rawToken: RAW_TOKEN });
  assert.equal(Boolean(session), true);
  const { gap } = await durableExpiryGap(store, file, RAW_TOKEN);
  assert.equal(gap, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("per-record fence: unrelated checkpoints never advance this record's durable marker", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const store = await readyStore(file, { now: clock.now });
  await store.createSession(RAW_TOKEN, validRecord());
  await store.createSession(OTHER_TOKEN, validRecord({ userId: "user-2" }));
  // Repeatedly touch + checkpoint the OTHER record; RAW is untouched.
  for (let index = 0; index < 5; index += 1) {
    clock.advance(10_000);
    const other = store.snapshot(OTHER_TOKEN);
    store.touchIfCurrent(other.tokenHash, other.version, (record) => ({ ...record, lastSeenAt: clock.now() }));
    await store.checkpoint();
  }
  // At 50s RAW may still touch without a checkpoint...
  clock.advance(0);
  const early = store.snapshot(RAW_TOKEN);
  const earlyTouch = store.touchIfCurrent(early.tokenHash, early.version, (record) => ({
    ...record,
    lastSeenAt: clock.now(),
    expiresAt: clock.now() + 8 * 60 * 60 * 1000,
  }));
  assert.equal(earlyTouch.checkpointRequired, false);
  // ...but when its own 60s window is crossed it must checkpoint.
  clock.advance(10_000);
  const due = store.snapshot(RAW_TOKEN);
  const dueTouch = store.touchIfCurrent(due.tokenHash, due.version, (record) => ({
    ...record,
    lastSeenAt: clock.now(),
    expiresAt: clock.now() + 8 * 60 * 60 * 1000,
  }));
  assert.equal(dueTouch.checkpointRequired, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("per-record fence: a concurrent touch during an in-flight candidate persist does not inherit an unwritten marker", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const { io, state } = barrierIo();
  const store = await readyStore(file, { now: clock.now, io });
  await store.createSession(RAW_TOKEN, validRecord());
  await store.createSession(OTHER_TOKEN, validRecord({ userId: "user-2" }));
  clock.advance(59_000);
  const a = store.snapshot(RAW_TOKEN);
  state.blockNext = true;
  const update = store.updateIfCurrent(a.tokenHash, a.version, (record) => ({ ...record, vaultId: "research" }));
  await state.entered.promise;
  const b = store.snapshot(OTHER_TOKEN);
  const touchB = store.touchIfCurrent(b.tokenHash, b.version, (record) => ({
    ...record,
    lastSeenAt: clock.now(),
    expiresAt: clock.now() + 8 * 60 * 60 * 1000,
  }));
  assert.equal(touchB.ok, true);
  assert.equal(touchB.checkpointRequired, false);
  state.release.resolve();
  assert.equal((await update).ok, true);
  // B's touch was not part of the written candidate, so its durable marker is still 0s.
  clock.advance(1_000);
  const b2 = store.snapshot(OTHER_TOKEN);
  const dueB = store.touchIfCurrent(b2.tokenHash, b2.version, (record) => ({
    ...record,
    lastSeenAt: clock.now(),
    expiresAt: clock.now() + 8 * 60 * 60 * 1000,
  }));
  assert.equal(dueB.checkpointRequired, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("per-record fence: a record's own touch during an in-flight checkpoint does not inherit the unwritten marker", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  const { io, state } = barrierIo();
  const store = await readyStore(file, { now: clock.now, io });
  await store.createSession(RAW_TOKEN, validRecord());
  clock.advance(60_000);
  state.blockNext = true;
  const checkpoint = store.checkpoint();
  await state.entered.promise;
  const snapshot = store.snapshot(RAW_TOKEN);
  const touch = store.touchIfCurrent(snapshot.tokenHash, snapshot.version, (record) => ({
    ...record,
    lastSeenAt: clock.now(),
    expiresAt: clock.now() + 8 * 60 * 60 * 1000,
  }));
  assert.equal(touch.ok, true);
  state.release.resolve();
  assert.equal((await checkpoint).ok, true);
  // The in-flight checkpoint captured version 1; the touch advanced memory to version 2
  // and must remain fenced against version 1's durable marker, not the write in flight.
  clock.advance(1_000);
  const after = store.snapshot(RAW_TOKEN);
  const due = store.touchIfCurrent(after.tokenHash, after.version, (record) => ({
    ...record,
    lastSeenAt: clock.now(),
    expiresAt: clock.now() + 8 * 60 * 60 * 1000,
  }));
  assert.equal(due.checkpointRequired, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("per-record fence: a failed overdue checkpoint stays dirty and the next checkpoint advances only this record's marker", async () => {
  const clock = makeClock();
  const dir = await tempDir();
  const file = path.join(dir, "sessions.json");
  let failNext = false;
  const io = {
    ...fs,
    rename: async (...args) => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
      }
      return fs.rename(...args);
    },
  };
  const store = await readyStore(file, { now: clock.now, io });
  await store.createSession(RAW_TOKEN, validRecord());
  const original = validRecord();
  clock.advance(WEB_SESSION_CHECKPOINT_MS);
  failNext = true;
  const failed = await store.checkpoint();
  assert.equal(failed.ok, false);
  assert.equal(store.dirty, true);
  const diskAfterFailure = JSON.parse(await fs.readFile(file, "utf8")).sessions[hashWebSessionToken(RAW_TOKEN)];
  assert.equal(diskAfterFailure.expiresAt, original.expiresAt);
  const snapshot = store.snapshot(RAW_TOKEN);
  const touch = store.touchIfCurrent(snapshot.tokenHash, snapshot.version, (record) => ({
    ...record,
    lastSeenAt: clock.now(),
    expiresAt: clock.now() + 8 * 60 * 60 * 1000,
  }));
  assert.equal(touch.checkpointRequired, true);
  assert.equal((await store.checkpoint()).ok, true);
  const { memory, disk, gap } = await durableExpiryGap(store, file, RAW_TOKEN);
  assert.equal(memory.record.expiresAt, disk.expiresAt);
  assert.equal(gap, 0);
  assert.equal(store.dirty, false);
  await fs.rm(dir, { recursive: true, force: true });
});
