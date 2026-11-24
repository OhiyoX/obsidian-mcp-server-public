// P0 Task 5 gate (compact half): a compact group's intent sentence comes from the
// Base pack, while the action list, the credential rule, the routing table and the
// per-branch schemas stay code-owned.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TEST_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-prompt-compact-"));
process.env.VAULT_PATH = path.join(TEST_ROOT, "vault");
process.env.DATA_PATH = path.join(TEST_ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";

const { COMPACT_GROUPS, compactToolView } = await import("../src/compact-tools.js");
const { compactDescriptorFingerprint } = await import("../src/compact-descriptor-integrity.js");
const { TOOL_NAMES } = await import("../src/config.js");
const { bundledBasePack } = await import("../src/prompt-registry/bundled.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");

test.after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

const BASELINE = JSON.parse(await readFile(new URL("./fixtures/prompt-base-baseline.json", import.meta.url), "utf8"));
const DESCRIPTIONS = BASELINE.canonical;

async function nativeTools() {
  const server = new McpServer({ name: "prompt-compact-native", version: "1" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "prompt-compact", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return JSON.parse(JSON.stringify(tools));
  } finally {
    await client.close();
    await server.close();
  }
}

function shiftedSnapshot(suffix) {
  const values = { ...bundledBasePack().values };
  for (const domain of Object.keys(COMPACT_GROUPS)) {
    const key = `tools.compact.${domain}.summary`;
    if (keys().includes(key)) values[key] = `${values[key]}${suffix}`;
  }
  return { revision: 2, values };
}

function keys() {
  return Object.keys(bundledBasePack().values);
}

test("the pack carries an intent sentence for the six domains that have one", () => {
  const summaries = keys().filter((key) => key.startsWith("tools.compact."));
  assert.equal(summaries.length, 6);
  for (const key of summaries) assert.notEqual(bundledBasePack().values[key].trim(), "", key);
});

test("no summary means no intent sentence, exactly as before the migration", async () => {
  const native = await nativeTools();
  const { tools } = compactToolView(native, [...TOOL_NAMES]);
  const info = tools.find((tool) => tool.name === "obsidian_info");
  assert.equal(
    info.description,
    "Obsidian actions / 笔记操作: index_status. Choose action then supply its native params; credentials and Vault policy are checked per action.",
  );
});

test("the compact wire still reproduces the frozen descriptors", async () => {
  const native = await nativeTools();
  const { tools } = compactToolView(native, [...TOOL_NAMES]);
  assert.deepEqual(
    tools.map((tool) => ({ name: tool.name, description: tool.description ?? null })),
    BASELINE.compact.descriptors,
  );
  assert.equal(compactDescriptorFingerprint(tools), BASELINE.compact.fingerprint);
});

test("changing a summary changes only the group description", async () => {
  const native = await nativeTools();
  const before = compactToolView(native, [...TOOL_NAMES]);
  const after = compactToolView(native, [...TOOL_NAMES], { promptSnapshot: shiftedSnapshot(" [edited]") });

  assert.deepEqual(after.tools.map((tool) => tool.name), before.tools.map((tool) => tool.name), "names keep");
  assert.deepEqual([...after.routing.keys()], [...before.routing.keys()], "routing keys keep");
  for (const [name, members] of after.routing) {
    assert.deepEqual([...members], [...before.routing.get(name)], `${name} membership keeps`);
  }
  // The edit domain is partitioned by Scope/annotation signature, so the group is
  // several descriptors; the intent sentence belongs to each of them.
  const pick = (list) => list.find((tool) => tool.description.includes("新建、保存、写入、修改、追加笔记"));
  const edited = pick(after.tools);
  const original = pick(before.tools);
  assert.notEqual(edited.description, original.description);
  assert.ok(edited.description.includes("[edited]"));
  // The action list and the credential rule are code, so they survive an edit
  // unchanged, in the same order.
  const actionsOf = (description) => description.slice("Obsidian actions / 笔记操作: ".length).split(". ")[0];
  assert.equal(actionsOf(edited.description), actionsOf(original.description));
  assert.ok(COMPACT_GROUPS.obsidian_edit.some((name) => actionsOf(edited.description).includes(name)));
  assert.ok(edited.description.endsWith("Choose action then supply its native params; credentials and Vault policy are checked per action."));
  assert.deepEqual(edited.inputSchema, original.inputSchema, "branch schemas are untouched");
  // Descriptions that carry no summary cannot be changed by an edit.
  const infoBefore = before.tools.find((tool) => tool.name === "obsidian_info");
  const infoAfter = after.tools.find((tool) => tool.name === "obsidian_info");
  assert.equal(infoAfter.description, infoBefore.description);
});

test("a canonical description edit does not silently rewrite a compact group", async () => {
  const native = await nativeTools();
  const before = compactToolView(native, [...TOOL_NAMES]);
  const edited = native.map((tool) =>
    tool.name === "get_note" ? { ...tool, description: `${tool.description} EXTRA` } : tool,
  );
  const after = compactToolView(edited, [...TOOL_NAMES]);
  assert.deepEqual(
    after.tools.map((tool) => tool.description),
    before.tools.map((tool) => tool.description),
  );
  // The reason it cannot: the group copy never reads a member's description.
  assert.notEqual(DESCRIPTIONS.get_note.description, "");
});
