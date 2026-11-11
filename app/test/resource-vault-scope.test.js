// Fix for the P0 finding "a secondary-only credential reads the primary Vault through the MCP
// resources" (`test/permission-baseline-resource.test.js` in the `permission-p0` worktree proves the
// gap; this file proves the repair).
//
// The repair lives in the canonical Vault registrar (`src/vault-scope-registrar.js`): the three
// `obsidian://vault/*` resources now pass the same `allowedVaults` gate as `tools/call`, and
// `obsidian://agent/memory-policy` stays instance-level.
//
// The test is end to end over a real loopback MCP transport: real `McpServer`, real
// `registerResources`, real Vault on disk with markers that exist in exactly one place, and a real
// per-request `req.auth` that the SDK hands to the handler as `extra.authInfo`. No production
// server, no live Vault, no credentials.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-resource-vault-scope-"));
process.env.VAULT_PATH = path.join(ROOT, "vault");
process.env.DATA_PATH = path.join(ROOT, "data");
process.env.HISTORY_PATH = path.join(ROOT, "data", "history");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
await fs.mkdir(process.env.VAULT_PATH, { recursive: true });
await fs.mkdir(process.env.DATA_PATH, { recursive: true });

const { createVaultScopeRegistrar } = await import("../src/vault-scope-registrar.js");
const { registerResources } = await import("../src/resources.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { MEMORY_POLICY_URI, getAgentBootstrap } = await import("../src/agent-bootstrap.js");

const SECONDARY_VAULT_ID = "alpha";
const VAULT_URIS = ["obsidian://vault/index", "obsidian://vault/tags", "obsidian://vault/graph"];

// Two markers that exist in exactly one place, so a payload says who answered: the primary Vault's
// marker is written under VAULT_PATH, and the secondary Vault never appears in a resource read.
const PRIMARY_MARKER = "primary-only-marker";
const PRIMARY_TAG = "primarytag";

async function seedVault() {
  await fs.writeFile(
    path.join(process.env.VAULT_PATH, `${PRIMARY_MARKER}.md`),
    `---\ntags:\n  - ${PRIMARY_TAG}\n---\n\n# Only in the primary Vault\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(process.env.VAULT_PATH, "linked-note.md"),
    `# Linked note\n\nSee [[${PRIMARY_MARKER}]].\n`,
    "utf8",
  );
}

/** Identity sets the credential may hold. `undefined` = no credential at all (auth disabled). */
const CREDENTIALS = {
  "secondary-only": { allowedVaults: [SECONDARY_VAULT_ID] },
  full: { allowedVaults: [DEFAULT_VAULT_ID, SECONDARY_VAULT_ID] },
  "no-vault": { allowedVaults: [] },
  anonymous: undefined,
};

function parseIdentity(header) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  const credential = CREDENTIALS[match[1]];
  if (!credential) throw new Error(`unknown test credential ${match[1]}`);
  return { type: "test", clientId: match[1], scopes: ["obsidian.read"], allowedVaults: [...credential.allowedVaults] };
}

async function startHarness(t) {
  const sessions = new Map();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    try {
      req.auth = parseIdentity(req.header("authorization"));
      next();
    } catch (error) {
      next(error);
    }
  });

  app.post("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    if (sessionId) {
      const record = sessions.get(sessionId);
      if (!record) return res.status(404).end();
      await record.transport.handleRequest(req, res, req.body);
      return;
    }
    const server = new McpServer({ name: "resource-vault-scope", version: "1" });
    // The production chain starts at the discovery registrar, which forwards the SDK's
    // registration methods as own properties (`src/discovery-runtime.js`); the Vault registrar
    // hands any member it does not override back to it. This stand-in keeps that shape so a
    // resource reaches the SDK with and without the gate.
    const upstream = {
      server: server.server,
      getClientVersion: () => server.getClientVersion(),
      registerResource: (...args) => server.registerResource(...args),
    };
    registerResources(createVaultScopeRegistrar(upstream));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, { transport, server }),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      server.close().catch(() => {});
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  t.after(async () => {
    for (const record of sessions.values()) await record.server.close().catch(() => {});
    await new Promise((resolve) => httpServer.close(resolve));
  });
  return { port: httpServer.address().port };
}

