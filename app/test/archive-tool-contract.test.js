// A3 (issue #254) — archive tool contract characterization.
//
// Scope of this file (read-only, no Vault access, no tool invocation, no writes):
//   1. the three existing ZIP tools (create_archive / inspect_archive /
//      extract_archive) keep their frozen literal output shape, scope,
//      annotations, capability-catalog placement and runtime/inventory
//      fingerprints — these must stay green forever;
//   2. the new read_archive_entry tool is characterized by *literal* frozen
//      expectations that stay explicitly PENDING (loud diagnostic, never a
//      silent pass) until the B+C registry PR lands the tool.
//
// Every expectation below is a literal value transcribed from the frozen
// contract note
//   _Workspace/40-Projects/obsidian_mcp_server/MCP/DEVELOPMENT - Issue 254 read_archive_entry 只读单条目读取.md
// (+ scratch/issue-254/CONTRACT-NOTE.md). None of it is derived from the
// implementation tables, so this file fails when the implementation drifts
// away from the contract instead of silently re-freezing the new behaviour.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_CATALOG_TOOL_COUNT,
  TOOLSET_TOOLS,
  catalogEntry,
} from "../src/capability-catalog.js";
import { registerObsidianCapabilities } from "../src/capabilities.js";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";
import { hasWave1InputSchemaWidening, vaultScopeComparableInputSchema } from "../src/tool-schema-compat.js";
import { completeToolAnnotations, outputSchemaForTool } from "../src/tool-contracts.js";
import { registerFileTools } from "../src/tools/files.js";

// ---------------------------------------------------------------------------
// Literal contract (transcribed, not derived)
// ---------------------------------------------------------------------------

const EXISTING_ARCHIVE_TOOLS = Object.freeze(["create_archive", "inspect_archive", "extract_archive"]);

const ARCHIVE_LIST_REQUIRED = Object.freeze([
  "path", "format", "entries", "entryCount", "fileCount",
  "compressedBytes", "uncompressedBytes", "sha256", "revision",
]);

const EXISTING_ARCHIVE_REQUIRED = Object.freeze({
  create_archive: ARCHIVE_LIST_REQUIRED,
  inspect_archive: ARCHIVE_LIST_REQUIRED,
  extract_archive: Object.freeze([
    "archivePath", "destinationDirectory", "dryRun", "collisions", "outputs",
  ]),
});

const EXISTING_ARCHIVE_OPTIONAL = Object.freeze({
  create_archive: Object.freeze([]),
  inspect_archive: Object.freeze([]),
  extract_archive: Object.freeze([
    "entryCount", "fileCount", "compressedBytes", "uncompressedBytes",
    "extracted", "format", "entries",
  ]),
});

const EXISTING_ARCHIVE_SCOPES = Object.freeze({
  create_archive: Object.freeze(["obsidian.read", "obsidian.write", "obsidian.files"]),
  inspect_archive: Object.freeze(["obsidian.read", "obsidian.files"]),
  extract_archive: Object.freeze(["obsidian.read", "obsidian.write", "obsidian.files"]),
});

const EXISTING_ARCHIVE_ANNOTATIONS = Object.freeze({
  inspect_archive: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  create_archive: Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }),
  extract_archive: Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }),
});

const NEW_TOOL = "read_archive_entry";

const NEW_TOOL_REQUIRED = Object.freeze([
  "archivePath", "entry", "path", "size", "compressedSize", "encoding",
  "truncated", "returnedBytes", "sha256", "crc32", "archiveSha256", "archiveRevision",
]);

// `content` is present but never required: binary entries omit it entirely.
const NEW_TOOL_OPTIONAL = Object.freeze(["content"]);

const NEW_TOOL_SCOPE = Object.freeze(["obsidian.read", "obsidian.files"]);

const NEW_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

// Frozen scalar contract for every declared field of read_archive_entry.
const NEW_TOOL_FIELD_TYPES = Object.freeze({
  archivePath: "string",
  entry: "string",
  path: "string",
  size: "number",
  compressedSize: "number",
  encoding: "enum:text|binary",
  truncated: "boolean",
  returnedBytes: "number",
  sha256: "string",
  crc32: "string",
  archiveSha256: "string",
  archiveRevision: "string",
});

// ---------------------------------------------------------------------------
// Helpers (canonicalize / fingerprints mirror capability-catalog.test.js)
// ---------------------------------------------------------------------------

const INVENTORY_URL = new URL("../../docs/review/tool-discovery/inventory.json", import.meta.url);

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

