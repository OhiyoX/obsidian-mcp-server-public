// #364 slice 2 — Admin transfer route over a real Express app and the real Auth Center
// router: CSRF, status mapping, flash wording, cancel and the SSR projection.
//
// The provider here is a deterministic stand-in (the route only consumes its snapshot and
// transfer service), so a failure mode like "store not writable" can be injected as the
// real typed error and the route's mapping is asserted without a filesystem. The real
// end-to-end path lives in `authorization-transfer-admin-e2e.test.js`.

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import express from "express";

import { createAdminRouter } from "../src/admin/router.js";
import { AuthorizationTransferError } from "../src/oauth/authorization-transfer-methods.js";
import { pairGenerationKey } from "../src/oauth/authorization-transfer-runtime.js";

const ADMIN_PASSWORD = "i364-admin-password";
const BEGIN = "/admin/auth/oauth/client/transfer";
const CANCEL = "/admin/auth/oauth/client/transfer/cancel";
const CLIENTS = "/admin/auth?tab=clients";

const users = [
  { id: "u-a", username: "alice", displayName: "Alice" },
  { id: "u-b", username: "bob", displayName: "Bob" },
  { id: "u-c", username: "carol", displayName: "Carol" },
].map((user) => ({ ...user, allowedScopes: [], allowedVaults: [], createdAt: null, lastLoginAt: null, lastSource: null }));

function baseSnapshot(tokens = []) {
  return {
    oauthUsers: users,
    clients: [{ clientId: "client-x", clientName: "X 客户端", redirectUris: [], connectionOrigins: [], createdAt: null, lastUsedAt: null, lastSource: null }],
    apiKeys: [],
    tokens,
    audit: [],
    configuredApiKeyUsage: { lastUsedAt: null, lastSource: null },
  };
}

function makeProvider({ snapshot = baseSnapshot(), transferSnapshot = { available: true, healthy: true, transfers: [], generations: [] }, begin = null, cancel = null } = {}) {
  const provider = {
    ready: Promise.resolve(),
    audits: [],
    beginCalls: [],
    cancelCalls: [],
    recordAudit(event) { this.audits.push(event); },
    async authorizationSnapshot() { return snapshot; },
    async authorizationTransferSnapshot() { return transferSnapshot; },
    async beginAuthorizationTransfer(args) {
      provider.beginCalls.push(args);
      return begin ? begin(args) : { transfer: { id: "tr-1", status: "pending" }, reused: false, degraded: false };
    },
    async cancelAuthorizationTransfer(id, options) {
      provider.cancelCalls.push({ id, options });
      return cancel ? cancel(id, options) : { changed: true, transfer: { id }, reason: "cancelled_by_admin" };
    },
  };
  return provider;
}

async function startAdmin(t, provider) {
  const app = express();
  app.use("/admin/auth", createAdminRouter({ provider, adminPassword: ADMIN_PASSWORD, secureCookie: false }));
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function login(origin) {
  const response = await fetch(`${origin}/admin/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

function csrfFrom(body) {
  const match = /name="csrf" value="([^"]+)"/.exec(body);
  assert.ok(match, "the page must expose a CSRF token");
  return match[1];
}

async function getPage(origin, cookie, path) {
  const response = await fetch(`${origin}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  return { response, body: await response.text() };
}

async function post(origin, cookie, path, fields) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields),
  });
  return { response, body: await response.text() };
}

const FIELDS = { clientId: "client-x", sourceUserId: "u-a", targetUserId: "u-b" };

test("an unauthenticated transfer POST is redirected to the admin login", async (t) => {
  const provider = makeProvider();
  const origin = await startAdmin(t, provider);
  const { response } = await post(origin, null, BEGIN, FIELDS);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin/auth/login");
  assert.equal(provider.beginCalls.length, 0);
});

test("a missing or wrong CSRF token is refused with zero state change", async (t) => {
  const provider = makeProvider();
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const { body } = await getPage(origin, cookie, CLIENTS);
  const csrf = csrfFrom(body);
  const auditRows = provider.audits.length;

  const missing = await post(origin, cookie, BEGIN, FIELDS);
  assert.equal(missing.response.status, 403);
  assert.match(missing.body, /CSRF 校验失败/);
  const wrong = await post(origin, cookie, BEGIN, { ...FIELDS, csrf: `${csrf}x` });
  assert.equal(wrong.response.status, 403);
  assert.equal(provider.beginCalls.length, 0, "a CSRF failure must not reach the service");
  assert.equal(provider.audits.length, auditRows, "a CSRF failure must not write an audit row");
});

