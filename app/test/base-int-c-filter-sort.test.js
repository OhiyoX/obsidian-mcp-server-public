// Bases P1 / INT-C — typed `formula.*` participation in a Base's own filters / sort.
//
// Scope:
//   1. `formula.<name>` filter conditions use the P1-A typed comparison
//      (app/src/base-values.js): `==` / `!=` are strict (`number` ≠ `string`),
//      ordering is typed, and an empty side is stably false;
//   2. `formula.<name>` sort keys use the P1-A typed total order
//      (`compareBaseValues`) with the frozen `file.path` tie-break, while mixed
//      sort lists keep the declared key priority (typed and P0 keys interleaved);
//   3. `list` / `object` formula values and cross-type orderings fail closed;
//   4. `formula.*` in `view.groupBy` stays unsupported (the renamed INT-C guard);
//   5. P0 zero regression: non-formula filters keep the historical `String()`
//      coercion, non-formula sorts keep the historical null-last / localeCompare
//      comparator, and a `"formula.x"` literal is never misrouted to the typed path.
//
// Self-contained (injected records, no vault, no MCP), mirroring
// app/test/base-query-overrides.test.js.
import assert from "node:assert/strict";
import test from "node:test";

const { BaseQueryError, queryBaseSnapshot } = await import("../src/base-query.js");
const { assertNoFormulaReferencesInGroupBy } = await import("../src/base-formulas.js");

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

// `score`: 7 / null / absent / 9 covers number + null + missing in one column;
// `title` is absent on Two and Three (missing), `tags` / `meta` cover list/object.
const RECORDS = [
  record("One", { status: "active", rank: 30, score: 7, title: "One" }),
  record("Two", { status: "active", rank: 5, score: null, tags: ["a", "b"], meta: { k: 1 } }),
  record("Three", { status: "done", rank: 8, tags: [], meta: {} }),
  record("Four", { status: "active", rank: 2, score: 9, title: "Aaa", tags: ["c"], meta: { k: 2 } }),
];

const ALL = ["WB/One.md", "WB/Two.md", "WB/Three.md", "WB/Four.md"];

// `filterLines` are raw YAML lines so both the string and the and/or object form
// can be expressed exactly as a `.base` would spell them.
function baseDocument({ formulas = {}, filterLines = [], sort = null, groupBy = null, order = ["file.path"] } = {}) {
  const lines = [...filterLines];
  const names = Object.keys(formulas);
  if (names.length) {
    lines.push("formulas:");
    for (const name of names) lines.push(`  ${name}: '${formulas[name]}'`);
  }
  lines.push("views:", "  - type: table", "    name: Main");
  if (sort) {
    lines.push("    sort:");
    for (const item of sort) lines.push(`      - property: ${item.property}`, `        direction: ${item.direction}`);
  }
  if (groupBy) lines.push(`    groupBy: ${groupBy}`);
  lines.push("    order:");
  for (const key of order) lines.push(`      - ${key}`);
  return `${lines.join("\n")}\n`;
}

function query(options, records = RECORDS) {
  return queryBaseSnapshot({ raw: baseDocument(options), records });
}

function errorOf(options, records = RECORDS) {
  try {
    query(options, records);
  } catch (error) {
    return error;
  }
  return null;
}

function paths(result) {
  return result.rows.map((row) => row.path);
}

test("typed filter equality: `== 2` matches, `== \"2\"` does not (contract §8)", () => {
  const base = { formulas: { x: "file.asLink(1 + 1)" } };
  // `formula.x` is the number 2 for every record; the quoted literal is a string.
  assert.deepEqual(paths(query({ ...base, filterLines: [`filters: 'formula.x == 2'`] })), ALL);
  assert.deepEqual(paths(query({ ...base, filterLines: [`filters: 'formula.x == "2"'`] })), []);
  assert.deepEqual(paths(query({ ...base, filterLines: [`filters: 'formula.x != "2"'`] })), ALL);
});

test("a formula expression participates in filter comparison (note.rank * 2)", () => {
  const base = { formulas: { double: "file.asLink(note.rank * 2)" } };
  assert.deepEqual(paths(query({ ...base, filterLines: ["filters: 'formula.double > 10'"] })), ["WB/One.md", "WB/Three.md"]);
  assert.deepEqual(paths(query({ ...base, filterLines: ["filters: 'formula.double <= 10'"] })), ["WB/Two.md", "WB/Four.md"]);
});

