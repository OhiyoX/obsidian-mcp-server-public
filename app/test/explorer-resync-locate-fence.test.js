// Issue #423 unit regression: an anchor-locate walk must not retire the level's in-flight COMPLETE
// HEAD page.
//
// `tree.locate()` asks for an anchor-inclusive page (`parent=&anchorPath=…`), which is a SUFFIX of
// its level. A `vault.resync`-driven rebuild asks for the level's complete first page at the same
// time. When the suffix request retired the head owner, the level kept only the rows from the anchor
// onwards: every sibling that sorts before the anchor (the whole folder group, at the root level)
// disappeared from the Explorer for the rest of the session. The fence in `locate()` now waits that
// head page out and re-reads the level, so the walk only writes a suffix when the level really
// cannot carry the target.
//
// These tests drive the controller with a deferred first page and an injected api, so the
// interleaving is exact instead of a timing race.
import assert from "node:assert/strict";
import test from "node:test";
import { createLazyTreeController } from "../frontend/app/features/explorer/lazy-controller.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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

// The rebuild's root page is deferred; the first (first-paint) page resolves immediately.
function raceController({ headItems, firstItems }) {
  const calls = [];
  const rebuildHead = deferred();
  let rootRequests = 0;
  const controller = createLazyTreeController({
    retryDelays: [],
    api: async (url) => {
      calls.push(url);
      const params = paramsOf(url);
      if (params.get("parent") !== "") throw new Error(`unexpected parent ${params.get("parent")}`);
      if (params.has("anchorPath")) return page("", firstItems);
      rootRequests += 1;
      return rootRequests === 1 ? page("", headItems) : rebuildHead.promise;
    },
  });
  return { controller, calls, rebuildHead };
}

test("#423: an anchor locate waits for the in-flight head page instead of replacing it with a suffix", async () => {
  const head = [folder("Folder"), note("A.md"), note("B.md")];
  const { controller, calls, rebuildHead } = raceController({ headItems: head, firstItems: [note("A.md"), note("B.md")] });
  await controller.loadRoot();
  assert.deepEqual(paths(controller), ["Folder", "A.md", "B.md"], "the first paint carries the root head");

  // A `vault.resync` rebuild starts; its complete head page is still in flight when the document
  // open's anchor walk reaches the root level.
  const rebuild = controller.invalidateEverything();
  const walk = controller.locate("A.md");
  assert.deepEqual(paths(controller), null, "the rebuild cleared the level before re-reading it");

  rebuildHead.resolve(page("", head));
  await Promise.all([rebuild, walk]);

  assert.deepEqual(paths(controller), ["Folder", "A.md", "B.md"], "the rebuilt head page is the final state");
  assert.equal(anchored(calls).length, 0, "and the walk needed no suffix page at all: the head carries the target");
  assert.equal(controller.model.currentPath, "A.md");
  assert.equal(controller.loadedGenerationFor(""), 1);
});

test("#423: the suffix page still wins when the head page cannot carry the target (locate semantics unchanged)", async () => {
  const head = [folder("Folder"), note("A.md")];
  const { controller, calls, rebuildHead } = raceController({ headItems: head, firstItems: [note("Zed.md")] });
  await controller.loadRoot();

  const rebuild = controller.invalidateEverything();
  const walk = controller.locate("Zed.md");
  assert.equal(anchored(calls).length, 0, "the fence applies before the level is re-read");
  rebuildHead.resolve(page("", head));
  await Promise.all([rebuild, walk]);

  assert.deepEqual(paths(controller), ["Zed.md"], "a level that does not carry the target is still replaced by its anchor page");
  // Two walks ask for the anchor page (this test's walk plus `invalidateEverything`'s own
  // re-anchor of `currentPath`); both describe the same suffix, so the count is >= 1 on purpose.
  assert.ok(anchored(calls).length >= 1, "the level is anchored through an anchor page request");
  assert.equal(controller.model.currentPath, "Zed.md");
});

test("#423: a failed head page does not fence the walk forever", async () => {
  const head = [folder("Folder"), note("A.md")];
  const { controller, calls, rebuildHead } = raceController({ headItems: head, firstItems: [note("A.md"), note("B.md")] });
  await controller.loadRoot();

  const rebuild = controller.invalidateEverything();
  const walk = controller.locate("A.md");
  assert.equal(anchored(calls).length, 0, "the fence waits for the in-flight head page first");
  rebuildHead.reject(Object.assign(new Error("boom"), { status: 500 }));
  await Promise.all([rebuild, walk]);

  assert.equal(anchored(calls).length, 1, "once the head page has failed the walk falls through to its anchor page");
  assert.deepEqual(paths(controller), ["A.md", "B.md"], "and the suffix page is applied as before");
});
