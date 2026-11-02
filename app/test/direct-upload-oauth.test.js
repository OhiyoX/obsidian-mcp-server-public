// Issue #470 follow-up — task B: the OAuth half of the direct-upload credential story.
//
// Wave A shipped with an API-key deploy probe, but D1 ("every request re-verifies the credential's
// current state") is a promise about OAuth too: tokens expire and clients/grants get revoked while
// a handle is still open. These tests run the real OAuth authorization-code + PKCE flow against the
// real `server.js`, then assert the data plane's answer before and after revocation/expiry.
//
// The helpers below duplicate only what `server-spawn-fixtures` does not expose (multi-scope
// consent, admin revoke, expiry patch); the server spawn/HTTP helpers are the shared ones.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  callTool,
  freePort,
  initialize,
  seedVault,
  serverEnv,
  startServer,
  stopChild,
} from "./helpers/server-spawn-fixtures.js";

const ADMIN_PASSWORD = "test-only-password";
const WEB_USER = "test-owner";
const WEB_PASSWORD = "test-oauth-password";
const SCOPES = ["obsidian.read", "obsidian.write", "obsidian.files"];
const PAYLOAD = Buffer.alloc(4_096, 11);
for (let index = 0; index < PAYLOAD.length; index += 1) PAYLOAD[index] = (index * 53 + 7) % 256;
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

let root;
let server;
let base;
let publicBase;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-oauth-"));
  await seedVault(root);
  const port = await freePort();
  server = await startServer(serverEnv({ port, root, extra: { WEB_CATALOG_DIR: path.join(root, "web-catalog") } }));
  base = server.base;
  publicBase = server.publicBase;
});

after(async () => {
  await stopChild(server?.child);
  await fs.rm(root, { recursive: true, force: true });
});

function vaultFile(target, vaultRoot = root) {
  return fs.readFile(path.join(vaultRoot, "vault", ...target.split("/")));
}

/** Real authorization-code + PKCE with the scopes the direct-upload tool requires. */
async function oauthToken(serverBase, serverPublicBase, scopes = SCOPES) {
  const callback = `${serverBase}/callback`;
  const registered = await (await fetch(`${serverBase}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `direct-upload-oauth-${randomUUID().slice(0, 8)}`,
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  })).json();
  assert.ok(registered.client_id, "client registration must return a client_id");
  const resource = `${serverPublicBase}/mcp`;
  const verifier = `direct-upload-verifier-${randomUUID()}`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = new URL(`${serverBase}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: callback,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "direct-upload-oauth",
    resource,
    scope: scopes.join(" "),
  });
  const consent = await (await fetch(authorizeUrl)).text();
  const transaction = consent.match(/name="transaction" value="([^"]+)"/)?.[1];
  assert.ok(transaction, "the consent page must expose a transaction");

  const decision = new URLSearchParams({ transaction, username: WEB_USER, password: WEB_PASSWORD, decision: "allow" });
  for (const scope of scopes) decision.append("scope", scope);
  const approved = await fetch(`${serverBase}/oauth/decision`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: decision,
  });
  assert.equal(approved.status, 302, `consent must redirect, got ${approved.status}: ${await approved.text()}`);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  assert.ok(code, "consent must return an authorization code");

  const tokens = await (await fetch(`${serverBase}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, code, code_verifier: verifier, redirect_uri: callback, resource }),
  })).json();
  assert.ok(tokens.access_token, `token exchange must return an access token: ${JSON.stringify(tokens)}`);
  assert.deepEqual([...tokens.scope.split(" ")].sort(), [...SCOPES].sort());
  return { registered, tokens, resource };
}

function putWithToken(serverBase, relativePath, token, body = PAYLOAD) {
  return fetch(`${serverBase}${relativePath}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body,
  });
}

