// Issue #626 gate: every compact descriptor must expose exactly the actions of
// its group (both directions), and the served schema must be reconcilable.
//
// The suite drives the real MCP protocol (SDK client over InMemoryTransport
// against the discovery runtime that server.js installs), never a hand-built
// descriptor, and every assertion has an injected-drift negative control.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Isolate config module reads (Vault/DATA env) before importing source modules.
const TEST_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-compact-integrity-"));
process.env.VAULT_PATH = path.join(TEST_ROOT, "vault");
process.env.DATA_PATH = path.join(TEST_ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";

const { TOOL_NAMES } = await import("../src/config.js");
const { COMPACT_GROUPS, compactToolView } = await import("../src/compact-tools.js");
const {
  checkCompactDescriptorIntegrity,
  compactDescriptorBranchTotal,
  compactDescriptorFingerprint,
} = await import("../src/compact-descriptor-integrity.js");
const { parseDiscoveryOperatorConfig } = await import("../src/discovery-config.js");
const { createDiscoveryRuntimePolicy } = await import("../src/discovery-runtime.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");

test.after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

const COMPACT_CONFIG = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "compact" });
const DENIED_CONFIG = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "compact", MCP_DISCOVERY_DENY_TOOLS: "list_base_views" });
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

async function withClient(createServer, run) {
  const server = createServer();
  const client = new Client({ name: "compact-integrity-client", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

// The native (unwrapped) inventory: the exact descriptors the compact builder
// must partition, and the source of the routing Map used by the checker.
async function nativeInventory() {
  return withClient(() => {
    const server = new McpServer({ name: "compact-integrity-native", version: "1" });
    registerObsidianCapabilities(server);
    return server;
  }, async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, TOOL_NAMES.length);
    return tools;
  });
}

// The compact wire: the discovery runtime that server.js installs, plus the
// server_info payload the same identity receives.
async function compactWire(config = COMPACT_CONFIG) {
  return withClient(() => {
    const server = new McpServer({ name: "compact-integrity-compact", version: "1" });
    const discovery = createDiscoveryRuntimePolicy(server, config, { authDisabled: true });
    registerObsidianCapabilities(discovery);
    discovery.install();
    return server;
  }, async (client) => {
    const { tools } = await client.listTools();
    const info = await client.callTool({ name: "server_info", arguments: {} });
    assert.equal(info.isError, undefined);
    // Round-trip through JSON so the checker sees wire shapes, not live objects.
    return { tools: JSON.parse(JSON.stringify(tools)), discovery: info.structuredContent.discovery };
  });
}

const NATIVE_TOOLS = await nativeInventory();
const { tools: EXPECTED_COMPACT, routing: ROUTING } = compactToolView(NATIVE_TOOLS, TOOL_NAMES);
const WIRE = await compactWire();

function branchesOf(tool) {
  return tool.inputSchema.oneOf.map((branch) => branch.properties.action.const);
}

function renameAction(tool, from, to) {
  const clone = JSON.parse(JSON.stringify(tool));
  for (const branch of clone.inputSchema.oneOf) {
    if (branch.properties.action.const === from) branch.properties.action.const = to;
  }
  clone.inputSchema.properties.action.enum = clone.inputSchema.properties.action.enum.map((value) => (value === from ? to : value));
  return clone;
}

test("the compact wire is the builder output for the live native catalog", () => {
  assert.equal(COMPACT_CONFIG.profile, "compact");
  assert.deepEqual(WIRE.tools, EXPECTED_COMPACT, "tools/list must be exactly compactToolView(native, allowed)");
});

test("every compact descriptor exposes exactly its group members, in both directions", () => {
  const reading = checkCompactDescriptorIntegrity({ tools: WIRE.tools, routing: ROUTING });
  assert.equal(reading.ok, true, reading.errors.join("\n"));
  assert.equal(reading.equations.length, Object.keys(COMPACT_GROUPS).length);
  assert.equal(reading.exposedTotal, TOOL_NAMES.length);
  assert.equal(reading.memberTotal, TOOL_NAMES.length);
  assert.equal(WIRE.tools.length, 34);
  assert.equal(compactDescriptorBranchTotal(WIRE.tools), TOOL_NAMES.length);

  // #626 regression: the reported group must carry the newest read action, and
  // the group is partitioned by annotation/Scope signature, so the equation is
  // per descriptor and only the sum is per group.
  const read = reading.equations.find((entry) => entry.domain === "obsidian_read");
  assert.equal(read.groupMembers, 7);
  assert.equal(read.exposedActions, 7);
  assert.equal(read.ok, true);
  assert.deepEqual([...read.descriptors].sort(), ["obsidian_read_read", "obsidian_read_read_external"]);

  const readTool = WIRE.tools.find((tool) => tool.name === "obsidian_read_read");
  assert.equal(readTool.inputSchema.oneOf.length, 6);
  assert.deepEqual(readTool.inputSchema.properties.action.enum, branchesOf(readTool));
  assert.ok(readTool.inputSchema.properties.action.enum.includes("list_base_views"), "#626: list_base_views must be in action.enum");

  const externalTool = WIRE.tools.find((tool) => tool.name === "obsidian_read_read_external");
  assert.deepEqual(branchesOf(externalTool), ["get_note_context"]);
});

test("a stale snapshot that lost one branch is rejected and named", () => {
  // The exact #626 symptom: a Host caches an obsidian_read_read enum from before
  // list_base_views existed.
  const stale = WIRE.tools.map((tool) => {
    if (tool.name !== "obsidian_read_read") return tool;
    const clone = JSON.parse(JSON.stringify(tool));
    clone.inputSchema.oneOf = clone.inputSchema.oneOf.filter((branch) => branch.properties.action.const !== "list_base_views");
    clone.inputSchema.properties.action.enum = clone.inputSchema.properties.action.enum.filter((value) => value !== "list_base_views");
    return clone;
  });

  const reading = checkCompactDescriptorIntegrity({ tools: stale, routing: ROUTING });
  assert.equal(reading.ok, false);
  assert.ok(reading.errors.some((error) => /list_base_views/.test(error)), reading.errors.join("\n"));
  assert.equal(compactDescriptorBranchTotal(stale), TOOL_NAMES.length - 1);
});

test("dropping one group member is rejected, so the gate is not vacuous", () => {
  const driftedGroups = { ...COMPACT_GROUPS, obsidian_read: COMPACT_GROUPS.obsidian_read.filter((name) => name !== "list_base_views") };
  const reading = checkCompactDescriptorIntegrity({ tools: WIRE.tools, routing: ROUTING, groups: driftedGroups });
  assert.equal(reading.ok, false);
  assert.ok(reading.errors.some((error) => /obsidian_read.*members=6 exposedActions=7/.test(error)), reading.errors.join("\n"));
  assert.ok(reading.errors.some((error) => /exposed action total=91 but group membership total=90/.test(error)), reading.errors.join("\n"));
});

test("renaming one action without touching the mapping is rejected", () => {
  const tampered = WIRE.tools.map((tool) => (tool.name === "obsidian_read_read" ? renameAction(tool, "list_base_views", "list_base_views_v2") : tool));
  const reading = checkCompactDescriptorIntegrity({ tools: tampered, routing: ROUTING });
  assert.equal(reading.ok, false);
  assert.ok(reading.errors.some((error) => /list_base_views_v2 is not a routed member/.test(error)), reading.errors.join("\n"));
  assert.ok(reading.errors.some((error) => /routed member list_base_views has no oneOf branch/.test(error)), reading.errors.join("\n"));
});

test("the schema fingerprint is stable, format-bounded, and membership-sensitive", () => {
  const first = compactDescriptorFingerprint(WIRE.tools);
  const second = compactDescriptorFingerprint(WIRE.tools);
  assert.match(first, FINGERPRINT_PATTERN);
  assert.equal(first, second, "the same descriptor set must fingerprint identically");
  assert.equal(first, compactDescriptorFingerprint(EXPECTED_COMPACT), "key order must not change the fingerprint");

  const renamed = WIRE.tools.map((tool) => (tool.name === "obsidian_read_read" ? renameAction(tool, "list_base_views", "list_base_views_v2") : tool));
  assert.notEqual(compactDescriptorFingerprint(renamed), first, "one renamed member must change the fingerprint");

  const stale = WIRE.tools.filter((tool) => tool.name !== "obsidian_read_read_external");
  assert.notEqual(compactDescriptorFingerprint(stale), first, "one dropped descriptor must change the fingerprint");
});

test("server_info reports the fingerprint of the schema it serves", () => {
  assert.equal(WIRE.discovery.profile, "compact");
  assert.equal(WIRE.discovery.compactSchemaFingerprint, compactDescriptorFingerprint(WIRE.tools));
  assert.match(WIRE.discovery.compactSchemaFingerprint, FINGERPRINT_PATTERN);
  // A Host that only caches tools/list can reproduce this value locally.
  assert.equal(WIRE.discovery.compactSchemaFingerprint, compactDescriptorFingerprint(EXPECTED_COMPACT));
});

test("an operator denyTools entry can produce the same 5-branch shape from the server side", () => {
  // Layer separation (#626): the reported symptom is also reachable through the
  // transport/policy layer, so the fingerprint alone must not be read as "the
  // Host is stale" — the caller's hiddenBy* / canonicalVisibleToolCount reading
  // is the discriminator.
  return compactWire(DENIED_CONFIG).then((denied) => {
    const readTool = denied.tools.find((tool) => tool.name === "obsidian_read_read");
    assert.equal(denied.tools.length, 34);
    assert.deepEqual(branchesOf(readTool), ["get_note", "get_metadata", "get_canvas", "get_base", "query_base"]);
    assert.deepEqual(readTool.inputSchema.properties.action.enum, branchesOf(readTool));
    assert.equal(denied.discovery.canonicalVisibleToolCount, TOOL_NAMES.length - 1);
    assert.equal(denied.discovery.hiddenByPolicy, 1);
    assert.equal(denied.discovery.hiddenByScope, 0);
    assert.notEqual(denied.discovery.compactSchemaFingerprint, compactDescriptorFingerprint(WIRE.tools));
    // The untrimmed reading is what rules the policy layer out on production.
    assert.equal(WIRE.discovery.canonicalVisibleToolCount, TOOL_NAMES.length);
    assert.equal(WIRE.discovery.hiddenByPolicy, 0);
  });
});
