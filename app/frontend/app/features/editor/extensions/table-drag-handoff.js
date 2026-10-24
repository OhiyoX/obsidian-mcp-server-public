// H1 P0-1: a drag that starts inside a rendered table block must not be frozen
// inside that block.
//
// `table-cell-editor.js` owns the pointerdown for in-table text selection with
// native DOM ranges. That handler captures `pointermove` on the document and
// keeps every focus point inside `.cm-table-widget`, so a drag started in a
// cell can never extend into the prose around the table. It also stops the
// pointerdown before it reaches `attachInteractionHandlers`, so the shared
// `interactionField` freeze (`isInteractionFrozen`) is never engaged while the
// gesture continues in the root editor.
//
// These helpers hold the geometry/position arithmetic so the decision stays a
// deterministic Node unit test; the DOM wiring lives in `table-cell-editor.js`.
//
// Nothing here reads the DOM: it must remain testable without a browser.

export const TABLE_DRAG_HANDOFF_TOLERANCE_PX = 2;

/**
 * Whether a pointer point has left the table block's bounding box.
 * `rect` is a `getBoundingClientRect()`-shaped object; `tolerance` absorbs the
 * one-pixel rounding gap between the widget border and the pointer point.
 */
export function pointerLeftBlock(rect, point, tolerance = TABLE_DRAG_HANDOFF_TOLERANCE_PX) {
  if (!rect || !point) return false;
  const slack = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x < rect.left - slack
    || x > rect.right + slack
    || y < rect.top - slack
    || y > rect.bottom + slack;
}

/**
 * Clamp a document position into the document. `posAtCoords` may answer null
 * (or a fractional position) for points at the viewport edge; a handoff must
 * never invent a position outside the document.
 */
export function clampDocPos(pos, docLength) {
  if (!Number.isFinite(pos)) return null;
  const length = Number.isFinite(docLength) ? Math.max(0, Math.round(docLength)) : 0;
  return Math.max(0, Math.min(Math.round(pos), length));
}

/**
 * Which document position a handed-off gesture anchors at. The anchor is fixed
 * once, at the moment of handoff, so later pointermoves only move the head.
 *
 * A block widget maps every inside point onto one of its boundaries, so the
 * first focus point past the block says which side the drag is going. Anchor at
 * the opposite table edge and the whole rendered block participates in the
 * selection (`sliceDoc` stays the Markdown the user dragged through) instead of
 * silently starting after it.
 */
export function handoffAnchorPosition({ blockFrom, blockTo, pointerPos } = {}) {
  const pos = clampDocPos(pointerPos, Number.MAX_SAFE_INTEGER);
  if (pos == null) return null;
  const from = clampDocPos(blockFrom, Number.MAX_SAFE_INTEGER);
  const to = clampDocPos(blockTo, Number.MAX_SAFE_INTEGER);
  if (from == null || to == null) return pos;
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  if (pos >= high) return low;
  if (pos <= low) return high;
  return pos;
}
