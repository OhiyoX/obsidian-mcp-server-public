// Issue #669 (C5) — operator onboarding self-check: scope-aware MCP connection diagnostics.
//
// An operator whose agent "cannot write notes" used to get ONE word back — "failed" — and the
// fix differs completely per cause: a wrong API key, an expired OAuth token, a token that only
// carries `obsidian.read`, a read-only discovery profile, a dropped MCP session, a DNS or TLS
// fault, or Chinese tool discovery that never reaches `write_note`. Each cause below gets its
// own local fake Streamable-HTTP endpoint, because a real endpoint is not available here.
//
// The script under test is a PROBE: it reads, it never writes, and it prints no secret. Both
// are asserted here (the fake endpoints record every `tools/call`, and one endpoint echoes the
// credential back on purpose).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runOnboardingSmoke } from "../scripts/mcp-onboarding-smoke.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mcp-onboarding-smoke.mjs");

// A CN-capable `write_note`: its descriptor carries the Chinese signal the #276 work added.
const WRITE_NOTE_CN = { name: "write_note", title: "写入笔记", description: "保存笔记：把给定内容写入一篇新笔记，或覆盖已有笔记。", inputSchema: { type: "object", properties: {} } };
const APPEND_CN = { name: "append_to_note", title: "追加到笔记", description: "在笔记末尾追加内容。", inputSchema: { type: "object", properties: {} } };
// The same tools after a Latin-only regression: nothing a Chinese query can match.
const WRITE_NOTE_LATIN = { name: "write_note", title: "Write Note", description: "Save note content into a new note, or overwrite an existing note.", inputSchema: { type: "object", properties: {} } };
const APPEND_LATIN = { name: "append_to_note", title: "Append To Note", description: "Append text at the end of a note.", inputSchema: { type: "object", properties: {} } };
const READ_TOOLS = [
  { name: "server_info", title: "Server Info", description: "Return server configuration, health, tools.", inputSchema: { type: "object", properties: {} } },
  { name: "get_note", title: "Get Note", description: "Read one note by its Vault path.", inputSchema: { type: "object", properties: {} } },
  { name: "search_notes", title: "Search Notes", description: "Search notes by text.", inputSchema: { type: "object", properties: {} } },
];

const FULL_DISCOVERY = { schemaVersion: 1, profile: "full", catalogToolCount: 92, authorizedToolCount: 5, visibleToolCount: 5, hiddenByScope: 0, hiddenByPolicy: 0 };
const READ_ONLY_DISCOVERY = { ...FULL_DISCOVERY, authorizedToolCount: 3, visibleToolCount: 3, hiddenByScope: 2 };
const COMPACT_DISCOVERY = { ...FULL_DISCOVERY, profile: "compact", visibleToolCount: 3, hiddenByPolicy: 2 };

function jsonReply(res, id, result, headers = {}) {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

async function fakeEndpoint(handler) {
  const calls = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let message = null;
    try {
      message = raw ? JSON.parse(raw) : null;
    } catch {
      message = null;
    }
    calls.push({ method: message?.method || null, tool: message?.params?.name || null, headers: req.headers });
    handler({ message, req, res, calls });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// A well-behaved Streamable-HTTP endpoint: initialize, one 202 for `notifications/initialized`,
// tools/list, tools/call. `onToolsList` may answer a request itself (dropped-session case).
function mcpHandler({ tools, discovery, onToolsList }) {
  return ({ message, req, res }) => {
    if (!message) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (message.method === "initialize") {
      jsonReply(res, message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-onboarding-endpoint", version: "0.0.1" },
      }, { "mcp-session-id": "session-ok" });
      return;
    }
    if (message.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    if (message.method === "tools/list") {
      if (onToolsList?.({ req, res, message }) === "handled") return;
      jsonReply(res, message.id, { tools });
      return;
    }
    if (message.method === "tools/call") {
      const text = JSON.stringify({ version: "0.0.1", discovery, tools: tools.map((tool) => tool.name) });
      jsonReply(res, message.id, { content: [{ type: "text", text }] });
      return;
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "unsupported" } }));
  };
}

async function withEndpoint(handler, run) {
  const endpoint = await fakeEndpoint(handler);
  try {
    return await run(endpoint);
  } finally {
    await endpoint.close();
  }
}

const classesOf = (result) => result.errors.map((error) => error.class);

