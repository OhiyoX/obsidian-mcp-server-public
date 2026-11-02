// P1-A typed value layer: property resolution, type normalization, safe typed
// comparison and the frozen operator semantics for the portable Bases subset.
//
// Pure module by contract (§7): no fs / path / express / MCP imports, no
// eval / Function / vm / dynamic import, no process state, no clock, no I/O.
// It does NOT evaluate an AST (P1-A ships no evaluator): it exposes the typed
// primitives INT-A will call while walking base-expression.js trees, and it is
// not wired into base-query.js / base-formulas.js / workflows.js.
//
// Frozen type vocabulary (§8): `SUPPORTED_VALUE_TYPES` is what this module can
// classify and compare today; `PLANNED_VALUE_TYPES` freezes the official values
// a later phase may add, so no phase can quietly rename or reuse a type. A
// planned type never materializes as a classification yet — an unparsed
// duration string is still a `string`.
//
// Typed equality is strict: `1 == "1"` is false, because JavaScript `String()`
// coercion is what §14.4 forbids. The legacy P0 filter path in workflows.js
// keeps its historical coercion — this module is not wired into it, and §7
// requires such a change to be an explicit, separately reviewed breaking change.
//
// Empty/NaN semantics follow SEMANTIC-ORDER-EVIDENCE.md B6: DOC rows are the
// official `isEmpty()` per type; DESIGN rows (marked inline) are missing ≡ null,
// NaN / invalid dates as `missing`, and empty values on the smallest sort side.

import {
  BaseExpressionError,
  BASE_EXPRESSION_OPERATORS,
  ERROR_CODE_SYNTAX,
  ERROR_CODE_TYPE_MISMATCH,
  ERROR_CODE_UNSUPPORTED,
  PROPERTY_NAMESPACES,
} from "./base-expression.js";
import { isFormulaTruthy } from "./base-formulas.js";

export const SUPPORTED_VALUE_TYPES = Object.freeze([
  "missing",
  "null",
  "boolean",
  "number",
  "string",
  "date",
  "datetime",
  "list",
  "object",
  "link",
]);

export const PLANNED_VALUE_TYPES = Object.freeze(["duration", "regex", "image", "file", "html", "icon"]);

export const VALUE_TYPES = Object.freeze([...SUPPORTED_VALUE_TYPES, ...PLANNED_VALUE_TYPES]);

// Frozen sort rank. Only the empty side is observable in the official docs
// (1.10.0: indeterminate checkbox sorts with false); the rest is this project's
// deterministic DESIGN choice (B6#2 / B7), so a sort never coerces types.
const TYPE_RANK = Object.freeze({
  missing: 0,
  null: 0,
  boolean: 1,
  number: 2,
  date: 3,
  datetime: 3,
  string: 4,
  list: 5,
  link: 6,
  object: 7,
});

// Official `file.*` fields this subset reads; the list mirrors
// app/src/workflows.js `propertyValue` so INT-A can delegate without moving P0
// behaviour. `file.name` is the record basename and `file.ext` the "md" literal
// (registered DEFERRED divergences, recorded in the HANDOFF).
export const FILE_PROPERTY_KEYS = Object.freeze([
  "name",
  "basename",
  "path",
  "folder",
  "ext",
  "size",
  "ctime",
  "mtime",
  "tags",
  "links",
]);

// Official `file.*` fields that are deliberately not read yet; they fail closed.
// Official-but-unread fields (expensive or index-dependent) fail closed below.
export const DEFERRED_FILE_PROPERTY_KEYS = Object.freeze(["backlinks", "embeds", "properties", "file"]);

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;

function isMissingOrNull(type) {
  return type === "missing" || type === "null";
}

function isDateFamily(type) {
  return type === "date" || type === "datetime";
}

function typeMismatch(message) {
  return new BaseExpressionError(ERROR_CODE_TYPE_MISMATCH, message, null);
}

function unsupported(message) {
  return new BaseExpressionError(ERROR_CODE_UNSUPPORTED, message, null);
}

