// #628 — MCP-side normalization of the ad-hoc `query_base` narrowing inputs.
//
// `filters` / `sort` / `search` are the MCP spelling of the frozen Web Base API
// overrides (`?filter=` / `?sort=` / `?q=`, D-PARITY-PLAN). They translate into
// the canonical `filterExtra` / `sortOverride` / `textQuery` inputs of
// `base-query.js`, so filtering, matching and ordering stay single-sourced: this
// module never evaluates a filter, compares a value or renders a row. It owns
// only the *transport shape* (MCP receives structured JSON, the Web receives
// JSON strings) and maps every structural failure onto the existing
// BaseQueryError codes G3/G4 already use:
//
//   invalid-schema — malformed shape (bad type, unknown key, non-object item)
//   unsupported    — well-formed but not executable (unknown sort direction; a
//                    column outside the selected view is rejected with the same
//                    code by the canonical column gate in `base-query.js`)
//
// Every input is optional. An absent or empty input returns `undefined`, which
// `evaluateBaseView` treats as "no override" — so a `query_base` call that
// passes none of them is byte-for-byte the pre-#628 response.
import { BaseQueryError, assertBaseFilterTree } from "./base-query.js";

// Mirrors `BASE_QUERY_TEXT_MAX` (src/app/base-params.js): the Web transport
// bounds `q` at 256 characters, and the MCP surface must not accept a wider
// predicate than the contract it reuses. `base-adhoc-params.test.js` asserts the
// two constants are equal, so the comment cannot drift silently.
export const ADHOC_SEARCH_MAX = 256;
export const ADHOC_SORT_DIRECTIONS = Object.freeze(["asc", "desc"]);
const SORT_ITEM_KEYS = Object.freeze(["property", "direction"]);

/**
 * The desktop filter-group dialect, unchanged: `{and|or|not: [...]}` nested to
 * any depth, leaves either a structured `{key, op, value}` condition from the
 * frozen 11-operator list or an advanced expression string. An array is the
 * legacy AND list. The canonical validator is called here so a malformed tree
 * fails closed before any Vault I/O, with the same message/code the evaluator
 * would raise.
 */
export function normalizeAdhocFilters(filters) {
  if (filters === undefined || filters === null) return undefined;
  assertBaseFilterTree(filters, { allowConditions: true, path: "filters" });
  return filters;
}

/**
 * `[{ property, direction }]` — the `.base` sort spelling, translated to the
 * canonical `sortOverride` shape (`{key, dir}`). `direction` is optional and
 * defaults to `asc`; `ASC`/`DESC` are accepted because that is what a `.base`
 * file writes. An unknown direction fails closed (`unsupported`) instead of
 * silently sorting ascending.
 */
export function normalizeAdhocSort(sort) {
  if (sort === undefined || sort === null) return undefined;
  if (!Array.isArray(sort)) throw new BaseQueryError("sort must be an array of { property, direction } items", "invalid-schema");
  if (!sort.length) return undefined;
  return sort.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BaseQueryError(`sort[${index}] must be an object`, "invalid-schema");
    }
    for (const key of Object.keys(item)) {
      if (!SORT_ITEM_KEYS.includes(key)) throw new BaseQueryError(`sort[${index}] has an unknown key "${key}"`, "invalid-schema");
    }
    if (typeof item.property !== "string" || item.property === "") {
      throw new BaseQueryError(`sort[${index}] needs a string property`, "invalid-schema");
    }
    const raw = item.direction === undefined || item.direction === null ? "asc" : item.direction;
    const direction = typeof raw === "string" ? raw.toLowerCase() : raw;
    if (!ADHOC_SORT_DIRECTIONS.includes(direction)) {
      throw new BaseQueryError(`Unsupported Base sort direction: ${String(raw)}`, "unsupported");
    }
    return { key: item.property, dir: direction };
  });
}

/**
 * The case-insensitive substring predicate over the selected view's columns,
 * i.e. exactly the canonical `textQuery`. An empty string is the Web's `?q=`
 * ("no predicate", not an error); an over-long literal is refused with the same
 * bound as the Web transport instead of being truncated or scanned unbounded.
 */
export function normalizeAdhocSearch(search) {
  if (search === undefined || search === null) return undefined;
  if (typeof search !== "string") throw new BaseQueryError("search must be a string", "invalid-schema");
  if (!search) return undefined;
  if (search.length > ADHOC_SEARCH_MAX) {
    throw new BaseQueryError(`Base query search is limited to ${ADHOC_SEARCH_MAX} characters`, "invalid-schema");
  }
  return search;
}
