import {
  computeBalancedTableColumns,
  tableVisualUnits,
} from "../../document/table-layout.js";
import { measureLiveTableMetrics } from "../../document/table-overflow-geometry.js";
import { bindTableCellEditor } from "./table-cell-editor.js";
import { renderTableCellIdle } from "./table-cell-render.js";
import { primeTableSurfaceGeometry } from "./table-surface-geometry.js";

// Table Surface v2 DOM construction and offscreen block-height estimation.
// `table-surface.js` owns the widget and the replacement decoration; this module
// owns the single rendering path shared by the mounted widget and the offscreen
// measurement probe, so both always use the same themed DOM.

const ESTIMATED_TABLE_WIDTH = 690;
const ESTIMATED_TABLE_FONT_SIZE = 16;
const ESTIMATED_TABLE_CELL_CHROME = 19;
const ESTIMATED_TABLE_LINE_HEIGHT = ESTIMATED_TABLE_FONT_SIZE * 1.65;
const ESTIMATED_TABLE_SOURCE_WRAP_FACTOR = 1.2;
const ESTIMATED_TABLE_BLOCK_PADDING = ESTIMATED_TABLE_FONT_SIZE;

// Resolved style inputs that can change table wrapping, row height or block
// padding. Property names cover typography, spacing, whitespace control and
// cell chrome; the variable list covers the Obsidian table tokens a theme
// rebinds. A partial variable list is not assumed sufficient: unknown extra
// variables still surface through the resolved properties around the cell text.
const THEME_SIGNATURE_PROPERTIES = [
  "fontSize",
  "lineHeight",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "wordSpacing",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "textTransform",
  "direction",
  "zoom",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "borderTopWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderRightWidth",
];
const THEME_SIGNATURE_VARS = [
  "--table-text-size",
  "--table-header-size",
  "--table-line-height",
  "--table-white-space",
  "--table-cell-padding",
  "--table-border-width",
  "--table-header-border-width",
  "--table-column-first-border-width",
  "--table-column-last-border-width",
  "--font-text-size",
];

// The heuristic is a last-resort approximation used only when no editor view is
// available to measure against (for example a pure state fixture or
// server-side tooling) or when the owning view is not laid out yet. It keeps the
// long-standing fixed-pixel behaviour instead of failing the height map.
export function heuristicTableHeight(model) {
  const rows = model.rows.map((row) => row.cells.map((cell) => cell.value));
  const layout = computeBalancedTableColumns(rows, {
    availableWidth: ESTIMATED_TABLE_WIDTH,
    cellChromePx: ESTIMATED_TABLE_CELL_CHROME,
    unitPx: ESTIMATED_TABLE_FONT_SIZE / 2,
  });
  const rowHeights = rows.map((row) => {
    const lines = Math.max(1, ...row.map((value, index) => {
      const contentWidth = Math.max(
        ESTIMATED_TABLE_FONT_SIZE,
        (layout.widths[index] || ESTIMATED_TABLE_WIDTH) - ESTIMATED_TABLE_CELL_CHROME,
      );
      const unitsPerLine = Math.max(1, contentWidth / (ESTIMATED_TABLE_FONT_SIZE / 2));
      // Estimate from the Markdown cell source, not stripped display text.
      // Inline-code/link chrome and unbreakable semantic spans consume more
      // horizontal room than plain glyph text. A small source-width factor
      // models that paint cost and was calibrated against the real DEVELOPMENT
      // table row geometry (including code chips) rather than adding a blanket
      // per-row height fudge.
      return Math.ceil(
        tableVisualUnits(value) * ESTIMATED_TABLE_SOURCE_WRAP_FACTOR / unitsPerLine,
      );
    }));
    // Cell editor: 1.5 line-height + 6px top/bottom padding. One extra pixel
    // covers the shared row grid stroke in the separated-border table.
    return lines * ESTIMATED_TABLE_LINE_HEIGHT + 13;
  });
  const blockPadding = (model.blankBefore ? 0 : ESTIMATED_TABLE_BLOCK_PADDING)
    + (model.blankAfter ? 0 : ESTIMATED_TABLE_BLOCK_PADDING);
  return rowHeights.reduce((sum, height) => sum + height, 0) + blockPadding;
}