/**
 * Read an own *data* property without touching the prototype chain and without
 * invoking accessors. Hostile keys (`__proto__`, `constructor`, …) and
 * inherited/getter properties therefore resolve to `undefined` instead of
 * running user-influenced code (contract §7 / §14.7).
 */
export function readOwnDataProperty(target, key) {
  if (target === null || typeof target !== "object") return undefined;
  if (!Object.hasOwn(target, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function posixDirname(value) {
  if (typeof value !== "string") return undefined;
  const separator = value.lastIndexOf("/");
  return separator === -1 ? "" : value.slice(0, separator);
}

function utcEpoch(year, month, day, hour, minute, second, millisecond) {
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const date = new Date(epoch);
  const roundTrips = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second
    && date.getUTCMilliseconds() === millisecond;
  return roundTrips ? epoch : null;
}

// A YAML/ISO date is only recognized in its zero-padded shape; an invalid
// calendar date inside that shape is `missing` (DESIGN B6#3: illegal dates are
// treated as empty, they never become a bogus epoch).
function parseDateString(value) {
  const dateOnly = DATE_ONLY_PATTERN.exec(value);
  if (dateOnly) {
    const epoch = utcEpoch(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]), 0, 0, 0, 0);
    return epoch === null ? { type: "missing", value: undefined } : { type: "date", value: epoch };
  }
  const dateTime = DATE_TIME_PATTERN.exec(value);
  if (!dateTime) return null;
  const [, year, month, day, hour, minute, second = "0", fraction = "0", zone] = dateTime;
  const parts = utcEpoch(
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, "0")),
  );
  if (parts === null) return { type: "missing", value: undefined };
  let offsetMinutes = 0;
  if (zone && zone !== "Z") {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return { type: "missing", value: undefined };
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
  }
  return { type: "datetime", value: parts - offsetMinutes * 60000 };
}

// A Date whose UTC time of day is exactly midnight is a calendar date; anything
// else is a datetime. Deterministic and UTC-based; the official docs do not
// define a JavaScript-level mapping, so this is a documented narrowing.
function dateTypeForEpoch(epoch) {
  const date = new Date(epoch);
  const midnight = date.getUTCHours() === 0
    && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0;
  return midnight ? "date" : "datetime";
}

function readLinkValue(value) {
  if (readOwnDataProperty(value, "kind") !== "asLink") return null;
  const path = readOwnDataProperty(value, "path");
  if (typeof path !== "string") return null;
  const displayName = readOwnDataProperty(value, "displayName");
  return { path, displayName: typeof displayName === "string" ? displayName : null };
}

/**
 * Classify a raw record / frontmatter value into the frozen type vocabulary.
 * Returns a frozen `{ type, value }` pair; `missing` is the fail-closed
 * classification for everything unrecognized (functions, symbols, bigints,
 * NaN / ±Infinity, an invalid Date, a malformed ISO-looking date).
 */
export function normalizeBaseValue(value) {
  if (value === undefined) return { type: "missing", value: undefined };
  if (value === null) return { type: "null", value: null };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number") {
    // DESIGN B6#3: NaN is `missing`; ±Infinity is likewise treated as missing
    // so a non-finite number cannot poison a comparison or a summary.
    if (!Number.isFinite(value)) return { type: "missing", value: undefined };
    return { type: "number", value: value === 0 ? 0 : value };
  }
  if (typeof value === "string") return parseDateString(value) ?? { type: "string", value };
  if (typeof value === "object") {
    if (value instanceof Date) {
      const epoch = value.getTime();
      if (!Number.isFinite(epoch)) return { type: "missing", value: undefined };
      return { type: dateTypeForEpoch(epoch), value: epoch };
    }
    if (Array.isArray(value)) return { type: "list", value };
    const link = readLinkValue(value);
    if (link) return { type: "link", value: link };
    return { type: "object", value };
  }
  return { type: "missing", value: undefined };
}

/** Frozen type name for a raw value (a member of `VALUE_TYPES`). */
export function baseValueType(value) {
  return normalizeBaseValue(value).type;
}

