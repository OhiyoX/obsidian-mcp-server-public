// P0 Task 3 gate: every canonical tool description comes from the Base pack, and
// no tool module keeps its own copy of that text.
//
// Two directions, because either one alone can pass while the copy is duplicated:
// the wire must still say exactly what it said before (golden), and the source
// must no longer hold a description literal that could drift from the pack.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TEST_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-prompt-tools-"));
process.env.VAULT_PATH = path.join(TEST_ROOT, "vault");
process.env.DATA_PATH = path.join(TEST_ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";

const { TOOL_NAMES } = await import("../src/config.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { bundledBasePack } = await import("../src/prompt-registry/bundled.js");
const { renderPromptTemplate } = await import("../src/prompt-registry/schema.js");

test.after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

const BASELINE = JSON.parse(await readFile(new URL("./fixtures/prompt-base-baseline.json", import.meta.url), "utf8"));

function suffixOf(description) {
  const read = BASELINE.memory.readHint;
  const write = BASELINE.memory.writeHint;
  if (description.endsWith(read)) return "read";
  if (description.endsWith(write)) return "write";
  return null;
}

test("the pack carries a description for every canonical tool", () => {
  for (const name of TOOL_NAMES) {
    const text = bundledBasePack().values[`tools.canonical.${name}.description`];
    assert.equal(typeof text, "string", name);
    assert.notEqual(text.trim(), "", name);
  }
});

test("each wire description is the Base text plus its guidance suffix", async () => {
  const server = new McpServer({ name: "prompt-tools", version: "1" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "prompt-tools-client", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();

  const wire = new Map(tools.map((tool) => [tool.name, tool.description ?? ""]));
  assert.deepEqual([...wire.keys()].sort(), [...TOOL_NAMES].sort());

  for (const [name, description] of wire) {
    assert.equal(description, BASELINE.canonical[name].description, `${name} equals the frozen text`);
    const base = renderPromptTemplate(bundledBasePack().values[`tools.canonical.${name}.description`], {
      memoryPath: "20-Memory",
    });
    const kind = suffixOf(description);
    const suffix = kind === "read" ? BASELINE.memory.readHint : kind === "write" ? BASELINE.memory.writeHint : "";
    assert.equal(base + suffix, description, `${name} comes from the pack plus its suffix`);
  }
});

test("tool modules no longer hold description literals", async () => {
  const directory = new URL("../src/tools/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".js"));
  assert.ok(files.length >= 11);
  const offenders = [];
  for (const file of files) {
    const source = await readFile(new URL(file, directory), "utf8");
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      // A tool config property named `description` is the literal this gate bans.
      // Zod `.describe(...)`, handler variables and comments are not that property.
      if (/^\s*description:\s*["'`]/.test(line) || /^\s*description:\s*$/.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    });
  }
  // The shared face module holds one tool config too; it must follow the same rule.
  const face = await readFile(new URL("../src/base-create-face.js", import.meta.url), "utf8");
  face.split("\n").forEach((line, index) => {
    if (/^\s*description:\s*["'`]/.test(line) || /^\s*description:\s*$/.test(line)) {
      offenders.push(`base-create-face.js:${index + 1}`);
    }
  });
  assert.deepEqual(offenders, [], "tool copy must live in app/prompts/base");
});
