// Focused runtime tests for Progressive Tool Discovery Phase 2B.
//
// These tests drive the real MCP Streamable HTTP transport with per-request
// auth context. They prove observable runtime behavior: list filtering, direct
// call denial, per-request scope recomputation, profile/deny selection, config
// fallback, and server_info policy truthfulness.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { fetchSafePort } from "./fetch-safe-port.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Isolate config module reads (Vault/DATA env) before importing source modules.
const TEST_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-discovery-runtime-"));
process.env.VAULT_PATH = path.join(TEST_ROOT, "vault");
process.env.DATA_PATH = path.join(TEST_ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";

const { CAPABILITY_CATALOG } = await import("../src/capability-catalog.js");
const { CORE_TOOL_NAMES } = await import("../src/capability-policy.js");
const { TOOL_NAMES } = await import("../src/config.js");
const { parseDiscoveryOperatorConfig } = await import("../src/discovery-config.js");
const { createDiscoveryRuntimePolicy, resolveDiscoveryView } = await import("../src/discovery-runtime.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");

const ALL_SCOPES = ["obsidian.read", "obsidian.write", "obsidian.files"];
const READ_SCOPES = ["obsidian.read"];
const FULL_CONFIG = parseDiscoveryOperatorConfig({});
const READ_ONLY_NAME_SET = new Set(
  CAPABILITY_CATALOG.filter((entry) => entry.scope.every((scope) => scope === "obsidian.read")).map((entry) => entry.name),
);

test.after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

// Canonical (TOOL_NAMES) order, used by server_info.tools.
function readOnlyNames() {
  return [...READ_ONLY_NAME_SET];
}

// Native SDK registration order, used by tools/list after the policy filter.
function nativeOrderFor(names) {
  const wanted = new Set(names);
  return NATIVE_TOOL_ORDER.filter((name) => wanted.has(name));
}

function readOnlyNativeNames() {
  return NATIVE_TOOL_ORDER.filter((name) => READ_ONLY_NAME_SET.has(name));
}

function createRuntimeServer(operatorConfig = FULL_CONFIG, options = {}) {
  const server = new McpServer({ name: "discovery-runtime-test", version: "1" });
  const discovery = createDiscoveryRuntimePolicy(server, operatorConfig, options);
  registerObsidianCapabilities(discovery);
  discovery.install();
  return server;
}

function createRawServer() {
  const server = new McpServer({ name: "discovery-runtime-test", version: "1" });
  registerObsidianCapabilities(server);
  return server;
}

async function startHarness(t, createServer, { skipAuth = false } = {}) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  const sessions = new Map();
  app.use((req, _res, next) => {
    if (skipAuth) { next(); return; }
    const scopes = req.header("x-test-scopes");
    req.auth = {
      type: "test",
      clientId: req.header("x-test-client") || "anonymous",
      scopes: scopes ? scopes.split(",").map((value) => value.trim()).filter(Boolean) : [...ALL_SCOPES],
      allowedVaults: ["vault"],
    };
    next();
  });
  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id");
      if (sessionId) {
        const record = sessions.get(sessionId);
        if (!record) { res.status(404).end(); return; }
        if (record.authClientId && record.authClientId !== req.auth?.clientId) { res.status(403).end(); return; }
        await record.transport.handleRequest(req, res, req.body);
        return;
      }
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, { transport, authClientId: req.auth?.clientId, server }),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        server.close().catch(() => {});
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: String(error?.message || error) });
    }
  });
  const httpServer = app.listen(await fetchSafePort(), "127.0.0.1");
  await once(httpServer, "listening");
  const port = httpServer.address().port;
  t.after(async () => {
    for (const record of sessions.values()) await record.server.close().catch(() => {});
    httpServer.close();
  });
  return { port, sessions };
}

