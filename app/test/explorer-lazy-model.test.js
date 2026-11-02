// Phase 2B-0 unit tests: pure lazy Explorer tree state model.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ancestorChain,
  applyTreePage,
  beginLoad,
  createLazyExplorerState,
  endLoad,
  evictParents,
  invalidateAll,
  invalidateParent,
  invalidatePath,
  isLoaded,
  itemsFor,
  loadedGenerationFor,
  nextCursorFor,
  parentOf,
  revealAncestors,
  setExpanded,
  setLoadError,
  treeRenderSignature,
} from "../frontend/app/features/explorer/lazy-model.js";

test("parentOf and ancestorChain derive the folder chain", () => {
  assert.equal(parentOf("Notes/A.md"), "Notes");
  assert.equal(parentOf("A.md"), "");
  assert.equal(parentOf("a/b/c.md"), "a/b");
  assert.deepEqual(ancestorChain("a/b/c.md"), ["a", "a/b"]);
  assert.deepEqual(ancestorChain("A.md"), []);
});

test("applyTreePage replaces a fresh page and appends a same-generation continuation", () => {
  const state = createLazyExplorerState();
  applyTreePage(state, { parent: "", items: [{ path: "A.md" }], nextCursor: "c1", generation: 1 });
  assert.deepEqual(itemsFor(state, "").map((item) => item.path), ["A.md"]);
  assert.equal(nextCursorFor(state, ""), "c1");
  assert.equal(loadedGenerationFor(state, ""), 1);

  applyTreePage(state, { parent: "", items: [{ path: "B.md" }], nextCursor: null, generation: 1, append: true });
  assert.deepEqual(itemsFor(state, "").map((item) => item.path), ["A.md", "B.md"]);
  assert.equal(nextCursorFor(state, ""), null);

  // A fresh (non-append) page replaces.
  applyTreePage(state, { parent: "", items: [{ path: "C.md" }], nextCursor: null, generation: 1 });
  assert.deepEqual(itemsFor(state, "").map((item) => item.path), ["C.md"]);
});

test("a continuation from another generation replaces instead of appending", () => {
  const state = createLazyExplorerState();
  applyTreePage(state, { parent: "Notes", items: [{ path: "Notes/A.md" }], nextCursor: "c1", generation: 1 });
  applyTreePage(state, { parent: "Notes", items: [{ path: "Notes/B.md" }], nextCursor: null, generation: 2, append: true });
  assert.deepEqual(itemsFor(state, "Notes").map((item) => item.path), ["Notes/B.md"]);
});

test("invalidation is per parent (and per path), never global by accident", () => {
  const state = createLazyExplorerState();
  applyTreePage(state, { parent: "", items: [{ path: "A.md" }], nextCursor: null, generation: 1 });
  applyTreePage(state, { parent: "Notes", items: [{ path: "Notes/B.md" }], nextCursor: "c", generation: 1 });

  invalidatePath(state, "Notes/B.md");
  assert.equal(isLoaded(state, "Notes"), false);
  assert.equal(isLoaded(state, ""), true, "the other parent is untouched");

  invalidateParent(state, "");
  assert.equal(isLoaded(state, ""), false);

  applyTreePage(state, { parent: "x", items: [{ path: "x/y.md" }], nextCursor: null, generation: 1 });
  invalidateAll(state);
  assert.equal(state.childrenByParent.size, 0);
  assert.equal(state.nextCursorByParent.size, 0);
  assert.equal(state.loadedGenerationByParent.size, 0);
});

test("loading state is tracked and cleared by the page", () => {
  const state = createLazyExplorerState();
  beginLoad(state, "Notes");
  assert.equal(state.loadingParents.has("Notes"), true);
  applyTreePage(state, { parent: "Notes", items: [], nextCursor: null, generation: 1 });
  assert.equal(state.loadingParents.has("Notes"), false);
});

test("expanded state and revealAncestors expand the folder chain", () => {
  const state = createLazyExplorerState();
  setExpanded(state, "Notes", true);
  assert.equal(state.expanded.has("Notes"), true);
  setExpanded(state, "Notes", false);
  assert.equal(state.expanded.has("Notes"), false);

  revealAncestors(state, "_Workspace/40-Projects/Note.md");
  assert.deepEqual([...state.expanded].sort(), ["_Workspace", "_Workspace/40-Projects"]);
});

