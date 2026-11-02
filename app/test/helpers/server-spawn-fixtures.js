// Shared spawn/HTTP fixtures for the AuthZ Wave C real-server integration tests.
//
// Contract: `scratch/authz/INTERFACE.md` §10.1/§10.2/§10.3/§10.6 and the C1 BRIEF
// §2. These helpers spawn the real `server.js` (`spawn(process.execPath,
// ["server.js"])`) against a temporary DATA_PATH and talk to it over HTTP, so
// wiring defects that pure helper tests cannot see (registration order, middleware
// injection, health aggregation, Stage 0 zero-difference, shutdown drain
// ownership) can be exercised for real. Nothing here asserts on its own; the
// assertions live in `access-policy-server-integration.test.js` and
// `access-policy-server-integration-lifecycle.test.js`.
//
// Determinism: every policy window used here is unambiguously outside its window
// (an `expiresAt` in the past), so no test reads the ambient clock for a decision
// and none sleeps to cross a boundary. Policy changes between phases are applied
// by restarting the process, because the durable store has no file watcher by
// design (DEVELOPMENT §10.1).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  ACCESS_POLICY_SCHEMA_VERSION,
  newPolicyId,
  serializeAccessPolicyDocument,
  validateAccessPolicyDocument,
} from "../../src/access-policy/schema.js";

export const APP_DIR = path.resolve(import.meta.dirname, "..", "..");
export const API_KEY = "wave-c-configured-env-key";
const ADMIN_PASSWORD = "test-only-password";
const WEB_USER = "test-owner";
const WEB_PASSWORD = "test-oauth-password";
const CONFIGURED_SUBJECT = "api-key:configured-env";
export const METADATA_TOOLS = ["server_info", "agent_bootstrap"];

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

// Stop a spawned server without hanging the suite (see server-oauth.test.js).
export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let escalate;
    const finish = () => { clearTimeout(escalate); resolve(); };
    child.once("exit", finish);
    escalate = setTimeout(() => { child.kill("SIGKILL"); finish(); }, 5000);
    escalate.unref?.();
    child.kill();
  });
}

export function serverEnv({ port, root, extra = {} }) {
  return {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    VAULT_PATH: path.join(root, "vault"),
    DATA_PATH: path.join(root, "data"),
    OAUTH_ENABLED: "true",
    PUBLIC_BASE_URL: `http://localhost:${port}`,
    OAUTH_ADMIN_PASSWORD: ADMIN_PASSWORD,
    OAUTH_INITIAL_USERNAME: WEB_USER,
    OAUTH_INITIAL_PASSWORD: WEB_PASSWORD,
    API_KEY,
    GIT_ENABLED: "false",
    EMBEDDING_PROVIDER: "disabled",
    ...extra,
  };
}

export async function startServer(env) {
  const child = spawn(process.execPath, ["server.js"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const base = `http://127.0.0.1:${env.PORT}`;
  for (let attempt = 0; attempt < 450; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${output.join("")}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return { child, base, publicBase: `http://localhost:${env.PORT}`, output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopChild(child);
  throw new Error(`timed out waiting for the server: ${output.join("")}`);
}

export async function seedVault(root) {
  await fs.mkdir(path.join(root, "vault", ".obsidian"), { recursive: true });
  await fs.writeFile(path.join(root, "vault", "note.md"), "# Integration note\n\nbody\n", "utf8");
}

export async function writePolicy(root, policies, revision = 1) {
  const document = validateAccessPolicyDocument({
    schemaVersion: ACCESS_POLICY_SCHEMA_VERSION,
    revision,
    policies,
  });
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "access-policy.json"), serializeAccessPolicyDocument(document), "utf8");
}

export async function writeCorruptPolicy(root) {
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "access-policy.json"), "{ this is not valid json", "utf8");
}

