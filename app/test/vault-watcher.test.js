// W4 (#437) — the automatic discovery triggers: debounce / bounded merge wait / single-flight through
// the unified service / failure backoff / switch-off / parent-visibility diagnostics.
//
// Every test here is meant to be a real negative control: the mutation that would break it is named in
// the assertion message, and the deterministic clock means "it passed because it was slow enough" is
// not available as an explanation.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createVaultWatcher,
  VAULT_WATCHER_CONFIG_INVALID,
  VAULT_WATCH_PARENT_MISSING,
  VAULT_WATCH_PARENT_UNREADABLE,
  VAULT_WATCH_SUBSCRIPTION_ERROR,
  VAULT_WATCH_SUBSCRIPTION_FAILED,
  WATCH_DEBOUNCE_MS,
  WATCH_MAX_COALESCE_MS,
  WATCH_PERIODIC_MAX_MS,
  WATCH_PERIODIC_MS,
} from "../src/vault-runtime/vault-watcher.js";

const quiet = { info() {}, warn() {}, log() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Deterministic clock + timer seam: nothing here depends on wall-clock time or on real timers. */
function makeClock() {
  let current = 0;
  let seq = 0;
  const tasks = new Map();
  return {
    now: () => current,
    pending: () => tasks.size,
    timers: {
      setTimeout(fn, ms) {
        const id = ++seq;
        tasks.set(id, { at: current + Math.max(0, Math.trunc(ms)), fn });
        return id;
      },
      clearTimeout(id) { tasks.delete(id); },
      unref() {},
    },
    async advance(ms) {
      const target = current + Math.max(0, Math.trunc(ms));
      for (;;) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        tasks.delete(due[0]);
        current = Math.max(current, due[1].at);
        await due[1].fn();
        await settle();
      }
      current = target;
      await settle();
    },
  };
}

/** A standalone fake watcher handle so `fs.watch` semantics (handlers, `close`, `error`) are observable. */
function makeWatch() {
  const handles = [];
  const watch = (target, options) => {
    const handlers = new Map();
    const handle = {
      target, options, closed: false,
      on(event, handler) { handlers.set(event, handler); return handle; },
      close() { handle.closed = true; },
      emit(event, value) { handlers.get(event)?.(value); },
      // Node's `fs.watch` listener is always called with `(eventType, filename)` on the `change` event.
      fire(eventType, filename) { handlers.get("change")?.(eventType, filename); },
    };
    handles.push(handle);
    return handle;
  };
  return { watch, handles };
}

function recorder(outcomes = [], now = () => Date.now()) {
  const calls = [];
  let index = 0;
  return {
    calls,
    reconcile(trigger) {
      calls.push({ trigger, at: now() });
      const next = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return typeof next === "function" ? next() : (next ?? { status: "committed" });
    },
  };
}

function watcherFor({ clock, watch = makeWatch(), statApi = async () => ({ isDirectory: () => true }), outcomes, ...overrides }) {
  const log = recorder(outcomes, clock.now);
  const watcher = createVaultWatcher({
    reconcile: log.reconcile,
    parents: ["/discovery-parent"],
    enabled: true,
    debounceMs: WATCH_DEBOUNCE_MS,
    maxCoalesceMs: WATCH_MAX_COALESCE_MS,
    periodicMs: WATCH_PERIODIC_MS,
    scheduler: clock.timers,
    watch: watch.watch,
    statApi,
    now: clock.now,
    logger: quiet,
    ...overrides,
  });
  return { watcher, log, watch };
}

test("defaults are the frozen parameters (500ms debounce, 5s merge wait, 60s period, 900s cap)", () => {
  assert.equal(WATCH_DEBOUNCE_MS, 500);
  assert.equal(WATCH_MAX_COALESCE_MS, 5000);
  assert.equal(WATCH_PERIODIC_MS, 60_000);
  assert.equal(WATCH_PERIODIC_MAX_MS, 900_000);
});

test("switch off: neither a watch handle, a stat nor a timer is created (contract §10)", async () => {
  const clock = makeClock();
  let touched = 0;
  const watcher = createVaultWatcher({
    reconcile: () => { touched += 1; return { status: "committed" }; },
    parents: ["/discovery-parent"],
    enabled: false,
    scheduler: clock.timers,
    watch: () => { touched += 1; throw new Error("watch must not be called when discovery is disabled"); },
    statApi: async () => { touched += 1; throw new Error("stat must not be called when discovery is disabled"); },
    now: clock.now,
    logger: quiet,
  });
  const started = await watcher.start();
  assert.equal(touched, 0, "a disabled watcher must not touch the filesystem");
  assert.equal(started.running, false);
  assert.equal(started.watcher, false);
  assert.equal(started.periodic, false);
  assert.equal(clock.pending(), 0, "no timer may exist with the discovery switch off");
  await clock.advance(10 * WATCH_PERIODIC_MS);
  assert.equal(touched, 0, "advancing time must produce no round and no I/O when disabled");
});

