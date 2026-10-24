// Bases P1 / INT-B — dependency wiring for the canonical formula layer.
//
// This module owns exactly one job: turn the parsed P1-A expression ASTs of a
// Base formula registry into the W1-B formula dependency DAG (compile time) and
// resolve `formula.<name>` references through its per-row memoized evaluator
// (run time). It owns no expression grammar, no value semantics and no Base
// pipeline knowledge:
//
//   * the DAG / cycle detection / memoized orchestration come from
//     `app/src/base-formula-graph.js` (P1-B, injected, never re-implemented);
//   * the expression language comes from `app/src/base-expression.js` (P1-A);
//   * the compiled per-formula closures are injected by `base-formulas.js`.
//
// The single seam this module implements is the graph's `extractReferences`,
// and it does it from the P1-A AST (`reference` nodes with
// `namespace === "formula"`), stripping the `formula.` prefix.
//
// Memoization: the graph defines "at most one evaluation per formula per row"
// per `createFormulaRowEvaluator` instance. The canonical pipeline
// (`workflows.baseRow` -> `evaluateBaseFormula(ast, record)`) has no injectable
// evaluator seam and may call the same row repeatedly (filter / sort / text
// query / projection), so the runtime keys one row evaluator on the record
// object itself (WeakMap). The same record therefore never evaluates a formula
// twice, and a record that is never queried again is collected with its memo.

import { parseBaseExpression } from "./base-expression.js";
import {
  BaseFormulaGraphError,
  buildFormulaDependencyGraph,
  createFormulaRowEvaluator,
} from "./base-formula-graph.js";

// The canonical (BaseQueryError) code every dependency failure maps to; the
// domain code, message and causes chain of the underlying failure are preserved.
export const FORMULA_DEPENDENCY_ERROR_CODE = "unsupported";

// Carries a verbatim W1-B graph message plus its `causes` chain. `base-formulas`
// maps it into `BaseFormulaError` (`unsupported`), it never leaks a stack.
export class BaseFormulaDependencyError extends Error {
  constructor(message, causes = []) {
    super(message);
    this.name = "BaseFormulaDependencyError";
    this.code = FORMULA_DEPENDENCY_ERROR_CODE;
    this.causes = Object.freeze(Array.isArray(causes) ? [...causes] : []);
  }
}

function toDependencyError(error) {
  if (error instanceof BaseFormulaDependencyError) return error;
  if (error instanceof BaseFormulaGraphError) return new BaseFormulaDependencyError(error.message, []);
  return error;
}

function collectReferences(node, names, seen) {
  if (node === null || typeof node !== "object") return;
  switch (node.type) {
    case "reference":
      if (node.namespace === "formula" && typeof node.name === "string" && !seen.has(node.name)) {
        seen.add(node.name);
        names.push(node.name);
      }
      return;
    case "unary":
      return collectReferences(node.argument, names, seen);
    case "binary":
    case "comparison":
    case "logical":
      collectReferences(node.left, names, seen);
      return collectReferences(node.right, names, seen);
    case "call":
      for (const argument of Array.isArray(node.args) ? node.args : []) collectReferences(argument, names, seen);
      return;
    default:
      return;
  }
}

/**
 * Bare formula names referenced by one expression, in first-appearance order
 * and without duplicates. Accepts a P1-A AST or an expression source string
 * (`parseBaseExpression` is applied to strings), so the seam can be unit tested
 * on its own. `formula.` is stripped; `note.*` / bare properties are ignored.
 *
 * @param {object|string} expression
 * @returns {string[]}
 */
export function extractFormulaReferences(expression) {
  const ast = typeof expression === "string" ? parseBaseExpression(expression) : expression;
  if (ast === null || typeof ast !== "object" || typeof ast.type !== "string") {
    throw new BaseFormulaDependencyError("Formula reference extraction requires a parsed expression or an expression source");
  }
  const names = [];
  collectReferences(ast, names, new Set());
  return names;
}

/**
 * Build the dependency runtime for a list of compiled formula entries
 * (`{ name, source, expression, evaluate(record, dependencies) }`). Compile
 * failures (missing formula, any cycle class including dead branches) throw
 * here, before any row is read.
 *
 * @param {ReadonlyArray<{name: string, expression: unknown, evaluate: Function}>} declared
 * @returns {Readonly<{graph: object, value(name: string, record: object): unknown}>}
 */
export function createFormulaDependencyRuntime(declared) {
  if (!Array.isArray(declared)) {
    throw new BaseFormulaDependencyError("Base formula dependency wiring requires an array of compiled formula entries");
  }
  let graph;
  try {
    graph = buildFormulaDependencyGraph({
      // The opaque expression value the graph stores and hands back verbatim is
      // the compiled entry itself (parsed AST + raw closure): no re-parsing, no
      // second grammar, and the evaluator seam can reach both fields.
      formulas: declared.map((entry) => ({ name: entry.name, expression: entry })),
      extractReferences: (entry) => extractFormulaReferences(entry && entry.expression),
    });
  } catch (error) {
    throw toDependencyError(error);
  }

  // Only successful dependency values are handed to the closure, in the
  // formula's own declaration order (the graph freezes that contract). A closure
  // failure is captured per formula so a directly requested formula keeps the
  // INT-A error shape (type-mismatch / limit / syntax + expressionCode) instead
  // of the graph's generic wrapper; the graph itself records the wrapper message
  // inside the `causes` chain of its dependents.
  const rowStates = new WeakMap();
  const evaluate = (context) => {
    try {
      return context.expression.evaluate(context.row, context.dependencies);
    } catch (error) {
      const state = rowStates.get(context.row);
      if (state) state.thrown.set(context.name, error);
      throw error;
    }
  };

  function rowState(record) {
    let state = rowStates.get(record);
    if (state) return state;
    // Registered before the first evaluation so the seam above can always find
    // it; one state per record carries the memo AND the failure origin.
    state = { evaluator: null, thrown: new Map() };
    rowStates.set(record, state);
    try {
      state.evaluator = createFormulaRowEvaluator(graph, record, evaluate);
    } catch (error) {
      rowStates.delete(record);
      throw toDependencyError(error);
    }
    return state;
  }

  return Object.freeze({
    graph,
    value(name, record) {
      if (record === null || typeof record !== "object") {
        throw new BaseFormulaDependencyError("Base formula evaluation requires a non-null row object");
      }
      const state = rowState(record);
      let result;
      try {
        result = state.evaluator.evaluate(name);
      } catch (error) {
        throw toDependencyError(error);
      }
      const failure = result.errors.find((entry) => entry.formula === name);
      if (failure) {
        const origin = failure.code === "formula_evaluation_failed" ? state.thrown.get(name) : undefined;
        if (origin !== undefined) throw origin;
        // Dependency failures keep the verbatim graph message + frozen causes
        // chain (root cause code/message kept); never a vague re-wording.
        throw new BaseFormulaDependencyError(failure.message, failure.causes);
      }
      return result.values[name];
    },
  });
}
