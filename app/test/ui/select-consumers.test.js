// U48 (#409) — the custom-select keyboard model at its real consumers.
//
// The unit contract lives in `test/ui/select.test.js`. This file drives the same control
// through the two entry points that enhance selects in the app, each with the real consumer
// wiring behind it:
//
//   1. the app shell's document-wide `enhanceSelects()` — the page-markup selects from
//      `src/app/pages.js`: the sidebar Vault selector (real `initializeVaultController`) and
//      the settings dialog's 颜色模式 / 主题 selects (real `initializeTheme`);
//   2. the Base surface's per-mount `enhanceSelects(root)` — the view selector built by
//      `features/bases/toolbar.js` (real `createBaseSurface`) and the `buildSelect` family in
//      the action panels (real `createBasePanels`).
//
// Every scenario is keyboard-only up to the final commit, and each one asserts the consumer's
// own observable effect (a POST body, a query URL, a theme class) rather than the control's
// internal state.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createDomHarness } from "../helpers/base-dom.mjs";
import { enhanceSelects } from "../../frontend/app/ui/select.js";
import { createBaseSurface } from "../../frontend/app/features/bases/index.js";
import { createBasePanels } from "../../frontend/app/features/bases/panels.js";
import { initializeVaultController } from "../../frontend/app/features/vault/controller.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;

const live = [];

const keyOn = (node, name) => node.dispatchEvent({ type: "keydown", key: name });
const key = (name) => document.dispatchEvent({ type: "keydown", key: name });
const focusOf = () => document.activeElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A spy payload, so a test can assert whether the control consumed the keystroke.
function spyKey(name) {
  const calls = { prevented: 0 };
  document.dispatchEvent({
    type: "keydown",
    key: name,
    preventDefault: () => { calls.prevented += 1; },
    stopPropagation: () => {},
  });
  return calls;
}

// The harness only fills an *undefined* event target and a real `Event`'s target is a
// read-only null, so `event.target === select` — which every consumer below relies on — has
// to be restored explicitly. A browser always sets it.
function withEventTarget(select) {
  const original = select.dispatchEvent;
  select.dispatchEvent = (event) => {
    if (event && typeof event === "object" && event.target == null) {
      try {
        Object.defineProperty(event, "target", { value: select, configurable: true });
      } catch { /* frozen event */ }
    }
    return original.call(select, event);
  };
  return () => { select.dispatchEvent = original; };
}

function findControl(wrapper) {
  return {
    wrapper,
    trigger: wrapper.querySelector(".select-trigger"),
    menu: wrapper.querySelector(".select-menu"),
    items: () => [...wrapper.querySelectorAll(".select-option")],
  };
}

// The wrapper is the select's own parent once the control is enhanced.
function controlOf(select) {
  return findControl(select.closest(".select-control"));
}

afterEach(() => {
  for (const handle of live.splice(0)) handle.destroy();
  document.activeElement = null;
  document.body.replaceChildren();
  delete globalThis.location;
  delete globalThis.matchMedia;
});

// --- consumer 1: the app shell's document-wide enhancement -------------------

const VAULTS = [
  { id: "vault-a", name: "Alpha Vault" },
  { id: "vault-b", name: "Beta Vault" },
  { id: "vault-c", name: "Gamma Vault" },
];

