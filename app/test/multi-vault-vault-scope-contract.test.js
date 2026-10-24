// Wave C — tool schema / contract surface (contract §7.3, §7.4, §18.1, §19, §28, §35).
//
// This file drives the real registration chain (`registerObsidianCapabilities`) through the real
// MCP SDK and compares the served `tools/list` with the frozen Wave 1 inventory in
// `docs/review/tool-discovery/inventory.json`. The inventory is historical evidence and is never
// rewritten: `tool-schema-compat.js` projects the canonical `vaultId` away (exact-match only, see
// `vaultScopeComparableInputSchema`) so every other byte stays protected.
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-scope-contract-"));
process.env.VAULT_PATH = path.join(ROOT, "vault");
process.env.DATA_PATH = path.join(ROOT, "data");
process.env.HISTORY_PATH = path.join(ROOT, "data", "history");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
await fs.mkdir(process.env.VAULT_PATH, { recursive: true });
await fs.mkdir(process.env.DATA_PATH, { recursive: true });

const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { TOOL_NAMES } = await import("../src/config.js");
const { discoveryPolicySummary, resolveDiscoveryView } = await import("../src/discovery-runtime.js");
const { MCP_TOOL_SCOPE_REQUIREMENTS } = await import("../src/scopes.js");
const { wave1ComparableInputSchema, wave1ComparableOutputSchema } = await import("../src/tool-schema-compat.js");
const { VAULT_ID_INPUT_SPEC, VAULT_SCOPED_TOOLS, GLOBAL_TOOLS } = await import("../src/vault-scope.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultScopeRegistrar } = await import("../src/vault-scope-registrar.js");

const INVENTORY_URL = new URL("../../docs/review/tool-discovery/inventory.json", import.meta.url);
// Wave C is the commit that makes the two Publish tools canonical; the inventory recorded their
// old local field, which is exactly what `vaultScopeComparableInputSchema` restores for comparison.
const PUBLISH_TOOLS = ["get_publish_status", "manage_publish"];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function schemaSha256(schema) {
  return createHash("sha256").update(JSON.stringify(canonicalize(schema)), "utf8").digest("hex");
}

async function runtimeTools() {
  const server = new McpServer({ name: "vault-scope-contract", version: "0.0.0" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "vault-scope-contract", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
    await server.close();
  }
}

test("tools/list keeps the canonical tool set, order and count (§7.4)", async () => {
  const tools = await runtimeTools();
  assert.equal(tools.length, TOOL_NAMES.length);
  assert.equal(tools.length, 91, "the multi-Vault wave must not add a select_vault tool; #470 wave A added start_direct_upload");
  // The served order is the registration order (module by module); the catalog order is
  // `TOOL_NAMES`. Both must describe the same set — the vault-scope registrar adds no tool.
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  assert.equal(new Set(tools.map((tool) => tool.name)).size, TOOL_NAMES.length);
});

test("every vault-scoped tool carries the canonical optional vaultId and globals carry none (§7.3)", async () => {
  const tools = await runtimeTools();
  const expected = {
    type: VAULT_ID_INPUT_SPEC.type,
    minLength: VAULT_ID_INPUT_SPEC.minLength,
    maxLength: VAULT_ID_INPUT_SPEC.maxLength,
    description: VAULT_ID_INPUT_SPEC.description,
  };
  const scoped = [];
  for (const tool of tools) {
    const property = tool.inputSchema?.properties?.vaultId;
    if (GLOBAL_TOOLS.includes(tool.name)) {
      assert.equal(property, undefined, `${tool.name} is global and must not carry vaultId`);
      continue;
    }
    assert.ok(property, `${tool.name} is vault-scoped and must carry vaultId`);
    assert.deepEqual(
      { type: property.type, minLength: property.minLength, maxLength: property.maxLength, description: property.description },
      expected,
      `${tool.name} vaultId must be the canonical spec`,
    );
    assert.equal((tool.inputSchema.required ?? []).includes("vaultId"), false, `${tool.name} vaultId must be optional`);
    scoped.push(tool.name);
  }
  assert.deepEqual(scoped.sort(), [...VAULT_SCOPED_TOOLS].sort());
  assert.equal(scoped.length, TOOL_NAMES.length - GLOBAL_TOOLS.length);
});

test("the two Publish tools are synonyms of the canonical vaultId, not a local fork (§7.3)", async () => {
  const tools = await runtimeTools();
  const reference = tools.find((tool) => tool.name === "list_notes").inputSchema.properties.vaultId;
  for (const name of PUBLISH_TOOLS) {
    const property = tools.find((tool) => tool.name === name).inputSchema.properties.vaultId;
    assert.deepEqual(
      property,
      reference,
      `${name} must inject the same canonical vaultId as every other scoped tool`,
    );
  }
});

test("no tool module hand-writes a vaultId any more (the registrar would fail closed)", () => {
  // `applyVaultIdSpec` is the fail-closed guard: it throws when a schema already declares the
  // field. Registering the whole catalog proves the two Publish locals are gone.
  const fake = { registerTool() {}, registerResource() {}, registerPrompt() {}, getClientVersion: () => ({ name: "", version: "" }) };
  assert.doesNotThrow(() => registerObsidianCapabilities(fake));
});

test("input/output schemas, annotations and titles still match the frozen Wave 1 inventory (§35)", async () => {
  const inventory = JSON.parse(await fs.readFile(INVENTORY_URL, "utf8"));
  const baselineByName = new Map(inventory.tools.map((tool) => [tool.name, tool]));
  const tools = await runtimeTools();
  for (const tool of tools) {
    const baseline = baselineByName.get(tool.name);
    if (!baseline) {
      assert.ok(["get_note_context", "list_base_views", "patch_base", "create_base_entry", "start_direct_upload"].includes(tool.name), `${tool.name} is neither historical nor an allowed additive tool`);
      continue;
    }
    assert.equal(
      schemaSha256(wave1ComparableInputSchema(tool.name, tool.inputSchema)),
      baseline.inputSchema.sha256,
      `${tool.name} inputSchema drifted`,
    );
    assert.equal(schemaSha256(wave1ComparableOutputSchema(tool.name, tool.outputSchema)), baseline.outputContract.sha256, `${tool.name} outputSchema drifted`);
    assert.deepEqual(tool.annotations, baseline.annotations, `${tool.name} annotations drifted`);
    assert.equal(tool.title, baseline.title, `${tool.name} title drifted`);
  }
});

test("scopes and discovery profiles are unchanged by the vault-scope injection (§35)", async () => {
  assert.deepEqual(Object.keys(MCP_TOOL_SCOPE_REQUIREMENTS).sort(), [...TOOL_NAMES].sort());
  const view = resolveDiscoveryView({ authDisabled: true });
  assert.deepEqual(view.toolNames, [...TOOL_NAMES], "the full profile must still expose the whole catalog");
  const summary = discoveryPolicySummary(view);
  assert.equal(summary.catalogToolCount, TOOL_NAMES.length);
  assert.equal(summary.visibleToolCount, TOOL_NAMES.length);
});

test("the Publish handlers take the selected vault from the registrar context, not from a local allowlist", async () => {
  // §43-4: no tool module may hold its own `allowedVaults` check, and §7.3 wants the local field gone.
  const source = await fs.readFile(new URL("../src/tools/publish.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /allowedVaults/, "tools/publish.js must not keep a second allowlist");
  assert.match(source, /requestContext\(\)\?\.vaultId/, "tools/publish.js must read the registrar's selection");

  const tools = new Map();
  const fake = {
    registerTool(name, config, handler) { tools.set(name, { config, handler }); },
    registerResource() {},
    registerPrompt() {},
    getClientVersion: () => ({ name: "", version: "" }),
  };
  createVaultScopeRegistrar(fake, { vaultExists: async () => true }).registerTool("get_publish_status", { inputSchema: {} }, () => "handler-ran");
  assert.ok(tools.get("get_publish_status").config.inputSchema.vaultId, "the registrar owns the injected field");
  const { registerPublishTools } = await import("../src/tools/publish.js");
  const publishTools = new Map();
  const publishRegistrar = createVaultScopeRegistrar(
    { registerTool(name, config, handler) { publishTools.set(name, { config, handler }); }, getClientVersion: () => ({ name: "", version: "" }) },
    { vaultExists: async () => true },
  );
  registerPublishTools(publishRegistrar);
  const denied = await publishTools.get("get_publish_status").handler({ path: "a.md", vaultId: "beta" }, { authInfo: { allowedVaults: ["alpha"] } });
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.structuredContent, { code: "vault_access_denied", vaultId: "beta" });
  assert.equal(DEFAULT_VAULT_ID, "default");
});
