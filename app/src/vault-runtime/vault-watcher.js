// W4 (#437) — the two AUTOMATIC triggers of the ONE reconciliation service: a directory watcher
// plus a bounded periodic scan fallback.
//
// Authority: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - Vault 热发现与准入（Issue 437）.md`
//   §1   四类触发（启动 / 人工 / watcher / 周期）进同一个进程内 reconciliation 服务。The service owns
//        single-flight and "at most one pending rerun"; THIS module owns only the *rate* of the two
//        automatic triggers. It never scans, never diffs and never publishes: every trigger is a call
//        into the unified service (`reconcile(trigger)`), which is also what makes an event storm
//        bounded — a trigger that arrives while a round is running is coalesced by the service into
//        the single pending-rerun flag instead of queueing.
//   §5   发现 ≠ 授权：the watcher callback only ASKS for a round; it never touches
//        `admitted`/`pending`/scope/`allowedVaults`.
//   §6   可观测性：触发次数、合并次数、订阅数、连续失败、退避后的当前周期、最后成功/失败。Diagnostics
//        carry an error code and the parent's ordinal — never an absolute path (issue §5 "不记录敏感
//        目录绝对路径/凭据").
//   §10  自动发现默认关闭：`enabled !== true` ⇒ neither a watch handle, a stat nor a timer is created.
//
// Frozen parameters (Codex ruling 2026-10-09, issue #437): debounce 500 ms, longest merge wait 5 s,
// periodic default 60 s (operator range 30–900 s), failure backoff up to 900 s. The operator range is
// enforced by `config.js`; this module accepts any positive integer so tests can drive the scheduler
// deterministically (and so a future caller can shorten the interval for a container without
// re-freezing the contract).
//
// Why the periodic scan is the CORRECTNESS path and the watcher only the latency path:
//   * `fs.watch` has no overflow signal at all on Linux (an inotify queue overflow is silent) and
//     coalesces/drops events on network filesystems, so "no event" can never mean "no change";
//   * a watcher `error` (the watched parent was removed/replaced, EACCES after a mount change, a
//     transient ENOENT on a NAS) would otherwise be an unhandled 'error' event that kills the process.
//     It is converted into a diagnostic + a closed subscription, and re-subscription is retried once
//     per completed round;
//   * a parent that is invisible in this mount namespace is reported as a diagnostic
//     (`VAULT_WATCH_PARENT_MISSING`/`VAULT_WATCH_PARENT_UNREADABLE`) — never as a discovered Vault
//     (issue §1 "不得宣称任意宿主机新目录都能自动接入").

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { RECONCILIATION_TRIGGER_PERIODIC, RECONCILIATION_TRIGGER_WATCHER } from "./reconciliation-vocabulary.js";

export const VAULT_WATCHER_CONFIG_INVALID = "VAULT_WATCHER_CONFIG_INVALID";
export const VAULT_WATCH_PARENT_MISSING = "VAULT_WATCH_PARENT_MISSING";
export const VAULT_WATCH_PARENT_UNREADABLE = "VAULT_WATCH_PARENT_UNREADABLE";
export const VAULT_WATCH_SUBSCRIPTION_FAILED = "VAULT_WATCH_SUBSCRIPTION_FAILED";
export const VAULT_WATCH_SUBSCRIPTION_ERROR = "VAULT_WATCH_SUBSCRIPTION_ERROR";
export const VAULT_WATCH_RECONCILE_REJECTED = "VAULT_WATCH_RECONCILE_REJECTED";
export const VAULT_WATCH_UNKNOWN_EVENT = "VAULT_WATCH_UNKNOWN_EVENT";

/** Frozen defaults (contract §1). `WATCH_PERIODIC_MIN_MS`/`MAX` are the operator range of the period. */
export const WATCH_DEBOUNCE_MS = 500;
export const WATCH_MAX_COALESCE_MS = 5000;
export const WATCH_PERIODIC_MS = 60_000;
export const WATCH_PERIODIC_MIN_MS = 30_000;
export const WATCH_PERIODIC_MAX_MS = 900_000;

