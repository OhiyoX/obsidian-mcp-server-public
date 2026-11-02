// Issue #337 Cut 3 (Bases table touch) — Node line.
//
// The browser scene (`scripts/web-regression/bases-table-touch.mjs`) owns the real
// finger, the computed styles and the geometry; this file pins the pieces a
// headless DOM can decide exactly:
//
//   - the coarse-pointer capability seam (including every "cannot answer" path,
//     which must stay on the desktop side);
//   - the resize refusal: a coarse pointer attaches no drag listener at all, while a
//     fine pointer still resizes (the seam is not a blanket off switch);
//   - the tap-selection state machine, its row identity across re-renders, and the
//     link priority mechanism (`stopPropagation` is what keeps a link tap from
//     selecting the row, so it is asserted directly);
//   - the stylesheet contract: the touch rules live only in the `(pointer: coarse)`
//     block and the desktop rules are byte-identical.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { COARSE_POINTER_QUERY, isCoarsePointer, nextSelectionKey } from "../frontend/app/features/bases/pointer-policy.js";
import { attachColumnResize, createResizeHandle } from "../frontend/app/features/bases/resize.js";
import { createBaseState } from "../frontend/app/features/bases/state.js";
import { BASE_SURFACE_CSS } from "../frontend/app/features/bases/styles.js";
import { createBaseView } from "../frontend/app/features/bases/view.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;
if (typeof document.createElementNS !== "function") {
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
}

const ROUTE = "/app/base/r";
const BASE_PATH = "40-Projects/Projects.base";

const coarseWindow = (matches = true) => ({
  matchMedia(query) {
    return { matches: query === COARSE_POINTER_QUERY ? matches : false, media: query };
  },
});

function baseState(overrides = {}) {
  const state = createBaseState();
  state.vaultId = "vault-1";
  state.path = BASE_PATH;
  state.route = ROUTE;
  state.views = [{ name: "Table", type: "table" }];
  state.view = { name: "Table", type: "table" };
  state.columns = [
    { key: "name", label: "Name", kind: "string" },
    { key: "status", label: "Status", kind: "string" },
    { key: "link", label: "Link", kind: "string" },
  ];
  state.rows = [
    { path: "Notes/A.md", values: { name: "A", status: "active", link: { kind: "asLink", path: "Notes/A.md", displayName: "A" } } },
    { path: "Notes/B.md", values: { name: "B", status: "archived", link: { kind: "asLink", path: "Notes/B.md", displayName: "B" } } },
  ];
  state.totalMatched = 2;
  return Object.assign(state, overrides);
}

function renderView({ windowObject = null, onOpenNote = () => {} } = {}) {
  const host = document.createElement("div");
  const view = createBaseView({ doc: document, host, windowObject, onOpenNote });
  view.render(baseState());
  return { host, view };
}

const rowsOf = (host) => host.querySelectorAll(".base-table tbody tr");
const isSelected = (row) => row.getAttribute("aria-selected") === "true";

test("the coarse-pointer seam answers false for every window it cannot interrogate", () => {
  assert.equal(COARSE_POINTER_QUERY, "(pointer: coarse)");
  assert.equal(isCoarsePointer(coarseWindow(true)), true);
  assert.equal(isCoarsePointer(coarseWindow(false)), false);
  assert.equal(isCoarsePointer({}), false, "a window without matchMedia must stay on the desktop side");
  assert.equal(isCoarsePointer(null), false);
  assert.equal(typeof globalThis.matchMedia, "undefined", "the Node harness must not carry a matchMedia");
  assert.equal(isCoarsePointer(globalThis), false, "the harness global must resolve to the fine-pointer side");
  assert.equal(isCoarsePointer({ matchMedia() { throw new Error("no media queries"); } }), false, "a throwing matchMedia must not break rendering");
});

test("the tap selection transition toggles off only on the selected row", () => {
  assert.equal(nextSelectionKey(null, "a"), "a");
  assert.equal(nextSelectionKey("a", "b"), "b");
  assert.equal(nextSelectionKey("a", "a"), null);
  assert.equal(nextSelectionKey(null, null), null);
  assert.equal(nextSelectionKey("a", undefined), "a");
});

// --- column resize policy ---------------------------------------------------

function resizeFixture() {
  const headRow = document.createElement("tr");
  const handle = createResizeHandle(document, "name", "Name");
  headRow.appendChild(handle);
  return { headRow, handle, columns: [{ key: "name", label: "Name" }], widths: { name: 220 } };
}

test("a coarse pointer never attaches the column drag, a fine pointer still resizes", () => {
  const coarse = { commits: [], previews: [] };
  const coarseFixture = resizeFixture();
  const coarseAttached = attachColumnResize({
    ...coarseFixture,
    windowObject: coarseWindow(true),
    onPreview: (key, width) => coarse.previews.push([key, width]),
    onCommit: (key, width) => coarse.commits.push([key, width]),
  });
  assert.equal(coarseAttached.disabled, true, "the coarse policy must be reported, not silently ignored");
  coarseFixture.handle.dispatchEvent({ type: "pointerdown", clientX: 200 });
  coarseFixture.handle.dispatchEvent({ type: "pointermove", clientX: 300 });
  coarseFixture.handle.dispatchEvent({ type: "pointerup", clientX: 300 });
  assert.deepEqual(coarse.previews, [], "no preview may be produced on a coarse pointer");
  assert.deepEqual(coarse.commits, [], "no width may be committed on a coarse pointer");
  assert.equal(coarseFixture.handle.getAttribute("data-dragging"), null, "no drag state may be set");

  const fine = { commits: [] };
  const fineFixture = resizeFixture();
  const fineAttached = attachColumnResize({
    ...fineFixture,
    windowObject: coarseWindow(false),
    onCommit: (key, width) => fine.commits.push([key, width]),
  });
  assert.equal(fineAttached.disabled, undefined, "a fine pointer keeps the desktop behaviour");
  fineFixture.handle.dispatchEvent({ type: "pointerdown", clientX: 200 });
  fineFixture.handle.dispatchEvent({ type: "pointermove", clientX: 260 });
  fineFixture.handle.dispatchEvent({ type: "pointerup", clientX: 260 });
  assert.deepEqual(fine.commits, [["name", 280]], "the desktop drag must still resize");
});

