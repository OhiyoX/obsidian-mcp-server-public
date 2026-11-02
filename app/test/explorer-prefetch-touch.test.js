// Issue #337 Cut 1 unit matrix: explorer touch-prefetch intent policy module.
//
// Everything is injected (fake clock, fake storage, fake matchMedia, duck-typed
// controller) — no real timers, no sleep, no DOM, no network. The browser-side
// characterisation of the same policy lives in `scripts/web-regression/mobile.mjs`.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COARSE_POINTER_MEDIA_QUERY,
  NO_HOVER_MEDIA_QUERY,
  TOUCH_PREFETCH_COMMIT_GRACE_MS,
  TOUCH_PREFETCH_INTENT_DELAY_MS,
  TOUCH_PREFETCH_POINTER_TYPES,
  TOUCH_PREFETCH_RATE_LIMIT_COOLDOWN_MS,
  TOUCH_PREFETCH_RATE_LIMIT_MAX,
  TOUCH_PREFETCH_RATE_LIMIT_WINDOW_MS,
  TOUCH_PREFETCH_SLOP_PX,
  createExplorerTouchPrefetchIntent,
  resolveTouchCapability,
} from "../frontend/app/features/explorer/prefetch-touch.js";
import { folderPathFromEvent } from "../frontend/app/features/explorer/prefetch-touch-bind.js";

function source(relative) {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const TOUCH_SOURCE = source("../frontend/app/features/explorer/prefetch-touch.js");
const BIND_SOURCE = source("../frontend/app/features/explorer/prefetch-touch-bind.js");
const CONTROLLER_SOURCE = source("../frontend/app/features/explorer/controller.js");
const TREE_SOURCE = source("../frontend/app/features/explorer/tree.js");

// --- test doubles ----------------------------------------------------------

function createFakeClock() {
  let now = 0;
  let sequence = 0;
  const pending = new Map();
  return {
    now: () => now,
    schedule(fn, ms) {
      const id = ++sequence;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    unschedule(id) {
      pending.delete(id);
    },
    pendingCount() {
      return pending.size;
    },
    // Fires every due timer in due order, including timers scheduled by a timer.
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, entry] of pending) {
          if (entry.at > target) continue;
          if (!next || entry.at < next[1].at || (entry.at === next[1].at && id < next[0])) next = [id, entry];
        }
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
    },
  };
}

function createControllerDouble() {
  const prefetched = [];
  const cancelled = [];
  return {
    prefetched,
    cancelled,
    prefetch(parent) {
      prefetched.push(parent);
    },
    cancelPrefetch(parent) {
      cancelled.push(parent);
    },
  };
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null) };
}

// A pointer event double: only the fields the policy is allowed to read.
function pointer(type, { id = 1, x = 0, y = 0, pointerType = "touch", isPrimary = true } = {}) {
  return { type, pointerId: id, clientX: x, clientY: y, pointerType, isPrimary };
}

function createHarness(overrides = {}) {
  const clock = createFakeClock();
  const controller = createControllerDouble();
  const events = [];
  const intent = createExplorerTouchPrefetchIntent({
    controller,
    storage: null, // no persisted preference unless a test asks for one
    touchCapable: true,
    delayMs: TOUCH_PREFETCH_INTENT_DELAY_MS,
    slopPx: TOUCH_PREFETCH_SLOP_PX,
    graceMs: TOUCH_PREFETCH_COMMIT_GRACE_MS,
    now: () => clock.now(),
    schedule: (fn, ms) => clock.schedule(fn, ms),
    unschedule: (id) => clock.unschedule(id),
    debug: (payload) => events.push(payload),
    ...overrides,
  });
  return { clock, controller, intent, events };
}
// --- frozen parameters and capability -------------------------------------

