// Bases action-popover layout pins (lane desktop-re/bases-ui-polish, owner report
// 2026-10-20).
//
// Two defects the owner photographed, one test file:
//
//   A — `全部属性` repeated the whole `已显示` list (and the tail of the popover,
//       footer included, painted outside the popover box).
//   B — the advanced filter put the conjunction selector and the raw-expression
//       input on one line, so the input was squeezed into whatever the selector
//       left over.
//
// The invariants below are the regression nails. They are structural (never a
// screenshot): the difference semantics are read off the panel DOM, and the two
// layout contracts are read off the stylesheet the surface really ships — the
// geometric truth (rects, scroll boxes, dark 1440x900) was measured against a
// real Chromium by this lane's own probe, which lives in the lane root and is
// deliberately not committed to the branch (see HANDOFF.md, §10).
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createBasePanels } from "../frontend/app/features/bases/panels.js";
import { BASE_SURFACE_CSS } from "../frontend/app/features/bases/styles.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;

// Five declared columns, one of them a formula column, of which three are shown.
const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
  { key: "created", label: "Created" },
  { key: "updated", label: "更新" },
  { key: "formula.link", label: "公式", formula: { expression: "file.asLink(file.name)" } },
];
const HIDDEN = ["created", "updated"];
const VISIBLE = COLUMNS.filter((column) => !HIDDEN.includes(column.key));

function build(panelId, { columns = COLUMNS, visibleColumns = VISIBLE, state = {} } = {}) {
  const api = createBasePanels({ doc: document, close() {}, onFilter() {}, onToggleColumn() {}, onHideAllColumns() {} });
  const panel = api.build(
    panelId,
    { sort: [], filter: [], q: "", columns, rows: [], path: "Lane.base", ...state },
    { doc: document, columns, visibleColumns, config: { hidden: HIDDEN, widths: {} } },
  );
  return panel;
}

const keys = (panel, group) => [...panel.querySelectorAll(`[data-prop-group="${group}"] [data-prop-row]`)]
  .map((row) => row.getAttribute("data-prop-row"));

