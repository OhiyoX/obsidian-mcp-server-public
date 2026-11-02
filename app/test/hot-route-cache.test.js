// Hot Routes Phase 1-A — hermetic contract tests for the isolated
// `hot-route-cache.js` primitive.
//
// Every test is deterministic: an injected fake clock and explicit
// entered/release barriers replace sleeps, and freshness is a synchronous
// in-memory probe. No vault, filesystem, network, or runtime module is touched.

import assert from "node:assert/strict";
import test from "node:test";

import { createHotRouteCache } from "../src/hot-route-cache.js";

const NAMESPACES = {
  "test-route": { allowedArgKeys: ["k1", "k2"], maxCanonicalBytes: 256 },
};

function makeSource({
  publicationRevision = 0,
  snapshotGeneration = 0,
  includeHidden = false,
  completeness = "complete",
  skipped = 0,
} = {}) {
  return {
    publicationRevision,
    snapshotGeneration,
    includeHidden,
    coverage: { includeHidden, completeness, skipped },
  };
}

function makeFresh({
  freshness = "clean",
  vaultGeneration,
  snapshotGeneration,
  publicationRevision = 0,
  includeHidden = false,
  completeness = "complete",
  skipped = 0,
} = {}) {
  return {
    freshness,
    vaultGeneration: snapshotGeneration ?? vaultGeneration ?? 0,
    publicationRevision,
    includeHidden,
    coverage: { includeHidden, completeness, skipped },
  };
}

function harness({ ttlMs = 60000, maxEntries = 8, maxApproxBytes, namespaces = NAMESPACES, clock = { now: 0 }, nowHook } = {}) {
  const state = { value: makeFresh(), mode: "ok" };
  const readFreshness = () => {
    if (state.mode === "throw") throw new Error("freshness provider boom");
    if (state.mode === "malformed") return null;
    return state.value;
  };
  const now = () => {
    if (nowHook) nowHook(state);
    return clock.now;
  };
  const cache = createHotRouteCache({ namespaces, ttlMs, maxEntries, maxApproxBytes, now, readFreshness });
  return { cache, state, clock };
}

function barrier() {
  let enterResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enterResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  return { entered, release, enter: enterResolve, open: releaseResolve };
}

function call(cache, sourceStats, canonicalArgs, compute, namespace = "test-route") {
  return cache.getOrCompute({ namespace, canonicalArgs, sourceStats, compute });
}

test("ttl: hit before expiry and equal-to-expiry is expired", async () => {
  const clock = { now: 0 };
  const { cache } = harness({ ttlMs: 10, clock });
  const source = makeSource();
  let computed = 0;
  const compute = () => ({ n: computed++ });

  const first = await call(cache, source, { k1: "a" }, compute);
  assert.equal(first.status, "computed");
  clock.now = 9;
  const hit = await call(cache, source, { k1: "a" }, compute);
  assert.equal(hit.status, "hit");
  assert.deepEqual(hit.value, { n: 0 });
  clock.now = 10;
  const expired = await call(cache, source, { k1: "a" }, compute);
  assert.equal(expired.status, "computed");
  assert.deepEqual(expired.value, { n: 1 });
  assert.equal(computed, 2);
  assert.equal(cache.stats().hit, 1);
  assert.equal(cache.stats().expired, 1);
});

test("ttl 0 computes and returns without retaining", async () => {
  const { cache } = harness({ ttlMs: 0 });
  const source = makeSource();
  let computed = 0;
  const first = await call(cache, source, { k1: "a" }, () => ({ n: computed++ }));
  const second = await call(cache, source, { k1: "a" }, () => ({ n: computed++ }));
  assert.equal(first.status, "computed");
  assert.equal(second.status, "computed");
  assert.deepEqual(second.value, { n: 1 });
  assert.equal(computed, 2);
  assert.equal(cache.stats().currentEntries, 0);
});

