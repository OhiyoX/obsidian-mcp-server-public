// 刀4 acceptance: `views[].groupBy` × `sort` × `limit` × `views[].summaries`.
//
// One test per item of the frozen checklist in docs/bases/SEMANTICS-FROZEN.md §3
// (C1–C22), each naming the frozen evidence line it pins (P#) or the deliberate
// project narrowing it registers (D#/E#). The frozen pipeline is
//
//   filters -> sort -> limit(global, flat rows) -> groupBy(partition) -> summaries(per group)
//
// so every assertion below is about ORDER, MEMBERSHIP or the ADD-only DTO
// (`groups` / `summaries`), never about a new row set: grouping partitions the
// rows that survived `limit` and never adds, drops or reorders one.
import assert from "node:assert/strict";
import test from "node:test";

const { BaseQueryError, parseAndValidateBase, queryBaseSnapshot } = await import("../src/base-query.js");

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

// Five rows. `status` has one missing value (the keyless group), `score` is
// unique per row (so a sort key is also a row identity in the assertions).
const RECORDS = Object.freeze([
  record("Alpha", { status: "active", score: 8, flag: true, mix: "", tag: 1 }),
  record("Bravo", { status: "done", score: 3, flag: false, mix: 0, tag: "1" }),
  record("Delta", { status: "active", score: 5, flag: true, mix: false }),
  record("Echo", { score: 1 }),
  record("Foxtrot", { status: null, score: 0, mix: null, tag: null }),
]);

const VIEW_ORDER = ["file.name", "status", "score"];

function baseYaml({ filter = 'file.inFolder("WB")', top = [], view = [], order = VIEW_ORDER } = {}) {
  return [
    ...(filter === null ? [] : [`filters: ${filter}`]),
    ...top,
    "views:",
    "  - type: table",
    "    name: V",
    `    order: [${order.map((key) => `"${key}"`).join(", ")}]`,
    ...view,
    "",
  ].join("\n");
}

function snapshot(options, records = RECORDS) {
  return queryBaseSnapshot({ raw: baseYaml(options), records });
}

function groupShape(snap) {
  return (snap.groups ?? []).map((group) => [group.key, group.count, group.rowPaths]);
}

function summaryOf(snap, property, groupIndex = null) {
  const values = groupIndex === null ? snap.summaries.values : snap.groups[groupIndex].summaries.values;
  return values[property];
}

// ── C1–C3: 顺序与 limit ────────────────────────────────────────────────────

test("C1: sort runs before limit (P2) — the truncated prefix is the SORTED prefix", () => {
  const snap = snapshot({
    view: ["    sort:", "      - property: score", "        direction: ASC", "    limit: 3"],
  });
  // Sorted by score ASC the first three rows are Foxtrot(0), Echo(1), Bravo(3).
  // "limit first, then sort" would have kept the injected first three rows
  // (Alpha, Bravo, Delta) instead — the two sets differ, and this pins which one.
  assert.deepEqual(snap.rows.map((row) => row.path), ["WB/Foxtrot.md", "WB/Echo.md", "WB/Bravo.md"]);
  assert.equal(snap.totalMatched, 5);
  assert.equal(snap.truncated, true);
});

test("C2: limit applies to flat rows BEFORE grouping (P6/P7) — a group can lose every row", () => {
  const snap = snapshot({
    view: ["    sort:", "      - property: score", "        direction: ASC", "    limit: 4", "    groupBy:", "      property: status"],
  });
  // score ASC keeps Foxtrot(0), Echo(1), Bravo(3), Delta(5): Alpha (8) — the
  // second `active` row — was cut, so the active group only has Delta.
  assert.deepEqual(snap.rows.map((row) => row.path), ["WB/Foxtrot.md", "WB/Echo.md", "WB/Bravo.md", "WB/Delta.md"]);
  assert.deepEqual(groupShape(snap), [
    ["active", 1, ["WB/Delta.md"]],
    ["done", 1, ["WB/Bravo.md"]],
    [null, 2, ["WB/Foxtrot.md", "WB/Echo.md"]],
  ]);
  assert.equal(snap.groups.reduce((total, group) => total + group.count, 0), 4, "only the retained rows are grouped");
});