test("frozen parameters: 100 ms window, 10 px Euclidean slop, 250 ms grace, touch/pen only", () => {
  assert.equal(TOUCH_PREFETCH_INTENT_DELAY_MS, 100);
  assert.equal(TOUCH_PREFETCH_SLOP_PX, 10);
  assert.equal(TOUCH_PREFETCH_COMMIT_GRACE_MS, 250);
  assert.equal(COARSE_POINTER_MEDIA_QUERY, "(pointer: coarse)");
  assert.equal(NO_HOVER_MEDIA_QUERY, "(hover: none)");
  assert.deepEqual([...TOUCH_PREFETCH_POINTER_TYPES], ["touch", "pen"]);
  assert.deepEqual(
    [TOUCH_PREFETCH_RATE_LIMIT_MAX, TOUCH_PREFETCH_RATE_LIMIT_WINDOW_MS, TOUCH_PREFETCH_RATE_LIMIT_COOLDOWN_MS],
    [20, 60_000, 120_000],
  );
});

test("capability is (pointer: coarse) OR (hover: none), fail-closed without matchMedia", () => {
  const coarse = { matchMedia: (query) => ({ matches: query === COARSE_POINTER_MEDIA_QUERY }) };
  const noHover = { matchMedia: (query) => ({ matches: query === NO_HOVER_MEDIA_QUERY }) };
  const desktop = { matchMedia: () => ({ matches: false }) };
  const broken = { matchMedia: () => { throw new Error("blocked"); } };
  assert.equal(resolveTouchCapability(coarse), true);
  assert.equal(resolveTouchCapability(noHover), true);
  assert.equal(resolveTouchCapability(desktop), false);
  assert.equal(resolveTouchCapability({}), false);
  assert.equal(resolveTouchCapability(broken), false);
});

test("a hover-fine desktop, an explicit off preference and a disposed instance never arm", () => {
  const desktop = createHarness({ touchCapable: false });
  desktop.intent.pointerdown("Folder", pointer("pointerdown"));
  desktop.clock.advance(1000);
  assert.deepEqual(desktop.controller.prefetched, [], "a fine pointer device must never touch-prefetch");

  const off = createHarness({ mode: "off" });
  off.intent.pointerdown("Folder", pointer("pointerdown"));
  off.clock.advance(1000);
  assert.deepEqual(off.controller.prefetched, [], "mode off disables hover and touch alike");

  const stored = createHarness({ storage: memoryStorage({ "obsidian.web.explorer.prefetch.v1": "off" }) });
  assert.equal(stored.intent.enabled(), false, "the frozen storage key is the single preference source");
  stored.intent.pointerdown("Folder", pointer("pointerdown"));
  stored.clock.advance(1000);
  assert.deepEqual(stored.controller.prefetched, []);

  const disposed = createHarness();
  disposed.intent.dispose();
  disposed.intent.pointerdown("Folder", pointer("pointerdown"));
  disposed.clock.advance(1000);
  assert.deepEqual(disposed.controller.prefetched, [], "a disposed intent never calls the controller again");
});

test("mouse, secondary, non-pointer and non-string parents are ignored", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerdown("Folder", pointer("pointerdown", { pointerType: "mouse" }));
  intent.pointerdown("Folder", pointer("pointerdown", { isPrimary: false }));
  intent.pointerdown("Folder", pointer("pointerdown", { pointerType: "" }));
  intent.pointerdown("Folder", { type: "pointerdown" });
  intent.pointerdown(null, pointer("pointerdown", { id: 9 }));
  intent.pointerdown(42, pointer("pointerdown", { id: 8 }));
  clock.advance(1000);
  assert.deepEqual(controller.prefetched, []);
  assert.equal(clock.pendingCount(), 0, "no timer may be armed for an ignored gesture");
});

// --- the intent window -----------------------------------------------------

