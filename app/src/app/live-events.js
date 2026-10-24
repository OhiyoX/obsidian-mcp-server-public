import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { createDedupCache } from "./events/dedup.js";
import { createHashQueue, hashFileStream, HashQueueOverflowError } from "./events/hash-queue.js";
import { buildEventDto, formatSseFrame } from "./events/sse-frame.js";
import { createSseBroker } from "./events/sse-broker.js";
import { createLiveEventTeardown } from "./events/teardown.js";
import { startSubscriberHeartbeat } from "./events/heartbeat.js";
import { getWebCatalogRuntime, indexWatcherEvent, notifyVaultResync, notifyWatcherClosed, notifyWatcherReady } from "./web-catalog/runtime.js";
import { isCatalogDocumentPath } from "./web-catalog/vault-source.js";

const HEARTBEAT_MS = Math.max(10_000, Number(process.env.WEB_EVENT_HEARTBEAT_MS || 25_000));
const REPLAY_SIZE = Math.max(32, Number(process.env.WEB_EVENT_REPLAY_SIZE || 512));
const WATCH_DEBOUNCE_MS = Math.max(50, Number(process.env.WEB_FILE_WATCH_DEBOUNCE_MS || 250));
const MAX_SESSION_CONNECTIONS = Math.max(1, Number(process.env.WEB_EVENT_MAX_CONNECTIONS_PER_SESSION || 3));
const MAX_SUBSCRIBERS = Math.max(1, Number(process.env.WEB_EVENT_MAX_SUBSCRIBERS || 128));
const MAX_WATCHERS = Math.max(1, Number(process.env.WEB_EVENT_MAX_WATCHERS || 32));
const MAX_PENDING = Math.max(32, Number(process.env.WEB_EVENT_MAX_PENDING || 256));
const MAX_HASH_CONCURRENCY = Math.max(1, Number(process.env.WEB_EVENT_HASH_CONCURRENCY || 4));
const MAX_HASH_PENDING = Math.max(MAX_HASH_CONCURRENCY, Number(process.env.WEB_EVENT_MAX_HASH_PENDING || 256));
const DEDUP_TTL_MS = Math.max(1_000, Number(process.env.WEB_EVENT_DEDUP_TTL_MS || 30_000));
const DEDUP_MAX = Math.max(64, Number(process.env.WEB_EVENT_DEDUP_MAX || 2_048));
const LIVE_UPDATES = !/^(?:0|false|off|no)$/i.test(String(process.env.WEB_LIVE_UPDATES || "true"));
const WATCHER_READY_TIMEOUT_MS = Math.max(100, Number(process.env.WEB_EVENT_WATCHER_READY_TIMEOUT_MS || 5_000));

const bootId = randomUUID();
/** @type {Map<string, { watcher: import("chokidar").FSWatcher, generation: number, ready: boolean, readyPromise: Promise<void>, resolveReady: () => void, stopped: boolean }>} */
const watchers = new Map();
/** Survives close so reopen never reuses an in-flight generation. */
const watcherGenerationSeq = new Map();
const watcherRefs = new Map();
/** @type {Map<string, { timer: NodeJS.Timeout, event: Record<string, string | number>, generation: number }>} */
const pending = new Map();
/** Coverage gap markers: after last subscriber releases a watcher, offline mutations were not observed. */
const coverageGaps = new Map();
const dedup = createDedupCache({ ttlMs: DEDUP_TTL_MS, maxSize: DEDUP_MAX });
const hashQueue = createHashQueue({ maxConcurrency: MAX_HASH_CONCURRENCY, maxPending: MAX_HASH_PENDING });

const slash = (value) => String(value || "").split(path.sep).join("/");

function ignored(root, candidate) {
  const relative = slash(path.relative(root, candidate));
  if (!relative || relative.startsWith("../")) return false;
  const parts = relative.split("/");
  if (parts.includes(".git") || parts.includes("#recycle")) return true;
  if (parts[0] === ".obsidian") return true;
  return parts.some((part) => /^\..+\.(?:tmp|swp)$/i.test(part) || /(?:\.tmp|\.swp|~)$/i.test(part));
}

const broker = createSseBroker({
  bootId,
  replaySize: REPLAY_SIZE,
  maxSubscribers: MAX_SUBSCRIBERS,
  maxSessionConnections: MAX_SESSION_CONNECTIONS,
  buildEventDto,
  formatSseFrame,
  dedup,
  onWatcherRelease: (vaultId) => releaseVaultWatcher(vaultId),
});
const { subscribers, replay } = broker;
const publish = (input) => broker.publish(input);

