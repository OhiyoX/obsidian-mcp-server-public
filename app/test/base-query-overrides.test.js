// Canonical A1 service tests for the frozen Web Base overrides
// (`sortOverride` / `filterExtra` / `textQuery`, D-PARITY-PLAN).
//
// Proves:
//   - each override is additive and optional: an absent/empty override is a
//     byte-for-byte no-op (the MCP `query_base` path passes none of them);
//   - sortOverride reuses the canonical comparator (asc/desc, Chinese, numbers,
//     missing values, path tie-break, formula columns) by comparing against the
//     equivalent `view.sort` evaluation;
//   - every filter operator, and the key-membership / unknown-operator fail-closed
//     behavior.
import assert from "node:assert/strict";
import test from "node:test";

const { evaluateBaseView, evaluateBaseCondition, evaluateBaseFilterTree, queryBaseSnapshot, BaseQueryError, BASE_FILTER_OPERATORS } =
  await import("../src/base-query.js");
const { compileBaseFormulas } = await import("../src/base-formulas.js");
const { parseBaseFilter } = await import("../src/app/base-params.js");

function record(name, frontmatter = {}, extra = {}) {
  return {
    path: `WB/${name}.md`,
    basename: name,
    frontmatter,
    tags: extra.tags ?? [],
    links: (extra.links ?? []).map((target) => ({ target })),
    stat: {
      size: extra.size ?? 1,
      created: extra.created ?? "2026-01-01T00:00:00Z",
      modified: extra.modified ?? "2026-01-01T00:00:00Z",
    },
  };
}

const records = [
  record("Zulu", { title: "苹果", score: 10, status: "active", list: ["red", "blue"], meta: { depth: 2 } }, { links: ["One"], tags: ["topic/red"] }),
  record("Alpha", { title: "香蕉", score: 10, status: "done" }, { links: [] }),
  record("Mike", { title: "cherry", score: 2, status: "active" }, { links: [] }),
  record("Bravo", { score: null, status: "" }, { links: [] }),
  record("Echo", { title: "2026", status: "deferred" }, { links: [] }),
];

const order = ["file.name", "status", "score", "title", "list", "meta"];
const base = { views: [{ type: "table", name: "V", order }] };
const view = base.views[0];
const evaluate = (overrides) => evaluateBaseView({ base, view, order, formulas: {}, records, ...overrides });

test("an absent or empty override is a no-op (MCP path unaffected)", () => {
  const baseline = evaluate({});
  for (const noop of [{ sortOverride: [] }, { filterExtra: [] }, { textQuery: "" }, { sortOverride: [], filterExtra: [], textQuery: "" }]) {
    assert.deepEqual(evaluate(noop), baseline, JSON.stringify(noop));
  }
});

test("sortOverride asc/desc reuses the canonical comparator and path tie-break", () => {
  // Missing values sort last in both directions; score ties fall back to path.
  const asc = evaluate({ sortOverride: [{ key: "score", dir: "asc" }] });
  assert.deepEqual(
    asc.rows.map((row) => row.path),
    ["WB/Mike.md", "WB/Alpha.md", "WB/Zulu.md", ...["WB/Bravo.md", "WB/Echo.md"]],
  );

  const desc = evaluate({ sortOverride: [{ key: "score", dir: "desc" }] });
  assert.deepEqual(
    desc.rows.map((row) => row.path),
    ["WB/Alpha.md", "WB/Zulu.md", "WB/Mike.md", "WB/Bravo.md", "WB/Echo.md"],
  );

  // Byte-for-byte identical to the canonical `view.sort` evaluation.
  const canonical = evaluateBaseView({
    base,
    view: { ...view, sort: [{ property: "score", direction: "ASC" }] },
    order,
    formulas: {},
    records,
  });
  assert.deepEqual(asc.rows, canonical.rows);
  assert.deepEqual(asc.columns, canonical.columns);
});

