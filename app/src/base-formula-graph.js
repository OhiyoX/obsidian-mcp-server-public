// Pure model: formula dependency DAG, compile-time cycle validation and
// per-row memoized evaluation orchestration for Obsidian Bases formulas.
//
// This module deliberately owns NO expression grammar and NO evaluation
// semantics. Both are injected through two seams:
//
//   extractReferences(expression) => string[]      // compile time (P1-A parser)
//   evaluate({ name, expression, row, dependencies }) => unknown   // run time
//
// It never calls eval/Function/vm, never imports fs/path/express/MCP, never
// reads row properties itself and never inspects the opaque expression values
// beyond passing them back to the caller-provided seams. Dependency extraction
// results are interpreted as FORMULA NAMES (the seam strips any `formula.`
// prefix; see `docs/bases/BASES-FORMULA-GRAPH.md`).
//
// Guarantees (contract §7):
//   * formula dependency is an explicit DAG; self / 2-node / multi-node cycles
//     and missing formulas fail closed at compile time - including formulas
//     that no view or other formula uses ("dead branch") and unreferenced ones;
//   * every declared formula is analysed before any row/limit/short-circuit;
//   * compile and evaluation are iterative (explicit stacks), so hostile deep
//     chains cannot overflow the call stack - no artificial depth cap is added
//     because it would reject valid Bases documents;
//   * the same formula is evaluated at most once per row (memoization), and
//     diamond dependencies reuse the memoized value;
//   * hostile formula names (`__proto__`, `constructor`, ...) stay own keys;
//     accessor properties are never invoked.

const GRAPH_BRAND = Symbol("base-formula-graph");

/** Compile-time / API failure codes thrown by {@link BaseFormulaGraphError}. */
export const FORMULA_GRAPH_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "invalid_input",
  INVALID_FORMULA_NAME: "invalid_formula_name",
  INVALID_FORMULA_EXPRESSION: "invalid_formula_expression",
  DUPLICATE_FORMULA: "duplicate_formula",
  INVALID_REFERENCE: "invalid_reference",
  EXPRESSION_ERROR: "expression_error",
  MISSING_FORMULA: "missing_formula",
  FORMULA_CYCLE: "formula_cycle",
  UNKNOWN_FORMULA: "unknown_formula",
  INVALID_ROW: "invalid_row",
});

/** Codes carried by evaluation failures returned in a row result. */
export const FORMULA_EVALUATION_ERROR_CODES = Object.freeze({
  FORMULA_EVALUATION_FAILED: "formula_evaluation_failed",
  FORMULA_DEPENDENCY_FAILED: "formula_dependency_failed",
});

/** Non-fatal compile diagnostics (the graph is still usable). */
export const FORMULA_GRAPH_DIAGNOSTIC_CODES = Object.freeze({
  UNREFERENCED_FORMULA: "unreferenced_formula",
});

export class BaseFormulaGraphError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BaseFormulaGraphError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BaseFormulaGraphError(code, message);
}

// Only `.message` is ever surfaced: no stack, path or arbitrary thrown object
// is exposed through errors or results.
function describeThrown(error) {
  try {
    const message = error && error.message;
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // Reading `.message` itself threw; fall through to a safe string form.
  }
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

function readOwnData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) return { present: false, accessor: false, value: undefined };
  if (!Object.hasOwn(descriptor, "value")) return { present: true, accessor: true, value: undefined };
  return { present: true, accessor: false, value: descriptor.value };
}

function normalizeFormulaEntries(formulas) {
  if (formulas === undefined || formulas === null) return [];
  const entries = [];
  if (Array.isArray(formulas)) {
    formulas.forEach((entry, index) => {
      if (Array.isArray(entry)) {
        if (entry.length !== 2) fail(FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT, `Base formula entry must be a [name, expression] pair (index ${index})`);
        entries.push({ name: entry[0], expression: entry[1] });
        return;
      }
      if (entry === null || typeof entry !== "object") fail(FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT, `Base formula entry must be an object or a [name, expression] pair (index ${index})`);
      const name = readOwnData(entry, "name");
      const expression = readOwnData(entry, "expression");
      if (name.accessor || expression.accessor) fail(FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT, `Base formula entry properties must be data properties, not accessors (index ${index})`);
      if (!expression.present) fail(FORMULA_GRAPH_ERROR_CODES.INVALID_FORMULA_EXPRESSION, `Base formula entry must provide an expression (index ${index})`);
      entries.push({ name: name.value, expression: expression.value });
    });
    return entries;
  }
  if (typeof formulas !== "object") fail(FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT, "Base formulas must be a mapping of name to expression or an array of entries");
  for (const name of Object.keys(formulas)) {
    const expression = readOwnData(formulas, name);
    if (expression.accessor) fail(FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT, `Base formula "${name}" must be a data property, not an accessor`);
    entries.push({ name, expression: expression.value });
  }
  return entries;
}

