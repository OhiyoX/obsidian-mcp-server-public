// U11 — Base action popovers: the four desktop-parity menus (排序 / 筛选 / 属性 /
// 搜索, plus 新建) float over the table instead of pushing it down, and each one
// carries the real controls the desktop Bases menus carry.
//
// Two levels are covered here:
//   1. the panel bodies built by features/bases/panel-*.js (structure + real
//      interactions + the deliberate omissions);
//   2. the floating wiring in the mounted surface (anchor ownership, Esc /
//      outside-click dismissal, panel switching, end-to-end column hiding).
//
// The real-browser geometry (rect overlap with the table, table y immobility,
// narrow screen, themes) is asserted by the Chromium probe, not here.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBaseSurface } from "../frontend/app/features/bases/index.js";
import { createBasePanels } from "../frontend/app/features/bases/panels.js";
import {
  columnValueSample,
  inferSortKind,
  replaceSortKey,
  sortDirectionLabels,
} from "../frontend/app/features/bases/panel-sort.js";
import {
  columnMatchesSearch,
  normalizePropertySearch,
} from "../frontend/app/features/bases/panel-properties.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;
if (typeof document.createElementNS !== "function") {
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
}

const COLUMNS = [
  { key: "name", label: "Name", kind: "property" },
  { key: "status", label: "Status", kind: "property" },
  { key: "updated", label: "更新", kind: "property" },
];

// --- panel harness ----------------------------------------------------------

function makePanels({ state: stateOverrides = {}, context: contextOverrides = {} } = {}) {
  const calls = { sort: [], filter: [], query: [], toggle: [], hideAll: [], newNote: [], closed: 0 };
  const api = createBasePanels({
    doc: document,
    close: () => { calls.closed += 1; },
    onSort: (list) => calls.sort.push(list),
    onFilter: (list) => calls.filter.push(list),
    onQuery: (value) => calls.query.push(value),
    onToggleColumn: (key) => calls.toggle.push(key),
    onHideAllColumns: () => calls.hideAll.push(true),
    onNewNote: (name) => calls.newNote.push(name),
    queryDebounceMs: 0,
  });
  const state = { sort: [], filter: [], q: "", columns: COLUMNS, rows: [], path: "40-Projects/Projects.base", ...stateOverrides };
  const context = { doc: document, columns: COLUMNS, allColumns: COLUMNS, config: { hidden: [], widths: {} }, ...contextOverrides };
  return { api, state, context, calls };
}

function build(panelId, options = {}) {
  const panel = makePanels(options);
  const node = panel.api.build(panelId, panel.state, panel.context);
  return { ...panel, node };
}

// --- sort direction vocabulary ---------------------------------------------

test("the sort direction labels follow the property type inferred from real values", () => {
  assert.equal(inferSortKind([1, 2, 3]), "number");
  assert.equal(inferSortKind(["1", "2.5"]), "number");
  assert.equal(inferSortKind(["2026-01-02", "2026-01-02T10:00:00Z"]), "date");
  assert.equal(inferSortKind(["alpha", "beta"]), "text");
  // Mixed, empty and non-decisive samples stay on the neutral text vocabulary.
  assert.equal(inferSortKind(["alpha", 2]), "text");
  assert.equal(inferSortKind([]), "text");
  assert.deepEqual(sortDirectionLabels("number"), { asc: "0 → 1", desc: "1 → 0" });
  assert.deepEqual(sortDirectionLabels("date"), { asc: "旧 → 新", desc: "新 → 旧" });
  assert.deepEqual(sortDirectionLabels("text"), { asc: "A → Z", desc: "Z → A" });
  assert.deepEqual(sortDirectionLabels("unknown"), { asc: "A → Z", desc: "Z → A" });
});

