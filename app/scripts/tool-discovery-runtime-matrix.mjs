#!/usr/bin/env node
// Progressive Tool Discovery — Phase 2C Scope-negative *runtime* matrix.
//
// This harness is deliberately different from the offline cost gate: it drives the
// real MCP Streamable HTTP transport over a loopback socket with the real discovery
// runtime (`createDiscoveryRuntimePolicy` + `registerObsidianCapabilities`), so the
// evidence is the actual per-request `tools/list` and direct `tools/call` behavior,
// not a second, pure-policy recomputation.
//
// What it proves (per profile x scope set):
//   * visibility equals the *independently computed* expected wire list built from
//     the Scope truth (`src/scopes.js`) and profile membership (`CORE_TOOL_NAMES` /
//     `TOOLSET_TOOLS`), in the raw native registration order;
//   * zero metadata leaks: a hidden tool never appears in `tools/list`, and a denied
//     `tools/call` result carries no descriptor metadata;
//   * zero denied-handler executions: every registered handler is wrapped with a
//     sentinel counter, and a denied call must never reach the wrapped handler;
//   * fail-closed negatives: missing auth context -> 0 tools; no scopes -> 0 tools;
//   * the view is recomputed per request: the same session changes view when the
//     request's scopes change and restores when they change back.
//
// Hard boundaries: no Vault write, no production/NAS state, no production auth. This
// is an SDK/runtime transport test, NOT host deferred-load evidence; host behavior
// stays `unknown` until a real installed host is driven (see the host matrix).
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { generatedArtifactMismatch } from "./artifact-text.mjs";
import { listenFetchSafe } from "./fetch-safe-listen.mjs";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(SCRIPT_DIR, "..");
export const REPO_DIR = path.resolve(APP_DIR, "..");
export const DEFAULT_OUT_DIR = path.join(REPO_DIR, "docs", "review", "tool-discovery", "p2c-cost-gate");
export const RUNTIME_MATRIX_JSON = "runtime-matrix.json";
export const RUNTIME_MATRIX_MD = "runtime-matrix.md";

export const RUNTIME_MATRIX_SCHEMA_VERSION = "1.0.0";
export const AUTHOR = "app/scripts/tool-discovery-runtime-matrix.mjs";

export const ALL_SCOPES = Object.freeze(["obsidian.read", "obsidian.write", "obsidian.files"]);

export const SCOPE_SETS = Object.freeze([
  Object.freeze({ id: "read", scopes: Object.freeze(["obsidian.read"]), header: "obsidian.read" }),
  Object.freeze({ id: "read+files", scopes: Object.freeze(["obsidian.read", "obsidian.files"]), header: "obsidian.read,obsidian.files" }),
  Object.freeze({ id: "read+write", scopes: Object.freeze(["obsidian.read", "obsidian.write"]), header: "obsidian.read,obsidian.write" }),
  Object.freeze({ id: "all", scopes: ALL_SCOPES, header: "all" }),
]);

