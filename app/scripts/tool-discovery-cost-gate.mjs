#!/usr/bin/env node
// Progressive Tool Discovery — Phase 2C eval & cost gate (offline, deterministic).
//
// This harness answers a narrow, falsifiable question: given the current native
// `tools/list` descriptor set and the frozen 50 task fixtures, what do the
// already-implemented static discovery profiles (`full` / `core` / `module`)
// actually cost, what critical tool references do they fail to expose, and do
// they ever expose a tool the caller is not authorized to see?
//
// Hard boundaries (see docs/AGENT_EXECUTION_GUIDE.md and the discovery TODO):
//   * offline and read-only: it uses the in-memory MCP catalog and never connects
//     to a live server, never calls a tool, and never touches the Vault;
//   * no new inventory / catalog / taxonomy is invented. `toolset` membership,
//     Scope and annotations come from the existing verified sources;
//   * static expected-tool membership is NOT reported as agent task success, and
//     destructive-annotation counts are NOT reported as an observed wrong-tool
//     selection rate;
//   * token numbers are byte/4 estimates, not tokenizer output;
//   * the gate is a real fail gate: it refuses to bless a production default
//     shrink from static coverage alone.
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
import { CAPABILITY_CATALOG, TOOLSET_TOOLS, toolsetForTool } from "../src/capability-catalog.js";
import { CORE_TOOL_NAMES, buildCapabilityPolicyView } from "../src/capability-policy.js";
import { parseDiscoveryOperatorConfig } from "../src/discovery-config.js";
import { createDiscoveryRuntimePolicy } from "../src/discovery-runtime.js";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";
import { generatedArtifactMismatch } from "./artifact-text.mjs";
import {
  DEFAULT_FIXTURE_PATH,
  loadFixtures,
  validateFixtures,
} from "./tool-discovery-eager.mjs";
import {
  DEFAULT_INVENTORY_PATH,
} from "./tool-discovery-production-eval.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(SCRIPT_DIR, "..");
export const REPO_DIR = path.resolve(APP_DIR, "..");
export const DEFAULT_OUT_DIR = path.join(REPO_DIR, "docs", "review", "tool-discovery", "p2c-cost-gate");
export const COST_GATE_JSON = "cost-gate.json";
export const COST_GATE_MD = "cost-gate.md";

export const COST_GATE_SCHEMA_VERSION = "1.0.0";
export const AUTHOR = "app/scripts/tool-discovery-cost-gate.mjs";
// Explicit, documented estimate. Never presented as tokenizer output.
export const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 4;
export const ESTIMATED_TOKEN_METHOD =
  "ceil(utf8 bytes / 4). A coarse byte/4 English heuristic; NO tokenizer was run, so this is an estimate only.";

const UTF8 = new TextEncoder();

export const ALL_SCOPES = Object.freeze(["obsidian.read", "obsidian.write", "obsidian.files"]);

export const SCOPE_SETS = Object.freeze([
  Object.freeze({ id: "read", scopes: Object.freeze(["obsidian.read"]), label: "read-only token" }),
  Object.freeze({ id: "read+files", scopes: Object.freeze(["obsidian.read", "obsidian.files"]), label: "read + file transfer" }),
  Object.freeze({ id: "read+write", scopes: Object.freeze(["obsidian.read", "obsidian.write"]), label: "read + write (no file transfer)" }),
  Object.freeze({ id: "all", scopes: ALL_SCOPES, label: "all three scopes" }),
]);

export const TOOLSET_IDS = Object.freeze(Object.keys(TOOLSET_TOOLS));