async function rpc(port, method, params, { session, client = "anonymous", scopes } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-test-client": client,
  };
  if (session) headers["mcp-session-id"] = session;
  if (scopes) headers["x-test-scopes"] = scopes.join(",");
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  });
  const text = await response.text();
  const payload = !text
    ? null
    : response.headers.get("content-type")?.includes("event-stream")
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((message) => message.id === 7)
      : JSON.parse(text);
  return { status: response.status, payload, session: response.headers.get("mcp-session-id") || session };
}

async function openSession(port, { client, scopes }) {
  const init = await rpc(port, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: client, version: "1" } }, { client, scopes });
  assert.equal(init.status, 200);
  assert.ok(init.session, "initialize must return a session id");
  return init.session;
}

async function listTools(port, session, identity) {
  const response = await rpc(port, "tools/list", {}, { ...identity, session });
  assert.equal(response.status, 200);
  assert.ok(!response.payload.error, JSON.stringify(response.payload.error));
  return response.payload.result.tools;
}

async function callTool(port, session, identity, name, args = {}) {
  const response = await rpc(port, "tools/call", { name, arguments: args }, { ...identity, session });
  assert.equal(response.status, 200);
  return response.payload.result;
}

// Capture the native SDK registration order from a raw (unwrapped) server so
// the tests can prove the policy only removes members and never reorders.
async function captureNativeToolOrder() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  const sessions = new Map();
  app.post("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    if (sessionId) {
      await sessions.get(sessionId).transport.handleRequest(req, res, req.body);
      return;
    }
    const server = createRawServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, { transport, server }),
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const httpServer = app.listen(await fetchSafePort(), "127.0.0.1");
  await once(httpServer, "listening");
  try {
    const port = httpServer.address().port;
    const init = await rpc(port, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "native-order", version: "1" } });
    const response = await rpc(port, "tools/list", {}, { session: init.session });
    return response.payload.result.tools.map((tool) => tool.name);
  } finally {
    for (const record of sessions.values()) await record.server.close().catch(() => {});
    await new Promise((resolve) => httpServer.close(resolve));
  }
}

const NATIVE_TOOL_ORDER = await captureNativeToolOrder();

test("captured native order matches the registered catalog set", () => {
  assert.deepEqual([...NATIVE_TOOL_ORDER].sort(), [...TOOL_NAMES].sort());
  assert.equal(new Set(NATIVE_TOOL_ORDER).size, TOOL_NAMES.length);
});

function normalizeToolName(payload, name) {
  return JSON.parse(JSON.stringify(payload).split(name).join("<tool>"));
}

test("default full profile preserves native descriptors and native order", async (t) => {
  const wrapped = await startHarness(t, () => createRuntimeServer(FULL_CONFIG));
  const raw = await startHarness(t, createRawServer);
  const wrappedSession = await openSession(wrapped.port, { client: "full", scopes: ALL_SCOPES });
  const rawSession = await openSession(raw.port, { client: "full", scopes: ALL_SCOPES });
  const wrappedTools = await listTools(wrapped.port, wrappedSession, { client: "full", scopes: ALL_SCOPES });
  const rawTools = await listTools(raw.port, rawSession, { client: "full", scopes: ALL_SCOPES });
  assert.equal(wrappedTools.length, TOOL_NAMES.length);
  assert.deepEqual(wrappedTools.map((tool) => tool.name), NATIVE_TOOL_ORDER);
  // Full profile is a pure membership pass-through: descriptors and order must
  // be byte-for-byte identical to the raw native array.
  assert.deepEqual(wrappedTools, rawTools);
});

test("tools/list fails loudly when a catalog tool has no native registration", async (t) => {
  const { port } = await startHarness(t, () => {
    const server = new McpServer({ name: "drift-partial", version: "1" });
    const discovery = createDiscoveryRuntimePolicy(server, FULL_CONFIG);
    discovery.registerTool("server_info", { title: "Server Info", description: "x", inputSchema: {} }, async () => ({ content: [] }));
    discovery.install();
    return server;
  });
  const session = await openSession(port, { client: "drift-partial", scopes: ALL_SCOPES });
  const response = await rpc(port, "tools/list", {}, { client: "drift-partial", scopes: ALL_SCOPES, session });
  assert.equal(response.status, 200);
  assert.equal(response.payload.error.code, -32603);
  assert.match(response.payload.error.message, /Discovery catalog\/registration drift/);
});

