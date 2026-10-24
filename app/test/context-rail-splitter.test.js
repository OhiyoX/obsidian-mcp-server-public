// Frontend tests for the U3 right-rail height splitter (user-requested Web enhancement).
//
// Covers: the real `pages.js` markup (the splitter sits between the two outgoing
// sections and carries the separator semantics), the pointer drag + keyboard nudge,
// the min-height clamp, the localStorage round trip with junk fallback,
// re-application once the view is laid out, and the absence of listener leaks
// (including a drag that is still open when the host is destroyed).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { attachNoteContext } from "../frontend/app/features/context/attach-note-context.js";
import {
  KEYBOARD_STEP,
  MIN_FIRST_SECTION,
  MIN_SECOND_SECTION,
  STORAGE_KEY,
  createContextRailSplitter,
} from "../frontend/app/features/context/rail-splitter.js";

const dom = createDomHarness();
dom.install();

const PANEL = 600;
const HEADER = 40; // --pane-header-height on the desktop layout
const SPLITTER = 7;
const LIST = 250;
const RESIZING_CLASS = "is-resizing-rail";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
}

// Records the window-level listeners a drag/resize hook installs, so the tests can
// drive them and assert they are gone after destroy.
function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    emit(type, payload = {}) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler({ type, ...payload });
    },
    listenerCount(type) { return (listeners.get(type) ?? []).length; },
    total() { return [...listeners.values()].reduce((sum, list) => sum + list.length, 0); },
  };
}

function fakeResizeObserver() {
  const observers = [];
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
    trigger() { this.callback([], this); }
  }
  return { FakeResizeObserver, observers };
}

function setHeight(element, height) {
  element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: height, width: 300, height, x: 0, y: 0 });
}

function sectionHeader(name) {
  const header = dom.createElement("header");
  header.className = "context-header context-section-header";
  header.setAttribute("data-context-section", name);
  return header;
}

// Mirror of the real outgoing panel: header -> list -> splitter -> header -> list.
function mountPanel({
  panelHeight = PANEL,
  firstHeader = HEADER,
  secondHeader = HEADER,
  splitterHeight = SPLITTER,
  listHeight = LIST,
  hidden = false,
} = {}) {
  const panel = dom.createElement("section");
  panel.id = "context-view-outgoing";
  panel.className = "context-view";
  panel.setAttribute("data-context-view-panel", "outgoing");
  panel.hidden = hidden;

  const first = sectionHeader("outgoing");
  const list = dom.createElement("nav");
  list.id = "outgoing-list";
  list.className = "outline-list outgoing-list";
  const handle = dom.createElement("div");
  handle.id = "context-rail-splitter";
  handle.className = "context-rail-splitter";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "horizontal");
  handle.setAttribute("aria-label", "调整「链接」与「潜在链接」的高度");
  handle.setAttribute("tabindex", "0");
  const second = sectionHeader("unlinked");
  const unlinked = dom.createElement("nav");
  unlinked.id = "unlinked-list";
  unlinked.className = "outline-list unlinked-list";

  panel.append(first, list, handle, second, unlinked);
  dom.document.body.replaceChildren(panel);

  // Geometry is injected: the harness has no layout engine.
  panel.getBoundingClientRect = () => {
    const height = panel.hidden ? 0 : panelHeight;
    return { left: 0, top: 0, right: 300, bottom: height, width: 300, height, x: 0, y: 0 };
  };
  setHeight(first, firstHeader);
  setHeight(list, listHeight);
  setHeight(handle, splitterHeight);
  setHeight(second, secondHeader);
  return { panel, first, list, handle, second, unlinked };
}

const attach = (fixture, options = {}) => createContextRailSplitter({
  documentRef: dom.document,
  panel: fixture.panel,
  handle: fixture.handle,
  firstList: fixture.list,
  secondHeader: fixture.second,
  resizeObserver: fakeResizeObserver().FakeResizeObserver,
  ...options,
});

const pointerDown = (handle, clientY, pointerId = 1) => handle.dispatchEvent({ type: "pointerdown", clientY, button: 0, pointerId });
const pointerMove = (win, clientY) => win.emit("pointermove", { clientY });
const pointerUp = (win) => win.emit("pointerup");

// --- real shell markup ------------------------------------------------------

