// Focused parity tests for the static Capability Catalog
// (app/src/capability-catalog.js). Read-only characterization: these tests
// never call a tool, never touch the Vault, and never change registration.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_CATALOG_BY_NAME,
  CAPABILITY_CATALOG_FIELD_SOURCES,
  CAPABILITY_CATALOG_GAPS,
  CAPABILITY_CATALOG_SCHEMA_VERSION,
  CAPABILITY_CATALOG_TOOL_COUNT,
  EAGER_VISIBILITY,
  TOOLSET_MODULES,
  TOOLSET_TOOLS,
  catalogEntry,
  toolsetForTool,
} from "../src/capability-catalog.js";
import { registerObsidianCapabilities } from "../src/capabilities.js";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";
import { completeToolAnnotations, hasDeclaredToolContract, outputSchemaForTool } from "../src/tool-contracts.js";
import { hasWave1InputSchemaWidening, wave1ComparableInputSchema, wave1ComparableOutputSchema } from "../src/tool-schema-compat.js";
import { registerFileTools } from "../src/tools/files.js";
import { registerGitTools } from "../src/tools/git.js";
import { registerInfoTools } from "../src/tools/info.js";
import { registerIntelligenceTools } from "../src/tools/intelligence.js";
import { registerContextTools } from "../src/tools/context.js";
import { registerLinkTools } from "../src/tools/links.js";
import { registerNoteTools } from "../src/tools/notes.js";
import { registerPlanTools } from "../src/tools/plans.js";
import { registerPublishTools } from "../src/tools/publish.js";
import { registerSearchTools } from "../src/tools/search.js";
import { registerWorkflowTools } from "../src/tools/workflows.js";

// Same order as app/src/capabilities.js registerObsidianCapabilities.
const REGISTRARS = [
  ["info", registerInfoTools],
  ["notes", registerNoteTools],
  ["search", registerSearchTools],
  ["files", registerFileTools],
  ["links", registerLinkTools],
  ["workflows", registerWorkflowTools],
  ["git", registerGitTools],
  ["intelligence", registerIntelligenceTools],
  ["context", registerContextTools],
  ["publish", registerPublishTools],
  ["plans", registerPlanTools],
];

const INVENTORY_URL = new URL("../../docs/review/tool-discovery/inventory.json", import.meta.url);

function captureRegistrations() {
  const toolsetByTool = new Map();
  const order = [];
  for (const [toolset, registrar] of REGISTRARS) {
    registrar({
      registerTool(name) {
        assert.equal(toolsetByTool.has(name), false, `tool ${name} registered by multiple modules`);
        toolsetByTool.set(name, toolset);
        order.push(name);
      },
    });
  }
  return { toolsetByTool, order };
}