test("column values are sampled by projection index or by column key", () => {
  const rows = [
    { values: ["A", 1, "2026-01-02"] },
    { values: { name: "B", status: 3 } },
  ];
  assert.deepEqual(columnValueSample({ columns: COLUMNS, rows }, "status"), [1, 3]);
  assert.deepEqual(columnValueSample({ columns: COLUMNS, rows }, "name"), ["A", "B"]);
  assert.deepEqual(columnValueSample({ columns: COLUMNS, rows }, "missing"), []);
  assert.deepEqual(columnValueSample({}, "name"), []);
});

test("re-picking a property drops the duplicate level instead of doubling it", () => {
  const list = [{ key: "name", dir: "asc" }, { key: "status", dir: "desc" }];
  assert.deepEqual(replaceSortKey(list, 1, "name"), [{ key: "name", dir: "asc" }]);
  assert.deepEqual(replaceSortKey(list, 0, "updated"), [{ key: "updated", dir: "asc" }, { key: "status", dir: "desc" }]);
});

// --- sort popover -----------------------------------------------------------

test("the sort popover has the desktop shape and no group-by / per-column grid", () => {
  const { node, calls } = build("sort");
  assert.equal(node.getAttribute("data-base-panel"), "sort");
  assert.equal(node.getAttribute("role"), "dialog");
  assert.equal(node.getAttribute("aria-label"), "排序");
  const section = node.querySelector("[data-sort-section]");
  assert.equal(section.querySelector(".base-panel-section-label").textContent, "排序依据");
  assert.equal(section.querySelector(".base-panel-count").textContent, "0");
  // 分组依据 needs a grouping contract the DTO reports as unavailable.
  assert.equal(node.textContent.includes("分组依据"), false);
  // No column grid: with no sort there is exactly one row — the footer.
  assert.deepEqual(node.querySelectorAll("[data-sort-row]"), []);
  const add = node.querySelector("[data-sort-add]");
  assert.equal(add.querySelector(".base-panel-icon use").getAttribute("href"), "/app/assets/icons.svg#plus");
  assert.equal(add.disabled, false);
  assert.equal(node.querySelector("[data-sort-clear]"), null, "clear only exists once a sort is active");

  add.click();
  assert.deepEqual(calls.sort, [[{ key: "name", dir: "asc" }]]);
});

test("the sort popover can add several named levels and edits them through selects", () => {
  const two = build("sort", { state: { sort: [{ key: "name", dir: "asc" }, { key: "status", dir: "desc" }] } });
  const rows = two.node.querySelectorAll("[data-sort-row]");
  assert.deepEqual(rows.map((row) => row.getAttribute("data-sort-row")), ["name", "status"]);
  assert.equal(two.node.querySelector("[data-sort-section] .base-panel-count").textContent, "2");

  const first = rows[0];
  const property = first.querySelector("[data-sort-property]");
  assert.equal(property.getAttribute("data-sort-key"), "name");
  assert.deepEqual(property.querySelectorAll("option").map((option) => option.value), ["name", "status", "updated"]);
  property.value = "updated";
  property.dispatchEvent({ type: "change" });
  assert.deepEqual(two.calls.sort.at(-1), [{ key: "updated", dir: "asc" }, { key: "status", dir: "desc" }]);

  const direction = first.querySelector("[data-sort-direction]");
  assert.equal(direction.getAttribute("data-sort-key"), "name");
  assert.equal(direction.getAttribute("data-sort-direction"), "asc");
  assert.deepEqual(direction.querySelectorAll("option").map((option) => option.value), ["asc", "desc"]);
  direction.value = "desc";
  direction.dispatchEvent({ type: "change" });
  assert.deepEqual(two.calls.sort.at(-1), [{ key: "name", dir: "desc" }, { key: "status", dir: "desc" }]);

  first.querySelector('[data-sort-remove="name"]').click();
  assert.deepEqual(two.calls.sort.at(-1), [{ key: "status", dir: "desc" }]);
});

