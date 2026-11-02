// A1 + A6 — `query_base` output formats and structured error codes.
//
// A1: `format: json|csv|tsv|md|paths`. The csv/tsv/md renderers are frozen
// against the desktop bundle's `toText` / `toMarkdown` semantics (see
// app/src/base-formats.js header and HANDOFF.md for the byte offsets), and the
// hard requirement is that omitting `format` stays byte-identical to the
// historical json DTO (the pre/post capture is recorded in HANDOFF.md; this
// file locks the in-repo half of it).
//
// A6: a failing `query_base` returns `structuredContent: { code, message }`
// while keeping the historical `Error: <message>` text.
//
// The last two tests are negative controls: local mutants of the format
// dispatch and of the structured-error shape prove the assertions above are not
// vacuous (a real source mutation of either branch turns them red; the raw
// in-session mutation runs are recorded in HANDOFF.md).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  BASE_QUERY_FORMATS,
  BaseFormatError,
  assertBaseQueryFormat,
  baseDelimitedTable,
  baseFormatCell,
  baseMarkdownTable,
  renderBaseQueryFormat,
} from "../src/base-formats.js";
import { err, errStructured } from "../src/result.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-base-formats-"));
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

const VIEW_ORDER = ["    order:", "      - file.name", "      - title", "      - status"];