test("formula conditions mix with P0 conditions through and / or", () => {
  const base = { formulas: { x: "file.asLink(1 + 1)" } };
  const andLines = ["filters:", "  and:", `    - 'status == "active"'`, `    - 'formula.x == 2'`];
  assert.deepEqual(paths(query({ ...base, filterLines: andLines })), ["WB/One.md", "WB/Two.md", "WB/Four.md"]);
  const orLines = ["filters:", "  or:", `    - 'formula.x == "2"'`, "    - 'rank > 20'"];
  assert.deepEqual(paths(query({ ...base, filterLines: orLines })), ["WB/One.md"]);
});

test("an empty formula side is stably false, never coerced to \"\"", () => {
  const base = { formulas: { label: "file.asLink(title)" } };
  // Four ("Aaa") matches `< "M"`; the missing titles on Two / Three must not.
  assert.deepEqual(paths(query({ ...base, filterLines: [`filters: 'formula.label < "M"'`] })), ["WB/Four.md"]);
  assert.deepEqual(paths(query({ ...base, filterLines: [`filters: 'formula.label > "M"'`] })), ["WB/One.md"]);
});

test("cross-type ordering fails closed with no coercion (option A)", () => {
  const base = { formulas: { num: "file.asLink(note.rank)" } };
  const error = errorOf({ ...base, filterLines: [`filters: 'formula.num > "10"'`] });
  assert.ok(error instanceof BaseQueryError);
  assert.equal(error.code, "unsupported");
  assert.match(error.message, /cannot compare number and string/);
  // The same comparison against a number literal is typed and succeeds.
  assert.deepEqual(paths(query({ ...base, filterLines: ["filters: 'formula.num > 10'"] })), ["WB/One.md"]);
});

test("list / object formula values fail closed in filter ordering and in sort", () => {
  const base = { formulas: { tags: "file.asLink(tags)" } };
  // `==` is typed deep equality against a non-list => false, not an error.
  assert.deepEqual(paths(query({ ...base, filterLines: ["filters: 'formula.tags == 1'"] })), []);
  const filterError = errorOf({ ...base, filterLines: ["filters: 'formula.tags > 1'"] });
  assert.equal(filterError.code, "unsupported");
  assert.match(filterError.message, /cannot compare list and number/);
  const sortError = errorOf({ ...base, sort: [{ property: "formula.tags", direction: "ASC" }] });
  assert.equal(sortError.code, "unsupported");
  assert.match(sortError.message, /not supported in view sort for list values/);

  const obj = { formulas: { meta: "file.asLink(meta)" } };
  const objSort = errorOf({ ...obj, sort: [{ property: "formula.meta", direction: "DESC" }] });
  assert.equal(objSort.code, "unsupported");
  assert.match(objSort.message, /not supported in view sort for object values/);
});

test("typed sort uses the P1-A total order (empty side smallest, B6#2)", () => {
  // `score` is 7 / null / missing / 9. P1-A TYPE_RANK puts missing+null on the
  // smallest side (unlike the P0 comparator, which keeps nulls last); equal
  // values fall back to the frozen `file.path` tie-break.
  const base = { formulas: { score: "file.asLink(score)" } };
  assert.deepEqual(
    paths(query({ ...base, sort: [{ property: "formula.score", direction: "ASC" }] })),
    ["WB/Three.md", "WB/Two.md", "WB/One.md", "WB/Four.md"],
  );
  assert.deepEqual(
    paths(query({ ...base, sort: [{ property: "formula.score", direction: "DESC" }] })),
    ["WB/Four.md", "WB/One.md", "WB/Three.md", "WB/Two.md"],
  );
});