/** The watched set is the configured discovery parents — one per deployment. A hard cap keeps a
 *  misconfiguration from opening an unbounded number of watch handles. */
const MAX_WATCHED_PARENTS = 8;
const DIAGNOSTIC_LIMIT = 20;

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

/** Timer seam: production uses the global timers; tests inject a deterministic clock. */
function resolveWatchTimers(scheduler) {
  if (scheduler === null || scheduler === undefined) {
    return { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle), unref: (handle) => handle?.unref?.() };
  }
  if (typeof scheduler.setTimeout !== "function" || typeof scheduler.clearTimeout !== "function") {
    fail(VAULT_WATCHER_CONFIG_INVALID, "scheduler must expose setTimeout/clearTimeout when provided");
  }
  return { setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout, unref: scheduler.unref ?? ((handle) => handle?.unref?.()) };
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) fail(VAULT_WATCHER_CONFIG_INVALID, `${name} must be a positive integer in ms; got ${String(value)}`);
  return value;
}

/**
 * `createVaultWatcher({ reconcile, parents, enabled, debounceMs, maxCoalesceMs, periodicMs, maxBackoffMs,
 *   scheduler, watch, statApi, now, logger })`
 *
 *   reconcile — `(trigger, options) => summary|{status:"coalesced"}`, i.e. the unified service's
 *               `reconcile`. The ONLY way this module can influence the inventory.
 *   parents   — the configured discovery parent directories (their DIRECT children are candidates;
 *               the registry, not this module, decides what is a Vault).
 *   enabled   — `VAULT_DISCOVERY_ENABLED`. `false` ⇒ `start()` creates nothing at all (contract §10).
 *
 * Returns a frozen `{ start, stop, status }`. `start()` is idempotent and, when disabled, safe to
 * call: it reports `watcher: false, periodic: false` without touching the filesystem.
 */
