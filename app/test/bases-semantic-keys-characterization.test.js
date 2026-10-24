// Bases P1 Wave 0-A — characterization of every known Base semantic key.
//
// Purpose: freeze the *current* behavior of the canonical Base domain service
// for each documented Base key, so the Wave 0-D fail-closed guard can flip the
// red rows in one atomic commit. This file adds no production behavior and must
// be green on the frozen BASE.
//
// State after 刀4 (grouping lane): the three keys frozen as RED in W0-A
// (`views[].groupBy`, `views[].summaries`, top-level `summaries`) are ACCEPTED
// and executed (docs/bases/SEMANTICS-FROZEN.md frozen pipeline + D1–D5).
// `FROZEN_UNSUPPORTED_AFTER_CUT4` is now empty: the only rejections left are
// malformed declarations (a scalar `groupBy`, a non-mapping `summaries`, an
// unknown summary name), and those live in the dedicated test below rather than
// in the frozen table, because they are shape errors, not key paths.
//
// Rules for this file (contract §2, reviewer ack):
//   - `SEMANTIC_KEY_CASES` is the single frozen table; later slices edit only
//     that table (key path, YAML fragment, expected behavior, classification),
//     never scatter new assertions.
//   - Every `test(...)` name states the *current* behavior in words, e.g.
//     "should accept and consume views[].groupBy and return supportedSubset=true".
//   - A rejected row declares `behavior: "REJECT unsupported"` and
//     `expect.code`, and its key path must be listed in
//     `FROZEN_UNSUPPORTED_AFTER_CUT4`.
//   - No skip / todo may hide an expected rejection.
//
// Record shape follows the contract documented at the top of
// `app/src/base-query.js` (path/basename/frontmatter/tags/links/stat) and the
// same inline-record style as `app/test/base-query-overrides.test.js`.
// Adapter-layer facts (MCP hardcoded `supportedSubset`, Web capability flags)
// are read-only evidence recorded in `docs/bases/BASES-SEMANTIC-KEY-INVENTORY.md`.

import assert from "node:assert/strict";
import test from "node:test";

const { BaseQueryError, parseAndValidateBase, queryBaseSnapshot, validateBaseDocument } = await import("../src/base-query.js");

