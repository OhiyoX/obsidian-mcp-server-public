// Lane desktop-re/panel-sort — the sort menu's declared-sort projection (D1) and the
// desktop row/section skin it renders into (D2/D3/D4/D6).
//
// Desktop authority, re-measured on the pinned 1.14.4 extract (the parity inventory's
// D-section offsets were partly taken from 1.13.7):
//   * `display()` merges the live rows with `loadSort(){ return
//     this.queryController.getViewConfig()?.getSort() ?? [] }` (app.js@2526324/@2527053),
//     i.e. the menu OPENS on the view's declared `sort:`;
//   * row = `.base-toolbar-sort-item` (app.js@2481117) with the grip as its first child
//     (`createDiv("grip-handle")` + `LM(r,"grip-vertical")`, app.js@2528519);
//   * actions = `.bases-toolbar-section.bases-toolbar-menu-actions` (app.js@2526713);
//   * `--input-height:28px` on the menu (app.css@455463).
//
// Nothing here asserts a panel width: the desktop's 248.5px is the content's own result,
// not a declaration (only `min-width:220px` is written, app.css@455463).
import assert from "node:assert/strict";
import test from "node:test";
import { createBaseSnapshotEvaluator, summarizeBaseSort } from "../src/app/base-snapshot-adapter.js";
import { BASE_PANEL_CSS } from "../frontend/app/features/bases/styles-panels.js";

const DECLARED_BASE = [
  "filters:",
  "  and:",
  '    - file.inFolder("Projects")',
  "views:",
  "  - type: table",
  "    name: Dev",
  "    order: [note.name, status, updated]",
  "    sort:",
  "      - property: updated",
  "        direction: DESC",
  "  - type: table",
  "    name: Tools",
  "    order: [note.name]",
  "",
].join("\n");

test("a declared sort is projected into the frozen override shape", () => {
  assert.deepEqual(summarizeBaseSort({ sort: [{ property: "updated", direction: "DESC" }] }), [
    { key: "updated", dir: "desc" },
  ]);
  // An absent direction is ASC — the same default the document pipeline reads
  // (`item.direction || "ASC"`, base-query.js@609).
  assert.deepEqual(summarizeBaseSort({ sort: [{ property: "status" }] }), [{ key: "status", dir: "asc" }]);
  // A property appears once (the desktop keeps one row per property), junk is dropped.
  assert.deepEqual(summarizeBaseSort({
    sort: [
      { property: "a", direction: "ASC" },
      { direction: "DESC" },
      { property: "", direction: "DESC" },
      { property: "a", direction: "DESC" },
      null,
    ],
  }), [{ key: "a", dir: "asc" }]);
  assert.deepEqual(summarizeBaseSort(null), []);
  assert.deepEqual(summarizeBaseSort({ sort: "nope" }), []);
});

test("the evaluator carries the SELECTED view's declared sort, and only that view's", () => {
  // The evaluator is the seam the Web route reads (`evaluateSnapshot`); the stub stands in
  // for the canonical A1 service so this asserts the projection, not the query.
  const evaluate = ({ viewName }) => ({
    view: viewName,
    views: [
      { name: "Dev", type: "table" },
      { name: "Tools", type: "table" },
    ],
    columns: [],
    rows: [],
    totalMatched: 0,
  });
  const snapshot = createBaseSnapshotEvaluator(evaluate);
  assert.deepEqual(snapshot({ raw: DECLARED_BASE, viewName: "Dev", records: [], limit: 10 }).viewSort, [
    { key: "updated", dir: "desc" },
  ]);
  // The other view declares none, so the menu opens empty there (no invention).
  assert.deepEqual(snapshot({ raw: DECLARED_BASE, viewName: "Tools", records: [], limit: 10 }).viewSort, []);
});

test("the sort menu's desktop skin is pinned in the panel stylesheet", () => {
  const css = BASE_PANEL_CSS.join("");
  // D4: the menu's local control height token (app.css@455463), scoped to the menu that was
  // measured; the shared 30px skin keeps its fallback.
  assert.match(css, /\.base-panel\[data-base-panel="sort"\]\{--input-height:28px;\}/);
  assert.match(css, /\.base-panel\[data-base-panel="sort"\] \.select-control\{height:var\(--input-height,30px\);\}/);
  // D3: one frame, two segments (app.css@461837 + @462364 + @458358).
  assert.match(css, /\.base-toolbar-sort-item\{display:flex;align-items:center;gap:var\(--size-4-1\);[^}]*border-radius:var\(--radius-s\);background-color:var\(--menu-background/);
  assert.match(css, /\.base-toolbar-sort-item>\.select-control:last-of-type\{[^}]*min-width:5\.25em[^}]*border-left:1px solid var\(--background-modifier-border\)/);
  // D2: the grip handle's hover face (app.css@453866 family).
  assert.match(css, /\.base-toolbar-sort-item \.grip-handle\{[^}]*cursor:grab/);
  assert.match(css, /\.base-toolbar-sort-item \.grip-handle:hover\{color:var\(--text-muted\);\}/);
  // D6: the actions section paints no border/top hairline of its own — the rows section's
  // `:not(:last-child)` hairline is the divider.
  assert.match(css, /\.base-panel\[data-base-panel="sort"\] \.base-panel-footer\{[^}]*border-top:0/);
  // D7: no fixed pixel width is written anywhere in the sort skin (the desktop's 248.5px is
  // content-driven; only the menu's `min-width:220px` exists, on the shell).
  const sortRules = css.split("}").filter((rule) => rule.includes("data-base-panel=\"sort\"") || rule.includes("base-toolbar-sort-item"));
  assert.equal(/width:\s*\d[\d.]*px/.test(sortRules.join("}")), false, "no hardcoded pixel width in the sort skin");
  assert.equal(sortRules.join("}").includes("248"), false);
});