test("a healthy endpoint reports ok, transport, authKind, scope, profile and read/write", async () => {
  await withEndpoint(
    mcpHandler({ tools: [...READ_TOOLS, WRITE_NOTE_CN, APPEND_CN], discovery: FULL_DISCOVERY }),
    async (endpoint) => {
      const result = await runOnboardingSmoke({ endpoint: endpoint.endpoint, apiKey: "smoke-key-ok" });
      assert.deepEqual(result.errors, []);
      assert.equal(result.transport, "streamable-http");
      assert.equal(result.authKind, "api-key");
      assert.deepEqual(result.scope, ["obsidian.read", "obsidian.write"]);
      assert.equal(result.profile, "full");
      assert.equal(result.readAvailable, true);
      assert.equal(result.writeDiscoverable, true);
    },
  );
});

test("the probe performs one safe read and never calls a write tool", async () => {
  await withEndpoint(
    mcpHandler({ tools: [...READ_TOOLS, WRITE_NOTE_CN], discovery: FULL_DISCOVERY }),
    async (endpoint) => {
      await runOnboardingSmoke({ endpoint: endpoint.endpoint, apiKey: "smoke-key-ok" });
      const toolCalls = endpoint.calls.filter((call) => call.method === "tools/call");
      assert.deepEqual(toolCalls.map((call) => call.tool), ["server_info"]);
      assert.deepEqual(endpoint.calls.map((call) => call.method), [
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
      ]);
    },
  );
});

test("an invalid API key is its own class, distinct from an expired OAuth token", async () => {
  const invalidKey = ({ message, res }) => {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32001, message: "Unauthorized: missing or invalid API key" } }));
  };
  await withEndpoint(invalidKey, async (endpoint) => {
    const result = await runOnboardingSmoke({ endpoint: endpoint.endpoint, apiKey: "wrong-key" });
    assert.deepEqual(classesOf(result), ["auth-invalid-key"]);
    assert.equal(result.readAvailable, false);
    assert.equal(result.writeDiscoverable, false);
    assert.equal(result.authKind, "api-key");
  });

  const expiredToken = ({ message, res }) => {
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": 'Bearer error="invalid_token", error_description="Invalid or expired access token"',
    });
    res.end(JSON.stringify({ error: "invalid_token", error_description: "Invalid or expired access token" }));
  };
  await withEndpoint(expiredToken, async (endpoint) => {
    const result = await runOnboardingSmoke({ endpoint: endpoint.endpoint, token: "expired-oauth-token" });
    assert.deepEqual(classesOf(result), ["auth-token-expired"]);
    assert.equal(result.authKind, "oauth");
    assert.equal(result.readAvailable, false);
  });
});

test("a token whose scope is read-only-limited is its own class, not a profile problem", async () => {
  // Transport-level refusal of a write-scoped request (OAuth 403 + insufficient_scope).
  const insufficientScope = ({ message, res }) => {
    res.writeHead(403, {
      "content-type": "application/json",
      "www-authenticate": 'Bearer error="insufficient_scope", error_description="Additional permission is required", scope="obsidian.read obsidian.write"',
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32003, message: "forbidden" } }));
  };
  await withEndpoint(insufficientScope, async (endpoint) => {
    const result = await runOnboardingSmoke({ endpoint: endpoint.endpoint, token: "read-only-token" });
    assert.deepEqual(classesOf(result), ["scope-read-only"]);
  });

  // Connection accepted, but the credential only carries `obsidian.read`.
  await withEndpoint(
    mcpHandler({ tools: READ_TOOLS, discovery: READ_ONLY_DISCOVERY }),
    async (endpoint) => {
      const result = await runOnboardingSmoke({ endpoint: endpoint.endpoint, token: "read-only-token" });
      assert.deepEqual(classesOf(result), ["scope-read-only"]);
      assert.deepEqual(result.scope, ["obsidian.read"]);
      assert.equal(result.readAvailable, true);
      assert.equal(result.writeDiscoverable, false);
    },
  );
});

test("a compact read-only profile is its own class, even when the scope allows writing", async () => {
  await withEndpoint(
    mcpHandler({ tools: READ_TOOLS, discovery: COMPACT_DISCOVERY }),
    async (endpoint) => {
      const result = await runOnboardingSmoke({ endpoint: endpoint.endpoint, apiKey: "smoke-key-ok" });
      assert.deepEqual(classesOf(result), ["profile-read-only"]);
      assert.equal(result.profile, "compact");
      assert.equal(result.readAvailable, true);
      assert.equal(result.writeDiscoverable, false);
    },
  );
});

