// #364 durable authorization-transfer store.
//
// The store is the security authority for the transfer fence, so these tests pin
// the properties the running server depends on: whole-file atomic replacement
// (mode 0600), crash/restart reload, corruption fail-closed, generation
// monotonicity, one pending per pair/target, no revival of a closed intent, and
// "a failed write publishes nothing".

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTHORIZATION_TRANSFER_PENDING_TTL_MS,
  AUTHORIZATION_TRANSFER_SCHEMA_VERSION,
  AuthorizationTransferStoreError,
  createAuthorizationTransferStore,
} from "../src/oauth/authorization-transfer-store.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-i364-store-"));
test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

let sequence = 0;
function storeFile(name) {
  sequence += 1;
  return path.join(root, `${name}-${sequence}.json`);
}

function clock(start = Date.parse("2026-10-09T00:00:00.000Z")) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => { value += ms; },
  };
}

async function started(options = {}) {
  const store = createAuthorizationTransferStore(options);
  await store.ready;
  return store;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

/** A well-formed transfer record; individual fields are overridden per case. */
function transferJson(overrides = {}) {
  return {
    id: "t1",
    clientId: "c",
    sourceUserId: "u",
    targetUserId: "v",
    status: "pending",
    generation: 1,
    sourceRevokedAt: "2026-10-09T00:00:00.000Z",
    createdAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T00:15:00.000Z",
    completedAt: null,
    cancelledAt: null,
    closedReason: null,
    completionUserId: null,
    lastErrorCode: null,
    ...overrides,
  };
}

/** A whole store document, used to hand-build the cross-record corruption cases. */
function storeJson({ transfers = {}, generations = {} } = {}) {
  return JSON.stringify({ version: 1, generations, transfers }, null, 2);
}

test("an absent store is created atomically, mode 0600, schema v1, and reloads", async () => {
  const file = storeFile("create");
  const store = await started({ file });
  assert.equal(store.isHealthy(), true);
  const initial = await readJson(file);
  assert.deepEqual(initial, { version: AUTHORIZATION_TRANSFER_SCHEMA_VERSION, generations: {}, transfers: {} });
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
  const begun = await store.begin({ clientId: "c1", sourceUserId: "u1", targetUserId: "u2" });
  assert.equal(begun.reused, false);
  assert.equal(begun.transfer.status, "pending");
  assert.equal(begun.transfer.generation, 1);
  assert.equal(begun.transfer.sourceRevokedAt, begun.transfer.createdAt);
  assert.equal(AUTHORIZATION_TRANSFER_PENDING_TTL_MS, 15 * 60 * 1000);
  assert.equal(begun.transfer.expiresAt, new Date(Date.parse(begun.transfer.createdAt) + AUTHORIZATION_TRANSFER_PENDING_TTL_MS).toISOString());

  const reloaded = await started({ file });
  assert.deepEqual(reloaded.snapshot(), store.snapshot(), "a restart must restore the exact durable state");
  assert.equal(reloaded.pendingForSource("c1", "u1").id, begun.transfer.id);
  assert.equal(reloaded.view().generations[JSON.stringify(["c1", "u1"])].generation, 1);
});

test("the persisted record carries ids, statuses and times only — never a secret", async () => {
  const file = storeFile("shape");
  const store = await started({ file });
  const { transfer } = await store.begin({ clientId: "c2", sourceUserId: "u3", targetUserId: "u4" });
  const raw = await fs.readFile(file, "utf8");
  assert.deepEqual(Object.keys(await readJson(file)).sort(), ["generations", "transfers", "version"]);
  const persisted = (await readJson(file)).transfers[transfer.id];
  assert.deepEqual(Object.keys(persisted).sort(), [
    "cancelledAt", "clientId", "closedReason", "completedAt", "completionUserId",
    "createdAt", "expiresAt", "generation", "id", "lastErrorCode",
    "sourceRevokedAt", "sourceUserId", "status", "targetUserId",
  ]);
  assert.doesNotMatch(raw, /token|secret|password|bearer|code_verifier|access_token|refresh_token/i);
});

test("corrupt, malformed and unknown-version stores fail closed and are left untouched", async () => {
  const cases = [
    ["not-json", "{ this is not json", "corrupt"],
    ["not-object", "[]", "corrupt"],
    ["wrong-version", JSON.stringify({ version: 2, generations: {}, transfers: {} }), "unsupported_version"],
    ["missing-maps", JSON.stringify({ version: 1, transfers: {} }), "corrupt"],
    ["bad-key", JSON.stringify({ version: 1, generations: { "client:user": { generation: 1 } }, transfers: {} }), "corrupt"],
    ["zero-generation", JSON.stringify({ version: 1, generations: { [JSON.stringify(["c", "u"])]: { generation: 0 } }, transfers: {} }), "corrupt"],
    ["bad-status", JSON.stringify({
      version: 1,
      generations: {},
      transfers: {
        t1: {
          id: "t1", clientId: "c", sourceUserId: "u", targetUserId: "v", status: "revived",
          generation: 1, createdAt: "2026-10-09T00:00:00.000Z", expiresAt: "2026-10-09T00:15:00.000Z",
        },
      },
    }), "corrupt"],
    ["mismatched-id", JSON.stringify({
      version: 1,
      generations: {},
      transfers: {
        t1: {
          id: "t2", clientId: "c", sourceUserId: "u", targetUserId: "v", status: "pending",
          generation: 1, createdAt: "2026-10-09T00:00:00.000Z", expiresAt: "2026-10-09T00:15:00.000Z",
        },
      },
    }), "corrupt"],
    // Cross-record consistency (P0 #364 L1 fix): a generation 1 transfer with no
    // fence generation record would leave the old-generation credential unfenced.
    ["transfer-without-generation", storeJson({ transfers: { t1: transferJson() } }), "corrupt"],
    ["generation-behind-history", storeJson({
      transfers: { t1: transferJson({ generation: 2 }) },
      generations: { [JSON.stringify(["c", "u"])]: { generation: 1, transferId: "t1" } },
    }), "corrupt"],
    ["generation-wrong-pair", storeJson({
      transfers: { t1: transferJson() },
      generations: { [JSON.stringify(["c", "other"])]: { generation: 1, transferId: "t1" } },
    }), "corrupt"],
    ["generation-unknown-transfer", storeJson({
      transfers: {},
      generations: { [JSON.stringify(["c", "u"])]: { generation: 1, transferId: "missing" } },
    }), "corrupt"],
    ["two-pending-per-source", storeJson({ transfers: {
      t1: transferJson(),
      t2: transferJson({ id: "t2", targetUserId: "w" }),
    } }), "corrupt"],
    ["two-pending-per-target", storeJson({ transfers: {
      t1: transferJson(),
      t2: transferJson({ id: "t2", sourceUserId: "z" }),
    } }), "corrupt"],
  ];
  const failures = [];
  for (const [name, content, code] of cases) {
    const file = storeFile(name);
    await fs.writeFile(file, content, "utf8");
    const store = createAuthorizationTransferStore({ file });
    try {
      await assert.rejects(store.ready, (error) => {
        assert.ok(error instanceof AuthorizationTransferStoreError, `${name}: typed error`);
        assert.equal(error.code, code, `${name}: code`);
        assert.equal(error.status, 503, `${name}: fail-closed status hint`);
        return true;
      });
      assert.equal(store.isHealthy(), false, `${name}: unhealthy`);
      assert.equal(await fs.readFile(file, "utf8"), content, `${name}: the corrupt file must not be overwritten`);
    } catch (error) {
      failures.push(`${name}: ${String(error.message).split("\n")[0]}`);
    }
  }
  assert.deepEqual(failures, [], "every untrusted store must fail closed and be left untouched");
});

test("begin is idempotent for the same target and a second generation is never spent twice", async () => {
  const file = storeFile("idempotent");
  const store = await started({ file });
  const first = await store.begin({ clientId: "c3", sourceUserId: "u5", targetUserId: "u6" });
  const writesAfterFirst = store.persistCount();
  const again = await store.begin({ clientId: "c3", sourceUserId: "u5", targetUserId: "u6" });
  assert.equal(again.reused, true);
  assert.equal(again.transfer.id, first.transfer.id);
  assert.equal(store.persistCount(), writesAfterFirst, "an idempotent repeat must not rewrite the store");
  assert.equal(store.view().generations[JSON.stringify(["c3", "u5"])].generation, 1);
  assert.equal(Object.keys(store.view().transfers).length, 1);
});

test("a conflicting begin has zero side effects in memory and on disk", async () => {
  const file = storeFile("conflict");
  const store = await started({ file });
  const first = await store.begin({ clientId: "c4", sourceUserId: "u7", targetUserId: "u8" });
  const before = store.snapshot();
  const writes = store.persistCount();
  await assert.rejects(store.begin({ clientId: "c4", sourceUserId: "u7", targetUserId: "u9" }), (error) => {
    assert.equal(error.code, "conflict");
    assert.equal(error.status, 409);
    return true;
  });
  assert.deepEqual(store.snapshot(), before, "a rejected conflict must not touch memory");
  assert.deepEqual(await readJson(file), before, "a rejected conflict must not touch disk");
  assert.equal(store.persistCount(), writes);
  // Another source aiming at the already-pending target is also refused.
  await assert.rejects(store.begin({ clientId: "c4", sourceUserId: "u10", targetUserId: "u8" }), (error) => error.code === "conflict");
  assert.deepEqual(store.snapshot(), before);
  // A different client and a distinct pair is untouched.
  const other = await store.begin({ clientId: "c5", sourceUserId: "u7", targetUserId: "u8" });
  assert.equal(other.transfer.status, "pending");
  assert.equal(store.pendingForSource("c4", "u7").id, first.transfer.id);
});

test("concurrent begins for one pair yield exactly one durable fence", async () => {
  const file = storeFile("concurrent");
  const store = await started({ file });
  const settled = await Promise.allSettled([
    store.begin({ clientId: "c6", sourceUserId: "u11", targetUserId: "u12" }),
    store.begin({ clientId: "c6", sourceUserId: "u11", targetUserId: "u13" }),
    store.begin({ clientId: "c6", sourceUserId: "u11", targetUserId: "u12" }),
  ]);
  const ok = settled.filter((item) => item.status === "fulfilled");
  const failed = settled.filter((item) => item.status === "rejected");
  assert.equal(ok.length, 2, "the winner plus its idempotent repeat");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, "conflict");
  const pendings = Object.values(store.view().transfers).filter((item) => item.status === "pending");
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0].targetUserId, "u12");
  assert.equal(Object.values(store.view().generations).filter((item) => item.transferId === pendings[0].id).length, 1);
  assert.equal(store.view().generations[JSON.stringify(["c6", "u11"])].generation, 1, "exactly one generation is spent");
});