export function byteLength(value) {
  return UTF8.encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

export function estimatedTokens(bytes) {
  return Math.ceil(bytes / TOKEN_ESTIMATE_BYTES_PER_TOKEN);
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function digestJson(value) {
  const text = JSON.stringify(canonicalize(value));
  return {
    bytes: byteLength(text),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function histogram(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

export function percentile(sortedNumbers, fraction) {
  if (!sortedNumbers.length) return null;
  const index = Math.min(sortedNumbers.length - 1, Math.max(0, Math.ceil(fraction * sortedNumbers.length) - 1));
  return sortedNumbers[index];
}

// --- catalog + descriptor measurement ---------------------------------------------

// Build a name -> descriptor map plus every budget figure this slice reports. The
// descriptors must come from a real native `client.listTools()` handshake (Wave 1
// method), not from the static catalog.
export function measureCatalog(descriptors) {
  const byName = new Map(descriptors.map((tool) => [tool.name, tool]));
  const annotations = { readOnlyHint: 0, destructiveHint: 0, idempotentHint: 0, openWorldHint: 0 };
  const risk = { readOnly: 0, destructive: 0, mutating: 0 };
  const scopeHistogram = new Map();
  let descriptorBytes = 0;
  let inputSchemaBytes = 0;
  let outputSchemaBytes = 0;
  const perTool = [];
  for (const tool of descriptors) {
    const descriptor = byteLength(JSON.stringify(tool));
    const input = tool.inputSchema ? byteLength(JSON.stringify(tool.inputSchema)) : 0;
    const output = tool.outputSchema ? byteLength(JSON.stringify(tool.outputSchema)) : 0;
    descriptorBytes += descriptor;
    inputSchemaBytes += input;
    outputSchemaBytes += output;
    for (const key of Object.keys(annotations)) if (tool.annotations?.[key] === true) annotations[key] += 1;
    if (tool.annotations?.readOnlyHint === true) risk.readOnly += 1;
    else if (tool.annotations?.destructiveHint === true) risk.destructive += 1;
    else risk.mutating += 1;
    const scopes = MCP_TOOL_SCOPE_REQUIREMENTS[tool.name] || [];
    const scopeKey = scopes.join("+");
    scopeHistogram.set(scopeKey, (scopeHistogram.get(scopeKey) || 0) + 1);
    perTool.push({ name: tool.name, descriptorBytes: descriptor, inputSchemaBytes: input, outputSchemaBytes: output, scopes });
  }
  return {
    byName,
    toolCount: descriptors.length,
    nativeOrder: descriptors.map((tool) => tool.name),
    descriptorBytes,
    inputSchemaBytes,
    outputSchemaBytes,
    toolsListPayloadBytes: byteLength({ tools: descriptors }),
    estimatedTokens: estimatedTokens(descriptorBytes),
    annotations,
    risk,
    scopeHistogram: Object.fromEntries([...scopeHistogram.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    perTool: perTool.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

function costOfNames(names, catalog) {
  let descriptorBytes = 0;
  let inputSchemaBytes = 0;
  let outputSchemaBytes = 0;
  for (const name of names) {
    const tool = catalog.byName.get(name);
    if (!tool) throw new Error(`Profile references a tool absent from the native catalog: ${name}`);
    descriptorBytes += byteLength(JSON.stringify(tool));
    inputSchemaBytes += tool.inputSchema ? byteLength(JSON.stringify(tool.inputSchema)) : 0;
    outputSchemaBytes += tool.outputSchema ? byteLength(JSON.stringify(tool.outputSchema)) : 0;
  }
  return {
    descriptorBytes,
    inputSchemaBytes,
    outputSchemaBytes,
    estimatedTokens: estimatedTokens(descriptorBytes),
  };
}

// --- native order vs canonical membership order -----------------------------------
//
// There are two genuinely different orders and they must never be conflated:
//
//   * canonical membership order (`TOOL_NAMES`, config.js) — the immutable set and
//     order the server uses for `server_info.tools` and the Scope truth tables;
//   * native wire order — the order the pinned MCP SDK actually registers and emits
//     from `tools/list`, which is what a host/model receives.
//
// The earlier slice compared the full *policy* view (itself derived from TOOL_NAMES)
// to TOOL_NAMES and called that "native registration-order parity". That is circular
// evidence: it never observed the native wire order. This harness now captures the
// raw native `tools/list` handshake and compares the real wired runtime filter output
// against it, in order and deep-equal, before the gate can pass.

export function applyViewToNativeDescriptors(descriptors, visibleNames) {
  // Filter a native descriptor array by an allow-set, preserving the input order.
  // This is the same membership-only transform the runtime installs on tools/list.
  const visible = visibleNames instanceof Set ? visibleNames : new Set(visibleNames);
  return descriptors.filter((tool) => visible.has(tool.name));
}

async function inMemoryListTools(connectServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-discovery-cost-gate-probe", version: "1.0.0" });
  let server;
  try {
    server = connectServer();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }
}

// Raw native `tools/list`, in the exact SDK registration order. Never sorted.
export async function captureRawNativeCatalog() {
  return inMemoryListTools(() => {
    const server = new McpServer({ name: "tool-discovery-cost-gate-native", version: "1.0.0" });
    registerObsidianCapabilities(server);
    return server;
  });
}

// The real wired runtime path: createDiscoveryRuntimePolicy + registerObsidianCapabilities,
// all scopes granted (authDisabled), so the returned array is what a host would actually
// receive for the given operator profile before any Scope reduction.
export async function captureWiredRuntimeCatalog(policy) {
  const operatorConfig = parseDiscoveryOperatorConfig({
    MCP_DISCOVERY_PROFILE: policy.profile,
    MCP_DISCOVERY_TOOLSETS: (policy.toolsets || []).join(","),
    MCP_DISCOVERY_TOOLS: (policy.tools || []).join(","),
    MCP_DISCOVERY_DENY_TOOLS: (policy.denyTools || []).join(","),
  });
  return inMemoryListTools(() => {
    const server = new McpServer({ name: "tool-discovery-cost-gate-wired", version: "1.0.0" });
    const discovery = createDiscoveryRuntimePolicy(server, operatorConfig, { authDisabled: true });
    registerObsidianCapabilities(discovery);
    discovery.install();
    return server;
  });
}

// --- profiles ---------------------------------------------------------------------

export function fixedProfileDefinitions() {
  const defs = [
    { id: "full", policy: { profile: "full" } },
    { id: "core", policy: { profile: "core" } },
  ];
  for (const toolset of TOOLSET_IDS) {
    defs.push({ id: `module:${toolset}`, policy: { profile: "module", toolsets: [toolset] } });
  }
  return defs;
}

function viewNames(policy, scopes = ALL_SCOPES) {
  return buildCapabilityPolicyView({ grantedScopes: [...scopes], ...policy }).toolNames;
}

// --- fixture coverage -------------------------------------------------------------

function expectedRefs(fixtures) {
  return fixtures.flatMap((task) => (task.expectedTools || []).map((tool) => ({ taskId: task.taskId, category: task.category, tool })));
}

function coverageAgainstVisible(visibleNames, fixtures) {
  const visible = new Set(visibleNames);
  const refs = expectedRefs(fixtures);
  const missing = refs.filter((ref) => !visible.has(ref.tool));
  const fullyCovered = fixtures.filter((task) => (task.expectedTools || []).every((name) => visible.has(name)));
  const byCategory = {};
  for (const task of fixtures) {
    const bucket = byCategory[task.category] || (byCategory[task.category] = { fixtures: 0, expectedRefs: 0, missingRefs: 0, fullyCovered: 0 });
    bucket.fixtures += 1;
    const expected = task.expectedTools || [];
    const missingHere = expected.filter((name) => !visible.has(name));
    bucket.expectedRefs += expected.length;
    bucket.missingRefs += missingHere.length;
    if (missingHere.length === 0) bucket.fullyCovered += 1;
  }
  const alternativeVisible = fixtures.flatMap((task) => task.alternativeTools || []).filter((name) => visible.has(name)).length;
  const alternativeTotal = fixtures.flatMap((task) => task.alternativeTools || []).length;
  const readOnlyFixtures = fixtures.filter((task) => (task.safetyExpectations || []).includes("read-only"));
  return {
    fixtures: fixtures.length,
    expectedRefs: refs.length,
    expectedVisibleRefs: refs.length - missing.length,
    criticalToolRecall: refs.length ? (refs.length - missing.length) / refs.length : null,
    fullyCoveredFixtures: fullyCovered.length,
    fullyCoveredRate: fixtures.length ? fullyCovered.length / fixtures.length : null,
    missingCriticalRefs: missing.length,
    missingCritical: missing,
    alternativeVisibleRefs: alternativeVisible,
    alternativeRefs: alternativeTotal,
    readOnlyFixtures: readOnlyFixtures.length,
    byCategory,
  };
}

function riskExposure(visibleNames, catalog) {
  const scopesFor = (name) => MCP_TOOL_SCOPE_REQUIREMENTS[name] || [];
  const descriptorFor = (name) => catalog.byName.get(name);
  const readOnly = visibleNames.filter((name) => descriptorFor(name)?.annotations?.readOnlyHint === true);
  const destructive = visibleNames.filter((name) => descriptorFor(name)?.annotations?.destructiveHint === true);
  const mutating = visibleNames.filter((name) => {
    const annotations = descriptorFor(name)?.annotations || {};
    return annotations.readOnlyHint !== true && annotations.destructiveHint !== true;
  });
  return {
    readOnlyVisible: readOnly.length,
    destructiveVisible: destructive.length,
    mutatingVisible: mutating.length,
    nonReadOnlyVisible: visibleNames.length - readOnly.length,
    writeScopedVisible: visibleNames.filter((name) => scopesFor(name).includes("obsidian.write")).length,
    filesScopedVisible: visibleNames.filter((name) => scopesFor(name).includes("obsidian.files")).length,
  };
}

function evaluateFixedProfile(definition, catalog, fixtures, allScopesView) {
  const names = viewNames(definition.policy);
  const cost = costOfNames(names, catalog);
  const coverage = coverageAgainstVisible(names, fixtures);
  const hidden = TOOL_NAMES.filter((name) => !names.includes(name));
  return {
    id: definition.id,
    policy: definition.policy,
    toolCount: names.length,
    hiddenToolCount: hidden.length,
    toolNames: names,
    cost,
    reductionVsFull: {
      hiddenTools: hidden.length,
      descriptorBytesSaved: allScopesView.catalog.descriptorBytes - cost.descriptorBytes,
      descriptorBytesReduction: allScopesView.catalog.descriptorBytes
        ? (allScopesView.catalog.descriptorBytes - cost.descriptorBytes) / allScopesView.catalog.descriptorBytes
        : null,
    },
    coverage,
    riskExposure: riskExposure(names, catalog),
  };
}

// --- module-oracle (per-fixture minimal toolset cover) -----------------------------

function moduleOracle(fixtures, catalog) {
  const rows = [];
  for (const task of fixtures) {
    const toolsets = sortedUnique((task.expectedTools || []).map((name) => toolsetForTool(name)).filter(Boolean));
    const names = viewNames({ profile: "module", toolsets });
    const visible = new Set(names);
    const missing = (task.expectedTools || []).filter((name) => !visible.has(name));
    rows.push({
      taskId: task.taskId,
      category: task.category,
      toolsets,
      toolCount: names.length,
      descriptorBytes: costOfNames(names, catalog).descriptorBytes,
      coversExpected: missing.length === 0,
      missing,
    });
  }
  const sortedCosts = rows.map((row) => row.descriptorBytes).sort((a, b) => a - b);
  const sortedCounts = rows.map((row) => row.toolCount).sort((a, b) => a - b);
  return {
    semantics:
      "Upper-bound diagnostic: for each fixture, the union of the verified source-module toolsets that contains every expected tool. This is NOT a deployable fixed policy and NOT an observed discovery outcome; per-fixture it proves only that toolset granularity can express the expected tools.",
    fixtures: rows.length,
    toolsetsNeededHistogram: histogram(rows.map((row) => row.toolsets.join("+"))),
    allCoverExpected: rows.every((row) => row.coversExpected),
    descriptorBytesTotal: rows.reduce((sum, row) => sum + row.descriptorBytes, 0),
    descriptorBytesMin: sortedCosts[0] ?? null,
    descriptorBytesP50: percentile(sortedCosts, 0.5),
    descriptorBytesP95: percentile(sortedCosts, 0.95),
    descriptorBytesMax: sortedCosts[sortedCosts.length - 1] ?? null,
    toolCountMin: sortedCounts[0] ?? null,
    toolCountMax: sortedCounts[sortedCounts.length - 1] ?? null,
    perFixture: rows,
  };
}

// --- best fixed module bundle (pure optimization over verified data) ---------------

// Exhaustive search over all 2^N toolset subsets for the smallest fixed `module`
// bundle that statically exposes every fixture expected tool. This is a diagnostic
// optimizer over verified membership data, not a validated production default.
export function bestFixedModuleBundle(fixtures, catalog) {
  const refs = sortedUnique(expectedRefs(fixtures).map((ref) => ref.tool));
  const toolsets = TOOLSET_IDS;
  let best = null;
  for (let mask = 0; mask < 1 << toolsets.length; mask += 1) {
    const chosen = toolsets.filter((_, index) => mask & (1 << index));
    const visible = new Set(viewNames({ profile: "module", toolsets: chosen }));
    if (!refs.every((name) => visible.has(name))) continue;
    const cost = costOfNames([...visible], catalog);
    const candidate = { toolsets: chosen, toolCount: visible.size, descriptorBytes: cost.descriptorBytes };
    if (!best || candidate.descriptorBytes < best.descriptorBytes || (candidate.descriptorBytes === best.descriptorBytes && candidate.toolCount < best.toolCount)) {
      best = candidate;
    }
  }
  return best
    ? {
        ...best,
        totalToolsets: toolsets.length,
        toolsetsOmitted: toolsets.filter((toolset) => !best.toolsets.includes(toolset)),
        descriptorBytesReduction: catalog.descriptorBytes ? (catalog.descriptorBytes - best.descriptorBytes) / catalog.descriptorBytes : null,
        semantics:
          "Smallest fixed module bundle (by descriptor bytes) that statically exposes all fixture expected tools. Static coverage is necessary but not sufficient for a default shrink; see gate.",
      }
    : null;
}

// --- scope-negative matrix ---------------------------------------------------------

function authorizedNamesFor(scopes) {
  return new Set(viewNames({ profile: "full" }, scopes));
}

export function scopeMatrix(catalog, fixtures) {
  const refs = expectedRefs(fixtures);
  const rows = [];
  for (const definition of fixedProfileDefinitions()) {
    for (const scopeSet of SCOPE_SETS) {
      const authorized = authorizedNamesFor(scopeSet.scopes);
      const names = viewNames(definition.policy, scopeSet.scopes);
      const leaks = names.filter((name) => !authorized.has(name));
      const expectedRefsHidden = refs.filter((ref) => !names.includes(ref.tool) && authorized.has(ref.tool)).length;
      const expectedRefsHiddenByAuthorization = refs.filter((ref) => !authorized.has(ref.tool)).length;
      rows.push({
        profile: definition.id,
        scopeSet: scopeSet.id,
        visibleCount: names.length,
        authorizedCount: authorized.size,
        leaks,
        expectedRefsVisible: refs.filter((ref) => names.includes(ref.tool)).length,
        expectedRefsHiddenByProfile: expectedRefsHidden,
        expectedRefsHiddenByAuthorization,
      });
    }
  }
  return {
    semantics:
      "Authorization is checked before policy. `leaks` must always be empty: policy may only remove tools, never expose one the granted scopes do not authorize. expectedRefsHiddenByAuthorization counts fixture expected tools a reduced-scope caller is not authorized to see; that is correct authorization behavior, not a discovery miss.",
    scopeSets: SCOPE_SETS,
    profilesEvaluated: fixedProfileDefinitions().map((definition) => definition.id),
    leakTotal: rows.reduce((sum, row) => sum + row.leaks.length, 0),
    rows,
  };
}

// --- baseline limits / honesty -----------------------------------------------------

export function baselineLimits({ fixtures, catalog, inventory, fixtureFile }) {
  const referenced = new Set(fixtures.flatMap((task) => [...(task.expectedTools || []), ...(task.alternativeTools || [])]));
  const inventoryNames = new Set((inventory?.tools || []).map((tool) => tool.name));
  const additiveTools = TOOL_NAMES.filter((name) => !inventoryNames.has(name));
  const missingHistorical = [...inventoryNames].filter((name) => !TOOL_NAMES.includes(name));
  return {
    currentCatalogToolCount: catalog.toolCount,
    historicalInventoryToolCount: inventoryNames.size,
    fixtureBaseline: {
      toolCatalog: fixtureFile?.basedOn?.toolCatalog ?? "unknown",
      commit: fixtureFile?.basedOn?.commit ?? "unknown",
      taskCount: fixtures.length,
    },
    additiveToolsSinceFixtureBaseline: additiveTools,
    historicalInventoryMissingFromCurrentCatalog: missingHistorical,
    toolsUnreferencedByFixtures: TOOL_NAMES.filter((name) => !referenced.has(name)),
    notes: [
      "The 50 task fixtures were authored against the historical 85-tool catalog recorded in docs/review/tool-discovery/inventory.json. The current native catalog is larger; this slice does NOT rebuild the inventory or rewrite the fixtures.",
      "Any tool that appears after the fixture baseline (for example get_note_context) is additive: it is not referenced by any fixture, so its absence from per-fixture coverage is a fixture coverage gap, not evidence about the tool.",
      "Unreferenced tools are listed explicitly instead of being silently folded into a coverage percentage.",
    ],
  };
}

export function metricSemantics() {
  return {
    staticCoverageIsNotSuccess: true,
    criticalToolRecall:
      "Deterministic set membership: fixture expectedTools present in a profile's visible names. This is NOT end-to-end task success and was not produced by a model.",
    wrongToolRisk:
      "Counts of visible destructive/mutating-annotated and write-scoped tools (annotation/Scope-derived exposure). This is NOT an observed wrong-tool selection rate; no model ran.",
    estimatedTokens: ESTIMATED_TOKEN_METHOD,
    schemaCost: "utf8 bytes of JSON.stringify of the native descriptor / inputSchema / outputSchema from an in-memory client.listTools() handshake.",
    forbiddenToolCategories:
      "Unmeasured: fixtures declare forbidden tool categories, but no canonical category->tool mapping exists in the runtime. No mapping was invented for this slice.",
  };
}

// Runtime parity compares the *actual wired runtime output* (real discovery-runtime
// tools/list filter, all scopes) against the raw native descriptor array, in order
// and deep-equal. It also records how the native wire order differs positionally
// from the canonical membership order, so the distinction is visible in the report
// instead of being silently assumed to be the same.
export function evaluateRuntimeParity(nativeDescriptors, wiredDescriptors) {
  const nativeNames = nativeDescriptors.map((tool) => tool.name);
  const wiredNames = wiredDescriptors.map((tool) => tool.name);
  const sameLength = nativeNames.length === wiredNames.length;
  const namesDeepEqual = sameLength && nativeNames.every((name, index) => name === wiredNames[index]);
  const descriptorsDeepEqual =
    sameLength && JSON.stringify(nativeDescriptors) === JSON.stringify(wiredDescriptors);
  const nativeSet = new Set(nativeNames);
  const setEqualsCanonical =
    nativeNames.length === TOOL_NAMES.length && TOOL_NAMES.every((name) => nativeSet.has(name));
  return {
    nativeToolCount: nativeNames.length,
    wiredToolCount: wiredNames.length,
    nativeOrderDigest: digestJson(nativeNames).sha256,
    wiredOrderDigest: digestJson(wiredNames).sha256,
    fullProfileWiredNamesDeepEqualNative: namesDeepEqual,
    fullProfileWiredDescriptorsDeepEqualNative: descriptorsDeepEqual,
    fullProfileWiredMatchesNative: namesDeepEqual && descriptorsDeepEqual,
    nativeSetEqualsCanonicalMembership: setEqualsCanonical,
    positionalMismatchesVsCanonical: nativeNames.filter((name, index) => TOOL_NAMES[index] !== name).length,
    semantics:
      "`nativeRegistrationOrder` is the order the pinned SDK emits from raw tools/list. `canonicalMembershipOrder` (TOOL_NAMES) is the immutable membership/order used by server_info and Scope tables. The full-profile wired runtime output must deep-equal the raw native descriptor array in order; a pure-policy name comparison is not accepted as native-order evidence.",
  };
}

// --- gate -------------------------------------------------------------------------

export function costGateExitCode(decision) {
  return decision === "hold" ? 0 : 1;
}

// Real fail gate. Even a statically perfect fixed bundle cannot pass the default
// shrink check without end-to-end task-success evidence, because static expected-tool
// coverage is not task success.
export function evaluateGate(report) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass, detail });

  const runtimeParity = report.runtimeParity || {};
  const nativeOrder = report.catalog.nativeRegistrationOrder;
  const seamlessRuntimeEvidence =
    report.catalog.toolCount === TOOL_NAMES.length &&
    Array.isArray(nativeOrder) &&
    nativeOrder.length === TOOL_NAMES.length &&
    runtimeParity.fullProfileWiredMatchesNative === true &&
    runtimeParity.nativeSetEqualsCanonicalMembership === true &&
    // The recorded native wire order must be the one the wired runtime actually
    // emitted; a pure-policy-only or tampered native order cannot pass.
    runtimeParity.nativeOrderDigest === digestJson(nativeOrder).sha256 &&
    runtimeParity.wiredOrderDigest === runtimeParity.nativeOrderDigest;
  add(
    "catalog-integrity",
    seamlessRuntimeEvidence,
    `native catalog ${report.catalog.toolCount} tools; TOOL_NAMES ${TOOL_NAMES.length}; ` +
      `wired full-profile output deep-equals raw native descriptors in order=${runtimeParity.fullProfileWiredMatchesNative === true}; ` +
      `native wire order positional mismatches vs canonical membership=${runtimeParity.positionalMismatchesVsCanonical ?? "unknown"} (informational: membership order and wire order are distinct and both recorded)`,
  );

  const full = report.fixedProfiles.find((row) => row.id === "full");
  add(
    "full-passthrough",
    Boolean(full) && full.hiddenToolCount === 0 && full.coverage.criticalToolRecall === 1,
    full ? `full hides ${full.hiddenToolCount} tools; critical recall ${full.coverage.criticalToolRecall}` : "full profile missing",
  );

  add(
    "no-scope-escalation",
    report.scopeMatrix.leakTotal === 0,
    `scope x profile rows with a visibility leak: ${report.scopeMatrix.leakTotal}`,
  );

  add(
    "historical-inventory-preserved",
    report.baselineLimits.historicalInventoryMissingFromCurrentCatalog.length === 0,
    report.baselineLimits.historicalInventoryMissingFromCurrentCatalog.length === 0
      ? `all ${report.baselineLimits.historicalInventoryToolCount} historical inventory tools still registered`
      : `missing: ${report.baselineLimits.historicalInventoryMissingFromCurrentCatalog.join(", ")}`,
  );

  add(
    "fixture-contract",
    report.inputs.fixtureValidationOk === true && report.inputs.fixtureCount === 50,
    `fixtures valid=${report.inputs.fixtureValidationOk}, count=${report.inputs.fixtureCount}`,
  );

  const perfectStatic = report.fixedProfiles.filter(
    (row) => row.id !== "full" && row.coverage.criticalToolRecall === 1 && row.hiddenToolCount > 0,
  );
  const bestBundle = report.bestFixedModuleBundle;
  const staticCoverageExpressible = perfectStatic.length > 0 || Boolean(bestBundle);
  add(
    "static-coverage-expressible",
    staticCoverageExpressible,
    perfectStatic.length
      ? `profiles with full static critical coverage: ${perfectStatic.map((row) => row.id).join(", ")}`
      : bestBundle
        ? `best fixed module bundle statically covers every expected tool with ${bestBundle.toolCount}/86 tools (${pct(bestBundle.descriptorBytesReduction)} descriptor reduction); single-toolset/core profiles do not`
        : "no fixed profile or module bundle statically covers every expected tool",
  );

  add(
    "default-shrink-readiness",
    false,
    "HELD: the TODO requires end-to-end task-success (critical safety/recovery/auth) evidence before any production default shrink. This slice has no agent harness; static expected-tool coverage is explicitly not task success. Default stays `full`.",
  );

  add(
    "baseline-limit-disclosed",
    report.baselineLimits.notes.length > 0 &&
      report.baselineLimits.additiveToolsSinceFixtureBaseline.length >= 0 &&
      Array.isArray(report.baselineLimits.toolsUnreferencedByFixtures),
    `additive tools: ${report.baselineLimits.additiveToolsSinceFixtureBaseline.join(", ") || "(none)"}; unreferenced tools: ${report.baselineLimits.toolsUnreferencedByFixtures.length}`,
  );

  const blockers = checks.filter((check) => !check.pass).map((check) => `${check.id}: ${check.detail}`);
  return {
    decision: checks.every((check) => check.pass) ? "candidate-shrink" : "hold",
    productionDefaultProfile: "full",
    checks,
    blockers,
  };
}

// --- report assembly ---------------------------------------------------------------

export async function buildCostGateReport({
  fixturePath = DEFAULT_FIXTURE_PATH,
  inventoryPath = DEFAULT_INVENTORY_PATH,
  descriptors,
  wiredDescriptors,
  sourceCommit = null,
} = {}) {
  const fixtureFile = await loadFixtures(fixturePath);
  const validation = validateFixtures(fixtureFile);
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  // Raw native `tools/list`, in SDK registration order. `descriptors` is an injection
  // point for the permutation regression; it is never sorted by this harness.
  const native = descriptors || (await captureRawNativeCatalog());
  if (!Array.isArray(native) || !native.length) throw new Error("native catalog is empty");
  // Actual wired runtime output for the full profile (all scopes): the real
  // discovery-runtime filter path, not a policy-derived name list.
  const wiredFull = wiredDescriptors || (await captureWiredRuntimeCatalog({ profile: "full" }));

  const catalog = measureCatalog(native);
  const fixtures = Array.isArray(fixtureFile.tasks) ? fixtureFile.tasks : [];
  const fullView = { catalog };

  if (catalog.toolCount !== TOOL_NAMES.length) {
    throw new Error(`native catalog has ${catalog.toolCount} tools but TOOL_NAMES has ${TOOL_NAMES.length}`);
  }
  for (const name of TOOL_NAMES) {
    if (!catalog.byName.has(name)) throw new Error(`native catalog is missing TOOL_NAMES entry ${name}`);
    if (!MCP_TOOL_SCOPE_REQUIREMENTS[name]) throw new Error(`scopes.js is missing a scope mapping for ${name}`);
    if (!toolsetForTool(name)) throw new Error(`capability catalog is missing a toolset for ${name}`);
  }

  const runtimeParity = evaluateRuntimeParity(native, wiredFull);
  const baseline = baselineLimits({ fixtures, catalog, inventory, fixtureFile });
  const fixedProfiles = fixedProfileDefinitions().map((definition) => evaluateFixedProfile(definition, catalog, fixtures, fullView));
  const report = {
    schemaVersion: COST_GATE_SCHEMA_VERSION,
    generatedBy: AUTHOR,
    mode: "phase2c cost gate (offline static)",
    source: {
      commit: sourceCommit,
      commitIsInformational: true,
      exactSourceSha: null,
      provenance:
        "Offline, deterministic. Recomputable from the current worktree without a live server; the content digest is over everything except this `source` block. `commit` is the pre-generation HEAD and is informational only (generation predates the commit that ships the artifact); it is not an exact source digest.",
    },
    inputs: {
      fixturesPath: path.relative(REPO_DIR, fixturePath).replaceAll(path.sep, "/"),
      fixtureSchemaVersion: fixtureFile.schemaVersion || "unknown",
      fixtureCount: fixtures.length,
      fixtureValidationOk: validation.ok,
      fixtureValidationErrors: validation.errors,
      inventoryPath: path.relative(REPO_DIR, inventoryPath).replaceAll(path.sep, "/"),
      inventoryToolCount: (inventory.tools || []).length,
      catalogSource: "raw in-memory McpServer + registerObsidianCapabilities + client.listTools() (unsorted native wire order)",
      runtimeSource: "real createDiscoveryRuntimePolicy + registerObsidianCapabilities + client.listTools() (wired tools/list filter)",
    },
    catalog: {
      toolCount: catalog.toolCount,
      // Distinct orders, never conflated in the report or the gate:
      canonicalMembershipOrder: TOOL_NAMES,
      nativeRegistrationOrder: catalog.nativeOrder,
      // Back-compat alias kept only for the historical markdown renderer; equals
      // the canonical membership order, NOT the native wire order.
      toolNames: TOOL_NAMES,
      descriptorBytes: catalog.descriptorBytes,
      inputSchemaBytes: catalog.inputSchemaBytes,
      outputSchemaBytes: catalog.outputSchemaBytes,
      toolsListPayloadBytes: catalog.toolsListPayloadBytes,
      estimatedTokens: catalog.estimatedTokens,
      annotationCensus: { readOnly: catalog.risk.readOnly, destructive: catalog.risk.destructive, mutating: catalog.risk.mutating },
      scopeHistogram: catalog.scopeHistogram,
    },
    runtimeParity,
    metricSemantics: metricSemantics(),
    baselineLimits: baseline,
    scopeMatrix: scopeMatrix(catalog, fixtures),
    fixedProfiles,
    moduleOracle: moduleOracle(fixtures, catalog),
    bestFixedModuleBundle: bestFixedModuleBundle(fixtures, catalog),
    unmeasured: [
      "end-to-end agent task success (no model/agent harness in this slice)",
      "observed tool-selection precision/recall and wrong-tool selection rate",
      "latency (intentionally not captured)",
      "real tokenizer counts (only byte/4 estimates)",
      "forbiddenToolCategories -> tool mapping (no canonical runtime mapping; not invented)",
      "host/client deferred loading behavior (Phase 3 live host evidence)",
      "deployed-server scope enforcement (needs a scope-limited credential)",
    ],
    measured: [
      "raw native in-memory tools/list descriptor/inputSchema/outputSchema bytes per profile (native wire order)",
      "actual wired runtime tools/list output for the full profile, compared deep-equal to raw native descriptors in order",
      "native wire order vs canonical TOOL_NAMES membership order, both recorded distinctly",
      "static expected-tool coverage and missing critical references per profile",
      "annotation/Scope risk exposure per profile",
      "authorization x profile visibility matrix with leak detection",
      "per-fixture module-oracle cover cost and the smallest fixed module bundle",
    ],
  };
  report.gate = evaluateGate(report);
  // Deterministic over everything except the informational `source` block, so
  // `--verify` catches any catalog/fixture/policy/gate change.
  report.contentDigest = digestJson({ ...report, contentDigest: undefined, source: undefined });
  return report;
}

// --- markdown ----------------------------------------------------------------------

function pct(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function table(rows, headers) {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines;
}

export function formatCostGateMarkdown(report) {
  const lines = [];
  lines.push("# Progressive Tool Discovery — Phase 2C eval & cost gate");
  lines.push("");
  lines.push("Status: **candidate** (offline, deterministic branch artifact). Default production profile stays `full`.");
  lines.push(`Source commit: \`${report.source.commit ?? "uncommitted"}\`.`);
  lines.push("");
  lines.push("This slice is evaluation/evidence only. It changes no registration, no visibility default,");
  lines.push("no Scope truth, and no Vault behavior. It reuses the frozen 50 task fixtures and the native");
  lines.push("in-memory `tools/list` descriptors; it does not rebuild the inventory or catalog.");
  lines.push("");
  lines.push("## Gate decision");
  lines.push("");
  lines.push(`**Decision: \`${report.gate.decision}\`** — production default remains \`${report.gate.productionDefaultProfile}\`.`);
  lines.push("");
  lines.push(...table(report.gate.checks.map((check) => [`\`${check.id}\``, check.pass ? "pass" : "**fail**", check.detail]), ["Check", "Result", "Detail"]));
  lines.push("");
  if (report.gate.blockers.length) {
    lines.push("Blockers:");
    for (const blocker of report.gate.blockers) lines.push(`- ${blocker}`);
    lines.push("");
  }
  lines.push("## Catalog baseline");
  lines.push("");
  lines.push(`- Native catalog: **${report.catalog.toolCount}** tools; descriptor ${report.catalog.descriptorBytes} bytes (~${report.catalog.estimatedTokens} est. tokens); inputSchema ${report.catalog.inputSchemaBytes} bytes; outputSchema ${report.catalog.outputSchemaBytes} bytes.`);
  lines.push(`- Canonical membership order (\`TOOL_NAMES\`, \`server_info.tools\`, Scope tables): ${report.catalog.canonicalMembershipOrder.length} names — **immutable membership order, not the wire order**.`);
  lines.push(`- Native wire order (raw \`tools/list\`): positional mismatches vs canonical membership = **${report.runtimeParity.positionalMismatchesVsCanonical}**; set equality = \`${report.runtimeParity.nativeSetEqualsCanonicalMembership}\`. The two orders are recorded separately; neither is inferred from the other.`);
  lines.push(`- Wired runtime parity (full profile, all scopes): output deep-equals raw native descriptors in order = **${report.runtimeParity.fullProfileWiredMatchesNative}** (names ${report.runtimeParity.fullProfileWiredNamesDeepEqualNative}, descriptors ${report.runtimeParity.fullProfileWiredDescriptorsDeepEqualNative}).`);
  lines.push(`- Annotations: readOnly ${report.catalog.annotationCensus.readOnly}, destructive ${report.catalog.annotationCensus.destructive}, mutating ${report.catalog.annotationCensus.mutating}.`);
  lines.push(`- Historical inventory: ${report.baselineLimits.historicalInventoryToolCount} tools; additive since fixture baseline: ${report.baselineLimits.additiveToolsSinceFixtureBaseline.map((name) => `\`${name}\``).join(", ") || "(none)"}.`);
  lines.push(`- Fixture baseline: ${report.baselineLimits.fixtureBaseline.toolCatalog} (\`${report.baselineLimits.fixtureBaseline.commit}\`), ${report.baselineLimits.fixtureBaseline.taskCount} tasks.`);
  lines.push("");
  lines.push("## Profile cost x critical coverage");
  lines.push("");
  lines.push("`criticalToolRecall` is deterministic set membership of fixture expectedTools, **not** task success.");
  lines.push("");
  lines.push(...table(
    report.fixedProfiles.map((row) => [
      `\`${row.id}\``,
      String(row.toolCount),
      String(row.hiddenToolCount),
      String(row.cost.descriptorBytes),
      `~${row.cost.estimatedTokens}`,
      pct(row.reductionVsFull.descriptorBytesReduction),
      pct(row.coverage.criticalToolRecall),
      `${row.coverage.fullyCoveredFixtures}/${row.coverage.fixtures}`,
      String(row.coverage.missingCriticalRefs),
    ]),
    ["Profile", "Visible", "Hidden", "Descriptor B", "Est. tokens", "Bytes saved", "Critical recall", "Fixtures fully covered", "Missing critical refs"],
  ));
  lines.push("");
  lines.push("### Wrong/missing-tool exposure (annotation/Scope derived, not a selection rate)");
  lines.push("");
  lines.push(...table(
    report.fixedProfiles.map((row) => [
      `\`${row.id}\``,
      String(row.riskExposure.readOnlyVisible),
      String(row.riskExposure.destructiveVisible),
      String(row.riskExposure.mutatingVisible),
      String(row.riskExposure.writeScopedVisible),
      String(row.riskExposure.filesScopedVisible),
    ]),
    ["Profile", "readOnly visible", "destructive visible", "mutating visible", "write-scoped visible", "files-scoped visible"],
  ));
  lines.push("");
  lines.push("## Module oracle (upper bound, not a deployment)");
  lines.push("");
  lines.push(`- All fixtures expressible by a toolset union: **${report.moduleOracle.allCoverExpected}**.`);
  lines.push(`- Per-fixture cover descriptor bytes: min ${report.moduleOracle.descriptorBytesMin}, p50 ${report.moduleOracle.descriptorBytesP50}, p95 ${report.moduleOracle.descriptorBytesP95}, max ${report.moduleOracle.descriptorBytesMax}.`);
  lines.push("");
  lines.push("## Best fixed module bundle (diagnostic optimizer)");
  lines.push("");
  if (report.bestFixedModuleBundle) {
    const bundle = report.bestFixedModuleBundle;
    lines.push(`- Toolsets: ${bundle.toolsets.map((value) => `\`${value}\``).join(", ")}.`);
    lines.push(`- Omitted toolsets: ${bundle.toolsetsOmitted.map((value) => `\`${value}\``).join(", ") || "(none)"}.`);
    lines.push(`- Visible tools ${bundle.toolCount}; descriptor ${bundle.descriptorBytes} bytes; descriptor reduction vs full ${pct(bundle.descriptorBytesReduction)}.`);
  } else {
    lines.push("- None found.");
  }
  lines.push("");
  lines.push("## Scope-negative matrix");
  lines.push("");
  lines.push(`- Visibility leaks across all profile x scope rows: **${report.scopeMatrix.leakTotal}** (must be 0).`);
  lines.push("");
  lines.push(...table(
    report.scopeMatrix.rows.map((row) => [
      `\`${row.profile}\``,
      `\`${row.scopeSet}\``,
      String(row.visibleCount),
      String(row.authorizedCount),
      String(row.leaks.length),
      String(row.expectedRefsVisible),
      String(row.expectedRefsHiddenByProfile),
      String(row.expectedRefsHiddenByAuthorization),
    ]),
    ["Profile", "Scopes", "Visible", "Authorized", "Leaks", "Expected refs visible", "Hidden by profile", "Hidden by authorization"],
  ));
  lines.push("");
  lines.push("## Fixture coverage by category (full profile)");
  lines.push("");
  const full = report.fixedProfiles.find((row) => row.id === "full");
  lines.push(...table(
    Object.entries(full.coverage.byCategory).map(([category, bucket]) => [
      `\`${category}\``,
      String(bucket.fixtures),
      String(bucket.expectedRefs),
      String(bucket.missingRefs),
      String(bucket.fullyCovered),
    ]),
    ["Category", "Fixtures", "Expected refs", "Missing refs", "Fully covered"],
  ));
  lines.push("");
  lines.push("## Baseline limits and honesty");
  lines.push("");
  for (const note of report.baselineLimits.notes) lines.push(`- ${note}`);
  lines.push(`- Tools not referenced by fixtures (${report.baselineLimits.toolsUnreferencedByFixtures.length}): ${report.baselineLimits.toolsUnreferencedByFixtures.map((name) => `\`${name}\``).join(", ")}.`);
  lines.push("");
  lines.push("### Metric semantics");
  lines.push("");
  for (const [key, value] of Object.entries(report.metricSemantics)) lines.push(`- \`${key}\`: ${value}`);
  lines.push("");
  lines.push("### Unmeasured");
  lines.push("");
  for (const item of report.unmeasured) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`Content digest (excludes \`source\`): \`${report.contentDigest.sha256}\` (${report.contentDigest.bytes} bytes).`);
  lines.push("");
  return lines.join("\n");
}

