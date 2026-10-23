// Web Base formula DTO contract (RECON §4 刀3, server half).
//
// Pins three things the Web surface depends on and MCP does not:
//   1. a `formula.<name>` column is a renderable column whose DTO carries the
//      .base declaration (`{ name, expression, displayName }`) and whose row
//      value is the already-evaluated result;
//   2. an unknown function / type error / cycle stays fail-closed (no snapshot,
//      no partial row set) and additionally carries the stable failure class the
//      UI maps to the desktop `msgError*` messages;
//   3. the negative control: a fail-open mutation is observable, so the
//      assertions above cannot pass by accident.
//
// Fixtures are the official corpus files (no new corpus): the accepted
// `properties.formula.<name>.displayName` case and the rejected arithmetic case.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { BaseQueryError, queryBaseSnapshot } from "../src/base-query.js";
import { createBaseSnapshotEvaluator, exposeFormulaColumns } from "../src/app/base-snapshot-adapter.js";

const fixtures = new URL("./fixtures/bases/official/", import.meta.url);
const readFixture = (name) => fs.readFile(new URL(name, fixtures), "utf8");

const [acceptedBase, acceptedRecords] = await Promise.all([
  readFixture("official-properties-displayname-formula.base"),
  readFixture("official-properties-displayname-formula.records.json"),
]);
const records = JSON.parse(acceptedRecords);

const evaluate = createBaseSnapshotEvaluator();

// Small inline documents keep the failure classes independent of the corpus
// (the corpus pins the *acceptance* boundary; this file pins the diagnostics).
function formulaBase(source, name = "x") {
  return [
    "formulas:",
    `  ${name}: ${JSON.stringify(source)}`,
    "views:",
    "  - name: Main",
    "    type: table",
    "    order:",
    `      - formula.${name}`,
    "",
  ].join("\n");
}

function failing(error) {
  return error instanceof BaseQueryError ? error : null;
}