/**
 * Official `isEmpty()` semantics per type (B6 DOC rows): string — no characters
 * (or not present); number — only "not present", so `0` is not empty; date —
 * always false; list — no elements; object — no own keys. `missing`/`null` are
 * empty here by construction (B6#1).
 */
export function isBaseValueEmpty(value) {
  const normalized = normalizeBaseValue(value);
  if (isMissingOrNull(normalized.type)) return true;
  if (normalized.type === "string") return normalized.value.length === 0;
  if (normalized.type === "list") return normalized.value.length === 0;
  if (normalized.type === "object") return Object.keys(normalized.value).length === 0;
  return false;
}

function normalizeReference(reference) {
  if (typeof reference === "string") {
    const segments = reference.split(".");
    if (segments.length === 1) return { namespace: "note", name: segments[0], explicit: false };
    if (!PROPERTY_NAMESPACES.includes(segments[0])) {
      throw unsupported(`Unsupported expression namespace "${segments[0]}" in reference "${reference}"`);
    }
    if (segments.length > 2) throw unsupported(`Unsupported nested member access "${reference}"`);
    return { namespace: segments[0], name: segments[1], explicit: true };
  }
  if (reference && typeof reference === "object") {
    const namespace = readOwnDataProperty(reference, "namespace");
    const name = readOwnDataProperty(reference, "name");
    if (typeof namespace === "string" && typeof name === "string") {
      return { namespace, name, explicit: readOwnDataProperty(reference, "explicit") === true };
    }
  }
  throw new BaseExpressionError(ERROR_CODE_SYNTAX, "Property reference must be a string or a reference node", null);
}

// `file.*` readers. Every read goes through readOwnDataProperty so a record
// whose fields are getters cannot execute them.
const FILE_VALUE_READERS = Object.freeze({
  name: (record) => readOwnDataProperty(record, "basename"),
  basename: (record) => readOwnDataProperty(record, "basename"),
  path: (record) => readOwnDataProperty(record, "path"),
  folder: (record) => posixDirname(readOwnDataProperty(record, "path")),
  ext: () => "md",
  size: (record) => readOwnDataProperty(readOwnDataProperty(record, "stat"), "size"),
  ctime: (record) => readOwnDataProperty(readOwnDataProperty(record, "stat"), "created"),
  mtime: (record) => readOwnDataProperty(readOwnDataProperty(record, "stat"), "modified"),
  tags: (record) => readOwnDataProperty(record, "tags"),
  links: (record) => {
    const links = readOwnDataProperty(record, "links");
    return Array.isArray(links) ? links.map((link) => readOwnDataProperty(link, "target")) : undefined;
  },
});

function resolveFileProperty(record, name) {
  if (Object.hasOwn(FILE_VALUE_READERS, name)) return normalizeBaseValue(FILE_VALUE_READERS[name](record));
  const reason = DEFERRED_FILE_PROPERTY_KEYS.includes(name)
    ? "official field deferred to a later phase"
    : "unknown field";
  throw unsupported(`Unsupported file property "file.${name}" (${reason})`);
}

function resolveFormulaReference(name, options) {
  const formulas = readOwnDataProperty(options, "formulaValues");
  if (formulas === undefined || formulas === null) {
    throw unsupported(`Formula reference "formula.${name}" needs a formula resolver, which P1-A does not wire (dependency DAG is P1-B / INT-B)`);
  }
  if (!Object.hasOwn(formulas, name)) throw unsupported(`Unsupported formula reference "formula.${name}" (unknown formula)`);
  return normalizeBaseValue(readOwnDataProperty(formulas, name));
}

/**
 * Resolve one property reference against an injected record.
 * `reference` is a base-expression reference node or a shorthand string
 * (`"price"`, `"note.price"`, `"file.size"`, `"formula.ppu"`).
 * Records are never scanned: only the injected record's own fields are read.
 * Unimplemented targets fail closed (UNSUPPORTED) instead of resolving to
 * `missing`, which would silently change a filter's result set.
 */
