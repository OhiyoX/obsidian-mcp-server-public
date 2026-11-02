// P1-A: typed value layer — property resolution, normalization, safe comparison
// and the frozen operator semantics.
//
// Two independent evidence sources are kept in sync on purpose:
//   1. `test/fixtures/bases-grammar/08-values-cross-type.corpus.json` — curated,
//      official-anchored cells (see `docs/bases/BASES-GRAMMAR-CORPUS.md` §7);
//   2. `CROSS_TYPE_MATRIX` below — the rule table that is expanded over every
//      ordered pair of the ten frozen value types and every operator, so no cell
//      is "we will see in the code later".
// A consistency test replays every corpus operator case through the rule table
// and asserts both agree, so the curated corpus and the exhaustive grid cannot
// drift apart. Error codes are asserted by exact value.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BASE_EXPRESSION_OPERATORS,
  BaseExpressionError,
  ERROR_CODE_TYPE_MISMATCH,
  ERROR_CODE_UNSUPPORTED,
} from "../src/base-expression.js";
import {
  baseValueTruthy,
  baseValueType,
  baseValuesEqual,
  compareBaseValues,
  DEFERRED_FILE_PROPERTY_KEYS,
  evaluateBaseBinaryOperator,
  evaluateBaseComparisonOperator,
  evaluateBaseLogicalOperator,
  evaluateBaseUnaryOperator,
  FILE_PROPERTY_KEYS,
  isBaseValueEmpty,
  normalizeBaseValue,
  PLANNED_VALUE_TYPES,
  readOwnDataProperty,
  resolveBaseProperty,
  SUPPORTED_VALUE_TYPES,
  VALUE_TYPES,
} from "../src/base-values.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, "fixtures", "bases-grammar");
const SOURCE_ROOT = path.join(HERE, "..", "src");
const CORPUS_FILE = "08-values-cross-type.corpus.json";
const CORPUS_CASE_COUNT = 138;
const DISPOSITIONS = new Set(["permanent", "P1-C", "P1-B/INT-B", "P1-F"]);
const DATE_FAMILY = new Set(["date", "datetime"]);
const EMPTY_TYPES = new Set(["missing", "null"]);

function decodeFixtureValue(value) {
  if (Array.isArray(value)) return value.map(decodeFixtureValue);
  if (value === null || typeof value !== "object") return value;
  if (value.$missing === true) return undefined;
  if (typeof value.$number === "string") {
    if (value.$number === "NaN") return NaN;
    if (value.$number === "-0") return -0;
    if (value.$number === "Infinity") return Infinity;
    if (value.$number === "-Infinity") return -Infinity;
  }
  if (typeof value.$date === "string") return new Date(value.$date);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeFixtureValue(item)]));
}

async function loadCorpus() {
  return JSON.parse(await fs.readFile(path.join(FIXTURE_ROOT, CORPUS_FILE), "utf8"));
}

function runCorpusCase(entry, record) {
  const options = Object.hasOwn(entry, "formulaValues") ? { formulaValues: decodeFixtureValue(entry.formulaValues) } : {};
  switch (entry.call) {
    case "normalize":
      return normalizeBaseValue(decodeFixtureValue(entry.value));
    case "empty":
      return { type: "boolean", value: isBaseValueEmpty(decodeFixtureValue(entry.value)) };
    case "equal":
      return { type: "boolean", value: baseValuesEqual(decodeFixtureValue(entry.left), decodeFixtureValue(entry.right)) };
    case "compare":
      return { type: "number", value: compareBaseValues(decodeFixtureValue(entry.left), decodeFixtureValue(entry.right)) };
    case "arithmetic":
      return normalizeBaseValue(evaluateBaseBinaryOperator(entry.operator, decodeFixtureValue(entry.left), decodeFixtureValue(entry.right)));
    case "comparison":
      return { type: "boolean", value: evaluateBaseComparisonOperator(entry.operator, decodeFixtureValue(entry.left), decodeFixtureValue(entry.right)) };
    case "logical":
      return { type: "boolean", value: evaluateBaseLogicalOperator(entry.operator, decodeFixtureValue(entry.left), decodeFixtureValue(entry.right)) };
    case "unary":
      return normalizeBaseValue(evaluateBaseUnaryOperator(entry.operator, decodeFixtureValue(entry.operand)));
    case "resolve":
      return resolveBaseProperty(record, entry.reference, options);
    default:
      throw new Error(`corpus case ${entry.id}: unknown call ${entry.call}`);
  }
}

