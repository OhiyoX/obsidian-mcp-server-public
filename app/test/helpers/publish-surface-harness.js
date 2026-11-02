// Shared harness for the A4 Publish surface-error tests (Web route + MCP `manage_publish`).
//
// Everything here is lazy: importing this module must have no side effects, because the test
// runner also scans `test/**` and any file it picks up would otherwise create temp Vaults or
// log the fixture in. Call `ensureFixture()` / `mcpServer()` and finish with `cleanup()`.
//
// `ensureFixture()` sets `VAULT_PATH`/`DATA_PATH` before the *dynamic* import of the Web router
// and PublishService, so the module-scope config reads see the temp Vault (same pattern as
// `app/test/publish-http.test.js`). The MCP surface is a real spawned server driving the real
// `/mcp` JSON-RPC endpoint over HTTP.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Contract §7 domain codes. The definition site is A1's `app/src/publish/target.js`
// (`UNSUPPORTED_PUBLISH_TARGET` / `PUBLISH_TARGET_MISSING`); A4 re-states the literals instead
// of importing that lane's branch so the tests stay executable on the frozen BASE while still
// pinning what B1/C1/C2 must produce. The error *text* is explicitly not part of the contract.
export const CODE_UNSUPPORTED_TARGET = "unsupported_publish_target";
export const CODE_TARGET_MISSING = "publish_target_missing";
export const CODE_INVALID_TARGET_PATH = "invalid_publish_target_path";
export const CODE_TARGET_NOT_A_FILE = "publish_target_not_a_file";
export const CODE_TARGET_TOO_LARGE = "publish_target_too_large";

// ---------------------------------------------------------------- PENDING / negative control
// A contract probe is skipped with a reason until its owning lane lands. The skip is bypassed
// only by an explicit `P278_A4_FORCE_PENDING=<key>` (or `all`) run, which is how the negative
// control proves the skipped assertion is a real red detector instead of a vacuous one.
const FORCE_PENDING = String(process.env.P278_A4_FORCE_PENDING || "").trim();

export function pending(key, reason) {
  const forced = FORCE_PENDING === "all" || FORCE_PENDING === key;
  return forced ? {} : { skip: `PENDING(B1/C1/C2): ${reason}` };
}

// ---------------------------------------------------------------- in-process Web fixture
const OWNER = {
  id: "user-1",
  username: "owner",
  displayName: "Owner",
  updatedAt: "v1",
  allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
  allowedVaults: ["default"],
};
const provider = {
  authenticateOAuthUser: async (username, password) => (username === "owner" && password === "password" ? OWNER : null),
  oauthUserSessionRecord: async (id) => (id === OWNER.id ? OWNER : null),
  recordAudit() {},
};

let modulesPromise = null;
let fixturePromise = null;
let fixtureRoot = null;
const webSessions = [];
let mcpState = null;
let mcpRoot = null;

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** Real HTTP Web surface with a real session login and a real CSRF token. */
async function startWebApp(publishService) {
  const { createWebAppRouter } = await ensureModules();
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false, publishService }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "owner", password: "password" }),
  });
  assert.equal(login.status, 303, "fixture login must succeed before the surface can be characterized");
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const appHtml = await (await fetch(`${base}/app`, { headers: { Cookie: cookie } })).text();
  const csrf = appHtml.match(/name="csrf-token" content="([^"]+)"/)[1];
  const session = { base, cookie, csrf, server };
  session.post = async (body) => {
    const response = await fetch(`${base}/api/web/v1/publish`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON bodies are asserted as text */ }
    return { status: response.status, text, json };
  };
  session.anonymous = async (id) => {
    const response = await fetch(`${base}/publish/${encodeURIComponent(id)}`, { redirect: "manual" });
    return { status: response.status, text: await response.text() };
  };
  session.close = () => new Promise((resolve) => server.close(resolve));
  webSessions.push(session);
  return session;
}

/** Temp Vault + data dir, plus the dynamically imported production modules. The dynamic
 *  imports must happen *after* the env override and must not depend on `ensureFixture()`
 *  (which itself awaits `startWebApp`) — two nested memos avoid that await cycle. */