test("expiry closes the completion intent, never the fence, and a later begin spends a new generation", async () => {
  const file = storeFile("expiry");
  const time = clock();
  const store = await started({ file, now: time.now, ttlMs: 60_000 });
  const first = await store.begin({ clientId: "c7", sourceUserId: "u14", targetUserId: "u15" });
  assert.deepEqual(await store.sweepExpired(), [], "a live pending is not expired");
  time.advance(60_001);
  const expired = await store.sweepExpired();
  assert.deepEqual(expired.map((item) => item.id), [first.transfer.id]);
  assert.equal(store.getTransfer(first.transfer.id).status, "expired");
  assert.equal(store.view().generations[JSON.stringify(["c7", "u14"])].generation, 1, "expiry must not lift the fence");
  assert.equal(await store.sweepExpired().then((items) => items.length), 0, "expiry is idempotent");
  // A closed intent cannot be completed or re-cancelled.
  assert.equal((await store.complete(first.transfer.id, { completionUserId: "u15" })).changed, false);
  assert.equal((await store.cancel(first.transfer.id)).changed, false);
  const second = await store.begin({ clientId: "c7", sourceUserId: "u14", targetUserId: "u16" });
  assert.equal(second.reused, false, "an expired intent does not absorb the new request");
  assert.equal(second.transfer.generation, 2);
  assert.deepEqual(second.expired, [], "an already-swept intent is reported once, by the sweep");
  // A begin that itself finds a stale pending of its own pair expires and reports it.
  time.advance(60_001);
  const third = await store.begin({ clientId: "c7", sourceUserId: "u14", targetUserId: "u17" });
  assert.deepEqual(third.expired.map((item) => item.id), [second.transfer.id]);
  assert.equal(third.transfer.generation, 3);
  assert.equal(store.getTransfer(third.expired[0].id).status, "expired");
});