// Isolate config reads (Vault/DATA env) BEFORE the source modules are imported.
const TEST_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-runtime-matrix-"));
process.env.VAULT_PATH = path.join(TEST_ROOT, "vault");
process.env.DATA_PATH = path.join(TEST_ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";

const { CAPABILITY_CATALOG, TOOLSET_TOOLS } = await import("../src/capability-catalog.js");
const { CORE_TOOL_NAMES } = await import("../src/capability-policy.js");
const { TOOL_NAMES } = await import("../src/config.js");
const { parseDiscoveryOperatorConfig } = await import("../src/discovery-config.js");
const { createDiscoveryRuntimePolicy } = await import("../src/discovery-runtime.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { MCP_TOOL_SCOPE_REQUIREMENTS } = await import("../src/scopes.js");

const UTF8 = new TextEncoder();

export function byteLength(value) {
  return UTF8.encode(typeof value === "string" ? value : JSON.stringify(value)).length;
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
  return { bytes: byteLength(text), sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

// --- independent expected view (Scope truth + profile membership) -------------------

export function profileAllowSet(policy) {
  if (policy.profile === "full") return null;
  if (policy.profile === "core") return new Set(CORE_TOOL_NAMES);
  if (policy.profile === "module") {
    return new Set(policy.toolsets.flatMap((toolset) => TOOLSET_TOOLS[toolset] || []));
  }
  throw new Error(`Unsupported matrix profile ${policy.profile}`);
}

// Built from `src/scopes.js` (the Scope truth) and the capability catalog scope field.
// Deliberately does NOT call the runtime policy function, so it is not tautological.
export function expectedVisibleNames(policy, grantedScopes, nativeOrder) {
  const granted = new Set(grantedScopes);
  const allowed = profileAllowSet(policy);
  const authorized = CAPABILITY_CATALOG.filter((entry) => entry.scope.every((scope) => granted.has(scope))).map(
    (entry) => entry.name,
  );
  const authorizedSet = new Set(authorized);
  const visible = new Set(authorized.filter((name) => allowed === null || allowed.has(name)));
  return nativeOrder.filter((name) => visible.has(name));
}

export function profileDefinitions() {
  const defs = [
    { id: "full", policy: { profile: "full" } },
    { id: "core", policy: { profile: "core" } },
  ];
  for (const toolset of Object.keys(TOOLSET_TOOLS)) {
    defs.push({ id: `module:${toolset}`, policy: { profile: "module", toolsets: [toolset] } });
  }
  return defs;
}

// --- raw native capture (HTTP transport, so descriptors share the exact same
// serialization as the wired runtime output they are compared against) --------

async function captureRawNativeViaHttp() {
  const harness = await startHarness(() => {
    const server = new McpServer({ name: "runtime-matrix-raw-http", version: "1.0.0" });
    registerObsidianCapabilities(server);
    return server;
  });
  try {
    const client = "matrix-raw-native";
    const session = await openSession(harness.port, { client, scopeHeader: "all" });
    return await listToolNames(harness.port, session, { client, scopeHeader: "all" });
  } finally {
    await harness.close();
  }
}

// --- sentinel runtime server + HTTP harness ----------------------------------------

// Wrap every registered handler with a counter so a denied call provably never
// reaches the tool implementation. No tool is ever called unless it is expected
// visible, and the matrix only calls denied tools. A fresh server is created per
// HTTP session (as the runtime tests do) while the invocation counter is shared.
export function createSentinelServerFactory(policy, { authDisabled = false } = {}) {
  const operatorConfig = parseDiscoveryOperatorConfig({
    MCP_DISCOVERY_PROFILE: policy.profile,
    MCP_DISCOVERY_TOOLSETS: (policy.toolsets || []).join(","),
    MCP_DISCOVERY_TOOLS: (policy.tools || []).join(","),
    MCP_DISCOVERY_DENY_TOOLS: (policy.denyTools || []).join(","),
  });
  const handlerInvocations = [];
  const createServer = () => {
    const server = new McpServer({ name: "runtime-matrix", version: "1.0.0" });
    const base = createDiscoveryRuntimePolicy(server, operatorConfig, { authDisabled });
    const registrar = {
      server: base.server,
      getClientVersion: () => base.getClientVersion?.(),
      registerTool: (name, definition, handler) =>
        base.registerTool(name, definition, (...args) => {
          handlerInvocations.push(name);
          return handler(...args);
        }),
      registerResource: (...args) => base.registerResource(...args),
      registerPrompt: (...args) => base.registerPrompt(...args),
      install: () => base.install(),
      get operatorConfig() {
        return base.operatorConfig;
      },
      get authDisabled() {
        return base.authDisabled;
      },
    };
    registerObsidianCapabilities(registrar);
    registrar.install();
    return server;
  };
  return { createServer, handlerInvocations, operatorConfig };
}

function rpcRequest(port, method, params, identity = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (identity.client) headers["x-test-client"] = identity.client;
  if (identity.session) headers["mcp-session-id"] = identity.session;
  if (typeof identity.scopeHeader === "string") headers["x-test-scopes"] = identity.scopeHeader;
  return { method, params, headers };
}

export async function startHarness(createServer) {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  const sessions = new Map();
  app.use((req, _res, next) => {
    // Test auth harness: maps a header to authInfo.scopes. This is NOT production auth.
    if (!Object.hasOwn(req.headers, "x-test-scopes")) {
      req.auth = undefined;
      next();
      return;
    }
    const raw = req.headers["x-test-scopes"];
    let scopes;
    if (raw === "all") scopes = [...ALL_SCOPES];
    else if (raw === "none" || raw === "") scopes = [];
    else scopes = String(raw).split(",").map((value) => value.trim()).filter(Boolean);
    req.auth = {
      type: "test",
      clientId: req.header("x-test-client") || "anonymous",
      scopes,
      allowedVaults: ["vault"],
    };
    next();
  });
  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id");
      if (sessionId) {
        const record = sessions.get(sessionId);
        if (!record) {
          res.status(404).end();
          return;
        }
        if (record.authClientId && record.authClientId !== req.auth?.clientId) {
          res.status(403).end();
          return;
        }
        await record.transport.handleRequest(req, res, req.body);
        return;
      }
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, { transport, authClientId: req.auth?.clientId, server }),
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: String(error?.message || error) });
    }
  });
  // `listen(0)` can hand back a WHATWG fetch "bad port" on hosts with a low dynamic
  // range (Windows: 1024-15000) ⇒ see `fetch-safe-listen.mjs` (issue #344).
  const httpServer = http.createServer(app);
  const port = await listenFetchSafe(httpServer);
  return {
    port,
    close: async () => {
      for (const record of sessions.values()) await record.server.close().catch(() => {});
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

async function rpc(port, method, params, identity = {}) {
  const { method: m, params: p, headers } = rpcRequest(port, method, params, identity);
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: m, params: p }),
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const payload = !text
    ? null
    : contentType.includes("event-stream")
      ? text
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)))
          .find((message) => message.id === 7)
      : JSON.parse(text);
  return { status: response.status, payload, session: response.headers.get("mcp-session-id") || identity.session };
}