async function ensureModules() {
  if (modulesPromise) return modulesPromise;
  modulesPromise = (async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-surface-"));
    fixtureRoot = root;
    const vault = path.join(root, "vault");
    const data = path.join(root, "data");
    await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
    await fs.writeFile(path.join(vault, "Notes", "ok.md"), "# OK\n\npublic body\n", "utf8");
    await fs.writeFile(path.join(vault, "Notes", "diagram.canvas"), JSON.stringify({ nodes: [], edges: [] }), "utf8");
    // The case variant must be created *explicitly*: the surface assertions publish
    // `Notes/diagram.CANVAS` and expect the frozen `unsupported_publish_target` (400). The
    // implementation stats the target before it inspects the extension, so on a case-sensitive
    // filesystem (Linux/CI) an absent uppercase spelling hits `publish_target_missing` (404)
    // first, while a case-insensitive filesystem (Windows) silently resolves it to the
    // lowercase file. Writing the variant makes that 400 a cross-platform literal instead of a
    // Windows-only resolution artefact.
    await fs.writeFile(path.join(vault, "Notes", "diagram.CANVAS"), JSON.stringify({ nodes: [], edges: [] }), "utf8");
    await fs.writeFile(path.join(vault, "Notes", "raw.txt"), "plain text\n", "utf8");
    await fs.writeFile(path.join(vault, "Notes", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]), "utf8");
    await fs.writeFile(path.join(vault, "Notes", "gone.md"), "# Gone\n", "utf8");
    await fs.writeFile(path.join(vault, "Notes", "orphan.md"), "# Orphan\n", "utf8");
    process.env.VAULT_PATH = vault;
    process.env.DATA_PATH = data;
    delete process.env.WEB_VAULTS_ROOT;

    const [{ createWebAppRouter }, { PublishService }] = await Promise.all([
      import("../../src/app/routes.js"),
      import("../../src/publish/service.js"),
    ]);
    return { root, vault, data, createWebAppRouter, PublishService };
  })();
  return modulesPromise;
}

/** The Web router + the shared PublishService + one logged-in session, on a temp Vault. */
export async function ensureFixture() {
  if (fixturePromise) return fixturePromise;
  fixturePromise = (async () => {
    const modules = await ensureModules();
    const service = new modules.PublishService({ file: path.join(modules.data, "publish", "shared-state.json") });
    const web = await startWebApp(service);
    return { ...modules, service, web };
  })();
  return fixturePromise;
}

/** §12.3 fixture: a hand-written v1 state file holding a non-Markdown record, a missing
 *  (orphan) record and one healthy record, loaded by a fresh PublishService + Web app. */
export async function historicalFixture(name) {
  const { data, PublishService } = await ensureModules();
  const file = path.join(data, "publish", `historical-${name}.json`);
  const ids = { nonMarkdown: "H".repeat(43), orphan: "G".repeat(43), healthy: "V".repeat(43) };
  const stamp = "2026-01-01T00:00:00.000Z";
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    records: [
      { id: ids.nonMarkdown, vaultId: "default", path: "Notes/diagram.canvas", createdAt: stamp, updatedAt: stamp, createdBy: "fixture" },
      { id: ids.orphan, vaultId: "default", path: "Notes/ghost.md", createdAt: stamp, updatedAt: stamp, createdBy: "fixture" },
      { id: ids.healthy, vaultId: "default", path: "Notes/ok.md", createdAt: stamp, updatedAt: stamp, createdBy: "fixture" },
    ],
  }, null, 2), "utf8");
  const service = new PublishService({ file });
  await service.ready;
  const session = await startWebApp(service);
  return { file, ids, service, session };
}

// ---------------------------------------------------------------- payload helpers
export function errorCode(body) {
  if (!body || typeof body !== "object") return null;
  if (typeof body.code === "string") return body.code;
  if (body.error && typeof body.error === "object" && typeof body.error.code === "string") return body.error.code;
  return null;
}

/** Rejects any payload that carries a server-side absolute path in any spelling: raw, with
 *  forward slashes, or JSON-escaped (a plain `JSON.stringify` check would silently miss
 *  Windows separators, so every spelling is checked against the JSON and the raw prose). */
export function assertNoServerPath(value, roots, label) {
  const texts = typeof value === "string"
    ? [value]
    : [JSON.stringify(value), ...(value?.content || []).map((item) => item.text ?? "")];
  const spellings = new Set();
  for (const candidate of roots) {
    const raw = String(candidate);
    const flat = raw.replaceAll("\\", "/");
    for (const spelling of [raw, flat]) {
      spellings.add(spelling);
      spellings.add(JSON.stringify(spelling).slice(1, -1));
    }
  }
  for (const text of texts) {
    for (const spelling of spellings) {
      assert.ok(!text.includes(spelling), `${label} leaks the server absolute path ${spelling}: ${text}`);
    }
  }
}

