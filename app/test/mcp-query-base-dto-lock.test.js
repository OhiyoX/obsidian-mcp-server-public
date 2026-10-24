// B1 DTO lock: query_base must keep the exact historical MCP output shape after
// being rewired onto the shared Base domain service (app/src/base-query.js).
//
// The shared service also computes `views` and `columns` for the Web/UI
// adapters. This test freezes the MCP wire contract so those new fields can
// never leak into query_base and the field/keys order cannot drift.

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
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-base-dto-lock-"));
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
// Issue #627 additive registration: a view that DECLARES `groupBy` /
// `summaries` is allowed to append those two keys AFTER the frozen historical
// fields. Written here (not in the shared fixture helper) so the frozen corpus
// used by the other suites is untouched.
await fs.writeFile(
  path.join(vault, "Grouped.base"),
  [
    'filters: file.inFolder("WB")',
    "views:",
    "  - type: table",
    "    name: Grouped",
    "    order:",
    "      - file.name",
    "      - status",
    "    sort:",
    "      - property: file.name",
    "        direction: ASC",
    "    groupBy:",
    "      property: status",
    "    summaries:",
    "      file.name: Unique",
    "",
  ].join("\n"),
  "utf8",
);

const { registerWorkflowTools } = await import("../src/tools/workflows.js");
const { getVaultIndex } = await import("../src/vault-index.js");

// Exact historical query_base structuredContent contract, in field order.
const QUERY_BASE_KEYS = ["path", "view", "rows", "totalMatched", "truncated", "supportedSubset", "index"];

let server;
let client;
let index;

before(async () => {
  index = await getVaultIndex();
  server = new McpServer({ name: "base-dto-lock-test", version: "1" });
  registerWorkflowTools(server);
  client = new Client({ name: "base-dto-lock-client", version: "1" });
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
  const result = await client.callTool({ name: "query_base", arguments: arguments_ });
  assert.equal(result.isError, undefined, `query_base must not fail: ${result.content?.[0]?.text}`);
  return result;
}

test("query_base structuredContent exposes exactly the historical top-level keys in order", async () => {
  const result = await queryBase({ path: "Formula.base" });
  const payload = result.structuredContent;

  assert.deepEqual(Object.keys(payload), QUERY_BASE_KEYS);
  // The A1 service additions must never leak into the MCP DTO.
  assert.ok(!("views" in payload), "views must not leak into query_base");
  assert.ok(!("columns" in payload), "columns must not leak into query_base");

  // The text content is the same JSON payload, so both transports stay identical.
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
});

test("query_base appends groups/summaries AFTER the frozen fields, and only when the view declares them", async () => {
  const declared = (await queryBase({ path: "Grouped.base" })).structuredContent;
  // The pre-#627 prefix is byte-identical, in order; the two additive keys close
  // the payload. No other service field (`views` / `columns`) may leak.
  assert.deepEqual(Object.keys(declared).slice(0, QUERY_BASE_KEYS.length), QUERY_BASE_KEYS);
  assert.deepEqual(Object.keys(declared).slice(QUERY_BASE_KEYS.length), ["groups", "summaries"]);
  assert.ok(!("views" in declared) && !("columns" in declared));
  assert.equal(declared.groups.reduce((total, group) => total + group.count, 0), declared.rows.length);
  // The undeclared document next to it stays exactly on the historical key list.
  const undeclared = (await queryBase({ path: "Formula.base" })).structuredContent;
  assert.deepEqual(Object.keys(undeclared), QUERY_BASE_KEYS);
});

test("query_base view stays the selected view name (undefined when no view is declared)", async () => {
  const withView = await queryBase({ path: "Default.base", view: "Second" });
  assert.equal(withView.structuredContent.view, "Second");

  const defaultView = await queryBase({ path: "Default.base" });
  assert.equal(defaultView.structuredContent.view, "First");

  const noViews = await queryBase({ path: "NoViews.base" });
  assert.equal(noViews.structuredContent.view, undefined);
  for (const row of noViews.structuredContent.rows) {
    assert.deepEqual(Object.keys(row.values), ["file.path"]);
  }
});

test("query_base rows[].values preserve the declared order key sequence", async () => {
  const result = await queryBase({ path: "Formula.base" });
  const payload = result.structuredContent;
  assert.ok(payload.rows.length > 0);
  for (const row of payload.rows) {
    assert.deepEqual(Object.keys(row.values), ["formula.note", "file.name", "type"]);
  }

  const filters = await queryBase({ path: "Filters.base" });
  for (const row of filters.structuredContent.rows) {
    assert.deepEqual(Object.keys(row.values), ["file.name", "priority", "status"]);
  }
});

test("query_base index and counts keep their historical semantics", async () => {
  const payload = (await queryBase({ path: "Limit.base" })).structuredContent;
  // `index` is getVaultIndex().stats; its keys are the frozen shape but the
  // per-refresh counters (reparsed/reused/durationMs) legitimately change.
  assert.deepEqual(Object.keys(payload.index), Object.keys(index.stats));
  assert.equal(payload.index.files, index.stats.files);
  assert.equal(payload.supportedSubset, true);
  assert.equal(payload.totalMatched, 12);
  assert.equal(payload.truncated, true);

  const limited = (await queryBase({ path: "Limit.base", limit: 5 })).structuredContent;
  assert.equal(limited.rows.length, 5);
  assert.equal(limited.totalMatched, 12);
  assert.equal(limited.truncated, true);
});
