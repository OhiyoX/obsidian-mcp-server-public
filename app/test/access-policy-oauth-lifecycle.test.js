// AuthZ Wave B / B2 — OAuth lifecycle hard revoke gate.
//
// Contract: `scratch/authz/INTERFACE.md` §10.2 and DEVELOPMENT §13/§20.6.
// Real `PersistentOAuthProvider` (temp DATA_PATH), real access-policy runtime and
// store fixtures, and a real SDK `mcpAuthRouter` token endpoint for the wire
// payload of a denied refresh.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-authz-oauth-lifecycle-"));
process.env.DATA_PATH = root;
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:18923";
process.env.OAUTH_ADMIN_PASSWORD = "test-only-password";
process.env.OAUTH_INITIAL_USERNAME = "test-owner";
process.env.OAUTH_INITIAL_PASSWORD = "test-oauth-password";
process.env.MCP_PATH = "/mcp";
process.env.GIT_ENABLED = "false";
process.env.OAUTH_REFRESH_REUSE_GRACE_SECONDS = "1";

const [
  { createOAuthService, OAUTH_SCOPES },
  { mcpAuthRouter },
  { oauthEndpointHardening },
  { createAccessPolicyRuntime },
  { digest },
  fixtures,
] = await Promise.all([
  import("../src/oauth-provider.js"),
  import("@modelcontextprotocol/sdk/server/auth/router.js"),
  import("../src/oauth/hardening.js"),
  import("../src/access-policy/runtime.js"),
  import("../src/oauth/primitives.js"),
  import("./helpers/access-policy-fixtures.js"),
]);

const { fakeClock, fakeStore, policyFixture, snapshotFixture } = fixtures;

const WINDOW_CLOSED = Date.UTC(2026, 9, 4, 0, 0); // Sun 08:00 Asia/Shanghai — outside
const WINDOW_OPEN = Date.UTC(2026, 9, 7, 2, 0); // Wed 10:00 Asia/Shanghai — inside
const MCP_URL = "http://127.0.0.1:18923/mcp";
const SCOPES = ["obsidian.read"];

const providers = new Set();
// All providers in this file share one DATA_PATH/state.json. Draining the
// previous provider before constructing the next keeps the atomic-rename saves
// strictly serialized (Windows EPERM on a concurrent rename to the same target).
async function newService(accessRuntime) {
  for (const provider of providers) await provider.drainPersistence();
  const service = createOAuthService({ accessRuntime });
  providers.add(service.provider);
  return service;
}

after(async () => {
  for (const provider of providers) await provider.drainPersistence();
  await fs.rm(root, { recursive: true, force: true });
});

function policyFor({ mode = "revoke", subjects }) {
  return policyFixture({ mode, capabilities: ["all"], subjects, timezone: "Asia/Shanghai" });
}

async function runtimeFor({ policies = [], clock = fakeClock(WINDOW_CLOSED), status = "ready" } = {}) {
  const store = fakeStore({
    snapshot: snapshotFixture({ status, revision: status === "ready" ? 1 : null, policies }),
  });
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: clock.now });
  await runtime.ready;
  return runtime;
}

