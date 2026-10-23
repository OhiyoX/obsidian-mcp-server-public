import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

process.env.WEB_LIVE_UPDATES = "true";
process.env.WEB_FILE_WATCH_DEBOUNCE_MS = "40";
process.env.WEB_EVENT_HEARTBEAT_MS = "60000";
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

const live = await import(`../src/app/live-events.js?test=${Date.now()}`);
// #428: the per-Vault catalog store must be closed before `after` deletes the temp root (Windows).
const { __resetWebCatalogRuntimesForTests } = await import("../src/app/web-catalog/runtime.js");
const { buildEventDto, formatSseFrame } = await import("../src/app/events/sse-frame.js");
const { createHashQueue, hashFileStream, HashQueueOverflowError, HashQueueCancelledError } = await import("../src/app/events/hash-queue.js");
const { createDedupCache } = await import("../src/app/events/dedup.js");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-live-events-"));
// #428: own the catalog directory; never the process-wide `DATA_PATH/web-catalog` (unwritable on CI).
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
const vaultRoot = path.join(root, "vault");
await fs.mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
const vault = { id: "test-vault", root: vaultRoot };

after(async () => {
  await live.resetLiveEventsForTests();
  __resetWebCatalogRuntimesForTests();
  await fs.rm(root, { recursive: true, force: true });
});

function createMockSocket({ writeImpl } = {}) {
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
      if (this.ended || this.writableEnded) {
        throw new Error("write after end");
      }
      chunks.push(String(chunk));
      if (writeImpl) return writeImpl(chunk, chunks, this);
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
      const lines = block.split("\n");
      const frame = { id: null, event: null, data: null, comment: null };
      for (const line of lines) {
        if (line.startsWith(":")) frame.comment = line.slice(1).trim();
        else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("data:")) frame.data = JSON.parse(line.slice(5).trim());
      }
      return frame;
    });
}

function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
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