test("the sidebar Vault selector switches Vaults from the keyboard", async () => {
  const footer = document.createElement("div");
  footer.className = "sidebar-footer";
  const switcher = document.createElement("div");
  switcher.className = "vault-switcher";
  const label = document.createElement("label");
  label.className = "vault-label";
  const select = document.createElement("select");
  select.id = "vault-select";
  select.className = "vault-select";
  select.setAttribute("data-select", "");
  select.setAttribute("aria-label", "切换 Vault");
  label.append(select);
  switcher.append(label);
  footer.append(switcher);
  document.body.replaceChildren(footer);

  const calls = { posted: [], replaced: 0 };
  globalThis.location = { replace: () => { calls.replaced += 1; } };
  const restoreTarget = withEventTarget(select);
  const controller = initializeVaultController({
    api: async (url, options) => {
      if (url === "/api/web/v1/vaults") return { current: "vault-a", vaults: VAULTS, canCreate: true };
      calls.posted.push(JSON.parse(options.body));
      return {};
    },
    toast: () => {},
    session: {
      isDirty: () => false,
      setWritesSuspended: () => {},
      invalidateInFlightReads: () => {},
      whenSavesIdle: async () => {},
      statusFlags: () => ({}),
    },
    state: { vaultId: "vault-a" },
    lifecycle: { switching: false },
    saveButton: document.createElement("button"),
    vaultSelect: select,
    createButton: document.createElement("button"),
    abortOpen: () => {},
    abortRefresh: () => {},
    syncStatus: () => {},
  });
  live.push({ destroy: restoreTarget });

  await controller.load();
  // The shell enhances the whole document once, after the markup exists.
  const control = enhanceSelects(document);
  live.push(control);

  const { trigger, menu, items } = controlOf(select);
  assert.equal(trigger.firstElementChild.textContent, "Alpha Vault", "the current Vault is labelled");

  // Keyboard only: open on the selection, walk to the second Vault, commit with Enter.
  keyOn(trigger, "ArrowDown");
  assert.equal(menu.hidden, false);
  assert.equal(focusOf(), items()[0], "the keyboard open lands on the current Vault");
  key("ArrowDown");
  assert.equal(focusOf(), items()[1]);
  key("Enter");

  await tick();
  assert.deepEqual(calls.posted, [{ id: "vault-b" }], "the consumer saw the real select value");
  assert.equal(calls.replaced, 1, "and ran its own switch path");
  assert.equal(trigger.firstElementChild.textContent, "Beta Vault", "the trigger label followed");
  assert.equal(menu.hidden, true);

  // Escape is the same focus contract as everywhere else: close and hand the focus back.
  keyOn(trigger, "ArrowDown");
  const stopped = { count: 0 };
  document.dispatchEvent({
    type: "keydown",
    key: "Escape",
    preventDefault: () => {},
    stopPropagation: () => { stopped.count += 1; },
  });
  assert.equal(menu.hidden, true);
  assert.equal(focusOf(), trigger);
  assert.equal(stopped.count, 1, "the innermost layer owns Escape");
});

