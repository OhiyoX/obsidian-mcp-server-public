// A live prompt-registry stack for tests: one process, one registry, one Admin API,
// one MCP endpoint whose sessions keep their identity through a publish.

import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createAdminRouter } from "../../src/admin/router.js";
import { getInitializeInstructions } from "../../src/agent-bootstrap.js";
import { bundledBasePack } from "../../src/prompt-registry/bundled.js";
import { setLivePromptRegistry, resetLivePromptRegistry } from "../../src/prompt-registry/live.js";
import { createPromptAdminService } from "../../src/prompt-registry/service.js";
import { createPromptNotificationFanout } from "../../src/prompt-registry/notification-fanout.js";
import { createPromptRegistry } from "../../src/prompt-registry/registry.js";
import { createPromptRegistryStore } from "../../src/prompt-registry/store.js";
import { registerObsidianCapabilities } from "../../src/capabilities.js";
import { createDiscoveryRuntimePolicy } from "../../src/discovery-runtime.js";
import { parseDiscoveryOperatorConfig } from "../../src/discovery-config.js";

export const PACK_ROOT = new URL("../../prompts/base/", import.meta.url).pathname;
export const PASSWORD = "test-only-admin-password";
export const SCOPES = ["obsidian.read", "obsidian.write", "obsidian.files"];

/**
 * Start the stack. `env` must already point VAULT_PATH and DATA_PATH at temp dirs
 * (see `prepareEnv`), because the config modules read it at import.
 */
export async function startStack(t, { profile = "full" } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "prompt-live-stack-"));
  const store = createPromptRegistryStore({
    headFile: path.join(dir, "agent-prompts.json"),
    packsDir: path.join(dir, "prompt-registry", "packs"),
    bundledBase: bundledBasePack(),
  });
  await store.ready;
  const registry = createPromptRegistry({ bundledBase: bundledBasePack(), store });
  setLivePromptRegistry(registry);
  const service = createPromptAdminService({ store, bundledBase: bundledBasePack() });

  const app = express();
  app.use("/admin/auth", createAdminRouter({
    provider: {
      ready: Promise.resolve(),
      recordAudit: () => {},
      async authorizationSnapshot() {
        return { oauthUsers: [], clients: [], apiKeys: [], tokens: [], audit: [], configuredApiKeyUsage: { lastUsedAt: null, lastSource: null } };
      },
    },
    adminPassword: PASSWORD,
    secureCookie: false,
    promptRegistryStore: store,
    promptAdminService: service,
  }));

  const sessions = new Map();
  const notifications = createPromptNotificationFanout({ sessions });
  service.subscribe((snapshot) => notifications.notifyPublished(snapshot));

  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    const scopes = req.header("x-test-scopes");
    req.auth = {
      type: "test",
      clientId: req.header("x-test-client") || "anonymous",
      scopes: scopes ? scopes.split(",").map((value) => value.trim()).filter(Boolean) : [...SCOPES],
      allowedVaults: ["vault"],
    };
    next();
  });
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
    const server = new McpServer({ name: "prompt-live-stack", version: "1" }, { instructions: getInitializeInstructions() });
    // Mirrors server.js: the registry is injected, so one request pins one snapshot.
    const discovery = createDiscoveryRuntimePolicy(server, parseDiscoveryOperatorConfig({ MCP_DISCOVERY_PROFILE: profile }), { authDisabled: false, promptRegistry: registry });
    registerObsidianCapabilities(discovery, { promptRegistry: registry });
    discovery.install();
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
    resetLivePromptRegistry();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, registry, service, notifications, sessions, dir, origin: `http://127.0.0.1:${httpServer.address().port}` };
}

/** Point the config modules at temp dirs before anything imports them. */
export async function prepareEnv() {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-live-env-"));
  process.env.VAULT_PATH = path.join(root, "vault");
  process.env.DATA_PATH = path.join(root, "data");
  process.env.OBSIDIAN_READ_ONLY = "false";
  process.env.OAUTH_ENABLED = "false";
  process.env.API_KEY = "";
  await mkdir(process.env.VAULT_PATH, { recursive: true });
  return root;
}

export async function connectMcp(origin, { scopes = SCOPES, client = "live-client" } = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { "x-test-scopes": scopes.join(","), "x-test-client": client } },
  });
  const mcp = new Client({ name: client, version: "1" }, { capabilities: {} });
  await mcp.connect(transport);
  return mcp;
}

/** The shipped pack, ready to be changed file by file. */
export async function shippedPack() {
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

export async function adminLogin(origin) {
  const login = await fetch(`${origin}/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: "manual",
  });
  if (login.status !== 303) throw new Error(`login failed: ${login.status}`);
  const cookie = (typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie")])
    .filter(Boolean)
    .map((item) => item.split(";")[0])
    .join("; ");
  const session = await (await fetch(`${origin}/admin/auth/prompt-registry/session`, { headers: { cookie } })).json();
  return { cookie, csrf: session.csrf };
}

export async function publishPack(origin, admin, pack, revision, reason = "test") {
  const response = await fetch(`${origin}/admin/auth/prompt-registry/base/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ csrf: admin.csrf, expectedRevision: revision, reason, pack }),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`publish ${response.status}: ${text}`);
  return JSON.parse(text);
}