test("sortOverride handles Chinese values and a missing dir defaults to asc", () => {
  const chinese = evaluate({ sortOverride: [{ key: "title", dir: "asc" }] });
  const canonical = evaluateBaseView({
    base,
    view: { ...view, sort: [{ property: "title", direction: "ASC" }] },
    order,
    formulas: {},
    records,
  });
  assert.deepEqual(chinese.rows, canonical.rows);

  const defaulted = evaluate({ sortOverride: [{ key: "score" }] });
  assert.deepEqual(
    defaulted.rows.map((row) => row.path),
    ["WB/Mike.md", "WB/Alpha.md", "WB/Zulu.md", "WB/Bravo.md", "WB/Echo.md"],
  );
});

test("sortOverride supports formula columns via the canonical comparator", () => {
  const formulas = compileBaseFormulas({ note: "file.asLink(title)" });
  const withFormula = { base: { views: [{ type: "table", name: "V", order: ["formula.note", "file.name"] }] } };
  const formulaOrder = withFormula.base.views[0].order;
  const result = evaluateBaseView({
    base: withFormula.base,
    view: withFormula.base.views[0],
    order: formulaOrder,
    formulas,
    records,
    sortOverride: [{ key: "formula.note", dir: "asc" }],
  });
  // asLink displayName falls back to the file basename when `title` is absent.
  const canonical = evaluateBaseView({
    base: withFormula.base,
    view: { ...withFormula.base.views[0], sort: [{ property: "formula.note", direction: "ASC" }] },
    order: formulaOrder,
    formulas,
    records,
  });
  assert.deepEqual(result.rows, canonical.rows);
});

test("every frozen filter operator evaluates against the projected cell", () => {
  // `lt`/`lte` mirror the canonical `compare(...)` (`left < right`), where a
  // missing value still satisfies `null < 10` / `null <= 10`. The matrix proves
  // the canonical semantics rather than a second, stricter one.
  const cases = [
    [{ key: "status", op: "is", value: "active" }, ["Zulu", "Mike"]],
    [{ key: "status", op: "is-not", value: "active" }, ["Alpha", "Bravo", "Echo"]],
    [{ key: "title", op: "contains", value: "苹" }, ["Zulu"]],
    [{ key: "title", op: "starts-with", value: "ch" }, ["Mike"]],
    [{ key: "title", op: "ends-with", value: "26" }, ["Echo"]],
    [{ key: "score", op: "lt", value: 10 }, ["Mike", "Bravo"]],
    [{ key: "score", op: "lte", value: 10 }, ["Zulu", "Alpha", "Mike", "Bravo"]],
    [{ key: "score", op: "gt", value: 2 }, ["Zulu", "Alpha"]],
    [{ key: "score", op: "gte", value: 10 }, ["Zulu", "Alpha"]],
    [{ key: "status", op: "is-empty", value: null }, ["Bravo"]],
    [{ key: "score", op: "is-not-empty", value: null }, ["Zulu", "Alpha", "Mike"]],
    // G4: the desktop simple-builder function table reduced to this vocabulary.
    // Cell-operand: `containsAny`/`containsAll` (varargs needles), `matches`.
    [{ key: "list", op: "contains-any", value: ["green", "red"] }, ["Zulu"]],
    [{ key: "list", op: "contains-all", value: ["red", "blue"] }, ["Zulu"]],
    [{ key: "title", op: "matches", value: "^[a-z]+$" }, ["Mike"]],
    // Record-operand: `hasProperty` reads the property name from `key`, the other
    // three are the expression layer's own `file.*` rules.
    [{ key: "meta", op: "has-property" }, ["Zulu"]],
    [{ key: "file.path", op: "has-link", value: "One" }, ["Zulu"]],
    [{ key: "file.path", op: "in-folder", value: "WB" }, ["Zulu", "Alpha", "Mike", "Bravo", "Echo"]],
    [{ key: "file.path", op: "has-tag", value: "#topic/red" }, ["Zulu"]],
  ];
  assert.deepEqual(
    cases.map(([condition]) => condition.op),
    BASE_FILTER_OPERATORS,
    "the matrix covers the frozen operator list in order",
  );
  for (const [condition, expected] of cases) {
    const result = evaluate({ filterExtra: [condition] });
    assert.deepEqual([...result.rows.map((row) => row.path.slice(3, -3))].sort(), [...expected].sort(), JSON.stringify(condition));
  }
});

