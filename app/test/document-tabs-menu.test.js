// #429 — the tab strip's batch-close menu, on the real controller + real `ui/popup-menu.js`.
//
// The model's decision table is pinned in document-tabs-bulk-model.test.js; this file drives the
// product seams the user touches: right-click / Shift+F10 / the touch long press all report the
// *operated* tab, the five items are enabled exactly while their plan would remove a tab, a
// refusal by the dirty guard removes nothing at all, one batch commits one list, and the menu's
// dismissal and focus belong to the #407 primitive instead of a second implementation.
//
// The last test is a paired negative control: the same invariant is evaluated against the
// pre-#429 shape (a loop of single `close(index)` calls) and must be red there.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { installTimerRecorder } from "./helpers/deterministic-timers.mjs";
import { createDocumentTabs } from "../frontend/app/features/tabs/index.js";

const NOTE_A = "A.md";
const NOTE_B = "B.md";
const NOTE_C = "C.md";
const NOTE_D = "D.md";
const NOTE_E = "E.md";
const ACTION_LABELS = [["close", "关闭"], ["close-others", "关闭其他"], ["close-left", "关闭左侧标签页"], ["close-right", "关闭右侧标签页"], ["close-all", "关闭全部"]];
const isAssertionError = (error) => error?.code === "ERR_ASSERTION";

function mount({ openResult = true, welcomeResult = true, holdOpen = false } = {}) {
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
  const editor = local.createElement("textarea");
  editor.className = "editor";
  local.document.body.append(editor);

  const app = { path: null, documentKind: null };
  const opens = [];
  const welcomes = [];
  const stripChanges = [];
  const releases = [];
  let controller = null;

  controller = createDocumentTabs({
    documentRef: local.document,
    enterWelcome: () => { welcomes.push(true); return welcomeResult; },
    onModelChange: (tabs) => stripChanges.push(tabs.map((tab) => tab.path)),
    openNote: async (path) => {
      opens.push(path);
      if (holdOpen) await new Promise((resolve) => releases.push(resolve));
      if (openResult === false) return false;
      app.path = path;
      app.documentKind = "note";
      controller.syncFromSession();
      return true;
    },
    getCurrentPath: () => app.path,
    getDocumentKind: () => app.documentKind,
  });

  const menu = local.document.querySelector(".tabs-close-menu");
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const rows = () => host.querySelectorAll(".document-tab");
  const mains = () => rows().map((row) => row.querySelector(".document-tab-main"));
  const mainFor = (path) => mains().find((main) => main.getAttribute("data-tab-path") === path);
  const paths = () => rows().map((row) => row.getAttribute("data-tab-path"));
  const item = (action) => menu.querySelector(`[data-tab-action="${action}"]`);
  const click = (target) => host.dispatchEvent({ type: "click", target });
  const press = (target, key, extra = {}) => {
    const event = { type: "keydown", key, target, defaultPrevented: false, ...extra };
    event.preventDefault = () => { event.defaultPrevented = true; };
    host.dispatchEvent(event);
    return event;
  };
  const pointer = (type, target, extra = {}) => host.dispatchEvent({ type, target, pointerType: "touch", clientX: 12, clientY: 24, ...extra });
  const contextMenu = (target, point = { clientX: 40, clientY: 60 }) => {
    const event = { type: "contextmenu", target, defaultPrevented: false, ...point };
    event.preventDefault = () => { event.defaultPrevented = true; };
    host.dispatchEvent(event);
    return event;
  };
  const setDocument = (path, documentKind = "note") => { app.path = path; app.documentKind = documentKind; controller.syncFromSession(); };
  const setStrip = (list, activePath) => {
    for (const path of list) setDocument(path);
    if (activePath === null) setDocument(null, null);
    else setDocument(activePath);
  };
  const pick = async (action) => {
    // The menu owns its own click listener (popup scope), exactly like every other popup.
    menu.dispatchEvent({ type: "click", target: item(action) });
    await settle();
  };
  const pickItem = (action) => menu.dispatchEvent({ type: "click", target: item(action) });
  return {
    local, host, menu, controller, app, opens, welcomes, stripChanges, releases, settle, rows, mains, mainFor, paths,
    item, click, pickItem, press, pointer, contextMenu, setDocument, setStrip, pick,
    menuOpen: () => menu.hidden === false,
    focused: () => local.document.activeElement,
    state: () => controller.getState(),
  };
}

