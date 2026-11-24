// P1 Task 7: publish without a restart, through the real Admin API, and watch an
// MCP session that is already open receive the new Base on its next call.
//
// Scope of the claim (P1 Exit Gate): `agent_bootstrap` and the memory reminders only.
// Full/compact `tools/list` and the MCP prompt list are P2's surface.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Isolate the config modules before any source import reads the environment.
const ENV_ROOT = await mkdtemp(path.join(tmpdir(), "prompt-live-env-"));
process.env.VAULT_PATH = path.join(ENV_ROOT, "vault");
process.env.DATA_PATH = path.join(ENV_ROOT, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
process.env.OAUTH_ENABLED = "false";
process.env.API_KEY = "";
await mkdir(process.env.VAULT_PATH, { recursive: true });

const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { getInitializeInstructions } = await import("../src/agent-bootstrap.js");
const { bundledBasePack } = await import("../src/prompt-registry/bundled.js");
const { setLivePromptRegistry, resetLivePromptRegistry } = await import("../src/prompt-registry/live.js");
const { createPromptRegistry } = await import("../src/prompt-registry/registry.js");
const { createPromptAdminService } = await import("../src/prompt-registry/service.js");
const { createPromptRegistryStore } = await import("../src/prompt-registry/store.js");
const { createAdminRouter } = await import("../src/admin/router.js");

test.after(() => rm(ENV_ROOT, { recursive: true, force: true }));

const PASSWORD = "test-only-admin-password";
const PACK_ROOT = new URL("../prompts/base/", import.meta.url).pathname;
const bundled = bundledBasePack();

function providerStub() {
  return {
    ready: Promise.resolve(),
    recordAudit: () => {},
    async authorizationSnapshot() {
      return { oauthUsers: [], clients: [], apiKeys: [], tokens: [], audit: [], configuredApiKeyUsage: { lastUsedAt: null, lastSource: null } };
    },
  };
}

/** One process: an MCP endpoint, an Admin API, a durable store and one registry. */
async function start(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "prompt-live-"));
  t.after(async () => {
    resetLivePromptRegistry();
    await rm(dir, { recursive: true, force: true });
  });
  const store = createPromptRegistryStore({
    headFile: path.join(dir, "agent-prompts.json"),
    packsDir: path.join(dir, "prompt-registry", "packs"),
    bundledBase: bundled,
  });
  await store.ready;
  const registry = createPromptRegistry({ bundledBase: bundled, store });
  setLivePromptRegistry(registry);
  const service = createPromptAdminService({ store, bundledBase: bundled });

  const app = express();
  app.use("/admin/auth", createAdminRouter({
    provider: providerStub(),
    adminPassword: PASSWORD,
    secureCookie: false,
    promptRegistryStore: store,
    promptAdminService: service,
  }));

  const sessions = new Map();
  app.use(express.json({ limit: "2mb" }));
  app.post("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    if (sessionId) {
      const record = sessions.get(sessionId);
      if (!record) {
        res.status(404).end();
        return;
      }
      await record.transport.handleRequest(req, res, req.body);
      return;
    }
    const server = new McpServer({ name: "prompt-live", version: "1" }, { instructions: getInitializeInstructions() });
    registerObsidianCapabilities(server);
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
    httpServer.close();
  });
  return { store, registry, dir, origin: `http://127.0.0.1:${httpServer.address().port}` };
}

/** An SDK client over the real HTTP transport, so the session survives our publish. */
async function connectMcp(origin) {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "prompt-live-client", version: "1" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  return client;
}

async function adminSession(origin) {
  const login = await fetch(`${origin}/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: "manual",
  });
  assert.equal(login.status, 303);
  const cookie = (typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie")])
    .filter(Boolean)
    .map((item) => item.split(";")[0])
    .join("; ");
  const session = await (await fetch(`${origin}/admin/auth/prompt-registry/session`, { headers: { cookie } })).json();
  return { cookie, csrf: session.csrf };
}

async function publish(origin, admin, pack, revision, reason) {
  const response = await fetch(`${origin}/admin/auth/prompt-registry/base/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ csrf: admin.csrf, expectedRevision: revision, reason, pack }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function shippedPack() {
  const manifest = JSON.parse(await readFile(path.join(PACK_ROOT, "manifest.json"), "utf8"));
  const files = {};
  const walk = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else if (entry.name.endsWith(".md")) files[relative] = await readFile(path.join(directory, entry.name), "utf8");
    }
  };
  await walk(PACK_ROOT);
  return { manifest, files };
}

test("an open MCP session sees a published Base on its next agent_bootstrap call", async (t) => {
  const { store, origin, dir } = await start(t);
  const admin = await adminSession(origin);
  const client = await connectMcp(origin);
  t.after(() => client.close());

  const pid = process.pid;
  const before = JSON.parse((await client.callTool({ name: "agent_bootstrap", arguments: { client: "live-test" } })).content[0].text);
  assert.match(before.instructions, /Obsidian project-memory server/);

  const pack = await shippedPack();
  const instructionsFile = "bootstrap/instructions.md";
  pack.files[instructionsFile] = `${pack.files[instructionsFile].trimEnd()} Live published sentence.\n`;
  const published = await publish(origin, admin, pack, 0, "live test");
  assert.equal(published.revision, 1);

  const after = JSON.parse((await client.callTool({ name: "agent_bootstrap", arguments: { client: "live-test" } })).content[0].text);
  assert.match(after.instructions, /Live published sentence\./);
  assert.equal(after.policyVersion, before.policyVersion, "the contract version is code-owned");
  assert.equal(process.pid, pid, "the same process served both calls");

  // The head is durable: a fresh store over the same data directory reads revision 1.
  const reopened = createPromptRegistryStore({
    headFile: path.join(dir, "agent-prompts.json"),
    packsDir: path.join(dir, "prompt-registry", "packs"),
    bundledBase: bundled,
  });
  await reopened.ready;
  assert.equal(reopened.snapshot().revision, 1);
  assert.match(reopened.snapshot().values["bootstrap.instructions"], /Live published sentence\./);
  assert.equal(store.snapshot().revision, 1);
});

test("a published reminder reaches the next call that carries one", async (t) => {
  const { origin } = await start(t);
  const admin = await adminSession(origin);
  const pack = await shippedPack();
  pack.files["memory/first-read.md"] = "Published first-read reminder.\n";
  await publish(origin, admin, pack, 0, "reminder test");

  const client = await connectMcp(origin);
  t.after(() => client.close());
  const result = await client.callTool({ name: "search_notes", arguments: { query: "anything-not-present-here", limit: 1 } });
  const texts = result.content.filter((block) => block.type === "text").map((block) => block.text);
  assert.ok(texts.includes("Published first-read reminder."), texts.join(" | "));
});

test("a stale publish from a second admin session is refused in the live stack", async (t) => {
  const { origin } = await start(t);
  const first = await adminSession(origin);
  const second = await adminSession(origin);
  const pack = await shippedPack();
  await publish(origin, first, pack, 0, "first");
  const stale = await fetch(`${origin}/admin/auth/prompt-registry/base/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: second.cookie },
    body: JSON.stringify({ csrf: second.csrf, expectedRevision: 0, reason: "second", pack }),
  });
  assert.equal(stale.status, 409);
});
