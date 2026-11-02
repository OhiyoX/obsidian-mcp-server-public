// Issue #427: the Explorer 新建笔记 / 新建文件夹 draft lifecycle.
//
// Two halves:
//  1. the DOM-free state machine of `features/explorer/create-draft.js` (draft token,
//     initial value, change + revert, commit-once, cancel, stale events);
//  2. the real controller + DOM harnesses for the three entries (panel-head new note,
//     folder-row `+`, panel-head new folder): nothing is created by the click, the
//     default name never commits, a committed rename calls the create seam exactly once,
//     and every cancel path (Escape, blur, browse-mode switch, search) claims no write.
//
// Level 3 (real Chromium + a real POST count against an isolated Vault) lives in
// `scripts/web-regression/explorer-draft.mjs`, registered from `scripts/web-regression.mjs`.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createExplorerController } from "../frontend/app/features/explorer/controller.js";
import {
  DEFAULT_FOLDER_NAME,
  DEFAULT_NOTE_NAME,
  activeDraft,
  beginDraft,
  createDraftRegistry,
  draftCommitDecision,
  hasActiveDraft,
  setDraftSettledHandler,
  settleActiveDraft,
} from "../frontend/app/features/explorer/create-draft.js";

const draftSource = await fs.readFile(new URL("../frontend/app/features/explorer/create-draft.js", import.meta.url), "utf8");

// --- 1. the pure state machine ----------------------------------------------------

test("the commit decision: only a real name change is a create intent", () => {
  assert.deepEqual(draftCommitDecision({ value: "", initialValue: DEFAULT_NOTE_NAME }), { action: "reject", reason: "empty" });
  assert.deepEqual(draftCommitDecision({ value: "   ", initialValue: DEFAULT_FOLDER_NAME }), { action: "reject", reason: "empty" });
  assert.deepEqual(draftCommitDecision({ value: DEFAULT_NOTE_NAME, initialValue: DEFAULT_NOTE_NAME }), { action: "reject", reason: "unchanged-default" });
  // A name typed back to the initial value is not a final change either.
  assert.deepEqual(draftCommitDecision({ value: ` ${DEFAULT_FOLDER_NAME} `, initialValue: DEFAULT_FOLDER_NAME }), { action: "reject", reason: "unchanged-default" });
  assert.deepEqual(draftCommitDecision({ value: "  我的笔记  ", initialValue: DEFAULT_NOTE_NAME }), { action: "submit", name: "我的笔记" });
});

test("the registry is token-scoped: one owner, one submit, stale tokens are inert", () => {
  const registry = createDraftRegistry();
  assert.equal(registry.current(), null);
  const first = registry.begin({ kind: "note", scope: "", initialValue: DEFAULT_NOTE_NAME });
  assert.equal(registry.current().token, first.token);
  assert.equal(first.value, DEFAULT_NOTE_NAME);
  assert.equal(first.submitting, false);
  assert.equal(registry.isCurrent(first), true);

  // Commit-once: the first Enter wins, the second one (and a double click) is refused.
  assert.equal(registry.beginSubmit(first), true);
  assert.equal(registry.beginSubmit(first), false);
  // A failed commit can be retried; a successful one settles the draft.
  registry.failSubmit(first);
  assert.equal(registry.beginSubmit(first), true);
  registry.failSubmit(first);
  assert.equal(registry.settle(first), true);
  assert.equal(registry.isCurrent(first), false);

  // A replaced draft's late callbacks can neither commit nor settle the new owner.
  const stale = registry.begin({ kind: "folder", scope: "", initialValue: DEFAULT_FOLDER_NAME });
  const current = registry.begin({ kind: "note", scope: "Folder", initialValue: DEFAULT_NOTE_NAME });
  assert.equal(registry.isCurrent(stale), false);
  assert.equal(registry.beginSubmit(stale), false);
  assert.equal(registry.settle(stale), false);
  assert.equal(registry.isCurrent(current), true);
  assert.equal(registry.current(), current);
});