const teardown = createLiveEventTeardown({ pending, subscribers, watchers, watcherRefs, broker, closeWatcher: closeVaultWatcher });
export function publishVaultResync(vaultId, origin) {
  notifyVaultResync(vaultId, origin);
  try {
    return publish({
      type: "vault.resync",
      vaultId,
      path: "",
      origin,
      occurredAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Web Vault resync failed (${vaultId}):`, error?.message || error);
    return null;
  }
}

function clearPendingForVault(vaultId) {
  for (const [key, record] of [...pending]) {
    if (!key.startsWith(`${vaultId}\0`)) continue;
    clearTimeout(record.timer);
    pending.delete(key);
  }
}

function dropPendingWithResync(preferredVaultId) {
  const oldestKey = pending.keys().next().value;
  if (oldestKey === undefined) {
    if (preferredVaultId) publishVaultResync(preferredVaultId, "pending-overflow");
    return;
  }
  const record = pending.get(oldestKey);
  const evictedVaultId = record?.event?.vaultId || preferredVaultId;
  clearTimeout(record?.timer);
  pending.delete(oldestKey);
  if (evictedVaultId) {
    clearPendingForVault(evictedVaultId);
    publishVaultResync(evictedVaultId, "pending-overflow");
  }
}

function currentWatcherGeneration(vaultId) {
  return watchers.get(vaultId)?.generation ?? 0;
}

function isWatcherGenerationCurrent(vaultId, generation) {
  const state = watchers.get(vaultId);
  return Boolean(state) && !state.stopped && state.generation === generation;
}

function schedule(input, generation) {
  const event = buildEventDto(input);
  if (!isWatcherGenerationCurrent(event.vaultId, generation)) return;

  // Per-path coalesce: delete/create/change converge to the latest observed state.
  const key = `${event.vaultId}\0${event.path}`;
  const existing = pending.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  else if (pending.size >= MAX_PENDING) dropPendingWithResync(event.vaultId);

  const timer = setTimeout(() => {
    const current = pending.get(key);
    if (current?.timer !== timer) return;
    pending.delete(key);
    if (!isWatcherGenerationCurrent(event.vaultId, generation)) return;
    try {
      publish(current.event);
    } catch (error) {
      console.error("Web live event publish failed:", error?.message || error);
    }
  }, WATCH_DEBOUNCE_MS);
  timer.unref?.();
  pending.set(key, { timer, event, generation });
}

async function inspectFile(absolute) {
  const [stat, revision] = await Promise.all([fs.stat(absolute), hashFileStream(absolute)]);
  if (!stat.isFile()) return null;
  return {
    revision,
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

async function fileEvent(vault, type, absolute, generation) {
  if (!isWatcherGenerationCurrent(vault.id, generation)) return;
  const relative = slash(path.relative(vault.root, absolute));
  if (!relative || relative.startsWith("../") || ignored(vault.root, absolute)) return;
  const queueKey = `${vault.id}\0${relative}`;
  try {
    await hashQueue.enqueuePath(queueKey, async () => {
      if (!isWatcherGenerationCurrent(vault.id, generation)) return;
      const event = {
        vaultId: vault.id,
        path: relative,
        type: isCatalogDocumentPath(relative) ? type : "asset.changed",
        origin: "filesystem",
      };
      if (type !== "note.deleted") {
        try {
          const meta = await inspectFile(absolute);
          if (!meta) return;
          if (!isWatcherGenerationCurrent(vault.id, generation)) return;
          Object.assign(event, meta);
        } catch (error) {
          if (error?.code === "ENOENT") {
            event.type = isCatalogDocumentPath(relative) ? "note.deleted" : "asset.changed";
          } else {
            throw error;
          }
        }
      }
      schedule(event, generation);
      indexWatcherEvent(vault.id, event, absolute);
    });
  } catch (error) {
    if (error instanceof HashQueueOverflowError || error?.code === "HASH_QUEUE_OVERFLOW") {
      publishVaultResync(vault.id, "hash-overflow");
      return;
    }
    if (error?.code === "HASH_QUEUE_CANCELLED") return;
    throw error;
  }
}

function canStartVaultWatcher(vaultId) {
  if (!LIVE_UPDATES) return false;
  if (watchers.has(vaultId)) return true;
  return watchers.size < MAX_WATCHERS;
}

export function ensureVaultWatcher(vault) {
  if (!LIVE_UPDATES) return false;
  const existing = watchers.get(vault.id);
  if (existing && !existing.stopped) {
    watcherRefs.set(vault.id, (watcherRefs.get(vault.id) || 0) + 1);
    return true;
  }
  if (watchers.size >= MAX_WATCHERS) {
    console.error(`Web Vault watcher limit reached (${MAX_WATCHERS}); refusing ${vault.id}`);
    return false;
  }

  let resolveReady = () => {};
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const generation = (watcherGenerationSeq.get(vault.id) || 0) + 1;
  watcherGenerationSeq.set(vault.id, generation);
  const state = {
    watcher: null,
    generation,
    ready: false,
    readyPromise,
    resolveReady,
    stopped: false,
  };

  const watcher = chokidar.watch(vault.root, {
    persistent: !process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== "test",
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: WATCH_DEBOUNCE_MS, pollInterval: 50 },
    ignored: (candidate) => ignored(vault.root, candidate),
  });
  state.watcher = watcher;

  const guard = (handler) => (...args) => {
    if (!isWatcherGenerationCurrent(vault.id, generation)) return;
    handler(...args);
  };

  watcher.on(
    "add",
    guard((absolute) => fileEvent(vault, "note.created", absolute, generation).catch(reportWatcherError)),
  );
  watcher.on(
    "change",
    guard((absolute) => fileEvent(vault, "note.changed", absolute, generation).catch(reportWatcherError)),
  );
  watcher.on(
    "unlink",
    guard((absolute) => fileEvent(vault, "note.deleted", absolute, generation).catch(reportWatcherError)),
  );
  watcher.on(
    "ready",
    guard(() => {
      state.ready = true;
      state.resolveReady();
      notifyWatcherReady(vault);
      publishVaultResync(vault.id, "watcher-ready");
    }),
  );
  watcher.on("error", guard(reportWatcherError));
  watchers.set(vault.id, state);
  watcherRefs.set(vault.id, (watcherRefs.get(vault.id) || 0) + 1);
  getWebCatalogRuntime(vault);
  return true;

  function reportWatcherError(error) {
    if (!isWatcherGenerationCurrent(vault.id, generation)) return;
    console.error(`Web Vault watcher failed (${vault.id}):`, error?.message || error);
    publishVaultResync(vault.id, "watcher-error");
  }
}

function releaseVaultWatcher(vaultId) {
  const refs = (watcherRefs.get(vaultId) || 0) - 1;
  if (refs > 0) {
    watcherRefs.set(vaultId, refs);
    return;
  }
  watcherRefs.delete(vaultId);
  notifyWatcherClosed(vaultId);
  // Last subscriber left: retain a coverage gap so reconnect must resync (offline mutations unwatched).
  const gapGeneration = (coverageGaps.get(vaultId) || 0) + 1;
  coverageGaps.set(vaultId, gapGeneration);
  // Shutdown teardown owns watcher cleanup so close failures can be reported truthfully.
  if (!teardown.isShuttingDown()) closeVaultWatcher(vaultId).catch((error) => console.error(`Web Vault watcher close failed (${vaultId}):`, error?.message || error));
}

export async function closeVaultWatcher(vaultId, { rethrow = false } = {}) {
  watcherRefs.delete(vaultId);
  const state = watchers.get(vaultId);
  if (!state) return;
  state.stopped = true;
  // Invalidate this generation; reopen allocates a fresh sequence value.
  const invalidated = (watcherGenerationSeq.get(vaultId) || state.generation) + 1;
  watcherGenerationSeq.set(vaultId, invalidated);
  state.generation = invalidated;
  state.resolveReady();
  watchers.delete(vaultId);
  clearPendingForVault(vaultId);
  try {
    await state.watcher?.close();
  } catch (error) {
    if (rethrow) throw error; // Callers that do not opt in tolerate close races.
  }
}

export function publishWebMutation({ vaultId, path: notePath, created, revision: currentRevision, size, origin, mutationId }) {
  if (!LIVE_UPDATES) return null;
  return publish({
    type: created ? "note.created" : "note.changed",
    vaultId,
    path: notePath,
    revision: currentRevision,
    size,
    origin: origin || "web",
    mutationId,
  });
}

function waitForWatcherReady(vaultId, timeoutMs = WATCHER_READY_TIMEOUT_MS) {
  const state = watchers.get(vaultId);
  if (!state || state.ready || state.stopped) return Promise.resolve();
  return Promise.race([
    state.readyPromise,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

export async function openVaultEventStream({ req, res, session, vault, revalidate }) {
  if (teardown.isShuttingDown()) return res.status(503).json({ error: "Live updates are shutting down" });
  if (!LIVE_UPDATES) return res.status(404).json({ error: "Live updates are disabled" });
  const admission = broker.canRegister(session.id);
  if (!admission.ok) return res.status(admission.status).json({ error: admission.error });
  if (!canStartVaultWatcher(vault.id)) {
    return res.status(503).json({ error: "Live updates unavailable: watcher limit reached" });
  }

  const acquiredWatcher = ensureVaultWatcher(vault);
  if (!acquiredWatcher) {
    return res.status(503).json({ error: "Live updates unavailable: watcher limit reached" });
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Snapshot replay eligibility before registration. There is no await between
  // this snapshot and register(), so normal event-loop callbacks cannot create a
  // gap. Once registered, live publishes are deferred per-subscriber until the
  // snapshot replay has drained, which also protects against synchronous
  // re-entrant publishes triggered while writing hello/replay frames.
  const hadCoverageGap = coverageGaps.has(vault.id);
  if (hadCoverageGap) coverageGaps.delete(vault.id);
  const missed = hadCoverageGap ? null : broker.replayAfter(req.get("Last-Event-ID"), vault.id);

  const subscriber = broker.register({
    res,
    vaultId: vault.id,
    sessionId: session.id,
    acquiredWatcher,
    deferLive: true,
  });
  // Register before the first write and readiness await: the client may leave
  // while the watcher is still starting.
  const close = () => broker.close(subscriber);
  req.on("close", close);
  res.on("close", close);

  // Hello must not carry the latest sequence id before replay (would skip undelivered events).
  if (
    !broker.deliver(subscriber, {
      type: "hello",
      vaultId: vault.id,
      occurredAt: new Date().toISOString(),
    })
  ) {
    return;
  }

  if (missed === null) {
    if (
      !broker.deliver(subscriber, {
        type: "vault.resync",
        vaultId: vault.id,
        path: "",
        origin: hadCoverageGap ? "coverage-gap" : "replay-gap",
        occurredAt: new Date().toISOString(),
      })
    ) {
      return;
    }
  } else {
    for (const event of missed) {
      if (!broker.deliver(subscriber, event)) return;
    }
  }

  if (!broker.finishReplay(subscriber)) return;

  // First client: wait for ready (or timeout) so we do not declare live while ignoreInitial can miss changes.
  await waitForWatcherReady(vault.id);
  if (!broker.isActive(subscriber)) return;

  const watcherState = watchers.get(vault.id);
  if (watcherState && !watcherState.ready) {
    // Ready timed out — force explicit resync rather than silently claiming live coverage.
    if (
      !broker.deliver(subscriber, {
        type: "vault.resync",
        vaultId: vault.id,
        path: "",
        origin: "watcher-not-ready",
        occurredAt: new Date().toISOString(),
      })
    ) {
      return;
    }
  }

  if (!broker.isActive(subscriber)) return;

  startSubscriberHeartbeat({ subscriber, broker, vaultId: vault.id, revalidate, intervalMs: HEARTBEAT_MS });
}

export const teardownLiveEvents = teardown.teardown;
/** Test helper: drain timers, watchers, and in-memory queues. Awaits in-flight watcher close. */
export async function resetLiveEventsForTests() {
  teardown.reset();
  for (const record of pending.values()) clearTimeout(record.timer);
  pending.clear();
  broker.reset();
  watcherRefs.clear();
  coverageGaps.clear();
  dedup.clear();
  hashQueue.clear();
  const ids = [...watchers.keys()];
  for (const id of ids) await closeVaultWatcher(id);
  await hashQueue.whenIdle();
  watcherGenerationSeq.clear();
  // Allow stray hash tasks from prior generations to settle without repopulating.
  await new Promise((resolve) => setImmediate(resolve));
  pending.clear();
}

export function liveEventInternalsForTests() {
  return {
    bootId,
    pending,
    replay,
    subscribers,
    watchers,
    watcherRefs,
    coverageGaps,
    dedup,
    hashQueue,
    get sequence() {
      return broker.sequence;
    },
    get maxSubscribers() {
      return broker.maxSubscribers;
    },
    get maxPending() {
      return MAX_PENDING;
    },
    get maxWatchers() {
      return MAX_WATCHERS;
    },
    currentWatcherGeneration,
    publishVaultResync,
    scheduleForTests: schedule,
    canStartVaultWatcher,
  };
}

export const liveUpdatesEnabled = LIVE_UPDATES;
