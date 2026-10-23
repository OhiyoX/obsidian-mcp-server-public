/**
 * Pure device-pixel grid arithmetic for the caret paint step.
 *
 * CodeMirror's `drawSelection()` positions cursors at fractional CSS
 * coordinates derived from glyph advances. Painting a fixed-width caret at a
 * fractional coordinate makes the two vertical edges land between device
 * pixels. The previous implementation corrected that with a fractional CSS
 * `translate`, which is itself painted as a sub-pixel transform and therefore
 * *introduces* antialiased edges at DPR 1/2 where Blink would otherwise snap the
 * layout box. These helpers instead move the layout `left` onto the device grid
 * so the browser's own pixel snapping keeps both edges crisp.
 *
 * This is paint-only arithmetic: it never reads or writes editor position
 * state. See `caret.js` for the DOM application and `app/test/editor-caret.test.js`
 * for the contract.
 */

/** Nearest device-pixel grid x for a CSS-pixel layout coordinate. */
export function deviceGridLeft(layoutLeft, dpr) {
  const scale = Math.max(1, Number(dpr) || 1);
  return Math.round(layoutLeft * scale) / scale;
}

/**
 * Whether a cursor already holds the value we chose, comparing against the
 * value read back from the DOM (not the requested one). Blink serializes and
 * rounds `style.left` to its 1/64 px LayoutUnit, so remembering the requested
 * float would re-fire the observer forever at fractional DPR.
 */
export function caretSnapSettled(rawLeft, snappedLeft) {
  return snappedLeft !== undefined && Math.abs(snappedLeft - rawLeft) < 1e-6;
}

/**
 * Compute the layout `left` write that puts `viewportLeft` on the device grid.
 *
 * @param {{ rawLeft: number, viewportLeft: number, dpr: number }} input
 *   `rawLeft` is the current inline layout `left` (offset-parent relative);
 *   `viewportLeft` is the current `getBoundingClientRect().left`.
 * @returns {{ left: number, delta: number, changed: boolean }}
 */
export function caretPaintTarget({ rawLeft, viewportLeft, dpr }) {
  const target = deviceGridLeft(viewportLeft, dpr);
  const delta = target - viewportLeft;
  return { left: rawLeft + delta, delta, changed: Math.abs(delta) > 1e-4 };
}

/**
 * Blink's internal layout unit. `caretPaintTarget` returns `rawLeft + delta` as a
 * double, but the browser stores the written `style.left` as a LayoutUnit and
 * serializes the *specified* float back out of the CSSOM, so the two can differ.
 *
 * That gap is the DPR=2 "437.484375" regression: CodeMirror wrote
 * `left: 123.281px` (used 123.28125), the snap computed `123.281 + 0.21875 =
 * 123.49975`, Blink truncated it to 123.484375 and the caret landed one 1/64 px
 * short of the 0.5 px device grid at `rect.left = 437.484375` instead of 437.5.
 * Pre-rounding the write onto the LayoutUnit grid makes that conversion exact,
 * because the desired layout left is itself an integral number of LayoutUnits.
 */
export const LAYOUT_UNIT = 1 / 64;

/** Nearest LayoutUnit grid value for a CSS-pixel write. */
export function layoutUnitLeft(value, unit = LAYOUT_UNIT) {
  const step = Number(unit) > 0 ? Number(unit) : LAYOUT_UNIT;
  return Math.round(Number(value) / step) * step;
}