export function resolveBaseProperty(record, reference, options = {}) {
  const resolved = normalizeReference(reference);
  if (resolved.namespace === "formula") return resolveFormulaReference(resolved.name, options);
  if (resolved.namespace === "file") return resolveFileProperty(record, resolved.name);
  return normalizeBaseValue(readOwnDataProperty(readOwnDataProperty(record, "frontmatter"), resolved.name));
}

function objectValuesEqual(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && baseValuesEqual(left[key], right[key]));
}

/**
 * Typed deep equality. `missing` and `null` are the same value (DESIGN B6#1);
 * `date` and `datetime` compare by instant; every other cross-type pair is
 * unequal — never coerced through `String()` (reviewer requirement 4).
 */
export function baseValuesEqual(left, right) {
  const a = normalizeBaseValue(left);
  const b = normalizeBaseValue(right);
  const aEmpty = isMissingOrNull(a.type);
  const bEmpty = isMissingOrNull(b.type);
  if (aEmpty || bEmpty) return aEmpty && bEmpty;
  if (isDateFamily(a.type) && isDateFamily(b.type)) return a.value === b.value;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "boolean":
    case "number":
    case "string":
      return a.value === b.value;
    case "link":
      // Official: links equate when they point to the same file, i.e. by path.
      return a.value.path === b.value.path;
    case "list":
      return a.value.length === b.value.length && a.value.every((item, index) => baseValuesEqual(item, b.value[index]));
    case "object":
      return objectValuesEqual(a.value, b.value);
    default:
      return false;
  }
}

function compareListValues(left, right) {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const result = compareBaseValues(left[index], right[index]);
    if (result !== 0) return result;
  }
  return left.length < right.length ? -1 : 1;
}

function compareObjectValues(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  const shared = Math.min(leftKeys.length, rightKeys.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return leftKeys[index] < rightKeys[index] ? -1 : 1;
    const result = compareBaseValues(left[leftKeys[index]], right[rightKeys[index]]);
    if (result !== 0) return result;
  }
  return leftKeys.length < rightKeys.length ? -1 : 1;
}

/**
 * Deterministic total order over the frozen type vocabulary, for sorting.
 * Empty (`missing`/`null`) values sort on the smallest side (DESIGN B6#2);
 * unrelated types order by `TYPE_RANK` (DESIGN B7); same-type values order by
 * value, with `-1`/`1` always returned so a comparator never produces `NaN`.
 */
export function compareBaseValues(left, right) {
  const a = normalizeBaseValue(left);
  const b = normalizeBaseValue(right);
  if (baseValuesEqual(left, right)) return 0;
  const rankA = TYPE_RANK[a.type];
  const rankB = TYPE_RANK[b.type];
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  switch (a.type) {
    case "boolean":
      return a.value ? 1 : -1;
    case "number":
    case "string":
    case "date":
    case "datetime":
      return a.value < b.value ? -1 : 1;
    case "link":
      return a.value.path < b.value.path ? -1 : 1;
    case "list":
      return compareListValues(a.value, b.value);
    case "object":
      return compareObjectValues(a.value, b.value);
    default:
      return 0;
  }
}

function applyOrdering(operator, left, right) {
  switch (operator) {
    case ">":
      return left > right;
    case "<":
      return left < right;
    case ">=":
      return left >= right;
    case "<=":
      return left <= right;
    default:
      return false;
  }
}

// Truthiness is re-exported from base-formulas.js on purpose: §7 forbids two
// long-lived truthiness implementations, and that function is the frozen P0
// rule (null/empty string/0/NaN/empty list are falsey).
export const baseValueTruthy = isFormulaTruthy;

/**
 * Unary `!` — always defined (boolean of the truthiness of any value).
 * Unary `-` — numbers only.
 */
