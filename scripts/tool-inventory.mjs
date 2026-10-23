#!/usr/bin/env node
// Wave 1 / A — Progressive Tool Discovery, Phase 0 inventory generator.
//
// Read-only characterization of the *current* eager MCP tool catalog. This
// script never mutates the server, Vault, or configuration. It:
//
//   1. instantiates the real registration path (`registerObsidianCapabilities`)
//      against an in-memory MCP client/server pair and captures a genuine
//      `tools/list` response;
//   2. maps each tool to the source module that registers it;
//   3. reads Scope requirements from the real `src/scopes.js` registry;
//   4. measures canonical input/output JSON Schema bytes.
//
// Regeneration (from the repository root). The no-flag path rewrites the
// historical evidence snapshot. It is not the gate; do not use it to silence
// `--check`.
//
//   cd app && npm ci
//   cd .. && node scripts/tool-inventory.mjs
//
// Monotonic compatibility gate. Regenerates in memory, never writes, and does
// not require the frozen snapshot to match byte-for-byte. Fails when the live
// catalog drops a snapshot tool, downgrades derived risk, drops a required
// scope, or weakens a safety hint:
//
//   node scripts/tool-inventory.mjs --check
//
// Print one generation without writing:
//
//   node scripts/tool-inventory.mjs --stdout
//
// The output is deterministic: no timestamps, no git HEAD, and all JSON is
// emitted with recursively sorted object keys.

import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(scriptDir, "..");
export const APP_ROOT = path.join(REPO_ROOT, "app");
export const REPORT_DIR = path.join(REPO_ROOT, "docs", "review", "tool-discovery");
export const JSON_PATH = path.join(REPORT_DIR, "inventory.json");
export const MARKDOWN_PATH = path.join(REPORT_DIR, "inventory.md");

const SDK_MODULES_DIR = path.join(
  APP_ROOT,
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
  "dist",
  "esm",
);

// The registration module -> tool name mapping. Keep in sync with
// app/src/capabilities.js. This is source evidence, not part of `tools/list`.
const TOOL_MODULES = [
  ["tools/info.js", "registerInfoTools"],
  ["tools/notes.js", "registerNoteTools"],
  ["tools/search.js", "registerSearchTools"],
  ["tools/files.js", "registerFileTools"],
  ["tools/links.js", "registerLinkTools"],
  ["tools/workflows.js", "registerWorkflowTools"],
  ["tools/git.js", "registerGitTools"],
  ["tools/intelligence.js", "registerIntelligenceTools"],
  ["tools/context.js", "registerContextTools"],
  ["tools/publish.js", "registerPublishTools"],
  ["tools/plans.js", "registerPlanTools"],
];

const EVIDENCE = Object.freeze({
  name: "runtime `tools/list` response captured from the production registration path over an in-process MCP transport",
  module: "source evidence: which `app/src/tools/*.js` `register*Tools` function calls `server.registerTool(name, ...)`",
  inputSchema:
    "runtime `tools/list` response: the SDK-computed JSON Schema (draft-07 via zod v4, strictUnions, pipeStrategy=input); canonicalized for byte measurement",
  scope:
    "source evidence: `app/src/scopes.js` `MCP_TOOL_SCOPE_REQUIREMENTS` (authorization truth; not carried in `tools/list`)",
  annotations:
    "runtime `tools/list` response: annotations completed by `app/src/tool-contracts.js` `completeToolAnnotations`",
  outputContract:
    "runtime `tools/list` response `outputSchema`: derived from `app/src/tool-contracts.js` `outputSchemaForTool`",
  domain:
    "unknown: no canonical catalog/toolset taxonomy is implemented yet (Progressive Tool Discovery Phase 1); source module is reported instead",
});

const UNKNOWNS = Object.freeze([
  {
    field: "domain / toolset",
    value: "unknown",
    reason:
      "No canonical capability-catalog taxonomy exists in the runtime (planned Phase 1). The source registration module is reported as a proxy.",
  },
  {
    field: "production deployment tools/list",
    value: "unknown",
    reason:
      "This baseline is a real in-process `tools/list` from current main. It is not a response captured from the deployed NAS process, so deployment drift, host tool filtering, and client-specific visibility are not proven here.",
  },
]);