test("tools/list fails loudly when a native tool is missing from the catalog", async (t) => {
  const { port } = await startHarness(t, () => {
    const server = new McpServer({ name: "drift-extra", version: "1" });
    const discovery = createDiscoveryRuntimePolicy(server, FULL_CONFIG);
    registerObsidianCapabilities(discovery);
    discovery.registerTool("totally_uncataloged", { title: "x", description: "x", inputSchema: {} }, async () => ({ content: [] }));
    discovery.install();
    return server;
  });
  const session = await openSession(port, { client: "drift-extra", scopes: ALL_SCOPES });
  const response = await rpc(port, "tools/list", {}, { client: "drift-extra", scopes: ALL_SCOPES, session });
  assert.equal(response.status, 200);
  assert.equal(response.payload.error.code, -32603);
  assert.match(response.payload.error.message, /Discovery catalog\/registration drift/);
});

test("read-only scope excludes mutation/file tools and denies direct calls", async (t) => {
  const { port } = await startHarness(t, () => createRuntimeServer(FULL_CONFIG));
  const session = await openSession(port, { client: "reader", scopes: READ_SCOPES });
  const names = (await listTools(port, session, { client: "reader", scopes: READ_SCOPES })).map((tool) => tool.name);
  assert.deepEqual(names, readOnlyNativeNames());
  assert.ok(names.includes("get_note"));
  assert.equal(names.includes("write_note"), false);
  assert.equal(names.includes("get_file"), false);
  assert.equal(names.includes("git_commit"), false);
  assert.equal(names.includes("daily_note"), false);

  for (const denied of ["write_note", "get_file", "git_commit", "daily_note"]) {
    const result = await callTool(port, session, { client: "reader", scopes: READ_SCOPES }, denied);
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, `MCP error -32602: Tool ${denied} not found`);
  }
});

test("explicit core, module, custom, and deny configurations select the right view", async (t) => {
  const cases = [
    { env: { MCP_DISCOVERY_PROFILE: "core" }, client: "core", expected: nativeOrderFor([...CORE_TOOL_NAMES]) },
    {
      env: { MCP_DISCOVERY_PROFILE: "module", MCP_DISCOVERY_TOOLSETS: "git" },
      client: "module",
      expected: nativeOrderFor(["git_status", "git_diff", "git_log", "git_commit", "git_pull", "git_push"]),
    },
    {
      env: { MCP_DISCOVERY_PROFILE: "custom", MCP_DISCOVERY_TOOLS: "get_file,get_note" },
      client: "custom",
      expected: nativeOrderFor(["get_note", "get_file"]),
    },
    {
      env: { MCP_DISCOVERY_PROFILE: "full", MCP_DISCOVERY_DENY_TOOLS: "server_info,get_file" },
      client: "deny",
      expected: NATIVE_TOOL_ORDER.filter((name) => !["server_info", "get_file"].includes(name)),
    },
  ];
  for (const item of cases) {
    const { port } = await startHarness(t, () => createRuntimeServer(parseDiscoveryOperatorConfig(item.env)));
    const session = await openSession(port, { client: item.client, scopes: ALL_SCOPES });
    const names = (await listTools(port, session, { client: item.client, scopes: ALL_SCOPES })).map((tool) => tool.name);
    assert.deepEqual(names, item.expected, `${item.client} view mismatch`);
  }
});

