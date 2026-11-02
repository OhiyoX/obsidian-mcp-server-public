// Portable, fail-closed Bases formula layer for the canonical Base pipeline.
//
// Grammar of one Base formula (INT-A wiring):
//   formula    := file.asLink( expression )
//   expression := the P1-A expression language (app/src/base-expression.js):
//                 literals (number / string / true / false / null), parentheses,
//                 `note.<prop>` and bare frontmatter references, `file.name`,
//                 unary `-` `!`, arithmetic `+ - * / %`, comparison
//                 `== != > < >= <=`, logical `&&` `||`, and `if(cond, a, b)`.
//
// INT-B wires `formula.<name>` references: the whole registry is compiled to
// the P1-B dependency DAG (`app/src/base-formula-dependencies.js`) before any
// record is read, so cycles (including dead branches) and undeclared formulas
// fail closed at compile time, and every formula is evaluated at most once per
// row through that graph's memoized orchestrator.
//
// Deliberately NOT wired (each one fails closed with an explicit error, never a
// silent `undefined`): every `file.*` except `file.name`, date arithmetic,
// member / index access, list and object literals, regular expressions, every
// function except `if`, plugin functions, `this`, and the 2-argument form of
// `if` (P0 required three arguments). Since INT-C a formula property may take
// part in the Base's own `filters` / `sort` (typed value semantics; see
// docs/bases/BASES-FILTER-SORT-SEMANTICS.md) — those call sites live in
// base-query.js. `view.groupBy` is still rejected by
// `assertNoFormulaReferencesInGroupBy` before any record is read.
//
// There is deliberately no eval / Function / vm and no dynamic import. Every
// formula is parsed and validated (including unreachable branches and formulas
// no view references) before any filtering, limit or empty-result short-circuit.
//
// `parseBaseFormula` is the frozen P0 parser (its exact grammar and messages are
// pinned by app/test/workflows.test.js); INT-A keeps it for backward
// compatibility and compiles formulas through the P1-A parser instead.

import {
  BaseExpressionError,
  ERROR_CODE_LIMIT,
  ERROR_CODE_SYNTAX,
  ERROR_CODE_TYPE_MISMATCH,
  ERROR_CODE_UNSUPPORTED,
  parseBaseExpression,
} from "./base-expression.js";
import {
  evaluateBaseBinaryOperator,
  evaluateBaseComparisonOperator,
  evaluateBaseLogicalOperator,
  evaluateBaseUnaryOperator,
  readOwnDataProperty,
} from "./base-values.js";
import {
  BaseFormulaDependencyError,
  createFormulaDependencyRuntime,
} from "./base-formula-dependencies.js";

