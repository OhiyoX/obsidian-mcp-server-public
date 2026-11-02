// #429 fix — the two interaction defects the review reproduced in real Chromium, pinned at the
// Node seam as well:
//
//   1. the strip re-renders under an open menu (a history navigation, an SSE-driven list change,
//      another close), so the row the menu was opened against — and, for a keyboard open, the focus
//      owner the close must give the focus back to — is detached. Escape then focused a detached
//      node, which leaves `document.activeElement` on `body` in a browser;
//   2. a held press on a row's close control opened the menu *and* closed the tab: the trailing
//      click of the gesture was only suppressed on the tab's main button.
//
// The third review round added a third one: an origin that is still *connected* can be unusable
// all the same. Returning the focus to a node the shell hid meanwhile (the Base surface covering
// the note, so the origin's ancestors are `[hidden]` and it has no layout) is a silent no-op in a
// browser and left `document.activeElement` on `body`, even though a live tab was still in the
// strip. Connectivity alone is therefore not a sufficient focus candidate; the twins below pin
// the fall-through and the terminal of an emptied strip at the same seam.
//
// The witnesses are the same seams the browser checks read (element identity, connectivity via
// `parentNode`, the strip's paths, the menu's target), so a regression is visible without a browser.
// This file keeps its own small harness on purpose: the thirteen assertions of
// document-tabs-menu.test.js stay byte-identical.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { installTimerRecorder } from "./helpers/deterministic-timers.mjs";
import { createDocumentTabs } from "../frontend/app/features/tabs/index.js";

const NOTE_A = "A.md";
const NOTE_B = "B.md";
const NOTE_C = "C.md";

function mount({ documentKind = null } = {}) {
  const local = createDomHarness();
  local.install();
  const host = local.createElement("div");
  host.id = "document-tabs";
  host.setAttribute("role", "tablist");
  host.setAttribute("aria-label", "打开的文档");
  local.document.body.append(host);
  const editor = local.createElement("textarea");
  editor.className = "editor";
  local.document.body.append(editor);

  const app = { path: null, kind: "note" };
  let controller = null;
  controller = createDocumentTabs({
    documentRef: local.document,
    enterWelcome: () => true,
    openNote: async (path) => { app.path = path; controller.syncFromSession(); return true; },
    getCurrentPath: () => app.path,
    getDocumentKind: documentKind ?? (() => app.kind),
  });

  const menu = local.document.querySelector(".tabs-close-menu");
  const rows = () => host.querySelectorAll(".document-tab");
  const mains = () => rows().map((row) => row.querySelector(".document-tab-main"));
  const mainFor = (path) => mains().find((main) => main.getAttribute("data-tab-path") === path);
  const closeFor = (path) => rows().find((row) => row.getAttribute("data-tab-path") === path).querySelector(".document-tab-close");
  const paths = () => rows().map((row) => row.getAttribute("data-tab-path"));
  // One `syncFromSession` per committed document identity: opening a note, a Base document (which
  // adds no tab and leaves every tab inactive) and a history navigation all end here, and all of
  // them re-render the strip.
  const setDocument = (path, kind = "note") => { app.kind = kind; app.path = path; controller.syncFromSession(); };
  // Build a strip the way the app does: every open adds (or re-selects) a tab, and the last
  // identity is the document on screen.
  const setStrip = (list, activePath) => { for (const path of list) setDocument(path); setDocument(activePath); };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const click = (target) => host.dispatchEvent({ type: "click", target });
  const press = (target, key, extra = {}) => {
    const event = { type: "keydown", key, target, defaultPrevented: false, ...extra };
    event.preventDefault = () => { event.defaultPrevented = true; };
    host.dispatchEvent(event);
    return event;
  };
  const pointer = (type, target, extra = {}) => host.dispatchEvent({ type, target, pointerType: "touch", clientX: 12, clientY: 24, ...extra });
  // "Still in the strip": the harness (like the browser) keeps a detached subtree's internal
  // parent pointers, so the ancestor walk is the portable witness, not `parentNode`.
  const attached = (element) => Boolean(element) && element.closest?.("#document-tabs") === host;

  return {
    local, controller, menu, host, editor, rows, mains, mainFor, closeFor, paths, setDocument, setStrip, settle, click, press, pointer, attached,
    menuOpen: () => menu.hidden === false,
    target: () => menu.getAttribute("data-tab-menu-target"),
    focused: () => local.document.activeElement,
    state: () => controller.getState(),
  };
}

