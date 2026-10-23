// Bases UI parity, cut 2 (lane desktop-re/bases-ui-parity-2, owner screenshots
// 2026-10-21: 「UI 看起来很粗糙，不像是复刻桌面端」).
//
// Why this file exists: the two popovers the owner photographed showed internal
// English diagnostics and internal `file.*` property keys, the footer read as two
// equal-width boxes, and the popover geometry had never been compared with the
// desktop menu tokens. The invariants below are the regression nails for that cut:
//
//   ① user language on the surface, diagnostic CODE kept on the node;
//   ② built-in `file.*` display names (desktop i18n) with custom keys untouched;
//   ③ the desktop-shaped footer (a column of full-width action rows) and the `</>`
//      simple/advanced switch on the section heading;
//   ④ the popover chrome the desktop shares (radius 8, border-box 320px) and the
//      desktop filter-menu width that is deliberately NOT adopted.
//
// Text assertions are line-anchored regexes over the shipped module source, so a
// reworded line is loud and a comment can never satisfy them. The geometric truth
// (rects, padding, radii, font faces, occlusion, dark 1440/1024/720 x three
// popovers) is measured against a real Chromium by this lane's own probe, which
// lives in the lane root and is deliberately not committed to the branch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBasePanels } from "../frontend/app/features/bases/panels.js";
import { BASE_SURFACE_CSS } from "../frontend/app/features/bases/styles.js";
import { queryBaseSnapshot } from "../src/base-query.js";

const MODULE_DIR = path.resolve(import.meta.dirname, "..", "frontend", "app", "features", "bases");
const read = (name) => fs.readFileSync(path.join(MODULE_DIR, name), "utf8");

// The rule body of one selector in the shipped stylesheet (the surface injects this
// single string, so a rule that is not in it is not shipped).
function rule(selector) {
  const match = BASE_SURFACE_CSS.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`));
  assert.notEqual(match, null, `the shipped stylesheet must still carry ${selector}`);
  return match[1];
}

const harness = createDomHarness();
harness.install();
const document = harness.document;

const COLUMNS = [
  { key: "file.name", label: "name", kind: "property" },
  { key: "file.mtime", label: "编辑时间", kind: "property" },
  { key: "status", label: "status", kind: "property" },
  { key: "formula.note", label: "笔记", kind: "formula", formula: { expression: "file.asLink(file.name)" } },
];

function build(panelId, { state = {} } = {}) {
  const api = createBasePanels({
    doc: document, close() {}, onFilter() {}, onToggleColumn() {}, onHideAllColumns() {}, onSort() {}, onQuery() {},
  });
  return api.build(
    panelId,
    { sort: [], filter: [], q: "", columns: COLUMNS, rows: [], path: "Parity.base", ...state },
    { doc: document, columns: COLUMNS, visibleColumns: COLUMNS.slice(0, 2), config: { hidden: [], widths: {} } },
  );
}

// --- nail ①: the surface speaks the reader's language, the code stays ---------

test("the surface sentences are user language and the stale banner keeps its code", () => {
  const source = read("labels.js");
  for (const [name, english] of [
    ["BASE_EMPTY_TEXT", "No rows match this view."],
    ["BASE_BUSY_TEXT", "Loading…"],
    ["BASE_STALE_TEXT", "Catalog snapshot is stale; showing the last known data."],
    ["BASE_LOAD_MORE_TEXT", "Load more"],
    ["BASE_RETRY_TEXT", "Retry"],
  ]) {
    // Line-anchored: the export line itself must carry Chinese and no ASCII sentence.
    const line = new RegExp(`^export const ${name} = "([^"]+)";$`, "m").exec(source);
    assert.notEqual(line, null, `${name} must stay a one-line export`);
    assert.match(line[1], /[\u4e00-\u9fa5]/, `${name} must be user language, got ${line[1]}`);
    assert.doesNotMatch(line[1], /[A-Za-z]{3,}/, `${name} still reads as the internal English (${english})`);
  }
  assert.match(source, /^export const BASE_STALE_CODE = "[A-Z_]+";$/m, "the diagnostic code must stay a named constant");
  const view = read("view.js");
  assert.match(view, /^\s+stale\.setAttribute\("data-catalog-stale-code", BASE_STALE_CODE\);$/m, "the banner must carry the code on the node");
  assert.match(view, /^\s+if \(error\.code\) block\.setAttribute\("data-error-code", String\(error\.code\)\);$/m, "the error block must carry the server code");
});

