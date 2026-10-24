// Desktop-parity UI line (P1): BASE badge, custom view dropdown, tool row,
// action row (sort / filter / properties / search / new), column resize, URL
// state and the 409 restart contract.
//
// Uses the dedicated Base DOM harness. `createElementNS` is added here so the
// icon sprite path is exercised too; the real custom dropdown (ui/select.js)
// needs a browser, so the enhancement seam is asserted through an injected spy.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBaseSurface } from "../frontend/app/features/bases/index.js";
import { baseViewConfigKey, writeViewOptions } from "../frontend/app/features/bases/view-config.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;
if (typeof document.createElementNS !== "function") {
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
}

const ROUTE = "/app/base/r";
const BASE_PATH = "40-Projects/Projects.base";

function page(overrides = {}) {
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

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// `auto` answers every request immediately; otherwise the test resolves them in
// order (needed for the 409 restart).
function makeQueue() {
  const calls = [];
  const waiting = [];
  let auto = null;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (auto) return response(200, typeof auto === "function" ? auto(url) : auto);
    return new Promise((resolve) => waiting.push(resolve));
  };
  return {
    calls,
    fetchImpl,
    setAuto(value) { auto = value; },
    pending: () => waiting.length,
    take: () => waiting.shift(),
  };
}

function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

function makeBrowser({ pathname = ROUTE, search = "" } = {}) {
  const location = { pathname, search };
  const pushes = [];
  const replaces = [];
  const history = {
    state: { kind: "obsidianWebNavigation", index: 0, path: BASE_PATH, documentKind: "base" },
    pushState(_state, _title, url) { pushes.push(url); apply(url); },
    replaceState(_state, _title, url) { replaces.push(url); apply(url); },
  };
  function apply(url) {
    const value = String(url ?? "");
    const index = value.indexOf("?");
    location.pathname = index < 0 ? value : value.slice(0, index);
    location.search = index < 0 ? "" : value.slice(index);
  }
  const listeners = new Map();
  const windowObject = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
  };
  return { location, history, pushes, replaces, windowObject, listeners };
}

function newSurface({ queue = makeQueue(), browser = makeBrowser(), storage = makeStorage(), enhance = null, onCreateNote = null } = {}) {
  const host = document.createElement("div");
  const errors = [];
  const enhanced = [];
  const surface = createBaseSurface({
    host,
    fetchImpl: queue.fetchImpl,
    enhance: enhance ?? ((root) => enhanced.push(root)),
    onCreateNote,
    storage,
    locationObject: browser.location,
    historyObject: browser.history,
    windowObject: browser.windowObject,
    onOpenNote: () => {},
    onError: (error) => errors.push(error),
  });
  return { host, queue, browser, storage, surface, errors, enhanced };
}

async function openSurface(options = {}) {
  const context = newSurface(options);
  context.queue.setAuto(page());
  await context.surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: "Table" });
  return context;
}

// --- Explorer BASE badge ----------------------------------------------------

