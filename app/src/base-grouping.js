// P1-D grouping model: turn an ALREADY ORDERED row sequence into flat group
// boundaries (`{ boundaries, totalGroups }`) without copying row payloads.
//
// Pure module by contract (§7): no fs / path / express / MCP imports, no
// eval / Function / vm / dynamic import, no process state, no clock, no I/O.
// It IS imported by `base-query.js` (INT-D wired this seam in 刀4) and imports
// only other pure modules (`base-values.js`, `base-summaries.js`): still no
// fs / path / express / MCP, no eval / Function / vm / dynamic import, no
// process state, no clock, no I/O.
//
// Scope, frozen by the W2-A BRIEF §2 and SEMANTIC-ORDER-EVIDENCE.md:
//   * input is an ALREADY SORTED row sequence (B3 `filter -> sort -> group`).
//     This module never filters, never sorts rows and never reorders the rows
//     inside a group: group-internal order IS the caller's sort result, whose
//     final `file.path` ascending tie-break (B7) the caller guarantees;
//   * the group key is an ALREADY EVALUATED key. This module performs no
//     property resolution and no formula evaluation: either the caller injects
//     a `keyOf(row, index)` seam, or the module reads the named property as an
//     OWN DATA property (never inherited, never an accessor);
//   * supported key types: string / number / boolean / date family
//     (`date` + `datetime` share one instant order), plus the single null group
//     — empty, missing, `null`, `NaN`, ±Infinity and invalid dates are ONE
//     value (B6#1/#3). The null (keyless) group is ALWAYS LAST, under ASC and
//     DESC alike (D1 = desktop asar fact P10/P11; this supersedes the B7 DESIGN
//     "smallest side" that this module shipped first). `list` / `object` keys
//     fail closed;
//   * no per-group limit. `view.limit` is a global view scalar (B4); applying
//     it is INT-D's orchestration step, so this model never truncates a group.
//
// Group ordering reuses the P1-A typed total order `compareBaseValues`
// (app/src/base-values.js) instead of a second comparator, so grouping and
// sorting cannot drift apart (§7 "no two long-lived compare implementations").

import { compareBaseValues, normalizeBaseValue, readOwnDataProperty } from "./base-values.js";
import { BaseSummaryError, isBuiltinSummaryName, readSummaryDeclarations } from "./base-summaries.js";

/** Allowed `groupBy.direction` values (exact, case-sensitive; B7). */
export const GROUP_DIRECTIONS = Object.freeze(["ASC", "DESC"]);

/** Direction used when `groupBy.direction` is absent. */
export const DEFAULT_GROUP_DIRECTION = "ASC";

/** Failure codes carried by {@link BaseGroupingError}. */
export const GROUPING_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "invalid_input",
  INVALID_GROUP_BY: "invalid_group_by",
  INVALID_DIRECTION: "invalid_direction",
  UNSUPPORTED_GROUP_KEY: "unsupported_group_key",
});

export class BaseGroupingError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BaseGroupingError";
    this.code = code;
  }
}

// Canonical identity of the null group. The NUL prefix cannot collide with the
// type-tagged identities below, so a caller-supplied string can never be
// mistaken for the empty value.
const NULL_GROUP_IDENTITY = "\u0000null";

/**
 * Canonical grouping identity of one evaluated key.
 *
 * The identity is deliberately the same equivalence that `baseValuesEqual`
 * implements (missing === null, `date`/`datetime` by instant, `link` by path,
 * cross-type values never equal), so the map that collects groups and the
 * comparator that orders them can never disagree: two distinct identities
 * always compare non-zero. `list` / `object` keys fail closed
 * (`unsupported_group_key`) rather than inventing a deep order.
 */