test("#429: the menu lists the five actions in contract order and binds to the operated tab", () => {
  const strip = mount();
  strip.setStrip([NOTE_A, NOTE_B, NOTE_C, NOTE_D], NOTE_A);
  assert.equal(strip.menuOpen(), false, "a fresh strip shows no menu");
  assert.equal(strip.menu.getAttribute("role"), "menu");

  const event = strip.contextMenu(strip.mainFor(NOTE_C));
  assert.equal(event.defaultPrevented, true, "the strip owns the tab's context menu");
  assert.equal(strip.menuOpen(), true);
  assert.equal(strip.state().menuOpen, true);
  assert.equal(strip.state().menuTarget, NOTE_C, "the menu is bound to the operated tab, not the active one");
  assert.equal(strip.menu.getAttribute("data-tab-menu-target"), NOTE_C);
  assert.match(strip.menu.getAttribute("aria-label"), /^C：/, "the menu announces the tab it will act on");
  assert.deepEqual(
    strip.menu.querySelectorAll("[data-tab-action]").map((node) => [node.getAttribute("data-tab-action"), node.textContent, node.getAttribute("role"), node.getAttribute("type")]),
    ACTION_LABELS.map(([action, label]) => [action, label, "menuitem", "button"]),
  );
  assert.deepEqual(
    ACTION_LABELS.map(([action]) => strip.item(action).disabled),
    [false, false, false, false, false],
    "with four tabs every action really removes something",
  );
});

test("#429: an action is enabled exactly while its plan removes a tab; the menu never offers a fake close", () => {
  const single = mount();
  single.setStrip([NOTE_A], NOTE_A);
  single.contextMenu(single.mainFor(NOTE_A));
  assert.deepEqual(ACTION_LABELS.map(([action]) => single.item(action).disabled), [false, true, true, true, false]);
  assert.deepEqual(ACTION_LABELS.map(([action]) => single.item(action).getAttribute("aria-disabled")), ["false", "true", "true", "true", "false"]);

  const first = mount();
  first.setStrip([NOTE_A, NOTE_B, NOTE_C], NOTE_A);
  first.contextMenu(first.mainFor(NOTE_A));
  assert.deepEqual(ACTION_LABELS.map(([action]) => first.item(action).disabled), [false, false, true, false, false], "nothing is left of the first tab");

  const last = mount();
  last.setStrip([NOTE_A, NOTE_B, NOTE_C], NOTE_A);
  last.contextMenu(last.mainFor(NOTE_C));
  assert.deepEqual(ACTION_LABELS.map(([action]) => last.item(action).disabled), [false, false, false, true, false], "nothing is right of the last tab");
});

test("#429: Close Others on a background tab navigates to it and commits one new list", async () => {
  const strip = mount();
  strip.setStrip([NOTE_A, NOTE_B, NOTE_C, NOTE_D], NOTE_A);
  // The user was typing in A: the pointer-opened menu must not take that focus away.
  strip.local.document.activeElement = strip.local.document.querySelector("textarea");
  const editor = strip.focused();
  strip.contextMenu(strip.mainFor(NOTE_B));
  await strip.pick("close-others");
  assert.deepEqual(strip.opens, [NOTE_B], "the kept tab is opened through the ordinary flow");
  assert.deepEqual(strip.welcomes, [], "no welcome transition is involved");
  assert.deepEqual(strip.paths(), [NOTE_B]);
  assert.equal(strip.state().activeIndex, 0);
  assert.deepEqual(strip.stripChanges.at(-1), [NOTE_B], "exactly one committed list reaches the row mirror");
  assert.equal(strip.menuOpen(), false, "picking an action closes the menu");
  assert.equal(strip.focused(), editor, "a pointer pick gives the editor its focus back instead of the strip");
});

