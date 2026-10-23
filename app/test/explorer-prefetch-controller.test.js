// Issue #284 Wave A2: Explorer hover-prefetch controller CONTRACT tests (old red).
//
// Written against the frozen target API of the issue contract — `prefetch(parent)`,
// `cancelPrefetch(parent)`, `prefetchStats()` — never against "that API is missing":
// every case asserts an observable behaviour that a wrong implementation (hover wired
// to ensureLoaded, abort+re-issue promotion, unbounded budget, speculative error rows,
// unbounded speculative cache) still fails after the API exists.
//
// Invariant map (issue contract §5/§11): I01 single cache, I02 silent before committed
// intent, I03 shared consistency fences, I04 owner-safe cancel, I05 bounded concurrency,
// I06 first page only, I07 failure invisible, I08 promotion/consume, I10 eligibility,
// I11 intent-bounded speculative cache lifetime.
import assert from "node:assert/strict";
import test from "node:test";
import { createLazyTreeController } from "../frontend/app/features/explorer/lazy-controller.js";

// Yields the queues once, without any timing assumption: a correctness gate must not
// depend on how fast the machine is.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const page = (parent, items, nextCursor = null, generation = 1) => ({
  parent,
  items,
  nextCursor,
  catalog: { generation, stale: false },
});

const parentOfUrl = (url) => url.match(/parent=([^&]*)/)?.[1] ?? "";

const requestsFor = (calls, parent) => calls.filter((call) => parentOfUrl(call.url) === parent);

function createFakeApi(handler) {
  const calls = [];
  const api = async (url, options = {}) => {
    calls.push({ url, signal: options.signal });
    return handler(url, options);
  };
  return { api, calls };
}

