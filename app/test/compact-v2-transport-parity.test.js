// W3-A: real Streamable HTTP characterization of the opt-in Compact v2 view.
// This is a deterministic transport/scope matrix, NOT a real-agent Host A/B
// benchmark, production token authorization test, or deployment approval.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fetchSafePort } from "./fetch-safe-port.mjs";

const ROOT = await mkdtemp(path.join(os.tmpdir(), "compact-v2-w3-"));
const VAULT = path.join(ROOT, "vault");
await mkdir(path.join(VAULT, ".obsidian"), { recursive: true });
await writeFile(path.join(VAULT, "w3-fixture.md"), "# W3\n\nCompact/legacy parity fixture.\n", "utf8");
process.env.VAULT_PATH = VAULT;
process.env.DATA_PATH = path.join(ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.API_KEY = "";
process.env.OAUTH_ENABLED = "false";

const { TOOL_NAMES } = await import("../src/config.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { createDiscoveryRuntimePolicy } = await import("../src/discovery-runtime.js");
const { parseDiscoveryOperatorConfig } = await import("../src/discovery-config.js");

const FULL = ["obsidian.read", "obsidian.write", "obsidian.files"];
const READ = ["obsidian.read"];
const READ_FILES = ["obsidian.read", "obsidian.files"];
const READ_WRITE = ["obsidian.read", "obsidian.write"];
test.after(async () => rm(ROOT, { recursive: true, force: true }));

async function createHarness(t, operatorEnv) {
  const sessions = new Map();
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  // Test-only injected identities. The production OAuth/API-key gate is
  // deliberately NOT simulated here and needs separate real-auth testing.
  app.use((req, _res, next) => {
    req.auth = {
      type: "test",
      clientId: req.header("x-test-client") || "w3",
      scopes: (req.header("x-test-scopes") || "obsidian.read").split(","),
      allowedVaults: ["default"], // No WEB_VAULTS_ROOT: primary Vault id is "default".
    };
    next();
  });
  app.post("/mcp", async (req, res) => {
    try {
      const id = req.header("mcp-session-id");
      if (id) {
        const record = sessions.get(id);
        if (!record) return void res.status(404).end();
        if (record.client !== req.auth.clientId) return void res.status(403).end();
        await record.transport.handleRequest(req, res, req.body);
        return;
      }
      const server = new McpServer({ name: "compact-w3", version: "1" });
      const discovery = createDiscoveryRuntimePolicy(server, parseDiscoveryOperatorConfig(operatorEnv));
      registerObsidianCapabilities(discovery);
      discovery.install();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId) => sessions.set(newId, { server, transport, client: req.auth.clientId }),
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: String(error) });
    }
  });
  const server = app.listen(await fetchSafePort(), "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const entry of sessions.values()) await entry.server.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

async function rpc(port, method, params, { session, scopes = FULL, client = "w3" } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-test-scopes": scopes.join(","),
    "x-test-client": client,
  };
  if (session) headers["mcp-session-id"] = session;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 17, method, params }),
  });
  const raw = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((value) => value.id === 17)
    : JSON.parse(raw);
  assert.equal(response.status, 200, raw.slice(0, 500));
  assert.ok(payload && !payload.error, JSON.stringify(payload?.error));
  return { result: payload.result, session: response.headers.get("mcp-session-id") || session };
}

async function initialize(port, scopes = FULL) {
  const x = await rpc(port, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "compact-w3", version: "1" },
  }, { scopes });
  assert.ok(x.session);
  return x.session;
}
async function list(port, session, scopes = FULL) {
  return (await rpc(port, "tools/list", {}, { session, scopes })).result.tools;
}
async function call(port, session, scopes, name, args) {
  return (await rpc(port, "tools/call", { name, arguments: args }, { session, scopes })).result;
}
function routed(tools) {
  return tools.flatMap((tool) => tool.name === "agent_bootstrap" || tool.name === "server_info"
    ? [{ action: tool.name, descriptor: tool, branch: null }]
    : tool.inputSchema.oneOf.map((branch) => ({
        action: branch.properties.action.const, descriptor: tool, branch,
      })));
}
function names(tools) {
  return routed(tools).map((x) => x.action);
}