function compileDeclarations(entries) {
  const declared = new Map();
  entries.forEach((entry, index) => {
    if (typeof entry.name !== "string" || entry.name.length === 0) fail(FORMULA_GRAPH_ERROR_CODES.INVALID_FORMULA_NAME, `Base formula name must be a non-empty string (index ${index})`);
    if (declared.has(entry.name)) fail(FORMULA_GRAPH_ERROR_CODES.DUPLICATE_FORMULA, `Base formula "${entry.name}" is declared more than once`);
    if (entry.expression === undefined) fail(FORMULA_GRAPH_ERROR_CODES.INVALID_FORMULA_EXPRESSION, `Base formula "${entry.name}" must provide an expression`);
    declared.set(entry.name, entry);
  });
  return declared;
}

function extractDependencies(declared, extractReferences) {
  const dependencies = new Map();
  for (const [name, entry] of declared) {
    let raw;
    try {
      raw = extractReferences(entry.expression);
    } catch (error) {
      fail(FORMULA_GRAPH_ERROR_CODES.EXPRESSION_ERROR, `Base formula "${name}" could not be analyzed for references: ${describeThrown(error)}`);
    }
    if (!Array.isArray(raw)) fail(FORMULA_GRAPH_ERROR_CODES.INVALID_REFERENCE, `Reference extractor must return an array of formula names for base formula "${name}"`);
    const refs = [];
    const seen = new Set();
    raw.forEach((ref, index) => {
      if (typeof ref !== "string" || ref.length === 0) fail(FORMULA_GRAPH_ERROR_CODES.INVALID_REFERENCE, `Reference extractor returned an invalid formula name at index ${index} for base formula "${name}"`);
      if (seen.has(ref)) return;
      seen.add(ref);
      refs.push(ref);
    });
    dependencies.set(name, refs);
  }
  return dependencies;
}

// Iterative DFS post-order = dependencies before dependents. Cycle detection
// and ordering share one traversal so both are deterministic and stack-safe.
function topologicallySort(names, dependencies) {
  const state = new Map();
  const order = [];
  for (const root of names) {
    if (state.get(root) === "done") continue;
    const frames = [{ name: root, refs: dependencies.get(root), index: 0 }];
    const path = [root];
    state.set(root, "visiting");
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (frame.index < frame.refs.length) {
        const next = frame.refs[frame.index];
        frame.index += 1;
        const status = state.get(next);
        if (status === "visiting") {
          const cycle = path.slice(path.indexOf(next)).concat(next);
          fail(FORMULA_GRAPH_ERROR_CODES.FORMULA_CYCLE, `Base formula dependency cycle detected: ${cycle.join(" -> ")}`);
        }
        if (status === "done") continue;
        state.set(next, "visiting");
        path.push(next);
        frames.push({ name: next, refs: dependencies.get(next), index: 0 });
        continue;
      }
      frames.pop();
      path.pop();
      state.set(frame.name, "done");
      order.push(frame.name);
    }
  }
  return order;
}

function buildDependents(names, dependencies) {
  const dependents = new Map(names.map((name) => [name, []]));
  for (const name of names) {
    for (const ref of dependencies.get(name)) dependents.get(ref).push(name);
  }
  return dependents;
}

function toRecord(source) {
  const record = Object.create(null);
  for (const [key, value] of source) record[key] = value;
  return Object.freeze(record);
}

function toArrayRecord(source) {
  const record = Object.create(null);
  for (const [key, value] of source) record[key] = Object.freeze([...value]);
  return Object.freeze(record);
}

/**
 * Build the validated formula dependency graph.
 *
 * @param {object} spec
 * @param {Record<string, unknown> | Array<[string, unknown] | {name: string, expression: unknown}>} [spec.formulas]
 *   Formula name -> opaque expression value (string text or an already-compiled
 *   object). Array entries allow duplicate declarations to be detected.
 * @param {(expression: unknown) => string[]} spec.extractReferences
 *   Injected reference extractor returning the FORMULA NAMES this expression
 *   depends on (prefix already stripped by the caller/parser).
 * @returns {object} frozen graph: `{ names, order, expressions, dependencies, dependents, diagnostics, has(name) }`
 */
export function buildFormulaDependencyGraph({ formulas, extractReferences } = {}) {
  if (typeof extractReferences !== "function") fail(FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT, "Formula graph requires an extractReferences function");
  const entries = normalizeFormulaEntries(formulas);
  const declared = compileDeclarations(entries);
  const dependencies = extractDependencies(declared, extractReferences);

  for (const [name, refs] of dependencies) {
    for (const ref of refs) {
      if (!declared.has(ref)) fail(FORMULA_GRAPH_ERROR_CODES.MISSING_FORMULA, `Base formula "${name}" references undeclared formula "${ref}"`);
    }
  }

  const names = [...declared.keys()];
  const order = topologicallySort(names, dependencies);
  const dependents = buildDependents(names, dependencies);

  const referenced = new Set();
  for (const refs of dependencies.values()) for (const ref of refs) referenced.add(ref);
  const diagnostics = names
    .filter((name) => !referenced.has(name))
    .map((name) => Object.freeze({
      code: FORMULA_GRAPH_DIAGNOSTIC_CODES.UNREFERENCED_FORMULA,
      severity: "warning",
      formula: name,
      message: `Base formula "${name}" is not referenced by any other formula`,
    }));

  const graph = {
    [GRAPH_BRAND]: true,
    names: Object.freeze(names),
    order: Object.freeze(order),
    expressions: toRecord(new Map(names.map((name) => [name, declared.get(name).expression]))),
    dependencies: toArrayRecord(dependencies),
    dependents: toArrayRecord(dependents),
    diagnostics: Object.freeze(diagnostics),
    has: (name) => declared.has(name),
  };
  return Object.freeze(graph);
}