test("evictParents releases everything outside the keep set", () => {
  const state = createLazyExplorerState();
  for (const parent of ["", "Notes", "Deep/A"]) {
    applyTreePage(state, { parent, items: [{ path: `${parent}/x.md` }], nextCursor: "c", generation: 1 });
  }
  evictParents(state, ["", "Notes"]);
  assert.equal(isLoaded(state, ""), true);
  assert.equal(isLoaded(state, "Notes"), true);
  assert.equal(isLoaded(state, "Deep/A"), false);
  assert.equal(nextCursorFor(state, "Deep/A"), null);
});

test("endLoad clears only the loading flag, keeping the loaded page", () => {
  const state = createLazyExplorerState();
  applyTreePage(state, { parent: "Notes", items: [{ path: "Notes/A.md" }], nextCursor: "c1", generation: 3 });
  beginLoad(state, "Notes");
  endLoad(state, "Notes");
  assert.equal(state.loadingParents.has("Notes"), false);
  assert.deepEqual(itemsFor(state, "Notes").map((item) => item.path), ["Notes/A.md"]);
  assert.equal(nextCursorFor(state, "Notes"), "c1");
  assert.equal(loadedGenerationFor(state, "Notes"), 3);
});

test("a failed load-more keeps the already-loaded branch cache", () => {
  const state = createLazyExplorerState();
  applyTreePage(state, { parent: "", items: [{ path: "A.md" }], nextCursor: "c1", generation: 1 });
  beginLoad(state, "");
  endLoad(state, ""); // request failed or was aborted
  assert.equal(state.loadingParents.has(""), false);
  assert.deepEqual(itemsFor(state, "").map((item) => item.path), ["A.md"]);
  assert.equal(nextCursorFor(state, ""), "c1");
});

test("eviction clears evicted loading parents but preserves keepSet loading", () => {
  const state = createLazyExplorerState();
  beginLoad(state, "Keep");
  beginLoad(state, "Drop");
  evictParents(state, ["Keep"]);
  assert.equal(state.loadingParents.has("Keep"), true);
  assert.equal(state.loadingParents.has("Drop"), false);
});

test("a loaded parent's background refresh keeps the structural signature (DOM reuse)", () => {
  const state = createLazyExplorerState();
  applyTreePage(state, {
    parent: "Notes",
    items: [{ kind: "note", path: "Notes/A.md", title: "A" }],
    nextCursor: "c1",
    generation: 1,
  });
  setExpanded(state, "Notes", true);
  const base = treeRenderSignature(state);
  beginLoad(state, "Notes");
  assert.equal(treeRenderSignature(state), base, "a loaded parent's loading must not rebuild the DOM");
  endLoad(state, "Notes");
  assert.equal(treeRenderSignature(state), base);
});

test("cursor PRESENCE changes the signature; a value change with the same presence does not", () => {
  const state = createLazyExplorerState();
  applyTreePage(state, {
    parent: "Notes",
    items: [{ kind: "note", path: "Notes/A.md", title: "A" }],
    nextCursor: "c1",
    generation: 1,
  });
  const base = treeRenderSignature(state);
  state.nextCursorByParent.set("Notes", "c2");
  assert.equal(treeRenderSignature(state), base, "the sentinel still exists, so the structure is unchanged");
  state.nextCursorByParent.set("Notes", null);
  assert.notEqual(treeRenderSignature(state), base, "a removed cursor must remove the sentinel");
});

test("an expanded but unloaded parent's loading row changes the signature", () => {
  const state = createLazyExplorerState();
  setExpanded(state, "Notes", true);
  const base = treeRenderSignature(state);
  beginLoad(state, "Notes");
  assert.notEqual(treeRenderSignature(state), base, "the loading row appears");
  applyTreePage(state, {
    parent: "Notes",
    items: [{ kind: "note", path: "Notes/A.md", title: "A" }],
    nextCursor: "c1",
    generation: 1,
  });
  assert.notEqual(treeRenderSignature(state), base, "loaded children replace the loading row");
});

test("a same-shape refresh with unchanged structure keeps the signature (DOM reuse)", () => {
  const state = createLazyExplorerState();
  const items = [{ kind: "note", path: "Notes/A.md", title: "A" }];
  applyTreePage(state, { parent: "Notes", items, nextCursor: "c1", generation: 1 });
  const first = treeRenderSignature(state);
  applyTreePage(state, { parent: "Notes", items, nextCursor: "c1", generation: 2 });
  assert.equal(treeRenderSignature(state), first, "a no-op refresh must keep the signature for DOM reuse");
});