test("W3-A real HTTP: 87 native descriptors map once into 34 risk-partitioned entries with exact action schemas", async (t) => {
  const fullPort = await createHarness(t, { MCP_DISCOVERY_PROFILE: "full" });
  const compactPort = await createHarness(t, { MCP_DISCOVERY_PROFILE: "compact" });
  const full = await list(fullPort, await initialize(fullPort));
  const compact = await list(compactPort, await initialize(compactPort));
  assert.equal(full.length, TOOL_NAMES.length);
  assert.equal(compact.length, 34);
  const original = new Map(full.map((tool) => [tool.name, tool]));
  const routes = routed(compact);
  assert.equal(routes.length, TOOL_NAMES.length);
  assert.deepEqual([...names(compact)].sort(), [...TOOL_NAMES].sort());
  for (const route of routes) {
    const source = original.get(route.action);
    assert.ok(source, route.action);
    if (route.branch) {
      assert.deepEqual(route.branch.properties.params, source.inputSchema, route.action);
      assert.deepEqual(route.branch.required, ["action", "params"], route.action);
      assert.equal(route.branch.additionalProperties, false, route.action);
      assert.equal(route.descriptor.inputSchema.additionalProperties, false, route.action);
      assert.equal(route.descriptor.inputSchema.oneOf.length > 0, true);
    } else {
      assert.deepEqual(route.descriptor, source, route.action);
    }
  }
});

test("W3-A real HTTP: full and compact return equivalent native read results", async (t) => {
  const fullPort = await createHarness(t, { MCP_DISCOVERY_PROFILE: "full" });
  const compactPort = await createHarness(t, { MCP_DISCOVERY_PROFILE: "compact" });
  const fullSession = await initialize(fullPort);
  const compactSession = await initialize(compactPort);
  const descriptor = (await list(compactPort, compactSession)).find((tool) =>
    tool.inputSchema.oneOf?.some((branch) => branch.properties.action.const === "get_note"));
  assert.ok(descriptor);
  const args = { path: "w3-fixture.md", format: "content" };
  const original = await call(fullPort, fullSession, FULL, "get_note", args);
  const compact = await call(compactPort, compactSession, FULL, descriptor.name,
    { action: "get_note", params: args });
  assert.equal(original.isError, undefined, JSON.stringify(original).slice(0, 900));
  assert.equal(compact.isError, undefined, JSON.stringify(compact).slice(0, 900));
  assert.deepEqual(compact.structuredContent, original.structuredContent);
});

test("W3-A real HTTP: read/files/write combinations filter actions without leaking hidden names", async (t) => {
  const port = await createHarness(t, { MCP_DISCOVERY_PROFILE: "compact" });
  for (const [scopes, expected] of [
    [READ, { read: true, file: false, write: false }],
    [READ_FILES, { read: true, file: true, write: false }],
    [READ_WRITE, { read: true, file: false, write: true }],
    [FULL, { read: true, file: true, write: true }],
    [["invalid.scope"], { read: false, file: false, write: false }],
  ]) {
    const session = await initialize(port, scopes);
    const tools = await list(port, session, scopes);
    const visible = new Set(names(tools));
    assert.equal(visible.has("get_note"), expected.read);
    assert.equal(visible.has("get_file"), expected.file);
    assert.equal(visible.has("write_note"), expected.write);
    assert.equal(JSON.stringify(tools).includes('"write_note"'), expected.write);
    assert.equal(JSON.stringify(tools).includes('"get_file"'), expected.file);
  }
});

test("W3-A real HTTP: identity downgrades on the same session revoke prior compact action access", async (t) => {
  const port = await createHarness(t, { MCP_DISCOVERY_PROFILE: "compact" });
  const session = await initialize(port);
  const full = await list(port, session);
  const write = routed(full).find((route) => route.action === "write_note");
  assert.ok(write);
  const readTools = await list(port, session, READ);
  assert.equal(names(readTools).includes("write_note"), false);
  const denied = await call(port, session, READ, write.descriptor.name, {
    action: "write_note",
    params: { path: "should-not-exist.md", content: "FORBIDDEN" },
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.content[0].text, `MCP error -32602: Tool ${write.descriptor.name} not found`);
});

test("W3-A real HTTP: operator denyTools is applied inside a surviving domain", async (t) => {
  const port = await createHarness(t, {
    MCP_DISCOVERY_PROFILE: "compact", MCP_DISCOVERY_DENY_TOOLS: "get_note",
  });
  const session = await initialize(port);
  const tools = await list(port, session);
  const target = routed(tools).find((route) => route.action === "get_metadata");
  assert.ok(target);
  assert.equal(names(tools).includes("get_note"), false);
  const denied = await call(port, session, FULL, target.descriptor.name, {
    action: "get_note", params: { path: "w3-fixture.md" },
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.content[0].text, `MCP error -32602: Tool ${target.descriptor.name} not found`);
});
