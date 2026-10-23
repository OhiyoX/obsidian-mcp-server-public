// Lazy Tree sorting adaptation: entered-barrier negative tests for the SortSpec
// request-identity fence. Every case parks an old request at a deterministic barrier
// (an unresolved promise) and only then switches the sort, so the assertion is about
// ownership, not about timing. No sleep-only race proof.
import assert from "node:assert/strict";
import test from "node:test";
import { createLazyTreeController } from "../frontend/app/features/explorer/lazy-controller.js";
import { createLazyExplorerState, endLoad, beginLoad, itemsFor, isLoading } from "../frontend/app/features/explorer/lazy-model.js";

const page = (parent, items, nextCursor = null, generation = 1) => ({
  parent,
  items,
  nextCursor,
  catalog: { generation, stale: false },
});

const notReady = () => Object.assign(new Error("not ready"), { status: 503, data: { error: "catalog-not-ready" } });

function barrierApi() {
  const resolvers = [];
  const api = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      resolvers.push({ url, resolve });
    });
  return { api, resolvers };
}

test("model: a retired owner's late endLoad cannot clear a newer loading owner", () => {
  const state = createLazyExplorerState();
  const oldOwner = beginLoad(state, "P");
  const newOwner = beginLoad(state, "P");
  assert.equal(isLoading(state, "P", newOwner), true);
  assert.equal(endLoad(state, "P", oldOwner), false, "stale owner is rejected");
  assert.equal(isLoading(state, "P", newOwner), true, "new owner still loading");
  assert.equal(endLoad(state, "P", newOwner), true);
  assert.equal(isLoading(state, "P"), false);
});

test("root page captured for the old sort cannot write after the sort switch", async () => {
  const { api, resolvers } = barrierApi();
  const controller = createLazyTreeController({ api, initialSort: { key: "name", direction: "asc" } });
  const oldLoad = controller.loadRoot();
  const switched = controller.setSort({ key: "modified", direction: "desc" });
  // The new root is now the second barrier.
  assert.equal(resolvers.length, 2, "sort switch retired the old request and started a new one");
  resolvers[0].resolve(page("", [{ path: "OLD.md" }], null, 1));
  await oldLoad;
  resolvers[1].resolve(page("", [{ path: "NEW.md" }], null, 1));
  await switched;
  assert.deepEqual(itemsFor(controller.model, "").map((item) => item.path), ["NEW.md"]);
});

test("loadMore refuses an old cursor and never walks it under the new sort", async () => {
  const seen = [];
  const api = async (url) => {
    seen.push(url);
    const sort = new URL(url, "http://x").searchParams.get("sort");
    return page("", [{ path: `${sort}.md` }], `${sort}-cursor`, 1);
  };
  const controller = createLazyTreeController({ api, initialSort: { key: "name", direction: "asc" } });
  await controller.loadRoot();
  const switched = controller.setSort({ key: "modified", direction: "desc" });
  // A stale loadMore fired while the new sort is materializing must be refused.
  const stale = await controller.loadMore("");
  assert.equal(stale, null);
  await switched;
  assert.ok(
    !seen.some((url) => url.includes("cursor=name-cursor") && url.includes("sort=modified")),
    "the name cursor must never be sent with the modified sort",
  );
  // The new-spec cursor is usable.
  await controller.loadMore("");
  assert.ok(seen.some((url) => url.includes("cursor=modified-cursor") && url.includes("sort=modified")));
});

test("a late finally from a superseded same-parent request cannot clear the new loading", async () => {
  const { api, resolvers } = barrierApi();
  const controller = createLazyTreeController({ api });
  const first = controller.ensureLoaded("P");
  const second = controller.ensureLoaded("P"); // aborts first, owns loading now
  assert.equal(resolvers.length, 2);
  resolvers[0].resolve(page("P", [{ path: "P/old.md" }], null, 1)); // late first response
  await first;
  assert.equal(controller.model.loadingParents.has("P"), true, "late first must not clear the second");
  assert.equal(itemsFor(controller.model, "P"), null, "late first must not write");
  resolvers[1].resolve(page("P", [{ path: "P/new.md" }], null, 1));
  await second;
  assert.deepEqual(itemsFor(controller.model, "P").map((item) => item.path), ["P/new.md"]);
});

test("a late locate/anchor response after a sort switch must not continue the walk", async () => {
  const { api, resolvers } = barrierApi();
  const controller = createLazyTreeController({ api, initialSort: { key: "name", direction: "asc" } });
  const locating = controller.locate("a.md");
  assert.equal(resolvers.length, 1, "only the first anchor is requested so far");
  const switched = controller.setSort({ key: "modified", direction: "desc" });
  resolvers[0].resolve(page("", [{ path: "a.md" }], null, 1)); // late old-sort anchor
  await locating;
  const anchors = resolvers.map((entry) => entry.url).filter((url) => url.includes("anchorPath="));
  assert.equal(anchors.length, 1, "the retired locate must not issue a deeper anchor");
  assert.ok(anchors.every((url) => url.includes("sort=name")), "only the old-spec anchor was issued");
  // Settle the new-sort materialization.
  const rootResolver = resolvers.find((entry) => !entry.url.includes("anchorPath="));
  rootResolver?.resolve(page("", [{ path: "a.md" }], null, 1));
  await switched;
});

