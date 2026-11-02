// Focused model tests for the P1-B formula dependency graph.
//
// Purely local: no vault, no HTTP, no MCP, no base-formulas/base-query wiring.
// The P1-A parser is replaced by a stub extractor that reads `formula.<name>`
// tokens, and evaluation is a stub that sums its resolved dependencies. That
// keeps this suite pinning only graph / cycle / memoization / error
// propagation behaviour (see `docs/bases/BASES-FORMULA-GRAPH.md`).

import assert from "node:assert/strict";
import test from "node:test";

import {
  BaseFormulaGraphError,
  FORMULA_EVALUATION_ERROR_CODES,
  FORMULA_GRAPH_DIAGNOSTIC_CODES,
  FORMULA_GRAPH_ERROR_CODES,
  buildFormulaDependencyGraph,
  createFormulaRowEvaluator,
  evaluateFormulaRow,
} from "../src/base-formula-graph.js";

// Stub P1-A seam: returns BARE formula names (the `formula.` prefix is the
// parser's business, not the graph's).
function extractReferences(expression) {
  return [...String(expression).matchAll(/formula\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
}

// Stub evaluator. Leaf expression (`"3"`) -> 3. Dependent expression ->
// sum(values of referenced deps) + number of deps, so chains grow and diamond
// reuse is observable. `failOn` throws for the named formulas.
function countingEvaluator(calls, { failOn = [] } = {}) {
  const failing = new Set(failOn);
  return ({ name, expression, dependencies }) => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    if (failing.has(name)) throw new Error(`${name} exploded`);
    const refs = extractReferences(String(expression));
    if (!refs.length) return Number(expression);
    return refs.reduce((total, ref) => total + dependencies[ref], refs.length);
  };
}

function graphOf(formulas, extractor = extractReferences) {
  return buildFormulaDependencyGraph({ formulas, extractReferences: extractor });
}

function captureError(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail("expected a BaseFormulaGraphError to be thrown");
}

// --- compile: graph shape ---------------------------------------------------

test("compile: single, chain and diamond dependencies yield a dependency-first order", () => {
  const graph = graphOf({ d: "formula.a formula.c", c: "formula.b", b: "formula.a", a: "1" });
  assert.deepEqual(graph.names, ["d", "c", "b", "a"]);
  assert.deepEqual(graph.order, ["a", "b", "c", "d"]);
  assert.deepEqual([...graph.dependencies.d], ["a", "c"]);
  assert.deepEqual(graph.dependents.a, ["d", "b"]);
  assert.deepEqual(graph.diagnostics.map((entry) => entry.formula), ["d"]);
  assert.equal(graph.has("d"), true);
  assert.equal(graph.has("missing"), false);
});

test("compile: graph records are frozen, null-prototype containers", () => {
  const graph = graphOf({ ["__proto__"]: "1", b: "formula.__proto__" });
  assert.equal(Object.isFrozen(graph), true);
  assert.equal(Object.getPrototypeOf(graph.expressions), null);
  assert.equal(Object.getPrototypeOf(graph.dependencies), null);
  assert.equal(Object.getPrototypeOf(graph.dependents), null);
  assert.equal(graph.has("__proto__"), true);
  assert.equal(graph.expressions["__proto__"], "1");
  assert.deepEqual([...graph.dependencies.b], ["__proto__"]);
  assert.deepEqual(graph.order, ["__proto__", "b"]);
  assert.equal(Object.isFrozen(graph.dependencies.b), true);
});

test("compile: prototype-named formulas stay own keys", () => {
  const graph = graphOf({ constructor: "1", toString: "formula.constructor" });
  assert.deepEqual(graph.order, ["constructor", "toString"]);
  assert.equal(graph.has("constructor"), true);
  assert.equal(graph.has("hasOwnProperty"), false);
});

test("compile: duplicate declarations fail closed with a deterministic code and text", () => {
  const error = captureError(() => graphOf([["a", "1"], ["a", "2"]]));
  assert.ok(error instanceof BaseFormulaGraphError);
  assert.equal(error.code, FORMULA_GRAPH_ERROR_CODES.DUPLICATE_FORMULA);
  assert.equal(error.message, 'Base formula "a" is declared more than once');
});

test("compile: missing formula references fail closed with a deterministic code and text", () => {
  const error = captureError(() => graphOf({ a: "formula.ghost" }));
  assert.equal(error.code, FORMULA_GRAPH_ERROR_CODES.MISSING_FORMULA);
  assert.equal(error.message, 'Base formula "a" references undeclared formula "ghost"');
});

test("compile: invalid formulas containers and extractors fail closed", () => {
  assert.equal(captureError(() => buildFormulaDependencyGraph({})).code, FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT);
  assert.equal(captureError(() => graphOf(42)).code, FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT);
  assert.equal(captureError(() => graphOf({ a: undefined })).code, FORMULA_GRAPH_ERROR_CODES.INVALID_FORMULA_EXPRESSION);
  assert.equal(captureError(() => graphOf({ "": "1" })).code, FORMULA_GRAPH_ERROR_CODES.INVALID_FORMULA_NAME);
});

test("compile: an undefined formulas mapping is an empty graph", () => {
  const graph = buildFormulaDependencyGraph({ extractReferences });
  assert.deepEqual(graph.names, []);
  assert.deepEqual(graph.order, []);
  const result = evaluateFormulaRow(graph, {}, () => {
    throw new Error("must not be called");
  });
  assert.deepEqual([result.ok, result.evaluated, result.errors], [true, [], []]);
});

test("compile: reference extractor output is validated", () => {
  assert.equal(captureError(() => graphOf({ a: "1" }, () => "b")).code, FORMULA_GRAPH_ERROR_CODES.INVALID_REFERENCE);
  assert.equal(captureError(() => graphOf({ a: "1" }, () => [7])).code, FORMULA_GRAPH_ERROR_CODES.INVALID_REFERENCE);
  assert.equal(captureError(() => graphOf({ a: "1" }, () => [""])).code, FORMULA_GRAPH_ERROR_CODES.INVALID_REFERENCE);
  const error = captureError(() => graphOf({ a: "1" }, () => ["b", 2]));
  assert.equal(error.code, FORMULA_GRAPH_ERROR_CODES.INVALID_REFERENCE);
  assert.equal(error.message, 'Reference extractor returned an invalid formula name at index 1 for base formula "a"');
});

test("compile: duplicate references are de-duplicated in first-seen order", () => {
  const graph = graphOf({ a: "1", b: "formula.a formula.a formula.a" });
  assert.deepEqual([...graph.dependencies.b], ["a"]);
  assert.deepEqual(graph.dependents.a, ["b"]);
});

test("compile: a throwing extractor surfaces expression_error without a stack", () => {
  const error = captureError(() => graphOf({ a: "boom" }, () => {
    const thrown = new Error("parse exploded");
    thrown.stack = "STACK-SENTINEL";
    throw thrown;
  }));
  assert.equal(error.code, FORMULA_GRAPH_ERROR_CODES.EXPRESSION_ERROR);
  assert.equal(error.message, 'Base formula "a" could not be analyzed for references: parse exploded');
  assert.equal(error.message.includes("STACK-SENTINEL"), false);
});

test("compile: accessor properties are rejected without being invoked", () => {
  let reads = 0;
  const formulas = { a: "1" };
  Object.defineProperty(formulas, "b", { enumerable: true, configurable: true, get() { reads += 1; return "formula.a"; } });
  const error = captureError(() => graphOf(formulas));
  assert.equal(error.code, FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT);
  assert.equal(error.message, 'Base formula "b" must be a data property, not an accessor');
  assert.equal(reads, 0);
});

// --- compile: cycles (self / 2-node / 3+ / dead branch) ---------------------

test("compile: self cycle fails closed with the exact cycle path", () => {
  const error = captureError(() => graphOf({ a: "formula.a" }));
  assert.equal(error.code, FORMULA_GRAPH_ERROR_CODES.FORMULA_CYCLE);
  assert.equal(error.message, "Base formula dependency cycle detected: a -> a");
});

test("compile: 2-node cycle fails closed with the exact cycle path", () => {
  const error = captureError(() => graphOf({ a: "formula.b", b: "formula.a" }));
  assert.equal(error.code, FORMULA_GRAPH_ERROR_CODES.FORMULA_CYCLE);
  assert.equal(error.message, "Base formula dependency cycle detected: a -> b -> a");
});

test("compile: 3-node cycle fails closed with the exact cycle path", () => {
  const error = captureError(() => graphOf({ a: "formula.b", b: "formula.c", c: "formula.a" }));
  assert.equal(error.code, FORMULA_GRAPH_ERROR_CODES.FORMULA_CYCLE);
  assert.equal(error.message, "Base formula dependency cycle detected: a -> b -> c -> a");
});

test("compile: a cycle inside an unused dead branch fails closed", () => {
  const error = captureError(() => graphOf({ used: "1", orphan: "formula.loop", loop: "formula.orphan" }));
  assert.equal(error.code, FORMULA_GRAPH_ERROR_CODES.FORMULA_CYCLE);
  assert.equal(error.message, "Base formula dependency cycle detected: orphan -> loop -> orphan");
});

test("compile: cycle messages share one stable template", () => {
  const template = /^Base formula dependency cycle detected: [^ ]+(?: -> [^ ]+)+$/;
  for (const formulas of [{ a: "formula.a" }, { a: "formula.b", b: "formula.a" }, { x: "formula.y", y: "formula.z", z: "formula.x" }]) {
    const error = captureError(() => graphOf(formulas));
    assert.match(error.message, template);
  }
});

test("compile: formulas no other formula references get an advisory diagnostic, never an error", () => {
  const graph = graphOf({ base: "1", mid: "formula.base", unused: "2" });
  assert.deepEqual(graph.diagnostics, [
    {
      code: FORMULA_GRAPH_DIAGNOSTIC_CODES.UNREFERENCED_FORMULA,
      severity: "warning",
      formula: "mid",
      message: 'Base formula "mid" is not referenced by any other formula',
    },
    {
      code: FORMULA_GRAPH_DIAGNOSTIC_CODES.UNREFERENCED_FORMULA,
      severity: "warning",
      formula: "unused",
      message: 'Base formula "unused" is not referenced by any other formula',
    },
  ]);
  assert.equal(Object.isFrozen(graph.diagnostics[0]), true);
  assert.deepEqual(graph.order, ["base", "mid", "unused"]);
  assert.deepEqual(graph.dependents.base, ["mid"]);
});

test("compile: builds are deterministic and stack-safe for a 2000-formula chain", () => {
  const formulas = Object.create(null);
  formulas.f0 = "1";
  for (let index = 1; index <= 2000; index += 1) formulas[`f${index}`] = `formula.f${index - 1}`;
  const graph = graphOf(formulas);
  const again = graphOf(formulas);
  assert.equal(graph.order.length, 2001);
  assert.equal(graph.order[0], "f0");
  assert.equal(graph.order[2000], "f2000");
  assert.deepEqual(graph.order, again.order);
  assert.deepEqual(graph.diagnostics, again.diagnostics);
});

test("compile: a 20k-character formula name is accepted (names are opaque)", () => {
  const name = `long_${"x".repeat(20000)}`;
  const graph = graphOf({ [name]: "1", tail: `formula.${name}` });
  assert.deepEqual(graph.order, [name, "tail"]);
  const result = evaluateFormulaRow(graph, {}, ({ name: evaluated }) => (evaluated === name ? 1 : 2));
  assert.equal(result.values[name], 1);
  assert.equal(result.values.tail, 2);
});

// --- evaluate: memoization -------------------------------------------------

test("evaluate: diamond dependencies evaluate each formula exactly once per row", () => {
  const graph = graphOf({ a: "1", b: "formula.a", c: "formula.a", d: "formula.b formula.c" });
  const calls = new Map();
  const result = evaluateFormulaRow(graph, { id: 1 }, countingEvaluator(calls));
  assert.equal(result.ok, true);
  assert.deepEqual([...calls.entries()], [["a", 1], ["b", 1], ["c", 1], ["d", 1]]);
  assert.deepEqual(result.evaluated, ["a", "b", "c", "d"]);
  assert.deepEqual({ ...result.values }, { a: 1, b: 2, c: 2, d: 6 });
});

test("evaluate: one row evaluator reuses the memo across evaluate() and evaluateAll()", () => {
  const graph = graphOf({ a: "1", b: "formula.a", c: "formula.b" });
  const calls = new Map();
  const evaluator = createFormulaRowEvaluator(graph, { id: 1 }, countingEvaluator(calls));
  assert.deepEqual(Object.keys(evaluator.evaluate("b").values), ["a", "b"]);
  assert.equal(evaluator.evaluate("b").values.b, 2);
  assert.deepEqual(evaluator.evaluateAll().evaluated, ["a", "b", "c"]);
  assert.deepEqual([...calls.entries()], [["a", 1], ["b", 1], ["c", 1]]);
});

test("evaluate: memoization is per row", () => {
  const graph = graphOf({ a: "1", b: "formula.a" });
  const calls = new Map();
  const evaluate = countingEvaluator(calls);
  const first = createFormulaRowEvaluator(graph, { id: 1 }, evaluate);
  const second = createFormulaRowEvaluator(graph, { id: 2 }, evaluate);
  first.evaluateAll();
  second.evaluateAll();
  first.evaluateAll();
  assert.deepEqual([...calls.entries()], [["a", 2], ["b", 2]]);
});

test("evaluate: a 2000-formula chain evaluates iteratively with one call per formula", () => {
  const formulas = Object.create(null);
  formulas.f0 = "1";
  for (let index = 1; index <= 2000; index += 1) formulas[`f${index}`] = `formula.f${index - 1}`;
  const calls = new Map();
  const result = evaluateFormulaRow(graphOf(formulas), {}, countingEvaluator(calls));
  assert.equal(result.values.f2000, 2001);
  assert.equal(calls.size, 2001);
  for (const count of calls.values()) assert.equal(count, 1);
});

// --- evaluate: error propagation contract ----------------------------------

test("evaluate: a failing dependency is propagated and the dependent is not evaluated", () => {
  const graph = graphOf({ a: "1", b: "formula.a", c: "formula.b" });
  const calls = new Map();
  const result = evaluateFormulaRow(graph, { id: 1 }, countingEvaluator(calls, { failOn: ["b"] }));
  assert.equal(result.ok, false);
  assert.deepEqual([...calls.entries()], [["a", 1], ["b", 1]]);
  assert.deepEqual(Object.keys(result.values), ["a"]);
  assert.deepEqual(result.errors.map((error) => [error.code, error.formula]), [
    [FORMULA_EVALUATION_ERROR_CODES.FORMULA_EVALUATION_FAILED, "b"],
    [FORMULA_EVALUATION_ERROR_CODES.FORMULA_DEPENDENCY_FAILED, "c"],
  ]);
  assert.equal(result.errors[0].message, 'Base formula "b" failed to evaluate: b exploded');
  assert.equal(result.errors[1].message, 'Base formula "c" was not evaluated because dependency formulas failed: b');
  assert.deepEqual(result.errors[1].causes.map((error) => error.formula), ["b"]);
});

test("evaluate: multiple failures are aggregated in topological order with deterministic texts", () => {
  const graph = graphOf({ root1: "1", root2: "1", mid1: "formula.root1", mid2: "formula.root2", top: "formula.mid1 formula.mid2" });
  const calls = new Map();
  const result = evaluateFormulaRow(graph, {}, countingEvaluator(calls, { failOn: ["root1", "root2"] }));
  assert.deepEqual(result.evaluated, ["root1", "root2", "mid1", "mid2", "top"]);
  assert.deepEqual([...calls.keys()], ["root1", "root2"]);
  assert.deepEqual(result.errors.map((error) => error.formula), ["root1", "root2", "mid1", "mid2", "top"]);
  assert.deepEqual(result.errors.map((error) => error.code), [
    FORMULA_EVALUATION_ERROR_CODES.FORMULA_EVALUATION_FAILED,
    FORMULA_EVALUATION_ERROR_CODES.FORMULA_EVALUATION_FAILED,
    FORMULA_EVALUATION_ERROR_CODES.FORMULA_DEPENDENCY_FAILED,
    FORMULA_EVALUATION_ERROR_CODES.FORMULA_DEPENDENCY_FAILED,
    FORMULA_EVALUATION_ERROR_CODES.FORMULA_DEPENDENCY_FAILED,
  ]);
  assert.equal(result.errors[4].message, 'Base formula "top" was not evaluated because dependency formulas failed: mid1, mid2');
  assert.deepEqual(result.errors[4].causes.map((error) => error.formula), ["mid1", "mid2"]);
});

test("evaluate: a nested failure chain preserves causes and leaks no stack", () => {
  const graph = graphOf({ a: "formula.b", b: "formula.c", c: "1" });
  const result = evaluateFormulaRow(graph, {}, countingEvaluator(new Map(), { failOn: ["c"] }));
  assert.deepEqual(result.errors.map((error) => error.formula), ["c", "b", "a"]);
  assert.deepEqual(result.errors[2].causes.map((error) => error.formula), ["b"]);
  assert.deepEqual(result.errors[2].causes[0].causes.map((error) => error.formula), ["c"]);
  assert.equal(JSON.stringify(result.errors).includes("at Object."), false);
});

test("evaluate: a non-Error thrown value still produces a deterministic message", () => {
  const graph = graphOf({ a: "1" });
  const result = evaluateFormulaRow(graph, {}, () => {
    throw "kaboom";
  });
  assert.equal(result.errors[0].message, 'Base formula "a" failed to evaluate: kaboom');
});

test("evaluate: unknown formula names and non-object rows fail closed", () => {
  const graph = graphOf({ a: "1" });
  const evaluator = createFormulaRowEvaluator(graph, {}, () => 1);
  const unknown = captureError(() => evaluator.evaluate("ghost"));
  assert.equal(unknown.code, FORMULA_GRAPH_ERROR_CODES.UNKNOWN_FORMULA);
  assert.equal(unknown.message, 'Base formula "ghost" is not declared');
  assert.equal(captureError(() => createFormulaRowEvaluator(graph, null, () => 1)).code, FORMULA_GRAPH_ERROR_CODES.INVALID_ROW);
  assert.equal(captureError(() => createFormulaRowEvaluator(graph, {}, null)).code, FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT);
  assert.equal(captureError(() => evaluateFormulaRow({}, {}, () => 1)).code, FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT);
});

test("evaluate: results are frozen null-prototype containers", () => {
  const result = evaluateFormulaRow(graphOf({ a: "1" }), {}, () => 1);
  assert.equal(Object.getPrototypeOf(result.values), null);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.values), true);
  assert.equal(Object.isFrozen(result.errors), true);
  assert.equal(Object.isFrozen(result.evaluated), true);
});