test("the settings selects (颜色模式 / 主题) commit through the real theme controller", async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const dialog = document.createElement("dialog");
  dialog.id = "settings-dialog";
  const modeLabel = document.createElement("label");
  const modeSelect = document.createElement("select");
  modeSelect.id = "color-mode";
  modeSelect.setAttribute("data-select", "");
  modeSelect.setAttribute("title", "颜色模式");
  for (const [value, text] of [["desktop", "桌面端"], ["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    modeSelect.append(option);
  }
  const themeLabel = document.createElement("label");
  const themeSelect = document.createElement("select");
  themeSelect.id = "theme-select";
  themeSelect.setAttribute("data-select", "");
  themeSelect.setAttribute("aria-label", "主题");
  const link = document.createElement("link");
  link.id = "community-theme";
  modeLabel.append(modeSelect);
  themeLabel.append(themeSelect);
  dialog.append(modeLabel, themeLabel, link);
  document.body.replaceChildren(dialog);

  const { initializeTheme } = await import("../../frontend/app/features/theme/theme.js");
  await initializeTheme({
    api: async () => ({
      themes: [{ id: "Things", name: "Things" }],
      defaultTheme: "Things",
      appearance: { themeId: "Things", colorMode: "system", baseFontSize: 16 },
    }),
    toast: () => {},
  });
  const control = enhanceSelects(document);
  live.push(control);

  // 颜色模式: open on the stored mode, walk to 深色, commit.
  const mode = controlOf(modeSelect);
  keyOn(mode.trigger, "ArrowDown");
  assert.equal(mode.trigger.getAttribute("aria-label"), "颜色模式", "the title carries over as the name");
  assert.equal(focusOf(), mode.items()[0]);
  key("ArrowDown");
  key("ArrowDown");
  key("ArrowDown");
  assert.equal(focusOf(), mode.items()[3]);
  key("Enter");
  assert.equal(modeSelect.value, "dark");
  assert.equal(document.documentElement.classList.contains("theme-dark"), true, "the real theme path ran");
  assert.equal(document.documentElement.classList.contains("theme-light"), false);

  // 主题: the same control shape over the theme list the controller rendered.
  const theme = controlOf(themeSelect);
  assert.equal(theme.items().length, 3, "跟随桌面端 / 默认主题 / Things");
  keyOn(theme.trigger, "Enter");
  assert.equal(focusOf(), theme.items()[0]);
  key("ArrowDown");
  key(" ");
  assert.equal(themeSelect.value, "", "the second entry is the Obsidian default theme");
  assert.equal(document.body.dataset.theme, "default");
});

// --- consumer 2: the Base surface's per-mount enhancement --------------------

const BASE_PATH = "40-Projects/Projects.base";
const ROUTE = "/app/base/r";

function basePage(overrides = {}) {
  return {
    vaultId: "vault-1",
    path: BASE_PATH,
    route: ROUTE,
    revision: "rev-1",
    views: [{ name: "Table", type: "table" }, { name: "Cards", type: "cards" }],
    view: { name: "Table", type: "table" },
    columns: [
      { key: "name", label: "Name", kind: "string" },
      { key: "status", label: "Status", kind: "string" },
    ],
    rows: [{ path: "Notes/A.md", values: { name: "A", status: "active" } }],
    totalMatched: 1,
    truncated: false,
    nextCursor: null,
    supportedSubset: true,
    capabilities: { editable: false },
    catalog: { catalogId: "cat-1", generation: 1, stale: false },
    ...overrides,
  };
}

function baseSurface() {
  const host = document.createElement("div");
  const calls = [];
  let auto = null;
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => (typeof auto === "function" ? auto(url) : auto) };
  };
  const locationObject = { pathname: ROUTE, search: "" };
  const historyObject = {
    state: { kind: "obsidianWebNavigation", index: 0, path: BASE_PATH, documentKind: "base" },
    pushState(_state, _title, url) {
      const index = String(url).indexOf("?");
      locationObject.pathname = index < 0 ? String(url) : String(url).slice(0, index);
      locationObject.search = index < 0 ? "" : String(url).slice(index);
    },
    replaceState() {},
  };
  const surface = createBaseSurface({
    host,
    fetchImpl,
    // Mirrors `features/navigation/base-navigation.js`: hand the enhance handle back to the
    // surface, which destroys it on every re-render and on `release()`.
    enhance: (root) => {
      const handle = enhanceSelects(root);
      live.push(handle);
      return handle;
    },
    storage: { getItem: () => null, setItem: () => {} },
    locationObject,
    historyObject,
    windowObject: { addEventListener: () => {}, removeEventListener: () => {} },
    onOpenNote: () => {},
    onError: (error) => { throw error; },
  });
  return {
    host,
    surface,
    calls,
    locationObject,
    setAuto(value) { auto = value; },
    lastQuery() {
      const url = calls[calls.length - 1] ?? "";
      return new URLSearchParams(url.split("?")[1] ?? "");
    },
  };
}

test("the Base view selector switches the view from the keyboard", async () => {
  const context = baseSurface();
  context.setAuto(basePage());
  await context.surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: "Table" });

  const { trigger, menu, items } = findControl(context.host.querySelector(".base-view-control .select-control"));
  assert.equal(trigger.firstElementChild.textContent, "Table");

  keyOn(trigger, "ArrowDown");
  assert.equal(menu.hidden, false, "ArrowDown opens the view list");
  assert.equal(focusOf(), items()[0], "and lands on the current view");
  key("ArrowDown");
  assert.equal(focusOf(), items()[1], "the next view is 卡片");
  context.setAuto(basePage({ view: { name: "Cards", type: "cards" } }));
  key("Enter");
  await tick();

  assert.equal(context.surface.getState().view, "Cards", "the surface switched through its own path");
  assert.equal(context.lastQuery().get("view"), "Cards", "and the query carried the new view");
  const fresh = findControl(context.host.querySelector(".base-view-control .select-control"));
  assert.equal(fresh.trigger.firstElementChild.textContent, "Cards", "the re-rendered control labels the new view");
});

// --- issue #409 review: focus handoff and surface lifecycle at the real consumer

