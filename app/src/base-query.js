// Protocol-neutral canonical Base domain service (Web Bases Wave A / A1).
//
// This module owns Base parse / validate / view selection / filter / sort / row
// projection. It is deliberately pure and portable:
//   - no fs / path / express / MCP imports;
//   - no global VAULT, no process state, no authorization;
//   - the candidate records are injected by the caller.
//
// Record contract (only these fields are read; a caller may pass a superset,
// e.g. a full MCP vault-index record):
//   {
//     path: string,        // vault-relative posix path, e.g. "Folder/Note.md"
//     basename: string,    // file stem without extension
//     frontmatter: object, // parsed YAML frontmatter
//     tags: string[],      // normalized (lower-cased) tags
//     links: [{ target: string }],
//     stat: { size: number, created: string, modified: string } // ISO strings
//   }
//
// All errors are reported as BaseQueryError with a stable `code`. The error
// `message` is always the existing MCP-facing text, so extracting this service
// does not change query_base behavior or messages.
//
// `view.limit` legal domain: a positive safe integer, or absent. Invalid values
// (0, negative, fractional, string, NaN, Infinity) fail closed in
// validateBaseDocument with the same message/code for MCP and Web; the evaluator
// never sees them, so `limit || view?.limit || sorted.length` only ever applies a
// declared positive integer (or falls through for an absent limit).

import yaml from "js-yaml";
import {
  assertFormulaPropertiesAvailable,
  assertNoFormulaReferencesInGroupBy,
  classifyFormulaFailure,
  compileBaseFormulas,
  evaluateFormulaFilterExpression,
  formulaDisplayName,
  formulaFilterHasFormula,
  formulaFilterProperty,
  formulaPropertyName,
  isFormulaProperty,
  resolveFormulaValue,
} from "./base-formulas.js";
import { builtinPropertyName } from "./base-builtin-names.js";
import { compareBaseValues, normalizeBaseValue } from "./base-values.js";
import {
  BaseGroupingError,
  assertSupportedGroupingKeys,
  buildBaseGroups,
  groupKeyDto,
  readGroupByDeclaration,
} from "./base-grouping.js";
import { computeBaseSummaries, readSummaryDeclarations } from "./base-summaries.js";
import { baseRow, evaluateBaseFilter, sortBaseRecords } from "./workflows.js";

export const BASE_QUERY_ERROR_CODES = Object.freeze([
  "invalid-yaml",
  "invalid-schema",
  "view-not-found",
  "unsupported",
]);

// Filter operators accepted by the frozen Web Base API (`filter` query param,
// D-PARITY-PLAN). The list is the canonical authority: the HTTP parameter layer
// rejects an unknown op with 422 `unsupported`, and evaluateBaseCondition fails
// closed with the same BaseQueryError code if it is reached directly.
export const BASE_FILTER_OPERATORS = Object.freeze([
  "is",
  "is-not",
  "contains",
  "starts-with",
  "ends-with",
  "lt",
  "lte",
  "gt",
  "gte",
  "is-empty",
  "is-not-empty",
  // G4: the desktop simple-builder function table (app.js@3238200
  // registerOperatorFuncConfigs("bases", [...])) reduced to this structured
  // vocabulary. `startsWith`/`endsWith`/`contains`/`isEmpty` already have the
  // comparison-shaped spellings above; the seven below are new here and each one
  // is reconciled line-by-line in docs/bases/BASES-COMPATIBILITY-MATRIX.md §2.3.
  "contains-any",
  "contains-all",
  "matches",
  "has-property",
  "has-link",
  "in-folder",
  "has-tag",
]);

// Operators that take no value operand (`is-empty` / `is-not-empty` predate this
// and `has-property` reads the property name from `key`, like the desktop
// `note.hasProperty("<name>")` whose operand is the note's props object).
// Operators whose operand is the RECORD rather than the cell are documented in
// the matrix (§2.3): `has-property`, `has-link`, `has-tag`, `in-folder`.
//
// Desktop filter-group contract (app.js@2361900): a filter object must have
// EXACTLY ONE of `and` / `or` / `not`, and its value must be an array.
// `not: [...]` is "none of" (`!arr.some(...)`, app.js@2351400).
export const BASE_FILTER_CONJUNCTIONS = Object.freeze(["and", "or", "not"]);

export class BaseQueryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BaseQueryError";
    this.code = code;
  }
}

