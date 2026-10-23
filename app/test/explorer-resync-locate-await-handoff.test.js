// Issue #423 await-handoff regression: a fence that answers "stable" at ITS own resume point does
// not prove the level is still stable when `locate()` itself resumes.
//
// The review seat of `fix/web-explorer-resync-locate-race` (head 597257af) reproduced this with the
// real controller: start a root head page, let `locate()` wait on it, then register a follow-up
// continuation on that same head task and release the page. Continuations on one settled promise run
// in registration order, so a fence that awaits the page inside a HELPER frame resumes first, returns
// "stable", and only then does the follow-up continuation run — still before `locate()`'s own (outer)
// continuation reads the level. Two outcomes are deterministic:
//
//   1. the follow-up calls `invalidateEverything()`: the level is cleared and a NEW head page is
//      issued; the stale walk then reads an empty level, issues an anchor (suffix) page, and that
//      suffix retires the new head — the root keeps only `["A.md"]`, i.e. the folder group is lost
//      (#423 itself);
//   2. the follow-up calls `adoptSort(desc)`: the sort epoch has already moved, yet the stale walk
//      still issues one `direction=desc` anchor page and writes the root level under the new spec.
//
// The fix re-checks epoch and in-flight head in `locate()`'s OWN continuation, synchronously, right
// before it reads the level or issues the anchor. These tests pin both counterexamples plus the
// no-interleave control, so the three readings are deterministic instead of timing-dependent.
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

const ROOT_HEAD = [folder("Folder"), note("A.md")];

// The first root head page (the first paint) is deferred: the walk waits on it, the test then
// registers the interleaved continuation on that same task, and only then releases it. Every head a
// rebuild issues afterwards answers at once with the same complete root listing, unless
// `deferAllHeads` keeps them deferred too (the re-wait guard resolves the second one by hand). Head
// requests are recorded separately from the page calls so the pair can prove which head pages write
// the level. Every un-anchored page rejects on abort, so a retirement settles the awaited page
// deterministically.
function handoffController({ deferAllHeads = false } = {}) {
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
      const first = heads.length === 0;
      heads.push(entry);
      if (!first && !deferAllHeads) entry.resolve(page("", ROOT_HEAD));
      return entry.promise;
    },
  });
  return { controller, calls, heads };
}

// `action` is the continuation the head task registers for itself:
//   "none"   — no interleave (control);
//   "resync" — `invalidateEverything()`, exactly the `vault.resync` rebuild of #423;
//   "sort"   — `adoptSort(desc)`, a query-mode sort change while the walk waits.
async function handoff(action) {
  const { controller, calls, heads } = handoffController();
  const epochBefore = controller.currentEpoch();
  const root = controller.loadRoot(); // root head page #0, still in flight
  const walk = controller.locate("A.md"); // waits on page #0
  let follow = null;
  if (action !== "none") {
    // Registered AFTER the walk's await on the SAME page promise: this continuation runs between a
    // helper-await's "stable" answer and the walk's own resume.
    follow = root.then(() => (
      action === "resync"
        ? controller.invalidateEverything()
        : controller.adoptSort({ key: "name", direction: "desc" })
    ));
  }
  heads[0].resolve(page("", ROOT_HEAD));
  await walk;
  if (follow) await follow;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { controller, calls, heads, epochBefore };
}

test("#423 await handoff control: with no interleaved continuation the walk keeps the head listing", async () => {
  const { controller, calls } = await handoff("none");
  assert.deepEqual(paths(controller), ["Folder", "A.md"], "the head page is the final state");
  assert.equal(anchored(calls).length, 0, "the head page already carries the target");
});

test("#423 await handoff: a rebuild landing between the fence and the walk's resume keeps the root folder group", async () => {
  const { controller, calls, heads } = await handoff("resync");
  assert.deepEqual(
    paths(controller),
    ["Folder", "A.md"],
    "the rebuilt head page is the final state: the folder group survives",
  );
  assert.equal(anchored(calls).length, 0, "the stale walk issues no suffix page over the rebuilt level");
  assert.equal(heads.length, 2, "the rebuild's own head page was requested and left to write the level");
  assert.equal(heads[1].aborted, false, "the rebuild's head page was not retired by the stale walk");
});

test("#423 await handoff: a head re-issued while the walk waits is re-awaited before the level is read", async () => {
  // The rebuild's continuation is registered on the head page BEFORE the walk starts waiting, so it
  // runs first and replaces the level's head while the walk is suspended. Resuming into a replaced
  // head must re-wait inside the shared budget, not read or anchor the level. This is the detection
  // half of the fix (true at the bound head too); the two tests above are the ordering half.
  const { controller, calls, heads } = handoffController({ deferAllHeads: true });
  const root = controller.loadRoot();
  const rebuild = root.then(() => controller.invalidateEverything());
  const walk = controller.locate("A.md");
  heads[0].resolve(page("", ROOT_HEAD));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(heads.length, 2, "the rebuild issued its own head page while the walk waits");
  heads[1].resolve(page("", ROOT_HEAD));
  await Promise.all([walk, rebuild]);

  assert.deepEqual(paths(controller), ["Folder", "A.md"], "the fresh head page is the final state");
  assert.equal(anchored(calls).length, 0, "the walk re-reads the replaced head instead of anchoring over it");
  assert.equal(heads[1].aborted, false, "the fresh head page was allowed to write the level");
});

test("#423 await handoff: a sort change landing between the fence and the walk's resume issues no anchor", async () => {
  const { controller, calls, epochBefore } = await handoff("sort");
  assert.equal(anchored(calls).length, 0, "the superseded walk issues no anchor page under the new spec");
  assert.notEqual(controller.currentEpoch(), epochBefore, "the sort change bumped the epoch");
  assert.equal(paths(controller), null, "and the stale walk wrote no level under the new spec");
});