// ── The full cross-type rule table (docs/bases/BASES-GRAMMAR-CORPUS.md §7) ───
//
// Every rule is intentional and documented. There is no implicit JS coercion
// anywhere: `"5" + 3` is a type-mismatch, `1 == "1"` is false, and an
// unsupported (but official) combination is `unsupported`, not a guess.
function ruleForArithmetic(operator, left, right, values = {}) {
  const dateOperand = DATE_FAMILY.has(left) || DATE_FAMILY.has(right);
  if (dateOperand && (operator === "+" || operator === "-")) return { outcome: "reject", code: ERROR_CODE_UNSUPPORTED };
  // DESIGN B6#3: a non-finite result (divide/modulo by zero) is `missing`.
  if ((operator === "/" || operator === "%") && left === "number" && right === "number" && values.right === 0) {
    return { outcome: "accept", type: "missing" };
  }
  if (left === "number" && right === "number") return { outcome: "accept", type: "number" };
  if (operator === "+" && left === "string" && right === "string") return { outcome: "accept", type: "string" };
  return { outcome: "reject", code: ERROR_CODE_TYPE_MISMATCH };
}

function ruleForComparison(operator, left, right) {
  if (operator === "==" || operator === "!=") return { outcome: "accept", type: "boolean" };
  if (EMPTY_TYPES.has(left) || EMPTY_TYPES.has(right)) return { outcome: "accept", type: "boolean" };
  if (left === "number" && right === "number") return { outcome: "accept", type: "boolean" };
  if (left === "string" && right === "string") return { outcome: "accept", type: "boolean" };
  if (DATE_FAMILY.has(left) && DATE_FAMILY.has(right)) return { outcome: "accept", type: "boolean" };
  return { outcome: "reject", code: ERROR_CODE_TYPE_MISMATCH };
}

function ruleForUnary(operator, operand) {
  if (operator === "!") return { outcome: "accept", type: "boolean" };
  if (operand === "number") return { outcome: "accept", type: "number" };
  return { outcome: "reject", code: ERROR_CODE_TYPE_MISMATCH };
}

const MATRIX_SAMPLES = Object.freeze([
  ["missing", undefined],
  ["null", null],
  ["boolean", true],
  ["number", 5],
  ["string", "s"],
  ["date", "2025-01-02"],
  ["datetime", "2025-01-02T03:04:05Z"],
  ["list", [1]],
  ["object", { a: 1 }],
  ["link", { kind: "asLink", path: "A.md" }],
]);

function runForRule(call, operator, left, right) {
  try {
    if (call === "arithmetic") return { outcome: "accept", value: normalizeBaseValue(evaluateBaseBinaryOperator(operator, left, right)) };
    if (call === "comparison") return { outcome: "accept", value: normalizeBaseValue(evaluateBaseComparisonOperator(operator, left, right)) };
    if (call === "logical") return { outcome: "accept", value: normalizeBaseValue(evaluateBaseLogicalOperator(operator, left, right)) };
    if (call === "unary") return { outcome: "accept", value: normalizeBaseValue(evaluateBaseUnaryOperator(operator, left)) };
    throw new Error(`unsupported call ${call}`);
  } catch (error) {
    return { outcome: "reject", code: error.code };
  }
}

test("values corpus manifest is well formed and frozen", async () => {
  const corpus = await loadCorpus();
  assert.equal(corpus.target, "base-values");
  assert.ok(corpus.anchors.length >= 6, "the matrix must carry its official anchors");
  assert.ok(corpus.record && typeof corpus.record === "object", "resolve cases need the shared record");
  assert.equal(corpus.cases.length, CORPUS_CASE_COUNT, "values corpus case count changed");
  const ids = new Set();
  const calls = new Set();
  for (const entry of corpus.cases) {
    assert.ok(!ids.has(entry.id), `duplicate case id ${entry.id}`);
    ids.add(entry.id);
    calls.add(entry.call);
    assert.ok(["accept", "reject"].includes(entry.outcome), `${entry.id}: outcome`);
    assert.ok(typeof entry.note === "string" && entry.note.length > 0, `${entry.id}: note`);
    if (entry.outcome === "accept") {
      assert.ok(entry.result && typeof entry.result.type === "string", `${entry.id}: accept needs result.type`);
    } else {
      assert.ok([ERROR_CODE_TYPE_MISMATCH, ERROR_CODE_UNSUPPORTED].includes(entry.code), `${entry.id}: exact code`);
      assert.equal(typeof entry.messageTemplate, "string", `${entry.id}: messageTemplate`);
      if (entry.code === ERROR_CODE_UNSUPPORTED) assert.ok(DISPOSITIONS.has(entry.disposition), `${entry.id}: disposition`);
    }
  }
  assert.deepEqual([...calls].sort(), ["arithmetic", "compare", "comparison", "empty", "equal", "logical", "normalize", "resolve", "unary"]);
});

