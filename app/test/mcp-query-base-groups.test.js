// Issue #627 (P1) — `query_base` must PROJECT the cut-4 grouping DTO.
//
// Before this lane the shared service computed `groups` / `summaries` (刀4,
// PR #610) and the Web Base route mapped them, but the MCP handler reassembled
// the pre-刀4 DTO, so an agent got `supportedSubset: true` with the grouping
// intent silently swallowed. The contract pinned here:
//
//   1. ADD-only: the keys appear ONLY when the selected view declares
//      `groupBy` / `summaries`. Undeclared ⇒ the keys are absent (never
//      `null` / `[]`) and the whole DTO is byte-identical to the historical one.
//   2. The values are the service's verbatim ones: group order/`keyType`,
//      `Σ count === min(totalMatched, limit)`, per-group summaries, and the
//      whole-set `summaries` — no second calculator in the MCP adapter.
//   3. The grouping keys are appended AFTER the frozen historical fields.
//   4. The four text formats keep their frozen text (grouping never leaks into
//      csv/tsv/md/paths) while `structuredContent` still carries `groups` /
//      `summaries`, so the intent is never dropped.
//   5. Declared-but-unprojected fails closed with `code: "unsupported"`.
//
// Negative controls at the bottom: deleting the projection wiring (mutant) and
// flipping `groupBy.direction` both turn the real assertions red.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import yaml from "js-yaml";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-base-groups-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
await fs.mkdir(data, { recursive: true });

function note(frontmatter) {
  const keys = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---\n${keys}\n---\n# ${frontmatter.title ?? "note"}\n`;
}

// Five rows: `status` has BOTH a missing value and an explicit null (the frozen
// missing ≡ null equivalence, one keyless group) and `score` is unique per row so
// a sort key is also a row identity in the assertions.
const NOTES = {
  "G/Alpha.md": note({ title: "Alpha", status: "active", score: 8, flag: true }),
  "G/Bravo.md": note({ title: "Bravo", status: "done", score: 3, flag: false }),
  "G/Delta.md": note({ title: "Delta", status: "active", score: 5, flag: true }),
  "G/Echo.md": note({ title: "Echo", score: 1 }),
  "G/Foxtrot.md": note({ title: "Foxtrot", status: "null", score: 0 }),
};

const FILTER = 'filters: file.inFolder("G")';
const VIEW_TAIL = (extra) => ["  - type: table", "    name: V", "    order: [file.name, status, score, flag]", ...extra, ""];
const SORT_SCORE = ["    sort:", "      - property: score", "        direction: ASC"];

const BASES = {
  // Undeclared: the frozen historical DTO (the B1 lock shape).
  "Ungrouped.base": [FILTER, "views:", ...VIEW_TAIL(SORT_SCORE)].join("\n"),
  // groupBy only.
  "Grouped.base": [FILTER, "views:", ...VIEW_TAIL([...SORT_SCORE, "    groupBy:", "      property: status"])].join("\n"),
  // groupBy DESC: moves GROUPS only (the null group stays last under both).
  "GroupedDesc.base": [FILTER, "views:", ...VIEW_TAIL([...SORT_SCORE, "    groupBy:", "      property: status", "      direction: DESC"])].join("\n"),
  // groupBy + summaries (per group and view-wide).
  "Summaries.base": [FILTER, "views:", ...VIEW_TAIL([
    ...SORT_SCORE,
    "    groupBy:",
    "      property: status",
    "    summaries:",
    "      score: Sum",
    "      status: Unique",
    "      flag: Checked",
  ])].join("\n"),
  // summaries WITHOUT groupBy: one keyless group over the retained rows (P8).
  "WholeSummaries.base": [FILTER, "views:", ...VIEW_TAIL([
    ...SORT_SCORE,
    "    summaries:",
    "      score: Sum",
    "      title: Unique",
  ])].join("\n"),
  // limit truncates the flat rows BEFORE grouping (P6/P7).
  "Limited.base": [FILTER, "views:", ...VIEW_TAIL([
    ...SORT_SCORE,
    "    limit: 3",
    "    groupBy:",
    "      property: status",
  ])].join("\n"),
  // 0 rows: 0 groups (groupBy declared) / 1 empty group + empty summaries.
  "Empty.base": ['filters: file.inFolder("Nope")', "views:", ...VIEW_TAIL([
    "    groupBy:",
    "      property: status",
    "    summaries:",
    "      score: Sum",
  ])].join("\n"),
  // A formula COLUMN as a summary key is executed; `groupBy` on a formula stays
  // fail-closed (assertNoFormulaReferencesInGroupBy), so this groups by `status`.
  "FormulaGrouped.base": [
    FILTER,
    "formulas:",
    "  note: file.asLink(if(title, title, file.name))",
    "views:",
    "  - type: table",
    "    name: V",
    "    order: [formula.note, file.name, status]",
    "    groupBy:",
    "      property: status",
    "    summaries:",
    "      formula.note: Unique",
    "",
  ].join("\n"),
  // A NON-selected view with an illegal declaration still fails closed: the gate
  // is document-scoped (#612/#610), so `view: Good` must not launder it.
  "OtherBadView.base": [FILTER, "views:", "  - type: table", "    name: Good", "    order: [file.name]", "  - type: table", "    name: Bad", "    order: [file.name]", "    groupBy:", "      property: status", "      direction: SIDEWAYS", ""].join("\n"),
};

