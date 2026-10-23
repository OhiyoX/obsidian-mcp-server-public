import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-oauth-"));
process.env.DATA_PATH = root;
process.env.PUBLIC_BASE_URL = "http://localhost:18923";
process.env.OAUTH_ADMIN_PASSWORD = "test-only-password";
process.env.OAUTH_INITIAL_USERNAME = "test-owner";
process.env.OAUTH_INITIAL_PASSWORD = "test-oauth-password";
process.env.MCP_PATH = "/mcp";
process.env.OAUTH_REFRESH_REUSE_GRACE_SECONDS = "1";
process.env.WEB_DEFAULT_VAULT = "default";

const { createOAuthService: createOAuthServiceRaw } = await import("../src/oauth-provider.js");
const providers = new Set();

function createOAuthService() {
  const service = createOAuthServiceRaw();
  providers.add(service.provider);
  return service;
}

after(async () => {
  for (const provider of providers) await provider.drainPersistence();
  await fs.rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function htmlResponse() {
  return {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    type() { return this; },
    send(value) { this.body = value; return this; },
  };
}

test("drainPersistence flushes a scheduled activity save and waits for the pending write", { timeout: 5000 }, async () => {
  const service = createOAuthService();
  await service.provider.ready;
  await service.provider.drainPersistence();

  service.provider.recordAudit({ action: "test.explicit-save", credentialType: "test" });
  assert.ok(service.provider.saveTimer, "recordAudit must schedule deferred persistence");
  await service.provider.save();
  assert.equal(service.provider.saveTimer, null, "an explicit save must absorb the deferred activity timer");

  const originalWriteFile = fs.writeFile;
  const writeEntered = deferred();
  const releaseWrite = deferred();
  let intercepted = false;
  let drainSettled = false;

  fs.writeFile = async (candidate, ...rest) => {
    if (!intercepted && String(candidate).startsWith(`${service.provider.file}.`) && String(candidate).endsWith(".tmp")) {
      intercepted = true;
      writeEntered.resolve();
      await releaseWrite.promise;
    }
    return originalWriteFile.call(fs, candidate, ...rest);
  };

  try {
    service.provider.recordAudit({ action: "test.persistence-drain", credentialType: "test" });
    const draining = service.provider.drainPersistence().then(() => {
      drainSettled = true;
    });

    const first = await Promise.race([
      writeEntered.promise.then(() => "write-entered"),
      draining.then(() => "drain-settled"),
    ]);
    assert.equal(first, "write-entered", "drain must convert the pending timer into a queued write");
    assert.equal(drainSettled, false, "drain must not resolve while the persistence write is blocked");

    releaseWrite.resolve();
    await draining;

    assert.equal(service.provider.saveTimer, null);
    const persisted = JSON.parse(await fs.readFile(service.provider.file, "utf8"));
    assert.ok(persisted.audit.some((entry) => entry.action === "test.persistence-drain"));
  } finally {
    releaseWrite.resolve();
    fs.writeFile = originalWriteFile;
    await service.provider.drainPersistence();
  }
});

test("embedded OAuth provider supports consent, audience binding and refresh rotation", async () => {
  const service = createOAuthService();
  const client = {
    client_id: "test-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: "Test MCP Client",
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  await service.provider.clientsStore.registerClient(client);
  const authorizeResponse = htmlResponse();
  await service.provider.authorize(client, {
    state: "opaque-state",
    scopes: ["obsidian.read", "obsidian.files"],
    redirectUri: client.redirect_uris[0],
    codeChallenge: "pkce-challenge",
    resource: service.resource,
  }, authorizeResponse);
  assert.match(authorizeResponse.body, /OAuth 账户/);
  assert.doesNotMatch(authorizeResponse.body, /管理员授权密码/);
  assert.match(authorizeResponse.body, /appearance:none/);
  assert.match(authorizeResponse.body, /border-radius:4px/);
  assert.doesNotMatch(authorizeResponse.body, /translateX\(/);
  const transaction = authorizeResponse.body.match(/name="transaction" value="([^"]+)"/)[1];
  let redirect;
  await service.provider.handleApproval({ body: { transaction, username: "test-owner", password: "test-oauth-password", scope: ["obsidian.read"], decision: "allow" }, headers: {}, socket: {} }, { status() { return this; }, type() { return this; }, send() { return this; }, redirect(_status, value) { redirect = value; } });
  const authorizationCode = new URL(redirect).searchParams.get("code");
  assert.equal(new URL(redirect).searchParams.get("state"), "opaque-state");
  assert.equal(await service.provider.challengeForAuthorizationCode(client, authorizationCode), "pkce-challenge");
  const tokens = await service.provider.exchangeAuthorizationCode(client, authorizationCode, undefined, client.redirect_uris[0], service.resource);
  const verified = await service.provider.verifyAccessToken(tokens.access_token);
  assert.equal(verified.clientId, client.client_id);
  assert.ok(verified.userId);
  assert.deepEqual(verified.scopes, ["obsidian.read"]);
  assert.deepEqual(verified.allowedVaults, ["default"]);
  assert.equal(verified.resource.href, service.resource.href);
  await service.provider.noteAccessTokenUse(tokens.access_token, { source: "127.0.0.1", action: "mcp.initialize" });
  const clientInventory = (await service.provider.authorizationSnapshot()).clients.find((item) => item.clientId === client.client_id);
  assert.deepEqual(clientInventory.connectionOrigins, [service.resource.origin]);
  assert.equal(clientInventory.lastConnectionOrigin, service.resource.origin);
  service.provider.noteClientOrigin(client.client_id, "http://127.0.0.1:18923/mcp", { usedAt: new Date().toISOString() });
  const multiDomainInventory = (await service.provider.authorizationSnapshot()).clients.find((item) => item.clientId === client.client_id);
  assert.deepEqual(multiDomainInventory.connectionOrigins, ["http://localhost:18923", "http://127.0.0.1:18923"]);
  assert.equal(multiDomainInventory.lastConnectionOrigin, "http://127.0.0.1:18923");
  await assert.rejects(() => service.provider.verifyAccessToken(tokens.access_token, "http://localhost:18924/mcp"), /requested MCP domain/);
  const refreshed = await service.provider.exchangeRefreshToken(client, tokens.refresh_token, ["obsidian.read"], service.resource);
  const concurrentRefresh = await service.provider.exchangeRefreshToken(client, tokens.refresh_token, ["obsidian.read"], service.resource);
  assert.ok(concurrentRefresh.access_token);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(() => service.provider.exchangeRefreshToken(client, tokens.refresh_token, undefined, service.resource), /already been rotated/);
  const refreshedAuth = await service.provider.verifyAccessToken(refreshed.access_token);
  assert.deepEqual(refreshedAuth.scopes, ["obsidian.read"]);
  assert.deepEqual(refreshedAuth.allowedVaults, ["default"]);
  const inventory = await service.provider.authorizationSnapshot();
  const createdAt = inventory.tokens.map((item) => Date.parse(item.createdAt));
  assert.deepEqual(createdAt, [...createdAt].sort((left, right) => right - left));
  const refreshedDigest = createHash("sha256").update(refreshed.access_token).digest("hex");
  const refreshedId = service.provider.data.accessTokens[refreshedDigest].id;
  const accessRecord = inventory.tokens.find((item) => item.type === "access" && item.id === refreshedId);
  assert.deepEqual(await service.provider.revokeTokenById("access", accessRecord.id), {
    clientId: client.client_id,
    userId: verified.userId,
  });
  await assert.rejects(() => service.provider.verifyAccessToken(refreshed.access_token), /Invalid or expired/);
  const activeBeforeCleanup = (await service.provider.authorizationSnapshot()).tokens.filter((item) => item.status === "active").map((item) => item.id).sort();
  const cleaned = await service.provider.cleanupTokenRecords(0);
  assert.ok(cleaned.total >= 1);
  const afterCleanup = await service.provider.authorizationSnapshot();
  assert.deepEqual(afterCleanup.tokens.filter((item) => item.status === "active").map((item) => item.id).sort(), activeBeforeCleanup);
  assert.ok(afterCleanup.tokens.every((item) => item.status === "active"));
  assert.equal(await service.provider.revokeClient(client.client_id, true), true);
  assert.ok(!(await service.provider.authorizationSnapshot()).clients.some((item) => item.clientId === client.client_id));
});

test("OAuth accounts are independently managed and password hashes are never exposed", async () => {
  const service = createOAuthService();
  const created = await service.provider.createOAuthUser({
    username: "another-agent",
    password: "another-test-password",
    displayName: "Another Agent",
    allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
    allowedVaults: ["default", "research"],
  });
  assert.equal(created.username, "another-agent");
  assert.deepEqual(created.allowedVaults, ["default", "research"]);
  assert.equal(await service.provider.authenticateOAuthUser("another-agent", "wrong-password"), null);
  assert.equal((await service.provider.authenticateOAuthUser("another-agent", "another-test-password")).id, created.id);
  const snapshot = await service.provider.authorizationSnapshot();
  assert.ok(snapshot.oauthUsers.some((item) => item.id === created.id));
  const updated = await service.provider.updateOAuthUser(created.id, { allowedVaults: ["research"] });
  assert.deepEqual(updated.user.allowedVaults, ["research"]);
  assert.ok(!JSON.stringify(snapshot).includes("passwordHash"));
  assert.ok(!JSON.stringify(await fs.readFile(path.join(root, "oauth", "state.json"), "utf8")).includes("another-test-password"));
});

test("authorization store hashes managed API keys and supports revoke inventory", async () => {
  const service = createOAuthService();
  const created = await service.provider.createApiKey("integration test");
  assert.match(created.secret, /^obmcp_/);
  const verified = await service.provider.verifyApiKey(created.secret, { source: "127.0.0.1", action: "mcp.tools/list" });
  assert.equal(verified.clientId, `api-key:${created.id}`);
  const snapshot = await service.provider.authorizationSnapshot();
  assert.equal(snapshot.apiKeys.find((item) => item.id === created.id).label, "integration test");
  assert.ok(!JSON.stringify(snapshot).includes(created.secret));
  assert.ok(snapshot.audit.some((item) => item.credentialId === created.id));
  assert.equal(await service.provider.deleteApiKey(created.id), true);
  await assert.rejects(() => service.provider.verifyApiKey(created.secret), /Invalid API key/);
});

test("configured environment API key usage uses canonical state identifiers", async () => {
  const service = createOAuthService();
  await service.provider.noteConfiguredApiKeyUse({ source: "127.0.0.1", action: "mcp.tools/list" });
  const snapshot = await service.provider.authorizationSnapshot();
  assert.equal(snapshot.configuredApiKeyUsage.lastSource, "127.0.0.1");
  assert.ok(snapshot.audit.some((item) => item.credentialId === "configured-env" && item.clientId === "api-key:configured-env"));
  assert.equal(Object.hasOwn(snapshot, "legacyApiKeyUsage"), false);
});

test("managed API keys use the shared Scope registry and can be narrowed", async () => {
  const service = createOAuthService();
  const created = await service.provider.createApiKey("read-only", ["obsidian.read"], ["research"]);
  assert.deepEqual(created.allowedScopes, ["obsidian.read"]);
  assert.deepEqual(created.allowedVaults, ["research"]);
  const initial = await service.provider.verifyApiKey(created.secret);
  assert.deepEqual(initial.scopes, ["obsidian.read"]);
  assert.deepEqual(initial.allowedVaults, ["research"]);
  const updated = await service.provider.updateApiKey(created.id, { allowedScopes: ["obsidian.read", "obsidian.files"], allowedVaults: ["default"] });
  assert.deepEqual(updated.allowedScopes, ["obsidian.read", "obsidian.files"]);
  assert.deepEqual(updated.allowedVaults, ["default"]);
  const verified = await service.provider.verifyApiKey(created.secret);
  assert.ok(verified.scopes.includes("obsidian.files"));
  assert.deepEqual(verified.allowedVaults, ["default"]);
});

test("embedded OAuth registration rejects non-HTTPS remote redirects", async () => {
  const service = createOAuthService();
  await assert.rejects(() => service.provider.clientsStore.registerClient({
    client_id: "unsafe-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: ["http://remote.example/callback"],
    token_endpoint_auth_method: "none",
  }), /HTTPS|loopback/);
});

test("revokeGrants:false keeps an account's sessions; the default still revokes them", async () => {
  const service = createOAuthService();
  const user = await service.provider.createOAuthUser({
    username: "keep-sessions",
    password: "keep-sessions-password",
    allowedScopes: ["obsidian.read"],
    allowedVaults: ["default"],
  });
  const seed = (suffix) => {
    const id = `seeded-${suffix}-${Math.random().toString(16).slice(2)}`;
    service.provider.data.accessTokens[id] = {
      id, clientId: `client-${suffix}`, userId: user.id, type: "access",
      scopes: ["obsidian.read"], allowedVaults: ["default"],
      createdAt: new Date().toISOString(), expiresAt: Date.now() + 600_000, revokedAt: null,
    };
    return service.provider.data.accessTokens[id];
  };

  // Additive grant with the flag off: the token must survive (its own allowedVaults snapshot is what
  // limits it, so an added Vault cannot leak through an old session).
  const kept = seed("keep");
  await service.provider.updateOAuthUser(user.id, { allowedVaults: ["default", "research"], revokeGrants: false });
  assert.equal(kept.revokedAt, null, "revokeGrants:false must not touch existing tokens");

  // The default path is unchanged: any scope/Vault change revokes.
  const revoked = seed("revoke");
  await service.provider.updateOAuthUser(user.id, { allowedVaults: ["default"] });
  assert.ok(revoked.revokedAt, "the default update revokes existing tokens");
});
