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
//   ② the same label reaches the table header, the properties popover and the
//      filter/sort dropdowns — and all of them read the ONE server-side label;
//   ③ an explicit declaration still beats the table (the `.30` invariant);
//   ④ a custom property stays its own key (`status` is not translated);
//   ⑤ the frontend carries no second copy of the table.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBasePanels } from "../frontend/app/features/bases/panels.js";
import { columnOptions } from "../frontend/app/features/bases/panel-chrome.js";
import { queryBaseSnapshot } from "../src/base-query.js";
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
function columnsFor({ declared = {}, order = [] } = {}) {
  const properties = Object.entries(declared)
    .map(([key, displayName]) => [`  ${key}:`, `    displayName: ${JSON.stringify(displayName)}`])
    .flat();
  const raw = [
    "formulas:",
    "  note: file.asLink(file.name)",
    ...(properties.length ? ["properties:", ...properties] : []),
    "views:",
    "  - type: table",
    "    name: V",
    `    order: [${order.map((key) => `"${key}"`).join(", ")}]`,
    "",
  ].join("\n");
  return queryBaseSnapshot({ raw, viewName: "V", records: [record("Alpha", { status: "active" })] }).columns;
}

function labelOf(columns, key) {
  return columns.find((column) => column.key === key)?.label;
}

// A real popover, driven by those same server columns (this is what the surface does:
// the panel never invents a label of its own).
function panelFor(panelId, columns, state = {}) {
  const api = createBasePanels({
    doc: document, close() {}, onFilter() {}, onToggleColumn() {}, onHideAllColumns() {}, onSort() {}, onQuery() {},
  });
  const shared = { sort: [], filter: [], q: "", columns, rows: [], path: "Builtin.base", ...state };
  return api.build(panelId, shared, {
    doc: document, columns, visibleColumns: columns.slice(0, 1), config: { hidden: [], widths: {} },
  });
}

// The three surfaces, each read through the DOM the surface really paints.
function surfacesFor(columns, key) {
  const properties = panelFor("properties", columns);
  const propertyLabel = properties.querySelector(`[data-prop-row="${key}"] .base-panel-option-label`)?.textContent;
  const filter = panelFor("filter", columns, { filter: [{ key, op: "is", value: "2026" }] });
  const filterLabel = [...filter.querySelectorAll("[data-filter-key] option")].find((option) => option.value === key)?.textContent;
  const sort = panelFor("sort", columns, { sort: [{ key, dir: "desc" }] });
  const sortLabel = [...sort.querySelectorAll("[data-sort-key] option")].find((option) => option.value === key)?.textContent;
  return { header: labelOf(columns, key), propertyLabel, filterLabel, sortLabel };
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

// --- ③ the declaration still wins (the `.30` invariant) ----------------------

test("a declared displayName beats the built-in table on every surface", () => {
  const columns = columnsFor({
    declared: { "file.mtime": "我的名字" },
    order: ["file.mtime", "file.size"],
  });
  const surfaces = surfacesFor(columns, "file.mtime");
  assert.deepEqual(
    [surfaces.header, surfaces.propertyLabel, surfaces.filterLabel, surfaces.sortLabel],
    ["我的名字", "我的名字", "我的名字", "我的名字"],
    "the author's declaration is step 1 of the desktop priority, the table is only step 2",
  );
  // The sibling key is untouched by the declaration on its neighbour.
  assert.equal(labelOf(columns, "file.size"), "文件大小");
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
    "the stale-key branch must import the single table across the build-time tree edge");
  assert.match(chrome, /label: builtinPropertyName\(key\) \?\? key/, "the stale-key label must go through the table");
  const query = fs.readFileSync(path.join(APP_DIR, "src", "base-query.js"), "utf8");
  assert.match(query, /^import \{ builtinPropertyName \} from "\.\/base-builtin-names\.js";$/m);
  assert.match(query, /formulaDisplayName\(displayName, null\) \?\? builtinPropertyName\(key\) \?\? tailKey\(key\)/,
    "the desktop priority order is declared → built-in table → key tail");
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