test("C3: limit: 0 stays fail-closed (D5, deliberate narrowing — desktop 0 = 'Show all')", () => {
  assert.throws(
    () => parseAndValidateBase(baseYaml({ view: ["    limit: 0"] })),
    (error) => error instanceof BaseQueryError
      && error.code === "invalid-schema"
      && error.message === "Invalid Base: views[0].limit must be a positive integer",
    "desktop treats limit: 0 as UNLIMITED; this project keeps the fail-closed narrowing and registers it in the matrix",
  );
});

// ── C4–C7: 行序与组序 ──────────────────────────────────────────────────────

test("C4: group-internal order IS the sort order (P2/P5/P12)", () => {
  const snap = snapshot({
    view: ["    sort:", "      - property: score", "        direction: DESC", "    groupBy:", "      property: status"],
  });
  assert.deepEqual(groupShape(snap), [
    ["active", 2, ["WB/Alpha.md", "WB/Delta.md"]],
    ["done", 1, ["WB/Bravo.md"]],
    [null, 2, ["WB/Echo.md", "WB/Foxtrot.md"]],
  ]);
  // Concatenating the groups in group order reproduces the flat sort order.
  assert.deepEqual(
    (snap.groups ?? []).flatMap((group) => group.rowPaths),
    ["WB/Alpha.md", "WB/Delta.md", "WB/Bravo.md", "WB/Echo.md", "WB/Foxtrot.md"],
  );
});

test("C5: groupBy.direction moves GROUPS only — the row sets are identical (P9)", () => {
  const asc = snapshot({ view: ["    groupBy:", "      property: status"] });
  const desc = snapshot({ view: ["    groupBy:", "      property: status", "      direction: DESC"] });
  assert.deepEqual(groupShape(asc), [["active", 2, ["WB/Alpha.md", "WB/Delta.md"]], ["done", 1, ["WB/Bravo.md"]], [null, 2, ["WB/Echo.md", "WB/Foxtrot.md"]]]);
  assert.deepEqual(groupShape(desc), [["done", 1, ["WB/Bravo.md"]], ["active", 2, ["WB/Alpha.md", "WB/Delta.md"]], [null, 2, ["WB/Echo.md", "WB/Foxtrot.md"]]]);
  assert.deepEqual(desc.rows, asc.rows, "row order never follows groupBy.direction");
});

test("C6: the keyless (null) group is LAST in both directions (D1, asar P10/P11)", () => {
  const asc = snapshot({ view: ["    groupBy:", "      property: status"] });
  const desc = snapshot({ view: ["    groupBy:", "      property: status", "      direction: DESC"] });
  assert.equal(asc.groups.at(-1).key, null);
  assert.equal(asc.groups.at(-1).keyType, "null");
  assert.equal(desc.groups.at(-1).key, null);
  assert.equal(asc.groups.at(-1).count, 2, "missing (Echo) and explicit null (Foxtrot) are ONE group");
});

test("C7: an empty sort value sorts last in BOTH directions (P4)", () => {
  for (const direction of ["ASC", "DESC"]) {
    const snap = snapshot({ order: ["file.name", "tag"], view: ["    sort:", "      - property: tag", `        direction: ${direction}`] });
    // `tag` is 1 (Alpha), "1" (Bravo), null (Foxtrot) and missing (Delta, Echo).
    assert.deepEqual(snap.rows.slice(-3).map((row) => row.path).sort(), ["WB/Delta.md", "WB/Echo.md", "WB/Foxtrot.md"], `${direction}: empty values last`);
    assert.deepEqual(snap.rows.slice(0, 2).map((row) => row.path).sort(), ["WB/Alpha.md", "WB/Bravo.md"], `${direction}: non-empty values first`);
  }
});

// ── C8–C10: summaries 的作用域 ─────────────────────────────────────────────

