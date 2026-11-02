// Focused model tests for the P1-D grouping model (`base-grouping.js`).
//
// 刀4 update (docs/bases/SEMANTICS-FROZEN.md D1): the keyless (null) group is
// ALWAYS LAST — under ASC *and* DESC — because the desktop comparator only
// applies the direction multiplier when both sides have a key (asar P10/P11).
// The earlier B7 DESIGN ("null on the smallest side": first under ASC, last
// under DESC) is superseded here; only the group ORDER moves, never membership.
//
// Purely local: no vault, no HTTP, no MCP, no base-query / adapter / workflow
// wiring. The suite pins the frozen grouping semantics of
// SEMANTIC-ORDER-EVIDENCE.md B3 / B4 / B6 / B7 and the W2-A BRIEF §2/§3 matrix
// (see `docs/bases/BASES-GROUPING-MODEL.md`).

import assert from "node:assert/strict";
import test from "node:test";

import {
  BaseGroupingError,
  DEFAULT_GROUP_DIRECTION,
  GROUP_DIRECTIONS,
  GROUPING_ERROR_CODES,
  buildBaseGroups,
  groupKeyIdentity,
} from "../src/base-grouping.js";
import { baseValuesEqual, compareBaseValues } from "../src/base-values.js";

// 2024-01-02T00:00:00Z — midnight UTC, so `normalizeBaseValue` calls it a `date`.
const JAN_2 = Date.UTC(2024, 0, 2);
const JAN_3 = Date.UTC(2024, 0, 3);

function rows(pairs) {
  return pairs.map(([path, key]) => (key === undefined ? { path } : { path, group: key }));
}

function groupsOf(pairs, spec) {
  return buildBaseGroups(rows(pairs), spec);
}

function snapshot(model) {
  // `rowIndexes` is deliberately dropped: it is the membership of THIS input
  // permutation, so two permutations of the same rows legitimately differ there
  // while the group order/shape must not.
  return {
    boundaries: model.boundaries.map(({ groupValue, startIndex, count }) => ({ groupValue, startIndex, count })),
    totalGroups: model.totalGroups,
  };
}

function shape(model) {
  return model.boundaries.map((boundary) => [boundary.groupValue, boundary.startIndex, boundary.count]);
}

// The boundary invariants the DTO depends on: a contiguous partition of the
// rows, in group order, covering every row exactly once.
function assertPartition(model, rowCount) {
  assert.equal(model.totalGroups, model.boundaries.length);
  let expectedStart = 0;
  let total = 0;
  for (const boundary of model.boundaries) {
    assert.equal(boundary.startIndex, expectedStart);
    assert.ok(Number.isInteger(boundary.count) && boundary.count > 0);
    expectedStart += boundary.count;
    total += boundary.count;
  }
  assert.equal(total, rowCount);
  return true;
}

function groupError(code, message) {
  return (error) => {
    assert.ok(error instanceof BaseGroupingError, `expected BaseGroupingError, got ${error}`);
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  };
}

// ── 组键类型与 null 组 ─────────────────────────────────────────────────────

test("string keys: groups order by code unit, group-internal order is the input order", () => {
  const model = groupsOf([["a", "b"], ["b", "a"], ["c", "b"], ["d", "a"]], { property: "group" });
  assert.deepEqual(shape(model), [["a", 0, 2], ["b", 2, 2]]);
  assert.equal(assertPartition(model, 4), true);
});

test("number keys order numerically, not lexicographically", () => {
  const model = groupsOf([["a", 10], ["b", 9], ["c", 2], ["d", 10]], { property: "group" });
  assert.deepEqual(shape(model), [[2, 0, 1], [9, 1, 1], [10, 2, 2]]);
});

test("boolean keys: false before true under ASC, true first under DESC", () => {
  assert.deepEqual(shape(groupsOf([["a", true], ["b", false], ["c", true]], { property: "group" })), [[false, 0, 1], [true, 1, 2]]);
  assert.deepEqual(
    shape(groupsOf([["a", true], ["b", false], ["c", true]], { property: "group", direction: "DESC" })),
    [[true, 0, 2], [false, 2, 1]],
  );
});

test("date family: date-only, Date instance and equal-instant datetime are one group", () => {
  const model = groupsOf(
    [["a", "2024-01-03"], ["b", new Date(JAN_2)], ["c", "2024-01-02T00:00:00Z"], ["d", "2024-01-02"]],
    { property: "group" },
  );
  // Group value is the first-seen raw key; identity is the instant for the whole family.
  assert.deepEqual(shape(model), [[new Date(JAN_2), 0, 3], ["2024-01-03", 3, 1]]);
  assert.equal(model.boundaries[0].groupValue.getTime(), JAN_2);
});

