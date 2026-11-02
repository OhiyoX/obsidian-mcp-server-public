// #364 slice 2 — the Admin transfer route end-to-end against a real `server.js` process.
//
// Unlike slice 1 (which began the transfer out-of-band because it owned no route), this
// test drives the REAL `POST /admin/auth/oauth/client/transfer` over HTTP with a real
// admin session + CSRF, and asserts the security outcome on the real MCP route: the
// source pair's live transport is closed, the same client's other account and the
// source's other client keep working, and the old credential cannot ride stale-session
// recovery. It also proves a 409 conflict leaves ZERO side effects (no fence, no
// generation, no revoke, no audit) and that cancel never restores the old bearer.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchSafePort } from "./fetch-safe-port.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-i364-admin-e2e-"));
process.env.DATA_PATH = path.join(root, "data");
process.env.PUBLIC_BASE_URL = "http://localhost:18923";
process.env.OAUTH_ADMIN_PASSWORD = "test-only-password";
process.env.OAUTH_INITIAL_USERNAME = "i364-owner";
process.env.OAUTH_INITIAL_PASSWORD = "i364-oauth-password";
process.env.MCP_PATH = "/mcp";
process.env.WEB_DEFAULT_VAULT = "default";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const ADMIN_PASSWORD = "test-only-password";
const PASSWORD = "i364-test-password";
const OWNER_PASSWORD = "i364-oauth-password";
const STATE_FILE = path.join(root, "data", "oauth", "state.json");
const TRANSFERS_FILE = path.join(root, "data", "oauth", "transfers.json");
const BEGIN = "/admin/auth/oauth/client/transfer";
const CANCEL = "/admin/auth/oauth/client/transfer/cancel";

async function freePort() {
  // Wave Q: not `listen(0)` — the OS can hand out a port `fetch` refuses (see `fetch-safe-port.mjs`).
  return fetchSafePort();
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
      PORT: String(port), HOST: "127.0.0.1",
      VAULT_PATH: path.join(root, "vault"), DATA_PATH: path.join(root, "data"),
      OAUTH_ENABLED: "true", PUBLIC_BASE_URL: `http://localhost:${port}`,
      OAUTH_ADMIN_PASSWORD: ADMIN_PASSWORD,
      OAUTH_INITIAL_USERNAME: "i364-owner", OAUTH_INITIAL_PASSWORD: OWNER_PASSWORD,
      API_KEY: "", GIT_ENABLED: "false", EMBEDDING_PROVIDER: "disabled",
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
  const verifier = `i364-e2e-verifier-${createHash("sha256").update(String(Math.random())).digest("hex")}`;
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
      client_name: clientName, redirect_uris: [`${base}/callback`],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
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
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id, method,
      params: method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "i364", version: "1" } } : {},
    }),
  });
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), text: await response.text() };
}

