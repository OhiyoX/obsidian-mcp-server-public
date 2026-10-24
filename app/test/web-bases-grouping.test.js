// `分组` lane (desktop-re/bases-grouping): the Web grouping surface, end to end at the
// module seams. Three things are pinned here, each where a regression would be silent:
//
//   1. the `?group=` transport rule (`base-params.js`) — one `.base`-shaped rule, its
//      canonical cursor identity, and the fail-closed codes;
//   2. the evaluator wiring (`base-query.js`) — the override REPLACES the view's declared
//      `groupBy` and an absent override leaves the declared rule in charge;
//   3. the client codec + capability gate (`query-state.js` / `actions.js`) — the rule the
//      menu shows is the rule the server applied, and no `分组` button exists on a server
//      that does not report the capability.
import assert from "node:assert/strict";
import test from "node:test";

const {
  BaseHttpError,
  encodeGroupIdentity,
  parseBaseQuery,
  parseBaseGroup,
} = await import("../src/app/base-params.js");
const { queryBaseSnapshot } = await import("../src/base-query.js");
const { BaseCursorError, assertBaseCursorMatches, encodeBaseCursor, decodeBaseCursor } = await import("../src/app/base-cursor.js");
const { effectiveGroupBy, groupParam, normalizeGroup, parseBaseSearch } = await import("../frontend/app/features/bases/query-state.js");
const { actionIsActive, visibleActionItems } = await import("../frontend/app/features/bases/actions.js");

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
  record("Alpha", { status: "active", score: 8 }),
  record("Bravo", { status: "done", score: 3 }),
  record("Delta", { status: "active", score: 5 }),
  record("Echo", { score: 1 }),
]);

function baseYaml({ view = [] } = {}) {
  return [
    'filters: file.inFolder("WB")',
    "views:",
    "  - type: table",
    "    name: V",
    '    order: ["file.name", "status", "score"]',
    ...view,
    "",
  ].join("\n");
}

const DECLARED = baseYaml({ view: ["    groupBy:", "      property: score", "      direction: DESC"] });

// ── 1. transport rule ───────────────────────────────────────────────────────
test("?group= accepts exactly the .base rule shape and defaults the direction", () => {
  assert.deepEqual(parseBaseGroup('{"property":"status"}'), { property: "status", direction: "ASC" });
  assert.deepEqual(parseBaseGroup('{"property":"status","direction":"DESC"}'), { property: "status", direction: "DESC" });
  // "no override" is an absent/empty value, never an empty rule
  assert.equal(parseBaseGroup(undefined), null);
  assert.equal(parseBaseGroup(""), null);

  const rejected = {
    notJson: "status",
    array: '[{"property":"status"}]',
    noProperty: '{"direction":"ASC"}',
    // case-sensitive on purpose: the `.base` domain is ASC|DESC
    lowerCase: '{"property":"status","direction":"asc"}',
    // the frozen domain is exactly {property, direction?} — a typo must not be swallowed
    extraKey: '{"property":"status","groupOrder":[]}',
    notObject: '"status"',
  };
  for (const [name, value] of Object.entries(rejected)) {
    assert.throws(
      () => parseBaseGroup(value),
      (error) => error instanceof BaseHttpError && error.status === 400 && error.code === "invalid-group",
      `${name} must be a 400 invalid-group`,
    );
  }
});

test("the cursor identity of a grouping rule is canonical", () => {
  assert.equal(encodeGroupIdentity(null), undefined);
  assert.equal(
    encodeGroupIdentity({ property: "status", direction: "ASC" }),
    encodeGroupIdentity({ property: "status", direction: "ASC" }),
    "the canonical encoding names both fields explicitly",
  );
  // `parseBaseGroup` always fills the default, so the identity of `{property}` and of
  // `{property, direction: "ASC"}` is one and the same after parsing.
  assert.equal(
    encodeGroupIdentity(parseBaseGroup('{"property":"status"}')),
    encodeGroupIdentity(parseBaseGroup('{"property":"status","direction":"ASC"}')),
  );
  const parsed = parseBaseQuery({ path: "V.base", group: '{"property":"status"}' });
  assert.deepEqual(parsed.group, { property: "status", direction: "ASC" });
  assert.equal(parsed.groupIdentity, encodeGroupIdentity({ property: "status", direction: "ASC" }));
});

test("a cursor cannot cross two different grouping rules", () => {
  const identity = { catalogId: "c", generation: 1, path: "V.base", revision: "r", view: "V", orderContract: 1 };
  const cursor = encodeBaseCursor({ ...identity, offset: 1, group: encodeGroupIdentity({ property: "status" }) });
  const decoded = decodeBaseCursor(cursor);
  assert.doesNotThrow(() => assertBaseCursorMatches(decoded, { ...identity, group: encodeGroupIdentity({ property: "status" }) }));
  assert.throws(
    () => assertBaseCursorMatches(decoded, { ...identity, group: encodeGroupIdentity({ property: "score" }) }),
    (error) => error instanceof BaseCursorError && error.code === "BASE_CURSOR_STALE",
  );
  // An empty string is not a valid identity field.
  assert.throws(() => encodeBaseCursor({ ...identity, offset: 0, group: "" }), BaseCursorError);
});

// ── 2. evaluator wiring ─────────────────────────────────────────────────────
test("an absent ?group= leaves the declared groupBy in charge", () => {
  const snapshot = queryBaseSnapshot({ raw: DECLARED, viewName: "V", records: RECORDS });
  assert.deepEqual(snapshot.groups.map((group) => group.key), [8, 5, 3, 1], "DESC over score");
  assert.equal(snapshot.groups.reduce((total, group) => total + group.count, 0), RECORDS.length);
});