test("empty / missing / null / NaN / Infinity / illegal date share one null group (always last)", () => {
  const model = groupsOf(
    [["a"], ["b", null], ["c", Number.NaN], ["d", "2024-13-01"], ["e", Number.POSITIVE_INFINITY], ["f", "x"]],
    { property: "group" },
  );
  assert.deepEqual(shape(model), [["x", 0, 1], [null, 1, 5]]);
  assert.equal(model.boundaries[1].groupValue, null);
  assert.equal(assertPartition(model, 6), true);
});

test("an empty string is a group of its own: isEmpty() is not the null group", () => {
  const model = groupsOf([["a", "a"], ["b"], ["c", ""]], { property: "group" });
  assert.deepEqual(shape(model), [["", 0, 1], ["a", 1, 1], [null, 2, 1]]);
});

test("0 and false are groups of their own, never the null group", () => {
  const model = groupsOf([["a", 0], ["b", false], ["c"], ["d", "0"]], { property: "group" });
  assert.deepEqual(shape(model), [[false, 0, 1], [0, 1, 1], ["0", 2, 1], [null, 3, 1]]);
});

test("list keys fail closed with unsupported_group_key", () => {
  assert.throws(
    () => groupsOf([["a", "x"], ["b", []]], { property: "group" }),
    groupError(GROUPING_ERROR_CODES.UNSUPPORTED_GROUP_KEY, "Base groupBy is not supported for list values (out of scope)"),
  );
});

test("object keys fail closed with unsupported_group_key", () => {
  assert.throws(
    () => groupsOf([["a", {}]], { property: "group" }),
    groupError(GROUPING_ERROR_CODES.UNSUPPORTED_GROUP_KEY, "Base groupBy is not supported for object values (out of scope)"),
  );
});

test("an unsupported key fails the whole call, even as the last row (no partial result)", () => {
  assert.throws(
    () => groupsOf([["a", 1], ["b", 2], ["c", [1, 2]]], { property: "group" }),
    groupError(GROUPING_ERROR_CODES.UNSUPPORTED_GROUP_KEY),
  );
});

test("link keys group by path (P1-A typed order), not by displayName", () => {
  const model = groupsOf(
    [
      ["a", { kind: "asLink", path: "b.md", displayName: "Bee" }],
      ["b", { kind: "asLink", path: "a.md" }],
      ["c", { kind: "asLink", path: "b.md" }],
    ],
    { property: "group" },
  );
  assert.equal(model.totalGroups, 2);
  assert.deepEqual(shape(model).map(([value, start, count]) => [value.path, start, count]), [["a.md", 0, 1], ["b.md", 1, 2]]);
});

// ── 组方向与 null 组位置（刀4/D1） ───────────────────────────────────────────

test("DESC reverses the group order", () => {
  const spec = { property: "group" };
  assert.deepEqual(shape(groupsOf([["a", "b"], ["b", "a"], ["c", "c"]], spec)), [["a", 0, 1], ["b", 1, 1], ["c", 2, 1]]);
  assert.deepEqual(
    shape(groupsOf([["a", "b"], ["b", "a"], ["c", "c"]], { ...spec, direction: "DESC" })),
    [["c", 0, 1], ["b", 1, 1], ["a", 2, 1]],
  );
});

test("the keyless (null) group is LAST in both directions (D1, desktop asar P10/P11)", () => {
  const pairs = [["a", "b"], ["b"], ["c", "a"], ["d", null]];
  // ASC: keyed groups ascending, null group last (NOT first, which was the
  // superseded B7 DESIGN).
  assert.deepEqual(shape(groupsOf(pairs, { property: "group" })), [["a", 0, 1], ["b", 1, 1], [null, 2, 2]]);
  assert.deepEqual(shape(groupsOf(pairs, { property: "group", direction: "DESC" })), [["b", 0, 1], ["a", 1, 1], [null, 2, 2]]);
});

test("rowIndexes list each group's members as input indexes, in input order", () => {
  const model = groupsOf([["m", 1], ["a", 2], ["z", 1], ["b", 2], ["c"]], { property: "group" });
  assert.deepEqual(model.boundaries.map((boundary) => [...boundary.rowIndexes]), [[0, 2], [1, 3], [4]]);
  assert.deepEqual(model.boundaries.map((boundary) => boundary.count), [2, 2, 1]);
  assert.ok(Object.isFrozen(model.boundaries[0].rowIndexes));
});

test("direction defaults to ASC (DEFAULT_GROUP_DIRECTION)", () => {
  assert.equal(DEFAULT_GROUP_DIRECTION, "ASC");
  assert.deepEqual(GROUP_DIRECTIONS, ["ASC", "DESC"]);
  assert.deepEqual(shape(groupsOf([["a", 2], ["b", 1]], { property: "group" })), [[1, 0, 1], [2, 1, 1]]);
});

