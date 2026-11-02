import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-list-notes-"));
const vault = path.join(root, "vault");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
process.env.HISTORY_PATH = path.join(root, "data", "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(root, "data", "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
await fs.mkdir(path.join(vault, "Notes", "Deep"), { recursive: true });
await fs.writeFile(path.join(vault, "root.md"), "# root\n");
await fs.writeFile(path.join(vault, "Notes", "Nested.md"), "# nested\n");
await fs.writeFile(path.join(vault, "Notes", "Deep", "entry.md"), "# deeper\n");
const { resolveListNotesPath, registerSearchTools } = await import("../src/tools/search.js");

after(async () => { await fs.rm(root, { recursive: true, force: true }); });

test("list_notes defaults to root and normalizes its canonical pathPrefix", () => {
  assert.equal(resolveListNotesPath(undefined), "");
  assert.equal(resolveListNotesPath("/AI笔记\\\\skills/"), "AI笔记/skills/");
  assert.equal(resolveListNotesPath("Notes"), "Notes");
});

test("list_notes MCP schema and filesystem respect canonical pathPrefix, depth and cursor", async () => {
  const server = new McpServer({ name: "list-notes-test", version: "1" });
  registerSearchTools(server);
  const client = new Client({ name: "list-notes-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const descriptor = (await client.listTools()).tools.find((item) => item.name === "list_notes");
    assert.ok(descriptor?.inputSchema?.properties?.pathPrefix);
    assert.equal(descriptor?.inputSchema?.properties?.directory, undefined, "directory is not an advertised input alias");
    const call = (args) => client.callTool({ name: "list_notes", arguments: args });
    const good = async (args) => {
      const response = await call(args);
      assert.notEqual(response.isError, true, JSON.stringify(response.content));
      return response.structuredContent;
    };

    const rootPage = await good({ limit: 20 });
    assert.equal(rootPage.directory, "");
    assert.ok(rootPage.entries.some((entry) => entry.path === "root.md"));

    const canonical = await good({ pathPrefix: "Notes", limit: 20 });
    assert.equal(canonical.directory, "Notes");
    assert.deepEqual(canonical.entries.map((entry) => entry.path).sort(), ["Notes/Deep", "Notes/Nested.md"]);
    assert.equal(canonical.entries.some((entry) => entry.path === "root.md"), false);

    const first = await good({ pathPrefix: "Notes", limit: 1 });
    assert.equal(first.truncated, true);
    assert.ok(first.nextCursor);
    const second = await good({ pathPrefix: "Notes", limit: 1, cursor: first.nextCursor });
    assert.equal(second.entries.length, 1);
    assert.notEqual(second.entries[0].path, first.entries[0].path);

    const flat = await good({ pathPrefix: "Notes", recursive: true, depth: 0, limit: 20 });
    const deep = await good({ pathPrefix: "Notes", recursive: true, depth: 2, limit: 20 });
    assert.equal(flat.entries.some((entry) => entry.path === "Notes/Deep/entry.md"), false);
    assert.equal(deep.entries.some((entry) => entry.path === "Notes/Deep/entry.md"), true);

  } finally {
    await client.close();
    await server.close();
  }
});