function assertGraph(graph) {
  if (graph === null || typeof graph !== "object" || !Object.hasOwn(graph, GRAPH_BRAND)) {
    fail(FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT, "A graph built by buildFormulaDependencyGraph is required");
  }
}

function dependencyClosure(graph, requested) {
  const closure = new Set();
  const stack = [...requested];
  while (stack.length) {
    const name = stack.pop();
    if (closure.has(name)) continue;
    closure.add(name);
    for (const dependency of graph.dependencies[name]) stack.push(dependency);
  }
  return closure;
}

function evaluationFailure(code, formula, message, causes) {
  return { ok: false, error: Object.freeze({ code, formula, message, causes: Object.freeze(causes) }) };
}

function evaluateOne(graph, name, row, evaluate, memo) {
  const dependencies = graph.dependencies[name];
  const failed = dependencies.filter((dependency) => memo.get(dependency).ok === false);
  if (failed.length) {
    return evaluationFailure(
      FORMULA_EVALUATION_ERROR_CODES.FORMULA_DEPENDENCY_FAILED,
      name,
      `Base formula "${name}" was not evaluated because dependency formulas failed: ${failed.join(", ")}`,
      failed.map((dependency) => memo.get(dependency).error),
    );
  }
  const resolved = Object.create(null);
  for (const dependency of dependencies) resolved[dependency] = memo.get(dependency).value;
  try {
    const value = evaluate({ name, expression: graph.expressions[name], row, dependencies: Object.freeze(resolved) });
    return { ok: true, value };
  } catch (error) {
    return evaluationFailure(
      FORMULA_EVALUATION_ERROR_CODES.FORMULA_EVALUATION_FAILED,
      name,
      `Base formula "${name}" failed to evaluate: ${describeThrown(error)}`,
      [],
    );
  }
}

function ensureEvaluated(graph, requested, row, evaluate, memo) {
  const closure = dependencyClosure(graph, requested);
  for (const name of graph.order) {
    if (!closure.has(name) || memo.has(name)) continue;
    memo.set(name, Object.freeze(evaluateOne(graph, name, row, evaluate, memo)));
  }
  return closure;
}

function collectRowResult(graph, closure, memo) {
  const values = Object.create(null);
  const errors = [];
  const evaluated = [];
  for (const name of graph.order) {
    if (!closure.has(name)) continue;
    evaluated.push(name);
    const entry = memo.get(name);
    if (entry.ok) values[name] = entry.value;
    else errors.push(entry.error);
  }
  return Object.freeze({
    ok: errors.length === 0,
    values: Object.freeze(values),
    errors: Object.freeze(errors),
    evaluated: Object.freeze(evaluated),
  });
}

/**
 * Create a per-row evaluator. One instance owns one row's memo, so reusing the
 * same instance across filter / sort / display guarantees "at most one
 * evaluation per formula per row".
 *
 * @param {object} graph graph from {@link buildFormulaDependencyGraph}
 * @param {object} row non-null row object handed verbatim to `evaluate`
 * @param {(context: {name: string, expression: unknown, row: object, dependencies: Record<string, unknown>}) => unknown} evaluate
 * @returns {{evaluate(name: string): object, evaluateAll(): object}}
 */
export function createFormulaRowEvaluator(graph, row, evaluate) {
  assertGraph(graph);
  if (row === null || typeof row !== "object") fail(FORMULA_GRAPH_ERROR_CODES.INVALID_ROW, "Base formula evaluation requires a non-null row object");
  if (typeof evaluate !== "function") fail(FORMULA_GRAPH_ERROR_CODES.INVALID_INPUT, "Base formula evaluation requires an evaluate function");
  const memo = new Map();
  return Object.freeze({
    evaluate(name) {
      if (typeof name !== "string" || !graph.has(name)) fail(FORMULA_GRAPH_ERROR_CODES.UNKNOWN_FORMULA, `Base formula "${String(name)}" is not declared`);
      const closure = ensureEvaluated(graph, [name], row, evaluate, memo);
      return collectRowResult(graph, closure, memo);
    },
    evaluateAll() {
      const closure = ensureEvaluated(graph, graph.names, row, evaluate, memo);
      return collectRowResult(graph, closure, memo);
    },
  });
}

/**
 * Convenience one-shot evaluation of every declared formula for one row.
 *
 * @returns {{ok: boolean, values: Record<string, unknown>, errors: readonly object[], evaluated: readonly string[]}}
 */
export function evaluateFormulaRow(graph, row, evaluate) {
  return createFormulaRowEvaluator(graph, row, evaluate).evaluateAll();
}
