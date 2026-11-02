import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createExplorerController } from "../frontend/app/features/explorer/controller.js";
import { createLazyExplorerState } from "../frontend/app/features/explorer/lazy-model.js";
import { renderLazyExplorer } from "../frontend/app/features/explorer/tree.js";

const treeSource = await fs.readFile(new URL("../frontend/app/features/explorer/tree.js", import.meta.url), "utf8");
const draftSource = await fs.readFile(new URL("../frontend/app/features/explorer/create-draft.js", import.meta.url), "utf8");
const prefetchHoverSource = await fs.readFile(new URL("../frontend/app/features/explorer/prefetch-hover.js", import.meta.url), "utf8");
const controllerSource = await fs.readFile(new URL("../frontend/app/features/explorer/controller.js", import.meta.url), "utf8");
const wiringSource = await fs.readFile(new URL("../frontend/app/core/explorer-wiring.js", import.meta.url), "utf8");
const appSource = await fs.readFile(new URL("../frontend/app/core/app.js", import.meta.url), "utf8");

test("ordinary explorer renders preserve position and never auto-reveal the active note", () => {
  assert.match(controllerSource, /const scrollTop = host\.scrollTop;/);
  assert.match(controllerSource, /if \(!revealCurrent\) host\.scrollTop = scrollTop;/);
  assert.match(treeSource, /if \(revealCurrent\) \{[\s\S]*?scrollIntoView\(\{[\s\S]*?behavior:\s*"smooth"[\s\S]*?block:\s*"center"/);
  assert.doesNotMatch(treeSource, /scrollIntoView\(\{ block: "nearest" \}\)/);
});

test("reveal current locates the note in the lazy tree instead of loading the whole vault", () => {
  assert.match(controllerSource, /await tree\.locate\(state\.path\);/);
  assert.match(controllerSource, /render\(\{ revealCurrent: true \}\);/);
  assert.doesNotMatch(controllerSource, /unfilteredNotes/);
  assert.doesNotMatch(controllerSource, /state\.notes = /);
});

test("tree and search keep separate caches", () => {
  assert.match(controllerSource, /const search = createSearchState\(\);/);
  assert.match(controllerSource, /const isQueryActive = \(\) => isSearchActive\(search\);/);
  assert.match(controllerSource, /await tree\.loadRoot\(\);/);
  // Search is its own v2-backed view (Phase 3A-3): no v1 notes, no global notes array.
  assert.match(controllerSource, /searchPageUrl\(search, cursor\)/);
  assert.doesNotMatch(controllerSource, /\/api\/web\/v1\/notes/);
  assert.doesNotMatch(controllerSource, /renderExplorer/);
});

test("the lazy tree owns its own expanded/children state (state.expanded is search-only)", () => {
  assert.match(controllerSource, /tree\.model\.expanded\.add\(rel\)/);
  assert.match(controllerSource, /tree\.model\.childrenByParent\.get\(rel\)/);
  assert.match(controllerSource, /renderLazyExplorer\(\{/);
  assert.match(controllerSource, /onToggle: \(folderPath\) => tree\.toggle\(folderPath\)/);
  assert.match(controllerSource, /onLoadMore: \(parent\) => tree\.loadMore\(parent\)/);
});

test("create-note collisions use the lazy tree children, not a global notes list", () => {
  assert.match(controllerSource, /function hasChild\(parent, path\)/);
  assert.match(appSource, /hasChild: \(parent, path\) => explorer\.hasChild\(parent, path\)/);
  assert.match(appSource, /ensureExpanded: \(folderPath\) => explorer\.ensureTreeExpanded\(folderPath\)/);
});

test("opening a note expands ancestors and initial note/tree loads run concurrently", () => {
  assert.match(appSource, /explorer\.ensureVisible\(result\.path\)/);
  assert.match(appSource, /explorer\.syncCurrent\(\);/);
  assert.doesNotMatch(appSource, /syncStatusFromSession\(session\.statusFlags\(\)\);\s*explorer\.render\(\);\s*return true;/);
  assert.match(appSource, /const initialTasks = \[loadNotes\(\)\];[\s\S]*?initialTasks\.push\(openNote\(initialNotePath, \{ historyMode: "replace", fragment: location\.hash\.slice\(1\) \}\)\)[\s\S]*?await Promise\.all\(initialTasks\);/);
  assert.match(appSource, /applyOpenCommit\(result, \{ refreshOutline: false \}\)[\s\S]*?viewMode\.setMode\(state\.mode\)[\s\S]*?documentNavigation\?\.commit\(/);
});

test("a structurally identical tree refresh reuses the DOM instead of rebuilding", () => {
  assert.match(controllerSource, /let lastTreeSignature = null;/);
  assert.match(controllerSource, /treeRenderSignature\(tree\.model\)/);
  assert.match(
    controllerSource,
    /if \(!revealCurrent && signature === lastTreeSignature\) \{[\s\S]*?syncCurrent\(\);\s*syncLoadMoreChrome\(\);/,
  );
});

test("a reused DOM still patches the load-more sentinel chrome", () => {
  assert.match(controllerSource, /function syncLoadMoreChrome\(\)/);
  assert.match(controllerSource, /\.tree-load-more\[data-parent-path\]/);
  assert.match(controllerSource, /button\.disabled = loading;/);
  assert.match(controllerSource, /loading \? "正在加载…" : "加载更多"/);
});

test("a lazy tree refresh re-renders from the model change hook, not a full reload", () => {
  assert.match(controllerSource, /const tree = createLazyTreeController\(\{[\s\S]*?onChange: \(\) => render\(\)/);
});

// --- BASE open seam (Wave B / B2) -------------------------------------------

test("the explorer controller accepts an optional openBase and forwards onOpenBase to the renderer", () => {
  assert.match(controllerSource, /createExplorerController\(\{[^}]*\bopenBase\b[^}]*\}\)/);
  assert.match(controllerSource, /onOpenBase: \(payload\) => openBase\?\.\(payload\)/);
  // The renderer emits intent only. core/app.js supplies the callback in B4
  // (documentKind navigation); this test locks the seam shape, not app.js.
});

test("the explorer wiring exposes a backward-compatible optional onOpenBase (default no-op)", () => {
  assert.match(wiringSource, /onOpenBase,/);
  assert.match(wiringSource, /openBase: \(payload\) => onOpenBase\?\.\(payload\)/);
  assert.match(treeSource, /onOpenBase,/);
});

test("base selection does not reuse the note `.md`-stripping identity", () => {
  assert.match(controllerSource, /button\.dataset\.kind === "base"/);
  assert.match(controllerSource, /normalizePath\(button\.dataset\.path\) === normalizePath\(state\.path\)/);
});

// --- #284 B2: hover-prefetch intent wiring -----------------------------------
//
// The renderer is allowed to bind exactly two bare events on a directory row and
// nothing else. The 150 ms intent window, the `(hover: hover)` capability check and
// the controller calls all live in the frozen A1 module (`prefetch.js`), so these
// tests lock both halves: real DOM event behavior through `renderLazyExplorer`, and
// the source invariant that the renderer and its extracted binding module
// (`prefetch-hover.js`) hold no timer or network rule of their own.

const harness = createDomHarness();
harness.install();
const document = harness.document;

const HOVER_ITEMS = [
  { kind: "directory", path: "Folder", name: "Folder" },
  { kind: "note", path: "Note.md", title: "Note" },
  { kind: "base", path: "Board.base", title: "Board" },
  { kind: "file", path: "doc.txt", name: "doc.txt", title: "doc.txt", extension: "txt" },
];

function renderHoverProbe({ items = HOVER_ITEMS, children = {}, expanded = [] } = {}) {
  const host = document.createElement("div");
  const model = createLazyExplorerState();
  model.childrenByParent.set("", items);
  for (const [parent, list] of Object.entries(children)) model.childrenByParent.set(parent, list);
  for (const parent of expanded) model.expanded.add(parent);
  const events = [];
  const intent = {
    pointerenter: (parent) => events.push(`enter:${parent}`),
    pointerleave: (parent) => events.push(`leave:${parent}`),
  };
  renderLazyExplorer({
    host,
    model,
    currentPath: null,
    escapeHtml: (value) => String(value),
    hoverIntent: intent,
  });
  return { host, model, events, intent };
}

test("a directory row emits pointerenter/pointerleave intent carrying its own path", () => {
  const { host, events } = renderHoverProbe();
  const row = host.querySelectorAll(".tree-folder")[0];
  assert.ok(row, "the directory row renders");
  assert.equal(typeof row.onpointerenter, "function", "the directory row must emit a pointerenter intent");
  assert.equal(typeof row.onpointerleave, "function", "the directory row must emit a pointerleave intent");
  row.dispatchEvent({ type: "pointerenter" });
  row.dispatchEvent({ type: "pointerleave" });
  assert.deepEqual(events, ["enter:Folder", "leave:Folder"]);
});

test("hover intent is inert on note, base, file and add-button elements", () => {
  const { host } = renderHoverProbe();
  const rows = host.querySelectorAll(".note");
  assert.deepEqual(rows.map((row) => row.dataset.path), ["Note.md", "Board.base", "doc.txt"]);
  for (const row of rows) {
    assert.equal(row.onpointerenter ?? null, null, `${row.dataset.path} must not carry hover intent`);
    assert.equal(row.onpointerleave ?? null, null, `${row.dataset.path} must not carry hover intent`);
  }
  const add = host.querySelectorAll(".tree-folder-add")[0];
  assert.ok(add, "the add button renders inside the directory row");
  assert.equal(add.onpointerenter ?? null, null, "the add button must not carry hover intent");
  assert.equal(add.onpointerleave ?? null, null, "the add button must not carry hover intent");
});

test("hovering a collapsed directory never expands it, loads it or reveals children", () => {
  const { host, model } = renderHoverProbe();
  const row = host.querySelectorAll(".tree-folder")[0];
  row.dispatchEvent({ type: "pointerenter" });
  row.dispatchEvent({ type: "pointerleave" });
  assert.equal(row.getAttribute("aria-expanded"), "false");
  assert.equal(host.querySelectorAll(".tree-children")[0].hidden, true);
  assert.equal(model.expanded.size, 0, "hovering must not expand the parent in the model");
  assert.equal(model.loadingParents.size, 0, "hovering must not start a visible load");
});

test("an expanded directory row emits intent without disturbing its rendered children", () => {
  const sub = [{ kind: "directory", path: "Folder/Sub", name: "Sub" }];
  const { host, events } = renderHoverProbe({ expanded: ["Folder"], children: { Folder: sub } });
  const rows = host.querySelectorAll(".tree-folder");
  assert.deepEqual(rows.map((row) => row.title), ["Folder", "Folder/Sub"]);
  rows[0].dispatchEvent({ type: "pointerenter" });
  rows[0].dispatchEvent({ type: "pointerleave" });
  assert.deepEqual(events, ["enter:Folder", "leave:Folder"]);
  assert.equal(rows[0].getAttribute("aria-expanded"), "true");
  assert.equal(host.querySelectorAll(".tree-children")[0].hidden, false);
  assert.equal(host.querySelectorAll(".tree-folder").length, 2, "the rendered child subtree survives the hover events");
});

test("hover intent callbacks are optional, so a bare render stays safe", () => {
  const host = document.createElement("div");
  const model = createLazyExplorerState();
  model.childrenByParent.set("", HOVER_ITEMS);
  // No intent injected at all: the binding seam is skipped, not stubbed.
  renderLazyExplorer({ host, model, currentPath: null, escapeHtml: (value) => String(value) });
  const row = host.querySelectorAll(".tree-folder")[0];
  assert.equal(row.onpointerenter ?? null, null, "an uninjected intent leaves the row without a hover seam");
  row.dispatchEvent({ type: "pointerenter" });
  row.dispatchEvent({ type: "pointerleave" });
  assert.equal(row.getAttribute("aria-expanded"), "false");
});

test("the renderer and its extracted hover binding hold no timer and no network rule (intent policy lives in prefetch.js)", () => {
  // Issue #427: the shared draft lifecycle (and with it the one deferred-blur timer of the
  // create flow) moved to create-draft.js; the renderer itself now owns no timer at all.
  assert.equal((treeSource.match(/setTimeout\(/g) ?? []).length, 0, "the renderer owns no timer");
  assert.equal((draftSource.match(/setTimeout\(/g) ?? []).length, 1, "the draft row keeps exactly the one deferred-blur timer");
  assert.match(draftSource, /input\.addEventListener\("blur", \(\) => setTimeout\(cancel, 0\)\)/);
  assert.equal((prefetchHoverSource.match(/setTimeout\(/g) ?? []).length, 0, "the hover binding must not own a timer");
  for (const source of [treeSource, draftSource, prefetchHoverSource]) {
    for (const forbidden of [
      /setInterval\(/,
      /requestIdleCallback/,
      /fetch\(/,
      /AbortController/,
      /XMLHttpRequest/,
      /sendBeacon/,
      /\/api\//,
      /matchMedia/,
      /prefetch\(/,
      /cancelPrefetch\(/,
    ]) {
      assert.doesNotMatch(source, forbidden);
    }
  }
  // The one binding lives in the extracted module; tree.js only delegates to it.
  assert.match(prefetchHoverSource, /row\.onpointerenter = \(\) => intent\.pointerenter\(parent\);/);
  assert.match(prefetchHoverSource, /row\.onpointerleave = \(\) => intent\.pointerleave\(parent\);/);
  assert.match(treeSource, /bindFolderHoverIntent\(row, item\.path, hoverIntent\);/);
  assert.doesNotMatch(treeSource, /onpointerenter|onpointerleave/);
});

test("the explorer controller builds exactly one hover intent instance from the frozen A1 factory", () => {
  assert.match(controllerSource, /import \{ createExplorerPrefetchIntent \} from "\.\/prefetch\.js";/);
  assert.equal((controllerSource.match(/createExplorerPrefetchIntent\(/g) ?? []).length, 1, "one intent instance per controller");
  assert.match(controllerSource, /createExplorerPrefetchIntent\(\{ controller: tree \}\)/);
  // The renderer receives that single instance; the controller keeps the network rules
  // and no per-callback closure of its own.
  assert.match(controllerSource, /hoverIntent: prefetchIntent,/);
  assert.doesNotMatch(controllerSource, /onFolderPointerEnter|onFolderPointerLeave/);
  // No second tree endpoint and no cache/network rule smuggled into the wiring layer.
  assert.doesNotMatch(controllerSource, /\/api\/web\/v2\/tree/);
  assert.doesNotMatch(controllerSource, /prefetchStats|hasBudget|AbortController/);
});

// Bounded poll: the intent window is a real 150 ms timer inside the frozen A1 module
// (whose own fake-clock tests own the window itself), so this bridge test only waits
// for the observable outcome with a wide margin instead of asserting a fixed sleep.
async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

test("a real pointerenter on a rendered directory row reaches tree.prefetch through the wiring", async () => {
  const originalMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({ matches: query === "(hover: hover)" });
  try {
    const host = document.createElement("div");
    const requests = [];
    let releasePrefetch = () => {};
    const prefetchGate = new Promise((resolve) => { releasePrefetch = resolve; });
    const api = async (url) => {
      const parent = new URL(url, "http://localhost").searchParams.get("parent") ?? "";
      requests.push(url);
      // The speculative response is held open so the in-flight cancel path (I04) is
      // the one being asserted, not the completed-page reclaim (I11).
      if (parent === "Folder") await prefetchGate;
      return {
        parent,
        items: parent === ""
          ? [{ kind: "note", path: "Note.md", title: "Note" }, { kind: "directory", path: "Folder", name: "Folder" }]
          : [],
        nextCursor: null,
        catalog: { generation: 1, stale: false },
      };
    };
    const explorer = createExplorerController({
      state: { path: null, query: "", searchCollapsed: new Set(), semantic: false, caseSensitive: false, vaultId: "v1" },
      host,
      statusHost: null,
      api,
      toast: () => {},
      escapeHtml: (value) => String(value),
      openNote: () => {},
      createNote: () => {},
    });
    await explorer.load("");
    const row = host.querySelectorAll(".tree-folder")[0];
    const note = host.querySelectorAll(".note")[0];
    assert.ok(row && note, "the root level renders through the controller path");
    assert.equal(requests.length, 1, "only the root level is requested before any hover");
    const tree = explorer.treeController();

    // A note row carries no hover seam at all: hovering it can never reach the intent.
    note.dispatchEvent({ type: "pointerenter" });
    row.dispatchEvent({ type: "pointerenter" });
    assert.ok(await waitUntil(() => requests.some((url) => url.includes("parent=Folder"))), `the hover intent must reach tree.prefetch(): ${JSON.stringify(requests)}`);
    assert.equal(requests.filter((url) => url.includes("parent=Note.md")).length, 0, "note rows must never prefetch");
    assert.equal(requests.filter((url) => url.includes("parent=Folder")).length, 1, "one parent, one speculative request (§I08)");
    const prefetchQuery = new URL(requests.find((url) => url.includes("parent=Folder")), "http://localhost").searchParams;
    assert.equal(prefetchQuery.get("cursor"), null, "a hover prefetch never pages (§I06)");
    assert.equal(row.getAttribute("aria-expanded"), "false", "the hover must not expand the row (§I02)");
    assert.equal(host.querySelectorAll(".tree-children")[0].hidden, true, "the hover must not reveal children (§I02)");
    assert.equal(tree.model.expanded.size, 0, "the hover must not write expansion state (§I02)");
    assert.equal(tree.model.loadingParents.size, 0, "the hover must not write a visible loading state (§I02)");
    assert.equal(tree.model.errorByParent.size, 0, "the hover must not write an error state (§I07)");
    const issued = tree.prefetchStats();
    assert.equal(issued.issued, 1);
    assert.equal(issued.dropped, 0);
    assert.equal(issued.failed, 0);

    row.dispatchEvent({ type: "pointerleave" });
    assert.equal(tree.prefetchStats().cancelled, 1, "pointerleave must cancel the still-speculative owner (§I04)");
    releasePrefetch();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(tree.model.childrenByParent.has("Folder"), false, "a cancelled prefetch must not leave a page behind");
  } finally {
    if (originalMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = originalMatchMedia;
  }
});

// --- U6: collapse-all + new folder ------------------------------------------

test("collapse-all clears the tree expansion set, is idempotent, and stays a client action", () => {
  assert.match(controllerSource, /function collapseAll\(\) \{\s*if \(tree\.model\.expanded\.size === 0\) return false;\s*tree\.model\.expanded\.clear\(\);/);
  assert.match(controllerSource, /collapseAll,\s*beginNewNote: createEntries\.beginNewNote,\s*beginNewFolder: createEntries\.beginNewFolder,\s*cancelDraft: createEntries\.cancelDraft,/);
  // Session-scoped: never written to localStorage/preferences.
  assert.doesNotMatch(controllerSource, /writeExplorerSort\([^)]*collapse|localStorage[^\n]*collapseAll/);
});

test("the new-folder action opens the inline root draft and calls the real Web route", () => {
  assert.match(draftSource, /beginNewFolder: \(\) => beginDraft\(\{[\s\S]*?kind: "folder",[\s\S]*?onCommit: \(name\) => createFolder\?\.\(name\)/);
  assert.match(controllerSource, /createFolder: \(name\) => createFolderAtRoot\(name\)/);
  assert.match(controllerSource, /api\("\/api\/web\/v1\/folder", \{\s*method: "POST"/);
  assert.match(controllerSource, /error\?\.status === 409\) return "已存在同名文件夹，请换一个名称"/);
  // No browser prompt anywhere in the new flows.
  assert.doesNotMatch(controllerSource, /prompt\(/);
});

test("the panel-head new-note action opens a root draft and never posts on the click", () => {
  // #427: the click only opens the shared inline draft; the POST lives in the commit seam.
  assert.match(draftSource, /beginNewNote: \(\) => beginDraft\(\{[\s\S]*?kind: "note",[\s\S]*?onCommit: \(name\) => createNote\?\.\(name\)/);
  assert.match(controllerSource, /createNote: \(name\) => createNote\("", name\)/);
  const beginNewNote = draftSource.match(/beginNewNote: \(\) => beginDraft\(\{[\s\S]*?\n    \}\),/);
  assert.ok(beginNewNote, "beginNewNote is defined");
  assert.doesNotMatch(beginNewNote[0], /api\(/, "opening a draft must not issue a request");
});

test("an uncommitted draft is cancelled by the panel close, the mode switch and a new search", () => {
  assert.match(draftSource, /cancelDraft: \(\) => settleActiveDraft\(\)/);
  assert.match(controllerSource, /setMode: \(next\) => \{\s*\/\/[\s\S]*?settleActiveDraft\(\);\s*return flat\.setMode\(next\);/);
  assert.match(controllerSource, /async function runSearch\(query, \{ revealCurrent = false \} = \{\}\) \{\s*\/\/[\s\S]*?settleActiveDraft\(\);/);
  assert.match(appSource, /onClose: \(\) => explorer\.cancelDraft\(\)/);
});
