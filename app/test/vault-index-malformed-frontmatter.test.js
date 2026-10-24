import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-index-bad-yaml-"));
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
await fs.writeFile(
  path.join(vault, "Healthy.md"),
  "---\ntags: [healthy]\n---\n# Healthy\n\nhealthy needle\n",
  "utf8",
);
await fs.writeFile(
  path.join(vault, "Broken.md"),
  "---\naliases: [unfinished\n---\n# Broken\n\nmalformed searchable body\n\n[[Healthy]]\n",
  "utf8",
);

const [{ registerSearchTools }, { registerLinkTools }, { readNote }] = await Promise.all([
  import("../src/tools/search.js"),
  import("../src/tools/links.js"),
  import("../src/obsidian.js"),
]);

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function withClient(callback) {
  const server = new McpServer({ name: "bad-yaml-index-test", version: "1" });
  registerSearchTools(server);
  registerLinkTools(server);
  const client = new Client({ name: "bad-yaml-index-client", version: "1" });
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

test("ordinary note reads remain strict for malformed frontmatter", async () => {
  await assert.rejects(() => readNote(path.join(vault, "Broken.md")));
});

test("MCP search and link tools isolate malformed frontmatter to one note", async () => {
  await withClient(async (client) => {
    const healthy = await client.callTool({
      name: "search_notes",
      arguments: { query: "healthy needle", semantic: false },
    });
    assert.equal(healthy.isError, undefined, "a malformed neighbor must not abort search");
    assert.deepEqual(
      healthy.structuredContent.results.map((item) => item.path),
      ["Healthy.md"],
    );

    const brokenBody = await client.callTool({
      name: "search_notes",
      arguments: { query: "malformed searchable body", semantic: false },
    });
    assert.equal(brokenBody.isError, undefined, "the malformed note body must remain searchable");
    assert.deepEqual(
      brokenBody.structuredContent.results.map((item) => item.path),
      ["Broken.md"],
    );

    const backlinks = await client.callTool({
      name: "get_backlinks",
      arguments: { path: "Healthy.md" },
    });
    assert.equal(backlinks.isError, undefined, "malformed frontmatter must not disable link indexing");
    assert.deepEqual(
      backlinks.structuredContent.backlinks.map((item) => item.path),
      ["Broken.md"],
    );
  });
});
