// G3/G4 — desktop filter groups (`and`/`or`/`not`) + the desktop simple-builder
// operator table, in the canonical Base domain service.
//
// Desktop evidence (asar static read, 1.14.4):
//   - group parse: app.js@2361900 — the object must have EXACTLY ONE key of
//     `and`/`or`/`not` (`msgErrorFilterAllowedKeys`) and its value must be an
//     array (`msgErrorFilterMustBeArray`);
//   - `not` = "none of" (`!items.some(...)`, app.js@2351400);
//   - operator table: app.js@3238200 `registerOperatorFuncConfigs("bases", [...])`
//     with hasProperty/isEmpty/startsWith/endsWith/contains/containsAny/
//     containsAll/matches/hasLink/inFolder/hasTag.
//
// Proves:
//   - `{and|or|not}` recurses (nested groups, mixed with expression leaves);
//   - unknown / multi-key group shapes fail closed instead of picking a key;
//   - the LEGACY frozen shape `filter=[{key,op,value}]` (AND list) is unchanged:
//     same rows as the explicit `{and: [...]}` form and as the pre-G3 evaluator;
//   - each new operator has a positive AND a negative case;
//   - negative control: an `or` group evaluated as `and` must be RED.
import assert from "node:assert/strict";
import test from "node:test";

const {
  BASE_FILTER_OPERATORS,
  BASE_FILTER_RECORD_OPERATORS,
  BaseQueryError,
  assertBaseFilterTree,
  evaluateBaseCondition,
  evaluateBaseFilterTree,
  evaluateBaseView,
  queryBaseSnapshot,
} = await import("../src/base-query.js");
const { compileBaseFormulas } = await import("../src/base-formulas.js");

