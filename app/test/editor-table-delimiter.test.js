import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function source(relative) {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const createEditor = source("../frontend/app/features/editor/create-editor.js");
const surface = source("../frontend/app/features/editor/extensions/surface.js");
const live = source("../frontend/app/features/editor/extensions/live-decorations.js");
const theme = source("../frontend/app/features/editor/extensions/theme.js");
const tableOverflow = source("../frontend/app/features/document/table-overflow-geometry.js");
const tableLayout = source("../frontend/app/features/document/table-layout.js");
const appCss = source("../src/app/assets/app.css");
const tableSurface = source("../frontend/app/features/editor/extensions/table-surface.js");
const tableSurfaceDom = source("../frontend/app/features/editor/extensions/table-surface-dom.js");
const tableCellEditor = source("../frontend/app/features/editor/extensions/table-cell-editor.js");
const tableCellRender = source("../frontend/app/features/editor/extensions/table-cell-render.js");
const tableGeometry = source("../frontend/app/features/editor/extensions/table-surface-geometry.js");
const packageJson = JSON.parse(source("../package.json"));

test("Table Surface v2 is a local whole-table block widget", () => {
  assert.equal("codemirror-markdown-tables" in packageJson.devDependencies, false);
  assert.match(tableSurface, /class TableSurfaceWidget extends WidgetType/);
  assert.match(tableSurface, /Decoration\.replace\(/);
  assert.match(tableSurface, /block:\s*true/);
  assert.match(tableSurfaceDom, /dataset\.obsidianTableSurface\s*=\s*"v2"/);
  assert.match(tableSurface, /data-obsidian-table-engine/);
});

test("Table Surface v2 derives editable ranges from Lezer TableCell source ranges", () => {
  assert.match(tableSurface, /node\.name !== "Table"/);
  assert.match(tableSurface, /child\.name !== "TableCell"/);
  assert.match(tableSurface, /state\.sliceDoc\(cellNode\.from, cellNode\.to\)/);
  assert.match(tableCellEditor, /changes:\s*\{ from, to, insert: next \}/);
  assert.doesNotMatch(tableSurface + tableCellEditor, /table\.format/);
  assert.doesNotMatch(tableSurface, /serializeMarkdownTable/);
});

test("Live surface installs V2 and no longer installs row-simulation selection hooks", () => {
  assert.match(surface, /obsidianTableSurface/);
  assert.match(surface, /\.\.\.obsidianTableSurface\(measurementContext\)/);
  assert.doesNotMatch(surface, /tableCellMouseSelection/);
  assert.doesNotMatch(surface, /tableSelectionLayer/);
});

test("Live decorations treat the complete Table range as widget-owned", () => {
  assert.match(live, /if \(node\.name === "Table"\) return false/);
  assert.doesNotMatch(live, /prepareTableColumnWidths/);
  assert.doesNotMatch(live, /tablePipeClass/);
  assert.doesNotMatch(live, /cm-live-table-scroll-owner/);
  assert.doesNotMatch(live, /attachLiveTableScrollController/);
  assert.doesNotMatch(live, /createTableGeometryRefresh/);
});

test("dynamic editor theme contains no legacy row-simulated table layout", () => {
  for (const selector of [
    ".cm-live-table-header",
    ".cm-live-table-row",
    ".cm-live-table-cell",
    ".cm-live-table-pipe",
    ".cm-live-table-scroll-owner",
  ]) {
    assert.equal(theme.includes(selector), false, selector);
  }
});

test("Table Surface v2 keeps one horizontal scroll owner and root transactions", () => {
  assert.match(tableGeometry, /viewport\.scrollLeft \+= delta/);
  assert.match(tableGeometry, /capture:\s*true/);
  assert.match(tableGeometry, /event\.preventDefault\(\)/);
  assert.doesNotMatch(tableSurface, /addEventListener\("wheel"/);
  assert.match(tableCellEditor, /view\.dispatch\(\{/);
  assert.match(tableCellEditor, /userEvent/);
  assert.doesNotMatch(tableSurface + tableCellEditor + tableGeometry, /row\.scrollLeft/);
});

test("Table Surface v2 maps unchanged widgets and refreshes cell-only edits without reparsing", () => {
  assert.match(tableSurface, /function mapUnchangedTables[\s\S]*value\.decorations\.map\(changes\)/);
  assert.match(tableSurface, /function changesStayInsideKnownCells/);
  assert.match(tableSurface, /function refreshKnownTableModels/);
  assert.match(tableSurface, /return refreshKnownTableModels\(value, transaction\)/);
});

test("Table Surface v2 reuses the shared balanced allocator and canonical rendered cell surface", () => {
  assert.match(tableGeometry, /computeBalancedTableColumns/);
  assert.match(tableGeometry, /colgroup\[data-table-layout="balanced"\]/);
  assert.match(tableGeometry, /--table-layout-width/);
  assert.match(tableSurfaceDom, /cm-table-cell-editor markdown-rendered/);
});

test("Table Surface v2 uses native DOM text ranges for cross-cell drag selection", () => {
  assert.match(tableCellEditor, /function beginPointerSelection/);
  assert.match(tableCellEditor, /addEventListener\("pointerdown"/);
  assert.match(tableCellEditor, /addEventListener\("pointermove"/);
  assert.match(tableCellEditor, /selection\.setBaseAndExtent/);
  assert.match(tableCellEditor, /Math\.hypot/);
  assert.doesNotMatch(theme, /cm-live-table-selection-active/);
  assert.doesNotMatch(theme, /cm-live-table-selection-layer/);
  assert.doesNotMatch(theme, /cm-live-table-selection-rect/);
});

test("Table Surface v2.10 establishes table topology before viewport parsing", () => {
  assert.match(tableSurface, /parser as markdownParser/);
  assert.match(tableSurface, /stableTableParser\s*=\s*markdownParser\.configure\(GFM\)/);
  assert.match(tableSurface, /buildStableTableSurfaceState/);
  assert.match(tableSurface, /stableTableParser\.parse\(state\.doc\.toString\(\)\)/);
  assert.doesNotMatch(tableSurface, /syntaxTree/);
  assert.match(tableSurface, /if \(!transaction\.docChanged\) return value/);
  assert.match(tableSurface, /lineNeighborhoodHasPipe/);
});

test("Table Surface v2.10 gives offscreen block widgets a content-aware height estimate", () => {
  assert.match(tableSurface, /get estimatedHeight\(\)/);
  assert.match(tableSurface, /estimatedTableHeight\(this\.model, this\.model\.measurementContext\?\.view \|\| null\)/);
  assert.match(tableSurfaceDom, /computeBalancedTableColumns/);
  assert.match(tableSurfaceDom, /tableVisualUnits\(value\) \* ESTIMATED_TABLE_SOURCE_WRAP_FACTOR/);
  assert.doesNotMatch(tableSurfaceDom, /tableCellDisplayText/);
  // The fixed-pixel model survives only as the last-resort fallback.
  assert.match(tableSurfaceDom, /export function heuristicTableHeight\(model\)/);
  assert.match(tableSurfaceDom, /return heuristicTableHeight\(model\)/);
});

test("Table Surface v2.11 measures the offscreen estimate from the real themed DOM", () => {
  // The height map is built before toDOM for an offscreen table, so the estimate
  // must be a real measurement of the themed DOM instead of a fixed pixel model.
  assert.match(tableSurfaceDom, /export function measuredTableBlockHeight\(view, model\)/);
  assert.match(tableSurfaceDom, /export function estimatedTableHeight\(model, view, measure = measuredTableBlockHeight\)/);
  assert.match(tableSurfaceDom, /shell\.getBoundingClientRect\(\)\.height/);
  assert.match(tableSurfaceDom, /host\.append\(shell\)/);
  assert.match(tableSurfaceDom, /shell\.remove\(\)/);
  // Probe host must stay outside `.cm-editor`: CodeMirror's DOMObserver watches
  // that subtree, so a probe inside contentDOM would be read as a document edit.
  assert.match(tableSurfaceDom, /function estimateProbeHost\(view\)/);
  assert.match(tableSurfaceDom, /closest\?\.\("\.markdown-source-view"\)/);
  assert.doesNotMatch(tableSurfaceDom, /contentDOM\.append/);
  // The mounted widget inherits .cm-content typography (its 1em block padding
  // resolves against it), so the out-of-editor probe restores it explicitly.
  assert.match(tableSurfaceDom, /function applyProbeTypography\(shell, view\)/);
  assert.match(tableSurfaceDom, /win\.getComputedStyle\(contentDOM\)/);
});

test("Table Surface v2.11 keeps every helper that stayed behind imported after the DOM split", () => {
  // The v2.11 slice moved DOM building into table-surface-dom.js. A helper that
  // stayed in the widget (cell rendering, used by updateDOM) must remain
  // imported, otherwise the first cell update throws a ReferenceError inside
  // CodeMirror and the whole editor surface reports an uncaught page error.
  function importedNames(source, modulePath) {
    const names = new Set();
    const pattern = /import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g;
    for (const match of source.matchAll(pattern)) {
      if (match[2] !== modulePath) continue;
      for (const name of match[1].split(",")) names.add(name.trim());
    }
    return names;
  }
  const checks = [
    {
      modulePath: "./table-cell-render.js",
      used: [...tableSurface.matchAll(/\brenderTableCell[A-Za-z]+/g)].map((match) => match[0]),
    },
    {
      modulePath: "./table-surface-dom.js",
      used: [...tableSurface.matchAll(/\b(?:buildTableDOM|estimatedTableHeight|heuristicTableHeight)\b/g)]
        .map((match) => match[0]),
    },
  ];
  for (const { modulePath, used } of checks) {
    const imported = importedNames(tableSurface, modulePath);
    for (const name of new Set(used)) {
      assert.ok(imported.has(name), `${name} must be imported by table-surface.js from ${modulePath}`);
    }
  }
});

test("Table Surface v2.11 reads the theme signature and cache key from the owning view", () => {
  assert.match(tableSurfaceDom, /export function estimateThemeSignature\(view\)/);
  assert.match(tableSurfaceDom, /export function estimateCacheKey\(model, columnWidth, themeSignature\)/);
  for (const token of ["--table-text-size", "--table-header-size", "--font-text-size"]) {
    assert.ok(tableSurfaceDom.includes(token), token);
  }
  assert.match(tableSurfaceDom, /win\.getComputedStyle\(target\)/);
  // A view without a resolved style degrades to an empty signature, never a throw.
  assert.match(tableSurfaceDom, /if \(!style\) return ""/);
});

test("Table Surface v2.11 binds the measurement view to the owning widget, not a module singleton", () => {
  // A table model from editor A must never measure against editor B, and
  // destroying/reconfiguring B must not make A fall back to a fixed estimate.
  assert.match(tableSurface, /export const tableMeasurementContext = Facet\.define/);
  assert.match(tableSurface, /measurementContext: state\.facet\(tableMeasurementContext\) \|\| null/);
  assert.match(tableSurface, /estimatedTableHeight\(this\.model, this\.model\.measurementContext\?\.view \|\| null\)/);
  assert.match(tableSurface, /obsidianTableSurface\(measurementContext = null\)/);
  assert.match(surface, /obsidianTableSurface\(measurementContext\)/);
  assert.match(createEditor, /const tableMeasurementContext = \{ view: null \}/);
  assert.match(createEditor, /tableMeasurementContext\.view = view/);
  // Per-view cache only: one WeakMap keyed by EditorView, no shared "current view".
  assert.match(tableSurfaceDom, /const estimateCacheByView = new WeakMap\(\)/);
  assert.match(tableSurfaceDom, /export function estimateCacheFor\(view\)/);
  assert.doesNotMatch(
    tableGeometry + tableSurfaceDom + tableSurface + surface + createEditor,
    /measurementViewRef|setTableMeasurementView|getTableMeasurementView|currentMeasurementView|lastMeasuredView/,
  );
});

test("Table Surface v2.11 keys the estimate cache by per-view geometry identity", () => {
  // blankBefore/blankAfter are outside model.source but change block padding;
  // the cache is per-EditorView and never buckets width into a rounded key.
  assert.match(tableSurfaceDom, /model\.blankBefore \? "b1" : "b0"/);
  assert.match(tableSurfaceDom, /model\.blankAfter \? "a1" : "a0"/);
  assert.match(tableSurfaceDom, /String\(columnWidth\)/);
  assert.doesNotMatch(tableSurfaceDom, /Math\.round\(columnWidth/);
  assert.match(tableSurface, /other\.model\.blankBefore === this\.model\.blankBefore/);
  assert.match(tableSurface, /other\.model\.blankAfter === this\.model\.blankAfter/);
});

test("Table Surface v2.10 synchronizes geometry through CodeMirror measure phases", () => {
  assert.match(tableGeometry, /view\.requestMeasure\(\{/);
  assert.match(tableGeometry, /read:\s*\(view\)\s*=>\s*measureTableViewports\(view\)/);
  assert.match(tableGeometry, /write:\s*\(measurements, view\)/);
  assert.match(tableGeometry, /if \(changed\) view\.requestMeasure\(\)/);
  assert.doesNotMatch(tableGeometry, /requestAnimationFrame/);
});

test("Table Surface v2.11 primes detached widgets with the same geometry inputs used after mount", () => {
  assert.match(tableSurfaceDom, /primeTableSurfaceGeometry\(view, root\)/);
  assert.match(tableGeometry, /function readDetachedTableGeometry\(view, shell\)/);
  assert.match(tableGeometry, /export function primeTableSurfaceGeometry\(view, shell\)/);
  assert.match(tableGeometry, /tableLayoutOptions\(table, columnWidth\)/);
  assert.match(tableGeometry, /getComputedStyle\(sampleCell\)/);
  assert.match(tableGeometry, /host\.append\(shell\)/);
  assert.match(tableGeometry, /shell\.remove\(\)/);
  assert.match(tableGeometry, /layout\.widths\.map/);
});

test("Table Surface v2 expands only the table viewport into measured pane gutters", () => {
  assert.match(tableGeometry, /measureLiveTableMetrics/);
  assert.match(tableGeometry, /computeTableOverflowGeometry/);
  assert.match(tableGeometry, /--table-v2-viewport-width/);
  assert.match(tableGeometry, /--table-symmetric-extension/);
  assert.match(tableGeometry, /TABLE_PANE_SAFETY/);
});

test("Table Surface v2 shows a horizontal scrollbar only for real Live overflow", () => {
  // The policy now comes from the shared geometry tokens; the app.css fallback
  // keeps the previous behaviour (fit => hidden, real overflow => auto).
  assert.match(
    appCss,
    /is-live-preview \.cm-table-viewport\s*\{[\s\S]*overflow-x:\s*var\(--md-table-overflow-x,\s*hidden\)/,
  );
  assert.match(
    appCss,
    /is-live-preview \.cm-table-viewport\[data-table-overflow="true"\]\s*\{\s*overflow-x:\s*var\(--md-table-overflow-x-active,\s*auto\)/,
  );
  assert.match(tableGeometry, /viewport\.dataset\.tableOverflow = geometry\.overflow \? "true" : "false"/);
});

test("Reader and Live clear stale horizontal scroll when overflow no longer applies", () => {
  assert.match(
    tableGeometry,
    /if \(!geometry\.overflow && Math\.abs\(viewport\.scrollLeft\) > 0\.5\) viewport\.scrollLeft = 0/,
  );
  assert.match(
    tableLayout,
    /if \(!geometry\.overflow && Math\.abs\(wrapper\.scrollLeft\) > 0\.5\) wrapper\.scrollLeft = 0/,
  );
  assert.match(tableGeometry, /viewport\.dataset\.tableOverflow !== "true"/);
  assert.match(tableGeometry, /geometry\.overflow \? "overflow" : "fit"/);
});

test("Table Surface v2 editing keeps source text and canonical semantic classes", () => {
  assert.match(tableCellRender, /renderTableCellEditing/);
  assert.match(tableCellRender, /cm-inline-code cm-live-inline-code-content cm-live-inline-code/);
  assert.match(tableCellRender, /cm-strong/);
  assert.match(tableCellRender, /cm-em/);
  assert.match(tableCellRender, /cm-strikethrough/);
  assert.match(tableCellRender, /cm-obsidian-highlight cm-highlight/);
  assert.match(tableCellRender, /cm-link/);
  assert.match(tableCellEditor, /renderTableCellEditing\(editor, editor\.dataset\.sourceValue/);
  assert.doesNotMatch(tableCellEditor, /editor\.textContent = editor\.dataset\.sourceValue/);
});

test("Table Surface v2 DOM interaction does not focus the whole widget or mirror hidden root selection", () => {
  assert.doesNotMatch(tableCellEditor, /root\.focus\(/);
  assert.doesNotMatch(tableCellEditor, /root\.tabIndex\s*=/);
  assert.match(tableCellEditor, /cm-table-dom-selection-active/);
  assert.match(tableCellEditor, /cm-table-dom-edit-active/);
  assert.doesNotMatch(tableCellEditor, /selection:\s*\{\s*anchor:\s*from \+ next\.length/);
  // The cell editor must never mirror the hidden root selection while it owns
  // an in-table DOM gesture. The single legal root-selection write is the
  // cross-block handoff (H1 / table-drag-handoff.js): a drag that leaves the
  // table block hands the gesture to the root editor and releases it on
  // pointerup. Keep that allowlist explicit instead of a bare source ban.
  const rootSelectionDispatches = tableCellEditor.match(/view\.dispatch\(\{\s*selection:/g) || [];
  assert.equal(rootSelectionDispatches.length, 1);
  assert.match(tableCellEditor, /handoffAnchor/);
  assert.match(tableCellEditor, /releasePointerSelection\(view\)/);
  assert.match(theme, /--text-selection/);
});

test("Table Surface v2 does not draw a root range cursor at atomic table boundaries", () => {
  assert.match(createEditor, /drawSelection\(\{\s*drawRangeCursor:\s*false\s*\}\)/);
});

test("Web editor has one vertical scrollbar owner", () => {
  assert.match(appCss, /\.editor\s*\{[\s\S]*overflow:\s*hidden[\s\S]*scrollbar-gutter:\s*auto/);
  assert.match(theme, /"\.cm-scroller"[\s\S]*scrollbarGutter:\s*"stable"/);
});

test("Live Preview owns one Reader-aligned document axis before table overflow", () => {
  assert.match(appCss, /is-live-preview \.cm-scroller[\s\S]*padding-inline:[\s\S]*max\(28px, calc\(\(100% - var\(--file-line-width, var\(--line-width, 700px\)\)\) \/ 2\)\)/);
  assert.match(appCss, /is-live-preview \.cm-content[\s\S]*width:\s*100%[\s\S]*max-width:\s*var\(--file-line-width, var\(--line-width, 700px\)\) !important/);
  assert.match(appCss, /is-live-preview \.cm-gutters[\s\S]*position:\s*absolute !important[\s\S]*transform:\s*translateX\(-100%\)/);
  assert.match(tableOverflow, /const columnLeft = Number\.isFinite\(measuredColumnLeft\) \? measuredColumnLeft : paneLeft/);
  assert.doesNotMatch(tableOverflow + tableGeometry + appCss, /reservedInlineChrome|canonicalColumnLeft|table-column-offset|tableLeftClamped/);
});

test("Table Surface v2 keeps structural table borders out of the cell grid", () => {
  assert.match(appCss, /\.cm-live-table-element > thead[\s\S]*border:\s*0 !important/);
  assert.match(appCss, /\.cm-live-table-element > tbody[\s\S]*border:\s*0 !important/);
  assert.match(appCss, /\.cm-table-header-cell[\s\S]*border-bottom-width:\s*var\(--table-header-border-width/);
});

test("Table Surface v2 is painted above the fold gutter only inside its own block", () => {
  assert.match(appCss, /cm-table-widget[\s\S]*position:\s*relative[\s\S]*z-index:\s*1/);
  assert.match(appCss, /is-live-preview \.cm-gutters[\s\S]*z-index:\s*0 !important/);
});

test("Table Surface v2 activates DOM selection only after a non-collapsed range exists", () => {
  assert.match(tableCellEditor, /if \(setNativeTableSelection\(root, anchor, focus\)\) markDOMSelection\(view, true\)/);
  assert.doesNotMatch(tableCellEditor, /dragged = true;[\s\S]{0,120}markDOMSelection\(view, true\)/);
});

test("Table Surface v2 owns cross-cell plain-text copy before CodeMirror", () => {
  assert.match(tableGeometry, /addEventListener\("copy", this\.onCopy, true\)/);
  assert.match(tableGeometry, /clipboardData\.setData\("text\/plain", text\)/);
  assert.match(tableGeometry, /event\.preventDefault\(\)/);
  assert.match(tableGeometry, /event\.stopPropagation\(\)/);
});

test("Table Surface v2 lets adjacent blank source lines own table spacing", () => {
  assert.match(tableSurface, /blankBefore:\s*blankLines\.before/);
  assert.match(tableSurface, /blankAfter:\s*blankLines\.after/);
  assert.match(tableSurfaceDom, /dataset\.tableBlankBefore/);
  assert.match(tableSurfaceDom, /dataset\.tableBlankAfter/);
  assert.match(appCss, /cm-table-widget\[data-table-blank-before="true"\][\s\S]*padding-top:\s*0/);
  assert.match(appCss, /cm-table-widget\[data-table-blank-after="true"\][\s\S]*padding-bottom:\s*0/);
});

test("Table Surface v2 suppresses the root caret across hidden atomic table source", () => {
  assert.match(tableGeometry, /function rootCaretTouchesTableSource/);
  assert.match(tableGeometry, /head >= from && head <= to/);
  assert.match(tableGeometry, /cm-table-root-caret-suppressed/);
  assert.match(appCss, /cm-table-root-caret-suppressed[\s\S]*cm-cursorLayer[\s\S]*visibility:\s*hidden !important/);
});

