// Regression for issue #217: daily_note write actions (create/append/prepend)
// previously failed on every client with "MCP writes require _meta[obsidian/author]"
// because the tool was missing from the memory-guidance write sets, so no author
// context reached the fail-closed write gates. This file drives the real
// registration path and pins:
//   - all three write actions succeed with a real boolean `created`;
//   - all three write actions preserve the same mcp_author provenance
//     (create now parses the rendered template's frontmatter and goes through
//     writeNoteFile; original properties are preserved);
//   - the underlying write gates stay fail-closed without a request author.
// Scope enforcement for the tool is frozen separately in scopes.test.js
// (issue #224).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Environment must be configured before importing config/vault modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-daily-note-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.GIT_ENABLED = "false";
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(data, { recursive: true });

const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { atomicWriteFile } = await import("../src/vault.js");
const { writeNoteFile } = await import("../src/obsidian.js");

const server = new McpServer({ name: "daily-note-author-test", version: "1" });
registerObsidianCapabilities(server);
const client = new Client({ name: "daily-note-author-client", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

after(async () => {
  await client.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function call(name, args) {
  return client.callTool({ name, arguments: args });
}

function reminderKind(result) {
  return result?._meta?.["obsidian/memoryReminder"]?.kind;
}

async function dailyBytes() {
  return fs.readFile(path.join(vault, "2026-10-04.md"), "utf8");
}

test("daily_note create works through the real registration path", async () => {
  const created = await call("daily_note", { action: "create", date: "2026-10-04", content: "first line\n" });
  assert.equal(created.isError, undefined);
  assert.equal(created.structuredContent.created, true);
  assert.equal(created.structuredContent.path, "2026-10-04.md");
  assert.equal(typeof created.structuredContent.size, "number");
  assert.equal(typeof created.structuredContent.revision, "string");
  assert.equal(reminderKind(created), "verify-write", "create must be treated as a mutation");

  // Create now goes through writeNoteFile: the body stays intact and the note
  // carries the same mcp_author provenance as append/prepend.
  const bytes = await dailyBytes();
  assert.match(bytes, /first line/);
  assert.match(bytes, /mcp_author/);
});

test("daily_note create preserves template frontmatter and adds mcp_author", async () => {
  const templated = await call("daily_note", {
    action: "create",
    date: "2026-10-05",
    content: "---\nstatus: draft\n---\nfrontmatter body\n",
  });
  assert.equal(templated.isError, undefined);
  assert.equal(templated.structuredContent.created, true);
  const bytes = await fs.readFile(path.join(vault, "2026-10-05.md"), "utf8");
  assert.match(bytes, /status: draft/, "original template property must be preserved");
  assert.match(bytes, /mcp_author/, "create must stamp provenance like the other write actions");
  assert.match(bytes, /frontmatter body/);
});

test("daily_note read actions stay read-like and keep working", async () => {
  const pathResult = await call("daily_note", { action: "path", date: "2026-10-04" });
  assert.equal(pathResult.isError, undefined);
  assert.equal(pathResult.structuredContent.exists, true);
  assert.notEqual(reminderKind(pathResult), "verify-write", "path must not be treated as a mutation");

  const read = await call("daily_note", { action: "read", date: "2026-10-04" });
  assert.equal(read.isError, undefined);
  assert.equal(read.structuredContent.path, "2026-10-04.md");
  assert.notEqual(reminderKind(read), "verify-write", "read must not be treated as a mutation");
});

test("daily_note append and prepend work and stamp mcp_author", async () => {
  const seed = await call("daily_note", { action: "create", date: "2026-10-06", content: "first line\n", overwrite: true });
  assert.equal(seed.isError, undefined, "seed create must succeed");
  const appended = await call("daily_note", { action: "append", date: "2026-10-06", content: "tail line\n" });
  assert.equal(appended.isError, undefined);
  assert.equal(appended.structuredContent.action, "append");
  let bytes = await fs.readFile(path.join(vault, "2026-10-06.md"), "utf8");
  assert.match(bytes, /first line[\s\S]*tail line/);
  assert.match(bytes, /mcp_author/, "append goes through writeNoteFile and stamps provenance");

  const prepended = await call("daily_note", { action: "prepend", date: "2026-10-06", content: "top line\n" });
  assert.equal(prepended.isError, undefined);
  assert.equal(prepended.structuredContent.action, "prepend");
  bytes = await fs.readFile(path.join(vault, "2026-10-06.md"), "utf8");
  assert.match(bytes, /top line[\s\S]*first line/);
  assert.match(bytes, /mcp_author/, "prepend goes through writeNoteFile and stamps provenance");
});

test("write gates stay fail-closed without a request author", async () => {
  await assert.rejects(
    () => atomicWriteFile(path.join(vault, "direct-atomic.md"), "x", { encoding: "utf-8" }),
    /MCP writes require/,
    "atomicWriteFile must keep requiring an author context",
  );
  await assert.rejects(
    () => writeNoteFile(path.join(vault, "direct-note.md"), {}, "x"),
    /MCP writes require/,
    "writeNoteFile must keep requiring an author context",
  );
});