export const BASE_FORMULA_PROPERTY_PREFIX = "formula.";
const FILE_PROPERTY_PREFIX = "file.";
const FORMULA_SHELL = /^file\.asLink\s*\(/;
// Frozen P0 narrowing: only `file.name` is readable inside a formula.
const ALLOWED_FILE_PROPERTIES = new Set(["name"]);
// The 3-argument form is the only one P0 accepted; `if(c, a)` stays unsupported.
const IF_ARGUMENTS = 3;
const MAX_LEGACY_FORMULA_DEPTH = 20;
const BARE_PROPERTY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class BaseFormulaError extends Error {
  constructor(message, code = ERROR_CODE_UNSUPPORTED, expressionCode = null, causes = []) {
    super(message);
    this.name = "BaseFormulaError";
    // `code` is the canonical code for this layer (see EXPRESSION_CODE_MAP);
    // `expressionCode` preserves the original P1-A code (`syntax`,
    // `unsupported`, `type-mismatch`, `limit`) so nothing is lost when the
    // canonical pipeline folds every formula failure into `unsupported`.
    this.code = code;
    this.expressionCode = expressionCode;
    // INT-B: the verbatim W1-B failure chain of a dependency failure (empty for
    // every other failure). Each cause keeps its own domain code, formula name,
    // message and nested causes; no stack is ever part of it.
    this.causes = Object.freeze(Array.isArray(causes) ? [...causes] : []);
  }
}

// INT-B: W1-B domain failures (`formula_cycle`, `missing_formula`,
// `formula_dependency_failed`, `formula_evaluation_failed`, ...) all become the
// canonical `unsupported` code with the original message and causes preserved.
function mapDependencyError(error) {
  if (error instanceof BaseFormulaDependencyError) {
    return new BaseFormulaError(error.message, ERROR_CODE_UNSUPPORTED, null, error.causes);
  }
  return error;
}

// INT-A error-code mapping, frozen by the review verdict: `syntax` and
// `unsupported` pass through, `type-mismatch` and `limit` (depth overflow)
// become `unsupported` because from a user's point of view those are simply
// type combinations / complexities this subset does not support. The original
// P1-A message is always preserved verbatim.
const EXPRESSION_CODE_MAP = Object.freeze({
  [ERROR_CODE_SYNTAX]: ERROR_CODE_SYNTAX,
  [ERROR_CODE_UNSUPPORTED]: ERROR_CODE_UNSUPPORTED,
  [ERROR_CODE_TYPE_MISMATCH]: ERROR_CODE_UNSUPPORTED,
  [ERROR_CODE_LIMIT]: ERROR_CODE_UNSUPPORTED,
});

export function isFormulaProperty(property) {
  return typeof property === "string" && property.startsWith(BASE_FORMULA_PROPERTY_PREFIX);
}

// ── Failure classes for the Web formula UI (`RECON` §1.4 desktop i18n@119770) ──
//
// Pure, additive diagnostic layer: it only *names* a failure the layer already
// threw, using the frozen fields of `BaseFormulaError` (`code`,
// `expressionCode`, `causes`) and the verbatim message. It never changes which
// formulas are accepted, never re-words a message and never swallows an error;
// `compileBaseFormulas` keeps failing closed exactly as before. The classes are
// the transport-stable names a client can map to a visible message, mirroring
// the desktop `msgError*` keys they are documented against in
// docs/bases/FORMULA-PARITY.md.
export const FORMULA_FAILURE_CLASSES = Object.freeze({
  // desktop msgErrorInfiniteLoop
  INFINITE_LOOP: "formula-infinite-loop",
  // desktop msgErrorInvalidFunction / msgErrorInvalidArrayAccess / msgErrorInvalidObjectAccess
  INVALID_FUNCTION: "formula-invalid-function",
  // desktop msgErrorNotEnoughArguments / msgErrorTooManyArguments
  NOT_ENOUGH_ARGUMENTS: "formula-not-enough-arguments",
  TOO_MANY_ARGUMENTS: "formula-too-many-arguments",
  // desktop msgErrorTypeError
  TYPE_ERROR: "formula-type-error",
  // desktop msgErrorParseFormula
  PARSE: "formula-parse",
  UNSUPPORTED: "formula-unsupported",
});

const FORMULA_NAME_IN_MESSAGE = /^Base formula "([^"]*)"/;
const IF_ARITY = /Expected 3 arguments for "if" but found (\d+)/;
const INVALID_FUNCTION = /Unsupported function "[^"]*"/;
const INVALID_MEMBER_ACCESS = /Unsupported (?:nested )?(?:member|method|field) access/;

function formulaNameOf(message) {
  const match = FORMULA_NAME_IN_MESSAGE.exec(String(message ?? ""));
  return match ? match[1] : null;
}

