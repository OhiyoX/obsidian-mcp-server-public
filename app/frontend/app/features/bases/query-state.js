// Pure codec for the Base view override state that travels in the document URL
// (`?view=&sort=&filter=&q=&group=`) and in the `/api/web/v1/base` request.
//
// No DOM, no network, no imports: safe to unit test in Node (surface contract).
// The frozen API contract (D-PARITY-PLAN) is:
//   sort   = [{"key":"<column key>","dir":"asc|desc"}]
//   filter = [{"key":"<column key>","op":"<op>","value":<any>}], AND combined
//   q      = text, <= 256 chars, case-insensitive contains over every column
//   group  = {"property":"<column key>","direction":"ASC|DESC"} (one rule, `.base` spelling)
// Anything structurally invalid is dropped here; the server stays the authority
// for "unknown column key -> 422" semantics.

export const BASE_SORT_MAX = 4;
export const BASE_FILTER_MAX = 8;
export const BASE_QUERY_MAX = 256;

// `group` is ONE rule, in the `.base` spelling (`views[].groupBy` is exactly
// `{property, direction?: "ASC"|"DESC"}`; matrix §6 / N8). The Web override
// carries the same shape so the panel, the URL and the document cannot disagree.
export const BASE_GROUP_DIRECTIONS = ["ASC", "DESC"];
export const DEFAULT_GROUP_DIRECTION = "ASC";

export const BASE_SORT_DIRECTIONS = ["asc", "desc"];

// Canonical operator vocabulary (frozen by the API contract).
// The seven G4 operators below the pre-G3 eleven are the desktop simple-builder
// function table (`app.js@3238200`) reduced to this vocabulary; each one is
// reconciled in docs/bases/BASES-COMPATIBILITY-MATRIX.md §2.3.
export const BASE_FILTER_OPS = [
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
  "contains-any",
  "contains-all",
  "matches",
  "has-property",
  "has-link",
  "in-folder",
  "has-tag",
];

// Operators that take no value.
export const BASE_FILTER_OPS_NOVALUE = ["is-empty", "is-not-empty", "has-property"];

// Filter groups (desktop `and` / `or` / `not`, app.js@2361900): a group object
// carries exactly ONE of these keys and an array value. `not` means "none of".
export const BASE_FILTER_CONJUNCTIONS = ["and", "or", "not"];