test("a dropped session is recovered once, and the class says so", async () => {
  let dropped = false;
  const handler = mcpHandler({
    tools: [...READ_TOOLS, WRITE_NOTE_CN],
    discovery: FULL_DISCOVERY,
    onToolsList: ({ message, res }) => {
      if (dropped) return;
      dropped = true;
      // The server forgot the session (restart / stateless flip): the historical 404.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: "Session not found" } }));
      return "handled";
    },
  });
  await withEndpoint(handler, async (endpoint) => {
    const result = await runOnboardingSmoke({ endpoint: endpoint.endpoint, apiKey: "smoke-key-ok" });
    assert.deepEqual(classesOf(result), ["session-dropped-recovered"]);
    assert.equal(result.readAvailable, true);
    assert.equal(result.writeDiscoverable, true);
    assert.equal(endpoint.calls.filter((call) => call.method === "initialize").length, 2);
  });
});

test("a DNS failure and a TLS failure are two classes", async () => {
  const dns = await runOnboardingSmoke({ endpoint: "http://onboarding-smoke.invalid:8080/mcp", apiKey: "k" });
  assert.deepEqual(classesOf(dns), ["network-dns"]);
  assert.equal(dns.readAvailable, false);

  const directory = await mkdtemp(path.join(os.tmpdir(), "onboarding-tls-"));
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1",
    ], { stdio: "ignore" });
    const server = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (_req, res) => res.end("{}"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const tls = await runOnboardingSmoke({ endpoint: `https://127.0.0.1:${port}/mcp`, apiKey: "k" });
      assert.deepEqual(classesOf(tls), ["network-tls"]);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Chinese tool discovery reaching write_note is its own class when it breaks", async () => {
  // Healthy: the Chinese descriptors carry the query signal.
  await withEndpoint(
    mcpHandler({ tools: [...READ_TOOLS, WRITE_NOTE_CN, APPEND_CN], discovery: FULL_DISCOVERY }),
    async (endpoint) => {
      const result = await runOnboardingSmoke({ endpoint: endpoint.endpoint, apiKey: "smoke-key-ok" });
      assert.deepEqual(result.errors, []);
      assert.equal(result.writeDiscoverable, true);
    },
  );

  // Regression: the write tools are served, but nothing Chinese can reach them.
  await withEndpoint(
    mcpHandler({ tools: [...READ_TOOLS, WRITE_NOTE_LATIN, APPEND_LATIN], discovery: FULL_DISCOVERY }),
    async (endpoint) => {
      const result = await runOnboardingSmoke({ endpoint: endpoint.endpoint, apiKey: "smoke-key-ok" });
      assert.deepEqual(classesOf(result), ["cjk-write-unreachable"]);
      assert.equal(result.writeDiscoverable, true);
      assert.equal(result.readAvailable, true);
    },
  );
});

test("the CLI takes endpoint and credential from env or stdin and prints no secret", async () => {
  const API_KEY = "smoke-test-key-9f3a1b7c4d";
  // A hostile/buggy endpoint echoes the credential it received back in its error body.
  const echoHandler = ({ message, req, res }) => {
    const echoed = req.headers["x-api-key"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer error="${echoed}"` });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32001, message: `Unauthorized: missing or invalid API key ${echoed}` } }));
  };

  await withEndpoint(echoHandler, async (endpoint) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, MCP_SMOKE_URL: endpoint.endpoint, MCP_SMOKE_API_KEY: API_KEY, MCP_SMOKE_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));

    const printed = stdout.trim();
    const result = JSON.parse(printed);
    assert.equal(result.authKind, "api-key");
    assert.deepEqual(result.errors.map((error) => error.class), ["auth-invalid-key"]);
    assert.notEqual(code, 0);
    assert.ok(!printed.includes(API_KEY), "stdout must not contain the key");
    assert.ok(!printed.includes(API_KEY.slice(0, 8)), "stdout must not contain a key prefix");
    assert.ok(!stderr.includes(API_KEY), "stderr must not contain the key");
  });

  // No env at all: the same run through stdin as JSON.
  await withEndpoint(
    mcpHandler({ tools: [...READ_TOOLS, WRITE_NOTE_CN], discovery: FULL_DISCOVERY }),
    async (endpoint) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: { ...process.env, MCP_SMOKE_URL: "", MCP_SMOKE_API_KEY: "", MCP_SMOKE_TOKEN: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stdin.end(JSON.stringify({ endpoint: endpoint.endpoint, apiKey: "stdin-key-123456" }));
      const code = await new Promise((resolve) => child.on("close", resolve));
      const result = JSON.parse(stdout.trim());
      assert.equal(code, 0);
      assert.deepEqual(result.errors, []);
      assert.equal(result.readAvailable, true);
      assert.ok(!stdout.includes("stdin-key-123456"));
    },
  );
});