test("a 503 readiness retry chain stops when the owner is retired by a sort switch", async () => {
  const seen = [];
  const api = async (url) => {
    seen.push(url);
    throw notReady();
  };
  const controller = createLazyTreeController({ api, initialSort: { key: "name", direction: "asc" }, retryDelays: [5, 5, 5, 5] });
  const oldLoad = controller.loadRoot();
  // Retire synchronously, before the first backoff timer can fire.
  const switched = controller.setSort({ key: "modified", direction: "desc" });
  await oldLoad;
  await switched;
  const nameCalls = seen.filter((url) => url.includes("sort=name"));
  assert.equal(nameCalls.length, 1, "the old-spec retry chain must not keep retrying after the switch");
});

test("SSE invalidateParent while a parent is inflight retires ownership so the late page cannot write back", async () => {
  const { api, resolvers } = barrierApi();
  const controller = createLazyTreeController({ api });
  const loading = controller.ensureLoaded("P");
  await controller.invalidate("P/x.md");
  resolvers[0].resolve(page("P", [{ path: "P/old.md" }], null, 1));
  await loading;
  assert.equal(controller.model.childrenByParent.has("P"), false, "late invalidated page must not be applied");
  assert.equal(controller.model.loadingParents.has("P"), false, "no loading residue");
});

test("a sort switch retires every page/cursor but keeps expanded and currentPath", async () => {
  const api = async (url) => page("", [{ path: "a" }], "c1", 1);
  const controller = createLazyTreeController({ api, initialSort: { key: "name", direction: "asc" } });
  controller.model.expanded.add("a");
  controller.model.currentPath = "a/b.md";
  await controller.loadRoot();
  await controller.setSort({ key: "modified", direction: "desc" });
  assert.equal(controller.model.expanded.has("a"), true);
  assert.equal(controller.model.currentPath, "a/b.md");
  assert.equal(controller.model.loadedSortEpochByParent.get("") === undefined, false, "root re-materialized under the new epoch");
  assert.equal(controller.isSortCurrent(""), true);
});

test("a current-owner AbortError releases its owned loading without marking success or error", async () => {
  const states = [];
  const controller = createLazyTreeController({
    api: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
    onChange: () => states.push({
      loading: isLoading(controller.model, ""),
      loaded: controller.model.childrenByParent.has(""),
      error: controller.model.errorByParent.has(""),
    }),
  });
  await controller.loadRoot();
  assert.equal(controller.model.loadingParents.has(""), false, "the aborted load must not stay loading");
  assert.equal(controller.model.loadingOwnerByParent.has(""), false, "the aborted owner must be released");
  assert.equal(controller.model.childrenByParent.has(""), false, "an abort is never success");
  assert.equal(controller.model.errorByParent.has(""), false, "an abort is not a rendered load error");
  assert.ok(states.length >= 2, "the abort cleanup must notify the UI");
  assert.deepEqual(states.at(-1), { loading: false, loaded: false, error: false }, "the final notification is the released state");
});

test("an entered old request's abort cannot clear the new owner's loading (barrier)", async () => {
  const resolvers = [];
  const api = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      resolvers.push({ resolve, reject });
    });
  const controller = createLazyTreeController({ api });
  const first = controller.ensureLoaded("P"); // entered barrier
  const second = controller.ensureLoaded("P"); // retires first, owns loading now
  assert.equal(resolvers.length, 2);
  await first; // the retired request rejects with AbortError and runs its cleanup
  assert.equal(controller.model.loadingParents.has("P"), true, "the retired abort/finally must not clear the new owner");
  assert.equal(controller.model.loadingOwnerByParent.has("P"), true, "the new owner survives");
  assert.equal(itemsFor(controller.model, "P"), null, "the retired request must not write");
  resolvers[1].resolve(page("P", [{ path: "P/new.md" }], null, 1));
  await second;
  assert.deepEqual(itemsFor(controller.model, "P").map((item) => item.path), ["P/new.md"]);
});

test("adoptSort retires old pages without issuing tree network (query-mode zero tree IO)", async () => {
  let calls = 0;
  const api = async () => { calls += 1; return page("", [], null, 1); };
  const controller = createLazyTreeController({ api, initialSort: { key: "name", direction: "asc" } });
  await controller.loadRoot();
  const before = calls;
  controller.adoptSort({ key: "modified", direction: "desc" });
  assert.equal(calls, before, "adoptSort must not fetch");
  assert.equal(controller.isSortCurrent(""), false, "old page retired");
  assert.equal(controller.model.loadingParents.has(""), false);
});