test("maxEntries LRU: hit refreshes recency and evicts the least recent", async () => {
  const { cache } = harness({ maxEntries: 2 });
  const source = makeSource();
  await call(cache, source, { k1: "A" }, () => ({ tag: "A" }));
  await call(cache, source, { k1: "B" }, () => ({ tag: "B" }));
  const hitA = await call(cache, source, { k1: "A" }, () => ({ tag: "A2" }));
  assert.equal(hitA.status, "hit");
  assert.deepEqual(hitA.value, { tag: "A" });
  await call(cache, source, { k1: "C" }, () => ({ tag: "C" }));
  const stillA = await call(cache, source, { k1: "A" }, () => ({ tag: "A3" }));
  assert.equal(stillA.status, "hit");
  const evictedB = await call(cache, source, { k1: "B" }, () => ({ tag: "B2" }));
  assert.equal(evictedB.status, "computed");
  assert.deepEqual(evictedB.value, { tag: "B2" });
  assert.equal(cache.stats().evicted, 2);
});

test("maxApproxBytes evicts by serialized size and oversize is returned but not stored", async () => {
  const { cache } = harness({ maxEntries: 8, maxApproxBytes: 25 });
  const source = makeSource();
  await call(cache, source, { k1: "A" }, () => ({ p: "aaaa" })); // 12 bytes
  await call(cache, source, { k1: "B" }, () => ({ p: "bbbb" })); // 24 bytes total
  await call(cache, source, { k1: "C" }, () => ({ p: "cccc" })); // 36 > 25 -> evict A
  const evictedA = await call(cache, source, { k1: "A" }, () => ({ p: "aaaa" }));
  assert.equal(evictedA.status, "computed");
  assert.equal(cache.stats().evicted, 2);

  const oversize = await call(cache, source, { k1: "BIG" }, () => ({ p: "x".repeat(100) }));
  assert.equal(oversize.status, "computed");
  assert.equal(oversize.value.p.length, 100);
  assert.equal(cache.stats().oversize, 1);
  const after = cache.stats();
  assert.ok(after.approxBytes <= 25);
});

test("canonical args: key order is equivalent, unknown/oversize/illegal values reject", async () => {
  const { cache } = harness();
  const source = makeSource();
  let computed = 0;
  const compute = () => ({ n: computed++ });
  const first = await call(cache, source, { k1: "x", k2: "y" }, compute);
  assert.equal(first.status, "computed");
  const reordered = await call(cache, source, { k2: "y", k1: "x" }, compute);
  assert.equal(reordered.status, "hit");
  assert.deepEqual(reordered.value, { n: 0 });

  await assert.rejects(() => call(cache, source, { unknown: 1 }, compute), (error) => error.code === "HOT_ROUTE_CACHE_ARGS");
  await assert.rejects(() => call(cache, source, { k1: { nested: true } }, compute), (error) => error.code === "HOT_ROUTE_CACHE_ARGS");
  await assert.rejects(() => call(cache, source, { k1: [{ nested: true }] }, compute), (error) => error.code === "HOT_ROUTE_CACHE_ARGS");
  await assert.rejects(() => call(cache, source, { k1: () => 1 }, compute), (error) => error.code === "HOT_ROUTE_CACHE_ARGS");
  await assert.rejects(() => call(cache, source, { k1: Number.NaN }, compute), (error) => error.code === "HOT_ROUTE_CACHE_ARGS");
  await assert.rejects(() => call(cache, source, { k1: "z".repeat(300) }, compute), (error) => error.code === "HOT_ROUTE_CACHE_ARGS");
});

test("canonical args encoding is injective for separator-shaped keys", async () => {
  const namespaces = {
    "test-route": { allowedArgKeys: ["a", "b", 'a=s"x"\nb'], maxCanonicalBytes: 256 },
  };
  const { cache } = harness({ namespaces });
  const source = makeSource();
  let computed = 0;
  const compute = () => ({ case: (computed += 1) });
  const first = await call(cache, source, { a: "x", b: "y" }, compute);
  assert.equal(first.status, "computed");
  assert.deepEqual(first.value, { case: 1 });
  // A key that reproduces the old `\n`-joined pre-hash string must not alias.
  const second = await call(cache, source, { ['a=s"x"\nb']: "y" }, compute);
  assert.equal(second.status, "computed");
  assert.deepEqual(second.value, { case: 2 });
  assert.equal(computed, 2);
  assert.equal(cache.stats().hit, 0);
  assert.equal(cache.stats().coalesced, 0);
  // Re-issuing the first shape is a real hit of its own distinct entry.
  const firstAgain = await call(cache, source, { a: "x", b: "y" }, compute);
  assert.equal(firstAgain.status, "hit");
  assert.deepEqual(firstAgain.value, { case: 1 });
});

