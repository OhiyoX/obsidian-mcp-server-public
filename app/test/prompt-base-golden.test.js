// Prompt Base P0 Task 1: freeze the MCP-facing prompt contract before any of it
// moves into `app/prompts/base`.
//
// The fixture is generated once by `scripts/capture-prompt-baseline.mjs` and read
// only: every assertion below compares live wire output with that frozen text, so
// the migration in Tasks 3–5 cannot drift a byte without turning this suite red.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Isolate config module reads (Vault/DATA env) before importing source modules.
const TEST_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-prompt-golden-"));
process.env.VAULT_PATH = path.join(TEST_ROOT, "vault");
process.env.DATA_PATH = path.join(TEST_ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";

const { TOOL_NAMES } = await import("../src/config.js");
const { CAPABILITY_CATALOG } = await import("../src/capability-catalog.js");
const { COMPACT_GROUPS, compactToolView } = await import("../src/compact-tools.js");
const { compactDescriptorFingerprint } = await import("../src/compact-descriptor-integrity.js");
const { parseDiscoveryOperatorConfig } = await import("../src/discovery-config.js");
const { createDiscoveryRuntimePolicy } = await import("../src/discovery-runtime.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { createMemoryGuidanceRegistrar } = await import("../src/memory-guidance.js");
const { registerPrompts } = await import("../src/prompts.js");
const { AGENT_INSTRUCTIONS, getAgentBootstrap } = await import("../src/agent-bootstrap.js");

test.after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

const BASELINE = JSON.parse(await readFile(new URL("./fixtures/prompt-base-baseline.json", import.meta.url), "utf8"));

async function withClient(createServer, run) {
  const server = createServer();
  const client = new Client({ name: "prompt-golden", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function nativeServer() {
  const server = new McpServer({ name: "prompt-golden-native", version: "1" });
  registerObsidianCapabilities(server);
  return server;
}

function compactServer(config) {
  const server = new McpServer({ name: "prompt-golden-compact", version: "1" });
  const discovery = createDiscoveryRuntimePolicy(server, config, { authDisabled: true });
  registerObsidianCapabilities(discovery);
  discovery.install();
  return server;
}

test("the frozen baseline covers exactly the registered canonical catalog", () => {
  assert.deepEqual(Object.keys(BASELINE.canonical).sort(), [...TOOL_NAMES].sort());
  assert.deepEqual(BASELINE.toolNames, [...TOOL_NAMES]);
});

test("canonical tools/list reproduces the frozen titles and descriptions", async () => {
  const wire = await withClient(nativeServer, async (client) => {
    const { tools } = await client.listTools();
    return JSON.parse(JSON.stringify(tools));
  });

  const live = {};
  for (const tool of wire) live[tool.name] = { title: tool.title ?? null, description: tool.description ?? null };
  assert.deepEqual(live, BASELINE.canonical);
});

test("compact projection reproduces the frozen descriptors, branches and fingerprint", async () => {
  const config = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "compact" });
  assert.equal(config.profile, "compact");

  const wire = await withClient(() => compactServer(config), async (client) => {
    const { tools } = await client.listTools();
    return JSON.parse(JSON.stringify(tools));
  });

  assert.deepEqual(
    wire.map((tool) => ({ name: tool.name, description: tool.description ?? null })),
    BASELINE.compact.descriptors,
  );
  assert.equal(wire.reduce((sum, tool) => sum + (tool.inputSchema?.oneOf?.length ?? 0), 0), BASELINE.compact.branches);
  assert.equal(compactDescriptorFingerprint(wire), BASELINE.compact.fingerprint);
  assert.deepEqual(Object.keys(COMPACT_GROUPS), BASELINE.compact.groups);

  // Scope-restricted representative: the same builder, driven by the read-only catalog slice.
  const readNames = new Set(
    CAPABILITY_CATALOG.filter((entry) => entry.scope.every((scope) => scope === "obsidian.read")).map((entry) => entry.name),
  );
  const native = await withClient(nativeServer, async (client) => {
    const { tools } = await client.listTools();
    return JSON.parse(JSON.stringify(tools));
  });
  const scoped = compactToolView(native, [...readNames]);
  assert.deepEqual(scoped.tools.map((tool) => tool.name), BASELINE.compact.scoped.names);
  assert.equal(compactDescriptorFingerprint(scoped.tools), BASELINE.compact.scoped.fingerprint);
});

test("memory guidance keeps its exact suffixes and three reminder texts", async () => {
  function probe() {
    const tools = new Map();
    const server = { registerTool: (name, config, handler) => tools.set(name, { config, handler }) };
    const registrar = createMemoryGuidanceRegistrar(server, { repeatAfterReads: 2 });
    registrar.registerTool("agent_bootstrap", { description: "RAW-BOOTSTRAP" }, async () => ({ content: [] }));
    registrar.registerTool("search_notes", { description: "RAW-READ" }, async () => ({ content: [] }));
    registrar.registerTool("write_note", { description: "RAW-WRITE" }, async () => ({ content: [] }));
    return tools;
  }
  const texts = (result) => result.content.at(-1)?.text ?? "";

  const cold = probe();
  assert.equal(cold.get("search_notes").config.description, `RAW-READ${BASELINE.memory.readHint}`);
  assert.equal(cold.get("write_note").config.description, `RAW-WRITE${BASELINE.memory.writeHint}`);
  assert.equal(texts(await cold.get("search_notes").handler()), BASELINE.memory.firstRead);

  const warm = probe();
  await warm.get("agent_bootstrap").handler();
  const reminders = [texts(await warm.get("search_notes").handler()), texts(await warm.get("search_notes").handler())];
  assert.deepEqual(reminders, ["", BASELINE.memory.checkpoint], "checkpoint lands on the read after the throttled one");

  const write = probe();
  assert.equal(texts(await write.get("write_note").handler()), BASELINE.memory.afterWrite);
});

test("agent_bootstrap returns the frozen contract", () => {
  // Design §7.1 adds two report fields; every frozen string below stays byte-identical.
  const actual = JSON.parse(JSON.stringify(getAgentBootstrap({ client: "prompt-baseline", project: "" })));
  assert.deepEqual(actual, { ...BASELINE.bootstrap, promptRevision: 0, promptSource: "base" });
});

test("MCP prompts and initialize instructions keep their frozen copy", async () => {
  // See capture-prompt-baseline.mjs: the copy is frozen from `registerPrompts` on a
  // bare server; the capability chain's reachability is a separate contract.
  const prompts = await withClient(() => {
    const server = new McpServer({ name: "prompt-golden-prompts", version: "1" });
    registerPrompts(server);
    return server;
  }, async (client) => {
    const listed = await client.listPrompts();
    const research = listed.prompts.find((prompt) => prompt.name === "research_brief");
    const got = await client.getPrompt({ name: "research_brief", arguments: { topic: "golden topic" } });
    return {
      list: JSON.parse(JSON.stringify(listed.prompts)),
      researchBrief: {
        title: research?.title ?? null,
        description: research?.description ?? null,
        body: got.messages[0]?.content?.text ?? null,
      },
    };
  });
  assert.deepEqual(prompts, BASELINE.prompts);

  const instructions = await withClient(
    () => new McpServer({ name: "prompt-golden-instructions", version: "1" }, { instructions: AGENT_INSTRUCTIONS }),
    async (client) => client.getInstructions() ?? "",
  );
  assert.equal(instructions, BASELINE.initializeInstructions);
});