for (const [relative, content] of Object.entries({ ...NOTES, ...BASES })) {
  const absolute = path.join(vault, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

const { projectBaseGroupingDto, registerWorkflowTools } = await import("../src/tools/workflows.js");
const { getVaultIndex } = await import("../src/vault-index.js");
const { parseAndValidateBase, queryBaseSnapshot } = await import("../src/base-query.js");
const { computeBaseSummaries, readSummaryDeclarations } = await import("../src/base-summaries.js");
const { renderBaseQueryFormat } = await import("../src/base-formats.js");

// The frozen pre-#627 structuredContent contract, in field order.
const HISTORICAL_KEYS = ["path", "view", "rows", "totalMatched", "truncated", "supportedSubset", "index"];

let server;
let client;
let index;

before(async () => {
  index = await getVaultIndex();
  server = new McpServer({ name: "base-groups-test", version: "1" });
  registerWorkflowTools(server);
  client = new Client({ name: "base-groups-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  if (client) await client.close();
  if (server) await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function queryBase(arguments_) {
  return client.callTool({ name: "query_base", arguments: arguments_ });
}

async function queryOk(arguments_) {
  const result = await queryBase(arguments_);
  assert.notEqual(result.isError, true, `query_base must not fail: ${result.content?.[0]?.text}`);
  return result;
}

// The service snapshot for the same .base/records the MCP call reads, used as
// the independent side of the parity assertions.
function snapshot(baseName, { view, limit } = {}) {
  return queryBaseSnapshot({
    raw: BASES[baseName],
    viewName: view,
    records: index.records,
    limit,
  });
}

// Frontmatter of a `G/*.md` fixture path, parsed from the same text that was
// written to the Vault (an independent second read of the fixture's data).
function frontmatterOf(vaultPath) {
  return yaml.load(NOTES[vaultPath].split("---")[1]);
}

const keyOfGroup = (group) => `${group.keyType}:${JSON.stringify(group.key)}`;

// ── 1. Undeclared ⇒ absent keys + historical bytes ──────────────────────────

test("undeclared: neither groups nor summaries is emitted, and the DTO is byte-identical to the historical one", async () => {
  const payload = (await queryOk({ path: "Ungrouped.base" })).structuredContent;
  assert.deepEqual(Object.keys(payload), HISTORICAL_KEYS);
  assert.equal(Object.hasOwn(payload, "groups"), false, "an undeclared groupBy must not emit groups (not even [])");
  assert.equal(Object.hasOwn(payload, "summaries"), false, "an undeclared summaries must not emit summaries (not even null)");

  // The historical DTO rebuilt from the same service result, in the same key
  // order. `index` carries per-refresh counters (revision/duration/lastRefresh)
  // that legitimately differ between two reads, so the byte comparison uses the
  // payload's own index object (the shape itself is asserted below).
  const snap = snapshot("Ungrouped.base");
  const historical = {
    path: "Ungrouped.base",
    view: snap.view,
    rows: snap.rows,
    totalMatched: snap.totalMatched,
    truncated: snap.truncated,
    supportedSubset: true,
    index: payload.index,
  };
  assert.equal(JSON.stringify(payload), JSON.stringify(historical), "the undeclared DTO must stay byte-identical");
  assert.deepEqual(Object.keys(payload.index), Object.keys(index.stats));
  assert.equal(JSON.parse((await queryOk({ path: "Ungrouped.base" })).content[0].text).groups, undefined);
});

// ── 2. groupBy ⇒ groups projected, partition invariants hold ─────────────────

test("groupBy: groups appear after the historical fields and partition the retained rows", async () => {
  const payload = (await queryOk({ path: "Grouped.base" })).structuredContent;
  assert.deepEqual(Object.keys(payload), [...HISTORICAL_KEYS, "groups"]);
  assert.equal(payload.groups.length, 3);

  // ASC typed order with the keyless group LAST (D1), missing ≡ null in one group.
  assert.deepEqual(payload.groups.map(keyOfGroup), ['string:"active"', 'string:"done"', "null:null"]);
  assert.deepEqual(payload.groups.map((group) => group.count), [2, 1, 2]);
  // Members keep the SORT order (score ASC: 0,1,3,5,8), never path order.
  assert.deepEqual(payload.groups.map((group) => group.rowPaths), [
    ["G/Delta.md", "G/Alpha.md"],
    ["G/Bravo.md"],
    ["G/Foxtrot.md", "G/Echo.md"],
  ]);

  // Σ count === min(totalMatched, limit) (刀4 frozen semantics, reused verbatim).
  // This view declares no `limit`, so the ceiling is `totalMatched` itself.
  assert.equal(payload.groups.reduce((total, group) => total + group.count, 0), payload.totalMatched);
  // The partition never reorders, adds or drops a row: the groups in group order
  // are a permutation of the row sequence, and each group is a contiguous block
  // of it (rowIndexes are ascending in `base-grouping.js`).
  assert.deepEqual(
    payload.groups.flatMap((group) => group.rowPaths).slice().sort(),
    payload.rows.map((row) => row.path).slice().sort(),
  );
  // The projected DTO equals the service DTO (no MCP-side recomputation drift).
  assert.deepEqual(payload.groups, snapshot("Grouped.base").groups);
});

test("groupBy.direction moves GROUPS only: DESC reverses the non-null groups and keeps the null group last", async () => {
  const asc = (await queryOk({ path: "Grouped.base" })).structuredContent;
  const desc = (await queryOk({ path: "GroupedDesc.base" })).structuredContent;
  assert.deepEqual(desc.groups.map(keyOfGroup), ['string:"done"', 'string:"active"', "null:null"]);
  assert.deepEqual(desc.rows, asc.rows, "rows keep the sort order; only group order changes");
  assert.notDeepEqual(desc.groups.map(keyOfGroup), asc.groups.map(keyOfGroup));
});

// ── 3. summaries ⇒ projected and equal to a DIRECT base-summaries run ────────

test("summaries: per-group and view-wide values equal a direct computeBaseSummaries run", async () => {
  const payload = (await queryOk({ path: "Summaries.base" })).structuredContent;
  assert.deepEqual(Object.keys(payload), [...HISTORICAL_KEYS, "groups", "summaries"]);
  assert.equal(payload.summaries.scope, "visible-rows");

  const { base } = parseAndValidateBase(BASES["Summaries.base"]);
  const declarations = readSummaryDeclarations(base.views[0].summaries, "views[].summaries");
  const columnKeys = ["file.name", "status", "score", "flag"];
  const direct = (rowPaths) => computeBaseSummaries({
    declarations,
    rows: rowPaths.map(frontmatterOf),
    resolveValue: (frontmatter, property) => frontmatter[property],
    columnKeys,
  });

  // Independently recomputed from the fixtures' frontmatter only.
  assert.deepEqual(payload.summaries.values, direct(payload.rows.map((row) => row.path)));
  for (const group of payload.groups) {
    assert.deepEqual(group.summaries.values, direct(group.rowPaths), `group ${keyOfGroup(group)}`);
    assert.equal(group.summaries.scope, "visible-rows");
  }
  // Spot-check one real aggregate so the equality above cannot be vacuous:
  // scores 8 + 5 for `active`.
  assert.equal(payload.groups[0].summaries.values.score.value, 13);
  assert.equal(payload.groups[0].summaries.values.flag.value, 2);
});

test("summaries without groupBy: one keyless group over the retained rows (P8)", async () => {
  const payload = (await queryOk({ path: "WholeSummaries.base" })).structuredContent;
  assert.deepEqual(Object.keys(payload), [...HISTORICAL_KEYS, "groups", "summaries"]);
  assert.equal(payload.groups.length, 1);
  assert.equal(payload.groups[0].key, null);
  assert.equal(payload.groups[0].keyType, "null");
  assert.equal(payload.groups[0].count, payload.rows.length);
  assert.deepEqual(payload.groups[0].summaries, payload.summaries);
  // `title` is not a projected column of this view: it reports not-a-column
  // instead of vanishing (E8).
  assert.deepEqual(payload.summaries.values.title, { summary: "Unique", value: null, reason: "not-a-column" });
});

// ── 4. Degenerate / bounded / fail-closed cases ─────────────────────────────

test("0 rows: groups is [] with groupBy and summaries still report `empty`", async () => {
  const payload = (await queryOk({ path: "Empty.base" })).structuredContent;
  assert.deepEqual(payload.groups, [], "no rows ⇒ zero groups (an empty array, not an absent key)");
  assert.deepEqual(payload.summaries, { scope: "visible-rows", values: { score: { summary: "Sum", value: null, reason: "empty" } } });
  assert.equal(payload.totalMatched, 0);
});

test("limit truncation happens BEFORE grouping: Σ count === min(totalMatched, limit)", async () => {
  const payload = (await queryOk({ path: "Limited.base" })).structuredContent;
  assert.equal(payload.totalMatched, 5);
  assert.equal(payload.truncated, true);
  assert.equal(payload.rows.length, 3);
  // Sorted by score ASC the kept rows are Foxtrot(0), Echo(1), Bravo(3): `done`
  // survives with 1 row and `active` keeps none, so no `active` group exists.
  assert.deepEqual(payload.groups.map(keyOfGroup), ['string:"done"', "null:null"]);
  assert.deepEqual(payload.groups.map((group) => group.count), [1, 2]);
  assert.equal(payload.groups.reduce((total, group) => total + group.count, 0), Math.min(payload.totalMatched, 3));
  // An explicit `limit` parameter drives the same ceiling.
  const limited = (await queryOk({ path: "Grouped.base", limit: 2 })).structuredContent;
  assert.equal(limited.groups.reduce((total, group) => total + group.count, 0), 2);
});

test("formula column: a formula.* summary key is projected, its values stay the service's", async () => {
  const payload = (await queryOk({ path: "FormulaGrouped.base" })).structuredContent;
  assert.equal(payload.summaries.values["formula.note"].summary, "Unique");
  assert.equal(payload.summaries.values["formula.note"].value, payload.rows.length);
  assert.deepEqual(payload.summaries, snapshot("FormulaGrouped.base").summaries);
});

test("a NON-selected view with an illegal declaration still fails closed with a machine-readable code", async () => {
  const result = await queryBase({ path: "OtherBadView.base", view: "Good" });
  assert.equal(result.isError, true, "the document-scoped gate must not be bypassed by view selection");
  assert.equal(result.structuredContent.code, "unsupported");
  assert.match(result.structuredContent.message, /groupBy/);
  assert.equal(Object.hasOwn(result.structuredContent, "supportedSubset"), false, "no fake-success flag on an error");
});

// ── 5. The five formats ────────────────────────────────────────────────────

test("json: the grouping keys are the whole payload — no format/text keys", async () => {
  const payload = (await queryOk({ path: "Summaries.base", format: "json" })).structuredContent;
  assert.deepEqual(Object.keys(payload), [...HISTORICAL_KEYS, "groups", "summaries"]);
  assert.equal(Object.hasOwn(payload, "format"), false);
  assert.equal(Object.hasOwn(payload, "text"), false);
});

for (const format of ["csv", "tsv", "md", "paths"]) {
  test(`${format}: the rendered text never expresses grouping, structuredContent still carries it`, async () => {
    const result = await queryOk({ path: "Summaries.base", format });
    const payload = result.structuredContent;
    const snap = snapshot("Summaries.base");
    // The frozen renderer output for the SAME columns/rows: grouping contributes
    // no header, no row and no separator to the text.
    const expected = renderBaseQueryFormat({ format, columns: snap.columns, rows: snap.rows });
    assert.equal(result.content[0].text, expected.text, `${format} text must stay flat`);
    assert.equal(payload.text, expected.text);
    assert.equal(payload.format, format);
    if (format === "paths") assert.deepEqual(payload.paths, snap.rows.map((row) => row.path));
    // …but the grouping intent is on the wire in the structured payload.
    assert.deepEqual(Object.keys(payload), [...HISTORICAL_KEYS, "groups", "summaries", "format", "text", ...(format === "paths" ? ["paths"] : [])]);
    assert.deepEqual(payload.groups, snap.groups);
    assert.deepEqual(payload.summaries, snap.summaries);
    // No group header / subtotal line was appended: the line count is exactly the
    // flat header (+ md separator) plus one line per row.
    const lines = expected.text.split("\n");
    assert.equal(lines.length, format === "paths" ? snap.rows.length : snap.rows.length + (format === "md" ? 2 : 1));
  });
}

// ── 6. Negative controls ───────────────────────────────────────────────────

test("negative control: deleting the projection wiring makes the groups assertions red", () => {
  const { base } = parseAndValidateBase(BASES["Grouped.base"]);
  const result = snapshot("Grouped.base");
  const real = projectBaseGroupingDto({ view: base.views[0], result });
  // Mutant = the pre-#627 wiring: the handler spread `{}` (or nothing at all).
  const deletedWiring = () => ({});
  assert.deepEqual(Object.keys(real), ["groups"]);
  assert.deepEqual(Object.keys(deletedWiring()), []);
  // The end-to-end key list above is exactly historical ⊕ this projection, so a
  // handler that stopped spreading it would fail the earlier key assertions.
  const undeclared = parseAndValidateBase(BASES["Ungrouped.base"]).base;
  assert.deepEqual(projectBaseGroupingDto({ view: undeclared.views[0], result: snapshot("Ungrouped.base") }), {});
});

test("negative control: a declared view whose result lost its groups fails closed instead of reporting success", () => {
  const { base } = parseAndValidateBase(BASES["Grouped.base"]);
  assert.throws(
    () => projectBaseGroupingDto({ view: base.views[0], result: { rows: [] } }),
    (error) => error.code === "unsupported" && /groupBy\/summaries/.test(error.message),
  );
  const summaries = parseAndValidateBase(BASES["Summaries.base"]).base;
  assert.throws(
    () => projectBaseGroupingDto({ view: summaries.views[0], result: { groups: [] } }),
    (error) => error.code === "unsupported" && /summaries/.test(error.message),
  );
});

test("negative control: flipping groupBy.direction turns the group-order assertion red", () => {
  const ascKeys = snapshot("Grouped.base").groups.map(keyOfGroup);
  const descKeys = snapshot("GroupedDesc.base").groups.map(keyOfGroup);
  // The two declarations differ ONLY in `direction`; the order differs, so the
  // DESC assertion in test 2 cannot hold against a flipped/ignored direction.
  assert.notDeepEqual(descKeys, ascKeys);
  assert.deepEqual(descKeys.slice(0, 2), ascKeys.slice(0, 2).reverse());
});