// A real measurement is cached by the exact layout inputs. Many documents (and
// performance fixtures) repeat the same table, so this keeps the synchronous
// height-map build to one probe per distinct table instead of one probe per
// table occurrence. The cache is strictly partitioned by the EditorView that
// performs the measurement: a table in editor A can never reuse, or be
// invalidated by, editor B's font/theme/width, and destroying B cannot make A
// fall back to the fixed heuristic. There is no shared "current view" state.
const estimateCacheByView = new WeakMap();
const ESTIMATE_CACHE_LIMIT = 256;

export function estimateCacheFor(view) {
  let cache = estimateCacheByView.get(view);
  if (!cache) {
    cache = new Map();
    estimateCacheByView.set(view, cache);
  }
  return cache;
}

export function estimateThemeSignature(view) {
  const win = view?.dom?.ownerDocument?.defaultView;
  const target = view?.contentDOM || view?.dom;
  let style = null;
  try {
    style = win?.getComputedStyle && target ? win.getComputedStyle(target) : null;
  } catch {
    // A view whose target is not a styled Element (or lives in a detached
    // document) has no resolved style. Degrade to the empty signature so the
    // height map still reaches the heuristic fallback instead of throwing.
    style = null;
  }
  if (!style) return "";
  return [
    ...THEME_SIGNATURE_PROPERTIES.map((key) => `${key}=${style[key] ?? ""}`),
    ...THEME_SIGNATURE_VARS.map((name) => (
      `${name}=${style.getPropertyValue ? style.getPropertyValue(name) : ""}`
    )),
  ].join("|");
}

export function estimateCacheKey(model, columnWidth, themeSignature) {
  // blankBefore/blankAfter are derived from the lines around the table and are
  // absent from model.source, yet they change the measured block padding. Use
  // the exact column width (never a rounded bucket) so equal-source tables in
  // different-width panes cannot collide.
  const blankBefore = model.blankBefore ? "b1" : "b0";
  const blankAfter = model.blankAfter ? "a1" : "a0";
  return [String(columnWidth), blankBefore, blankAfter, themeSignature, model.source].join("\u241f");
}

// The probe host must be outside `.cm-editor`: CodeMirror observes that subtree,
// so a probe inserted into `view.contentDOM` would be reported to the DOM
// observer as a document mutation on every estimate. `.markdown-source-view`
// wraps the editor, applies the same Obsidian table theme scope and is invisible
// to the observer. The mounted widget lives inside `.cm-content`, and its `1em`
// block padding resolves against that element's typography, so the probe shell
// restores the resolved content typography explicitly.
function estimateProbeHost(view) {
  return view?.dom?.closest?.(".markdown-source-view")
    || view?.dom?.parentElement
    || view?.dom
    || null;
}

function applyProbeTypography(shell, view) {
  const win = view?.dom?.ownerDocument?.defaultView;
  const contentDOM = view?.contentDOM;
  const style = win?.getComputedStyle && contentDOM ? win.getComputedStyle(contentDOM) : null;
  if (!style) return;
  const fontSize = Number.parseFloat(style.fontSize);
  const lineHeight = Number.parseFloat(style.lineHeight);
  shell.style.fontSize = style.fontSize;
  shell.style.fontFamily = style.fontFamily;
  shell.style.fontWeight = style.fontWeight;
  shell.style.fontStyle = style.fontStyle;
  shell.style.letterSpacing = style.letterSpacing;
  shell.style.wordSpacing = style.wordSpacing;
  // `.cm-table-cell-editor` resets `line-height` through its `font: inherit`
  // shorthand, so a mounted cell inherits the content line-height and recomputes
  // it against its own table font size. Copying the resolved pixel value would
  // freeze the row grid at the content font size; carry the ratio instead.
  if (style.lineHeight === "normal") shell.style.lineHeight = "normal";
  else if (fontSize > 0 && Number.isFinite(lineHeight)) {
    shell.style.lineHeight = String(lineHeight / fontSize);
  }
}