test("debounce: a burst inside the window triggers exactly one round, after the debounce delay", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const { watcher, log } = watcherFor({ clock, watch });
  await watcher.start();
  const handle = watch.handles[0];
  assert.equal(handle.options.persistent, false, "the watch handle must never hold the process open");
  for (let i = 0; i < 5; i += 1) { handle.fire("rename", "x.md"); await clock.advance(50); }
  assert.equal(log.calls.length, 0, "nothing may be triggered before the debounce window elapses");
  await clock.advance(500);
  assert.equal(log.calls.length, 1, "a 5-event burst must collapse into exactly one reconciliation round");
  assert.equal(log.calls[0].trigger, "watcher");
  const status = watcher.status();
  assert.equal(status.merged, 4, "each event after the first must be counted as merged");
  assert.equal(status.events, 5);
  assert.equal(status.triggers.watcher, 1);
});

test("bounded merge wait: a continuous storm cannot postpone the trigger past 5s, and triggers stay bounded", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const firedAt = [];
  const watcher = createVaultWatcher({
    reconcile: () => { firedAt.push(clock.now()); return { status: "committed" }; },
    parents: ["/discovery-parent"], enabled: true,
    scheduler: clock.timers, watch: watch.watch, statApi: async () => ({ isDirectory: () => true }), now: clock.now, logger: quiet,
  });
  await watcher.start();
  const handle = watch.handles[0];
  // 500 events, one every 40ms: 20s of continuous churn (a "scan storm" on a busy parent).
  for (let t = 0; t < 20_000; t += 40) { handle.fire("rename", `f${t}.md`); await clock.advance(40); }
  assert.ok(firedAt.length >= 1, "a storm must still produce at least one round");
  assert.ok(
    firedAt[0] <= WATCH_MAX_COALESCE_MS,
    `the first trigger must not be postponed past the ${WATCH_MAX_COALESCE_MS}ms merge wait; it fired at ${firedAt[0]}ms`,
  );
  const bound = Math.ceil(20_000 / WATCH_MAX_COALESCE_MS) + 1;
  assert.ok(firedAt.length <= bound, `500 events over 20s must produce at most ${bound} rounds, got ${firedAt.length}`);
  for (let i = 1; i < firedAt.length; i += 1) {
    assert.ok(firedAt[i] - firedAt[i - 1] >= WATCH_MAX_COALESCE_MS - 40, "consecutive storm rounds must be separated by the merge window");
  }
  assert.equal(watcher.status().triggers.watcher, firedAt.length);
});

test("storm bound is time-bounded, not event-bounded (the same 500 events never grow the queue)", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const { watcher, log } = watcherFor({ clock, watch });
  await watcher.start();
  const handle = watch.handles[0];
  for (let i = 0; i < 500; i += 1) { handle.fire("change", `f${i}.md`); }
  assert.equal(log.calls.length, 0, "no event may trigger synchronously from the fs.watch callback");
  await clock.advance(499);
  assert.equal(log.calls.length, 0, "the debounce window is still open");
  await clock.advance(1);
  assert.equal(log.calls.length, 1, "500 events in one tick collapse into exactly one round");
  assert.equal(watcher.status().merged, 499);
});

test("single flight: while a round is running the periodic fallback schedules nothing and queues nothing", async () => {
  const clock = makeClock(); const watch = makeWatch();
  let release = null;
  const calls = [];
  const watcher = createVaultWatcher({
    reconcile: (trigger) => { calls.push(trigger); return new Promise((resolve) => { release = resolve; }); },
    parents: ["/discovery-parent"],
    enabled: true,
    periodicMs: 1000,
    scheduler: clock.timers, watch: watch.watch, statApi: async () => ({ isDirectory: () => true }), now: clock.now, logger: quiet,
  });
  await watcher.start();
  await clock.advance(1000);
  assert.deepEqual(calls, ["periodic"], "the first periodic round starts");
  await clock.advance(9 * 1000);
  assert.deepEqual(calls, ["periodic"], "an unfinished round must not be overlapped or queued: exactly one round is in flight");
  release({ status: "committed" });
  await settle();
  await clock.advance(1000);
  assert.deepEqual(calls, ["periodic", "periodic"], "the next round is armed only after the previous one settled");
});