async function openSession(port, { client, scopeHeader } = {}) {
  const identity = { client };
  if (typeof scopeHeader === "string") identity.scopeHeader = scopeHeader;
  const init = await rpc(
    port,
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: client, version: "1" } },
    identity,
  );
  if (init.status !== 200 || !init.session) throw new Error(`initialize failed: ${init.status}`);
  return init.session;
}

async function listToolNames(port, session, identity) {
  const response = await rpc(port, "tools/list", {}, { ...identity, session });
  if (response.status !== 200) throw new Error(`tools/list status ${response.status}`);
  if (response.payload?.error) throw new Error(`tools/list error ${JSON.stringify(response.payload.error)}`);
  return response.payload.result.tools;
}

async function callTool(port, session, identity, name, args = {}) {
  const response = await rpc(port, "tools/call", { name, arguments: args }, { ...identity, session });
  if (response.status !== 200) throw new Error(`tools/call status ${response.status}`);
  return response.payload.result;
}

export function deniedResultLeaksMetadata(result) {
  const serialized = JSON.stringify(result);
  return /inputSchema|outputSchema|annotations|"title"|_meta|structuredContent/i.test(serialized);
}

// --- matrix evaluation --------------------------------------------------------------

const DENIED_CALL_SAMPLE = Object.freeze([
  "write_note",
  "get_file",
  "git_commit",
  "apply_note_plan",
  "manage_publish",
  "memory_capture",
  "update_task",
  "delete_note",
]);