test("the shell puts the splitter between the link list and the unlinked section", async () => {
  const { appPage } = await import("../src/app/pages.js");
  const page = appPage({ username: "owner", displayName: "Owner", csrf: "csrf-token" }, {});

  const listIndex = page.indexOf('id="outgoing-list"');
  const splitIndex = page.indexOf('id="context-rail-splitter"');
  const secondIndex = page.indexOf('data-context-section="unlinked"');
  const unlinkedIndex = page.indexOf('id="unlinked-list"');
  assert.ok(listIndex > 0 && splitIndex > listIndex, "the splitter follows the outgoing list");
  assert.ok(secondIndex > splitIndex && unlinkedIndex > secondIndex, "the unlinked section follows the splitter");

  const tag = page.slice(page.lastIndexOf("<div", splitIndex), page.indexOf(">", splitIndex) + 1);
  assert.match(tag, /class="context-rail-splitter"/);
  assert.match(tag, /role="separator"/);
  assert.match(tag, /aria-orientation="horizontal"/);
  assert.match(tag, /aria-label="调整「链接」与「潜在链接」的高度"/);
  assert.match(tag, /tabindex="0"/);
});

test("the splitter styles pin a row-resize affordance and an accent hover state", async () => {
  const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
  const start = css.indexOf(".context-rail-splitter {");
  assert.ok(start > 0, "the splitter rule exists");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /cursor:\s*row-resize/);
  assert.match(rule, /touch-action:\s*none/);
  const hover = css.indexOf(".context-rail-splitter:hover::before");
  assert.ok(hover > start, "the hover rule exists");
  assert.match(css.slice(hover, css.indexOf("}", hover)), /--interactive-accent/);
});

// --- drag + persistence -----------------------------------------------------

test("a pointer drag resizes the first section and remembers it", () => {
  const storage = memoryStorage();
  const win = fakeWindow();
  const fixture = mountPanel();
  const splitter = attach(fixture, { storage, windowRef: win });

  assert.equal(splitter.isWired, true);
  assert.equal(splitter.getValue(), null, "an unset split leaves the CSS default in place");
  assert.equal(fixture.list.style.flex, undefined);
  // The a11y values still describe the rendered split, even before any preference.
  assert.equal(fixture.handle.getAttribute("aria-valuenow"), String(LIST));
  assert.equal(fixture.handle.getAttribute("aria-valuemin"), "80");
  assert.equal(fixture.handle.getAttribute("aria-valuemax"), "473");

  // Below the drag threshold nothing moves: a click on the handle must not resize.
  pointerDown(fixture.handle, 100);
  pointerMove(win, 102);
  assert.equal(splitter.getValue(), null);
  assert.equal(win.listenerCount("pointerup"), 1, "the drag window is live");

  pointerMove(win, 140);
  assert.equal(splitter.getValue(), LIST + 40, "the list height follows the pointer delta");
  assert.equal(fixture.list.style.flex, "0 0 290px");
  assert.equal(fixture.handle.getAttribute("aria-valuenow"), "290");
  assert.equal(fixture.handle.getAttribute("aria-valuemin"), "80");
  assert.equal(fixture.handle.getAttribute("aria-valuemax"), "473");
  assert.equal(dom.document.body.classList.contains(RESIZING_CLASS), true, "the drag marks the body");
  assert.equal(storage.dump()[STORAGE_KEY], "290");

  pointerUp(win);
  assert.equal(win.total(), 0, "the drag listeners are released on pointerup");
  assert.equal(dom.document.body.classList.contains(RESIZING_CLASS), false);
  splitter.destroy();
});

test("a stored split is applied on reload, junk falls back to the default", () => {
  const fixture = mountPanel();
  const storage = memoryStorage({ [STORAGE_KEY]: "320" });
  const splitter = attach(fixture, { storage });
  assert.equal(splitter.getStored(), 320);
  assert.equal(splitter.getValue(), 320, "reload restores the remembered split");
  assert.equal(fixture.list.style.flex, "0 0 320px");
  splitter.destroy();

  for (const junk of ["abc", "", "-5", "NaN", "null"]) {
    const host = mountPanel();
    const junkSplitter = attach(host, { storage: memoryStorage({ [STORAGE_KEY]: junk }) });
    assert.equal(junkSplitter.getStored(), null, `${JSON.stringify(junk)} falls back`);
    assert.equal(junkSplitter.getValue(), null, `${JSON.stringify(junk)} leaves the default`);
    assert.equal(host.list.style.flex, undefined);
    junkSplitter.destroy();
  }
});

