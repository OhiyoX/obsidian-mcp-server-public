// U5 closure: the desktop's built-in Base property display names as the fallback.
//
// Lane `desktop-re/bases-builtin-names`, 2026-10-21. The previous cut (`.30`) made the
// AUTHOR's `properties.<key>.displayName` win for every kind, but left the undeclared
// case printing the key tail: `file.mtime` → `mtime`, `file.size` → `size`. The desktop
// does not do that. `getDisplayName()` (asar `app.js@2352471`) is three steps with no
// branch on the property kind — declared displayName → built-in name table `o$` →
// property name — and `o$` (asar `app.js@2351488`) is exactly 14 `file.*` names whose
// values are the i18n `label-file-prop-*` strings.
//
// The table now lives in exactly one place, `src/base-builtin-names.js`, which both
// `src/base-query.js` (the label every consumer reads, Web and MCP alike) and
// `frontend/app/features/bases/panel-chrome.js` (the stale URL-override key, which by
// definition never arrives inside `columns`) import. The tests below pin:
//
//   ① the table is the desktop's 14 keys with the desktop's zh values, unmodified;
//   ② the table HEADER and the three SELECTOR rows (properties menu, filter dropdown, sort
//      dropdown) read ONE rule — a formula keeps its displayName (`项目`), anything else is the
//      built-in name (`修改时间`) else the raw key (`status`);
//   ③ an explicit declaration still beats the table in the header (the `.30` invariant);
//   ④ a custom property stays its own key (`status` is not translated);
//   ⑤ the frontend carries no second copy of the table.
//
// ② was split by lane `desktop-re/property-label-surfaces` (2026-10-23) on the owner's own
// screenshots: `scratch/desktop-re/owner-shots/02-properties-open.png` reads `项目` / `status` /
// `updated`, `01-filter-open.png` reads `kind`, `04-sort-popover.png` reads `updated` — while
// the `.base` behind them (`_Workspace/40-Projects/Projects.base`) declares
// `status:{displayName:状态}` and `updated:{displayName:更新}`. That cut moved the selector rows
// and left the header pinned to the server's displayName-first label, which was the last open
// question (matrix §14.9.2-1, `[未证实]`). Lane `desktop-re/column-label-surfaces` (2026-10-24)
// closed it from the same shots: the 01 HEADER reads `status` (x~862,y~162) and the 04 header
// reads `updated` (y~168), so the header obeys the picker rule too and `columnLabel()` stopped
// applying a note property's displayName. The four surfaces are one rule again — this time the
// desktop's.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBasePanels } from "../frontend/app/features/bases/panels.js";
import { createRowLayouts } from "../frontend/app/features/bases/row-layouts.js";
import { columnOptions, propertyPickerLabel } from "../frontend/app/features/bases/panel-chrome.js";
import { queryBaseSnapshot } from "../src/base-query.js";
import { buildPropertyCatalog } from "../src/base-property-catalog.js";
import { BASE_BUILTIN_PROPERTY_NAMES, builtinPropertyName } from "../src/base-builtin-names.js";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const MODULE_DIR = path.join(APP_DIR, "frontend", "app", "features", "bases");
const readBases = (name) => fs.readFileSync(path.join(MODULE_DIR, name), "utf8");

// The desktop's `o$` table, in the desktop's own key order (asar `app.js@2351488`), with
// the value the desktop's `i18n/zh.txt` holds on the line the matching `i18n/mapping.txt`
// key occupies (`plugins.bases.label-file-prop-*`, lines 2334-2347). These literals are
// the independent copy: the test below compares the shipped module against THIS list, so
// a silent edit of either side goes red.
const DESKTOP_TABLE = [
  ["file.file", "文件"],
  ["file.name", "名称"],
  ["file.basename", "文件名"],
  ["file.fullname", "完整文件名"],
  ["file.path", "路径"],
  ["file.folder", "文件夹"],
  ["file.ext", "扩展名"],
  ["file.ctime", "创建时间"],
  ["file.mtime", "修改时间"],
  ["file.size", "文件大小"],
  ["file.links", "文件链接"],
  ["file.backlinks", "文件反向链接"],
  ["file.embeds", "文件嵌入"],
  ["file.tags", "文件标签"],
];