test("values corpus: every case reproduces exactly", async () => {
  const corpus = await loadCorpus();
  let accepted = 0;
  let rejected = 0;
  for (const entry of corpus.cases) {
    if (entry.outcome === "accept") {
      accepted += 1;
      const actual = runCorpusCase(entry, corpus.record);
      assert.equal(actual.type, entry.result.type, `${entry.id}: result type`);
      if (Object.hasOwn(entry.result, "value")) assert.deepStrictEqual(actual.value, entry.result.value, `${entry.id}: result value`);
      continue;
    }
    rejected += 1;
    let thrown;
    try {
      runCorpusCase(entry, corpus.record);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof BaseExpressionError, `${entry.id}: expected a BaseExpressionError`);
    assert.equal(thrown.code, entry.code, `${entry.id}: code must match exactly`);
    assert.equal(thrown.message, entry.messageTemplate, `${entry.id}: message must match the frozen template`);
  }
  assert.equal(accepted + rejected, CORPUS_CASE_COUNT);
  assert.ok(rejected >= 25, "corpus must keep a substantial reject set");
});

test("cross-type matrix: every ordered type pair x operator is decided by the rule table", () => {
  let cells = 0;
  for (const operator of BASE_EXPRESSION_OPERATORS.arithmetic) {
    for (const [leftName, left] of MATRIX_SAMPLES) {
      for (const [rightName, right] of MATRIX_SAMPLES) {
        const expected = ruleForArithmetic(operator, leftName, rightName, { left, right });
        const actual = runForRule("arithmetic", operator, left, right);
        assert.equal(actual.outcome, expected.outcome, `"${leftName}" ${operator} "${rightName}"`);
        if (expected.outcome === "accept") assert.equal(actual.value.type, expected.type, `"${leftName}" ${operator} "${rightName}"`);
        else assert.equal(actual.code, expected.code, `"${leftName}" ${operator} "${rightName}"`);
        cells += 1;
      }
    }
  }
  for (const operator of BASE_EXPRESSION_OPERATORS.comparison) {
    for (const [leftName, left] of MATRIX_SAMPLES) {
      for (const [rightName, right] of MATRIX_SAMPLES) {
        const expected = ruleForComparison(operator, leftName, rightName);
        const actual = runForRule("comparison", operator, left, right);
        assert.equal(actual.outcome, expected.outcome, `"${leftName}" ${operator} "${rightName}"`);
        if (expected.outcome === "accept") assert.equal(actual.value.type, "boolean");
        else assert.equal(actual.code, ERROR_CODE_TYPE_MISMATCH);
        cells += 1;
      }
    }
  }
  for (const operator of BASE_EXPRESSION_OPERATORS.logical) {
    for (const [leftName, left] of MATRIX_SAMPLES) {
      for (const [rightName, right] of MATRIX_SAMPLES) {
        const actual = runForRule("logical", operator, left, right);
        assert.equal(actual.outcome, "accept", `"${leftName}" ${operator} "${rightName}"`);
        assert.equal(actual.value.type, "boolean", "logical operators always return an explicit boolean");
        cells += 1;
      }
    }
  }
  for (const operator of BASE_EXPRESSION_OPERATORS.unary) {
    for (const [name, sample] of MATRIX_SAMPLES) {
      const expected = ruleForUnary(operator, name);
      const actual = runForRule("unary", operator, sample);
      assert.equal(actual.outcome, expected.outcome, `${operator}"${name}"`);
      if (expected.outcome === "accept") assert.equal(actual.value.type, expected.type, `${operator}"${name}"`);
      cells += 1;
    }
  }
  // 5 arithmetic + 6 comparison operators over 100 ordered pairs, plus 2 logical
  // operators over 100 pairs, plus 2 unary operators over 10 samples.
  assert.equal(cells, 11 * 100 + 2 * 100 + 2 * 10);
});

