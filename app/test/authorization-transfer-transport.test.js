// #364 transfer × real MCP transport (in-process harness).
//
// The service under test is real: `createOAuthService` (real durable provider +
// real transfer store), `createAuthMiddleware`, `createMcpSessionRegistry` with
// real `StreamableHTTPServerTransport` instances, real HTTP over loopback, and the
// real `closeSessionsForClient`. Only the `/mcp` route glue is mirrored from
// `server.js` (same order: auth → session lookup → principal check →
// transport handleRequest → stale-session recovery), because slice 2 owns the
// Admin route and slice 1 must not add one. `authorization-transfer-http.test.js`
// covers the real `server.js` over HTTP for everything observable across a
// restart; this file covers what only the live process can show (I06).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-i364-transport-"));
process.env.DATA_PATH = root;
process.env.PUBLIC_BASE_URL = "http://localhost:18923";
process.env.OAUTH_ADMIN_PASSWORD = "test-only-password";
process.env.OAUTH_INITIAL_USERNAME = "i364-owner";
process.env.OAUTH_INITIAL_PASSWORD = "i364-oauth-password";
process.env.MCP_PATH = "/mcp";
process.env.WEB_DEFAULT_VAULT = "default";

const { createOAuthService } = await import("../src/oauth-provider.js");
const { createAuthorizationTransferStore } = await import("../src/oauth/authorization-transfer-store.js");
const { createMcpSessionRegistry } = await import("../src/mcp-sessions.js");
const { createAuthMiddleware } = await import("../src/auth.js");
const { headerValue, jsonRpcError } = await import("../src/http.js");
const { MCP_PATH } = await import("../src/server-config.js");

const PASSWORD = "i364-test-password";
const MCP_URL = "http://localhost:18923/mcp";
const servers = new Set();

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

function isInitializeRequest(body) {
  return Array.isArray(body) ? body.some((message) => message?.method === "initialize") : body?.method === "initialize";
}

function htmlResponse() {
  return {
    status(value) { this.statusCode = value; return this; },
    type() { return this; },
    send(value) { this.body = value; return this; },
  };
}