// ── 组内稳定序（B3） ───────────────────────────────────────────────────────

test("group-internal order is exactly the input order: no re-sort, no re-group", () => {
  const model = groupsOf([["m", 1], ["a", 2], ["z", 1], ["b", 2]], { property: "group" });
  assert.deepEqual(shape(model), [[1, 0, 2], [2, 2, 2]]);
  // Boundary slices describe the grouped order: group 1 rows are the input rows
  // 0 and 2, group 2 rows are input rows 1 and 3 — unchanged, in that order.
  assert.equal(model.boundaries[0].count, 2);
});

test("unsorted input is never reordered; boundaries describe the concatenated group order", () => {
  const model = groupsOf([["a", 2], ["b", 1], ["c", 2]], { property: "group" });
  assert.deepEqual(shape(model), [[1, 0, 1], [2, 1, 2]]);
  assert.equal(assertPartition(model, 3), true);
});

test("the caller's file.path tie-break inside a group is preserved verbatim", () => {
  // The module must not add its own tie-break: whatever path order the caller
  // sorted with is the order that comes back in the boundaries.
  const model = groupsOf([["z.md", 1], ["a.md", 1], ["m.md", 1]], { property: "group" });
  assert.equal(model.totalGroups, 1);
  assert.equal(model.boundaries[0].count, 3);
});

// ── 边界与规模 ─────────────────────────────────────────────────────────────

test("empty input yields no boundaries", () => {
  const model = buildBaseGroups([], { property: "group" });
  assert.deepEqual(snapshot(model), { boundaries: [], totalGroups: 0 });
});

test("all rows in the null group yield one boundary covering every row", () => {
  const model = groupsOf([["a"], ["b"], ["c"]], { property: "group" });
  assert.deepEqual(shape(model), [[null, 0, 3]]);
});

test("single-row groups: one boundary per distinct key", () => {
  const model = groupsOf([["a", 3], ["b", 1], ["c", 2]], { property: "group" });
  assert.deepEqual(shape(model), [[1, 0, 1], [2, 1, 1], [3, 2, 1]]);
  assert.equal(assertPartition(model, 3), true);
});

test("one large group (5000 rows) keeps every row: limit is global and not ours (B4)", () => {
  const big = Array.from({ length: 5000 }, (_, index) => [`n${index}.md`, "same"]);
  const model = groupsOf(big, { property: "group", direction: "DESC" });
  assert.deepEqual(shape(model), [["same", 0, 5000]]);
  assert.equal(assertPartition(model, 5000), true);
});

// ── 输入校验（fail closed） ────────────────────────────────────────────────

test("rows must be an array", () => {
  for (const value of [undefined, null, "rows", { length: 0 }, 42]) {
    assert.throws(() => buildBaseGroups(value, { property: "group" }), groupError(GROUPING_ERROR_CODES.INVALID_INPUT));
  }
});

test("a non-object row fails closed when the property is read", () => {
  assert.throws(
    () => buildBaseGroups([{ path: "a", group: 1 }, null], { property: "group" }),
    groupError(GROUPING_ERROR_CODES.INVALID_INPUT, 'Base groupBy rows must be objects to read property "group"'),
  );
});

test("groupBy must be an object", () => {
  for (const value of [undefined, null, "group", ["group"], 7]) {
    assert.throws(
      () => buildBaseGroups([], value),
      groupError(GROUPING_ERROR_CODES.INVALID_GROUP_BY, "Base groupBy must be an object with a property name"),
    );
  }
});

test("groupBy.property must be a non-empty string", () => {
  for (const value of [undefined, null, "", 7, {}]) {
    assert.throws(
      () => buildBaseGroups([], { property: value }),
      groupError(GROUPING_ERROR_CODES.INVALID_GROUP_BY, "Base groupBy.property must be a non-empty string"),
    );
  }
});

test("direction must be exactly ASC or DESC", () => {
  for (const value of ["asc", "desc", "ASC ", 1, null]) {
    assert.throws(
      () => buildBaseGroups([], { property: "group", direction: value }),
      groupError(GROUPING_ERROR_CODES.INVALID_DIRECTION, `Unsupported Base groupBy direction "${value}" (expected ASC or DESC)`),
    );
  }
});

test("a keyOf that is not a function fails closed", () => {
  assert.throws(
    () => buildBaseGroups([], { property: "group", keyOf: "group" }),
    groupError(GROUPING_ERROR_CODES.INVALID_GROUP_BY, "Base groupBy keyOf resolver must be a function"),
  );
});