test("the explorer renders a `.base` row as an ordinary row plus a trailing BASE tag", async () => {
  const tree = await fs.readFile(new URL("../frontend/app/features/explorer/tree.js", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
  // No bespoke table glyph on the row any more (desktop parity).
  assert.doesNotMatch(tree, /BASE_ICON/);
  assert.match(tree, /const BASE_TAG_TEXT = "BASE"/);
  assert.match(tree, /<span class="note-badge">\$\{BASE_TAG_TEXT\}<\/span>/);
  assert.match(css, /\.note\.note-base \{ display: flex; align-items: center; gap: 6px; \}/);
  // Only existing tokens: sidebar hover background + muted text, right-aligned.
  const badge = css.slice(css.indexOf(".note-badge {"), css.indexOf(".note-badge {") + 500);
  assert.match(badge, /margin-left: auto/);
  assert.match(badge, /background: var\(--app-sidebar-hover/);
  assert.match(badge, /color: var\(--app-sidebar-muted/);
});

// --- Tool row + custom dropdown --------------------------------------------

test("the tool row is [view glyph] [view selector] [sort indicator] [N 个结果]", async () => {
  const { host } = await openSurface();
  const toolbar = host.querySelector(".base-surface-toolbar");
  assert.notEqual(toolbar, null);
  assert.notEqual(host.querySelector(".base-surface-toolbar-icon use"), null);
  assert.equal(host.querySelector(".base-surface-toolbar-icon use").getAttribute("href"), "/app/assets/icons.svg#table");
  assert.equal(host.querySelector(".base-surface").getAttribute("data-base-path"), BASE_PATH);
  // The selector names the current VIEW (desktop Bases), never the file path.
  const select = host.querySelector(".base-view-select");
  assert.equal(select.value, "Table");
  assert.deepEqual(select.querySelectorAll("option").map((option) => option.textContent), ["Table", "Cards"]);
  assert.equal(select.querySelectorAll("option")[1].getAttribute("data-base-view-option"), "Cards");
  // Default state: no override -> the neutral direction glyph.
  const indicator = host.querySelector("[data-base-sort-indicator]");
  assert.equal(indicator.getAttribute("data-base-sort-indicator"), "");
  assert.equal(indicator.classList.contains("base-sort-active"), false);
  assert.equal(host.querySelector(".base-surface-count").textContent, "1 个结果");
});

test("the view selector opts into the app custom dropdown after every render", async () => {
  const context = await openSurface();
  // Every render (busy render + data render) enhances the freshly built subtree.
  assert.equal(context.enhanced.length >= 2, true);
  const first = context.enhanced[context.enhanced.length - 1];
  const select = first.querySelector("select[data-select]");
  assert.notEqual(select, null);
  assert.equal(select.getAttribute("data-base-view"), "true");
  // A view switch re-renders: the freshly built select is enhanced again.
  context.queue.setAuto(page({ view: { name: "Cards", type: "cards" } }));
  context.host.querySelector(".base-view-select").value = "Cards";
  context.host.querySelector(".base-view-select").dispatchEvent({ type: "change" });
  await tick();
  assert.equal(context.enhanced.length >= 2, true);
  const last = context.enhanced[context.enhanced.length - 1];
  assert.notEqual(last.querySelector("select[data-select]"), null);
  assert.notEqual(last, first);
});

test("the real custom dropdown replaces the native view select (no native look)", async () => {
  const { enhanceSelects } = await import("../frontend/app/ui/select.js");
  const context = await openSurface({ enhance: (root) => enhanceSelects(root) });
  const wrapper = context.host.querySelector(".base-view-control .select-control");
  assert.notEqual(wrapper, null, "the view select must be wrapped by the custom control");
  const trigger = wrapper.querySelector(".select-trigger");
  assert.equal(trigger.textContent, "Table");
  assert.notEqual(trigger.querySelector("svg"), null);
  // The native element stays the value source but is out of the visual surface.
  const native = wrapper.querySelector("select.select-native");
  assert.equal(native.getAttribute("aria-hidden"), "true");
  assert.equal(native.tabIndex, -1);
  // Our own direction glyph is the only chevron the user sees in the tool row.
  const surfaceCss = await fs.readFile(new URL("../frontend/app/features/bases/styles.js", import.meta.url), "utf8");
  assert.ok(surfaceCss.includes(".base-view-control .select-trigger > svg{display:none;}"));

  // Opening the custom menu lists the declared views and switching one works.
  trigger.click();
  const menu = wrapper.querySelector(".select-menu");
  assert.equal(menu.hidden, false);
  const options = menu.querySelectorAll(".select-option");
  assert.deepEqual(options.map((option) => option.textContent), ["Table", "Cards"]);
  context.queue.setAuto(page({ view: { name: "Cards", type: "cards" } }));
  options[1].click();
  await tick();
  const url = new URLSearchParams(context.queue.calls[context.queue.calls.length - 1].url.split("?")[1]);
  assert.equal(url.get("view"), "Cards");
  assert.equal(context.surface.getState().view, "Cards");
});

test("the wiring layer enhances Base subtrees with ui/select.js", async () => {
  const wiring = await fs.readFile(new URL("../frontend/app/features/navigation/base-navigation.js", import.meta.url), "utf8");
  assert.match(wiring, /import \{ enhanceSelects \} from "\.\.\/\.\.\/ui\/select\.js"/);
  assert.match(wiring, /enhance: \(root\) => enhanceSelects\(root\)/);
});

// --- Table scroll containment ----------------------------------------------

test("the table box is the Base document's own vertical scroller (sticky header inside)", async () => {
  const surfaceCss = await fs.readFile(new URL("../frontend/app/features/bases/styles.js", import.meta.url), "utf8");
  // `#base-host` fills the fixed-height document area instead of growing the page;
  // `[hidden]` must win over the id rule so the note surface can hide it again.
  assert.match(surfaceCss, /#base-host\{position:absolute;inset:0;min-height:0;box-sizing:border-box;\}/);
  assert.match(surfaceCss, /#base-host\[hidden\]\{display:none;\}/);
  assert.match(surfaceCss, /#base-host:not\(\[hidden\]\)\{display:flex;flex-direction:column;\}/);
  // The surface and the table box flex into the remaining document height; no
  // hard-coded pixel max-height is allowed.
  assert.match(surfaceCss, /\.base-surface\{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;/);
  assert.match(surfaceCss, /\.base-table-wrap\{flex:1 1 auto;min-height:0;max-height:100%;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;\}/);
  // Reserving the gutter keeps the column widths from shifting when the rows start
  // to overflow, exactly like the note preview and outline list.
  assert.match(surfaceCss, /scrollbar-gutter:stable/);
  assert.doesNotMatch(surfaceCss, /\.base-table-wrap\{overflow-x:auto/, "horizontal-only overflow is the regression being fixed");
  // The sticky header lives inside the scroll container, so it stays pinned.
  assert.match(surfaceCss, /\.base-table thead th\{[^}]*position:sticky;top:0;/);
});

test("the rendered table sits inside `.base-table-wrap` and keeps its horizontal scroll owner", async () => {
  const { host } = await openSurface();
  const wrap = host.querySelector(".base-table-wrap");
  assert.notEqual(wrap, null, "the table must be wrapped by the vertical scroll container");
  const table = wrap.querySelector("table.base-table");
  assert.notEqual(table, null, ".base-table-wrap must be the table's direct scroll parent");
  assert.notEqual(table.querySelector("thead th"), null, "the sticky header must live inside the scroll container");
});

// --- Action row -------------------------------------------------------------

test("the action row exposes five real, labelled controls", async () => {
  const { host } = await openSurface();
  const buttons = host.querySelectorAll(".base-action");
  assert.deepEqual(buttons.map((button) => button.getAttribute("data-base-action")), ["sort", "filter", "properties", "search", "new"]);
  assert.deepEqual(buttons.map((button) => button.querySelector(".base-action-label").textContent), ["排序", "筛选", "属性", "搜索", "新建"]);
  for (const button of buttons) {
    assert.notEqual(button.querySelector("svg use"), null, `${button.getAttribute("data-base-action")} needs an icon`);
    assert.equal(button.getAttribute("aria-expanded"), "false");
    // U11: every action declares itself as a popover trigger of a dialog panel.
    assert.equal(button.getAttribute("aria-haspopup"), "dialog");
    // U11: each button owns the positioning anchor its panel floats in.
    assert.equal(button.parentNode.getAttribute("data-base-anchor"), button.getAttribute("data-base-action"));
    assert.equal(button.parentNode.classList.contains("base-action-anchor"), true);
  }
});

test("the 新建 action reuses the note-creation flow in the Base folder and writes no .base", async () => {
  const created = [];
  const context = await openSurface({ onCreateNote: (folder, name) => { created.push([folder, name]); return true; } });
  const before = context.queue.calls.length;
  context.host.querySelector('[data-base-action="new"]').click();
  const input = context.host.querySelector("[data-new-name]");
  assert.notEqual(input, null);
  input.value = "新笔记";
  context.host.querySelector("[data-new-create]").click();
  await tick();
  assert.deepEqual(created, [["40-Projects", "新笔记"]]);
  // No network write happens here: the reused flow owns the request.
  assert.equal(context.queue.calls.length, before);
  assert.equal(context.queue.calls.some((call) => String(call.options?.method ?? "GET") !== "GET"), false);
  assert.equal(context.host.querySelector("[data-base-panel]"), null);
});

// --- Sort / filter / properties / search -----------------------------------

test("sort writes the frozen sort parameter, updates the URL and the indicator", async () => {
  const context = await openSurface();
  context.host.querySelector('[data-base-action="sort"]').click();
  assert.notEqual(context.host.querySelector('[data-base-panel="sort"]'), null);
  // Desktop shape (U11): 添加排序 adds a `排序依据` row built from selects — 属性 +
  // 方向 + 删除 — instead of one row per column with two direction buttons.
  const add = context.host.querySelector("[data-sort-add]");
  assert.notEqual(add, null);
  add.click();
  await tick();
  // A new sort defaults to the first column that is not used yet, ascending.
  assert.notEqual(context.host.querySelector('[data-sort-row="name"]'), null);
  assert.deepEqual(JSON.parse(new URLSearchParams(context.queue.calls.at(-1).url.split("?")[1]).get("sort")), [{ key: "name", dir: "asc" }]);

  // Pick the property through the 属性 select, then the direction through 方向.
  const property = context.host.querySelector("[data-sort-property]");
  property.value = "status";
  property.dispatchEvent({ type: "change" });
  await tick();
  const row = context.host.querySelector('[data-sort-row="status"]');
  assert.notEqual(row, null);
  const direction = row.querySelector("[data-sort-direction]");
  assert.equal(direction.getAttribute("data-sort-direction"), "asc");
  direction.value = "desc";
  direction.dispatchEvent({ type: "change" });
  await tick();

  const url = new URLSearchParams(context.queue.calls.at(-1).url.split("?")[1]);
  assert.deepEqual(JSON.parse(url.get("sort")), [{ key: "status", dir: "desc" }]);
  assert.equal(context.browser.pushes.length, 3);
  assert.match(context.browser.location.search, /sort=/);
  const indicator = context.host.querySelector("[data-base-sort-indicator]");
  assert.equal(indicator.getAttribute("data-base-sort-indicator"), "desc");
  assert.equal(indicator.classList.contains("base-sort-active"), true);
  assert.equal(context.host.querySelector('[data-base-action="sort"]').classList.contains("base-action-active"), true);
  // Removing the row clears the override again (the popover stays open).
  context.host.querySelector('[data-sort-remove="status"]').click();
  await tick();
  assert.equal(new URLSearchParams(context.queue.calls.at(-1).url.split("?")[1]).get("sort"), null);
  assert.equal(context.host.querySelector('[data-base-sort-indicator]').classList.contains("base-sort-active"), false);
});

test("the filter builder adds AND conditions and writes the frozen filter parameter", async () => {
  const context = await openSurface();
  context.host.querySelector('[data-base-action="filter"]').click();
  context.host.querySelector("[data-filter-add]").click();
  await tick();

  const first = new URLSearchParams(context.queue.calls[1].url.split("?")[1]);
  assert.deepEqual(JSON.parse(first.get("filter")), [{ key: "name", op: "is", value: "" }]);
  // The panel stays open with the condition and offers a value input.
  assert.notEqual(context.host.querySelector('[data-filter-row="0"]'), null);
  const valueInput = context.host.querySelector("[data-filter-value]");
  valueInput.value = "active";
  valueInput.dispatchEvent({ type: "change" });
  await tick();
  const second = new URLSearchParams(context.queue.calls[2].url.split("?")[1]);
  assert.deepEqual(JSON.parse(second.get("filter")), [{ key: "name", op: "is", value: "active" }]);
  // Removing the condition drops the parameter again.
  context.host.querySelector("[data-filter-remove]").click();
  await tick();
  assert.equal(new URLSearchParams(context.queue.calls[3].url.split("?")[1]).get("filter"), null);
});

test("the search box writes q and replaces (never spams) the history entry", async () => {
  const context = await openSurface();
  context.host.querySelector('[data-base-action="search"]').click();
  const input = context.host.querySelector("[data-search-input]");
  assert.notEqual(input, null);
  input.value = "secrets";
  input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  await tick();

  assert.equal(new URLSearchParams(context.queue.calls[1].url.split("?")[1]).get("q"), "secrets");
  assert.equal(context.browser.replaces.length, 1);
  assert.equal(context.browser.pushes.length, 0);
  assert.match(context.browser.location.search, /q=secrets/);
  assert.equal(context.host.querySelector('[data-base-action="search"]').classList.contains("base-action-active"), true);
});

test("the properties panel hides columns client-side and persists per vault/base/view", async () => {
  const context = await openSurface();
  context.host.querySelector('[data-base-action="properties"]').click();
  const toggle = context.host.querySelector('[data-prop-toggle="status"]');
  assert.notEqual(toggle, null);
  toggle.checked = false;
  toggle.dispatchEvent({ type: "change" });
  await tick();

  assert.deepEqual(context.host.querySelectorAll("thead th").map((th) => th.textContent), ["Name"]);
  const key = baseViewConfigKey({ vaultId: "vault-1", path: BASE_PATH, view: "Table" });
  assert.deepEqual(JSON.parse(context.storage.map.get(key)).hidden, ["status"]);
  // The panel survives the re-render so a second toggle stays possible.
  assert.notEqual(context.host.querySelector('[data-base-panel="properties"]'), null);
  assert.equal(context.queue.calls.length, 1, "hiding a column is client-side only");
});

// --- Column resize ----------------------------------------------------------

test("dragging a column boundary resizes the column and persists the width", async () => {
  const context = await openSurface();
  const before = context.host.querySelector('col[data-column="name"]').style.width;
  assert.equal(before, "220px");
  const handle = context.host.querySelector('.base-col-resize[data-column="name"]');
  assert.notEqual(handle, null);
  handle.dispatchEvent({ type: "pointerdown", clientX: 200 });
  handle.dispatchEvent({ type: "pointermove", clientX: 260 });
  handle.dispatchEvent({ type: "pointerup", clientX: 260 });
  await tick();

  const key = baseViewConfigKey({ vaultId: "vault-1", path: BASE_PATH, view: "Table" });
  assert.equal(JSON.parse(context.storage.map.get(key)).widths.name, 280);
  assert.equal(context.host.querySelector('col[data-column="name"]').style.width, "280px");
  assert.equal(context.queue.calls.length, 1, "resizing never refetches");
  // The table keeps a min-width so a narrow viewport still scrolls horizontally.
  assert.match(context.host.querySelector(".base-table").style.minWidth, /^\d+px$/);
});

// --- URL state / Back-Forward / 409 ----------------------------------------

test("switching the view clears the explicit sort/filter/q overrides", async () => {
  const context = await openSurface();
  context.queue.setAuto(page());
  await context.surface.setSort([{ key: "status", dir: "desc" }]);
  await context.surface.setQuery("abc");
  assert.match(context.browser.location.search, /sort=/);
  assert.match(context.browser.location.search, /q=abc/);

  context.queue.setAuto(page({ view: { name: "Cards", type: "cards" } }));
  await context.surface.setView("Cards");
  const url = new URLSearchParams(context.queue.calls[context.queue.calls.length - 1].url.split("?")[1]);
  assert.equal(url.get("view"), "Cards");
  assert.equal(url.get("sort"), null);
  assert.equal(url.get("filter"), null);
  assert.equal(url.get("q"), null);
  assert.equal(context.browser.location.search, "?view=Cards");
});

test("Back/Forward re-applies the overrides carried by the address bar", async () => {
  const context = await openSurface();
  context.queue.setAuto(page());
  await context.surface.setSort([{ key: "name", dir: "asc" }]);
  const afterSort = context.queue.calls.length;

  // Simulate the browser restoring the previous entry.
  context.browser.location.search = "";
  context.queue.setAuto(page());
  await context.surface.syncFromUrl();
  const last = new URLSearchParams(context.queue.calls[afterSort].url.split("?")[1]);
  assert.equal(last.get("sort"), null);
  assert.deepEqual(context.surface.getState().sort, []);

  // ...and forward again.
  context.browser.location.search = "?sort=%5B%7B%22key%22%3A%22name%22%2C%22dir%22%3A%22asc%22%7D%5D";
  await context.surface.syncFromUrl();
  const forward = new URLSearchParams(context.queue.calls[context.queue.calls.length - 1].url.split("?")[1]);
  assert.deepEqual(JSON.parse(forward.get("sort")), [{ key: "name", dir: "asc" }]);
});

test("a 409 on the first page restarts the view and keeps the user's overrides", async () => {
  const queue = makeQueue();
  const context = newSurface({ queue });
  const pending = context.surface.open({ path: BASE_PATH, route: ROUTE, view: "Table" });
  queue.take()(response(409, { error: "cursor stale", code: "cursor-stale" }));
  await tick();
  queue.take()(response(200, page()));
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(queue.calls.length, 2);
  assert.equal(context.surface.getState().error, null);
  assert.equal(context.host.querySelectorAll("tbody tr").length, 1);

  // Now with overrides set: the restart request must repeat them.
  queue.setAuto(page());
  await context.surface.setSort([{ key: "status", dir: "asc" }]);
  const withSort = new URLSearchParams(queue.calls[queue.calls.length - 1].url.split("?")[1]);
  assert.deepEqual(JSON.parse(withSort.get("sort")), [{ key: "status", dir: "asc" }]);
});

// --- read-only view types: list + cards --------------------------------------
//
// Desktop evidence: app.js@3180669 (list) / @3147204 (cards) registration,
// @3181929 getMarkers and @3182005/@3147490 the private option declarations;
// i18n@118472 (list) / @118662 (cards) for the labels. The layout is
// DISPLAY-METADATA (BASES-COMPATIBILITY-MATRIX §5/§12.1): it may only change the
// box, never the row set.

const VIEW_ROWS = [
  { path: "Notes/A.md", values: { name: "A", status: "active", cover: { kind: "asLink", path: "Media/a.png" } } },
  { path: "Notes/B.md", values: { name: "B", status: "done", cover: { kind: "asLink", path: "Media/b.png" } } },
  { path: "Notes/C.md", values: { name: "C", status: "todo" } },
];

const VIEW_COLUMNS = [
  { key: "name", label: "Name", kind: "string" },
  { key: "status", label: "Status", kind: "string" },
  { key: "cover", label: "Cover", kind: "string" },
];

function pageFor(type, name) {
  return page({
    views: [{ name, type }],
    view: { name, type },
    columns: VIEW_COLUMNS,
    rows: VIEW_ROWS,
    totalMatched: VIEW_ROWS.length,
  });
}

async function openType(name, type, storage = makeStorage()) {
  const context = newSurface({ storage });
  context.queue.setAuto(pageFor(type, name));
  await context.surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: name });
  return context;
}

function optionsKey(view) {
  return baseViewConfigKey({ vaultId: "vault-1", path: BASE_PATH, view });
}

const rowIds = (host) => [...host.querySelectorAll("[data-row-id]")].map((node) => node.getAttribute("data-row-id"));
const ROW_IDS = ["Notes/A.md", "Notes/B.md", "Notes/C.md"];

test("the view type picks the layout and never the row set", async () => {
  const table = await openType("Table", "table");
  const list = await openType("List", "list");
  const cards = await openType("Cards", "cards");
  assert.equal(table.host.querySelector(".base-surface").getAttribute("data-view-type"), "table");
  assert.equal(list.host.querySelector(".base-surface").getAttribute("data-view-type"), "list");
  assert.equal(cards.host.querySelector(".base-surface").getAttribute("data-view-type"), "cards");
  // Three layouts, one row set: same identities, same order, same count (and the
  // table is still the only one with a resize-able header).
  assert.deepEqual(rowIds(table.host), ROW_IDS);
  assert.deepEqual(rowIds(list.host), ROW_IDS);
  assert.deepEqual(rowIds(cards.host), ROW_IDS);
  assert.equal(list.host.querySelector(".base-table"), null);
  assert.equal(list.host.querySelector(".base-col-resize"), null);
  assert.notEqual(cards.host.querySelector(".bases-cards-item"), null);
  // Same cells: the first row's three values are present in every layout.
  for (const context of [table, list, cards]) {
    assert.match(context.host.textContent, /A/);
    assert.match(context.host.textContent, /active/);
    assert.equal(context.host.querySelectorAll("[data-column]").length > 0, true);
  }
  // A declared type this slice does not render (map) keeps the table.
  const other = await openType("Map", "map");
  assert.equal(other.host.querySelector(".base-surface").getAttribute("data-view-type"), "table");
  assert.deepEqual(rowIds(other.host), ROW_IDS);
});

test("list renders the desktop markers, separator and indent mode", async () => {
  const byDefault = await openType("List", "list");
  const container = byDefault.host.querySelector(".bases-list-container");
  // Desktop defaults: markers bullet, separator ", ", indentation off.
  assert.equal(container.getAttribute("data-list-markers"), "bullet");
  assert.equal(container.getAttribute("data-list-indent-properties"), "false");
  assert.equal(container.getAttribute("data-list-separator"), ", ");
  assert.equal(byDefault.host.querySelectorAll(".bases-list-item").length, 3);
  const first = byDefault.host.querySelector(".bases-list-item");
  assert.equal(first.getAttribute("data-row-id"), "Notes/A.md");
  assert.equal(first.querySelector(".bases-list-property .list-bullet").textContent, "-");
  assert.equal(first.querySelectorAll(".bases-list-property").length, 3);
  // Two further properties per row, each preceded by the separator text.
  const separators = [...byDefault.host.querySelectorAll(".bases-list-separator")].map((node) => node.textContent);
  assert.deepEqual(separators, Array(ROW_IDS.length * 2).fill(", "));

  // Read side: the per-view store overrides the defaults.
  const storage = makeStorage();
  writeViewOptions(storage, optionsKey("List"), { markers: "number", indentProperties: true, separator: " | " });
  const numbered = await openType("List", "list", storage);
  const numberedContainer = numbered.host.querySelector(".bases-list-container");
  assert.equal(numberedContainer.getAttribute("data-list-markers"), "number");
  assert.equal(numberedContainer.getAttribute("data-list-indent-properties"), "true");
  const numberedItems = numbered.host.querySelectorAll(".bases-list-item");
  assert.equal(numberedItems[0].querySelector(".list-number").textContent, "1.");
  assert.equal(numberedItems[2].querySelector(".list-number").textContent, "3.");
  // Indented mode: the further properties get their own `-` lines and desktop hides
  // the separator field, so no separator element is rendered at all.
  assert.equal(numbered.host.querySelectorAll(".bases-list-separator").length, 0);
  const indented = numbered.host.querySelector(".bases-list-item-properties.is-indented");
  assert.notEqual(indented, null);
  assert.equal(indented.querySelectorAll(".bases-list-property").length, 2);
  assert.equal(indented.querySelector(".list-bullet").textContent, "-");
  // The row set is untouched by every option above.
  assert.deepEqual(rowIds(numbered.host), ROW_IDS);

  // markers: none -> no marker element at all.
  const noneStorage = makeStorage();
  writeViewOptions(noneStorage, optionsKey("List"), { markers: "none" });
  const plain = await openType("List", "list", noneStorage);
  assert.equal(plain.host.querySelector(".list-bullet"), null);
  assert.equal(plain.host.querySelector(".list-number"), null);
  assert.deepEqual(rowIds(plain.host), ROW_IDS);
});

test("cards renders cardSize, the image property, imageFit and the aspect ratio", async () => {
  const plain = await openType("Cards", "cards");
  const plainContainer = plain.host.querySelector(".bases-cards-container");
  assert.equal(plainContainer.getAttribute("data-card-size"), "200");
  assert.equal(plainContainer.getAttribute("data-image-fit"), "cover");
  assert.equal(plainContainer.getAttribute("data-image-aspect-ratio"), "1");
  assert.equal(plain.host.querySelectorAll(".bases-cards-item").length, 3);
  // No image property -> no cover box (desktop renders one only for a picked property).
  assert.equal(plain.host.querySelector(".bases-cards-cover"), null);
  assert.equal(plainContainer.getAttribute("data-image-property"), null);
  // Every visible column is a labelled property; the first one is the card title.
  const firstCard = plain.host.querySelector(".bases-cards-item");
  assert.equal(firstCard.querySelectorAll(".bases-cards-property").length, 3);
  assert.equal(firstCard.querySelector(".bases-cards-property.mod-title .bases-cards-line").textContent, "A");
  const labels = [...firstCard.querySelectorAll(".bases-cards-label")].map((node) => node.textContent);
  assert.deepEqual(labels, ["Name", "Status", "Cover"]);

  const storage = makeStorage();
  writeViewOptions(storage, optionsKey("Cards"), { cardSize: 300, image: "cover", imageFit: "contain", imageAspectRatio: 2 });
  const custom = await openType("Cards", "cards", storage);
  const container = custom.host.querySelector(".bases-cards-container");
  assert.equal(container.getAttribute("data-card-size"), "300");
  assert.equal(container.getAttribute("data-image-property"), "cover");
  assert.equal(container.getAttribute("data-image-fit"), "contain");
  assert.equal(container.getAttribute("data-image-aspect-ratio"), "2");
  assert.equal(container.style.getPropertyValue("--base-card-size"), "300px");
  const covers = custom.host.querySelectorAll(".bases-cards-cover");
  assert.equal(covers.length, 3);
  assert.equal(covers[0].getAttribute("data-image-fit"), "contain");
  assert.equal(covers[0].style.backgroundSize, "contain");
  // Cover height = cardSize / imageAspectRatio.
  assert.equal(covers[0].style.height, "150px");
  // The picked property's link value is what the cover points at; the row without
  // one keeps an empty cover box rather than an invented placeholder.
  assert.equal(covers[0].getAttribute("data-image-src"), "Media/a.png");
  assert.equal(covers[2].getAttribute("data-image-src"), null);
  assert.deepEqual(rowIds(custom.host), ROW_IDS);

  // imageFit defaults to Cover (""), i.e. `background-size: cover`.
  const coverStorage = makeStorage();
  writeViewOptions(coverStorage, optionsKey("Cards"), { image: "cover", cardSize: 400 });
  const coverFit = await openType("Cards", "cards", coverStorage);
  const cover = coverFit.host.querySelector(".bases-cards-cover");
  assert.equal(cover.getAttribute("data-image-fit"), "cover");
  assert.equal(cover.style.backgroundSize, "cover");
  assert.equal(cover.style.height, "400px");
});