// A rule of the shipped stylesheet, split into its declarations.
function rule(selector) {
  const match = BASE_SURFACE_CSS.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`));
  assert.notEqual(match, null, `the shipped stylesheet must still carry ${selector}`);
  return match[1];
}

// --- nail ①: 全部属性 is the difference ---------------------------------------

test("全部属性 lists the hidden columns only; every property is listed exactly once", () => {
  const panel = build("properties");
  const visible = keys(panel, "visible");
  const all = keys(panel, "all");
  assert.deepEqual(visible, ["name", "status", "formula.link"]);
  assert.deepEqual(all, ["created", "updated"]);
  // The invariant in one line: the two groups are disjoint and their union is the
  // declared column set (so a duplicate entry is a failure, not a cosmetic detail).
  const overlap = all.filter((key) => visible.includes(key));
  assert.deepEqual(overlap, [], "全部属性 must not repeat a 已显示 entry");
  assert.deepEqual([...visible, ...all].slice().sort(), COLUMNS.map((column) => column.key).sort());

  // A hidden column is still toggleable from below the fold: that is the undo path.
  const toggle = panel.querySelector('[data-prop-group="all"] [data-prop-toggle="created"]');
  assert.notEqual(toggle, null);
  assert.equal(toggle.checked, false);
});

test("an empty difference is not drawn at all", () => {
  const panel = build("properties", { visibleColumns: COLUMNS });
  assert.deepEqual(panel.querySelectorAll("[data-prop-section]").map((section) => section.getAttribute("data-prop-section")), ["visible"]);
  assert.equal(panel.querySelector('[data-prop-group="all"]'), null);
  assert.equal(panel.querySelector("[data-prop-section]").textContent, "已显示");
});

// --- nail ②: the advanced expression input owns a full-width row --------------

test("the panel is a column flex box and only its lists may shrink", () => {
  const panelRule = rule(".base-panel");
  assert.match(panelRule, /display:flex/);
  assert.match(panelRule, /flex-direction:column/);
  // Every other child keeps its own size, so the popover's `max-height` cannot push
  // the footer (or the tail of a list) out of the popover box.
  assert.match(rule(".base-panel-section-content > *"), /flex:0 0 auto/);
  assert.match(rule(".base-panel > *,.base-panel-scroll > *,.base-panel-container > *"), /flex:0 0 auto/);
  const listRule = rule(".base-panel-list");
  assert.match(listRule, /flex:1 1 auto/);
  assert.match(listRule, /min-height:0/);
  // The reset wins on source order (one class against one class), and the list has to
  // grow back after it: pin both ends so a future reorder cannot silently re-introduce
  // the clipped popover (the `.base-panel-input` row `flex` would become a height).
  const order = [
    BASE_SURFACE_CSS.indexOf(".base-panel-input{flex:1 1 90px;}"),
    BASE_SURFACE_CSS.indexOf(".base-panel > *,.base-panel-scroll > *,.base-panel-container > *"),
    BASE_SURFACE_CSS.indexOf(".base-panel-list{"),
  ];
  assert.ok(order.every((index) => index >= 0), "the three panel rules must all exist");
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), "input < reset < list is the required order");
});

test("the raw-expression filter input is a full-width row of its own", () => {
  const textareaRule = rule(".base-panel-textarea");
  assert.match(textareaRule, /min-height:56px/);
  assert.match(textareaRule, /height:auto/, "the row-height input rule must not flatten the textarea");
  // desktop-re/bases-panel-tokens: the raw filter input must NOT offer a resize grip.
  // The desktop has none, and a drag grip inside a popover whose own budget is a
  // `max-height` is a second, conflicting resize owner (measured before: `resize`
  // computed to `vertical` on the shipped surface, see that lane's evidence).
  assert.match(textareaRule, /resize:none/);
  // The input must not be a child of a condition row: a `<textarea>` is inline-level,
  // so sharing one line with the conjunction `<select>` is what squeezed it to 144px.
  const panel = build("filter", { state: { filter: { and: ['status == "active"'] } } });
  const area = panel.querySelector("[data-filter-advanced-mode]");
  assert.notEqual(area, null);
  assert.equal(area.className.includes("base-panel-textarea"), true);
  // G7 (lane desktop-re/bases-menu-content): the body is the desktop
  // `.bases-toolbar-section-content` now, so the expression input owns a full-width row inside
  // the `当前视图` section instead of being a direct child of the shell. The invariant the nail
  // is about — its own row, never a condition row — is unchanged.
  assert.equal(area.closest("[data-section-content]"), area.parentNode, "the expression input owns its row inside the section content");
  assert.equal(area.closest(".base-panel-row"), null, "the expression input must not share a condition row");
  const match = panel.querySelector("[data-filter-match]");
  assert.equal(match.closest(".base-panel-row"), null, "the conjunction selector must not share a row either");
});

// --- FIX-R1 nail: the flair is a real count, and count 0 does not paint one --

test("the section flair follows the desktop `toggle(t>0)`: 0 is hidden, a real count is shown", () => {
  const zero = build("filter", { state: { filter: [] } });
  const zeroFlair = zero.querySelector("[data-section-count]");
  assert.notEqual(zeroFlair, null, "the desktop builds the flair span unconditionally, then toggles it");
  assert.equal(zeroFlair.getAttribute("hidden"), "", "count 0 must not paint a `0` (desktop `e.toggle(t>0)`)");
  assert.equal(zeroFlair.className, "base-panel-count flair");
  const one = build("filter", { state: { filter: { and: ['status == "active"'] } } });
  const oneFlair = one.querySelector("[data-section-count]");
  assert.equal(oneFlair.getAttribute("hidden"), null, "a real count is painted");
  assert.equal(oneFlair.textContent, "1");
  const zeroSort = build("sort", { state: { sort: [] } });
  assert.equal(zeroSort.querySelector("[data-section-count]").getAttribute("hidden"), "");
});

// --- FIX-R1 nail: no class the desktop never builds is stuck on our nodes ---

test("the trailing action slot carries our class and the class the desktop really builds", () => {
  const panel = build("properties");
  const actions = panel.querySelectorAll(".base-panel-action-icon");
  assert.equal(actions.length, COLUMNS.length, "one trailing slot per property row");
  for (const action of actions) {
    assert.equal(action.className, "base-panel-action-icon bases-toolbar-menu-item-icon");
  }
  // `.bases-toolbar-menu-action-icon` has a desktop CSS rule (asar app.css@469509) and NO
  // desktop creator (latin1 count in app.js = 0), so it stays CSS-only: we do not build
  // structure the desktop never builds.
  assert.equal(panel.querySelectorAll(".bases-toolbar-menu-action-icon").length, 0);
});