test("a Base view commit keeps the focus on the re-rendered view trigger", async () => {
  const context = baseSurface();
  context.setAuto(basePage());
  await context.surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: "Table" });

  const before = findControl(context.host.querySelector(".base-view-control .select-control"));
  before.trigger.focus();
  keyOn(before.trigger, "ArrowDown");
  assert.equal(focusOf(), before.items()[0], "the open landed on the current view");
  key("ArrowDown");
  assert.equal(focusOf(), before.items()[1]);
  context.setAuto(basePage({ view: { name: "Cards", type: "cards" } }));
  key("Enter");
  await tick();

  assert.equal(context.surface.getState().view, "Cards", "the commit really switched the view");
  const after = findControl(context.host.querySelector(".base-view-control .select-control"));
  assert.notEqual(after.trigger, before.trigger, "the surface really replaced the control");
  assert.equal(after.trigger.getAttribute("data-focus"), "base-view", "the declared slot key moved onto the live trigger");
  assert.equal(focusOf(), after.trigger, "the focus followed the control into the fresh trigger, never body");
});

test("leaving the Base surface releases the open listbox keyboard", async () => {
  const context = baseSurface();
  context.setAuto(basePage());
  await context.surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: "Table" });

  const control = findControl(context.host.querySelector(".base-view-control .select-control"));
  control.trigger.focus();
  keyOn(control.trigger, "ArrowDown");
  assert.equal(control.menu.hidden, false);
  assert.equal(focusOf(), control.items()[0]);

  // `base-navigation.exitToNote()` hides the Base host and releases the widgets inside it.
  context.surface.release();
  assert.equal(control.menu.hidden, true, "the listbox closed before the note took over the screen");
  assert.equal(control.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(spyKey("ArrowDown").prevented, 0, "the released control no longer owns the document keys");
  assert.equal(spyKey("Enter").prevented, 0);
});

test("a hidden Base surface stops intercepting keys even when the control was not released", async () => {
  const context = baseSurface();
  context.setAuto(basePage());
  await context.surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: "Table" });

  const control = findControl(context.host.querySelector(".base-view-control .select-control"));
  control.trigger.focus();
  keyOn(control.trigger, "ArrowDown");
  assert.equal(control.menu.hidden, false);

  // The host stays in the DOM, hidden, when a note is shown again and nobody called release().
  context.host.hidden = true;
  assert.equal(spyKey("ArrowDown").prevented, 0, "the hidden listbox must not eat the keystroke");
  assert.equal(control.menu.hidden, true, "it released itself on the first key");
  assert.equal(spyKey("Enter").prevented, 0);
});

test("a Base action-panel select (buildSelect) commits from the keyboard", async () => {
  const calls = { sort: [] };
  const panels = createBasePanels({
    doc: document,
    close: () => {},
    onSort: (list) => calls.sort.push(list),
    onFilter: () => {},
    onQuery: () => {},
    onToggleColumn: () => {},
    onHideAllColumns: () => {},
    onNewNote: () => {},
    queryDebounceMs: 0,
  });
  const columns = [
    { key: "name", label: "Name", kind: "property" },
    { key: "status", label: "Status", kind: "property" },
  ];
  const node = panels.build("sort", { sort: [{ key: "name", dir: "asc" }], columns }, { doc: document, columns, allColumns: columns, config: { hidden: [], widths: {} } });
  document.body.replaceChildren(node);
  live.push(enhanceSelects(node));

  const property = controlOf(node.querySelector("[data-sort-property]"));
  keyOn(property.trigger, "ArrowDown");
  assert.equal(focusOf(), property.items()[0], "the open lands on the current sort property");
  key("ArrowDown");
  assert.equal(focusOf(), property.items()[1]);
  key("Enter");
  assert.deepEqual(calls.sort.at(-1), [{ key: "status", dir: "asc" }], "the real onSort path ran");

  const direction = controlOf(node.querySelector("[data-sort-direction]"));
  keyOn(direction.trigger, "ArrowDown");
  key("ArrowDown");
  key(" ");
  assert.deepEqual(calls.sort.at(-1), [{ key: "name", dir: "desc" }], "Space commits the direction too");
});
