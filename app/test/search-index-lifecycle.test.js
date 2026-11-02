import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-search-index-lifecycle-"));
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
await fs.mkdir(data, { recursive: true });

const [{ registerSearchTools }, { getVaultIndex }, { drainRetrievalIndex }] = await Promise.all([
  import("../src/tools/search.js"),
  import("../src/vault-index.js"),
  import("../src/retrieval.js"),
]);

after(async () => {
  // A closed MCP client transport does not close the retrieval storage
  // lifecycle. Drain the index queue and debounce timer before removing the
  // scratch root so cleanup cannot race an in-flight atomic index write.
  await drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

async function withClient(callback) {
  const server = new McpServer({ name: "search-index-lifecycle-test", version: "1" });
  registerSearchTools(server);
  const client = new Client({ name: "search-index-lifecycle-client", version: "1" });
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

async function search(client, query, extra = {}) {
  const result = await client.callTool({
    name: "search_notes",
    arguments: { query, semantic: false, ...extra },
  });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent;
}

test("search index reflects external move/delete and reports result truncation", async () => {
  const oldPath = path.join(vault, "Old.md");
  const movedPath = path.join(vault, "Moved.md");
  await fs.writeFile(oldPath, "# Lifecycle\n\nlifecycle-index-needle\n", "utf8");

  await withClient(async (client) => {
    const initial = await search(client, "lifecycle-index-needle");
    assert.deepEqual(initial.results.map((item) => item.path), ["Old.md"]);

    await fs.rename(oldPath, movedPath);
    const moved = await search(client, "lifecycle-index-needle");
    assert.deepEqual(
      moved.results.map((item) => item.path),
      ["Moved.md"],
      "a moved note must not leave the previous path searchable",
    );
    assert.ok(moved.index.removed >= 1, "move refresh should prune the stale cached path");

    await fs.rm(movedPath);
    const deleted = await search(client, "lifecycle-index-needle");
    assert.deepEqual(deleted.results, [], "a deleted note must disappear from search");
    assert.ok(deleted.index.removed >= 1, "delete refresh should prune the stale cached path");

    await fs.writeFile(path.join(vault, "Limit-A.md"), "# A\n\ntruncation-probe\n", "utf8");
    await fs.writeFile(path.join(vault, "Limit-B.md"), "# B\n\ntruncation-probe\n", "utf8");
    const limited = await search(client, "truncation-probe", { limit: 1, sortBy: "path" });
    assert.equal(limited.results.length, 1);
    assert.equal(limited.totalMatched, 2);
    assert.equal(limited.truncated, true, "result-limit truncation must be explicit");
    assert.ok(limited.totalScanned >= 2);

    const degraded = await search(client, "truncation-probe", { semantic: true, limit: 2 });
    assert.equal(degraded.semanticRequested, true);
    assert.equal(degraded.semanticUsed, false);
    assert.match(
      degraded.semanticError || "",
      /Embedding provider is not configured; lexical hybrid ranking was used/,
      "semantic fallback must be reported instead of silently presented as semantic retrieval",
    );
    assert.equal(degraded.hybridUsed, true);
  });

  // The semantic search above scheduled a background retrieval refresh. Settle
  // it before the forced scope/hidden rebuilds and before teardown.
  await drainRetrievalIndex();

  const scopedDir = path.join(vault, "Scoped");
  await fs.mkdir(scopedDir, { recursive: true });
  await fs.writeFile(path.join(scopedDir, "Inside.md"), "# Inside\n\nscope-cache-probe\n", "utf8");
  await fs.writeFile(path.join(vault, "Outside.md"), "# Outside\n\nscope-cache-probe\n", "utf8");
  await fs.writeFile(path.join(vault, ".Hidden.md"), "# Hidden\n\nhidden-cache-probe\n", "utf8");

  const scoped = await getVaultIndex({ force: true, pathPrefix: "Scoped" });
  assert.equal(scoped.records.some((record) => record.path === "Scoped/Inside.md"), true);
  assert.equal(scoped.records.some((record) => record.path === "Outside.md"), false);

  const full = await getVaultIndex({ force: true });
  assert.equal(full.records.some((record) => record.path === "Scoped/Inside.md"), true);
  assert.equal(full.records.some((record) => record.path === "Outside.md"), true);
  assert.equal(full.records.some((record) => record.path === ".Hidden.md"), false);

  const withHidden = await getVaultIndex({ force: true, includeHidden: true });
  assert.equal(withHidden.records.some((record) => record.path === ".Hidden.md"), true);

  const withoutHidden = await getVaultIndex({ force: true, includeHidden: false });
  assert.equal(withoutHidden.records.some((record) => record.path === ".Hidden.md"), false);
  assert.equal(withoutHidden.records.some((record) => record.path === "Outside.md"), true);

  const hiddenAgain = await getVaultIndex({ force: true, includeHidden: true });
  assert.equal(
    hiddenAgain.records.some((record) => record.path === ".Hidden.md"),
    true,
    "hidden records must be re-indexable after a non-hidden refresh prunes them",
  );
});