// Measure a detached shell of the real table with the real themed DOM and the
// same primed balanced columns the mounted widget will use. The offscreen height
// map entry therefore agrees with the first painted frame in any environment,
// including one whose fallback font wraps CJK text differently from the fixed
// pixel heuristic. Returns null when the owning view has no laid-out host, which
// keeps the heuristic fallback reachable.
export function measuredTableBlockHeight(view, model) {
  const host = estimateProbeHost(view);
  if (!host || host.isConnected === false) return null;
  const shell = buildTableShell(view, model, false);
  applyProbeTypography(shell, view);
  const previous = {
    position: shell.style.position,
    visibility: shell.style.visibility,
    pointerEvents: shell.style.pointerEvents,
    inset: shell.style.inset,
  };
  shell.style.position = "absolute";
  shell.style.visibility = "hidden";
  shell.style.pointerEvents = "none";
  shell.style.inset = "0 auto auto -100000px";
  host.append(shell);
  try {
    primeTableSurfaceGeometry(view, shell);
    const height = shell.getBoundingClientRect().height;
    return Number.isFinite(height) && height > 0 ? height : null;
  } finally {
    shell.remove();
    shell.style.position = previous.position;
    shell.style.visibility = previous.visibility;
    shell.style.pointerEvents = previous.pointerEvents;
    shell.style.inset = previous.inset;
  }
}

// `measure` is the measurement seam: the default reads the owning editor's real
// themed DOM, and tests inject a stub to exercise caching, invalidation and the
// fallback without a layout engine.
export function estimatedTableHeight(model, view, measure = measuredTableBlockHeight) {
  if (!view || !view.contentDOM) return heuristicTableHeight(model);
  let columnWidth = 0;
  try {
    columnWidth = measureLiveTableMetrics(view).columnWidth;
  } catch {
    columnWidth = 0;
  }
  const cache = estimateCacheFor(view);
  const key = estimateCacheKey(model, columnWidth, estimateThemeSignature(view));
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let measured = null;
  try {
    measured = measure(view, model);
  } catch {
    measured = null;
  }
  if (Number.isFinite(measured) && measured > 0) {
    if (cache.size >= ESTIMATE_CACHE_LIMIT) cache.clear();
    cache.set(key, measured);
    return measured;
  }
  return heuristicTableHeight(model);
}

function createCell(view, documentRef, model, row, col, header, bind) {
  const cell = model.rows[row].cells[col];
  const element = documentRef.createElement(header ? "th" : "td");
  element.className = header ? "cm-table-cell cm-table-header-cell" : "cm-table-cell cm-table-data-cell";
  element.dataset.tableRow = String(row);
  element.dataset.tableCol = String(col);
  element.style.textAlign = model.alignments[col] || "left";

  const editor = documentRef.createElement("div");
  editor.className = "cm-table-cell-editor markdown-rendered";
  editor.contentEditable = "false";
  editor.spellcheck = false;
  editor.dataset.sourceOffsetFrom = String(cell.from - model.from);
  editor.dataset.sourceOffsetTo = String(cell.to - model.from);
  editor.dataset.sourceValue = cell.value;
  renderTableCellIdle(editor, cell.value);
  element.append(editor);
  if (bind) bindTableCellEditor(view, element, model, row, col);
  return element;
}

// Build the complete table DOM without priming. `bind` is disabled for the
// offscreen height probe so measurement never installs interaction handlers that
// belong to a mounted widget.
function buildTableShell(view, model, bind) {
  const documentRef = view.dom.ownerDocument;
  const root = documentRef.createElement("div");
  root.className = "cm-table-widget cm-live-table-v2";
  root.dataset.obsidianTableSurface = "v2";
  root.dataset.tableFrom = String(model.from);
  root.dataset.tableTo = String(model.to);
  root.dataset.tableBlankBefore = model.blankBefore ? "true" : "false";
  root.dataset.tableBlankAfter = model.blankAfter ? "true" : "false";

  const viewport = documentRef.createElement("div");
  viewport.className = "cm-table-viewport";
  const table = documentRef.createElement("table");
  table.className = "cm-live-table-element";
  const thead = documentRef.createElement("thead");
  const tbody = documentRef.createElement("tbody");

  model.rows.forEach((row, rowIndex) => {
    const tr = documentRef.createElement("tr");
    tr.className = "HyperMD-table-row cm-table-row";
    row.cells.forEach((_cell, colIndex) => {
      tr.append(createCell(view, documentRef, model, rowIndex, colIndex, row.header, bind));
    });
    (row.header ? thead : tbody).append(tr);
  });
  if (thead.childNodes.length) table.append(thead);
  if (tbody.childNodes.length) table.append(tbody);
  viewport.append(table);
  root.append(viewport);
  return root;
}

export function buildTableDOM(view, model) {
  const root = buildTableShell(view, model, true);
  // Prime balanced columns and overflow geometry while the widget is still
  // detached. The first DOM frame CodeMirror exposes therefore already has
  // the same wrapping geometry that later measurement cycles will observe.
  primeTableSurfaceGeometry(view, root);
  return root;
}