const DERIVED = Object.freeze([
  {
    field: "risk",
    reason:
      "MCP has no `risk` field. Risk is derived deterministically from the four standard annotation hints (read-only / destructive / mutating); it is not an independent runtime claim.",
  },
]);

// ---------- canonical JSON / digests ----------

/**
 * Recursively sort object keys so byte measurements are independent of
 * insertion order. Arrays keep their order (significant for `enum`, etc.).
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------- runtime capture ----------

async function importApp(relative) {
  return import(pathToFileURL(path.join(APP_ROOT, relative)).href);
}

async function importSdk(subpath) {
  return import(pathToFileURL(path.join(SDK_MODULES_DIR, subpath)).href);
}

async function readPackageVersion(name) {
  const file = path.join(APP_ROOT, "node_modules", name, "package.json");
  const pkg = JSON.parse(await readFile(file, "utf8"));
  return pkg.version;
}

/**
 * Capture the genuine `tools/list` response produced by the production
 * registration code. Uses the SDK's in-memory transport; no network, no Vault
 * mutation, no server process.
 */
export async function captureToolsList() {
  const { McpServer } = await importSdk("server/mcp.js");
  const { Client } = await importSdk("client/index.js");
  const { InMemoryTransport } = await importSdk("inMemory.js");
  const { registerObsidianCapabilities } = await importApp("src/capabilities.js");

  const server = new McpServer({ name: "tool-inventory", version: "0.0.0" });
  registerObsidianCapabilities(server);

  const client = new Client({ name: "tool-inventory", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const response = await client.listTools();
  await client.close();
  await server.close();

  return response.tools;
}

/**
 * Build `tool name -> source module` from the individual registration
 * functions. Each function is called with a minimal recorder.
 */
export async function captureModuleMap() {
  const map = new Map();
  for (const [file, fn] of TOOL_MODULES) {
    const mod = await importApp(`src/${file}`);
    const registrar = mod[fn];
    if (typeof registrar !== "function") {
      throw new Error(`Missing export ${fn} in app/src/${file}`);
    }
    const names = [];
    registrar({
      registerTool(name) {
        names.push(name);
      },
    });
    for (const name of names) {
      if (map.has(name)) throw new Error(`Tool ${name} registered by multiple modules`);
      map.set(name, file);
    }
  }
  return map;
}

// ---------- derivation ----------

/**
 * Derive a coarse risk tier from standard MCP annotations. This mirrors the
 * completed annotations produced by `completeToolAnnotations`.
 */
export function deriveRisk(annotations = {}) {
  if (annotations.readOnlyHint === true) return "read-only";
  if (annotations.destructiveHint === true) return "destructive";
  return "mutating";
}

// Caution rank for the derived `risk` string. No numeric order exists in
// `deriveRisk` or in `app/src/tool-contracts.js`. `deriveRisk` above maps
// annotations onto exactly three labels:
//   readOnlyHint === true         → "read-only"
//   else destructiveHint === true → "destructive"
//   else                          → "mutating"
// Rank is weakest caution → strongest caution. A lower live rank understates
// the tool and is a downgrade. The same rank is allowed. A higher live rank
// (stronger caution) is allowed.
//   read-only (0) < mutating (1) < destructive (2)
export const RISK_RANK = Object.freeze({
  "read-only": 0,
  mutating: 1,
  destructive: 2,
});

// Safety-hint weakening. "Stronger" means a louder caution, not a larger
// boolean. Sources: MCP ToolAnnotations, and `completeToolAnnotations` in
// `app/src/tool-contracts.js` (read-only forces destructiveHint false and
// idempotentHint true; openWorldHint stays false unless explicitly true).
//   destructiveHint: true warns of destructive updates. Weakening is true→false.
//   idempotentHint: false warns that repeats can add effects. Weakening is
//     false→true (newly claiming that retries are safe).
//   openWorldHint: true warns of an open world of external entities.
//     Weakening is true→false.
// The opposite direction is a stronger warning and is allowed. Equal is allowed.
const HINT_WEAKENING = Object.freeze({
  destructiveHint: Object.freeze({ from: true, to: false }),
  idempotentHint: Object.freeze({ from: false, to: true }),
  openWorldHint: Object.freeze({ from: true, to: false }),
});

function toolNameMap(tools, label, failures) {
  const map = new Map();
  if (!Array.isArray(tools)) {
    failures.push(`${label}.tools is not an array`);
    return map;
  }
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
      failures.push(`${label} tool is missing a name`);
      continue;
    }
    if (map.has(tool.name)) failures.push(`duplicate ${label} tool: ${tool.name}`);
    map.set(tool.name, tool);
  }
  return map;
}