test("a successful begin is a 303 to the clients tab with the frozen flash wording", async (t) => {
  const provider = makeProvider();
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);

  const { response } = await post(origin, cookie, BEGIN, { ...FIELDS, csrf });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), CLIENTS);
  assert.equal(provider.beginCalls.length, 1);
  assert.deepEqual(
    { clientId: provider.beginCalls[0].clientId, sourceUserId: provider.beginCalls[0].sourceUserId, targetUserId: provider.beginCalls[0].targetUserId, actor: provider.beginCalls[0].actor },
    { clientId: "client-x", sourceUserId: "u-a", targetUserId: "u-b", actor: "admin-session" },
  );
  const page = (await getPage(origin, cookie, CLIENTS)).body;
  assert.match(page, /等待目标账户用同一客户端重新授权/);
  assert.match(page, /源授权已撤销/);
  assert.doesNotMatch(page, /转移完成/, "the flash must never claim the transfer completed");
});

test("a degraded begin reports the real close outcome in the flash", async (t) => {
  const provider = makeProvider({ begin: async () => ({ transfer: { id: "tr-1" }, reused: false, degraded: true, sessions: { failed: 1 } }) });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  assert.equal((await post(origin, cookie, BEGIN, { ...FIELDS, csrf })).response.status, 303);
  const page = (await getPage(origin, cookie, CLIENTS)).body;
  assert.match(page, /源会话关闭未完全成功/);
  assert.match(page, /旧凭证仍被撤销/);
});

test("a degraded begin that closed every session does not blame the session close", async (t) => {
  // Seat P1-3: the `source_revoke_sync_failed` path sets `degraded` while sessionsFailed is 0.
  const provider = makeProvider({ begin: async () => ({ transfer: { id: "tr-1" }, reused: false, degraded: true, sessions: { matched: 1, closed: 1, failed: 0, unavailable: false } }) });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  assert.equal((await post(origin, cookie, BEGIN, { ...FIELDS, csrf })).response.status, 303);
  const page = (await getPage(origin, cookie, CLIENTS)).body;
  assert.doesNotMatch(page, /源会话关闭未完全成功/, "a source-state sync failure must not be reported as a session close failure");
  assert.match(page, /未完成的同步步骤/);
  assert.match(page, /源账户旧凭证仍被撤销/);
});

test("a degraded begin reports the observed close counts when sessions did fail", async (t) => {
  const provider = makeProvider({ begin: async () => ({ transfer: { id: "tr-1" }, reused: true, degraded: true, sessions: { matched: 2, closed: 1, failed: 1 } }) });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  assert.equal((await post(origin, cookie, BEGIN, { ...FIELDS, csrf })).response.status, 303);
  const page = (await getPage(origin, cookie, CLIENTS)).body;
  assert.match(page, /源会话关闭未完全成功：已关闭 1\/2，未关闭 1 个/);
  assert.match(page, /源账户旧凭证仍被撤销/);
  assert.doesNotMatch(page, /未完成的同步步骤/, "the close counts are known, so no generic note is needed");
});

test("a degraded begin that both failed to sync and failed to close reports the close counts", async (t) => {
  const provider = makeProvider({ begin: async () => ({ transfer: { id: "tr-1" }, reused: false, degraded: true, sessions: { matched: 2, closed: 0, failed: 2, unavailable: false } }) });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  assert.equal((await post(origin, cookie, BEGIN, { ...FIELDS, csrf })).response.status, 303);
  const page = (await getPage(origin, cookie, CLIENTS)).body;
  assert.match(page, /源会话关闭未完全成功：已关闭 0\/2，未关闭 2 个/);
  assert.match(page, /源账户旧凭证仍被撤销/);
});

test("negative control: a healthy begin carries no degraded wording at all", async (t) => {
  const provider = makeProvider({ begin: async () => ({ transfer: { id: "tr-1" }, reused: false, degraded: false, sessions: { matched: 1, closed: 1, failed: 0 } }) });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  assert.equal((await post(origin, cookie, BEGIN, { ...FIELDS, csrf })).response.status, 303);
  const page = (await getPage(origin, cookie, CLIENTS)).body;
  assert.match(page, /已发起转移：源授权已撤销/);
  assert.doesNotMatch(page, /源会话关闭/);
  assert.doesNotMatch(page, /未完成的同步步骤/);
});