function captureFileRegistrations() {
  const order = [];
  const configs = new Map();
  registerFileTools({
    registerTool(name, config) {
      assert.equal(configs.has(name), false, `tool ${name} registered twice by tools/files.js`);
      order.push(name);
      configs.set(name, config);
    },
  });
  return { order, configs };
}

async function captureRuntimeTools() {
  const server = new McpServer({ name: "archive-tool-contract-test", version: "0.0.0" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "archive-tool-contract-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

function sortedEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

// JSON-Schema view of a declared output contract (the same projection the MCP
// server performs for tools/list).
function objectContractJson(schema) {
  const json = z.toJSONSchema(schema);
  return { required: json.required ?? [], properties: json.properties ?? {} };
}

function jsonSchemaType(property) {
  if (!property || typeof property !== "object") return "missing";
  if (Array.isArray(property.enum)) return `enum:${property.enum.join("|")}`;
  if (typeof property.type === "string") return property.type;
  if (Array.isArray(property.type)) return `union:${property.type.join("|")}`;
  if (Array.isArray(property.anyOf)) return `anyOf:${property.anyOf.map((part) => part?.type).join("|")}`;
  return "untyped";
}

// ---------------------------------------------------------------------------
// read_archive_entry assertion body (pure; reused by the PENDING test and by
// the reverse-control test so we can prove it really executes).
// ---------------------------------------------------------------------------

function checkReadArchiveEntryContract(observed) {
  const problems = [];
  const fail = (condition, message) => { if (!condition) problems.push(message); };
  const {
    toolNames,
    fileRegistrationOrder,
    filesToolsetOrder,
    scope,
    catalogToolset,
    catalogScope,
    annotations,
    outputSchema,
  } = observed;

  fail(Array.isArray(toolNames) && toolNames.includes(NEW_TOOL), `TOOL_NAMES must include ${NEW_TOOL}`);
  const inspectIndex = Array.isArray(toolNames) ? toolNames.indexOf("inspect_archive") : -1;
  fail(inspectIndex >= 0 && toolNames[inspectIndex + 1] === NEW_TOOL, `TOOL_NAMES must register ${NEW_TOOL} immediately after inspect_archive`);
  fail(inspectIndex >= 0 && toolNames[inspectIndex + 2] === "extract_archive", `TOOL_NAMES must keep extract_archive immediately after ${NEW_TOOL}`);

  fail(
    Array.isArray(fileRegistrationOrder) && Array.isArray(filesToolsetOrder)
      && JSON.stringify(fileRegistrationOrder) === JSON.stringify(filesToolsetOrder),
    `tools/files.js registerTool order must equal TOOLSET_TOOLS.files with ${NEW_TOOL} in place`,
  );

  fail(sortedEqual(scope, NEW_TOOL_SCOPE), `MCP_TOOL_SCOPE_REQUIREMENTS.${NEW_TOOL} must be exactly ${JSON.stringify(NEW_TOOL_SCOPE)}`);
  fail(Array.isArray(scope) && scope.includes("obsidian.write") === false, `${NEW_TOOL} must not require obsidian.write`);

  fail(catalogToolset === "files", `catalogEntry(${NEW_TOOL}).toolset must be "files"`);
  fail(sortedEqual(catalogScope, NEW_TOOL_SCOPE), `catalogEntry(${NEW_TOOL}).scope must be exactly ${JSON.stringify(NEW_TOOL_SCOPE)}`);
  fail(
    Array.isArray(catalogScope) && JSON.stringify(catalogScope.slice(1)) === JSON.stringify(["obsidian.files"]),
    `TOOL_EXTRA_SCOPES form for ${NEW_TOOL} must be ["obsidian.files"]`,
  );

  for (const [key, expected] of Object.entries(NEW_TOOL_ANNOTATIONS)) {
    fail(annotations?.[key] === expected, `${NEW_TOOL} annotation ${key} must be ${expected}, got ${String(annotations?.[key])}`);
  }
  fail(
    annotations !== null && typeof annotations === "object" && Object.keys(annotations).length === Object.keys(NEW_TOOL_ANNOTATIONS).length,
    `${NEW_TOOL} must declare exactly the frozen annotations object`,
  );

  const required = outputSchema?.required;
  const properties = outputSchema?.properties;
  fail(sortedEqual(required, NEW_TOOL_REQUIRED), `outputSchemaForTool(${NEW_TOOL}) required must be exactly ${JSON.stringify(NEW_TOOL_REQUIRED)}`);
  fail(Array.isArray(required) && required.includes("content") === false, `${NEW_TOOL}.content must be optional`);
  fail(Boolean(properties) && Object.hasOwn(properties, "content"), `${NEW_TOOL} outputSchema must declare content`);
  if (properties) {
    fail(
      sortedEqual(Object.keys(properties), [...NEW_TOOL_REQUIRED, ...NEW_TOOL_OPTIONAL]),
      `outputSchemaForTool(${NEW_TOOL}) properties must be exactly required + ${JSON.stringify(NEW_TOOL_OPTIONAL)}`,
    );
    for (const [field, expected] of Object.entries(NEW_TOOL_FIELD_TYPES)) {
      const actual = jsonSchemaType(properties[field]);
      fail(actual === expected, `${NEW_TOOL}.${field} must be ${expected}, got ${actual}`);
    }
  }
  return problems;
}

// A fully conforming synthetic observation ("tool is present" input), used to
// prove the assertion body executes and rejects each individual drift.
function syntheticReadArchiveEntryObservation() {
  const properties = { content: {} };
  for (const field of NEW_TOOL_REQUIRED) {
    const expected = NEW_TOOL_FIELD_TYPES[field];
    properties[field] = expected === "enum:text|binary"
      ? { type: "string", enum: ["text", "binary"] }
      : { type: expected };
  }
  const filesOrder = ["list_files", "create_archive", "inspect_archive", NEW_TOOL, "extract_archive"];
  return {
    toolNames: ["get_note", ...filesOrder],
    fileRegistrationOrder: [...filesOrder],
    filesToolsetOrder: [...filesOrder],
    scope: [...NEW_TOOL_SCOPE],
    catalogToolset: "files",
    catalogScope: [...NEW_TOOL_SCOPE],
    annotations: { ...NEW_TOOL_ANNOTATIONS },
    outputSchema: { required: [...NEW_TOOL_REQUIRED], properties },
  };
}

// ---------------------------------------------------------------------------
// 1. Existing three tools — BASE-green and must stay green
// ---------------------------------------------------------------------------

test("existing archive tools keep their exact literal output contract", () => {
  for (const name of EXISTING_ARCHIVE_TOOLS) {
    const { required, properties } = objectContractJson(outputSchemaForTool(name));
    assert.deepEqual(
      required.slice().sort(),
      EXISTING_ARCHIVE_REQUIRED[name].slice().sort(),
      `${name} required fields drifted`,
    );
    assert.deepEqual(
      Object.keys(properties).sort(),
      [...EXISTING_ARCHIVE_REQUIRED[name], ...EXISTING_ARCHIVE_OPTIONAL[name]].sort(),
      `${name} declared property set drifted`,
    );
    for (const optional of EXISTING_ARCHIVE_OPTIONAL[name]) {
      assert.equal(required.includes(optional), false, `${name}.${optional} must stay optional`);
    }
  }
});

test("existing archive tools keep their exact literal scope, annotations and catalog placement", () => {
  const { order, configs } = captureFileRegistrations();
  assert.deepEqual(order, TOOLSET_TOOLS.files, "tools/files.js registerTool order drifted");
  for (const name of EXISTING_ARCHIVE_TOOLS) {
    assert.deepEqual(MCP_TOOL_SCOPE_REQUIREMENTS[name], EXISTING_ARCHIVE_SCOPES[name], `${name} scope drifted`);
    const registered = configs.get(name);
    assert.ok(registered, `${name} is not registered by tools/files.js`);
    assert.deepEqual(
      completeToolAnnotations(registered.annotations),
      EXISTING_ARCHIVE_ANNOTATIONS[name],
      `${name} completed annotations drifted`,
    );
    const entry = catalogEntry(name);
    assert.ok(entry, `${name} missing from the capability catalog`);
    assert.equal(entry.toolset, "files", `${name} toolset drifted`);
    assert.deepEqual(entry.scope, EXISTING_ARCHIVE_SCOPES[name], `${name} catalog scope drifted`);
  }
});

test("existing archive tools match the frozen tool-discovery inventory fingerprints", async () => {
  const inventory = JSON.parse(await readFile(INVENTORY_URL, "utf8"));
  const inventoryByName = new Map(inventory.tools.map((tool) => [tool.name, tool]));
  const runtime = await captureRuntimeTools();
  const runtimeByName = new Map(runtime.map((tool) => [tool.name, tool]));

  for (const name of EXISTING_ARCHIVE_TOOLS) {
    const baseline = inventoryByName.get(name);
    const tool = runtimeByName.get(name);
    assert.ok(baseline, `${name} is missing from docs/review/tool-discovery/inventory.json`);
    assert.ok(tool, `${name} is missing from runtime tools/list`);
    // No Wave 1 widening rule may be used to soften these three contracts.
    assert.equal(hasWave1InputSchemaWidening(name, tool.inputSchema), false, `${name} must not rely on a compatibility widening`);
    // Wave C (contract §7.3) added the canonical optional `vaultId` to every vault-scoped tool; the
    // projection removes only that exact field (see tool-schema-compat.js), so the historical
    // inventory fingerprint still guards every other byte.
    assert.equal(schemaSha256(vaultScopeComparableInputSchema(name, tool.inputSchema)), baseline.inputSchema.sha256, `${name} inputSchema drifted`);
    assert.equal(schemaSha256(tool.outputSchema), baseline.outputContract.sha256, `${name} outputSchema drifted`);
    assert.deepEqual(tool.annotations, baseline.annotations, `${name} annotations drifted`);
    assert.equal(tool.title, baseline.title, `${name} title drifted`);
  }
});

test("tool registry integrity: TOOL_NAMES is duplicate-free and the catalog has full parity", () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, "TOOL_NAMES contains a duplicate name");
  assert.equal(CAPABILITY_CATALOG.length, TOOL_NAMES.length, "capability catalog length must equal TOOL_NAMES length");
  assert.equal(CAPABILITY_CATALOG_TOOL_COUNT, TOOL_NAMES.length, "declared catalog count must equal TOOL_NAMES length");
  assert.deepEqual(CAPABILITY_CATALOG.map((entry) => entry.name), TOOL_NAMES, "catalog order must equal TOOL_NAMES order");
});

// ---------------------------------------------------------------------------
// 2. New tool — literal expectations, PENDING until B+C lands
// ---------------------------------------------------------------------------

test("read_archive_entry public contract (activates when B+C lands)", async (t) => {
  const hasTool = TOOL_NAMES.includes(NEW_TOOL);
  if (!hasTool) {
    t.diagnostic(`PENDING: ${NEW_TOOL} not yet registered (activates when B+C lands)`);
    // The PENDING premise itself is asserted: absence is the only allowed state
    // here, so this branch can never turn into a silent pass once the tool lands.
    assert.equal(hasTool, false);
    return;
  }

  const { order, configs } = captureFileRegistrations();
  const runtime = await captureRuntimeTools();
  const runtimeTool = runtime.find((tool) => tool.name === NEW_TOOL);
  const entry = catalogEntry(NEW_TOOL);

  const observed = {
    toolNames: TOOL_NAMES,
    fileRegistrationOrder: order,
    filesToolsetOrder: TOOLSET_TOOLS.files,
    scope: MCP_TOOL_SCOPE_REQUIREMENTS[NEW_TOOL],
    catalogToolset: entry?.toolset ?? null,
    catalogScope: entry?.scope ?? null,
    annotations: runtimeTool?.annotations
      ?? (configs.get(NEW_TOOL) ? completeToolAnnotations(configs.get(NEW_TOOL).annotations) : null),
    outputSchema: objectContractJson(outputSchemaForTool(NEW_TOOL)),
  };
  assert.deepEqual(checkReadArchiveEntryContract(observed), [], "read_archive_entry contract drifted");

  // Wire-level freeze: runtime tools/list must agree with the literal contract
  // and with the regenerated canonical inventory.
  assert.ok(runtimeTool, `${NEW_TOOL} must be exposed in runtime tools/list`);
  assert.deepEqual(
    (runtimeTool.outputSchema?.required ?? []).slice().sort(),
    NEW_TOOL_REQUIRED.slice().sort(),
    `${NEW_TOOL} runtime outputSchema.required drifted`,
  );
  assert.equal(jsonSchemaType(runtimeTool.outputSchema?.properties?.size), "number", `${NEW_TOOL}.size must be number on the wire`);
  assert.equal(jsonSchemaType(runtimeTool.outputSchema?.properties?.returnedBytes), "number", `${NEW_TOOL}.returnedBytes must be number on the wire`);
  assert.equal(jsonSchemaType(runtimeTool.outputSchema?.properties?.truncated), "boolean", `${NEW_TOOL}.truncated must be boolean on the wire`);
  assert.equal(jsonSchemaType(runtimeTool.outputSchema?.properties?.encoding), "enum:text|binary", `${NEW_TOOL}.encoding must be a text|binary enum on the wire`);

  const inventory = JSON.parse(await readFile(INVENTORY_URL, "utf8"));
  const baseline = inventory.tools.find((tool) => tool.name === NEW_TOOL);
  assert.ok(baseline, `docs/review/tool-discovery/inventory.json must contain ${NEW_TOOL} after C regenerates canonical artifacts`);
  assert.equal(hasWave1InputSchemaWidening(NEW_TOOL, runtimeTool.inputSchema), false, `${NEW_TOOL} must not rely on a compatibility widening`);
  assert.equal(schemaSha256(vaultScopeComparableInputSchema(NEW_TOOL, runtimeTool.inputSchema)), baseline.inputSchema.sha256, `${NEW_TOOL} inputSchema fingerprint drifted`);
  assert.equal(schemaSha256(runtimeTool.outputSchema), baseline.outputContract.sha256, `${NEW_TOOL} outputSchema fingerprint drifted`);
  assert.deepEqual(runtimeTool.annotations, baseline.annotations, `${NEW_TOOL} annotations fingerprint drifted`);
  assert.equal(runtimeTool.title, baseline.title, `${NEW_TOOL} title fingerprint drifted`);
});

test("reverse control: the read_archive_entry assertion body executes and rejects every frozen-field drift", () => {
  const base = syntheticReadArchiveEntryObservation();
  assert.deepEqual(checkReadArchiveEntryContract(base), [], "the synthetic conforming observation must be accepted");

  const mutations = [
    ["missing tool name", (o) => { o.toolNames = o.toolNames.filter((name) => name !== NEW_TOOL); }, "TOOL_NAMES must include"],
    ["wrong TOOL_NAMES position", (o) => { o.toolNames = ["get_note", "create_archive", "inspect_archive", "extract_archive", NEW_TOOL]; }, "immediately after inspect_archive"],
    ["wrong registration position", (o) => { o.fileRegistrationOrder = ["list_files", "create_archive", "inspect_archive", "extract_archive", NEW_TOOL]; }, "registerTool order must equal TOOLSET_TOOLS.files"],
    ["scope gains obsidian.write", (o) => { o.scope = ["obsidian.read", "obsidian.write", "obsidian.files"]; }, "must be exactly"],
    ["scope loses obsidian.files", (o) => { o.scope = ["obsidian.read"]; }, "must be exactly"],
    ["catalog scope keeps write", (o) => { o.catalogScope = ["obsidian.read", "obsidian.write", "obsidian.files"]; }, "TOOL_EXTRA_SCOPES form"],
    ["wrong catalog toolset", (o) => { o.catalogToolset = "notes"; }, "toolset must be \"files\""],
    ["annotations claim non-idempotent", (o) => { o.annotations = { ...o.annotations, idempotentHint: false }; }, "annotation idempotentHint must be true"],
    ["annotations claim destructive", (o) => { o.annotations = { ...o.annotations, destructiveHint: true }; }, "annotation destructiveHint must be false"],
    ["required field removed", (o) => { o.outputSchema.required = o.outputSchema.required.filter((field) => field !== "returnedBytes"); delete o.outputSchema.properties.returnedBytes; }, "required must be exactly"],
    ["content became required", (o) => { o.outputSchema.required = [...o.outputSchema.required, "content"]; }, "content must be optional"],
    ["size typed as string", (o) => { o.outputSchema.properties.size = { type: "string" }; }, "size must be number"],
    ["returnedBytes typed as string", (o) => { o.outputSchema.properties.returnedBytes = { type: "string" }; }, "returnedBytes must be number"],
    ["encoding enum narrowed", (o) => { o.outputSchema.properties.encoding = { type: "string", enum: ["text"] }; }, "encoding must be enum:text|binary"],
    ["path became nullable", (o) => { o.outputSchema.properties.path = { type: ["string", "null"] }; }, "path must be string"],
    ["undeclared extra property", (o) => { o.outputSchema.properties.preview = {}; }, "properties must be exactly"],
  ];

  for (const [label, mutate, expected] of mutations) {
    const observed = structuredClone(base);
    mutate(observed);
    const problems = checkReadArchiveEntryContract(observed);
    assert.ok(problems.length > 0, `reverse control "${label}" must be rejected`);
    assert.ok(
      problems.some((problem) => problem.includes(expected)),
      `reverse control "${label}" must report "${expected}", got ${JSON.stringify(problems)}`,
    );
  }
});