test("C8: summaries are computed PER GROUP (P15) and differ from the whole-view value", () => {
  const snap = snapshot({
    top: ["properties:", "  status:", '    displayName: "Status"'],
    view: ["    groupBy:", "      property: status", "    summaries:", "      score: Average", "      file.name: Unique"],
  });
  assert.deepEqual(summaryOf(snap, "score", 0), { summary: "Average", value: 6.5, reason: null });
  assert.deepEqual(summaryOf(snap, "score", 1), { summary: "Average", value: 3, reason: null });
  assert.deepEqual(summaryOf(snap, "file.name", 0), { summary: "Unique", value: 2, reason: null });
  // The top-level map is the whole retained set (P8), i.e. (8+3+5+1+0)/5.
  assert.deepEqual(summaryOf(snap, "score"), { summary: "Average", value: 3.4, reason: null });
});

test("C9: summaries are POST-limit (P16/E3): a truncated group vanishes, a cut group aggregates what is left", () => {
  const snap = snapshot({
    view: [
      "    sort:", "      - property: score", "        direction: ASC",
      "    limit: 3",
      "    groupBy:", "      property: status",
      "    summaries:", "      score: Sum",
    ],
  });
  assert.deepEqual(snap.rows.map((row) => row.path), ["WB/Foxtrot.md", "WB/Echo.md", "WB/Bravo.md"]);
  assert.deepEqual(groupShape(snap).map(([key, count]) => [key, count]), [["done", 1], [null, 2]]);
  assert.deepEqual(summaryOf(snap, "score", 0), { summary: "Sum", value: 3, reason: null }, "the done group sums its retained row");
  assert.deepEqual(summaryOf(snap, "score"), { summary: "Sum", value: 4, reason: null }, "0 + 1 + 3");
  assert.equal(snap.truncated, true);
});

test("C10: without groupBy the whole retained set is ONE keyless group (P8)", () => {
  const snap = snapshot({ view: ["    summaries:", "      score: Sum"] });
  assert.equal(snap.groups.length, 1);
  assert.deepEqual(groupShape(snap)[0], [null, 5, ["WB/Alpha.md", "WB/Bravo.md", "WB/Delta.md", "WB/Echo.md", "WB/Foxtrot.md"]]);
  assert.deepEqual(snap.groups[0].summaries, snap.summaries, "the single group and the view-wide map are the same computation");

  const limited = snapshot({ view: ["    limit: 2", "    summaries:", "      score: Sum"] });
  assert.deepEqual(summaryOf(limited, "score"), { summary: "Sum", value: 11, reason: null });
});

// ── C11–C15: 内置 summary 值语义 ───────────────────────────────────────────

test("C11: Empty/Filled only count isType('null') — \"\", 0 and false are VALUES (D3/P18/P20)", () => {
  const snap = snapshot({ order: ["file.name", "mix"], view: ["    summaries:", "      mix: Empty"] });
  // `mix` is "" (Alpha), 0 (Bravo), false (Delta), missing (Echo), null (Foxtrot).
  assert.deepEqual(summaryOf(snap, "mix"), { summary: "Empty", value: 2, reason: null }, "only missing + null are Empty");
  // A property outside `order` is reported explicitly instead of being dropped (E8).
  const offColumn = snapshot({ view: ["    summaries:", "      mix2: Filled"] });
  assert.deepEqual(summaryOf(offColumn, "mix2"), { summary: "Filled", value: null, reason: "not-a-column" });
  const filled = snapshot({ order: ["file.name", "mix"], view: ["    summaries:", "      mix: Filled"] });
  assert.deepEqual(summaryOf(filled, "mix"), { summary: "Filled", value: 3, reason: null });
});

test("C12: Unique is TYPED (D4/P21) — 1 and \"1\" are distinct, every empty value is one", () => {
  const snap = snapshot({ order: ["file.name", "tag"], view: ["    summaries:", "      tag: Unique"] });
  // tag: 1 (Alpha), "1" (Bravo), missing (Delta, Echo), null (Foxtrot) ⇒ 3.
  assert.deepEqual(summaryOf(snap, "tag"), { summary: "Unique", value: 3, reason: null });
});