test("the frozen data-sort-key/data-sort-dir hooks stay on the real asc/desc choices", () => {
  const { node } = build("sort", { state: { sort: [{ key: "status", dir: "asc" }] } });
  const hooks = node.querySelectorAll("[data-sort-key][data-sort-dir]");
  assert.deepEqual(hooks.map((hook) => `${hook.getAttribute("data-sort-key")}:${hook.getAttribute("data-sort-dir")}`), [
    "status:asc",
    "status:desc",
  ]);
  // …and they are the options of the direction select (still the value source).
  const direction = node.querySelector("[data-sort-direction]");
  assert.deepEqual(direction.querySelectorAll("option"), hooks);
});

test("the sort popover stops at the frozen four-level sort maximum", () => {
  const full = [
    { key: "name", dir: "asc" },
    { key: "status", dir: "asc" },
    { key: "updated", dir: "asc" },
    { key: "kind", dir: "asc" },
  ];
  const { node } = build("sort", { state: { sort: full }, context: { columns: [...COLUMNS, { key: "kind", label: "kind" }], allColumns: [...COLUMNS, { key: "kind", label: "kind" }] } });
  const add = node.querySelector("[data-sort-add]");
  assert.equal(add.disabled, true);
  assert.match(add.title, /最多 4 级排序/);
  assert.notEqual(node.querySelector("[data-sort-clear]"), null);
});

test("sorting is disabled when the view declares no column", () => {
  const { node } = build("sort", { context: { columns: [], allColumns: [] } });
  const add = node.querySelector("[data-sort-add]");
  assert.equal(add.disabled, true);
  assert.equal(node.textContent.includes("没有可排序的属性"), false, "the reason lives in the title, not as a fake row");
  assert.match(add.title, /没有可排序的属性/);
});

// --- filter popover ---------------------------------------------------------

test("the filter popover shows the real 当前视图 count and the conjunction selector", () => {
  const { node, calls } = build("filter", {
    state: { filter: [{ key: "status", op: "is", value: "active" }, { key: "updated", op: "is-not-empty" }] },
  });
  assert.equal(node.getAttribute("data-base-panel"), "filter");
  assert.equal(node.getAttribute("role"), "dialog");
  assert.equal(node.getAttribute("aria-label"), "筛选");
  const group = node.querySelector("[data-filter-group]");
  assert.equal(group.getAttribute("data-filter-group"), "view");
  assert.equal(group.querySelector(".base-panel-section-label").textContent, "当前视图");
  assert.equal(group.querySelector(".base-panel-count").textContent, "2");
  // 所有视图 would need the Base-file-level filters, which the DTO never exposes.
  assert.equal(node.textContent.includes("所有视图"), false);
  // G3: the conjunction is now a real selector (desktop All/Any/None). A legacy
  // AND list reads as "and" and its labels are the desktop三条 collection lines.
  const match = node.querySelector("[data-filter-match]");
  assert.equal(match.value, "and");
  assert.deepEqual(match.options.map((option) => option.value), ["and", "or", "not"]);
  assert.equal(node.textContent.includes("满足以下任一条件"), true);
  assert.equal(node.textContent.includes("以下条件都不满足"), true);
  assert.equal(node.textContent.includes("添加筛选器组"), false);

  // Choosing Any rewrites the payload into the group form; None into `not`.
  match.value = "or";
  match.dispatchEvent({ type: "change" });
  assert.deepEqual(calls.filter.at(-1), {
    or: [{ key: "status", op: "is", value: "active" }, { key: "updated", op: "is-not-empty" }],
  });
  match.value = "not";
  match.dispatchEvent({ type: "change" });
  assert.deepEqual(Object.keys(calls.filter.at(-1)), ["not"]);

  const rows = node.querySelectorAll("[data-filter-row]");
  assert.deepEqual(rows.map((row) => row.getAttribute("data-filter-row")), ["0", "1"]);
  assert.deepEqual(rows.map((row) => row.querySelector("[data-filter-key]").value), ["status", "updated"]);
  assert.deepEqual(rows.map((row) => row.querySelector("[data-filter-op]").value), ["is", "is-not-empty"]);
  // A value-less operator has no value input; the other row keeps one.
  assert.equal(rows[0].querySelector("[data-filter-value]").value, "active");
  assert.equal(rows[1].querySelector("[data-filter-value]"), null);

  rows[0].querySelector("[data-filter-op]").value = "contains";
  rows[0].querySelector("[data-filter-op]").dispatchEvent({ type: "change" });
  // Changing the operator drops the stale value instead of reusing it (frozen codec).
  assert.deepEqual(calls.filter.at(-1), [{ key: "status", op: "contains" }, { key: "updated", op: "is-not-empty" }]);
});

