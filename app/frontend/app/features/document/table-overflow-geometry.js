// Shared table overflow geometry for the Reader and Live surfaces.
//
// A wide Markdown table may grow beyond the article text column, but only into
// the gutters that really exist between the text column and the clipping pane.
// Deriving that allowance from measured viewport bounds (instead of assumed
// centred gutters) is what keeps a wide table out from under an open explorer
// or outline, including asymmetric scrollbar/padding and pane resizes.

// Reserve visible space around wide tables, including on narrow/mobile panes.
// The table's own cell borders and its scroll wrapper must stay clear of the
// clipping pane edge.
export const TABLE_PANE_SAFETY = 16;

/**
 * Decide how far a table wider than its text column may grow into the
 * surrounding inline gutters on each side. Reading and Live surfaces both want
 * the same visual rule: extra width is shared symmetrically around the article
 * text axis instead of dumping all overflow onto the right edge.
 *
 * When `bounds` carries the viewport coordinates of the clipping pane and of
 * the text column, the allowance is taken from the gutters that actually exist
 * on each side. This is what keeps a wide table from being painted under an
 * open explorer/outline when the text column is not centred (scrollbar gutter,
 * asymmetric padding, open sidebars). Without measured bounds the function
 * falls back to the historical width-based approximation.
 *
 * `availableWidth` is the widest the table's scroll container can be without
 * causing page overflow (the pane's client width). `extension` is the amount of
 * overhang applied to each side; when the natural table is wider than both real
 * gutters allow, the extension is capped and the remainder stays inside a local
 * horizontal scroller.
 */
export function computeTableOverflowGeometry(naturalWidth, columnWidth, availableWidth, bounds = null) {
  const column = Math.max(1, Number(columnWidth) || 0);
  const natural = Math.max(0, Number(naturalWidth) || 0);
  const pane = Math.max(column, Number(availableWidth) || 0);
  const overflow = Math.max(0, natural - column);
  const half = Math.max(0, (pane - column) / 2);
  const safety = Math.max(0, Number(bounds?.safety) || 0);
  const measured = bounds && [bounds.paneLeft, bounds.paneRight, bounds.columnLeft, bounds.columnRight]
    .every((value) => Number.isFinite(Number(value)));
  const allowedLeft = measured
    ? Math.max(0, Number(bounds.columnLeft) - Number(bounds.paneLeft) - safety)
    : half;
  const allowedRight = measured
    ? Math.max(0, Number(bounds.paneRight) - Number(bounds.columnRight) - safety)
    : half;
  const maxExtension = Math.min(allowedLeft, allowedRight);
  const extension = Math.min(overflow / 2, maxExtension);
  const visibleWidth = column + extension * 2;
  return {
    extension,
    maxExtension,
    allowedLeft,
    allowedRight,
    visibleWidth,
    // A local scroller is required only when the natural readable width cannot
    // fit inside the two real gutters.
    overflow: natural > visibleWidth + 0.5,
  };
}

// Walk up to the nearest element that clips inline overflow (for example the
// Reader pane or the Live editor scroller). Its viewport bounds describe the
// widest a table may occupy before the page itself starts to scroll; the right
// edge uses clientWidth so a vertical scrollbar is never counted as usable
// space. Publishing routes that do not wrap tables in a clipping pane fall back
// to the text column bounds.
export function nearestInlineClipBounds(element, fallback) {
  let node = element?.parentElement || null;
  while (node) {
    const view = node.ownerDocument?.defaultView;
    const style = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(node) : null;
    if (style && style.overflowX !== "visible" && node.clientWidth > 0) {
      const left = Number(node.getBoundingClientRect?.().left) || 0;
      return { left, right: left + node.clientWidth, width: node.clientWidth };
    }
    node = node.parentElement;
  }
  return fallback;
}

// Measure the real visible bounds of the Live editor. Live Preview CSS first
// places .cm-content on the same centred document axis as Reader; table layout
// then consumes those painted boxes directly. No table-specific gutter,
// scrollbar or canonical-axis compensation belongs in this measurement layer.
export function measureLiveTableMetrics(view) {
  const scroller = view.scrollDOM;
  const content = view.contentDOM;
  const scrollerRect = scroller?.getBoundingClientRect?.();
  const contentRect = content?.getBoundingClientRect?.();

  const paneLeft = Number(scrollerRect?.left) || 0;
  const paneWidth = Math.max(
    1,
    Number(scroller?.clientWidth) || Number(scrollerRect?.width) || Number(content?.clientWidth) || 700,
  );
  const paneRight = paneLeft + paneWidth;

  // Live Preview's CSS owns document-axis parity with Reader. Measure that
  // actual content box directly instead of reconstructing a second canonical
  // column from scrollbar, gutter and historical offset compensation.
  const measuredColumnLeft = Number(contentRect?.left);
  const columnLeft = Number.isFinite(measuredColumnLeft) ? measuredColumnLeft : paneLeft;
  const measuredColumnWidth = Number(contentRect?.width) || Number(content?.clientWidth) || paneWidth;
  const columnWidth = Math.max(1, Math.min(measuredColumnWidth, paneRight - columnLeft));
  const columnRight = columnLeft + columnWidth;

  return {
    paneWidth,
    paneLeft,
    paneRight,
    columnWidth,
    columnLeft,
    columnRight,
  };
}

// Build the shared overflow properties for callers that need a serialized
// Live table style. The same geometry function is used by Reader and Table V2;
// any excess beyond the visible frame remains table-local horizontal overflow.
export function liveTableOverflowStyle(metrics, naturalWidth) {
  const geometry = computeTableOverflowGeometry(naturalWidth, metrics.columnWidth, metrics.paneWidth, {
    paneLeft: metrics.paneLeft,
    paneRight: metrics.paneRight,
    columnLeft: metrics.columnLeft,
    columnRight: metrics.columnRight,
    safety: TABLE_PANE_SAFETY,
  });
  return {
    style: `--table-total-width:${naturalWidth}px;--table-visible-width:${geometry.visibleWidth}px;--table-symmetric-extension:${geometry.extension}px`,
  };
}
