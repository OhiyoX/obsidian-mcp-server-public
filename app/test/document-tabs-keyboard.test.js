// Issue #408 (audit §3 / Cut C) — Document Tab strip keyboard correctness.
//
// The strip is a roving-tabindex tablist: after ArrowLeft/ArrowRight/Home/End the *active
// document*, the single `aria-selected=true` tab and `document.activeElement` must be the same
// tab; a refused activation (dirty-document guard / failed open) must leave focus and the
// active document on the original tab; `Delete` closes the focused tab only while focus is
// inside the tablist; closing hands focus to the new active tab (active close) or leaves the
// focused tab / the editor focus alone (background close).
//
// The pre-#408 view restored focus by numeric index (`focusKey()` = `data-tab-index`), so it is
// red on "focus follows the activated tab" and on the close-focus checks below — see
// U34/verify/negative-*.txt for the recorded red/green pair.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createDocumentTabs } from "../frontend/app/features/tabs/index.js";

const NOTE_A = "_Workspace/40-Projects/A.md";
const NOTE_B = "_Workspace/40-Projects/B.md";
const NOTE_C = "Inbox/note-without-extension";
const NOTE_D = "Inbox/D.md";

function mountStrip({ openResult = true } = {}) {
  // A fresh harness per strip: `document.querySelector("#document-tabs")` must resolve to this
  // fixture's container, not to a strip mounted by an earlier test.
  const local = createDomHarness();
  local.install();
  const host = local.createElement("div");
  host.id = "document-tabs";
  host.className = "document-tabs";
  host.setAttribute("role", "tablist");
  host.setAttribute("aria-label", "打开的文档");
  local.document.body.append(host);

  const app = { path: null, documentKind: null };
  const opens = [];
  const replaces = [];
  let controller = null;

  controller = createDocumentTabs({
    documentRef: local.document,
    locationObject: { replace: (route) => replaces.push(route) },
    openNote: async (path) => {
      opens.push(path);
      if (openResult === false) return false; // the dirty-document guard answered "no"
      app.path = path;
      app.documentKind = "note";
      controller.syncFromSession();
      return true;
    },
    getCurrentPath: () => app.path,
    getDocumentKind: () => app.documentKind,
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const rows = () => host.querySelectorAll(".document-tab");
  const mains = () => rows().map((row) => row.querySelector(".document-tab-main"));
  const closeButtons = () => rows().map((row) => row.querySelector(".document-tab-close"));
  const paths = () => rows().map((row) => row.getAttribute("data-tab-path"));
  // The harness has no bubbling, so delegated events are dispatched on the strip itself — the
  // same listener the browser reaches by bubbling from the tab button.
  const click = (target) => host.dispatchEvent({ type: "click", target });
  const press = (target, key) => {
    const event = { type: "keydown", key, target, defaultPrevented: false };
    event.preventDefault = () => { event.defaultPrevented = true; };
    host.dispatchEvent(event);
    return event;
  };
  const setDocument = (path, documentKind = "note") => {
    app.path = path;
    app.documentKind = documentKind;
    controller.syncFromSession();
  };
  return {
    host, controller, app, opens, replaces, settle, rows, mains, closeButtons, paths, click, press, setDocument,
    focused: () => local.document.activeElement,
    newElement: (tag) => local.createElement(tag),
    body: local.document.body,
  };
}

const selected = (strip) => strip.mains().map((main) => main.getAttribute("aria-selected"));
const tabindexes = (strip) => strip.mains().map((main) => main.getAttribute("tabindex"));

test("#408: Arrow/Home/End keep active, aria-selected and DOM focus on the same tab", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);
  strip.setDocument(NOTE_C);
  assert.equal(strip.controller.getState().activeIndex, 2, "C is on screen");

  strip.mains()[0].focus();
  const right = strip.press(strip.mains()[0], "ArrowRight");
  await strip.settle();
  assert.equal(right.defaultPrevented, true, "the strip owns the arrow key");
  assert.deepEqual(strip.opens, [NOTE_B], "the arrow still opens the tab it lands on");
  assert.equal(strip.controller.getState().activeIndex, 1, "the active document follows the arrow");
  assert.deepEqual(selected(strip), ["false", "true", "false"], "aria-selected stays unique");
  assert.deepEqual(tabindexes(strip), ["-1", "0", "-1"], "roving tabindex is not loosened");
  assert.equal(strip.focused(), strip.mains()[1], "DOM focus follows the activated tab");

  strip.press(strip.mains()[1], "End");
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_B, NOTE_C]);
  assert.equal(strip.controller.getState().activeIndex, 2);
  assert.equal(strip.focused(), strip.mains()[2], "End activates and focuses the last tab");

  strip.press(strip.mains()[2], "ArrowRight");
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_B, NOTE_C, NOTE_A], "ArrowRight wraps to the first tab");
  assert.equal(strip.controller.getState().activeIndex, 0);
  assert.equal(strip.focused(), strip.mains()[0]);

  strip.press(strip.mains()[0], "ArrowLeft");
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_B, NOTE_C, NOTE_A, NOTE_C], "ArrowLeft wraps to the last tab");
  assert.equal(strip.controller.getState().activeIndex, 2);
  assert.equal(strip.focused(), strip.mains()[2]);

  strip.press(strip.mains()[2], "Home");
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_B, NOTE_C, NOTE_A, NOTE_C, NOTE_A]);
  assert.equal(strip.controller.getState().activeIndex, 0);
  assert.equal(strip.focused(), strip.mains()[0], "Home activates and focuses the first tab");

  assert.deepEqual(selected(strip), ["true", "false", "false"]);
  assert.deepEqual(tabindexes(strip), ["0", "-1", "-1"]);
  assert.deepEqual(strip.closeButtons().map((close) => close.getAttribute("tabindex")), ["-1", "-1", "-1"], "the close control is not a tab stop");
});