test("cancel and complete are durable, target-scoped and one-way", async () => {
  const file = storeFile("cancel-complete");
  const store = await started({ file });
  const a = await store.begin({ clientId: "c8", sourceUserId: "u17", targetUserId: "u18" });
  const b = await store.begin({ clientId: "c8", sourceUserId: "u19", targetUserId: "u20" });
  await assert.rejects(store.complete(a.transfer.id, { completionUserId: "u20" }), (error) => {
    assert.equal(error.code, "invalid_request");
    return true;
  });
  assert.equal(store.getTransfer(a.transfer.id).status, "pending", "a mismatched completer changes nothing");
  assert.equal((await store.cancel(a.transfer.id, { reason: "cancelled_by_admin" })).changed, true);
  assert.equal(store.getTransfer(a.transfer.id).closedReason, "cancelled_by_admin");
  assert.equal((await store.cancel(a.transfer.id)).changed, false);
  assert.equal((await store.complete(a.transfer.id, { completionUserId: "u18" })).changed, false, "a cancelled intent cannot be revived");
  const completed = await store.complete(b.transfer.id, { completionUserId: "u20" });
  assert.equal(completed.changed, true);
  assert.equal(completed.transfer.completedAt !== null, true);
  assert.equal(completed.transfer.completionUserId, "u20");
  assert.equal((await store.cancel(b.transfer.id)).changed, false, "a completed intent cannot be cancelled");
  const reloaded = await started({ file });
  assert.equal(reloaded.getTransfer(a.transfer.id).status, "cancelled");
  assert.equal(reloaded.getTransfer(b.transfer.id).status, "completed");
  await assert.rejects(store.cancel("does-not-exist"), (error) => file && error.code === "not_found");
  await assert.rejects(store.begin({ clientId: "c8", sourceUserId: "same", targetUserId: "same" }), (error) => error.code === "invalid_request");
});