async function rpc(port, method, params, { session, authorization } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  if (authorization) headers.authorization = authorization;
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

async function openSession(port, { authorization } = {}) {
  const init = await rpc(
    port,
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "resource-vault-scope", version: "1" } },
    { authorization },
  );
  assert.equal(init.status, 200);
  assert.ok(init.session, "initialize must return a session id");
  return init.session;
}

async function readResource(port, session, uri, { authorization } = {}) {
  const response = await rpc(port, "resources/read", { uri }, { session, authorization });
  const result = response.payload?.result ?? null;
  const text = result?.contents?.map((item) => item.text ?? "").join("\n") ?? null;
  return { response, result, text, serialized: JSON.stringify(response.payload) };
}

/** A refusal must not carry a single byte of Vault content. */
function assertRefused(read, label) {
  assert.equal(read.result?.isError, true, `${label}: the read is refused, got ${read.serialized.slice(0, 300)}`);
  assert.ok(read.serialized.includes("vault_access_denied"), `${label}: carries the tool refusal code family`);
  assert.ok(!read.serialized.includes(PRIMARY_MARKER), `${label}: no primary marker`);
  assert.ok(!read.serialized.includes(PRIMARY_TAG), `${label}: no primary tag`);
  assert.ok(!read.serialized.includes("linked-note.md"), `${label}: no primary note path`);
}

/** What the primary Vault's content looks like in each resource, when the read is permitted. */
const PERMITTED = {
  "obsidian://vault/index": [PRIMARY_MARKER],
  "obsidian://vault/tags": [PRIMARY_TAG],
  "obsidian://vault/graph": ["linked-note.md", `${PRIMARY_MARKER}.md`],
};

test.before(seedVault);
test.after(() => fs.rm(ROOT, { recursive: true, force: true }));

test("a secondary-only credential is refused on every Vault resource and sees no Vault content", async (t) => {
  const { port } = await startHarness(t);
  const authorization = "Bearer secondary-only";
  const session = await openSession(port, { authorization });

  for (const uri of VAULT_URIS) {
    const read = await readResource(port, session, uri, { authorization });
    assertRefused(read, `secondary-only ${uri}`);
  }
});

test("a credential with no Vault at all is refused on every Vault resource and sees no Vault content", async (t) => {
  const { port } = await startHarness(t);
  const authorization = "Bearer no-vault";
  const session = await openSession(port, { authorization });

  for (const uri of VAULT_URIS) {
    const read = await readResource(port, session, uri, { authorization });
    assertRefused(read, `no-vault ${uri}`);
  }
});

test("a credential that holds the primary Vault still reads all three resources", async (t) => {
  const { port } = await startHarness(t);
  const authorization = "Bearer full";
  const session = await openSession(port, { authorization });

  for (const uri of VAULT_URIS) {
    const read = await readResource(port, session, uri, { authorization });
    assert.ok(!read.result?.isError, `${uri} must not be refused: ${read.serialized}`);
    assert.ok(read.text, `${uri} returns content`);
    for (const marker of PERMITTED[uri]) assert.ok(read.text.includes(marker), `${uri} carries ${marker}`);
  }
});

test("the instance-level memory-policy resource works for a credential with no Vault", async (t) => {
  const { port } = await startHarness(t);
  const authorization = "Bearer no-vault";
  const session = await openSession(port, { authorization });

  const read = await readResource(port, session, MEMORY_POLICY_URI, { authorization });
  assert.ok(!read.result?.isError, `memory-policy must not be refused: ${read.serialized}`);
  assert.deepEqual(JSON.parse(read.text), getAgentBootstrap(), "the memory policy is the instance policy, unchanged");
  assert.ok(!read.serialized.includes(PRIMARY_MARKER), "the memory policy carries no Vault content");
});

test("a deployment with no credential plane keeps its resource reads (same rule as tools/call)", async (t) => {
  const { port } = await startHarness(t);
  const session = await openSession(port);

  // Without `API_KEY` and without an OAuth service `server.js` mounts no credential middleware, so
  // `authInfo` is absent for every request and `tools/call` is unrestricted too. The gate only ever
  // narrows an existing credential's reach; it never invents a Vault grant.
  const read = await readResource(port, session, "obsidian://vault/index");
  assert.ok(!read.result?.isError, `no credential plane means no allowlist to enforce: ${read.serialized}`);
  assert.ok(read.text.includes(PRIMARY_MARKER));
});