test("no module of the surface paints an internal English sentence any more", () => {
  // The one deliberate exception: the formula failure classes are pinned by
  // web-bases-formula-ui.test.js to the desktop's English i18n wording; every other
  // sentence is Chinese. The scan is what keeps the exception a decision, not a habit.
  const allowed = new Set(["formula-invalid-function", "formula-type-error", "formula-infinite-loop"]);
  const offenders = [];
  for (const name of fs.readdirSync(MODULE_DIR)) {
    if (!name.endsWith(".js")) continue;
    const source = read(name);
    for (const match of source.matchAll(/message:\s*"([^"]*[A-Za-z]{3,} [A-Za-z]{3,}[^"]*)"/g)) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      if (allowed.has(source.slice(match.index).split("\n")[0].trim().split(":")[0].replace(/"/g, ""))) continue;
      offenders.push(`${name}:${line} ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `these sentences are still internal English: ${offenders.join(" | ")}`);
});

// --- nail ②: the declared display name wins, for every kind --------------------

// The owner's `.base` declares its own names:
//   properties:
//     file.ctime: { displayName: 创建时间 }
//     file.mtime: { displayName: 编辑时间 }
//     file.size:  { displayName: 大小 }
//     formula.note: { displayName: 笔记 }
// The label that reaches the UI is built by `columnLabel` in `src/base-query.js`.
function record(name, frontmatter) {
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

function labelsFor({ declared = {}, order = [] } = {}) {
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
  const snapshot = queryBaseSnapshot({ raw, viewName: "V", records: [record("Alpha", { status: "active" })] });
  return Object.fromEntries(snapshot.columns.map((column) => [column.key, column.label]));
}

test("a declared properties.<key>.displayName is the label for every kind, not just formulas", () => {
  const labels = labelsFor({
    declared: { "file.ctime": "创建时间", "file.mtime": "编辑时间", "file.size": "大小", "formula.note": "笔记" },
    order: ["formula.note", "file.mtime", "file.ctime", "file.size", "file.name", "status"],
  });
  assert.deepEqual(labels, {
    "formula.note": "笔记",
    "file.mtime": "编辑时间",
    "file.ctime": "创建时间",
    "file.size": "大小",
    // Undeclared ⇒ the desktop built-in name wins over the key tail (U5).
    "file.name": "名称",
    status: "status",
  });
});

test("without a declaration the label falls back to the built-in name table, and an arbitrary name is printed verbatim", () => {
  // Negative control ①: no declaration at all ⇒ the DESKTOP built-in name table
  // (U5, closed by `desktop-re/bases-builtin-names`: `src/base-builtin-names.js`,
  // asar app.js@2351488), and a key the desktop has no name for keeps its key tail.
  assert.deepEqual(labelsFor({ order: ["file.mtime", "file.ctime", "file.size", "status"] }), {
    "file.mtime": "修改时间", "file.ctime": "创建时间", "file.size": "文件大小", status: "status",
  });
  // Negative control ②: any declared string is shown as declared, not translated.
  assert.deepEqual(labelsFor({ declared: { "file.mtime": "Whatever the author typed" }, order: ["file.mtime"] }), {
    "file.mtime": "Whatever the author typed",
  });
  // The formula branch keeps its own fallback (the formula key).
  assert.deepEqual(labelsFor({ order: ["formula.note"] }), { "formula.note": "formula.note" });
});

test("the same label reaches the table header, the properties panel and the filter/sort dropdowns", () => {
  const properties = build("properties");
  assert.deepEqual(properties.querySelectorAll("[data-prop-row]").map((row) => row.getAttribute("data-prop-row")), ["file.name", "file.mtime", "status", "formula.note"]);
  assert.equal(properties.querySelector('[data-prop-row="file.mtime"] .base-panel-option-label').textContent, "编辑时间");
  const filter = build("filter", { state: { filter: [{ key: "file.mtime", op: "is", value: "2026" }] } });
  const options = [...filter.querySelectorAll("[data-filter-key] option")];
  assert.equal(options.find((option) => option.value === "file.mtime")?.textContent, "编辑时间");
  const sort = build("sort", { state: { sort: [{ key: "file.mtime", dir: "desc" }] } });
  const sortOptions = [...sort.querySelectorAll("[data-sort-key] option")];
  assert.equal(sortOptions.find((option) => option.value === "file.mtime")?.textContent, "编辑时间");
});

test("the label is display-only: the value of every control stays the raw key", () => {
  const filter = build("filter", { state: { filter: [{ key: "file.mtime", op: "is", value: "2026" }] } });
  const mtime = [...filter.querySelectorAll("[data-filter-key] option")].find((option) => option.value === "file.mtime");
  assert.notEqual(mtime, undefined, "the option VALUE must stay the real key");
  assert.equal(mtime.textContent, "编辑时间", "the option LABEL is the declared display name");
});

// --- nail ③: the desktop-shaped footer and the `</>` switch -------------------

test("the footer is a column of full-width action rows, not two stretched boxes", () => {
  const footer = rule(".base-panel-footer");
  assert.match(footer, /flex-direction:column/);
  assert.match(footer, /align-items:stretch/);
  // The 6px rhythm and the hairline are the token contract of the previous cut.
  assert.match(footer, /gap:6px/);
  assert.match(footer, /margin:6px 0 0/);
  assert.match(footer, /padding-top:6px/);
  assert.match(footer, /border-top:1px solid var\(--background-modifier-border/);
  assert.match(rule(".base-panel-footer .base-panel-button"), /justify-content:flex-start/);
});

test("the simple/advanced switch is the `</>` icon control on the row-action area", () => {
  const panel = build("filter", { state: { filter: [{ key: "status", op: "is", value: "active" }] } });
  const mode = panel.querySelector("[data-filter-mode]");
  assert.notEqual(mode, null, "the switch must stay reachable through data-filter-mode");
  // G10/`<>` (lane desktop-re/bases-menu-content): the desktop builds this toggle in the filter
  // ROW's action area (`var h=l.createDiv("filter-row-actions");
  // r.toggleAdvancedModeButton=h.createEl("button",{cls:"clickable-icon filer-expression-mode-toggle"})`,
  // asar app.js@2468679/@2468775) — NOT in the section header, which carries only the collapse
  // icon, the label and the flair (@2479077). This build's mode is panel-wide, so the control
  // lives in the group's action row (`div.filter-group-actions`, asar app.js@2465689 =
  // `display:flex`, app.css@471185); the placement deviation is registered in
  // HANDOFF-MENU-CONTENT.md §`<>`.
  assert.equal(mode.parentNode.getAttribute("data-panel-actions"), "", "the switch belongs to the action row, not the section heading");
  assert.equal(mode.closest("[data-filter-group]"), null, "the switch left the section heading row");
  const glyph = mode.querySelector("use");
  assert.notEqual(glyph, null, "the switch must carry a sprite glyph");
  assert.match(String(glyph.getAttribute("href")), /#code$/, "the glyph is the desktop `</>` (sprite `code`)");
  assert.equal(mode.className.includes("base-panel-icon-button"), true);
  assert.equal(mode.className.includes("base-panel-mode"), true);
  // The glyph is the desktop `</>` (`code` symbol); the Node DOM harness has no
  // createElementNS, so this is asserted on the shipped source line.
  assert.match(read("panel-filter.js"), /^\s+icon: "code",$/m, "the switch glyph is the sprite `code` symbol");
  assert.equal(mode.textContent, "", "the switch is an icon control, not a worded button");
  assert.equal(mode.getAttribute("aria-label"), "高级筛选", "desktop tooltip-filter-advanced-mode");
  assert.equal(mode.getAttribute("title"), "高级筛选");
  // The one-class `.base-panel-mode` rule is GONE: `.base-panel-button` matched the shared
  // 30px control skin at equal specificity later in the cascade and painted the `</>` as a
  // bordered input frame. The switch is now scoped to the action row, so it wins on
  // specificity (two classes vs the skin's one) instead of on source order.
  assert.doesNotMatch(BASE_SURFACE_CSS, /(?<! )\.base-panel-mode\{/, "the frame-losing one-class switch rule must not come back");
  const modeRule = rule(".base-panel-actions .base-panel-mode");
  assert.match(modeRule, /border:0/);
  assert.match(modeRule, /background:transparent/);
  assert.match(modeRule, /border-radius:var\(--radius-s\)/, "desktop .clickable-icon box (asar app.css@258658)");
  assert.match(rule(".base-panel-actions .base-panel-mode[data-filter-mode=\"advanced\"]"), /color:var\(--text-accent/);
});

// --- nail ④: popover chrome, and the desktop width that is NOT adopted -------

test("the popover chrome matches the desktop menu scale, and takes the 520px filter width it now can", () => {
  const panel = rule(".base-panel");
  // P0 (lane desktop-re/bases-css-port-impl): the shell is the desktop `.menu` box now.
  assert.match(panel, /position:fixed/);
  assert.match(panel, /min-width:220px;max-width:100vw/);
  assert.match(panel, /border-radius:var\(--menu-radius,var\(--radius-m\)\)/, "desktop --menu-radius: var(--radius-m) (asar app.css@78291)");
  assert.match(panel, /padding:0/, "desktop `.menu{padding:0}` — the 2px section inset lives on the children");
  // FIX-1 F1: the border is the desktop's `.menu` hook chain (`--menu-border-width` ->
  // `--border-width`; `--menu-border-color` -> `--background-modifier-border-hover` ->
  // `--color-base-35`), so it follows the colour mode; the shell no longer carries the one-off
  // `var(--background-modifier-border-hover, ...)` fallback that resolved to `--color-base-30`.
  assert.match(panel, /border:var\(--menu-border-width,1px\) solid var\(--menu-border-color,var\(--color-base-35\)\)/);
  // The desktop filter menu is 520px wide (asar app.css@57465). The .30 deviation was registered
  // because the popover was `position:absolute` inside the header stacking context and slid under
  // the explorer at 1024. That mechanism is gone: `position:fixed` + the .33 clamp into the document
  // column (panel-position.js) is what makes the desktop width shippable — the 1024 reading is in
  // the lane's `evidence/readings.json` (`pastRightEdge:false`, no clipping). `:where()` keeps the
  // rule at zero specificity so the `<=720px` / `<=480px` bands still own the box.
  assert.match(BASE_SURFACE_CSS, /:where\(\.base-panel\[data-base-panel="filter"\]\)\{width:var\(--bases-filter-menu-width,520px\);\}/, "the 520px filter width is adopted, at zero specificity");
  assert.match(rule(".base-panel-section:not(:last-child)"), /border-bottom:1px solid var\(--background-modifier-border/, "desktop .bases-toolbar-section:not(:last-child) (asar app.css@455797)");
  assert.match(rule(".base-panel-section-header"), /color:var\(--text-normal/, "desktop .bases-toolbar-section-header paints var(--text-normal) (asar app.css@455939)");
  assert.match(rule(".base-panel-section-header"), /font-size:13px/, "desktop --font-ui-small (asar app.css@68526)");
  assert.match(rule(".base-panel-section-header"), /font-weight:500/, "desktop --font-medium (asar app.css@68749)");
  assert.match(rule(".base-panel-section-header .flair"), /margin-inline-start:var\(--size-4-1\)/, "desktop .bases-toolbar-section-header .flair (asar app.css@456413)");
  assert.match(rule(".base-panel-option:focus-within"), /background:var\(--background-modifier-hover/);
  assert.match(rule(".base-panel-textarea"), /font-family:var\(--font-monospace/);
});

// --- the whole surface still builds and keeps its data contract --------------

test("the filter and properties popovers still expose every hook the panels contract pins", () => {
  const filter = build("filter", { state: { filter: [{ key: "status", op: "is", value: "active" }] } });
  for (const hook of ["[data-filter-group]", "[data-filter-match]", "[data-filter-row]", "[data-filter-key]", "[data-filter-op]", "[data-filter-value]", "[data-filter-remove]", "[data-filter-add]", "[data-filter-clear]", "[data-filter-mode]"]) {
    assert.notEqual(filter.querySelector(hook), null, `${hook} must survive the restyle`);
  }
  const advanced = build("filter", { state: { filter: { and: ['status == "active"'] } } });
  assert.notEqual(advanced.querySelector("[data-filter-advanced-mode]"), null);
  assert.equal(advanced.querySelector("[data-filter-add]"), null, "advanced mode offers no simple add");
  const properties = build("properties");
  assert.deepEqual(properties.querySelectorAll("[data-prop-row]").map((row) => row.getAttribute("data-prop-row")), ["file.name", "file.mtime", "status", "formula.note"]);
  assert.equal(properties.querySelector('[data-prop-row="file.mtime"] .base-panel-option-label').textContent, "编辑时间");
  // `placeholder` is assigned as a property, which the Node harness does not model.
  assert.match(read("panel-properties.js"), /^\s+search\.placeholder = "查找属性…";$/m, "the property search keeps its hint");
});