/** Mirrors the `server.js` MCP route so the registry/transport/auth stack is exercised for real. */
async function startHarness(oauthService, registry) {
  const app = express();
  app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));
  const auth = createAuthMiddleware(oauthService, { accessRuntime: null, onHardRevoke: registry.closeSessionsForClient });
  app.post(MCP_PATH, auth, async (req, res) => {
    const sessionId = headerValue(req, "mcp-session-id");
    try {
      if (sessionId) {
        const record = registry.sessions.get(sessionId);
        if (!record) {
          if (registry.sessionRecovery.enabled && isInitializeRequest(req.body)) {
            const fresh = await registry.createSessionTransport(req.auth);
            await fresh.transport.handleRequest(req, res, req.body);
            return;
          }
          if (await registry.sessionRecovery.handle(req, res, sessionId)) return;
          if (!res.headersSent) jsonRpcError(res, 404, -32000, "Session not found");
          return;
        }
        if (!registry.sessionBelongsToAuth(record, req.auth)) {
          jsonRpcError(res, 403, -32001, "MCP session belongs to a different authenticated principal");
          return;
        }
        record.lastAccessAt = Date.now();
        await record.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32000, "Bad Request: initialize first or provide mcp-session-id");
        return;
      }
      const record = await registry.createSessionTransport(req.auth);
      await record.transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, `Internal server error: ${error?.message || error}`);
    }
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function rpc(base, { bearer, session, id = 1, method = "tools/list", params = {} }) {
  const response = await fetch(`${base}${MCP_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), text };
}

async function initializeSession(base, bearer, name) {
  const result = await rpc(base, { bearer, id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } } });
  assert.equal(result.status, 200, `initialize for ${name} must succeed: ${result.text.slice(0, 200)}`);
  assert.ok(result.sessionId, "the real transport must issue an Mcp-Session-Id");
  return result.sessionId;
}

async function newUser(provider, username) {
  return provider.createOAuthUser({
    username, password: PASSWORD, displayName: username,
    allowedScopes: ["obsidian.read", "obsidian.write"], allowedVaults: ["default"],
  });
}

async function registerClient(provider, clientId) {
  await provider.clientsStore.registerClient({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientId,
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

async function authorize(provider, clientId, username, scope = "obsidian.read") {
  const client = provider.data.clients[clientId];
  const response = htmlResponse();
  await provider.authorize(client, { state: "s", scopes: [scope], redirectUri: client.redirect_uris[0], codeChallenge: "pkce", resource: MCP_URL }, response);
  const transaction = response.body.match(/name="transaction" value="([^"]+)"/)[1];
  let redirect = null;
  await provider.handleApproval({
    body: { transaction, username, password: PASSWORD, scope, decision: "allow" },
    headers: {}, socket: { remoteAddress: "127.0.0.1" },
  }, { status() { return this; }, type() { return this; }, send() { return this; }, redirect(_status, value) { redirect = value; } });
  assert.ok(redirect, `consent for ${username} must succeed`);
  const code = new URL(redirect).searchParams.get("code");
  return provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], MCP_URL);
}

test("begin closes only the source pair's live transport, keeps C and the source's other client, and recovery cannot revive the old credential", async () => {
  const registry = createMcpSessionRegistry({ createServer: () => new McpServer({ name: "i364-transport", version: "1" }) });
  const service = createOAuthService({
    transferStore: createAuthorizationTransferStore({ file: path.join(root, "oauth", "transfers-transport.json") }),
    closeSessions: registry.closeSessionsForClient,
  });
  const base = await startHarness(service, registry);
  const owner = service.provider;
  await owner.ready;

  await registerClient(owner, "tp-client-x");
  await registerClient(owner, "tp-client-y");
  const [sourceA, otherC, targetB] = await Promise.all([newUser(owner, "tp-source"), newUser(owner, "tp-other"), newUser(owner, "tp-target")]);
  const tokensAX = await authorize(owner, "tp-client-x", "tp-source");
  const tokensCX = await authorize(owner, "tp-client-x", "tp-other");
  const tokensAY = await authorize(owner, "tp-client-y", "tp-source");
  await owner.save();

  const sessionA = await initializeSession(base, tokensAX.access_token, "tp-source-x");
  const sessionC = await initializeSession(base, tokensCX.access_token, "tp-other-x");
  const sessionOtherClient = await initializeSession(base, tokensAY.access_token, "tp-source-y");
  assert.equal(registry.sessions.size, 3, "three real transports are live");
  assert.equal((await rpc(base, { bearer: tokensAX.access_token, session: sessionA })).status, 200);

  const begun = await owner.beginAuthorizationTransfer({
    clientId: "tp-client-x", sourceUserId: sourceA.id, targetUserId: targetB.id, actor: "admin-session",
  });
  assert.equal(begun.sessions.matched, 1, "only the source pair's transport matched");
  assert.equal(begun.sessions.closed, 1);
  assert.equal(begun.sessions.failed, 0);
  assert.deepEqual(begun.sessions.sessionIds, [sessionA]);
  assert.equal(begun.degraded, false);
  assert.equal(registry.sessions.has(sessionA), false, "I06: the source pair's transport is really closed");
  assert.equal(registry.sessions.has(sessionC), true, "the client's other account keeps its transport");
  assert.equal(registry.sessions.has(sessionOtherClient), true, "the account's other client keeps its transport");

  // The fenced source credential is refused before any recovery path can answer.
  const fenced = await rpc(base, { bearer: tokensAX.access_token, session: sessionA });
  assert.equal(fenced.status, 401);
  const fencedInitialize = await rpc(base, { bearer: tokensAX.access_token, id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tp-source-x", version: "2" } } });
  assert.equal(fencedInitialize.status, 401);
  const staleId = "5f2b0a4c-9d3e-4b71-8c6a-2f0d1e7a4b93";
  const fencedRecovery = await rpc(base, { bearer: tokensAX.access_token, session: staleId });
  assert.equal(fencedRecovery.status, 401, "an old credential must not ride stale-session recovery");
  // Positive control: recovery itself is enabled for a live credential.
  const healthyRecovery = await rpc(base, { bearer: tokensCX.access_token, session: staleId });
  assert.equal(healthyRecovery.status, 200, "the same stale id is answered for a valid credential, so the 401 above is credential denial");

  const healthy = await rpc(base, { bearer: tokensCX.access_token, session: sessionC });
  assert.equal(healthy.status, 200);
  const otherClient = await rpc(base, { bearer: tokensAY.access_token, session: sessionOtherClient });
  assert.equal(otherClient.status, 200);

  // The Admin projection input reflects the fence: A/X is out, C/X and A/Y are current.
  const snapshot = await owner.authorizationSnapshot();
  const statusOf = (token) => snapshot.tokens.filter((item) => item.status === "active"
    && item.clientId === token.clientId && item.userId === token.userId);
  assert.equal(statusOf({ clientId: "tp-client-x", userId: sourceA.id }).length, 0);
  assert.ok(statusOf({ clientId: "tp-client-x", userId: otherC.id }).length >= 1);
  assert.ok(statusOf({ clientId: "tp-client-y", userId: sourceA.id }).length >= 1);
  const transfers = await owner.authorizationTransferSnapshot();
  assert.equal(transfers.available, true);
  assert.equal(transfers.transfers.filter((item) => item.clientId === "tp-client-x" && item.status === "pending").length, 1);
  assert.equal(transfers.generations.find((item) => item.key === JSON.stringify(["tp-client-x", sourceA.id])).generation, 1);
  assert.deepEqual(owner.data.oauthUsers[targetB.id].allowedVaults, ["default"]);
});

test("a real transport close failure is reported, audited, retained and recoverable", async () => {
  const registry = createMcpSessionRegistry({ createServer: () => new McpServer({ name: "i364-transport", version: "1" }) });
  const service = createOAuthService({
    transferStore: createAuthorizationTransferStore({ file: path.join(root, "oauth", "transfers-close-failure.json") }),
    closeSessions: registry.closeSessionsForClient,
  });
  const base = await startHarness(service, registry);
  const owner = service.provider;
  await owner.ready;
  await registerClient(owner, "close-client");
  const [source, target] = await Promise.all([newUser(owner, "close-source"), newUser(owner, "close-target")]);
  const tokens = await authorize(owner, "close-client", "close-source");
  await owner.save();

  // A REAL transport: a real initialize handshake over loopback, the registry's own
  // record, the real session id and principal. Only `close()` is made to fail — there
  // is no hand-built stub record in this test.
  const sessionId = await initializeSession(base, tokens.access_token, "close-source");
  const record = registry.sessions.get(sessionId);
  assert.ok(record?.transport, "the registry must own a real transport for this session");
  assert.equal(record.authClientId, "close-client");
  assert.equal(record.authPrincipalId, `oauth:close-client:${source.id}`);
  assert.equal((await rpc(base, { bearer: tokens.access_token, session: sessionId })).status, 200, "the real session serves before the transfer");
  const realClose = record.transport.close.bind(record.transport);
  record.transport.close = async () => { throw new Error("transport close exploded"); };

  const begun = await owner.beginAuthorizationTransfer({ clientId: "close-client", sourceUserId: source.id, targetUserId: target.id });
  assert.equal(begun.sessions.matched, 1);
  assert.equal(begun.sessions.closed, 0);
  assert.equal(begun.sessions.failed, 1);
  assert.equal(begun.sessions.failures[0].sessionId, sessionId);
  assert.match(begun.sessions.failures[0].error, /close exploded/);
  assert.equal(begun.degraded, true, "a close failure is surfaced as degraded, never hidden");
  const failureEvents = owner.data.audit.filter((entry) => entry.action === "oauth.client.transfer.session_close_failed" && entry.transferId === begun.transfer.id);
  assert.equal(failureEvents.length, 1);
  assert.equal(failureEvents[0].outcome, "failure");
  // The fence is still the authority: the credential stays denied even though the
  // transport survived the failed close.
  await assert.rejects(owner.verifyAccessToken(tokens.access_token), /Invalid or expired/);
  assert.equal(owner.transferStore.getTransfer(begun.transfer.id).status, "pending");
  // A failed close is NOT a close: the record stays resident and is reported as
  // unclosed instead of being deleted to look closed.
  assert.equal(registry.sessions.has(sessionId), true, "a failed close must not delete the Map entry");
  const stuck = registry.listUnclosedSessions();
  assert.deepEqual(stuck.map((item) => item.sessionId), [sessionId]);
  assert.equal(stuck[0].clientId, "close-client");
  assert.match(stuck[0].lastCloseError.error, /close exploded/);

  // Ops recovery: retry the same idempotent call (what the idle reaper and an
  // operator both do). The record disappears only through a real close.
  record.transport.close = realClose;
  const retried = await registry.closeSessionsForClient("close-client", { userId: source.id });
  assert.equal(retried.matched, 1);
  assert.equal(retried.closed, 1);
  assert.equal(retried.failed, 0);
  assert.equal(registry.sessions.has(sessionId), false, "the retry really closed the transport");
  assert.deepEqual(registry.listUnclosedSessions(), []);
});