test("canonical args distinguish scalar types and array shape", async () => {
  const namespaces = { "test-route": { allowedArgKeys: ["k"], maxCanonicalBytes: 256 } };
  const { cache } = harness({ namespaces });
  const source = makeSource();
  let computed = 0;
  const compute = () => ({ n: (computed += 1) });
  const shapes = [{ k: "1" }, { k: 1 }, { k: true }, { k: null }, { k: ["1", 1] }];
  const results = [];
  for (const args of shapes) results.push(await call(cache, source, args, compute));
  assert.deepEqual(results.map((result) => result.status), ["computed", "computed", "computed", "computed", "computed"]);
  assert.equal(computed, 5);
  assert.equal(cache.stats().hit, 0);
  const hitString = await call(cache, source, { k: "1" }, compute);
  assert.equal(hitString.status, "hit");
  assert.deepEqual(hitString.value, { n: 1 });
  const hitArray = await call(cache, source, { k: ["1", 1] }, compute);
  assert.equal(hitArray.status, "hit");
  assert.deepEqual(hitArray.value, { n: 5 });
  // Array order is significant: a reversed scalar array is a distinct entry.
  const reversed = await call(cache, source, { k: [1, "1"] }, compute);
  assert.equal(reversed.status, "computed");
  assert.deepEqual(reversed.value, { n: 6 });
});

test("singleflight: same key computes once and coalesces waiters", async () => {
  const { cache } = harness();
  const source = makeSource();
  const gate = barrier();
  let computed = 0;
  const compute = async () => { computed += 1; gate.enter(); await gate.release; return { n: computed }; };
  const first = call(cache, source, { k1: "x" }, compute);
  await gate.entered;
  const second = call(cache, source, { k1: "x" }, compute);
  gate.open();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.status, "computed");
  assert.equal(r2.status, "computed");
  assert.deepEqual(r1.value, r2.value);
  assert.notEqual(r1.value, r2.value);
  assert.equal(computed, 1);
  const stats = cache.stats();
  assert.equal(stats.computed, 1);
  assert.equal(stats.coalesced, 1);
  assert.equal(stats.inflight, 0);
});

test("singleflight key includes the publication token: different sources do not coalesce", async () => {
  const { cache, state } = harness();
  const sourceA = makeSource({ publicationRevision: 1, snapshotGeneration: 0 });
  const sourceB = makeSource({ publicationRevision: 2, snapshotGeneration: 0 });
  state.value = makeFresh({ publicationRevision: 1, snapshotGeneration: 0 });
  const gate = barrier();
  let computed = 0;
  const computeA = async () => { computed += 1; gate.enter(); await gate.release; return { from: "A" }; };
  const first = call(cache, sourceA, { k1: "x" }, computeA);
  await gate.entered;
  state.value = makeFresh({ publicationRevision: 2, snapshotGeneration: 0 });
  const second = call(cache, sourceB, { k1: "x" }, () => ({ from: "B" }));
  gate.open();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.status, "bypass");
  assert.equal(r1.reason, "publication-mismatch");
  assert.equal(r2.status, "computed");
  assert.deepEqual(r2.value, { from: "B" });
  assert.equal(computed, 1);
  assert.equal(cache.stats().coalesced, 0);
});

test("rejection: no negative cache, slot cleaned, waiters share the same error", async () => {
  const { cache } = harness();
  const source = makeSource();
  const gate = barrier();
  const boom = new Error("compute boom");
  const failing = async () => { gate.enter(); await gate.release; throw boom; };
  const first = call(cache, source, { k1: "x" }, failing);
  await gate.entered;
  const second = call(cache, source, { k1: "x" }, failing);
  gate.open();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[0].reason, boom);
  assert.equal(results[1].reason, boom);
  const stats = cache.stats();
  assert.equal(stats.reject, 1);
  assert.equal(stats.inflight, 0);
  assert.equal(stats.currentEntries, 0);
  const retry = await call(cache, source, { k1: "x" }, () => ({ ok: true }));
  assert.equal(retry.status, "computed");
  assert.deepEqual(retry.value, { ok: true });
});