function pickDeniedTools(visibleNames, nativeOrder, limit = 6) {
  const visible = new Set(visibleNames);
  const hidden = nativeOrder.filter((name) => !visible.has(name));
  const preferred = DENIED_CALL_SAMPLE.filter((name) => hidden.includes(name));
  const rest = hidden.filter((name) => !preferred.includes(name));
  return [...preferred, ...rest].slice(0, limit);
}

async function evaluateScopeRow(port, profileId, policy, scopeSet, nativeOrder, handlerInvocations) {
  const expected = expectedVisibleNames(policy, [...scopeSet.scopes], nativeOrder);
  const client = `matrix-${profileId}-${scopeSet.id}`;
  const identity = { client, scopeHeader: scopeSet.header };
  const session = await openSession(port, identity);
  const tools = await listToolNames(port, session, identity);
  const returnedNames = tools.map((tool) => tool.name);
  const expectedSet = new Set(expected);
  const structuralLeaks = returnedNames.filter((name) => !expectedSet.has(name));
  const hiddenNames = nativeOrder.filter((name) => !expectedSet.has(name));
  const hiddenNameInPayload = hiddenNames.filter((name) => returnedNames.includes(name));

  let deniedCalls = 0;
  let deniedHandlerExecutions = 0;
  let metadataLeaks = 0;
  const deniedSamples = [];
  for (const denied of pickDeniedTools(expected, nativeOrder)) {
    const before = handlerInvocations.length;
    const result = await callTool(port, session, identity, denied);
    deniedCalls += 1;
    if (handlerInvocations.length !== before) deniedHandlerExecutions += 1;
    if (deniedResultLeaksMetadata(result)) metadataLeaks += 1;
    deniedSamples.push({ name: denied, isError: result?.isError === true });
  }

  return {
    scopeSet: scopeSet.id,
    scopes: [...scopeSet.scopes],
    expectedCount: expected.length,
    visibleCount: returnedNames.length,
    hiddenCount: nativeOrder.length - returnedNames.length,
    matchesExpectedWireOrder: JSON.stringify(returnedNames) === JSON.stringify(expected),
    structuralLeaks: structuralLeaks.length,
    hiddenNameInPayload: hiddenNameInPayload.length,
    deniedCalls,
    deniedHandlerExecutions,
    deniedMetadataLeaks: metadataLeaks,
    deniedSamples,
  };
}

async function evaluateNegatives(port, profileId, policy, nativeOrder) {
  const rows = {};
  // Missing auth context: no x-test-scopes header -> authInfo undefined -> fail closed.
  {
    const client = `matrix-${profileId}-missing-auth`;
    const session = await openSession(port, { client });
    const tools = await listToolNames(port, session, { client, session });
    const probe = await callTool(port, session, { client }, "server_info");
    rows.missingAuth = {
      visibleCount: tools.length,
      deniedCallIsError: probe?.isError === true,
    };
  }
  // Present auth context with no scopes -> fail closed.
  {
    const client = `matrix-${profileId}-no-scope`;
    const session = await openSession(port, { client, scopeHeader: "none" });
    const tools = await listToolNames(port, session, { client, scopeHeader: "none" });
    const probe = await callTool(port, session, { client, scopeHeader: "none" }, "server_info");
    rows.noScope = {
      visibleCount: tools.length,
      deniedCallIsError: probe?.isError === true,
    };
  }
  // Same session/client, request scopes change -> view is recomputed, then restored.
  {
    const client = `matrix-${profileId}-scope-change`;
    const session = await openSession(port, { client, scopeHeader: "all" });
    const all = (await listToolNames(port, session, { client, scopeHeader: "all" })).map((tool) => tool.name);
    const read = (await listToolNames(port, session, { client, scopeHeader: "obsidian.read" })).map((tool) => tool.name);
    const restored = (await listToolNames(port, session, { client, scopeHeader: "all" })).map((tool) => tool.name);
    const expectedAll = expectedVisibleNames(policy, ALL_SCOPES, nativeOrder);
    const expectedRead = expectedVisibleNames(policy, ["obsidian.read"], nativeOrder);
    rows.scopeChange = {
      allCount: all.length,
      readCount: read.length,
      restoredCount: restored.length,
      shouldChange: JSON.stringify(expectedAll) !== JSON.stringify(expectedRead),
      changed: JSON.stringify(all) !== JSON.stringify(read),
      restored: JSON.stringify(all) === JSON.stringify(restored),
      matchesExpected:
        JSON.stringify(all) === JSON.stringify(expectedAll) &&
        JSON.stringify(read) === JSON.stringify(expectedRead) &&
        JSON.stringify(restored) === JSON.stringify(expectedAll),
    };
  }
  return rows;
}