test("profile-hidden direct call matches native unknown-tool protocol parity", async (t) => {
  const { port } = await startHarness(t, () => createRuntimeServer(parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "core" })));
  const session = await openSession(port, { client: "core", scopes: ALL_SCOPES });
  const identity = { client: "core", scopes: ALL_SCOPES };
  const hidden = await rpc(port, "tools/call", { name: "write_note", arguments: { path: "x.md", content: "x" } }, { ...identity, session });
  const nonexistent = await rpc(port, "tools/call", { name: "definitely_not_a_registered_tool", arguments: {} }, { ...identity, session });
  assert.equal(hidden.status, 200);
  assert.equal(nonexistent.status, 200);
  // Characterize the actual pinned SDK unknown-tool result for BOTH the
  // operator-hidden name and the never-registered name: the whole result is
  // exactly { content: [{ type, text }], isError: true }, with no metadata.
  for (const [payload, name] of [
    [hidden.payload, "write_note"],
    [nonexistent.payload, "definitely_not_a_registered_tool"],
  ]) {
    const result = payload.result;
    assert.deepEqual(Object.keys(result).sort(), ["content", "isError"]);
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    assert.deepEqual(Object.keys(result.content[0]).sort(), ["text", "type"]);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[0].text, `MCP error -32602: Tool ${name} not found`);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /Write note|write_note.*description|inputSchema/i);
    assert.doesNotMatch(serialized, /_meta|"title"|annotations?|outputSchema|structuredContent/i);
  }
  // A hidden name is JSON-RPC-shape identical to a never-registered name after
  // normalizing the name; only the tool name may differ, never metadata.
  assert.deepEqual(
    normalizeToolName(hidden.payload, "write_note"),
    normalizeToolName(nonexistent.payload, "definitely_not_a_registered_tool"),
  );
});

test("resolver fails closed without an auth context unless auth is explicitly disabled", () => {
  assert.deepEqual(resolveDiscoveryView({ authInfo: undefined }).toolNames, []);
  assert.deepEqual(resolveDiscoveryView({ authInfo: undefined, authDisabled: true }).toolNames, [...TOOL_NAMES]);
  // A present auth context is always authoritative, even when the server is open.
  assert.deepEqual(resolveDiscoveryView({ authInfo: {}, authDisabled: true }).toolNames, []);
  assert.deepEqual(resolveDiscoveryView({ authInfo: { scopes: [] }, authDisabled: true }).toolNames, []);
  assert.deepEqual(resolveDiscoveryView({ authInfo: { scopes: ["obsidian.admin"] }, authDisabled: true }).toolNames, []);
  assert.deepEqual(resolveDiscoveryView({ authInfo: {} }).toolNames, []);
  assert.deepEqual(resolveDiscoveryView({ authInfo: { scopes: [] } }).toolNames, []);
  assert.deepEqual(resolveDiscoveryView({ authInfo: { scopes: ["obsidian.admin"] } }).toolNames, []);
  const custom = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "custom", MCP_DISCOVERY_TOOLS: "get_note,write_note" });
  const readOnly = resolveDiscoveryView({ authInfo: { scopes: READ_SCOPES }, operatorConfig: custom });
  assert.deepEqual(readOnly.toolNames, ["get_note"]);
});

test("auth-expected runtime with no auth context fails closed over the real transport", async (t) => {
  const { port } = await startHarness(t, () => createRuntimeServer(FULL_CONFIG, { authDisabled: false }), { skipAuth: true });
  const session = await openSession(port, { client: "noauth" });
  const names = (await listTools(port, session, { client: "noauth" })).map((tool) => tool.name);
  assert.deepEqual(names, []);
  const result = await callTool(port, session, { client: "noauth" }, "get_note", { path: "x.md" });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "MCP error -32602: Tool get_note not found");
  const info = await callTool(port, session, { client: "noauth" }, "server_info");
  assert.equal(info.isError, true);
  assert.equal(info.content[0].text, "MCP error -32602: Tool server_info not found");
});

test("auth-disabled runtime with no auth context grants the full native view", async (t) => {
  const { port } = await startHarness(t, () => createRuntimeServer(FULL_CONFIG, { authDisabled: true }), { skipAuth: true });
  const session = await openSession(port, { client: "open-server" });
  const tools = await listTools(port, session, { client: "open-server" });
  assert.deepEqual(tools.map((tool) => tool.name), NATIVE_TOOL_ORDER);
  const info = await callTool(port, session, { client: "open-server" }, "server_info");
  assert.equal(info.isError, undefined);
  assert.deepEqual(info.structuredContent.tools, TOOL_NAMES);
  assert.equal(info.structuredContent.discovery.visibleToolCount, TOOL_NAMES.length);
});