function compareRisk(name, snapshotTool, liveTool, failures) {
  const snapshotRisk = snapshotTool.risk;
  const liveRisk = liveTool.risk;
  const snapshotRank = RISK_RANK[snapshotRisk];
  const liveRank = RISK_RANK[liveRisk];
  if (snapshotRank === undefined || liveRank === undefined) {
    failures.push(`A2 unknown risk: ${name} snapshot=${snapshotRisk} live=${liveRisk}`);
    return;
  }
  if (liveRank < snapshotRank) {
    failures.push(`A2 risk downgrade: ${name} snapshot=${snapshotRisk} live=${liveRisk}`);
  }
}

function compareScopes(name, snapshotTool, liveTool, failures) {
  if (!Array.isArray(snapshotTool.scope) || !Array.isArray(liveTool.scope)) {
    failures.push(`A3 scope is not an array: ${name}`);
    return;
  }
  const liveScopes = new Set(liveTool.scope);
  const removed = [...new Set(snapshotTool.scope)].filter((scope) => !liveScopes.has(scope)).sort();
  for (const scope of removed) failures.push(`A3 scope removed: ${name} missing=${scope}`);
}

function compareHints(name, snapshotTool, liveTool, failures) {
  const snapshotAnnotations = snapshotTool.annotations || {};
  const liveAnnotations = liveTool.annotations || {};
  for (const [hint, weakening] of Object.entries(HINT_WEAKENING)) {
    const before = snapshotAnnotations[hint];
    const after = liveAnnotations[hint];
    if (typeof before !== "boolean" || typeof after !== "boolean") {
      failures.push(`A4 hint is not boolean: ${name} ${hint}`);
      continue;
    }
    if (before === weakening.from && after === weakening.to) {
      failures.push(`A4 ${hint} weakened: ${name} ${String(before)} -> ${String(after)}`);
    }
  }
}

/**
 * Monotonic compatibility of a live inventory against a frozen evidence
 * snapshot. Returns a list of failure lines. Empty means the live catalog
 * only adds tools and only strengthens risk, scope, and safety hints.
 * Does not compare schema bytes or `toolchain`.
 */
export function compareInventoryMonotonicity(snapshot, live) {
  const failures = [];
  const snapshotTools = toolNameMap(snapshot?.tools, "snapshot", failures);
  const liveTools = toolNameMap(live?.tools, "live", failures);
  if (!Array.isArray(snapshot?.tools) || !Array.isArray(live?.tools)) return failures;

  const missing = [...snapshotTools.keys()].filter((name) => !liveTools.has(name)).sort();
  for (const name of missing) failures.push(`A1 missing tool: ${name}`);

  for (const [name, snapshotTool] of snapshotTools) {
    const liveTool = liveTools.get(name);
    if (!liveTool) continue;
    compareRisk(name, snapshotTool, liveTool, failures);
    compareScopes(name, snapshotTool, liveTool, failures);
    compareHints(name, snapshotTool, liveTool, failures);
  }
  return failures;
}

