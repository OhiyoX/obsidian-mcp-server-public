// W0-D adapter-level proof: the canonical fail-closed guard must be observable
// on both protocol edges, using the *real* adapters and without changing any
// production adapter file.
//
//   MCP  `query_base`            -> tool error (isError), message names the key
//   Web  GET /api/web/v1/base    -> 422 { error: "unsupported" }
//
// The Web half runs the real route (`registerBaseRoute`) with the real
// `createBaseSnapshotEvaluator()` (no fake evaluate), so the 422 comes from the
// existing `base-route.js` code-to-status mapping — exactly the claim W0-A left
// as an unproven adapter fact. The MCP half runs the real tool registry over a
// real McpServer + InMemoryTransport, like `mcp-query-base-dto-lock.test.js`.
//
// Both halves also include a positive control: a supported Base must still work.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// 刀4: `groupBy` itself is no longer fail-closed, so the adapter proof uses a
// groupBy the subset still cannot execute (an illegal `direction`), keeping the
// fail-closed edge observable on both protocols. `GROUPED_BASE` (a VALID groupBy)
// is the positive control that proves the 刀4 flip reaches the adapters.
const GROUPED_BASE = [
  "views:",
  "  - type: table",
  "    name: Grouped",
  "    groupBy:",
  "      property: status",
  "      direction: SIDEWAYS",
  "    order: [file.name]",
  "",
].join("\n");
const VALID_GROUPED_BASE = [
  "views:",
  "  - type: table",
  "    name: Grouped",
  "    groupBy:",
  "      property: status",
  "    summaries:",
  "      file.name: Unique",
  "    order: [file.name]",
  "",
].join("\n");
const NAMESPACE_FILTER_BASE = [
  "views:",
  "  - type: table",
  "    name: Filtered",
  '    filters: \'this.file.folder == ""\'',
  "    order: [file.name]",
  "",
].join("\n");
const SUPPORTED_BASE = ['filters: file.inFolder("WB")', "views:", "  - type: table", "    name: Plain", "    order: [file.name]", ""].join("\n");