const harness = createDomHarness();
harness.install();
const document = harness.document;

function record(name, frontmatter = {}) {
  return {
    path: name,
    name,
    basename: name,
    frontmatter,
    tags: [],
    links: [],
    stat: { size: 1, created: "2026-01-01T00:00:00Z", modified: "2026-01-02T00:00:00Z" },
  };
}

// The columns the SERVER hands to the surface, built through the real `columnLabel`.
function rawFor({ declared = {}, order = [] } = {}) {
  const properties = Object.entries(declared)
    .map(([key, displayName]) => [`  ${key}:`, `    displayName: ${JSON.stringify(displayName)}`])
    .flat();
  return [
    "formulas:",
    "  note: file.asLink(file.name)",
    ...(properties.length ? ["properties:", ...properties] : []),
    "views:",
    "  - type: table",
    "    name: V",
    `    order: [${order.map((key) => `"${key}"`).join(", ")}]`,
    "",
  ].join("\n");
}

function columnsFor(options = {}) {
  return queryBaseSnapshot({ raw: rawFor(options), viewName: "V", records: [record("Alpha", { status: "active" })] }).columns;
}

function labelOf(columns, key) {
  return columns.find((column) => column.key === key)?.label;
}

// A real popover, driven by those same server columns (this is what the surface does:
// the panel never invents a label of its own). `catalog` is the server's property catalog,
// which is what the properties menu reads in production.
function panelFor(panelId, columns, state = {}, catalog = null) {
  const api = createBasePanels({
    doc: document, close() {}, onFilter() {}, onToggleColumn() {}, onHideAllColumns() {}, onSort() {}, onQuery() {},
  });
  const shared = { sort: [], filter: [], q: "", columns, rows: [], path: "Builtin.base", ...state };
  if (catalog) shared.propertyCatalog = catalog;
  return api.build(panelId, shared, {
    doc: document, columns, visibleColumns: columns.slice(0, 1), config: { hidden: [], widths: {} },
  });
}

// The four surfaces, each read through the DOM the surface really paints. `catalog` is
// optional: without it the properties menu uses its degraded `columns` fallback.
function surfacesFor(columns, key, catalog = null) {
  const properties = panelFor("properties", columns, {}, catalog);
  const propertyLabel = properties.querySelector(`[data-prop-row="${key}"] .base-panel-option-label`)?.textContent;
  const filter = panelFor("filter", columns, { filter: [{ key, op: "is", value: "2026" }] });
  const filterLabel = [...filter.querySelectorAll("[data-filter-key] option")].find((option) => option.value === key)?.textContent;
  const sort = panelFor("sort", columns, { sort: [{ key, dir: "desc" }] });
  const sortLabel = [...sort.querySelectorAll("[data-sort-key] option")].find((option) => option.value === key)?.textContent;
  return { header: labelOf(columns, key), propertyLabel, filterLabel, sortLabel };
}

// The CARDS and LIST layouts, built through the real `createRowLayouts` with the same server
// columns. Cell values are stubbed empty so any text found is a LABEL, not data.
function layoutsFor() {
  return createRowLayouts({
    doc: document,
    coarse: false,
    valueNode: () => document.createElement("span"),
    valueFor: () => null,
    rowKey: (row, index) => row?.path ?? String(index),
    select() {},
    isSelected: () => false,
    markSelected() {},
  });
}

const LAYOUT_OPTIONS = Object.freeze({
  markers: "bullet", separator: " · ", indentProperties: false,
  cardSize: 240, imageProperty: "", imageFit: "cover", imageAspectRatio: "16:9",
});