/** Record classification, whichever field name B1/C3 end up persisting (§9). */
export function recordState(record) {
  return record?.state ?? record?.status ?? record?.lifecycle ?? null;
}

/** Admin-facing listing: inactive records must remain visible (§9). */
export function listForAdmin(service) {
  return service.list({ includeInactive: true });
}

export function resultText(result) {
  return (result?.content || []).map((item) => item.text ?? "").join("\n");
}

// ---------------------------------------------------------------- real MCP server fixture
const API_KEY = "a4-surface-errors-key";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let escalate;
    const finish = () => { clearTimeout(escalate); resolve(); };
    child.once("exit", finish);
    escalate = setTimeout(() => { child.kill("SIGKILL"); finish(); }, 5000);
    escalate.unref?.();
    child.kill();
  });
}

/** Spawns the real server and drives `manage_publish` over real `/mcp` HTTP (JSON-RPC). */
export async function mcpServer() {
  if (mcpState) return mcpState;
  await ensureModules();
  mcpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-surface-mcp-"));
  const mcpVault = path.join(mcpRoot, "vault");
  const port = await freePort();
  await fs.mkdir(path.join(mcpVault, "Notes"), { recursive: true });
  await fs.writeFile(path.join(mcpVault, "Notes", "ok.md"), "# OK\n", "utf8");
  await fs.writeFile(path.join(mcpVault, "Notes", "diagram.canvas"), JSON.stringify({ nodes: [] }), "utf8");
  await fs.writeFile(path.join(mcpVault, "Notes", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]), "utf8");
  await fs.writeFile(path.join(mcpVault, "Notes", "orphan.md"), "# Orphan\n", "utf8");

  const child = spawn(process.execPath, ["server.js"], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: mcpVault,
      DATA_PATH: path.join(mcpRoot, "data"),
      API_KEY,
      API_KEY_HEADER: "X-API-Key",
      OAUTH_ENABLED: "false",
      GIT_ENABLED: "false",
      WEB_CATALOG_ENABLED: "false",
      EMBEDDING_PROVIDER: "disabled",
      MCP_DEFAULT_AUTHOR_AGENT: "",
      MCP_DEFAULT_AUTHOR_MODEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 450; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`MCP fixture server exited early (${child.exitCode}): ${output.join("")}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* not listening yet */ }
    if (attempt === 449) throw new Error(`MCP fixture server never became healthy: ${output.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async function post(body, session) {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-API-Key": API_KEY,
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const payload = response.headers.get("content-type")?.includes("event-stream")
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))[0]
      : (text ? JSON.parse(text) : null);
    return { status: response.status, session: response.headers.get("mcp-session-id"), payload };
  }

  const initialized = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-client", version: "1" } },
  });
  assert.equal(initialized.status, 200, JSON.stringify(initialized.payload));
  assert.ok(initialized.session, "the MCP fixture must return a session id");

  let nextId = 2;
  mcpState = {
    base,
    child,
    vault: mcpVault,
    data: path.join(mcpRoot, "data"),
    root: mcpRoot,
    async callTool(name, args) {
      const response = await post(
        { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } },
        initialized.session,
      );
      assert.equal(response.status, 200, `tools/call ${name} transport failure: ${JSON.stringify(response.payload)}`);
      assert.ok(response.payload?.result, `tools/call ${name} returned no result: ${JSON.stringify(response.payload)}`);
      return response.payload.result;
    },
    /** Raw JSON-RPC reply, for assertions about a refusal that happens *before* the transport
     * (Wave C: the HTTP credential Vault gate answers 403 and no tool result exists). */
    callToolRaw(name, args) {
      return post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, initialized.session);
    },
    post,
  };
  return mcpState;
}

/** Closes every fixture this module opened and removes its temp directories. */
export async function cleanup() {
  await Promise.all(webSessions.splice(0).map((session) => session.close()));
  if (mcpState) {
    await stopChild(mcpState.child);
    mcpState = null;
  }
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
  if (mcpRoot) {
    await fs.rm(mcpRoot, { recursive: true, force: true });
    mcpRoot = null;
  }
}