export function groupKeyIdentity(value) {
  const normalized = normalizeBaseValue(value);
  switch (normalized.type) {
    case "missing":
    case "null":
      return NULL_GROUP_IDENTITY;
    case "boolean":
      return `b:${normalized.value}`;
    case "number":
      return `n:${normalized.value}`;
    case "string":
      return `s:${JSON.stringify(normalized.value)}`;
    case "date":
    case "datetime":
      // One prefix for the whole date family: a date-only key and a datetime
      // key with the same instant are one group (B6/#3 typed equality).
      return `@:${normalized.value}`;
    case "link":
      return `l:${JSON.stringify(normalized.value.path)}`;
    default:
      throw new BaseGroupingError(
        `Base groupBy is not supported for ${normalized.type} values (out of scope)`,
        GROUPING_ERROR_CODES.UNSUPPORTED_GROUP_KEY,
      );
  }
}

/**
 * Build the grouping model of an already sorted row sequence.
 *
 * @param {ReadonlyArray<unknown>} sortedRows rows in the caller's sort order
 *   (`filter -> sort -> group`, B3); the array is never mutated or copied.
 * @param {{ property: string, direction?: "ASC"|"DESC", keyOf?: (row: unknown, index: number) => unknown }} groupBy
 *   `property` is required and names the group property (used for the default
 *   own-data read and for diagnostics); `direction` defaults to `ASC`.
 * @param {{ keyOf?: (row: unknown, index: number) => unknown }} [options]
 *   `keyOf` wins over `groupBy.keyOf`; when present the module never reads a
 *   property and its return value is the evaluated group key verbatim.
 * @returns {{ boundaries: ReadonlyArray<{ groupValue: unknown, startIndex: number, count: number }>, totalGroups: number }}
 *   Frozen. `boundaries` are in group order and describe a partition of the
 *   rows as concatenated in that same group order: `startIndex` starts at 0 and
 *   each next `startIndex` is the previous `startIndex + count`, so
 *   `Σ count === sortedRows.length` and `boundaries.length === totalGroups`.
 *   `groupValue` is the first-seen raw key of the group, except the null group,
 *   which is `null`. `rowIndexes` lists the group members as indexes into
 *   `sortedRows` (ascending, i.e. in the caller's sort order) so a caller can
 *   materialize the group without re-deriving membership; the payload is still
 *   never copied.
 * @throws {BaseGroupingError} `invalid_input` / `invalid_group_by` /
 *   `invalid_direction` / `unsupported_group_key`.
 */