test("C13: Stddev is the POPULATION deviation (D2/P19): σ=2, n=1 ⇒ 0, empty ⇒ no value", () => {
  const records = [
    ...["2", "4", "4", "4", "5", "5", "7", "9"].map((value) => record(`N${value}-${Math.random()}`, { grp: "a", num: Number(value) })),
    record("Single", { grp: "b", num: 42 }),
    record("Empty", { grp: "c" }),
  ];
  const snap = snapshot({
    order: ["file.name", "num"],
    view: ["    groupBy:", "      property: grp", "    summaries:", "      num: Stddev"],
  }, records);
  assert.deepEqual(summaryOf(snap, "num", 0), { summary: "Stddev", value: 2, reason: null }, "population σ of [2,4,4,4,5,5,7,9] is 2 (sample would be 2.14)");
  assert.deepEqual(summaryOf(snap, "num", 1), { summary: "Stddev", value: 0, reason: null }, "n=1 ⇒ 0, never null");
  assert.deepEqual(summaryOf(snap, "num", 2), { summary: "Stddev", value: null, reason: "empty" });
});

test("C14: Average/Sum round to 2 decimals, Min/Max/Median/Range do not (P18)", () => {
  const records = [record("A", { num: 1 }), record("B", { num: 2 }), record("C", { num: 2 })];
  const snap = snapshot({
    order: ["file.name", "num"],
    view: [
      "    summaries:",
      "      num: Average",
      "      status: Median",
    ],
  }, records);
  assert.deepEqual(summaryOf(snap, "num"), { summary: "Average", value: 1.67, reason: null });
  assert.deepEqual(summaryOf(snap, "status"), { summary: "Median", value: null, reason: "not-a-column" });

  const numbers = snapshot({ order: ["file.name", "num"], view: ["    summaries:", "      num: Median"] }, records);
  assert.deepEqual(summaryOf(numbers, "num"), { summary: "Median", value: 2, reason: null });

  const thirds = [record("A", { num: 1 }), record("B", { num: 1 }), record("C", { num: 1 }), record("D", { num: 0.1 }), record("E", { num: 0.2 })];
  const sums = snapshot({ order: ["file.name", "num"], view: ["    summaries:", "      num: Sum"] }, thirds);
  assert.deepEqual(summaryOf(sums, "num"), { summary: "Sum", value: 3.3, reason: null }, "float noise is rounded to 2 decimals");
});

test("C15: a type-mismatched group reports an EXPLICIT reason, never a silent empty cell (E10)", () => {
  const records = [record("A", { grp: "mixed", num: 1 }), record("B", { grp: "mixed", num: "text" })];
  const snap = snapshot({
    order: ["file.name", "num"],
    view: ["    groupBy:", "      property: grp", "    summaries:", "      num: Sum"],
  }, records);
  assert.deepEqual(summaryOf(snap, "num", 0), { summary: "Sum", value: null, reason: "type-mismatch" });
});

// ── C16–C20: 边界与 DESIGN 收口 ────────────────────────────────────────────

test("C16: an empty result set never throws (E1): 0 groups with groupBy, 1 empty group without", () => {
  const empty = [];
  const grouped = snapshot({ view: ["    groupBy:", "      property: status", "    summaries:", "      score: Sum"] }, empty);
  assert.deepEqual(grouped.groups, [], "qJ([]) === [] — no phantom group");
  assert.deepEqual(grouped.summaries, { scope: "visible-rows", values: { score: { summary: "Sum", value: null, reason: "empty" } } });

  const ungrouped = snapshot({ view: ["    summaries:", "      score: Sum", "      file.name: Empty"] }, empty);
  assert.deepEqual(groupShape(ungrouped), [[null, 0, []]], "without groupBy the empty set is still ONE empty group");
  assert.deepEqual(summaryOf(ungrouped, "score"), { summary: "Sum", value: null, reason: "empty" });
  assert.deepEqual(summaryOf(ungrouped, "file.name"), { summary: "Empty", value: 0, reason: null }, "counts of nothing are 0, not null");
});