test("a stored split outside the current range is clamped, not applied verbatim", () => {
  const fixture = mountPanel();
  const splitter = attach(fixture, { storage: memoryStorage({ [STORAGE_KEY]: "99999" }) });
  const { hi } = splitter.metrics();
  assert.equal(splitter.getStored(), 99999, "the preference itself is kept");
  assert.equal(splitter.getValue(), hi, "the applied value is clamped");
  assert.ok(hi < 99999);
  assert.equal(fixture.list.style.flex, `0 0 ${hi}px`);
  splitter.destroy();
});

// --- clamping ---------------------------------------------------------------

test("dragging past either end stops at the section minimums", () => {
  const win = fakeWindow();
  const fixture = mountPanel();
  const splitter = attach(fixture, { storage: memoryStorage(), windowRef: win });

  pointerDown(fixture.handle, 100);
  pointerMove(win, 100 + 4000);
  const { hi } = splitter.metrics();
  assert.equal(splitter.getValue(), hi, "the drag clamps to the maximum");
  assert.equal(PANEL - HEADER - hi - SPLITTER, MIN_SECOND_SECTION, "the unlinked section keeps its minimum");
  assert.ok(HEADER + hi >= MIN_FIRST_SECTION);
  splitter.destroy();

  const down = mountPanel();
  const win2 = fakeWindow();
  const splitter2 = attach(down, { storage: memoryStorage({ [STORAGE_KEY]: "400" }), windowRef: win2 });
  pointerDown(down.handle, 500, 2);
  pointerMove(win2, 500 - 4000);
  const { lo } = splitter2.metrics();
  assert.equal(splitter2.getValue(), lo, "the drag clamps to the minimum");
  assert.equal(HEADER + lo, MIN_FIRST_SECTION, "the link section keeps its minimum height");
  splitter2.destroy();
});

// --- keyboard ---------------------------------------------------------------

test("ArrowUp/ArrowDown nudge the split by one step and persist it", () => {
  const storage = memoryStorage({ [STORAGE_KEY]: "250" });
  const fixture = mountPanel();
  const splitter = attach(fixture, { storage });

  fixture.handle.dispatchEvent({ type: "keydown", key: "ArrowDown" });
  assert.equal(splitter.getValue(), 250 + KEYBOARD_STEP);
  assert.equal(storage.dump()[STORAGE_KEY], String(250 + KEYBOARD_STEP));

  fixture.handle.dispatchEvent({ type: "keydown", key: "ArrowUp" });
  fixture.handle.dispatchEvent({ type: "keydown", key: "ArrowUp" });
  assert.equal(splitter.getValue(), 250 - KEYBOARD_STEP);
  assert.equal(storage.dump()[STORAGE_KEY], String(250 - KEYBOARD_STEP));

  const before = storage.dump()[STORAGE_KEY];
  fixture.handle.dispatchEvent({ type: "keydown", key: "Enter" });
  assert.equal(storage.dump()[STORAGE_KEY], before, "unrelated keys are ignored");
  splitter.destroy();
});

// --- layout + resilience ----------------------------------------------------

test("a hidden view is left untouched until it is laid out", () => {
  const fixture = mountPanel({ hidden: true });
  const splitter = attach(fixture, { storage: memoryStorage({ [STORAGE_KEY]: "300" }) });
  assert.equal(splitter.sync(), null, "no height while the panel is hidden");
  assert.equal(splitter.getValue(), null);
  assert.equal(fixture.list.style.flex, undefined);
  assert.equal(fixture.handle.getAttribute("aria-valuenow"), null, "no a11y range while the panel has no layout");

  fixture.panel.hidden = false; // the view switcher reveals the panel
  assert.equal(splitter.sync(), 300, "the stored split lands once the panel has height");
  assert.equal(fixture.list.style.flex, "0 0 300px");
  splitter.destroy();
});

test("a blocked storage degrades silently in both directions", () => {
  const throwing = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  const fixture = mountPanel();
  const splitter = attach(fixture, { storage: throwing });
  assert.equal(splitter.getStored(), null);
  assert.equal(splitter.setValue(300), 300, "the split still applies for this session");
  splitter.destroy();
});