// A controllable api: nothing settles until the test settles it, so "in flight" is
// deterministic. `abortRejects: false` models a transport that tolerates an abort and
// still delivers the body — the only way to prove the sort/invalidate fences rather
// than the abort itself.
function createDeferredApi({ abortRejects = true } = {}) {
  const calls = [];
  const api = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const entry = { url, signal: options?.signal, resolve, reject, aborted: false, done: false };
      calls.push(entry);
      options?.signal?.addEventListener("abort", () => {
        entry.aborted = true;
        entry.done = true;
        if (abortRejects) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  return { api, calls };
}

function settleRequest(deferred, parent, items, nextCursor = null, generation = 1) {
  const entry = deferred.calls.find((call) => !call.done && parentOfUrl(call.url) === parent);
  assert.ok(entry, `a pending request for ${JSON.stringify(parent)} exists`);
  entry.done = true;
  entry.resolve(page(parent, items, nextCursor, generation));
  return entry;
}

// --- I01/I02: silent success ------------------------------------------------

test("prefetch loads a collapsed parent silently without expanding it", async () => {
  const { api, calls } = createFakeApi(() => page("Notes", [{ path: "Notes/A.md" }]));
  const changes = [];
  const controller = createLazyTreeController({ api, onChange: () => changes.push(1) });
  const before = changes.length;

  await controller.prefetch("Notes");
  await flush();

  assert.equal(calls.length, 1, "one speculative page request");
  assert.deepEqual(
    controller.model.childrenByParent.get("Notes").map((item) => item.path),
    ["Notes/A.md"],
    "the page enters the one existing children cache (I01)",
  );
  assert.equal(controller.model.expanded.has("Notes"), false, "hover must not expand (I02)");
  assert.equal(controller.model.loadingParents.has("Notes"), false, "no visible loading row (I02)");
  assert.equal(controller.model.errorByParent.size, 0, "no error row (I02)");
  assert.equal(controller.model.currentPath, null, "no focus move (I02)");
  assert.equal(changes.length, before, "a silent prefetch must not notify the renderer (I02)");
  assert.equal(controller.prefetchStats().issued, 1);
  assert.equal(controller.prefetchStats().hit, 0, "nothing was consumed yet");
});

test("a failed prefetch stays invisible and the later toggle still shows the error", async () => {
  let failing = true;
  const { api, calls } = createFakeApi(() => {
    if (failing) throw Object.assign(new Error("boom"), { status: 500 });
    return page("Notes", [{ path: "Notes/A.md" }]);
  });
  const controller = createLazyTreeController({ api, retryDelays: [] });

  await controller.prefetch("Notes");
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(controller.model.errorByParent.has("Notes"), false, "speculative failure writes no error (I07)");
  assert.equal(controller.model.childrenByParent.has("Notes"), false);
  assert.equal(controller.model.loadingParents.has("Notes"), false);
  assert.equal(controller.prefetchStats().failed, 1, "the failure is only counted (I07)");
  assert.equal(controller.prefetchStats().issued, 1);

  failing = false;
  await controller.toggle("Notes");
  await flush();
  assert.equal(controller.model.expanded.has("Notes"), true, "the formal click still expands");
  assert.equal(requestsFor(calls, "Notes").length, 2, "the formal load is a fresh request, not the dead speculative one");
  assert.deepEqual(controller.model.childrenByParent.get("Notes").map((item) => item.path), ["Notes/A.md"]);
});

test("a failed prefetch leaves the formal error/retry experience intact", async () => {
  // The speculative failure must not pre-consume the formal error semantics: the
  // user's own click is the first thing allowed to write a visible error row.
  const { api } = createFakeApi(() => {
    throw Object.assign(new Error("boom"), { status: 500 });
  });
  const controller = createLazyTreeController({ api, retryDelays: [] });

  await controller.prefetch("Notes");
  await flush();
  assert.equal(controller.model.errorByParent.has("Notes"), false);

  await controller.toggle("Notes");
  await flush();
  assert.equal(controller.model.errorByParent.has("Notes"), true, "the formal toggle keeps the visible retry row");
});

// --- I10: eligibility -------------------------------------------------------

test("prefetching an already loaded parent issues no request", async () => {
  const { api, calls } = createFakeApi(() => page("a", [{ path: "a/x.md" }]));
  const controller = createLazyTreeController({ api });

  await controller.toggle("a"); // load formally
  await controller.toggle("a"); // collapse again: loaded + collapsed
  const before = calls.length;
  await controller.prefetch("a");
  await flush();

  assert.equal(calls.length, before, "a current-spec page is never re-fetched speculatively (I10)");
  assert.equal(controller.prefetchStats().issued, 0);
});

test("a repeated prefetch for the same parent reuses the in-flight owner", async () => {
  const deferred = createDeferredApi();
  const controller = createLazyTreeController({ api: deferred.api });

  const first = controller.prefetch("a");
  await flush();
  const second = controller.prefetch("a");
  await flush();

  assert.equal(requestsFor(deferred.calls, "a").length, 1, "no duplicate speculative request (I10)");
  settleRequest(deferred, "a", [{ path: "a/x.md" }]);
  await Promise.all([first, second]);
  await flush();

  assert.deepEqual(controller.model.childrenByParent.get("a").map((item) => item.path), ["a/x.md"]);
  assert.equal(controller.prefetchStats().issued, 1, "the reuse is not a second issue");
});

// --- I04/I08: ownership -----------------------------------------------------

test("cancelPrefetch aborts only the speculative owner", async () => {
  const deferred = createDeferredApi();
  const controller = createLazyTreeController({ api: deferred.api });

  controller.prefetch("a");
  await flush();
  assert.equal(deferred.calls.length, 1);

  controller.cancelPrefetch("a");
  await flush();
  assert.equal(deferred.calls[0].aborted, true, "the speculative request is aborted (I04)");
  assert.equal(controller.model.childrenByParent.has("a"), false, "no page from an aborted prefetch");
  assert.equal(controller.model.loadingParents.has("a"), false);
  assert.equal(controller.model.errorByParent.has("a"), false, "a cancel is not an error row");
  assert.equal(controller.prefetchStats().cancelled, 1);

  // The formal path is untouched by a speculative cancel: it issues its own request
  // and that request survives.
  const loading = controller.toggle("a");
  await flush();
  assert.equal(requestsFor(deferred.calls, "a").length, 2, "the formal toggle issues its own request");
  assert.equal(requestsFor(deferred.calls, "a")[1].aborted, false);
  settleRequest(deferred, "a", [{ path: "a/x.md" }]);
  await loading;
  assert.deepEqual(controller.model.childrenByParent.get("a").map((item) => item.path), ["a/x.md"]);
});

test("a late cancelPrefetch never aborts a promoted formal owner", async () => {
  const deferred = createDeferredApi();
  const controller = createLazyTreeController({ api: deferred.api });

  const flight = controller.prefetch("a");
  const outcome = Promise.resolve(flight).then(() => "resolved", () => "rejected");
  await flush();

  const toggling = controller.toggle("a"); // the click becomes the new owner (promotion)
  await flush();
  assert.equal(requestsFor(deferred.calls, "a").length, 1, "promotion must not issue a second request (I08)");

  // The classic P284-F3 race: pointerleave lands after the click.
  controller.cancelPrefetch("a");
  controller.cancelPrefetch("a");
  await flush();
  assert.equal(deferred.calls[0].aborted, false, "a late cancel must not abort the formal owner (I04/I08)");

  settleRequest(deferred, "a", [{ path: "a/x.md" }]);
  assert.equal(await outcome, "resolved", "the promoted request settles normally, not as an abort");
  await toggling;
  assert.deepEqual(controller.model.childrenByParent.get("a").map((item) => item.path), ["a/x.md"]);
  assert.equal(controller.model.expanded.has("a"), true);
  assert.equal(controller.prefetchStats().promoted, 1);
});

test("ensureLoaded (inline-create +) consumes an in-flight speculative request", async () => {
  const deferred = createDeferredApi();
  const controller = createLazyTreeController({ api: deferred.api });

  controller.prefetch("a");
  await flush();
  const ensuring = controller.ensureLoaded("a");
  await flush();

  assert.equal(requestsFor(deferred.calls, "a").length, 1, "the speculative owner is consumed, not re-issued (I08)");
  assert.equal(deferred.calls[0].aborted, false);
  settleRequest(deferred, "a", [{ path: "a/x.md" }]);
  await ensuring;
  await flush();

  assert.deepEqual(controller.model.childrenByParent.get("a").map((item) => item.path), ["a/x.md"]);
  assert.equal(controller.prefetchStats().issued, 1);
  assert.equal(controller.prefetchStats().promoted, 1, "counted once, for one settlement (I08)");
});

test("promoting a speculative request frees its concurrency slot immediately", async () => {
  const deferred = createDeferredApi();
  const controller = createLazyTreeController({ api: deferred.api });

  controller.prefetch("a");
  controller.prefetch("b");
  await flush();
  assert.equal(deferred.calls.length, 2, "two speculative requests fill the budget");

  const toggling = controller.toggle("a"); // promote "a" → one speculative slot frees
  await flush();
  controller.prefetch("c");
  await flush();

  assert.equal(requestsFor(deferred.calls, "c").length, 1, "the freed slot accepts a new speculative request (I05)");
  assert.equal(controller.prefetchStats().dropped, 0);
  assert.equal(controller.prefetchStats().promoted, 1);

  settleRequest(deferred, "a", [{ path: "a/x.md" }]);
  await toggling;
  assert.deepEqual(controller.model.childrenByParent.get("a").map((item) => item.path), ["a/x.md"]);
});

// --- §11.4: cache hit -------------------------------------------------------

test("a cache hit expands the parent with zero network and no loading state", async () => {
  const { api, calls } = createFakeApi(() => page("a", [{ path: "a/x.md" }]));
  const controller = createLazyTreeController({ api });

  await controller.prefetch("a");
  await flush();
  const before = calls.length;

  const toggling = controller.toggle("a");
  assert.equal(controller.model.loadingParents.has("a"), false, "no '正在加载…' row for a cache hit (§11.4)");
  assert.equal(controller.model.childrenByParent.has("a"), true, "the children are already available");
  await toggling;
  await flush();

  assert.equal(calls.length, before, "expanding from the speculative cache issues no request (§11.4)");
  assert.equal(controller.model.expanded.has("a"), true);
  assert.equal(controller.model.errorByParent.has("a"), false);
  assert.ok(controller.prefetchStats().hit >= 1, "the consumption is counted as a hit (§6)");
  assert.equal(controller.prefetchStats().issued, 1, "a hit is never re-issued");
});

// --- I05: bounded concurrency ----------------------------------------------

test("a third speculative request is dropped while formal loads are never queued", async () => {
  const deferred = createDeferredApi();
  const controller = createLazyTreeController({ api: deferred.api });

  controller.prefetch("a");
  controller.prefetch("b");
  await flush();
  assert.equal(deferred.calls.length, 2, "the speculative budget is 2 (I05)");

  controller.prefetch("c");
  await flush();
  assert.equal(requestsFor(deferred.calls, "c").length, 0, "over-budget prefetch is dropped, not queued (I05)");
  assert.equal(controller.prefetchStats().dropped, 1);

  const toggling = controller.toggle("c"); // formal intent is never blocked by the budget
  await flush();
  assert.equal(requestsFor(deferred.calls, "c").length, 1, "a formal toggle bypasses the speculative budget (I05)");
  assert.equal(requestsFor(deferred.calls, "c")[0].aborted, false);

  settleRequest(deferred, "a", [{ path: "a/x.md" }]); // "a" settles → one slot frees
  await flush();
  controller.prefetch("d");
  await flush();
  assert.equal(requestsFor(deferred.calls, "d").length, 1, "a settled speculative request frees its slot");

  settleRequest(deferred, "c", [{ path: "c/x.md" }]);
  await toggling;
  assert.deepEqual(controller.model.childrenByParent.get("c").map((item) => item.path), ["c/x.md"]);
});

// --- I03: consistency fences ------------------------------------------------

test("a sort change keeps an old-spec speculative page out of the new cache", async () => {
  const deferred = createDeferredApi({ abortRejects: false });
  const controller = createLazyTreeController({ api: deferred.api });

  controller.prefetch("a");
  await flush();
  const sorting = controller.setSort({ key: "modified", direction: "desc" });
  await flush();
  assert.equal(deferred.calls[0].aborted, true, "the old spec retires the speculative owner (I03)");

  // The stale body still arrives after the fence moved on.
  deferred.calls[0].done = true;
  deferred.calls[0].resolve(page("a", [{ path: "a/x.md" }]));
  settleRequest(deferred, "", [{ path: "root.md" }], null, 2);
  await sorting;
  await flush();

  assert.equal(controller.model.childrenByParent.has("a"), false, "an old-epoch page must never enter the cache (I03)");
  assert.equal(controller.model.expanded.has("a"), false);
  assert.deepEqual(controller.model.childrenByParent.get("").map((item) => item.path), ["root.md"]);
});

test("an invalidate keeps an in-flight speculative page out of the cache", async () => {
  const deferred = createDeferredApi({ abortRejects: false });
  const controller = createLazyTreeController({ api: deferred.api });

  controller.prefetch("a");
  await flush();
  await controller.invalidate("a/x.md");
  await flush();
  assert.equal(deferred.calls[0].aborted, true, "SSE invalidate retires the speculative owner (I03)");

  deferred.calls[0].done = true;
  deferred.calls[0].resolve(page("a", [{ path: "a/x.md" }]));
  await flush();

  assert.equal(controller.model.childrenByParent.has("a"), false, "an invalidated page is not resurrected");
  assert.equal(controller.model.errorByParent.has("a"), false);
  assert.equal(controller.model.loadingParents.has("a"), false);
});

test("dispose aborts the in-flight speculative request", async () => {
  const deferred = createDeferredApi();
  const controller = createLazyTreeController({ api: deferred.api });

  controller.prefetch("a");
  await flush();
  controller.dispose();
  await flush();

  assert.equal(deferred.calls[0].aborted, true, "dispose is the highest cancel authority (I03)");
  assert.equal(controller.model.childrenByParent.has("a"), false);
  assert.equal(controller.model.loadingParents.size, 0);
});

// --- I06/I11: speculative cache lifetime ------------------------------------

test("an unconsumed speculative page is reclaimed on cancel and never prefetches page 2", async () => {
  const { api, calls } = createFakeApi((url) => page(parentOfUrl(url), [{ path: `${parentOfUrl(url)}/x.md` }], "cursor-1"));
  const controller = createLazyTreeController({ api });

  await controller.prefetch("a");
  await flush();
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].url, /cursor=/, "a prefetch never carries a cursor (I06)");
  assert.equal(controller.model.childrenByParent.has("a"), true);

  controller.cancelPrefetch("a"); // pointerleave: collapsed and never consumed
  await flush();

  assert.equal(controller.model.childrenByParent.has("a"), false, "the pure speculative page is reclaimed (I11)");
  assert.equal(controller.model.nextCursorByParent.has("a"), false);
  assert.equal(controller.model.expanded.has("a"), false);
  assert.equal(controller.prefetchStats().evicted, 1);
});