test("failure backoff: the period doubles per failed round and is capped at 900s (default) — here capped at the injected cap", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const gaps = [];
  let lastAt = null;
  const watcher = createVaultWatcher({
    reconcile: () => { gaps.push(lastAt === null ? null : clock.now() - lastAt); lastAt = clock.now(); return { status: "failed", stage: "discover" }; },
    parents: ["/discovery-parent"],
    enabled: true,
    periodicMs: 100, maxBackoffMs: 800,
    scheduler: clock.timers, watch: watch.watch, statApi: async () => ({ isDirectory: () => true }), now: clock.now, logger: quiet,
  });
  await watcher.start();
  await clock.advance(100 + 200 + 400 + 800 + 800 + 800);
  assert.deepEqual(gaps, [null, 200, 400, 800, 800, 800], "period must back off geometrically after each failure and never exceed the cap");
  assert.equal(watcher.status().currentPeriodicMs, 800);
  assert.ok(watcher.status().consecutiveFailures >= 6);
});

test("a committed round resets the backoff to the configured period", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const outcomes = [{ status: "failed" }, { status: "not-published", stage: "persist" }, { status: "committed" }];
  let index = 0;
  const watcher = createVaultWatcher({
    reconcile: () => outcomes[Math.min(index++, outcomes.length - 1)],
    parents: ["/discovery-parent"],
    enabled: true,
    periodicMs: 100, maxBackoffMs: 800,
    scheduler: clock.timers, watch: watch.watch, statApi: async () => ({ isDirectory: () => true }), now: clock.now, logger: quiet,
  });
  await watcher.start();
  await clock.advance(100); // failed  → 200
  assert.equal(watcher.status().currentPeriodicMs, 200);
  await clock.advance(200); // not-published → 400
  assert.equal(watcher.status().currentPeriodicMs, 400);
  await clock.advance(400); // committed → reset
  const status = watcher.status();
  assert.equal(status.currentPeriodicMs, 100, "a clean round must reset the period to the configured default");
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.lastOutcome.status, "committed");
  assert.ok(status.lastSuccessAt !== null, "the last successful round must be observable");
});

test("a coalesced answer neither resets nor escalates the backoff (the running round owns the outcome)", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const watcher = createVaultWatcher({
    reconcile: () => ({ status: "coalesced", runId: 7 }),
    parents: ["/discovery-parent"],
    enabled: true,
    periodicMs: 100, maxBackoffMs: 800,
    scheduler: clock.timers, watch: watch.watch, statApi: async () => ({ isDirectory: () => true }), now: clock.now, logger: quiet,
  });
  await watcher.start();
  await clock.advance(100 + 100);
  const status = watcher.status();
  assert.equal(status.currentPeriodicMs, 100, "coalescing is not a failure and must not back off");
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.lastOutcome.status, "coalesced");
});

test("periodic fallback converges when the watcher never delivers an event", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const { watcher, log } = watcherFor({ clock, watch });
  await watcher.start();
  assert.equal(log.calls.length, 0);
  await clock.advance(WATCH_PERIODIC_MS);
  assert.deepEqual(log.calls.map((call) => call.trigger), ["periodic"], "the bounded periodic scan is the correctness path when events are lost");
  assert.equal(watcher.status().triggers.watcher, 0);
});

test("a missing parent is a diagnostic, never a discovery, and the periodic scan keeps running", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const { watcher, log } = watcherFor({ clock, watch, statApi: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } });
  const started = await watcher.start();
  assert.equal(watch.handles.length, 0, "no handle may be opened on a parent that is not visible here");
  assert.equal(started.watcher, false);
  assert.equal(started.periodic, true, "the periodic fallback must survive an unsubscribable parent");
  assert.equal(started.diagnostics.at(-1).code, VAULT_WATCH_PARENT_MISSING);
  await clock.advance(WATCH_PERIODIC_MS);
  assert.deepEqual(log.calls.map((call) => call.trigger), ["periodic"]);
});