test("nothing below the window, exactly one prefetch at the window, no restart on repeat down", () => {
  const { clock, controller, intent, events } = createHarness();
  intent.pointerdown("Folder", pointer("pointerdown", { x: 10, y: 10 }));
  clock.advance(TOUCH_PREFETCH_INTENT_DELAY_MS - 1);
  assert.deepEqual(controller.prefetched, [], "a hold below the intent window must not issue while the finger is still down");

  intent.pointerdown("Folder", pointer("pointerdown", { x: 10, y: 10 }));
  clock.advance(1);
  assert.deepEqual(controller.prefetched, ["Folder"], "crossing the window issues exactly one speculative request");
  assert.equal(clock.pendingCount(), 0);
  assert.deepEqual(events[0], { event: "prefetch-issued", parent: "Folder", delayMs: 100 });

  // The pointer stays down and jitters: repeat down/move inside the slop changes nothing.
  intent.pointerdown("Folder", pointer("pointerdown", { x: 10, y: 10 }));
  intent.pointermove("Folder", pointer("pointermove", { x: 16, y: 16 }));
  clock.advance(1000);
  assert.deepEqual(controller.prefetched, ["Folder"], "one continuous gesture issues at most once");
  assert.deepEqual(controller.cancelled, []);
});

test("a release inside the window issues nothing and cancels nothing", () => {
  const { clock, controller, intent, events } = createHarness();
  intent.pointerdown("Folder", pointer("pointerdown", { x: 4, y: 4 }));
  clock.advance(40);
  intent.pointerup("Folder", pointer("pointerup", { x: 4, y: 4 }));
  assert.equal(clock.pendingCount(), 0, "the pending window timer must be cleared on release");
  clock.advance(5000);
  assert.deepEqual(controller.prefetched, [], "releasing inside the intent window must cancel the pending intent");
  assert.deepEqual(controller.cancelled, [], "nothing was issued, so nothing is cancelled");
  assert.deepEqual(events.map((entry) => entry.event), ["released-inside-window"]);
});

test("travel is Euclidean: (6,6) keeps the gesture, (11,0) cancels it exactly once", () => {
  const inside = createHarness();
  inside.intent.pointerdown("Folder", pointer("pointerdown", { x: 0, y: 0 }));
  inside.intent.pointermove("Folder", pointer("pointermove", { x: 6, y: 6 }));
  inside.clock.advance(TOUCH_PREFETCH_INTENT_DELAY_MS);
  assert.deepEqual(inside.controller.prefetched, ["Folder"], "hypot(6,6) is 8.49, inside the 10 px slop");

  const outside = createHarness();
  outside.intent.pointerdown("Folder", pointer("pointerdown", { x: 0, y: 0 }));
  outside.intent.pointermove("Folder", pointer("pointermove", { x: 11, y: 0 }));
  assert.deepEqual(outside.events.map((entry) => entry.event), ["cancel:move"]);
  outside.intent.pointermove("Folder", pointer("pointermove", { x: 40, y: 0 }));
  outside.intent.pointerup("Folder", pointer("pointerup", { x: 40, y: 0 }));
  outside.clock.advance(TOUCH_PREFETCH_INTENT_DELAY_MS + 500);
  assert.deepEqual(outside.controller.prefetched, [], "a scroll gesture must not issue a request");
  assert.deepEqual(outside.controller.cancelled, [], "a movement cancel before the issue must not call cancelPrefetch");
  assert.equal(outside.events.filter((entry) => entry.event === "cancel:move").length, 1, "cancel is exactly once");
  assert.equal(outside.clock.pendingCount(), 0);
});

test("a coordinate-less pointermove cannot prove travel and never cancels", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerdown("Folder", pointer("pointerdown", { x: 0, y: 0 }));
  intent.pointermove("Folder", { type: "pointermove", pointerId: 1, pointerType: "touch", isPrimary: true });
  clock.advance(TOUCH_PREFETCH_INTENT_DELAY_MS);
  assert.deepEqual(controller.prefetched, ["Folder"]);
});

// --- cancel paths ----------------------------------------------------------

