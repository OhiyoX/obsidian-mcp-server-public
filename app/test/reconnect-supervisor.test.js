import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  createReconnectHint,
  createReconnectSupervisor,
} from "../frontend/app/features/sync/reconnect-supervisor.js";
import {
  START,
  collect,
  countType,
  createClock,
  createFakeDocument,
  createFakeElement,
  createHarness,
} from "./helpers/reconnect-supervisor-harness.mjs";

const SUPERVISOR_PATH = new URL("../frontend/app/features/sync/reconnect-supervisor.js", import.meta.url);

// ---------------------------------------------------------------------------
// probe routing
// ---------------------------------------------------------------------------

test("start probes immediately and reports online for 200", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [200] });
  const events = collect(supervisor);

  assert.equal(supervisor.getState().phase, "reconnecting");
  supervisor.start();
  await clock.advance(0);

  const state = supervisor.getState();
  assert.equal(state.phase, "online");
  assert.equal(state.attempts, 0);
  assert.equal(state.lastProbeAt, clock.now());
  assert.equal(state.since, clock.now());
  assert.equal(probe.calls.length, 1);
  assert.deepEqual(Object.keys(state).sort(), ["attempts", "lastProbeAt", "phase", "since"]);
  assert.equal(countType(events, "recovered"), 1);
  assert.equal(events.filter((event) => event.type === "state").at(-1).phase, "online");
});

test("403 counts as an online session because the session itself is valid", async () => {
  const { clock, supervisor } = createHarness({ statuses: [403] });
  const events = collect(supervisor);
  supervisor.start();
  await clock.advance(0);

  assert.equal(supervisor.getState().phase, "online");
  assert.equal(supervisor.getState().attempts, 0);
  assert.equal(countType(events, "recovered"), 1);
});

test("401 moves to session-expired, emits once and stops retrying", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [401] });
  const events = collect(supervisor);
  supervisor.start();
  await clock.advance(0);

  assert.equal(supervisor.getState().phase, "session-expired");
  assert.equal(countType(events, "session-expired"), 1);
  assert.equal(clock.pending(), 0);

  await clock.advance(10 * 60_000);
  assert.equal(probe.calls.length, 1);
  assert.equal(supervisor.getState().phase, "session-expired");
});

test("network failure and unexpected statuses fall to offline", async () => {
  for (const status of [0, 502, 503, 500]) {
    const { clock, supervisor } = createHarness({ statuses: [status] });
    supervisor.start();
    await clock.advance(0);
    assert.equal(supervisor.getState().phase, "offline", `status ${status}`);
    assert.equal(supervisor.getState().attempts, 1, `status ${status}`);
    supervisor.stop();
  }
});

test("a thrown probe is an offline network failure, not an auth failure", async () => {
  const { clock, supervisor } = createHarness({ statuses: [new Error("connection refused")] });
  supervisor.start();
  await clock.advance(0);

  assert.equal(supervisor.getState().phase, "offline");
  assert.equal(supervisor.getState().attempts, 1);
});

test("probeNow dedupes concurrent probes", async () => {
  const clock = createClock();
  let release;
  let calls = 0;
  const supervisor = createReconnectSupervisor({
    probe: () => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ status: 200 });
      });
    },
    now: clock.now,
    timers: clock.timers,
    random: () => 1,
  });

  const first = supervisor.probeNow();
  const second = supervisor.probeNow();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(supervisor.getState().phase, "online");
});

// ---------------------------------------------------------------------------
// backoff
// ---------------------------------------------------------------------------

test("offline retries with exponential backoff and recovers", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [0, 0, 200] });
  const events = collect(supervisor);
  supervisor.start();
  await clock.advance(0);

  assert.equal(supervisor.getState().phase, "offline");
  assert.equal(supervisor.getState().attempts, 1);

  await clock.advance(999);
  assert.equal(probe.calls.length, 1);
  await clock.advance(1);
  assert.equal(probe.calls.length, 2);
  assert.equal(supervisor.getState().attempts, 2);

  await clock.advance(1_999);
  assert.equal(probe.calls.length, 2);
  await clock.advance(1);
  assert.equal(probe.calls.length, 3);
  assert.equal(supervisor.getState().phase, "online");
  assert.equal(supervisor.getState().attempts, 0);
  assert.equal(countType(events, "recovered"), 1);

  assert.deepEqual(probe.calls.map((call) => call.at), [START, START + 1_000, START + 3_000]);
});

test("backoff delay is capped at maxDelayMs", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [0] });
  supervisor.start();
  await clock.advance(0);
  for (const step of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    await clock.advance(step);
  }

  assert.deepEqual(
    probe.calls.map((call) => call.at - START),
    [0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000],
  );
  assert.equal(supervisor.getState().attempts, 8);
});