async function adminLogin(serverBase) {
  const login = await fetch(`${serverBase}/admin/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 303, "admin login must succeed");
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const page = await fetch(`${serverBase}/admin/auth`, { headers: { Cookie: cookie } });
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf, "admin page must expose a CSRF token");
  return { cookie, csrf };
}

/** Operator revoke (the production path that flips the durable grant to `revoked`). */
async function revokeClient(serverBase, clientId) {
  const { cookie, csrf } = await adminLogin(serverBase);
  const response = await fetch(`${serverBase}/admin/auth/oauth/client/revoke`, {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, clientId }),
  });
  assert.equal(response.status, 303, "the revoke form must redirect back to the client list");
}

async function startUpload(serverBase, auth, session, target = `attachments/${randomUUID()}.bin`) {
  const response = await callTool(serverBase, auth, session, "start_direct_upload", {
    path: target, totalBytes: PAYLOAD.length, sha256: sha256(PAYLOAD), overwrite: false,
  });
  const structured = response.payload?.result?.structuredContent ?? {};
  assert.ok(structured.uploadId, `control plane failed: ${JSON.stringify(response.payload)}`);
  assert.equal(structured.mode, "single-put");
  assert.equal(structured.method, "PUT");
  return { structured, target };
}

test("an OAuth access token drives the control plane and publishes through PUT (201, bytes identical)", async () => {
  const { tokens } = await oauthToken(base, publicBase);
  const auth = { bearer: tokens.access_token };
  const init = await initialize(base, auth);
  assert.equal(init.status, 200, "OAuth must be accepted by the same auth middleware as an API key");
  const session = init.session;

  const { structured, target } = await startUpload(base, auth, session);
  const published = await putWithToken(base, structured.relativePath, tokens.access_token);
  const body = await published.json();
  assert.equal(published.status, 201, JSON.stringify(body));
  assert.equal(body.uploadId, structured.uploadId);
  assert.equal(body.size, PAYLOAD.length);
  assert.equal(body.sha256, sha256(PAYLOAD));
  assert.ok((await vaultFile(target)).equals(PAYLOAD));
});

test("revoking the OAuth client stops the open handle (401, nothing published) and the control plane", async () => {
  const { registered, tokens } = await oauthToken(base, publicBase);
  const auth = { bearer: tokens.access_token };
  const session = (await initialize(base, auth)).session;

  // The handle exists before the revoke: the PUT must re-verify the credential (D1), not trust the
  // handle or the MCP session that created it.
  const { structured, target } = await startUpload(base, auth, session);
  await revokeClient(base, registered.client_id);

  const blocked = await putWithToken(base, structured.relativePath, tokens.access_token);
  const blockedBody = await blocked.json();
  assert.equal(blocked.status, 401, `a revoked access token must not reach the stream: ${JSON.stringify(blockedBody)}`);
  assert.equal(blockedBody.error, "invalid_token");
  await assert.rejects(vaultFile(target), /ENOENT/, "a revoked PUT must publish nothing");

  // Control plane re-verifies too: no new handle for a revoked credential.
  const rejectedStart = await callTool(base, auth, session, "start_direct_upload", {
    path: `attachments/${randomUUID()}.bin`, totalBytes: PAYLOAD.length, sha256: sha256(PAYLOAD),
  });
  assert.equal(rejectedStart.status, 401, `revoked credential must not start an upload: ${rejectedStart.text}`);
});

test("an expired OAuth access token answers 401 (not 500) and never publishes", async () => {
  // Own instance: the token has to be expired in the durable state and the server restarted to load
  // it. The access-token TTL floor is 300 s, so waiting it out is not a test.
  const expiryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-oauth-expiry-"));
  await seedVault(expiryRoot);
  const port = await freePort();
  const env = serverEnv({ port, root: expiryRoot, extra: { WEB_CATALOG_DIR: path.join(expiryRoot, "web-catalog") } });
  let current = await startServer(env);
  try {
    const { registered, tokens } = await oauthToken(current.base, current.publicBase);
    const auth = { bearer: tokens.access_token };
    const session = (await initialize(current.base, auth)).session;
    const { structured, target } = await startUpload(current.base, auth, session);

    await stopChild(current.child);
    const statePath = path.join(expiryRoot, "data", "oauth", "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    const record = Object.values(state.accessTokens).find((item) => item.clientId === registered.client_id && !item.revokedAt);
    assert.ok(record, "the issued access token must be in the durable state");
    record.expiresAt = Date.now() - 60_000;
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    current = await startServer(env);
    const expired = await putWithToken(current.base, structured.relativePath, tokens.access_token);
    const expiredBody = await expired.json();
    assert.equal(expired.status, 401, `an expired token must be a 401, got ${expired.status}: ${JSON.stringify(expiredBody)}`);
    assert.equal(expiredBody.error, "invalid_token");
    await assert.rejects(vaultFile(target, expiryRoot), /ENOENT/, "an expired PUT must publish nothing");
  } finally {
    await stopChild(current.child);
    await fs.rm(expiryRoot, { recursive: true, force: true });
  }
});