function cardLabelsFor(columns) {
  const built = layoutsFor().buildCards({ rows: [{ path: "Alpha.md", values: {} }] }, columns, LAYOUT_OPTIONS, {});
  return Object.fromEntries([...built.wrap.querySelectorAll("[data-column]")]
    .map((node) => [node.getAttribute("data-column"), node.querySelector(".bases-cards-label")?.textContent ?? null]));
}

function listTextsFor(columns) {
  const built = layoutsFor().buildList({ rows: [{ path: "Alpha.md", values: {} }] }, columns, LAYOUT_OPTIONS, {});
  const texts = [];
  const walk = (node) => {
    if (node.nodeType === 3) {
      const value = String(node.textContent ?? "").trim();
      if (value) texts.push(value);
      return;
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(built.wrap);
  return texts;
}

// --- ① the table is the desktop's table, verbatim -----------------------------

test("the built-in table is the desktop's 14 file.* names, in the desktop's order", () => {
  assert.deepEqual(Object.keys(BASE_BUILTIN_PROPERTY_NAMES), DESKTOP_TABLE.map(([key]) => key),
    "the key set and its order are the desktop `o$` table (asar app.js@2351488), which lists links before backlinks");
  for (const [key, value] of DESKTOP_TABLE) {
    assert.equal(BASE_BUILTIN_PROPERTY_NAMES[key], value, `${key} must keep the desktop i18n zh value`);
    assert.equal(builtinPropertyName(key), value, `builtinPropertyName(${key}) must resolve`);
  }
  assert.equal(builtinPropertyName("status"), null, "a custom key has no built-in name");
  assert.equal(builtinPropertyName("file.nope"), null, "an unknown file.* key has no built-in name");
  assert.equal(builtinPropertyName("mtime"), null, "a bare tail without the `file.` prefix is never translated");
  assert.equal(builtinPropertyName("toString"), null, "the lookup must not walk the prototype chain");
  assert.equal(builtinPropertyName("file.toString"), null, "an inherited name is not a built-in property");
  // `编辑时间` is the OWNER's declared value in a `.base`, never a desktop built-in name
  // (BRIEF-DELTA). If it ever appears here, the two names have been mixed.
  assert.equal(Object.values(BASE_BUILTIN_PROPERTY_NAMES).includes("编辑时间"), false,
    "`编辑时间` is an author declaration, not a desktop built-in name");
});

test("every built-in name is what an undeclared key resolves to, and it comes from the table", () => {
  for (const [key, value] of DESKTOP_TABLE) {
    const columns = columnsFor({ order: [key] });
    assert.equal(labelOf(columns, key), value, `${key} must resolve to the table value`);
    // The value must be the TABLE's, not a coincidental literal: the expectation is read
    // from the exported table, so mutating one entry moves both sides together and any
    // hard-coded copy elsewhere goes red on the literal assertions above.
    assert.equal(labelOf(columns, key), BASE_BUILTIN_PROPERTY_NAMES[key], `${key} must read the table`);
  }
  // The key-tail fallback still exists for a `file.*` key the desktop has no name for.
  assert.equal(labelOf(columnsFor({ order: ["file.nope"] }), "file.nope"), "nope");
  assert.equal(labelOf(columnsFor({ order: ["status"] }), "status"), "status");
});

// --- ② one label, three surfaces ---------------------------------------------

test("an undeclared file.mtime reads 修改时间 on the header, the properties popover and the filter dropdown", () => {
  const columns = columnsFor({ order: ["file.name", "file.mtime", "status"] });
  const surfaces = surfacesFor(columns, "file.mtime");
  assert.equal(surfaces.header, "修改时间", "the table header label");
  assert.equal(surfaces.propertyLabel, "修改时间", "the properties popover label");
  assert.equal(surfaces.filterLabel, "修改时间", "the filter property dropdown label");
  assert.equal(surfaces.sortLabel, "修改时间", "the sort property dropdown label");
  // One source, not four literals: every surface reads the server column label, and the
  // option VALUE stays the raw key so the query still applies to `file.mtime`.
  assert.deepEqual(
    [surfaces.propertyLabel, surfaces.filterLabel, surfaces.sortLabel],
    [surfaces.header, surfaces.header, surfaces.header],
    "the popovers must paint the server's label, not a label of their own",
  );
  const filter = panelFor("filter", columns, { filter: [{ key: "file.mtime", op: "is", value: "2026" }] });
  assert.equal([...filter.querySelectorAll("[data-filter-key] option")].find((option) => option.textContent === "修改时间")?.value, "file.mtime",
    "the option VALUE must stay the raw key");
});

test("a stale URL-override key that the view no longer declares uses the same table", () => {
  // `columnOptions(columns, keys)` is the only client-side label decision: a stale key is
  // by definition absent from `columns`, so the server cannot have labelled it.
  const columns = columnsFor({ order: ["file.name"] });
  assert.deepEqual(columnOptions(columns, ["file.mtime", "file.size", "status"]), [
    { value: "file.name", label: "名称" },
    { value: "file.mtime", label: "修改时间" },
    { value: "file.size", label: "文件大小" },
    { value: "status", label: "status" },
  ]);
});

// --- ③ the declaration moves a FORMULA label, never a note property's ---------------------

test("a declared displayName no longer reaches the table header of a note property", () => {
  // This was the `.30` invariant ("a declared displayName beats the built-in table in the table
  // header") and it was the one surface left on the old rule. Owner screenshots 01/04: the header
  // reads `status` / `updated` although the `.base` declares 状态 / 更新 ⇒ the declaration is not
  // consumed for a non-formula key on ANY surface, header included.
  const columns = columnsFor({
    declared: { "file.mtime": "我的名字" },
    order: ["file.mtime", "file.size"],
  });
  assert.equal(surfacesFor(columns, "file.mtime").header, "修改时间",
    "the header obeys the same rule as the pickers: built-in name → raw key (asar app.js@2351488)");
  // The same declaration DOES move a formula column (the only place displayName is consumed).
  assert.equal(labelOf(columnsFor({ declared: { "formula.note": "项目" }, order: ["formula.note"] }), "formula.note"), "项目",
    "a formula keeps its declared displayName (屏幕 01 的 `项目`)");
  // The sibling key is untouched by the declaration on its neighbour.
  assert.equal(labelOf(columns, "file.size"), "文件大小");
});

// --- ③b no surface takes a note property's displayName -------------------------

test("every surface reads the built-in name, else the raw key, not a note property's displayName", () => {
  // Owner screenshots 02 (`status` / `updated` rows, `.base` declares 状态 / 更新), 04 (`updated`
  // sort row) and — since `desktop-re/column-label-surfaces` — 01 / 04 HEADERS (`status` at
  // x~862,y~162, `updated` at y~168). One rule, four surfaces, no exception left.
  const columns = columnsFor({
    declared: { "file.mtime": "我的名字", status: "状态", updated: "更新" },
    order: ["file.mtime", "status", "updated"],
  });
  const mtime = surfacesFor(columns, "file.mtime");
  assert.deepEqual([mtime.header, mtime.propertyLabel, mtime.filterLabel, mtime.sortLabel],
    ["修改时间", "修改时间", "修改时间", "修改时间"],
    "the declared name is not consumed on any surface: the built-in name stands everywhere");
  const status = surfacesFor(columns, "status");
  assert.deepEqual([status.header, status.propertyLabel, status.filterLabel, status.sortLabel],
    ["status", "status", "status", "status"],
    "a note property's displayName is never a label: the raw key is");
  // The picker rule is one function, not four call sites that happen to agree.
  assert.equal(propertyPickerLabel("status"), "status");
  assert.equal(propertyPickerLabel("file.mtime"), "修改时间");
  assert.equal(propertyPickerLabel("formula.note", { kind: "formula", label: "项目" }), "项目");
});

// --- ③c four surfaces × three property kinds, read from the real DOM ----------

test("the header and the three picker rows, for a built-in, a note and a formula key", () => {
  // This is the production path on the properties menu: it reads the server catalog, so the
  // catalog is built here by the same module the route uses.
  const options = {
    declared: { status: "状态", updated: "更新", "formula.note": "项目" },
    order: ["file.mtime", "status", "updated", "formula.note"],
  };
  const columns = columnsFor(options);
  const catalog = buildPropertyCatalog({
    base: { path: "V.base", raw: rawFor(options) },
    columns,
    records: [record("Alpha", { status: "active" })],
  });
  const surfaces = Object.fromEntries(
    ["file.mtime", "status", "updated", "formula.note"].map((key) => [key, surfacesFor(columns, key, catalog)]),
  );
  assert.deepEqual(surfaces, {
    "file.mtime": { header: "修改时间", propertyLabel: "修改时间", filterLabel: "修改时间", sortLabel: "修改时间" },
    status: { header: "status", propertyLabel: "status", filterLabel: "status", sortLabel: "status" },
    updated: { header: "updated", propertyLabel: "updated", filterLabel: "updated", sortLabel: "updated" },
    "formula.note": { header: "项目", propertyLabel: "项目", filterLabel: "项目", sortLabel: "项目" },
  });
  // NEGATIVE CONTROL (measured 2026-10-24, not asserted here): restore the displayName-first
  // branch in `columnLabel()` (`formulaDisplayName(displayName, null) ?? …`) and the two header
  // cells go red (状态 / 更新); point the three pickers back at `column.label` and the rest follow
  // — 10 of the 21 tests in this file + `web-bases-ui-parity-2.test.js` turn red.
});

// --- ③d server rule ≡ client copy ≡ property catalog ---------------------------

test("the column DTO, the client picker and the property catalog agree, so no surface can fork", () => {
  // The rule has three implementations by necessity (server label, client stale-key label, server
  // catalog for the properties menu). Equivalence is the contract: same three steps, same answer
  // for the three property shapes the dialect produces (built-in, note property, formula).
  const options = { declared: { status: "状态", updated: "更新", "formula.note": "项目" }, order: ["file.mtime", "status", "updated", "formula.note"] };
  const columns = columnsFor(options);
  const catalog = buildPropertyCatalog({
    base: { path: "V.base", raw: rawFor(options) },
    columns,
    records: [record("Alpha", { status: "active" })],
  });
  const catalogLabels = Object.fromEntries(catalog.map((row) => [row.key, row.label]));
  // The catalog also lists the 14 built-ins; compare only the view's own four rows.
  assert.deepEqual(
    Object.fromEntries(columns.map((column) => [column.key, catalogLabels[column.key]])),
    { "file.mtime": "修改时间", status: "status", updated: "updated", "formula.note": "项目" },
  );
  for (const column of columns) {
    assert.equal(catalogLabels[column.key], column.label, `${column.key}: the menu and the column DTO must not fork`);
    assert.equal(propertyPickerLabel(column.key, column), column.label, `${column.key}: the client picker must not fork`);
  }
});

// --- ③e the cards layout paints the same label; the list paints no label -------

test("the cards layout labels a column exactly like the header, and the list layout invents none", () => {
  const options = {
    declared: { status: "状态", updated: "更新", "formula.note": "项目" },
    order: ["file.mtime", "status", "formula.note"],
  };
  const columns = columnsFor(options);
  const cards = cardLabelsFor(columns);
  assert.deepEqual(cards, {
    "file.mtime": "修改时间",
    status: "status",
    "formula.note": "ƒ 项目",
  }, "a card repeats the header label (plus the ƒ marker a computed column already carries)");
  for (const column of columns) {
    assert.equal(cards[column.key].replace(/^ƒ /, ""), column.label, `${column.key}: the card and the header must not fork`);
  }
  // The list layout paints values only (desktop `bases-list-*`), so it has no label slot to drift:
  // it consumes the same column DTO and prints no label of its own.
  const listTexts = listTextsFor(columns);
  assert.deepEqual(listTexts.filter((text) => /[\u4e00-\u9fa5]/.test(text)), [], "the list paints no property label");
  for (const column of columns) {
    assert.equal(listTexts.includes(column.label), false, `${column.key}: the list prints no property label`);
  }
});

// --- ④ a custom property is never translated --------------------------------

test("a custom property with no declaration stays its own key", () => {
  const columns = columnsFor({ order: ["status", "tags", "file.mtime"] });
  assert.deepEqual(columns.map((column) => [column.key, column.label]), [
    ["status", "status"],
    ["tags", "tags"],
    ["file.mtime", "修改时间"],
  ]);
  // `tags` is NOT `file.tags`: only the `file.*` key has a desktop built-in name.
  assert.equal(columnOptions([], ["tags", "file.tags"]).find((option) => option.value === "tags")?.label, "tags");
  assert.equal(columnOptions([], ["tags", "file.tags"]).find((option) => option.value === "file.tags")?.label, "文件标签");
});

// --- ⑤ the table has exactly one home ---------------------------------------

test("the client imports the one table instead of keeping a copy", () => {
  // Comments are stripped: the SOURCE must not carry a second copy of a name, and the
  // module headers are allowed to name the value they document.
  const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  const chrome = readBases("panel-chrome.js");
  assert.match(chrome, /^import \{ builtinPropertyName \} from "\.\.\/\.\.\/\.\.\/\.\.\/src\/base-builtin-names\.js";$/m,
    "the picker label must import the single table across the build-time tree edge");
  assert.match(chrome, /return \(column\?\.kind === "formula" \? column\.label : null\) \?\? builtinPropertyName\(key\) \?\? key/,
    "the picker rule is one function: formula displayName → table → raw key");
  assert.match(chrome, /label: propertyPickerLabel\(key, column\)/,
    "a declared column goes through the picker rule, not through `column.label`");
  assert.match(chrome, /label: propertyPickerLabel\(key\)/, "the stale-key label must go through the same function");
  const query = fs.readFileSync(path.join(APP_DIR, "src", "base-query.js"), "utf8");
  assert.match(query, /^import \{ builtinPropertyName \} from "\.\/base-builtin-names\.js";$/m);
  assert.match(query, /return builtinPropertyName\(key\) \?\? tailKey\(key\);$/m,
    "the server rule is: a formula keeps its displayName, anything else is built-in name → key tail");
  assert.match(query, /if \(isFormulaProperty\(key\)\) return formulaDisplayName\(displayName, key\);/,
    "the formula branch is the only place `properties.<key>.displayName` is consumed");
  // The client copy and the server rule must stay the same three steps for a formula key and the
  // same two for everything else (asserted behaviourally in ③d below).
  for (const [key, value] of DESKTOP_TABLE) {
    assert.equal(withoutComments(chrome).includes(value), false, `panel-chrome.js must not carry its own copy of ${key} (${value})`);
    assert.equal(withoutComments(query).includes(value), false, `base-query.js must not carry its own copy of ${key} (${value})`);
  }
  // The table module is the one place the names exist, and neither of the two consumers
  // may hold a second table: a third file importing them is the only legal shape.
  const importers = fs.readdirSync(MODULE_DIR).filter((name) => name.endsWith(".js"))
    .filter((name) => readBases(name).includes("base-builtin-names.js"));
  assert.deepEqual(importers, ["panel-chrome.js"], "only the stale-key branch may import the table on the client");
});