test("#429: a background-only batch removes tabs without navigating, asking the guard or moving focus", async () => {
  const strip = mount();
  strip.setStrip([NOTE_A, NOTE_B, NOTE_C, NOTE_D], NOTE_A);
  strip.local.document.activeElement = strip.local.document.querySelector("textarea");
  const before = strip.focused();
  strip.contextMenu(strip.mainFor(NOTE_B));
  await strip.pick("close-right");
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B], "Close Right on B removed C and D");
  assert.deepEqual(strip.opens, [], "the document on screen is not reopened");
  assert.deepEqual(strip.welcomes, []);
  assert.equal(strip.state().activeIndex, 0);
  assert.equal(strip.focused(), before, "the editor keeps the focus it had");
});

test("#429: a refused dirty guard removes zero tabs, keeps the document and the focus", async () => {
  const strip = mount({ openResult: false });
  strip.setStrip([NOTE_A, NOTE_B, NOTE_C, NOTE_D], NOTE_A);
  strip.local.document.activeElement = strip.local.document.querySelector("textarea");
  strip.contextMenu(strip.mainFor(NOTE_D));
  await strip.pick("close-others");
  assert.deepEqual(strip.opens, [NOTE_D], "the guard was asked once, through the ordinary open flow");
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B, NOTE_C, NOTE_D], "no tab was removed by the refused batch");
  assert.equal(strip.state().activeIndex, 0, "the document on screen is untouched");
  assert.equal(strip.app.path, NOTE_A);
  assert.equal(strip.focused(), strip.local.document.querySelector("textarea"), "focus never moved to a tab");
  assert.equal(strip.menuOpen(), false, "and the menu is gone either way");
});

test("#429: Close All reaches the welcome transition only when a note is on screen", async () => {
  const withNote = mount();
  withNote.setStrip([NOTE_A, NOTE_B], NOTE_A);
  withNote.contextMenu(withNote.mainFor(NOTE_B));
  await withNote.pick("close-all");
  assert.deepEqual(withNote.welcomes, [true], "the app's in-app welcome transition owns the last close");
  assert.deepEqual(withNote.opens, [], "no note is opened to reach the welcome page");
  assert.deepEqual(withNote.paths(), []);
  assert.equal(withNote.state().activeIndex, -1);

  // A Base document is not a tab: closing every note tab must not push the Base to Welcome.
  const onBase = mount();
  onBase.setDocument(NOTE_A);
  onBase.setDocument(NOTE_B);
  onBase.setDocument("_Bases/Status.base", "base");
  onBase.contextMenu(onBase.mainFor(NOTE_A));
  await onBase.pick("close-all");
  assert.deepEqual(onBase.paths(), [], "the background note tabs are gone");
  assert.deepEqual(onBase.welcomes, [], "the Base document is not left for the welcome workspace");
  assert.equal(onBase.app.documentKind, "base", "the Base document stays on screen");
  assert.equal(onBase.state().activeIndex, -1);
});