test("an unreadable/unmounted parent (AUTH) is a diagnostic, never a false discovery", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const { watcher } = watcherFor({ clock, watch, statApi: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  const started = await watcher.start();
  assert.equal(started.diagnostics.at(-1).code, VAULT_WATCH_PARENT_UNREADABLE);
  assert.equal(started.diagnostics.at(-1).errno, "EACCES");
  assert.equal(started.subscribed, 0);
  // Issue §5: the status must never leak the sensitive absolute path.
  assert.ok(!JSON.stringify(started).includes("/discovery-parent"), "the diagnostic projection must not record the absolute parent path");
});

test("a watcher error is contained: the handle is closed, reported, and the periodic fallback continues", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const { watcher, log } = watcherFor({ clock, watch });
  await watcher.start();
  const handle = watch.handles[0];
  handle.emit("error", Object.assign(new Error("parent vanished"), { code: "ENOENT" }));
  const after = watcher.status();
  assert.equal(after.subscribed, 0, "a failed handle must be closed instead of leaking a dead subscription");
  assert.equal(handle.closed, true);
  assert.equal(after.diagnostics.at(-1).code, VAULT_WATCH_SUBSCRIPTION_ERROR);
  assert.equal(after.periodic, true);
  await clock.advance(WATCH_PERIODIC_MS);
  assert.deepEqual(log.calls.map((call) => call.trigger), ["periodic"], "the bounded scan must still converge after a watcher failure");
});

test("a subscription failure is reported and retried at most once per completed round", async () => {
  const clock = makeClock();
  let attempts = 0;
  const { watcher } = watcherFor({ clock, watch: { watch: () => { attempts += 1; throw Object.assign(new Error("EMFILE"), { code: "EMFILE" }); } } });
  const started = await watcher.start();
  assert.equal(attempts, 1);
  assert.equal(started.diagnostics.at(-1).code, VAULT_WATCH_SUBSCRIPTION_FAILED);
  await clock.advance(WATCH_PERIODIC_MS);
  assert.equal(attempts, 2, "exactly one re-subscription attempt per completed round — no retry storm");
  await clock.advance(WATCH_PERIODIC_MS);
  assert.equal(attempts, 3);
});

test("a parent that appears later is subscribed on the next completed round (ENOENT recovery)", async () => {
  const clock = makeClock(); const watch = makeWatch();
  let visible = false;
  const statApi = async () => { if (!visible) throw Object.assign(new Error("gone"), { code: "ENOENT" }); return { isDirectory: () => true }; };
  const { watcher } = watcherFor({ clock, watch, statApi });
  await watcher.start();
  assert.equal(watcher.status().subscribed, 0);
  visible = true;
  await clock.advance(WATCH_PERIODIC_MS);
  const status = watcher.status();
  assert.equal(status.subscribed, 1, "a now-visible parent must be picked up without a restart");
  assert.equal(status.watcher, true);
});

test("a grandchild event (note written inside a Vault) is ignored; direct children still trigger", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const { watcher, log } = watcherFor({ clock, watch });
  await watcher.start();
  const handle = watch.handles[0];
  // Grandchild shapes: a payload that resolves BELOW the watched parent. `path.join` picks this
  // platform's separator, and a relative payload containing `/` is a grandchild on both platforms.
  const grandchildEvents = [
    "some-vault/note.md",
    path.join("/discovery-parent", "some-vault", "deep", "note.md"),
  ];
  // `some-vault\note.md` is a grandchild only where `\` separates path segments. On POSIX a
  // backslash is an ordinary filename character, so the same payload is a legal DIRECT-child name
  // and must trigger the round ("an unknown event is never dropped silently"). The old assertion
  // called it a grandchild on every platform, which made this file red on the Linux CI runners
  // (issue #602: `log.calls.length 1 !== 0`) while it passed on Windows — it encoded a
  // Windows-only fact. Both directions are asserted below instead of one of them being dropped.
  const backslashIsSeparator = path.sep === "\\";
  const backslashEvent = "some-vault\\note.md";
  const ignoredCount = grandchildEvents.length + (backslashIsSeparator ? 1 : 0);
  const directFromBackslash = backslashIsSeparator ? 0 : 1;
  for (const payload of grandchildEvents) handle.fire("change", payload);
  handle.fire("change", backslashEvent);
  await clock.advance(2 * WATCH_MAX_COALESCE_MS);
  assert.equal(log.calls.length, directFromBackslash, "writing a note inside a Vault must not trigger a discovery round (no scan storm)");
  assert.equal(watcher.status().ignored, ignoredCount);
  assert.equal(watcher.status().events, directFromBackslash, "an ignored grandchild event is not counted as a discovery event");
  // A bare name, an absent filename and the absolute path of a DIRECT child are all direct-child facts.
  const roundsBeforeDirect = log.calls.length;
  handle.fire("rename", "brand-new-vault");
  handle.fire("rename", undefined);
  handle.fire("rename", path.resolve("/discovery-parent", "another-vault"));
  await clock.advance(WATCH_DEBOUNCE_MS + 1);
  assert.equal(log.calls.length, roundsBeforeDirect + 1, "direct-child events must still trigger the round");
  assert.equal(watcher.status().events, 3 + directFromBackslash);
});