export function evaluateBaseUnaryOperator(operator, operand) {
  if (!BASE_EXPRESSION_OPERATORS.unary.includes(operator)) throw unsupported(`Unsupported unary operator "${operator}"`);
  if (operator === "!") return !baseValueTruthy(operand);
  const value = normalizeBaseValue(operand);
  if (value.type !== "number") throw typeMismatch(`Unary "${operator}" requires a number but found ${value.type}`);
  return value.value === 0 ? 0 : -value.value;
}

/**
 * Arithmetic `+ - * / %`. Numbers only, except `+`, which also concatenates two
 * strings (official Formulas.md "Combine text fields"). No implicit cross-type
 * coercion: `"5" + 3` is a type-mismatch, not `"53"` (§14.4 / §8). A date
 * operand is official-but-deferred instead of being silently coerced (Bases
 * syntax "Date arithmetic" needs the injected clock contract, §8 priority 3).
 * A non-finite result is normalized to `missing` (DESIGN B6#3).
 */
export function evaluateBaseBinaryOperator(operator, left, right) {
  if (!BASE_EXPRESSION_OPERATORS.arithmetic.includes(operator)) throw unsupported(`Unsupported arithmetic operator "${operator}"`);
  const a = normalizeBaseValue(left);
  const b = normalizeBaseValue(right);
  if ((operator === "+" || operator === "-") && (isDateFamily(a.type) || isDateFamily(b.type))) {
    throw unsupported(`Unsupported date arithmetic ("${operator}" with a date value): durations need the injected clock contract (P1-C)`);
  }
  if (operator === "+" && a.type === "string" && b.type === "string") return a.value + b.value;
  if (a.type !== "number" || b.type !== "number") {
    const expected = operator === "+" ? "two numbers or two strings" : "two numbers";
    throw typeMismatch(`Operator "${operator}" requires ${expected} but found ${a.type} and ${b.type}`);
  }
  const result = operator === "+"
    ? a.value + b.value
    : operator === "-"
      ? a.value - b.value
      : operator === "*"
        ? a.value * b.value
        : operator === "/"
          ? a.value / b.value
          : a.value % b.value;
  // DESIGN B6#3: a non-finite result (divide/modulo by zero) is `missing`, not
  // Infinity/NaN; -0 is normalized to 0 so equality stays deterministic.
  if (!Number.isFinite(result)) return undefined;
  return result === 0 ? 0 : result;
}

/**
 * `==` / `!=` are defined for every type pair (typed equality, official "Equal
 * and not equal can be used with any kind of value"). Ordering comparators are
 * defined for number×number, string×string and date×datetime; a comparison with
 * an empty value is stably `false` (DESIGN B6#2: empty is never greater or
 * less); every other pair is a type-mismatch, never a JavaScript coercion.
 */
export function evaluateBaseComparisonOperator(operator, left, right) {
  if (!BASE_EXPRESSION_OPERATORS.comparison.includes(operator)) throw unsupported(`Unsupported comparison operator "${operator}"`);
  if (operator === "==") return baseValuesEqual(left, right);
  if (operator === "!=") return !baseValuesEqual(left, right);
  const a = normalizeBaseValue(left);
  const b = normalizeBaseValue(right);
  if (isMissingOrNull(a.type) || isMissingOrNull(b.type)) return false;
  if (a.type === "number" && b.type === "number") return applyOrdering(operator, a.value, b.value);
  if (a.type === "string" && b.type === "string") return applyOrdering(operator, a.value, b.value);
  if (isDateFamily(a.type) && isDateFamily(b.type)) return applyOrdering(operator, a.value, b.value);
  throw typeMismatch(`Operator "${operator}" cannot compare ${a.type} and ${b.type}`);
}

/**
 * `&&` / `||` return an explicit boolean (official: the operators combine
 * logical values "resulting in a true or false value"), unlike JavaScript's
 * operand-returning short circuit.
 */
export function evaluateBaseLogicalOperator(operator, left, right) {
  if (operator === "&&") return baseValueTruthy(left) && baseValueTruthy(right);
  if (operator === "||") return baseValueTruthy(left) || baseValueTruthy(right);
  throw unsupported(`Unsupported logical operator "${operator}"`);
}
