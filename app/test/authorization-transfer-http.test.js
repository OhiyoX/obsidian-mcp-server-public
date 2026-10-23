// #364 transfer × real `server.js` over HTTP.
//
// Slice 1 does not own the Admin route, so the transfer is begun out-of-band on the
// same durable `DATA_PATH` (exactly how `access-policy-server-integration.test.js`
// changes durable state: no file watcher by design), with the OAuth state save
// deliberately failing so that ONLY the durable fence can deny the source. The
// assertions then run against the real `server.js` process over real HTTP: OAuth
// token endpoint, `/mcp` with real transports and real stale-session recovery, and
// the fail-closed startup admission for a corrupt transfer store.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-i364-http-"));
process.env.DATA_PATH = path.join(root, "data");
process.env.PUBLIC_BASE_URL = "http://localhost:18923";
process.env.OAUTH_ADMIN_PASSWORD = "test-only-password";
process.env.OAUTH_INITIAL_USERNAME = "i364-owner";
process.env.OAUTH_INITIAL_PASSWORD = "i364-oauth-password";
process.env.MCP_PATH = "/mcp";
process.env.WEB_DEFAULT_VAULT = "default";

const { createOAuthService } = await import("../src/oauth-provider.js");
const { createAuthorizationTransferStore } = await import("../src/oauth/authorization-transfer-store.js");

const APP_DIR = path.resolve(import.meta.dirname, "..");
const ADMIN_PASSWORD = "test-only-password";
const PASSWORD = "i364-test-password";
const STALE_SESSION_ID = "5f2b0a4c-9d3e-4b71-8c6a-2f0d1e7a4b93";
const STATE_FILE = path.join(root, "data", "oauth", "state.json");
const TRANSFERS_FILE = path.join(root, "data", "oauth", "transfers.json");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopChild(child) {
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

async function spawnServer(port) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VAULT_PATH: path.join(root, "vault"),
      DATA_PATH: path.join(root, "data"),
      OAUTH_ENABLED: "true",
      PUBLIC_BASE_URL: `http://localhost:${port}`,
      OAUTH_ADMIN_PASSWORD: ADMIN_PASSWORD,
      OAUTH_INITIAL_USERNAME: "i364-owner",
      OAUTH_INITIAL_PASSWORD: "i364-oauth-password",
      API_KEY: "",
      GIT_ENABLED: "false",
      EMBEDDING_PROVIDER: "disabled",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  return { child, output };
}