test("a failed durable write publishes nothing: the fence is rolled back in memory too", async () => {
  const file = storeFile("write-failure");
  const realStore = await started({ file });
  const ready = realStore.snapshot();
  let failNext = true;
  const faultFs = {
    ...fs,
    rename: async (from, to) => {
      if (failNext && to === file) throw Object.assign(new Error("EIO: injected rename failure"), { code: "EIO" });
      return fs.rename(from, to);
    },
  };
  const faulty = await started({ file, fsModule: faultFs });
  await assert.rejects(faulty.begin({ clientId: "c9", sourceUserId: "u21", targetUserId: "u22" }), (error) => {
    assert.equal(error.code, "unavailable");
    assert.equal(error.status, 503, "the §5 hint for an unwritable transfer store");
    return true;
  });
  assert.deepEqual(faulty.snapshot(), ready, "no half-persisted fence in memory");
  assert.deepEqual(await readJson(file), ready, "no half-persisted fence on disk");
  assert.equal(faulty.isHealthy(), true, "a failed write is not a corrupt store");
  const leftovers = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith(path.basename(file)) && name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "a failed write must not leave temp files behind");

  failNext = false;
  const recovered = await faulty.begin({ clientId: "c9", sourceUserId: "u21", targetUserId: "u22" });
  assert.equal(recovered.transfer.generation, 1, "the rolled-back attempt must not have consumed a generation");
  assert.equal((await readJson(file)).transfers[recovered.transfer.id].status, "pending");
});

test("complete reports a persistence failure instead of claiming a completion", async () => {
  const file = storeFile("complete-failure");
  const store = await started({ file });
  const { transfer } = await store.begin({ clientId: "c10", sourceUserId: "u23", targetUserId: "u24" });
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === file) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return originalRename(from, to);
  };
  try {
    await assert.rejects(store.complete(transfer.id, { completionUserId: "u24" }), (error) => error.code === "unavailable");
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(store.getTransfer(transfer.id).status, "pending", "a failed completion write leaves the intent pending");
  const succeeded = await store.complete(transfer.id, { completionUserId: "u24" });
  assert.equal(succeeded.changed, true);
  assert.equal((await readJson(file)).transfers[transfer.id].status, "completed");
});