test("cross-type matrix and the curated corpus agree cell by cell", async () => {
  const corpus = await loadCorpus();
  const operatorCalls = new Set(["arithmetic", "comparison", "logical", "unary"]);
  let checked = 0;
  for (const entry of corpus.cases) {
    if (!operatorCalls.has(entry.call)) continue;
    const left = decodeFixtureValue(entry.left ?? entry.operand);
    const right = decodeFixtureValue(entry.right);
    const leftName = baseValueType(left);
    const rightName = baseValueType(right);
    const expected = entry.call === "arithmetic"
      ? ruleForArithmetic(entry.operator, leftName, rightName, { left, right })
      : entry.call === "comparison"
        ? ruleForComparison(entry.operator, leftName, rightName)
        : entry.call === "unary"
          ? ruleForUnary(entry.operator, leftName)
          : { outcome: "accept", type: "boolean" };
    assert.equal(expected.outcome, entry.outcome, `${entry.id}: rule table vs corpus outcome`);
    if (entry.outcome === "reject") assert.equal(expected.code, entry.code, `${entry.id}: rule table vs corpus code`);
    else assert.equal(expected.type, entry.result.type, `${entry.id}: rule table vs corpus result type`);
    checked += 1;
  }
  assert.ok(checked >= 45, "the corpus must exercise a substantial part of the grid");
});

test("frozen type vocabulary and property tables", () => {
  assert.deepEqual(SUPPORTED_VALUE_TYPES, ["missing", "null", "boolean", "number", "string", "date", "datetime", "list", "object", "link"]);
  assert.deepEqual(PLANNED_VALUE_TYPES, ["duration", "regex", "image", "file", "html", "icon"]);
  assert.deepEqual(VALUE_TYPES, [...SUPPORTED_VALUE_TYPES, ...PLANNED_VALUE_TYPES]);
  assert.equal(new Set(VALUE_TYPES).size, VALUE_TYPES.length, "type names must stay unique");
  assert.deepEqual(FILE_PROPERTY_KEYS, ["name", "basename", "path", "folder", "ext", "size", "ctime", "mtime", "tags", "links"]);
  assert.deepEqual(DEFERRED_FILE_PROPERTY_KEYS, ["backlinks", "embeds", "properties", "file"]);
  for (const value of [SUPPORTED_VALUE_TYPES, PLANNED_VALUE_TYPES, VALUE_TYPES, FILE_PROPERTY_KEYS, DEFERRED_FILE_PROPERTY_KEYS]) {
    assert.equal(Object.isFrozen(value), true);
  }
  // Every declared plan/deferred type is classified as something concrete today:
  // a duration string is a string, a regex is never a value, and so on.
  assert.equal(baseValueType("1d"), "string");
  assert.equal(baseValueType({ kind: "asLink", path: "A.md" }), "link");
});

test("property resolution: file mapping, missing keys, formula resolver contract", () => {
  const record = {
    path: "Folder/Note.md",
    basename: "Note",
    frontmatter: { price: 3, empty: "", zero: 0, flag: false },
    tags: ["work"],
    links: [{ target: "Other" }],
    stat: { size: 12, created: "2025-01-01T00:00:00Z", modified: "2025-02-01T00:00:00Z" },
  };
  assert.deepEqual(resolveBaseProperty(record, "price"), { type: "number", value: 3 });
  assert.deepEqual(resolveBaseProperty(record, "note.price"), { type: "number", value: 3 });
  assert.deepEqual(resolveBaseProperty(record, "ghost"), { type: "missing", value: undefined });
  assert.deepEqual(resolveBaseProperty(record, "empty"), { type: "string", value: "" });
  assert.deepEqual(resolveBaseProperty(record, "zero"), { type: "number", value: 0 });
  assert.deepEqual(resolveBaseProperty(record, "file.basename"), { type: "string", value: "Note" });
  assert.deepEqual(resolveBaseProperty(record, "file.folder"), { type: "string", value: "Folder" });
  assert.deepEqual(resolveBaseProperty(record, "file.size"), { type: "number", value: 12 });
  assert.deepEqual(resolveBaseProperty(record, "file.links"), { type: "list", value: ["Other"] });
  assert.deepEqual(resolveBaseProperty({ path: "Top.md", frontmatter: {} }, "file.folder"), { type: "string", value: "" });

  for (const reference of ["file.backlinks", "file.embeds", "file.properties", "file.zzz"]) {
    assert.throws(() => resolveBaseProperty(record, reference), (error) => error.code === ERROR_CODE_UNSUPPORTED);
  }
  assert.throws(() => resolveBaseProperty(record, "formula.ppu"), (error) => error.code === ERROR_CODE_UNSUPPORTED);
  assert.deepEqual(resolveBaseProperty(record, "formula.ppu", { formulaValues: { ppu: 4 } }), { type: "number", value: 4 });
  assert.throws(
    () => resolveBaseProperty(record, "formula.ghost", { formulaValues: { ppu: 4 } }),
    (error) => error.code === ERROR_CODE_UNSUPPORTED,
  );
  assert.throws(() => resolveBaseProperty(record, "this.file.folder"), (error) => error.code === ERROR_CODE_UNSUPPORTED);
});