test("filterExtra is AND-combined and appended after base/view filters", () => {
  const filtered = { ...view, filters: { or: ['status == "active"', 'status == "done"'] } };
  const result = evaluateBaseView({
    base,
    view: filtered,
    order,
    formulas: {},
    records,
    filterExtra: [{ key: "score", op: "gte", value: 10 }],
  });
  assert.deepEqual(result.rows.map((row) => row.path), ["WB/Zulu.md", "WB/Alpha.md"]);
  assert.equal(result.totalMatched, 2);
});

test("textQuery matches across columns, case-insensitively, including array and object cells", () => {
  const cases = [
    ["zulu", ["WB/Zulu.md"]], // file.name
    ["苹果", ["WB/Zulu.md"]], // Chinese title
    ["CHERRY", ["WB/Mike.md"]], // case-insensitive
    ["deferred", ["WB/Echo.md"]],
    ["blue", ["WB/Zulu.md"]], // array join
    ["depth: 2", ["WB/Zulu.md"]], // object safe summary
    // `q` is scoped to the view's columns: file.path is not one of them here.
    ["wb/", []],
    ["apple", []],
  ];
  for (const [needle, expected] of cases) {
    const result = evaluate({ textQuery: needle });
    assert.deepEqual(result.rows.map((row) => row.path), expected, needle);
  }
});

test("textQuery searches structured asLink displayName and path", () => {
  const formulas = compileBaseFormulas({ note: "file.asLink(title)" });
  const linkBase = { views: [{ type: "table", name: "V", order: ["formula.note"] }] };
  const linkView = linkBase.views[0];
  const search = (textQuery) =>
    evaluateBaseView({ base: linkBase, view: linkView, order: ["formula.note"], formulas, records, textQuery });
  // Zulu has a title -> displayName "苹果"; Bravo has none -> basename fallback.
  assert.deepEqual(search("苹果").rows.map((row) => row.path), ["WB/Zulu.md"]);
  assert.deepEqual(search("bravo").rows.map((row) => row.path), ["WB/Bravo.md"]);
  assert.deepEqual(search("WB/Zulu.md").rows.map((row) => row.path), ["WB/Zulu.md"]);
});

test("textQuery combines with sortOverride and filterExtra", () => {
  const result = evaluate({
    filterExtra: [{ key: "status", op: "is", value: "active" }],
    textQuery: "a",
    sortOverride: [{ key: "file.name", dir: "desc" }],
  });
  // status=active => Zulu/Mike; "a" matches their basenames/paths.
  assert.deepEqual(result.rows.map((row) => row.path), ["WB/Zulu.md", "WB/Mike.md"]);
});

test("an override key outside the view column set fails closed as unsupported", () => {
  for (const overrides of [
    { sortOverride: [{ key: "priority", dir: "asc" }] },
    { filterExtra: [{ key: "priority", op: "is", value: "P1" }] },
  ]) {
    assert.throws(
      () => evaluate(overrides),
      (error) => error instanceof BaseQueryError && error.code === "unsupported",
      JSON.stringify(overrides),
    );
  }
});

test("an unknown filter operator fails closed as unsupported", () => {
  assert.throws(
    () => evaluateBaseCondition({ key: "status", op: "like", value: "a" }, records[0], {}),
    (error) => error instanceof BaseQueryError && error.code === "unsupported",
  );
});

test("queryBaseSnapshot passes the overrides through without changing the DTO shape", () => {
  const raw = ["views:", "  - type: table", "    name: V", "    order: [file.name, score]", ""].join("\n");
  const baseline = queryBaseSnapshot({ raw, records });
  const overridden = queryBaseSnapshot({
    raw,
    records,
    sortOverride: [{ key: "score", dir: "desc" }],
    filterExtra: [{ key: "score", op: "gte", value: 10 }],
    textQuery: "a",
  });
  assert.deepEqual(Object.keys(overridden).sort(), Object.keys(baseline).sort());
  assert.deepEqual(overridden.rows.map((row) => row.path), ["WB/Alpha.md"]);
  assert.equal(overridden.totalMatched, 1);
  assert.equal(overridden.view, "V");
});