// --- offline verification ----------------------------------------------------------

// Recompute the report from the current worktree and compare it byte-for-byte with
// the checked-in artifact (ignoring the informational `source` block). This is a real
// gate: any change to the catalog, fixtures, policy or gate logic fails until the
// artifact is regenerated.
export async function verifyCheckedInArtifacts({ outDir = DEFAULT_OUT_DIR, fixturePath = DEFAULT_FIXTURE_PATH, inventoryPath = DEFAULT_INVENTORY_PATH } = {}) {
  const errors = [];
  let checkedIn;
  try {
    checkedIn = JSON.parse(await readFile(path.join(outDir, COST_GATE_JSON), "utf8"));
  } catch {
    return { ok: false, errors: [`${COST_GATE_JSON} missing or unreadable`] };
  }
  // Reuse the artifact's informational commit so the freshly formatted Markdown (which
  // displays that commit) is comparable. The commit is informational only; the content
  // digest deliberately excludes the whole `source` block.
  const expected = await buildCostGateReport({ fixturePath, inventoryPath, sourceCommit: checkedIn.source?.commit ?? null });
  if (checkedIn.generatedBy !== AUTHOR) errors.push(`artifact generatedBy is not ${AUTHOR}`);
  if (checkedIn.schemaVersion !== COST_GATE_SCHEMA_VERSION) errors.push(`artifact schemaVersion is ${checkedIn.schemaVersion}`);
  if (checkedIn.gate?.decision !== "hold") errors.push(`checked-in gate decision is "${checkedIn.gate?.decision}"; this slice must hold the production default at full`);
  if (checkedIn.gate?.productionDefaultProfile !== "full") errors.push("checked-in gate does not keep the production default at full");
  // Provenance honesty: the git commit recorded at generation predates the commit
  // that ships the artifact, so it is informational and never an exact source SHA.
  if (checkedIn.source?.commitIsInformational !== true) errors.push("artifact.source.commitIsInformational must be true");
  if (checkedIn.source?.exactSourceSha !== null) errors.push("artifact.source.exactSourceSha must be null (generation cannot know its own shipping commit)");
  // The two orders must be recorded distinctly and the wired runtime parity must
  // be real evidence, so a pure-policy-only artifact cannot verify.
  if (!Array.isArray(checkedIn.catalog?.canonicalMembershipOrder) || checkedIn.catalog.canonicalMembershipOrder.length !== TOOL_NAMES.length) {
    errors.push("artifact.catalog.canonicalMembershipOrder missing or wrong length");
  }
  if (!Array.isArray(checkedIn.catalog?.nativeRegistrationOrder) || checkedIn.catalog.nativeRegistrationOrder.length !== TOOL_NAMES.length) {
    errors.push("artifact.catalog.nativeRegistrationOrder missing or wrong length");
  }
  if (checkedIn.runtimeParity?.fullProfileWiredMatchesNative !== true) {
    errors.push("artifact.runtimeParity.fullProfileWiredMatchesNative must be true (wired runtime output must deep-equal raw native descriptors)");
  }
  const checkedInDigest = digestJson({ ...checkedIn, contentDigest: undefined, source: undefined });
  if (checkedInDigest.sha256 !== expected.contentDigest.sha256) {
    errors.push(`artifact content digest ${checkedInDigest.sha256} != freshly recomputed ${expected.contentDigest.sha256}; regenerate with --write`);
  }
  if (checkedIn.contentDigest?.sha256 !== checkedInDigest.sha256) errors.push("artifact contentDigest field is not self-consistent");
  // Markdown is generated from the same report; a hand-edited or stale Markdown
  // artifact must fail verification even when the JSON happens to match.
  try {
    const checkedInMd = await readFile(path.join(outDir, COST_GATE_MD), "utf8");
    const expectedMd = `${formatCostGateMarkdown(expected)}\n`;
    // CRLF checkout is equivalent to the committed LF blob; any other edit must fail.
    const mismatch = generatedArtifactMismatch(checkedInMd, expectedMd);
    if (mismatch) {
      errors.push(`${COST_GATE_MD} does not match the freshly formatted report (${mismatch}); regenerate with --write`);
    }
  } catch {
    errors.push(`${COST_GATE_MD} missing or unreadable`);
  }
  return { ok: errors.length === 0, errors, freshDigest: expected.contentDigest.sha256, checkedInDigest: checkedInDigest.sha256, gateDecision: expected.gate.decision, toolCount: expected.catalog.toolCount };
}

