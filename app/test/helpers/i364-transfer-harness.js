// Shared harness for the #364 authorization-transfer provider tests.
//
// Owns the one temporary `DATA_PATH` per test file (the OAuth provider resolves its
// state file at module load), the provider factory, and the login/consent helpers
// so the two provider-level suites stay under the line budget without duplicating
// the setup or weakening the flow (real `authorize` → `handleApproval` → real code
// exchange, real durable files, real audit trail).

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

export const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-i364-harness-"));
process.env.DATA_PATH = root;
process.env.PUBLIC_BASE_URL = "http://localhost:18923";
process.env.OAUTH_ADMIN_PASSWORD = "test-only-password";
process.env.OAUTH_INITIAL_USERNAME = "i364-owner";
process.env.OAUTH_INITIAL_PASSWORD = "i364-oauth-password";
process.env.MCP_PATH = "/mcp";
process.env.WEB_DEFAULT_VAULT = "default";

export const { createOAuthService } = await import("../../src/oauth-provider.js");
export const { createAuthorizationTransferStore } = await import("../../src/oauth/authorization-transfer-store.js");
export const { AuthorizationTransferError } = await import("../../src/oauth/authorization-transfer-methods.js");

export const MCP_URL = "http://localhost:18923/mcp";
export const STATE_FILE = path.join(root, "oauth", "state.json");
export const PASSWORD = "i364-test-password";

const providers = new Set();
let sequence = 0;

export function newStoreFile(name) {
  sequence += 1;
  return path.join(root, "oauth", `transfers-${name}-${sequence}.json`);
}

/**
 * `service({ store, closeSessions })`. Without an explicit hook the close report is
 * truthfully empty (a pure-provider test has no live MCP transports); the real
 * `closeSessionsForClient` is exercised in `authorization-transfer-transport.test.js`.
 */
export function service({ store = null, closeSessions = null } = {}) {
  const closeCalls = [];
  const hook = closeSessions ?? (async (clientId, { userId } = {}) => {
    closeCalls.push({ clientId, userId });
    return { clientId, userId, matched: 0, closed: 0, failed: 0, sessionIds: [], failures: [] };
  });
  const created = createOAuthService({
    transferStore: store ?? createAuthorizationTransferStore({ file: newStoreFile("auto") }),
    closeSessions: hook,
  });
  providers.add(created.provider);
  return { ...created, closeCalls };
}

/**
 * Flush every provider's debounced activity save. All providers in one test file share
 * `state.json`, and a stale timer must never race a later test's rename (Windows
 * surfaces that as EPERM).
 */
export async function drainProviders() {
  for (const provider of providers) await provider.drainPersistence().catch(() => {});
}

export async function cleanupHarness() {
  await drainProviders();
  await fs.rm(root, { recursive: true, force: true });
}

export function htmlResponse() {
  return {
    status(value) { this.statusCode = value; return this; },
    type() { return this; },
    send(value) { this.body = value; return this; },
  };
}

export async function registerClient(provider, clientId) {
  await provider.clientsStore.registerClient({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientId,
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  return clientId;
}

export async function newUser(provider, username, { scopes = ["obsidian.read", "obsidian.write"], vaults = ["default"] } = {}) {
  return provider.createOAuthUser({ username, password: PASSWORD, displayName: username, allowedScopes: scopes, allowedVaults: vaults });
}

/** Mint a pre-fence credential directly (generation 0) for a `(client, user)` pair. */
export function grant(provider, clientId, userId, { scopes = ["obsidian.read"], vaults = ["default"] } = {}) {
  return provider.issueTokens(clientId, scopes, MCP_URL, userId, vaults);
}

export function recordId(provider, collection, rawToken) {
  return provider.data[collection][createHash("sha256").update(rawToken).digest("hex")].id;
}

/** Create an unconsumed authorization code without exchanging it (normal consent). */
export async function issueCode(provider, clientId, username, { requested = ["obsidian.read"] } = {}) {
  const client = provider.data.clients[clientId];
  const response = htmlResponse();
  await provider.authorize(client, {
    state: "s", scopes: requested, redirectUri: client.redirect_uris[0], codeChallenge: "pkce", resource: MCP_URL,
  }, response);
  const transaction = response.body.match(/name="transaction" value="([^"]+)"/)[1];
  let redirect = null;
  await provider.handleApproval({
    body: { transaction, username, password: PASSWORD, scope: requested, decision: "allow" },
    headers: {}, socket: { remoteAddress: "127.0.0.1" },
  }, { status() { return this; }, type() { return this; }, send() { return this; }, redirect(_status, value) { redirect = value; } });
  if (!redirect) return null;
  return { client, code: new URL(redirect).searchParams.get("code") };
}

/** Full normal login + consent + code exchange (the contract's completion path). */
export async function consentAndExchange(provider, clientId, username, { requested = ["obsidian.read"] } = {}) {
  const issued = await issueCode(provider, clientId, username, { requested });
  assert.ok(issued, `consent for ${username} must succeed`);
  const tokens = await provider.exchangeAuthorizationCode(issued.client, issued.code, undefined, issued.client.redirect_uris[0], MCP_URL);
  return { tokens };
}

export function audit(provider, action, match = {}) {
  return provider.data.audit.filter((entry) => entry.action === action
    && Object.entries(match).every(([key, value]) => entry[key] === value));
}

export async function rejection(promise) {
  try {
    await promise;
    return { thrown: false };
  } catch (error) {
    return { thrown: true, error };
  }
}
