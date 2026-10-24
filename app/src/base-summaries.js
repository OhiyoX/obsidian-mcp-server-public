// 刀4 built-in summaries: the value layer behind `views[].summaries`.
//
// Pure module by contract (§7): no fs / path / express / MCP imports, no
// eval / Function / vm / dynamic import, no process state, no clock, no I/O.
// Property resolution is an injected seam (`resolveValue`), so this module never
// reads a record itself and never evaluates a formula.
//
// Frozen semantics (docs/bases/SEMANTICS-FROZEN.md):
//   * P18 — the built-in set is exactly the desktop registry: number
//     Average / Min / Max / Sum / Range / Median / Stddev, date Earliest /
//     Latest, boolean Checked / Unchecked, any Empty / Filled / Unique.
//     Desktop implements them as formula *source strings*; this module computes
//     the same values natively because the `values.*` surface is not part of the
//     frozen expression subset (matrix §3), and relaxing that is out of scope.
//   * P18 rounding — Average / Sum / Stddev round to 2 decimals; Min / Max /
//     Median / Range do not.
//   * P19 / D2 — `Stddev` is the POPULATION standard deviation (divisor n, not
//     n-1); n === 1 gives 0; an empty value set gives no value.
//   * P20 / D3 — `Empty` counts only `isType("null")` values, mapped onto this
//     project's frozen missing ≡ null equivalence (B6#1): `""`, `0` and `false`
//     are values, never empty.
//   * P21 / D4 — `Unique` is typed equality (`baseValuesEqual`) over
//     `toString()` buckets, so `1` and `"1"` are distinct and every empty value
//     counts once.
//   * P15/P16 — summaries aggregate the RETAINED rows of one group (post-limit).
//
// Deliberate narrowings vs the desktop (registered in the compatibility matrix,
// never silently different):
//   * an unknown summary NAME and a custom summary declared in the top-level
//     `summaries:` section fail closed (`unsupported`), where the desktop would
//     render an empty cell;
//   * a summary that cannot be computed for a group carries an explicit
//     `reason` (`empty` / `type-mismatch` / `unverified-unit` / `not-a-column`)
//     with `value: null`, where the desktop silently renders nothing (E9/E10);
//   * the date `Range` unit/rounding is not readable from the asar (U4), so it
//     reports `unverified-unit` instead of inventing a duration unit.

import { baseValuesEqual, normalizeBaseValue } from "./base-values.js";

/** Failure codes carried by {@link BaseSummaryError}. */
export const SUMMARY_ERROR_CODES = Object.freeze({
  INVALID_SUMMARIES: "invalid_summaries",
  UNKNOWN_SUMMARY: "unknown_summary",
  CUSTOM_SUMMARY_UNSUPPORTED: "custom_summary_unsupported",
});

export class BaseSummaryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BaseSummaryError";
    this.code = code;
  }
}

/** Number-family summaries (P18). */
export const NUMBER_SUMMARY_NAMES = Object.freeze(["Average", "Min", "Max", "Sum", "Range", "Median", "Stddev"]);
/** Date-family summaries (P18). `Range` is shared with the number family. */
export const DATE_SUMMARY_NAMES = Object.freeze(["Earliest", "Latest"]);
/** Boolean-family summaries (P18). */
export const BOOLEAN_SUMMARY_NAMES = Object.freeze(["Checked", "Unchecked"]);
/** Any-typed count summaries (P18). */
export const ANY_SUMMARY_NAMES = Object.freeze(["Empty", "Filled", "Unique"]);
/** Every built-in summary name, in the desktop registry order (P18). */
export const BUILTIN_SUMMARY_NAMES = Object.freeze([
  ...NUMBER_SUMMARY_NAMES,
  ...DATE_SUMMARY_NAMES,
  ...BOOLEAN_SUMMARY_NAMES,
  ...ANY_SUMMARY_NAMES,
]);