test("#429 fix: a repaint under an open menu re-anchors it and Escape returns the focus to the live tab", () => {
  const strip = mount();
  strip.setStrip([NOTE_A, NOTE_B], NOTE_B);
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B], "the case starts from the two-tab strip");

  const staleAnchor = strip.mainFor(NOTE_A);
  staleAnchor.focus();
  strip.press(staleAnchor, "F10", { shiftKey: true });
  assert.equal(strip.menuOpen(), true, "Shift+F10 opens the menu on the focused tab");
  assert.equal(strip.target(), NOTE_A);
  assert.equal(strip.focused(), strip.menu.querySelector('[data-tab-action="close"]'), "the keyboard open takes the first item");

  // The browser shows the other document again: the app commits the identity and the strip
  // re-renders, which replaces every row — the saved A button is detached from here on.
  strip.setDocument(NOTE_A);
  const liveAnchor = strip.mainFor(NOTE_A);
  assert.notEqual(liveAnchor, staleAnchor, "the re-render really built a new A button");
  assert.equal(strip.attached(staleAnchor), false, "the saved A button is no longer in the strip");
  assert.equal(strip.menuOpen(), true, "an open menu survives the re-render of its own anchor");
  assert.equal(strip.target(), NOTE_A, "and still names the operated tab");

  strip.local.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(strip.menuOpen(), false);
  assert.equal(strip.focused(), liveAnchor, "Escape hands the focus to the A button that is in the document");
  assert.equal(strip.attached(strip.focused()), true, "never to a detached node");
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B], "no action ran");
  strip.controller.destroy();
});

test("#429 fix: an open menu whose operated tab disappears closes and hands the focus to a live tab", () => {
  const strip = mount();
  strip.setStrip([NOTE_A, NOTE_B, NOTE_C], NOTE_B);
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B, NOTE_C]);

  const staleAnchor = strip.mainFor(NOTE_C);
  staleAnchor.focus();
  strip.press(staleAnchor, "F10", { shiftKey: true });
  assert.equal(strip.target(), NOTE_C);

  // Another close removes the tab the menu was planned against (the list changed under it).
  strip.click(strip.closeFor(NOTE_C));
  assert.equal(strip.attached(staleAnchor), false, "the operated tab's element is gone");
  assert.equal(strip.menuOpen(), false, "the menu has nothing left to act on");
  const focused = strip.focused();
  assert.notEqual(focused, staleAnchor, "the focus never stays on the replaced tab");
  assert.equal(focused, strip.mainFor(NOTE_B), "it lands on the tab the strip still shows");
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B]);
  strip.controller.destroy();
});

test("#429 fix: a held press on a row's close control never also closes the tab, and a plain click still does", async () => {
  const timers = installTimerRecorder();
  try {
    const strip = mount();
    strip.setStrip([NOTE_A, NOTE_B], NOTE_B);
    const closeA = strip.closeFor(NOTE_A);

    // The gesture the review drove with trusted touch input: press and hold on the row's `x`.
    strip.pointer("pointerdown", closeA);
    timers.runAll();
    assert.equal(strip.menuOpen(), true, "the held press opens the menu for the pressed tab");
    assert.equal(strip.target(), NOTE_A);
    // The lift's trailing click lands on the same control: it is the tail of the menu gesture, so
    // it must be swallowed instead of closing the tab the menu was just opened for.
    strip.pointer("pointerup", closeA);
    strip.click(closeA);
    await strip.settle();
    assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B], "one gesture cannot both open the menu and close the tab");
    assert.equal(strip.menuOpen(), true, "and the menu the gesture opened is still usable");

    // A plain click is unaffected: the same control closes its tab once, and the menu follows the
    // list it was planned against.
    strip.click(closeA);
    await strip.settle();
    assert.deepEqual(strip.paths(), [NOTE_B], "a plain click on `x` still closes the tab");
    assert.equal(strip.menuOpen(), false, "and the menu of the removed tab is gone");
    strip.controller.destroy();
  } finally {
    timers.restore();
  }
});