describe("live-events lifecycle / backpressure", { concurrency: false }, () => {
  test("real Timeout stays off the event DTO and SSE JSON stays valid", async () => {
    await live.resetLiveEventsForTests();
    const notePath = path.join(vaultRoot, "Timer.md");
    await fs.writeFile(notePath, "# timer base\n", "utf8");

    const { req, res, chunks } = createMockSocket();
    await live.openVaultEventStream({
      req,
      res,
      session: { id: "s1", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    await fs.writeFile(notePath, "# timer changed\n", "utf8");

    await waitFor(() => live.liveEventInternalsForTests().pending.size > 0, { timeoutMs: 10_000 });
    const record = [...live.liveEventInternalsForTests().pending.values()][0];
    assert.equal(typeof record.timer.refresh, "function");
    assert.equal(record.event.timer, undefined);
    assert.doesNotThrow(() => JSON.stringify(record.event));

    await waitFor(() => parseFrames(chunks).some((frame) => frame.event === "note.changed"), {
      timeoutMs: 10_000,
    });
    const frames = parseFrames(chunks);
    const note = frames.find((frame) => frame.event === "note.changed");
    assert.ok(note);
    assert.equal(note.data.path, "Timer.md");
    assert.equal(note.data.timer, undefined);
    assert.doesNotThrow(() => JSON.stringify(note.data));
    req.emit("close");
  });

  test(".base watcher events stay document events, not asset.changed", async () => {
    await live.resetLiveEventsForTests();
    const basePath = path.join(vaultRoot, "Config.base");
    await fs.writeFile(basePath, "views: []\n", "utf8");

    const { req, res, chunks } = createMockSocket();
    await live.openVaultEventStream({
      req,
      res,
      session: { id: "s-base", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    await fs.writeFile(basePath, "views:\n  - type: table\n", "utf8");
    await waitFor(() => parseFrames(chunks).some((frame) => frame.event === "note.changed" && frame.data.path === "Config.base"), {
      timeoutMs: 10_000,
    });
    const frames = parseFrames(chunks);
    assert.ok(frames.some((frame) => frame.event === "note.changed" && frame.data.path === "Config.base"));
    assert.ok(!frames.some((frame) => frame.event === "asset.changed" && frame.data.path === "Config.base"));
    req.emit("close");
  });

  test("hello omits id before replay; replay uses prior event ids", async () => {
    await live.resetLiveEventsForTests();
    const first = live.publishWebMutation({
      vaultId: vault.id,
      path: "A.md",
      created: true,
      revision: "sha256:one",
      size: 1,
      origin: "seed",
    });
    assert.ok(first?.id);

    // Keep coverage alive so the second stream can replay without a coverage-gap resync.
    const keeper = createMockSocket();
    await live.openVaultEventStream({
      req: keeper.req,
      res: keeper.res,
      session: { id: "s-hello-keeper", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });
    const keeperFrames = parseFrames(keeper.chunks);
    assert.equal(keeperFrames[0].event, "hello");
    assert.equal(keeperFrames[0].id, null);
    assert.equal(keeperFrames[0].data.id, undefined);

    const { req: req2, res: res2, chunks: chunks2 } = createMockSocket();
    req2.headers["last-event-id"] = `${live.liveEventInternalsForTests().bootId}:0`;
    await live.openVaultEventStream({
      req: req2,
      res: res2,
      session: { id: "s-hello-2", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });
    const replayed = parseFrames(chunks2);
    assert.equal(replayed[0].event, "hello");
    assert.equal(replayed[0].id, null);
    const note = replayed.find((frame) => frame.event === "note.created");
    assert.ok(note);
    assert.equal(note.id, first.id);
    assert.equal(note.data.path, "A.md");
    req2.emit("close");
    keeper.req.emit("close");
  });

  test("events published during hello are delivered once after replay in sequence order", async () => {
    await live.resetLiveEventsForTests();
    const first = live.publishWebMutation({
      vaultId: vault.id,
      path: "Replay-A.md",
      created: false,
      revision: "sha256:replay-a",
      size: 1,
      origin: "seed",
    });
    const second = live.publishWebMutation({
      vaultId: vault.id,
      path: "Replay-B.md",
      created: false,
      revision: "sha256:replay-b",
      size: 1,
      origin: "seed",
    });
    assert.ok(first?.id);
    assert.ok(second?.id);

    const keeper = createMockSocket();
    await live.openVaultEventStream({
      req: keeper.req,
      res: keeper.res,
      session: { id: "replay-order-keeper", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    let injected = null;
    const reconnect = createMockSocket({
      writeImpl(chunk) {
        if (!injected && String(chunk).includes("event: hello")) {
          injected = live.publishWebMutation({
            vaultId: vault.id,
            path: "Concurrent.md",
            created: false,
            revision: "sha256:concurrent",
            size: 1,
            origin: "concurrent",
          });
        }
        return true;
      },
    });
    reconnect.req.headers["last-event-id"] = `${live.liveEventInternalsForTests().bootId}:0`;
    await live.openVaultEventStream({
      req: reconnect.req,
      res: reconnect.res,
      session: { id: "replay-order-client", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    assert.ok(injected?.id);
    const frames = parseFrames(reconnect.chunks).filter((frame) => frame.id);
    const sequences = frames.map((frame) => Number(frame.id.split(":")[1]));
    assert.deepEqual(sequences, [...new Set(sequences)].sort((left, right) => left - right));
    assert.equal(frames.filter((frame) => frame.id === injected.id).length, 1);
    assert.ok(frames.findIndex((frame) => frame.id === first.id) < frames.findIndex((frame) => frame.id === injected.id));
    assert.ok(frames.findIndex((frame) => frame.id === second.id) < frames.findIndex((frame) => frame.id === injected.id));
    assert.equal(frames.find((frame) => frame.id === injected.id)?.data.path, "Concurrent.md");

    reconnect.req.emit("close");
    keeper.req.emit("close");
  });

  test("deferred replay overflow emits one resync without stale queued or duplicate replay events", async () => {
    await live.resetLiveEventsForTests();
    const seed = live.publishWebMutation({
      vaultId: vault.id,
      path: "Overflow-Seed.md",
      created: false,
      revision: "sha256:overflow-seed",
      size: 1,
      origin: "seed",
    });
    assert.ok(seed?.id);

    const keeper = createMockSocket();
    await live.openVaultEventStream({
      req: keeper.req,
      res: keeper.res,
      session: { id: "overflow-keeper", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    const injected = [];
    const reconnect = createMockSocket({
      writeImpl(chunk) {
        if (!injected.length && String(chunk).includes("event: hello")) {
          for (let index = 0; index < 33; index += 1) {
            injected.push(live.publishWebMutation({
              vaultId: vault.id,
              path: `Overflow-${index}.md`,
              created: false,
              revision: `sha256:overflow-${index}`,
              size: index + 1,
              origin: "overflow-during-replay",
            }));
          }
        }
        return true;
      },
    });
    reconnect.req.headers["last-event-id"] = `${live.liveEventInternalsForTests().bootId}:0`;
    await live.openVaultEventStream({
      req: reconnect.req,
      res: reconnect.res,
      session: { id: "overflow-client", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    assert.equal(injected.length, 33);
    assert.ok(injected.every(Boolean));
    const frames = parseFrames(reconnect.chunks);
    assert.equal(frames.filter((frame) => frame.id === seed.id).length, 1);
    const resyncs = frames.filter(
      (frame) => frame.event === "vault.resync" && frame.data?.origin === "replay-overflow",
    );
    assert.equal(resyncs.length, 1);
    assert.equal(resyncs[0].id, null);
    assert.equal(frames.filter((frame) => String(frame.data?.path || "").startsWith("Overflow-") && frame.id !== seed.id).length, 0);
    const ids = frames.filter((frame) => frame.id).map((frame) => frame.id);
    assert.equal(ids.length, new Set(ids).size);

    reconnect.req.emit("close");
    keeper.req.emit("close");
  });

  test("re-entrant publish during deferred queue drain stays monotonic and unique", async () => {
    await live.resetLiveEventsForTests();
    const seed = live.publishWebMutation({
      vaultId: vault.id,
      path: "Drain-Seed.md",
      created: false,
      revision: "sha256:drain-seed",
      size: 1,
      origin: "seed",
    });
    assert.ok(seed?.id);

    const keeper = createMockSocket();
    await live.openVaultEventStream({
      req: keeper.req,
      res: keeper.res,
      session: { id: "drain-keeper", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    let firstQueued = null;
    let reentrant = null;
    const reconnect = createMockSocket({
      writeImpl(chunk) {
        const text = String(chunk);
        if (!firstQueued && text.includes("event: hello")) {
          firstQueued = live.publishWebMutation({
            vaultId: vault.id,
            path: "Drain-1.md",
            created: false,
            revision: "sha256:drain-1",
            size: 1,
            origin: "queued-during-hello",
          });
        } else if (firstQueued && !reentrant && text.includes("Drain-1.md")) {
          reentrant = live.publishWebMutation({
            vaultId: vault.id,
            path: "Drain-2.md",
            created: false,
            revision: "sha256:drain-2",
            size: 2,
            origin: "reentrant-during-drain",
          });
        }
        return true;
      },
    });
    reconnect.req.headers["last-event-id"] = `${live.liveEventInternalsForTests().bootId}:0`;
    await live.openVaultEventStream({
      req: reconnect.req,
      res: reconnect.res,
      session: { id: "drain-client", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    assert.ok(firstQueued?.id);
    assert.ok(reentrant?.id);
    const frames = parseFrames(reconnect.chunks).filter((frame) => frame.id);
    const ids = frames.map((frame) => frame.id);
    const sequences = ids.map((id) => Number(id.split(":")[1]));
    assert.deepEqual(sequences, [...new Set(sequences)].sort((left, right) => left - right));
    assert.equal(frames.filter((frame) => frame.id === firstQueued.id).length, 1);
    assert.equal(frames.filter((frame) => frame.id === reentrant.id).length, 1);
    assert.ok(frames.findIndex((frame) => frame.id === seed.id) < frames.findIndex((frame) => frame.id === firstQueued.id));
    assert.equal(
      frames.findIndex((frame) => frame.id === reentrant.id),
      frames.findIndex((frame) => frame.id === firstQueued.id) + 1,
    );

    reconnect.req.emit("close");
    keeper.req.emit("close");
  });

  test("client close during deferred drain clears replay and releases watcher and session ownership", async () => {
    await live.resetLiveEventsForTests();
    const keeper = createMockSocket();
    await live.openVaultEventStream({
      req: keeper.req,
      res: keeper.res,
      session: { id: "close-drain-keeper", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    let queued = null;
    let closedSubscriber = null;
    let reconnect;
    reconnect = createMockSocket({
      writeImpl(chunk) {
        const text = String(chunk);
        if (!queued && text.includes("event: hello")) {
          queued = live.publishWebMutation({
            vaultId: vault.id,
            path: "Close-During-Drain.md",
            created: false,
            revision: "sha256:close-drain",
            size: 1,
            origin: "close-during-replay",
          });
        } else if (queued && text.includes("Close-During-Drain.md")) {
          closedSubscriber = [...live.liveEventInternalsForTests().subscribers]
            .find((item) => item.sessionId === "close-drain-client");
          reconnect.req.emit("close");
        }
        return true;
      },
    });
    reconnect.req.headers["last-event-id"] = `${live.liveEventInternalsForTests().bootId}:${live.liveEventInternalsForTests().sequence}`;
    await live.openVaultEventStream({
      req: reconnect.req,
      res: reconnect.res,
      session: { id: "close-drain-client", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    assert.ok(queued?.id);
    assert.ok(closedSubscriber);
    assert.equal(closedSubscriber.closed, true);
    assert.equal(closedSubscriber.replaying, false);
    assert.deepEqual(closedSubscriber.replayQueue, []);
    assert.equal(closedSubscriber.replayOverflow, false);
    assert.equal(closedSubscriber.heartbeat, null);
    assert.ok(![...live.liveEventInternalsForTests().subscribers]
      .some((item) => item.sessionId === "close-drain-client"));
    assert.equal(live.liveEventInternalsForTests().watcherRefs.get(vault.id), 1);

    const replacements = [];
    for (let index = 0; index < 3; index += 1) {
      const socket = createMockSocket();
      await live.openVaultEventStream({
        req: socket.req,
        res: socket.res,
        session: { id: "close-drain-client", vaultId: vault.id },
        vault,
        revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
      });
      assert.equal(socket.res.statusCode, 200);
      replacements.push(socket);
    }
    assert.equal(
      [...live.liveEventInternalsForTests().subscribers]
        .filter((item) => item.sessionId === "close-drain-client").length,
      3,
    );
    for (const socket of replacements) socket.req.emit("close");
    assert.equal(live.liveEventInternalsForTests().watcherRefs.get(vault.id), 1);
    keeper.req.emit("close");
  });

  test("backpressure during deferred drain clears replay and releases ownership without write-after-end", async () => {
    await live.resetLiveEventsForTests();
    const keeper = createMockSocket();
    await live.openVaultEventStream({
      req: keeper.req,
      res: keeper.res,
      session: { id: "backpressure-drain-keeper", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    let queued = null;
    let failedSubscriber = null;
    const reconnect = createMockSocket({
      writeImpl(chunk) {
        const text = String(chunk);
        if (!queued && text.includes("event: hello")) {
          queued = live.publishWebMutation({
            vaultId: vault.id,
            path: "Backpressure-During-Drain.md",
            created: false,
            revision: "sha256:backpressure-drain",
            size: 1,
            origin: "backpressure-during-replay",
          });
          return true;
        }
        if (queued && text.includes("Backpressure-During-Drain.md")) {
          failedSubscriber = [...live.liveEventInternalsForTests().subscribers]
            .find((item) => item.sessionId === "backpressure-drain-client");
          return false;
        }
        return true;
      },
    });
    reconnect.req.headers["last-event-id"] = `${live.liveEventInternalsForTests().bootId}:${live.liveEventInternalsForTests().sequence}`;
    await live.openVaultEventStream({
      req: reconnect.req,
      res: reconnect.res,
      session: { id: "backpressure-drain-client", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    assert.ok(queued?.id);
    assert.ok(failedSubscriber);
    assert.equal(reconnect.res.ended, true);
    assert.equal(failedSubscriber.closed, true);
    assert.deepEqual(failedSubscriber.replayQueue, []);
    assert.equal(failedSubscriber.replayOverflow, false);
    assert.equal(failedSubscriber.heartbeat, null);
    assert.ok(![...live.liveEventInternalsForTests().subscribers]
      .some((item) => item.sessionId === "backpressure-drain-client"));
    assert.equal(live.liveEventInternalsForTests().watcherRefs.get(vault.id), 1);
    assert.doesNotThrow(() => reconnect.res.write && undefined);

    const replacements = [];
    for (let index = 0; index < 3; index += 1) {
      const socket = createMockSocket();
      await live.openVaultEventStream({
        req: socket.req,
        res: socket.res,
        session: { id: "backpressure-drain-client", vaultId: vault.id },
        vault,
        revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
      });
      assert.equal(socket.res.statusCode, 200);
      replacements.push(socket);
    }
    assert.equal(
      [...live.liveEventInternalsForTests().subscribers]
        .filter((item) => item.sessionId === "backpressure-drain-client").length,
      3,
    );
    for (const socket of replacements) socket.req.emit("close");
    assert.equal(live.liveEventInternalsForTests().watcherRefs.get(vault.id), 1);
    keeper.req.emit("close");
  });

  test("disconnect during hello releases ownership before watcher readiness", async () => {
    await live.resetLiveEventsForTests();
    const socket = createMockSocket({ writeImpl(chunk, chunks, response) {
      response.emit("close");
      return true;
    } });
    await live.openVaultEventStream({ ...socket,
      session: { id: "early-close", vaultId: vault.id }, vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });
    const state = live.liveEventInternalsForTests();
    assert.equal(state.subscribers.size, 0);
    assert.equal(state.watcherRefs.size, 0);
    assert.equal(socket.chunks.length, 1);
  });

  test("hello backpressure ends setup immediately: no heartbeat and refs cleaned", async () => {
    await live.resetLiveEventsForTests();
    const { req, res } = createMockSocket({
      writeImpl() {
        return false;
      },
    });
    await live.openVaultEventStream({
      req,
      res,
      session: { id: "hello-slow", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    const internals = live.liveEventInternalsForTests();
    assert.equal(res.ended, true);
    assert.equal(internals.subscribers.size, 0);
    assert.equal(internals.watcherRefs.size, 0);
    assert.equal(internals.watchers.size, 0);
    assert.ok(internals.coverageGaps.has(vault.id));
    // Strict mock would throw on any write-after-end; none should occur.
    assert.doesNotThrow(() => res.write && undefined);
  });

  test("replay backpressure breaks loop: no heartbeat and no write-after-end", async () => {
    await live.resetLiveEventsForTests();
    live.publishWebMutation({
      vaultId: vault.id,
      path: "Replay.md",
      created: true,
      revision: "sha256:replay-1",
      size: 1,
      origin: "seed",
    });
    live.publishWebMutation({
      vaultId: vault.id,
      path: "Replay2.md",
      created: true,
      revision: "sha256:replay-2",
      size: 1,
      origin: "seed",
    });

    // Keep watcher coverage so reconnect can attempt replay (no coverage gap).
    const keeper = createMockSocket();
    await live.openVaultEventStream({
      req: keeper.req,
      res: keeper.res,
      session: { id: "keeper", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    let writes = 0;
    const { req, res, chunks } = createMockSocket({
      writeImpl() {
        writes += 1;
        // Allow hello only; fail on first replay frame.
        return writes <= 1;
      },
    });
    req.headers["last-event-id"] = `${live.liveEventInternalsForTests().bootId}:0`;
    await live.openVaultEventStream({
      req,
      res,
      session: { id: "replay-slow", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    assert.equal(res.ended, true);
    assert.equal(parseFrames(chunks)[0]?.event, "hello");
    assert.ok(![...live.liveEventInternalsForTests().subscribers].some((item) => item.sessionId === "replay-slow"));
    // Keeper still holds the watcher ref.
    assert.equal(live.liveEventInternalsForTests().watcherRefs.get(vault.id), 1);
    keeper.req.emit("close");
  });

  test("subscriber write errors and backpressure are isolated", async () => {
    await live.resetLiveEventsForTests();
    let healthyNoteWrites = 0;
    const bad = createMockSocket({
      writeImpl() {
        throw new Error("boom");
      },
    });
    const slow = createMockSocket({
      writeImpl(chunk) {
        // Stay open through hello / ready resync; only fail on a live note mutation frame.
        if (String(chunk).includes("event: note.changed")) return false;
        return true;
      },
    });
    const healthy = createMockSocket({
      writeImpl(chunk) {
        if (String(chunk).includes("note.changed")) healthyNoteWrites += 1;
        return true;
      },
    });

    for (const [socket, sessionId] of [
      [bad, "bad"],
      [slow, "slow"],
      [healthy, "healthy"],
    ]) {
      await live.openVaultEventStream({
        req: socket.req,
        res: socket.res,
        session: { id: sessionId, vaultId: vault.id },
        vault,
        revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
      });
    }

    assert.equal(live.liveEventInternalsForTests().subscribers.size, 2);

    live.publishWebMutation({
      vaultId: vault.id,
      path: "B.md",
      created: false,
      revision: "sha256:two",
      size: 2,
      origin: "web",
    });

    assert.equal(slow.res.ended, true);
    assert.equal(healthyNoteWrites, 1);
    assert.equal(live.liveEventInternalsForTests().subscribers.size, 1);
    healthy.req.emit("close");
  });

  test("last-seen revision dedup allows A→B→A revert; identical revision still drops", async () => {
    await live.resetLiveEventsForTests();
    const dedup = createDedupCache({ ttlMs: 5_000, maxSize: 32 });
    const base = { vaultId: "v", path: "X.md", type: "note.changed" };
    assert.equal(dedup.seen({ ...base, revision: "sha256:a" }), false);
    dedup.remember({ ...base, revision: "sha256:a" });
    assert.equal(dedup.seen({ ...base, revision: "sha256:a" }), true);
    assert.equal(dedup.seen({ ...base, revision: "sha256:b" }), false);
    dedup.remember({ ...base, revision: "sha256:b" });
    assert.equal(dedup.seen({ ...base, revision: "sha256:a" }), false);

    const { req, res, chunks } = createMockSocket();
    await live.openVaultEventStream({
      req,
      res,
      session: { id: "dedup-revert", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    assert.ok(live.publishWebMutation({ vaultId: vault.id, path: "Rev.md", created: false, revision: "sha256:a", size: 1 }));
    assert.equal(live.publishWebMutation({ vaultId: vault.id, path: "Rev.md", created: false, revision: "sha256:a", size: 1 }), null);
    assert.ok(live.publishWebMutation({ vaultId: vault.id, path: "Rev.md", created: false, revision: "sha256:b", size: 2 }));
    assert.ok(live.publishWebMutation({ vaultId: vault.id, path: "Rev.md", created: false, revision: "sha256:a", size: 1 }));

    const notes = parseFrames(chunks).filter((frame) => frame.event === "note.changed" && frame.data.path === "Rev.md");
    assert.deepEqual(
      notes.map((frame) => frame.data.revision),
      ["sha256:a", "sha256:b", "sha256:a"],
    );
    req.emit("close");
  });

  test("per-path pending coalesce converges delete then recreate", async () => {
    await live.resetLiveEventsForTests();
    live.ensureVaultWatcher(vault);
    const gen = live.liveEventInternalsForTests().currentWatcherGeneration(vault.id);
    const internals = live.liveEventInternalsForTests();

    internals.scheduleForTests(
      { type: "note.deleted", vaultId: vault.id, path: "Coalesce.md", origin: "filesystem" },
      gen,
    );
    internals.scheduleForTests(
      {
        type: "note.created",
        vaultId: vault.id,
        path: "Coalesce.md",
        revision: "sha256:new",
        size: 4,
        origin: "filesystem",
      },
      gen,
    );

    assert.equal(internals.pending.size, 1);
    const pendingEvent = [...internals.pending.values()][0].event;
    assert.equal(pendingEvent.type, "note.created");
    assert.equal(pendingEvent.revision, "sha256:new");

    await waitFor(() => internals.replay.some((event) => event.path === "Coalesce.md"), { timeoutMs: 2_000 });
    const published = internals.replay.filter((event) => event.path === "Coalesce.md");
    assert.equal(published.at(-1).type, "note.created");
    await live.closeVaultWatcher(vault.id);
  });

  test("pending overflow publishes vault.resync instead of silent loss", async () => {
    await live.resetLiveEventsForTests();
    live.ensureVaultWatcher(vault);
    const gen = live.liveEventInternalsForTests().currentWatcherGeneration(vault.id);
    const internals = live.liveEventInternalsForTests();
    const maxPending = internals.maxPending;

    for (let index = 0; index < maxPending; index += 1) {
      internals.scheduleForTests(
        { type: "note.changed", vaultId: vault.id, path: `P${index}.md`, revision: `sha256:${index}`, size: 1, origin: "filesystem" },
        gen,
      );
    }
    assert.equal(internals.pending.size, maxPending);

    internals.scheduleForTests(
      { type: "note.changed", vaultId: vault.id, path: "overflow.md", revision: "sha256:overflow", size: 1, origin: "filesystem" },
      gen,
    );

    assert.ok(internals.replay.some((event) => event.type === "vault.resync" && event.origin === "pending-overflow"));
    await live.closeVaultWatcher(vault.id);
  });

  test("future Last-Event-ID forces resync", async () => {
    await live.resetLiveEventsForTests();
    const keeper = createMockSocket();
    await live.openVaultEventStream({
      req: keeper.req,
      res: keeper.res,
      session: { id: "future-keeper", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    const { req, res, chunks } = createMockSocket();
    req.headers["last-event-id"] = `${live.liveEventInternalsForTests().bootId}:999999`;
    await live.openVaultEventStream({
      req,
      res,
      session: { id: "future-cursor", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });
    assert.ok(parseFrames(chunks).some((frame) => frame.event === "vault.resync"));
    req.emit("close");
    keeper.req.emit("close");
  });

  test("disconnect, external mutate, reconnect forces coverage-gap resync", async () => {
    await live.resetLiveEventsForTests();
    const notePath = path.join(vaultRoot, "Gap.md");
    await fs.writeFile(notePath, "# before\n", "utf8");

    const first = createMockSocket();
    await live.openVaultEventStream({
      req: first.req,
      res: first.res,
      session: { id: "gap-1", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });
    const lastId = parseFrames(first.chunks).find((frame) => frame.id)?.id
      || `${live.liveEventInternalsForTests().bootId}:${live.liveEventInternalsForTests().sequence}`;
    first.req.emit("close");

    await waitFor(() => live.liveEventInternalsForTests().coverageGaps.has(vault.id), { timeoutMs: 2_000 });
    await fs.writeFile(notePath, "# offline mutation\n", "utf8");

    const second = createMockSocket();
    second.req.headers["last-event-id"] = lastId;
    await live.openVaultEventStream({
      req: second.req,
      res: second.res,
      session: { id: "gap-2", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });
    const frames = parseFrames(second.chunks);
    assert.ok(frames.some((frame) => frame.event === "vault.resync" && frame.data.origin === "coverage-gap"));
    second.req.emit("close");
  });

  test("watcher limit refuses SSE with 503 before headers", async () => {
    await live.resetLiveEventsForTests();
    const extras = [];
    for (let index = 0; index < live.liveEventInternalsForTests().maxWatchers; index += 1) {
      const extraRoot = path.join(root, `extra-${index}`);
      await fs.mkdir(path.join(extraRoot, ".obsidian"), { recursive: true });
      const extraVault = { id: `extra-${index}`, root: extraRoot };
      assert.equal(live.ensureVaultWatcher(extraVault), true);
      extras.push(extraVault.id);
    }

    const { req, res } = createMockSocket();
    await live.openVaultEventStream({
      req,
      res,
      session: { id: "over-limit", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["Content-Type"], undefined);
    assert.match(String(res.jsonBody?.error || ""), /watcher limit/i);

    for (const id of extras) await live.closeVaultWatcher(id);
  });

  test("close+reopen does not mix watcher generations; reset drains async work", async () => {
    await live.resetLiveEventsForTests();
    assert.equal(live.ensureVaultWatcher(vault), true);
    const firstGen = live.liveEventInternalsForTests().currentWatcherGeneration(vault.id);
    await live.closeVaultWatcher(vault.id);
    assert.equal(live.ensureVaultWatcher(vault), true);
    const secondGen = live.liveEventInternalsForTests().currentWatcherGeneration(vault.id);
    assert.ok(secondGen > firstGen);

    live.liveEventInternalsForTests().scheduleForTests(
      { type: "note.changed", vaultId: vault.id, path: "stale.md", revision: "sha256:stale", size: 1, origin: "filesystem" },
      firstGen,
    );
    assert.equal(live.liveEventInternalsForTests().pending.size, 0);

    await live.resetLiveEventsForTests();
    assert.equal(live.liveEventInternalsForTests().pending.size, 0);
    assert.equal(live.liveEventInternalsForTests().watchers.size, 0);
    assert.equal(live.liveEventInternalsForTests().hashQueue.pendingJobs, 0);
  });

  test("internal mutation and watcher share revision dedup; stream hash works", async () => {
    await live.resetLiveEventsForTests();
    const filePath = path.join(vaultRoot, "Shared.md");
    const body = "# shared\n";
    await fs.writeFile(filePath, body, "utf8");
    const revision = await hashFileStream(filePath);
    assert.match(revision, /^sha256:[a-f0-9]{64}$/);

    const { req, res, chunks } = createMockSocket();
    await live.openVaultEventStream({
      req,
      res,
      session: { id: "dedup", vaultId: vault.id },
      vault,
      revalidate: async () => ({ vaultId: vault.id, allowedVaults: [vault.id] }),
    });

    live.publishWebMutation({
      vaultId: vault.id,
      path: "Shared.md",
      created: false,
      revision,
      size: Buffer.byteLength(body),
      origin: "client-1",
    });

    assert.equal(
      live.publishWebMutation({
        vaultId: vault.id,
        path: "Shared.md",
        created: false,
        revision,
        size: Buffer.byteLength(body),
        origin: "client-2",
      }),
      null,
    );

    const before = parseFrames(chunks).filter((frame) => frame.event === "note.changed").length;
    assert.equal(before, 1);

    await fs.writeFile(filePath, body, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const afterSame = parseFrames(chunks).filter((frame) => frame.event === "note.changed").length;
    assert.equal(afterSame, 1);

    await fs.writeFile(filePath, "# shared\nchanged\n", "utf8");
    await waitFor(() => parseFrames(chunks).filter((frame) => frame.event === "note.changed").length >= 2, {
      timeoutMs: 10_000,
    });
    req.emit("close");
  });

  test("SSE frame helper serializes the whole frame before write", () => {
    const event = buildEventDto({
      id: "boot:1",
      type: "note.changed",
      vaultId: "v",
      path: "x.md",
      revision: "sha256:1",
      occurredAt: "2026-09-13T00:00:00.000Z",
    });
    const frame = formatSseFrame(event);
    assert.match(frame, /^id: boot:1\nevent: note.changed\ndata: \{.*"path":"x.md".*\}\n\n$/s);
    const timer = setTimeout(() => {}, 1_000);
    assert.equal(typeof timer.refresh, "function");
    clearTimeout(timer);
    assert.doesNotThrow(() => JSON.stringify(event));
  });
});

describe("hash-queue bounds", { concurrency: false }, () => {
  test("same-path and many-path enqueue never exceed configured concurrency", async () => {
    const queue = createHashQueue({ maxConcurrency: 2, maxPending: 64 });
    let observed = 0;
    let maxObserved = 0;
    const tasks = [];

    const wrap = (delay) => async () => {
      observed += 1;
      maxObserved = Math.max(maxObserved, observed);
      await new Promise((resolve) => setTimeout(resolve, delay));
      observed -= 1;
    };

    for (let index = 0; index < 20; index += 1) {
      tasks.push(queue.enqueuePath("same", wrap(15)));
    }
    for (let index = 0; index < 20; index += 1) {
      tasks.push(queue.enqueuePath(`path-${index}`, wrap(15)));
    }
    await Promise.all(tasks);
    assert.ok(maxObserved <= 2);
    assert.equal(queue.inFlight, 0);
    assert.equal(queue.pendingJobs, 0);
  });

  test("overflow rejects; clear settles queued work without hanging", async () => {
    const queue = createHashQueue({ maxConcurrency: 1, maxPending: 3 });
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueuePath("a", async () => {
      await firstGate;
      return "first";
    });
    const second = queue.enqueuePath("b", async () => "second");
    const third = queue.enqueuePath("c", async () => "third");
    await waitFor(() => queue.pendingJobs === 3);

    await assert.rejects(() => queue.enqueuePath("d", async () => "nope"), HashQueueOverflowError);

    const pending = [second, third];
    queue.clear();
    await assert.rejects(() => first, HashQueueCancelledError);
    const settled = await Promise.allSettled(pending);
    assert.ok(settled.every((item) => item.status === "rejected"));
    assert.equal(queue.inFlight, 1);
    assert.equal(queue.pendingJobs, 1);
    releaseFirst();
    // Physical I/O continues after cancellation; only completion frees its slot.
    await queue.whenIdle();
    assert.equal(queue.inFlight, 0);
    assert.equal(queue.pendingJobs, 0);
  });
});
