// AuthZ Wave B / B3 — SSE temporal-boundary matrix.
//
// Contract: `scratch/authz/INTERFACE.md` §10.3 and DEVELOPMENT §20.8. Uses the
// real `openVaultEventStream` + real broker + a real A4 runtime over the shared
// fixtures. The heartbeat interval is triggered deterministically by capturing
// the real `setInterval` callback (no sleep, no new global auth timer). The
// clock is injected, so the window boundary is reached without waiting.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { createAccessPolicyRuntime } from "../src/access-policy/runtime.js";
import { createWebAccessPolicy } from "../src/app/access-policy.js";
import { fakeClock, fakeStore, policyFixture, snapshotFixture } from "./helpers/access-policy-fixtures.js";

process.env.WEB_LIVE_UPDATES = "true";
process.env.WEB_FILE_WATCH_DEBOUNCE_MS = "40";
process.env.WEB_EVENT_HEARTBEAT_MS = "10000";
process.env.WEB_EVENT_REPLAY_SIZE = "32";
process.env.WEB_EVENT_MAX_CONNECTIONS_PER_SESSION = "3";
process.env.WEB_EVENT_DEDUP_TTL_MS = "5000";
process.env.WEB_EVENT_DEDUP_MAX = "128";
process.env.WEB_EVENT_HASH_CONCURRENCY = "2";
process.env.WEB_EVENT_MAX_HASH_PENDING = "8";
process.env.WEB_EVENT_MAX_PENDING = "8";
process.env.WEB_EVENT_MAX_WATCHERS = "4";
process.env.WEB_EVENT_MAX_SUBSCRIBERS = "16";
process.env.WEB_EVENT_WATCHER_READY_TIMEOUT_MS = "2000";
process.env.NODE_ENV = "test";

const HEARTBEAT_MS = 10_000;

// Capture the heartbeat interval created by the real stream. The wrapper passes
// through to the real timer, so production behaviour is unchanged; tests only
// invoke the captured callback to emulate one tick.
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const capturedIntervals = [];
const clearedHandles = new Set();
globalThis.setInterval = (callback, delay, ...args) => {
  const handle = realSetInterval(callback, delay, ...args);
  capturedIntervals.push({ handle, callback, delay });
  return handle;
};
globalThis.clearInterval = (handle) => {
  if (handle) clearedHandles.add(handle);
  return realClearInterval(handle);
};

const live = await import(`../src/app/live-events.js?test=${Date.now()}`);
// The stream owns the real catalog runtimes; resetting them in `after` releases the SQLite handles
// before the temp root is removed (Windows keeps `-shm`/`-wal` busy while a connection is open).
const { __resetWebCatalogRuntimesForTests } = await import("../src/app/web-catalog/runtime.js");

// Asia/Shanghai Mon–Fri 09:00–18:00: 02:00Z is Monday 10:00 local (inside),
// 10:00Z is exactly Monday 18:00 local (interval end -> outside).
const INSIDE_MS = Date.parse("2026-10-05T02:00:00.000Z");
const WINDOW_END_MS = Date.parse("2026-10-05T10:00:00.000Z");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-authz-sse-"));
// #428: an admitted SSE stream opens a real per-Vault Web Catalog. Never let this process fall back
// to the process-wide default directory (`DATA_PATH/web-catalog`) — unwritable on CI. The store
// lives under this test's own temporary root, like the other catalog-touching HTTP suites.
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
const vaultRoot = path.join(root, "vault");
await fs.mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
const vault = { id: "b3-vault", root: vaultRoot };

after(async () => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  await live.resetLiveEventsForTests();
  __resetWebCatalogRuntimesForTests();
  await fs.rm(root, { recursive: true, force: true });
});

function createMockSocket() {
  const chunks = [];
  const emitter = new EventEmitter();
  const res = {
    statusCode: 200,
    headers: {},
    ended: false,
    writableEnded: false,
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      this.ended = true;
      this.writableEnded = true;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    flushHeaders() {},
    write(chunk) {
      if (this.ended || this.writableEnded) throw new Error("write after end");
      chunks.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
      this.writableEnded = true;
    },
    on(event, handler) {
      emitter.on(event, handler);
    },
    emit(event) {
      emitter.emit(event);
    },
  };
  const req = {
    headers: {},
    webSession: null,
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
    on(event, handler) {
      emitter.on(event, handler);
    },
    emit(event) {
      emitter.emit(event);
    },
  };
  return { req, res, chunks };
}

function parseFrames(chunks) {
  return chunks
    .join("")
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const frame = { id: null, event: null, data: null, comment: null };
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) frame.comment = line.slice(1).trim();
        else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("data:")) frame.data = JSON.parse(line.slice(5).trim());
      }
      return frame;
    });
}

function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeRuntime({ mode = "suspend", startMs = INSIDE_MS } = {}) {
  const clock = fakeClock(startMs);
  // revoke is all-only by schema (A3): its capability set is exactly ["all"].
  const capabilities = mode === "revoke" ? ["all"] : ["scope:obsidian.read"];
  const store = fakeStore({
    snapshot: snapshotFixture({ policies: [policyFixture({ mode, capabilities })] }),
  });
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: () => clock.now() });
  return { runtime, clock };
}

function makeSession(id) {
  return { id, userId: "u1", vaultId: vault.id, allowedVaults: [vault.id], csrf: "csrf-token" };
}

async function openStream(socket, session, revalidate) {
  const before = capturedIntervals.length;
  await live.openVaultEventStream({ req: socket.req, res: socket.res, session, vault, revalidate });
  return capturedIntervals.slice(before).filter((entry) => entry.delay === HEARTBEAT_MS).at(-1) ?? null;
}

