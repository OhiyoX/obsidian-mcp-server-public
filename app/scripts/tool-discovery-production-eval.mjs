#!/usr/bin/env node
// Progressive Tool Discovery — Wave 2 production parity + eager real-run harness.
//
// Two read-only jobs:
//   1. capture the *deployed* MCP `tools/list` and compare it, field by field, with
//      the Wave 1 local inventory (name / inputSchema / annotations / outputSchema);
//   2. reuse the Wave 1 50 task fixtures and issue real `tools/call` probes for every
//      read-only-annotated tool, then score what the eager catalog actually reached.
//
// Hard boundaries: only tools the deployed server annotates `readOnlyHint: true` are
// ever invoked; write/destructive tools are never called. Payload bodies are never
// stored or printed, only outcome classes and byte counts. The API key is read from
// an environment variable and is never emitted. Missing host/credentials produce an
// explicit `blocked` result — nothing is fabricated.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerObsidianCapabilities } from "../src/capabilities.js";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";
import { hasWave1InputSchemaWidening, wave1ComparableInputSchema, wave1ComparableOutputSchema } from "../src/tool-schema-compat.js";
import {
  DEFAULT_FIXTURE_PATH,
  loadFixtures,
  validateFixtures,
} from "./tool-discovery-eager.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(SCRIPT_DIR, "..");
export const REPO_DIR = path.resolve(APP_DIR, "..");
export const DEFAULT_INVENTORY_PATH = path.join(REPO_DIR, "docs", "review", "tool-discovery", "inventory.json");
export const DEFAULT_OUT_DIR = path.join(REPO_DIR, "docs", "review", "tool-discovery", "wave2-production");
export const DEFAULT_API_KEY_ENV = "OBSIDIAN_MCP_API_KEY";
export const DEFAULT_URL_ENV = "OBSIDIAN_MCP_URL";
export const PARITY_JSON = "production-parity.json";
export const PARITY_MD = "production-parity.md";
export const EAGER_RUN_JSON = "eager-run.json";
export const EAGER_RUN_MD = "eager-run.md";
export const BASELINE_COMMIT = "fc926a5d853888072c60454a2fffaa86cbe78b33";

const AUTHOR = "app/scripts/tool-discovery-production-eval.mjs";
const UTF8 = new TextEncoder();

// --- canonical JSON + digests (same method as scripts/tool-inventory.mjs) -------

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function canonicalJsonText(value) {
  return JSON.stringify(canonicalize(value));
}

export function byteLength(value) {
  return UTF8.encode(typeof value === "string" ? value : canonicalJsonText(value)).length;
}