function schemaSummary(schema) {
  const json = canonicalJson(schema);
  const properties =
    schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
      ? Object.keys(schema.properties)
      : [];
  const requiredCount = schema && Array.isArray(schema.required) ? schema.required.length : 0;
  return {
    bytes: byteLength(json),
    sha256: sha256(json),
    propertyCount: properties.length,
    requiredCount,
    optionalCount: Math.max(properties.length - requiredCount, 0),
  };
}

/**
 * Produce the canonical inventory object. Pure with respect to its inputs so it
 * can be unit-tested with synthetic data.
 */
export function buildInventory({ toolsList, moduleMap, scopeRequirements, toolNames, toolchain }) {
  const names = toolsList.map((tool) => tool.name);
  const unique = new Set(names);
  const expected = new Set(toolNames);
  const missing = toolNames.filter((name) => !unique.has(name)).sort();
  const extra = [...unique].filter((name) => !expected.has(name)).sort();
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index).sort();
  const orderMatches = names.length === toolNames.length && names.every((name, i) => name === toolNames[i]);

  const order = new Map(toolNames.map((name, index) => [name, index]));
  const orderOf = (name) => order.get(name) ?? Number.MAX_SAFE_INTEGER;
  const sortedTools = [...toolsList].sort((a, b) => orderOf(a.name) - orderOf(b.name));

  const tools = sortedTools.map((tool) => {
    const scope = scopeRequirements[tool.name];
    if (!scope) throw new Error(`No Scope requirement registered for tool ${tool.name}`);
    const annotations = tool.annotations || {};
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      if (typeof annotations[hint] !== "boolean") {
        throw new Error(`Tool ${tool.name} is missing boolean annotation ${hint}`);
      }
    }
    const input = schemaSummary(tool.inputSchema);
    const output = schemaSummary(tool.outputSchema);
    return {
      name: tool.name,
      title: tool.title ?? "",
      module: moduleMap.get(tool.name) ?? "unknown",
      domain: "unknown",
      scope: [...scope],
      risk: deriveRisk(annotations),
      annotations,
      inputSchema: input,
      outputContract: {
        present: Boolean(tool.outputSchema),
        ...output,
      },
    };
  });

  const countBy = (keyFn) => {
    const counts = new Map();
    for (const tool of tools) {
      for (const key of [].concat(keyFn(tool))) {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => (a.count === b.count ? a.key.localeCompare(b.key) : b.count - a.count));
  };

  const totals = {
    tools: tools.length,
    inputSchemaBytes: tools.reduce((sum, tool) => sum + tool.inputSchema.bytes, 0),
    outputSchemaBytes: tools.reduce((sum, tool) => sum + tool.outputContract.bytes, 0),
  };

  return {
    schemaVersion: 1,
    phase: "phase-0-characterization",
    generator: "scripts/tool-inventory.mjs",
    mutability: "read-only; generated from current source without changing registration, authorization, or runtime behavior",
    evidence: { ...EVIDENCE },
    method: {
      inputSchemaBytes: {
        state: "canonical JSON text of the `tools/list` inputSchema",
        encoding: "UTF-8",
        canonicalization: "recursive lexicographic object-key sort; JSON.stringify with no insignificant whitespace",
        measurement: "Buffer.byteLength(canonicalJson, 'utf8')",
      },
      outputSchemaBytes: {
        state: "canonical JSON text of the `tools/list` outputSchema",
        encoding: "UTF-8",
        canonicalization: "same as inputSchemaBytes",
        measurement: "Buffer.byteLength(canonicalJson, 'utf8')",
      },
      digest: "sha256 hex over the canonical JSON text",
    },
    toolchain,
    parity: {
      toolNamesFromConfig: toolNames.length,
      toolsListed: names.length,
      uniqueToolNames: unique.size,
      duplicateNames: duplicates,
      missingVersusToolNames: missing,
      extraVersusToolNames: extra,
      registrationOrderMatchesToolNames: orderMatches,
    },
    totals,
    counts: {
      byModule: countBy((tool) => tool.module),
      byIndividualScope: countBy((tool) => tool.scope),
      byScopeSet: countBy((tool) => tool.scope.join("+")),
      byRisk: countBy((tool) => tool.risk),
      byOpenWorld: countBy((tool) => (tool.annotations.openWorldHint ? "open-world" : "closed-world")),
    },
    unknowns: [...UNKNOWNS],
    derived: [...DERIVED],
    tools,
  };
}