function toBaseQueryError(error, code) {
  if (error instanceof BaseQueryError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const mapped = new BaseQueryError(message, code);
  // Additive Web diagnostic (never a relaxation): the verbatim message stays,
  // and a formula failure additionally carries its stable class + declared
  // formula name so the HTTP layer can expose it and the UI can show a message
  // aligned with the desktop `msgError*` keys. Non-formula errors are unchanged.
  const formulaFailure = classifyFormulaFailure(error);
  if (formulaFailure) mapped.formulaFailure = formulaFailure;
  return mapped;
}

// Mirrors the historical private validateBaseDocument (app/src/tools/workflows.js)
// exactly, including message text and evaluation order. The view loop only runs
// over an actual array, so a pathological non-array `views` value returns the
// declared schema error instead of leaking a runtime TypeError.
export function validateBaseDocument(base) {
  const errors = [];
  if (!base || typeof base !== "object" || Array.isArray(base)) errors.push("Base root must be a YAML object");
  if (base?.views !== undefined && !Array.isArray(base.views)) errors.push("views must be an array");
  const views = Array.isArray(base?.views) ? base.views : [];
  for (const [index, view] of views.entries()) {
    if (!view || typeof view !== "object") errors.push(`views[${index}] must be an object`);
    if (!view?.type) errors.push(`views[${index}].type is required`);
    if (!view?.name) errors.push(`views[${index}].name is required`);
    // `view.limit` is a semantic ceiling: only a positive safe integer is valid.
    // Anything else (0, negative, fractional, string, NaN, Infinity) fails closed
    // here so MCP and Web return the same error instead of coercing it.
    if (view && view.limit !== undefined && !(Number.isSafeInteger(view.limit) && view.limit > 0)) {
      errors.push(`views[${index}].limit must be a positive integer`);
    }
  }
  return errors;
}

// Parse YAML and validate the Base document shape. YAML syntax errors and shape
// errors are surfaced as BaseQueryError with distinct codes.
export function parseAndValidateBase(raw) {
  let base;
  try {
    base = yaml.load(raw);
  } catch (error) {
    throw toBaseQueryError(error, "invalid-yaml");
  }
  const errors = validateBaseDocument(base);
  if (errors.length) throw new BaseQueryError(`Invalid Base: ${errors.join("; ")}`, "invalid-schema");
  return { base };
}

// INT-C / 刀4: the `formula.<name>` properties the Base's own filters, sort and
// summaries refer to. They are validated for declaration at compile time
// (below), exactly like an `order` reference, so an undeclared formula fails
// closed even when the record set is empty instead of silently producing
// `supportedSubset: true` + 0 rows.
function collectFormulaFilterSortProperties(base, view) {
  const properties = [];
  const fromFilter = (filter) => {
    if (!filter) return;
    if (typeof filter === "string") {
      const property = formulaFilterProperty(filter);
      if (property) properties.push(property);
    } else if (Array.isArray(filter)) {
      filter.forEach(fromFilter);
    } else {
      fromFilter(filter.and);
      fromFilter(filter.or);
      fromFilter(filter.not);
    }
  };
  fromFilter(base?.filters);
  fromFilter(view?.filters);
  for (const sort of [base?.sort, view?.sort]) {
    for (const item of Array.isArray(sort) ? sort : []) {
      if (isFormulaProperty(item?.property)) properties.push(item.property);
    }
  }
  // 刀4: a summary column is a projected property like any other, so a
  // `formula.<name>` summary key must name a DECLARED formula (fail closed).
  for (const key of Object.keys(view?.summaries && typeof view.summaries === "object" && !Array.isArray(view.summaries) ? view.summaries : {})) {
    if (isFormulaProperty(key)) properties.push(key);
  }
  return properties;
}

// Compile the whole formula AST first (before view selection, limit or an empty
// result), select the requested view, then enforce the out-of-scope guards. The
// order matches the historical query_base handler exactly.
// Returns { view, viewName, order, formulas }; `view` is the selected view
// object (or undefined) and `viewName` is its declared name (or undefined).
export function compileBaseView(base, viewName) {
  let formulas;
  try {
    formulas = compileBaseFormulas(base?.formulas);
  } catch (error) {
    throw toBaseQueryError(error, "unsupported");
  }
  const view = viewName ? base?.views?.find((item) => item.name === viewName) : base?.views?.[0];
  if (viewName && !view) throw new BaseQueryError(`Base view not found: ${viewName}`, "view-not-found");
  // 刀4 supersedes main's `assertNoUnimplementedSemanticKeys` here: that gate
  // rejected `groupBy` / `summaries` as unimplemented, and this branch implements
  // them, so the same document-scoped check is now `assertSupportedGroupingKeys`
  // (it validates the declarations and fails closed on any key this subset still
  // cannot execute). origin/main never touched the old gate, so its call site is
  // the pre-刀4 spelling of the same position; keeping both would call a function
  // this branch deleted.
  //
  // The gate lives in `base-grouping.js` (line budget); it throws
  // BaseGroupingError carrying the final wire message, which is mapped back onto
  // BaseQueryError here so the observable `{code, message}` pair is unchanged.
  // Any other error keeps propagating verbatim, exactly as before.
  try {
    assertSupportedGroupingKeys(base);
  } catch (error) {
    if (error instanceof BaseGroupingError) throw toBaseQueryError(error, "unsupported");
    throw error;
  }
  // G3: the desktop filter-group contract is enforced before evaluation, so a
  // document with two conjunctions on one level (or a non-array `and`) fails
  // closed even when the record set is empty, instead of picking the first key.
  assertBaseFilterTree(base?.filters, { path: "filters" });
  assertBaseFilterTree(view?.filters, { path: `views[${view?.name ?? ""}].filters` });
  const order = view?.order || ["file.path"];
  try {
    assertNoFormulaReferencesInGroupBy(view);
    assertFormulaPropertiesAvailable([...order, ...collectFormulaFilterSortProperties(base, view)], formulas);
  } catch (error) {
    throw toBaseQueryError(error, "unsupported");
  }
  return { view, viewName: view?.name, order, formulas };
}

function columnLabel(base, key) {
  // The desktop's own three-step priority (`getDisplayName()`, asar app.js@2352471),
  // with no branch on the property kind:
  //   1. `properties.<key>.displayName` — the AUTHOR'S decision. A `.base` that
  //      declares `file.mtime: {displayName: 编辑时间}` asked for that name, so the
  //      surface must not print the key tail (`mtime`) at it.
  //   2. the desktop built-in name table — 14 `file.*` names, in
  //      `src/base-builtin-names.js` (U5 closure). Declaring the name in a `.base`
  //      is optional; when it is silent the reader must still see 修改时间, not `mtime`.
  //   3. the formula fallback / the key tail. A custom property stays untouched:
  //      `status` is `status`, never a translated name.
  const declared = base?.properties?.[key];
  const displayName = declared && typeof declared === "object" ? declared.displayName : undefined;
  if (isFormulaProperty(key)) return formulaDisplayName(displayName, key);
  return formulaDisplayName(displayName, null) ?? builtinPropertyName(key) ?? tailKey(key);
}

function tailKey(key) {
  const separator = key.lastIndexOf(".");
  return separator === -1 ? key : key.slice(separator + 1);
}

function buildColumns(base, order) {
  return (Array.isArray(order) ? order : []).map((key) => ({
    key,
    label: columnLabel(base, key),
    kind: isFormulaProperty(key) ? "formula" : "property",
  }));
}

// ── Frozen Web overrides (sort / filter / q) ────────────────────────────────
//
// These three optional inputs implement the Web Base API query contract
// (D-PARITY-PLAN). They are additive: the MCP `query_base` path never passes
// them, so its filtering, sorting and DTO stay byte-for-byte unchanged.
//
// Value projection used by `contains` / `starts-with` / `ends-with` and by the
// case-insensitive text query. Structured `file.asLink` cells expose both the
// display name and the target path, arrays are flattened, and a plain object is
// reduced to a bounded `key: value` summary instead of a raw JSON dump.
const MAX_SUMMARY_DEPTH = 3;

export function baseSearchableText(value, depth = 0) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => baseSearchableText(item, depth));
  if (typeof value !== "object") return [String(value)];
  // Structured link cell: { path, displayName, kind: "asLink" }.
  if (typeof value.displayName === "string" || typeof value.path === "string") {
    return [value.displayName, value.path].filter((item) => typeof item === "string");
  }
  if (depth >= MAX_SUMMARY_DEPTH) return [];
  const parts = [];
  for (const [key, item] of Object.entries(value)) {
    for (const text of baseSearchableText(item, depth + 1)) parts.push(`${key}: ${text}`);
  }
  return parts;
}

function isEmptyBaseValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

// Mirrors the canonical `compare(...)` equality used by Base filter expressions
// (`left === right || String(left) === String(right)`).
function looseBaseEqual(left, right) {
  return left === right || String(left) === String(right);
}

// ── Filter tree validation (G3) ─────────────────────────────────────────────
//
// One validator covers both dialects:
//   - the `.base` document dialect (`filters:` in the file / in a view), where a
//     leaf is a string expression and an object is always a group;
//   - the frozen Web override dialect (`?filter=`), where a leaf is the
//     structured `{ key, op, value }` condition.
// `allowConditions` selects the second. Everything else is identical, and the
// group rules are the desktop parser's (app.js@2361900): exactly one key, array
// value, anything else fails closed instead of silently picking the first key.
export function assertBaseFilterTree(node, { allowConditions = false, path = "filters" } = {}) {
  if (node === undefined || node === null) return;
  if (typeof node === "string") {
    // An expression leaf (desktop's `</>` advanced filter mode) is only legal in
    // the Web override dialect; the `.base` dialect has had it all along.
    if (allowConditions && node.trim() === "") {
      throw new BaseQueryError(`filter expression must not be empty: ${path}`, "invalid-schema");
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertBaseFilterTree(item, { allowConditions, path: `${path}[${index}]` }));
    return;
  }
  if (typeof node !== "object") {
    throw new BaseQueryError(`filter must be an object, an array or an expression string: ${path}`, "invalid-schema");
  }
  const keys = Object.keys(node);
  const conjunction = keys.find((key) => BASE_FILTER_CONJUNCTIONS.includes(key));
  if (conjunction) {
    if (keys.length !== 1) {
      throw new BaseQueryError(`"filters" may only have one of an "and", "or", or "not" keys: ${path}`, "invalid-schema");
    }
    const items = node[conjunction];
    if (!Array.isArray(items)) {
      throw new BaseQueryError(`${conjunction} must be an array: ${path}`, "invalid-schema");
    }
    items.forEach((item, index) => assertBaseFilterTree(item, { allowConditions, path: `${path}.${conjunction}[${index}]` }));
    return;
  }
  if (!allowConditions) {
    throw new BaseQueryError(`Unsupported Base filter object: ${path}`, "unsupported");
  }
  if (typeof node.key !== "string" || node.key === "") {
    throw new BaseQueryError(`filter item needs a string key: ${path}`, "invalid-schema");
  }
  if (!BASE_FILTER_OPERATORS.includes(node.op)) {
    throw new BaseQueryError(`Unsupported Base filter operator: ${node.op}`, "unsupported");
  }
  for (const key of keys) {
    if (!["key", "op", "value"].includes(key)) {
      throw new BaseQueryError(`filter item has an unknown key "${key}": ${path}`, "invalid-schema");
    }
  }
}