test("sequential abandoned hovers do not accumulate speculative pages", async () => {
  const { api } = createFakeApi((url) => page(parentOfUrl(url), [{ path: `${parentOfUrl(url)}/x.md` }]));
  const controller = createLazyTreeController({ api });
  await controller.loadRoot();
  await flush();

  for (const parent of ["a", "b", "c", "d", "e"]) {
    await controller.prefetch(parent);
    await flush();
    assert.equal(controller.model.expanded.has(parent), false, "hover still must not expand");
    controller.cancelPrefetch(parent);
    await flush();
  }

  assert.deepEqual([...controller.model.childrenByParent.keys()], [""], "only the root page survives (I11)");
  assert.equal(controller.model.nextCursorByParent.size, 1);
});

test("a formally consumed page is never reclaimed by a later cancel", async () => {
  const { api, calls } = createFakeApi(() => page("a", [{ path: "a/x.md" }]));
  const controller = createLazyTreeController({ api });

  await controller.prefetch("a");
  await flush();
  await controller.toggle("a"); // formal intent consumes the speculative page
  await flush();
  const before = calls.length;

  controller.cancelPrefetch("a");
  await flush();

  assert.deepEqual(
    controller.model.childrenByParent.get("a").map((item) => item.path),
    ["a/x.md"],
    "a committed page is ordinary formal cache (I11)",
  );
  assert.equal(controller.model.expanded.has("a"), true);
  assert.equal(calls.length, before, "a late cancel issues no cleanup request");
  assert.equal(controller.prefetchStats().evicted, 0);
});