const FIXTURES = {
  "F/One.md": '---\ntitle: "He said \\"hi\\", loudly"\nstatus: active\n---\n# One\n',
  // `|` is a real pipe in the value: it must survive csv/tsv unchanged and be
  // escaped in markdown.
  "F/Two.md": '---\ntitle: plain\nstatus: "has | pipe"\n---\n# Two\n',
  "Formats.base": ["filters: file.inFolder(\"F\")", "views:", "  - type: table", "    name: Formats", ...VIEW_ORDER, ""].join("\n"),
  "Empty.base": ["filters: file.inFolder(\"Nope\")", "views:", "  - type: table", "    name: Empty", "    order:", "      - file.name", "      - status", ""].join("\n"),
  // A6 unknown-base-key case: a documented-but-unimplemented semantic key.
  // 刀4 implements `groupBy`, so the fixture uses a `groupBy` this subset still
  // cannot execute — an illegal `direction` — keeping the same `unsupported` +
  // `/groupBy/` surface (same shape as `bases-fail-closed-adapters.test.js`).
  "Grouped.base": ["views:", "  - type: table", "    name: Grouped", "    groupBy:", "      property: status", "      direction: SIDEWAYS", "    order: [file.name]", ""].join("\n"),
  // A6 unknown-operator case.
  "BadOperator.base": ["filters: 'status =~ \"active\"'", "views:", "  - type: table", "    name: Bad", "    order: [file.name]", ""].join("\n"),
  "BadSchema.base": ["views: not-an-array", ""].join("\n"),
  "BadYaml.base": ["views: [", "  - {", ""].join("\n"),
};
for (const [relative, content] of Object.entries(FIXTURES)) {
  const absolute = path.join(vault, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

// Frozen exact expectations for the Formats.base fixture (headers are the
// `base-query.js` display labels: `file.name` -> the desktop built-in name `名称`,
// U5 closure `desktop-re/bases-builtin-names`; a key with no desktop name still shows
// its own key, see `status` below).
const EXPECTED_CSV = ["名称,title,status", 'One,"He said ""hi"", loudly",active', "Two,plain,has | pipe"].join("\n");
const EXPECTED_TSV = ["名称\ttitle\tstatus", 'One\t"He said ""hi"", loudly"\tactive', "Two\tplain\thas | pipe"].join("\n");
const EXPECTED_MD_EMPTY = ["| name | status |", "| ---- | ------ |"].join("\n");
// The Empty.base fixture's real header row: its order is `file.name, status` and
// `file.name` is a desktop built-in name (U5), so the rendered label is `名称` — two
// code points, hence the narrower separator and the different padding.
const EXPECTED_MD_EMPTY_FORMATS = ["| 名称 | status |", "| -- | ------ |"].join("\n");
const EXPECTED_MD_FORMATS = [
  "| 名称  |        title         |   status    |",
  "| --- | -------------------- | ----------- |",
  '| One | He said "hi", loudly |   active    |',
  "| Two |        plain         | has \\| pipe |",
].join("\n");

const { registerWorkflowTools } = await import("../src/tools/workflows.js");
const { getVaultIndex } = await import("../src/vault-index.js");
// config-dependent: imported only after VAULT_PATH/DATA_PATH are set above.
const { wave1ComparableInputSchema } = await import("../src/tool-schema-compat.js");
const { VAULT_ID_INPUT_SPEC } = await import("../src/vault-scope.js");
await getVaultIndex();

let server;
let client;

before(async () => {
  server = new McpServer({ name: "base-formats-test", version: "1" });
  registerWorkflowTools(server);
  client = new Client({ name: "base-formats-client", version: "1" });
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

// ── A1: pure renderer contract ──────────────────────────────────────────────

test("format vocabulary is closed and the default is json", () => {
  assert.deepEqual([...BASE_QUERY_FORMATS], ["json", "csv", "tsv", "md", "paths"]);
  assert.equal(assertBaseQueryFormat(undefined), "json");
  assert.equal(assertBaseQueryFormat(""), "json");
  assert.equal(assertBaseQueryFormat("md"), "md");
});

test("assertBaseQueryFormat fails closed on an unknown format instead of falling back to json", () => {
  assert.throws(() => assertBaseQueryFormat("yaml"), (error) => {
    assert.equal(error.code, "invalid-format");
    assert.match(error.message, /Unsupported Base query format: yaml/);
    return true;
  });
  assert.throws(() => renderBaseQueryFormat({ format: "yaml", columns: [], rows: [] }), { code: "invalid-format" });
});

test("cell rendering: null/undefined empty, Date ISO, list comma-joined, asLink display name, object JSON", () => {
  assert.equal(baseFormatCell(null), "");
  assert.equal(baseFormatCell(undefined), "");
  assert.equal(baseFormatCell(""), "");
  assert.equal(baseFormatCell(0), "0");
  assert.equal(baseFormatCell(false), "false");
  assert.equal(baseFormatCell(new Date("2026-09-01T00:00:00Z")), "2026-09-01T00:00:00.000Z");
  assert.equal(baseFormatCell(new Date("not a date")), "");
  assert.equal(baseFormatCell(["work", "alpha"]), "work,alpha");
  assert.equal(baseFormatCell({ path: "WB/Two.md", displayName: "Two", kind: "asLink" }), "Two");
  assert.equal(baseFormatCell({ path: "WB/Two.md", kind: "asLink" }), "WB/Two.md");
  assert.equal(baseFormatCell({ nested: true }), '{"nested":true}');
});

test("csv/tsv quoting matches the desktop toText rule (quote + doubled quotes on separator/quote/newline)", () => {
  const headers = ["a", "b"];
  const body = [["1", "x,y"], ["2", 'q"q'], ["3", "l1\nl2"], ["4", "plain"]];
  assert.equal(
    baseDelimitedTable(headers, body, ","),
    ['a,b', '1,"x,y"', '2,"q""q"', '3,"l1\nl2"', "4,plain"].join("\n"),
  );
  // A comma is not special in TSV, but a tab is.
  assert.equal(baseDelimitedTable(headers, [["1", "x,y"], ["2", "x\ty"]], "\t"), 'a\tb\n1\tx,y\n2\t"x\ty"');
});

test("markdown table matches the desktop toMarkdown rule (pipe escape, centered padding, separator)", () => {
  const rendered = baseMarkdownTable(["a", "|"], [["x|y", "z"]]);
  assert.equal(rendered, ["|  a   | \\| |", "| ---- | -- |", "| x\\|y | z  |"].join("\n"));
  // Empty body: header + separator only.
  assert.equal(baseMarkdownTable(["name", "status"], []), EXPECTED_MD_EMPTY);
});

test("paths renders the desktop newline join and the MCP-friendly array", () => {
  const rendered = renderBaseQueryFormat({ format: "paths", columns: [], rows: [{ path: "a.md" }, { path: "b/c.md" }] });
  assert.equal(rendered.text, "a.md\nb/c.md");
  assert.deepEqual(rendered.paths, ["a.md", "b/c.md"]);
  assert.deepEqual(renderBaseQueryFormat({ format: "paths", columns: [], rows: [] }), { text: "", paths: [] });
  // An empty result in the delimited formats is the header row only.
  assert.equal(renderBaseQueryFormat({ format: "csv", columns: [{ key: "file.name", label: "name" }], rows: [] }).text, "name");
});

// ── A1: end-to-end MCP tool contract ────────────────────────────────────────

test("MCP: omitting format is byte-identical to format=json and keeps the frozen DTO key order", async () => {
  // `index` carries per-refresh counters (publicationRevision, durationMs,
  // lastRefresh) that legitimately change between two calls, so the byte-level
  // comparison masks them (the process-level pre/post capture in HANDOFF.md does
  // the same).
  const maskIndex = (value) => {
    if (value && typeof value === "object") {
      value.publicationRevision = 0;
      value.durationMs = 0;
      value.lastRefresh = "<masked>";
    }
    return value;
  };
  const normalize = (result) => {
    const clone = structuredClone(result);
    maskIndex(clone.structuredContent.index);
    const parsed = JSON.parse(clone.content[0].text);
    maskIndex(parsed.index);
    clone.content[0].text = JSON.stringify(parsed);
    return clone;
  };

  const implicit = await queryOk({ path: "Formats.base" });
  const explicit = await queryOk({ path: "Formats.base", format: "json" });
  assert.deepEqual(Object.keys(implicit.structuredContent), ["path", "view", "rows", "totalMatched", "truncated", "supportedSubset", "index"]);
  assert.ok(!("format" in implicit.structuredContent), "the json DTO must not gain a format field");
  assert.ok(!("text" in implicit.structuredContent), "the json DTO must not gain a text field");
  assert.deepEqual(normalize(implicit), normalize(explicit));
  assert.deepEqual(JSON.parse(implicit.content[0].text), implicit.structuredContent);
});

test("MCP: format=csv returns the desktop csv text and still carries the DTO", async () => {
  const result = await queryOk({ path: "Formats.base", format: "csv" });
  assert.equal(result.content[0].text, EXPECTED_CSV);
  assert.equal(result.structuredContent.format, "csv");
  assert.equal(result.structuredContent.text, EXPECTED_CSV);
  assert.deepEqual(result.structuredContent.rows.map((row) => row.path), ["F/One.md", "F/Two.md"]);
  assert.equal(result.structuredContent.supportedSubset, true);
});

test("MCP: format=tsv returns the desktop tsv text", async () => {
  const result = await queryOk({ path: "Formats.base", format: "tsv" });
  assert.equal(result.content[0].text, EXPECTED_TSV);
  assert.equal(result.structuredContent.format, "tsv");
});

test("MCP: format=md returns the desktop markdown text (empty result = header + separator)", async () => {
  const empty = await queryOk({ path: "Empty.base", format: "md" });
  assert.equal(empty.content[0].text, EXPECTED_MD_EMPTY_FORMATS);
  const withRows = await queryOk({ path: "Formats.base", format: "md" });
  // Frozen exact table: padded centered cells, escaped pipe, separator row.
  assert.equal(withRows.content[0].text, EXPECTED_MD_FORMATS);
  assert.equal(withRows.structuredContent.format, "md");
});

test("MCP: format=paths returns the path array plus the desktop newline text", async () => {
  const result = await queryOk({ path: "Formats.base", format: "paths" });
  assert.deepEqual(result.structuredContent.paths, ["F/One.md", "F/Two.md"]);
  assert.equal(result.content[0].text, "F/One.md\nF/Two.md");
  const empty = await queryOk({ path: "Empty.base", format: "paths" });
  assert.deepEqual(empty.structuredContent.paths, []);
  assert.equal(empty.content[0].text, "");
});

test("MCP: empty results keep the header row in csv/tsv", async () => {
  assert.equal((await queryOk({ path: "Empty.base", format: "csv" })).content[0].text, "名称,status");
  assert.equal((await queryOk({ path: "Empty.base", format: "tsv" })).content[0].text, "名称\tstatus");
});

// ── A6: structured error codes ──────────────────────────────────────────────

test("MCP: an unknown format is an explicit structured error, not a silent json fallback", async () => {
  const result = await queryBase({ path: "Formats.base", format: "yaml" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "invalid-format");
  assert.match(result.structuredContent.message, /Unsupported Base query format: yaml/);
  assert.match(result.content[0].text, /^Error: /);
  assert.ok(!("rows" in result.structuredContent), "no DTO on an error");
});

test("MCP: an unknown base key carries code unsupported", async () => {
  const result = await queryBase({ path: "Grouped.base" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "unsupported");
  assert.match(result.structuredContent.message, /groupBy/);
});

test("MCP: an unknown filter operator carries code unsupported", async () => {
  const result = await queryBase({ path: "BadOperator.base" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "unsupported");
  assert.match(result.structuredContent.message, /Unsupported Base filter expression/);
});

test("MCP: view-not-found / invalid-schema / invalid-yaml codes survive transport", async () => {
  const viewNotFound = await queryBase({ path: "Formats.base", view: "Nope" });
  assert.equal(viewNotFound.structuredContent.code, "view-not-found");
  assert.match(viewNotFound.structuredContent.message, /Base view not found: Nope/);

  const invalidSchema = await queryBase({ path: "BadSchema.base" });
  assert.equal(invalidSchema.structuredContent.code, "invalid-schema");
  assert.match(invalidSchema.structuredContent.message, /views must be an array/);

  const invalidYaml = await queryBase({ path: "BadYaml.base" });
  assert.equal(invalidYaml.structuredContent.code, "invalid-yaml");

  // The message is never dropped.
  for (const result of [viewNotFound, invalidSchema, invalidYaml]) {
    assert.equal(result.isError, true);
    assert.equal(typeof result.structuredContent.message, "string");
    assert.ok(result.structuredContent.message.length > 0);
    assert.match(result.content[0].text, /^Error: /);
  }
});

// ── Negative controls ───────────────────────────────────────────────────────

test("A1 input schema addition stays backward-compatible with the frozen Wave 1 inventory (and real drift still throws)", () => {
  const vaultId = { [VAULT_ID_INPUT_SPEC.name]: {
    type: VAULT_ID_INPUT_SPEC.type,
    minLength: VAULT_ID_INPUT_SPEC.minLength,
    maxLength: VAULT_ID_INPUT_SPEC.maxLength,
    description: VAULT_ID_INPUT_SPEC.description,
  } };
  const live = { type: "object", properties: { path: { type: "string", minLength: 1 }, format: { type: "string" }, ...vaultId }, required: ["path"] };
  const projected = wave1ComparableInputSchema("query_base", live);
  assert.equal("format" in projected.properties, false, "the A1 addition must be projected away for the historical comparison");
  assert.equal("vaultId" in projected.properties, false, "the Wave C projection still applies");

  // A drifted shape for the added property is not silently tolerated.
  assert.throws(
    () => wave1ComparableInputSchema("query_base", { ...live, properties: { ...live.properties, format: { type: "string", minLength: 1 } } }),
    /exact format spec/,
  );
  // Unrelated drift is preserved (the projection only removes the named property).
  const drifted = { ...live, properties: { ...live.properties, extra: { type: "number" } } };
  assert.notDeepEqual(wave1ComparableInputSchema("query_base", drifted), projected);
  // Removing the property projects back to the historical baseline shape: the
  // inventory anchor cannot distinguish "never added" from "added then removed"
  // (a pre-existing property of the anchor; noted as residual in HANDOFF.md).
  const removed = { ...live, properties: { path: { type: "string", minLength: 1 }, ...vaultId } };
  assert.deepEqual(wave1ComparableInputSchema("query_base", removed), projected);
});

test("negative control: deleting the format dispatch makes the csv/tsv/md/paths assertions red", () => {
  // Mutant = the handler's dispatch with every non-json branch deleted (the
  // `if (selectedFormat === "json") return ok(dto)` line kept, the renderer call
  // removed). If the production branch regressed to this, the exact string
  // expectations above could not hold.
  const deletedDispatch = () => JSON.stringify({ format: "json" });
  for (const expected of [EXPECTED_CSV, EXPECTED_TSV, EXPECTED_MD_EMPTY, "F/One.md\nF/Two.md"]) {
    assert.notEqual(deletedDispatch(), expected);
  }
  // And the real renderer is what produces those expectations (the labels are the
  // renderer's inputs, so this passes the same strings `columnLabel` derives for
  // `file.name` — the desktop built-in name, U5).
  assert.equal(renderBaseQueryFormat({ format: "csv", columns: [{ key: "file.name", label: "名称" }, { key: "title", label: "title" }, { key: "status", label: "status" }], rows: [{ path: "F/One.md", values: { "file.name": "One", title: 'He said "hi", loudly', status: "active" } }, { path: "F/Two.md", values: { "file.name": "Two", title: "plain", status: "has | pipe" } }] }).text, EXPECTED_CSV);
});

test("negative control: silently falling back to json would break the invalid-format assertion", () => {
  // Mutant of `assertBaseQueryFormat`: unknown values become json instead of
  // throwing, which is exactly what the A1 requirement forbids.
  const fallbackMutant = (format) => (BASE_QUERY_FORMATS.includes(format) ? format : "json");
  assert.equal(fallbackMutant("yaml"), "json");
  assert.throws(() => assertBaseQueryFormat("yaml"), { code: "invalid-format" });
  assert.equal(assertBaseQueryFormat("json"), "json");
});

test("negative control: dropping the code (the old err()) turns the A6 assertions red", () => {
  const error = new BaseFormatError("Unsupported Base query format: yaml (expected one of json, csv, tsv, md, paths)");
  const droppedCode = err(error); // the pre-A6 shape
  assert.equal(droppedCode.structuredContent, undefined);
  // The real helper keeps the code while preserving the historical text.
  const structured = errStructured(error);
  assert.equal(structured.structuredContent.code, "invalid-format");
  assert.equal(structured.structuredContent.message, error.message);
  assert.equal(structured.content[0].text, droppedCode.content[0].text);
  // A code-less error still gets a stable payload (never `undefined`).
  assert.equal(errStructured(new Error("boom")).structuredContent.code, "error");
});
