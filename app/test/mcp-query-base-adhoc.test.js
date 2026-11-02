// #628 (`desktop-re/mcp-query-adhoc`) — the ad-hoc narrowing inputs of MCP
// `query_base`: `filters` / `sort` / `search`.
//
// Contract proved here:
//   * all three are optional; passing none (or empty ones) is a byte-for-byte
//     no-op, and the DTO is exactly the pre-#628 algorithm's output;
//   * the canonical kernel is reused, never re-implemented: the filter tree is
//     the `.base`/Web dialect, the sort list becomes the frozen `sortOverride`,
//     the search literal the frozen `textQuery`;
//   * merge rules: filters AND with base+view filters, sort REPLACES the view
//     sort, `limit` keeps its historical "explicit ceiling overrides the view
//     limit" meaning, search AND with filters;
//   * pipeline order is the frozen one (filters -> search -> sort -> limit);
//   * malformed / unsupported inputs fail closed with the G3/G4 codes;
//   * the real MCP HTTP transport serves the same behavior in the `full` and
//     `compact` profiles, an `obsidian.read`-only session can use it (no scope
//     widening) and a session without that scope is refused.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fetchSafePort } from "./fetch-safe-port.mjs";

// Environment must be configured before importing config/vault modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-base-adhoc-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
process.env.OBSIDIAN_READ_ONLY = "true";

function note(frontmatter) {
  const keys = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---\n${keys}\n---\n# note\n`;
}

const ORDER = "[file.name, status, score, title]";

// One note per hand-computed expectation row. `AD/Delta.md` deliberately has no
// `score` (missing value sorts last in BOTH directions, per the frozen P0 rule).
const NOTES = {
  "AD/Alpha.md": note({ status: "active", score: 10, title: "cherry" }),
  "AD/Bravo.md": note({ status: "done", score: 10, title: "Apple" }),
  "AD/Charlie.md": note({ status: "active", score: 2, title: "banana" }),
  "AD/Delta.md": note({ status: "active", title: "date" }),
  "AD/Echo.md": note({ status: "deferred", score: 7, title: "elder" }),
};

const BASES = {
  // Three views over the same notes: no ceiling, a declared ceiling, and a view
  // filter (used to observe the AND merge).
  "Adhoc.base": [
    'filters: file.inFolder("AD")',
    "views:",
    "  - type: table",
    "    name: All",
    `    order: ${ORDER}`,
    "    sort:",
    "      - property: file.name",
    "        direction: ASC",
    "  - type: table",
    "    name: Capped",
    "    limit: 2",
    `    order: ${ORDER}`,
    "    sort:",
    "      - property: file.name",
    "        direction: ASC",
    "  - type: table",
    "    name: Active",
    '    filters: status == "active"',
    `    order: ${ORDER}`,
    "    sort:",
    "      - property: file.name",
    "        direction: ASC",
    "",
  ].join("\n"),
  // The canonical equivalent of the ad-hoc `sort: [{property: score, direction: DESC}]`.
  "AdhocScore.base": [
    'filters: file.inFolder("AD")',
    "views:",
    "  - type: table",
    "    name: Sorted",
    `    order: ${ORDER}`,
    "    sort:",
    "      - property: score",
    "        direction: DESC",
    "",
  ].join("\n"),
};

await fs.mkdir(path.join(vault, "AD"), { recursive: true });
await fs.mkdir(data, { recursive: true });
for (const [relative, content] of Object.entries({ ...NOTES, ...BASES })) {
  await fs.writeFile(path.join(vault, relative), content);
}

const { registerWorkflowTools } = await import("../src/tools/workflows.js");
const { getVaultIndex } = await import("../src/vault-index.js");
const { compileBaseView, evaluateBaseView, parseAndValidateBase } = await import("../src/base-query.js");
const { BASE_QUERY_TEXT_MAX } = await import("../src/app/base-params.js");
const { ADHOC_SEARCH_MAX, normalizeAdhocFilters, normalizeAdhocSearch, normalizeAdhocSort } = await import("../src/base-adhoc-params.js");
const { createDiscoveryRuntimePolicy } = await import("../src/discovery-runtime.js");
const { parseDiscoveryOperatorConfig } = await import("../src/discovery-config.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");

const ALL_PATHS = ["AD/Alpha.md", "AD/Bravo.md", "AD/Charlie.md", "AD/Delta.md", "AD/Echo.md"];