test("#429: the menu is reachable and usable from the keyboard, and Escape restores the tab focus", async () => {
  const strip = mount();
  strip.setStrip([NOTE_A, NOTE_B, NOTE_C, NOTE_D], NOTE_A);
  strip.mainFor(NOTE_C).focus();
  const event = strip.press(strip.mainFor(NOTE_C), "F10", { shiftKey: true });
  assert.equal(event.defaultPrevented, true, "the strip owns Shift+F10");
  assert.equal(strip.menuOpen(), true);
  assert.equal(strip.state().menuTarget, NOTE_C);
  assert.equal(strip.focused(), strip.item("close"), "a keyboard open lands on the first enabled item");

  strip.local.document.dispatchEvent({ type: "keydown", key: "ArrowDown" });
  assert.equal(strip.focused(), strip.item("close-others"), "ArrowDown walks the enabled items");
  strip.local.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(strip.menuOpen(), false);
  assert.equal(strip.focused(), strip.mainFor(NOTE_C), "Escape hands focus back to the operated tab");
  assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B, NOTE_C, NOTE_D], "no action ran");

  // The ContextMenu key is the second keyboard entry, and it is red-free on its own.
  strip.mainFor(NOTE_D).focus();
  const key = strip.press(strip.mainFor(NOTE_D), "ContextMenu");
  assert.equal(key.defaultPrevented, true);
  assert.equal(strip.state().menuTarget, NOTE_D);
  strip.local.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(strip.focused(), strip.mainFor(NOTE_D), "the keyboard entry keeps the tab focus too");

  // A keyboard pick is the one pick that lands focus on the operated tab, and the strip's own
  // close policy then keeps it there when the batch keeps that tab (Close Others on C).
  strip.mainFor(NOTE_C).focus();
  strip.press(strip.mainFor(NOTE_C), "F10", { shiftKey: true });
  assert.equal(strip.focused(), strip.item("close"));
  strip.pickItem("close-others");
  await strip.settle();
  assert.deepEqual(strip.paths(), [NOTE_C]);
  assert.equal(strip.state().activeIndex, 0);
  assert.equal(strip.focused(), strip.mainFor(NOTE_C), "focus, the kept tab and the document agree");
  strip.controller.destroy();
});

test("#429: a held touch press opens the same menu, and the click it would become is swallowed", async () => {
  const timers = installTimerRecorder();
  try {
    const strip = mount();
    strip.setStrip([NOTE_A, NOTE_B, NOTE_C], NOTE_A);
    // A desktop pointer never arms the gesture: it has a real right button.
    strip.pointer("pointerdown", strip.mainFor(NOTE_B), { pointerType: "mouse" });
    assert.equal(timers.pending(), 0);
    // A scroll (movement past the slop) and a lift both cancel it.
    strip.pointer("pointerdown", strip.mainFor(NOTE_B));
    assert.deepEqual(timers.delays(), [500]);
    strip.pointer("pointermove", strip.mainFor(NOTE_B), { clientX: 12 + 20 });
    assert.equal(timers.pending(), 0, "a scrolling finger cancels the press");
    strip.pointer("pointerdown", strip.mainFor(NOTE_B));
    strip.pointer("pointerup", strip.mainFor(NOTE_B));
    assert.equal(timers.pending(), 0, "a short tap is not a long press");
    // A held press opens the menu for that tab …
    strip.pointer("pointerdown", strip.mainFor(NOTE_B), { clientX: 12, clientY: 24 });
    timers.runAll();
    assert.equal(strip.menuOpen(), true);
    assert.equal(strip.state().menuTarget, NOTE_B);
    // … and the click that follows the lift must not also switch the document.
    strip.click(strip.mainFor(NOTE_B));
    assert.deepEqual(strip.opens, [], "the long press does not turn into a tab activation");
    // The next, real click still works (the suppression is one-shot).
    strip.click(strip.mainFor(NOTE_B));
    await strip.settle();
    assert.deepEqual(strip.opens, [NOTE_B]);
    strip.controller.destroy();
  } finally {
    timers.restore();
  }
});