test("evaluate: dependency values handed to the evaluator are frozen null-prototype records", () => {
  const seen = [];
  const graph = graphOf({ a: "1", b: "formula.a" });
  evaluateFormulaRow(graph, {}, ({ dependencies }) => {
    seen.push(dependencies);
    return 1;
  });
  assert.deepEqual(seen.map((value) => Object.getPrototypeOf(value)), [null, null]);
  assert.deepEqual(seen.map((value) => Object.isFrozen(value)), [true, true]);
  assert.deepEqual(Object.keys(seen[1]), ["a"]);
});

// --- seams: the graph parses and reads nothing itself ----------------------

test("seams: the extractor and evaluator receive the opaque expression verbatim", () => {
  const expression = Object.freeze({ ast: "opaque" });
  const seen = [];
  const graph = buildFormulaDependencyGraph({
    formulas: { a: expression },
    extractReferences: (value) => {
      seen.push(value);
      return [];
    },
  });
  assert.deepEqual(seen, [expression]);
  assert.equal(graph.expressions.a, expression);
  let observed;
  evaluateFormulaRow(graph, {}, ({ expression: value }) => {
    observed = value;
    return 7;
  });
  assert.equal(observed, expression);
});

test("seams: row properties are never read by the graph", () => {
  let reads = 0;
  const row = { id: 1 };
  Object.defineProperty(row, "title", { enumerable: true, get() { reads += 1; return "x"; } });
  const result = evaluateFormulaRow(graphOf({ a: "1" }), row, ({ row: passed }) => {
    assert.equal(passed, row);
    return 1;
  });
  assert.equal(result.ok, true);
  assert.equal(reads, 0);
});