async function evaluateProfile(def, nativeOrder, rawDescriptors) {
  const { createServer, handlerInvocations } = createSentinelServerFactory(def.policy);
  const harness = await startHarness(createServer);
  const rows = [];
  let negatives = {};
  let fullDescriptorsDeepEqualNativeRaw = null;
  try {
    for (const scopeSet of SCOPE_SETS) {
      rows.push(await evaluateScopeRow(harness.port, def.id, def.policy, scopeSet, nativeOrder, handlerInvocations));
    }
    negatives = await evaluateNegatives(harness.port, def.id, def.policy, nativeOrder);
    if (def.id === "full") {
      const client = `matrix-${def.id}-descriptor-parity`;
      const session = await openSession(harness.port, { client, scopeHeader: "all" });
      const tools = await listToolNames(harness.port, session, { client, scopeHeader: "all" });
      fullDescriptorsDeepEqualNativeRaw = JSON.stringify(tools) === JSON.stringify(rawDescriptors);
    }
  } finally {
    await harness.close();
  }
  return {
    id: def.id,
    policy: def.policy,
    rows,
    negatives,
    fullDescriptorsDeepEqualNativeRaw,
    handlerInvocations: [...handlerInvocations],
  };
}

export function evaluateRuntimeGate(report) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass, detail });
  const rows = report.profiles.flatMap((profile) => profile.rows);
  const visibilityMismatches = rows.filter((row) => !row.matchesExpectedWireOrder).length;
  const structuralLeaks = rows.reduce((sum, row) => sum + row.structuralLeaks, 0);
  const payloadLeaks = rows.reduce((sum, row) => sum + row.hiddenNameInPayload, 0);
  const deniedHandlerExecutions = rows.reduce((sum, row) => sum + row.deniedHandlerExecutions, 0);
  const deniedMetadataLeaks = rows.reduce((sum, row) => sum + row.deniedMetadataLeaks, 0);
  const missingAuthBad = report.profiles.filter((profile) => profile.negatives?.missingAuth?.visibleCount !== 0).length;
  const noScopeBad = report.profiles.filter((profile) => profile.negatives?.noScope?.visibleCount !== 0).length;
  const scopeChangeBad = report.profiles.filter((profile) => profile.negatives?.scopeChange?.matchesExpected !== true).length;

  add("visibility-matches-independent-truth", visibilityMismatches === 0, `profile x scope rows with a visibility mismatch: ${visibilityMismatches}`);
  add("zero-metadata-leaks", structuralLeaks === 0 && payloadLeaks === 0, `structural leaks ${structuralLeaks}; hidden names in payload ${payloadLeaks}`);
  add("zero-denied-handler-executions", deniedHandlerExecutions === 0, `denied calls that reached a handler: ${deniedHandlerExecutions}`);
  add("denied-call-no-metadata", deniedMetadataLeaks === 0, `denied results containing descriptor metadata: ${deniedMetadataLeaks}`);
  add("missing-auth-fail-closed", missingAuthBad === 0, `profiles where missing auth exposed tools: ${missingAuthBad}`);
  add("no-scope-fail-closed", noScopeBad === 0, `profiles where empty scopes exposed tools: ${noScopeBad}`);
  add("current-request-scope-recompute", scopeChangeBad === 0, `profiles where scope change did not recompute/restore: ${scopeChangeBad}`);
  add(
    "full-descriptors-equal-raw-native",
    report.profiles.find((profile) => profile.id === "full")?.fullDescriptorsDeepEqualNativeRaw === true,
    "full-profile wired tools/list descriptors deep-equal the raw native descriptor array",
  );

  const blockers = checks.filter((check) => !check.pass).map((check) => `${check.id}: ${check.detail}`);
  return { decision: checks.every((check) => check.pass) ? "pass" : "fail", checks, blockers };
}

