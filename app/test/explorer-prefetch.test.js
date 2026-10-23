// Issue #284 Wave A1 unit matrix: explorer hover prefetch intent / capability /
// preference policy module. Everything here is injected (fake clock, fake storage,
// fake matchMedia, duck-typed controller) — no real timers, no sleep, no DOM.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EXPLORER_PREFETCH_MODE,
  EXPLORER_PREFETCH_MODES,
  EXPLORER_PREFETCH_STORAGE_KEY,
  HOVER_MEDIA_QUERY,
  PREFETCH_INTENT_DELAY_MS,
  createExplorerPrefetchIntent,
  parseExplorerPrefetch,
  readExplorerPrefetchPreference,
  resolveExplorerPrefetchStorage,
} from "../frontend/app/features/explorer/prefetch.js";

const MODULE_SOURCE_PATH = "../frontend/app/features/explorer/prefetch.js";

function source(relative) {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

// --- test doubles ----------------------------------------------------------

function createFakeClock() {
  let now = 0;
  let sequence = 0;
  const pending = new Map();
  return {
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
    now() {
      return now;
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
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
  };
}

function createHarness(overrides = {}) {
  const clock = createFakeClock();
  const controller = createControllerDouble();
  const prefetchQueries = [];
  const intent = createExplorerPrefetchIntent({
    controller,
    storage: null, // no persisted preference unless a test asks for one
    hoverCapable: true,
    schedule: (fn, ms) => clock.schedule(fn, ms),
    unschedule: (id) => clock.unschedule(id),
    matchMedia: (query) => {
      prefetchQueries.push(query);
      return { matches: true, media: query };
    },
    ...overrides,
  });
  return { clock, controller, intent, prefetchQueries };
}

// --- frozen constants / preference policy ---------------------------------

test("frozen constants: 150 ms threshold, hover-capable query, opt-out default", () => {
  assert.equal(PREFETCH_INTENT_DELAY_MS, 150);
  assert.equal(HOVER_MEDIA_QUERY, "(hover: hover)");
  assert.equal(EXPLORER_PREFETCH_STORAGE_KEY, "obsidian.web.explorer.prefetch.v1");
  assert.equal(DEFAULT_EXPLORER_PREFETCH_MODE, "hover");
  assert.deepEqual([...EXPLORER_PREFETCH_MODES], ["hover", "off"]);
});

test("parseExplorerPrefetch accepts exactly hover/off and falls back to hover", () => {
  assert.equal(parseExplorerPrefetch("hover"), "hover");
  assert.equal(parseExplorerPrefetch("off"), "off");
  for (const raw of ["yes", "", "HOVER", " hover", "off ", "1", "true", "null", undefined, null, 0, {}]) {
    assert.equal(parseExplorerPrefetch(raw), "hover", JSON.stringify(raw) ?? String(raw));
  }
});

test("readExplorerPrefetchPreference reads the exact key and defaults on read failure", () => {
  const storage = memoryStorage({ [EXPLORER_PREFETCH_STORAGE_KEY]: "off" });
  assert.equal(readExplorerPrefetchPreference(storage), "off");
  assert.equal(readExplorerPrefetchPreference(null), "hover");
  assert.equal(readExplorerPrefetchPreference({ getItem: () => { throw new Error("blocked"); } }), "hover");
  assert.equal(readExplorerPrefetchPreference({}), "hover");
  assert.equal(resolveExplorerPrefetchStorage({ get localStorage() { throw new Error("blocked"); } }), null);
});

// --- intent matrix (§11.1) -------------------------------------------------

test("enter then leave before 150 ms issues no prefetch", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerenter("a/b");
  clock.advance(149);
  intent.pointerleave("a/b");
  clock.advance(1000);
  assert.deepEqual(controller.prefetched, []);
  assert.deepEqual(controller.cancelled, []);
  assert.equal(clock.pendingCount(), 0);
});

test("enter held for the full 150 ms issues exactly one prefetch for that parent", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerenter("a/b");
  clock.advance(149);
  assert.deepEqual(controller.prefetched, []);
  clock.advance(1);
  assert.deepEqual(controller.prefetched, ["a/b"]);
  assert.equal(clock.pendingCount(), 0);
});

test("repeated enter on the same parent neither restarts the timer nor double-issues", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerenter("a");
  clock.advance(100);
  intent.pointerenter("a"); // must not restart the 150 ms window
  clock.advance(50);
  assert.deepEqual(controller.prefetched, ["a"]);
  intent.pointerenter("a"); // already issued: no second request
  clock.advance(1000);
  assert.deepEqual(controller.prefetched, ["a"]);
  intent.pointerleave("a");
  assert.deepEqual(controller.cancelled, ["a"]);
});

test("a non-hover pointer (hover:none) never prefetches and never cancels", () => {
  // The capability query array must exist before the factory runs, so it is
  // declared here instead of being destructured from the harness result.
  const queries = [];
  const { clock, controller, intent } = createHarness({
    hoverCapable: undefined,
    matchMedia: (query) => {
      queries.push(query);
      return { matches: false, media: query };
    },
  });
  intent.pointerenter("a");
  clock.advance(1000);
  intent.pointerleave("a");
  assert.deepEqual(queries, [HOVER_MEDIA_QUERY]);
  assert.deepEqual(controller.prefetched, []);
  assert.deepEqual(controller.cancelled, []);
});