test("#408: a refused arrow activation keeps focus and the active tab on the original tab", async () => {
  const strip = mountStrip({ openResult: false });
  strip.setDocument(NOTE_B);
  strip.setDocument(NOTE_A);
  assert.equal(strip.controller.getState().activeIndex, 1, "A is on screen");

  strip.mains()[1].focus();
  strip.press(strip.mains()[1], "ArrowRight"); // lands on the background tab B(0)
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_B], "the neighbour open was attempted (its guard answered)");
  assert.equal(strip.controller.getState().activeIndex, 1, "the refused tab is never activated");
  assert.deepEqual(selected(strip), ["false", "true"]);
  assert.equal(strip.focused(), strip.mains()[1], "focus stays on the tab the document still shows");

  // The refused intent must not survive: a later unrelated render cannot use it to focus the tab
  // that was never opened.
  strip.setDocument(NOTE_C);
  await strip.settle();
  assert.equal(strip.controller.getState().activeIndex, 2);
  assert.equal(strip.focused().getAttribute("data-tab-path"), NOTE_A, "the stale intent is not replayed");
});

test("#408: Delete closes the focused tab while focus is inside the tablist", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);
  strip.setDocument(NOTE_C);
  strip.setDocument(NOTE_B); // active B(1)

  strip.mains()[2].focus();
  const deleted = strip.press(strip.mains()[2], "Delete");
  await strip.settle();
  assert.equal(deleted.defaultPrevented, true, "the strip consumes the Delete");
  assert.deepEqual(strip.opens, [], "closing a background tab never navigates");
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B], "the focused background tab is removed");
  assert.equal(strip.controller.getState().activeIndex, 1, "the document on screen is untouched");
  assert.equal(strip.focused(), strip.mains()[1], "focus falls to the tab that took its place");
});

test("#408: Delete outside the tablist is left to the editor", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);
  const editor = strip.newElement("div");
  editor.className = "cm-content";
  strip.body.append(editor);
  editor.focus();

  const deleted = strip.press(editor, "Delete");
  await strip.settle();
  assert.equal(deleted.defaultPrevented, false, "the strip must not shadow the editor's Delete");
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B], "no tab is closed");
  assert.equal(strip.focused(), editor, "and focus is untouched");
});

test("#408: closing the active tab hands focus to the new active tab", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);
  strip.setDocument(NOTE_C);
  strip.setDocument(NOTE_B); // active B(1)

  const closeB = strip.closeButtons()[1];
  closeB.focus(); // a pointer click puts focus on the control it hits
  strip.click(closeB);
  await strip.settle();
  assert.deepEqual(strip.opens, [NOTE_C], "the right neighbour is opened");
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_C]);
  assert.equal(strip.controller.getState().activeIndex, 1);
  assert.equal(strip.mains()[1].getAttribute("data-tab-path"), NOTE_C, "the new active tab is C");
  assert.equal(strip.focused(), strip.mains()[1], "focus lands on the tab the close activated");
});

test("#408: closing a background tab keeps the same tab focused (no index drift)", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);
  strip.setDocument(NOTE_C);
  strip.setDocument(NOTE_D); // active D(3)

  strip.mains()[1].focus(); // focus sits on the background tab B(1)
  strip.click(strip.closeButtons()[0]); // close A(0), before the focused tab
  await strip.settle();
  assert.deepEqual(strip.paths(), [NOTE_B, NOTE_C, NOTE_D]);
  assert.equal(strip.controller.getState().activeIndex, 2, "the document on screen is untouched");
  assert.deepEqual(strip.opens, [], "a background close never navigates");
  const focused = strip.focused();
  assert.ok(focused, "focus survives the background close");
  assert.equal(focused.getAttribute("data-tab-path"), NOTE_B, "focus stays on the same tab, not on the shifted index");
  assert.equal(focused, strip.mains()[0]);
});

test("#408: closing a background tab never steals the editor focus", async () => {
  const strip = mountStrip();
  strip.setDocument(NOTE_A);
  strip.setDocument(NOTE_B);
  const editor = strip.newElement("div");
  editor.className = "cm-content";
  strip.body.append(editor);
  editor.focus();

  strip.click(strip.closeButtons()[0]); // close A(0), inactive
  await strip.settle();
  assert.deepEqual(strip.paths(), [NOTE_B]);
  assert.equal(strip.controller.getState().activeIndex, 0);
  assert.equal(strip.focused(), editor, "the reading/editing focus is left alone");
});
