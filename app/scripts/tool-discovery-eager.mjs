#!/usr/bin/env node
// Deterministic, read-only Phase 0 measurement entry point for the eager/full
// MCP tool catalog. It validates the task fixtures and reports catalog/schema
// sizes from a real in-memory `tools/list` handshake. It never calls a tool,
// never touches the vault, and never reports latency or agent-task success.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerObsidianCapabilities } from "../src/capabilities.js";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_FIXTURE_PATH = path.join(APP_DIR, "test", "fixtures", "tool-discovery-eager-tasks.json");
const AUTHORED_COMMIT = "44e3828e6f38c953464580ed3b135cf771ae1912";
const VALID_LANGUAGES = new Set(["en", "zh", "mixed"]);

const TOOL_NAME_SET = new Set(TOOL_NAMES);
const UTF8 = new TextEncoder();

function byteLength(value) {
  return UTF8.encode(value).length;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sortedEntries(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return sortedEntries(counts);
}

export async function loadFixtures(fixturePath = DEFAULT_FIXTURE_PATH) {
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw);
}

export function validateFixtures(fixtureFile) {
  const errors = [];
  const warnings = [];
  const tasks = Array.isArray(fixtureFile?.tasks) ? fixtureFile.tasks : null;
  const allowedCategories = new Set(fixtureFile?.categories || []);
  const allowedForbidden = new Set(fixtureFile?.forbiddenToolCategories || []);
  const allowedSafety = new Set(fixtureFile?.safetyExpectations || []);

  if (!tasks) {
    errors.push("fixture file has no tasks array");
    return { ok: false, errors, warnings };
  }
  if (!allowedCategories.size) errors.push("fixture file declares no categories");
  if (!allowedForbidden.size) errors.push("fixture file declares no forbiddenToolCategories");
  if (!allowedSafety.size) errors.push("fixture file declares no safetyExpectations");

  const seenIds = new Set();
  tasks.forEach((task, index) => {
    const label = task?.taskId || `#${index}`;
    const require = (condition, message) => {
      if (!condition) errors.push(`${label}: ${message}`);
    };
    require(typeof task?.taskId === "string" && task.taskId.trim().length > 0, "taskId must be a non-empty string");
    if (seenIds.has(task?.taskId)) errors.push(`${label}: duplicate taskId`);
    seenIds.add(task?.taskId);
    require(allowedCategories.has(task?.category), `unknown category "${task?.category}"`);
    require(VALID_LANGUAGES.has(task?.language), `unknown language "${task?.language}"`);
    require(typeof task?.request === "string" && task.request.trim().length > 0, "request must be a non-empty string");
    require(Array.isArray(task?.expectedTools) && task.expectedTools.length > 0, "expectedTools must be a non-empty array");
    require(Array.isArray(task?.alternativeTools), "alternativeTools must be an array");
    require(Array.isArray(task?.forbiddenToolCategories), "forbiddenToolCategories must be an array");
    require(Array.isArray(task?.safetyExpectations) && task.safetyExpectations.length > 0, "safetyExpectations must be a non-empty array");

    const expected = Array.isArray(task?.expectedTools) ? task.expectedTools : [];
    const alternatives = Array.isArray(task?.alternativeTools) ? task.alternativeTools : [];
    for (const name of [...expected, ...alternatives]) {
      require(TOOL_NAME_SET.has(name), `tool name "${name}" is not in TOOL_NAMES`);
    }
    for (const name of alternatives) {
      if (expected.includes(name)) errors.push(`${label}: "${name}" listed as both expected and alternative`);
    }
    for (const category of task?.forbiddenToolCategories || []) {
      require(allowedForbidden.has(category), `unknown forbidden tool category "${category}"`);
    }
    for (const expectation of task?.safetyExpectations || []) {
      require(allowedSafety.has(expectation), `unknown safety expectation "${expectation}"`);
    }
    if (Array.isArray(task?.safetyExpectations) && task.safetyExpectations.includes("read-only")) {
      for (const name of [...expected, ...alternatives]) {
        const scopes = MCP_TOOL_SCOPE_REQUIREMENTS[name] || [];
        if (scopes.includes("obsidian.write")) {
          errors.push(`${label}: read-only fixture references write-scoped tool "${name}"`);
        }
      }
    }
  });

  if (tasks.length < 30 || tasks.length > 50) {
    warnings.push(`fixture count ${tasks.length} is outside the target 30-50 range`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export async function buildEagerCatalog() {
  const server = new McpServer({ name: "tool-discovery-eager-baseline", version: "1.0.0" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "tool-discovery-eager-probe", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let descriptorBytes = 0;
    let inputSchemaBytes = 0;
    let outputSchemaBytes = 0;
    const annotations = { readOnlyHint: 0, destructiveHint: 0, idempotentHint: 0, openWorldHint: 0 };
    const scopeCounts = new Map();
    const perTool = sorted.map((tool) => {
      const descriptor = byteLength(JSON.stringify(tool));
      const input = tool.inputSchema ? byteLength(JSON.stringify(tool.inputSchema)) : 0;
      const output = tool.outputSchema ? byteLength(JSON.stringify(tool.outputSchema)) : 0;
      descriptorBytes += descriptor;
      inputSchemaBytes += input;
      outputSchemaBytes += output;
      for (const key of Object.keys(annotations)) {
        if (tool.annotations?.[key] === true) annotations[key] += 1;
      }
      const scopes = MCP_TOOL_SCOPE_REQUIREMENTS[tool.name] || [];
      const scopeKey = scopes.join("+");
      scopeCounts.set(scopeKey, (scopeCounts.get(scopeKey) || 0) + 1);
      return { name: tool.name, descriptorBytes: descriptor, inputSchemaBytes: input, outputSchemaBytes: output, scopes };
    });
    return {
      source: "in-memory McpServer + registerObsidianCapabilities + client.listTools()",
      measurement:
        "utf8 byte length of JSON.stringify of each tools/list tool descriptor and its inputSchema/outputSchema; " +
        "JSON object key order follows server registration order inside one process; no tokenization, no latency capture",
      toolCount: sorted.length,
      toolNames: sorted.map((tool) => tool.name),
      matchesToolNames: sorted.length === TOOL_NAMES.length && sorted.every((tool, index) => tool.name === [...TOOL_NAMES].sort()[index]),
      toolsListPayloadBytes: byteLength(JSON.stringify({ tools: sorted })),
      descriptorBytes,
      inputSchemaBytes,
      outputSchemaBytes,
      annotations,
      scopeHistogram: sortedEntries(scopeCounts),
      tools: perTool,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

export async function buildReport(fixturePath = DEFAULT_FIXTURE_PATH) {
  const fixtureFile = await loadFixtures(fixturePath);
  const validation = validateFixtures(fixtureFile);
  const catalog = await buildEagerCatalog();
  const tasks = Array.isArray(fixtureFile.tasks) ? fixtureFile.tasks : [];
  const expectedNames = sortedUnique(tasks.flatMap((task) => task.expectedTools || []));
  const alternativeNames = sortedUnique(tasks.flatMap((task) => task.alternativeTools || []));
  const referencedNames = sortedUnique([...expectedNames, ...alternativeNames]);
  const uncovered = TOOL_NAMES.filter((name) => !referencedNames.includes(name));

  return {
    schemaVersion: "1.0.0",
    generatedBy: "app/scripts/tool-discovery-eager.mjs",
    mode: "eager/full catalog baseline",
    readOnly: true,
    authoredCommit: AUTHORED_COMMIT,
    fixtureSchemaVersion: fixtureFile.schemaVersion || "unknown",
    measured: [
      "fixture count and per-category/per-language/per-safety distribution",
      "expected and alternative tool-name resolution against TOOL_NAMES",
      "eager catalog tool count from a real in-memory tools/list handshake",
      "per-tool descriptor/inputSchema/outputSchema utf8 byte sizes",
      "readOnly/destructive/idempotent/openWorld annotation counts",
      "scope-requirement histogram from app/src/scopes.js",
      "catalog coverage by fixture references",
    ],
    unmeasured: [
      "end-to-end agent task success",
      "tool-selection precision/recall",
      "wrong-tool or unnecessary-tool rate",
      "discovery rounds and real MCP tool call counts",
      "latency (p50/p95) — intentionally not captured",
      "real model token usage (byte sizes are not tokens)",
      "unauthorized-tool metadata leak behavior",
      "client/host progressive-disclosure support",
    ],
    catalog,
    fixtures: {
      count: tasks.length,
      byCategory: countBy(tasks, (task) => task.category),
      byLanguage: countBy(tasks, (task) => task.language),
      bySafetyExpectation: countBy(tasks.flatMap((task) => task.safetyExpectations || []), (value) => value),
      byForbiddenCategory: countBy(tasks.flatMap((task) => task.forbiddenToolCategories || []), (value) => value),
      expectedToolCount: expectedNames.length,
      alternativeToolCount: alternativeNames.length,
      referencedToolCount: referencedNames.length,
      catalogCoverage: { covered: referencedNames.length, total: TOOL_NAMES.length, uncovered: uncovered },
      expectedToolHistogram: countBy(tasks.flatMap((task) => task.expectedTools || []), (value) => value),
    },
    validation,
  };
}

export function formatReport(report) {
  const lines = [];
  const push = (line = "") => lines.push(line);
  push(`Tool Discovery — eager baseline (read-only)`);
  push(`authored commit: ${report.authoredCommit}`);
  push(`fixture schema:  ${report.fixtureSchemaVersion}`);
  push("");
  push(`Catalog: ${report.catalog.toolCount} tools (matches TOOL_NAMES: ${report.catalog.matchesToolNames})`);
  push(`  descriptor bytes:   ${report.catalog.descriptorBytes}`);
  push(`  inputSchema bytes:  ${report.catalog.inputSchemaBytes}`);
  push(`  outputSchema bytes: ${report.catalog.outputSchemaBytes}`);
  push(`  tools/list payload: ${report.catalog.toolsListPayloadBytes} bytes`);
  push(`  annotations:        ${JSON.stringify(report.catalog.annotations)}`);
  push(`  scopes:             ${JSON.stringify(report.catalog.scopeHistogram)}`);
  push("");
  push(`Fixtures: ${report.fixtures.count}`);
  push(`  by category:`);
  for (const [key, value] of Object.entries(report.fixtures.byCategory)) push(`    ${key}: ${value}`);
  push(`  by language: ${JSON.stringify(report.fixtures.byLanguage)}`);
  push(`  expected tools: ${report.fixtures.expectedToolCount}; alternatives: ${report.fixtures.alternativeToolCount}`);
  push(`  catalog coverage: ${report.fixtures.catalogCoverage.covered}/${report.fixtures.catalogCoverage.total}`);
  if (report.fixtures.catalogCoverage.uncovered.length) {
    push(`  uncovered tools: ${report.fixtures.catalogCoverage.uncovered.join(", ")}`);
  }
  push("");
  push(`Validation: ${report.validation.ok ? "OK" : "FAILED"}`);
  for (const error of report.validation.errors) push(`  error: ${error}`);
  for (const warning of report.validation.warnings) push(`  warn:  ${warning}`);
  push("");
  push(`Measured: ${report.measured.join("; ")}`);
  push(`Unmeasured: ${report.unmeasured.join("; ")}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { json: false, fixturePath: DEFAULT_FIXTURE_PATH, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--fixtures") options.fixturePath = path.resolve(argv[++i] || "");
    else if (arg.startsWith("--fixtures=")) options.fixturePath = path.resolve(arg.slice("--fixtures=".length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/tool-discovery-eager.mjs [--json] [--fixtures <path>]");
    return 0;
  }
  const report = await buildReport(options.fixturePath);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.validation.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(error?.stack || String(error));
      process.exitCode = 1;
    });
}