test("#429 fix2: an origin the shell hid (a Base surface over the note) falls through to the live tab", () => {
  const strip = mount();
  strip.setStrip([NOTE_A, NOTE_B], NOTE_B);
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B], "the case starts from the two-tab strip");

  // The note's own surface: the shell hides that container (it does not unmount it) while another
  // document kind is on screen, which is exactly what leaves the origin connected but unusable.
  const view = strip.local.createElement("div");
  view.className = "document-view";
  strip.local.document.body.append(view);
  view.append(strip.editor);
  const origin = strip.editor;
  let originFocusCalls = 0;
  const focus = origin.focus;
  // The harness' `focus()` is unconditional, so the honest witness is the call itself: a browser
  // would silently drop it on a hidden node and leave the focus on `body`.
  origin.focus = () => { originFocusCalls += 1; focus.call(origin); };
  origin.focus();
  assert.equal(strip.focused(), origin, "the user is working in the editor");
  // From here on the counter must stay at zero: the setup focus above is not a focus return.
  originFocusCalls = 0;

  // A right click on A: `features/tabs/view.js` captures the focus owner at `pointerdown`, before
  // the press can move the focus onto the tab, and hands it to the menu as its origin.
  const staleAnchor = strip.mainFor(NOTE_A);
  strip.pointer("pointerdown", staleAnchor, { pointerType: "mouse" });
  strip.host.dispatchEvent({ type: "contextmenu", target: staleAnchor, clientX: 40, clientY: 12 });
  assert.equal(strip.menuOpen(), true, "the menu opens for the operated tab");
  assert.equal(strip.target(), NOTE_A);

  // The review's navigation: the Base surface is shown over the note and then the note again. Each
  // step commits a document identity, so each one re-renders the strip and replaces A's row.
  strip.setDocument("U51Focus.base", "base");
  view.setAttribute("hidden", "");
  strip.setDocument(NOTE_A);
  const liveAnchor = strip.mainFor(NOTE_A);
  assert.notEqual(liveAnchor, staleAnchor, "the history navigation really rebuilt A's row");
  assert.equal(strip.attached(staleAnchor), false, "the menu's saved anchor is detached");
  assert.equal(strip.menuOpen(), true, "the menu survived the navigation");
  assert.equal(strip.target(), NOTE_A, "and still names the operated tab");
  // The counterexample's precondition, as the review witnessed it: connected, hidden, no layout.
  // (The harness has no `isConnected`, so "still in the document" is the ancestor walk to `body`.)
  const inDocument = (element) => { for (let node = element; node; node = node.parentNode) if (node === strip.local.document.body) return true; return false; };
  assert.equal(inDocument(origin), true, "the origin node is still in the document");
  assert.equal(origin.closest("[hidden]") !== null, true, "but its own view is hidden, not the node");

  strip.local.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(strip.menuOpen(), false, "Escape closes the menu");
  assert.equal(strip.focused(), liveAnchor, "the live A tab takes the focus return, never the hidden origin");
  assert.equal(strip.attached(strip.focused()), true, "and the focus owner is really in the strip");
  assert.equal(originFocusCalls, 0, "the hidden origin was never even asked to focus");
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B], "no action ran");
  strip.controller.destroy();
});

test("#429 fix2: an emptied strip leaves the focus on the document body instead of a detached trigger", async () => {
  const strip = mount();
  strip.setDocument(NOTE_A);
  assert.deepEqual(strip.paths(), [NOTE_A], "the case starts from the single-tab strip");

  const view = strip.local.createElement("div");
  view.className = "document-view";
  strip.local.document.body.append(view);
  view.append(strip.editor);
  const origin = strip.editor;
  origin.focus();

  const staleAnchor = strip.mainFor(NOTE_A);
  strip.pointer("pointerdown", staleAnchor, { pointerType: "mouse" });
  strip.host.dispatchEvent({ type: "contextmenu", target: staleAnchor, clientX: 40, clientY: 12 });
  assert.equal(strip.menuOpen(), true, "the menu opens for the last tab");
  let staleFocusCalls = 0;
  const staleFocus = staleAnchor.focus;
  staleAnchor.focus = () => { staleFocusCalls += 1; staleFocus.call(staleAnchor); };

  // The last tab is closed through the app's own close lane (the row's `x`): the welcome transition
  // hides the document surface, the strip empties and the open menu has nothing left to act on.
  view.setAttribute("hidden", "");
  strip.click(strip.closeFor(NOTE_A));
  await strip.settle();
  assert.deepEqual(strip.paths(), [], "the strip is empty");
  assert.equal(strip.menuOpen(), false, "the menu of the removed tab is closed");
  assert.equal(staleFocusCalls, 0, "a detached trigger is never asked to focus");
  assert.equal(strip.focused(), strip.local.document.body, "the terminal focus owner is the document body");
  assert.equal(strip.attached(strip.focused()), false, "and nothing in the gone strip holds the focus");
  strip.controller.destroy();
});

test("#429 fix: a new gesture clears a swallow whose trailing click never arrived", async () => {
  const timers = installTimerRecorder();
  try {
    const strip = mount();
    strip.setStrip([NOTE_A, NOTE_B], NOTE_B);
    // A platform that fires `contextmenu` on a long press and no trailing click afterwards.
    strip.pointer("pointerdown", strip.mainFor(NOTE_A));
    timers.runAll();
    assert.equal(strip.menuOpen(), true);
    strip.pointer("pointerup", strip.mainFor(NOTE_A));
    // No trailing click for that gesture: the next real tap on the same tab must still switch.
    strip.pointer("pointerdown", strip.mainFor(NOTE_A));
    strip.pointer("pointerup", strip.mainFor(NOTE_A));
    strip.click(strip.mainFor(NOTE_A));
    await strip.settle();
    assert.equal(strip.state().activeIndex, 0, "the next tap activates A instead of being swallowed");
    assert.equal(strip.mainFor(NOTE_A).getAttribute("aria-selected"), "true", "and the strip shows A as the shown document");
    strip.controller.destroy();
  } finally {
    timers.restore();
  }
});