export async function collectInventory() {
  const { TOOL_NAMES } = await importApp("src/config.js");
  const { MCP_TOOL_SCOPE_REQUIREMENTS } = await importApp("src/scopes.js");
  const [toolsList, moduleMap, mcpSdkVersion, zodVersion] = await Promise.all([
    captureToolsList(),
    captureModuleMap(),
    readPackageVersion("@modelcontextprotocol/sdk"),
    readPackageVersion("zod"),
  ]);
  return buildInventory({
    toolsList,
    moduleMap,
    scopeRequirements: MCP_TOOL_SCOPE_REQUIREMENTS,
    toolNames: [...TOOL_NAMES],
    toolchain: {
      mcpSdk: mcpSdkVersion,
      zod: zodVersion,
      jsonSchemaDialect: "http://json-schema.org/draft-07/schema#",
      node: "excluded from deterministic payload",
    },
  });
}

// ---------- rendering ----------

function formatBytes(value) {
  return value.toLocaleString("en-US");
}

export function renderMarkdown(inventory) {
  const { parity, totals, counts } = inventory;
  const lines = [];
  lines.push("# MCP tool inventory — Progressive Tool Discovery Phase 0");
  lines.push("");
  lines.push(
    "Status: **characterization only** (candidate). This report describes the current eager,",
    "always-visible MCP tool catalog. It does **not** implement progressive discovery,",
    "dynamic loading, or any change to registration, authorization, or runtime behavior.",
  );
  lines.push("");
  lines.push(
    "Role: a checked-in copy of this report and `inventory.json` is a **historical evidence snapshot**,",
    "not a byte-for-byte gate. `node scripts/tool-inventory.mjs --check` does not require the snapshot",
    "to match a later generation. It asserts monotonic compatibility against `inventory.json`:",
    "the live tool-name set is a superset, derived risk is not downgraded, required scopes are not",
    "removed, and destructive / idempotent / open-world hints are not weakened.",
  );
  lines.push("");
  lines.push(`- Baseline: current main \`44e3828e6f38c953464580ed3b135cf771ae1912\` (85 tools).`);
  lines.push(`- Tools captured: **${parity.toolsListed}** (unique: ${parity.uniqueToolNames}; missing vs \`TOOL_NAMES\`: ${parity.missingVersusToolNames.length}; extra: ${parity.extraVersusToolNames.length}).`);
  lines.push(`- Total input-schema bytes: **${formatBytes(totals.inputSchemaBytes)}** (UTF-8, canonical JSON).`);
  lines.push(`- Total output-schema bytes: **${formatBytes(totals.outputSchemaBytes)}**.`);
  lines.push(`- Registration order matches \`TOOL_NAMES\`: **${parity.registrationOrderMatchesToolNames}**.`);
  if (!parity.registrationOrderMatchesToolNames) {
    lines.push("  - `tools/list` order follows the `registerObsidianCapabilities` registration sequence (info, notes, search, files, links, workflows, git, intelligence, publish, plans); it is a different order from the `TOOL_NAMES` constant. Parity below is asserted on the name **set**, and this report sorts rows by `TOOL_NAMES` for stable comparison.");
  }
  lines.push("");
  lines.push("## Regeneration");
  lines.push("");
  lines.push("From the repository root, on Node 20+ (validated on Node 24.16 and Node 26.3; `engines` requires >=20). Python 3 is not required by this generator:");
  lines.push("");
  lines.push("```sh");
  lines.push("cd app && npm ci");
  lines.push("cd .. && node scripts/tool-inventory.mjs            # rewrite the evidence snapshot (not the gate)");
  lines.push("node scripts/tool-inventory.mjs --check             # monotonic compatibility; does not write");
  lines.push("node scripts/tool-inventory.mjs --stdout            # print one generation; does not write");
  lines.push("node --test scripts/tool-inventory.test.mjs         # focused generator test");
  lines.push("```");
  lines.push("");
  lines.push("`--check` regenerates in memory and asserts monotonic compatibility against the frozen `inventory.json`. It does not compare these files byte-for-byte and it never writes. Two `--stdout` runs on the same tree are byte-identical; that identity is the generator's determinism check, not a requirement that the snapshot match a later catalog. The generator reads `app/` source only and never mutates the server or Vault.");
  lines.push("");
  lines.push("## Method and evidence source per field");
  lines.push("");
  lines.push("| Field | Evidence source |");
  lines.push("| --- | --- |");
  for (const [field, source] of Object.entries(inventory.evidence)) {
    lines.push(`| \`${field}\` | ${source} |`);
  }
  lines.push("");
  lines.push("### Byte measurement");
  lines.push("");
  lines.push(`- State: ${inventory.method.inputSchemaBytes.state}.`);
  lines.push(`- Encoding: ${inventory.method.inputSchemaBytes.encoding}.`);
  lines.push(`- Canonicalization: ${inventory.method.inputSchemaBytes.canonicalization}.`);
  lines.push(`- Measurement: \`${inventory.method.inputSchemaBytes.measurement}\`.`);
  lines.push(`- Digest: ${inventory.method.digest}.`);
  lines.push("");
  lines.push(`Toolchain: MCP SDK \`${inventory.toolchain.mcpSdk}\`, zod \`${inventory.toolchain.zod}\`, JSON Schema dialect \`${inventory.toolchain.jsonSchemaDialect}\`.`);
  lines.push("");
  lines.push("## Visibility and authorization baseline");
  lines.push("");
  lines.push(`- \`registerObsidianCapabilities\` registers all ${totals.tools} tools unconditionally; \`tools/list\` is not filtered by Scope, Vault allowlist, or \`OBSIDIAN_READ_ONLY\` in current source.`);
  lines.push("- Scope is enforced per `tools/call` (`app/src/auth.js` `requestedScopes` -> `requiredScopesForTools`), and `OBSIDIAN_READ_ONLY` rejects mutations at execution time (`app/src/vault.js`). A caller can therefore see a tool in `tools/list` and still be denied when calling it.");
  lines.push("- Any future Progressive Tool Discovery must preserve this separation: visibility is not authorization.");
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push("### By source module");
  lines.push("");
  lines.push("| Module | Tools |");
  lines.push("| --- | ---: |");
  for (const row of counts.byModule) lines.push(`| \`${row.key}\` | ${row.count} |`);
  lines.push("");
  lines.push("### By risk (derived from annotations)");
  lines.push("");
  lines.push("| Risk | Tools |");
  lines.push("| --- | ---: |");
  for (const row of counts.byRisk) lines.push(`| ${row.key} | ${row.count} |`);
  lines.push("");
  lines.push("Risk derivation: `read-only` = `readOnlyHint === true`; `destructive` = `destructiveHint === true`; otherwise `mutating`. MCP does not define a `risk` field.");
  lines.push("");
  lines.push("### By open-world hint");
  lines.push("");
  lines.push("| Hint | Tools |");
  lines.push("| --- | ---: |");
  for (const row of counts.byOpenWorld) lines.push(`| ${row.key} | ${row.count} |`);
  lines.push("");
  lines.push("### By individual Scope");
  lines.push("");
  lines.push("| Scope | Tools |");
  lines.push("| --- | ---: |");
  for (const row of counts.byIndividualScope) lines.push(`| \`${row.key}\` | ${row.count} |`);
  lines.push("");
  lines.push("### By Scope set");
  lines.push("");
  lines.push("| Scope set | Tools |");
  lines.push("| --- | ---: |");
  for (const row of counts.byScopeSet) lines.push(`| \`${row.key}\` | ${row.count} |`);
  lines.push("");
  lines.push("## Inventory");
  lines.push("");
  lines.push("| # | Tool | Module | Scope | Risk | In bytes | Out fields (req/opt) |");
  lines.push("| ---: | --- | --- | --- | --- | ---: | ---: |");
  inventory.tools.forEach((tool, index) => {
    const req = tool.outputContract.requiredCount;
    const opt = tool.outputContract.optionalCount;
    lines.push(
      `| ${index + 1} | \`${tool.name}\` | \`${tool.module}\` | \`${tool.scope.join(", ")}\` | ${tool.risk} | ${tool.inputSchema.bytes} | ${req}/${opt} |`,
    );
  });
  lines.push("");
  lines.push("## Values that cannot be extracted without a real `tools/list`");
  lines.push("");
  lines.push(
    "The authoritative wire shape (`inputSchema`, `outputSchema`, completed `annotations`,",
    "`title`, `description`, `execution`) is produced by the MCP SDK from the registered",
    "zod schemas. A raw source registry or the `inputSchema` raw shape alone would not give",
    "reproducible byte counts, because the SDK converts zod to JSON Schema and completes",
    "annotation defaults. This report therefore captures a **real `tools/list` response**,",
    "generated in-process from the production registration path.",
  );
  lines.push("");
  lines.push("Remaining gaps and unknowns:");
  lines.push("");
  for (const item of inventory.unknowns) {
    lines.push(`- **${item.field}** (${item.value}): ${item.reason}`);
  }
  lines.push("");
  lines.push("Derived fields:");
  lines.push("");
  for (const item of inventory.derived) {
    lines.push(`- **${item.field}**: ${item.reason}`);
  }
  lines.push("");
  lines.push("Additionally, a real *deployed* `tools/list` could differ from this local capture if the NAS checkout drifts from the tagged commit. This report does not claim production-verified parity.");
  lines.push("");
  lines.push("## Determinism");
  lines.push("");
  lines.push("The checked-in `inventory.json` and this report contain no timestamps or git revision identifiers and sort all object keys. They are a frozen historical snapshot. Regeneration on the same commit and lockfile is byte-identical with itself (`--stdout` twice), but that identity does not require this snapshot to match a later catalog. `node scripts/tool-inventory.mjs --check` enforces monotonic compatibility, not byte equality with this file.");
  lines.push("");
  return lines.join("\n");
}

