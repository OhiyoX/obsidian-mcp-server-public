// D1 regression (review round 1, `desktop-re/bases-grouping`): the Web `?group=` override must
// pass the SAME fail-closed gate as a `.base`'s own `groupBy`.
//
// Before this test the two inputs disagreed: `assertNoFormulaReferencesInGroupBy` is called from
// `compileBaseView(view)` and therefore only ever inspects the DOCUMENT, so a rule written into the
// .base was rejected while the identical rule arriving through the URL executed. The frozen suite
// already pins the document side (`base-int-c-filter-sort.test.js`), which is what made the URL
// path a hole rather than a design choice.
import assert from "node:assert/strict";
import test from "node:test";

import { queryBaseSnapshot } from "../src/base-query.js";

function record(name, frontmatter) {
  return {
    path: `WB/${name}.md`,
    basename: name,
    frontmatter,
    tags: [],
    links: [],
    stat: { size: 1, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z" },
  };
}

const RECORDS = Object.freeze([
  record("Alpha", { status: "active" }),
  record("Bravo", { status: "done" }),
  record("Delta", { status: "active" }),
]);

// No `formulas:` block is needed: both gates reject on the `formula.` PREFIX (the declaration side
// via `assertNoFormulaReferencesInGroupBy`, the override side via the same predicate), which is
// what keeps the two paths from drifting. Declaring a real formula would drag the formula
// compiler's own `file.asLink(...)` requirement into a test about the groupBy gate.
function baseYaml({ groupBy = null } = {}) {
  const lines = [
    'filters: file.inFolder("WB")',
    "views:",
    "  - type: table",
    "    name: V",
    '    order: ["file.name", "status"]',
  ];
  if (groupBy) lines.push("    groupBy:", `      property: ${groupBy}`);
  lines.push("");
  return lines.join("\n");
}

const rejectsFormula = (error) => error?.code === "unsupported" && /not supported in groupBy/.test(error.message);

test("?group= cannot smuggle a formula past the fail-closed groupBy gate", () => {
  assert.throws(
    () => queryBaseSnapshot({
      raw: baseYaml(),
      viewName: "V",
      records: RECORDS,
      groupOverride: { property: "formula.anchor", direction: "ASC" },
    }),
    rejectsFormula,
  );
});

test("the document declaration keeps rejecting the same rule (unchanged behaviour)", () => {
  assert.throws(
    () => queryBaseSnapshot({
      raw: baseYaml({ groupBy: "formula.anchor" }),
      viewName: "V",
      records: RECORDS,
    }),
    rejectsFormula,
  );
});

test("a plain property still groups through the override", () => {
  const snapshot = queryBaseSnapshot({
    raw: baseYaml(),
    viewName: "V",
    records: RECORDS,
    groupOverride: { property: "status", direction: "ASC" },
  });
  assert.deepEqual(snapshot.groups.map((group) => group.key), ["active", "done"]);
});