test("C17: formula.* as a groupBy key stays fail-closed; as a SUMMARY column it is executed", () => {
  const formulaTop = ["formulas:", "  label: file.asLink(file.name)"];
  assert.throws(
    () => snapshot({ top: formulaTop, view: ["    groupBy:", "      property: formula.label"] }),
    (error) => error instanceof BaseQueryError && error.code === "unsupported" && /groupBy/.test(error.message),
    "assertNoFormulaReferencesInGroupBy is untouched (E11/U1)",
  );

  const executed = snapshot({
    top: formulaTop,
    order: ["file.name", "formula.label"],
    view: ["    summaries:", "      formula.label: Unique"],
  });
  assert.deepEqual(summaryOf(executed, "formula.label"), { summary: "Unique", value: 5, reason: null });

  assert.throws(
    () => snapshot({ order: ["file.name", "formula.ghost"], view: ["    summaries:", "      formula.ghost: Unique"] }),
    (error) => error instanceof BaseQueryError && error.code === "unsupported" && /ghost/.test(error.message),
    "an UNDECLARED formula summary column fails closed like any other formula reference",
  );
});

test("C18: list/object group keys stay fail-closed with unsupported_group_key (E4, project branch)", () => {
  const records = [record("A", { multi: [1, 2] }), record("B", { multi: 1 })];
  assert.throws(
    () => snapshot({ view: ["    groupBy:", "      property: multi"] }, records),
    (error) => error instanceof BaseQueryError && error.code === "unsupported" && /not supported for list values/.test(error.message),
    "the frozen model rejects list/object keys instead of inventing an element-wise identity",
  );
});

test("C23: a stray key INSIDE groupBy fails closed and names the key (frozen legal domain)", () => {
  // The frozen legal domain is exactly `{ property, direction? }` — the desktop
  // writes exactly that shape (SEMANTICS-FROZEN E6, asar @2353401) — so a stray
  // key is a typo, never a semantic key to swallow silently. Before this guard
  // `groupBy: { property, bogus: 1 }` was accepted and grouped by `property`.
  for (const extra of ["bogus", "directions", "groupOrder"]) {
    assert.throws(
      () => snapshot({ view: ["    groupBy:", "      property: status", `      ${extra}: 1`] }),
      (error) => error instanceof BaseQueryError
        && error.code === "unsupported"
        && /views\[\]\.groupBy/.test(error.message)
        && error.message.includes(`"${extra}"`),
      `groupBy.${extra} must fail closed with the offending key named`,
    );
  }
  // The legal domain itself is untouched.
  const ok = snapshot({ view: ["    groupBy:", "      property: status", "      direction: DESC"] });
  assert.deepEqual(groupShape(ok).map(([key]) => key), ["done", "active", null]);
});

test("C19: a declared groupOrder stays INERT — no silent row filtering enters the DTO (E12/U2)", () => {
  const snap = snapshot({ view: ["    groupBy:", "      property: status", '    groupOrder: ["active"]'] });
  assert.deepEqual(snap.rows.map((row) => row.path), ["WB/Alpha.md", "WB/Bravo.md", "WB/Delta.md", "WB/Echo.md", "WB/Foxtrot.md"]);
  assert.deepEqual(groupShape(snap).map(([key]) => key), ["active", "done", null]);
  assert.equal(Object.hasOwn(snap, "unlisted"), false, "the DTO publishes no half-implemented unlisted surface");
});

test("C20: no manual group-order state exists, so a groupBy property change cannot strand one (E13)", () => {
  const first = snapshot({ view: ["    groupBy:", "      property: status", '    groupOrder: ["active"]'] });
  const second = snapshot({ view: ["    groupBy:", "      property: score", '    groupOrder: ["active"]'] });
  // Group order follows the key only, in both documents: there is no stored
  // group order that a property change could leave behind.
  assert.deepEqual(groupShape(first).map(([key]) => key), ["active", "done", null]);
  assert.deepEqual(groupShape(second).map(([key]) => key), [0, 1, 3, 5, 8]);
});