// Returns `{ code, name }` for a `BaseFormulaError`, or null for anything else.
// Dependency cycles are checked first: their wrapper is `unsupported` with the
// verbatim W1-B causes chain, so the cause code is the only honest signal.
export function classifyFormulaFailure(error) {
  if (!(error instanceof BaseFormulaError)) return null;
  const message = String(error.message ?? "");
  const name = formulaNameOf(message);
  const causes = Array.isArray(error.causes) ? error.causes : [];
  const code = (() => {
    if (causes.some((cause) => cause?.code === "formula_cycle") || /dependency cycle detected/.test(message)) {
      return FORMULA_FAILURE_CLASSES.INFINITE_LOOP;
    }
    const arity = IF_ARITY.exec(message);
    if (arity) {
      return Number(arity[1]) > IF_ARGUMENTS
        ? FORMULA_FAILURE_CLASSES.TOO_MANY_ARGUMENTS
        : FORMULA_FAILURE_CLASSES.NOT_ENOUGH_ARGUMENTS;
    }
    if (INVALID_FUNCTION.test(message) || INVALID_MEMBER_ACCESS.test(message)) return FORMULA_FAILURE_CLASSES.INVALID_FUNCTION;
    if (error.expressionCode === ERROR_CODE_TYPE_MISMATCH) return FORMULA_FAILURE_CLASSES.TYPE_ERROR;
    if (error.expressionCode === ERROR_CODE_SYNTAX) return FORMULA_FAILURE_CLASSES.PARSE;
    return FORMULA_FAILURE_CLASSES.UNSUPPORTED;
  })();
  return Object.freeze({ code, name });
}

function mapExpressionError(error, formulaName) {
  const expressionCode = error instanceof BaseExpressionError ? error.code : ERROR_CODE_UNSUPPORTED;
  const code = EXPRESSION_CODE_MAP[expressionCode] ?? ERROR_CODE_UNSUPPORTED;
  // Keep the P1-A message verbatim (no vague re-wording); the `unsupported`
  // family carries the word so a caller can tell grammar rejection from a
  // malformed expression even without reading `code`.
  const prefix = code === ERROR_CODE_UNSUPPORTED && expressionCode === ERROR_CODE_UNSUPPORTED
    ? `Base formula "${formulaName}" uses unsupported expression: `
    : `Base formula "${formulaName}": `;
  // A code that had to be folded into `unsupported` keeps its own class name at
  // the end of the message (`type-mismatch` / `limit`), so the failure class
  // stays identifiable without re-parsing prose.
  const label = code === ERROR_CODE_UNSUPPORTED && expressionCode !== ERROR_CODE_UNSUPPORTED ? ` (${expressionCode})` : "";
  return new BaseFormulaError(`${prefix}${error.message}${label}`, code, expressionCode);
}

// ── Frozen P0 parser (kept verbatim; pinned by app/test/workflows.test.js) ──