// Operators whose operand is the RECORD, not the projected cell: the condition's
// `key` is not read as a cell, so it must not pass through the view-column gate
// (a view that does not display `file.path` can still filter `in-folder`).
// `has-property` reads the property name FROM `key`, which is likewise a
// frontmatter key, not a column. Documented in matrix §2.3.
export const BASE_FILTER_RECORD_OPERATORS = Object.freeze(["has-property", "has-link", "in-folder", "has-tag"]);

// Every structured condition leaf inside a filter tree (used for the view-column
// gate; a group adds no keys of its own and an expression leaf none at all).
function collectFilterConditionKeys(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((item) => collectFilterConditionKeys(item, out));
    return out;
  }
  const conjunction = BASE_FILTER_CONJUNCTIONS.find((key) => Array.isArray(node[key]));
  if (conjunction) {
    collectFilterConditionKeys(node[conjunction], out);
    return out;
  }
  if (typeof node.key === "string" && !BASE_FILTER_RECORD_OPERATORS.includes(node.op)) out.push(node.key);
  return out;
}

const REGEX_CACHE = new Map();

function filterRegExp(pattern) {
  const source = String(pattern);
  let regex = REGEX_CACHE.get(source);
  if (regex) return regex;
  try {
    regex = new RegExp(source);
  } catch {
    throw new BaseQueryError(`Base filter value is not a valid regular expression: ${source}`, "invalid-schema");
  }
  if (REGEX_CACHE.size >= 64) REGEX_CACHE.clear();
  REGEX_CACHE.set(source, regex);
  return regex;
}

// `containsAny` / `containsAll` take a list of needles; the desktop function
// signature is varargs (`containsAny(list, ...needles)`, app.js@3238200 table).
function filterNeedles(target) {
  if (Array.isArray(target)) return target.map(String);
  return [String(target ?? "")];
}