// ---------- CLI ----------

async function main(argv) {
  const check = argv.includes("--check");
  const stdout = argv.includes("--stdout");
  const inventory = await collectInventory();
  const json = `${JSON.stringify(canonicalize(inventory), null, 2)}\n`;
  const markdown = renderMarkdown(inventory);

  if (stdout) {
    process.stdout.write(json);
    return 0;
  }

  if (check) {
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(JSON_PATH, "utf8"));
    } catch (error) {
      process.stderr.write(
        `tool-inventory --check failed\n- unreadable snapshot: ${path.relative(REPO_ROOT, JSON_PATH)} (${error.message})\n`,
      );
      return 1;
    }
    const failures = compareInventoryMonotonicity(snapshot, inventory);
    if (failures.length) {
      process.stderr.write(`tool-inventory --check failed\n${failures.map((line) => `- ${line}`).join("\n")}\n`);
      return 1;
    }
    const snapshotCount = Array.isArray(snapshot.tools) ? snapshot.tools.length : 0;
    process.stdout.write(
      `tool-inventory --check: monotonic compatibility holds (snapshot ${snapshotCount} tools, live ${inventory.tools.length} tools)\n`,
    );
    return 0;
  }

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(JSON_PATH, json, "utf8");
  await writeFile(MARKDOWN_PATH, markdown, "utf8");
  const { parity, totals } = inventory;
  process.stdout.write(
    `tool-inventory: ${parity.toolsListed} tools (unique ${parity.uniqueToolNames}), ` +
      `missing ${parity.missingVersusToolNames.length}, extra ${parity.extraVersusToolNames.length}, ` +
      `input-schema ${totals.inputSchemaBytes} bytes\n` +
      `wrote ${path.relative(REPO_ROOT, JSON_PATH)} and ${path.relative(REPO_ROOT, MARKDOWN_PATH)}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exit(1);
    },
  );
}