// Summary names that are always computable, whatever the group's value types:
// they are counts, and the desktop formula filters an empty list to 0 (P18).
const COUNT_SUMMARY_NAMES = Object.freeze(["Checked", "Unchecked", "Empty", "Filled", "Unique"]);
const ROUNDED_SUMMARY_NAMES = Object.freeze(["Average", "Sum", "Stddev"]);

export function isBuiltinSummaryName(name) {
  return BUILTIN_SUMMARY_NAMES.includes(name);
}

function invalid(message) {
  return new BaseSummaryError(message, SUMMARY_ERROR_CODES.INVALID_SUMMARIES);
}

/**
 * Normalize a `summaries:` declaration (view-level `property -> name`, or the
 * top-level `name -> formula source` registry) into an ordered entry list.
 * The Wave 0-D declaration-freeze rule still holds: `null`, `undefined`, `{}`
 * and `[]` count as ABSENT (return `null`), never as an error.
 *
 * @param {unknown} value the raw YAML value
 * @param {string} keyPath the frozen key path used in diagnostics
 * @returns {ReadonlyArray<{ key: string, value: string }>|null}
 * @throws {BaseSummaryError} `invalid_summaries`
 */
export function readSummaryDeclarations(value, keyPath) {
  if (value === null || value === undefined) return null;
  // Wave 0-D declaration-freeze rule: an EMPTY container is "absent".
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    throw invalid(`${keyPath} must be a mapping of key to summary name`);
  }
  if (typeof value !== "object") {
    throw invalid(`${keyPath} must be a mapping of key to summary name`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  return Object.freeze(entries.map(([key, name]) => {
    if (typeof name !== "string" || name.length === 0) {
      throw invalid(`${keyPath}["${key}"] must be a summary name string`);
    }
    return Object.freeze({ key, value: name });
  }));
}

function roundToTwo(value) {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

// P19 / D2: population standard deviation (divisor n). n === 1 gives 0 because
// every squared deviation is 0; an empty set is handled by the caller.
function populationStddev(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

// P18 `Median`: the middle value, or the mean of the two middle values.
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// P21 / D4: bucket by the rendered string, then compare within the bucket with
// typed equality. `1` and `"1"` land in the same bucket but are not equal, so
// both survive; every empty value shares one bucket and one identity.
function uniqueCount(values) {
  const buckets = new Map();
  for (const value of values) {
    const normalized = normalizeBaseValue(value);
    const bucketKey = normalized.type === "missing" || normalized.type === "null"
      ? "\u0000null"
      : String(normalized.value);
    const bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      buckets.set(bucketKey, [value]);
      continue;
    }
    if (!bucket.some((existing) => baseValuesEqual(existing, value))) bucket.push(value);
  }
  let total = 0;
  for (const bucket of buckets.values()) total += bucket.length;
  return total;
}

function isoInstant(epoch) {
  return new Date(epoch).toISOString();
}

function cell(summary, value, reason = null) {
  return Object.freeze({ summary, value, reason });
}

/**
 * Compute one built-in summary over one group's values.
 *
 * @param {string} summary a built-in summary name
 * @param {ReadonlyArray<unknown>} rawValues the group's raw property values
 * @returns {{ summary: string, value: unknown, reason: string|null }} frozen
 */
export function computeBuiltinSummary(summary, rawValues) {
  const normalized = rawValues.map((value) => normalizeBaseValue(value));
  const present = normalized.filter((value) => value.type !== "missing" && value.type !== "null");
  const types = new Set(present.map((value) => value.type));

  // Counts are defined for every group, including an empty one (P18 filters).
  if (COUNT_SUMMARY_NAMES.includes(summary)) {
    if (summary === "Empty") return cell(summary, normalized.filter((value) => value.type === "missing" || value.type === "null").length);
    if (summary === "Filled") return cell(summary, present.length);
    if (summary === "Unique") return cell(summary, uniqueCount(rawValues));
    if (summary === "Checked") return cell(summary, normalized.filter((value) => value.type === "boolean" && value.value === true).length);
    return cell(summary, normalized.filter((value) => value.type === "boolean" && value.value === false).length);
  }

  const onlyNumbers = present.length > 0 && [...types].every((type) => type === "number");
  const onlyDates = present.length > 0 && [...types].every((type) => type === "date" || type === "datetime");

  if (summary === "Range" && onlyDates) {
    // U4: the desktop date `Range` unit and rounding are not readable from the
    // asar, so this narrowing reports "unverified" instead of guessing.
    return cell(summary, null, "unverified-unit");
  }
  if (DATE_SUMMARY_NAMES.includes(summary)) {
    if (present.length === 0) return cell(summary, null, "empty");
    if (!onlyDates) return cell(summary, null, "type-mismatch");
    const epochs = present.map((value) => value.value);
    const chosen = summary === "Earliest" ? Math.min(...epochs) : Math.max(...epochs);
    // DESIGN (U5): the instant is the verified semantics; the ISO-8601 UTC
    // string is this project's JSON-safe rendering of it.
    return cell(summary, isoInstant(chosen));
  }

  // Every remaining built-in is a number aggregate (Range included).
  if (present.length === 0) return cell(summary, null, "empty");
  if (!onlyNumbers) return cell(summary, null, "type-mismatch");
  const numbers = present.map((value) => value.value);
  let result;
  switch (summary) {
    case "Average":
      result = mean(numbers);
      break;
    case "Min":
      result = Math.min(...numbers);
      break;
    case "Max":
      result = Math.max(...numbers);
      break;
    case "Sum":
      result = numbers.reduce((total, value) => total + value, 0);
      break;
    case "Range":
      result = Math.max(...numbers) - Math.min(...numbers);
      break;
    case "Median":
      result = median(numbers);
      break;
    default:
      result = populationStddev(numbers);
      break;
  }
  return cell(summary, ROUNDED_SUMMARY_NAMES.includes(summary) ? roundToTwo(result) : result);
}

/**
 * Compute every declared summary over one row group.
 *
 * @param {{ declarations: ReadonlyArray<{key: string, value: string}>, rows: ReadonlyArray<unknown>, resolveValue: (row: unknown, property: string) => unknown, columnKeys?: ReadonlyArray<string>|null, customSummaryNames?: ReadonlyArray<string> }} input
 *   `resolveValue` is the caller's property seam (formula properties included);
 *   `columnKeys` is the projected column set — a declared summary for a
 *   property outside it reports `not-a-column` instead of being silently
 *   dropped (E8).
 * @returns {Readonly<Record<string, { summary: string, value: unknown, reason: string|null }>>} frozen
 * @throws {BaseSummaryError} `unknown_summary` / `custom_summary_unsupported`
 */
export function computeBaseSummaries({ declarations, rows, resolveValue, columnKeys = null, customSummaryNames = [] }) {
  if (typeof resolveValue !== "function") throw invalid("Base summaries need a value resolver");
  const columns = Array.isArray(columnKeys) ? new Set(columnKeys) : null;
  const result = {};
  for (const { key, value: summary } of declarations) {
    if (!isBuiltinSummaryName(summary)) {
      if (customSummaryNames.includes(summary)) {
        throw new BaseSummaryError(
          `Unsupported Base summary "${summary}" for property "${key}": custom summary formulas use the values.* surface, which is not implemented`,
          SUMMARY_ERROR_CODES.CUSTOM_SUMMARY_UNSUPPORTED,
        );
      }
      throw new BaseSummaryError(
        `Unsupported Base summary "${summary}" for property "${key}" (unknown summary name)`,
        SUMMARY_ERROR_CODES.UNKNOWN_SUMMARY,
      );
    }
    if (columns && !columns.has(key)) {
      result[key] = cell(summary, null, "not-a-column");
      continue;
    }
    result[key] = computeBuiltinSummary(summary, rows.map((row) => resolveValue(row, key)));
  }
  return Object.freeze(result);
}