// The singleton module API used by the renderers/controller (kept minimal here; the
// behaviour it drives is asserted through the real controller below).
test("the module-level draft slot reports and clears the one open draft", () => {
  const chrome = buildHarness();
  beginDraft({ host: chrome.host, initialValue: DEFAULT_NOTE_NAME, onCommit: () => true });
  assert.equal(hasActiveDraft(), true);
  assert.equal(activeDraft().kind, "note");
  assert.equal(chrome.host.querySelectorAll(".note-create-row").length, 1);
  assert.equal(settleActiveDraft(), true);
  assert.equal(hasActiveDraft(), false);
  // Idempotent: settling again is a no-op, not a second notification.
  let settled = 0;
  setDraftSettledHandler(() => { settled += 1; });
  assert.equal(settleActiveDraft(), false);
  assert.equal(settled, 0);
  setDraftSettledHandler(null);
});

// --- 2. controller + DOM ----------------------------------------------------------

const TREE_ROOT = {
  parent: "",
  items: [
    { kind: "directory", path: "Folder", name: "Folder" },
    { kind: "note", path: "A.md", title: "A" },
  ],
  nextCursor: null,
  catalog: { generation: 7, stale: false },
};

function buildHarness() {
  const harness = createDomHarness();
  harness.install();
  globalThis.CSS = { escape: (value) => String(value) };
  const document = harness.document;
  const host = document.createElement("div");
  let markup = "";
  Object.defineProperty(host, "innerHTML", {
    get: () => markup,
    set: (value) => {
      markup = String(value ?? "");
      if (markup === "") host.replaceChildren();
    },
  });
  const calls = { note: [], api: [] };
  let extra = null;
  let noteResult = true;
  const api = async (url, options) => {
    calls.api.push({ url: new URL(url, "http://test").pathname, method: options?.method ?? "GET", body: options?.body ?? null });
    if (url.includes("flat=1")) return { ...TREE_ROOT, items: [] };
    if (url.includes("/api/web/v2/search")) {
      return { items: [], nextCursor: null, semantic: { used: false }, catalog: { generation: 7, stale: false } };
    }
    return { ...TREE_ROOT, items: extra ? [...TREE_ROOT.items, extra] : TREE_ROOT.items };
  };
  const controller = createExplorerController({
    state: { path: "A.md", query: "", searchCollapsed: new Set(), semantic: false, caseSensitive: false, vaultId: "v1" },
    host,
    searchHost: null,
    statusHost: null,
    filesStatusHost: null,
    api,
    toast: () => {},
    escapeHtml: (value) => String(value),
    openNote: () => {},
    createNote: (folderPath, name) => { calls.note.push([folderPath, name]); return noteResult; },
    openBase: () => {},
    openFile: () => {},
  });
  return {
    ...harness,
    host,
    calls,
    controller,
    setExtra: (item) => { extra = item; },
    setNoteResult: (value) => { noteResult = value; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const draftRows = (host) => host.querySelectorAll(".note-create-input");
const draftInput = (host) => host.querySelector(".note-create-input");
const commitInput = async (host, value) => {
  const input = draftInput(host);
  input.value = value;
  input.dispatchEvent({ type: "input" });
  input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  await tick();
  return input;
};

test("the panel-head new-note click opens a draft and writes nothing by itself", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  chrome.calls.api.length = 0;
  assert.equal(chrome.controller.beginNewNote(), true);
  assert.equal(draftRows(chrome.host).length, 1);
  assert.equal(draftInput(chrome.host).value, DEFAULT_NOTE_NAME);
  assert.equal(draftInput(chrome.host).getAttribute("aria-label"), "新建笔记");
  assert.deepEqual(chrome.calls.note, [], "opening a draft never creates a note");
  assert.deepEqual(chrome.calls.api, [], "opening a draft never issues a request");
  assert.equal(chrome.controller.hasActiveDraft(), true);
});

test("Escape, blur and a name-less Enter cancel the panel-head draft without a write", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  chrome.controller.beginNewNote();
  draftInput(chrome.host).dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  assert.equal(draftRows(chrome.host).length, 0);
  assert.equal(chrome.controller.hasActiveDraft(), false);
  assert.deepEqual(chrome.calls.note, []);

  chrome.controller.beginNewNote();
  const input = draftInput(chrome.host);
  input.value = "临时名字";
  input.dispatchEvent({ type: "input" });
  input.dispatchEvent({ type: "blur" });
  await tick();
  assert.equal(draftRows(chrome.host).length, 0, "an uncommitted blur cancels the draft");
  assert.equal(chrome.controller.hasActiveDraft(), false);
  assert.deepEqual(chrome.calls.note, []);

  // An Enter that only clears the name keeps the row editable (unchanged U6 path).
  chrome.controller.beginNewNote();
  const empty = draftInput(chrome.host);
  empty.value = "";
  empty.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  await tick();
  assert.equal(draftRows(chrome.host).length, 1, "an empty name keeps the row");
  assert.deepEqual(chrome.calls.note, []);
});

test("the default name never commits, a real rename commits exactly once", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  chrome.controller.beginNewNote();
  await commitInput(chrome.host, DEFAULT_NOTE_NAME);
  assert.deepEqual(chrome.calls.note, [], "the untouched default is never a create intent");
  assert.equal(draftRows(chrome.host).length, 0, "the abandoned default draft is closed");

  chrome.controller.beginNewNote();
  await commitInput(chrome.host, `  ${DEFAULT_NOTE_NAME} `);
  assert.deepEqual(chrome.calls.note, [], "a name typed back to the default is not a change");

  chrome.controller.beginNewNote();
  await commitInput(chrome.host, "  我的笔记  ");
  assert.deepEqual(chrome.calls.note, [["", "我的笔记"]], "exactly one commit, trimmed, at the Vault root");
  assert.equal(draftRows(chrome.host).length, 0);
  assert.equal(chrome.controller.hasActiveDraft(), false);
});