test("malformed configuration falls back to full without expanding scopes", () => {
  const unknownProfile = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "bogus", MCP_DISCOVERY_TOOLS: "get_note" });
  assert.equal(unknownProfile.profile, "full");
  assert.deepEqual(unknownProfile.tools, []);
  assert.deepEqual(unknownProfile.toolsets, []);
  assert.match(unknownProfile.warning, /falling back to the full compatibility profile/);
  assert.ok(unknownProfile.warning.length <= 240);
  assert.doesNotMatch(unknownProfile.warning, /secret|token|password/i);

  const unknownTool = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "custom", MCP_DISCOVERY_TOOLS: "not_a_real_tool" });
  assert.equal(unknownTool.profile, "full");
  assert.match(unknownTool.warning, /Unknown capability tool/);

  const absent = parseDiscoveryOperatorConfig({});
  assert.equal(absent.profile, "full");
  assert.equal(absent.warning, null);
  assert.deepEqual(absent.denyTools, []);
});

test("malformed configuration server still enforces the current request scope", async (t) => {
  const config = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "bogus" });
  const { port } = await startHarness(t, () => createRuntimeServer(config));
  const session = await openSession(port, { client: "fallback", scopes: READ_SCOPES });
  const names = (await listTools(port, session, { client: "fallback", scopes: READ_SCOPES })).map((tool) => tool.name);
  assert.deepEqual(names, readOnlyNativeNames());
});

test("list view is recomputed per request for the same session and client", async (t) => {
  const { port } = await startHarness(t, () => createRuntimeServer(FULL_CONFIG));
  const session = await openSession(port, { client: "scope-change", scopes: ALL_SCOPES });
  const full = (await listTools(port, session, { client: "scope-change", scopes: ALL_SCOPES })).map((tool) => tool.name);
  const reduced = (await listTools(port, session, { client: "scope-change", scopes: READ_SCOPES })).map((tool) => tool.name);
  const restored = (await listTools(port, session, { client: "scope-change", scopes: ALL_SCOPES })).map((tool) => tool.name);
  assert.equal(full.length, TOOL_NAMES.length);
  assert.deepEqual(reduced, readOnlyNativeNames());
  assert.deepEqual(restored, full);
});

test("concurrent identities keep isolated views and sessions are identity-bound", async (t) => {
  const { port } = await startHarness(t, () => createRuntimeServer(FULL_CONFIG));
  const fullSession = await openSession(port, { client: "full", scopes: ALL_SCOPES });
  const readSession = await openSession(port, { client: "reader", scopes: READ_SCOPES });
  const [fullTools, readTools] = await Promise.all([
    listTools(port, fullSession, { client: "full", scopes: ALL_SCOPES }),
    listTools(port, readSession, { client: "reader", scopes: READ_SCOPES }),
  ]);
  assert.equal(fullTools.length, TOOL_NAMES.length);
  assert.deepEqual(readTools.map((tool) => tool.name), readOnlyNativeNames());

  const foreign = await rpc(port, "tools/list", {}, { session: fullSession, client: "reader", scopes: READ_SCOPES });
  assert.equal(foreign.status, 403);

  const afterIsolation = await listTools(port, fullSession, { client: "full", scopes: ALL_SCOPES });
  assert.equal(afterIsolation.length, TOOL_NAMES.length);
});

