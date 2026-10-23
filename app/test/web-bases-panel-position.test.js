// The Base action popovers must be fully visible and clickable at every width above the
// stylesheet's 720px breakpoint, where the shell clips them.
//
// `features/bases/panel-position.js` re-bases the open popover on the viewport (the
// shell's `.document`/`.workspace`/`.shell` are all `overflow:hidden`, so an
// `position:absolute` popover that needs more room than the document column has left of its
// button is CUT OFF, not painted under the sidebar). These are the unit-level halves:
//
//   ① the pure layout: a popover that would start left of the document column is placed
//      inside the column; a popover that already fits keeps its anchor alignment byte for
//      byte (the 1440 reading must not move). Removing the clamp fails ①.
//   ② the wiring: a window resize re-places the open popover, so the placement follows the
//      anchor. Deleting the `resize`/`scroll` registration fails ②.
//
// The real-browser geometry (elementFromPoint over the popover's own box at 1440/1024/720,
// the clip-vs-paint-order discriminator, the per-ancestor z-index/overflow chain) is
// asserted by the lane probe in `evidence/`, not here.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBaseToolbar } from "../frontend/app/features/bases/toolbar.js";
import {
  PANEL_DESKTOP_MIN_WIDTH,
  PANEL_VIEWPORT_MARGIN,
  computePanelPlacement,
  createPanelPositioner,
} from "../frontend/app/features/bases/panel-position.js";

// The document column at a 1024x800 viewport: the sidebar owns x < 315.
const COLUMN_1024 = { left: 315, right: 773, top: 52, bottom: 140, width: 458, height: 88 };
// The filter popover's own stylesheet layout there: right-aligned to its button, i.e. it
// starts 77px inside the sidebar and is clipped at the column's edge.
const CLIPPED = { left: 238, top: 134, right: 558, bottom: 338, width: 320, height: 204 };

function fakeWindow(width) {
  const listeners = new Map();
  return {
    innerWidth: width,
    listenerCount: (type) => (listeners.get(type) ?? []).length,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    emit(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type });
    },
  };
}

function fakePanel(rect, anchorRect) {
  return {
    style: { position: "", right: "", left: "", top: "" },
    parentNode: { getBoundingClientRect: () => anchorRect },
    // The positioner clears its own inline placement before measuring, so this is always
    // the stylesheet's layout — exactly what a browser would report at that moment.
    getBoundingClientRect: () => rect,
  };
}

// --- ① the pure layout ------------------------------------------------------

test("a popover that would be clipped is placed inside the document column", () => {
  const placement = computePanelPlacement({
    panel: CLIPPED,
    column: COLUMN_1024,
    viewport: { width: 1024 },
  });
  // The clamp, not a re-anchor: the popover keeps its vertical geometry and only moves right
  // as far as the column's own left edge.
  assert.deepEqual(placement, { left: 315, top: 134 });
  assert.ok(placement.left >= COLUMN_1024.left, "no part of the box may stay left of the column");
  assert.ok(placement.left + CLIPPED.width <= COLUMN_1024.right, "and none may run past its right edge");
});

test("a popover that already fits keeps its anchor alignment", () => {
  // The 1440x900 reading: the column is 874 wide, so the popover is not moved at all.
  const column = { left: 315, right: 1189, width: 874, height: 50 };
  const panel = { left: 654, top: 96, width: 320, height: 204 };
  assert.deepEqual(computePanelPlacement({ panel, column, viewport: { width: 1440 } }), { left: 654, top: 96 });
  // 720x900 is below the breakpoint: the positioner never runs, and the stylesheet's own
  // action-row layout (which already fits) is what the probe reads there.
  assert.equal(PANEL_DESKTOP_MIN_WIDTH, 720);
});