// --- CLI ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = { mode: "report", outDir: DEFAULT_OUT_DIR, fixturePath: DEFAULT_FIXTURE_PATH, inventoryPath: DEFAULT_INVENTORY_PATH, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--json") options.json = true;
    else if (arg === "--write") options.mode = "write";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--out-dir") options.outDir = path.resolve(next() || "");
    else if (arg.startsWith("--out-dir=")) options.outDir = path.resolve(arg.slice("--out-dir=".length));
    else if (arg === "--fixtures") options.fixturePath = path.resolve(next() || "");
    else if (arg.startsWith("--fixtures=")) options.fixturePath = path.resolve(arg.slice("--fixtures=".length));
    else if (arg === "--inventory") options.inventoryPath = path.resolve(next() || "");
    else if (arg.startsWith("--inventory=")) options.inventoryPath = path.resolve(arg.slice("--inventory=".length));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function resolveSourceCommit() {
  try {
    const { execFileSync } = await import("node:child_process");
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_DIR, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node app/scripts/tool-discovery-cost-gate.mjs [--json|--write|--verify]");
    console.log("  --fixtures <path>   fixture file (default app/test/fixtures/tool-discovery-eager-tasks.json)");
    console.log("  --inventory <path>  historical inventory (read-only baseline limits)");
    console.log("  --out-dir <path>    artifact output directory");
    console.log("  --json              print the full report as JSON");
    console.log("  --write             regenerate docs/review/tool-discovery/p2c-cost-gate/{cost-gate.json,cost-gate.md}");
    console.log("  --verify            recompute offline and compare with the checked-in artifact");
    return 0;
  }
  if (options.mode === "verify") {
    const verification = await verifyCheckedInArtifacts(options);
    console.log(verification.ok
      ? `verify: ok (${verification.toolCount} tools, gate ${verification.gateDecision}, digest ${verification.freshDigest})`
      : `verify: failed\n${verification.errors.map((error) => `- ${error}`).join("\n")}`);
    return verification.ok ? 0 : 1;
  }

  const report = await buildCostGateReport({
    fixturePath: options.fixturePath,
    inventoryPath: options.inventoryPath,
    sourceCommit: await resolveSourceCommit(),
  });
  if (options.mode === "write") {
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path.join(options.outDir, COST_GATE_JSON), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(options.outDir, COST_GATE_MD), `${formatCostGateMarkdown(report)}\n`, "utf8");
    console.log(`wrote ${COST_GATE_JSON} + ${COST_GATE_MD} (gate ${report.gate.decision}, digest ${report.contentDigest.sha256})`);
  } else if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCostGateMarkdown(report));
  }
  return costGateExitCode(report.gate.decision);
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