// --- report assembly ----------------------------------------------------------------

export async function buildRuntimeMatrixReport({ sourceCommit = null } = {}) {
  const rawDescriptors = await captureRawNativeViaHttp();
  const nativeOrder = rawDescriptors.map((tool) => tool.name);
  const nativeSet = new Set(nativeOrder);
  if (nativeOrder.length !== TOOL_NAMES.length || TOOL_NAMES.some((name) => !nativeSet.has(name))) {
    throw new Error("raw native order does not match TOOL_NAMES membership");
  }

  const profiles = [];
  for (const def of profileDefinitions()) {
    profiles.push(await evaluateProfile(def, nativeOrder, rawDescriptors));
  }

  // Read-only annotation vs Scope mismatch census (documented, not hidden).
  const scopeVsAnnotation = CAPABILITY_CATALOG.map((entry) => {
    const scopes = MCP_TOOL_SCOPE_REQUIREMENTS[entry.name] || [];
    return { name: entry.name, scopes, readScopeOnly: scopes.length === 1 && scopes[0] === "obsidian.read" };
  });
  const readOnlyAnnotationButWriteScoped = scopeVsAnnotation.filter(
    (entry) => !entry.readScopeOnly && entry.scopes.includes("obsidian.write"),
  ).length;

  const report = {
    schemaVersion: RUNTIME_MATRIX_SCHEMA_VERSION,
    generatedBy: AUTHOR,
    mode: "phase2c scope-negative runtime matrix (real MCP Streamable HTTP, SDK runtime — NOT host)",
    source: {
      commit: sourceCommit,
      commitIsInformational: true,
      exactSourceSha: null,
      provenance:
        "Recomputable from the current worktree by starting isolated in-process MCP servers on loopback with a temp vault/data path. `commit` is the pre-generation HEAD and is informational only; the content digest excludes this `source` block.",
    },
    scopeTruthSource: "app/src/scopes.js (MCP_TOOL_SCOPE_REQUIREMENTS)",
    profileTruthSource: "app/src/capability-policy.js CORE_TOOL_NAMES + app/src/capability-catalog.js TOOLSET_TOOLS",
    transport: "MCP Streamable HTTP over 127.0.0.1 ephemeral port",
    authHarness: "test middleware maps x-test-scopes -> authInfo.scopes; this is NOT production authentication",
    notHostEvidence:
      "This is SDK/runtime transport evidence. It does not prove any installed host defers tool loading or refreshes its tool list. Host cells stay `unknown`.",
    nativeRegistrationOrder: nativeOrder,
    nativeRegistrationOrderDigest: digestJson(nativeOrder).sha256,
    profiles,
    annotationScopeMismatch: {
      readOnlyAnnotationButWriteScoped,
      note: "Frozen fixtures classify some tasks as read-only while the tool's Scope requirement includes obsidian.write. This census records the mismatch; it does not change the frozen fixtures or the Scope truth.",
    },
    semantics: {
      deniedHandlerExecutions:
        "Every registered handler is wrapped with a sentinel counter. The matrix only calls tools that are expected to be hidden; a nonzero count means a denied call reached a handler.",
      metadataLeaks:
        "structuralLeaks counts returned tool names outside the independently computed expected set; hiddenNameInPayload counts expected-hidden names that leaked into the returned `name` field.",
    },
    unmeasured: [
      "installed host deferred loading / tool search (Phase 3 host evidence)",
      "production authentication and OAuth scope derivation",
      "end-to-end agent task success",
      "latency",
    ],
  };
  report.gate = evaluateRuntimeGate(report);
  report.contentDigest = digestJson({ ...report, contentDigest: undefined, source: undefined });
  return report;
}