function openSocket(session) {
  const socket = createMockSocket();
  socket.req.webSession = session;
  return socket;
}

async function establishStream({ mode = "suspend", revalidate } = {}) {
  await live.resetLiveEventsForTests();
  capturedIntervals.length = 0;
  const { runtime, clock } = makeRuntime({ mode });
  await runtime.ready;
  const policy = createWebAccessPolicy({ runtime });
  const session = makeSession(`sse-${mode}-${Math.random().toString(16).slice(2)}`);
  const socket = openSocket(session);
  const heartbeat = await openStream(
    socket,
    session,
    revalidate ?? (() => policy.revalidateWebRead(socket.req)),
  );
  const subscriber = [...live.liveEventInternalsForTests().subscribers].at(-1) ?? null;
  return { runtime, clock, policy, session, socket, heartbeat, subscriber };
}

describe("SSE temporal boundary (real stream + broker)", { concurrency: false }, () => {
  test("window crossing closes the subscriber and stops further delivery", async () => {
    const { clock, socket, heartbeat, subscriber } = await establishStream({ mode: "suspend" });
    assert.ok(heartbeat, "the real heartbeat interval must be installed");
    assert.ok(subscriber);
    assert.equal(parseFrames(socket.chunks)[0].event, "hello");

    // 1-2. Inside the window: a healthy heartbeat keeps the stream open and
    // event A is delivered.
    await heartbeat.callback();
    assert.equal(subscriber.closed, false);
    assert.ok(parseFrames(socket.chunks).some((frame) => frame.comment?.startsWith("heartbeat")));

    const eventA = live.publishWebMutation({
      vaultId: vault.id, path: "A.md", created: true, revision: "sha256:a", size: 3, origin: "test",
    });
    assert.ok(eventA);
    await waitFor(() => parseFrames(socket.chunks).some((frame) => frame.data?.path === "A.md"));

    // 3-5. Jump to the window end and run the real heartbeat revalidation path.
    clock.set(WINDOW_END_MS);
    await heartbeat.callback();
    assert.equal(subscriber.closed, true, "subscriber must be closed after the window ends");
    assert.equal(subscriber.heartbeat, null, "the heartbeat interval must be cleared");
    assert.ok(clearedHandles.has(heartbeat.handle), "the real interval handle must be cleared");
    assert.equal(live.liveEventInternalsForTests().subscribers.size, 0);

    // 6. Event B must not be delivered after the close.
    const eventB = live.publishWebMutation({
      vaultId: vault.id, path: "B.md", created: true, revision: "sha256:b", size: 3, origin: "test",
    });
    assert.ok(eventB);
    await tick();
    assert.ok(!parseFrames(socket.chunks).some((frame) => frame.data?.path === "B.md"));

    // 7. Watcher/broker references are released (last subscriber left).
    assert.equal(live.liveEventInternalsForTests().watcherRefs.get(vault.id), undefined);
    assert.equal(live.liveEventInternalsForTests().watchers.has(vault.id), false);
  });

  test("revoke and suspend both close the subscriber", async () => {
    for (const mode of ["suspend", "revoke"]) {
      const { clock, heartbeat, subscriber } = await establishStream({ mode });
      assert.ok(subscriber);
      clock.set(WINDOW_END_MS);
      await heartbeat.callback();
      assert.equal(subscriber.closed, true, `${mode} must close the stream`);
      assert.equal(live.liveEventInternalsForTests().subscribers.size, 0);
    }
  });

  test("a logout race (revalidate returns null) closes the subscriber", async () => {
    const { socket, heartbeat, subscriber } = await establishStream({ mode: "suspend" });
    assert.ok(subscriber);
    // Session invalidated between heartbeats: the gate sees no live session.
    socket.req.webSession = null;
    await heartbeat.callback();
    assert.equal(subscriber.closed, true);
    assert.equal(subscriber.heartbeat, null);
    assert.equal(live.liveEventInternalsForTests().subscribers.size, 0);
  });

  test("a revalidation exception fails closed (subscriber closed)", async () => {
    const { heartbeat, subscriber } = await establishStream({
      mode: "suspend",
      revalidate: () => { throw new Error("session store unavailable"); },
    });
    assert.ok(subscriber);
    await heartbeat.callback();
    assert.equal(subscriber.closed, true);
    assert.equal(subscriber.heartbeat, null);
    assert.equal(live.liveEventInternalsForTests().subscribers.size, 0);
  });

  test("a vault switch during revalidation closes the subscriber (existing semantics preserved)", async () => {
    const { heartbeat, subscriber } = await establishStream({
      mode: "suspend",
      revalidate: async () => ({ vaultId: "other-vault", allowedVaults: ["other-vault"] }),
    });
    assert.ok(subscriber);
    await heartbeat.callback();
    assert.equal(subscriber.closed, true);
    assert.equal(live.liveEventInternalsForTests().subscribers.size, 0);
  });

  test("disabled runtime keeps the SSE stream open across the window end", async () => {
    await live.resetLiveEventsForTests();
    capturedIntervals.length = 0;
    const runtime = createAccessPolicyRuntime({ enabled: false, store: null });
    await runtime.ready;
    const policy = createWebAccessPolicy({ runtime });
    const session = makeSession("sse-disabled");
    const socket = openSocket(session);
    const heartbeat = await openStream(socket, session, () => policy.revalidateWebRead(socket.req));
    const subscriber = [...live.liveEventInternalsForTests().subscribers].at(-1);
    assert.ok(subscriber);
    await heartbeat.callback();
    assert.equal(subscriber.closed, false);
    assert.equal(live.liveEventInternalsForTests().subscribers.size, 1);
  });
});