export function outsideWindowPolicy(overrides = {}) {
  return {
    id: newPolicyId(),
    label: "wave-c integration",
    enabled: true,
    subjects: [CONFIGURED_SUBJECT],
    mode: "suspend",
    capabilities: ["scope:obsidian.read"],
    timezone: "UTC",
    weekly: {},
    dateRanges: [],
    startsAt: null,
    expiresAt: "2000-01-01T00:00:00.000Z",
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

function parsePayload(text, contentType, id) {
  if (!text) return null;
  if (contentType?.includes("event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5));
        if (id === undefined || parsed?.id === id) return parsed;
      } catch {}
    }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

export async function mcp(base, { key, bearer, session, body, method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (key) headers["X-API-Key"] = key;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (session) headers["Mcp-Session-Id"] = session;
  const response = await fetch(`${base}/mcp`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    payload: parsePayload(text, response.headers.get("content-type"), body?.id),
    text,
    session: response.headers.get("mcp-session-id") || session,
  };
}

export async function initialize(base, auth = {}) {
  return mcp(base, {
    ...auth,
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wave-c-integration", version: "1" } } },
  });
}

export async function callTool(base, auth, session, name, args = {}, id = 5) {
  return mcp(base, {
    ...auth,
    session,
    body: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
  });
}

export async function listTools(base, auth, session) {
  return mcp(base, { ...auth, session, body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
}

async function readAudit(root) {
  try {
    const raw = await fs.readFile(path.join(root, "data", "oauth", "state.json"), "utf8");
    const state = JSON.parse(raw);
    return Array.isArray(state.audit) ? state.audit : [];
  } catch {
    return [];
  }
}

// `recordAudit` only schedules a debounced save, so the on-disk audit trails the
// in-memory one. Poll the durable file rather than racing it.
export async function waitForAudit(root, predicate, { attempts = 40, delay = 100 } = {}) {
  let audit = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    audit = await readAudit(root);
    if (predicate(audit)) return audit;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return audit;
}

async function adminLogin(base) {
  const login = await fetch(`${base}/admin/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const page = await fetch(`${base}/admin/auth`, { headers: { Cookie: cookie } });
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf, "admin page must expose a CSRF token");
  return { cookie, csrf };
}

export async function createManagedApiKey(base, { scopes = ["obsidian.read"], vault = "vault", label = "wave-c second principal" } = {}) {
  const { cookie, csrf } = await adminLogin(base);
  const body = new URLSearchParams({ csrf, label, allowedVault: vault });
  for (const scope of scopes) body.append("allowedScope", scope);
  const created = await fetch(`${base}/admin/auth/api-key/create`, {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  assert.equal(created.status, 303);
  const keysHtml = await (await fetch(`${base}/admin/auth?tab=keys`, { headers: { Cookie: cookie } })).text();
  const key = keysHtml.match(/obmcp_[0-9a-f]{12}_[A-Za-z0-9_-]+/)?.[0];
  assert.ok(key, "the created API key secret must be rendered once");
  return { key };
}

// --- real OAuth (authorization code + PKCE) ---------------------------------

export async function registerOAuthClient(base) {
  const callback = `${base}/callback`;
  const registered = await (await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Wave C integration", redirect_uris: [callback], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  })).json();
  assert.ok(registered.client_id, "client registration must return a client_id");
  return { callback, registered };
}

export async function approveAndExchange(base, { callback, registered, resource }) {
  const verifier = "wave-c-integration-verifier-0123456789-abcdefghijklmnop";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", state: "wave-c", resource, scope: "obsidian.read" });
  const consent = await (await fetch(authorizeUrl)).text();
  const transaction = consent.match(/name="transaction" value="([^"]+)"/)?.[1];
  assert.ok(transaction, "the consent page must expose a transaction");
  const approved = await fetch(`${base}/oauth/decision`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction, username: WEB_USER, password: WEB_PASSWORD, scope: "obsidian.read", decision: "allow" }),
  });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const tokens = await (await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, code, code_verifier: verifier, redirect_uri: callback, resource }),
  })).json();
  assert.ok(tokens.access_token && tokens.refresh_token, `expected tokens, got ${JSON.stringify(tokens)}`);
  return tokens;
}

export async function refreshTokens(base, { callback, registered, resource }, refreshToken) {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: registered.client_id, refresh_token: refreshToken, resource }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text };
}