function record(name, frontmatter, extra = {}) {
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

// Three synthesized records inside WB/, all matched by the default
// `file.inFolder("WB")` filter; `score` splits 8 / 3 / 5 so view filters and
// sorts are discriminating.
const RECORDS = Object.freeze([
  record("Alpha", { title: "Alpha Title", status: "active", score: 8 }, { tags: ["work"] }),
  record("Bravo", { status: "done", score: 3 }, { tags: ["work"] }),
  record("Delta", { status: "active", score: 5 }, { tags: ["work"] }),
]);

// Full-line view block (4-space indent, first line carries the `- ` sequence
// marker). `view` overrides the whole block; `extra` appends lines to it.
const SUPPORTED_VIEW = Object.freeze([
  "    type: table",
  "    name: V",
  '    order: ["file.name", "status", "score"]',
]);

function baseYaml({ filter = 'file.inFolder("WB")', top = [], view = SUPPORTED_VIEW, extra = [] } = {}) {
  const block = [...view, ...extra];
  return [
    ...(filter === null ? [] : [`filters: ${filter}`]),
    ...top,
    "views:",
    `  - ${block[0].trimStart()}`,
    ...block.slice(1),
    "",
  ].join("\n");
}

function viewWith(...extra) {
  return [...SUPPORTED_VIEW, ...extra];
}

// Frozen DTO key set of `queryBaseSnapshot` (sorted). Both adapters consume a
// subset: MCP `query_base` rebuilds its own DTO and hardcodes
// `supportedSubset: true` (app/src/tools/workflows.js:472); the Web route
// re-declares `supportedSubset: true` and `capabilities.grouping/aggregation:
// false` (app/src/app/base-route.js:168).
const SNAPSHOT_DTO_KEYS = Object.freeze(["columns", "rows", "supportedSubset", "totalMatched", "truncated", "view", "viewLimit", "views"]);

// 刀4 ADD-only grouping surface. `groups` / `summaries` appear ONLY when the
// selected view declares `groupBy` / `summaries`, so every undeclared document
// keeps the pre-刀4 DTO key set byte-identical (that is what keeps the MCP and
// Web locks green without a single edit there).
const GROUPING_DTO_KEYS = Object.freeze(["groups", "summaries"]);

// Key paths still fail-closed after 刀4. The three Wave 0-D keys left this list;
// it must stay in lockstep with the rejected table rows (empty means "no frozen
// key path is rejected any more").
const FROZEN_UNSUPPORTED_AFTER_CUT4 = Object.freeze([]);

// behavior: ACCEPT-silent | ACCEPT-consumed | REJECT <code>
// classification: SUPPORTED | KNOWN-UNIMPLEMENTED-SEMANTIC | DISPLAY-METADATA | NOT-APPLICABLE
// expect defaults: code=null, validatorErrors=[], view="V", rowCount=3,
// totalMatched=3, truncated=false; optional: views, columns, valueKeys.
const SEMANTIC_KEY_CASES = Object.freeze([
  // ── Top-level keys ───────────────────────────────────────────────────────
  {
    keyPath: "filters",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    flip: false,
    yaml: baseYaml({ filter: 'status == "active"' }),
    expect: { rowCount: 2, totalMatched: 2 },
  },
  {
    keyPath: "formulas",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    flip: false,
    yaml: baseYaml({ top: ["formulas:", "  note: file.asLink(if(title, title, file.name))"] }),
    expect: {},
  },
  {
    keyPath: "properties",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    flip: false,
    yaml: baseYaml({
      top: ["formulas:", "  note: file.asLink(if(title, title, file.name))", "properties:", "  formula.note:", '    displayName: "Note"'],
      view: ["    type: table", "    name: V", '    order: ["formula.note", "file.name"]'],
    }),
    expect: {
      valueKeys: ["formula.note", "file.name"],
      columns: [
        { key: "formula.note", label: "Note", kind: "formula" },
        { key: "file.name", label: "名称", kind: "property" },
      ],
    },
  },
  {
    keyPath: "views",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    flip: false,
    yaml: baseYaml(),
    expect: { views: [{ name: "V", type: "table" }] },
  },
  {
    keyPath: "summaries",
    behavior: "ACCEPT-silent",
    classification: "SUPPORTED",
    // 刀4: the top-level section is the custom-summary REGISTRY. An unreferenced
    // entry changes no row, column or group (desktop parity); the shape is
    // validated, and a view that references a custom name fails closed (the
    // values.* surface is not implemented).
    yaml: baseYaml({ top: ["summaries:", '  customAverage: "values.mean().round(3)"'] }),
    expect: {},
  },
  {
    keyPath: "<unknown top-level key>",
    behavior: "ACCEPT-silent",
    classification: "NOT-APPLICABLE",
    flip: false,
    yaml: baseYaml({ top: ["theme: dark"] }),
    expect: {},
  },

  // ── View keys ────────────────────────────────────────────────────────────
  {
    keyPath: "views[].type: table",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    flip: false,
    yaml: baseYaml(),
    expect: { views: [{ name: "V", type: "table" }] },
  },
  {
    keyPath: "views[].type: cards",
    behavior: "ACCEPT-silent",
    classification: "DISPLAY-METADATA",
    flip: false,
    yaml: baseYaml({ view: ["    type: cards", "    name: V", '    order: ["file.name", "status", "score"]'] }),
    expect: { views: [{ name: "V", type: "cards" }] },
  },
  {
    keyPath: "views[].type: list",
    behavior: "ACCEPT-silent",
    classification: "DISPLAY-METADATA",
    flip: false,
    yaml: baseYaml({ view: ["    type: list", "    name: V", '    order: ["file.name", "status", "score"]'] }),
    expect: { views: [{ name: "V", type: "list" }] },
  },
  {
    keyPath: "views[].type: map",
    behavior: "ACCEPT-silent",
    classification: "DISPLAY-METADATA",
    flip: false,
    yaml: baseYaml({ view: ["    type: map", "    name: V", '    order: ["file.name", "status", "score"]'] }),
    expect: { views: [{ name: "V", type: "map" }] },
  },
  {
    keyPath: "views[].type: <unknown>",
    behavior: "ACCEPT-silent",
    classification: "DISPLAY-METADATA",
    flip: false,
    yaml: baseYaml({ view: ["    type: mystery-view", "    name: V", '    order: ["file.name", "status", "score"]'] }),
    expect: { views: [{ name: "V", type: "mystery-view" }] },
  },
  {
    keyPath: "views[].name",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    flip: false,
    yaml: baseYaml({ view: ["    type: table", "    name: Named", '    order: ["file.name"]'] }),
    expect: { view: "Named", views: [{ name: "Named", type: "table" }], valueKeys: ["file.name"] },
  },
  {
    keyPath: "views[].limit",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    flip: false,
    yaml: baseYaml({ extra: ["    limit: 2"] }),
    expect: { rowCount: 2, totalMatched: 3, truncated: true },
  },
  {
    keyPath: "views[].filters",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    flip: false,
    yaml: baseYaml({ extra: ["    filters: score >= 5"] }),
    expect: { rowCount: 2, totalMatched: 2 },
  },
  {
    keyPath: "views[].order",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    flip: false,
    yaml: baseYaml({ view: ["    type: table", "    name: V", '    order: ["file.name", "status"]'] }),
    expect: {
      valueKeys: ["file.name", "status"],
      columns: [
        { key: "file.name", label: "名称", kind: "property" },
        { key: "status", label: "status", kind: "property" },
      ],
    },
  },
  {
    keyPath: "views[].sort",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    flip: false,
    yaml: baseYaml({ extra: ["    sort:", "      - property: score", "        direction: DESC"] }),
    expect: {},
  },
  {
    keyPath: "views[].groupBy",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    yaml: baseYaml({ extra: ["    groupBy:", "      property: status", "      direction: DESC"] }),
    // 刀4: grouping is executed; only the ADD-only `groups` key appears (this
    // view declares no summaries).
    expect: { groupingKeys: ["groups"] },
  },
  {
    keyPath: "views[].summaries",
    behavior: "ACCEPT-consumed",
    classification: "SUPPORTED",
    yaml: baseYaml({ extra: ["    summaries:", "      score: Sum"] }),
    // 刀4: summaries without `groupBy` are the single ungrouped group (P8), so
    // both grouping keys appear.
    expect: { groupingKeys: ["groups", "summaries"] },
  },
  {
    keyPath: "views[].cardSize",
    behavior: "ACCEPT-silent",
    classification: "DISPLAY-METADATA",
    flip: false,
    yaml: baseYaml({ extra: ["    cardSize: 120"] }),
    expect: {},
  },
  {
    keyPath: "views[].image",
    behavior: "ACCEPT-silent",
    classification: "DISPLAY-METADATA",
    flip: false,
    yaml: baseYaml({ extra: ["    image: cover"] }),
    expect: {},
  },
  {
    keyPath: "views[].<unknown key>",
    behavior: "ACCEPT-silent",
    classification: "DISPLAY-METADATA",
    flip: false,
    yaml: baseYaml({ extra: ["    mysteryKey: 1"] }),
    expect: {},
  },

  // ── `properties.<key>` config keys ───────────────────────────────────────
  {
    keyPath: "properties.formula.note.displayName",
    behavior: "ACCEPT-consumed",
    classification: "DISPLAY-METADATA",
    flip: false,
    yaml: baseYaml({
      top: ["formulas:", "  note: file.asLink(if(title, title, file.name))", "properties:", "  formula.note:", '    displayName: "Note"'],
      view: ["    type: table", "    name: V", '    order: ["formula.note", "file.name"]'],
    }),
    expect: {
      valueKeys: ["formula.note", "file.name"],
      columns: [
        { key: "formula.note", label: "Note", kind: "formula" },
        { key: "file.name", label: "名称", kind: "property" },
      ],
    },
  },
  {
    keyPath: "properties.status.displayName",
    behavior: "ACCEPT-silent",
    classification: "DISPLAY-METADATA",
    flip: false,
    // DISPLAY-METADATA: the display slice this row anticipated landed in
    // `desktop-re/bases-ui-parity-2` (2026-10-21) and was CORRECTED by
    // `desktop-re/column-label-surfaces` (2026-10-24): `properties[key].displayName` is
    // consumed for a FORMULA column only. A note property keeps the DESKTOP built-in
    // name table (`desktop-re/bases-builtin-names`, 14 `file.*` keys: `file.name` →
    // `名称`), and a key the desktop has no name for falls back to the key tail — so the
    // declared `Declared Status` is intentionally NOT the label of `status` (owner
    // screenshots 01/04: the header reads `status` / `updated` for a `.base` that declares
    // 状态 / 更新).
    yaml: baseYaml({ top: ["properties:", "  status:", '    displayName: "Declared Status"'] }),
    expect: {
      columns: [
        { key: "file.name", label: "名称", kind: "property" },
        { key: "status", label: "status", kind: "property" },
        { key: "score", label: "score", kind: "property" },
      ],
    },
  },
  {
    keyPath: "properties.status.<unknown config key>",
    behavior: "ACCEPT-silent",
    classification: "DISPLAY-METADATA",
    flip: false,
    yaml: baseYaml({ top: ["properties:", "  status:", "    mystery: 1"] }),
    expect: {},
  },
]);

function caseTitle(spec) {
  if (spec.expect.code) return `should reject ${spec.keyPath} with error code=${spec.expect.code}`;
  const verb = spec.behavior === "ACCEPT-consumed" ? "accept and consume" : "silently accept";
  return `should ${verb} ${spec.keyPath} and return supportedSubset=true`;
}

// The fail-closed set and the table must never drift apart: the reviewer greps
// both, and a key can only leave the set by also changing its row.
test("the fail-closed key list and the rejected table rows agree", () => {
  const rejected = SEMANTIC_KEY_CASES.filter((spec) => spec.expect.code === "unsupported").map((spec) => spec.keyPath).sort();
  assert.deepEqual(rejected, [...FROZEN_UNSUPPORTED_AFTER_CUT4].sort());
  for (const spec of SEMANTIC_KEY_CASES) {
    if (FROZEN_UNSUPPORTED_AFTER_CUT4.includes(spec.keyPath)) {
      assert.equal(spec.behavior, "REJECT unsupported", `${spec.keyPath}: a fail-closed key must declare the rejection`);
      assert.equal(spec.classification, "KNOWN-UNIMPLEMENTED-SEMANTIC", `${spec.keyPath}: fail-closed rows are semantic, never display metadata`);
    }
  }
});

for (const spec of SEMANTIC_KEY_CASES) {
  test(caseTitle(spec), () => {
    const expect = { code: null, validatorErrors: [], view: "V", rowCount: 3, totalMatched: 3, truncated: false, ...spec.expect };
    const label = spec.keyPath;

    // 1. Schema validation — the frozen error array (empty for every row today;
    //    a W0-D row may declare the `invalid-schema` text instead).
    if (expect.validatorErrors.length) {
      const message = `Invalid Base: ${expect.validatorErrors.join("; ")}`;
      assert.throws(
        () => parseAndValidateBase(spec.yaml),
        (error) => error instanceof BaseQueryError && error.code === "invalid-schema" && error.message === message,
        `${label}: schema rejection`,
      );
    } else {
      assert.deepEqual(validateBaseDocument(parseAndValidateBase(spec.yaml).base), [], `${label}: validateBaseDocument errors`);
    }

    // 2. Canonical pipeline — current behavior (accept) or the W0-D flip (reject).
    let snapshot = null;
    let error = null;
    try {
      snapshot = queryBaseSnapshot({ raw: spec.yaml, records: RECORDS });
    } catch (thrown) {
      error = thrown;
    }

    if (expect.code) {
      assert.ok(error instanceof BaseQueryError, `${label}: must fail closed with BaseQueryError, got ${error?.message}`);
      assert.equal(error.code, expect.code, `${label}: error code`);
      return;
    }
    assert.equal(error, null, `${label}: must not fail: ${error?.message}`);

    // 3. Supported-subset claim + the exact DTO surface (MCP hardcodes the
    //    claim at app/src/tools/workflows.js:472 without consulting it).
    assert.equal(snapshot.supportedSubset, true, `${label}: supportedSubset`);
    const groupingKeys = spec.expect.groupingKeys ?? [];
    assert.deepEqual(Object.keys(snapshot).sort(), [...SNAPSHOT_DTO_KEYS, ...groupingKeys].sort(), `${label}: DTO key set`);
    for (const key of groupingKeys) assert.ok(GROUPING_DTO_KEYS.includes(key), `${label}: ${key} is an ADD-only grouping key`);
    assert.equal(snapshot.view, expect.view, `${label}: selected view`);
    if (expect.views) assert.deepEqual(snapshot.views, expect.views, `${label}: declared views`);
    assert.equal(snapshot.rows.length, expect.rowCount, `${label}: rows.length`);
    assert.equal(snapshot.totalMatched, expect.totalMatched, `${label}: totalMatched`);
    assert.equal(snapshot.truncated, expect.truncated, `${label}: truncated`);
    for (const row of snapshot.rows) {
      assert.deepEqual(Object.keys(row).sort(), ["path", "values"], `${label}: row shape (no grouping/summary payload)`);
    }
    if (expect.valueKeys) assert.deepEqual(Object.keys(snapshot.rows[0].values), expect.valueKeys, `${label}: value keys`);
    if (expect.columns) assert.deepEqual(snapshot.columns, expect.columns, `${label}: columns/labels`);
  });
}

// 刀4 declaration rules: `null`, `undefined`, `{}` and `[]` still count as
// absent (no error, no DTO change), a malformed declaration still fails closed,
// and the three formerly-rejected keys are now executed instead of rejected.
test("an empty groupBy/summaries declaration is absent; a malformed one fails closed; a valid one is executed", () => {
  const absent = [
    ["views[].groupBy", baseYaml({ extra: ["    groupBy: {}"] })],
    ["views[].groupBy", baseYaml({ extra: ["    groupBy:"] })],
    ["views[].summaries", baseYaml({ extra: ["    summaries: {}"] })],
    ["views[].summaries", baseYaml({ extra: ["    summaries: []"] })],
    ["summaries", baseYaml({ top: ["summaries: {}"] })],
    ["summaries", baseYaml({ top: ["summaries: []"] })],
    ["summaries", baseYaml({ top: ["summaries:"] })],
  ];
  for (const [keyPath, yaml] of absent) {
    const snapshot = queryBaseSnapshot({ raw: yaml, records: RECORDS });
    assert.equal(snapshot.supportedSubset, true, `${keyPath}: an empty declaration is absent, not unsupported`);
    assert.equal(snapshot.rows.length, 3, `${keyPath}: rows are unaffected`);
    assert.deepEqual(Object.keys(snapshot).sort(), SNAPSHOT_DTO_KEYS, `${keyPath}: an absent declaration adds no DTO key`);
  }

  // Malformed shapes are still shape errors (never a half-applied semantic).
  const malformed = [
    ["views[].groupBy", baseYaml({ extra: ["    groupBy: status"] })],
    ["views[].summaries", baseYaml({ extra: ["    summaries: [Sum]"] })],
    ["summaries", baseYaml({ top: ["summaries: values"] })],
  ];
  for (const [keyPath, yaml] of malformed) {
    assert.throws(
      () => queryBaseSnapshot({ raw: yaml, records: RECORDS }),
      (error) => error instanceof BaseQueryError && error.code === "unsupported" && error.message.includes(keyPath),
      `${keyPath}: a malformed declaration is unsupported`,
    );
  }

  // 刀4: the same declarations are now EXECUTED (not rejected).
  const executed = [
    ["views[].groupBy", baseYaml({ extra: ["    groupBy:", "      property: status"] }), ["groups"]],
    ["views[].summaries", baseYaml({ extra: ["    summaries:", "      score: Sum"] }), ["groups", "summaries"]],
  ];
  for (const [keyPath, yaml, keys] of executed) {
    const snapshot = queryBaseSnapshot({ raw: yaml, records: RECORDS });
    assert.equal(snapshot.supportedSubset, true, `${keyPath}: executed`);
    assert.deepEqual(Object.keys(snapshot).sort(), [...SNAPSHOT_DTO_KEYS, ...keys].sort(), `${keyPath}: DTO key set`);
  }

  // The write path is untouched: the same documents still validate.
  for (const [, yaml] of [...malformed, ...absent.map(([, yaml]) => [null, yaml])]) {
    assert.deepEqual(validateBaseDocument(parseAndValidateBase(yaml).base), [], "validateBaseDocument stays the schema layer");
  }
});

// Positive control: every documented-and-supported key together in one real
// document must evaluate end to end (rows, order, limit, labels, link cell).
test("positive control: a fully supported Base evaluates end to end", () => {
  const raw = baseYaml({
    top: ["formulas:", "  note: file.asLink(if(title, title, file.name))", "properties:", "  formula.note:", '    displayName: "Note"'],
    view: [
      "    type: table",
      "    name: Full",
      "    limit: 3",
      '    order: ["formula.note", "file.name", "score"]',
      "    filters: score >= 5",
      "    sort:",
      "      - property: score",
      "        direction: DESC",
    ],
  });
  assert.deepEqual(validateBaseDocument(parseAndValidateBase(raw).base), []);
  const snapshot = queryBaseSnapshot({ raw, records: RECORDS });
  assert.equal(snapshot.supportedSubset, true);
  assert.equal(snapshot.view, "Full");
  assert.deepEqual(snapshot.views, [{ name: "Full", type: "table" }]);
  assert.equal(snapshot.totalMatched, 2);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.viewLimit, 3);
  assert.deepEqual(snapshot.rows.map((row) => row.path), ["WB/Alpha.md", "WB/Delta.md"]);
  assert.deepEqual(snapshot.columns, [
    { key: "formula.note", label: "Note", kind: "formula" },
    { key: "file.name", label: "名称", kind: "property" },
    { key: "score", label: "score", kind: "property" },
  ]);
  assert.deepEqual(snapshot.rows[0].values["formula.note"], { path: "WB/Alpha.md", displayName: "Alpha Title", kind: "asLink" });
});

// The frozen table is the contract; unwired expectations would be a silent gap.
test("every frozen case declares an explicit current behavior and classification", () => {
  const classifications = new Set(["SUPPORTED", "KNOWN-UNIMPLEMENTED-SEMANTIC", "DISPLAY-METADATA", "NOT-APPLICABLE"]);
  const behaviors = new Set(["ACCEPT-consumed", "ACCEPT-silent", "REJECT unsupported"]);
  const keyPaths = SEMANTIC_KEY_CASES.map((spec) => spec.keyPath);
  assert.equal(new Set(keyPaths).size, keyPaths.length, "key paths must be unique");
  for (const spec of SEMANTIC_KEY_CASES) {
    assert.ok(classifications.has(spec.classification), `${spec.keyPath}: classification`);
    assert.ok(behaviors.has(spec.behavior), `${spec.keyPath}: behavior`);
    assert.equal(typeof spec.yaml, "string", `${spec.keyPath}: YAML fragment`);
  }
});
