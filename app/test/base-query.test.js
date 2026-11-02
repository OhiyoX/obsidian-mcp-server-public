// A1 characterization + parity tests for the canonical Base domain service.
//
// The core gate is: for the same synthetic fixture, `queryBaseSnapshot` and the
// real MCP `query_base` handler produce identical view / rows / totalMatched /
// truncated (and identical error message text). This file must stay green both
// before and after B1 rewires the handler onto the shared service.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeBaseFixtures } from "./helpers/base-fixtures.js";

// Environment must be configured before importing config/vault modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-base-query-"));
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
await writeBaseFixtures(vault);

const { BaseQueryError, compileBaseView, evaluateBaseView, listBaseViews, parseAndValidateBase, queryBaseSnapshot, validateBaseDocument } = await import("../src/base-query.js");
const { registerWorkflowTools } = await import("../src/tools/workflows.js");
const { getVaultIndex } = await import("../src/vault-index.js");

let server;
let client;
let records;

before(async () => {
  records = (await getVaultIndex()).records;
  server = new McpServer({ name: "base-query-test", version: "1" });
  registerWorkflowTools(server);
  client = new Client({ name: "base-query-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  if (client) await client.close();
  if (server) await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

function readBase(relative) {
  return fs.readFile(path.join(vault, relative), "utf8");
}

function mcpQuery(spec) {
  const args = { path: spec.base };
  if (spec.viewName !== undefined) args.view = spec.viewName;
  if (spec.limit !== undefined) args.limit = spec.limit;
  return client.callTool({ name: "query_base", arguments: args });
}

function stripErrorPrefix(text) {
  return text.replace(/^Error: /, "");
}

// Run one fixture through both paths and assert MCP parity.
async function assertParity(spec) {
  const raw = await readBase(spec.base);
  const mcp = await mcpQuery(spec);
  let snapshot;
  let serviceError;
  try {
    snapshot = queryBaseSnapshot({ raw, viewName: spec.viewName, records, limit: spec.limit });
  } catch (error) {
    serviceError = error;
  }

  if (serviceError) {
    assert.equal(mcp.isError, true, `${spec.base}: MCP must fail closed`);
    assert.equal(stripErrorPrefix(mcp.content[0].text), serviceError.message, `${spec.base}: error message parity`);
    return { error: serviceError };
  }

  assert.equal(mcp.isError, undefined, `${spec.base}: MCP must not fail: ${mcp.content[0].text}`);
  const payload = JSON.parse(mcp.content[0].text);
  const normalized = JSON.parse(JSON.stringify(snapshot));
  assert.equal(normalized.view, payload.view, `${spec.base}: view parity`);
  assert.deepEqual(normalized.rows, payload.rows, `${spec.base}: rows parity`);
  assert.equal(normalized.totalMatched, payload.totalMatched, `${spec.base}: totalMatched parity`);
  assert.equal(normalized.truncated, payload.truncated, `${spec.base}: truncated parity`);
  assert.equal(normalized.supportedSubset, true, `${spec.base}: supportedSubset`);
  return { payload, snapshot };
}

const parityOkCases = [
  { name: "no views", base: "NoViews.base" },
  { name: "default first view", base: "Default.base" },
  { name: "explicit second view", base: "Default.base", viewName: "Second" },
  { name: "base.filters + view.filters", base: "Filters.base" },
  { name: "and / or / not / compare / contains / hasTag / hasLink / inFolder", base: "Logic.base" },
  { name: "sort priority ASC + updated DESC", base: "Sort.base", viewName: "SortAsc" },
  { name: "sort file.name DESC", base: "Sort.base", viewName: "SortDesc" },
  { name: "sort with null-last and path tie-break", base: "TieBreak.base" },
  { name: "file.asLink(if(title, title, file.name))", base: "Formula.base" },
  { name: "nested if", base: "Nested.base" },
  { name: "file.asLink(file.name)", base: "AsLinkName.base" },
  { name: "file.asLink(property)", base: "AsLinkProperty.base" },
  { name: "view limit only", base: "Limit.base" },
  { name: "request limit overrides view limit", base: "Limit.base", limit: 5 },
  { name: "request limit smaller than view limit", base: "Limit.base", limit: 1 },
  // INT-A flip (review-verdict-P0-FLIP.md): these two used to be `parity
  // (error)` rows asserting the P0 restriction. The P1-A expression layer now
  // supports them, so they run through the same MCP <-> canonical parity path
  // as every case above (the fixtures themselves are unchanged).
  { name: "note.title namespace is now supported (INT-A)", base: "Bad/NoteNamespace.base" },
  { name: "true literal is now supported (INT-A)", base: "Bad/TrueLiteral.base" },
  { name: "formula.<name> reference (INT-B: declared dependency)", base: "FormulaRef.base" },
  // INT-C flip (review-verdict-INT-C-GO.md §3): a `formula.<name>` filter is now
  // a typed comparison instead of an out-of-scope rejection. This fixture uses
  // `formula.note == "x"`, which matches no WB title, so the parity row is a valid
  // 0-row accept on both paths.
  { name: "formula.<name> filter is typed (INT-C)", base: "Bad/FilterFormula.base" },
];

for (const spec of parityOkCases) {
  test(`parity (ok): ${spec.name}`, async () => {
    await assertParity(spec);
  });
}

const parityErrorCases = [
  { name: "unsupported file property", base: "Bad/UnsupportedFileProp.base", code: "unsupported", message: /unsupported file property/ },
  { name: "undeclared formula.<name> reference", base: "Bad/FormulaRef.base", code: "unsupported", message: /references undeclared formula "other"/ },
  { name: "unsupported operator-function", base: "Bad/UnknownFunction.base", code: "unsupported", message: /sum|Expected/ },
  { name: "malformed formula", base: "Bad/Malformed.base", code: "unsupported", message: /Expected/ },
  { name: "depth > 20", base: "Bad/Deep.base", code: "unsupported", message: /nesting|depth/i },
  // INT-C: `formula.*` in filter is wired; this fixture now exercises the list
  // rule instead (WB/Listed.md has a list title, WB/Map.md an object title) — the
  // old blanket rejection message is gone.
  { name: "formula list value in sort (INT-C)", base: "Bad/SortFormula.base", code: "unsupported", message: /not supported in view sort for list values/ },
  { name: "missing formula property in order", base: "Bad/MissingOrderFormula.base", code: "unsupported", message: /missing formula "note"/ },
  { name: "unsupported filter object", base: "Bad/FilterObject.base", code: "unsupported", message: /Unsupported Base filter object/ },
  { name: "unsupported filter expression", base: "Bad/FilterExpression.base", code: "unsupported", message: /Unsupported Base filter expression: title\.matches/ },
  { name: "unsupported sort config", base: "Bad/SortConfig.base", code: "unsupported", message: /Unsupported Base sort configuration/ },
  { name: "invalid base root", base: "Bad/InvalidRoot.base", code: "invalid-schema", message: /^Invalid Base: Base root must be a YAML object$/ },
  { name: "invalid YAML", base: "Bad/InvalidYaml.base", code: "invalid-yaml", message: /./ },
  { name: "missing view name", base: "Bad/MissingViewName.base", code: "invalid-schema", message: /^Invalid Base: views\[0\]\.name is required$/ },
  { name: "missing view type", base: "Bad/MissingViewType.base", code: "invalid-schema", message: /^Invalid Base: views\[0\]\.type is required$/ },
  { name: "view not found", base: "NoViews.base", viewName: "Nope", code: "view-not-found", message: /^Base view not found: Nope$/ },
];

for (const spec of parityErrorCases) {
  test(`parity (error): ${spec.name}`, async () => {
    const { error } = await assertParity(spec);
    assert.ok(error instanceof BaseQueryError, `${spec.base}: service must throw BaseQueryError`);
    assert.equal(error.code, spec.code, `${spec.base}: error code`);
    assert.match(error.message, spec.message, `${spec.base}: error message`);
  });
}

test("invalid views shape fails closed; service normalizes the historical runtime TypeError", async () => {
  const raw = await readBase("Bad/InvalidViews.base");
  assert.throws(
    () => queryBaseSnapshot({ raw, records }),
    (error) => error instanceof BaseQueryError && error.code === "invalid-schema" && error.message === "Invalid Base: views must be an array",
  );
  const mcp = await mcpQuery({ base: "Bad/InvalidViews.base" });
  assert.equal(mcp.isError, true, "MCP must still fail closed on a non-array views value");
});

test("validateBaseDocument preserves the historical rule text and evaluation order", () => {
  assert.deepEqual(validateBaseDocument(undefined), ["Base root must be a YAML object"]);
  assert.deepEqual(validateBaseDocument([1, 2]), ["Base root must be a YAML object"]);
  assert.deepEqual(validateBaseDocument({ views: {} }), ["views must be an array"]);
  assert.deepEqual(validateBaseDocument({ views: [{ name: "x" }] }), ["views[0].type is required"]);
  assert.deepEqual(validateBaseDocument({ views: [{ type: "table" }] }), ["views[0].name is required"]);
  assert.deepEqual(validateBaseDocument({ views: [{ type: "table", name: "ok" }] }), []);
  assert.deepEqual(validateBaseDocument({ views: [null] }), ["views[0] must be an object", "views[0].type is required", "views[0].name is required"]);
  // Rules are reported in source order: root, views shape, then each view.
  assert.deepEqual(validateBaseDocument([1]), ["Base root must be a YAML object"]);
});

test("parseAndValidateBase classifies YAML syntax vs schema errors", () => {
  assert.throws(
    () => parseAndValidateBase("views: [\n"),
    (error) => error instanceof BaseQueryError && error.code === "invalid-yaml",
  );
  assert.throws(
    () => parseAndValidateBase("- a\n- b\n"),
    (error) => error instanceof BaseQueryError && error.code === "invalid-schema" && error.message === "Invalid Base: Base root must be a YAML object",
  );
  assert.deepEqual(parseAndValidateBase("filters: file.inFolder(\"WB\")\n").base, { filters: 'file.inFolder("WB")' });
});

test("compileBaseView picks the requested/default view and compiles formulas", async () => {
  const { base } = parseAndValidateBase(await readBase("Default.base"));
  const first = compileBaseView(base);
  assert.equal(first.view.name, "First");
  assert.equal(first.viewName, "First");
  assert.deepEqual(first.order, ["file.name", "status"]);
  const second = compileBaseView(base, "Second");
  assert.equal(second.view.name, "Second");
  assert.equal(second.viewName, "Second");
  assert.deepEqual(second.order, ["file.path"]);
  assert.throws(
    () => compileBaseView(base, "Nope"),
    (error) => error instanceof BaseQueryError && error.code === "view-not-found" && error.message === "Base view not found: Nope",
  );
});

test("compileBaseView defaults to no view and file.path order", () => {
  const { base } = parseAndValidateBase('filters: file.inFolder("WB")\n');
  const compiled = compileBaseView(base);
  assert.equal(compiled.view, undefined);
  assert.equal(compiled.viewName, undefined);
  assert.deepEqual(compiled.order, ["file.path"]);
  assert.deepEqual(compiled.formulas, {});
});

test("queryBaseSnapshot exposes stable columns with MCP-parity values keys", async () => {
  const snapshot = queryBaseSnapshot({ raw: await readBase("Formula.base"), records });
  assert.equal(snapshot.view, "Formula");
  assert.equal(snapshot.supportedSubset, true);
  assert.deepEqual(snapshot.columns, [
    { key: "formula.note", label: "Note", kind: "formula" },
    // Undeclared `file.name` is the desktop built-in name (U5, `src/base-builtin-names.js`),
    // not the key tail: asar app.js@2351488 / 2352471.
    { key: "file.name", label: "名称", kind: "property" },
    { key: "type", label: "type", kind: "property" },
  ]);
  for (const row of snapshot.rows) {
    assert.deepEqual(Object.keys(row.values), ["formula.note", "file.name", "type"]);
  }
});

test("columns fall back to the desktop built-in name and the raw formula key", async () => {
  const noViews = queryBaseSnapshot({ raw: await readBase("NoViews.base"), records });
  // `file.path` is one of the 14 desktop built-in names (U5). The key-tail fallback now
  // covers only keys the desktop has no name for; that case is pinned by
  // `web-bases-builtin-names.test.js` (`file.nope` → `nope`, `status` → `status`) so this
  // test can keep its original job: the missing-view default order and the formula key.
  assert.deepEqual(noViews.columns, [{ key: "file.path", label: "路径", kind: "property" }]);
  assert.equal(noViews.view, undefined);

  const asLinkName = queryBaseSnapshot({ raw: await readBase("AsLinkName.base"), records });
  assert.deepEqual(asLinkName.columns, [{ key: "formula.link", label: "formula.link", kind: "formula" }]);
});

test("queryBaseSnapshot exposes declared views in declaration order", async () => {
  const defaultRaw = await readBase("Default.base");
  const first = queryBaseSnapshot({ raw: defaultRaw, records });
  assert.deepEqual(first.views, [
    { name: "First", type: "table" },
    { name: "Second", type: "table" },
  ]);
  // Explicit view selection does not change the declared list or its order.
  const second = queryBaseSnapshot({ raw: defaultRaw, viewName: "Second", records });
  assert.equal(second.view, "Second");
  assert.deepEqual(second.views, [
    { name: "First", type: "table" },
    { name: "Second", type: "table" },
  ]);

  const noViews = queryBaseSnapshot({ raw: await readBase("NoViews.base"), records });
  assert.deepEqual(noViews.views, []);

  // Missing / non-array declarations and non-string fields normalize safely.
  assert.deepEqual(listBaseViews(undefined), []);
  assert.deepEqual(listBaseViews({ views: {} }), []);
  assert.deepEqual(listBaseViews({ views: [{ name: "X" }, { type: "table" }, {}] }), [
    { name: "X", type: null },
    { name: null, type: "table" },
    { name: null, type: null },
  ]);
});

test("file.asLink emits structured link cells with declared fallback display names", async () => {
  const snapshot = queryBaseSnapshot({ raw: await readBase("Formula.base"), records });
  const byPath = Object.fromEntries(snapshot.rows.map((row) => [row.path, row]));
  assert.deepEqual(byPath["WB/One.md"].values["formula.note"], { path: "WB/One.md", displayName: "One Title", kind: "asLink" });
  assert.equal(byPath["WB/Two.md"].values["formula.note"].displayName, "Two", "missing title falls back to basename");
  assert.equal(byPath["WB/Three.md"].values["formula.note"].displayName, "Three", "empty title falls back to basename");
  assert.equal(byPath["WB/Listed.md"].values["formula.note"].displayName, "One, Two");
  assert.equal(byPath["WB/Numeric.md"].values["formula.note"].displayName, "2026");
  assert.equal(byPath["WB/Flagged.md"].values["formula.note"].displayName, "true");
  assert.equal(byPath["WB/Map.md"].values["formula.note"].displayName, "Map", "object display falls back to basename");
  assert.equal(byPath["WB/Blank.md"].values["formula.note"].displayName, "Blank");
  for (const row of snapshot.rows) assert.equal(row.values["formula.note"].path, row.path);
});

test("nested if resolves title then name then file.name", async () => {
  const snapshot = queryBaseSnapshot({ raw: await readBase("Nested.base"), records });
  const byPath = Object.fromEntries(snapshot.rows.map((row) => [row.path, row]));
  assert.equal(byPath["WB/One.md"].values["formula.note"].displayName, "One Title");
  assert.equal(byPath["WB/Two.md"].values["formula.note"].displayName, "Two Named");
  assert.equal(byPath["WB/Three.md"].values["formula.note"].displayName, "Three");
});

test("sort applies ASC/DESC, null-last and final path tie-break", async () => {
  const asc = queryBaseSnapshot({ raw: await readBase("Sort.base"), viewName: "SortAsc", records });
  // priority ASC, then updated DESC within each group; a missing priority is
  // not a tie: it falls through to the next sort key (updated DESC), and only
  // then to the final path ASC tie-break.
  assert.deepEqual(asc.rows.map((row) => row.path), [
    "WB/Five.md",
    "WB/Six.md",
    "WB/Three.md",
    "WB/One.md",
    "WB/Two.md",
    "WB/Four.md",
    "WB/Sub/Deep.md",
    "WB/Blank.md",
    "WB/Map.md",
    "WB/Flagged.md",
    "WB/Numeric.md",
    "WB/Listed.md",
  ]);

  const tie = queryBaseSnapshot({ raw: await readBase("TieBreak.base"), records });
  assert.deepEqual(tie.rows.map((row) => row.path), [
    "WB/Blank.md",
    "WB/Five.md",
    "WB/Flagged.md",
    "WB/Listed.md",
    "WB/Map.md",
    "WB/Numeric.md",
    "WB/One.md",
    "WB/Six.md",
    "WB/Sub/Deep.md",
    "WB/Two.md",
    "WB/Three.md",
    "WB/Four.md",
  ]);
});

test("limit precedence: request > view limit, and 0/undefined fall through", async () => {
  const { base } = parseAndValidateBase(await readBase("Limit.base"));
  const compiled = compileBaseView(base);
  const evaluate = (limit) => evaluateBaseView({ base, view: compiled.view, order: compiled.order, formulas: compiled.formulas, records, limit });

  const viewLimit = evaluate(undefined);
  assert.equal(viewLimit.rows.length, 2);
  assert.equal(viewLimit.totalMatched, 12);
  assert.equal(viewLimit.truncated, true);

  const zero = evaluate(0);
  assert.equal(zero.rows.length, 2, "limit 0 falls through to view.limit");
  assert.equal(zero.truncated, true);

  const override = evaluate(5);
  assert.equal(override.rows.length, 5);
  assert.equal(override.totalMatched, 12);
});

test("view.limit canonical domain is a positive integer; invalid values fail closed", () => {
  const baseWith = (limitLiteral) => `views:\n  - type: table\n    name: V\n    limit: ${limitLiteral}\n`;
  const expectedMessage = "Invalid Base: views[0].limit must be a positive integer";
  for (const literal of ["150.5", "-5", "0", '"150"', ".nan", ".inf"]) {
    assert.throws(
      () => parseAndValidateBase(baseWith(literal)),
      (error) => error instanceof BaseQueryError
        && error.code === "invalid-schema"
        && error.message === expectedMessage,
      `view.limit ${literal} must fail closed`,
    );
  }
  for (const literal of ["1", "100", "150"]) {
    const { base } = parseAndValidateBase(baseWith(literal));
    assert.equal(base.views[0].limit, Number(literal), `view.limit ${literal} must be accepted`);
  }
  // The index is per-view and every violation accumulates with the existing rules.
  const multi = "views:\n  - type: table\n    name: A\n    limit: 10\n  - type: table\n    name: B\n    limit: -1\n";
  assert.throws(
    () => parseAndValidateBase(multi),
    (error) => error instanceof BaseQueryError
      && error.code === "invalid-schema"
      && error.message === "Invalid Base: views[1].limit must be a positive integer",
  );
});

test("filter/sort failures are categorized as unsupported", async () => {
  for (const base of ["Bad/FilterObject.base", "Bad/FilterExpression.base", "Bad/SortConfig.base", "Bad/UnsupportedFileProp.base"]) {
    const raw = await readBase(base);
    assert.throws(
      () => queryBaseSnapshot({ raw, records }),
      (error) => error instanceof BaseQueryError && error.code === "unsupported",
      `${base} must be unsupported`,
    );
  }
});

test("missing .base file fails closed with the canonical ENOENT error", async () => {
  const mcp = await client.callTool({ name: "query_base", arguments: { path: "Does/Not/Exist.base" } });
  assert.equal(mcp.isError, true);
  assert.match(mcp.content[0].text, /ENOENT/);
});