test("Enter double-press and Enter+blur commit once; a stale row cannot commit", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  chrome.controller.beginNewNote();
  const input = draftInput(chrome.host);
  input.value = "连击";
  input.dispatchEvent({ type: "input" });
  input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  input.dispatchEvent({ type: "blur" });
  await tick();
  assert.deepEqual(chrome.calls.note, [["", "连击"]], "one Enter burst is one create");

  // Cancel, then let the cancelled row's deferred blur + a late Enter fire: inert.
  chrome.controller.beginNewNote();
  const stale = draftInput(chrome.host);
  stale.value = "过期";
  stale.dispatchEvent({ type: "input" });
  stale.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  stale.dispatchEvent({ type: "blur" });
  stale.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  await tick();
  assert.deepEqual(chrome.calls.note, [["", "连击"]], "a cancelled draft cannot revive or write");
});

test("a failed create keeps the row, the typed value and the focus for a retry", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  chrome.setNoteResult(false);
  chrome.controller.beginNewNote();
  await commitInput(chrome.host, "会失败");
  assert.deepEqual(chrome.calls.note, [["", "会失败"]], "the server was asked once");
  const input = draftInput(chrome.host);
  assert.ok(input, "a rejected create keeps the draft row");
  assert.equal(input.value, "会失败", "the typed name is preserved");
  assert.equal(chrome.document.activeElement, input, "the focus stays in the row for the retry");
  assert.equal(chrome.controller.hasActiveDraft(), true);

  chrome.setNoteResult(true);
  input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  await tick();
  assert.deepEqual(chrome.calls.note, [["", "会失败"], ["", "会失败"]], "the retry is a second, explicit commit");
  assert.equal(draftRows(chrome.host).length, 0);
});

test("only one draft owner at a time: the folder draft replaces the note draft", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  chrome.controller.beginNewNote();
  assert.equal(chrome.controller.beginNewFolder(), true);
  assert.equal(draftRows(chrome.host).length, 1, "the replaced note draft left no second row");
  assert.equal(draftInput(chrome.host).value, DEFAULT_FOLDER_NAME);
  const draft = activeDraft();
  assert.equal(draft.kind, "folder");

  await commitInput(chrome.host, "新目录");
  const folderPosts = chrome.calls.api.filter((call) => call.url === "/api/web/v1/folder" && call.method === "POST");
  assert.equal(folderPosts.length, 1, "the folder draft committed through the real folder route, once");
  assert.deepEqual(JSON.parse(folderPosts[0].body), { path: "新目录" });
  assert.deepEqual(chrome.calls.note, [], "the replaced note draft never committed");
  assert.deepEqual(chrome.calls.api.filter((call) => call.url === "/api/web/v1/note"), []);
});