let server;
let client;
let index;

before(async () => {
  index = await getVaultIndex();
  server = new McpServer({ name: "base-adhoc-test", version: "1" });
  registerWorkflowTools(server);
  client = new Client({ name: "base-adhoc-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  if (client) await client.close();
  if (server) await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

/** Call query_base and require success, returning the DTO. */
async function query(arguments_) {
  const result = await client.callTool({ name: "query_base", arguments: arguments_ });
  assert.equal(result.isError, undefined, `query_base must not fail: ${result.content?.[0]?.text}`);
  return result.structuredContent;
}

/** Call query_base and require the structured failure, returning it. */
async function refuse(arguments_) {
  const result = await client.callTool({ name: "query_base", arguments: arguments_ });
  assert.equal(result.isError, true, `expected a refusal for ${JSON.stringify(arguments_)}`);
  return result;
}

const pathsOf = (dto) => dto.rows.map((row) => row.path);
// `index` carries per-refresh counters (durationMs / publicationRevision /
// lastRefresh) that legitimately change between two calls, so every byte
// comparison excludes it; its key set is asserted separately.
const withoutIndex = ({ index: _ignored, ...rest }) => JSON.stringify(rest);

// ── ① no ad-hoc input is a byte-for-byte no-op ──────────────────────────────

test("no ad-hoc input (and empty ones) keep the pre-#628 response byte-for-byte", async () => {
  const plain = await query({ path: "Adhoc.base" });
  // `filters: []` / `sort: []` / `search: ""` are the Web layer's "no override"
  // spellings; they must not move a single byte either.
  const noop = await query({ path: "Adhoc.base", filters: [], sort: [], search: "" });
  assert.deepEqual(Object.keys(noop), Object.keys(plain));
  assert.deepEqual(Object.keys(noop.index), Object.keys(plain.index));
  assert.equal(withoutIndex(noop), withoutIndex(plain));

  // The same DTO, computed with the untouched pre-#628 handler algorithm
  // (parse -> compile -> evaluate -> the historical field order). `index` is
  // excluded from the byte comparison because it carries per-refresh counters
  // (already documented in mcp-query-base-dto-lock.test.js); its key set is
  // asserted separately.
  const { base } = parseAndValidateBase(await fs.readFile(path.join(vault, "Adhoc.base"), "utf8"));
  const compiled = compileBaseView(base, undefined);
  const result = evaluateBaseView({
    base, view: compiled.view, order: compiled.order, formulas: compiled.formulas, records: index.records,
  });
  const baseline = {
    path: "Adhoc.base",
    view: compiled.viewName,
    rows: result.rows,
    totalMatched: result.totalMatched,
    truncated: result.truncated,
    supportedSubset: true,
    index: plain.index,
  };
  assert.deepEqual(Object.keys(plain), Object.keys(baseline), "the DTO field order must not move");
  assert.deepEqual(Object.keys(plain.index), Object.keys(index.stats));
  assert.equal(withoutIndex(plain), withoutIndex(baseline));
  assert.deepEqual(pathsOf(plain), ALL_PATHS);
});

// ── ② ad-hoc filters: canonical tree, AND-combined with the view filters ────

test("ad-hoc filters select exactly the hand-computed row set", async () => {
  const cases = [
    // and: active AND score >= 10 -> Alpha only.
    [{ and: [{ key: "status", op: "is", value: "active" }, { key: "score", op: "gte", value: 10 }] }, ["AD/Alpha.md"]],
    // or: done OR score > 7 -> Bravo (done) and Alpha (10 > 7), file.name order.
    [{ or: [{ key: "status", op: "is", value: "done" }, { key: "score", op: "gt", value: 7 }] }, ["AD/Alpha.md", "AD/Bravo.md"]],
    // not: none of "active" -> Bravo, Echo.
    [{ not: [{ key: "status", op: "is", value: "active" }] }, ["AD/Bravo.md", "AD/Echo.md"]],
    // legacy frozen AND list shape.
    [[{ key: "title", op: "contains", value: "e" }], ["AD/Alpha.md", "AD/Bravo.md", "AD/Delta.md", "AD/Echo.md"]],
    // advanced expression leaf (the desktop `</>` dialect).
    [{ and: ['status == "active"'] }, ["AD/Alpha.md", "AD/Charlie.md", "AD/Delta.md"]],
    // empty `and` / `not` = empty intersection = every row (frozen F3 rule).
    [{ and: [] }, ALL_PATHS],
    // record-operand operator: the key is not a view column.
    [{ key: "file.path", op: "has-link", value: "AD/Alpha.md" }, []],
  ];
  for (const [filters, expected] of cases) {
    const dto = await query({ path: "Adhoc.base", filters });
    assert.deepEqual(pathsOf(dto), expected, JSON.stringify(filters));
    assert.equal(dto.totalMatched, expected.length, JSON.stringify(filters));
  }
});

test("ad-hoc filters are AND-combined with the view filter (never replace it)", async () => {
  // View `Active` = status == "active" (Alpha, Charlie, Delta).
  const viewOnly = await query({ path: "Adhoc.base", view: "Active" });
  assert.deepEqual(pathsOf(viewOnly), ["AD/Alpha.md", "AD/Charlie.md", "AD/Delta.md"]);

  // AND with score >= 5 -> Alpha only. A "replace" merge would keep Bravo (10)
  // and Echo (7) as well, so this assertion is merge-direction sensitive.
  const both = await query({ path: "Adhoc.base", view: "Active", filters: [{ key: "score", op: "gte", value: 5 }] });
  assert.deepEqual(pathsOf(both), ["AD/Alpha.md"]);
  assert.equal(both.totalMatched, 1);
});

// ── no write surface: the .base files are byte-identical before and after ───

test("ad-hoc queries (and refusals) never touch the .base files on disk", async () => {
  const files = Object.keys(BASES).map((name) => path.join(vault, name));
  const digest = async () => {
    const { createHash } = await import("node:crypto");
    const out = {};
    for (const file of files) out[path.basename(file)] = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    return out;
  };
  const before = await digest();
  await query({ path: "Adhoc.base", filters: [{ key: "status", op: "is", value: "active" }], sort: [{ property: "score", direction: "desc" }], search: "a", limit: 2 });
  await query({ path: "Adhoc.base", view: "Capped", filters: { not: [{ key: "status", op: "is-empty", value: null }] } });
  await refuse({ path: "Adhoc.base", filters: [{ key: "status", op: "like", value: "a" }] });
  await refuse({ path: "Adhoc.base", sort: [{ property: "priority" }] });
  const after = await digest();
  assert.deepEqual(after, before, "the ad-hoc query path must not write a .base file");
  // Positive control: the digest really does move when the bytes move.
  await fs.writeFile(path.join(vault, "Adhoc.base"), `${BASES["Adhoc.base"]}\n`);
  assert.notDeepEqual(await digest(), before);
  await fs.writeFile(path.join(vault, "Adhoc.base"), BASES["Adhoc.base"]);
  assert.deepEqual(await digest(), before);
});

// ── ③ ad-hoc sort: canonical comparator, replaces the view sort ─────────────

test("ad-hoc sort reorders rows with the canonical comparator (view sort replaced)", async () => {
  const expected = ["AD/Alpha.md", "AD/Bravo.md", "AD/Echo.md", "AD/Charlie.md", "AD/Delta.md"];
  const desc = await query({ path: "Adhoc.base", sort: [{ property: "score", direction: "desc" }] });
  assert.deepEqual(pathsOf(desc), expected);
  // `DESC` / a missing direction (`asc` default) are the `.base` spellings.
  assert.deepEqual(pathsOf(await query({ path: "Adhoc.base", sort: [{ property: "score", direction: "DESC" }] })), expected);

  const asc = await query({ path: "Adhoc.base", sort: [{ property: "score" }] });
  assert.deepEqual(pathsOf(asc), ["AD/Charlie.md", "AD/Echo.md", "AD/Alpha.md", "AD/Bravo.md", "AD/Delta.md"]);

  // Byte-for-byte identical rows to the canonical `view.sort` evaluation.
  const canonical = await query({ path: "AdhocScore.base" });
  assert.deepEqual(desc.rows, canonical.rows);
  assert.equal(desc.totalMatched, canonical.totalMatched);

  // The ad-hoc sort REPLACES the view sort: the view's `file.name` order must be
  // gone (a view sort that survived would keep Alpha first for a score DESC).
  assert.notDeepEqual(pathsOf(desc), ALL_PATHS);

  // Filters and sort compose: sort applies to the filtered set only.
  const filtered = await query({
    path: "Adhoc.base",
    filters: [{ key: "status", op: "is", value: "active" }],
    sort: [{ property: "score", direction: "desc" }],
  });
  assert.deepEqual(pathsOf(filtered), ["AD/Alpha.md", "AD/Charlie.md", "AD/Delta.md"]);
});

// ── ④ limit composition ─────────────────────────────────────────────────────

test("limit keeps its historical meaning: an explicit ceiling overrides the view limit", async () => {
  const viewLimited = await query({ path: "Adhoc.base", view: "Capped" });
  assert.equal(viewLimited.rows.length, 2, "an absent limit falls through to the view limit");
  assert.equal(viewLimited.truncated, true);
  assert.equal(viewLimited.totalMatched, 5);

  // Explicit limit > view limit: the frozen MCP precedence (`limit || view.limit`)
  // and the locked `mcp-query-base-dto-lock` reading. Narrowing below the view
  // limit narrows further.
  const wider = await query({ path: "Adhoc.base", view: "Capped", limit: 5 });
  assert.deepEqual(pathsOf(wider), ALL_PATHS);
  assert.equal(wider.truncated, false);
  const narrower = await query({ path: "Adhoc.base", view: "Capped", limit: 1 });
  assert.deepEqual(pathsOf(narrower), ["AD/Alpha.md"]);
  assert.equal(narrower.truncated, true);
  assert.equal(narrower.totalMatched, 5);

  // limit is applied to the globally sorted rows BEFORE grouping/summaries, and
  // after the ad-hoc filter/sort (frozen pipeline).
  const combined = await query({
    path: "Adhoc.base",
    filters: [{ key: "score", op: "is-not-empty", value: null }],
    sort: [{ property: "score", direction: "desc" }],
    limit: 2,
  });
  assert.deepEqual(pathsOf(combined), ["AD/Alpha.md", "AD/Bravo.md"]);
  assert.equal(combined.totalMatched, 4);
});

// ── ⑤ search: same kernel as the Web `q`, AND-combined with filters ─────────

test("search is the canonical text predicate, AND-combined with the filters", async () => {
  // Case-insensitive substring over the view columns, arrays/objects included.
  assert.deepEqual(pathsOf(await query({ path: "Adhoc.base", search: "APPLE" })), ["AD/Bravo.md"]);
  assert.deepEqual(pathsOf(await query({ path: "Adhoc.base", search: "cherry" })), ["AD/Alpha.md"]);
  // Scoped to the view's columns: `file.path` is not one of them.
  assert.deepEqual(pathsOf(await query({ path: "Adhoc.base", search: "AD/" })), []);

  // AND with the ad-hoc filter: Echo matches "elder" but is not `active`.
  assert.deepEqual(pathsOf(await query({
    path: "Adhoc.base",
    filters: [{ key: "status", op: "is", value: "active" }],
    search: "elder",
  })), []);
  assert.deepEqual(pathsOf(await query({
    path: "Adhoc.base",
    filters: [{ key: "status", op: "is", value: "active" }],
    search: "date",
  })), ["AD/Delta.md"]);
  // AND with the view filter too (view `Active` + search "banana" -> Charlie).
  assert.deepEqual(pathsOf(await query({ path: "Adhoc.base", view: "Active", search: "banana" })), ["AD/Charlie.md"]);
});

// ── ⑥ fail-closed surface (G3/G4 codes, never 500, never silent) ────────────

test("malformed ad-hoc inputs fail closed with the frozen BaseQueryError codes", async () => {
  const cases = [
    [{ filters: { and: [], or: [] } }, "invalid-schema", /one of an "and", "or", or "not"/],
    [{ filters: { and: "x" } }, "invalid-schema", /and must be an array/],
    [{ filters: 5 }, "invalid-schema", /filter must be an object/],
    [{ filters: [{ key: "status", op: "like", value: "a" }] }, "unsupported", /Unsupported Base filter operator: like/],
    [{ filters: [{ key: "status", op: "is", value: "a", extra: 1 }] }, "invalid-schema", /unknown key "extra"/],
    [{ sort: ["score"] }, "invalid-schema", /sort\[0\] must be an object/],
    [{ sort: [{ property: "" }] }, "invalid-schema", /sort\[0\] needs a string property/],
    [{ sort: [{ property: "score", direction: "sideways" }] }, "unsupported", /Unsupported Base sort direction/],
    [{ sort: [{ property: "score", dir: "desc" }] }, "invalid-schema", /unknown key "dir"/],
    // A column outside the selected view is the frozen "unsupported" 422/`unsupported` code.
    [{ sort: [{ property: "priority" }] }, "unsupported", /column outside the view/],
    [{ filters: [{ key: "priority", op: "is", value: "P1" }] }, "unsupported", /column outside the view/],
    [{ search: "x".repeat(ADHOC_SEARCH_MAX + 1) }, "invalid-schema", /limited to 256 characters/],
  ];
  for (const [arguments_, code, message] of cases) {
    const refusal = await refuse({ path: "Adhoc.base", ...arguments_ });
    const payload = refusal.structuredContent;
    assert.ok(payload, `no structured payload for ${JSON.stringify(arguments_)}: ${refusal.content?.[0]?.text}`);
    assert.equal(payload.code, code, JSON.stringify(arguments_));
    assert.match(payload.message, message, JSON.stringify(arguments_));
    assert.equal(typeof refusal.content[0].text, "string");
  }
});

test("the MCP parameter schema still bounds limit and the search literal", async () => {
  for (const arguments_ of [
    { limit: 0 },
    { limit: 5001 },
    { limit: 1.5 },
    { search: 5 },
    { filters: { key: "", op: "is" } },
  ]) {
    const refusal = await refuse({ path: "Adhoc.base", ...arguments_ });
    assert.equal(refusal.isError, true);
  }
  // The MCP surface does not accept a wider predicate than the frozen Web `q`.
  assert.equal(ADHOC_SEARCH_MAX, BASE_QUERY_TEXT_MAX, "the MCP and Web search bounds must stay identical");
});

test("the normalizer refuses shapes the MCP schema cannot express, with the same codes", async () => {
  // `sort` reaches the normalizer as a string item (the schema only requires an
  // array); a non-array `sort` is already refused by the transport schema, so the
  // branch is exercised directly.
  assert.throws(() => normalizeAdhocSort({ property: "score" }), (error) => error.code === "invalid-schema" && /must be an array/.test(error.message));
  assert.equal(normalizeAdhocSort([]), undefined);
  assert.equal(normalizeAdhocSearch(""), undefined);
  assert.equal(normalizeAdhocFilters(null), undefined);
  assert.deepEqual(normalizeAdhocSort([{ property: "score", direction: "DESC" }]), [{ key: "score", dir: "desc" }]);
});

// ── ⑧ real MCP HTTP transport: full + compact profiles ──────────────────────

const ALL_SCOPES = ["obsidian.read", "obsidian.write", "obsidian.files"];
const READ_SCOPES = ["obsidian.read"];
const WRITE_ONLY_SCOPES = ["obsidian.write"];

function runtimeServer(operatorConfig) {
  const httpServer = new McpServer({ name: "base-adhoc-http", version: "1" });
  const discovery = createDiscoveryRuntimePolicy(httpServer, operatorConfig);
  registerObsidianCapabilities(discovery);
  discovery.install();
  return httpServer;
}

async function startHttpHarness(t, operatorConfig) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  const sessions = new Map();
  app.use((req, _res, next) => {
    const scopes = req.header("x-test-scopes");
    req.auth = {
      type: "test",
      clientId: req.header("x-test-client") || "anonymous",
      scopes: scopes ? scopes.split(",").map((value) => value.trim()).filter(Boolean) : [...ALL_SCOPES],
      allowedVaults: [DEFAULT_VAULT_ID],
    };
    next();
  });
  app.post("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    if (sessionId) {
      const record = sessions.get(sessionId);
      if (!record) { res.status(404).end(); return; }
      await record.transport.handleRequest(req, res, req.body);
      return;
    }
    const sessionServer = runtimeServer(operatorConfig);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, { transport, server: sessionServer }),
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await sessionServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const httpServer = app.listen(await fetchSafePort(), "127.0.0.1");
  await once(httpServer, "listening");
  const port = httpServer.address().port;
  t.after(async () => {
    for (const record of sessions.values()) await record.server.close().catch(() => {});
    await new Promise((resolve) => httpServer.close(resolve));
  });
  return { port };
}

async function rpc(port, method, params, { session, client = "adhoc", scopes } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-test-client": client,
  };
  if (session) headers["mcp-session-id"] = session;
  if (scopes) headers["x-test-scopes"] = scopes.join(",");
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  });
  const text = await response.text();
  const payload = !text
    ? null
    : response.headers.get("content-type")?.includes("event-stream")
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((message) => message.id === 7)
      : JSON.parse(text);
  return { status: response.status, payload, session: response.headers.get("mcp-session-id") || session };
}

