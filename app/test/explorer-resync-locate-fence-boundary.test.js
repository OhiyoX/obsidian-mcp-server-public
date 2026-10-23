// Issue #423 boundary regressions: the head-page fence must FAIL CLOSED at its 8-round bound, and a
// sort change during the wait must still cancel the walk.
//
// The review seat of `fix/web-explorer-resync-locate-race` (head 8660bfe0) reproduced two boundary
// counterexamples in `settleHead()`:
//
//   1. After the 8 bounded rounds the fence returned `true` whenever the epoch matched, without
//      re-checking whether a head page was STILL in flight. Nine consecutive real
//      `invalidateEverything()` rebuilds therefore let a `locate()` walk through past round 8; its
//      anchor page retired the 9th rebuild's head, every rebuild returned `null`, and the root level
//      was left as `["A.md"]` -- the lost-folder symptom of #423 itself.
//   2. `settleHead()` returned `true` on `if (!token)` BEFORE checking the epoch, and `locate()`'s
//      per-level epoch gate had been dropped. An `adoptSort(desc)` during the wait therefore let the
//      superseded walk issue one desc anchor page and write the root level.
//
// Both probes use an api that rejects on abort, so every retirement (abortAll / beginRequest) settles
// the awaited page promise deterministically instead of riding a timer.
import assert from "node:assert/strict";
import test from "node:test";
import { createLazyTreeController } from "../frontend/app/features/explorer/lazy-controller.js";

const page = (parent, items, nextCursor = null, generation = 1) => ({
  parent,
  items,
  nextCursor,
  catalog: { generation, stale: false },
});
const folder = (path) => ({ path, kind: "folder" });
const note = (path) => ({ path, kind: "note" });
const paramsOf = (url) => new URL(url, "http://localhost").searchParams;
const paths = (controller) => controller.model.childrenByParent.get("")?.map((item) => item.path) ?? null;
const anchored = (calls) => calls.filter((url) => paramsOf(url).has("anchorPath"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const ROOT_HEAD = [folder("Folder"), note("A.md")];

// Every un-anchored page (the level's COMPLETE HEAD) is deferred and rejects on abort, so a test
// aborts one rebuild's head simply by starting the next rebuild. `heads[n]` is the (n+1)-th head.
function headController() {
  const calls = [];
  const heads = [];
  const controller = createLazyTreeController({
    retryDelays: [],
    api: (url, { signal } = {}) => {
      calls.push(url);
      const params = paramsOf(url);
      if (params.has("anchorPath")) {
        return Promise.resolve(page(params.get("parent") ?? "", [note("A.md")]));
      }
      const entry = { aborted: false };
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      signal?.addEventListener("abort", () => {
        entry.aborted = true;
        entry.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
      heads.push(entry);
      return entry.promise;
    },
  });
  return { controller, calls, heads };
}

test("#423 boundary: the head fence fails closed when the 8 rounds run out with a head still in flight", async () => {
  const { controller, calls, heads } = headController();
  const firstPaint = controller.loadRoot();
  heads[0].resolve(page("", ROOT_HEAD));
  await firstPaint;
  assert.deepEqual(paths(controller), ["Folder", "A.md"], "the first paint carries the root head");

  // A `vault.resync` rebuild clears the level and starts its complete head page; the document open's
  // walk waits on it. Every following rebuild retires the head the walk awaits and issues the next
  // one: nine rebuilds in a row, which is exactly the storm the bound exists for.
  const rebuilds = [controller.invalidateEverything()];
  const walk = controller.locate("A.md");
  for (let round = 0; round < 8; round += 1) {
    rebuilds.push(controller.invalidateEverything());
    await tick();
  }
  // `heads[0]` is the first paint, `heads[1..9]` the nine rebuilds.
  assert.equal(heads.length, 10, "nine rebuild head pages were issued");

  // The fence is exhausted while the 9th rebuild's head is still in flight: fail closed. The walk
  // must issue no anchor page, and that rebuild must still be able to write its own head page.
  heads[9].resolve(page("", ROOT_HEAD));
  const settled = await Promise.all(rebuilds);
  await walk;

  assert.deepEqual(paths(controller), ["Folder", "A.md"], "the final rebuild's head page is the final state");
  assert.equal(anchored(calls).length, 0, "an exhausted walk issues no anchor page");
  assert.equal(heads[9].aborted, false, "the 9th rebuild's head page was not retired by the walk");
  assert.equal(settled.filter((value) => value !== null).length, 1, "only the last rebuild re-materializes the root");
});

test("#423 boundary: a sort change while waiting cancels the walk instead of anchoring under the new spec", async () => {
  const { controller, calls, heads } = headController();
  const firstPaint = controller.loadRoot();
  heads[0].resolve(page("", ROOT_HEAD));
  await firstPaint;
  const epochBefore = controller.currentEpoch();

  const rebuild = controller.invalidateEverything();
  const walk = controller.locate("A.md");
  // Query mode adopts the new spec while the walk still waits on the rebuild's head page:
  // `abortAll()` retires that head and bumps the epoch, so the superseded walk must stop here.
  controller.adoptSort({ key: "name", direction: "desc" });
  heads[1].resolve(page("", ROOT_HEAD));
  await Promise.all([rebuild, walk]);

  assert.equal(anchored(calls).length, 0, "the superseded walk issues no anchor page under the new spec");
  assert.equal(paths(controller), null, "and it writes no level under the new spec");
  assert.notEqual(controller.currentEpoch(), epochBefore, "the sort change bumped the epoch");
  assert.equal(heads[1].aborted, true, "the sort change retired the in-flight head page");
});