test("clear() during compute bypasses every caller and does not resurrect", async () => {
  const { cache } = harness({ maxEntries: 4 });
  const source = makeSource();
  await call(cache, source, { k1: "seed" }, () => ({ seed: true }));
  const gate = barrier();
  let computed = 0;
  const compute = async () => { computed += 1; gate.enter(); await gate.release; return { n: computed }; };
  const first = call(cache, source, { k1: "x" }, compute);
  await gate.entered;
  const second = call(cache, source, { k1: "x" }, compute);
  cache.clear();
  gate.open();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.status, "bypass");
  assert.equal(r1.reason, "invalidated");
  assert.equal(r2.status, "bypass");
  assert.equal(r2.reason, "invalidated");
  assert.equal(Object.prototype.hasOwnProperty.call(r1, "value"), false);
  assert.equal(computed, 1);
  assert.equal(cache.stats().currentEntries, 0);
  const after = await call(cache, source, { k1: "x" }, () => ({ fresh: true }));
  assert.equal(after.status, "computed");
  assert.deepEqual(after.value, { fresh: true });
});

test("invalidate(namespace) during compute bypasses waiters and blocks resurrection", async () => {
  const { cache } = harness({ maxEntries: 4 });
  const source = makeSource();
  await call(cache, source, { k1: "seed" }, () => ({ seed: true }));
  const gate = barrier();
  const compute = async () => { gate.enter(); await gate.release; return { n: 1 }; };
  const first = call(cache, source, { k1: "x" }, compute);
  await gate.entered;
  const second = call(cache, source, { k1: "x" }, compute);
  cache.invalidate("test-route");
  gate.open();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.status, "bypass");
  assert.equal(r1.reason, "invalidated");
  assert.equal(r2.status, "bypass");
  assert.equal(cache.stats().currentEntries, 0);
});

test("source mutation while awaiting compute bypasses all callers", async () => {
  const { cache, state } = harness();
  const source = makeSource();
  const gate = barrier();
  const compute = async () => { gate.enter(); await gate.release; return { ok: true }; };
  const first = call(cache, source, { k1: "x" }, compute);
  await gate.entered;
  const second = call(cache, source, { k1: "x" }, compute);
  state.value = makeFresh({ vaultGeneration: 1, publicationRevision: 1 });
  gate.open();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.status, "bypass");
  assert.equal(r1.reason, "generation-mismatch");
  assert.equal(r2.status, "bypass");
  assert.equal(Object.prototype.hasOwnProperty.call(r2, "value"), false);
});

test("individual fence after the group put fence bypasses leader and waiter", async () => {
  let flipped = false;
  const { cache } = harness({
    nowHook: (state) => {
      if (!flipped) {
        flipped = true;
        state.value = makeFresh({ vaultGeneration: 1, publicationRevision: 1 });
      }
    },
  });
  const source = makeSource();
  const gate = barrier();
  const compute = async () => { gate.enter(); await gate.release; return { ok: true }; };
  const first = call(cache, source, { k1: "x" }, compute);
  await gate.entered;
  const second = call(cache, source, { k1: "x" }, compute);
  gate.open();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.status, "bypass");
  assert.equal(r1.reason, "generation-mismatch");
  assert.equal(r2.status, "bypass");
  assert.equal(Object.prototype.hasOwnProperty.call(r2, "value"), false);
  assert.equal(cache.stats().computed, 1);
});

test("synchronous invalidate after the call prevents serving the invalidated hit", async () => {
  const { cache } = harness();
  const source = makeSource();
  await call(cache, source, { k1: "x" }, () => ({ n: 1 }));
  const pending = call(cache, source, { k1: "x" }, () => ({ n: 2 }));
  cache.invalidate("test-route");
  const result = await pending;
  assert.equal(result.status, "computed");
  assert.deepEqual(result.value, { n: 2 });
  assert.equal(cache.stats().hit, 0);
});

test("hit path bypasses when the source becomes dirty without invalidation", async () => {
  const { cache, state } = harness();
  const source = makeSource();
  await call(cache, source, { k1: "x" }, () => ({ n: 1 }));
  state.value = makeFresh({ freshness: "dirty" });
  const result = await call(cache, source, { k1: "x" }, () => ({ n: 2 }));
  assert.equal(result.status, "bypass");
  assert.equal(result.reason, "dirty");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "value"), false);
});

