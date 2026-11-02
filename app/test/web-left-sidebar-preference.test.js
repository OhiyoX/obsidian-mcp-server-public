// #420: the left docked pane's persisted visibility preference.
//
// Split out of `web-left-sidebar-panels.test.js` when the #420 cases pushed that file past the
// architecture line budget. This file owns the preference contract — the key literal, the
// desktop remember/restore round trip, the drawer-mode write suppression and the viewport-change
// restore — while the parent file keeps the U4/U6 panel-chrome contract. The assertion shapes
// mirror the right rail's cases in `web-right-rail-topbar.test.js` one by one, because the two
// docked panes share one contract (`obsidian-web.explorer-open` / `obsidian-web.context-open`).
import assert from "node:assert/strict";
import test from "node:test";
import { initializeSidebarPanels } from "../frontend/app/features/explorer/sidebar-panels.js";

// Persisted-preference contract: the literal is on purpose, because a rename silently loses the
// user's saved choice across reloads (the same pin the right rail uses for its own key).
const EXPLORER_OPEN_KEY = "obsidian-web.explorer-open";

const desktopMedia = () => ({ matches: false });
const narrowMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });

// The same minimal store the right-rail tests install (Node has no `localStorage`); handing the
// same instance to two harnesses is how a "reload" is modelled.
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

// The element shim of the parent file, reduced to what the layout tests touch.
function makeElement(name, doc) {
  const attrs = new Map();
  const classes = new Set();
  const listeners = new Map();
  const element = {
    nodeName: String(name).toUpperCase(),
    dataset: {},
    hidden: false,
    ownerDocument: doc,
    get className() { return [...classes].join(" "); },
    classList: {
      add(...tokens) { for (const token of tokens) classes.add(token); },
      remove(...tokens) { for (const token of tokens) classes.delete(token); },
      contains(token) { return classes.has(token); },
      toggle(token, force) {
        const next = force === undefined ? !classes.has(token) : Boolean(force);
        if (next) classes.add(token); else classes.delete(token);
        return next;
      },
    },
    setAttribute(key, value) { attrs.set(key, String(value)); },
    getAttribute(key) { return attrs.has(String(key)) ? attrs.get(String(key)) : null; },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    querySelectorAll: () => [],
  };
  element.__fire = (type) => listeners.get(type)?.({ preventDefault() {} });
  return element;
}

function buildChrome({ storage = memoryStorage() } = {}) {
  globalThis.localStorage = storage;
  const doc = { createElement: (name) => makeElement(name, doc) };
  const shell = makeElement("div", doc);
  const filesToggle = makeElement("button", doc);
  const tabs = [
    Object.assign(makeElement("button", doc), { dataset: { sidebarTab: "files" } }),
    Object.assign(makeElement("button", doc), { dataset: { sidebarTab: "search" } }),
  ];
  const registry = new Map([["[data-sidebar-tab]", tabs]]);
  const root = {
    querySelectorAll: (selector) => registry.get(selector) ?? [],
    querySelector: () => null,
  };
  return { root, shell, filesToggle, tabs, storage };
}

const wire = (chrome, matchMedia) => initializeSidebarPanels({
  root: chrome.root,
  shell: chrome.shell,
  filesToggle: chrome.filesToggle,
  matchMedia,
});

// Same assertion shape as the right rail's "the layout toggle collapses the rail from outside it,
// and restores it": the docked pane collapses, remembers it, and restores it through the one write
// path, while switching views never moves the layout.
test("#420: the docked collapse is remembered and the ribbon toggle restores it", () => {
  const chrome = buildChrome();
  const panels = wire(chrome, desktopMedia);
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), false, "with no preference the docked pane starts open");
  assert.equal(chrome.filesToggle.classList.contains("active"), true, "the ribbon toggle reports the open pane");

  // The active tab collapses (U4, unchanged) and that collapse is now remembered.
  chrome.tabs[0].__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), true, "clicking the active tab collapses the sidebar");
  assert.equal(chrome.filesToggle.classList.contains("active"), false, "the ribbon toggle follows the same state");
  assert.equal(panels.currentView(), "files", "collapsing does not change the selected view");
  assert.equal(chrome.storage.getItem(EXPLORER_OPEN_KEY), "false", "the collapse is remembered");

  // The ribbon toggle restores it — from outside the pane it hides.
  chrome.filesToggle.__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), false, "the ribbon toggle restores the sidebar");
  assert.equal(chrome.filesToggle.classList.contains("active"), true);
  assert.equal(chrome.storage.getItem(EXPLORER_OPEN_KEY), "true", "restoring is remembered too");
  chrome.tabs[1].__fire("click");
  assert.equal(panels.currentView(), "search", "switching views does not collapse the sidebar");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), false);

  chrome.filesToggle.__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), true, "the ribbon toggle really hides the docked pane");
  assert.equal(chrome.storage.getItem(EXPLORER_OPEN_KEY), "false");
  panels.destroy();
});