test("pointerleave inside the window cancels silently, after the issue it cancels the owner once", () => {
  const inside = createHarness();
  inside.intent.pointerdown("Folder", pointer("pointerdown", { x: 0, y: 0 }));
  inside.clock.advance(30);
  inside.intent.pointerleave("Folder", pointer("pointerleave", { x: 0, y: 0 }));
  inside.clock.advance(1000);
  assert.deepEqual(inside.controller.prefetched, [], "leaving the row inside the window must not issue");
  assert.deepEqual(inside.controller.cancelled, [], "there was nothing to cancel");

  const after = createHarness();
  after.intent.pointerdown("Folder", pointer("pointerdown", { x: 0, y: 0 }));
  after.clock.advance(120);
  after.intent.pointerleave("Folder", pointer("pointerleave", { x: 0, y: 0 }));
  assert.deepEqual(after.controller.prefetched, ["Folder"]);
  assert.deepEqual(after.controller.cancelled, ["Folder"], "leaving after the issue releases the speculative owner (I04)");
  after.intent.pointerleave("Folder", pointer("pointerleave", { x: 0, y: 0 }));
  assert.deepEqual(after.controller.cancelled, ["Folder"], "a repeated leave must not cancel twice");

  // A leave reported for another row cannot end this gesture (retargeted/synthetic event).
  const other = createHarness();
  other.intent.pointerdown("Folder", pointer("pointerdown", { x: 0, y: 0 }));
  other.clock.advance(120);
  other.intent.pointerleave("OtherFolder", pointer("pointerleave", { x: 0, y: 0 }));
  assert.deepEqual(other.controller.cancelled, []);
});

test("pointercancel counts once: silent before the issue, owner-safe after it", () => {
  const before = createHarness();
  before.intent.pointerdown("Folder", pointer("pointerdown"));
  before.clock.advance(20);
  before.intent.pointercancel("Folder", pointer("pointercancel"));
  before.clock.advance(1000);
  assert.deepEqual(before.controller.prefetched, []);
  assert.deepEqual(before.controller.cancelled, []);

  const after = createHarness();
  after.intent.pointerdown("Folder", pointer("pointerdown"));
  after.clock.advance(120);
  after.intent.pointercancel("Folder", pointer("pointercancel"));
  after.intent.pointercancel("Folder", pointer("pointercancel"));
  assert.deepEqual(after.controller.prefetched, ["Folder"]);
  assert.deepEqual(after.controller.cancelled, ["Folder"]);
  assert.equal(after.clock.pendingCount(), 0);
});

// --- release grace ---------------------------------------------------------

test("a release after the issue defers to the click for one grace window, then cancels once", () => {
  const { clock, controller, intent, events } = createHarness();
  intent.pointerdown("Folder", pointer("pointerdown"));
  clock.advance(TOUCH_PREFETCH_INTENT_DELAY_MS);
  intent.pointerup("Folder", pointer("pointerup"));
  clock.advance(TOUCH_PREFETCH_COMMIT_GRACE_MS - 1);
  assert.deepEqual(controller.cancelled, [], "the click/toggle has the whole grace window to promote the owner");
  intent.pointerup("Folder", pointer("pointerup"));
  clock.advance(1);
  assert.deepEqual(controller.cancelled, ["Folder"], "an unredeemed release gives the slot back after the grace");
  clock.advance(600);
  assert.deepEqual(controller.cancelled, ["Folder"], "the grace timer settles exactly once");
  assert.equal(clock.pendingCount(), 0);
  assert.deepEqual(events.map((entry) => entry.event), ["prefetch-issued", "grace-expired"]);
});

test("a promotion within the grace window is followed by exactly one owner-safe late cancel", () => {
  const controller = createControllerDouble();
  const clock = createFakeClock();
  // The controller promotes on the click that follows the release: from then on the parent
  // is a formal owner, which the frozen cancel policy must refuse to abort (I04).
  let promoted = false;
  const intent = createExplorerTouchPrefetchIntent({
    controller: {
      prefetch: (parent) => controller.prefetch(parent),
      cancelPrefetch: (parent) => { if (!promoted) controller.cancelPrefetch(parent); },
    },
    mode: "hover",
    touchCapable: true,
    now: () => clock.now(),
    schedule: (fn, ms) => clock.schedule(fn, ms),
    unschedule: (id) => clock.unschedule(id),
  });
  intent.pointerdown("Folder", pointer("pointerdown"));
  clock.advance(TOUCH_PREFETCH_INTENT_DELAY_MS);
  intent.pointerup("Folder", pointer("pointerup"));
  clock.advance(20);
  promoted = true; // the click landed inside the grace window
  clock.advance(TOUCH_PREFETCH_COMMIT_GRACE_MS);
  assert.deepEqual(controller.prefetched, ["Folder"]);
  assert.deepEqual(controller.cancelled, [], "the late grace cancel must never abort a promoted owner");
});

