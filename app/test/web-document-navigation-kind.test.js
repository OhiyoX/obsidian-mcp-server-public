// B4: documentKind-aware history commit + Back/Forward dispatch.
//
// Drives bindDocumentNavigation with an injected fake history/location/window so
// Base↔note popstate routing is deterministic without a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { bindDocumentNavigation } from "../frontend/app/features/navigation/bind-navigation.js";

const harness = createDomHarness();
harness.install();

function makeNavigation({ openNoteResult = true, openBaseResult = true } = {}) {
  const doc = harness.document;
  const preview = doc.createElement("article");
  const editorHost = doc.createElement("div");
  const searchInput = doc.createElement("input");
  const listeners = new Map();
  const windowObject = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    getSelection: () => null,
    open() {},
  };
  const locationObject = { pathname: "/app", search: "", hash: "", reload() { locationObject.reloaded = true; } };
  const historyObject = {
    state: { kind: "obsidianWebNavigation", index: 0, vaultId: "vault-1", path: null, route: null, documentKind: "note", fragment: "" },
    replaceState(state) { this.state = state; },
    pushState(state) { this.state = state; },
    go(delta) { this.gone = (this.gone || 0) + delta; },
  };
  const current = { path: null, documentKind: "note" };
  const calls = { note: [], base: [], load: [] };
  const nav = bindDocumentNavigation({
    preview,
    editorHost,
    outline: { getHeadings: () => [], scrollTo: () => true },
    editor: { scrollToPosition: () => true },
    getMode: () => "preview",
    getPath: () => current.path,
    getDocumentKind: () => current.documentKind,
    getVaultId: () => "vault-1",
    openNote: async (path, options) => { calls.note.push({ path, ...options }); return openNoteResult; },
    openBase: async (options) => { calls.base.push(options); return openBaseResult; },
    resolveNote: async () => ({ path: "A.md", route: "/app/note/A" }),
    searchInput,
    loadNotes: (value) => calls.load.push(value),
    syncSearchChrome: () => {},
    historyObject,
    locationObject,
    windowObject,
  });
  return { nav, historyObject, locationObject, windowObject, listeners, calls, current, preview, editorHost };
}

async function popstate(ctx, state) {
  const listener = ctx.listeners.get("popstate")[0];
  return listener({ state });
}

test("commit records documentKind and route for note and base entries", () => {
  const ctx = makeNavigation();
  assert.equal(ctx.nav.commit({ route: "/app/note/A", path: "A.md", vaultId: "vault-1", documentKind: "note" }, "push"), true);
  assert.equal(ctx.historyObject.state.documentKind, "note");
  assert.equal(ctx.historyObject.state.route, "/app/note/A");
  const noteIndex = ctx.historyObject.state.index;
  assert.equal(ctx.nav.commit({ route: "/app/base/Z", path: "Z.base", vaultId: "vault-1", documentKind: "base" }, "push"), true);
  assert.equal(ctx.historyObject.state.documentKind, "base");
  assert.equal(ctx.historyObject.state.path, "Z.base");
  assert.equal(ctx.historyObject.state.index, noteIndex + 1);
});

test("popstate dispatches a Base entry to openBase, not openNote", async () => {
  const ctx = makeNavigation();
  ctx.nav.commit({ route: "/app/note/A", path: "A.md", vaultId: "vault-1", documentKind: "note" }, "replace");
  ctx.nav.commit({ route: "/app/base/Z", path: "Z.base", vaultId: "vault-1", documentKind: "base" }, "push");
  const baseEntry = { ...ctx.historyObject.state };
  ctx.current.path = "A.md";
  ctx.current.documentKind = "note";
  await popstate(ctx, baseEntry);
  assert.equal(ctx.calls.note.length, 0);
  assert.equal(ctx.calls.base.length, 1);
  assert.equal(ctx.calls.base[0].path, "Z.base");
  assert.equal(ctx.calls.base[0].route, "/app/base/Z");
  assert.equal(ctx.calls.base[0].historyMode, "none");
});

test("popstate dispatches a note entry to openNote", async () => {
  const ctx = makeNavigation();
  ctx.nav.commit({ route: "/app/note/A", path: "A.md", vaultId: "vault-1", documentKind: "note" }, "push");
  const noteEntry = { ...ctx.historyObject.state };
  ctx.current.path = "Z.base";
  ctx.current.documentKind = "base";
  await popstate(ctx, noteEntry);
  assert.equal(ctx.calls.base.length, 0);
  assert.equal(ctx.calls.note.length, 1);
  assert.equal(ctx.calls.note[0].path, "A.md");
  assert.equal(ctx.calls.note[0].historyMode, "none");
});

test("rejected Back navigation restores the visible document entry", async () => {
  const ctx = makeNavigation({ openNoteResult: false });
  ctx.nav.commit({ route: "/app/note/A", path: "A.md", vaultId: "vault-1", documentKind: "note" }, "push");
  ctx.nav.commit({ route: "/app/note/B", path: "B.md", vaultId: "vault-1", documentKind: "note" }, "push");
  const olderEntry = { ...ctx.historyObject.state, path: "A.md", route: "/app/note/A", index: 1 };
  ctx.current.path = "C.md";
  ctx.current.documentKind = "note";
  await popstate(ctx, olderEntry);
  assert.equal(ctx.calls.note.length, 1);
  assert.equal(ctx.historyObject.gone, 1);
});

test("rejected Base Back navigation asks history to restore", async () => {
  const ctx = makeNavigation({ openBaseResult: false });
  ctx.nav.commit({ route: "/app/note/A", path: "A.md", vaultId: "vault-1", documentKind: "note" }, "push");
  ctx.nav.commit({ route: "/app/base/Z", path: "Z.base", vaultId: "vault-1", documentKind: "base" }, "push");
  const olderBaseEntry = { ...ctx.historyObject.state, path: "Z.base", route: "/app/base/Z", documentKind: "base", index: 1 };
  ctx.current.path = "A.md";
  ctx.current.documentKind = "note";
  await popstate(ctx, olderBaseEntry);
  assert.equal(ctx.calls.base.length, 1);
  assert.equal(ctx.historyObject.gone, 1);
});

test("same-path same-kind popstate only navigates the fragment", async () => {
  const ctx = makeNavigation();
  ctx.nav.commit({ route: "/app/note/A", path: "A.md", vaultId: "vault-1", documentKind: "note", fragment: "intro" }, "push");
  const entry = { ...ctx.historyObject.state };
  ctx.current.path = "A.md";
  ctx.current.documentKind = "note";
  await popstate(ctx, entry);
  assert.equal(ctx.calls.note.length, 0);
  assert.equal(ctx.calls.base.length, 0);
});