// ── C21–C22: 契约级不变式与 fail-closed 边界 ───────────────────────────────

test("C21: pipeline invariants over the 2×2×2×2 fixture sweep", () => {
  for (const withGroupBy of [false, true]) {
    for (const direction of ["ASC", "DESC"]) {
      for (const limit of [null, 2]) {
        for (const withSummaries of [false, true]) {
          const view = [
            "    sort:", "      - property: score", `        direction: ${direction}`,
            ...(limit ? [`    limit: ${limit}`] : []),
            ...(withGroupBy ? ["    groupBy:", "      property: status"] : []),
            ...(withSummaries ? ["    summaries:", "      score: Sum"] : []),
          ];
          const snap = snapshot({ view });
          const label = `groupBy=${withGroupBy} direction=${direction} limit=${limit} summaries=${withSummaries}`;
          const expectedTotal = Math.min(snap.totalMatched, limit ?? snap.totalMatched);
          if (!withGroupBy && !withSummaries) {
            assert.equal(Object.hasOwn(snap, "groups"), false, `${label}: nothing declared ⇒ no grouping key`);
            assert.deepEqual(snap.rows.map((row) => row.path).length, expectedTotal, `${label}: rows are still the retained prefix`);
            continue;
          }
          const groups = snap.groups ?? [];
          assert.equal(groups.reduce((total, group) => total + group.count, 0), expectedTotal, `${label}: Σ count === min(totalMatched, limit)`);
          assert.equal(groups.reduce((total, group) => total + group.rowPaths.length, 0), expectedTotal, `${label}: rowPaths cover the retained rows`);
          const seen = new Set();
          for (const group of groups) {
            for (const path of group.rowPaths) {
              assert.equal(seen.has(path), false, `${label}: ${path} appears in two groups`);
              seen.add(path);
            }
          }
          assert.deepEqual([...seen].sort(), snap.rows.map((row) => row.path).sort(), `${label}: the groups partition exactly the retained rows`);
          if (withSummaries) assert.equal(summaryOf(snap, "score").summary, "Sum", `${label}: the view-wide summary exists`);
          if (!withSummaries) assert.equal(Object.hasOwn(snap, "summaries"), false, `${label}: no summaries declared ⇒ no summaries key`);
        }
      }
    }
  }
});

test("C22: unknown summary names and referenced custom summaries fail closed (E9, narrowing vs desktop)", () => {
  assert.throws(
    () => snapshot({ view: ["    summaries:", "      score: Average2"] }),
    (error) => error instanceof BaseQueryError && error.code === "unsupported" && /unknown summary name/.test(error.message),
  );
  assert.throws(
    () => snapshot({
      top: ["summaries:", "  customAverage: 'values.mean().round(3)'"],
      view: ["    summaries:", "      score: customAverage"],
    }),
    (error) => error instanceof BaseQueryError && error.code === "unsupported" && /values\.\* surface/.test(error.message),
    "a custom summary body is not executable in this subset (matrix §3), so the reference fails closed",
  );
  // A NON-selected view may not smuggle an unknown name past the document guard.
  assert.throws(
    () => queryBaseSnapshot({
      raw: [
        "views:",
        "  - type: table",
        "    name: First",
        "    order: [file.name]",
        "  - type: table",
        "    name: Second",
        "    summaries:",
        "      score: Nope",
        "",
      ].join("\n"),
      records: RECORDS,
    }),
    (error) => error instanceof BaseQueryError && error.code === "unsupported",
  );
});

test("刀4 DTO is ADD-only: an undeclared view keeps the pre-刀4 key set", () => {
  const snap = snapshot({});
  assert.deepEqual(Object.keys(snap).sort(), ["columns", "rows", "supportedSubset", "totalMatched", "truncated", "view", "viewLimit", "views"]);
  for (const row of snap.rows) assert.deepEqual(Object.keys(row).sort(), ["path", "values"]);
});