const RECORDS = [
  {
    path: "WB/One.md",
    basename: "One",
    frontmatter: { status: "active" },
    tags: [],
    links: [],
    stat: { size: 10, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z" },
  },
  {
    path: "Other/Two.md",
    basename: "Two",
    frontmatter: { status: "done" },
    tags: [],
    links: [],
    stat: { size: 10, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z" },
  },
];

// ── MCP: real registry over a real McpServer ────────────────────────────────
// Environment must be configured before importing config/vault modules.
const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-w0d-adapters-"));
const vault = path.join(vaultRoot, "vault");
const data = path.join(vaultRoot, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(path.join(vault, "WB"), { recursive: true });
await fs.mkdir(path.join(vault, "Other"), { recursive: true });
await fs.mkdir(data, { recursive: true });
await fs.writeFile(path.join(vault, "WB", "One.md"), "---\nstatus: active\n---\n# One\n");
await fs.writeFile(path.join(vault, "Other", "Two.md"), "---\nstatus: done\n---\n# Two\n");
await fs.writeFile(path.join(vault, "Grouped.base"), GROUPED_BASE);
await fs.writeFile(path.join(vault, "ValidGrouped.base"), VALID_GROUPED_BASE);
await fs.writeFile(path.join(vault, "NamespaceFilter.base"), NAMESPACE_FILTER_BASE);
await fs.writeFile(path.join(vault, "Plain.base"), SUPPORTED_BASE);

let server;
let client;

before(async () => {
  const { registerWorkflowTools } = await import("../src/tools/workflows.js");
  const { getVaultIndex } = await import("../src/vault-index.js");
  await getVaultIndex();
  server = new McpServer({ name: "w0d-adapter-test", version: "1" });
  registerWorkflowTools(server);
  client = new Client({ name: "w0d-adapter-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  if (client) await client.close();
  if (server) await server.close();
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

async function callQueryBase(basePath) {
  return client.callTool({ name: "query_base", arguments: { path: basePath } });
}

test("adapter MCP: query_base reports an invalid groupBy direction as a tool error, not a flat result", async () => {
  const result = await callQueryBase("Grouped.base");
  assert.equal(result.isError, true, "a fail-closed Base must surface as an MCP tool error");
  // A6: the BaseQueryError code now travels in `structuredContent` (the DTO is
  // still absent — no `rows`). Shape: { code, message }.
  assert.equal(result.structuredContent.code, "unsupported", "the BaseQueryError code must be on the wire");
  assert.equal(result.structuredContent.rows, undefined, "no DTO may be returned for a rejected Base");
  assert.match(result.content?.[0]?.text ?? "", /groupBy/);
  assert.match(result.structuredContent.message, /groupBy/);
});

test("adapter MCP: a valid groupBy Base is served (刀4 flip) and still returns the flat row set", async () => {
  const result = await callQueryBase("ValidGrouped.base");
  assert.equal(result.isError, undefined, `query_base must not fail: ${result.content?.[0]?.text}`);
  assert.equal(result.structuredContent.supportedSubset, true);
  assert.deepEqual(
    result.structuredContent.rows.map((row) => row.path),
    ["Other/Two.md", "WB/One.md"],
  );
});

test("adapter MCP: query_base reports an unknown filter namespace as a tool error", async () => {
  const result = await callQueryBase("NamespaceFilter.base");
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /unknown namespace "this"/);
});

test("adapter MCP positive control: a supported Base still returns supportedSubset=true", async () => {
  const result = await callQueryBase("Plain.base");
  assert.equal(result.isError, undefined, `query_base must not fail: ${result.content?.[0]?.text}`);
  assert.equal(result.structuredContent.supportedSubset, true);
  assert.deepEqual(
    result.structuredContent.rows.map((row) => row.path),
    ["WB/One.md"],
  );
});

// ── Web: real Express route + real snapshot evaluator ───────────────────────
async function startBaseServer(rawByPath) {
  const [{ registerBaseRoute }, { createBaseSnapshotEvaluator }] = await Promise.all([
    import("../src/app/base-route.js"),
    import("../src/app/base-snapshot-adapter.js"),
  ]);
  const deps = {
    requireApi(_req, _res, next) {
      next();
    },
    async currentVault() {
      return { id: "primary", root: vaultRoot };
    },
    async readBase(_vault, basePath) {
      const raw = rawByPath[basePath];
      if (!raw) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return { path: basePath, raw, revision: "rev-1" };
    },
    async loadRecords() {
      return { records: RECORDS, catalog: { catalogId: "cat-1", generation: 1, stale: false }, complete: true };
    },
    evaluateSnapshot: createBaseSnapshotEvaluator(),
  };
  const app = express();
  const router = express.Router();
  registerBaseRoute(router, deps);
  app.use(router);
  const instance = await new Promise((resolve, reject) => {
    const candidate = http.createServer(app);
    candidate.once("error", reject);
    candidate.listen(0, "127.0.0.1", () => resolve(candidate));
  });
  return {
    base: `http://127.0.0.1:${instance.address().port}`,
    close: () =>
      new Promise((resolve) => {
        instance.closeAllConnections?.();
        instance.close(() => resolve());
      }),
  };
}

test("adapter Web: GET /api/web/v1/base maps an invalid groupBy direction to 422 unsupported", async () => {
  const server = await startBaseServer({ "Grouped.base": GROUPED_BASE, "ValidGrouped.base": VALID_GROUPED_BASE, "Plain.base": SUPPORTED_BASE });
  try {
    const response = await fetch(`${server.base}/api/web/v1/base?path=Grouped.base`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "unsupported" });

    const plain = await fetch(`${server.base}/api/web/v1/base?path=Plain.base`, { signal: AbortSignal.timeout(5000) });
    assert.equal(plain.status, 200, "positive control: a supported Base is still served");
    const body = await plain.json();
    assert.equal(body.supportedSubset, true);
    assert.deepEqual(body.rows.map((row) => row.path), ["WB/One.md"]);
    assert.deepEqual(body.capabilities, { editable: false, grouping: false, aggregation: false });

    // 刀4 flip: a VALID groupBy/summaries Base is served. The Web DTO stays as
    // it was (the route does not publish the grouping surface yet — the UI leg
    // is a separate lane), so `capabilities.grouping` stays false on purpose.
    const grouped = await fetch(`${server.base}/api/web/v1/base?path=ValidGrouped.base`, { signal: AbortSignal.timeout(5000) });
    assert.equal(grouped.status, 200, "a valid groupBy Base must be served");
    const groupedBody = await grouped.json();
    assert.equal(groupedBody.supportedSubset, true);
    // The Web fixture injects its records in this order and the Base declares no
    // `sort`, so the row order is the P0 input order (the frozen pipeline sorts
    // only by declared keys + the file.path tie-break).
    assert.deepEqual(groupedBody.rows.map((row) => row.path), ["WB/One.md", "Other/Two.md"]);
  } finally {
    await server.close();
  }
});

test("adapter Web: an unknown filter namespace is also 422 unsupported", async () => {
  const server = await startBaseServer({ "NamespaceFilter.base": NAMESPACE_FILTER_BASE });
  try {
    const response = await fetch(`${server.base}/api/web/v1/base?path=NamespaceFilter.base`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "unsupported" });
  } finally {
    await server.close();
  }
});