async function waitForHealthz(base, child, output) {
  for (let attempt = 0; attempt < 450; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${output.join("")}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${base}/healthz: ${output.join("")}`);
}

function pkce() {
  const verifier = `i364-http-verifier-${createHash("sha256").update(String(Math.random())).digest("hex")}`;
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function adminSession(base) {
  const login = await fetch(`${base}/admin/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const page = await (await fetch(`${base}/admin/auth`, { headers: { Cookie: cookie } })).text();
  return { cookie, csrf: page.match(/name="csrf" value="([^"]+)"/)[1] };
}

async function createUser(base, cookie, csrf, username) {
  const body = new URLSearchParams({ csrf, username, displayName: username, password: PASSWORD, allowedVault: "default" });
  body.append("allowedScope", "obsidian.read");
  body.append("allowedScope", "obsidian.write");
  const response = await fetch(`${base}/admin/auth/oauth/user/create`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  assert.equal(response.status, 303, `creating ${username}`);
}

async function registerClient(base, clientName) {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [`${base}/callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function authorizeAndExchange(base, client, username, password, scope = "obsidian.read") {
  const redirectUri = client.redirect_uris[0];
  const { verifier, challenge } = pkce();
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", state: "i364", resource: `${base}/mcp`, scope,
  });
  const consent = await fetch(authorizeUrl);
  assert.equal(consent.status, 200);
  const transaction = (await consent.text()).match(/name="transaction" value="([^"]+)"/)[1];
  const approval = await fetch(`${base}/oauth/decision`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction, username, password, scope, decision: "allow" }),
  });
  assert.equal(approval.status, 302, `consent for ${username}`);
  const code = new URL(approval.headers.get("location")).searchParams.get("code");
  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: redirectUri, resource: `${base}/mcp` }),
  });
  assert.equal(tokenResponse.status, 200);
  return tokenResponse.json();
}

async function mcp(base, { bearer, session = null, method = "tools/list", id = 2 } = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id, method,
      params: method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "i364", version: "1" } } : {},
    }),
  });
  const text = await response.text();
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), text };
}

/** A store the server cannot trust must abort startup and leave the file untouched. */
async function expectStartupAbort(base, port, t, contents) {
  await fs.writeFile(TRANSFERS_FILE, contents, "utf8");
  const spawned = await spawnServer(port);
  t.after(async () => { await stopChild(spawned.child); });
  let deadline = null;
  const exited = await Promise.race([
    new Promise((resolve) => spawned.child.once("exit", (code) => resolve({ code }))),
    new Promise((resolve) => { deadline = setTimeout(() => resolve({ timeout: true }), 20_000); deadline.unref?.(); }),
  ]);
  clearTimeout(deadline);
  if (exited.timeout) {
    await stopChild(spawned.child);
    assert.fail(`an untrusted transfer store must abort startup, but the server kept running: ${spawned.output.join("")}`);
  }
  assert.notEqual(exited.code, 0, "an untrusted transfer store must abort startup with a non-zero code");
  assert.match(spawned.output.join(""), /authorization-transfer-store/i, "the failure must name the untrusted store");
  assert.equal(await fs.readFile(TRANSFERS_FILE, "utf8"), contents, "the untrusted file must be preserved for a human");
  assert.equal(await fetch(`${base}/healthz`).then(() => "up", () => "down"), "down");
}

test("a durable transfer fence (with no physical revoke persisted) is enforced by the real server across a restart", async (t) => {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  await fs.mkdir(path.join(root, "vault"), { recursive: true });

  const first = await spawnServer(port);
  t.after(async () => { await stopChild(first.child); });
  await waitForHealthz(base, first.child, first.output);

  const { cookie, csrf } = await adminSession(base);
  await createUser(base, cookie, csrf, "i364-b");
  await createUser(base, cookie, csrf, "i364-c");
  const clientX = await registerClient(base, "i364 X");
  const clientY = await registerClient(base, "i364 Y");
  const tokensAX = await authorizeAndExchange(base, clientX, "i364-owner", "i364-oauth-password");
  const tokensCX = await authorizeAndExchange(base, clientX, "i364-c", PASSWORD);
  const tokensAY = await authorizeAndExchange(base, clientY, "i364-owner", "i364-oauth-password");

  // Live sessions on the real /mcp route with real transports.
  const sessionAX = (await mcp(base, { bearer: tokensAX.access_token, id: 1, method: "initialize" })).sessionId;
  const sessionCX = (await mcp(base, { bearer: tokensCX.access_token, id: 1, method: "initialize" })).sessionId;
  assert.ok(sessionAX && sessionCX);
  assert.equal((await mcp(base, { bearer: tokensAX.access_token, session: sessionAX })).status, 200);
  await stopChild(first.child);

  // Begin the transfer out-of-band with the OAuth state save failing: the fence is
  // durable, the physical revoke is not. Only the fence can deny A from here.
  const provider = createOAuthService({ transferStore: createAuthorizationTransferStore({ file: TRANSFERS_FILE }) }).provider;
  await provider.ready;
  const sourceUser = Object.values(provider.data.oauthUsers).find((user) => user.username === "i364-owner");
  const targetUser = Object.values(provider.data.oauthUsers).find((user) => user.username === "i364-b");
  const originalSave = provider.save;
  const originalSchedule = provider.scheduleSave;
  provider.save = async () => { throw Object.assign(new Error("EIO: injected"), { code: "EIO" }); };
  provider.scheduleSave = () => {};
  let begun;
  try {
    begun = await provider.beginAuthorizationTransfer({ clientId: clientX.client_id, sourceUserId: sourceUser.id, targetUserId: targetUser.id, actor: "admin-session" });
  } finally {
    provider.save = originalSave;
    provider.scheduleSave = originalSchedule;
  }
  assert.equal(begun.degraded, true);
  const onDiskState = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  assert.ok(Object.values(onDiskState.refreshTokens).every((record) => record.clientId !== clientX.client_id || record.userId !== sourceUser.id || record.revokedAt === undefined),
    "the physical revoke must not be durable: the fence alone has to deny A");
  const onDiskTransfers = JSON.parse(await fs.readFile(TRANSFERS_FILE, "utf8"));
  assert.equal(onDiskTransfers.transfers[begun.transfer.id].status, "pending");
  assert.equal(Object.values(onDiskTransfers.generations).find((entry) => entry.transferId === begun.transfer.id).generation, 1);
  await provider.drainPersistence();

  // Restart the real server; it must admit the store and keep denying the old credential.
  const second = await spawnServer(port);
  t.after(async () => { await stopChild(second.child); });
  await waitForHealthz(base, second.child, second.output);

  const fencedVerify = await mcp(base, { bearer: tokensAX.access_token, id: 3, method: "initialize" });
  assert.equal(fencedVerify.status, 401, "the old access token is refused over real HTTP by the fence");
  const fencedRefresh = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientX.client_id, refresh_token: tokensAX.refresh_token, resource: `${base}/mcp`, scope: "obsidian.read" }),
  });
  assert.equal(fencedRefresh.status, 400);
  assert.equal((await fencedRefresh.json()).error, "invalid_grant");
  const fencedRecovery = await mcp(base, { bearer: tokensAX.access_token, session: STALE_SESSION_ID });
  assert.equal(fencedRecovery.status, 401, "an old credential must not ride stale-session recovery");

  // Unrelated credentials keep working, and recovery is genuinely enabled (positive control).
  assert.equal((await mcp(base, { bearer: tokensCX.access_token, id: 4, method: "initialize" })).status, 200);
  assert.equal((await mcp(base, { bearer: tokensAY.access_token, id: 5, method: "initialize" })).status, 200);
  assert.equal((await mcp(base, { bearer: tokensCX.access_token, session: STALE_SESSION_ID, id: 6 })).status, 200,
    "the same stale id is answered for a valid credential, so the 401 above is credential denial, not a disabled recovery path");
  assert.equal((await mcp(base, { bearer: tokensCX.access_token, session: sessionCX })).status, 200);

  // Restart evidence: the fence is durable and still holds.
  const afterRestart = JSON.parse(await fs.readFile(TRANSFERS_FILE, "utf8"));
  assert.equal(afterRestart.transfers[begun.transfer.id].status, "pending");
  await stopChild(second.child);

  // Fail closed on a corrupt store: the process must refuse to start and must not
  // overwrite the file it cannot understand.
  await expectStartupAbort(base, port, t, "{ this is not json");

  // The subtler corruption: valid JSON whose records contradict each other — a
  // generation 1 transfer with no fence generation record. A store that accepted it
  // would treat the old-generation credential as unfenced, so startup must refuse it
  // too and keep the file for a human (P0-3 of the L1 return).
  const orphanTransfer = JSON.stringify({
    version: 1,
    generations: {},
    transfers: {
      "t-orphan": {
        id: "t-orphan", clientId: clientX.client_id, sourceUserId: sourceUser.id, targetUserId: targetUser.id,
        status: "pending", generation: 1,
        sourceRevokedAt: "2026-10-09T00:00:00.000Z", createdAt: "2026-10-09T00:00:00.000Z", expiresAt: "2026-10-09T00:15:00.000Z",
        completedAt: null, cancelledAt: null, closedReason: null, completionUserId: null, lastErrorCode: null,
      },
    },
  }, null, 2);
  await expectStartupAbort(base, port, t, orphanTransfer);
});