// --- concurrency-adjacent ceiling (rate limit) -----------------------------

test("the cumulative ceiling drops the next intent, then resets after the cooldown", () => {
  const { clock, controller, intent, events } = createHarness({
    rateLimitMax: 2,
    rateLimitWindowMs: 60_000,
    rateLimitCooldownMs: 120_000,
  });
  const issue = (id) => {
    intent.pointerdown("Folder", pointer("pointerdown", { id }));
    clock.advance(TOUCH_PREFETCH_INTENT_DELAY_MS + 1);
    intent.pointerup("Folder", pointer("pointerup", { id }));
    clock.advance(TOUCH_PREFETCH_COMMIT_GRACE_MS + 1);
  };
  issue(1);
  issue(2);
  assert.deepEqual(controller.prefetched, ["Folder", "Folder"], "two issues fill the ceiling");
  issue(3);
  assert.deepEqual(controller.prefetched, ["Folder", "Folder"], "the next intent inside the window is dropped, never queued");
  assert.deepEqual(events.filter((entry) => entry.event === "rate-limited").length, 1);
  assert.ok(events.some((entry) => entry.event === "rate-limit-triggered"));

  clock.advance(60_000);
  issue(4);
  assert.equal(controller.prefetched.length, 2, "the cooldown keeps prefetch off");

  clock.advance(TOUCH_PREFETCH_RATE_LIMIT_COOLDOWN_MS);
  issue(5);
  assert.equal(controller.prefetched.length, 3, "after the cooldown the window resets and prefetch works again");
});

test("the ceiling is time-bounded: issues outside the window do not accumulate", () => {
  const { clock, controller, intent } = createHarness({ rateLimitMax: 1, rateLimitWindowMs: 1000, rateLimitCooldownMs: 1000 });
  const issue = (id, waitMs) => {
    clock.advance(waitMs);
    intent.pointerdown("Folder", pointer("pointerdown", { id }));
    clock.advance(TOUCH_PREFETCH_INTENT_DELAY_MS);
  };
  issue(1, 0);
  issue(2, 1001);
  issue(3, 1001);
  assert.equal(controller.prefetched.length, 3, "one issue per window is allowed again once the window slides");
});

// --- multiple pointers -----------------------------------------------------

test("each active pointerId arms its own gesture; a second finger does not reuse the first state", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerdown("AdapterA", pointer("pointerdown", { id: 101, x: 0, y: 0 }));
  clock.advance(150);
  intent.pointerdown("AdapterB", pointer("pointerdown", { id: 102, x: 0, y: 50 }));
  clock.advance(TOUCH_PREFETCH_INTENT_DELAY_MS);
  assert.deepEqual(controller.prefetched, ["AdapterA", "AdapterB"], "both held fingers issue for their own parent");
  intent.pointerup("AdapterA", pointer("pointerup", { id: 101 }));
  intent.pointerup("AdapterB", pointer("pointerup", { id: 102 }));
  clock.advance(TOUCH_PREFETCH_COMMIT_GRACE_MS + 1);
  assert.deepEqual(controller.cancelled, ["AdapterA", "AdapterB"]);
});

// --- dispose ---------------------------------------------------------------

test("dispose clears every timer, drops live gestures and is idempotent", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerdown("Folder", pointer("pointerdown", { id: 1 }));
  intent.pointerdown("Other", pointer("pointerdown", { id: 2 }));
  clock.advance(120);
  assert.deepEqual(controller.prefetched, ["Folder", "Other"]);
  intent.dispose();
  assert.equal(clock.pendingCount(), 0, "no timer survives dispose");
  intent.pointerup("Folder", pointer("pointerup", { id: 1 }));
  clock.advance(TOUCH_PREFETCH_COMMIT_GRACE_MS + 1);
  assert.deepEqual(controller.cancelled, [], "the request side belongs to controller.dispose()");
  intent.dispose();
  intent.pointerdown("Third", pointer("pointerdown", { id: 3 }));
  clock.advance(1000);
  assert.deepEqual(controller.prefetched, ["Folder", "Other"]);
});