test("dirty and cold bypasses carry no value", async () => {
  const { cache, state } = harness();
  const source = makeSource();
  state.value = makeFresh({ freshness: "dirty" });
  const dirty = await call(cache, source, { k1: "x" }, () => ({ n: 1 }));
  assert.deepEqual(dirty, { status: "bypass", reason: "dirty" });
  state.value = makeFresh({ freshness: "cold" });
  const cold = await call(cache, source, { k1: "x" }, () => ({ n: 1 }));
  assert.deepEqual(cold, { status: "bypass", reason: "cold" });
});

test("partial coverage admission follows the namespace requirement", async () => {
  const namespaces = {
    "test-route": { allowedArgKeys: ["k1"], maxCanonicalBytes: 256 },
    "strict-route": { allowedArgKeys: ["k1"], maxCanonicalBytes: 256, requireComplete: true },
  };
  const { cache, state } = harness({ namespaces });
  state.value = makeFresh({ completeness: "partial", skipped: 3 });
  const source = makeSource({ completeness: "partial", skipped: 3 });
  const loose = await call(cache, source, { k1: "a" }, () => ({ ok: true }));
  assert.equal(loose.status, "computed");
  const strict = await call(cache, source, { k1: "a" }, () => ({ ok: true }), "strict-route");
  assert.equal(strict.status, "bypass");
  assert.equal(strict.reason, "coverage-requirement");
});

test("coverage skipped digest mismatch bypasses", async () => {
  const { cache, state } = harness();
  const source = makeSource({ completeness: "partial", skipped: 3 });
  state.value = makeFresh({ completeness: "partial", skipped: 4 });
  const result = await call(cache, source, { k1: "a" }, () => ({ ok: true }));
  assert.equal(result.status, "bypass");
  assert.equal(result.reason, "coverage-mismatch");
});

test("ABA includeHidden with publication change never hits the first true entry", async () => {
  const { cache, state } = harness();
  const step = (includeHidden, publicationRevision, tag) => {
    state.value = makeFresh({ includeHidden, publicationRevision, snapshotGeneration: 7 });
    return call(cache, makeSource({ includeHidden, publicationRevision, snapshotGeneration: 7 }), { k1: "same" }, () => ({ tag }));
  };
  const r1 = await step(true, 10, "rev10");
  const r2 = await step(false, 11, "rev11");
  const r3 = await step(true, 12, "rev12");
  assert.equal(r1.status, "computed");
  assert.equal(r2.status, "computed");
  assert.equal(r3.status, "computed");
  assert.deepEqual(r3.value, { tag: "rev12" });
  assert.equal(cache.stats().hit, 0);
  assert.equal(cache.stats().computed, 3);
});

test("publicationRevision change with the same generation misses", async () => {
  const { cache, state } = harness();
  state.value = makeFresh({ publicationRevision: 1, snapshotGeneration: 5 });
  const r1 = await call(cache, makeSource({ publicationRevision: 1, snapshotGeneration: 5 }), { k1: "a" }, () => ({ tag: 1 }));
  state.value = makeFresh({ publicationRevision: 2, snapshotGeneration: 5 });
  const r2 = await call(cache, makeSource({ publicationRevision: 2, snapshotGeneration: 5 }), { k1: "a" }, () => ({ tag: 2 }));
  assert.equal(r1.status, "computed");
  assert.equal(r2.status, "computed");
  assert.equal(cache.stats().hit, 0);
});

test("computed and hit results are independent clones", async () => {
  const { cache } = harness();
  const source = makeSource();
  const make = () => ({ list: [1, 2], nested: { ok: true } });
  const first = await call(cache, source, { k1: "a" }, make);
  first.value.list.push(99);
  first.value.nested.ok = false;
  const hit = await call(cache, source, { k1: "a" }, make);
  assert.equal(hit.status, "hit");
  assert.deepEqual(hit.value, { list: [1, 2], nested: { ok: true } });
  hit.value.list.push(42);
  const again = await call(cache, source, { k1: "a" }, make);
  assert.deepEqual(again.value, { list: [1, 2], nested: { ok: true } });
});

