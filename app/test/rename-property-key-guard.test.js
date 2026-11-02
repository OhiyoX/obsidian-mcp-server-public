// Issue #531: exercise the registered MCP tool, schema defaults and persisted bytes.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-rename-property-"));
const vault = path.join(root, "vault");
const history = path.join(root, "data", "history");
Object.assign(process.env, {
  VAULT_PATH: vault,
  DATA_PATH: path.join(root, "data"),
  HISTORY_PATH: history,
  GIT_ENABLED: "false",
  VERSION_HISTORY_ENABLED: "true",
  RETRIEVAL_AUTO_EMBED: "false",
  EMBEDDING_PROVIDER: "disabled",
});
await fs.mkdir(vault, { recursive: true });

const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { invalidateVaultIndex } = await import("../src/vault-index.js");
const { parseFrontmatter } = await import("../src/obsidian.js");
const author = { agent: "rename-property-test", model: "test" };
const server = new McpServer({ name: author.agent, version: "1" });
registerObsidianCapabilities(server);
const client = new Client({ name: author.agent, version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
after(async () => {
  await client.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

const body = "# Body\n\nKeep **formatting**, [[links]] and 中文.\n";
const provenance = "mcp_author:\n  agent: rename-property-test\n  model: test\n";
const rawNote = (header) => `---\n${header}\n${provenance}---\n${body}`;
let caseNumber = 0;
async function fixture(headers) {
  const prefix = `case-${++caseNumber}`;
  await fs.mkdir(path.join(vault, prefix));
  const paths = [];
  for (const [i, header] of headers.entries()) {
    const relative = `${prefix}/${i + 1}.md`;
    await fs.writeFile(path.join(vault, relative), rawNote(header));
    paths.push(relative);
  }
  invalidateVaultIndex(paths);
  return { prefix, paths };
}
const read = (relative) => fs.readFile(path.join(vault, relative), "utf8");
const bytes = (paths) => Promise.all(paths.map((relative) => fs.readFile(path.join(vault, relative))));
async function historyEntries() {
  try { return (await fs.readdir(history, { recursive: true })).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
const call = (args) => client.callTool({ name: "rename_property", arguments: args, _meta: { "obsidian/author": author } });
function success(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
}
function errorText(result) {
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.content.map((part) => part.text).join("\n");
}

for (const dryRun of [true, false]) {
  test(`existing dotted source can be renamed to plain (dryRun=${dryRun})`, async () => {
    const { prefix, paths } = await fixture(["a.b: source\na:\n  b: nested\nkeep: true", "other: untouched"]);
    const before = await bytes(paths);
    const out = success(await call({ from: "a.b", to: "plain", pathPrefix: prefix, dryRun }));
    assert.deepEqual(out, { from: "a.b", to: "plain", dryRun, changed: [paths[0]], skipped: [], truncated: false });
    if (dryRun) assert.deepEqual(await bytes(paths), before);
    else {
      const parsed = parseFrontmatter(await read(paths[0]));
      assert.deepEqual(parsed.data, { a: { b: "nested" }, keep: true, mcp_author: author, plain: "source" });
      assert.equal(parsed.content, body);
      assert.equal(await read(paths[0]), `---\na:\n  b: nested\nkeep: true\n${provenance}plain: source\n---\n${body}`);
      assert.deepEqual((await bytes(paths))[1], before[1]);
    }
  });
}

let destinationError;
for (const dryRun of [undefined, true, false]) {
  for (const conflict of ["error", "skip", "overwrite"]) {
    test(`dotted destination is refused before any note changes (dryRun=${dryRun ?? "default"}, conflict=${conflict})`, async () => {
      const { prefix, paths } = await fixture([
        "plain: source\na:\n  b: nested",
        "plain: second\na.b: existing",
        "other: untouched",
      ]);
      const before = await bytes(paths);
      const historyBefore = await historyEntries();
      const args = { from: "plain", to: "a.b", pathPrefix: prefix, conflict };
      if (dryRun !== undefined) args.dryRun = dryRun;
      const message = errorText(await call(args));
      assert.match(message, /rename/i);
      assert.match(message, /cannot create.*(?:dot|"\."|containing)/i);
      assert.match(message, /nested.*parent mapping/i);
      assert.match(message, /manage_frontmatter.*updates/i);
      if (destinationError === undefined) destinationError = message;
      assert.equal(message, destinationError, "preview and apply must return the same explicit error");
      assert.deepEqual(await bytes(paths), before, "the entire batch must remain byte-identical");
      assert.deepEqual(await historyEntries(), historyBefore, "rejection must not create pre-write history");
    });
  }
}

for (const header of ["other: no-source", "plain: source\na.b: existing"]) {
  test(`dotted destination is refused even with no source or an existing target: ${header.split("\n")[0]}`, async () => {
    const { prefix, paths } = await fixture([header]);
    const before = await bytes(paths);
    errorText(await call({ from: "plain", to: "a.b", pathPrefix: prefix, dryRun: false, conflict: "overwrite" }));
    assert.deepEqual(await bytes(paths), before);
  });
}

test("dotted destination is refused for an empty selection", async () => {
  const { prefix } = await fixture([]);
  errorText(await call({ from: "plain", to: "a.b", pathPrefix: prefix }));
});

for (const conflict of ["error", "skip", "overwrite"]) {
  for (const dryRun of [true, false]) {
    test(`plain destination preserves conflict=${conflict} behavior (dryRun=${dryRun})`, async () => {
      const { prefix, paths } = await fixture(["plain: source\nkeep: true\nrenamed: target", "other: untouched"]);
      const before = await bytes(paths);
      const result = await call({ from: "plain", to: "renamed", pathPrefix: prefix, conflict, dryRun });
      if (conflict === "error") {
        assert.equal(errorText(result), `Error: Property conflict in ${paths[0]}: renamed already exists`);
      } else {
        const changed = conflict === "overwrite" ? [paths[0]] : [];
        const skipped = conflict === "skip" ? [paths[0]] : [];
        assert.deepEqual(success(result), { from: "plain", to: "renamed", dryRun, changed, skipped, truncated: false });
      }
      if (dryRun || conflict !== "overwrite") assert.deepEqual(await bytes(paths), before);
      else {
        assert.equal(await read(paths[0]), rawNote("keep: true\nrenamed: source"));
        assert.deepEqual((await bytes(paths))[1], before[1]);
      }
    });
  }
}

test("plain destination keeps default preview, pathPrefix and limit behavior", async () => {
  const selected = await fixture(["plain: first", "plain: second"]);
  const outside = await fixture(["plain: outside"]);
  const allPaths = [...selected.paths, ...outside.paths];
  const before = await bytes(allPaths);
  assert.deepEqual(success(await call({ from: "plain", to: "renamed", pathPrefix: selected.prefix, limit: 1 })), {
    from: "plain", to: "renamed", dryRun: true, changed: [selected.paths[0]], skipped: [], truncated: true,
  });
  assert.deepEqual(await bytes(allPaths), before);
  const applied = success(await call({ from: "plain", to: "renamed", pathPrefix: selected.prefix, limit: 1, dryRun: false }));
  assert.deepEqual(applied, { from: "plain", to: "renamed", dryRun: false, changed: [selected.paths[0]], skipped: [], truncated: true });
  assert.equal(await read(selected.paths[0]), `---\n${provenance}renamed: first\n---\n${body}`);
  assert.deepEqual((await bytes(allPaths)).slice(1), before.slice(1));
});

test("missing dotted source to a plain destination remains a successful no-op", async () => {
  const { prefix, paths } = await fixture(["a:\n  b: nested"]);
  const before = await bytes(paths);
  assert.deepEqual(success(await call({ from: "a.b", to: "plain", pathPrefix: prefix, dryRun: false })), {
    from: "a.b", to: "plain", dryRun: false, changed: [], skipped: [], truncated: false,
  });
  assert.deepEqual(await bytes(paths), before);
});