test("the filter popover adds, removes and clears conditions through the frozen hooks", () => {
  const { node, calls } = build("filter");
  assert.equal(node.querySelector("[data-filter-clear]"), null);
  node.querySelector("[data-filter-add]").click();
  assert.deepEqual(calls.filter.at(-1), [{ key: "name", op: "is", value: "" }]);
  const withOne = build("filter", { state: { filter: [{ key: "name", op: "is", value: "A" }] } });
  withOne.node.querySelector("[data-filter-remove]").click();
  assert.deepEqual(withOne.calls.filter.at(-1), []);
  withOne.node.querySelector("[data-filter-clear]").click();
  assert.deepEqual(withOne.calls.filter.at(-1), []);
});

// --- properties popover -----------------------------------------------------

test("the properties popover groups 已显示 / 全部属性 and never offers 添加公式", () => {
  const { node, calls } = build("properties", { context: { visibleColumns: [COLUMNS[0], COLUMNS[2]], config: { hidden: ["status"], widths: {} } } });
  assert.equal(node.getAttribute("data-base-panel"), "properties");
  assert.equal(node.getAttribute("role"), "dialog");
  assert.equal(node.getAttribute("aria-label"), "属性");
  assert.notEqual(node.querySelector("[data-prop-search]"), null);
  const sections = node.querySelectorAll("[data-prop-section]");
  assert.deepEqual(sections.map((section) => section.textContent), ["已显示", "全部属性"]);
  const visibleRows = node.querySelectorAll('[data-prop-group="visible"] [data-prop-row]');
  const allRows = node.querySelectorAll('[data-prop-group="all"] [data-prop-row]');
  assert.deepEqual(visibleRows.map((row) => row.getAttribute("data-prop-row")), ["name", "updated"]);
  // 全部属性 is the difference `declared − 已显示` (owner report 2026-10-20): the popover
  // lists a property once, and the hidden one is the only entry below the fold.
  assert.deepEqual(allRows.map((row) => row.getAttribute("data-prop-row")), ["status"]);
  assert.deepEqual(allRows.map((row) => row.querySelector("[data-prop-toggle]").checked), [false]);
  // 添加公式 needs a formula-write route: read-only surface, so no button at all.
  assert.equal(node.textContent.includes("添加公式"), false);

  node.querySelector('[data-prop-toggle="status"]').onchange();
  assert.deepEqual(calls.toggle, ["status"]);
});

test("the properties search filters both lists in place", () => {
  // One hidden column, so both groups are non-empty and the search can hide every row.
  const { node } = build("properties", { context: { visibleColumns: [COLUMNS[0], COLUMNS[1]], config: { hidden: ["updated"], widths: {} } } });
  const search = node.querySelector("[data-prop-search]");
  const keys = (group) => node.querySelectorAll(`[data-prop-group="${group}"] [data-prop-row]`).map((row) => row.getAttribute("data-prop-row"));
  assert.deepEqual(keys("all"), ["updated"]);
  assert.deepEqual(keys("visible"), ["name", "status"]);
  search.value = "upd";
  search.oninput();
  assert.deepEqual(keys("all"), ["updated"]);
  assert.deepEqual(keys("visible"), []);
  search.value = "更新"; // matches the label of a column whose key is English
  search.oninput();
  assert.deepEqual(keys("all"), ["updated"]);
  assert.deepEqual(keys("visible"), [], "the label search is case-insensitive but text-exact");
  search.value = "STATUS";
  search.oninput();
  assert.deepEqual(keys("all"), []);
  assert.deepEqual(keys("visible"), ["status"]);
  search.value = "不存在";
  search.oninput();
  assert.deepEqual(keys("all"), []);
  search.value = "";
  search.oninput();
  assert.deepEqual(keys("all"), ["updated"]);
  assert.equal(normalizePropertySearch("  Name "), "name");
  assert.equal(columnMatchesSearch(COLUMNS[2], "更新"), true);
});