// --- row selection ----------------------------------------------------------

test("a tap selects one row, moves the selection, clears it and survives a re-render", () => {
  const { host, view } = renderView({ windowObject: coarseWindow(true) });
  const [first, second] = rowsOf(host);
  assert.equal(isSelected(first), false);

  first.click();
  assert.equal(isSelected(first), true, "a tap on a row must select it");
  assert.equal(first.className.includes("is-selected"), true, "the selection must carry its class too");
  assert.equal(isSelected(second), false);
  assert.equal(view.getSelectedKey(), "Notes/A.md", "the selection is keyed by the row path");

  second.click();
  assert.equal(isSelected(first), false, "selecting another row must clear the previous one");
  assert.equal(isSelected(second), true);

  second.click();
  assert.equal(isSelected(second), false, "tapping the selected row again must clear it");
  assert.equal(view.getSelectedKey(), null);

  second.click();
  view.render(baseState());
  const rerendered = rowsOf(host);
  assert.equal(isSelected(rerendered[1]), true, "a re-render must re-apply the selection by row path");
  assert.equal(isSelected(rerendered[0]), false);
});

test("a fine pointer keeps the desktop table: rows are not selectable", () => {
  const fine = renderView({ windowObject: coarseWindow(false) });
  assert.equal(rowsOf(fine.host)[0].getAttribute("aria-selected"), null);
  rowsOf(fine.host)[0].click();
  assert.equal(rowsOf(fine.host)[0].getAttribute("aria-selected"), null, "a fine pointer must never gain the row selection");

  const noMedia = renderView({ windowObject: { addEventListener() {}, removeEventListener() {} } });
  rowsOf(noMedia.host)[0].click();
  assert.equal(rowsOf(noMedia.host)[0].getAttribute("aria-selected"), null, "a window without matchMedia keeps the desktop table");
});

test("a link tap stops the click and never selects its row", () => {
  const opened = [];
  const { host } = renderView({ windowObject: coarseWindow(true), onOpenNote: (arg) => opened.push(arg) });
  const link = host.querySelectorAll(".base-cell-link")[0];
  assert.notEqual(link, null);
  let stopped = 0;
  let prevented = 0;
  link.dispatchEvent({
    type: "click",
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
  });
  assert.deepEqual(opened, [{ path: "Notes/A.md" }], "the link must still open its note");
  assert.equal(prevented, 1, "the link must keep preventing the default navigation");
  assert.equal(stopped, 1, "stopPropagation is the mechanism that keeps the row selection away");
  assert.equal(isSelected(rowsOf(host)[0]), false, "the link's row must not become selected");
});

// --- stylesheet contract ----------------------------------------------------

test("the touch rules live only in the (pointer: coarse) block and the desktop rules are unchanged", () => {
  const coarseAt = BASE_SURFACE_CSS.indexOf("@media (pointer: coarse){");
  assert.ok(coarseAt > 0, "the coarse-pointer block must exist");
  const coarseBlock = BASE_SURFACE_CSS.slice(coarseAt);
  assert.match(coarseBlock, /\.base-table-wrap\{touch-action:pan-x pan-y;\}/, "both pan axes must be left to the browser");
  assert.match(coarseBlock, /\.base-table tbody tr\{height:44px;\}/, "rows must be a 44px touch target");
  assert.match(coarseBlock, /\.base-table thead th \.base-col-resize\{display:none;\}/, "the resize handle must be hidden");
  assert.match(coarseBlock, /tr\[aria-selected="true"\]/, "the selection must be painted");
  assert.equal(
    BASE_SURFACE_CSS.match(/pan-x pan-y/g).length,
    1,
    "the two-axis declaration must exist exactly once, inside the coarse block",
  );
  // Desktop rules byte-identical: the container keeps `overflow:auto` and the handle
  // keeps `touch-action:none` (which is exactly why it must not be reachable by touch).
  assert.ok(
    BASE_SURFACE_CSS.includes(".base-table-wrap{flex:1 1 auto;min-height:0;max-height:100%;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;}"),
    "the desktop table container rule must be unchanged",
  );
  assert.ok(
    BASE_SURFACE_CSS.includes(".base-col-resize{position:absolute;top:0;right:-3px;bottom:0;width:7px;display:block;cursor:col-resize;background:transparent;touch-action:none;z-index:2;}"),
    "the desktop resize handle rule must be unchanged",
  );
  assert.ok(
    BASE_SURFACE_CSS.includes(".base-table tbody tr:hover{background:var(--background-modifier-hover,var(--hover));}"),
    "the desktop hover rule must be unchanged",
  );
});