test("?group= replaces the declared groupBy, and no override means no invented groups", () => {
  const overridden = queryBaseSnapshot({
    raw: DECLARED,
    viewName: "V",
    records: RECORDS,
    groupOverride: { property: "status", direction: "ASC" },
  });
  assert.deepEqual(overridden.groups.map((group) => group.key), ["active", "done", null]);
  assert.deepEqual(overridden.groups.map((group) => group.count), [2, 1, 1]);

  const undeclared = queryBaseSnapshot({ raw: baseYaml(), viewName: "V", records: RECORDS });
  assert.equal(undeclared.groups, undefined, "an ungrouped view must not carry `groups`");
  const adHoc = queryBaseSnapshot({
    raw: baseYaml(),
    viewName: "V",
    records: RECORDS,
    groupOverride: { property: "status", direction: "ASC" },
  });
  assert.deepEqual(adHoc.groups.map((group) => group.key), ["active", "done", null]);
});

// ── 3. client codec + capability gate ───────────────────────────────────────
test("the client codec round-trips the rule through the URL", () => {
  assert.equal(normalizeGroup('{"property":"status","direction":"DESC"}').direction, "DESC");
  assert.equal(normalizeGroup({ property: "status" }).direction, "ASC");
  assert.equal(normalizeGroup("{}"), null);
  assert.equal(normalizeGroup({ property: "status", direction: "desc" }), null, "lower-case is not the .base spelling");
  const params = `group=${encodeURIComponent(groupParam({ property: "status", direction: "DESC" }))}`;
  const parsed = parseBaseSearch(`?${params}`);
  assert.deepEqual(parsed.group, { property: "status", direction: "DESC" });
  // No rule = no query parameter at all.
  assert.equal(groupParam(null), null);
  assert.deepEqual(parseBaseSearch("?view=V").group, null);
});

test("effectiveGroupBy prefers the reader override over the view declaration", () => {
  assert.deepEqual(effectiveGroupBy({ group: null, viewGroupBy: { property: "score", direction: "DESC" } }), { property: "score", direction: "DESC" });
  assert.deepEqual(
    effectiveGroupBy({ group: { property: "status", direction: "ASC" }, viewGroupBy: { property: "score", direction: "DESC" } }),
    { property: "status", direction: "ASC" },
  );
  assert.equal(effectiveGroupBy({ group: null, viewGroupBy: null }), null);
});

test("the 分组 action exists only when the server reports the capability", () => {
  const ids = (capabilities) => visibleActionItems(capabilities).map((item) => item.id);
  // Order follows the owner's shot 03: 排序 → 分组 → 筛选 → 属性 (review round 1, D2 — the button
  // used to sit after 筛选 while this test pinned that wrong order).
  assert.deepEqual(ids({ grouping: true }), ["sort", "group", "filter", "properties", "search", "new"]);
  assert.deepEqual(ids({ grouping: false }), ["sort", "filter", "properties", "search", "new"]);
  assert.deepEqual(ids(null), ["sort", "filter", "properties", "search", "new"], "an older server hides the button");
  assert.equal(actionIsActive("group", { group: { property: "status", direction: "ASC" } }), true);
  assert.equal(actionIsActive("group", { group: null }), false);
});

// Lane grouping-honesty (review D5) narrowed `分组` to the layouts that painted the partition;
// lane group-headings-list-cards ports the missing half (list/cards now paint one group box +
// `bases-group-heading mod-collapsible` per `groups[]` entry, matrix §14.12), so the gate opens
// on every layout again. This is a WIDENING of the same assertion, not a deletion: what #686
// added and what still binds is the capability gate and the unknown-layout normalization rules.
test("分组 is offered on every layout the surface can render, gated by the capability", () => {
  const ids = (capabilities, layout) => visibleActionItems(capabilities, layout).map((item) => item.id);
  const grouped = ["sort", "group", "filter", "properties", "search", "new"];
  const flat = ["sort", "filter", "properties", "search", "new"];

  assert.deepEqual(ids({ grouping: true }, "table"), grouped);
  assert.deepEqual(ids({ grouping: true }, "kanban"), grouped, "the board's columns ARE the groups");
  assert.deepEqual(ids({ grouping: true }, "list"), grouped, "grouped list boxes + headings (this cut)");
  assert.deepEqual(ids({ grouping: true }, "cards"), grouped, "grouped card boxes + headings (this cut)");
  // The layout gate still sits on top of the capability gate; it never opens one by itself.
  assert.deepEqual(ids({ grouping: false }, "table"), flat);
  assert.deepEqual(ids({ grouping: false }, "list"), flat);
  assert.deepEqual(ids({ grouping: false }, "cards"), flat);
  assert.deepEqual(ids({ grouping: false }, "kanban"), flat);
  // Unknown / missing layout = table, the same rule view.js mounts the renderer on, so the
  // button set can never disagree with the layout that is on screen.
  assert.deepEqual(ids({ grouping: true }), grouped);
  assert.deepEqual(ids({ grouping: true }, null), grouped);
  assert.deepEqual(ids({ grouping: true }, "future-layout"), grouped);
  assert.deepEqual(ids({ grouping: true }, " TABLE "), grouped, "the declared type is normalized like view-options.js");
});