test("全部隐藏 is a real bulk action and the last-column checkbox guard stays put", () => {
  const { node, calls } = build("properties", { context: { visibleColumns: [COLUMNS[0]], config: { hidden: ["status", "updated"], widths: {} } } });
  const hideAll = node.querySelector("[data-prop-hide-all]");
  assert.equal(hideAll.disabled, false);
  hideAll.click();
  assert.deepEqual(calls.hideAll, [true]);
  // The single visible column's checkbox is still disabled (never hide the last one
  // through the checkbox path), while 全部隐藏 is the explicit escape hatch.
  assert.equal(node.querySelector('[data-prop-row="name"] [data-prop-toggle]').disabled, true);
  const empty = build("properties", { context: { visibleColumns: [], config: { hidden: ["name", "status", "updated"], widths: {} } } });
  assert.equal(empty.node.querySelector('[data-prop-hide-all]').disabled, true);
  assert.deepEqual(empty.node.querySelectorAll('[data-prop-group="visible"] [data-prop-row]'), []);
  // Nothing to show below the fold either, but the difference group is the whole set.
  assert.deepEqual(empty.node.querySelectorAll('[data-prop-group="all"] [data-prop-row]').map((row) => row.getAttribute("data-prop-row")), ["name", "status", "updated"]);
});

// --- surface wiring: floating popovers, dismissal ---------------------------

const ROUTE = "/app/base/r";
const BASE_PATH = "40-Projects/Projects.base";