test("hostile keys, accessors and inherited properties are never executed", () => {
  assert.equal(readOwnDataProperty(undefined, "x"), undefined);
  assert.equal(readOwnDataProperty("string", "length"), undefined, "primitives are not objects");
  const accessor = {};
  Object.defineProperty(accessor, "evil", {
    enumerable: true,
    get() {
      throw new Error("accessor executed");
    },
  });
  assert.equal(readOwnDataProperty(accessor, "evil"), undefined);
  assert.equal(readOwnDataProperty({}, "constructor"), undefined, "inherited constructor is not own data");
  assert.equal(readOwnDataProperty({}, "__proto__"), undefined);

  const record = { frontmatter: {}, path: "A.md", basename: "A" };
  assert.deepEqual(resolveBaseProperty(record, "__proto__"), { type: "missing", value: undefined });
  assert.deepEqual(resolveBaseProperty(record, "constructor"), { type: "missing", value: undefined });
  assert.deepEqual(resolveBaseProperty(record, "toString"), { type: "missing", value: undefined });
  assert.equal(Object.prototype.polluted, undefined, "no prototype pollution");

  const withOwnProtoKey = { frontmatter: {} };
  Object.defineProperty(withOwnProtoKey.frontmatter, "__proto__", { value: 7, enumerable: true, configurable: true });
  assert.deepEqual(resolveBaseProperty(withOwnProtoKey, "__proto__"), { type: "number", value: 7 }, "own data for a hostile name is still plain data");
  assert.equal(Object.prototype.polluted, undefined);

  const frontmatterAccessor = {};
  Object.defineProperty(frontmatterAccessor, "frontmatter", {
    get() {
      throw new Error("accessor executed");
    },
  });
  assert.deepEqual(resolveBaseProperty(frontmatterAccessor, "price"), { type: "missing", value: undefined });

  const throwingStat = { frontmatter: {}, stat: {} };
  Object.defineProperty(throwingStat, "stat", {
    get() {
      throw new Error("accessor executed");
    },
  });
  assert.deepEqual(resolveBaseProperty(throwingStat, "file.size"), { type: "missing", value: undefined });

  const hostileLink = {};
  Object.defineProperty(hostileLink, "target", {
    get() {
      throw new Error("accessor executed");
    },
  });
  assert.deepEqual(resolveBaseProperty({ frontmatter: {}, links: [hostileLink] }, "file.links"), { type: "list", value: [undefined] });
});

test("typed equality and comparison are deterministic total orders", () => {
  const samples = [undefined, null, false, true, -3, 0, 5, "A", "a", "b", "2025-01-02", "2025-01-03", [1], [1, 2], { a: 1 }, { b: 2 }, { kind: "asLink", path: "A.md" }];
  for (const left of samples) {
    assert.equal(compareBaseValues(left, left), 0, "self comparison");
    for (const right of samples) {
      const forward = compareBaseValues(left, right);
      const backward = compareBaseValues(right, left);
      assert.ok([-1, 0, 1].includes(forward), "comparator must never return NaN");
      assert.ok(forward === -backward, "antisymmetry");
      assert.equal(baseValuesEqual(left, right), forward === 0, "equality agrees with the comparator");
    }
  }
  for (const a of samples) {
    for (const b of samples) {
      for (const c of samples) {
        if (compareBaseValues(a, b) <= 0 && compareBaseValues(b, c) <= 0) assert.ok(compareBaseValues(a, c) <= 0, "transitivity");
      }
    }
  }
  // Sorting is stable and puts the empty values first (DESIGN B6#2 / B7).
  // `undefined` is excluded because Array.prototype.sort moves it to the end by
  // specification (it never reaches the comparator); `compareBaseValues` itself
  // is still exercised on it by the loops above.
  const sortable = samples.filter((value) => value !== undefined);
  const sorted = [...sortable].reverse().sort(compareBaseValues);
  assert.deepStrictEqual(sorted[0], null, "the empty value sorts first");
  assert.deepStrictEqual([...sorted].sort(compareBaseValues), sorted, "sort is idempotent");
  for (const value of sortable) assert.ok(compareBaseValues(undefined, value) <= 0, "missing is never greater than a present value");
  assert.equal(compareBaseValues(undefined, null), 0, "missing and null are one value");
});

