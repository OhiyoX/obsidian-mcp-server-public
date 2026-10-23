// Issue #410 (audit Cut D): the in-app welcome transition behind the last-tab close.
//
// Two halves are pinned here:
//   - `createWelcomeTransition` (features/navigation/welcome-transition.js) — the shared dirty
//     guard, the session reset, the document-kind/outline/breadcrumb/welcome-surface order and
//     the injected navigation commit. The old behaviour was `location.replace("/app")`, which no
//     longer has a call path: the module tests below fail on a transition that does not commit
//     through the session.
//   - `commitWelcome` (features/navigation/bind-navigation.js) — the history entry that makes the
//     welcome workspace addressable as `/app` without pushing the just-closed note back onto Back.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { bindDocumentNavigation } from "../frontend/app/features/navigation/bind-navigation.js";
import { createWelcomeTransition, WELCOME_ROUTE } from "../frontend/app/features/navigation/welcome-transition.js";
import { dirtyDiscardMessage, UNSAVED_CHANGES_PREFIX } from "../frontend/app/features/session/unsaved-guard.js";

const read = (relative) => fs.readFile(new URL(relative, import.meta.url), "utf8");

function makeTransition({ dirty = false, confirmResult = true, vaultSwitching = false, navigation = null } = {}) {
  const calls = [];
  const messages = [];
  const state = { path: "A.md", revision: "r1", mode: "preview", vaultId: "vault-1" };
  const session = {
    isDirty: () => dirty,
    statusFlags: () => ({ dirty, path: state.path, baseRevision: state.revision }),
    closeDocument: () => { calls.push("session.closeDocument"); state.path = null; return { applied: true, path: null }; },
  };
  const transition = createWelcomeTransition({
    state,
    session,
    viewMode: { setMode: (mode) => calls.push(`viewMode.setMode:${mode}`) },
    pathBreadcrumb: { render: (path) => calls.push(`breadcrumb:${path}`) },
    clearDocumentContext: () => calls.push("clearDocumentContext"),
    syncStatus: (flags) => { calls.push(`syncStatus:${flags.path ?? "null"}`); state.path = flags.path; },
    isVaultSwitching: () => vaultSwitching,
    abortInFlight: () => calls.push("abortInFlight"),
    getNavigation: () => navigation ?? {},
    confirm: (message) => { messages.push(message); calls.push("confirm"); return confirmResult; },
  });
  return { transition, calls, messages, state };
}

test("the welcome transition commits the document reset in the app's order", () => {
  const calls = [];
  const state = { path: "A.md", mode: "live", vaultId: "vault-1" };
  const transition = createWelcomeTransition({
    state,
    session: { isDirty: () => false, statusFlags: () => ({ dirty: false, path: "A.md" }), closeDocument: () => { calls.push("session.closeDocument"); return { applied: true }; } },
    viewMode: { setMode: (mode) => calls.push(`viewMode.setMode:${mode}`) },
    pathBreadcrumb: { render: (path) => calls.push(`breadcrumb:${path}`) },
    clearDocumentContext: () => calls.push("clearDocumentContext"),
    syncStatus: () => calls.push("syncStatus"),
    abortInFlight: () => calls.push("abortInFlight"),
    getNavigation: () => ({
      documentNavigation: { commitWelcome: (data) => calls.push(`commitWelcome:${JSON.stringify(data)}`) },
      baseNavigation: { exitToNote: () => calls.push("exitToNote") },
    }),
  });
  assert.equal(transition.enterWelcome(), true);
  assert.equal(state.mode, "live", "the remembered view mode is session-only UI state and survives");
  assert.deepEqual(calls, [
    "abortInFlight",
    "session.closeDocument",
    "syncStatus",
    "exitToNote",
    "clearDocumentContext",
    "breadcrumb:null",
    "viewMode.setMode:preview",
    `commitWelcome:${JSON.stringify({ vaultId: "vault-1", route: WELCOME_ROUTE })}`,
  ], "the transition mirrors a committed note open: session first, then chrome, then history");
});

test("a declined unsaved-changes guard aborts the transition before any state change", () => {
  const declined = makeTransition({ dirty: true, confirmResult: false });
  assert.equal(declined.transition.enterWelcome(), false);
  assert.deepEqual(declined.calls, ["confirm"], "nothing but the dialog ran");
  assert.equal(declined.state.path, "A.md", "the document stays on screen");

  const accepted = makeTransition({ dirty: true, confirmResult: true });
  assert.equal(accepted.transition.enterWelcome(), true);
  assert.deepEqual(accepted.calls.slice(0, 2), ["confirm", "abortInFlight"]);
});

test("a clean document is not asked, and the dialog is the shared unsaved-changes message", () => {
  const clean = makeTransition();
  assert.equal(clean.transition.enterWelcome(), true);
  assert.deepEqual(clean.messages, [], "a clean document needs no confirmation");

  const dirty = makeTransition({ dirty: true });
  assert.equal(dirty.transition.enterWelcome(), true);
  assert.deepEqual(dirty.messages, [dirtyDiscardMessage("关闭该笔记吗？")]);
  assert.match(dirty.messages[0], new RegExp(`^${UNSAVED_CHANGES_PREFIX}`), "the same guard prefix openNote uses");
});