// --- static boundaries -----------------------------------------------------

test("the touch policy owns no DOM, no fetch, no timer primitive of its own and no lazy model", () => {
  for (const forbidden of [
    /setInterval\(/,
    /requestIdleCallback/,
    /\bfetch\(/,
    /AbortController/,
    /XMLHttpRequest/,
    /sendBeacon/,
    /\/api\//,
    /document\./,
    /querySelector/,
    /getElementById/,
    /addEventListener/,
    /lazy-model|childrenByParent/,
    /touchstart/,
    /preventDefault|stopPropagation|setPointerCapture/,
  ]) {
    assert.doesNotMatch(TOUCH_SOURCE, forbidden);
  }
  // I337-E03: one slop definition, Euclidean, defined exactly once in the policy.
  assert.equal((TOUCH_SOURCE.match(/Math\.hypot\(/g) ?? []).length, 1);
  assert.match(TOUCH_SOURCE, /import \{[\s\S]*?readExplorerPrefetchPreference,[\s\S]*?\} from "\.\/prefetch\.js";/);
  assert.doesNotMatch(TOUCH_SOURCE, /EXPLORER_PREFETCH_STORAGE_KEY\s*=/);
});

test("the renderer seam binds delegated pointer events only and never a network or network-rule call", () => {
  for (const forbidden of [
    /setTimeout\(/,
    /setInterval\(/,
    /\bfetch\(/,
    /AbortController/,
    /cancelPrefetch\(/,
    /matchMedia/,
    /touchstart/,
    /preventDefault|stopPropagation|setPointerCapture/,
  ]) {
    assert.doesNotMatch(BIND_SOURCE, forbidden);
  }
  for (const event of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave"]) {
    assert.match(BIND_SOURCE, new RegExp(`host\\.addEventListener\\("${event}"`));
  }
  // `pointerleave` does not bubble, so the delegated seam observes it in the capture phase.
  assert.match(BIND_SOURCE, /host\.addEventListener\("pointerleave", onPointerLeave, true\);/);
});

test("the seam resolves the folder path from the row wrapper, never from an add button", () => {
  const wrap = { dataset: { folderPath: "Folder/Sub" }, closest: (selector) => (selector === ".tree-folder-row" ? wrap : null) };
  const row = {
    closest: (selector) => {
      if (selector === ".tree-folder") return row;
      if (selector === ".tree-folder-row") return wrap;
      return null;
    },
  };
  const addButton = { closest: (selector) => (selector === ".tree-folder-row" ? wrap : null) };
  assert.equal(folderPathFromEvent({ target: row }), "Folder/Sub");
  assert.equal(folderPathFromEvent({ target: addButton }), null, "the add button must never arm a folder prefetch");
  assert.equal(folderPathFromEvent({ target: wrap }), null);
  assert.equal(folderPathFromEvent({}), null);
});

test("the controller creates exactly one touch intent from the frozen factory and delegates it once", () => {
  assert.match(CONTROLLER_SOURCE, /import \{ createExplorerTouchPrefetchIntent \} from "\.\/prefetch-touch\.js";/);
  assert.match(CONTROLLER_SOURCE, /import \{ bindFolderTouchIntent \} from "\.\/prefetch-touch-bind\.js";/);
  assert.equal((CONTROLLER_SOURCE.match(/createExplorerTouchPrefetchIntent\(/g) ?? []).length, 1, "one touch intent per controller");
  assert.match(CONTROLLER_SOURCE, /createExplorerTouchPrefetchIntent\(\{ controller: tree \}\)/);
  assert.match(CONTROLLER_SOURCE, /bindFolderTouchIntent\(\{ host, intent: touchIntent \}\)/);
  assert.doesNotMatch(CONTROLLER_SOURCE, /\/api\/web\/v2\/tree/);
  // The hover renderer seam of #284 is untouched: no touch handler was added to tree.js.
  assert.doesNotMatch(TREE_SOURCE, /touch|Touch/);
});