test("explicit hover capability bypasses matchMedia but a false flag stays disabled", () => {
  const { clock, controller, intent, prefetchQueries } = createHarness({ hoverCapable: false });
  // The harness default matchMedia is never consulted when the flag is explicit.
  intent.pointerenter("a");
  clock.advance(1000);
  assert.deepEqual(prefetchQueries, []);
  assert.deepEqual(controller.prefetched, []);
});

test("preference off disables prefetch and cancel entirely", () => {
  const { clock, controller, intent } = createHarness({
    storage: memoryStorage({ [EXPLORER_PREFETCH_STORAGE_KEY]: "off" }),
  });
  intent.pointerenter("a");
  clock.advance(1000);
  intent.pointerleave("a");
  assert.deepEqual(controller.prefetched, []);
  assert.deepEqual(controller.cancelled, []);
});

test("invalid or missing preference values fall back to the hover default", () => {
  const cases = [
    "yes",
    "",
    "HOVER",
    undefined,
    null,
  ];
  for (const raw of cases) {
    const storage = { getItem: () => raw };
    const { clock, controller, intent } = createHarness({ storage });
    intent.pointerenter("a");
    clock.advance(150);
    assert.deepEqual(controller.prefetched, ["a"], `preference ${JSON.stringify(raw) ?? String(raw)} must behave as hover`);
  }
});

test("an explicit mode option overrides the injected storage", () => {
  const storage = memoryStorage({ [EXPLORER_PREFETCH_STORAGE_KEY]: "hover" });
  const { clock, controller, intent } = createHarness({ storage, mode: "off" });
  intent.pointerenter("a");
  clock.advance(1000);
  assert.deepEqual(controller.prefetched, []);
});

// --- cancel semantics ------------------------------------------------------

test("leave before the timer fires cancels silently; leave after issues cancelPrefetch once", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerenter("a");
  clock.advance(120);
  intent.pointerleave("a");
  assert.equal(clock.pendingCount(), 0);
  assert.deepEqual(controller.prefetched, []);
  assert.deepEqual(controller.cancelled, []);

  intent.pointerenter("a"); // a fresh intent after an abandoned hover may re-issue
  clock.advance(150);
  assert.deepEqual(controller.prefetched, ["a"]);
  intent.pointerleave("a");
  intent.pointerleave("a"); // late duplicate leave must not repeat the cancel
  assert.deepEqual(controller.cancelled, ["a"]);
});

test("parents time independently", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerenter("a");
  clock.advance(100);
  intent.pointerenter("b");
  clock.advance(50);
  assert.deepEqual(controller.prefetched, ["a"]); // b still inside its 150 ms window
  intent.pointerleave("b");
  clock.advance(1000);
  assert.deepEqual(controller.prefetched, ["a"]);
  assert.deepEqual(controller.cancelled, []); // b was cancelled before it issued
  intent.pointerleave("a");
  assert.deepEqual(controller.cancelled, ["a"]);
});

test("invalid parent values are ignored", () => {
  const { clock, controller, intent } = createHarness();
  for (const parent of [undefined, null, 42, {}, [], true]) intent.pointerenter(parent);
  clock.advance(1000);
  for (const parent of [undefined, null, 42, {}, [], true]) intent.pointerleave(parent);
  assert.deepEqual(controller.prefetched, []);
  assert.deepEqual(controller.cancelled, []);
  assert.equal(clock.pendingCount(), 0);
});

// --- dispose ---------------------------------------------------------------

test("dispose clears every pending timer and stops further intent work", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerenter("a");
  intent.pointerenter("b");
  assert.equal(clock.pendingCount(), 2);
  intent.dispose();
  assert.equal(clock.pendingCount(), 0);
  clock.advance(1000);
  intent.pointerenter("c");
  clock.advance(1000);
  intent.pointerleave("c");
  assert.deepEqual(controller.prefetched, []);
  assert.deepEqual(controller.cancelled, []);
});

test("an already-issued instance produces no further calls after dispose", () => {
  const { clock, controller, intent } = createHarness();
  intent.pointerenter("a");
  clock.advance(150);
  assert.deepEqual(controller.prefetched, ["a"]);
  intent.dispose();
  intent.pointerleave("a"); // controller.dispose owns cancellation, not this module
  intent.pointerenter("b");
  clock.advance(1000);
  assert.deepEqual(controller.prefetched, ["a"]);
  assert.deepEqual(controller.cancelled, []);
  assert.equal(clock.pendingCount(), 0);
});

// --- dependency-injection contract ----------------------------------------

test("the factory requires a duck-typed controller and never imports one", () => {
  assert.throws(() => createExplorerPrefetchIntent(), /controller/);
  assert.throws(() => createExplorerPrefetchIntent({ controller: {} }), /controller/);
  assert.throws(() => createExplorerPrefetchIntent({ controller: { prefetch() {} } }), /controller/);
  assert.throws(() => createExplorerPrefetchIntent({ controller: { cancelPrefetch() {} } }), /controller/);
});

// --- architecture assertion (§15) -----------------------------------------

test("intent module stays pure: no imports, no fetch, no model/controller access", () => {
  const text = source(MODULE_SOURCE_PATH);
  assert.doesNotMatch(text, /^\s*import\s/m, "prefetch.js must not import anything");
  assert.doesNotMatch(text, /\bfetch\s*\(/, "prefetch.js must never fetch");
  assert.doesNotMatch(text, /lazy-model|childrenByParent|nextCursorByParent/, "prefetch.js must not touch the lazy model");
  assert.doesNotMatch(text, /lazy-controller/, "prefetch.js must not import the controller implementation");
  assert.doesNotMatch(text, /document\.|window\./, "prefetch.js must not bind or read the DOM");
});