async function openSession(port, identity) {
  const init = await rpc(port, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: identity.client, version: "1" } }, identity);
  assert.equal(init.status, 200);
  assert.ok(init.session, "initialize must return a session id");
  return init.session;
}

async function httpCall(port, session, identity, name, args) {
  const response = await rpc(port, "tools/call", { name, arguments: args }, { ...identity, session });
  assert.equal(response.status, 200);
  return response.payload.result;
}

test("real HTTP: the full profile serves an ad-hoc query over the wire", async (t) => {
  const { port } = await startHttpHarness(t, parseDiscoveryOperatorConfig({}));
  const identity = { client: "adhoc-full", scopes: READ_SCOPES };
  const session = await openSession(port, identity);

  const result = await httpCall(port, session, identity, "query_base", {
    path: "Adhoc.base",
    filters: { and: [{ key: "status", op: "is", value: "active" }, { key: "score", op: "gte", value: 10 }] },
    sort: [{ property: "score", direction: "desc" }],
    search: "cherry",
    limit: 1,
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(result.structuredContent.rows.map((row) => row.path), ["AD/Alpha.md"]);
  assert.equal(result.structuredContent.totalMatched, 1);

  // `obsidian.read` alone is enough: the ad-hoc inputs widen no Scope.
  const readOnly = await httpCall(port, session, identity, "query_base", { path: "Adhoc.base", sort: [{ property: "score", direction: "desc" }] });
  assert.equal(readOnly.isError, undefined);
  assert.deepEqual(readOnly.structuredContent.rows.map((row) => row.path), ["AD/Alpha.md", "AD/Bravo.md", "AD/Echo.md", "AD/Charlie.md", "AD/Delta.md"]);

  // A session without `obsidian.read` cannot reach the query at all (unchanged).
  const writeIdentity = { client: "adhoc-write", scopes: WRITE_ONLY_SCOPES };
  const writeSession = await openSession(port, writeIdentity);
  const denied = await httpCall(port, writeSession, writeIdentity, "query_base", { path: "Adhoc.base", search: "cherry" });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /Tool query_base not found/);

  // No ad-hoc input introduces a Vault selector: `vaultId` stays the only Vault
  // selector and a Vault outside the session's allowlist is still refused.
  const crossVault = await httpCall(port, session, identity, "query_base", { path: "Adhoc.base", vaultId: "secondary", search: "cherry" });
  assert.equal(crossVault.isError, true);
  assert.match(crossVault.content[0].text, /vault_access_denied/);
});

test("real HTTP: the compact profile routes the same ad-hoc params through obsidian_read", async (t) => {
  const { port } = await startHttpHarness(t, parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "compact" }));
  const identity = { client: "adhoc-compact", scopes: ALL_SCOPES };
  const session = await openSession(port, identity);

  const listed = await rpc(port, "tools/list", {}, { ...identity, session });
  const tools = listed.payload.result.tools;
  const readGroup = tools.find((tool) => tool.inputSchema.oneOf?.some((branch) => branch.properties.action.const === "query_base"));
  assert.ok(readGroup, "the compact read group must route query_base");
  // The compact descriptor is synthesized from the live native schema, so the
  // three ad-hoc properties must be visible in the routed branch.
  const branch = readGroup.inputSchema.oneOf.find((item) => item.properties.action.const === "query_base");
  assert.deepEqual(Object.keys(branch.properties.params.properties).filter((key) => ["filters", "sort", "search"].includes(key)).sort(), ["filters", "search", "sort"]);

  const result = await httpCall(port, session, identity, readGroup.name, {
    action: "query_base",
    params: {
      path: "Adhoc.base",
      filters: { or: [{ key: "status", op: "is", value: "done" }, { key: "score", op: "gt", value: 7 }] },
      sort: [{ property: "score", direction: "desc" }],
      limit: 2,
    },
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(result.structuredContent.rows.map((row) => row.path), ["AD/Alpha.md", "AD/Bravo.md"]);
  assert.equal(result.structuredContent.totalMatched, 2);
});