test("the 5s merge wait is a hard ceiling even when the LAST event lands inside the final debounce window", async () => {
  // F2 (independent review): the previous storm test used a 40ms grid that always reached the
  // `remaining <= 0` immediate-flush branch, so removing the tail clamp (`Math.min(debounceMs,
  // remaining)`) changed behaviour (5000ms -> 5400ms) with all tests still green. This test uses the
  // reviewer's grid — one event every 100ms from 0 to 4900ms, then silence — where the trailing
  // debounce alone would fire at 5400ms.
  const clock = makeClock(); const watch = makeWatch();
  const firedAt = [];
  const watcher = createVaultWatcher({
    reconcile: () => { firedAt.push(clock.now()); return { status: "committed" }; },
    parents: ["/discovery-parent"], enabled: true,
    scheduler: clock.timers, watch: watch.watch, statApi: async () => ({ isDirectory: () => true }), now: clock.now, logger: quiet,
  });
  await watcher.start();
  const handle = watch.handles[0];
  for (let t = 0; t <= 4900; t += 100) {
    handle.fire("rename", `f${t}.md`);
    await clock.advance(100);
    if (clock.now() < WATCH_MAX_COALESCE_MS) {
      assert.equal(firedAt.length, 0, `the burst must stay merged until the ceiling (t=${clock.now()}ms)`);
    }
  }
  assert.deepEqual(firedAt, [WATCH_MAX_COALESCE_MS], "the trigger must land exactly ON the 5s ceiling, not one debounce later");
  assert.ok(firedAt[0] <= WATCH_MAX_COALESCE_MS, "the merge wait is an upper bound, never exceeded");

  // Control: a sparse event still honours the plain debounce, i.e. the ceiling did not replace it.
  await clock.advance(1000);
  handle.fire("rename", "sparse.md");
  await clock.advance(WATCH_DEBOUNCE_MS);
  assert.deepEqual(firedAt, [WATCH_MAX_COALESCE_MS, WATCH_MAX_COALESCE_MS + 1000 + WATCH_DEBOUNCE_MS], "an isolated event fires after the debounce, not after the ceiling");
});

test("a parent path that is not a directory (ENOTDIR) is a diagnostic, never a subscription", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const { watcher } = watcherFor({ clock, watch, statApi: async () => ({ isDirectory: () => false }) });
  const started = await watcher.start();
  assert.equal(watch.handles.length, 0, "a non-directory parent must not get a watch handle");
  assert.equal(started.subscribed, 0);
  assert.equal(started.diagnostics.at(-1).code, VAULT_WATCH_PARENT_UNREADABLE);
  assert.equal(started.diagnostics.at(-1).errno, "ENOTDIR");
  assert.equal(started.periodic, true, "the bounded periodic fallback must keep running");
});

test("stop() releases every handle and timer and no later event can trigger a round", async () => {
  const clock = makeClock(); const watch = makeWatch();
  const { watcher, log } = watcherFor({ clock, watch });
  await watcher.start();
  const handle = watch.handles[0];
  watcher.stop();
  assert.equal(handle.closed, true);
  assert.equal(clock.pending(), 0, "no timer may survive stop()");
  assert.equal(watcher.status().running, false);
  handle.fire("rename", "x.md");
  await clock.advance(10 * WATCH_PERIODIC_MS);
  assert.equal(log.calls.length, 0, "a stopped watcher must not reconcile");
});

test("configuration is refused loudly instead of degrading into a hot loop", () => {
  const clock = makeClock();
  const base = { reconcile: () => ({ status: "committed" }), parents: [], scheduler: clock.timers, logger: quiet };
  assert.throws(() => createVaultWatcher({ ...base, reconcile: null }), (error) => error.code === VAULT_WATCHER_CONFIG_INVALID);
  assert.throws(() => createVaultWatcher({ ...base, debounceMs: 600, maxCoalesceMs: 500 }), (error) => error.code === VAULT_WATCHER_CONFIG_INVALID);
  assert.throws(() => createVaultWatcher({ ...base, maxBackoffMs: 500, periodicMs: 1000 }), (error) => error.code === VAULT_WATCHER_CONFIG_INVALID);
  assert.throws(() => createVaultWatcher({ ...base, periodicMs: 0 }), (error) => error.code === VAULT_WATCHER_CONFIG_INVALID);
  assert.throws(() => createVaultWatcher({ ...base, parents: Array.from({ length: 9 }, (_, i) => `/p${i}`) }), (error) => error.code === VAULT_WATCHER_CONFIG_INVALID);
});