test("own __proto__ and constructor keys round-trip without prototype pollution", async () => {
  const { cache } = harness();
  const source = makeSource();
  const raw = JSON.parse('{"__proto__":{"deep":1},"constructor":{"kind":"c"},"ok":2,"nested":{"__proto__":{"n":3},"constructor":"shadow"}}');
  assert.equal(Object.hasOwn(raw, "__proto__"), true);
  assert.equal(Object.hasOwn(raw, "constructor"), true);
  assert.equal(Object.getPrototypeOf(raw), Object.prototype);

  const first = await call(cache, source, { k1: "proto" }, () => raw);
  assert.equal(first.status, "computed");
  assert.equal(Object.getPrototypeOf(first.value), Object.prototype);
  assert.equal(Object.hasOwn(first.value, "__proto__"), true);
  assert.deepEqual(first.value, raw);

  // The cache was not poisoned: a later hit neither throws nor leaks the copy.
  const hit = await call(cache, source, { k1: "proto" }, () => ({ replaced: true }));
  assert.equal(hit.status, "hit");
  assert.equal(Object.getPrototypeOf(hit.value), Object.prototype);
  assert.deepEqual(hit.value, raw);

  // Mutating the returned clone, including an own __proto__ branch, is isolated.
  hit.value.nested.__proto__.n = 99;
  hit.value.__proto__.deep = 99;
  const isolated = await call(cache, source, { k1: "proto" }, () => ({ replaced: true }));
  assert.equal(isolated.status, "hit");
  assert.equal(isolated.value.nested.__proto__.n, 3);
  assert.equal(isolated.value.__proto__.deep, 1);
  assert.deepEqual(isolated.value, raw);

  // A genuinely unsupported own __proto__ value still rejects without an entry.
  const poisoned = {};
  Object.defineProperty(poisoned, "__proto__", { value: () => 1, enumerable: true, writable: true, configurable: true });
  const before = cache.stats().currentEntries;
  await assert.rejects(() => call(cache, source, { k1: "proto-fn" }, () => poisoned), (error) => error.code === "HOT_ROUTE_CACHE_VALUE");
  assert.equal(cache.stats().currentEntries, before);
});

test("null and undefined are returned but never retained (no negative cache)", async () => {
  const { cache } = harness();
  const source = makeSource();
  const nil = await call(cache, source, { k1: "nil" }, () => null);
  assert.equal(nil.status, "computed");
  assert.equal(nil.value, null);
  assert.equal(cache.stats().currentEntries, 0);
  const replacement = await call(cache, source, { k1: "nil" }, () => ({ fallback: true }));
  assert.equal(replacement.status, "computed");
  assert.equal(cache.stats().hit, 0);
  const undef = await call(cache, source, { k1: "undef" }, () => undefined);
  assert.equal(undef.status, "computed");
  assert.equal(undef.value, undefined);
  assert.equal(cache.stats().currentEntries, 1);
});

test("unsupported computed values reject and never cache", async () => {
  const { cache } = harness();
  const source = makeSource();
  await assert.rejects(() => call(cache, source, { k1: "fn" }, () => () => 1), (error) => error.code === "HOT_ROUTE_CACHE_VALUE");
  await assert.rejects(() => call(cache, source, { k1: "map" }, () => new Map()), (error) => error.code === "HOT_ROUTE_CACHE_VALUE");
  await assert.rejects(() => call(cache, source, { k1: "big" }, () => 10n), (error) => error.code === "HOT_ROUTE_CACHE_VALUE");
  assert.equal(cache.stats().currentEntries, 0);
  assert.equal(cache.stats().reject, 3);
});

test("malformed or throwing readFreshness fails closed without an old value", async () => {
  const { cache, state } = harness();
  const source = makeSource();
  await call(cache, source, { k1: "a" }, () => ({ cached: true }));
  state.mode = "throw";
  const thrown = await call(cache, source, { k1: "a" }, () => ({ cached: false }));
  assert.equal(thrown.status, "bypass");
  assert.equal(thrown.reason, "freshness-error");
  assert.equal(Object.prototype.hasOwnProperty.call(thrown, "value"), false);
  state.mode = "malformed";
  const malformed = await call(cache, source, { k1: "a" }, () => ({ cached: false }));
  assert.equal(malformed.status, "bypass");
  assert.equal(malformed.reason, "freshness-error");
  state.mode = "ok";
  state.value = { freshness: "clean", vaultGeneration: "x", publicationRevision: 0, includeHidden: false, coverage: { completeness: "complete", skipped: 0 } };
  const badShape = await call(cache, source, { k1: "a" }, () => ({ cached: false }));
  assert.equal(badShape.status, "bypass");
  assert.equal(badShape.reason, "freshness-error");
});