async function registerClient(service, clientId) {
  await service.provider.clientsStore.registerClient({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientId,
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  return { client_id: clientId, redirect_uris: ["https://client.example/callback"] };
}

/** Issues an access + refresh token for an already-registered client (real state). */
function grant(service, clientId, userId = "user-1") {
  return service.provider.issueTokens(clientId, SCOPES, MCP_URL, userId, ["default"]);
}

function refreshRecord(service, refreshToken) {
  return service.provider.data.refreshTokens[digest(refreshToken)];
}

function accessTokenCount(service, clientId) {
  return Object.values(service.provider.data.accessTokens).filter((record) => record.clientId === clientId).length;
}

function denies(service, client, refreshToken) {
  return service.provider.exchangeRefreshToken(client, refreshToken, SCOPES, service.resource);
}

function codeChallengeFor(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Runs the real authorize + approval flow (window must be open) and returns the code. */
async function approve(service, client, { scopes = SCOPES, codeChallenge = "pkce-challenge" } = {}) {
  const authorizeResponse = fakeResponse();
  await service.provider.authorize(client, {
    state: "opaque-state", scopes, redirectUri: client.redirect_uris[0], codeChallenge, resource: service.resource,
  }, authorizeResponse);
  const transaction = authorizeResponse.body.match(/name="transaction" value="([^"]+)"/)[1];
  const approval = { body: { transaction, username: "test-owner", password: "test-oauth-password", scope: scopes, decision: "allow" }, headers: {}, socket: {} };
  const response = fakeResponse();
  await service.provider.handleApproval(approval, response);
  assert.equal(response.statusCode, 302, "approval is expected to succeed while the window is open");
  return new URL(response.redirectTo).searchParams.get("code");
}

function exchange(service, client, code, { verifier, redirectUri = client.redirect_uris[0] } = {}) {
  return service.provider.exchangeAuthorizationCode(client, code, verifier, redirectUri, service.resource);
}

function codeRecord(service, code) {
  return service.provider.data.codes[digest(code)];
}

// Every provider in this file shares one DATA_PATH, so loaded audit entries from
// earlier tests are always filtered out by a unique identifier.
function denialAudit(service, filter = {}) {
  return service.provider.data.audit.filter((entry) => entry.action === "authz.deny"
    && (!filter.clientId || entry.clientId === filter.clientId)
    && (!filter.userId || entry.userId === filter.userId)
    && (!filter.credentialId || entry.credentialId === filter.credentialId));
}

/** Boots the real SDK auth router (token + discovery endpoints) over HTTP. */
async function bootRouter(service) {
  const app = express();
  app.use(oauthEndpointHardening());
  app.use(mcpAuthRouter({
    provider: service.provider,
    issuerUrl: service.issuer,
    resourceServerUrl: service.resource,
    scopesSupported: OAUTH_SCOPES,
    resourceName: "Obsidian Vault MCP",
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    status(value) { this.statusCode = value; return this; },
    type() { return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    send(value) { this.body = value; return this; },
    redirect(status, value) { this.statusCode = status; this.redirectTo = value; return this; },
  };
}

test("suspend does not affect refresh: tokens are still issued", async () => {
  const service = await newService(await runtimeFor({ policies: [policyFor({ mode: "suspend", subjects: ["oauth-user:user-1"] })] }));
  const client = await registerClient(service, "client-suspend");
  const issued = grant(service, client.client_id);
  const refreshed = await denies(service, client, issued.refresh_token);
  assert.ok(refreshed.access_token);
  assert.ok(refreshRecord(service, issued.refresh_token).usedAt);
  assert.equal(denialAudit(service, { clientId: client.client_id }).length, 0);
  const verified = await service.provider.verifyAccessToken(refreshed.access_token);
  assert.equal(verified.userId, "user-1");
});

test("revoke outside the window denies refresh without consuming or revoking the token", async () => {
  const policy = policyFor({ subjects: ["oauth-user:user-1"] });
  const service = await newService(await runtimeFor({ policies: [policy] }));
  const client = await registerClient(service, "client-revoke");
  const issued = grant(service, client.client_id);
  const before = accessTokenCount(service, client.client_id);

  await assert.rejects(() => denies(service, client, issued.refresh_token), (error) => {
    assert.equal(error.name, "AccessDeniedError");
    assert.equal(error.errorCode, "access_denied");
    return true;
  });

  const record = refreshRecord(service, issued.refresh_token);
  assert.equal(record.usedAt, undefined);
  assert.equal(record.revokedAt, undefined);
  assert.equal(record.lastUsedAt, null);
  assert.equal(accessTokenCount(service, client.client_id), before);
  const entry = denialAudit(service, { credentialId: record.id });
  assert.equal(entry.length, 1);
  assert.equal(entry[0].surface, "oauth");
  assert.equal(entry[0].mode, "revoke");
  assert.equal(entry[0].policyId, policy.id);
  assert.equal(entry[0].credentialType, "oauth-refresh");
  assert.equal(entry[0].userId, "user-1");
});

test("once the window reopens the original refresh token still works", async () => {
  const clock = fakeClock(WINDOW_CLOSED);
  const policy = policyFor({ subjects: ["oauth-user:user-1"] });
  const service = await newService(await runtimeFor({ policies: [policy], clock }));
  const client = await registerClient(service, "client-reopen");
  const issued = grant(service, client.client_id);

  await assert.rejects(() => denies(service, client, issued.refresh_token), /Access is outside the authorized time window/);
  clock.set(WINDOW_OPEN);
  const refreshed = await denies(service, client, issued.refresh_token);
  assert.ok(refreshed.access_token);
  assert.ok(refreshRecord(service, issued.refresh_token).usedAt);
  const verified = await service.provider.verifyAccessToken(refreshed.access_token);
  assert.deepEqual(verified.scopes, SCOPES);
});

test("user-level revoke applies to every client of that user", async () => {
  const service = await newService(await runtimeFor({ policies: [policyFor({ subjects: ["oauth-user:user-1"] })] }));
  const first = await registerClient(service, "client-user-1");
  const second = await registerClient(service, "client-user-2");
  const firstGrant = grant(service, first.client_id);
  const secondGrant = grant(service, second.client_id);
  await assert.rejects(() => denies(service, first, firstGrant.refresh_token), /authorized time window/);
  await assert.rejects(() => denies(service, second, secondGrant.refresh_token), /authorized time window/);
  assert.equal(refreshRecord(service, firstGrant.refresh_token).usedAt, undefined);
  assert.equal(refreshRecord(service, secondGrant.refresh_token).usedAt, undefined);
});

test("client-level revoke only affects that client", async () => {
  const service = await newService(await runtimeFor({ policies: [policyFor({ subjects: ["oauth-client:client-scoped"] })] }));
  const scoped = await registerClient(service, "client-scoped");
  const other = await registerClient(service, "client-other");
  const scopedGrant = grant(service, scoped.client_id);
  const otherGrant = grant(service, other.client_id);
  await assert.rejects(() => denies(service, scoped, scopedGrant.refresh_token), /authorized time window/);
  const allowed = await denies(service, other, otherGrant.refresh_token);
  assert.ok(allowed.access_token);
  assert.equal(refreshRecord(service, scopedGrant.refresh_token).usedAt, undefined);
  assert.ok(refreshRecord(service, otherGrant.refresh_token).usedAt);
});

test("OAuth discovery and registration stay available while a revoke window is active", async () => {
  const service = await newService(await runtimeFor({ policies: [policyFor({ subjects: ["oauth-user:user-1"] })] }));
  const router = await bootRouter(service);
  try {
    const metadata = await fetch(`${router.base}/.well-known/oauth-authorization-server`);
    assert.equal(metadata.status, 200);
    const body = await metadata.json();
    assert.equal(body.issuer, service.issuer.href);
    assert.ok(body.token_endpoint);

    const protectedResource = await fetch(`${router.base}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(protectedResource.status, 200);
    assert.equal((await protectedResource.json()).resource, service.resource.href);

    const registration = await fetch(`${router.base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "discovery-client", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }),
    });
    assert.ok([200, 201].includes(registration.status), `registration should stay available, got ${registration.status}`);
    assert.ok((await registration.json()).client_id);
  } finally {
    await router.close();
  }
});

test("a denied refresh on the real token endpoint is access_denied without policy internals", async () => {
  const policy = policyFor({ subjects: ["oauth-user:user-1"] });
  const service = await newService(await runtimeFor({ policies: [policy] }));
  const client = await registerClient(service, "client-wire");
  const issued = grant(service, client.client_id);
  const before = accessTokenCount(service, client.client_id);
  const router = await bootRouter(service);
  try {
    const response = await fetch(`${router.base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: client.client_id }),
    });
    const text = await response.text();
    assert.equal(response.status, 400);
    const body = JSON.parse(text);
    assert.equal(body.error, "access_denied");
    assert.equal(body.error_description, "Access is outside the authorized time window");
    for (const leak of [policy.id, "schemaVersion", "capabilities", "weekly", "timezone", "dateRanges", "subjects", "policyId", "[{"]) {
      assert.equal(text.includes(leak), false, `token error must not leak ${leak}`);
    }
    assert.equal(refreshRecord(service, issued.refresh_token).usedAt, undefined);
    assert.equal(accessTokenCount(service, client.client_id), before);
  } finally {
    await router.close();
  }
});

test("approval outside a revoke window uses the existing 403 path and stays retryable", async () => {
  const clock = fakeClock(WINDOW_CLOSED);
  const service = await newService(null);
  const owner = await service.provider.authenticateOAuthUser("test-owner", "test-oauth-password");
  assert.ok(owner?.id);
  // Injected after the owner id is known (direct property form also supported).
  service.provider.accessRuntime = await runtimeFor({ policies: [policyFor({ subjects: [`oauth-user:${owner.id}`] })], clock });
  const client = await registerClient(service, "client-approval");
  const authorizeResponse = fakeResponse();
  await service.provider.authorize(client, {
    state: "opaque-state",
    scopes: SCOPES,
    redirectUri: client.redirect_uris[0],
    codeChallenge: "pkce-challenge",
    resource: service.resource,
  }, authorizeResponse);
  const transaction = authorizeResponse.body.match(/name="transaction" value="([^"]+)"/)[1];
  const approval = { body: { transaction, username: "test-owner", password: "test-oauth-password", scope: SCOPES, decision: "allow" }, headers: {}, socket: {} };

  const denied = fakeResponse();
  await service.provider.handleApproval(approval, denied);
  assert.equal(denied.statusCode, 403);
  assert.match(denied.body, /授权时间窗/);
  for (const leak of ["schemaVersion", "capabilities", "weekly", "policyId", "[{"]) {
    assert.equal(denied.body.includes(leak), false, `approval error must not leak ${leak}`);
  }
  assert.equal(Object.keys(service.provider.data.codes).length, 0);
  const deniedAudit = denialAudit(service, { userId: owner.id });
  assert.equal(deniedAudit.length, 1);
  assert.equal(deniedAudit[0].surface, "oauth");
  assert.equal(deniedAudit[0].mode, "revoke");

  // The transaction survives the denial, so the same approval works once the
  // window reopens (temporary, not destructive).
  clock.set(WINDOW_OPEN);
  const allowed = fakeResponse();
  await service.provider.handleApproval(approval, allowed);
  assert.equal(allowed.statusCode, 302);
  assert.ok(new URL(allowed.redirectTo).searchParams.get("code"));
});

test("no injected accessRuntime: the OAuth lifecycle is unchanged", async () => {
  const service = await newService(null);
  const client = await registerClient(service, "client-plain");
  const issued = grant(service, client.client_id);
  const refreshed = await denies(service, client, issued.refresh_token);
  assert.ok(refreshed.access_token);
  assert.ok(refreshRecord(service, issued.refresh_token).usedAt);
  assert.equal(denialAudit(service, { clientId: client.client_id }).length, 0);

  const router = await bootRouter(service);
  try {
    const response = await fetch(`${router.base}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(response.status, 200);
  } finally {
    await router.close();
  }
});

test("a code approved inside the window is denied once it closes and stays consumable", async () => {
  const clock = fakeClock(WINDOW_OPEN);
  const service = await newService(null);
  const owner = await service.provider.authenticateOAuthUser("test-owner", "test-oauth-password");
  assert.ok(owner?.id);
  const policy = policyFor({ subjects: [`oauth-user:${owner.id}`] });
  service.provider.accessRuntime = await runtimeFor({ policies: [policy], clock });
  const client = await registerClient(service, "client-code-revoke");

  const code = await approve(service, client);
  assert.ok(codeRecord(service, code), "the authorization code exists before the exchange");
  const before = accessTokenCount(service, client.client_id);

  clock.set(WINDOW_CLOSED);
  await assert.rejects(() => exchange(service, client, code), (error) => {
    assert.equal(error.name, "AccessDeniedError");
    assert.equal(error.errorCode, "access_denied");
    assert.equal(error.message, "Access is outside the authorized time window");
    return true;
  });

  assert.ok(codeRecord(service, code), "a denied exchange must not consume the authorization code");
  assert.equal(accessTokenCount(service, client.client_id), before, "a denied exchange must not issue tokens");
  const entries = denialAudit(service, { clientId: client.client_id });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].surface, "oauth");
  assert.equal(entries[0].mode, "revoke");
  assert.equal(entries[0].policyId, policy.id);
  assert.equal(entries[0].credentialType, "oauth-client");
  assert.equal(entries[0].userId, owner.id);

  // Window reopens within the 5 minute code TTL: the very same code still works.
  clock.set(WINDOW_OPEN);
  const tokens = await exchange(service, client, code);
  assert.ok(tokens.access_token);
  assert.equal(codeRecord(service, code), undefined, "a successful exchange consumes the code");
  const verified = await service.provider.verifyAccessToken(tokens.access_token);
  assert.equal(verified.userId, owner.id);
});

test("a denied code exchange on the real token endpoint is access_denied without policy internals", async () => {
  const clock = fakeClock(WINDOW_OPEN);
  const service = await newService(null);
  const owner = await service.provider.authenticateOAuthUser("test-owner", "test-oauth-password");
  const policy = policyFor({ subjects: [`oauth-user:${owner.id}`] });
  service.provider.accessRuntime = await runtimeFor({ policies: [policy], clock });
  const client = await registerClient(service, "client-code-wire");
  const verifier = "a".repeat(64);
  const code = await approve(service, client, { codeChallenge: codeChallengeFor(verifier) });
  const before = accessTokenCount(service, client.client_id);
  clock.set(WINDOW_CLOSED);

  const router = await bootRouter(service);
  try {
    const response = await fetch(`${router.base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: client.redirect_uris[0], client_id: client.client_id }),
    });
    const text = await response.text();
    assert.equal(response.status, 400);
    const body = JSON.parse(text);
    assert.equal(body.error, "access_denied");
    assert.equal(body.error_description, "Access is outside the authorized time window");
    for (const leak of [policy.id, "schemaVersion", "capabilities", "weekly", "timezone", "dateRanges", "subjects", "policyId", "[{"]) {
      assert.equal(text.includes(leak), false, `token error must not leak ${leak}`);
    }
    assert.ok(codeRecord(service, code), "the denied wire exchange must not consume the code");
    assert.equal(accessTokenCount(service, client.client_id), before);
  } finally {
    await router.close();
  }
});

test("a suspend policy does not block a code exchange", async () => {
  const clock = fakeClock(WINDOW_OPEN);
  const service = await newService(null);
  const owner = await service.provider.authenticateOAuthUser("test-owner", "test-oauth-password");
  service.provider.accessRuntime = await runtimeFor({ policies: [policyFor({ mode: "suspend", subjects: [`oauth-user:${owner.id}`] })], clock });
  const client = await registerClient(service, "client-code-suspend");
  const code = await approve(service, client);
  clock.set(WINDOW_CLOSED);
  const tokens = await exchange(service, client, code);
  assert.ok(tokens.access_token);
  assert.equal(codeRecord(service, code), undefined);
  assert.equal(denialAudit(service, { clientId: client.client_id }).length, 0);
});

test("a broken policy runtime does not block a code exchange", async () => {
  const clock = fakeClock(WINDOW_OPEN);
  const service = await newService(null);
  await service.provider.authenticateOAuthUser("test-owner", "test-oauth-password");
  service.provider.accessRuntime = await runtimeFor({ status: "broken", clock });
  const client = await registerClient(service, "client-code-broken");
  const code = await approve(service, client);
  const tokens = await exchange(service, client, code);
  assert.ok(tokens.access_token);
  assert.equal(codeRecord(service, code), undefined);
  assert.equal(denialAudit(service, { clientId: client.client_id }).length, 0);
});

test("no injected accessRuntime: a code exchange is unchanged", async () => {
  const service = await newService(null);
  const client = await registerClient(service, "client-code-plain");
  const code = await approve(service, client);
  const tokens = await exchange(service, client, code);
  assert.ok(tokens.access_token);
  assert.equal(codeRecord(service, code), undefined);
  assert.equal(denialAudit(service, { clientId: client.client_id }).length, 0);
});