test("a column narrower than the popover falls back to the viewport instead of shrinking it", () => {
  // 800x800: the document column is 234 wide, so the popover cannot fit in it. It stays on
  // screen at the desktop width rather than being clipped or squeezed.
  const placement = computePanelPlacement({
    panel: { left: 138, top: 134, width: 320, height: 204 },
    column: { left: 315, right: 549, width: 234, height: 88 },
    viewport: { width: 800 },
  });
  assert.equal(placement.left, 138, "the anchor alignment is kept when the viewport can hold it");
  assert.ok(placement.left + 320 <= 800 - PANEL_VIEWPORT_MARGIN, "still fully inside the viewport");
});

test("an unmeasured popover or viewport is left to the stylesheet", () => {
  assert.equal(computePanelPlacement({ panel: { width: 0 }, column: COLUMN_1024, viewport: { width: 1024 } }), null);
  assert.equal(computePanelPlacement({ panel: CLIPPED, column: COLUMN_1024, viewport: { width: 0 } }), null);
  assert.equal(computePanelPlacement(), null);
});

// --- ② the wiring ----------------------------------------------------------

test("the positioner re-places the open popover on every window resize", () => {
  const win = fakeWindow(1024);
  let panel = fakePanel(CLIPPED, { left: 495, top: 100, right: 558, bottom: 128, width: 63, height: 28 });
  let column = { getBoundingClientRect: () => COLUMN_1024 };
  const positioner = createPanelPositioner({ win, resolvePanel: () => panel, resolveColumn: () => column });
  positioner.sync();
  assert.equal(panel.style.position, "fixed");
  assert.equal(panel.style.right, "auto");
  assert.equal(panel.style.left, "315px");
  assert.equal(panel.style.top, "134px");

  // The 1440 -> 1200 pair from the lane probe: no clamp is active at either width, so the
  // popover must track its anchor exactly. A positioner that never re-derived the offsets
  // would leave the 1024 numbers here.
  panel = fakePanel({ left: 414, top: 96, right: 734, bottom: 300, width: 320, height: 204 }, { left: 671, top: 62, right: 734, bottom: 90, width: 63, height: 28 });
  column = { getBoundingClientRect: () => ({ left: 315, right: 949, width: 634, height: 50 }) };
  win.innerWidth = 1200;
  positioner.sync();
  assert.equal(panel.style.left, "414px");
  assert.equal(panel.style.top, "96px");

  // And back to 1024: the clamp is re-derived from the column on every placement, it is not
  // a one-off nudge applied at open time.
  panel = fakePanel(CLIPPED, { left: 495, top: 100, right: 558, bottom: 128, width: 63, height: 28 });
  column = { getBoundingClientRect: () => COLUMN_1024 };
  win.innerWidth = 1024;
  positioner.sync();
  assert.equal(panel.style.left, "315px");
});

test("below the breakpoint the positioner hands the popover back to the stylesheet", () => {
  const win = fakeWindow(1024);
  const panel = fakePanel(CLIPPED, { left: 495, top: 100, right: 558, bottom: 128, width: 63, height: 28 });
  const positioner = createPanelPositioner({ win, resolvePanel: () => panel, resolveColumn: () => ({ getBoundingClientRect: () => COLUMN_1024 }) });
  positioner.sync();
  assert.equal(panel.style.position, "fixed");
  win.innerWidth = 720;
  positioner.sync();
  assert.equal(panel.style.position, "", "the <=720px rules own the layout again");
  assert.equal(panel.style.left, "");
  assert.equal(panel.style.top, "");
});

test("a closed popover clears the remembered anchor, so re-opening re-places it", () => {
  const win = fakeWindow(1024);
  const panel = fakePanel(CLIPPED, { left: 495, top: 100, right: 558, bottom: 128, width: 63, height: 28 });
  let open = true;
  const positioner = createPanelPositioner({ win, resolvePanel: () => (open ? panel : null), resolveColumn: () => ({ getBoundingClientRect: () => COLUMN_1024 }) });
  positioner.sync();
  assert.equal(panel.style.left, "315px");
  open = false;
  positioner.sync();
  panel.style.position = "";
  panel.style.left = "";
  panel.style.top = "";
  open = true;
  // Same anchor, same width: without the reset this would be skipped and the popover would
  // stay on the stylesheet's clipped layout.
  positioner.sync();
  assert.equal(panel.style.position, "fixed");
  assert.equal(panel.style.left, "315px");
});