test("a mutation is published only after its durable write, and a duplicate waits for that commit", async () => {
  const file = storeFile("publish-after-commit");
  let block = false;
  let entered = null;
  let release = null;
  const blockedFs = {
    ...fs,
    rename: async (from, to) => {
      if (block && to === file) {
        entered?.();
        await new Promise((resolve) => { release = resolve; });
      }
      return fs.rename(from, to);
    },
  };
  const store = await started({ file, fsModule: blockedFs });
  block = true;
  let signal;
  const enteredWrite = new Promise((resolve) => { signal = resolve; });
  entered = signal;
  const first = store.begin({ clientId: "c11", sourceUserId: "u25", targetUserId: "u26" });
  await enteredWrite;
  assert.equal(store.pendingForSource("c11", "u25"), null, "an unpersisted fence must not be readable");
  assert.deepEqual(store.view().transfers, {}, "the candidate must not be published before its rename()");
  let secondSettled = null;
  const second = store.begin({ clientId: "c11", sourceUserId: "u25", targetUserId: "u26" }).then((value) => { secondSettled = value; return value; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondSettled, null, "a duplicate begin must wait for the in-flight commit");
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.reused, false);
  assert.equal(secondResult.reused, true);
  assert.equal(secondResult.transfer.id, firstResult.transfer.id, "exactly one fence is created");
  assert.equal((await readJson(file)).transfers[firstResult.transfer.id].status, "pending");
  assert.equal(store.pendingForSource("c11", "u25").id, firstResult.transfer.id, "published after the commit");
});

test("a rejected mutation publishes nothing: a stale record is not half-expired in memory", async () => {
  const file = storeFile("mutator-throw");
  const time = clock();
  const store = await started({ file, now: time.now, ttlMs: 60_000 });
  // `live` is created half a TTL later, so one clock jump past `stale`'s deadline
  // leaves a stale pending AND a live pending for the same client.
  const stale = await store.begin({ clientId: "c13", sourceUserId: "u28", targetUserId: "u32" });
  time.advance(50_000);
  const live = await store.begin({ clientId: "c13", sourceUserId: "u27", targetUserId: "u31" });
  time.advance(20_001);
  const before = store.snapshot();
  const writes = store.persistCount();
  // Conflicts on the *target*, after the mutator has already looked at the stale
  // pending of the source pair: the rejection must undo every intermediate edit.
  await assert.rejects(store.begin({ clientId: "c13", sourceUserId: "u28", targetUserId: "u31" }), (error) => error.code === "conflict");
  assert.deepEqual(store.snapshot(), before, "a rejected mutation must not publish a partial change");
  assert.equal(store.getTransfer(stale.transfer.id).status, "pending", "the stale record must stay pending until a real sweep commits");
  assert.deepEqual(await readJson(file), before, "and the disk must agree with memory");
  assert.equal(store.persistCount(), writes, "a rejection writes nothing");
  const expired = await store.sweepExpired();
  assert.deepEqual(expired.map((item) => item.id), [stale.transfer.id], "the stale intent is still reported exactly once");
  assert.equal((await readJson(file)).transfers[stale.transfer.id].status, "expired");
  assert.equal(store.getTransfer(live.transfer.id).status, "pending", "the live intent is untouched");
});

test("complete re-checks the deadline in its serialized section: an expired intent is never completed", async () => {
  const file = storeFile("complete-ttl");
  const time = clock();
  const store = await started({ file, now: time.now, ttlMs: 60_000 });
  const { transfer } = await store.begin({ clientId: "c14", sourceUserId: "u33", targetUserId: "u34" });
  time.advance(60_001);
  const refused = await store.complete(transfer.id, { completionUserId: "u34" });
  assert.equal(refused.changed, false, "an intent past its TTL can never complete");
  assert.equal(refused.reason, "expired");
  assert.equal(refused.transfer.status, "expired");
  assert.equal((await readJson(file)).transfers[transfer.id].status, "expired", "the refusal itself is durable");
  assert.equal((await store.complete(transfer.id, { completionUserId: "u34" })).changed, false, "a retry cannot revive it");
  assert.equal(store.view().generations[JSON.stringify(["c14", "u33"])].generation, 1, "expiry never lifts the fence");
});