// --- markdown -----------------------------------------------------------------------

function pct(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function formatRuntimeMatrixMarkdown(report) {
  const lines = [];
  lines.push("# Progressive Tool Discovery — Phase 2C runtime Scope-negative matrix");
  lines.push("");
  lines.push("Status: **candidate** (branch artifact). This is **SDK/runtime transport evidence, not host evidence**.");
  lines.push(`Source commit: \`${report.source.commit ?? "uncommitted"}\` (informational).`);
  lines.push("");
  lines.push("Real MCP Streamable HTTP over loopback with the real discovery runtime and sentinel-wrapped handlers.");
  lines.push("No Vault write, no production auth, no NAS state. Scope truth: `src/scopes.js`.");
  lines.push("");
  lines.push("## Gate decision");
  lines.push("");
  lines.push(`**Decision: \`${report.gate.decision}\`**`);
  lines.push("");
  lines.push("| Check | Result | Detail |");
  lines.push("| --- | --- | --- |");
  for (const check of report.gate.checks) lines.push(`| \`${check.id}\` | ${check.pass ? "pass" : "**fail**"} | ${check.detail} |`);
  lines.push("");
  if (report.gate.blockers.length) {
    lines.push("Blockers:");
    for (const blocker of report.gate.blockers) lines.push(`- ${blocker}`);
    lines.push("");
  }
  lines.push(`- Profiles: ${report.profiles.length}; scope rows: ${report.profiles.reduce((sum, p) => sum + p.rows.length, 0)}.`);
  lines.push(`- Native registration order digest: \`${report.nativeRegistrationOrderDigest}\` (${report.nativeRegistrationOrder.length} tools).`);
  lines.push(`- ReadOnly-annotation-but-write-scoped tools: ${report.annotationScopeMismatch.readOnlyAnnotationButWriteScoped}.`);
  lines.push("");
  lines.push("## Per-profile visibility");
  lines.push("");
  lines.push("| Profile | Scope set | Expected | Visible | Match order | Structural leaks | Denied calls | Denied handler runs |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const profile of report.profiles) {
    for (const row of profile.rows) {
      lines.push(
        `| \`${profile.id}\` | \`${row.scopeSet}\` | ${row.expectedCount} | ${row.visibleCount} | ${row.matchesExpectedWireOrder} | ${row.structuralLeaks} | ${row.deniedCalls} | ${row.deniedHandlerExecutions} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Negatives (fail closed)");
  lines.push("");
  lines.push("| Profile | Missing auth visible | No-scope visible | Scope change recompute |");
  lines.push("| --- | --- | --- | --- |");
  for (const profile of report.profiles) {
    const negatives = profile.negatives || {};
    lines.push(
      `| \`${profile.id}\` | ${negatives.missingAuth?.visibleCount ?? "n/a"} | ${negatives.noScope?.visibleCount ?? "n/a"} | ${negatives.scopeChange?.matchesExpected === true} |`,
    );
  }
  lines.push("");
  lines.push("## Semantics and limits");
  lines.push("");
  for (const [key, value] of Object.entries(report.semantics)) lines.push(`- \`${key}\`: ${value}`);
  lines.push("");
  for (const item of report.unmeasured) lines.push(`- Unmeasured: ${item}`);
  lines.push("");
  lines.push(`Content digest (excludes \`source\`): \`${report.contentDigest.sha256}\` (${report.contentDigest.bytes} bytes).`);
  lines.push("");
  return lines.join("\n");
}

// --- verification -------------------------------------------------------------------

export async function verifyRuntimeMatrixArtifacts({ outDir = DEFAULT_OUT_DIR } = {}) {
  const errors = [];
  let checkedIn;
  try {
    checkedIn = JSON.parse(await readFile(path.join(outDir, RUNTIME_MATRIX_JSON), "utf8"));
  } catch {
    return { ok: false, errors: [`${RUNTIME_MATRIX_JSON} missing or unreadable`] };
  }
  const expected = await buildRuntimeMatrixReport({ sourceCommit: checkedIn.source?.commit ?? null });
  if (checkedIn.generatedBy !== AUTHOR) errors.push(`artifact generatedBy is not ${AUTHOR}`);
  if (checkedIn.gate?.decision !== "pass") errors.push(`checked-in runtime gate decision is "${checkedIn.gate?.decision}"`);
  const checkedInDigest = digestJson({ ...checkedIn, contentDigest: undefined, source: undefined });
  if (checkedInDigest.sha256 !== expected.contentDigest.sha256) {
    errors.push(`artifact content digest ${checkedInDigest.sha256} != freshly recomputed ${expected.contentDigest.sha256}; regenerate with --write`);
  }
  if (checkedIn.contentDigest?.sha256 !== checkedInDigest.sha256) errors.push("artifact contentDigest field is not self-consistent");
  try {
    const md = await readFile(path.join(outDir, RUNTIME_MATRIX_MD), "utf8");
    // CRLF checkout is equivalent to the committed LF blob; any other edit must fail.
    const mismatch = generatedArtifactMismatch(md, `${formatRuntimeMatrixMarkdown(expected)}\n`);
    if (mismatch) errors.push(`${RUNTIME_MATRIX_MD} does not match the freshly formatted report (${mismatch}); regenerate with --write`);
  } catch {
    errors.push(`${RUNTIME_MATRIX_MD} missing or unreadable`);
  }
  return { ok: errors.length === 0, errors, freshDigest: expected.contentDigest.sha256, gateDecision: expected.gate.decision };
}

// --- CLI ----------------------------------------------------------------------------

async function resolveSourceCommit() {
  try {
    const { execFileSync } = await import("node:child_process");
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_DIR, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function parseArgs(argv) {
  const options = { mode: "report", outDir: DEFAULT_OUT_DIR, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--json") options.json = true;
    else if (arg === "--write") options.mode = "write";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--out-dir") options.outDir = path.resolve(next() || "");
    else if (arg.startsWith("--out-dir=")) options.outDir = path.resolve(arg.slice("--out-dir=".length));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node app/scripts/tool-discovery-runtime-matrix.mjs [--json|--write|--verify]");
    return 0;
  }
  if (options.mode === "verify") {
    const verification = await verifyRuntimeMatrixArtifacts(options);
    console.log(verification.ok
      ? `verify: ok (gate ${verification.gateDecision}, digest ${verification.freshDigest})`
      : `verify: failed\n${verification.errors.map((error) => `- ${error}`).join("\n")}`);
    return verification.ok ? 0 : 1;
  }
  const report = await buildRuntimeMatrixReport({ sourceCommit: await resolveSourceCommit() });
  if (options.mode === "write") {
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path.join(options.outDir, RUNTIME_MATRIX_JSON), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(options.outDir, RUNTIME_MATRIX_MD), `${formatRuntimeMatrixMarkdown(report)}\n`, "utf8");
    console.log(`wrote ${RUNTIME_MATRIX_JSON} + ${RUNTIME_MATRIX_MD} (gate ${report.gate.decision}, digest ${report.contentDigest.sha256})`);
  } else if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatRuntimeMatrixMarkdown(report));
  }
  return report.gate.decision === "pass" ? 0 : 1;
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
    })
    .finally(async () => {
      await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    });
}
