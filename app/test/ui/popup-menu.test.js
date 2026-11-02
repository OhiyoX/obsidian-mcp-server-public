// U35 (#407) — the shared popup/menu interaction primitive.
//
// Drives the real `ui/popup-menu.js` on the repository's DOM harness. The contract under
// test is the one the migrated consumers rely on: single-writer `hidden`/`aria-expanded`,
// one open popup per scope, the focus matrix (a pointer never moves focus, a keyboard open
// lands on the checked/first item, Escape hands focus back), Arrow/Home/End navigation,
// outside dismissal, and a `destroy()` that leaves no listener behind.
//
// The three negative controls at the end are paired: each runs the same assertion against a
// deliberately broken twin and requires it to fail, so a green run also proves the assertion
// is sensitive instead of vacuously passing.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createDomHarness } from "../helpers/base-dom.mjs";
import { createPopupMenuController } from "../../frontend/app/ui/popup-menu.js";

const dom = createDomHarness();
dom.install();

const live = [];

// --- fixtures ---------------------------------------------------------------

// One trigger + popup pair in the shipped markup shape. `checkedIndex`/`disabledIndex` mirror
// the `menuitemradio` menus (reading view, Tags sort) and their disabled items.
function scene({
  scope = "topbar",
  restoreFocus = true,
  itemCount = 3,
  checkedIndex = -1,
  disabledIndex = -1,
  role = "menuitem",
  withEditor = false,
  track = true,
} = {}) {
  const wrap = dom.createElement("div");
  const trigger = dom.createElement("button");
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const popup = dom.createElement("div");
  popup.setAttribute("role", "menu");
  popup.hidden = true;
  const items = [];
  for (let index = 0; index < itemCount; index += 1) {
    const item = dom.createElement("button");
    item.className = "popup-item";
    item.setAttribute("role", role);
    if (index === checkedIndex) item.setAttribute("aria-checked", "true");
    if (index === disabledIndex) item.disabled = true;
    items.push(item);
    popup.append(item);
  }
  const editor = withEditor ? dom.createElement("textarea") : null;
  wrap.append(trigger, popup);
  if (editor) wrap.append(editor);
  dom.document.body.replaceChildren(wrap);
  const opens = [];
  const closes = [];
  const controller = createPopupMenuController({
    trigger,
    popup,
    scope,
    restoreFocus,
    onOpen: () => opens.push(true),
    onClose: () => closes.push(true),
  });
  const handle = { trigger, popup, items, editor, controller, opens, closes };
  if (track) live.push(handle);
  return handle;
}

// Net per-type document listener count. The harness ignores the capture flag but matches
// listeners by identity, exactly like the controller's `removeEventListener` call.
function trackDocumentListeners() {
  const counts = new Map();
  const originalAdd = dom.document.addEventListener;
  const originalRemove = dom.document.removeEventListener;
  dom.document.addEventListener = (type, listener, ...rest) => {
    counts.set(type, (counts.get(type) ?? 0) + 1);
    return originalAdd.call(dom.document, type, listener, ...rest);
  };
  dom.document.removeEventListener = (type, listener, ...rest) => {
    counts.set(type, (counts.get(type) ?? 0) - 1);
    return originalRemove.call(dom.document, type, listener, ...rest);
  };
  return {
    total: () => [...counts.values()].reduce((sum, value) => sum + value, 0),
    restore() {
      dom.document.addEventListener = originalAdd;
      dom.document.removeEventListener = originalRemove;
    },
  };
}

const key = (name) => dom.document.dispatchEvent({ type: "keydown", key: name });
const outsidePointer = (node) => dom.document.dispatchEvent({ type: "pointerdown", target: node });
const pointerClick = (node) => node.dispatchEvent({ type: "click", detail: 1 });
const keyboardClick = (node) => node.dispatchEvent({ type: "click", detail: 0 });
const focusOf = () => dom.document.activeElement;
const isAssertionError = (error) => error?.code === "ERR_ASSERTION";

afterEach(() => {
  for (const handle of live.splice(0)) handle.controller.destroy();
  dom.document.activeElement = null;
  dom.document.body.replaceChildren();
});

// --- open / close / toggle --------------------------------------------------