function record(name, frontmatter = {}, extra = {}) {
  return {
    path: extra.path ?? `WB/${name}.md`,
    basename: name,
    frontmatter,
    tags: extra.tags ?? [],
    links: (extra.links ?? []).map((target) => ({ target })),
    stat: { size: 1, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z" },
  };
}

const records = [
  record("Alpha", { status: "active", score: 10 }, { tags: ["work"], links: ["Beta"] }),
  record("Bravo", { status: "done", score: 2 }, { path: "Archive/Bravo.md" }),
  record("Echo", { status: "active", score: 7 }, { path: "Archive/Deep/Echo.md", tags: ["work/nested"] }),
];

const order = ["file.name", "status", "score"];
const base = { views: [{ type: "table", name: "V", order }] };
const view = base.views[0];
const evaluate = (filterExtra) => evaluateBaseView({ base, view, order, formulas: {}, records, filterExtra });
const paths = (result) => result.rows.map((row) => row.path);

// ── 1. and / or / not recursion ──────────────────────────────────────────────
test("or is union, and is intersection and not is none-of (recursively)", () => {
  assert.deepEqual(paths(evaluate([{ key: "status", op: "is", value: "active" }])), ["WB/Alpha.md", "Archive/Deep/Echo.md"]);
  assert.deepEqual(
    paths(evaluate({ or: [{ key: "status", op: "is", value: "done" }, { key: "score", op: "gt", value: 8 }] })),
    ["WB/Alpha.md", "Archive/Bravo.md"],
  );
  assert.deepEqual(
    paths(evaluate({ and: [{ key: "status", op: "is", value: "active" }, { key: "score", op: "gt", value: 8 }] })),
    ["WB/Alpha.md"],
  );
  // `not` is "none of": every record whose status is done OR score > 8 is removed.
  assert.deepEqual(
    paths(evaluate({ not: [{ key: "status", op: "is", value: "done" }, { key: "score", op: "gt", value: 8 }] })),
    ["Archive/Deep/Echo.md"],
  );
});

test("groups nest to any depth and mix with expression leaves", () => {
  const nested = {
    or: [
      { and: [{ key: "status", op: "is", value: "active" }, { not: [{ key: "score", op: "gt", value: 8 }] }] },
      { key: "file.path", op: "in-folder", value: "Archive" },
    ],
  };
  // Alpha fails the inner not (10 > 8), Bravo is in Archive, Echo is active + 7 <= 8.
  assert.deepEqual(paths(evaluate(nested)), ["Archive/Bravo.md", "Archive/Deep/Echo.md"]);

  // A `.base` document filter tree keeps its expression-string leaves.
  const raw = [
    "filters:",
    "  not:",
    "    - 'status == \"done\"'",
    "views:",
    "  - type: table",
    "    name: V",
    "    order: [file.name, status, score]",
    "    filters:",
    "      or:",
    "        - 'score > 8'",
    "        - file.hasTag(\"work\")",
    "",
  ].join("\n");
  const snapshot = queryBaseSnapshot({ raw, records });
  assert.equal(snapshot.supportedSubset, true);
  // Echo's only tag is `work/nested`, which the documented D1 rule does NOT
  // match for `hasTag("work")` (exact match, no nesting), so only Alpha's
  // `score > 8` survives the outer AND.
  assert.deepEqual(paths(snapshot), ["WB/Alpha.md"]);
});

// ── 2. fail-closed group shapes (desktop msgErrorFilterAllowedKeys) ──────────
test("an unparsable or ambiguous group fails closed instead of picking a key", () => {
  const cases = [
    [{ and: [], or: [] }, "invalid-schema"],            // two conjunctions on one level
    [{ and: [{ key: "status", op: "is", value: "x" }], nand: [] }, "invalid-schema"],
    [{ and: { key: "status", op: "is", value: "x" } }, "invalid-schema"], // non-array conjunction
    [{ or: "status == \"active\"" }, "invalid-schema"],
    [42, "invalid-schema"],
    [{ key: "status", op: "like", value: "a" }, "unsupported"],           // unknown operator
    [{ key: "status", op: "is", value: "a", extra: 1 }, "invalid-schema"], // unknown condition key
    [{ key: "", op: "is", value: "a" }, "invalid-schema"],
  ];
  for (const [node, code] of cases) {
    assert.throws(
      () => assertBaseFilterTree(node, { allowConditions: true, path: "filter" }),
      (error) => error instanceof BaseQueryError && error.code === code,
      JSON.stringify(node),
    );
    assert.throws(() => evaluate(node), (error) => error instanceof BaseQueryError, JSON.stringify(node));
  }
  // The `.base` dialect has no condition leaves: a structured condition in a
  // document filter is unsupported, and an unknown group key too.
  assert.throws(
    () => assertBaseFilterTree({ key: "status", op: "is", value: "a" }, { path: "filters" }),
    (error) => error instanceof BaseQueryError && error.code === "unsupported",
  );
  assert.throws(
    () => assertBaseFilterTree({ nand: [] }, { path: "filters" }),
    (error) => error instanceof BaseQueryError && error.code === "unsupported",
  );
});

test("a document with an ambiguous filter group fails closed before evaluation", () => {
  const raw = [
    "filters:",
    "  and:",
    "    - 'status == \"active\"'",
    "  or:",
    "    - 'score > 1'",
    "views:",
    "  - type: table",
    "    name: V",
    "",
  ].join("\n");
  assert.throws(
    () => queryBaseSnapshot({ raw, records: [] }),
    (error) => error instanceof BaseQueryError && /one of an "and", "or", or "not"/.test(error.message),
  );
});

// ── 3. backward compatibility of the frozen legacy shape ────────────────────
test("the legacy AND list is byte-identical to the pre-G3 evaluation", () => {
  const legacy = [{ key: "status", op: "is", value: "active" }, { key: "score", op: "gte", value: 7 }];
  const equivalent = { and: legacy };
  const legacyResult = evaluate(legacy);
  assert.deepEqual(paths(legacyResult), ["WB/Alpha.md", "Archive/Deep/Echo.md"]);
  // Same rows, same order, same DTO counters as the explicit group form.
  assert.deepEqual(legacyResult.rows, evaluate(equivalent).rows);
  assert.equal(legacyResult.totalMatched, evaluate(equivalent).totalMatched);
  // Per-condition evaluation is unchanged: an AND list is `every(condition)`.
  assert.equal(
    legacy.every((condition) => evaluateBaseFilterTree(condition, records[0], {})),
    evaluateBaseFilterTree(legacy, records[0], {}),
  );
  // An empty legacy array is still a no-op (the frozen "absent override" rule).
  assert.deepEqual(evaluate([]).rows, evaluate(undefined).rows);
  assert.equal(evaluate([]).totalMatched, records.length);
});

test("BASE_FILTER_OPERATORS keeps every pre-G3 operator and only adds the G4 seven", () => {
  const preG3 = ["is", "is-not", "contains", "starts-with", "ends-with", "lt", "lte", "gt", "gte", "is-empty", "is-not-empty"];
  for (const op of preG3) assert.ok(BASE_FILTER_OPERATORS.includes(op), `${op} must stay supported`);
  const added = BASE_FILTER_OPERATORS.filter((op) => !preG3.includes(op));
  assert.deepEqual([...added].sort(), ["contains-all", "contains-any", "has-link", "has-property", "has-tag", "in-folder", "matches"]);
});

// ── 4. G4 operator reconciliation, positive AND negative case each ─────────
test("contains-any / contains-all reconcile with the desktop varargs functions", () => {
  const list = { key: "file.tags", op: "contains-any", value: ["work", "zzz"] };
  const all = { key: "file.tags", op: "contains-all", value: ["work", "zzz"] };
  // `contains-any(["work","zzz"])`: Alpha carries work.
  assert.equal(evaluateBaseCondition(list, records[0], {}), true);
  // negative: an unrelated needle only.
  assert.equal(evaluateBaseCondition({ ...list, value: ["zzz"] }, records[0], {}), false);
  assert.equal(evaluateBaseCondition(all, records[0], {}), false);
  assert.equal(evaluateBaseCondition({ ...all, value: ["work"] }, records[0], {}), true);
  // A scalar needle is accepted (single-value form of the same function).
  assert.equal(evaluateBaseCondition({ key: "file.tags", op: "contains-any", value: "work" }, records[0], {}), true);
});

test("matches is a regular expression over the cell text", () => {
  const condition = { key: "status", op: "matches", value: "^act" };
  assert.equal(evaluateBaseCondition(condition, records[0], {}), true);
  assert.equal(evaluateBaseCondition(condition, records[1], {}), false);
  // Case sensitivity follows RegExp (desktop passes the pattern through).
  assert.equal(evaluateBaseCondition({ ...condition, value: "^ACT" }, records[0], {}), false);
  // An invalid pattern fails closed with a stable code, never "no rows match".
  assert.throws(
    () => evaluateBaseCondition({ ...condition, value: "(" }, records[0], {}),
    (error) => error instanceof BaseQueryError && error.code === "invalid-schema",
  );
  // Formula cells are matched through the same projected-cell seam.
  const formulas = compileBaseFormulas({ note: "file.asLink(status)" });
  assert.equal(evaluateBaseCondition({ key: "formula.note", op: "matches", value: "done" }, records[1], formulas), true);
});

test("has-tag / has-link / in-folder reuse the expression layer's file.* rules", () => {
  // has-tag strips a leading '#' and is exact (the documented D1 non-nesting).
  assert.equal(evaluateBaseCondition({ key: "file.tags", op: "has-tag", value: "#work" }, records[0], {}), true);
  assert.equal(evaluateBaseCondition({ key: "file.tags", op: "has-tag", value: "work" }, records[0], {}), true);
  assert.equal(evaluateBaseCondition({ key: "file.tags", op: "has-tag", value: "work" }, records[2], {}), false);
  // has-link accepts the basename or the '*.md' target.
  assert.equal(evaluateBaseCondition({ key: "file.links", op: "has-link", value: "Beta" }, records[0], {}), true);
  assert.equal(evaluateBaseCondition({ key: "file.links", op: "has-link", value: "Beta.md" }, records[0], {}), true);
  assert.equal(evaluateBaseCondition({ key: "file.links", op: "has-link", value: "Beta" }, records[1], {}), false);
  // in-folder is a prefix match on the record path, subfolders included.
  assert.equal(evaluateBaseCondition({ key: "file.path", op: "in-folder", value: "Archive" }, records[2], {}), true);
  assert.equal(evaluateBaseCondition({ key: "file.path", op: "in-folder", value: "Archive/" }, records[1], {}), true);
  assert.equal(evaluateBaseCondition({ key: "file.path", op: "in-folder", value: "Archive" }, records[0], {}), false);
  // Prefix must stop at a folder boundary ("Arch" is not "Archive").
  assert.equal(evaluateBaseCondition({ key: "file.path", op: "in-folder", value: "Arch" }, records[1], {}), false);
});

test("has-property reads the property name from the condition key", () => {
  assert.equal(evaluateBaseCondition({ key: "status", op: "has-property" }, records[0], {}), true);
  assert.equal(evaluateBaseCondition({ key: "missing", op: "has-property" }, records[0], {}), false);
  // A declared-but-null property is still declared (desktop: props.keys()).
  assert.equal(evaluateBaseCondition({ key: "status", op: "has-property" }, record("X", { status: null }), {}), true);
  // file.* builtins count as present when they resolve.
  assert.equal(evaluateBaseCondition({ key: "file.path", op: "has-property" }, records[0], {}), true);
  assert.equal(evaluateBaseCondition({ key: "file.backlinks", op: "has-property" }, records[0], {}), false);
  // Record-operand operators are not gated by the view-column set.
  assert.deepEqual(BASE_FILTER_RECORD_OPERATORS, ["has-property", "has-link", "in-folder", "has-tag"]);
});

// ── 5. negative controls ───────────────────────────────────────────────────
test("negative control: evaluating an `or` group as `and` must be observable", () => {
  const group = { or: [{ key: "status", op: "is", value: "done" }, { key: "score", op: "gt", value: 8 }] };
  const orRows = paths(evaluate(group));
  const asAndRows = paths(evaluate({ and: group.or }));
  assert.notDeepEqual(orRows, asAndRows);
  assert.deepEqual(orRows, ["WB/Alpha.md", "Archive/Bravo.md"]);
  assert.deepEqual(asAndRows, []);
});

test("negative control: evaluating a `not` group as `and` must be observable", () => {
  const items = [{ key: "status", op: "is", value: "done" }, { key: "score", op: "gt", value: 8 }];
  assert.deepEqual(paths(evaluate({ not: items })), ["Archive/Deep/Echo.md"]);
  assert.deepEqual(paths(evaluate({ and: items })), []);
  assert.deepEqual(paths(evaluate({ or: items })), ["WB/Alpha.md", "Archive/Bravo.md"]);
});
