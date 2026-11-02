// B3/Wave C wiring seam between the canonical A1 Base domain service and the
// frozen A3 `evaluateSnapshot({ raw, viewName, records, limit })` route contract.
//
// Responsibilities:
//   1. A1 returns the selected view *name* (MCP parity); A3 expects `{ name, type }`.
//      Bridge the two through the declared `views` list without touching A1/A3.
//   2. Wave C bounded-prefix pagination. The Web transport `limit` is a page
//      window, not a semantic override: the fetch must be exactly
//      `min(viewLimit, prefixNeeded)` so pagination can never materialize the full
//      result set, while the Base view's own `limit` remains authoritative.
//   3. Formula DTO exposure (RECON §1.4 / §4 刀3). Every `formula.<name>` column
//      the domain already projects gets the *declaration* the desktop UI needs to
//      offer its `Edit formula...` affordance: `column.formula =
//      { name, expression, displayName }`. This is additive DTO metadata only:
//      the column set, the row values, the filter/sort semantics and the frozen
//      fail-closed direction are untouched (`compileBaseFormulas` still rejects
//      an unknown function / a type error before any row is read).
//   4. U12 filter projection. `filters: { base, view }` carries the condition
//      summary of the Base-file-level and selected-view-level `filters:` the
//      filter menu draws (`所有视图` / `当前视图`). Read-only metadata: the
//      evaluator still owns the semantics, and `capabilities` is unchanged.
//   5. Sort projection (lane desktop-re/panel-sort). `viewSort: [{ key, dir }]`
//      is the selected view's DECLARED `sort:`, in the frozen override shape, so
//      the sort menu can open with the document's own row instead of an empty
//      list. Additive metadata: the evaluator still owns the ordering.
//   6. Grouping projection (lane desktop-re/bases-grouping). `viewGroupBy:
//      { property, direction } | null` is the selected view's DECLARED `groupBy:`,
//      so the `分组依据` menu can open on the document's own rule while the Web
//      `?group=` override stays the only thing this surface writes. Additive
//      metadata: the partition itself is still built by the evaluator.
//
// `view.limit` is a semantic ceiling whose canonical legal domain is a positive
// safe integer; `validateBaseDocument` rejects any other value (0, negative,
// fractional, string, NaN, Infinity) with `invalid-schema` before this seam runs,
// so MCP and Web fail closed identically. `normalizeViewLimit` below is only
// defense-in-depth for an already-validated document.
//
// This seam does not change MCP: `query_base` keeps passing its own explicit
// limit straight through `queryBaseSnapshot`, where an explicit limit still wins.
import { isFormulaProperty, formulaPropertyName } from "../base-formulas.js";
import { compileBaseView, parseAndValidateBase, queryBaseSnapshot } from "../base-query.js";
import { summarizeBaseFilters } from "../base-filter-summary.js";
import { readGroupByDeclaration } from "../base-grouping.js";

// Redundant guard: a validated `view.limit` is already a positive safe integer.
// Any other value (or a non-number) means "no declared ceiling", which can only
// happen if a caller bypassed canonical validation.
export function normalizeViewLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function declaredFormulaSource(base, name) {
  const formulas = base?.formulas;
  if (!formulas || typeof formulas !== "object" || Array.isArray(formulas) || !Object.hasOwn(formulas, name)) return null;
  const source = formulas[name];
  return typeof source === "string" ? source : null;
}

function declaredDisplayName(base, key) {
  const properties = base?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !Object.hasOwn(properties, key)) return null;
  const declared = properties[key];
  const displayName = declared && typeof declared === "object" ? declared.displayName : undefined;
  return typeof displayName === "string" ? displayName : null;
}

// Enrich only the columns the domain already labelled `kind: "formula"`; a
// missing/undeclared source stays `null` (the domain rejects that case on its own
// with `missing_formula`, so this seam never has to invent an error).
export function exposeFormulaColumns(base, columns) {
  if (!Array.isArray(columns)) return [];
  return columns.map((column) => {
    if (column?.kind !== "formula" || !isFormulaProperty(column.key)) return column;
    const name = formulaPropertyName(column.key);
    return {
      ...column,
      formula: {
        name,
        expression: declaredFormulaSource(base, name),
        displayName: declaredDisplayName(base, column.key),
      },
    };
  });
}

// The selected view's DECLARED sort (`.base` `views[].sort`), projected into the same
// wire shape as the frozen Web override (`[{ key, dir }]`). Desktop authority: the sort
// menu seeds its rows from the view config (`display()` merges `currentSort` with
// `loadSort(){ return queryController.getViewConfig()?.getSort() ?? [] }`, asar
// app.js@2526324/@2527053), so a document-declared sort has to reach the client.
//
// `key` is the declared `property` verbatim: that is the vocabulary `order` (and hence
// every column key and the override assertion in `assertBaseColumnKeys`) already uses.
// `direction` maps onto the override's `asc`/`desc`; an absent direction is `ASC`, the
// same default the document pipeline applies (base-query.js `item.direction || "ASC"`).
// Items without a string property, and repeated properties, are dropped — the desktop
// keeps one row per property.
export function summarizeBaseSort(view) {
  const items = Array.isArray(view?.sort) ? view.sort : [];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const key = typeof item.property === "string" ? item.property : "";
    if (!key || out.some((entry) => entry.key === key)) continue;
    out.push({ key, dir: item.direction === "DESC" ? "desc" : "asc" });
  }
  return out;
}

export function createBaseSnapshotEvaluator(evaluate = queryBaseSnapshot) {
  return function evaluateBaseSnapshot(input) {
    const { base } = parseAndValidateBase(input.raw);
    const { view: resolvedView } = compileBaseView(base, input.viewName);
    const viewLimit = normalizeViewLimit(resolvedView?.limit);
    const effectiveFetchLimit = viewLimit ? Math.min(viewLimit, input.limit) : input.limit;
    const result = evaluate({ ...input, limit: effectiveFetchLimit });
    const selected = Array.isArray(result.views) ? result.views.find((view) => view.name === result.view) : null;
    return {
      ...result,
      viewLimit,
      columns: exposeFormulaColumns(base, result.columns),
      view: selected || { name: typeof result.view === "string" ? result.view : null, type: null },
      // U12: additive, read-only condition summary of the two declared filter
      // layers. Never throws for a document the domain accepted (`compileBaseView`
      // already ran the same tree assertion above).
      filters: summarizeBaseFilters({ base, view: resolvedView }),
      // ADDITIVE (lane desktop-re/panel-sort): the selected view's DECLARED sort, which
      // the sort menu shows until the user overrides it.
      viewSort: summarizeBaseSort(resolvedView),
      // The declared grouping rule (null when the view declares none). `compileBaseView`
      // above already ran the same declaration gate, so this never introduces a new
      // failure mode for a document the domain accepted.
      viewGroupBy: readGroupByDeclaration(resolvedView),
    };
  };
}

export const evaluateBaseSnapshot = createBaseSnapshotEvaluator();
