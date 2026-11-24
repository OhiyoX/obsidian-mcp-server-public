#!/usr/bin/env node
// Measured cost of the real `tools/list` descriptor set, per discovery profile (D1).
//
// A Host pays these bytes on every connect, so the figure must be reproducible on
// any commit instead of quoted from a note. Every number here comes from a real
// in-memory `client.listTools()` handshake through the same discovery runtime that
// `server.js` installs — never from a fixture and never from a second registry.
//
// The descriptor set is a contract: a list that does not expose every TOOL_NAMES
// entry exactly once is a hard error, never a smaller number. Token counts are
// deliberately absent — no tokenizer runs here, and bytes/4 is not a token count.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerObsidianCapabilities } from "../src/capabilities.js";
import { TOOL_NAMES } from "../src/config.js";
import { compactDescriptorFingerprint } from "../src/compact-descriptor-integrity.js";
import { parseDiscoveryOperatorConfig } from "../src/discovery-config.js";
import { createDiscoveryRuntimePolicy } from "../src/discovery-runtime.js";

export const REPORT_SCHEMA_VERSION = "1.0.0";
export const AUTHOR = "app/scripts/mcp-descriptor-cost-report.mjs";
export const CLI_PROFILES = Object.freeze(["compact", "full"]);
export const TOKEN_REASON =
  "No tokenizer runs in this offline report, and bytes/4 is not a token count, so no token figure is given.";

const UTF8 = new TextEncoder();

function byteLength(text) {
  return UTF8.encode(text).length;
}

function readText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`buildDescriptorCostReport requires a non-empty string ${label}`);
  }
  return value;
}

function readPrincipalScope(value) {
  if (Array.isArray(value) && value.length && value.every((scope) => typeof scope === "string" && scope.trim())) {
    return [...value];
  }
  return readText(value, "options.principalScope (a scope name, a scope array, or \"all\")");
}

// Every violation below carries the offending name: a report about a corrupt list
// must say what is corrupt, not just fail.
function readDescriptors(list) {
  if (!list || typeof list !== "object" || !Array.isArray(list.tools)) {
    throw new Error("buildDescriptorCostReport requires a tools/list result: an object with a tools[] array");
  }
  if (!list.tools.length) throw new Error("tools/list returned no descriptors");

  const seen = new Set();
  const rows = [];
  const actions = [];
  for (const [index, tool] of list.tools.entries()) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error(`descriptor #${index} is not an object`);
    const name = tool.name;
    if (typeof name !== "string" || !name.trim()) throw new Error(`descriptor #${index} has no usable name`);
    if (seen.has(name)) throw new Error(`duplicate descriptor name: ${name}`);
    seen.add(name);

    const bytes = byteLength(JSON.stringify(tool));
    const branches = tool.inputSchema?.oneOf;
    if (branches === undefined) {
      // No oneOf: the descriptor's own name is the one action it serves.
      rows.push({ name, bytes, oneOfBranches: 1, oneOfBytes: 0 });
      actions.push(name);
      continue;
    }
    if (!Array.isArray(branches) || !branches.length) {
      throw new Error(`descriptor ${name}: inputSchema.oneOf is not a non-empty array`);
    }
    for (const [branchIndex, branch] of branches.entries()) {
      const action = branch?.properties?.action?.const;
      if (typeof action !== "string" || !action) {
        throw new Error(`descriptor ${name}: oneOf branch #${branchIndex} has no properties.action.const`);
      }
      actions.push(action);
    }
    rows.push({ name, bytes, oneOfBranches: branches.length, oneOfBytes: byteLength(JSON.stringify(branches)) });
  }
  return { rows, actions };
}

function readCoverage(actions) {
  const canonical = new Set(TOOL_NAMES);
  const counts = new Map();
  for (const action of actions) counts.set(action, (counts.get(action) ?? 0) + 1);
  const coverage = {
    expected: TOOL_NAMES.length,
    covered: actions.length,
    unique: counts.size,
    missing: TOOL_NAMES.filter((name) => !counts.has(name)),
    extra: [...counts.keys()].filter((name) => !canonical.has(name)).sort(),
    duplicates: [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name).sort(),
  };
  if (coverage.missing.length || coverage.extra.length || coverage.duplicates.length || coverage.unique !== canonical.size) {
    throw new Error(
      `action coverage is not one-to-one with TOOL_NAMES (${TOOL_NAMES.length} exactly once): ` +
        `covered=${coverage.covered} unique=${coverage.unique} ` +
        `missing=[${coverage.missing.join(", ")}] extra=[${coverage.extra.join(", ")}] duplicates=[${coverage.duplicates.join(", ")}]`,
    );
  }
  return coverage;
}

/**
 * Cost report for one real `tools/list` result.
 *
 * `list` is the wire result (`{ tools: [...] }`, JSON round-tripped), and
 * `options` fixes the measurement context: `profile` (the discovery profile that
 * produced it), `principalScope` (the caller's granted scope set) and
 * `hostCapability` (what the host does with the descriptors).
 */