export function createVaultWatcher({
  reconcile,
  parents = [],
  enabled = false,
  debounceMs = WATCH_DEBOUNCE_MS,
  maxCoalesceMs = WATCH_MAX_COALESCE_MS,
  periodicMs = WATCH_PERIODIC_MS,
  maxBackoffMs = WATCH_PERIODIC_MAX_MS,
  scheduler = null,
  watch = null,
  statApi = null,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (typeof reconcile !== "function") fail(VAULT_WATCHER_CONFIG_INVALID, "reconcile must be the unified reconciliation service's reconcile(trigger, options)");
  if (typeof now !== "function") fail(VAULT_WATCHER_CONFIG_INVALID, "now must be a function returning epoch ms");
  requirePositiveInteger(debounceMs, "debounceMs");
  requirePositiveInteger(maxCoalesceMs, "maxCoalesceMs");
  requirePositiveInteger(periodicMs, "periodicMs");
  requirePositiveInteger(maxBackoffMs, "maxBackoffMs");
  if (maxCoalesceMs < debounceMs) {
    fail(VAULT_WATCHER_CONFIG_INVALID, `maxCoalesceMs (${maxCoalesceMs}) must be >= debounceMs (${debounceMs}): the longest merge wait can never be shorter than the debounce`);
  }
  if (maxBackoffMs < periodicMs) fail(VAULT_WATCHER_CONFIG_INVALID, `maxBackoffMs (${maxBackoffMs}) must be >= periodicMs (${periodicMs})`);
  const directories = (Array.isArray(parents) ? parents : []).filter((parent) => typeof parent === "string" && parent.trim().length > 0);
  if (directories.length > MAX_WATCHED_PARENTS) {
    fail(VAULT_WATCHER_CONFIG_INVALID, `${directories.length} discovery parents exceed the ${MAX_WATCHED_PARENTS} watch-handle cap`);
  }
  const timers = resolveWatchTimers(scheduler);
  const watchFn = watch ?? ((target, options) => fs.watch(target, options));
  const statFn = statApi ?? ((target) => fsp.stat(target));

  let running = false;
  let debounceTimer = null;
  let periodicTimer = null;
  let burstStartedAtMs = null;
  const subscriptions = new Map();
  const diagnostics = [];
  const counters = { watcher: 0, periodic: 0, events: 0, merged: 0, ignored: 0, reconciles: 0 };
  let lastWatcherAt = null;
  let lastPeriodicAt = null;
  let lastTriggerAt = null;
  let lastOutcome = null;
  let lastSuccessAt = null;
  let lastFailureCode = null;
  let consecutiveFailures = 0;
  let currentPeriodicMs = periodicMs;

  const at = () => new Date(now()).toISOString();

  /** Structured, path-free diagnostic. Consecutive identical entries collapse into one. */
  function note(code, parentIndex = null, { errno = null, eventType = null, warn = false } = {}) {
    const previous = diagnostics[diagnostics.length - 1];
    const duplicate = previous !== undefined && previous.code === code && previous.parentIndex === parentIndex && previous.errno === errno;
    if (!duplicate) {
      diagnostics.push(Object.freeze({ code, at: at(), parentIndex, errno, eventType }));
      if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.shift();
    }
    if (warn) logger?.warn?.(`[vault-watcher] ${code}${parentIndex === null ? "" : ` (discovery parent #${parentIndex})`}${errno === null ? "" : ` [${errno}]`}`);
    return diagnostics[diagnostics.length - 1];
  }

  /**
   * Escalate the PERIODIC re-arm delay after a failed/degraded round.
   *
   * KNOWN LIMITATION — W4 review F7 (recorded here on purpose so the next reader of this file sees it):
   * the backoff throttles ONLY the periodic fallback (`schedulePeriodic` reads `currentPeriodicMs`). The
   * event path is deliberately NOT throttled: `fire(RECONCILIATION_TRIGGER_WATCHER)` runs regardless, so
   * while a directory keeps producing events a persistently failing round can still start one round per
   * `maxCoalesceMs` window (default: one per 5s). That is bounded, fail-closed and cannot produce an
   * unauthorized state, but it means "backoff" here does not mean "no rounds". Evaluate a per-trigger
   * throttle in W5 together with the F4 re-subscription policy.
   */
  function applyBackoff() {
    currentPeriodicMs = Math.min(maxBackoffMs, Math.max(periodicMs, currentPeriodicMs * 2));
    return currentPeriodicMs;
  }

  /** The ONLY place a trigger is emitted: one call into the unified service, never a local scan. */
  function fire(trigger) {
    if (!running) return Promise.resolve(null);
    lastTriggerAt = at();
    if (trigger === RECONCILIATION_TRIGGER_WATCHER) { counters.watcher += 1; lastWatcherAt = lastTriggerAt; }
    else { counters.periodic += 1; lastPeriodicAt = lastTriggerAt; }
    let result;
    try {
      result = reconcile(trigger, {});
    } catch (error) {
      // A synchronous refusal must never escape into an fs.watch callback (it would be an uncaught
      // exception). The next bounded round is the recovery path.
      counters.reconciles += 1;
      applyBackoff();
      lastFailureCode = error?.code ?? "reconcile-threw";
      note(VAULT_WATCH_RECONCILE_REJECTED, null, { errno: error?.code ?? null, warn: true });
      return Promise.resolve(null);
    }
    counters.reconciles += 1;
    return Promise.resolve(result).then(
      (summary) => { noteOutcome(trigger, summary); return summary; },
      (error) => {
        applyBackoff();
        lastFailureCode = error?.code ?? "reconcile-rejected";
        note(VAULT_WATCH_RECONCILE_REJECTED, null, { errno: error?.code ?? null, warn: true });
        return null;
      },
    );
  }

  /**
   * A `coalesced` answer belongs to the running round (the service already holds a pending rerun), so
   * it neither resets nor escalates the backoff. A clean round resets the period; a failed, degraded
   * or unpublished round backs the period off geometrically, capped at `maxBackoffMs` (900 s).
   */
  function noteOutcome(trigger, summary) {
    const status = summary === null || summary === undefined ? "ignored" : (summary.status ?? "unknown");
    lastOutcome = Object.freeze({ trigger, status, at: at() });
    if (status === "coalesced" || status === "ignored") return;
    if (status === "committed") {
      consecutiveFailures = 0;
      currentPeriodicMs = periodicMs;
      lastSuccessAt = lastOutcome.at;
      retryUnsubscribed();
      return;
    }
    consecutiveFailures += 1;
    lastFailureCode = summary?.stage ?? status;
    applyBackoff();
  }

  /**
   * Re-arm one subscription attempt for every parent without a live handle (bounded: once per round).
   *
   * KNOWN LIMITATION (W4 review F4, deliberately NOT fixed in the W4 close-out — the re-subscription
   * policy and the meaning of the `subscribed` projection are a design change, not a bug fix): a handle
   * that stops delivering WITHOUT emitting `error`/`close` (Linux inotify queue overflow, a NAS/network
   * filesystem dropping events) keeps its entry in `subscriptions`, so this function never retries it
   * and `scheduled.subscribed`/`scheduled.watcher` keep reporting it as healthy. Correctness does not
   * depend on it — the bounded periodic scan is the correctness path and re-derives the inventory —
   * but the projection can be optimistic about liveness. Tracked for W5.
   */
  function retryUnsubscribed() {
    if (!running || subscriptions.size === directories.length) return;
    void subscribeParents();
  }

  /** Attempt to watch every parent that has no handle yet. Never throws: a failure is a diagnostic. */
  async function subscribeParents() {
    for (let index = 0; index < directories.length; index += 1) {
      if (!running) return;
      if (subscriptions.has(index)) continue;
      const parent = directories[index];
      let info;
      try {
        info = await statFn(parent);
      } catch (error) {
        // ENOENT (not mounted / not created yet) and EACCES (AUTH / different mount namespace) are
        // both "invisible here": report it and let the periodic scan keep looking.
        note(error?.code === "ENOENT" ? VAULT_WATCH_PARENT_MISSING : VAULT_WATCH_PARENT_UNREADABLE, index, { errno: error?.code ?? null, warn: true });
        continue;
      }
      if (typeof info?.isDirectory === "function" && info.isDirectory() === false) {
        note(VAULT_WATCH_PARENT_UNREADABLE, index, { errno: "ENOTDIR", warn: true });
        continue;
      }
      try {
        const handle = await watchFn(parent, { persistent: false });
        handle?.on?.("error", (error) => onSubscriptionError(index, error));
        handle?.on?.("change", (eventType, filename) => onEvent(index, eventType, filename));
        subscriptions.set(index, handle ?? null);
      } catch (error) {
        note(VAULT_WATCH_SUBSCRIPTION_FAILED, index, { errno: error?.code ?? null, warn: true });
      }
    }
  }

  function closeSubscription(index) {
    const handle = subscriptions.get(index);
    subscriptions.delete(index);
    try {
      handle?.close?.();
    } catch {
      /* best-effort: an already-dead handle is not an error */
    }
  }

  function onSubscriptionError(index, error) {
    note(VAULT_WATCH_SUBSCRIPTION_ERROR, index, { errno: error?.code ?? null, warn: true });
    closeSubscription(index);
  }

  /**
   * Is this event about a DIRECT child of the watched parent? Only direct children can become Vaults
   * (contract §4.1), and a non-recursive `fs.watch` on the parent can still report a *grandchild* on
   * some platforms/NTFS (a note written inside a Vault touches the directory entry of that Vault).
   * Treating those as discovery events would turn every note write into a discovery round — the exact
   * "扫描风暴" the contract forbids. A platform that reports no filename (or a bare name) must still
   * be honoured: an unknown event is never dropped silently.
   */
  function isDirectChildEvent(parent, filename) {
    if (typeof filename !== "string" || filename.length === 0) return true;
    return path.dirname(path.resolve(parent, filename)) === path.resolve(parent);
  }

  /**
   * Debounce with a bounded longest merge wait: a burst fires once `debounceMs` after its LAST event,
   * and unconditionally once `maxCoalesceMs` have passed since its FIRST event. A directory storm
   * therefore triggers the service at most once per `maxCoalesceMs` window, and each extra event only
   * moves one timer — no queue, no per-event work.
   */
  function onEvent(parentIndex, eventType, filename) {
    if (!running) return;
    if (!isDirectChildEvent(directories[parentIndex], filename)) {
      counters.ignored += 1;
      return undefined;
    }
    if (typeof eventType === "string" && eventType.length > 0 && eventType !== "rename" && eventType !== "change") {
      // An event kind this Node/filesystem pair does not document is still a change candidate: it
      // must NOT be dropped (a silently ignored new event type is exactly the "missed event" bug).
      note(VAULT_WATCH_UNKNOWN_EVENT, parentIndex, { eventType });
    }
    counters.events += 1;
    const nowMs = now();
    if (burstStartedAtMs === null) burstStartedAtMs = nowMs;
    if (debounceTimer !== null) {
      timers.clearTimeout(debounceTimer);
      debounceTimer = null;
      counters.merged += 1;
    }
    const remaining = maxCoalesceMs - (nowMs - burstStartedAtMs);
    if (remaining <= 0) return flushBurst();
    debounceTimer = timers.setTimeout(flushBurst, Math.min(debounceMs, remaining));
    timers.unref?.(debounceTimer);
    return undefined;
  }

  function flushBurst() {
    if (debounceTimer !== null) {
      timers.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    burstStartedAtMs = null;
    if (!running) return;
    return fire(RECONCILIATION_TRIGGER_WATCHER);
  }

  /**
   * The bounded fallback: one periodic round, re-armed only AFTER the previous one settled. That
   * ordering makes overlap impossible by construction, uses the (possibly backed-off) delay in force
   * at scheduling time, and keeps the timer `unref`ed so it never holds the process open.
   */
  function schedulePeriodic(delayMs = currentPeriodicMs) {
    if (!running || periodicTimer !== null) return;
    periodicTimer = timers.setTimeout(() => {
      periodicTimer = null;
      if (!running) return;
      Promise.resolve(fire(RECONCILIATION_TRIGGER_PERIODIC)).catch(() => {}).finally(() => {
        if (running) schedulePeriodic();
      });
    }, delayMs);
    timers.unref?.(periodicTimer);
  }

  async function start() {
    if (running) return status();
    if (enabled !== true) {
      // Contract §10: the switch off means NOTHING automatic runs — no handle, no stat, no timer.
      lastOutcome = Object.freeze({ trigger: null, status: "disabled", at: at() });
      return status();
    }
    running = true;
    await subscribeParents();
    schedulePeriodic();
    return status();
  }

  function stop() {
    running = false;
    if (debounceTimer !== null) {
      timers.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (periodicTimer !== null) {
      timers.clearTimeout(periodicTimer);
      periodicTimer = null;
    }
    burstStartedAtMs = null;
    for (const index of [...subscriptions.keys()]) closeSubscription(index);
    return status();
  }

  function status() {
    return Object.freeze({
      enabled: enabled === true,
      running,
      watcher: running && subscriptions.size > 0,
      periodic: running && periodicTimer !== null,
      debounceMs,
      maxCoalesceMs,
      periodicMs,
      currentPeriodicMs,
      maxBackoffMs,
      parents: directories.length,
      subscribed: subscriptions.size,
      triggers: Object.freeze({ watcher: counters.watcher, periodic: counters.periodic }),
      reconciles: counters.reconciles,
      events: counters.events,
      merged: counters.merged,
      ignored: counters.ignored,
      consecutiveFailures,
      lastOutcome,
      lastSuccessAt,
      lastFailureCode,
      lastWatcherAt,
      lastPeriodicAt,
      lastTriggerAt,
      diagnostics: Object.freeze([...diagnostics]),
    });
  }

  return Object.freeze({ start, stop, status });
}