test("the service status codes are rendered verbatim: 400 / 404 / 409 / 503", async (t) => {
  const cases = [
    ["invalid_request", 400, "invalid_request"],
    ["not_found", 404, "not_found"],
    ["conflict", 409, "The target account is already authorized for this client"],
    ["unavailable", 503, "unavailable"],
  ];
  for (const [code, status, message] of cases) {
    const provider = makeProvider({ begin: async () => { throw new AuthorizationTransferError(code, status, message); } });
    const origin = await startAdmin(t, provider);
    const cookie = await login(origin);
    const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
    const { response, body } = await post(origin, cookie, BEGIN, { ...FIELDS, csrf });
    assert.equal(response.status, status, `${code} must map to ${status}`);
    assert.match(body, new RegExp(`错误码 <code>${status}</code>`));
    assert.match(body, /转移未发起|未撤销源账户授权|字段不合法|不存在/);
  }
});

test("the target-already-authorized conflict uses the frozen wording", async (t) => {
  const provider = makeProvider({ begin: async () => { throw new AuthorizationTransferError("conflict", 409, "The target account is already authorized for this client"); } });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  const { response, body } = await post(origin, cookie, BEGIN, { ...FIELDS, csrf });
  assert.equal(response.status, 409);
  assert.match(body, /目标账户已授权该客户端，请先处理其现有授权。转移未发起。/);
});

test("a 503 never revokes the source: the provider is not asked to change anything else", async (t) => {
  const provider = makeProvider({ begin: async () => { throw new AuthorizationTransferError("unavailable", 503, "unavailable"); } });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  const { response, body } = await post(origin, cookie, BEGIN, { ...FIELDS, csrf });
  assert.equal(response.status, 503);
  assert.match(body, /未撤销源账户授权/);
  assert.equal(provider.cancelCalls.length, 0);
});

test("healthy:false does not block a begin — the store is asked and decides", async (t) => {
  const provider = makeProvider({ transferSnapshot: { available: true, healthy: false, transfers: [], generations: [] } });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  const { response } = await post(origin, cookie, BEGIN, { ...FIELDS, csrf });
  assert.equal(response.status, 303, "an unhealthy read must not be used as a writability gate");
  assert.equal(provider.beginCalls.length, 1);
});

test("cancel is a 303 with a flash that says the old bearer is not restored", async (t) => {
  const provider = makeProvider();
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  const { response } = await post(origin, cookie, CANCEL, { csrf, transferId: "tr-1" });
  assert.equal(response.status, 303);
  assert.equal(provider.cancelCalls[0].id, "tr-1");
  const page = (await getPage(origin, cookie, CLIENTS)).body;
  assert.match(page, /不会恢复/);
});

test("cancelling an unknown transfer is a 404", async (t) => {
  const provider = makeProvider({ cancel: async () => { throw new AuthorizationTransferError("not_found", 404, "Unknown authorization transfer"); } });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  const { response } = await post(origin, cookie, CANCEL, { csrf, transferId: "missing" });
  assert.equal(response.status, 404);
});

test("a failed cancel says it was NOT cancelled and the existing fence is not lifted", async (t) => {
  // Seat P1-2: the cancel 503 used to reuse the begin wording ("未撤销源账户授权"), which
  // describes the wrong state — nothing was revoked by the cancel, and the fence that already
  // exists stays in force (the record is still pending, the old bearer is still refused).
  const provider = makeProvider({ cancel: async () => { throw new AuthorizationTransferError("unavailable", 503, "Authorization transfer store is unavailable"); } });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
  const { response, body } = await post(origin, cookie, CANCEL, { csrf, transferId: "tr-1" });
  assert.equal(response.status, 503);
  assert.match(body, /未能成功取消/);
  assert.match(body, /不会解除/);
  assert.match(body, /源账户的旧凭证仍被拒绝/);
  assert.doesNotMatch(body, /未撤销源账户授权/, "the cancel page must not reuse the begin wording");
});

test("a failed cancel of a 400/404/409 kind also keeps the cancel wording", async (t) => {
  for (const [code, status] of [["invalid_request", 400], ["not_found", 404], ["conflict", 409]]) {
    const provider = makeProvider({ cancel: async () => { throw new AuthorizationTransferError(code, status, "irrelevant"); } });
    const origin = await startAdmin(t, provider);
    const cookie = await login(origin);
    const csrf = csrfFrom((await getPage(origin, cookie, CLIENTS)).body);
    const { response, body } = await post(origin, cookie, CANCEL, { csrf, transferId: "tr-1" });
    assert.equal(response.status, status);
    assert.match(body, /未能成功取消/, `${code} must use the cancel wording`);
    assert.doesNotMatch(body, /未撤销源账户授权/);
  }
});