export function buildBaseGroups(sortedRows, groupBy, options = {}) {
  if (!Array.isArray(sortedRows)) {
    throw new BaseGroupingError("Base groupBy requires an array of rows", GROUPING_ERROR_CODES.INVALID_INPUT);
  }
  if (groupBy === null || typeof groupBy !== "object" || Array.isArray(groupBy)) {
    throw new BaseGroupingError("Base groupBy must be an object with a property name", GROUPING_ERROR_CODES.INVALID_GROUP_BY);
  }
  const { property } = groupBy;
  if (typeof property !== "string" || property.length === 0) {
    throw new BaseGroupingError("Base groupBy.property must be a non-empty string", GROUPING_ERROR_CODES.INVALID_GROUP_BY);
  }
  const direction = groupBy.direction === undefined ? DEFAULT_GROUP_DIRECTION : groupBy.direction;
  if (!GROUP_DIRECTIONS.includes(direction)) {
    throw new BaseGroupingError(
      `Unsupported Base groupBy direction "${direction}" (expected ASC or DESC)`,
      GROUPING_ERROR_CODES.INVALID_DIRECTION,
    );
  }
  const keyOf = options?.keyOf ?? groupBy.keyOf;
  if (keyOf !== undefined && typeof keyOf !== "function") {
    throw new BaseGroupingError("Base groupBy keyOf resolver must be a function", GROUPING_ERROR_CODES.INVALID_GROUP_BY);
  }
  const keyAt = typeof keyOf === "function"
    ? (row, index) => keyOf(row, index)
    : (row) => {
      if (row === null || typeof row !== "object") {
        throw new BaseGroupingError(
          `Base groupBy rows must be objects to read property "${property}"`,
          GROUPING_ERROR_CODES.INVALID_INPUT,
        );
      }
      return readOwnDataProperty(row, property);
    };

  // One pass in input order: `count` accumulates in place, so the rows inside a
  // group stay in the caller's sort order (B3) and no row payload is copied.
  const groups = new Map();
  for (let index = 0; index < sortedRows.length; index += 1) {
    const key = keyAt(sortedRows[index], index);
    const identity = groupKeyIdentity(key);
    const existing = groups.get(identity);
    if (existing !== undefined) {
      existing.count += 1;
      existing.rowIndexes.push(index);
      continue;
    }
    const isNullGroup = identity === NULL_GROUP_IDENTITY;
    if (isNullGroup) {
      groups.set(identity, { key, groupValue: null, hasKey: false, count: 1, rowIndexes: [index] });
      continue;
    }
    groups.set(identity, { key, groupValue: key, hasKey: true, count: 1, rowIndexes: [index] });
  }

  // Group order is decided by the key, never by first appearance. Distinct
  // identities never compare 0, so the order is total and stable regardless of
  // the input permutation.
  //
  // D1 (desktop asar P10/P11): the keyless (null) group is ALWAYS LAST — the
  // direction multiplier is only applied when BOTH sides have a key. This is a
  // deliberate supersession of the earlier B7 DESIGN ("null on the smallest
  // side": first under ASC, last under DESC); only group ORDER moves, never the
  // group membership.
  const ordered = [...groups.values()].sort((left, right) => {
    if (!left.hasKey || !right.hasKey) return left.hasKey === right.hasKey ? 0 : left.hasKey ? -1 : 1;
    const result = compareBaseValues(left.key, right.key);
    return direction === "DESC" ? -result : result;
  });

  let startIndex = 0;
  const boundaries = ordered.map((group) => {
    const boundary = Object.freeze({
      groupValue: group.groupValue,
      startIndex,
      count: group.count,
      rowIndexes: Object.freeze(group.rowIndexes),
    });
    startIndex += group.count;
    return boundary;
  });
  return Object.freeze({ boundaries: Object.freeze(boundaries), totalGroups: boundaries.length });
}

// ── 刀4 declaration gate (MOVED from `base-query.js`, pure move) ─────────────
//
// `views[].groupBy`, `views[].summaries` and the top-level `summaries` registry
// used to be rejected outright (Wave 0-D). 刀4 executes them, per
// docs/bases/SEMANTICS-FROZEN.md (frozen pipeline + D1–D5). What still fails
// closed is everything this subset cannot execute — a shape, a name or a key
// path — so a document is never served as `supportedSubset: true` with a
// half-applied semantic key (contract §2.2/§17).
//
// Declaration freeze rule (unchanged from Wave 0-D): a key counts as declared
// only when it is non-empty — `null`, `undefined`, `{}` and `[]` are absent.
//
// These functions carry the FINAL wire message and code (`unsupported`) on a
// BaseGroupingError; the `base-query.js` call sites map them through
// `toBaseQueryError`, so the observable `{code, message}` pair is byte-identical
// to the pre-move BaseQueryError.

/** Wire code for a declaration this subset cannot execute. */
export const UNSUPPORTED_DECLARATION_CODE = "unsupported";

function unsupportedDeclarationError(keyPath, detail) {
  return new BaseGroupingError(`Unsupported Base key: ${keyPath} (${detail})`, UNSUPPORTED_DECLARATION_CODE);
}