test("a vault switch in flight refuses the welcome transition", () => {
  const switching = makeTransition({ vaultSwitching: true });
  assert.equal(switching.transition.enterWelcome(), false);
  assert.deepEqual(switching.calls, [], "no session reset and no dialog during a vault switch");
});

test("the transition needs no navigation module to reset the document", () => {
  const bare = makeTransition();
  assert.equal(bare.transition.enterWelcome(), true);
  assert.ok(bare.calls.includes("session.closeDocument"), "the session still drops the document");
  assert.deepEqual(bare.state.path, null);
});

test("#410: neither the strip nor the transition keeps a page-load path", async () => {
  const strip = await read("../frontend/app/features/tabs/index.js");
  const transition = await read("../frontend/app/features/navigation/welcome-transition.js");
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code(transition), /location|\.reload\(|\.replace\(/, "the transition never loads a page");
  assert.doesNotMatch(code(strip), /location|WELCOME_ROUTE|\.reload\(|\.replace\(/, "the strip never loads a page");
});

// --- history ---------------------------------------------------------------

function makeNavigation() {
  const harness = createDomHarness();
  harness.install();
  const doc = harness.document;
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
  const locationObject = { pathname: "/app/note/A", search: "", hash: "", reload() { locationObject.reloaded = true; } };
  const historyObject = {
    state: { kind: "obsidianWebNavigation", index: 3, vaultId: "vault-1", path: "A.md", route: "/app/note/A", documentKind: "note", fragment: "" },
    writes: [],
    replaceState(state, title, url) { this.writes.push({ method: "replaceState", url, state }); this.state = state; },
    pushState(state, title, url) { this.writes.push({ method: "pushState", url, state }); this.state = state; },
    go(delta) { this.gone = (this.gone || 0) + delta; },
  };
  const current = { path: "A.md", documentKind: "note" };
  const calls = { note: [], base: [], load: [] };
  const nav = bindDocumentNavigation({
    preview: doc.createElement("article"),
    editorHost: doc.createElement("div"),
    outline: { getHeadings: () => [], scrollTo: () => true },
    editor: { scrollToPosition: () => true },
    getMode: () => "preview",
    getPath: () => current.path,
    getDocumentKind: () => current.documentKind,
    getVaultId: () => "vault-1",
    openNote: async (path, options) => { calls.note.push({ path, ...options }); return true; },
    openBase: async (options) => { calls.base.push(options); return true; },
    resolveNote: async () => ({ path: "A.md", route: "/app/note/A" }),
    searchInput: doc.createElement("input"),
    loadNotes: (value) => calls.load.push(value),
    syncSearchChrome: () => {},
    historyObject,
    locationObject,
    windowObject,
  });
  return { nav, historyObject, locationObject, listeners, calls, current };
}

test("#410: commitWelcome replaces the current entry with the document-less /app entry", () => {
  const ctx = makeNavigation();
  assert.equal(ctx.nav.commitWelcome({ vaultId: "vault-1" }), true);
  assert.equal(ctx.historyObject.writes.length, 1, "one history write");
  const [write] = ctx.historyObject.writes;
  assert.equal(write.method, "replaceState", "the closed document must not come back on Back");
  assert.equal(write.url, WELCOME_ROUTE);
  assert.deepEqual(write.state, { kind: "obsidianWebNavigation", index: 3, vaultId: "vault-1", path: null, route: WELCOME_ROUTE, documentKind: "note", fragment: "" });
  assert.equal(ctx.historyObject.state.path, null, "the current entry is the document-less one");
});

test("#410: Back from the welcome workspace replays an earlier note in-app, Forward reloads it", async () => {
  const ctx = makeNavigation();
  ctx.nav.commitWelcome({ vaultId: "vault-1" });
  ctx.current.path = null;
  const listener = ctx.listeners.get("popstate")[0];
  await listener({ state: { kind: "obsidianWebNavigation", index: 2, vaultId: "vault-1", path: "B.md", route: "/app/note/B", documentKind: "note", fragment: "" } });
  assert.deepEqual(ctx.calls.note, [{ path: "B.md", historyMode: "none", fragment: "" }], "an earlier note entry reopens through openNote");
  assert.equal(ctx.locationObject.reloaded, undefined, "Back never reloads the page");

  await listener({ state: { kind: "obsidianWebNavigation", index: 3, vaultId: "vault-1", path: null, route: WELCOME_ROUTE, documentKind: "note", fragment: "" } });
  assert.equal(ctx.locationObject.reloaded, true, "the document-less entry is the SSR welcome page, exactly like a first load");
});

test("#410: commitWelcome pushes on request and refuses to write without a vault or route", () => {
  const ctx = makeNavigation();
  assert.equal(ctx.nav.commitWelcome({ vaultId: "vault-1", route: "/app", mode: "push" }), true);
  assert.equal(ctx.historyObject.writes[0].method, "pushState");
  assert.equal(ctx.historyObject.writes[0].state.index, 4, "a pushed welcome entry takes the next index");

  const refused = makeNavigation();
  assert.equal(refused.nav.commitWelcome({ vaultId: "", route: "/app" }), false);
  assert.equal(refused.nav.commitWelcome({ vaultId: "vault-1", route: "", mode: "none" }), false);
  assert.deepEqual(refused.historyObject.writes, [], "an unusable commit writes no history");
});