test("secret-shaped argument keys are structurally denied at construction and call time", () => {
  assert.throws(
    () => createHotRouteCache({ namespaces: { "test-route": { allowedArgKeys: ["token"], maxCanonicalBytes: 64 } }, ttlMs: 1, maxEntries: 1, readFreshness: () => makeFresh() }),
    (error) => error.code === "HOT_ROUTE_CACHE_CONFIG",
  );
  assert.throws(
    () => createHotRouteCache({ namespaces: { "test-route": { allowedArgKeys: ["raw-query"], maxCanonicalBytes: 64 } }, ttlMs: 1, maxEntries: 1, readFreshness: () => makeFresh() }),
    (error) => error.code === "HOT_ROUTE_CACHE_CONFIG",
  );
});

test("constructor rejects missing or invalid explicit limits", () => {
  const base = { namespaces: NAMESPACES, readFreshness: () => makeFresh() };
  assert.throws(() => createHotRouteCache({ ...base, maxEntries: 1 }), (error) => error.code === "HOT_ROUTE_CACHE_CONFIG");
  assert.throws(() => createHotRouteCache({ ...base, ttlMs: 1 }), (error) => error.code === "HOT_ROUTE_CACHE_CONFIG");
  assert.throws(() => createHotRouteCache({ ...base, ttlMs: -1, maxEntries: 1 }), (error) => error.code === "HOT_ROUTE_CACHE_CONFIG");
  assert.throws(() => createHotRouteCache({ ...base, ttlMs: 1, maxEntries: 0 }), (error) => error.code === "HOT_ROUTE_CACHE_CONFIG");
  assert.throws(() => createHotRouteCache({ ...base, ttlMs: 1, maxEntries: 1, maxApproxBytes: 0 }), (error) => error.code === "HOT_ROUTE_CACHE_CONFIG");
  assert.throws(() => createHotRouteCache({ ...base, ttlMs: 1, maxEntries: 1, now: "clock" }), (error) => error.code === "HOT_ROUTE_CACHE_CONFIG");
  assert.throws(
    () => createHotRouteCache({ namespaces: { "test-route": { allowedArgKeys: ["k1"] } }, ttlMs: 1, maxEntries: 1, readFreshness: () => makeFresh() }),
    (error) => error.code === "HOT_ROUTE_CACHE_CONFIG",
  );
});

test("unknown namespace and malformed sourceStats reject", async () => {
  const { cache } = harness();
  await assert.rejects(
    () => cache.getOrCompute({ namespace: "nope", canonicalArgs: {}, sourceStats: makeSource(), compute: () => 1 }),
    (error) => error.code === "HOT_ROUTE_CACHE_NAMESPACE",
  );
  await assert.rejects(
    () => call(cache, { publicationRevision: 0 }, { k1: "a" }, () => 1),
    (error) => error.code === "HOT_ROUTE_CACHE_SOURCE",
  );
  assert.throws(() => cache.invalidate("nope"), (error) => error.code === "HOT_ROUTE_CACHE_NAMESPACE");
});

test("stats stay anonymous and never contain argument or path payloads", async () => {
  const { cache } = harness();
  const source = makeSource();
  const secretish = "do-not-log-this-argument-value";
  await call(cache, source, { k1: secretish }, () => ({ ok: true }));
  const serialized = JSON.stringify(cache.stats());
  assert.equal(serialized.includes(secretish), false);
  assert.deepEqual(Object.keys(cache.stats()).sort(), [
    "approxBytes",
    "bypass",
    "bypassByReason",
    "coalesced",
    "computed",
    "currentEntries",
    "evicted",
    "expired",
    "hit",
    "inflight",
    "miss",
    "oversize",
    "reject",
  ]);
});
