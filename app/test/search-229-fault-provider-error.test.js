// Issue #229 follow-up / D1 — §15.3 fallback fault evidence: embedding provider error.
//
// Deterministic public-config injection without a fault seam:
//   - EMBEDDING_PROVIDER=openai + a reachable-shaped but unreachable base URL
//     (http://127.0.0.1:1) and a model name => semanticConfiguration().enabled;
//   - RETRIEVAL_INDEX_PATH points at a *valid* index whose chunks carry an
//     `embedding` array, so rankRecall() actually calls embedTexts() at query
//     time; the unreachable endpoint makes that call reject immediately.
// The recalled error is reported through `semanticError`; exact results are
// preserved and the tool never crashes. No sleep/timer is used: the failure is
// connection-refused, not a timeout.
//
// Run:
//   cd app
//   node --test test/search-229-fault-provider-error.test.js

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-search-229-fault-provider-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "openai";
process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:1";
process.env.EMBEDDING_MODEL = "probe-model";
process.env.EMBEDDING_TIMEOUT_MS = "2000";
process.env.GIT_ENABLED = "false";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(path.join(data, "index"), { recursive: true });
await fs.writeFile(path.join(vault, "Keep.md"), "# Keep\n\nexact-needle lives here.\n", "utf8");
await fs.writeFile(path.join(vault, "Other.md"), "# Other\n\nunrelated body.\n", "utf8");

// A valid retrieval index (version 1) with one embedded chunk. Written before
// the tool loads it so the query-time embedding provider is exercised.
const fixtureIndex = {
  version: 1,
  updatedAt: new Date().toISOString(),
  embeddingModel: "probe-model",
  notes: {
    "Keep.md": {
      path: "Keep.md",
      metadata: {
        title: "Keep",
        description: "",
        type: "",
        status: "",
        memoryKind: "",
        tags: [],
        aliases: [],
        entities: [],
        projects: [],
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
      },
      chunks: [{ id: "Keep.md#0", ordinal: 0, heading: "Keep", text: "exact-needle lives here.", hash: "probe", embedding: [0.1, 0.2, 0.3] }],
    },
  },
};
await fs.writeFile(process.env.RETRIEVAL_INDEX_PATH, JSON.stringify(fixtureIndex), "utf8");

const [{ registerSearchTools }, { drainRetrievalIndex }] = await Promise.all([
  import("../src/tools/search.js"),
  import("../src/retrieval.js"),
]);

after(async () => {
  await drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

async function withClient(callback) {
  const server = new McpServer({ name: "search-229-fault-provider", version: "1" });
  registerSearchTools(server);
  const client = new Client({ name: "search-229-fault-provider-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function search(client, args) {
  const result = await client.callTool({ name: "search_notes", arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent;
}

test("§15.3 embedding provider error: non-fatal degradation and exact results survive", async () => {
  await withClient(async (client) => {
    // First recall in the process: the in-memory retrieval state is the fixture
    // with an embedding, so the unreachable provider is really exercised.
    const degraded = await search(client, { query: "absent-token-xyz" });
    assert.equal(degraded.semanticMode, "auto");
    assert.equal(degraded.fallbackUsed, true);
    assert.equal(degraded.hybridUsed, true);
    assert.equal(degraded.semanticUsed, false);
    assert.ok(degraded.semanticError, "the provider failure must be reported");
    assert.doesNotMatch(degraded.semanticError, /not configured/, "the provider is configured; this must be a real failure");
    assert.match(degraded.semanticError, /fetch failed|ECONNREFUSED|connect/i);
    assert.deepEqual(degraded.results, []);

    // Exact results are not lost while the provider is failing.
    const exact = await search(client, { query: "exact-needle", semantic: true });
    assert.equal(exact.semanticMode, "on");
    assert.equal(exact.fallbackUsed, false);
    assert.deepEqual(exact.results.map((item) => item.path), ["Keep.md"]);
  });
});
