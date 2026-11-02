// Regression for issue #211: output contracts must match the real handler
// results. `tool-contracts.js` infers a field's type from a global name -> type
// table, so two tools returning different scalar types under one field name
// need per-tool overrides. Without them the server rejects its own
// structuredContent with `-32602 Output validation error` on every client that
// validates output. This file drives the real registered tools through the
// MCP SDK so a regression fails exactly the way production failed:
//   get_note_version.created: ISO string vs declared boolean
//   git_diff.staged:          boolean    vs declared string
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const execFileAsync = promisify(execFile);

// Environment must be configured before importing config/vault/retrieval modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-output-schema-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
const history = path.join(data, "history");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = history;
process.env.GIT_ENABLED = "true";
process.env.GIT_AUTO_COMMIT = "false";
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(data, { recursive: true });

const { registerObsidianCapabilities } = await import("../src/capabilities.js");

async function git(...args) {
  return execFileAsync("git", ["-C", vault, ...args], { encoding: "utf-8" });
}

// Commit one tracked file so git_diff has a stable unstaged/staged baseline.
await git("init");
await fs.writeFile(path.join(vault, "tracked.md"), "initial\n", "utf8");
await git("add", "tracked.md");
await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");

const server = new McpServer({ name: "output-schema-collision-test", version: "1" });
registerObsidianCapabilities(server);
const client = new Client({ name: "output-schema-collision-client", version: "1" });
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

test("write_note keeps the boolean created flag in structured output", async () => {
  const created = await call("write_note", { path: "Notes/flag.md", content: "first\n", overwrite: true });
  assert.equal(created.isError, undefined);
  assert.equal(created.structuredContent.created, true);
  const replaced = await call("write_note", { path: "Notes/flag.md", content: "second\n", overwrite: true });
  assert.equal(replaced.isError, undefined);
  assert.equal(replaced.structuredContent.created, false);
});

test("append_to_note keeps the boolean created flag in structured output", async () => {
  const appended = await call("append_to_note", { path: "Notes/flag.md", content: "tail\n" });
  assert.equal(appended.isError, undefined);
  assert.equal(appended.structuredContent.created, false);
});

test("get_note_version reports string timestamps and a numeric size", async () => {
  await call("write_note", { path: "Notes/versioned.md", content: "v1\n", overwrite: true });
  await call("write_note", { path: "Notes/versioned.md", content: "v2\n", overwrite: true });
  const versionDirectory = path.join(history, "Notes", "versioned.md");
  const entries = (await fs.readdir(versionDirectory)).filter((name) => name.endsWith(".bak")).sort((a, b) => b.localeCompare(a));
  assert.ok(entries.length >= 1, "overwriting a note must create a history version");

  const result = await call("get_note_version", { versionId: `Notes/versioned.md/${entries[0]}` });
  assert.equal(result.isError, undefined);
  const out = result.structuredContent;
  assert.equal(typeof out.created, "string");
  assert.equal(typeof out.modified, "string");
  assert.ok(!Number.isNaN(Date.parse(out.created)), "created must be a parseable ISO timestamp");
  assert.equal(typeof out.size, "number");
  assert.equal(typeof out.revision, "string");
  assert.equal(out.truncated, false);
  assert.match(out.content, /v1/);
});

test("git_diff reports staged as a boolean", async () => {
  const clean = await call("git_diff", { staged: false });
  assert.equal(clean.isError, undefined);
  assert.equal(clean.structuredContent.staged, false);
  assert.equal(typeof clean.structuredContent.diff, "string");

  await fs.writeFile(path.join(vault, "tracked.md"), "changed\n", "utf8");
  const unstaged = await call("git_diff", { staged: false });
  assert.equal(unstaged.isError, undefined);
  assert.equal(unstaged.structuredContent.staged, false);
  assert.match(unstaged.structuredContent.diff, /changed/);

  await git("add", "tracked.md");
  const staged = await call("git_diff", { staged: true });
  assert.equal(staged.isError, undefined);
  assert.equal(staged.structuredContent.staged, true);
  assert.match(staged.structuredContent.diff, /changed/);
});

test("daily_note validates its declared output shape for read actions", async () => {
  // daily_note create was blocked by a separate author-propagation defect
  // (issue #217); that chain is covered end-to-end by daily-note-author.test.js.
  // Here the read actions pin the declared schema; the boolean `created` flag
  // shares the global field entry pinned by write_note / append_to_note above.
  const missing = await call("daily_note", { action: "path", date: "2026-10-04" });
  assert.equal(missing.isError, undefined);
  assert.equal(missing.structuredContent.path, "2026-10-04.md");
  assert.equal(missing.structuredContent.exists, false);

  await fs.writeFile(path.join(vault, "2026-10-04.md"), "existing daily\n", "utf8");
  const present = await call("daily_note", { action: "path", date: "2026-10-04" });
  assert.equal(present.isError, undefined);
  assert.equal(present.structuredContent.exists, true);

  const read = await call("daily_note", { action: "read", date: "2026-10-04" });
  assert.equal(read.isError, undefined);
  assert.equal(read.structuredContent.content, "existing daily\n");
  assert.equal(typeof read.structuredContent.date, "string");
  assert.equal(typeof read.structuredContent.revision, "string");
  assert.equal(typeof read.structuredContent.stat, "object");
});