test("backoff jitter stays inside (50%, 100%] of the capped delay", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [0], options: { random: () => 0 } });
  supervisor.start();
  await clock.advance(0);
  await clock.advance(500);
  assert.equal(probe.calls.length, 2);
  await clock.advance(1_000);
  assert.equal(probe.calls.length, 3);
  await clock.advance(2_000);
  assert.equal(probe.calls.length, 4);
});

// ---------------------------------------------------------------------------
// watchdog / lifecycle hooks
// ---------------------------------------------------------------------------

test("watchdog re-confirms an idle online session once per interval", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [200], options: { watchdogMs: 60_000 } });
  supervisor.start();
  await clock.advance(0);
  assert.equal(probe.calls.length, 1);

  await clock.advance(59_999);
  assert.equal(probe.calls.length, 1);
  await clock.advance(1);
  assert.equal(probe.calls.length, 2);
  assert.equal(supervisor.getState().phase, "online");

  await clock.advance(59_999);
  assert.equal(probe.calls.length, 2);
  await clock.advance(1);
  assert.equal(probe.calls.length, 3);
});

test("watchdog failure drops an online session to offline with retries", async () => {
  const { clock, supervisor } = createHarness({ statuses: [200, 0], options: { watchdogMs: 60_000 } });
  supervisor.start();
  await clock.advance(0);
  assert.equal(supervisor.getState().phase, "online");

  await clock.advance(60_000);
  assert.equal(supervisor.getState().phase, "offline");
  assert.equal(supervisor.getState().attempts, 1);
  assert.equal(clock.pending(), 1);
});

test("reportOffline pauses probing and reportOnline resumes immediately", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [200] });
  const events = collect(supervisor);
  supervisor.start();
  await clock.advance(0);
  assert.equal(probe.calls.length, 1);

  supervisor.reportOffline();
  assert.equal(supervisor.getState().phase, "offline");
  assert.equal(clock.pending(), 0);

  await clock.advance(10 * 60_000);
  assert.equal(probe.calls.length, 1, "no probing while the browser is offline");
  supervisor.reportVisible();
  assert.equal(probe.calls.length, 1, "visibility does not probe while the browser is offline");

  supervisor.reportOnline();
  assert.equal(supervisor.getState().phase, "reconnecting");
  await clock.advance(0);
  assert.equal(probe.calls.length, 2);
  assert.equal(supervisor.getState().phase, "online");
  assert.equal(countType(events, "recovered"), 2);
});

test("reportVisible probes a disrupted session and keeps online quiet", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [200] });
  const events = collect(supervisor);
  supervisor.start();
  await clock.advance(0);
  const recoveredBefore = countType(events, "recovered");

  supervisor.reportVisible();
  await clock.advance(0);
  assert.equal(probe.calls.length, 2);
  assert.equal(supervisor.getState().phase, "online");
  assert.equal(
    countType(events, "recovered"),
    recoveredBefore,
    "an online session is not recovered twice",
  );
});

test("session-expired ignores online/offline events and retries no timer", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [401] });
  const events = collect(supervisor);
  supervisor.start();
  await clock.advance(0);
  assert.equal(supervisor.getState().phase, "session-expired");

  supervisor.reportOnline();
  supervisor.reportOffline();
  await clock.advance(10 * 60_000);
  assert.equal(probe.calls.length, 1);
  assert.equal(clock.pending(), 0);
  assert.equal(supervisor.getState().phase, "session-expired");
  assert.equal(countType(events, "session-expired"), 1);
});

test("session-expired recovers through a visible probe when a session reappears", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [401] });
  const events = collect(supervisor);
  supervisor.start();
  await clock.advance(0);
  assert.equal(supervisor.getState().phase, "session-expired");

  probe.respond(200);
  supervisor.reportVisible();
  await clock.advance(0);

  assert.equal(probe.calls.length, 2);
  assert.equal(supervisor.getState().phase, "online");
  assert.equal(countType(events, "recovered"), 1);
  assert.equal(countType(events, "session-expired"), 1);
});

test("stop clears timers, stops probing and accepts no further reports", async () => {
  const { clock, supervisor, probe } = createHarness({ statuses: [0] });
  supervisor.start();
  await clock.advance(0);
  assert.equal(clock.pending(), 1);

  supervisor.stop();
  assert.equal(clock.pending(), 0);

  await clock.advance(10 * 60_000);
  assert.equal(probe.calls.length, 1);

  supervisor.reportOnline();
  supervisor.reportVisible();
  await supervisor.probeNow();
  await clock.advance(10 * 60_000);
  assert.equal(probe.calls.length, 1, "stopped supervisors never probe again");
});