test("operator config is per server and never mutates the shared registry", async (t) => {
  const core = await startHarness(t, () => createRuntimeServer(parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "core" })));
  const raw = await startHarness(t, createRawServer);
  const coreSession = await openSession(core.port, { client: "core", scopes: ALL_SCOPES });
  const rawSession = await openSession(raw.port, { client: "raw", scopes: ALL_SCOPES });
  const coreList = await listTools(core.port, coreSession, { client: "core", scopes: ALL_SCOPES });
  const rawList = await listTools(raw.port, rawSession, { client: "raw", scopes: ALL_SCOPES });
  assert.deepEqual(coreList.map((tool) => tool.name), nativeOrderFor([...CORE_TOOL_NAMES]));
  assert.equal(rawList.length, TOOL_NAMES.length);
  // Repeated filtered reads do not accumulate state or shrink the native list.
  await listTools(core.port, coreSession, { client: "core", scopes: READ_SCOPES });
  assert.deepEqual((await listTools(core.port, coreSession, { client: "core", scopes: ALL_SCOPES })).map((tool) => tool.name), nativeOrderFor([...CORE_TOOL_NAMES]));
  assert.equal((await listTools(raw.port, rawSession, { client: "raw", scopes: ALL_SCOPES })).length, TOOL_NAMES.length);
});

test("server_info reports the same per-request view and a bounded summary", async (t) => {
  const { port } = await startHarness(t, () => createRuntimeServer(FULL_CONFIG));
  const fullSession = await openSession(port, { client: "full", scopes: ALL_SCOPES });
  const fullInfo = await callTool(port, fullSession, { client: "full", scopes: ALL_SCOPES }, "server_info");
  assert.equal(fullInfo.isError, undefined);
  const fullExpected = TOOL_NAMES;
  assert.deepEqual(fullInfo.structuredContent.tools, fullExpected);
  assert.deepEqual(fullInfo.structuredContent.discovery, {
    schemaVersion: 1,
    profile: "full",
    catalogToolCount: TOOL_NAMES.length,
    authorizedToolCount: TOOL_NAMES.length,
    visibleToolCount: TOOL_NAMES.length,
    hiddenByScope: 0,
    hiddenByPolicy: 0,
  });

  const readSession = await openSession(port, { client: "reader", scopes: READ_SCOPES });
  const readInfo = await callTool(port, readSession, { client: "reader", scopes: READ_SCOPES }, "server_info");
  const readExpected = readOnlyNames();
  assert.deepEqual(readInfo.structuredContent.tools, readExpected);
  assert.equal(readInfo.structuredContent.discovery.visibleToolCount, readExpected.length);
  assert.equal(readInfo.structuredContent.discovery.authorizedToolCount, readExpected.length);
  assert.equal(readInfo.structuredContent.discovery.hiddenByScope, TOOL_NAMES.length - readExpected.length);
  assert.equal(readInfo.structuredContent.discovery.hiddenByPolicy, 0);
});

test("server_info is unreachable when policy hides it", async (t) => {
  const { port } = await startHarness(t, () => createRuntimeServer(parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "custom", MCP_DISCOVERY_TOOLS: "get_note" })));
  const session = await openSession(port, { client: "custom", scopes: ALL_SCOPES });
  const result = await callTool(port, session, { client: "custom", scopes: ALL_SCOPES }, "server_info");
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "MCP error -32602: Tool server_info not found");
});


test("compact runtime exposes annotation-safe groups with exactly 89 native action routes", async (t) => {
  const profile = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "compact" });
  assert.equal(profile.profile, "compact");
  const { port } = await startHarness(t, () => createRuntimeServer(profile));
  const session = await openSession(port, { client: "compact-full", scopes: ALL_SCOPES });
  const tools = await listTools(port, session, { client: "compact-full", scopes: ALL_SCOPES });
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, tools.length);
  assert.equal(tools.length, 34, "current native annotations + Scope require 34 groups, not unsafe forced 26");
  assert.ok(names.includes("agent_bootstrap"));
  assert.ok(names.includes("server_info"));
  assert.equal(names.includes("write_note"), false);
  assert.equal(names.includes("get_note"), false);

  const routed = tools.flatMap((tool) => tool.name === "agent_bootstrap" || tool.name === "server_info"
    ? [tool.name]
    : tool.inputSchema.oneOf.map((branch) => branch.properties.action.const));
  assert.equal(routed.length, TOOL_NAMES.length);
  assert.deepEqual([...routed].sort(), [...TOOL_NAMES].sort());
  const compactInfo = await callTool(port, session, { client: "compact-full", scopes: ALL_SCOPES }, "server_info");
  assert.equal(compactInfo.isError, undefined);
  assert.equal(compactInfo.structuredContent.discovery.profile, "compact");
  assert.equal(compactInfo.structuredContent.discovery.visibleToolCount, tools.length);
  assert.deepEqual(compactInfo.structuredContent.tools, names);
  assert.equal(compactInfo.structuredContent.discovery.canonicalVisibleToolCount, TOOL_NAMES.length);
});