test("#429: the primitive owns the dismissal (outside click, Escape, scroll/resize focus policy)", async () => {
  const strip = mount();
  strip.setStrip([NOTE_A, NOTE_B], NOTE_A);
  const outside = strip.local.createElement("div");
  strip.local.document.body.append(outside);

  const counts = new Map();
  const track = (method) => {
    const original = strip.local.document[method];
    strip.local.document[method] = (type, listener, ...rest) => {
      counts.set(type, (counts.get(type) ?? 0) + (method === "addEventListener" ? 1 : -1));
      return original.call(strip.local.document, type, listener, ...rest);
    };
    return original;
  };
  const originalAdd = track("addEventListener");
  const originalRemove = track("removeEventListener");
  const net = () => [...counts.values()].reduce((sum, value) => sum + value, 0);

  strip.contextMenu(strip.mainFor(NOTE_B), { clientX: 0, clientY: 0 });
  assert.ok(net() > 0, "an open menu installs its document listeners");
  strip.local.document.dispatchEvent({ type: "pointerdown", target: outside });
  assert.equal(strip.menuOpen(), false, "a pointer press outside closes the menu");
  assert.equal(net(), 0, "and releases every listener it installed");

  strip.contextMenu(strip.mainFor(NOTE_B));
  strip.local.document.dispatchEvent({ type: "scroll" });
  assert.equal(strip.menuOpen(), false, "a scroll moves the anchor away, so the menu leaves");
  assert.equal(net(), 0);

  // A `resize` is dispatched at the window, never at the document: the primitive resolves its
  // resize target from `document.defaultView`, exactly as a browser exposes it, and releases
  // that listener together with the document ones.
  const windowListeners = new Map();
  const fakeWindow = {
    addEventListener: (type) => windowListeners.set(type, (windowListeners.get(type) ?? 0) + 1),
    removeEventListener: (type) => windowListeners.set(type, (windowListeners.get(type) ?? 0) - 1),
  };
  const withWindow = mount();
  withWindow.setStrip([NOTE_A, NOTE_B], NOTE_A);
  withWindow.local.document.defaultView = fakeWindow;
  withWindow.contextMenu(withWindow.mainFor(NOTE_B));
  assert.equal(windowListeners.get("resize"), 1, "an open positional menu listens for the window resize");
  withWindow.local.document.dispatchEvent({ type: "pointerdown", target: withWindow.local.document.body });
  assert.equal(withWindow.menuOpen(), false, "a press outside the popup closes it");
  assert.equal(windowListeners.get("resize"), 0, "and the window listener is released with the rest");

  // A tab the menu was operating on that disappears under it closes the menu instead of
  // offering an action for a path that is gone.
  strip.contextMenu(strip.mainFor(NOTE_B));
  const closeButton = strip.rows()[1].querySelector(".document-tab-close");
  strip.click(closeButton);
  await strip.settle();
  assert.deepEqual(strip.paths(), [NOTE_A]);
  assert.equal(strip.menuOpen(), false, "the menu follows the list it was planned against");
  strip.local.document.addEventListener = originalAdd;
  strip.local.document.removeEventListener = originalRemove;
  strip.controller.destroy();
});

test("#429: one in-flight batch at a time; a batch planned against a moved list fails closed", async () => {
  const held = mount({ holdOpen: true });
  held.setStrip([NOTE_A, NOTE_B, NOTE_C], NOTE_A);
  held.contextMenu(held.mainFor(NOTE_C));
  held.pickItem("close-others");
  await held.settle();
  assert.deepEqual(held.opens, [NOTE_C], "the batch is waiting on the navigation");
  // A second pick while the first batch is in flight must not run a second close.
  held.contextMenu(held.mainFor(NOTE_C));
  held.pickItem("close-all");
  await held.settle();
  assert.equal(held.opens.length, 1, "the double pick ran the batch once");
  assert.deepEqual(held.paths(), [NOTE_A, NOTE_B, NOTE_C], "nothing was removed while the navigation was open");
  held.releases.forEach((release) => release());
  await held.settle();
  await held.settle();
  assert.deepEqual(held.paths(), [NOTE_C], "the first batch committed exactly its own plan");

  const stale = mount({ holdOpen: true });
  stale.setStrip([NOTE_A, NOTE_B, NOTE_C], NOTE_A);
  stale.contextMenu(stale.mainFor(NOTE_C));
  stale.pickItem("close-others");
  await stale.settle();
  // The list moves while the navigation is in flight (another close / an SSE-driven open).
  stale.setDocument(NOTE_E);
  stale.releases.forEach((release) => release());
  await stale.settle();
  await stale.settle();
  assert.deepEqual(stale.paths(), [NOTE_A, NOTE_B, NOTE_C, NOTE_E], "a stale batch removes nothing at all");
  assert.equal(stale.menuOpen(), false);
});