test("operator errors are typed, deterministic and leak-free", () => {
  const expected = [
    [() => evaluateBaseBinaryOperator("+", "5", 3), ERROR_CODE_TYPE_MISMATCH, 'Operator "+" requires two numbers or two strings but found string and number'],
    [() => evaluateBaseBinaryOperator("-", "a", "b"), ERROR_CODE_TYPE_MISMATCH, 'Operator "-" requires two numbers but found string and string'],
    [() => evaluateBaseBinaryOperator("+", "2025-01-02", "1d"), ERROR_CODE_UNSUPPORTED, 'Unsupported date arithmetic ("+" with a date value): durations need the injected clock contract (P1-C)'],
    [() => evaluateBaseComparisonOperator(">", "5", 3), ERROR_CODE_TYPE_MISMATCH, 'Operator ">" cannot compare string and number'],
    [() => evaluateBaseUnaryOperator("-", "5"), ERROR_CODE_TYPE_MISMATCH, 'Unary "-" requires a number but found string'],
    [() => evaluateBaseLogicalOperator("^", true, false), ERROR_CODE_UNSUPPORTED, 'Unsupported logical operator "^"'],
    [() => evaluateBaseBinaryOperator("**", 2, 3), ERROR_CODE_UNSUPPORTED, 'Unsupported arithmetic operator "**"'],
  ];
  for (const [run, code, message] of expected) {
    let thrown;
    try {
      run();
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof BaseExpressionError, message);
    assert.equal(thrown.code, code);
    assert.equal(thrown.message, message);
    assert.equal(thrown.stack, `BaseExpressionError: ${message}`);
    assert.equal(thrown.stack.split("\n").length, 1);
    assert.doesNotMatch(thrown.stack, /[A-Za-z]:[\\/]|file:\/\/|node:internal/);
    assert.ok(!JSON.stringify(thrown).includes("stack"));
  }
});

test("truthiness is the single P0 implementation, reused not duplicated", () => {
  assert.equal(baseValueTruthy(undefined), false);
  assert.equal(baseValueTruthy(null), false);
  assert.equal(baseValueTruthy(""), false);
  assert.equal(baseValueTruthy(" "), false);
  assert.equal(baseValueTruthy("x"), true);
  assert.equal(baseValueTruthy(0), false);
  assert.equal(baseValueTruthy(Number.NaN), false);
  assert.equal(baseValueTruthy(1), true);
  assert.equal(baseValueTruthy(false), false);
  assert.equal(baseValueTruthy(true), true);
  assert.equal(baseValueTruthy([]), false);
  assert.equal(baseValueTruthy([0]), true);
  assert.equal(baseValueTruthy({}), true);
});

test("value module source stays pure: no fs/path/express/MCP imports, no dynamic execution", async () => {
  const allowedSpecifiers = new Set(["./base-expression.js", "./base-formulas.js"]);
  for (const file of ["base-expression.js", "base-values.js"]) {
    const source = await fs.readFile(path.join(SOURCE_ROOT, file), "utf8");
    for (const match of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      assert.ok(allowedSpecifiers.has(match[1]), `${file}: unexpected import ${match[1]}`);
    }
    assert.doesNotMatch(source, /\beval\s*\(/);
    assert.doesNotMatch(source, /new\s+Function\s*\(/);
    assert.doesNotMatch(source, /\bvm\.|child_process|createRequire/);
    assert.doesNotMatch(source, /\bimport\s*\(/);
    assert.doesNotMatch(source, /\brequire\s*\(/);
  }
});