async function postForm(base, cookie, pathname, fields) {
  return fetch(`${base}${pathname}`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

async function page(base, cookie, query) {
  const response = await fetch(`${base}/admin/auth?${query}`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return response.text();
}

async function sessions(base) {
  return (await (await fetch(`${base}/healthz`)).json()).sessions;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

/** The clients-tab `<tr>` for one client, so "not current" can be asserted per row. */
function clientRow(body, clientName) {
  const match = new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?<b>${clientName}</b>(?:(?!</tr>)[\\s\\S])*?</tr>`).exec(body);
  assert.ok(match, `the clients tab must render a row for ${clientName}`);
  return match[0];
}

/** A current account is a link to that account's drawer in the row's 已授权账户 cell. */
const currentAccountCell = (name) => new RegExp(`<a href="/admin/auth\\?tab=accounts&amp;id=[^"]+">${name}</a>`);

test("the real Admin transfer route fences the source, closes only its transport, and cancels without restoring", async (t) => {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  await fs.mkdir(path.join(root, "vault"), { recursive: true });
  const server = await spawnServer(port);
  t.after(async () => { await stopChild(server.child); });
  await waitForHealthz(base, server.child, server.output);

  const { cookie, csrf } = await adminSession(base);
  await createUser(base, cookie, csrf, "i364-b");
  await createUser(base, cookie, csrf, "i364-c");
  const clientX = await registerClient(base, "i364 X");
  const clientZ = await registerClient(base, "i364 Z");

  const tokensAX = await authorizeAndExchange(base, clientX, "i364-owner", OWNER_PASSWORD);
  const tokensCX = await authorizeAndExchange(base, clientX, "i364-c", PASSWORD);
  const tokensAZ = await authorizeAndExchange(base, clientZ, "i364-owner", OWNER_PASSWORD);
  await authorizeAndExchange(base, clientZ, "i364-b", PASSWORD);

  const users = (await readJson(STATE_FILE)).oauthUsers;
  const idOf = (username) => Object.values(users).find((user) => user.username === username).id;
  const ownerId = idOf("i364-owner");
  const bId = idOf("i364-b");

  const sessionAX = (await mcp(base, { bearer: tokensAX.access_token, id: 1, method: "initialize" })).sessionId;
  const sessionCX = (await mcp(base, { bearer: tokensCX.access_token, id: 1, method: "initialize" })).sessionId;
  const sessionAZ = (await mcp(base, { bearer: tokensAZ.access_token, id: 1, method: "initialize" })).sessionId;
  assert.ok(sessionAX && sessionCX && sessionAZ);
  assert.equal(await sessions(base), 3);

  // --- 409: the target is already authorized on client Z -----------------------
  const before = await readJson(TRANSFERS_FILE);
  const auditBefore = await page(base, cookie, "tab=audit&action=oauth.client.transfer");
  assert.match(auditBefore, /没有匹配的审计记录/);
  const conflict = await postForm(base, cookie, BEGIN, { csrf, clientId: clientZ.client_id, sourceUserId: ownerId, targetUserId: bId });
  assert.equal(conflict.status, 409);
  assert.match(await conflict.text(), /目标账户已授权该客户端，请先处理其现有授权。转移未发起。/);
  assert.deepEqual(await readJson(TRANSFERS_FILE), before, "a 409 must not add a fence, generation or record");
  assert.equal(await sessions(base), 3, "a 409 must not close any transport");
  assert.equal((await mcp(base, { bearer: tokensAZ.access_token, session: sessionAZ })).status, 200, "the source keeps working after a 409");
  assert.match(await page(base, cookie, "tab=audit&action=oauth.client.transfer"), /没有匹配的审计记录/, "a 409 must not write an audit row");

  // --- success: transfer the source relation of client X to B ------------------
  const begin = await postForm(base, cookie, BEGIN, { csrf, clientId: clientX.client_id, sourceUserId: ownerId, targetUserId: bId });
  assert.equal(begin.status, 303);
  assert.equal(begin.headers.get("location"), "/admin/auth?tab=clients");
  const flash = await page(base, cookie, "tab=clients");
  assert.match(flash, /等待目标账户用同一客户端重新授权/);
  assert.doesNotMatch(flash, /转移完成/);

  // Live transport: only the source pair's session closed; the others stay up.
  assert.equal(await sessions(base), 2, "exactly the source pair's transport must be closed");
  assert.equal((await mcp(base, { bearer: tokensCX.access_token, session: sessionCX })).status, 200);
  assert.equal((await mcp(base, { bearer: tokensAZ.access_token, session: sessionAZ })).status, 200);

  // The old credential is denied on every entry, and recovery cannot resurrect it.
  assert.equal((await mcp(base, { bearer: tokensAX.access_token, id: 3, method: "initialize" })).status, 401);
  const refresh = await fetch(`${base}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientX.client_id, refresh_token: tokensAX.refresh_token, resource: `${base}/mcp`, scope: "obsidian.read" }),
  });
  assert.equal(refresh.status, 400);
  assert.equal((await refresh.json()).error, "invalid_grant");
  assert.equal((await mcp(base, { bearer: tokensAX.access_token, session: sessionAX })).status, 401, "a stale session id must not rescue a fenced credential");
  assert.equal((await mcp(base, { bearer: tokensCX.access_token, session: sessionAX, id: 4 })).status, 200, "the same stale id is answered for a live credential, so recovery is on");

  // Durable evidence: the physical revoke landed and the fence is pending generation 1.
  const state = await readJson(STATE_FILE);
  const revoked = [...Object.values(state.accessTokens), ...Object.values(state.refreshTokens)]
    .filter((record) => record.clientId === clientX.client_id && record.userId === ownerId);
  assert.ok(revoked.length >= 2 && revoked.every((record) => record.revokedAt), "the source pair's tokens must be physically revoked");
  const transfers = await readJson(TRANSFERS_FILE);
  const transfer = Object.values(transfers.transfers)[0];
  assert.equal(transfer.status, "pending");
  assert.equal(transfers.generations[JSON.stringify([clientX.client_id, ownerId])].generation, 1);
  assert.ok(transfer.sourceRevokedAt);

  // SSR: the fenced source is gone from client X, the pending target is shown, cancel is offered.
  const clients = await page(base, cookie, "tab=clients");
  const rowX = clientRow(clients, "i364 X");
  assert.match(rowX, /转移中 → i364-b/);
  assert.doesNotMatch(rowX, currentAccountCell("i364-owner"), "the fenced source must not be current on client X");
  assert.match(rowX, currentAccountCell("i364-c"), "the same client's other account stays current");
  // The cancel form belongs to the client's drawer (prototype `5-render.js`), not to the row.
  const drawerX = await page(base, cookie, `tab=clients&id=${clientX.client_id}`);
  assert.match(drawerX, new RegExp(`name="transferId" value="${transfer.id}"`));
  assert.match(await page(base, cookie, "tab=audit&action=oauth.client.transfer.begin"), /oauth\.client\.transfer\.begin/);

  // --- cancel: the pending intent ends, the old bearer does not come back ------
  const cancel = await postForm(base, cookie, CANCEL, { csrf, transferId: transfer.id });
  assert.equal(cancel.status, 303);
  assert.equal(cancel.headers.get("location"), "/admin/auth?tab=clients");
  const afterCancel = await page(base, cookie, "tab=clients");
  assert.doesNotMatch(afterCancel, /转移中 → i364-b/);
  assert.doesNotMatch(clientRow(afterCancel, "i364 X"), currentAccountCell("i364-owner"), "cancel must not restore the source");
  assert.equal((await mcp(base, { bearer: tokensAX.access_token, id: 5, method: "initialize" })).status, 401, "cancel must not restore the old bearer");
  assert.equal((await readJson(TRANSFERS_FILE)).transfers[transfer.id].status, "cancelled");
  assert.match(await page(base, cookie, "tab=audit&action=oauth.client.transfer.cancel"), /oauth\.client\.transfer\.cancel/);
});