test("root loading and a root failure are render-visible structural states", () => {
  const state = createLazyExplorerState();
  const initial = treeRenderSignature(state);
  beginLoad(state, "");
  const loading = treeRenderSignature(state);
  assert.notEqual(loading, initial, "the root loading state is part of the signature");
  setLoadError(state, "", new Error("boom"));
  const error = treeRenderSignature(state);
  assert.notEqual(error, loading, "a 500/503 root failure must change the signature so the retry row renders");
  assert.notEqual(error, initial, "the failure is distinct from the initial state too");
  // Retry clears the error and returns to the loading state.
  beginLoad(state, "");
  assert.equal(treeRenderSignature(state), loading, "retry leaves the error state for loading");
});

// --- BASE nodes (Wave B / B2) -----------------------------------------------

test("a page preserves the server order and real kind for mixed directory/note/base", () => {
  const state = createLazyExplorerState();
  const items = [
    { kind: "directory", path: "Sub", name: "Sub" },
    { kind: "base", path: "P/a.base", name: "a.base", title: "a" },
    { kind: "note", path: "P/a.md", name: "a.md", title: "a" },
    { kind: "base", path: "P/c.base", name: "c.base", title: "c" },
    { kind: "note", path: "P/d.md", name: "d.md", title: "d" },
  ];
  applyTreePage(state, { parent: "P", items, nextCursor: "c1", generation: 1 });
  const loaded = itemsFor(state, "P");
  assert.deepEqual(loaded.map((item) => item.path), items.map((item) => item.path), "server order is preserved verbatim");
  assert.deepEqual(loaded.map((item) => item.kind), ["directory", "base", "note", "base", "note"]);
  assert.equal(loaded[1], items[1], "records are the same references, never folded or deduped");
});

test("the structural signature distinguishes a note from a base at the same path", () => {
  const state = createLazyExplorerState();
  applyTreePage(state, { parent: "", items: [{ kind: "note", path: "X.md", title: "X" }], nextCursor: null, generation: 1 });
  const asNote = treeRenderSignature(state);
  applyTreePage(state, { parent: "", items: [{ kind: "base", path: "X.md", title: "X" }], nextCursor: null, generation: 1 });
  const asBase = treeRenderSignature(state);
  assert.notEqual(asBase, asNote, "a kind flip must change the signature (no stale DOM reuse)");
});

test("a base continuation across the note/base boundary appends without reordering", () => {
  const state = createLazyExplorerState();
  applyTreePage(state, {
    parent: "",
    items: [{ kind: "base", path: "a.base", title: "a" }, { kind: "note", path: "b.md", title: "b" }],
    nextCursor: "c1",
    generation: 1,
  });
  applyTreePage(state, {
    parent: "",
    items: [{ kind: "note", path: "c.md", title: "c" }, { kind: "base", path: "d.base", title: "d" }],
    nextCursor: null,
    generation: 1,
    append: true,
  });
  assert.deepEqual(itemsFor(state, "").map((item) => item.path), ["a.base", "b.md", "c.md", "d.base"]);
  assert.deepEqual(itemsFor(state, "").map((item) => item.kind), ["base", "note", "note", "base"]);
});

test("an expanded parent's failure is render-visible only until its children load", () => {
  const state = createLazyExplorerState();
  setExpanded(state, "Notes", true);
  const empty = treeRenderSignature(state);
  beginLoad(state, "Notes");
  const loading = treeRenderSignature(state);
  assert.notEqual(loading, empty, "the expanded loading row appears");
  setLoadError(state, "Notes", new Error("boom"));
  const error = treeRenderSignature(state);
  assert.notEqual(error, loading, "a failed expanded parent must render the retry row");
  // Once loaded, a background refresh/error must NOT rebuild its nodes.
  applyTreePage(state, {
    parent: "Notes",
    items: [{ kind: "note", path: "Notes/A.md", title: "A" }],
    nextCursor: "c1",
    generation: 1,
  });
  const loaded = treeRenderSignature(state);
  beginLoad(state, "Notes");
  setLoadError(state, "Notes", new Error("refresh failed"));
  assert.equal(treeRenderSignature(state), loaded, "a loaded parent keeps its structural signature (DOM reuse)");
});