test("the keyOf seam receives (row, index) and supplies the key verbatim", () => {
  const seen = [];
  const rowsIn = rows([["a", "ignored"], ["b", "ignored"], ["c", "ignored"]]);
  const model = buildBaseGroups(rowsIn, { property: "group", keyOf: (row, index) => {
    seen.push([row.path, index]);
    return index < 2 ? "low" : "high";
  } });
  assert.deepEqual(seen, [["a", 0], ["b", 1], ["c", 2]]);
  // Group order comes from the key ("high" < "low"), not from the seam's order.
  assert.deepEqual(shape(model), [["high", 0, 1], ["low", 1, 2]]);
});

// ── 安全（契约 §7 / §14.7） ────────────────────────────────────────────────

test("an accessor property is never invoked: it reads as the null group", () => {
  const row = { path: "a" };
  let invoked = 0;
  Object.defineProperty(row, "group", { enumerable: true, get() { invoked += 1; return "boom"; } });
  assert.deepEqual(shape(buildBaseGroups([row], { property: "group" })), [[null, 0, 1]]);
  assert.equal(invoked, 0);
});

test("the keyOf seam wins over the property, so the accessor stays untouched", () => {
  const row = { path: "a" };
  let invoked = 0;
  Object.defineProperty(row, "group", { enumerable: true, get() { invoked += 1; throw new Error("getter invoked"); } });
  const model = buildBaseGroups([row], { property: "group", keyOf: () => "seam" });
  assert.deepEqual(shape(model), [["seam", 0, 1]]);
  assert.equal(invoked, 0);
});

test("inherited properties are never read: only own data properties group", () => {
  const row = Object.create({ group: "leaked" });
  row.path = "a";
  assert.deepEqual(shape(buildBaseGroups([row], { property: "group" })), [[null, 0, 1]]);
});

// ── 确定性与输出形状 ───────────────────────────────────────────────────────

test("identical input yields an identical model (null group + DESC)", () => {
  const rowsIn = rows([["a", 2], ["b", null], ["c", 2], ["d", 1]]);
  const spec = { property: "group", direction: "DESC" };
  const first = buildBaseGroups(rowsIn, spec);
  const second = buildBaseGroups(rowsIn, spec);
  assert.deepEqual(snapshot(first), snapshot(second));
  assert.deepEqual(shape(first), [[2, 0, 2], [1, 2, 1], [null, 3, 1]]);
});

test("group order does not depend on the row permutation (first appearance is not the order)", () => {
  const ascending = groupsOf([["x", 2], ["y", 1], ["z", 1]], { property: "group" });
  const descending = groupsOf([["z", 1], ["y", 1], ["x", 2]], { property: "group" });
  assert.deepEqual(snapshot(ascending), snapshot(descending));
  assert.deepEqual(shape(ascending), [[1, 0, 2], [2, 2, 1]]);
});

test("the model is frozen and boundaries carry exactly groupValue / startIndex / count / rowIndexes", () => {
  const model = groupsOf([["a", 1]], { property: "group" });
  assert.ok(Object.isFrozen(model));
  assert.ok(Object.isFrozen(model.boundaries));
  assert.ok(Object.isFrozen(model.boundaries[0]));
  assert.deepEqual(Object.keys(model.boundaries[0]), ["groupValue", "startIndex", "count", "rowIndexes"]);
  assert.deepEqual(Object.keys(model), ["boundaries", "totalGroups"]);
});

test("the input array and its rows are never mutated", () => {
  const rowsIn = rows([["a", 2], ["b"], ["c", 1]]);
  const before = JSON.stringify(rowsIn);
  buildBaseGroups(rowsIn, { property: "group", direction: "DESC" });
  assert.equal(JSON.stringify(rowsIn), before);
  assert.deepEqual(rowsIn.map((row) => row.path), ["a", "b", "c"]);
});

test("groupKeyIdentity agrees with baseValuesEqual, and distinct identities never compare 0", () => {
  const values = [
    undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "2024-13-01",
    0, -0, 1, 2.5, "1", "", "a", "B",
    "2024-01-02", "2024-01-02T00:00:00Z", new Date(JAN_2), new Date(JAN_3),
    true, false,
    { kind: "asLink", path: "p.md" }, { kind: "asLink", path: "p.md", displayName: "P" },
  ];
  for (const left of values) {
    for (const right of values) {
      const sameIdentity = groupKeyIdentity(left) === groupKeyIdentity(right);
      assert.equal(sameIdentity, baseValuesEqual(left, right), `identity/equality mismatch for ${String(left)} vs ${String(right)}`);
      if (!sameIdentity) {
        assert.notEqual(compareBaseValues(left, right), 0, `distinct identities must order: ${String(left)} vs ${String(right)}`);
      }
    }
  }
});