// Advanced (raw expression) leaves: desktop's `</>` filter mode. The expression
// grammar is the portable closed subset of `base-expression`/`workflows`, which
// fails closed on anything else, so an expression leaf is safe to carry here.
export const BASE_FILTER_EXPRESSION_MODE = "advanced";

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeKey(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function normalizeSort(raw) {
  const out = [];
  for (const entry of asArray(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const key = normalizeKey(entry.key);
    if (!key) continue;
    const dir = BASE_SORT_DIRECTIONS.includes(entry.dir) ? entry.dir : "asc";
    if (out.some((item) => item.key === key)) continue;
    out.push({ key, dir });
    if (out.length >= BASE_SORT_MAX) break;
  }
  return out;
}

export function sortParam(list) {
  const normalized = normalizeSort(list);
  return normalized.length ? JSON.stringify(normalized) : null;
}

export function parseSortParam(value) {
  return normalizeSort(value);
}

function normalizeCondition(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const key = normalizeKey(entry.key);
  if (!key) return null;
  const op = BASE_FILTER_OPS.includes(entry.op) ? entry.op : null;
  if (!op) return null;
  const item = { key, op };
  if (!BASE_FILTER_OPS_NOVALUE.includes(op) && entry.value !== undefined) item.value = entry.value;
  return item;
}

function countLeaves(node) {
  if (Array.isArray(node)) return node.reduce((total, item) => total + countLeaves(item), 0);
  if (typeof node === "string") return node.trim() ? 1 : 0;
  if (!node || typeof node !== "object") return 0;
  const conjunction = BASE_FILTER_CONJUNCTIONS.find((key) => Array.isArray(node[key]));
  return conjunction ? countLeaves(node[conjunction]) : 1;
}

// A filter is either the legacy AND list `[{key,op,value}]` or a desktop group
// `{and|or|not: [...]}` nested to any depth, whose leaves are conditions or (in
// advanced mode) raw expression strings. Unknown group shapes are dropped here;
// the server stays the authority for fail-closed shapes.
function normalizeFilterNode(node, budget) {
  if (typeof node === "string") {
    const expression = node.trim();
    return expression ? expression.slice(0, BASE_QUERY_MAX) : null;
  }
  if (!node || typeof node !== "object") return null;
  if (!Array.isArray(node)) {
    const conjunction = BASE_FILTER_CONJUNCTIONS.find((key) => Array.isArray(node[key]));
    if (!conjunction) return normalizeCondition(node);
    const items = node[conjunction]
      .map((item) => normalizeFilterNode(item, budget))
      .filter((item) => item !== null && item !== undefined);
    // An empty group is a REAL shape (`{"or":[]}`, F3): keep it so URL ⇄ state
    // ⇄ request stay faithful. The server treats an absent predicate as "no
    // override" and an empty group as the evaluator does, so collapsing it here
    // would silently turn `{"or":[]}` into "no filter" on the way out.
    return { [conjunction]: items };
  }
  const out = [];
  for (const entry of node) {
    const item = normalizeFilterNode(entry, budget);
    if (item === null || item === undefined) continue;
    out.push(item);
    if (out.reduce((total, entry2) => total + countLeaves(entry2), 0) >= BASE_FILTER_MAX) break;
  }
  return out;
}

export function normalizeFilter(raw) {
  let source = raw;
  if (typeof source === "string") {
    if (source.trim() === "") return [];
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (Array.isArray(source)) {
    // The top-level array is the legacy AND list, but it may also carry raw
    // expression leaves (`?filter=["score > 8"]`, the desktop advanced mode).
    // Both go through the same node normalizer, so a string leaf is preserved
    // instead of being dropped by the condition-only branch (review F1).
    const out = [];
    for (const entry of source) {
      const item = normalizeFilterNode(entry, BASE_FILTER_MAX);
      // A nested array is not a legal leaf of the AND list; drop it rather than
      // inventing a nesting level the server contract does not ask for.
      if (item === null || item === undefined || Array.isArray(item)) continue;
      out.push(item);
      if (out.reduce((total, entry2) => total + countLeaves(entry2), 0) >= BASE_FILTER_MAX) break;
    }
    return out;
  }
  if (!source || typeof source !== "object") return [];
  const group = normalizeFilterNode(source, BASE_FILTER_MAX);
  return group ?? [];
}

export function filterParam(list) {
  const normalized = normalizeFilter(list);
  // A legacy AND list with no leaves is "no override" (no query parameter); a
  // group is a real shape and is encoded even when empty, so `{"or":[]}` cannot
  // round-trip into "all rows" by accident (F3).
  if (Array.isArray(normalized)) return normalized.length ? JSON.stringify(normalized) : null;
  return JSON.stringify(normalized);
}

export function parseFilterParam(value) {
  return normalizeFilter(value);
}

export function normalizeQuery(value) {
  if (typeof value !== "string") return "";
  return value.slice(0, BASE_QUERY_MAX);
}

// `{ property, direction }` or null. A missing/blank direction defaults to ASC (the
// `.base` default); an unknown direction or a non-object is dropped rather than
// coerced, and the server stays the authority for its own 400/422 codes.
export function normalizeGroup(raw) {
  let source = raw;
  if (typeof source === "string") {
    if (source.trim() === "") return null;
    try {
      source = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const property = normalizeKey(source.property);
  if (!property) return null;
  const direction = source.direction === undefined || source.direction === null
    ? DEFAULT_GROUP_DIRECTION
    : source.direction;
  if (!BASE_GROUP_DIRECTIONS.includes(direction)) return null;
  return { property, direction };
}

export function groupParam(group) {
  const normalized = normalizeGroup(group);
  return normalized ? JSON.stringify(normalized) : null;
}

export function parseGroupParam(value) {
  return normalizeGroup(value);
}

// The rule the server actually applied to this response: the reader's `?group=`
// override when present, else the view's declared `groupBy`. Both are the same
// `{ property, direction }` shape, so every consumer (menu row, table headings,
// active badge) reads one value and cannot disagree with the result set.
export function effectiveGroupBy(state) {
  return normalizeGroup(state?.group) ?? normalizeGroup(state?.viewGroupBy);
}

// `?view=&sort=&filter=&q=&group=` — stable order, empty values omitted.
export function buildBaseSearch({ view = null, sort = [], filter = [], q = "", group = null } = {}) {
  const params = new URLSearchParams();
  if (view !== null && view !== undefined && String(view) !== "") params.set("view", String(view));
  const sortValue = sortParam(sort);
  if (sortValue) params.set("sort", sortValue);
  const filterValue = filterParam(filter);
  if (filterValue) params.set("filter", filterValue);
  const query = normalizeQuery(q);
  if (query) params.set("q", query);
  const groupValue = groupParam(group);
  if (groupValue) params.set("group", groupValue);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function parseBaseSearch(search) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const view = params.get("view");
  return {
    view: view !== null && view !== "" ? view : null,
    sort: parseSortParam(params.get("sort")),
    filter: parseFilterParam(params.get("filter")),
    q: normalizeQuery(params.get("q") || ""),
    group: parseGroupParam(params.get("group")),
  };
}

// Route + search, used for both the address bar and the history entry.
export function buildBaseHref(route, state) {
  const path = String(route || "");
  const search = buildBaseSearch(state);
  const hashIndex = path.indexOf("#");
  if (hashIndex < 0) return `${path}${search}`;
  return `${path.slice(0, hashIndex)}${search}${path.slice(hashIndex)}`;
}