// --- §6: stats --------------------------------------------------------------

test("prefetchStats reports issued/hit/failed for the success and failure paths", async () => {
  let failing = false;
  const { api, calls } = createFakeApi((url) => {
    if (failing) throw Object.assign(new Error("boom"), { status: 500 });
    return page(parentOfUrl(url), [{ path: `${parentOfUrl(url)}/x.md` }]);
  });
  const controller = createLazyTreeController({ api, retryDelays: [] });

  const stats = controller.prefetchStats();
  for (const key of ["issued", "hit", "cancelled", "failed", "dropped", "promoted", "evicted"]) {
    assert.equal(typeof stats[key], "number", `prefetchStats().${key} must be a counter (§6)`);
  }

  await controller.prefetch("a");
  await flush();
  assert.equal(controller.prefetchStats().issued, 1);

  await controller.toggle("a");
  await flush();
  assert.ok(controller.prefetchStats().hit >= 1, "the consumed page is a hit (§6)");
  assert.equal(controller.prefetchStats().issued, 1);

  failing = true;
  await controller.prefetch("b");
  await flush();
  assert.equal(controller.prefetchStats().failed, 1);
  assert.equal(controller.prefetchStats().issued, 2, "the failed attempt was issued");
  assert.equal(calls.length, 2, "prefetch a (consumed by toggle, 0 network per I11/§11.4), prefetch b");
});
