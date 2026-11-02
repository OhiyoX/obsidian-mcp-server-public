// Issue #229 follow-up / D1 RETURN — §15.3 executable "recall throws" evidence.
//
// The corrupt-JSON case (search-229-fault-corrupt-index.test.js) is a *degrade*
// case: loadState() catches the JSON.parse error and substitutes emptyState(),
// so recall() resolves normally. This file covers the distinct *rejection* case:
// a JSON-valid, `version: 1` index whose runtime shape is broken. loadState()
// does no shape validation, so `rankRecall()` reaches
// `notes.flatMap((note) => note.chunks.map(...))` with `chunks: null` and throws
// a TypeError. `recall()` does not catch `rankRecall()`, so the exception
// propagates into `augmentWithRetrieval()`'s catch, which degrades to the exact
// results and reports the real message with `hybridUsed === false`.
//
// The expected message is captured dynamically from a direct `recall()` call
// (the same exception the tool path propagates) and is never hardcoded.
//
// Run:
//   cd app
//   node --test test/search-229-fault-recall-throw.test.js

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-search-229-fault-recall-throw-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(path.join(data, "index"), { recursive: true });
await fs.writeFile(path.join(vault, "Keep.md"), "# Keep\n\nexact-needle lives here.\n", "utf8");

// JSON-valid, version 1, but the runtime shape is broken: `chunks` is null.
// `metadata` stays filter-compatible so the failure happens at the chunk map,
// not in matchesFilters().
const badShapeIndex = {
  version: 1,
  updatedAt: new Date().toISOString(),
  embeddingModel: null,
  notes: {
    "Keep.md": {
      path: "Keep.md",
      revision: "no-match",
      stat: {},
      metadata: { title: "Keep", description: "", tags: [], entities: [] },
      chunks: null,
    },
  },
};
await fs.writeFile(process.env.RETRIEVAL_INDEX_PATH, JSON.stringify(badShapeIndex), "utf8");

const [{ registerSearchTools }, { recall, drainRetrievalIndex }] = await Promise.all([
  import("../src/tools/search.js"),
  import("../src/retrieval.js"),
]);

after(async () => {
  await drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

async function withClient(callback) {
  const server = new McpServer({ name: "search-229-fault-recall-throw", version: "1" });
  registerSearchTools(server);
  const client = new Client({ name: "search-229-fault-recall-throw-client", version: "1" });
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

test("§15.3 recall rejection: a shape-broken version-1 index rejects recall() and the tool degrades with the real message", async () => {
  // Dynamic oracle: capture the real exception from the same call the tool
  // makes. No message string is hardcoded. assert.throws-style capture because
  // the async rejection is intentionally part of the contract under test.
  let expectedMessage;
  try {
    await recall("absent-token-xyz", { semantic: true, limit: 100, chunksPerNote: 2, snippetLength: 400 });
  } catch (error) {
    expectedMessage = error.message;
  }
  assert.ok(expectedMessage, "the shape-broken index must make recall() reject");
  assert.match(expectedMessage, /map|null|chunks/i);

  await withClient(async (client) => {
    // auto + exact=0 + positive text: the rejected recall degrades to exact
    // results, reports the real message, and must not claim hybridUsed.
    const degraded = await search(client, { query: "absent-token-xyz" });
    assert.equal(degraded.semanticMode, "auto");
    assert.equal(degraded.fallbackUsed, true);
    assert.equal(degraded.hybridUsed, false, "a rejected recall must not report hybridUsed");
    assert.equal(degraded.semanticUsed, false);
    assert.equal(degraded.semanticError, expectedMessage, "the tool must surface the real recall exception verbatim");
    assert.deepEqual(degraded.results, []);
    assert.equal("diagnostics" in degraded, true, "auto exact=0 still explains the exact pass");

    // semantic=true + exact>0 on the same broken index: exact results survive.
    const exact = await search(client, { query: "exact-needle", semantic: true });
    assert.equal(exact.semanticMode, "on");
    assert.equal(exact.fallbackUsed, false);
    assert.deepEqual(exact.results.map((item) => item.path), ["Keep.md"], "exact results must survive a rejected recall");
  });
});