test("stop makes an in-flight probe a no-op", async () => {
  const clock = createClock();
  let release;
  let scheduled = 0;
  const supervisor = createReconnectSupervisor({
    probe: () => new Promise((resolve) => { release = () => resolve({ status: 200 }); }),
    now: clock.now,
    timers: {
      setTimeout: (callback, delay) => {
        scheduled += 1;
        return clock.timers.setTimeout(callback, delay);
      },
      clearTimeout: (id) => clock.timers.clearTimeout(id),
    },
    random: () => 1,
  });
  supervisor.start();
  supervisor.stop();
  release();
  await clock.advance(0);
  assert.equal(supervisor.getState().phase, "reconnecting");
  assert.equal(scheduled, 0, "a stopped supervisor schedules no watchdog");
});

// ---------------------------------------------------------------------------
// hint
// ---------------------------------------------------------------------------

test("hint is hidden by default and only adds one child to its host", () => {
  const doc = createFakeDocument();
  const host = createFakeElement("div");
  const sibling = doc.createElement("button");
  host.appendChild(sibling);

  const hint = createReconnectHint({ host, document: doc });

  assert.equal(host.children.length, 2);
  assert.equal(host.children[1], hint.element);
  assert.equal(hint.element.hidden, true);
  assert.equal(hint.element.getAttribute("role"), "status");
  assert.equal(hint.element.getAttribute("aria-live"), "polite");
  assert.equal(sibling.parentNode, host);
  assert.equal(sibling.children.length, 0);
  hint.destroy();
  assert.equal(host.children.length, 1);
});

test("hint reflects each supervisor phase with visible, accessible text", () => {
  const doc = createFakeDocument();
  const host = createFakeElement("div");
  const hint = createReconnectHint({ host, document: doc });
  const [dot, label] = hint.element.children;

  hint.update({ phase: "online" });
  assert.equal(hint.element.hidden, true);
  assert.equal(label.textContent, "");

  hint.update({ phase: "reconnecting" });
  assert.equal(hint.element.hidden, false);
  assert.equal(hint.element.getAttribute("data-phase"), "reconnecting");
  assert.equal(dot.getAttribute("data-state"), "reconnecting");
  assert.match(label.textContent, /恢复/);

  hint.update({ phase: "offline" });
  assert.equal(hint.element.hidden, false);
  assert.equal(hint.element.getAttribute("data-phase"), "offline");
  assert.equal(dot.getAttribute("data-state"), "paused");
  assert.match(label.textContent, /离线|恢复/);

  hint.update({ phase: "session-expired" });
  assert.equal(hint.element.hidden, false);
  assert.equal(hint.element.getAttribute("data-phase"), "session-expired");
  assert.match(label.textContent, /登录/);

  // No interactive controls: nothing to trap keyboard focus in a light hint.
  assert.equal(hint.element.children.length, 2);
  assert.equal(dot.nodeName, "SPAN");
  assert.equal(label.nodeName, "SPAN");
});

test("hint subscribes to a supervisor and unsubscribes on destroy", async () => {
  const doc = createFakeDocument();
  const host = createFakeElement("div");
  const { clock, supervisor } = createHarness({ statuses: [200] });
  const hint = createReconnectHint({ host, supervisor, document: doc });

  assert.equal(hint.element.hidden, false, "the initial unconfirmed state is shown");
  assert.equal(hint.element.getAttribute("data-phase"), "reconnecting");

  supervisor.start();
  await clock.advance(0);
  assert.equal(hint.element.hidden, true);
  assert.equal(hint.element.getAttribute("data-phase"), "online");

  supervisor.reportOnline();
  await clock.advance(0);
  hint.destroy();
  assert.equal(host.children.length, 0);

  // Destroyed hints no longer react to supervisor events.
  supervisor.reportOffline();
  assert.equal(hint.element.getAttribute("data-phase"), "online");
});

// ---------------------------------------------------------------------------
// source contract
// ---------------------------------------------------------------------------

test("reconnect supervisor source stays self-contained and listener-free", () => {
  const source = fs.readFileSync(SUPERVISOR_PATH, "utf8");

  assert.ok(source.split(/\r?\n/).length <= 500, "file must fit the local 500-line cap");
  assert.match(source, /export function createReconnectSupervisor\(/);
  assert.match(source, /export function createReconnectHint\(/);
  assert.doesNotMatch(source, /^\s*import\s/m, "module must be self-contained");
  assert.doesNotMatch(source, /core\/app\.js/);
  assert.doesNotMatch(source, /features\/bases\//);
  assert.doesNotMatch(source, /features\/editor\//);
  assert.doesNotMatch(source, /addEventListener/, "no global or DOM listener side effects");
  assert.doesNotMatch(source, /removeEventListener/);
  for (const hook of ["reportOnline", "reportOffline", "reportVisible", "probeNow"]) {
    assert.match(source, new RegExp(hook));
  }
});
