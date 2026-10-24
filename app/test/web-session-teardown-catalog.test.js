// Reconciliation barrier test: the owned live-event teardown must close a
// Catalog-enabled watcher exactly once and leave the Web Catalog coverage
// explicitly closed (never a stale/false "ready") when no subscriber remains.
//
// This is the narrow integration proof for the frozen-main reconciliation:
// upstream notifyWatcherClosed (final release) + owned shutdown release
// suppression + teardown-owned close/rethrow must compose without a duplicate
// close, a missing close notification, or a false ready.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

process.env.WEB_LIVE_UPDATES = "true";
process.env.NODE_ENV = "test";
process.env.WEB_CATALOG_ENABLED = "true";
process.env.WEB_EVENT_HEARTBEAT_MS = "60000";
process.env.WEB_EVENT_WATCHER_READY_TIMEOUT_MS = "2000";

const live = await import(`../src/app/live-events.js?teardown-catalog=${Date.now()}`);
const runtime = await import("../src/app/web-catalog/runtime.js");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-teardown-catalog-"));
const vaultRoot = path.join(root, "vault");
await fs.mkdir(vaultRoot, { recursive: true });
const vault = { id: "teardown-catalog-vault", root: vaultRoot };

// A deterministic fake runtime so the barrier asserts the exact coverage
// transitions without opening a real SQLite store.
function createCoverageRuntime(v) {
  const events = [];
  const state = { covered: false };
  return {
    vaultId: v.id,
    start() {},
    resync(origin) { events.push({ kind: "resync", origin }); },
    setCoverage(covered, origin) {
      state.covered = covered;
      events.push({ kind: "coverage", covered, origin });
    },
    indexFile: async () => ({ ok: true }),
    removePath: () => ({ ok: true }),
    drain: async () => {},
    close() {},
    isStarted: () => true,
    status: () => ({ covered: state.covered, stale: !state.covered }),
    events,
  };
}

function createMockSocket() {
  const emitter = new EventEmitter();
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    ended: false,
    writableEnded: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; this.ended = true; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    flushHeaders() {},
    write(chunk) {
      if (this.ended || this.writableEnded) throw new Error("write after end");
      chunks.push(String(chunk));
      return true;
    },
    end() { this.ended = true; this.writableEnded = true; },
    on(event, handler) { emitter.on(event, handler); },
    emit(event) { emitter.emit(event); },
  };
  const req = {
    headers: {},
    get(name) { return this.headers[String(name).toLowerCase()]; },
    on(event, handler) { emitter.on(event, handler); },
    emit(event) { emitter.emit(event); },
  };
  return { req, res, chunks };
}

after(async () => {
  await live.resetLiveEventsForTests();
  runtime.__resetWebCatalogRuntimesForTests();
  await fs.rm(root, { recursive: true, force: true });
});

test("teardown closes a Catalog-enabled watcher once and marks coverage closed", async () => {
  await live.resetLiveEventsForTests();
  runtime.__resetWebCatalogRuntimesForTests();

  let fake = null;
  runtime.__setWebCatalogRuntimeFactoryForTests((v) => {
    fake = createCoverageRuntime(v);
    return fake;
  });
  try {
    const { req, res } = createMockSocket();
    await live.openVaultEventStream({
      req,
      res,
      session: { id: "session-teardown-catalog", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    assert.ok(fake, "the Catalog runtime is created on watcher admission");
    assert.equal(res.statusCode, 200);
    assert.equal(fake.status().covered, true, "watcher-ready must mark coverage present");

    const internals = live.liveEventInternalsForTests();
    const watcherState = internals.watchers.get(vault.id);
    assert.ok(watcherState, "the watcher is owned by live-events");

    let closeCalls = 0;
    const realClose = watcherState.watcher.close.bind(watcherState.watcher);
    watcherState.watcher.close = async () => {
      closeCalls += 1;
      return realClose();
    };

    await live.teardownLiveEvents();

    const coverageEvents = fake.events.filter((event) => event.kind === "coverage");
    const closedEvents = coverageEvents.filter((event) => event.covered === false && event.origin === "watcher-closed");
    assert.equal(closedEvents.length, 1, "final release must notify watcher-closed exactly once");
    assert.equal(closeCalls, 1, "teardown owns the close and must not double-close");
    assert.equal(internals.watchers.has(vault.id), false, "the watcher is released after teardown");

    const last = coverageEvents.at(-1);
    assert.deepEqual(last, { kind: "coverage", covered: false, origin: "watcher-closed" });
    assert.equal(fake.status().covered, false, "coverage must never remain falsely ready after close");
    assert.equal(fake.status().stale, true, "a closed watcher leaves the catalog explicitly stale");
  } finally {
    runtime.__setWebCatalogRuntimeFactoryForTests(null);
  }
});