export function buildDescriptorCostReport(list, options = {}) {
  const profile = readText(options.profile, "options.profile");
  const principalScope = readPrincipalScope(options.principalScope);
  const hostCapability = readText(options.hostCapability, "options.hostCapability");

  const { rows, actions } = readDescriptors(list);
  const coverage = readCoverage(actions);
  const payload = JSON.stringify({ tools: list.tools });
  const oneOfRows = rows.filter((row) => row.oneOfBranches > 1 || row.oneOfBytes > 0);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedBy: AUTHOR,
    context: { profile, principalScope, hostCapability },
    descriptorCount: rows.length,
    toolsListPayload: {
      bytes: byteLength(payload),
      sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
    },
    servedSchemaFingerprint: compactDescriptorFingerprint(list.tools),
    oneOf: {
      descriptors: oneOfRows.length,
      branches: rows.reduce((sum, row) => sum + row.oneOfBranches, 0),
      bytes: rows.reduce((sum, row) => sum + row.oneOfBytes, 0),
    },
    actionCoverage: coverage,
    tokens: { estimate: null, reason: TOKEN_REASON },
    descriptors: rows,
    semantics: {
      toolsListPayload: "UTF-8 bytes of JSON.stringify({ tools }) as client.listTools() returned it; the JSON-RPC envelope is excluded.",
      oneOfBytes: "UTF-8 bytes of JSON.stringify(inputSchema.oneOf) per descriptor that serves one, 0 otherwise.",
      oneOfBranches: "Actions reachable through the descriptor set: one per oneOf branch, or the descriptor's own name when it has no oneOf.",
      servedSchemaFingerprint: "compactDescriptorFingerprint(tools): the 16-hex digest the server also reports as discovery.compactSchemaFingerprint.",
      context: "The provenance of the numbers. principalScope \"all\" means every MCP scope was granted when the list was captured.",
      tokens: TOKEN_REASON,
    },
  };
}

// Real handshake: the SDK server with the shipped capability registration and the
// discovery runtime installed exactly as server.js installs it, every scope granted.
export async function captureToolsList(profile) {
  const operatorConfig = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: profile });
  if (operatorConfig.profile !== profile) {
    throw new Error(`discovery config rejected profile ${profile}: ${operatorConfig.warning ?? `got ${operatorConfig.profile}`}`);
  }
  const server = new McpServer({ name: "mcp-descriptor-cost-report", version: REPORT_SCHEMA_VERSION });
  const discovery = createDiscoveryRuntimePolicy(server, operatorConfig, { authDisabled: true });
  registerObsidianCapabilities(discovery);
  discovery.install();
  const client = new Client({ name: "mcp-descriptor-cost-report", version: REPORT_SCHEMA_VERSION }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    // Wire shapes, not live SDK objects: what a Host actually parses.
    return JSON.parse(JSON.stringify({ tools }));
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export function formatDescriptorCostTable(reports) {
  const header = ["profile", "scope", "host capability", "descriptors", "payload bytes", "sha256", "fingerprint", "oneOf d/b/B", "actions"];
  const rows = reports.map((report) => [
    report.context.profile,
    Array.isArray(report.context.principalScope) ? report.context.principalScope.join("+") : report.context.principalScope,
    report.context.hostCapability,
    String(report.descriptorCount),
    String(report.toolsListPayload.bytes),
    report.toolsListPayload.sha256.slice(0, 16),
    report.servedSchemaFingerprint,
    `${report.oneOf.descriptors}/${report.oneOf.branches}/${report.oneOf.bytes}`,
    `${report.actionCoverage.covered}/${report.actionCoverage.expected}`,
  ]);
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column].length)));
  return [header, ...rows].map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n");
}

export function parseArgs(argv) {
  const options = { profiles: [...CLI_PROFILES], out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--profile") {
      const value = next() || "";
      options.profiles = value === "both" ? [...CLI_PROFILES] : [value];
    } else if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      options.profiles = value === "both" ? [...CLI_PROFILES] : [value];
    } else if (arg === "--out") {
      options.out = path.resolve(next() || "");
    } else if (arg.startsWith("--out=")) {
      options.out = path.resolve(arg.slice("--out=".length));
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  for (const profile of options.profiles) {
    if (!CLI_PROFILES.includes(profile)) throw new Error(`Unknown profile: ${profile} (use ${CLI_PROFILES.join("|")}|both)`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node app/scripts/mcp-descriptor-cost-report.mjs [--profile compact|full|both] [--out <file.json>]");
    console.log("  Measures the real in-memory tools/list descriptor set; prints a table, writes JSON with --out.");
    return 0;
  }
  const reports = [];
  for (const profile of options.profiles) {
    const list = await captureToolsList(profile);
    reports.push(buildDescriptorCostReport(list, { profile, principalScope: "all", hostCapability: "tools/list" }));
  }
  console.log(formatDescriptorCostTable(reports));
  if (options.out) {
    const artifact = { schemaVersion: REPORT_SCHEMA_VERSION, generatedBy: AUTHOR, reports };
    await writeFile(options.out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.log(`wrote ${options.out} (${reports.length} profile report${reports.length === 1 ? "" : "s"})`);
  }
  return 0;
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