export function digestJson(value) {
  const text = canonicalJsonText(value);
  return {
    bytes: byteLength(text),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

function sortedByName(items) {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function histogram(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

// --- Streamable HTTP transport ---------------------------------------------------

export function parseMcpResponseBody(text, contentType = "") {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  const looksSse = /text\/event-stream/i.test(contentType) || /^(event|data):/m.test(trimmed);
  if (looksSse) {
    const data = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(trimmed);
}

export class McpHttpClient {
  constructor({ url, apiKey, apiKeyHeader = "X-API-Key", fetchImpl = globalThis.fetch, timeoutMs = 60000 }) {
    this.url = url;
    this.apiKey = apiKey;
    this.apiKeyHeader = apiKeyHeader;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
  }

  headers() {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.apiKey) headers[this.apiKeyHeader] = this.apiKey;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  async #post(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const session = response.headers.get("mcp-session-id");
      if (session) this.sessionId = session;
      const text = await response.text();
      if (!response.ok) {
        return { kind: "http_error", status: response.status, bodyBytes: byteLength(text) };
      }
      return { kind: "message", message: parseMcpResponseBody(text, response.headers.get("content-type") || "") };
    } catch (error) {
      return { kind: "transport_error", code: error?.name === "AbortError" ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  async connect() {
    const result = await this.#post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tool-discovery-production-eval", version: "1.0.0" },
      },
    });
    if (result.kind !== "message") return { ok: false, ...result };
    const initialized = result.message?.result;
    if (!initialized) return { ok: false, kind: "invalid_initialize" };
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return {
      ok: true,
      protocolVersion: initialized.protocolVersion,
      serverInfo: initialized.serverInfo,
    };
  }

  async listTools() {
    const result = await this.#post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    if (result.kind !== "message") return { ok: false, ...result };
    if (result.message?.error) return { ok: false, kind: "rpc_error", error: result.message.error };
    const tools = result.message?.result?.tools;
    if (!Array.isArray(tools)) return { ok: false, kind: "invalid_tools_list" };
    return { ok: true, tools };
  }

  async callTool(name, args, id = 0) {
    const result = await this.#post({
      jsonrpc: "2.0",
      id: 1000 + id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (result.kind !== "message") return result;
    const message = result.message;
    if (message?.error) return { kind: "rpc_error", error: message.error };
    if (!message?.result) return { kind: "invalid_result" };
    return { kind: "result", result: message.result };
  }
}

// --- outcome classification ------------------------------------------------------

const DENIED_PATTERN = /denied|forbidden|unauthori[sz]ed|insufficient[ _-]?scope|permission|not allowed/i;

export function classifyToolCall(response) {
  if (response?.kind === "http_error") return { outcome: "transport_error", reason: `http_${response.status}` };
  if (response?.kind === "transport_error") return { outcome: "transport_error", reason: response.code || "network" };
  if (response?.kind === "rpc_error") {
    const code = response.error?.code;
    const message = response.error?.message || "";
    if (code === -32602) return { outcome: "invalid_arguments", reason: "jsonrpc_-32602" };
    if (code === -32601) return { outcome: "unknown_tool", reason: "jsonrpc_-32601" };
    if (DENIED_PATTERN.test(message)) return { outcome: "denied", reason: "authorization" };
    return { outcome: "rpc_error", reason: `jsonrpc_${code ?? "unknown"}` };
  }
  if (response?.kind !== "result") return { outcome: "protocol_error", reason: response?.kind || "unknown" };
  const result = response.result;
  if (result?.isError) {
    const text = (result.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text || "")
      .join("\n");
    if (/MCP error -32602:\s*Output validation error/i.test(text)) {
      return { outcome: "output_contract_violation", reason: "output_validation" };
    }
    if (/MCP error -32602/.test(text)) return { outcome: "invalid_arguments", reason: "input_validation" };
    if (DENIED_PATTERN.test(text)) return { outcome: "denied", reason: "authorization" };
    if (/exceeding maxBytes|use get_file base64 chunks/i.test(text)) {
      return { outcome: "tool_error", reason: "payload_exceeds_probe_budget" };
    }
    return { outcome: "tool_error", reason: "tool_reported_error" };
  }
  return { outcome: "success", reason: null };
}

export function resultPayloadBytes(response) {
  if (response?.kind !== "result") return 0;
  try {
    return byteLength(JSON.stringify(response.result));
  } catch {
    return 0;
  }
}

// --- production vs Wave 1 inventory parity ---------------------------------------

export function compareToolCatalog({ productionTools, inventory, expectedToolNames = TOOL_NAMES }) {
  const inventoryTools = Array.isArray(inventory?.tools) ? inventory.tools : [];
  const inventoryByName = new Map(inventoryTools.map((tool) => [tool.name, tool]));
  const productionByName = new Map(productionTools.map((tool) => [tool.name, tool]));
  const expected = expectedToolNames.map((name) => name);

  const missingFromProduction = expected.filter((name) => !productionByName.has(name)).sort();
  const extraInProduction = [...productionByName.keys()].filter((name) => !expected.includes(name)).sort();
  const missingFromInventory = expected.filter((name) => !inventoryByName.has(name)).sort();
  // Historical Wave 1 descriptors are frozen. A newer working tree may add tools,
  // but must never drop or rename a tool that the inventory already recorded.
  const inventoryMissingFromProduction = inventoryTools
    .filter((tool) => !productionByName.has(tool.name))
    .map((tool) => tool.name)
    .sort();

  const inputSchemaMismatches = [];
  const compatibleInputSchemaWidenings = [];
  const outputSchemaMismatches = [];
  const compatibleOutputSchemaWidenings = [];
  const annotationMismatches = [];
  const titleMismatches = [];
  let compared = 0;
  let metaBearingTools = 0;
  const metaDigests = new Set();
  const totals = { inputSchemaBytes: 0, outputSchemaBytes: 0, descriptorBytes: 0 };

  for (const name of [...expected].sort()) {
    const production = productionByName.get(name);
    if (!production) continue;
    compared += 1;
    const input = digestJson(production.inputSchema ?? {});
    const comparableInput = digestJson(wave1ComparableInputSchema(name, production.inputSchema ?? {}));
    // Output contracts get the same treatment as input schemas: a *declared* additive
    // property (`WAVE1_INPUT_SCHEMA_ADDITIONS`, e.g. `get_base.revision`, the CAS token
    // `patch_base.ifMatch` consumes) is projected away before the byte comparison, so the
    // frozen Wave 1 inventory stays the baseline. Anything undeclared — or a declared spec
    // that drifted from the frozen one — still fails; `wave1ComparableOutputSchema` throws
    // rather than silently accepting a different shape.
    const outputSchema = production.outputSchema ?? {};
    const output = digestJson(wave1ComparableOutputSchema(name, outputSchema));
    totals.inputSchemaBytes += input.bytes;
    totals.outputSchemaBytes += output.bytes;
    totals.descriptorBytes += byteLength(JSON.stringify(production));
    if (production._meta && Object.keys(production._meta).length) {
      metaBearingTools += 1;
      metaDigests.add(canonicalJsonText(production._meta));
    }
    const baseline = inventoryByName.get(name);
    if (!baseline) continue;
    if (comparableInput.sha256 !== baseline.inputSchema?.sha256 || comparableInput.bytes !== baseline.inputSchema?.bytes) {
      inputSchemaMismatches.push(name);
    } else if (hasWave1InputSchemaWidening(name, production.inputSchema ?? {})) {
      compatibleInputSchemaWidenings.push(name);
    }
    if (output.sha256 !== baseline.outputContract?.sha256 || output.bytes !== baseline.outputContract?.bytes) {
      outputSchemaMismatches.push(name);
    } else if (digestJson(outputSchema).sha256 !== output.sha256) {
      compatibleOutputSchemaWidenings.push(name);
    }
    if (canonicalJsonText(production.annotations ?? {}) !== canonicalJsonText(baseline.annotations ?? {})) {
      annotationMismatches.push(name);
    }
    if ((production.title ?? "") !== (baseline.title ?? "")) titleMismatches.push(name);
  }

  const annotations = { readOnlyHint: 0, destructiveHint: 0, idempotentHint: 0, openWorldHint: 0 };
  const risk = { readOnly: 0, destructive: 0, mutating: 0 };
  const scopeHistogram = new Map();
  for (const tool of productionTools) {
    for (const key of Object.keys(annotations)) if (tool.annotations?.[key] === true) annotations[key] += 1;
    if (tool.annotations?.readOnlyHint === true) risk.readOnly += 1;
    else if (tool.annotations?.destructiveHint === true) risk.destructive += 1;
    else risk.mutating += 1;
    const scopes = MCP_TOOL_SCOPE_REQUIREMENTS[tool.name] || [];
    scopeHistogram.set(scopes.join("+"), (scopeHistogram.get(scopes.join("+")) || 0) + 1);
  }

  const inventoryTotals = inventory?.totals || {};
  return {
    wireToolCount: productionTools.length,
    expectedToolCount: expected.length,
    inventoryToolCount: inventoryTools.length,
    nameSetMatchesExpected: missingFromProduction.length === 0 && extraInProduction.length === 0,
    nameSetMatchesInventory:
      inventoryTools.length === productionTools.length &&
      inventoryTools.every((tool) => productionByName.has(tool.name)),
    missingFromProduction,
    extraInProduction,
    missingFromInventory,
    inventoryMissingFromProduction,
    compared,
    inputSchemaMismatches,
    compatibleInputSchemaWidenings,
    compatibleOutputSchemaWidenings,
    outputSchemaMismatches,
    annotationMismatches,
    titleMismatches,
    allSchemasMatch: inputSchemaMismatches.length === 0 && outputSchemaMismatches.length === 0 && compared === expected.length,
    annotations: histogram(Object.entries(annotations).flatMap(([key, count]) => Array(count).fill(key))),
    annotationCensus: annotations,
    risk,
    scopeHistogram: Object.fromEntries([...scopeHistogram.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    meta: { toolsWithMeta: metaBearingTools, distinctMetaValues: metaDigests.size },
    totals: {
      production: totals,
      inventory: {
        inputSchemaBytes: inventoryTotals.inputSchemaBytes ?? null,
        outputSchemaBytes: inventoryTotals.outputSchemaBytes ?? null,
      },
      inputSchemaBytesMatch: totals.inputSchemaBytes === (inventoryTotals.inputSchemaBytes ?? totals.inputSchemaBytes),
      outputSchemaBytesMatch: totals.outputSchemaBytes === (inventoryTotals.outputSchemaBytes ?? totals.outputSchemaBytes),
    },
  };
}

// --- read-only probe plan ---------------------------------------------------------

// Read-only tools that are deliberately NOT invoked because the probe itself would
// create or require durable server-side state.
export const STATEFUL_READ_TOOLS = new Map([
  ["file_upload_status", "requires_upload_id_stateful"],
  ["get_note_plan", "requires_plan_id_stateful"],
  ["plan_note_changes", "creates_plan_stateful"],
  ["plan_move_note", "creates_plan_stateful"],
  ["plan_delete_note", "creates_plan_stateful"],
  ["plan_restore_version", "creates_plan_stateful"],
  ["plan_restore_from_trash", "creates_plan_stateful"],
]);

const NOTE_PATH = (context) => context?.sampleNotePath;

// name -> (context) => candidate args. The builder drops keys the deployed inputSchema
// does not declare, and refuses to probe when a required property cannot be satisfied.
export const PROBE_RECIPES = new Map([
  ["agent_bootstrap", () => ({ client: "tool-discovery-production-eval", model: "deterministic-probe", project: "wave2-prod-parity" })],
  ["server_info", () => ({})],
  ["get_note", (c) => ({ path: NOTE_PATH(c) })],
  ["get_metadata", (c) => ({ path: NOTE_PATH(c) })],
  ["get_file", (c) => ({ path: NOTE_PATH(c), encoding: "auto" })],
  ["pull_file", (c) => ({ path: NOTE_PATH(c), maxBytes: 1048576 })],
  ["pull_note_file", (c) => ({ path: NOTE_PATH(c), encoding: "text", maxBytes: 1048576 })],
  ["get_backlinks", (c) => ({ path: NOTE_PATH(c) })],
  ["find_related", (c) => ({ path: NOTE_PATH(c), limit: 3 })],
  ["suggest_links", (c) => ({ path: NOTE_PATH(c), limit: 3 })],
  ["list_versions", (c) => ({ path: NOTE_PATH(c), limit: 2 })],
  ["get_publish_status", (c) => ({ path: NOTE_PATH(c) })],
  ["get_note_version", (c) => ({ versionId: c?.sampleVersionId, maxChars: 2000 })],
  ["compare_note_versions", (c) => ({
    left: { kind: "current", path: NOTE_PATH(c) },
    right: { kind: "candidate", path: NOTE_PATH(c), content: "" },
    maxDiffChars: 2000,
  })],
  ["get_base", (c) => ({ path: c?.sampleBasePath })],
  ["query_base", (c) => ({ path: c?.sampleBasePath, limit: 3 })],
  ["get_canvas", (c) => ({ path: c?.sampleCanvasPath })],
  ["inspect_archive", (c) => ({ path: c?.sampleArchivePath })],
  ["skill_validate", (c) => ({ path: c?.sampleSkillPath })],
  ["skill_list", () => ({ limit: 3 })],
  ["skill_match", () => ({ query: "note", limit: 3 })],
  ["memory_recall", () => ({ query: "obsidian", limit: 3 })],
  ["recall", () => ({ query: "obsidian", limit: 3 })],
  ["search_notes", () => ({ query: "obsidian", limit: 3 })],
  ["list_notes", () => ({ limit: 3 })],
  ["list_files", () => ({ limit: 3 })],
  ["list_recent", () => ({ limit: 3 })],
  ["list_tags", () => ({})],
  ["list_tasks", () => ({ limit: 3 })],
  ["list_properties", () => ({})],
  ["list_aliases", () => ({ limit: 3 })],
  ["list_templates", () => ({ limit: 3 })],
  ["list_bases", () => ({ limit: 3 })],
  ["list_trash", () => ({ limit: 3 })],
  ["get_graph", () => ({ limit: 3 })],
  ["get_orphans", () => ({ limit: 3 })],
  ["get_deadends", () => ({ limit: 3 })],
  ["get_unresolved_links", () => ({ limit: 3 })],
  ["graph_health", () => ({ limit: 3, includeDetails: true })],
  ["git_status", () => ({})],
  ["git_diff", (c) => ({ path: NOTE_PATH(c), maxChars: 1000 })],
  ["git_log", () => ({ limit: 3 })],
  ["index_status", () => ({ checkRemote: false })],
]);

export function buildProbePlan({ catalog, context = {} }) {
  const probes = [];
  for (const tool of sortedByName(catalog)) {
    const entry = { tool: tool.name, readOnly: tool.annotations?.readOnlyHint === true };
    if (!entry.readOnly) {
      probes.push({ ...entry, probe: false, reason: "not_read_only" });
      continue;
    }
    if (STATEFUL_READ_TOOLS.has(tool.name)) {
      probes.push({ ...entry, probe: false, reason: STATEFUL_READ_TOOLS.get(tool.name) });
      continue;
    }
    const recipe = PROBE_RECIPES.get(tool.name);
    if (!recipe) {
      probes.push({ ...entry, probe: false, reason: "no_probe_recipe" });
      continue;
    }
    let candidate;
    try {
      candidate = recipe(context);
    } catch {
      probes.push({ ...entry, probe: false, reason: "recipe_error" });
      continue;
    }
    const missingContext = Object.entries(candidate)
      .filter(([, value]) => value === undefined || value === null)
      .map(([key]) => key);
    if (missingContext.length) {
      probes.push({ ...entry, probe: false, reason: `missing_context:${missingContext.join("+")}` });
      continue;
    }
    const properties = tool.inputSchema?.properties || {};
    const args = Object.fromEntries(Object.entries(candidate).filter(([key]) => Object.hasOwn(properties, key)));
    const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
    const unsatisfied = required.filter((key) => !Object.hasOwn(args, key));
    if (unsatisfied.length) {
      probes.push({ ...entry, probe: false, reason: `missing_required:${unsatisfied.join("+")}` });
      continue;
    }
    probes.push({ ...entry, probe: true, args });
  }
  return probes;
}

// --- run helpers ------------------------------------------------------------------

function readFirst(nodes, ...keys) {
  for (const node of nodes || []) {
    for (const key of keys) {
      if (node && typeof node[key] === "string" && node[key]) return node[key];
    }
  }
  return undefined;
}

export async function collectProbeContext(client) {
  const availability = {};
  const context = {};
  let calls = 0;
  const call = async (name, args) => {
    calls += 1;
    const response = await client.callTool(name, args, calls);
    return response?.kind === "result" && !response.result?.isError ? response.result?.structuredContent : undefined;
  };

  const recent = await call("list_recent", { limit: 1 });
  context.sampleNotePath = readFirst(recent?.notes, "path");
  availability.sampleNotePath = Boolean(context.sampleNotePath);

  if (context.sampleNotePath) {
    const versions = await call("list_versions", { path: context.sampleNotePath, limit: 1 });
    context.sampleVersionId = readFirst(versions?.versions, "versionId");
  }
  availability.sampleVersionId = Boolean(context.sampleVersionId);

  const bases = await call("list_bases", { limit: 1 });
  context.sampleBasePath = readFirst(bases?.bases, "path");
  availability.sampleBasePath = Boolean(context.sampleBasePath);

  const skills = await call("skill_list", { limit: 1 });
  context.sampleSkillPath = readFirst(skills?.skills, "path");
  availability.sampleSkillPath = Boolean(context.sampleSkillPath);

  const canvases = await call("list_files", { nameRegex: "\\.canvas$", limit: 1 });
  context.sampleCanvasPath = readFirst(canvases?.entries, "path");
  availability.sampleCanvasPath = Boolean(context.sampleCanvasPath);

  const archives = await call("list_files", { nameRegex: "\\.zip$", limit: 1 });
  context.sampleArchivePath = readFirst(archives?.entries, "path");
  availability.sampleArchivePath = Boolean(context.sampleArchivePath);

  return { context, availability, calls };
}

export async function runProbes(client, plan) {
  const results = {};
  let id = 0;
  for (const probe of plan) {
    if (!probe.readOnly) continue;
    if (!probe.probe) {
      results[probe.tool] = { outcome: "not_probed", reason: probe.reason };
      continue;
    }
    id += 1;
    const response = await client.callTool(probe.tool, probe.args, 100 + id);
    results[probe.tool] = { ...classifyToolCall(response), resultBytes: resultPayloadBytes(response) };
  }
  return { results, calls: id };
}

// --- fixture scoring --------------------------------------------------------------

export function evaluateFixtures({ tasks, catalog, probeResults, inventory }) {
  const catalogByName = new Map(catalog.map((tool) => [tool.name, tool]));
  const inventoryByName = new Map((inventory?.tools || []).map((tool) => [tool.name, tool]));
  const rows = [];

  for (const task of tasks) {
    const expected = task.expectedTools || [];
    const detail = expected.map((name) => {
      const tool = catalogByName.get(name);
      const probes = probeResults?.[name];
      let state;
      if (!tool) state = "absent";
      else if (tool.annotations?.readOnlyHint !== true) state = "safety_skipped";
      else if (!probes || probes.outcome === "not_probed") state = "unprobed";
      else if (probes.outcome === "success") state = "verified";
      else state = "failed";
      return { tool: name, state, probeReason: probes?.reason ?? null, outcome: probes?.outcome ?? "not_probed" };
    });

    const absent = detail.filter((item) => item.state === "absent");
    const failed = detail.filter((item) => item.state === "failed");
    const unprobed = detail.filter((item) => item.state === "unprobed");
    const safetySkipped = detail.filter((item) => item.state === "safety_skipped");
    let status;
    if (absent.length || failed.length) status = "failed";
    else if (safetySkipped.length) status = "blocked_safety";
    else if (unprobed.length) status = "blocked_harness";
    else status = "ready";

    const schemaCostBytes = expected.reduce((sum, name) => sum + (inventoryByName.get(name)?.inputSchema?.bytes || 0), 0);
    rows.push({
      taskId: task.taskId,
      category: task.category,
      language: task.language,
      status,
      expectedTools: expected,
      expectedPresent: detail.every((item) => item.state !== "absent"),
      verified: detail.filter((item) => item.state === "verified").map((item) => item.tool),
      failed: failed.map((item) => ({ tool: item.tool, reason: item.probeReason, outcome: item.outcome })),
      unprobed: unprobed.map((item) => ({ tool: item.tool, reason: item.probeReason })),
      safetySkipped: safetySkipped.map((item) => item.tool),
      schemaCostBytes,
    });
  }

  const statusHistogram = histogram(rows.map((row) => row.status));
  const failureReasons = histogram([
    ...rows.flatMap((row) => row.failed.map((item) => `failed:${item.tool}:${item.reason || "unknown"}`)),
    ...rows.flatMap((row) => row.unprobed.map((item) => `unprobed:${item.tool}:${item.reason || "unknown"}`)),
    ...rows.flatMap((row) => row.safetySkipped.map((tool) => `safety_skipped:${tool}`)),
  ]);

  return {
    count: rows.length,
    statusHistogram,
    failureReasons,
    readyRate: rows.length ? rows.filter((row) => row.status === "ready").length / rows.length : 0,
    reachableRate: rows.length ? rows.filter((row) => row.expectedPresent).length / rows.length : 0,
    perTask: rows,
  };
}

export function summarizeProbes(plan, probeResults) {
  const readOnly = plan.filter((probe) => probe.readOnly);
  const writeOrDestructive = plan.filter((probe) => !probe.readOnly);
  const readOnlyProbed = readOnly.filter((probe) => probe.probe);
  const readOnlyNotProbed = readOnly.filter((probe) => !probe.probe);
  const notProbedReasons = histogram(readOnlyNotProbed.map((probe) => `${probe.tool}:${probe.reason}`));
  const outcomes = histogram(Object.values(probeResults).map((result) => result.outcome));
  const invoked = Object.values(probeResults).filter((result) => result.outcome !== "not_probed");
  const successes = invoked.filter((result) => result.outcome === "success");
  return {
    readOnlyTools: readOnly.length,
    readOnlyProbedTools: readOnlyProbed.length,
    readOnlyNotProbedTools: readOnlyNotProbed.length,
    writeOrDestructiveToolsExcluded: writeOrDestructive.length,
    notProbedReasons,
    invokedCalls: invoked.length,
    outcomes,
    successRate: invoked.length ? successes.length / invoked.length : null,
    resultBytes: invoked.reduce((sum, result) => sum + (result.resultBytes || 0), 0),
  };
}

// --- endpoint redaction -----------------------------------------------------------

const PRIVATE_IPV4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

// Credential-looking query parameters and URL userinfo. Used only to assert that no
// raw endpoint ever reaches a committed artifact.
export const CREDENTIAL_URL_PATTERN = /[?&](?:access[_-]?token|api[_-]?key|token|password|passwd|secret|signature|sig|auth)=/i;
export const URL_USERINFO_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;

export function classifyEndpointNetwork(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return "unknown";
  if (host === "::1" || host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host)) return "loopback";
  if (/^169\.254\./.test(host) || /^fe80:/i.test(host)) return "link-local";
  if (PRIVATE_IPV4.some((pattern) => pattern.test(host)) || /^f[cd][0-9a-f]{2}:/i.test(host)) return "private";
  return "public";
}

// Redact an MCP endpoint into a stable category. Never returns the host, userinfo, path,
// query string or fragment, so internal hostnames, tokens, signatures and access_token
// values cannot leak into a committed artifact.
export function sanitizeEndpoint(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { endpointClass: "unset", scheme: "unknown", network: "unknown", port: "unknown" };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { endpointClass: "invalid", scheme: "unknown", network: "unknown", port: "unknown" };
  }
  const scheme = parsed.protocol === "https:" ? "https" : parsed.protocol === "http:" ? "http" : "other";
  const network = classifyEndpointNetwork(parsed.hostname);
  const defaultPort = scheme === "https" ? "443" : "80";
  const port = parsed.port === "" || parsed.port === defaultPort ? "default" : "custom";
  return {
    endpointClass: `${scheme}-${network}-${port === "default" ? "default" : "custom"}-port`,
    scheme,
    network,
    port,
  };
}

// Walk a value and return the JSON paths whose string values look like a credential-bearing
// URL (query credential or userinfo). Side-effect free; used by the offline validators.
export function findUnsafeUrlLike(value, trail = "$", hits = []) {
  if (typeof value === "string") {
    if (CREDENTIAL_URL_PATTERN.test(value) || URL_USERINFO_PATTERN.test(value)) hits.push(trail);
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findUnsafeUrlLike(item, `${trail}[${index}]`, hits));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) findUnsafeUrlLike(item, `${trail}.${key}`, hits);
  }
  return hits;
}

// --- report assembly --------------------------------------------------------------

export function buildParityReport({ target, parity }) {
  const matched = parity.missingFromProduction.length === 0 && parity.extraInProduction.length === 0 && parity.allSchemasMatch;
  return {
    schemaVersion: "1.0.0",
    generatedBy: AUTHOR,
    mode: "production tools/list parity",
    baseline: {
      commit: BASELINE_COMMIT,
      inventoryPath: "docs/review/tool-discovery/inventory.json",
      inventoryToolCount: parity.inventoryToolCount,
    },
    target: {
      endpoint: sanitizeEndpoint(target.url),
      transport: "streamable-http",
      auth: "API key header (value not recorded)",
      serverInfo: target.serverInfo,
      protocolVersion: target.protocolVersion,
    },
    provenance: {
      kind: "live-capture",
      offlineCanProveLiveOrigin: false,
      note: "Recorded from a live capture at capture time. Offline verification re-checks artifact shape, internal consistency and the local catalog only; it cannot prove this data came from a live server.",
    },
    status: matched ? "match" : "drift",
    parity,
    scope: {
      status: "not_wire_observable",
      source: "app/src/scopes.js MCP_TOOL_SCOPE_REQUIREMENTS",
      sourceToolCount: Object.keys(MCP_TOOL_SCOPE_REQUIREMENTS).length,
      deployedScopeEnforcement: "unknown",
      note: "`tools/list` never carries Scope. Scope is enforced per `tools/call`; this slice did not acquire a second, scope-limited production credential, so deployed enforcement was not behaviourally probed.",
    },
    measured: [
      "deployed tools/list name set versus TOOL_NAMES and the Wave 1 inventory",
      "deployed inputSchema canonical sha256 + utf8 bytes versus the Wave 1 inventory",
      "deployed outputSchema (output contract) canonical sha256 + utf8 bytes versus the Wave 1 inventory",
      "deployed annotations versus the Wave 1 inventory",
      "deployed title versus the Wave 1 inventory",
      "annotation/risk/scope histograms computed from the deployed catalog",
    ],
    unmeasured: [
      "deployed Scope enforcement (not observable over tools/list; no scope-limited credential used)",
      "client/host tool filtering — this is a raw HTTP capture, not a specific host's filtered view",
      "token cost (byte sizes are not tokens)",
    ],
  };
}

export function buildEagerRunReport({ target, parityReport, context, discovery, plan, probeResults, fixtureRun, capturedAt }) {
  const probeSummary = summarizeProbes(plan, probeResults);
  const schemaCost = {
    catalogInputSchemaBytes: parityReport.parity.totals.production.inputSchemaBytes,
    catalogOutputSchemaBytes: parityReport.parity.totals.production.outputSchemaBytes,
    catalogDescriptorBytes: parityReport.parity.totals.production.descriptorBytes,
    fixtureSchemaCostBytesTotal: fixtureRun.perTask.reduce((sum, row) => sum + row.schemaCostBytes, 0),
    fixtureSchemaCostBytesMax: fixtureRun.perTask.reduce((max, row) => Math.max(max, row.schemaCostBytes), 0),
  };
  return {
    schemaVersion: "1.0.0",
    generatedBy: AUTHOR,
    mode: "eager real run (read-only probes)",
    target: {
      endpoint: sanitizeEndpoint(target.url),
      transport: "streamable-http",
      auth: "API key header (value not recorded)",
      serverInfo: target.serverInfo,
      protocolVersion: target.protocolVersion,
      capturedAtUtc: capturedAt,
    },
    provenance: {
      kind: "live-capture",
      offlineCanProveLiveOrigin: false,
      note: "Recorded from a live capture at capture time. Offline verification re-checks artifact shape, internal consistency and the local catalog only; it cannot prove this data came from a live server.",
    },
    realCalls: {
      discoveryCalls: discovery.calls,
      probeCalls: probeSummary.invokedCalls,
      totalCalls: discovery.calls + probeSummary.invokedCalls,
    },
    discovery: { contextAvailability: discovery.availability },
    probes: probeSummary,
    probeDetail: plan
      .filter((probe) => probe.probe)
      .map((probe) => ({
        tool: probe.tool,
        outcome: probeResults[probe.tool]?.outcome ?? "unknown",
        reason: probeResults[probe.tool]?.reason ?? null,
        resultBytes: probeResults[probe.tool]?.resultBytes ?? 0,
      })),
    notProbed: plan
      .filter((probe) => probe.readOnly && !probe.probe)
      .map((probe) => ({ tool: probe.tool, reason: probe.reason })),
    excludedWriteOrDestructiveTools: plan.filter((probe) => !probe.readOnly).map((probe) => probe.tool),
    observedContractViolations: Object.entries(probeResults)
      .filter(([, result]) => result.outcome === "output_contract_violation")
      .map(([tool]) => ({
        tool,
        defect: "deployed server returned structured content rejected by its own declared outputSchema",
      })),
    fixtures: {
      count: fixtureRun.count,
      statusHistogram: fixtureRun.statusHistogram,
      readyRate: fixtureRun.readyRate,
      reachableRate: fixtureRun.reachableRate,
      failureReasons: fixtureRun.failureReasons,
      perTask: fixtureRun.perTask,
    },
    schemaCost,
    agentTaskSuccess: {
      status: "blocked",
      reason:
        "No model/agent harness exists in this slice. Task-level completion, tool-selection precision/recall and discovery rounds are not deterministically measurable here and were not simulated.",
    },
    safety: {
      policy: "only tools annotated readOnlyHint:true by the deployed server were invoked",
      statefulReadToolsSkipped: [...STATEFUL_READ_TOOLS.keys()],
      writeOrDestructiveToolsInvoked: 0,
      payloadBodiesRecorded: false,
    },
    measured: [
      "real tools/call outcomes per read-only deployed tool",
      "fixture-level readiness against the real eager catalog",
      "real MCP call counts and per-call result byte sizes",
      "task-relevant input-schema byte cost per fixture",
    ],
    unmeasured: [
      "end-to-end agent task success (blocked: no agent harness)",
      "tool-selection precision/recall and wrong-tool rate",
      "latency (intentionally not captured)",
      "write/destructive tool execution (intentionally never invoked)",
    ],
  };
}

// --- markdown formatting -----------------------------------------------------------

function table(rows, headers) {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines;
}

export function formatParityMarkdown(report) {
  const { parity } = report;
  const lines = [];
  lines.push("# Production tools/list parity — Wave 2");
  lines.push("");
  lines.push(`Status: **${report.status === "match" ? "production-verified" : "drift detected"}** (deployed \`tools/list\` surface; candidate artifact on a branch).`);
  lines.push(`Baseline: local \`main\` \`${report.baseline.commit}\` (Wave 1 inventory, ${report.baseline.inventoryToolCount} tools).`);
  lines.push(`Target: deployed server \`${report.target.serverInfo?.name} ${report.target.serverInfo?.version}\` over Streamable HTTP at a redacted endpoint (\`${report.target.endpoint?.endpointClass}\`); API key supplied from an environment variable and not recorded.`);
  lines.push("Offline verification of this artifact cannot prove it was captured from a live server.");
  lines.push("");
  lines.push("This proves parity of the deployed wire contract with local main. It does not prove the deployed checkout equals the baseline commit; only the registration-derived catalog was compared.");
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push(`- Deployed tools: **${parity.wireToolCount}**; expected: ${parity.expectedToolCount}; Wave 1 inventory: ${parity.inventoryToolCount}.`);
  lines.push(`- Name set matches \`TOOL_NAMES\`: **${parity.nameSetMatchesExpected}**; matches the Wave 1 inventory: **${parity.nameSetMatchesInventory}**.`);
  lines.push(`- inputSchema sha256 + bytes mismatches: **${parity.inputSchemaMismatches.length}**.`);
  lines.push(`- outputSchema (output contract) sha256 + bytes mismatches: **${parity.outputSchemaMismatches.length}**.`);
  lines.push(`- annotation mismatches: **${parity.annotationMismatches.length}**; title mismatches: **${parity.titleMismatches.length}**.`);
  lines.push(`- Totals: inputSchema ${parity.totals.production.inputSchemaBytes} bytes, outputSchema ${parity.totals.production.outputSchemaBytes} bytes, descriptor ${parity.totals.production.descriptorBytes} bytes.`);
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push(`- ${report.scope.note}`);
  lines.push(`- Source of truth: \`${report.scope.source}\` (${report.scope.sourceToolCount} tools).`);
  lines.push(`- Deployed scope enforcement: **${report.scope.deployedScopeEnforcement}** (status: \`${report.scope.status}\`).`);
  lines.push("");
  lines.push("## Census (from the deployed catalog)");
  lines.push("");
  lines.push(...table(
    Object.entries(parity.annotationCensus).map(([key, value]) => [`\`${key}\``, String(value)]),
    ["Annotation flag", "Tools"],
  ));
  lines.push("");
  lines.push(...table(
    Object.entries(parity.scopeHistogram).map(([key, value]) => [`\`${key || "(none)"}\``, String(value)]),
    ["Scope set (source evidence)", "Tools"],
  ));
  lines.push("");
  lines.push("## Measured / unmeasured");
  lines.push("");
  lines.push(`Measured: ${report.measured.join("; ")}.`);
  lines.push("");
  lines.push(`Unmeasured: ${report.unmeasured.join("; ")}.`);
  lines.push("");
  return lines.join("\n");
}

export function formatEagerRunMarkdown(report) {
  const lines = [];
  lines.push("# Eager real run — Wave 2 production anchors");
  lines.push("");
  lines.push("Status: **candidate**. A real, read-only `tools/call` run against the deployed eager catalog, reusing the Wave 1 50 task fixtures.");
  lines.push(`Target: redacted endpoint \`${report.target.endpoint?.endpointClass}\` (\`${report.target.serverInfo?.name} ${report.target.serverInfo?.version}\`), captured ${report.target.capturedAtUtc}.`);
  lines.push("Offline verification of this artifact cannot prove it was captured from a live server.");
  lines.push("");
  lines.push("## Calls and outcomes");
  lines.push("");
  lines.push(`- Real MCP calls: **${report.realCalls.totalCalls}** (${report.realCalls.discoveryCalls} discovery + ${report.realCalls.probeCalls} probes).`);
  lines.push(`- Read-only tools in catalog: ${report.probes.readOnlyTools}; probed: ${report.probes.readOnlyProbedTools}; not probed: ${report.probes.readOnlyNotProbedTools}.`);
  lines.push(`- Write/destructive tools excluded from probing by safety policy: ${report.probes.writeOrDestructiveToolsExcluded}.`);
  lines.push(`- Probe success rate (success / invoked): **${report.probes.successRate === null ? "n/a" : report.probes.successRate.toFixed(3)}**.`);
  lines.push("");
  lines.push(...table(Object.entries(report.probes.outcomes).map(([key, value]) => [`\`${key}\``, String(value)]), ["Outcome", "Calls"]));
  lines.push("");
  const nonSuccess = (report.probeDetail || []).filter((row) => row.outcome !== "success");
  if (nonSuccess.length) {
    lines.push("### Non-success probes");
    lines.push("");
    lines.push(...table(nonSuccess.map((row) => [`\`${row.tool}\``, `\`${row.outcome}\``, row.reason || ""]), ["Tool", "Outcome", "Reason"]));
    lines.push("");
  }
  lines.push("### Read-only tools not probed (and why)");
  lines.push("");
  lines.push(...table(Object.entries(report.probes.notProbedReasons).map(([key, value]) => [key.replace(/\|/g, "\\|"), String(value)]), ["tool:reason", "Count"]));
  lines.push("");
  lines.push("## Fixtures (50 tasks)");
  lines.push("");
  lines.push(`- Readiness histogram: ${JSON.stringify(report.fixtures.statusHistogram)}.`);
  lines.push(`- Expected-tool reachable rate: **${report.fixtures.reachableRate.toFixed(3)}**; fully ready rate: **${report.fixtures.readyRate.toFixed(3)}**.`);
  lines.push("");
  lines.push(...table(Object.entries(report.fixtures.failureReasons).map(([key, value]) => [key.replace(/\|/g, "\\|"), String(value)]), ["reason", "Count"]));
  lines.push("");
  lines.push("## Schema cost");
  lines.push("");
  lines.push(`- Deployed catalog: inputSchema ${report.schemaCost.catalogInputSchemaBytes} bytes, outputSchema ${report.schemaCost.catalogOutputSchemaBytes} bytes, descriptors ${report.schemaCost.catalogDescriptorBytes} bytes.`);
  lines.push(`- Per-fixture expected-tool inputSchema cost: total ${report.schemaCost.fixtureSchemaCostBytesTotal} bytes, max ${report.schemaCost.fixtureSchemaCostBytesMax} bytes.`);
  lines.push("");
  lines.push("## Agent task success");
  lines.push("");
  lines.push(`Status: **${report.agentTaskSuccess.status}** — ${report.agentTaskSuccess.reason}`);
  lines.push("");
  lines.push("## Observed output-contract violations");
  lines.push("");
  if ((report.observedContractViolations || []).length) {
    lines.push(...table(report.observedContractViolations.map((item) => [`\`${item.tool}\``, item.defect]), ["Tool", "Observed"]));
  } else {
    lines.push("None observed in this run.");
  }
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push(`- ${report.safety.policy}.`);
  lines.push(`- Stateful read-only tools skipped: ${report.safety.statefulReadToolsSkipped.map((name) => `\`${name}\``).join(", ")}.`);
  lines.push(`- Write/destructive tools invoked: ${report.safety.writeOrDestructiveToolsInvoked}; payload bodies recorded: ${report.safety.payloadBodiesRecorded}.`);
  lines.push("");
  lines.push("## Measured / unmeasured");
  lines.push("");
  lines.push(`Measured: ${report.measured.join("; ")}.`);
  lines.push("");
  lines.push(`Unmeasured: ${report.unmeasured.join("; ")}.`);
  lines.push("");
  return lines.join("\n");
}

// --- offline verification ----------------------------------------------------------

export async function buildLocalCatalog() {
  const server = new McpServer({ name: "tool-discovery-production-eval-local", version: "1.0.0" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "tool-discovery-production-eval-local-probe", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    return sortedByName(tools);
  } finally {
    await client.close();
    await server.close();
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateTargetContract(target, label, errors) {
  if (!isPlainObject(target)) {
    errors.push(`${label} target missing`);
    return;
  }
  if (Object.hasOwn(target, "url")) errors.push(`${label} target must not embed a raw url`);
  if (!isPlainObject(target.endpoint)) {
    errors.push(`${label} target.endpoint missing`);
  } else {
    const { endpointClass, scheme, network, port } = target.endpoint;
    if (typeof endpointClass !== "string" || !/^[a-z][a-z0-9-]*$/.test(endpointClass)) {
      errors.push(`${label} target.endpoint.endpointClass is not a stable category`);
    }
    if (typeof scheme !== "string" || typeof network !== "string" || typeof port !== "string") {
      errors.push(`${label} target.endpoint fields missing`);
    }
  }
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(JSON.stringify(target))) errors.push(`${label} target embeds a raw URL scheme`);
}

function validateProvenance(report, label, errors) {
  if (!isPlainObject(report.provenance)) {
    errors.push(`${label} provenance missing`);
    return;
  }
  if (report.provenance.offlineCanProveLiveOrigin !== false) {
    errors.push(`${label} provenance must state offlineCanProveLiveOrigin=false`);
  }
}

// Descriptors added to the checked-in Wave 1 inventory after the pinned production snapshot; the list is explicit so a future tool must be registered here deliberately.
export const ADDITIVE_SINCE_PARITY_SNAPSHOT = Object.freeze(["read_archive_entry"]);
// Contract check for production-parity.json. Pure and synchronous, unit-tested against mutated copies; no live-provenance claim.
export function validateParityReport(report, inventory) {
  const errors = [];
  if (!isPlainObject(report)) return ["production-parity.json is not an object"];
  if (report.generatedBy !== AUTHOR) errors.push(`parity generatedBy is not ${AUTHOR}`);
  if (typeof report.schemaVersion !== "string" || !report.schemaVersion) errors.push("parity schemaVersion missing");
  if (report.mode !== "production tools/list parity") errors.push("parity mode is unexpected");
  if (report.status !== "match" && report.status !== "drift") errors.push(`parity status "${report.status}" is invalid`);
  if (!isPlainObject(report.baseline) || typeof report.baseline.commit !== "string" || typeof report.baseline.inventoryPath !== "string") errors.push("parity baseline fields missing");
  validateTargetContract(report.target, "parity", errors);
  if (!isPlainObject(report.parity)) {
    errors.push("parity.parity missing");
  } else {
    for (const key of ["missingFromProduction", "extraInProduction", "inputSchemaMismatches", "outputSchemaMismatches", "annotationMismatches", "titleMismatches"]) {
      if (!Array.isArray(report.parity[key])) errors.push(`parity.parity.${key} must be an array`);
    }
    if (!isPlainObject(report.parity.totals?.production)) errors.push("parity totals missing");
  }
  validateProvenance(report, "parity", errors);
  if (inventory) {
    const tools = Array.isArray(inventory.tools) ? inventory.tools : null, size = tools?.length ?? null, wire = report.parity?.wireToolCount;
    if (report.baseline?.inventoryToolCount !== wire || wire !== report.parity?.expectedToolCount) errors.push("parity snapshot tool counts disagree with each other");
    if (!Number.isInteger(size) || !Number.isInteger(wire) || size !== wire + ADDITIVE_SINCE_PARITY_SNAPSHOT.length) errors.push(`parity checked-in inventory has ${size} tools; wireToolCount ${wire} plus named additive [${ADDITIVE_SINCE_PARITY_SNAPSHOT.join(", ")}] requires exactly ${wire + ADDITIVE_SINCE_PARITY_SNAPSHOT.length}`);
    for (const name of ADDITIVE_SINCE_PARITY_SNAPSHOT) if (!tools?.some((tool) => tool?.name === name)) errors.push(`parity named additive tool ${name} is missing from the checked-in inventory`);
  }
  for (const trail of findUnsafeUrlLike(report, "parity")) errors.push(`parity contains a credential-like URL at ${trail}`);
  return errors;
}

// Contract + cross-consistency check for eager-run.json. `parityReport` is optional for a
// standalone contract check; when present the two artifacts must agree on target, catalog
// coverage and schema byte totals. It cannot prove live provenance.
export function validateEagerRunReport(report, { parityReport = null, fixtureCount = null, inventory = null } = {}) {
  const errors = [];
  if (!isPlainObject(report)) return ["eager-run.json is not an object"];
  if (report.generatedBy !== AUTHOR) errors.push(`eager generatedBy is not ${AUTHOR}`);
  if (typeof report.schemaVersion !== "string" || !report.schemaVersion) errors.push("eager schemaVersion missing");
  if (report.mode !== "eager real run (read-only probes)") errors.push("eager mode is unexpected");
  validateTargetContract(report.target, "eager", errors);

  const realCalls = report.realCalls;
  if (!isPlainObject(realCalls)) {
    errors.push("eager realCalls missing");
  } else if (realCalls.totalCalls !== realCalls.discoveryCalls + realCalls.probeCalls) {
    errors.push("eager realCalls totalCalls does not equal discoveryCalls + probeCalls");
  }
  if (!isPlainObject(report.probes)) {
    errors.push("eager probes missing");
  } else if (report.probes.invokedCalls !== realCalls?.probeCalls) {
    errors.push("eager probes.invokedCalls does not match realCalls.probeCalls");
  }
  if (!isPlainObject(report.safety)) {
    errors.push("eager safety missing");
  } else {
    if (report.safety.writeOrDestructiveToolsInvoked !== 0) errors.push("eager run invoked write/destructive tools");
    if (report.safety.payloadBodiesRecorded !== false) errors.push("eager run recorded payload bodies");
  }
  if (report.agentTaskSuccess?.status !== "blocked") errors.push("eager agent task success must be blocked");
  if (!Array.isArray(report.probeDetail)) errors.push("eager probeDetail must be an array");
  validateProvenance(report, "eager", errors);

  if (inventory && Array.isArray(report.probeDetail)) {
    const inventoryByName = new Map((inventory.tools || []).map((tool) => [tool.name, tool]));
    for (const row of report.probeDetail) {
      const entry = inventoryByName.get(row?.tool);
      if (!entry) errors.push(`eager probeDetail references unknown tool ${row?.tool}`);
      else if (entry.risk !== "read-only") errors.push(`eager probeDetail invoked non-read-only tool ${row.tool}`);
    }
  }
  if (fixtureCount !== null && report.fixtures?.count !== fixtureCount) {
    errors.push("eager fixtures.count does not match the fixture file");
  }

  if (parityReport) {
    if (report.target?.endpoint?.endpointClass !== parityReport.target?.endpoint?.endpointClass) errors.push("eager/parity endpointClass mismatch");
    if (report.target?.serverInfo?.name !== parityReport.target?.serverInfo?.name) errors.push("eager/parity serverInfo.name mismatch");
    if (report.target?.serverInfo?.version !== parityReport.target?.serverInfo?.version) errors.push("eager/parity serverInfo.version mismatch");
    if (report.target?.protocolVersion !== parityReport.target?.protocolVersion) errors.push("eager/parity protocolVersion mismatch");
    const catalogCount = parityReport.parity?.wireToolCount;
    const coverage = (report.probes?.readOnlyTools || 0) + (report.probes?.writeOrDestructiveToolsExcluded || 0);
    if (Number.isInteger(catalogCount) && coverage !== catalogCount) errors.push("eager catalog coverage does not match parity wireToolCount");
    if (report.schemaCost?.catalogInputSchemaBytes !== parityReport.parity?.totals?.production?.inputSchemaBytes) {
      errors.push("eager/parity inputSchema byte total mismatch");
    }
    if (report.schemaCost?.catalogOutputSchemaBytes !== parityReport.parity?.totals?.production?.outputSchemaBytes) {
      errors.push("eager/parity outputSchema byte total mismatch");
    }
  }

  for (const trail of findUnsafeUrlLike(report, "eager")) errors.push(`eager contains a credential-like URL at ${trail}`);
  return errors;
}

export async function verifyCheckedInArtifacts({ inventoryPath = DEFAULT_INVENTORY_PATH, outDir = DEFAULT_OUT_DIR } = {}) {
  const errors = [];
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const fixtureFile = await loadFixtures(DEFAULT_FIXTURE_PATH);
  const validation = validateFixtures(fixtureFile);
  if (!validation.ok) errors.push(...validation.errors);

  let parityReport = null;
  let eagerReport = null;
  try {
    parityReport = JSON.parse(await readFile(path.join(outDir, PARITY_JSON), "utf8"));
  } catch {
    errors.push(`${PARITY_JSON} missing or unreadable`);
  }
  try {
    eagerReport = JSON.parse(await readFile(path.join(outDir, EAGER_RUN_JSON), "utf8"));
  } catch {
    errors.push(`${EAGER_RUN_JSON} missing or unreadable`);
  }

  // Offline anchor: the current working tree must still reproduce every checked-in
  // Wave 1 descriptor. Additive tools are allowed and checked separately by the
  // catalog parity test; removals or drift of historical tools fail here.
  const localTools = await buildLocalCatalog();
  const localParity = compareToolCatalog({ productionTools: localTools, inventory });
  if (localParity.inventoryMissingFromProduction.length) {
    errors.push(`local in-process catalog is missing Wave 1 tools: ${localParity.inventoryMissingFromProduction.join(", ")}`);
  }
  if (localParity.inputSchemaMismatches.length) {
    errors.push(`local in-process inputSchema mismatches Wave 1 inventory: ${localParity.inputSchemaMismatches.join(", ")}`);
  }
  if (localParity.outputSchemaMismatches.length) {
    errors.push(`local in-process outputSchema mismatches Wave 1 inventory: ${localParity.outputSchemaMismatches.join(", ")}`);
  }
  if (localParity.annotationMismatches.length) {
    errors.push(`local in-process annotations mismatch Wave 1 inventory: ${localParity.annotationMismatches.join(", ")}`);
  }

  // Artifact contracts plus cross-consistency. This is an offline check: it can neither
  // prove the captured data was live nor that the deployed checkout equals the baseline.
  if (parityReport) errors.push(...validateParityReport(parityReport, inventory));
  if (eagerReport) {
    errors.push(...validateEagerRunReport(eagerReport, { parityReport, fixtureCount: fixtureFile.tasks.length, inventory }));
  }
  if (parityReport) {
    if (parityReport.status !== "match") errors.push(`checked-in parity status is "${parityReport.status}"`);
  }
  if (parityReport && eagerReport) {
    const parityMd = formatParityMarkdown(parityReport);
    const eagerMd = formatEagerRunMarkdown(eagerReport);
    for (const [name, markdown] of [[PARITY_MD, parityMd], [EAGER_RUN_MD, eagerMd]]) {
      if (/[a-z][a-z0-9+.-]*:\/\//i.test(markdown)) errors.push(`${name} embeds a raw URL`);
    }
  }

  return {
    ok: errors.length === 0 && Boolean(parityReport) && Boolean(eagerReport),
    errors,
    localToolCount: localTools.length,
    localCatalogDigest: digestJson(localTools),
    offlineCanProveLiveOrigin: false,
  };
}

// --- CLI ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    mode: "capture",
    url: undefined,
    urlEnv: DEFAULT_URL_ENV,
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    apiKeyHeader: "X-API-Key",
    fixtures: DEFAULT_FIXTURE_PATH,
    inventory: DEFAULT_INVENTORY_PATH,
    outDir: DEFAULT_OUT_DIR,
    timeoutMs: 60000,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--capture") options.mode = "capture";
    else if (arg === "--run") options.mode = "run";
    else if (arg === "--all") options.mode = "all";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--url") options.url = next();
    else if (arg.startsWith("--url=")) options.url = arg.slice("--url=".length);
    else if (arg === "--url-env") options.urlEnv = next();
    else if (arg === "--api-key-env") options.apiKeyEnv = next();
    else if (arg === "--api-key-header") options.apiKeyHeader = next();
    else if (arg === "--fixtures") options.fixtures = path.resolve(next() || "");
    else if (arg === "--inventory") options.inventory = path.resolve(next() || "");
    else if (arg === "--out-dir") options.outDir = path.resolve(next() || "");
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next());
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function blockedResult(reason, mode) {
  return { status: "blocked", mode, reason };
}

async function execute(options, env = process.env) {
  if (options.mode === "verify") {
    const verification = await verifyCheckedInArtifacts({ inventoryPath: options.inventory, outDir: options.outDir });
    return { status: verification.ok ? "ok" : "failed", mode: "verify", ...verification };
  }

  const url = options.url || env[options.urlEnv];
  const apiKey = env[options.apiKeyEnv];
  if (!url) return blockedResult(`no MCP URL provided (use --url or ${options.urlEnv})`, options.mode);
  if (!apiKey) return blockedResult(`no API key in environment variable ${options.apiKeyEnv}`, options.mode);

  const inventory = JSON.parse(await readFile(options.inventory, "utf8"));
  const fixtureFile = await loadFixtures(options.fixtures);
  const validation = validateFixtures(fixtureFile);
  if (!validation.ok) return { status: "failed", mode: options.mode, validation };

  const client = new McpHttpClient({ url, apiKey, apiKeyHeader: options.apiKeyHeader, timeoutMs: options.timeoutMs });
  const connected = await client.connect();
  if (!connected.ok) return blockedResult(`MCP initialize failed: ${connected.kind}${connected.status ? ` (${connected.status})` : ""}`, options.mode);
  const listed = await client.listTools();
  if (!listed.ok) return blockedResult(`MCP tools/list failed: ${listed.kind}`, options.mode);

  const target = {
    url,
    serverInfo: connected.serverInfo,
    protocolVersion: connected.protocolVersion,
  };
  const parity = compareToolCatalog({ productionTools: listed.tools, inventory });
  const capturedAt = new Date().toISOString();
  const parityReport = buildParityReport({ target, parity });

  if (options.mode === "capture") return { status: "ok", parityReport };

  const discovery = await collectProbeContext(client);
  const plan = buildProbePlan({ catalog: listed.tools, context: discovery.context });
  const probeRun = await runProbes(client, plan);
  const fixtureRun = evaluateFixtures({
    tasks: fixtureFile.tasks,
    catalog: listed.tools,
    probeResults: probeRun.results,
    inventory,
  });
  const eagerReport = buildEagerRunReport({
    target,
    parityReport,
    context: discovery.context,
    discovery,
    plan,
    probeResults: probeRun.results,
    fixtureRun,
    capturedAt,
  });

  return { status: "ok", parityReport, eagerReport };
}

export async function writeArtifacts(result, outDir = DEFAULT_OUT_DIR) {
  if (result.status !== "ok") return [];
  await mkdir(outDir, { recursive: true });
  const written = [];
  if (result.parityReport) {
    await writeFile(path.join(outDir, PARITY_JSON), `${JSON.stringify(result.parityReport, null, 2)}\n`, "utf8");
    await writeFile(path.join(outDir, PARITY_MD), `${formatParityMarkdown(result.parityReport)}\n`, "utf8");
    written.push(PARITY_JSON, PARITY_MD);
  }
  if (result.eagerReport) {
    await writeFile(path.join(outDir, EAGER_RUN_JSON), `${JSON.stringify(result.eagerReport, null, 2)}\n`, "utf8");
    await writeFile(path.join(outDir, EAGER_RUN_MD), `${formatEagerRunMarkdown(result.eagerReport)}\n`, "utf8");
    written.push(EAGER_RUN_JSON, EAGER_RUN_MD);
  }
  return written;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node app/scripts/tool-discovery-production-eval.mjs [--capture|--run|--all|--verify]");
    console.log("  --url <mcp-url>            or set OBSIDIAN_MCP_URL");
    console.log("  --api-key-env <NAME>       environment variable holding the API key (default OBSIDIAN_MCP_API_KEY)");
    console.log("  --out-dir <path>           artifact output directory");
    console.log("  --timeout-ms <ms>          per-request timeout (default 60000)");
    console.log("  --json                     print the result as JSON");
    console.log("  --verify                   offline check of both artifact contracts + cross-consistency (cannot prove live origin)");
    return 0;
  }
  const result = await execute(options);
  if (result.status === "ok" && options.mode !== "verify") {
    result.written = await writeArtifacts(result, options.outDir);
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (result.status === "blocked") console.log(`BLOCKED: ${result.reason}`);
  else if (result.status === "failed") console.log(`FAILED: ${result.errors?.join("; ") || result.validation?.errors?.join("; ") || "unknown"}`);
  else if (result.mode === "verify") console.log(`verify: ${result.ok ? "ok" : "failed"} (local tools: ${result.localToolCount}); offline check cannot prove live origin`);
  else if (result.parityReport) {
    console.log(`parity: ${result.parityReport.status} (${result.parityReport.parity.wireToolCount} tools, inputSchema mismatches ${result.parityReport.parity.inputSchemaMismatches.length})`);
    if (result.eagerReport) {
      console.log(`eager run: ${result.eagerReport.realCalls.totalCalls} calls, success rate ${result.eagerReport.probes.successRate}`);
    }
  }
  return result.status === "ok" ? 0 : result.status === "blocked" ? 3 : 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error?.stack || String(error));
      process.exitCode = 1;
    });
}