test("SSR: a pending transfer shows the frozen label, a cancel form, and no current source", async (t) => {
  const tokens = [{ id: "t-a", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 0, revokedAt: null, scopes: [], allowedVaults: [] }];
  const transfer = { id: "tr-1", clientId: "client-x", sourceUserId: "u-a", targetUserId: "u-b", status: "pending", generation: 1, expiresAt: new Date(Date.now() + 600_000).toISOString(), createdAt: new Date().toISOString() };
  const provider = makeProvider({
    snapshot: baseSnapshot(tokens),
    transferSnapshot: { available: true, healthy: true, transfers: [transfer], generations: [{ key: pairGenerationKey("client-x", "u-a"), generation: 1 }] },
  });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  // The row states the fence; the cancel action lives in the client's `?id=` drawer (prototype
  // `5-render.js` clients row + drawer), which is also where the transfer fields are posted.
  const { body } = await getPage(origin, cookie, CLIENTS);
  assert.match(body, /转移中 → Bob/);
  assert.doesNotMatch(body, /<a href="\/admin\/auth\?tab=accounts&amp;id=u-a">Alice<\/a>/, "the fenced source must not be projected as current");
  const drawer = await getPage(origin, cookie, `${CLIENTS}&id=client-x`);
  assert.match(drawer.body, new RegExp(`action="${CANCEL.replaceAll("/", "\\/")}"`));
  assert.match(drawer.body, /name="transferId" value="tr-1"/);
});

test("SSR negative control: without a fence generation the source is shown as current", async (t) => {
  const tokens = [{ id: "t-a", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 0, revokedAt: null, scopes: [], allowedVaults: [] }];
  const provider = makeProvider({ snapshot: baseSnapshot(tokens), transferSnapshot: { available: true, healthy: true, transfers: [], generations: [] } });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const { body } = await getPage(origin, cookie, CLIENTS);
  assert.match(body, /<a href="\/admin\/auth\?tab=accounts&amp;id=u-a">Alice<\/a>/, "the same page must show the account when no fence exists");
  assert.doesNotMatch(body, /转移中 → Bob/);
});

test("SSR: a pending past its TTL whose expiry is not committed is not shown as a live pending", async (t) => {
  const transfer = { id: "tr-1", clientId: "client-x", sourceUserId: "u-a", targetUserId: "u-b", status: "pending", generation: 1, expiresAt: new Date(Date.now() - 60_000).toISOString(), createdAt: new Date(Date.now() - 900_000).toISOString() };
  const provider = makeProvider({
    snapshot: baseSnapshot(),
    transferSnapshot: { available: true, healthy: true, transfers: [transfer], generations: [{ key: pairGenerationKey("client-x", "u-a"), generation: 1 }] },
  });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const { body } = await getPage(origin, cookie, CLIENTS);
  assert.match(body, /转移期限已过/);
  assert.match(body, /尚未落盘/);
  assert.doesNotMatch(body, /转移待 Bob 重新授权/);
});

test("SSR: the fence marks the credential itself revoked, not only the account cell", async (t) => {
  const tokens = [{ id: "t-a", clientId: "client-x", userId: "u-a", type: "access", status: "active", generation: 0, revokedAt: null, scopes: ["obsidian.read"], allowedVaults: ["default"], createdAt: null, expiresAt: "2030-01-01T00:00:00.000Z", lastUsedAt: null, lastSource: null, connectionOrigin: null }];
  const provider = makeProvider({
    snapshot: baseSnapshot(tokens),
    transferSnapshot: { available: true, healthy: true, transfers: [], generations: [{ key: pairGenerationKey("client-x", "u-a"), generation: 1 }] },
  });
  const origin = await startAdmin(t, provider);
  const cookie = await login(origin);
  const { body } = await getPage(origin, cookie, "/admin/auth?tab=tokens");
  assert.match(body, /<td><span class="st danger" title="revoked"><span class="dot"><\/span>已撤销<\/span><\/td>/, "the fenced credential is projected as revoked, not filtered out of one cell");
});