test("compact dispatch is fail-closed across read-only scopes, denied members, and incorrect groups", async (t) => {
  const fullConfig = parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: "compact" });
  const { port } = await startHarness(t, () => createRuntimeServer(fullConfig));
  const session = await openSession(port, { client: "compact-reader", scopes: READ_SCOPES });
  const tools = await listTools(port, session, { client: "compact-reader", scopes: READ_SCOPES });
  const allActions = tools.flatMap((tool) => tool.inputSchema.oneOf?.map((branch) => branch.properties.action.const) || [tool.name]);
  assert.ok(allActions.includes("get_note"));
  assert.equal(allActions.includes("write_note"), false);
  assert.equal(allActions.includes("get_file"), false);

  const readTool = tools.find((tool) => tool.inputSchema.oneOf?.some((branch) => branch.properties.action.const === "get_note"));
  assert.ok(readTool, "read-only caller must retain get_note");
  const absent = await callTool(port, session, { client: "compact-reader", scopes: READ_SCOPES },
    readTool.name, { action: "get_note", params: { path: "missing-note.md" } });
  assert.equal(absent.isError, true);
  assert.notEqual(absent.content[0].text, "MCP error -32602: Tool " + readTool.name + " not found");

  for (const invalid of [
    { action: "write_note", params: { path: "should-not-write.md", content: "x" } },
    { action: "get_note", params: { path: "missing-note.md" }, unexpected: true },
    { action: "get_note", params: null },
  ]) {
    const denied = await callTool(port, session, { client: "compact-reader", scopes: READ_SCOPES }, readTool.name, invalid);
    assert.equal(denied.isError, true);
    assert.equal(denied.content[0].text, "MCP error -32602: Tool " + readTool.name + " not found");
  }
  const hiddenLegacy = await callTool(port, session, { client: "compact-reader", scopes: READ_SCOPES },
    "get_note", { path: "missing-note.md" });
  assert.equal(hiddenLegacy.isError, true);
  assert.match(hiddenLegacy.content[0].text, /Tool get_note not found/);
});

test("compact denyTools removes the denied action from discovery and execution", async (t) => {
  const config = parseDiscoveryOperatorConfig({
    MCP_DISCOVERY_PROFILE: "compact",
    MCP_DISCOVERY_DENY_TOOLS: "get_note",
  });
  const { port } = await startHarness(t, () => createRuntimeServer(config));
  const session = await openSession(port, { client: "compact-denied", scopes: ALL_SCOPES });
  const tools = await listTools(port, session, { client: "compact-denied", scopes: ALL_SCOPES });
  const allActions = tools.flatMap((tool) => tool.inputSchema.oneOf?.map((branch) => branch.properties.action.const) || [tool.name]);
  assert.equal(allActions.includes("get_note"), false);
  const target = tools.find((tool) => tool.inputSchema.oneOf?.some((branch) => branch.properties.action.const === "get_metadata"));
  assert.ok(target);
  const denied = await callTool(port, session, { client: "compact-denied", scopes: ALL_SCOPES }, target.name,
    { action: "get_note", params: { path: "missing.md" } });
  assert.equal(denied.isError, true);
  assert.equal(denied.content[0].text, "MCP error -32602: Tool " + target.name + " not found");
});
