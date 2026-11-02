// Issue #427 (U50, review HOLD): the three *interleavings* around the commit `await` in
// `features/explorer/create-draft.js`. The base lifecycle tests live in
// `test/explorer-create-draft.test.js`; this file drives the same real controller + DOM
// harness with a commit that is deliberately held open, so the sequence
// "commit in flight -> a repaint, or a new draft -> the old answer arrives" is a
// deterministic Node test instead of a browser race:
//
//   1. a late SUCCESS of a replaced draft must not remove (or settle) the newer draft;
//   2. a late FAILURE of a replaced draft must not re-render a second row;
//   3. a failure after a mid-flight repaint must restore the in-folder row into the
//      container that is live NOW, never into the detached pre-request children.
//
// The Chromium parity for the same three interleavings lives in
// `scripts/web-regression/explorer-draft-interleave.mjs`.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createExplorerController } from "../frontend/app/features/explorer/controller.js";
import { activeDraft } from "../frontend/app/features/explorer/create-draft.js";

const TREE_ROOT = {
  parent: "",
  items: [
    { kind: "directory", path: "Folder", name: "Folder" },
    { kind: "note", path: "A.md", title: "A" },
  ],
  nextCursor: null,
  catalog: { generation: 7, stale: false },
};

// The same harness shape as the base lifecycle tests, plus two controls they do not need:
// `setNoteImpl` replaces the note-commit seam with a promise the test resolves by hand, and
// `setExtra` adds one tree item so a "background repaint" is a real re-render.
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
  const calls = { note: [], folder: [] };
  let extra = null;
  let noteImpl = null;
  const api = async (url, options) => {
    if (url === "/api/web/v1/folder") {
      const body = JSON.parse(options.body);
      calls.folder.push(body.path);
      return { path: body.path };
    }
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
    createNote: (folderPath, name) => {
      calls.note.push([folderPath, name]);
      return noteImpl ? noteImpl(folderPath, name) : true;
    },
    openBase: () => {},
    openFile: () => {},
  });
  return {
    ...harness,
    host,
    calls,
    controller,
    setExtra: (item) => { extra = item; },
    setNoteImpl: (impl) => { noteImpl = impl; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const draftRows = (host) => host.querySelectorAll(".note-create-input");
const draftInput = (host) => host.querySelector(".note-create-input");
const heldNote = (chrome) => {
  let release;
  chrome.setNoteImpl(() => new Promise((resolve) => { release = resolve; }));
  return (created) => release(created);
};
const commitInput = async (host, value) => {
  const input = draftInput(host);
  input.value = value;
  input.dispatchEvent({ type: "input" });
  input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  await tick();
  return input;
};
const folderRow = (host) => [...host.querySelectorAll(".tree-folder-row")].find((row) => row.dataset.folderPath === "Folder");

test("a late successful commit never removes the draft opened after it", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  const release = heldNote(chrome);

  chrome.controller.beginNewNote();
  await commitInput(chrome.host, "旧笔记");
  assert.equal(draftRows(chrome.host).length, 0, "the in-flight commit takes its row off screen");

  // The user opens a fresh draft while the first request is still open.
  chrome.controller.beginNewNote();
  const fresh = draftInput(chrome.host);
  fresh.value = "Fresh note";
  fresh.dispatchEvent({ type: "input" });
  assert.equal(draftRows(chrome.host).length, 1);

  release(true); // the OLD request succeeds now
  await tick();
  await tick();

  assert.equal(draftRows(chrome.host).length, 1, "the older success must not delete the newer draft");
  assert.equal(draftInput(chrome.host).value, "Fresh note", "the newer draft keeps its typed value");
  assert.equal(chrome.document.activeElement, draftInput(chrome.host), "the newer draft keeps the focus");
  assert.equal(chrome.calls.note.length, 1, "the confirmed resource is kept, not re-created");
  assert.equal(activeDraft().value, "Fresh note", "the newer draft is still the single owner");
});

test("a late failed commit never re-renders a second row for the newer draft", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  const release = heldNote(chrome);

  chrome.controller.beginNewNote();
  await commitInput(chrome.host, "旧笔记");
  chrome.controller.beginNewFolder();
  const fresh = draftInput(chrome.host);
  fresh.value = "Fresh folder";
  fresh.dispatchEvent({ type: "input" });
  assert.equal(draftRows(chrome.host).length, 1);

  release(false); // the OLD request fails now
  await tick();
  await tick();

  assert.equal(draftRows(chrome.host).length, 1, "the older failure must not render a duplicate row");
  assert.equal(draftInput(chrome.host).value, "Fresh folder", "the newer draft keeps its typed value");
  assert.equal(activeDraft().kind, "folder", "the newer draft is still the single owner");
  assert.equal(chrome.document.activeElement, draftInput(chrome.host), "the focus stays on the newer draft");
});

test("a failure after a mid-flight repaint restores the in-folder row in the live children", async () => {
  const chrome = buildHarness();
  await chrome.controller.load("");
  folderRow(chrome.host).querySelector(".tree-folder-add")
    .dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
  await tick();
  const input = draftInput(chrome.host);
  assert.ok(input, "the in-folder draft row exists");
  const staleContainer = input.closest(".tree-children");

  const release = heldNote(chrome);
  input.value = "Nested retry";
  input.dispatchEvent({ type: "input" });
  input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  await tick();
  assert.equal(draftRows(chrome.host).length, 0, "no row is painted while the commit is in flight");

  // A background repaint (SSE / sort) rebuilds every folder's children while the POST is open.
  chrome.setExtra({ kind: "note", path: "Extra.md", title: "Extra" });
  await chrome.controller.load("");
  assert.equal(draftRows(chrome.host).length, 0, "the repaint paints no row for an in-flight commit");

  release(false); // the request fails after the repaint
  await tick();
  await tick();

  const restored = draftInput(chrome.host);
  assert.ok(restored, "the failed commit brings the row back");
  assert.equal(restored.value, "Nested retry", "the typed name survives the repaint");
  assert.notEqual(restored.closest(".tree-children"), staleContainer, "the row is not rendered into the pre-request subtree");
  const row = folderRow(chrome.host);
  const siblings = [...row.parentNode.children];
  assert.equal(restored.closest(".tree-children"), siblings[siblings.indexOf(row) + 1], "the row lives in the folder's live children");
  assert.equal(chrome.document.activeElement, restored, "the retry row takes the focus back");
  assert.equal(chrome.controller.hasActiveDraft(), true, "the draft is still open for the retry");
});