function containsBaseNeedle(value, needle) {
  if (Array.isArray(value)) {
    // Desktop's LIST variant (`fK.containsAny` @2226133) is `list.includes(value)`:
    // exact, case-sensitive element equality. Keep it.
    return value.some((item) => String(item) === needle);
  }
  // Desktop's STRING variants lowercase BOTH sides (app.js@2225713):
  //   contains    : ""!==t.data && e.data.toLowerCase().includes(t.data.toLowerCase())
  //   containsAny : var i=e.data.toLowerCase(); ... i.includes(e.data.toLowerCase())
  //   containsAll : same every(...)
  // Review F2: the G4 `contains-any` / `contains-all` must inherit that case
  // insensitivity instead of Web's case-sensitive `String.includes`.
  const haystack = String(needle).toLowerCase();
  return baseSearchableText(value).some((text) => text.toLowerCase().includes(haystack));
}

// Evaluate one frozen-API filter condition against a record. `key` is resolved
// through baseRow so formula columns (`formula.*`) are supported exactly like a
// projected cell. Unknown operators fail closed as BaseQueryError("unsupported").
export function evaluateBaseCondition(condition, record, formulas) {
  const value = baseRow(record, [condition.key], { formulas })[condition.key];
  const target = condition.value;
  switch (condition.op) {
    case "is":
      return looseBaseEqual(value, target);
    case "is-not":
      return !looseBaseEqual(value, target);
    case "contains":
      return baseSearchableText(value).some((text) => text.includes(String(target)));
    case "starts-with":
      return baseSearchableText(value).some((text) => text.startsWith(String(target)));
    case "ends-with":
      return baseSearchableText(value).some((text) => text.endsWith(String(target)));
    case "lt":
      return value < target;
    case "lte":
      return value <= target;
    case "gt":
      return value > target;
    case "gte":
      return value >= target;
    case "is-empty":
      return isEmptyBaseValue(value);
    case "is-not-empty":
      return !isEmptyBaseValue(value);
    // ── G4 desktop function-table operators (matrix §2.3) ──
    // Cell-operand operators, mirroring the expression layer's own rules so the
    // two dialects cannot drift: `contains` (string substring / list element),
    // `matches` (RegExp.test), `containsAny` / `containsAll` (varargs needles).
    case "contains-any":
      return filterNeedles(target).some((needle) => containsBaseNeedle(value, needle));
    case "contains-all":
      return filterNeedles(target).every((needle) => containsBaseNeedle(value, needle));
    case "matches":
      return baseSearchableText(value).some((text) => filterRegExp(target).test(text));
    // Record-operand operators: identical to `evaluateBaseExpression`'s
    // `file.hasTag` / `file.hasLink` / `file.inFolder` rules (workflows.js) and to
    // desktop's (app.js@2351400 neighbourhood), so the advanced and simple
    // dialects agree; `key` is only the view-column scope, never the operand.
    case "has-tag":
      return recordHasTag(record, String(target ?? "").replace(/^#/, "").toLowerCase());
    case "has-link":
      return recordHasLink(record, target);
    case "in-folder":
      return record.path.startsWith(`${String(target ?? "").replace(/\/$/, "")}/`);
    // `note.hasProperty("<name>")`: the property name is the condition's `key`.
    case "has-property":
      return hasRecordProperty(record, condition.key);
    default:
      throw new BaseQueryError(`Unsupported Base filter operator: ${condition.op}`, "unsupported");
  }
}

function recordHasTag(record, tag) {
  const tags = Array.isArray(record?.tags) ? record.tags : [];
  return tags.map((item) => String(item).replace(/^#/, "").toLowerCase()).includes(tag);
}

function recordHasLink(record, target) {
  const wanted = String(target ?? "");
  const links = Array.isArray(record?.links) ? record.links : [];
  return links.some((link) => link?.target === wanted
    || String(link?.target ?? "").replace(/\.md$/i, "") === wanted.replace(/\.md$/i, ""));
}

// A property counts as present when it is declared in the frontmatter, or when a
// `file.*` builtin resolves to a non-undefined value. Deliberately not
// `propertyValue() != null`: the desktop test is `getProps().keys().contains()`.
function hasRecordProperty(record, key) {
  const property = String(key ?? "");
  if (property.startsWith("file.")) return baseRow(record, [property])[property] !== undefined;
  const frontmatter = record?.frontmatter;
  const bare = property.startsWith("note.") ? property.slice("note.".length) : property;
  return Boolean(frontmatter && typeof frontmatter === "object" && Object.hasOwn(frontmatter, bare));
}

// Every override key must belong to the selected view's column set (`order`).
function assertBaseColumnKeys(order, keys) {
  const known = new Set(Array.isArray(order) ? order : []);
  for (const key of keys) {
    if (!known.has(key)) {
      throw new BaseQueryError(`Base query references a column outside the view: ${key}`, "unsupported");
    }
  }
}

// A filter condition whose leading property token is a `formula.<name>` is
// evaluated with the typed comparator; every other condition delegates to the
// frozen P0 `evaluateBaseFilter`. The tree walk implements the desktop group
// contract (`and` = all, `or` = any, `not` = none of) for BOTH dialects: an array
// is an AND list (the frozen legacy `?filter=[{key,op,value}]` shape), a group
// object carries exactly one conjunction (validated by assertBaseFilterTree), a
// string is an expression leaf and `{key,op,value}` a structured condition.
export function evaluateBaseFilterTree(filter, record, formulas) {
  if (!filter) return true;
  if (typeof filter === "string") {
    return formulaFilterHasFormula(filter)
      ? evaluateFormulaFilterExpression(filter, record, formulas)
      : evaluateBaseFilter(filter, record);
  }
  if (Array.isArray(filter)) return filter.every((item) => evaluateBaseFilterTree(item, record, formulas));
  if (filter.and) return filter.and.every((item) => evaluateBaseFilterTree(item, record, formulas));
  if (filter.or) return filter.or.some((item) => evaluateBaseFilterTree(item, record, formulas));
  if (filter.not) return !filter.not.some((item) => evaluateBaseFilterTree(item, record, formulas));
  if (typeof filter.key === "string") return evaluateBaseCondition(filter, record, formulas);
  throw new BaseQueryError("Unsupported Base filter object", "unsupported");
}

// One P0 sort key, compatible with `workflows.js sortBaseRecords` (empty values
// last in BOTH directions; date, then number, then numeric localeCompare) minus
// its trailing `file.path` tie-break, which the caller applies as the last key.
// Values come from `baseRow`, i.e. the same `propertyValue` seam.
const DATE_LIKE_STRING = /^\d{4}-\d{2}-\d{2}(?:T|$)/;

function compareP0SortKey(left, right, direction) {
  if (left == null || right == null) return left == null && right == null ? 0 : left == null ? 1 : -1;
  const dateValue = (value) => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string" && DATE_LIKE_STRING.test(value)) return Date.parse(value);
    return NaN;
  };
  const leftDate = dateValue(left);
  const rightDate = dateValue(right);
  const result = Number.isFinite(leftDate) && Number.isFinite(rightDate)
    ? leftDate - rightDate
    : typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), undefined, { numeric: true });
  if (result === 0) return 0;
  const sign = result < 0 ? -1 : 1;
  return direction === "DESC" ? -sign : sign;
}

// Sort with formula keys: formula keys use the P1-A typed total order
// (`compareBaseValues`), non-formula keys the frozen P0 comparator, and
// `file.path` is the final tie-break; `list` / `object` values fail closed
// (verdict §4 option A). Without a formula key this delegates to
// `sortBaseRecords` byte-for-byte, so P0 sort behavior cannot move.
function sortBaseRecordsWithFormulas(records, sort, formulas) {
  const items = Array.isArray(sort) ? sort : [];
  if (!items.some((item) => isFormulaProperty(item?.property))) return sortBaseRecords(records, sort);
  for (const item of items) {
    if (!item || typeof item.property !== "string" || !["ASC", "DESC"].includes(item.direction || "ASC")) {
      throw new BaseQueryError("Unsupported Base sort configuration", "unsupported");
    }
  }
  const formulaValues = new WeakMap();
  const p0Cache = new WeakMap();
  for (const record of records) {
    const resolved = Object.create(null);
    for (const item of items) {
      if (!isFormulaProperty(item.property)) continue;
      const name = formulaPropertyName(item.property);
      const value = resolveFormulaValue(record, name, formulas);
      const type = normalizeBaseValue(value).type;
      if (type === "list" || type === "object") throw new BaseQueryError(`Base formulas are not supported in view sort for ${type} values (out of scope)`, "unsupported");
      resolved[name] = value;
    }
    formulaValues.set(record, resolved);
  }
  const p0Value = (record, property) => {
    const cached = p0Cache.get(record) ?? new Map();
    p0Cache.set(record, cached);
    if (!cached.has(property)) cached.set(property, baseRow(record, [property])[property]);
    return cached.get(property);
  };
  return [...records].sort((left, right) => {
    for (const item of items) {
      const direction = item.direction || "ASC";
      const formula = isFormulaProperty(item.property);
      const result = formula
        ? compareBaseValues(formulaValues.get(left)[formulaPropertyName(item.property)], formulaValues.get(right)[formulaPropertyName(item.property)])
        : compareP0SortKey(p0Value(left, item.property), p0Value(right, item.property), direction);
      if (result !== 0) return formula && direction === "DESC" ? -result : result;
    }
    return left.path.localeCompare(right.path);
  });
}

// 刀4 frozen pipeline (SEMANTICS-FROZEN §1):
//   filters -> sort -> limit(global, flat rows) -> groupBy(partition) -> summaries(per group)
// `limit` is a ROW ceiling applied to the globally sorted flat rows BEFORE any
// grouping, so a group only ever sees the rows that survived the ceiling
// (P6/P7/P16, C2/C9) and the rows inside a group keep the `sort` order —
// `groupBy.direction` moves GROUPS, never rows (P9/P12, C4/C5).
const SUMMARY_SCOPE_VISIBLE_ROWS = "visible-rows";

// ADD-only grouping DTO. `groups` / `summaries` appear ONLY when the selected
// view declares `groupBy` / `summaries`, so an undeclared document keeps a
// byte-identical DTO (MCP `query_base`, the Web page and their locks are
// untouched).
//
// `groups[i]` = one group in group order: its JSON-safe key, its member count,
// the member paths (in the frozen sort order) and — when summaries are declared
// — the per-group summary values (P15). The top-level `summaries` object is the
// SAME computation over every retained row, i.e. the single ungrouped group
// (P8); `scope: "visible-rows"` records that the domain is post-limit (E14/B5).
function buildGroupingDto({ view, order, formulas, retained, rows }) {
  const groupBy = readGroupByDeclaration(view);
  const declarations = readSummaryDeclarations(view?.summaries, "views[].summaries");
  if (!groupBy && !declarations) return {};

  const summariesOf = (records) => (declarations
    ? {
      scope: SUMMARY_SCOPE_VISIBLE_ROWS,
      values: computeBaseSummaries({
        declarations,
        rows: records,
        resolveValue: (record, property) => baseRow(record, [property], { formulas })[property],
        columnKeys: order,
      }),
    }
    : null);

  // Group keys are evaluated once per retained row through the same property
  // seam as the projected cells, then injected as the model's `keyOf` seam so
  // `base-grouping.js` never re-derives them.
  const keyValues = groupBy
    ? retained.map((record) => baseRow(record, [groupBy.property], { formulas })[groupBy.property])
    : [];
  const model = groupBy
    ? buildBaseGroups(retained, { property: groupBy.property, direction: groupBy.direction }, { keyOf: (_row, index) => keyValues[index] })
    : null;
  const entries = model
    ? model.boundaries.map((boundary) => ({ indexes: boundary.rowIndexes, groupValue: boundary.groupValue }))
    : [{ indexes: retained.map((_record, index) => index), groupValue: null }];

  const groups = entries.map(({ indexes, groupValue }) => {
    const summaries = summariesOf(indexes.map((index) => retained[index]));
    return {
      ...groupKeyDto(groupValue),
      count: indexes.length,
      rowPaths: indexes.map((index) => rows[index].path),
      ...(summaries ? { summaries } : {}),
    };
  });
  return {
    groups,
    ...(declarations ? { summaries: summariesOf(retained) } : {}),
  };
}

// Apply filters and sort, then project rows. `effectiveLimit` keeps the
// historical falsy fall-through semantics (0 / undefined fall through to the
// view limit and finally to the full result length). `view.limit`, when present,
// is guaranteed to be a positive safe integer by validateBaseDocument.
//
// `viewLimit` is the view's declared semantic ceiling (null when the view
// declares none). It is only exposed for callers that paginate a bounded
// prefix; the historical `limit || view?.limit` precedence is unchanged, so MCP
// explicit-limit behavior does not move.
//
// Optional frozen Web overrides:
//   - `filterExtra`: [{ key, op, value }], appended as AND after base/view filters;
//   - `textQuery`:   case-insensitive substring match over every view column;
//   - `sortOverride`: [{ key, dir: "asc" | "desc" }], replaces `view.sort`.
// An absent or empty override is a no-op, so the MCP call sites are unaffected.
export function evaluateBaseView({ base, view, order, formulas, records = [], limit, sortOverride, filterExtra, textQuery }) {
  try {
    const filters = [base?.filters, view?.filters].filter(Boolean);
    // Detected once per filter (not per record): a pure-P0 tree keeps the frozen
    // `evaluateBaseFilter` call and pays no per-row formula bookkeeping.
    const formulaFilter = filters.map((filter) => (formulaFilterHasFormula(filter) ? filter : null));
    let matched = records.filter((record) => filters.every((filter, index) => (
      formulaFilter[index] ? evaluateBaseFilterTree(filter, record, formulas) : evaluateBaseFilter(filter, record)
    )));

    if (filterExtra !== undefined && filterExtra !== null) {
      assertBaseFilterTree(filterExtra, { allowConditions: true, path: "filter" });
    }
    if (Array.isArray(filterExtra) ? filterExtra.length : filterExtra) {
      // Legacy `?filter=[{key,op,value}]` is an AND list and keeps its exact
      // behavior; a group object is the new shape. Both go through the same
      // evaluator, and the view-column gate now walks the whole tree.
      assertBaseColumnKeys(order, collectFilterConditionKeys(filterExtra));
      matched = matched.filter((record) => evaluateBaseFilterTree(filterExtra, record, formulas));
    }

    if (typeof textQuery === "string" && textQuery.length) {
      const needle = textQuery.toLowerCase();
      const searchKeys = Array.isArray(order) && order.length ? order : ["file.path"];
      matched = matched.filter((record) => {
        const values = baseRow(record, searchKeys, { formulas });
        return searchKeys.some((key) =>
          baseSearchableText(values[key]).some((text) => text.toLowerCase().includes(needle)),
        );
      });
    }

    let sort = view?.sort;
    if (Array.isArray(sortOverride) && sortOverride.length) {
      assertBaseColumnKeys(order, sortOverride.map((item) => item.key));
      sort = sortOverride.map((item) => ({ property: item.key, direction: item.dir === "desc" ? "DESC" : "ASC" }));
    }

    const sorted = sortBaseRecordsWithFormulas(matched, sort, formulas);
    const effectiveLimit = limit || view?.limit || sorted.length;
    const retained = sorted.slice(0, effectiveLimit);
    const rows = retained.map((record) => ({ path: record.path, values: baseRow(record, order, { formulas }) }));
    return {
      columns: buildColumns(base, order),
      rows,
      totalMatched: matched.length,
      truncated: matched.length > effectiveLimit,
      supportedSubset: true,
      // Declared ceiling of the selected view; null means "no semantic limit".
      viewLimit: view?.limit ?? null,
      ...buildGroupingDto({ view, order, formulas, retained, rows }),
    };
  } catch (error) {
    throw toBaseQueryError(error, "unsupported");
  }
}

// Declared views in Base order, reduced to the selector DTO shape. A missing or
// non-array `views` value yields []; name/type are normalized to string|null so
// callers never receive a non-string. This does not validate the document: use
// parseAndValidateBase when schema rejection is required.
export function listBaseViews(base) {
  const views = Array.isArray(base?.views) ? base.views : [];
  return views.map((view) => ({
    name: typeof view?.name === "string" ? view.name : null,
    type: typeof view?.type === "string" ? view.type : null,
  }));
}

// ── 刀4: grouping / summaries are EXECUTED (accept), not rejected ───────────
//
// `views[].groupBy`, `views[].summaries` and the top-level `summaries` registry
// used to be rejected outright (Wave 0-D). They are accepted now that the
// pipeline below executes them, per docs/bases/SEMANTICS-FROZEN.md (frozen
// pipeline + D1–D5). What still fails closed is everything this subset cannot
// execute — a shape, a name or a key path — so a document is never served as
// `supportedSubset: true` with a half-applied semantic key (contract §2.2/§17).
//
// The declaration gate (`readGroupByDeclaration` / `assertSupportedGroupingKeys`)
// and the JSON-safe `groupKeyDto` projection were MOVED to `base-grouping.js`
// (pure move: same messages, same codes, same order) so this file stays inside
// the 800-line architecture budget. The declaration freeze rule is unchanged: a
// key counts as declared only when it is non-empty — `null`, `undefined`, `{}`
// and `[]` are absent.

// Full canonical pipeline used by protocol adapters: parse -> compile -> evaluate.
// `view` is the resolved view name (MCP parity) and `views` lists every declared
// view for the UI selector in declaration order. The optional `sortOverride` /
// `filterExtra` / `textQuery` inputs are the frozen Web Base API overrides; they
// default to undefined so the MCP call site is unchanged.
export function queryBaseSnapshot({ raw, viewName, records, limit, sortOverride, filterExtra, textQuery }) {
  const { base } = parseAndValidateBase(raw);
  const { view, viewName: selectedViewName, order, formulas } = compileBaseView(base, viewName);
  const result = evaluateBaseView({ base, view, order, formulas, records, limit, sortOverride, filterExtra, textQuery });
  return { view: selectedViewName, views: listBaseViews(base), ...result };
}