test("#420: a reload follows the stored preference, and an absent key still means open", () => {
  const store = memoryStorage();
  const first = buildChrome({ storage: store });
  const firstPanels = wire(first, desktopMedia);
  first.filesToggle.__fire("click");
  assert.equal(first.shell.classList.contains("sidebar-hidden"), true);
  assert.equal(store.getItem(EXPLORER_OPEN_KEY), "false", "the collapse is the only thing persisted");
  firstPanels.destroy();

  // A reload: the same browser storage, a fresh document and a fresh controller.
  const reloaded = buildChrome({ storage: store });
  wire(reloaded, desktopMedia);
  assert.equal(reloaded.shell.classList.contains("sidebar-hidden"), true, "the reload keeps the collapsed pane collapsed");
  assert.equal(reloaded.filesToggle.classList.contains("active"), false, "and the toggle mirror agrees with it");

  // The default stays open: no key, or any value that is not the exact string "false".
  const pristine = buildChrome({ storage: memoryStorage() });
  wire(pristine, desktopMedia);
  assert.equal(pristine.shell.classList.contains("sidebar-hidden"), false, "no preference means the docked pane is open");
  assert.equal(pristine.filesToggle.classList.contains("active"), true);
  const storedTrue = buildChrome({ storage: memoryStorage({ [EXPLORER_OPEN_KEY]: "true" }) });
  wire(storedTrue, desktopMedia);
  assert.equal(storedTrue.shell.classList.contains("sidebar-hidden"), false, "a stored \"true\" reopens the pane");
});

// Same assertion shape as the right rail's "on a narrow viewport the layout toggle opens the drawer
// and the active tab closes it", plus the #420 rule that a temporary drawer is not a docked choice:
// the `<=720px` drawer never writes the desktop preference.
test("#420: on a narrow viewport the drawer policy owns the pane and no preference is written", () => {
  const storage = memoryStorage();
  const chrome = buildChrome({ storage });
  wire(chrome, narrowMedia);
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), false, "drawer mode clears the docked-hidden class");
  assert.equal(chrome.shell.classList.contains("sidebar-open"), false, "and never opens a drawer from the preference");
  assert.equal(storage.getItem(EXPLORER_OPEN_KEY), null, "booting in drawer mode writes no preference");

  chrome.filesToggle.__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-open"), true, "the ribbon toggle opens the drawer");
  assert.equal(chrome.filesToggle.classList.contains("active"), true);
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), false, "a drawer is not a docked collapse");
  assert.equal(storage.getItem(EXPLORER_OPEN_KEY), null, "opening the drawer writes no preference");

  chrome.filesToggle.__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-open"), false, "the ribbon toggle closes the drawer again");
  assert.equal(chrome.filesToggle.classList.contains("active"), false);
  chrome.filesToggle.__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-open"), true, "the ribbon toggle re-opens it");

  chrome.tabs[0].__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-open"), false, "clicking the active tab closes the drawer");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), false, "and it never leaves the docked class behind");
  assert.equal(storage.getItem(EXPLORER_OPEN_KEY), null, "closing the drawer writes no preference either");
});

test("#420: a viewport change keeps the drawer temporary and restores the docked choice", () => {
  const storage = memoryStorage({ [EXPLORER_OPEN_KEY]: "false" });
  const chrome = buildChrome({ storage });
  const media = {
    matches: false,
    handlers: new Set(),
    addEventListener(type, handler) { if (type === "change") this.handlers.add(handler); },
    removeEventListener(type, handler) { if (type === "change") this.handlers.delete(handler); },
  };
  const fire = () => { for (const handler of media.handlers) handler({ matches: media.matches }); };
  const panels = wire(chrome, () => media);
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), true, "the docked pane starts from the stored collapse");
  assert.equal(chrome.filesToggle.classList.contains("active"), false);

  // Entering drawer mode: the docked class goes away and nothing is written.
  media.matches = true;
  fire();
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), false, "drawer mode owns the pane");
  assert.equal(chrome.shell.classList.contains("sidebar-open"), false, "and starts from both drawers closed");
  assert.equal(storage.getItem(EXPLORER_OPEN_KEY), "false", "the desktop preference survives the phone viewport");
  chrome.filesToggle.__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-open"), true);
  assert.equal(storage.getItem(EXPLORER_OPEN_KEY), "false", "and an open phone drawer never overwrites it");

  // Leaving drawer mode restores the remembered desktop choice.
  media.matches = false;
  fire();
  assert.equal(chrome.shell.classList.contains("sidebar-open"), false, "no drawer class survives the desktop layout");
  assert.equal(chrome.shell.classList.contains("sidebar-hidden"), true, "the remembered collapse comes back");
  assert.equal(chrome.filesToggle.classList.contains("active"), false);
  panels.destroy();
});

// The note-open path (`core/app.js`) closes the mobile files drawer by removing the class directly,
// so the narrow toggle must read the real DOM instead of a mirror that path cannot update.
test("#420: a drawer closed from outside still toggles open on the next click", () => {
  const chrome = buildChrome();
  wire(chrome, narrowMedia);
  chrome.filesToggle.__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-open"), true, "the drawer opens");
  // `openNote` in core/app.js: the class leaves without going through this module.
  chrome.shell.classList.remove("sidebar-open");
  chrome.filesToggle.__fire("click");
  assert.equal(chrome.shell.classList.contains("sidebar-open"), true, "the next click opens the drawer, not closes it");
});