test("the controller is the only writer of hidden and aria-expanded", () => {
  const { trigger, popup, controller, opens, closes } = scene();
  assert.equal(popup.hidden, true, "a fresh controller starts closed");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(controller.isOpen(), false);

  assert.equal(controller.open(), true);
  assert.equal(popup.hidden, false);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(controller.isOpen(), true);
  assert.equal(opens.length, 1, "onOpen fires on the transition");
  assert.equal(controller.open(), true, "re-opening an open popup is idempotent");
  assert.equal(opens.length, 1, "and does not fire onOpen twice");

  assert.equal(controller.close(), true);
  assert.equal(popup.hidden, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(controller.isOpen(), false);
  assert.equal(closes.length, 1);
});

test("construction closes markup that was left open (no drifted initial state)", () => {
  const { trigger, popup } = scene({ track: false });
  popup.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  const controller = createPopupMenuController({ trigger, popup, scope: "drift-check" });
  assert.equal(popup.hidden, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  controller.destroy();
});

test("toggle() opens a closed popup and closes an open one", () => {
  const { trigger, popup, controller } = scene();
  pointerClick(trigger);
  assert.equal(controller.isOpen(), true, "the controller owns the trigger click");
  assert.equal(popup.hidden, false);
  pointerClick(trigger);
  assert.equal(controller.isOpen(), false);
  assert.equal(popup.hidden, true);
});

test("close() on a closed popup is a no-op, so a redundant close never steals focus", () => {
  // features/navigation/keyboard-shortcuts.js calls every consumer's `closeMenu` on Escape,
  // including for menus that are already closed.
  const { trigger, editor, controller } = scene({ withEditor: true });
  editor.focus();
  assert.equal(controller.close(), false, "there was no transition to report");
  assert.equal(focusOf(), editor, "and focus stayed in the editor");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

// --- focus matrix -----------------------------------------------------------

test("keyboard open lands on the checked item, or on the first enabled one", () => {
  const checked = scene({ checkedIndex: 2, role: "menuitemradio", withEditor: true });
  checked.editor.focus();
  keyboardClick(checked.trigger);
  assert.equal(focusOf(), checked.items[2], "the checked radio wins over DOM order");
  checked.controller.close();

  const plain = scene({ disabledIndex: 0 });
  keyboardClick(plain.trigger);
  assert.equal(focusOf(), plain.items[1], "the first enabled item is the fallback");
});

test("pointer open leaves the focus where it was", () => {
  const { editor, trigger, popup, items } = scene({ withEditor: true });
  editor.focus();
  pointerClick(trigger);
  assert.equal(popup.hidden, false, "the popup opened");
  assert.equal(focusOf(), editor, "and the editor kept the caret");
  assert.notEqual(focusOf(), items[0]);
});

test("close({ returnFocus }) decides whether the trigger takes the focus back", () => {
  const withReturn = scene({ withEditor: true });
  withReturn.editor.focus();
  pointerClick(withReturn.trigger);
  withReturn.controller.close();
  assert.equal(focusOf(), withReturn.trigger);

  const without = scene({ restoreFocus: false, withEditor: true });
  without.editor.focus();
  pointerClick(without.trigger);
  without.controller.close();
  assert.equal(focusOf(), without.editor, "restoreFocus: false keeps the focus in place");
});

test("Escape closes and returns focus; a keyboard-opened menu always returns it", () => {
  // Pointer open of a restoreFocus menu: Escape hands the focus to the trigger.
  const pointer = scene({ withEditor: true });
  pointer.editor.focus();
  pointerClick(pointer.trigger);
  key("Escape");
  assert.equal(pointer.popup.hidden, true);
  assert.equal(pointer.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(focusOf(), pointer.trigger);

  // Pointer open of a restoreFocus:false menu (the reading-view menu): focus stays put,
  // because the user never put it in the menu.
  const passive = scene({ restoreFocus: false, withEditor: true });
  passive.editor.focus();
  pointerClick(passive.trigger);
  key("Escape");
  assert.equal(passive.popup.hidden, true);
  assert.equal(focusOf(), passive.editor);

  // Keyboard open: the menu owns the focus, so Escape must not drop it on the body.
  const keyboard = scene({ restoreFocus: false, withEditor: true });
  keyboard.editor.focus();
  keyboardClick(keyboard.trigger);
  assert.equal(focusOf(), keyboard.items[0]);
  key("Escape");
  assert.equal(keyboard.popup.hidden, true);
  assert.equal(focusOf(), keyboard.trigger);
});

// --- scope ------------------------------------------------------------------

test("one popup per scope: opening a second closes the first without moving focus", () => {
  const first = scene({ scope: "topbar", withEditor: true });
  const second = scene({ scope: "topbar" });
  first.editor.focus();
  pointerClick(first.trigger);
  assert.equal(first.controller.isOpen(), true);
  pointerClick(second.trigger);
  assert.equal(second.controller.isOpen(), true, "the second popup is open");
  assert.equal(first.controller.isOpen(), false, "and the first closed itself");
  assert.equal(first.popup.hidden, true);
  assert.equal(first.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(focusOf(), first.editor, "the passive close does not grab the trigger");
});

test("different scopes are independent and can be open at the same time", () => {
  const topbar = scene({ scope: "topbar" });
  const rail = scene({ scope: "context-sidebar" });
  pointerClick(topbar.trigger);
  pointerClick(rail.trigger);
  assert.equal(topbar.controller.isOpen(), true, "the topbar menu survived the rail open");
  assert.equal(rail.controller.isOpen(), true, "and both are open at once");
  // The harness invokes document listeners from the live list, so a listener that removes
  // itself mid-dispatch also hides the next one (the DOM spec copies the list first, so a
  // real browser reaches both). Dispatching twice keeps this assertion green either way;
  // the real single-press cross-scope dismissal is covered by the Chromium check in
  // `scripts/web-regression/chrome.mjs`.
  outsidePointer(dom.document.body);
  outsidePointer(dom.document.body);
  assert.equal(topbar.controller.isOpen(), false, "an outside press dismisses the topbar menu");
  assert.equal(rail.controller.isOpen(), false, "and the rail menu too");
});

// --- keyboard navigation ----------------------------------------------------

test("ArrowDown/ArrowUp cycle through the enabled items and skip disabled ones", () => {
  const { trigger, items } = scene({ itemCount: 4, disabledIndex: 1 });
  keyboardClick(trigger);
  assert.equal(focusOf(), items[0], "keyboard open focuses the first enabled item");
  key("ArrowDown");
  assert.equal(focusOf(), items[2], "the disabled item is skipped");
  key("ArrowDown");
  assert.equal(focusOf(), items[3]);
  key("ArrowDown");
  assert.equal(focusOf(), items[0], "the list wraps at the end");
  key("ArrowUp");
  assert.equal(focusOf(), items[3], "and at the start");
  key("ArrowUp");
  assert.equal(focusOf(), items[2]);
});

test("Home and End jump to the first and last enabled items", () => {
  const { trigger, items } = scene();
  keyboardClick(trigger);
  key("End");
  assert.equal(focusOf(), items[2]);
  key("Home");
  assert.equal(focusOf(), items[0]);
});

test("a closed popup registers no keyboard listener at all", () => {
  const { trigger, editor, controller } = scene({ withEditor: true });
  editor.focus();
  key("ArrowDown");
  key("Home");
  key("End");
  assert.equal(controller.isOpen(), false);
  assert.equal(focusOf(), editor, "the navigation keys left the editor alone");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

// --- outside dismissal ------------------------------------------------------

test("pointerdown outside closes the popup and leaves the click target's focus alone", () => {
  const { trigger, popup, controller, editor } = scene({ withEditor: true });
  const outside = dom.createElement("div");
  dom.document.body.append(outside);
  editor.focus();
  pointerClick(trigger);
  assert.equal(controller.isOpen(), true);
  outsidePointer(outside);
  assert.equal(controller.isOpen(), false);
  assert.equal(popup.hidden, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(focusOf(), editor, "an outside dismissal never returns focus to the trigger");
});

test("pointerdown inside the popup or on the trigger keeps it open", () => {
  const { trigger, popup, items, controller } = scene();
  pointerClick(trigger);
  outsidePointer(items[1]);
  assert.equal(controller.isOpen(), true, "a press on a menu item does not dismiss");
  outsidePointer(popup);
  assert.equal(controller.isOpen(), true, "nor does a press on the panel itself");
  outsidePointer(trigger);
  assert.equal(controller.isOpen(), true, "the trigger press belongs to its own click");
  pointerClick(trigger);
  assert.equal(controller.isOpen(), false, "which then toggles the popup closed");
});

test("reopening after a dismiss installs the dismiss path again", () => {
  const { trigger, controller } = scene();
  const outside = dom.createElement("div");
  dom.document.body.append(outside);
  pointerClick(trigger);
  controller.close();
  outsidePointer(outside);
  assert.equal(controller.isOpen(), false, "the stale press does nothing");
  assert.equal(controller.open(), true);
  outsidePointer(outside);
  assert.equal(controller.isOpen(), false, "and a fresh open dismisses again");
});

// --- destroy ----------------------------------------------------------------

test("destroy() releases every document listener it installed", () => {
  const tracker = trackDocumentListeners();
  try {
    const { trigger, popup, controller } = scene({ scope: "destroy-check" });
    assert.equal(tracker.total(), 0, "constructing a closed controller registers nothing");
    pointerClick(trigger);
    assert.equal(tracker.total(), 2, "open installs the dismiss + keyboard pair");
    controller.destroy();
    assert.equal(tracker.total(), 0, "destroy removes exactly those two");
    assert.equal(popup.hidden, true, "and leaves the popup closed");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(controller.isOpen(), false);
  } finally {
    tracker.restore();
  }
});

test("after destroy() the controller is inert and out of its scope", () => {
  const stale = scene({ track: false });
  const sibling = scene();
  pointerClick(stale.trigger);
  stale.controller.destroy();
  assert.equal(stale.controller.open(), false, "open() no longer works");
  assert.equal(stale.controller.toggle(), false);
  assert.equal(stale.controller.close(), false);
  assert.equal(stale.popup.hidden, true);
  // A destroyed controller is no longer a sibling: opening the survivor must not touch it.
  pointerClick(sibling.trigger);
  assert.equal(sibling.controller.isOpen(), true);
  assert.equal(stale.popup.hidden, true);
  stale.controller.destroy();
});

// --- negative controls ------------------------------------------------------
// Each one runs an assertion from the suites above against a deliberately broken twin and
// requires it to fail; the same assertion is green on the real primitive.

test("negative control 1: same-scope exclusion is red for two different scopes", () => {
  const exclusion = (controller) => assert.equal(controller.isOpen(), false, "the first popup must have closed");

  // Red half: two controllers that are deliberately not in the same scope.
  const topbar = scene({ scope: "topbar" });
  const rail = scene({ scope: "context-sidebar" });
  topbar.controller.open();
  rail.controller.open();
  assert.throws(() => exclusion(topbar.controller), isAssertionError, "two scopes are not mutually exclusive");

  // Green half: the very same predicate on a real same-scope pair.
  const sameOne = scene({ scope: "exclusion-check" });
  const sameTwo = scene({ scope: "exclusion-check" });
  sameOne.controller.open();
  sameTwo.controller.open();
  exclusion(sameOne.controller);
  assert.equal(sameTwo.controller.isOpen(), true, "and the second one stayed open");
});

test("negative control 2: the listener-leak checker is red for a leaking twin", () => {
  const tracker = trackDocumentListeners();
  try {
    const clean = scene({ track: false });
    clean.controller.open();
    clean.controller.destroy();
    assert.equal(tracker.total(), 0, "the real controller leaves nothing behind");

    const leakyAdd = (type) => dom.document.addEventListener(type, () => {}, true);
    leakyAdd("pointerdown");
    leakyAdd("keydown");
    assert.throws(
      () => assert.equal(tracker.total(), 0, "destroy must leave no listener"),
      isAssertionError,
      "the leak this checker exists to catch",
    );
  } finally {
    tracker.restore();
  }
});

test("negative control 3: the pointer-focus assertion is red for a keyboard open", () => {
  const { editor, trigger, popup, items } = scene({ withEditor: true });
  editor.focus();
  keyboardClick(trigger);
  assert.equal(popup.hidden, false);
  assert.throws(
    () => assert.equal(focusOf(), editor, "a pointer open leaves the editor focused"),
    isAssertionError,
    "a keyboard open really does move focus into the menu",
  );
  assert.equal(focusOf(), items[0], "sanity: the keyboard open put the focus on the menu item");
});