function page(overrides = {}) {
  return {
    vaultId: "vault-1",
    path: BASE_PATH,
    route: ROUTE,
    revision: "rev-1",
    views: [{ name: "Table", type: "table" }],
    view: { name: "Table", type: "table" },
    columns: COLUMNS.map((column) => ({ ...column })),
    rows: [{ path: "Notes/A.md", values: { name: "A", status: "active", updated: "2026-01-02" } }],
    totalMatched: 1,
    truncated: false,
    nextCursor: null,
    supportedSubset: true,
    capabilities: { editable: false, grouping: false, aggregation: false },
    catalog: { catalogId: "cat-1", generation: 1, stale: false },
    ...overrides,
  };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

async function openSurface({ pageOverride = null, storage = makeStorage() } = {}) {
  const host = document.createElement("div");
  const browser = {
    location: { pathname: ROUTE, search: "" },
    history: {
      state: {},
      pushState(_state, _title, url) { const index = url.indexOf("?"); browser.location.pathname = index < 0 ? url : url.slice(0, index); browser.location.search = index < 0 ? "" : url.slice(index); },
      replaceState(_state, _title, url) { browser.history.pushState(_state, _title, url); },
    },
    windowObject: { addEventListener() {}, removeEventListener() {} },
  };
  const surface = createBaseSurface({
    host,
    fetchImpl: async () => response(200, pageOverride ?? page()),
    storage,
    locationObject: browser.location,
    historyObject: browser.history,
    windowObject: browser.windowObject,
    onOpenNote: () => {},
  });
  await surface.open({ vaultId: "vault-1", path: BASE_PATH, route: ROUTE, view: "Table" });
  // The mounted header must be reachable through the document for the dismissal
  // listeners (toolbar.afterMount records it from the mount call).
  return { host, surface, storage, browser };
}

function openPanel(host, id) {
  host.querySelector(`[data-base-action="${id}"]`).click();
  return host.querySelector(`[data-base-panel="${id}"]`);
}

test("every action popover floats inside its own anchor and never inside the header flow", async () => {
  const { host } = await openSurface();
  const header = host.querySelector(".base-surface-header");
  assert.notEqual(header, null);
  // Only the tool row is in the header flow: a popover is never appended to it, so
  // opening a menu cannot move the table (geometry is asserted in Chromium too).
  for (const id of ["sort", "filter", "properties", "search", "new"]) {
    const panel = openPanel(host, id);
    assert.notEqual(panel, null, `${id} opens a popover`);
    assert.equal(panel.parentNode.getAttribute("data-base-anchor"), id);
    assert.equal(panel.parentNode.classList.contains("base-action-anchor"), true);
    assert.equal(header.children.filter((child) => child.classList.contains("base-panel")).length, 0);
    assert.equal(host.querySelectorAll(`[data-base-panel="${id}"]`).length, 1);
    host.querySelector(`[data-base-action="${id}"]`).click();
    assert.equal(host.querySelector(`[data-base-panel="${id}"]`), null, `${id} closes again`);
  }
});

test("a second menu is a PAGE of the same panel, with a back control that returns to it", async () => {
  const { host } = await openSurface();
  openPanel(host, "sort");
  const filter = openPanel(host, "filter");
  // Owner screenshot 3's mechanism (two floating layers that overlap and run off the
  // viewport edge) must be impossible here: the desktop replaces the page inside ONE menu
  // (`pageStack`, asar app.js@2368072/@2371419) instead of opening a second one.
  assert.equal(host.querySelectorAll("[data-base-panel]").length, 1, "one panel node, never two floating layers");
  assert.equal(host.querySelector(".base-panel").getAttribute("data-base-panel"), "filter");
  assert.equal(filter.classList.contains("is-nested"), true, "the second page is marked as nested");
  // …and the header that the desktop builds for a nested page is here, with a real target.
  const back = filter.querySelector("[data-base-panel-back]");
  assert.notEqual(back, null, "a nested page carries the desktop back control (asar app.js@2369195)");
  assert.notEqual(back.querySelector(".base-panel-back-label"), null, "the back button is also the page title");
  back.click();
  const restored = host.querySelector("[data-base-panel]");
  assert.notEqual(restored, null, "back leaves the previous page open");
  assert.equal(restored.getAttribute("data-base-panel"), "sort");
  assert.equal(restored.classList.contains("is-nested"), false);
  assert.equal(restored.querySelector("[data-base-panel-back]"), null, "a root page has no header/back control (desktop pageStack.length === 1)");
  // Re-picking a menu that is already in the stack walks back to its page instead of
  // pushing the same page twice.
  openPanel(host, "properties");
  openPanel(host, "sort");
  assert.equal(host.querySelectorAll("[data-base-panel]").length, 1);
  assert.equal(host.querySelector("[data-base-panel]").getAttribute("data-base-panel"), "sort");
  // Picking the page you are already on closes the panel, which is the toggle it always was.
  host.querySelector('[data-base-action="sort"]').click();
  assert.equal(host.querySelector("[data-base-panel]"), null);
});

test("the popover stylesheet gives the panel the desktop menu box on every width", async () => {
  const css = (await import("../frontend/app/features/bases/styles.js")).BASE_SURFACE_CSS;
  // P0 (lane desktop-re/bases-css-port-impl): the panel IS the desktop `div.menu.bases-toolbar-menu`
  // (asar app.js@2368459), so its shell is `.menu`'s own declaration set (asar app.css@282803) plus
  // the `.bases-toolbar-menu` attach block (@455439) — not this surface's hand-drawn 320px box.
  // This replaces the old "the panel is `position:absolute` inside its anchor" pin: the anchor keeps
  // the panel as its child (asserted above) but no longer owns its box, and every declaration below
  // is a desktop one, so the pin now covers the box itself instead of only its positioning model.
  const shell = css.match(/\.base-panel\{([^}]*)\}/);
  assert.notEqual(shell, null, "the shell rule must exist");
  const decls = shell[1];
  for (const declaration of [
    "position:fixed",
    "z-index:var(--layer-popover,30)",
    "min-width:220px",
    "max-width:100vw",
    "max-height:100%",
    "padding:0",
    "overflow:hidden",
    "border-radius:var(--menu-radius,var(--radius-m))",
    "background-color:var(--menu-background,var(--background-secondary,var(--panel)))",
    "border:var(--menu-border-width,1px) solid var(--menu-border-color,var(--color-base-35))",
    "box-shadow:var(--menu-shadow,var(--shadow-s))",
  ]) {
    assert.ok(decls.includes(declaration), `.base-panel must carry the desktop declaration ${declaration}, got ${decls}`);
  }
  // FIX-1 F11: the desktop's `.bases-toolbar-menu{--input-height:28px}` (asar app.css@455439) is
  // deliberately NOT copied. Nothing in this panel consumes it — the panel's controls are the Web
  // app's own 30px `.select-control` skin (pinned by `web-bases-panel-tokens.test.js`), and
  // `--input-height` is not declared anywhere in `src/app/assets/app.css`, so the copy resolved to
  // a value no box ever read. A declaration with no consumer is not alignment evidence; this
  // assertion makes its return loud instead of silent.
  assert.ok(!decls.includes("--input-height"), `.base-panel must not carry a dead --input-height, got ${decls}`);
  // P5: the filter menu keeps the desktop's own 520px, and the rule must stay at zero
  // specificity so the narrow bands below still win.
  assert.match(css, /:where\(\.base-panel\[data-base-panel="filter"\]\)\{width:var\(--bases-filter-menu-width,520px\);\}/);
  assert.match(css, /\.base-action-anchor\{position:relative;display:inline-flex;align-items:center;\}/);
  assert.match(css, /\.base-surface-header\{position:relative;z-index:5;\}/);
  // Narrow screens: the action row becomes the containing block so a left-anchored
  // popover cannot overflow the viewport, and the band takes the box back from the fixed
  // shell (`.33`'s hand-back: `panel-position.js` clears its inline placement there).
  assert.match(css, /@media \(max-width:720px\)\{\.base-surface-toolbar\{[^}]*\}\.base-action-anchor\{position:static;\}/);
  assert.match(css, /@media \(max-width:720px\)\{[^@]*\.base-panel\{position:absolute;top:calc\(100% \+ 6px\);right:0;z-index:7;/, "the <=720px band owns the box again");
});

test("a click inside the popover keeps it open even after the dropdown detaches the target", async () => {
  const { host } = await openSurface();
  openPanel(host, "sort");
  const panel = host.querySelector('[data-base-panel="sort"]');
  const option = document.createElement("div");
  option.className = "select-option";
  // The app's own dropdown replaces its menu items inside the click handler
  // (`menu.replaceChildren()`), so the clicked option is already detached when the
  // event reaches the document and `closest()` cannot see the popover any more.
  // The frozen event path still can — that is what keeps the popover open.
  document.dispatchEvent({ type: "click", target: option, composedPath: () => [option, panel, document] });
  assert.notEqual(host.querySelector('[data-base-panel="sort"]'), null, "the popover must survive an in-popover option click");
  document.dispatchEvent({ type: "mousedown", target: option, composedPath: () => [option, panel, document] });
  assert.notEqual(host.querySelector('[data-base-panel="sort"]'), null, "mousedown inside the popover keeps it open");
  // A detached target with no frozen path and no popover ancestor is outside.
  const stray = document.createElement("div");
  document.dispatchEvent({ type: "mousedown", target: stray, composedPath: () => [stray, document] });
  assert.equal(host.querySelector('[data-base-panel="sort"]'), null, "mousedown outside closes the popover");
});

test("Escape and an outside click close the open popover; clicks inside keep it open", async () => {
  const { host } = await openSurface();
  const panel = openPanel(host, "properties");
  assert.notEqual(panel, null);

  // A click inside the popover (or on its own action button) is not "outside".
  document.dispatchEvent({ type: "click", target: host.querySelector('[data-base-panel="properties"] .base-panel-option') });
  assert.notEqual(host.querySelector('[data-base-panel="properties"]'), null);
  document.dispatchEvent({ type: "click", target: host.querySelector('[data-base-action="properties"]') });
  assert.notEqual(host.querySelector('[data-base-panel="properties"]'), null);

  // A click anywhere else closes it.
  document.dispatchEvent({ type: "click", target: host.querySelector(".base-table-wrap") });
  assert.equal(host.querySelector('[data-base-panel="properties"]'), null);
  assert.equal(host.querySelector('[data-base-action="properties"]').getAttribute("aria-expanded"), "false");

  // ... and so does a real pointer press outside (the primary dismissal path).
  openPanel(host, "properties");
  document.dispatchEvent({ type: "mousedown", target: host.querySelector(".base-table-wrap") });
  assert.equal(host.querySelector('[data-base-panel="properties"]'), null);

  // Escape closes it too.
  openPanel(host, "filter");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(host.querySelector('[data-base-panel="filter"]'), null);

  // An unrelated key does nothing.
  openPanel(host, "filter");
  document.dispatchEvent({ type: "keydown", key: "a" });
  assert.notEqual(host.querySelector('[data-base-panel="filter"]'), null);

  // Clicking another action switches the popover instead of leaving two open.
  host.querySelector('[data-base-action="sort"]').click();
  assert.equal(host.querySelector('[data-base-panel="filter"]'), null);
  assert.notEqual(host.querySelector('[data-base-panel="sort"]'), null);
});

test("closing the surface detaches the document listeners (no stale dismissal)", async () => {
  const { host, surface } = await openSurface();
  openPanel(host, "sort");
  surface.close();
  // A later outside click must not reach the destroyed toolbar.
  document.dispatchEvent({ type: "click", target: host });
  document.dispatchEvent({ type: "mousedown", target: host });
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(host.childNodes.length, 0, "close() clears only its own host");
});

test("全部隐藏 clears every visible column and the properties popover can undo it", async () => {
  const { host, storage, surface } = await openSurface();
  assert.deepEqual(host.querySelectorAll("[data-base-table] thead th").map((th) => th.getAttribute("data-column")), ["name", "status", "updated"]);
  openPanel(host, "properties");
  host.querySelector("[data-prop-hide-all]").click();
  assert.deepEqual(host.querySelectorAll("[data-base-table] thead th"), []);
  const state = surface.getState();
  assert.equal(state.columns.length, 3, "the view still declares its columns");
  const stored = JSON.parse(storage.map.get([...storage.map.keys()].find((key) => key.startsWith("obsidian-web.base-view-config"))));
  assert.deepEqual(stored.hidden.slice().sort(), ["name", "status", "updated"]);
  // Every property stays listed with an unchecked box, so the popover can undo it.
  const popover = host.querySelector('[data-base-panel="properties"]');
  assert.deepEqual(popover.querySelectorAll('[data-prop-group="all"] [data-prop-toggle]').map((input) => input.checked), [false, false, false]);
  const restore = popover.querySelector('[data-prop-toggle="status"]');
  restore.checked = true;
  restore.dispatchEvent({ type: "change" });
  assert.deepEqual(host.querySelectorAll("[data-base-table] thead th").map((th) => th.getAttribute("data-column")), ["status"]);
});

test("the base stylesheet and new modules stay inside the surface contract", async () => {
  const contract = await fs.readFile(new URL("./web-bases-surface-contract.test.js", import.meta.url), "utf8");
  for (const name of ["panel-chrome.js", "panel-sort.js", "panel-filter.js", "panel-properties.js"]) {
    assert.ok(contract.includes(`"${name}"`), `${name} must be registered in the surface-contract module list`);
  }
});