test("path tie-break order is stable across pages when evaluated with a growing prefix limit", () => {
  const sortOverride = [{ key: "score", dir: "asc" }];
  const full = evaluate({ sortOverride });
  const page = (offset, pageSize) => {
    const prefix = evaluate({ sortOverride, limit: offset + pageSize });
    return prefix.rows.slice(offset, offset + pageSize);
  };
  const concatenated = [...page(0, 2), ...page(2, 2), ...page(4, 2)];
  assert.deepEqual(concatenated.map((row) => row.path), full.rows.map((row) => row.path));
  assert.deepEqual(full.rows.map((row) => row.path), ["WB/Mike.md", "WB/Alpha.md", "WB/Zulu.md", "WB/Bravo.md", "WB/Echo.md"]);
  assert.equal(evaluate({ sortOverride, limit: 2 }).truncated, true);
  assert.equal(evaluate({ sortOverride, limit: 2 }).totalMatched, 5);
});

// ── review round 2: F2 (contains-any/all case) and F3 (empty groups) ────────

test("F2: contains-any / contains-all lowercase string operands like the desktop", () => {
  // Desktop string variants (app.js@2225713 / @2226000) lowercase BOTH sides:
  // `i=e.data.toLowerCase(); i.includes(e.data.toLowerCase())`.
  const work = record("Work", { title: "Work", list: ["Work"] });
  assert.equal(evaluateBaseCondition({ key: "title", op: "contains-any", value: "work" }, work, {}), true);
  assert.equal(evaluateBaseCondition({ key: "title", op: "contains-all", value: ["WORK", "ork"] }, work, {}), true);
  assert.equal(evaluateBaseCondition({ key: "title", op: "contains-any", value: "zzz" }, work, {}), false);
  // The LIST variant is `list.includes(value)` on the desktop (app.js@2226133):
  // exact and case-sensitive. It must NOT inherit the string lowering.
  assert.equal(evaluateBaseCondition({ key: "list", op: "contains-any", value: "work" }, work, {}), false);
  assert.equal(evaluateBaseCondition({ key: "list", op: "contains-any", value: "Work" }, work, {}), true);
  assert.equal(evaluateBaseCondition({ key: "list", op: "contains-all", value: ["work"] }, work, {}), false);
});

test("F3: empty groups agree between the HTTP parser and the evaluator", () => {
  const allPaths = evaluate({}).rows.map((row) => row.path);

  // `{"or":[]}` is the empty union = no rows. The HTTP layer must not collapse
  // it to `null` ("no override" = all rows); it passes the tree through and the
  // evaluator decides, exactly like an in-document `filters:` tree.
  const orGroup = parseBaseFilter('{"or":[]}');
  assert.deepEqual(orGroup, { or: [] });
  assert.deepEqual(evaluate({ filterExtra: orGroup }).rows, []);
  assert.equal(evaluateBaseFilterTree({ or: [] }, records[0], {}), false);

  // Empty `and` / `not` are the empty intersection = all rows in both layers.
  for (const raw of ['{"and":[]}', '{"not":[]}']) {
    const group = parseBaseFilter(raw);
    assert.deepEqual(evaluate({ filterExtra: group }).rows.map((row) => row.path), allPaths, raw);
  }
  assert.equal(evaluateBaseFilterTree({ and: [] }, records[0], {}), true);
  assert.equal(evaluateBaseFilterTree({ not: [] }, records[0], {}), true);

  // The legacy empty AND list stays the frozen "no override".
  assert.equal(parseBaseFilter("[]"), null);
  assert.deepEqual(evaluate({ filterExtra: parseBaseFilter("[]") }), evaluate({}));
});