function describeToken(token) {
  if (token.type === "eof") return "end of formula";
  return `"${token.value}"`;
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "(" || character === ")" || character === ",") {
      tokens.push({ type: character, value: character });
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) end += 1;
      tokens.push({ type: "identifier", value: source.slice(index, end) });
      index = end;
      continue;
    }
    throw new BaseFormulaError(`Unexpected character "${character}" at position ${index}`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

export function parseBaseFormula(source) {
  const tokens = tokenize(String(source ?? ""));
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const expect = (type) => {
    const token = peek();
    if (token.type !== type) throw new BaseFormulaError(`Expected "${type}" but found ${describeToken(token)}`);
    return next();
  };

  function parseExpression(depth) {
    if (depth > MAX_LEGACY_FORMULA_DEPTH) throw new BaseFormulaError(`Formula nesting exceeds the maximum depth of ${MAX_LEGACY_FORMULA_DEPTH}`);
    const token = peek();
    if (token.type === "identifier" && token.value === "if") {
      next();
      expect("(");
      const condition = parseExpression(depth + 1);
      expect(",");
      const consequent = parseExpression(depth + 1);
      expect(",");
      const alternate = parseExpression(depth + 1);
      expect(")");
      return { type: "if", condition, consequent, alternate };
    }
    if (token.type === "identifier") {
      next();
      return { type: "reference", name: token.value };
    }
    throw new BaseFormulaError(`Expected a formula expression but found ${describeToken(token)}`);
  }

  const head = peek();
  if (!(head.type === "identifier" && head.value === "file.asLink")) {
    throw new BaseFormulaError('Formula must start with file.asLink(...)');
  }
  next();
  expect("(");
  const argument = parseExpression(1);
  expect(")");
  const trailing = peek();
  if (trailing.type !== "eof") throw new BaseFormulaError(`Unexpected token after formula: ${describeToken(trailing)}`);
  return { type: "asLink", argument };
}

// ── P1-A based compile ──────────────────────────────────────────────────────

// Split `file.asLink( <expression> )` into the inner expression source. The
// shell errors keep the frozen P0 wording (`test/workflows.test.js`).
function splitFormulaShell(source) {
  const trimmed = source.trim();
  const shell = FORMULA_SHELL.exec(trimmed);
  if (!shell) throw new BaseFormulaError('Formula must start with file.asLink(...)');
  if (!trimmed.endsWith(")")) {
    const trailing = trimmed.slice(trimmed.lastIndexOf(")") + 1).trim();
    throw new BaseFormulaError(`Unexpected token after formula: "${trailing}"`);
  }
  return trimmed.slice(shell[0].length, -1);
}

function unsupportedReference(formulaName, node) {
  if (node.namespace === "file") {
    if (ALLOWED_FILE_PROPERTIES.has(node.name)) return null;
    return new BaseFormulaError(
      `Base formula "${formulaName}" uses unsupported file property "${FILE_PROPERTY_PREFIX}${node.name}"`,
    );
  }
  // `formula.<name>` is wired since INT-B: it is validated against the compiled
  // registry (undeclared => missing_formula) and cycle-checked by the DAG, both
  // at compile time, instead of being rejected here.
  return null;
}

// Validate the whole AST, dead branches included, before any record is read.
function assertSupportedNode(node, formulaName) {
  switch (node.type) {
    case "literal":
      return;
    case "reference": {
      const failure = unsupportedReference(formulaName, node);
      if (failure) throw failure;
      if (!BARE_PROPERTY.test(node.name)) {
        throw new BaseFormulaError(`Base formula "${formulaName}" uses unsupported reference "${node.name}"`);
      }
      return;
    }
    case "unary":
      return assertSupportedNode(node.argument, formulaName);
    case "binary":
    case "comparison":
    case "logical":
      assertSupportedNode(node.left, formulaName);
      return assertSupportedNode(node.right, formulaName);
    case "call":
      if (node.args.length !== IF_ARGUMENTS) {
        throw new BaseFormulaError(
          `Base formula "${formulaName}": Expected ${IF_ARGUMENTS} arguments for "if" but found ${node.args.length}`,
        );
      }
      for (const argument of node.args) assertSupportedNode(argument, formulaName);
      return;
    default:
      throw new BaseFormulaError(`Base formula "${formulaName}" contains an unsupported node type "${node.type}"`);
  }
}

function compileFormula(formulaName, source) {
  let expression;
  try {
    expression = parseBaseExpression(splitFormulaShell(source));
  } catch (error) {
    if (error instanceof BaseFormulaError) throw error;
    if (error instanceof BaseExpressionError) throw mapExpressionError(error, formulaName);
    throw error;
  }
  assertSupportedNode(expression, formulaName);
  return Object.freeze({ name: formulaName, source, expression, evaluate: compileNode(expression) });
}

export function compileBaseFormulas(formulas) {
  if (formulas === undefined || formulas === null) return Object.freeze({});
  if (typeof formulas !== "object" || Array.isArray(formulas)) throw new BaseFormulaError("Base formulas must be a mapping of name to expression");
  // 1. parse + validate every formula (dead branches included) before any row.
  const declared = [];
  for (const [name, source] of Object.entries(formulas)) {
    if (typeof source !== "string") throw new BaseFormulaError(`Base formula "${name}" must be a string expression`);
    declared.push(compileFormula(name, source));
  }
  // 2. build the dependency DAG: missing formulas and every cycle class
  //    (self / 2-node / multi-node / dead branch) fail closed right here.
  let runtime;
  try {
    runtime = createFormulaDependencyRuntime(declared);
  } catch (error) {
    throw mapDependencyError(error);
  }
  // 3. publish frozen entries whose `evaluate(record)` resolves through the
  //    graph's per-row memo, so a dependency is never evaluated twice per row.
  //    Null prototype so a formula literally named __proto__ stays an own key.
  const compiled = Object.create(null);
  for (const entry of declared) {
    const name = entry.name;
    compiled[name] = Object.freeze({
      name,
      source: entry.source,
      expression: entry.expression,
      evaluate: (record) => runtime.value(name, record),
    });
  }
  return Object.freeze(compiled);
}

// INT-C (reviewer verdict §3, option B): the guard keeps protecting exactly the
// one position that is still out of scope — `view.groupBy` (grouping is P1-D).
// `filters` / `sort` were released by INT-C and are evaluated with the typed
// value layer instead (base-query.js). The rename makes the guarded range
// explicit: the function name IS its scope.
//
// Only a `groupBy` that actually selects a `formula.<name>` is rejected here;
// any other non-empty `groupBy` is already rejected by the Wave 0-D
// known-semantic-key guard (`views[].groupBy` is not implemented), so this stays
// a defence in depth rather than the only line of protection.
export function assertNoFormulaReferencesInGroupBy(view) {
  const groupBy = view?.groupBy;
  if (!groupBy) return;
  const property = typeof groupBy === "string" ? groupBy : groupBy.property;
  if (isFormulaProperty(property)) throw new BaseFormulaError("Base formulas are not supported in groupBy (out of scope)");
}

export function assertFormulaPropertiesAvailable(order, compiledFormulas) {
  for (const property of Array.isArray(order) ? order : []) {
    if (!isFormulaProperty(property)) continue;
    const name = property.slice(BASE_FORMULA_PROPERTY_PREFIX.length);
    if (!Object.hasOwn(compiledFormulas, name)) throw new BaseFormulaError(`Base view references missing formula "${name}"`);
  }
}

// ── INT-C: formula references inside the Base's own filters / sort ──────────
// Review verdict §4 / contract §S5: a `formula.<name>` in `filters` / `sort`
// uses the P1-A typed value layer (never the P0 `String()` coercion) and
// resolves to the referenced formula's raw value (INT-B ruling).

const FILTER_PROPERTY_TOKEN = /^([A-Za-z_][\w.-]*)/;
const FILTER_COMPARISON = /^([\w.-]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;

export function formulaPropertyName(property) {
  return property.slice(BASE_FORMULA_PROPERTY_PREFIX.length);
}

export function resolveFormulaValue(record, name, formulas) {
  if (!Object.hasOwn(formulas, name)) throw new BaseFormulaError(`Base view references missing formula "${name}"`);
  return formulas[name].evaluate(record);
}

// The property of a `formula.<name> <op> <literal>` condition, or null when the
// condition is not a formula comparison. Only the leading token counts, so a
// literal such as `type == "formula.note"` is never a reference; a
// formula-leading shape outside the grammar falls through to the frozen P0
// evaluator, whose fail-closed "Unsupported Base filter expression" covers it.
export function formulaFilterProperty(expression) {
  const source = String(expression).trim();
  const token = source.match(FILTER_PROPERTY_TOKEN);
  if (!token || !isFormulaProperty(token[1])) return null;
  const match = source.match(FILTER_COMPARISON);
  return match ? match[1] : null;
}

// True only for a filter tree that contains a typed formula comparison, so a
// pure-P0 filter never leaves the frozen `evaluateBaseFilter` path.
export function formulaFilterHasFormula(filter) {
  if (!filter) return false;
  if (typeof filter === "string") return formulaFilterProperty(filter) !== null;
  if (Array.isArray(filter)) return filter.some(formulaFilterHasFormula);
  return Boolean(
    (filter.and && formulaFilterHasFormula(filter.and))
      || (filter.or && formulaFilterHasFormula(filter.or))
      || (filter.not && formulaFilterHasFormula(filter.not)),
  );
}

// P0 filter literal grammar (`workflows.js literal()`), minus the coercion:
// quoted => string, true/false/null typed, numeric => number, else raw string.
export function parseFormulaFilterLiteral(token) {
  const trimmed = String(token).trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  const number = Number(trimmed);
  return Number.isNaN(number) ? trimmed : number;
}

// One `formula.<name> <op> <literal>` condition with the typed comparator. Any
// other shape fails closed, and cross-type ordering throws `type-mismatch`.
export function evaluateFormulaFilterExpression(expression, record, formulas) {
  const source = String(expression).trim();
  const match = source.match(FILTER_COMPARISON);
  if (!match) throw new BaseFormulaError(`Unsupported Base filter expression: ${source}`);
  const left = resolveFormulaValue(record, formulaPropertyName(match[1]), formulas);
  return evaluateBaseComparisonOperator(match[2], left, parseFormulaFilterLiteral(match[3]));
}

export function isFormulaTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function formulaDisplayName(value, fallback) {
  if (typeof value === "string") return value.trim() ? value : fallback;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const joined = value.map((item) => (item === null || item === undefined ? "" : String(item))).join(", ");
    return joined.trim() ? joined : fallback;
  }
  return fallback;
}

function recordBasename(record) {
  if (typeof record.basename === "string" && record.basename.length) return record.basename;
  if (typeof record.path === "string") return record.path.replace(/^.*\//, "").replace(/\.md$/i, "");
  return "";
}

// ── Evaluator (P1-A walker, compiled to closures at compile time) ──────────

// Each node compiles to a plain closure over the record, so a compiled formula
// carries no AST walk, no per-node dispatch and no per-row allocation. Capture
// happens once, per formula.
function compileNode(node) {
  switch (node.type) {
    case "literal": {
      const value = node.value;
      return () => value;
    }
    case "reference": {
      if (node.namespace === "file") return (record) => recordBasename(record);
      const key = node.name;
      // `formula.<name>` reads the already-evaluated dependency value the graph
      // hands over (only successful dependencies ever appear there); a failing
      // dependency short-circuits before this closure is called at all.
      if (node.namespace === "formula") return (record, dependencies) => dependencies[key];
      return (record) => readOwnDataProperty(record.frontmatter, key);
    }
    case "unary": {
      const operand = compileNode(node.argument);
      const operator = node.operator;
      return (record, dependencies) => evaluateBaseUnaryOperator(operator, operand(record, dependencies));
    }
    case "binary": {
      const left = compileNode(node.left);
      const right = compileNode(node.right);
      const operator = node.operator;
      return (record, dependencies) => evaluateBaseBinaryOperator(operator, left(record, dependencies), right(record, dependencies));
    }
    case "comparison": {
      const left = compileNode(node.left);
      const right = compileNode(node.right);
      const operator = node.operator;
      return (record, dependencies) => evaluateBaseComparisonOperator(operator, left(record, dependencies), right(record, dependencies));
    }
    // Both operands are evaluated: the frozen P1-A evaluator takes two values,
    // and && / || return an explicit boolean, so the result stays deterministic.
    case "logical": {
      const left = compileNode(node.left);
      const right = compileNode(node.right);
      const operator = node.operator;
      return (record, dependencies) => evaluateBaseLogicalOperator(operator, left(record, dependencies), right(record, dependencies));
    }
    // Only the selected branch runs, exactly like the P0 evaluator; the compile
    // step guarantees the 3-argument shape.
    case "call": {
      const [condition, consequent, alternate] = node.args.map(compileNode);
      return (record, dependencies) => (
        isFormulaTruthy(condition(record, dependencies))
          ? consequent(record, dependencies)
          : alternate(record, dependencies)
      );
    }
    default:
      throw new BaseFormulaError(`Unsupported node type "${node.type}"`);
  }
}

// Returns a consumable, structured link cell, never the unevaluated source.
export function evaluateBaseFormula(ast, record) {
  if (!ast || typeof ast !== "object" || typeof ast.evaluate !== "function") throw new BaseFormulaError("Base formula must be compiled before evaluation");
  let value;
  try {
    value = ast.evaluate(record);
  } catch (error) {
    if (error instanceof BaseFormulaError) throw error;
    if (error instanceof BaseFormulaDependencyError) throw mapDependencyError(error);
    if (error instanceof BaseExpressionError) throw mapExpressionError(error, ast.name);
    throw error;
  }
  return { path: record.path, displayName: formulaDisplayName(value, recordBasename(record)), kind: "asLink" };
}