async function captureRuntimeTools() {
  const server = new McpServer({ name: "capability-catalog-test", version: "0.0.0" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "capability-catalog-test", version: "0.0.0" });
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

test("catalog version and count are declared", () => {
  assert.equal(CAPABILITY_CATALOG_SCHEMA_VERSION, 1);
  assert.equal(CAPABILITY_CATALOG_TOOL_COUNT, TOOL_NAMES.length);
});

test("catalog covers every TOOL_NAMES entry exactly once, in TOOL_NAMES order", () => {
  assert.equal(CAPABILITY_CATALOG.length, TOOL_NAMES.length);
  assert.equal(new Set(CAPABILITY_CATALOG.map((entry) => entry.name)).size, TOOL_NAMES.length);
  assert.deepEqual(CAPABILITY_CATALOG.map((entry) => entry.name), TOOL_NAMES);
  for (const name of TOOL_NAMES) assert.equal(catalogEntry(name), CAPABILITY_CATALOG_BY_NAME[name]);
});

test("toolset assignment is exactly the source registration module mapping", () => {
  const { toolsetByTool, order } = captureRegistrations();
  assert.equal(order.length, TOOL_NAMES.length);
  assert.deepEqual([...toolsetByTool.keys()].sort(), [...TOOL_NAMES].sort());
  for (const entry of CAPABILITY_CATALOG) {
    assert.equal(entry.toolset, toolsetByTool.get(entry.name), `${entry.name} toolset mismatch`);
    assert.ok(Object.hasOwn(TOOLSET_MODULES, entry.toolset), `${entry.name} has unknown toolset`);
    assert.equal(toolsetForTool(entry.name), entry.toolset);
  }
  // TOOLSET_TOOLS is the same partition as the source registrars.
  const fromCatalog = new Map();
  for (const [toolset, tools] of Object.entries(TOOLSET_TOOLS)) {
    for (const name of tools) fromCatalog.set(name, toolset);
  }
  assert.deepEqual([...fromCatalog.entries()].sort(), [...toolsetByTool.entries()].sort());
});

test("catalog scope matches scopes.js MCP_TOOL_SCOPE_REQUIREMENTS", () => {
  assert.deepEqual(
    Object.keys(MCP_TOOL_SCOPE_REQUIREMENTS).sort(),
    TOOL_NAMES.slice().sort(),
  );
  for (const entry of CAPABILITY_CATALOG) {
    assert.deepEqual(entry.scope, MCP_TOOL_SCOPE_REQUIREMENTS[entry.name], `${entry.name} scope mismatch`);
  }
});

test("relatedTools are same-toolset siblings, symmetric, and TOOL_NAMES-ordered", () => {
  const index = new Map(TOOL_NAMES.map((name, i) => [name, i]));
  for (const entry of CAPABILITY_CATALOG) {
    assert.equal(entry.relatedTools.includes(entry.name), false, `${entry.name} lists itself as related`);
    const expected = TOOLSET_TOOLS[entry.toolset]
      .filter((name) => name !== entry.name)
      .sort((a, b) => index.get(a) - index.get(b));
    assert.deepEqual(entry.relatedTools, expected, `${entry.name} relatedTools mismatch`);
    for (const related of entry.relatedTools) {
      assert.equal(catalogEntry(related).toolset, entry.toolset);
      assert.ok(catalogEntry(related).relatedTools.includes(entry.name), `${entry.name}/${related} not symmetric`);
    }
  }
});

test("visibility is eager for every tool; aliases/domain/intents stay explicit gaps", () => {
  const gapFields = CAPABILITY_CATALOG_GAPS.map((gap) => gap.field);
  assert.ok(gapFields.includes("domain"));
  assert.ok(gapFields.includes("intents"));
  for (const gap of CAPABILITY_CATALOG_GAPS) {
    assert.equal(gap.status, "unverified");
    assert.equal(typeof gap.reason, "string");
  }
  assert.match(CAPABILITY_CATALOG_FIELD_SOURCES.visibility, /unconditionally/);
  assert.match(CAPABILITY_CATALOG_FIELD_SOURCES.relatedTools, /structural/);

  const expectedKeys = ["aliases", "domain", "intents", "name", "relatedTools", "scope", "toolset", "visibility"];
  for (const entry of CAPABILITY_CATALOG) {
    assert.equal(entry.visibility, EAGER_VISIBILITY, `${entry.name} visibility changed`);
    assert.deepEqual(entry.aliases, []);
    assert.deepEqual(entry.intents, []);
    assert.equal(entry.domain, null);
    // No dynamic visible-view / defer / activation fields are introduced.
    assert.deepEqual(Object.keys(entry).sort(), expectedKeys, `${entry.name} exposes unexpected metadata`);
  }
});

test("every catalog tool has a declared output contract", () => {
  for (const entry of CAPABILITY_CATALOG) {
    assert.equal(hasDeclaredToolContract(entry.name), true, `${entry.name} has no declared contract`);
    assert.equal(typeof outputSchemaForTool(entry.name)?.shape, "object", `${entry.name} has no output schema`);
  }
});

test("Wave 1 schema compatibility rules are narrow and observable on the live catalog", async () => {
  const runtime = await captureRuntimeTools();
  const byName = new Map(runtime.map((tool) => [tool.name, tool]));
  const expected = [
    "compare_note_versions",
    "plan_delete_note",
    "plan_move_note",
    "plan_note_changes",
    "plan_restore_from_trash",
    "plan_restore_version",
  ];
  assert.deepEqual(
    runtime.filter((tool) => hasWave1InputSchemaWidening(tool.name, tool.inputSchema)).map((tool) => tool.name).sort(),
    expected,
  );

  const sample = byName.get("plan_note_changes");
  const drifted = structuredClone(sample.inputSchema);
  drifted.properties.maxDiffChars.maximum = 499999;
  assert.notEqual(
    schemaSha256(wave1ComparableInputSchema(sample.name, drifted)),
    schemaSha256(wave1ComparableInputSchema(sample.name, sample.inputSchema)),
    "compatibility normalization must not hide unrelated schema drift",
  );
});

test("runtime tools/list names, order, schema, and annotations are unchanged", async () => {
  const { order } = captureRegistrations();
  const runtime = await captureRuntimeTools();
  const inventory = JSON.parse(await readFile(INVENTORY_URL, "utf8"));
  const inventoryByName = new Map(inventory.tools.map((tool) => [tool.name, tool]));
  const runtimeByName = new Map(runtime.map((tool) => [tool.name, tool]));

  assert.deepEqual(runtime.map((tool) => tool.name), order, "tools/list registration order changed");
  assert.deepEqual(runtime.map((tool) => tool.name).sort(), TOOL_NAMES.slice().sort());

  // Additive context descriptor: historical Wave 1 descriptors stay byte-for-byte
  // identical; only the explicitly listed new tool may be absent from the baseline.
  const additiveTools = new Set(["get_note_context", "list_base_views", "patch_base", "create_base_entry"]);
  for (const tool of inventory.tools) {
    assert.ok(runtimeByName.has(tool.name), `runtime catalog removed historical tool ${tool.name}`);
  }

  for (const tool of runtime) {
    const entry = catalogEntry(tool.name);
    assert.ok(entry, `${tool.name} missing from capability catalog`);
    const baseline = inventoryByName.get(tool.name);
    if (!baseline) {
      assert.ok(additiveTools.has(tool.name), `${tool.name} is not a historical tool and is not an allowed additive tool`);
      continue;
    }

    const comparableInputSchema = wave1ComparableInputSchema(tool.name, tool.inputSchema);
    assert.equal(schemaSha256(comparableInputSchema), baseline.inputSchema.sha256, `${tool.name} inputSchema changed beyond an allowed widening`);
    assert.equal(schemaSha256(wave1ComparableOutputSchema(tool.name, tool.outputSchema)), baseline.outputContract.sha256, `${tool.name} outputSchema changed`);
    assert.deepEqual(tool.annotations, baseline.annotations, `${tool.name} annotations changed`);
    assert.deepEqual(completeToolAnnotations(tool.annotations), tool.annotations, `${tool.name} annotations not completed`);
    assert.equal(tool.title, baseline.title, `${tool.name} title changed`);
    // Scope is authorization truth, not wire-visible: it must come from the catalog/source.
    assert.deepEqual(entry.scope, MCP_TOOL_SCOPE_REQUIREMENTS[tool.name]);
  }
});