// JSON-safe projection of one group key. The empty (missing/null) group is
// canonical: `key: null` + `keyType: "null"` (B6#1 missing ≡ null). Dates are
// rendered as ISO-8601 UTC strings so the DTO stays JSON-safe.
export function groupKeyDto(groupValue) {
  const normalized = normalizeBaseValue(groupValue);
  switch (normalized.type) {
    case "missing":
    case "null":
      return { key: null, keyType: "null" };
    case "date":
    case "datetime":
      return { key: new Date(normalized.value).toISOString(), keyType: normalized.type };
    case "link":
      return { key: normalized.value.path, keyType: "link" };
    default:
      return { key: normalized.value, keyType: normalized.type };
  }
}

// Normalize `views[].groupBy` to `{ property, direction }`, or null when absent.
// The frozen legal domain is exactly `{ property: <non-empty string>,
// direction?: "ASC"|"DESC" }`; anything else fails closed (the desktop reads no
// direction table, see SEMANTICS-FROZEN E6 / matrix §9 V3).
export function readGroupByDeclaration(view) {
  const declared = view?.groupBy;
  if (declared === null || declared === undefined) return null;
  // Wave 0-D declaration-freeze rule: an EMPTY container is "absent".
  if (Array.isArray(declared)) {
    if (declared.length === 0) return null;
    throw unsupportedDeclarationError("views[].groupBy", "must be a mapping with a property name");
  }
  if (typeof declared !== "object") {
    throw unsupportedDeclarationError("views[].groupBy", "must be a mapping with a property name");
  }
  if (Object.keys(declared).length === 0) return null;
  const { property } = declared;
  if (typeof property !== "string" || property.length === 0) {
    throw unsupportedDeclarationError("views[].groupBy", "groupBy.property must be a non-empty string");
  }
  const direction = declared.direction === undefined ? DEFAULT_GROUP_DIRECTION : declared.direction;
  if (!GROUP_DIRECTIONS.includes(direction)) {
    throw unsupportedDeclarationError("views[].groupBy", `unsupported direction "${direction}", expected ASC or DESC`);
  }
  // The frozen legal domain is exactly `{ property, direction? }`, so a stray
  // key (`directions`, `groupOrder`, …) is a typo that would otherwise be
  // silently swallowed while the response still claims `supportedSubset: true`.
  // It fails closed and names the offending key.
  for (const key of Object.keys(declared)) {
    if (key !== "property" && key !== "direction") {
      throw unsupportedDeclarationError(
        "views[].groupBy",
        `unsupported key "${key}" (the frozen legal domain is exactly { property, direction? })`,
      );
    }
  }
  return { property, direction };
}

// Document-scoped on purpose: `queryBaseSnapshot` returns every declared view,
// so a non-selected view carrying a key this subset cannot execute would still
// be published as part of a `supportedSubset: true` response. The top-level
// `summaries` registry is a declaration only: an unreferenced custom summary
// changes no row, column or group (exactly like the desktop); its shape is still
// validated, and a view that REFERENCES a custom name fails closed because the
// `values.*` surface is not implemented (matrix §3).
export function assertSupportedGroupingKeys(base) {
  try {
    const customNames = (readSummaryDeclarations(base?.summaries, "summaries") ?? []).map((entry) => entry.key);
    for (const view of Array.isArray(base?.views) ? base.views : []) {
      readGroupByDeclaration(view);
      for (const { key, value } of readSummaryDeclarations(view?.summaries, "views[].summaries") ?? []) {
        if (isBuiltinSummaryName(value)) continue;
        throw unsupportedDeclarationError(
          "views[].summaries",
          customNames.includes(value)
            ? `custom summary "${value}" for property "${key}" uses the values.* surface, which is not implemented`
            : `unknown summary name "${value}" for property "${key}"`,
        );
      }
    }
  } catch (error) {
    if (error instanceof BaseGroupingError) throw error;
    if (error instanceof BaseSummaryError) {
      const keyPath = error.message.startsWith("views[].summaries") ? "views[].summaries" : "summaries";
      throw unsupportedDeclarationError(keyPath, error.message);
    }
    throw error;
  }
}