test("the folder-row `+` opens an in-folder draft and commits into that folder", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  const folderRow = [...chrome.host.querySelectorAll(".tree-folder-row")].find((row) => row.dataset.folderPath === "Folder");
  const add = folderRow?.querySelector(".tree-folder-add");
  assert.ok(add, "the folder row exposes its add control");
  add.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
  await tick();
  const input = draftInput(chrome.host);
  assert.ok(input, "the in-folder draft row exists");
  assert.equal(input.closest(".tree-children") !== null, true, "it lives inside the folder's children");
  assert.equal(input.getAttribute("aria-label"), "在 Folder 中新建笔记");
  await commitInput(chrome.host, "子笔记");
  assert.deepEqual(chrome.calls.note, [["Folder", "子笔记"]]);
});

test("a browse-mode switch and a new search cancel an uncommitted draft", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  chrome.controller.beginNewNote();
  await chrome.controller.setMode("flat");
  assert.equal(chrome.controller.hasActiveDraft(), false, "flat mode cannot host a tree draft");
  assert.equal(chrome.host.querySelectorAll(".note-create-row").length, 0, "an external cancel clears the row too");
  assert.deepEqual(chrome.calls.note, []);

  await chrome.controller.setMode("tree");
  chrome.controller.beginNewNote();
  await chrome.controller.load("snippet");
  assert.equal(chrome.controller.hasActiveDraft(), false, "a new search abandons the draft");
  assert.deepEqual(chrome.calls.note, []);
});

test("a background tree repaint preserves the draft value and focus", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  chrome.controller.beginNewNote();
  const input = draftInput(chrome.host);
  input.value = "后台重绘";
  input.dispatchEvent({ type: "input" });
  // A real SSE/sort refresh repaints the same tree with a changed signature.
  chrome.setExtra({ kind: "note", path: "Extra.md", title: "Extra" });
  await chrome.controller.load("");
  const restored = draftInput(chrome.host);
  assert.ok(restored, "the draft row survives the repaint");
  assert.equal(restored.value, "后台重绘", "the typed value survives the repaint");
  assert.equal(chrome.document.activeElement, restored, "the focus returns to the draft row");
  await commitInput(chrome.host, "后台重绘");
  assert.deepEqual(chrome.calls.note, [["", "后台重绘"]]);
});

test("an external cancel clears the draft and takes its row off screen", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  chrome.controller.beginNewNote();
  assert.equal(chrome.host.querySelectorAll(".note-create-row").length, 1);
  assert.equal(chrome.controller.cancelDraft(), true);
  assert.equal(chrome.controller.hasActiveDraft(), false);
  assert.equal(chrome.host.querySelectorAll(".note-create-row").length, 0, "the cancelled row is removed");
  // Idempotent: a second cancel is a no-op and never notifies twice.
  let settled = 0;
  setDraftSettledHandler(() => { settled += 1; });
  assert.equal(chrome.controller.cancelDraft(), false);
  assert.equal(settled, 0);
  setDraftSettledHandler(null);
});

test("the draft waits for the pending sort instead of applying it mid-draft", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  const before = chrome.controller.getSort();
  const next = { key: before.key, direction: before.direction === "asc" ? "desc" : "asc" };
  chrome.controller.beginNewNote();
  await chrome.controller.setSort(next);
  assert.equal(chrome.controller.hasActiveDraft(), true, "the draft stays open while the sort is deferred");
  assert.equal(chrome.controller.getSort().direction, next.direction, "the preference advanced");
  draftInput(chrome.host).dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  await tick();
  assert.equal(chrome.controller.hasActiveDraft(), false);
});

// One contract the browser scene cannot assert from the source alone: the module never
// calls the network or a timer of its own beyond the deferred blur (checked again there).
test("the draft module owns no network call and no second timer", () => {
  for (const forbidden of [/fetch\(/, /\/api\//, /XMLHttpRequest/, /setInterval\(/, /requestIdleCallback/]) {
    assert.doesNotMatch(draftSource, forbidden);
  }
  assert.equal((draftSource.match(/setTimeout\(/g) ?? []).length, 1);
});
