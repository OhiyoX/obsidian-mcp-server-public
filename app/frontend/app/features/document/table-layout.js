import {
  TABLE_PANE_SAFETY,
  computeTableOverflowGeometry,
  nearestInlineClipBounds,
} from "./table-overflow-geometry.js";

export { TABLE_PANE_SAFETY, computeTableOverflowGeometry } from "./table-overflow-geometry.js";

const DEFAULT_AVAILABLE_WIDTH = 700;
const DEFAULT_CELL_CHROME_PX = 18;
const DEFAULT_UNIT_PX = 7.2;
// Reader's scroll frame no longer carries inline padding. The fixed side
// border itself is outside the table's content budget (border-box/clientWidth
// already accounts for it), so the allocator should use the full content width.
const TABLE_SCROLL_INLINE_CHROME = 0;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function isWideCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function tableVisualUnits(value) {
  let units = 0;
  for (const glyph of String(value ?? "")) {
    if (/\s/u.test(glyph)) units += 0.45;
    else if (isWideCodePoint(glyph.codePointAt(0))) units += 2;
    else if (/[-–—_:;,.()[\]{}]/u.test(glyph)) units += 0.72;
    else units += 1;
  }
  return units;
}

export function tableCellDisplayText(value) {
  return String(value ?? "")
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target, label) => label || target)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target, label) => label || target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|==|\`/g, "")
    .trim();
}

function longestTokenUnits(text) {
  return Math.max(
    0,
    ...String(text || "")
      .split(/[\s,;，；、/|]+/u)
      .filter(Boolean)
      .map(tableVisualUnits),
  );
}

function compactValue(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  return /^(?:[-+]?\d[\d.,:%+-]*|\d{4}[-/]\d{1,2}[-/]\d{1,2}|true|false|yes|no|done|todo|open|closed|pending|ok|n\/a|[✓✔✕✖✅❌⚠️-])$/iu.test(text);
}

function codeLikeValue(value) {
  const text = String(value || "").trim();
  if (!text || /\s/u.test(text)) return false;
  return /[\\/]/u.test(text)
    || /\.[A-Za-z0-9_-]{1,10}$/u.test(text)
    || /[*{}]/u.test(text);
}

function columnProfile(values, options) {
  const visible = values.map(tableCellDisplayText);
  const lengths = visible.map(tableVisualUnits);
  const body = visible.slice(1).filter(Boolean);
  const bodyLengths = lengths.slice(1).filter((value) => value > 0);
  const sampleLengths = bodyLengths.length ? bodyLengths : lengths;
  const q75 = percentile(sampleLengths, 0.75);
  const q90 = percentile(sampleLengths, 0.9);
  const maxUnits = Math.max(0, ...lengths);
  const headerUnits = lengths[0] || 0;
  const longestToken = Math.max(0, ...visible.map(longestTokenUnits));
  const compactRatio = body.length
    ? body.filter(compactValue).length / body.length
    : 0;
  const codeLikeRatio = body.length
    ? body.filter(codeLikeValue).length / body.length
    : 0;
  const codeLike = codeLikeRatio >= 0.5 && q90 >= 10;
  const compact = !codeLike && (
    (q75 <= 14 && maxUnits <= 22 && longestToken <= 18)
    || (compactRatio >= 0.7 && maxUnits <= 28)
  );

  const minFloor = codeLike ? 132 : (compact ? 64 : 92);
  const minCeiling = codeLike ? 420 : (compact ? 184 : 220);
  const idealMaxWidth = codeLike ? 460 : (compact ? 220 : 380);
  const comfortMaxWidth = codeLike
    ? Math.min(360, Math.max(180, options.availableWidth * 0.36))
    : (compact ? 208 : Math.min(560, options.availableWidth * 0.78));
  const tokenUnits = codeLike ? Math.max(longestToken, q90) : longestToken;
  const tokenDrivenMin = options.cellChromePx + Math.min(tokenUnits, codeLike ? 42 : (compact ? 20 : 28)) * 5.5;
  // Headers are semantic labels, not disposable samples. Keep a short header
  // on one line whenever the table budget permits, instead of letting a
  // compact body force an awkward header wrap.
  const headerNoWrapWidth = options.cellChromePx
    + Math.max(0, headerUnits) * options.unitPx * 1.06;
  // Code/path columns are rendered as chips and often contain no spaces.
  // Reserve enough width for their longest real token before falling back to
  // wrapping; otherwise the chip can visibly spill into the next cell.
  const nowrapContentWidth = codeLike
    ? options.cellChromePx + 10 + longestToken * Math.max(options.unitPx, 9.2)
    : 0;
  // Short body labels/statuses are substantially harder to scan when a
  // harmless phrase such as "Not implemented" is split over multiple lines.
  // Headers already have their own no-wrap target, so do not let a long header
  // inflate this body readability floor (that can feed intrinsic table width
  // back into CodeMirror's editor surface).
  const shortPhraseUnits = Math.max(
    0,
    ...body
      .map((text) => ({
        units: tableVisualUnits(text),
        longestToken: longestTokenUnits(text),
      }))
      .filter((sample) => sample.units <= 24 && sample.longestToken <= 18)
      .map((sample) => sample.units),
  );
  const shortPhraseNoWrapWidth = shortPhraseUnits > 0
    ? Math.ceil(
      (options.cellChromePx + shortPhraseUnits * options.unitPx * 1.08) * 2,
    ) / 2
    : 0;
  const minWidth = clamp(
    Math.max(
      tokenDrivenMin,
      Math.min(headerNoWrapWidth, compact ? 184 : 220),
      codeLike ? Math.min(nowrapContentWidth, 420) : 0,
      shortPhraseNoWrapWidth,
    ),
    minFloor,
    minCeiling,
  );
  const preferredUnits = Math.max(
    headerUnits * 1.08,
    q75,
    longestToken * 0.92,
    codeLike ? q90 : 0,
  );
  const idealPixelWidth = codeLike
    ? options.cellChromePx + 12 + preferredUnits * Math.max(options.unitPx, 8.6)
    : options.cellChromePx + preferredUnits * options.unitPx;
  const idealWidth = clamp(
    Math.max(idealPixelWidth, shortPhraseNoWrapWidth),
    minWidth,
    idealMaxWidth,
  );
  // idealWidth keeps dense tables compact. comfortableWidth is a second
  // target used only when spare room can reduce real wrapping. Path/code
  // columns use a monospace-aware pixel estimate plus chip chrome so values
  // such as tools/ingest-zips.mjs do not wrap despite available space.
  const comfortableUnits = Math.max(preferredUnits, q90, longestToken);
  const comfortablePixelWidth = codeLike
    ? options.cellChromePx + 14 + comfortableUnits * Math.max(options.unitPx, 9.2)
    : options.cellChromePx + comfortableUnits * options.unitPx;
  const comfortableWidth = clamp(
    comfortablePixelWidth,
    idealWidth,
    comfortMaxWidth,
  );
  const wrapDemand = Math.max(0, q90 - (codeLike ? 16 : (compact ? 18 : 24)));
  // `minWidth` is the hard safety floor. `readableWidth` is the softer
  // layout floor: below it wrapping becomes materially worse, so allowing a
  // horizontal scroller is preferable to forcing the table into the viewport.
  const readableRatio = codeLike ? 0.68 : (compact ? 0.78 : 0.60);
  const readableWidth = clamp(
    Math.max(minWidth, shortPhraseNoWrapWidth, idealWidth * readableRatio),
    minWidth,
    idealWidth,
  );

  return {
    compact,
    codeLike,
    minWidth,
    idealWidth,
    comfortableWidth,
    wrapDemand,
    q75,
    q90,
    maxUnits,
    longestToken,
    headerNoWrapWidth,
    nowrapContentWidth,
    shortPhraseNoWrapWidth,
    readableWidth,
  };
}

function growToward(widths, targets, remaining) {
  while (remaining > 0.5) {
    const active = targets
      .map((target, index) => ({ index, need: Math.max(0, target - widths[index]) }))
      .filter((item) => item.need > 0.25);
    if (!active.length) break;

    const weightTotal = active.reduce((sum, item) => sum + Math.pow(item.need, 0.72), 0);
    let spent = 0;
    for (const item of active) {
      const share = remaining * (Math.pow(item.need, 0.72) / weightTotal);
      const delta = Math.min(item.need, share);
      widths[item.index] += delta;
      spent += delta;
    }
    if (spent < 0.25) break;
    remaining -= spent;
  }
  return remaining;
}

function fillSpareWidth(widths, profiles, remaining) {
  if (remaining <= 0.5) return;
  const weights = profiles.map((profile, index) => {
    const headerDeficit = Math.max(0, profile.headerNoWrapWidth - widths[index]);
    const tokenDeficit = profile.codeLike
      ? Math.max(0, profile.nowrapContentWidth - widths[index])
      : 0;
    const base = profile.codeLike ? 1.05 : (profile.compact ? 0.6 : 1.45);
    return base
      + Math.min(3, headerDeficit / 36)
      + Math.min(4, tokenDeficit / 72)
      + Math.min(3, profile.wrapDemand / 8);
  });
  const total = weights.reduce((sum, value) => sum + value, 0) || widths.length;
  widths.forEach((_, index) => {
    widths[index] += remaining * ((weights[index] || 1) / total);
  });
}

function distributeWithinBudget(profiles, availableWidth) {
  const readables = profiles.map((profile) => profile.readableWidth);
  const ideals = profiles.map((profile) => profile.idealWidth);
  const comforts = profiles.map((profile) => profile.comfortableWidth);
  const totalReadable = readables.reduce((sum, value) => sum + value, 0);
  const totalIdeal = ideals.reduce((sum, value) => sum + value, 0);

  // Do not treat viewport fit as an invariant. Once every column has reached
  // its readability floor, horizontal scrolling is the lesser cost than
  // splitting short labels or collapsing several prose columns at once.
  if (totalReadable > availableWidth) return readables;

  // Protect one-line headers after satisfying the readability floor.
  const headerTargets = profiles.map((profile, index) => (
    Math.max(readables[index], Math.min(profile.headerNoWrapWidth, profile.idealWidth))
  ));
  const widthsFromReadable = [...readables];
  growToward(widthsFromReadable, headerTargets, availableWidth - totalReadable);
  const totalAfterHeaders = widthsFromReadable.reduce((sum, value) => sum + value, 0);
  if (totalIdeal > availableWidth) {
    growToward(widthsFromReadable, ideals, Math.max(0, availableWidth - totalAfterHeaders));
    return widthsFromReadable;
  }

  // First satisfy the dense target. When it fits, spend spare width only
  // where the content profile says wider columns will reduce wrapping.
  if (totalIdeal <= availableWidth) {
    const widths = [...ideals];
    let remaining = growToward(widths, comforts, availableWidth - totalIdeal);
    // If prose-like columns still have strong wrap demand, spare horizontal
    // space is more valuable than an artificially compact table. Give those
    // columns an extra runway before leaving a large empty gutter.
    if (remaining > 0.5) {
      const pressureTargets = profiles.map((profile, index) => {
        if (profile.codeLike || profile.wrapDemand <= 0) return widths[index];
        const bonus = Math.min(availableWidth * 0.22, profile.wrapDemand * 7.5);
        return Math.min(widths[index] + bonus, profile.compact ? 220 : availableWidth * 0.72);
      });
      remaining = growToward(widths, pressureTargets, remaining);
    }
    // Reader already fills its wrapper. Live must use the same final inline
    // budget instead of stopping at a compact target and leaving a fake empty
    // column/gutter. Distribute the last spare width by actual content demand.
    fillSpareWidth(widths, profiles, remaining);
    return widths;
  }

  const widths = [...minimums];
  growToward(widths, ideals, availableWidth - totalMin);
  return widths;
}

export function computeBalancedTableColumns(rows, options = {}) {
  const normalizedRows = (rows || [])
    .filter((row) => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "")));
  const columnCount = normalizedRows.reduce((max, row) => Math.max(max, row.length), 0);
  if (!columnCount) return { widths: [], totalWidth: 0, overflow: false, profiles: [] };

  const settings = {
    availableWidth: Math.max(1, Number(options.availableWidth) || DEFAULT_AVAILABLE_WIDTH),
    cellChromePx: Math.max(0, Number(options.cellChromePx) || DEFAULT_CELL_CHROME_PX),
    unitPx: Math.max(1, Number(options.unitPx) || DEFAULT_UNIT_PX),
  };
  const columns = Array.from({ length: columnCount }, (_, index) => (
    normalizedRows.map((row) => row[index] || "")
  ));
  const profiles = columns.map((values) => columnProfile(values, settings));
  const widths = distributeWithinBudget(profiles, settings.availableWidth)
    .map((value) => Math.round(value * 2) / 2);
  const totalWidth = widths.reduce((sum, value) => sum + value, 0);

  return {
    widths,
    totalWidth,
    overflow: totalWidth > settings.availableWidth + 0.5,
    profiles,
  };
}

function tableRows(table) {
  return [...table.rows].map((row) => [...row.cells].map((cell) => cell.textContent || ""));
}

export function layoutRenderedTables(root, options = {}) {
  if (!root?.querySelectorAll) return [];
  const layouts = [];
  for (const table of root.querySelectorAll("table")) {
    // `force` re-runs the allocator for an already-balanced table, which the
    // Reader uses after a viewport/pane resize so a stale symmetric extension
    // can never push the table's left edge outside the pane.
    if (table.dataset.columnLayout === "balanced" && !options.force) continue;

    // On a forced re-run the table already sits inside `.table-scroll`; measure
    // the wrapper's containing block (the reading column) rather than the
    // wrapper itself, otherwise the previous symmetric extension would inflate
    // the next layout and compound on every resize.
    const existingWrapper = table.parentElement?.classList.contains("table-scroll")
      ? table.parentElement
      : null;
    const container = existingWrapper?.parentElement || table.parentElement;
    const parentWidth = container?.getBoundingClientRect?.().width
      || container?.clientWidth
      || root.getBoundingClientRect?.().width
      || root.clientWidth
      || DEFAULT_AVAILABLE_WIDTH;
    // Reserve the frame's padding before allocating cell widths.
    // Otherwise a table that nominally fits makes its own scroll wrapper
    // wider than its client area by exactly that outer chrome.
    const availableWidth = Math.max(1, (Number(options.availableWidth) || parentWidth) - TABLE_SCROLL_INLINE_CHROME);
    // The shared allocator's default unit is calibrated for Live's 0.9em
    // monospace table surface. Reader tables inherit the real theme font at
    // normal text size, so reusing 7.2px underestimates short CJK headers
    // (for example “当前上限”) and can wrap them despite available space.
    // Derive the Reader measurement unit and cell chrome from the actual
    // rendered header cell while keeping explicit test/caller overrides.
    const sampleCell = table.rows?.[0]?.cells?.[0] || null;
    const sampleStyle = sampleCell?.ownerDocument?.defaultView?.getComputedStyle?.(sampleCell) || null;
    const renderedFontSize = Number.parseFloat(sampleStyle?.fontSize) || 0;
    const renderedCellChrome = sampleStyle
      ? ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"]
        .reduce((sum, key) => sum + (Number.parseFloat(sampleStyle[key]) || 0), 0)
      : 0;
    const layout = computeBalancedTableColumns(tableRows(table), {
      availableWidth,
      cellChromePx: options.cellChromePx ?? (renderedCellChrome || DEFAULT_CELL_CHROME_PX),
      unitPx: options.unitPx ?? (renderedFontSize > 0 ? renderedFontSize / 2 : DEFAULT_UNIT_PX),
    });
    if (!layout.widths.length) continue;

    const documentRef = table.ownerDocument || document;
    const colgroup = documentRef.createElement("colgroup");
    colgroup.dataset.tableLayout = "balanced";
    for (const width of layout.widths) {
      const col = documentRef.createElement("col");
      col.style.width = `${width}px`;
      colgroup.append(col);
    }
    table.querySelector('colgroup[data-table-layout="balanced"]')?.remove();
    table.prepend(colgroup);
    table.dataset.columnLayout = "balanced";
    table.style.setProperty("--table-layout-width", `${layout.totalWidth}px`);

    let wrapper = existingWrapper;
    if (!wrapper) {
      wrapper = documentRef.createElement("div");
      wrapper.className = "table-scroll";
      table.replaceWith(wrapper);
      wrapper.append(table);
    }

    // Symmetric overflow decision, measured against the real pane and text
    // column bounds so a wide table can never be painted under an open
    // explorer or outline. Falls back to the container width when the layout
    // has not been painted yet (unit tests, detached fixtures).
    const columnRect = container?.getBoundingClientRect?.() || null;
    const columnLeft = Number(columnRect?.left) || 0;
    const columnWidth = Number(options.columnWidth) || Number(columnRect?.width) || parentWidth;
    const clipFallback = { left: columnLeft, right: columnLeft + columnWidth, width: columnWidth };
    const clip = options.paneBounds || nearestInlineClipBounds(wrapper, clipFallback);
    const geometry = computeTableOverflowGeometry(
      layout.totalWidth + TABLE_SCROLL_INLINE_CHROME,
      columnWidth,
      Number(options.availableInlineWidth) || clip.width,
      {
        paneLeft: clip.left,
        paneRight: clip.right,
        columnLeft,
        columnRight: columnLeft + columnWidth,
        safety: options.safety ?? TABLE_PANE_SAFETY,
      },
    );
    wrapper.style.setProperty("--table-symmetric-extension", `${geometry.extension}px`);

    // Overflow is a layout decision, not an incidental 1–2px browser artifact.
    // Only enable the horizontal scroller when the readable minimums genuinely
    // exceed the width available after symmetric gutter growth.
    wrapper.dataset.tableOverflow = geometry.overflow ? "true" : "false";
    table.dataset.tableOverflow = geometry.overflow ? "true" : "false";
    if (!geometry.overflow && Math.abs(wrapper.scrollLeft) > 0.5) wrapper.scrollLeft = 0;

    layouts.push({ table, ...layout, geometry });
  }
  return layouts;
}

/**
 * Keep an already-rendered Reader responsive. A window/pane resize changes the
 * gutter available for symmetric table overflow; without a forced re-run the
 * fixed extension computed at render time could push a wide table's left edge
 * outside the pane. Returns a disposer (used by tests and future cleanup).
 */
export function observeRenderedTableRelayout(getRoot, isActive, options = {}) {
  const root = getRoot?.();
  const win = root?.ownerDocument?.defaultView
    || (typeof window !== "undefined" ? window : null);
  if (!win?.addEventListener) return () => {};
  let timer;
  const runNow = () => {
    const current = getRoot?.();
    if (!current || (typeof isActive === "function" && !isActive())) return;
    layoutRenderedTables(current, { ...options, force: true });
  };
  const schedule = () => {
    if (typeof isActive === "function" && !isActive()) return;
    win.clearTimeout(timer);
    timer = win.setTimeout(runNow, options.debounceMs ?? 90);
  };
  win.addEventListener("resize", schedule, { passive: true });
  // A sidebar/outline toggle or a pane-resizer drag changes the document pane
  // without a window resize. Re-run off the real pane geometry so a stale
  // symmetric extension can never end up under the explorer.
  const observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(schedule) : null;
  const watched = new Set();
  if (observer) {
    for (const node of [
      root,
      root?.querySelector?.(".markdown-preview-sizer"),
      root?.closest?.(".document"),
    ]) {
      if (node && !watched.has(node)) {
        watched.add(node);
        observer.observe(node);
      }
    }
  }
  return () => {
    win.clearTimeout(timer);
    win.removeEventListener("resize", schedule);
    observer?.disconnect();
  };
}