test("mixed sort keys keep the declared priority in both directions", () => {
  const base = { formulas: { score: "file.asLink(score)" } };
  // Typed primary, P0 secondary: the empty scores tie on the typed key, so
  // `status` decides (active < done) => Two before Three.
  assert.deepEqual(
    paths(query({ ...base, sort: [{ property: "formula.score", direction: "ASC" }, { property: "status", direction: "ASC" }] })),
    ["WB/Two.md", "WB/Three.md", "WB/One.md", "WB/Four.md"],
  );
  // P0 primary, typed secondary: the P0 key outranks the typed key, so the
  // `done` record stays last even though its formula value is empty.
  assert.deepEqual(
    paths(query({ ...base, sort: [{ property: "status", direction: "ASC" }, { property: "formula.score", direction: "ASC" }] })),
    ["WB/Two.md", "WB/One.md", "WB/Four.md", "WB/Three.md"],
  );
});

test("a mixed sort with a constant formula key matches the P0-only sort", () => {
  // Proves the P0 per-key comparison reused by the mixed path is byte-compatible
  // with `sortBaseRecords` (here: numbers first, then empty values last, then path).
  const p0 = query({ sort: [{ property: "score", direction: "ASC" }] });
  assert.deepEqual(paths(p0), ["WB/One.md", "WB/Four.md", "WB/Three.md", "WB/Two.md"]);
  const mixed = query({ formulas: { one: "file.asLink(1)" }, sort: [{ property: "score", direction: "ASC" }, { property: "formula.one", direction: "ASC" }] });
  assert.deepEqual(paths(mixed), paths(p0));
});

test("undeclared formula in filter / sort fails closed at compile time (empty records)", () => {
  const filterError = errorOf({ filterLines: ["filters: 'formula.nope == 1'"] }, []);
  assert.equal(filterError.code, "unsupported");
  assert.match(filterError.message, /missing formula "nope"/);
  const sortError = errorOf({ sort: [{ property: "formula.nope", direction: "ASC" }] }, []);
  assert.equal(sortError.code, "unsupported");
  assert.match(sortError.message, /missing formula "nope"/);
});

test("an out-of-grammar formula filter condition fails closed", () => {
  const error = errorOf({ formulas: { s: "file.asLink(title)" }, filterLines: [`filters: 'formula.s.contains("a")'`] });
  assert.equal(error.code, "unsupported");
  assert.match(error.message, /Unsupported Base filter expression/);
});

test("a malformed direction on a formula sort key still fails closed", () => {
  const error = errorOf({ formulas: { s: "file.asLink(score)" }, sort: [{ property: "formula.s", direction: "SIDEWAYS" }] });
  assert.equal(error.code, "unsupported");
  assert.match(error.message, /Unsupported Base sort configuration/);
});

test("formula.* in view.groupBy is still unsupported (renamed guard, option B)", () => {
  // End to end: the Wave 0-D known-semantic-key guard rejects any non-empty
  // groupBy, so a formula groupBy stays fail-closed with a `groupBy` message.
  const error = errorOf({ formulas: { x: "file.asLink(1 + 1)" }, groupBy: "formula.x" });
  assert.equal(error.code, "unsupported");
  assert.match(error.message, /groupBy/);
  // The renamed guard itself protects exactly `view.groupBy`.
  assert.throws(() => assertNoFormulaReferencesInGroupBy({ groupBy: { property: "formula.x" } }), /not supported in groupBy/);
  assert.throws(() => assertNoFormulaReferencesInGroupBy({ groupBy: "formula.x" }), /not supported in groupBy/);
  assert.doesNotThrow(() => assertNoFormulaReferencesInGroupBy({ groupBy: { property: "status" } }));
  assert.doesNotThrow(() => assertNoFormulaReferencesInGroupBy({ groupBy: undefined }));
  assert.doesNotThrow(() => assertNoFormulaReferencesInGroupBy({}));
});

test("P0 zero regression: non-formula filters keep the String() coercion", () => {
  // P0 `compare` is `left === right || String(left) === String(right)`.
  assert.deepEqual(paths(query({ filterLines: [`filters: 'rank == "30"'`] })), ["WB/One.md"]);
  assert.deepEqual(paths(query({ filterLines: ["filters: 'rank == 30'"] })), ["WB/One.md"]);
  // A `"formula.x"` string literal is a value, so the condition stays on the P0 path.
  assert.deepEqual(paths(query({ filterLines: [`filters: 'status == "formula.note"'`] })), []);
});
