// U12 — additive, read-only projection of a Base's DECLARED filters.
//
// The desktop filter menu draws two sections: `所有视图` (the Base-file-level
// `filters:`) and `当前视图` (the selected view's `filters:`), each with the number of
// conditions in its `.flair` and one condition row per leaf. The Web DTO used to
// expose neither, so the client had no honest count and drew no section at all
// (registered as a not-ported omission in docs/bases/BASES-COMPATIBILITY-MATRIX.md
// §14.5 U12).
//
// This module only PROJECTS what the domain already validated and evaluated:
//   - the tree shape is checked with the existing `assertBaseFilterTree`, so a
//     document this subset cannot read never reaches the DTO half-summarized;
//   - `conjunction` and every `operator` come from the frozen vocabularies;
//   - a string leaf (the `.base` expression dialect, e.g. `file.ext == "md"`) is
//     decoded with the EXISTING expression parser (`parseBaseExpression`) and only
//     when it is a plain `reference <cmp> literal` comparison. Anything else (a call
//     such as `file.inFolder(...)`, a logical chain) keeps `property`/`operator`/
//     `value` null and carries the raw `expression` instead: the DTO never invents
//     a property/operator/value triple it could not read.
//
// Additive only: no existing DTO field changes, `capabilities` is untouched, and a
// caller that ignores `filters` keeps today's behavior byte for byte.
import {
  BASE_FILTER_CONJUNCTIONS,
  BASE_FILTER_OPERATORS,
  assertBaseFilterTree,
} from "./base-query.js";
import { parseBaseExpression } from "./base-expression.js";

// Bare `==`/`!=` map onto the frozen operator vocabulary the builder and the
// override dialect use; the ordering symbols onto their comparison spellings.
const COMPARISON_OPERATORS = Object.freeze({
  "==": "is",
  "!=": "is-not",
  ">": "gt",
  "<": "lt",
  ">=": "gte",
  "<=": "lte",
});

// Bound every string that leaves the server: a filter expression is author text,
// not a document, and the DTO is a UI projection.
const MAX_DTO_TEXT = 240;

function dtoText(value) {
  return typeof value === "string" ? value.slice(0, MAX_DTO_TEXT) : null;
}

function dtoScalar(value) {
  if (typeof value === "string") return value.slice(0, MAX_DTO_TEXT);
  return typeof value === "number" || typeof value === "boolean" ? value : null;
}

function referenceProperty(reference) {
  if (!reference || reference.type !== "reference" || typeof reference.name !== "string") return null;
  // A bare identifier is the documented `note.` shorthand; every other namespace
  // keeps its prefix so the key matches the column key the view declares.
  return reference.namespace === "note" ? reference.name : `${reference.namespace}.${reference.name}`;
}

function literalValue(node) {
  if (!node || node.type !== "literal") return null;
  return node.valueType === "null" ? null : dtoScalar(node.value);
}

function structuredCondition(leaf) {
  return {
    property: dtoText(leaf.key),
    operator: BASE_FILTER_OPERATORS.includes(leaf.op) ? leaf.op : null,
    value: dtoScalar(leaf.value),
    expression: null,
  };
}

function expressionCondition(source) {
  const condition = { property: null, operator: null, value: null, expression: dtoText(source) };
  let ast = null;
  try {
    ast = parseBaseExpression(source);
  } catch {
    // Unsupported / syntax leaf: the raw expression is the honest projection.
    return condition;
  }
  if (ast?.type !== "comparison") return condition;
  const property = referenceProperty(ast.left);
  const operator = COMPARISON_OPERATORS[ast.operator] ?? null;
  if (!property || !operator || !BASE_FILTER_OPERATORS.includes(operator)) return condition;
  return { property, operator, value: literalValue(ast.right), expression: dtoText(source) };
}

function collectLeaves(node, out) {
  if (node === undefined || node === null) return out;
  if (typeof node === "string") {
    out.push(expressionCondition(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectLeaves(item, out);
    return out;
  }
  if (typeof node !== "object") return out;
  const conjunction = BASE_FILTER_CONJUNCTIONS.find((key) => Array.isArray(node[key]));
  if (conjunction) {
    collectLeaves(node[conjunction], out);
    return out;
  }
  // A structured condition leaf (the Web override dialect) is legal only behind
  // `allowConditions`; `assertBaseFilterTree` below decides that, so anything that
  // reaches here with a `key` is already a valid leaf.
  if (typeof node.key === "string") out.push(structuredCondition(node));
  return out;
}

function topLevelConjunction(filter) {
  if (Array.isArray(filter)) return "and"; // the legacy AND list, both dialects
  if (filter && typeof filter === "object") {
    return BASE_FILTER_CONJUNCTIONS.find((key) => Array.isArray(filter[key])) ?? null;
  }
  return null;
}

// One layer (`所有视图` = the Base file, `当前视图` = the selected view):
// `null` means "this layer declares no filters"; a declared-but-empty group is an
// object with `count: 0` (the section exists, its flair stays hidden).
//
// `count` is the number of LEAVES this projection renders as rows. The desktop's own
// flair counter counts the top-level group's direct ENTRIES instead (app.js@2480449
// `e instanceof t$ ? e.filters.length : 1`), where a nested group is one entry; the two
// agree on every flat layer (the owner's anchor) and diverge only for a nested group,
// which is registered in docs/bases/BASES-COMPATIBILITY-MATRIX.md §14.6.1.
export function summarizeBaseFilterLayer(filter, { path = "filters" } = {}) {
  if (filter === undefined || filter === null) return null;
  assertBaseFilterTree(filter, { path });
  const conditions = collectLeaves(filter, []);
  return { conjunction: topLevelConjunction(filter), count: conditions.length, conditions };
}

// The two layers the desktop filter menu draws, in menu order.
export function summarizeBaseFilters({ base, view } = {}) {
  return {
    base: summarizeBaseFilterLayer(base?.filters, { path: "filters" }),
    view: summarizeBaseFilterLayer(view?.filters, { path: `views[${view?.name ?? ""}].filters` }),
  };
}