test("a container shrink re-clamps the applied split via ResizeObserver", () => {
  const fixture = mountPanel();
  const { FakeResizeObserver, observers } = fakeResizeObserver();
  const splitter = attach(fixture, { storage: memoryStorage({ [STORAGE_KEY]: "400" }), resizeObserver: FakeResizeObserver });
  assert.equal(splitter.getValue(), 400);
  assert.equal(observers.length, 1, "the panel is observed");

  setHeight(fixture.panel, 300);
  observers[0].trigger();
  const { hi } = splitter.metrics();
  assert.ok(hi < 400, "the range shrank with the container");
  assert.equal(splitter.getValue(), hi, "the applied value is re-clamped");
  assert.equal(splitter.getStored(), 400, "the preference itself is preserved");
  splitter.destroy();
  assert.equal(observers[0].disconnected, true);
});

// --- listener hygiene -------------------------------------------------------

test("the module leaks no listener after destroy, including mid-drag", () => {
  const win = fakeWindow();
  const fixture = mountPanel();
  const splitter = attach(fixture, { storage: memoryStorage(), windowRef: win });
  assert.equal(win.total(), 0, "an idle splitter holds no window listener when ResizeObserver exists");

  pointerDown(fixture.handle, 100);
  pointerMove(win, 160);
  assert.ok(win.total() > 0, "a drag opens the pointer window");

  splitter.destroy();
  assert.equal(win.total(), 0, "destroy releases the open drag");
  assert.equal(dom.document.body.classList.contains(RESIZING_CLASS), false);

  const frozen = splitter.getValue();
  pointerDown(fixture.handle, 100, 3);
  fixture.handle.dispatchEvent({ type: "keydown", key: "ArrowDown" });
  assert.equal(splitter.getValue(), frozen, "a destroyed splitter ignores input");
  assert.equal(win.total(), 0);
});

test("without ResizeObserver the window resize fallback is removed on destroy", () => {
  const win = fakeWindow();
  const fixture = mountPanel();
  const splitter = attach(fixture, { storage: memoryStorage({ [STORAGE_KEY]: "260" }), windowRef: win, resizeObserver: null });
  assert.equal(win.listenerCount("resize"), 1, "the fallback listener is installed");
  assert.equal(splitter.getValue(), 260);
  splitter.destroy();
  assert.equal(win.listenerCount("resize"), 0);
});

test("the module stays element-scoped with no global listener and no raw HTML sink", async () => {
  const source = await fs.readFile(new URL("../frontend/app/features/context/rail-splitter.js", import.meta.url), "utf8");
  for (const forbidden of ["core/app.js", "features/editor", "features/explorer", "features/bases", "app/src/app/assets"]) {
    assert.equal(source.includes(forbidden), false, `rail-splitter.js must not reference ${forbidden}`);
  }
  assert.equal(/document\s*\.\s*addEventListener/.test(source), false);
  assert.equal(/window\s*\.\s*addEventListener/.test(source), false);
  assert.equal(/innerHTML/.test(source), false);
});

// --- attach integration -----------------------------------------------------

test("attachNoteContext wires the splitter and re-syncs it when the view is revealed", () => {
  const root = dom.createElement("aside");
  root.id = "context-sidebar";
  const top = dom.createElement("header");
  top.className = "context-header context-view-header";
  const buttons = ["outline", "outgoing"].map((name) => {
    const button = dom.createElement("button");
    button.className = "icon-btn context-view-btn";
    button.setAttribute("data-context-view", name);
    top.append(button);
    return button;
  });
  const outlinePanel = dom.createElement("section");
  outlinePanel.className = "context-view";
  outlinePanel.setAttribute("data-context-view-panel", "outline");

  const fixture = mountPanel({ hidden: true });
  root.append(top, outlinePanel, fixture.panel);
  dom.document.body.replaceChildren(root);

  const storage = memoryStorage({ [STORAGE_KEY]: "320" });
  const win = fakeWindow();
  const context = attachNoteContext({
    outgoingHost: fixture.list,
    incomingHost: null,
    openNote: () => {},
    storage,
    windowRef: win,
    loadTags: false,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ links: [] }) }),
  });

  assert.equal(context.splitter.isWired, true);
  assert.equal(context.splitter.getValue(), null, "hidden by default: nothing applied yet");
  context.view.setView("outgoing");
  assert.equal(fixture.panel.hidden, false);
  assert.equal(context.splitter.getValue(), 320, "revealing the view lands the stored split");
  assert.equal(fixture.list.style.flex, "0 0 320px");

  buttons[1].click();
  assert.equal(context.view.getView(), "outgoing");
  context.destroy();
  assert.equal(win.total(), 0);
});
