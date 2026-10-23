// Viewport placement for the Base action popovers (排序 / 筛选 / 属性 / 搜索 / 新建).
//
// The popover is the anchor's child (that ownership is frozen by
// `test/web-bases-popovers.test.js`) and its box is the desktop `.menu` box, i.e.
// `position:fixed` (styles.js, P0 of the CSS-port lane), so the shell no longer clips it:
// `.document`, `.workspace`
// and `.shell` are all `overflow:hidden`, and a popover that needs more room than the
// document column has left of its button is CUT OFF — it is not painted under the
// explorer. Real Chromium at 1024x800 (dark, `elementFromPoint` over the popover's own
// box) shows the mechanism directly: `elementsFromPoint` does not list the popover at all
// left of x=315, which is the document column's edge, and a box that is only occluded
// would still be listed. Readings: `evidence/readings.json`.
//
// No ancestor on that chain carries `transform` / `filter` / `contain` (recorded per
// ancestor in the same reading), so a `position:fixed` box is placed against the viewport
// — the same repair `ui/popup-position.js` already applies to the
// sidebar's own popups. Nothing here changes the popover's `z-index`: the fix is where the
// box is laid out, never what it paints over.
//
// Horizontally the popover prefers to stay inside the document column, so a narrow desktop
// keeps it out of the explorer instead of covering the user's navigation, and falls back to
// the viewport when the popover cannot fit in the column at all. Vertically it keeps the
// stylesheet's own `top: calc(100% + 6px)` and `max-height`, so every width above the
// 720px breakpoint paints the same box height it painted before.
//
// Below that breakpoint the stylesheet already lays the popover out against the action row
// (<=720px) or as the full-bleed overlay (<=480px), so the positioner clears its inline
// placement and does nothing.
export const PANEL_VIEWPORT_MARGIN = 12; // the stylesheet's own `calc(100vw - 24px)`
export const PANEL_DESKTOP_MIN_WIDTH = 720;
// The stylesheet's own gap below the anchor: `top:calc(100% + 6px)` (the `<=720px` band still
// declares exactly that). A `position:fixed` box with `top:auto` would otherwise lay out at
// its static position, which is the anchor's own top, not below it.
export const PANEL_ANCHOR_GAP = 6;

// Pure layout: one measured popover rect, the document column and the viewport width ->
// the `position:fixed` offsets. `null` means "leave the stylesheet's layout alone".
export function computePanelPlacement({ panel, column, viewport, margin = PANEL_VIEWPORT_MARGIN } = {}) {
  const width = Number(panel?.width) || 0;
  const viewportWidth = Number(viewport?.width) || 0;
  if (!width || !viewportWidth) return null;
  const left = Number(panel?.left) || 0;
  const viewportRight = Math.max(margin, viewportWidth - margin - width);
  const columnLeft = Number(column?.left);
  const columnRight = Number(column?.right);
  // Inside the column while the popover fits in it — a narrow desktop then keeps the
  // popover out of the explorer instead of covering the user's navigation — and inside the
  // viewport otherwise, so a column narrower than the popover still cannot clip it away.
  const inColumn = Number.isFinite(columnLeft) && Number.isFinite(columnRight) && columnRight - columnLeft >= width;
  const floor = inColumn ? Math.max(margin, columnLeft) : margin;
  const ceiling = inColumn ? Math.min(viewportRight, columnRight - width) : viewportRight;
  return {
    left: Math.round(Math.min(Math.max(left, floor), Math.max(floor, ceiling))),
    top: Math.round(Number(panel?.top) || 0),
  };
}

// DOM wiring. `resolvePanel` returns the live popover (or null when none is open),
// `resolveColumn` the document column, and `win` is the window whose coordinates we place
// against. Both resolvers are called on every sync, never captured at construction.
export function createPanelPositioner({ win = null, resolvePanel, resolveColumn } = {}) {
  let last = null;
  // The surface re-renders rebuild the panel node WITHOUT its inline placement, so the
  // "nothing moved" memo has to be keyed on the node as well: with only the anchor key, a
  // re-render (adding a sort row, typing in the filter) left the fresh node at its static
  // position — over the action buttons it hangs from. Caught by the lane's Chromium probe.
  let lastPanel = null;

  function sync() {
    const panel = resolvePanel?.();
    if (!panel?.style) {
      // Nothing is open: forget the last anchor, or a re-open at the same place would
      // skip the placement and leave the popover on the stylesheet's clipped layout.
      last = null;
      lastPanel = null;
      return;
    }
    const desktop = win && Number(win.innerWidth) > PANEL_DESKTOP_MIN_WIDTH;
    // `parentNode`, not `parentElement`: the anchor is the popover's parent (pinned by
    // `web-bases-popovers.test.js`) and the minimal DOM harness the tests use has no
    // `parentElement`.
    const anchor = desktop ? panel.parentNode?.getBoundingClientRect?.() : null;
    // The anchor did not move and the window did not change size: the placement below is
    // still correct, so a scroll of the table (the shell scrolls the document, not the
    // page) costs nothing.
    const key = desktop && anchor ? `${Math.round(anchor.left)},${Math.round(anchor.right)},${win.innerWidth}` : null;
    if (key && key === last && panel === lastPanel) return;
    last = key;
    lastPanel = panel;
    // Clear first: the measurement has to be the stylesheet's own layout, or a re-place
    // after a resize would read this function's own previous offsets back.
    panel.style.position = "";
    panel.style.right = "";
    panel.style.left = "";
    panel.style.top = "";
    if (!desktop) return;
    // The stylesheet's own geometry relative to the ANCHOR is what this module has to reproduce
    // now that the box is `position:fixed` (a fixed box with `left/top:auto` lays out at its
    // static position, which is the anchor's own left/top). The desktop/`.33` box sat
    // `right:0; top:calc(100% + 6px)` inside the anchor, i.e. `anchor.right - width` and
    // `anchor.bottom + PANEL_ANCHOR_GAP` — the `<=720px` band still declares exactly that. The
    // real-Chromium probe caught the difference: with the static-position left the panel covered
    // the action buttons to its left instead of hanging under its own button.
    const measured = panel.getBoundingClientRect();
    const width = measured.width;
    const placement = computePanelPlacement({
      panel: {
        left: anchor ? Number(anchor.right) - width : measured.left,
        top: anchor ? Number(anchor.bottom) + PANEL_ANCHOR_GAP : measured.top,
        width,
      },
      column: resolveColumn?.()?.getBoundingClientRect?.(),
      viewport: { width: win.innerWidth },
    });
    if (!placement) return;
    panel.style.position = "fixed";
    panel.style.right = "auto";
    panel.style.left = `${placement.left}px`;
    panel.style.top = `${placement.top}px`;
  }

  return { sync };
}