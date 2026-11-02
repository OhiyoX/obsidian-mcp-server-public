// Issue #229 follow-up / D1 — §15.3 fallback fault evidence: corrupt retrieval index.
//
// This is the *degradation* case (unparsable JSON), NOT the recall-rejection case.
// For the executable "recall throws" contract see
// search-229-fault-recall-throw.test.js (JSON-valid but shape-broken index).
//
// Deterministic public-config injection: point RETRIEVAL_INDEX_PATH at an invalid
// JSON file. Observed contract on this head (see D1.HANDOFF.md limitations):
//   - retrieval.loadState() catches the JSON error, logs it, and degrades to an
//     empty in-memory index; recall() therefore does NOT throw;
//   - the tool never crashes, fallbackUsed=true, exact results are preserved;
//   - hybridUsed stays true (the brief's expected hybridUsed=false would require
//     a throwing recall(), which public config cannot trigger — recall() only
//     throws for an empty query);
//   - the reported semanticError is the embedding-disabled degradation reason,
//     not the index error, because an empty index has no embeddings to query.
//
// Run:
//   cd app
//   node --test test/search-229-fault-corrupt-index.test.js

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-search-229-fault-corrupt-"));
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
await fs.writeFile(path.join(vault, "Other.md"), "# Other\n\nunrelated body.\n", "utf8");
// The fault: a retrieval index that cannot be parsed.
await fs.writeFile(process.env.RETRIEVAL_INDEX_PATH, "{ this is not valid json", "utf8");

const [{ registerSearchTools }, { drainRetrievalIndex }] = await Promise.all([
  import("../src/tools/search.js"),
  import("../src/retrieval.js"),
]);

after(async () => {
  await drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

async function withClient(callback) {
  const server = new McpServer({ name: "search-229-fault-corrupt", version: "1" });
  registerSearchTools(server);
  const client = new Client({ name: "search-229-fault-corrupt-client", version: "1" });
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

test("§15.3 corrupt retrieval index: the tool degrades without crashing and keeps exact results", async () => {
  await withClient(async (client) => {
    // The file is genuinely corrupt before the first call.
    const raw = await fs.readFile(process.env.RETRIEVAL_INDEX_PATH, "utf8");
    assert.throws(() => JSON.parse(raw), "setup must write an unparsable index");

    // auto + exact=0 + positive text: the fallback path runs against the
    // degraded (empty) retrieval state.
    const degraded = await search(client, { query: "absent-token-xyz" });
    assert.equal(degraded.semanticMode, "auto");
    assert.equal(degraded.fallbackUsed, true);
    assert.equal(degraded.hybridUsed, true);
    assert.equal(degraded.semanticUsed, false);
    assert.equal(degraded.results.length, 0);
    assert.ok(degraded.semanticError, "a degradation reason must be reported");

    // semantic=true + exact>0 on the same corrupt index: exact results survive
    // the failed embedding/retrieval path.
    const exact = await search(client, { query: "exact-needle", semantic: true });
    assert.equal(exact.semanticMode, "on");
    assert.equal(exact.fallbackUsed, false);
    assert.equal(exact.hybridUsed, true);
    assert.deepEqual(exact.results.map((item) => item.path), ["Keep.md"], "exact results must not be lost");

    // auto + exact>0 never touches retrieval, so it is fully independent of the
    // corrupt index.
    const exactAuto = await search(client, { query: "exact-needle" });
    assert.equal(exactAuto.semanticMode, "auto");
    assert.equal(exactAuto.fallbackUsed, false);
    assert.equal(exactAuto.hybridUsed, false);
    assert.deepEqual(exactAuto.results.map((item) => item.path), ["Keep.md"]);
  });
});