test("#429: a pick after the held press runs the same batch (the touch path end to end)", async () => {
  const timers = installTimerRecorder();
  try {
    const strip = mount();
    strip.setStrip([NOTE_A, NOTE_B], NOTE_B);
    strip.pointer("pointerdown", strip.mainFor(NOTE_A));
    timers.runAll();
    assert.equal(strip.menuOpen(), true, "the held press opened the menu for the pressed background tab");
    // The browser then lifts the finger (its click is swallowed) and taps the menu item.
    strip.pointer("pointerup", strip.mainFor(NOTE_A));
    strip.click(strip.mainFor(NOTE_A));
    await strip.settle();
    assert.deepEqual(strip.opens, [], "the tail click of the gesture never selects the tab");
    strip.pickItem("close-others");
    await strip.settle();
    assert.deepEqual(strip.opens, [NOTE_A], "the tapped action navigates to the kept tab");
    assert.deepEqual(strip.paths(), [NOTE_A], "and commits the whole new list once");
    assert.equal(strip.state().activeIndex, 0);
    assert.equal(strip.menuOpen(), false);
  } finally {
    timers.restore();
  }
});

test("#429: the menu is the #407 primitive, not a second interaction machine", async () => {
  const [menuSource, viewSource, indexSource] = await Promise.all([
    fs.readFile(new URL("../frontend/app/features/tabs/menu.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../frontend/app/features/tabs/view.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../frontend/app/features/tabs/index.js", import.meta.url), "utf8"),
  ]);
  assert.match(menuSource, /import \{ createPopupMenuController \} from "\.\.\/\.\.\/ui\/popup-menu\.js"/);
  assert.match(menuSource, /import \{ applyPopupLayout, computePopupLayout \} from "\.\.\/\.\.\/ui\/popup-position\.js"/);
  assert.match(menuSource, /attachTrigger: false/, "a role=tab anchor is not a disclosure trigger");
  assert.match(menuSource, /dismissOnViewportChange: true/, "a positional popup leaves when its anchor moves");
  // The strip never grows its own dismissal/focus machinery: no Escape, no outside-click
  // listener, no `hidden`/`aria-expanded` writer in the gesture surface.
  assert.doesNotMatch(viewSource, /Escape/);
  assert.doesNotMatch(viewSource, /classList\.toggle\("hidden"|\.hidden\s*=|aria-expanded/);
  // One commit per action: no loop of single closes inside the strip controller.
  assert.doesNotMatch(indexSource, /for\s*\([^)]*\)\s*\{[^}]*close\(/);
  assert.match(indexSource, /model\.commitBulk\(plan, \{ activate: getCurrentPath\(\) \}\);/, "a batch commits once, keyed on the committed identity");
  assert.match(indexSource, /if \(!model\.samePaths\(plan\.basis\)\) return false;/, "a stale plan fails closed");
});

test("#429 negative control: a loop of single closes is red for the zero-removal invariant", async () => {
  // The pre-#429 shape: run the same product action as a loop of single closes. The twin uses
  // the shipped model/planner and a real refusal, so the only difference is the loop.
  const strip = mount({ openResult: false });
  strip.setStrip([NOTE_A, NOTE_B, NOTE_C, NOTE_D], NOTE_A);
  const model = strip.controller.getState();
  assert.deepEqual(model.tabs.map((tab) => tab.path), [NOTE_A, NOTE_B, NOTE_C, NOTE_D]);
  const loop = async () => {
    // Close Others on D, index by index, in the order a naive implementation would walk them.
    for (const index of [1, 2, 0]) {
      strip.click(strip.rows()[index].querySelector(".document-tab-close"));
      await strip.settle();
    }
  };
  await loop();
  let caught = null;
  try {
    assert.deepEqual(strip.paths(), [NOTE_A, NOTE_B, NOTE_C, NOTE_D], "a refused batch removes zero tabs");
  } catch (error) {
    caught = error;
  }
  assert.ok(isAssertionError(caught), `the invariant must be red for the loop shape, got ${caught}`);
  assert.ok(strip.paths().length < 4, `the loop really left a half-applied strip: ${JSON.stringify(strip.paths())}`);
});