test("a re-rendered panel node is placed again even when its anchor never moved", () => {
  // The surface rebuilds the panel node on every re-render (adding a sort row, typing in the
  // filter), and the fresh node carries no inline placement. The "nothing moved" memo is keyed
  // on the anchor, so it must also be keyed on the NODE: with the desktop `position:fixed` shell a
  // skipped placement leaves the panel at its static position, over the action buttons it hangs
  // from (real-Chromium reading in the lane's `evidence/after/readings.json`).
  const win = fakeWindow(1024);
  const anchor = { left: 495, top: 100, right: 558, bottom: 128, width: 63, height: 28 };
  let panel = fakePanel(CLIPPED, anchor);
  const positioner = createPanelPositioner({
    win,
    resolvePanel: () => panel,
    resolveColumn: () => ({ getBoundingClientRect: () => COLUMN_1024 }),
  });
  positioner.sync();
  assert.equal(panel.style.left, "315px");
  panel = fakePanel(CLIPPED, anchor);
  positioner.sync();
  assert.equal(panel.style.position, "fixed", "the fresh node must be placed, not left at its static position");
  assert.equal(panel.style.left, "315px");
  assert.equal(panel.style.top, "134px", "and it hangs below its anchor (anchor.bottom + the stylesheet's 6px gap)");
});

// --- the mounted surface ---------------------------------------------------

const harness = createDomHarness();
harness.install();
const document = harness.document;
if (typeof document.createElementNS !== "function") {
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
}

const COLUMNS = [{ key: "status", label: "Status", kind: "property" }];
const STATE = {
  view: "Table", viewType: "table", views: [{ name: "Table" }], sort: [], filter: [], q: "",
  columns: COLUMNS, rows: [], totalMatched: 0, path: "40-Projects/Projects.base",
};
const CONTEXT = { doc: document, columns: COLUMNS, allColumns: COLUMNS, config: { hidden: [], widths: {} } };

test("the mounted tool row places its open popover against the document column", () => {
  const win = fakeWindow(1024);
  document.defaultView = win;
  const toolbar = createBaseToolbar({
    doc: document,
    onSelectView: () => {},
    onSort: () => {},
    onFilter: () => {},
    onQuery: () => {},
    onToggleColumn: () => {},
    onHideAllColumns: () => {},
    onNewNote: () => {},
    queryDebounceMs: 0,
  });
  const cycle = () => {
    const header = toolbar.render(STATE, CONTEXT);
    document.body.appendChild(header);
    toolbar.afterMount(header, () => {});
    return header;
  };
  let header = cycle();
  document.querySelector('[data-base-action="filter"]').click();
  header = cycle();
  const panel = header.querySelector('[data-base-panel="filter"]');
  assert.notEqual(panel, null, "the filter popover opened");
  assert.equal(panel.parentNode.getAttribute("data-base-anchor"), "filter", "still owned by its anchor");
  // The harness reports zero rects, so the first placement is a no-op; a resize is the
  // measurement. This is the integration half of negative control ②: it only passes when
  // `toolbar.js` really registered the window listener and resolves the live column.
  header.getBoundingClientRect = () => COLUMN_1024;
  panel.getBoundingClientRect = () => CLIPPED;
  panel.parentNode.getBoundingClientRect = () => ({ left: 495, top: 100, right: 558, bottom: 128, width: 63, height: 28 });
  win.innerWidth = 1200;
  assert.ok(win.listenerCount("resize") >= 1, "the tool row owns a resize listener");
  assert.ok(win.listenerCount("scroll") >= 1);
  win.emit("resize");
  assert.equal(panel.style.position, "fixed");
  assert.equal(panel.style.left, "315px");
  assert.equal(panel.style.top, "134px");
  toolbar.destroy();
  assert.equal(win.listenerCount("resize"), 0, "the toolbar detaches every window listener it owns");
  assert.equal(win.listenerCount("scroll"), 0);
});