// `assert.throws` returns undefined, so failures are captured explicitly (the
// diagnostic fields are the contract this file pins).
function capture(produce) {
  try {
    const value = produce();
    assert.fail(`expected a BaseQueryError, got a snapshot: ${JSON.stringify(value?.rows?.length)} rows`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    return error;
  }
  return null;
}

test("an accepted formula column is a renderable DTO column with its evaluated values", async () => {
  const snapshot = evaluate({ raw: acceptedBase, viewName: "Main", records, limit: 10 });
  assert.equal(snapshot.supportedSubset, true);
  const column = snapshot.columns.find((item) => item.key === "formula.label");
  assert.deepEqual(column, {
    key: "formula.label",
    label: "Label",
    kind: "formula",
    // The declaration the desktop `Edit formula...` panel reads from the .base.
    formula: { name: "label", expression: "file.asLink(file.name)", displayName: "Label" },
  });
  // Every row carries the evaluated result (the structured asLink cell the
  // existing cell codec already renders).
  assert.equal(snapshot.rows.length, records.length);
  for (const row of snapshot.rows) {
    const value = row.values["formula.label"];
    assert.equal(value.kind, "asLink");
    assert.equal(value.path, row.path);
  }
  // A plain property column is untouched: no formula metadata is invented.
  const plain = snapshot.columns.find((item) => item.key === "file.name");
  assert.equal(plain.formula, undefined);
});

test("an unknown function fails closed with the invalid-function class (no rows at all)", () => {
  const error = capture(() => evaluate({ raw: formulaBase("file.asLink(nope(1))"), viewName: "Main", records, limit: 10 }));
  assert.ok(failing(error));
  assert.equal(error.code, "unsupported");
  assert.deepEqual(error.formulaFailure, { code: "formula-invalid-function", name: "x" });
  // Fail-closed: the error is the only outcome; no snapshot is produced.
  assert.equal(error.rows, undefined);
});

test("a type error and an `if` arity error keep their own classes", () => {
  const typeError = capture(() => evaluate({ raw: formulaBase('file.asLink(price > "x")'), viewName: "Main", records, limit: 10 }));
  assert.deepEqual(typeError.formulaFailure, { code: "formula-type-error", name: "x" });

  const arity = capture(() => evaluate({ raw: formulaBase("file.asLink(if(1,2))"), viewName: "Main", records, limit: 10 }));
  assert.deepEqual(arity.formulaFailure, { code: "formula-not-enough-arguments", name: "x" });
});

test("a formula cycle fails closed as formula-infinite-loop", () => {
  const cycle = [
    "formulas:",
    '  a: "file.asLink(formula.b)"',
    '  b: "file.asLink(formula.a)"',
    "views:",
    "  - name: Main",
    "    type: table",
    "    order:",
    "      - formula.a",
    "",
  ].join("\n");
  const error = capture(() => evaluate({ raw: cycle, viewName: "Main", records, limit: 10 }));
  assert.equal(error.code, "unsupported");
  assert.equal(error.formulaFailure?.code, "formula-infinite-loop");
});

test("MCP's frozen DTO is untouched: the domain service still returns bare columns", () => {
  const snapshot = queryBaseSnapshot({ raw: acceptedBase, viewName: "Main", records, limit: 10 });
  const column = snapshot.columns.find((item) => item.key === "formula.label");
  assert.deepEqual(column, { key: "formula.label", label: "Label", kind: "formula" });
  assert.equal(column.formula, undefined);
});

test("exposeFormulaColumns never invents a declaration for an undeclared name", () => {
  const base = { formulas: { label: "file.asLink(file.name)" }, properties: { "formula.label": { displayName: "Label" } } };
  const columns = exposeFormulaColumns(base, [
    { key: "formula.label", label: "Label", kind: "formula" },
    { key: "formula.missing", label: "missing", kind: "formula" },
    { key: "file.name", label: "name", kind: "property" },
  ]);
  assert.equal(columns[0].formula.expression, "file.asLink(file.name)");
  // Undeclared: the domain rejects it with `missing_formula` on its own.
  assert.deepEqual(columns[1].formula, { name: "missing", expression: null, displayName: null });
  assert.equal(columns[2].formula, undefined);
});

// --- negative control -------------------------------------------------------
//
// The two invariants the tests above rely on, applied to a *mutant* producer that
// ignores the formula failure in place (the change the brief forbids). If a
// future edit made the pipeline fail open, the mutant shape is what the DTO would
// look like and both invariants are violated, so the contract tests would go red.
function failClosedInvariants(snapshot, error) {
  return {
    noSnapshot: snapshot === undefined,
    noRows: snapshot === undefined || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0,
    classified: Boolean(error?.formulaFailure?.code),
  };
}

test("negative control: a fail-open mutation violates every fail-closed invariant", () => {
  // Mutant: the compile-time failure is ignored in place, so the pipeline would
  // serve the column with empty values (the exact shape the forbidden change
  // would produce for the same inputs). Built by hand because the mutation must
  // not exist in the real code path.
  const mutantSnapshot = {
    views: [{ name: "Main", type: "table" }],
    view: "Main",
    columns: [{ key: "formula.x", label: "x", kind: "formula" }],
    rows: [{ path: "Notes/Alpha.md", values: { "formula.x": null } }],
    totalMatched: 1,
    supportedSubset: true,
  };
  const mutantInvariants = failClosedInvariants(mutantSnapshot, null);
  assert.equal(mutantInvariants.noSnapshot, false);
  assert.equal(mutantInvariants.noRows, false);
  assert.equal(mutantInvariants.classified, false);

  // The real producer satisfies all three (same helper, no special casing).
  let realError = null;
  let realSnapshot;
  try {
    realSnapshot = evaluate({ raw: formulaBase("file.asLink(nope(1))"), viewName: "Main", records, limit: 10 });
  } catch (error) {
    realError = error;
  }
  assert.deepEqual(failClosedInvariants(realSnapshot, realError), { noSnapshot: true, noRows: true, classified: true });
});
