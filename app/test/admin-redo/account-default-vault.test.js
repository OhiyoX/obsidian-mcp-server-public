// #642 follow-up: the account drawer can set the account's default Vault.
//
// Real Express listener, real Admin router, real CSRF, real page render. The provider is a stub
// whose default-Vault write runs the REAL `normalizeDefaultVaultId`. That stub only refuses an
// out-of-scope value because the route refuses it first: a route that skipped the check would
// reach `normalizeDefaultVaultId` and throw, so the refusal alone does not prove the route. The
// `writes` assertions are what pin "the route refused before any write", and the installed-Vault
// case is the route's own check.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createAdminRouter } from "../../src/admin/router.js";
import { normalizeDefaultVaultId } from "../../src/default-vault.js";

const ADMIN_PASSWORD = "account-default-vault-admin";
const zh = (await import("../../src/i18n/admin/zh-CN.policy.js")).default;
const en = (await import("../../src/i18n/admin/en.policy.js")).default;
const dir = await mkdtemp(path.join(os.tmpdir(), "admin-account-default-vault-"));
process.env.DATA_PATH = path.join(dir, "data");
process.env.VAULT_PATH = path.join(dir, "vault");
await import("node:fs/promises").then((fs) => fs.mkdir(process.env.VAULT_PATH, { recursive: true }));

const INVENTORY = [
  { id: "default", name: "Default", primary: true },
  { id: "alpha", name: "Alpha" },
];

function makeState(defaultVaultId = null) {
  return {
    tokens: [],
    oauthUsers: [{
      id: "u-1", username: "bob", displayName: "Bob Li", allowedScopes: ["obsidian.read"],
      allowedVaults: ["default", "beta"], defaultVaultId,
      createdAt: "2026-10-01T00:00:00.000Z", lastLoginAt: null, lastSource: null,
    }],
    apiKeys: [], clients: [], audit: [], configuredApiKeyUsage: { lastUsedAt: null, lastSource: null },
  };
}

function makeProvider(state) {
  const writes = [];
  return {
    writes,
    ready: Promise.resolve(),
    recordAudit() {},
    async drainPersistence() {},
    async authorizationSnapshot() {
      return { apiKeys: state.apiKeys, clients: state.clients, oauthUsers: state.oauthUsers, tokens: state.tokens, audit: state.audit };
    },
    async updateOAuthUserDefaultVault(userId, defaultVaultId) {
      const user = state.oauthUsers.find((item) => item.id === userId);
      if (!user) return false;
      user.defaultVaultId = normalizeDefaultVaultId(defaultVaultId, user.allowedVaults);
      writes.push([userId, user.defaultVaultId]);
      return true;
    },
  };
}

async function startFixture(t, defaultVaultId = null) {
  const state = makeState(defaultVaultId);
  const provider = makeProvider(state);
  const app = express();
  app.use("/admin/auth", createAdminRouter({
    provider, adminPassword: ADMIN_PASSWORD, secureCookie: false,
    listVaults: async () => ({ vaults: INVENTORY }),
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/admin/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 303, "the fixture login must succeed");
  return { origin, cookie: login.headers.get("set-cookie").split(";", 1)[0], provider, state };
}

async function get(origin, cookie, urlPath) {
  const response = await fetch(`${origin}${urlPath}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}

async function post(origin, cookie, urlPath, fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, String(value ?? ""));
  const response = await fetch(`${origin}${urlPath}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: params.toString(),
  });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}

function csrfOf(body) {
  const match = /name="csrf" value="([^"]+)"/.exec(body);
  assert.ok(match, "the page must expose a CSRF token");
  return match[1];
}

async function drawer(fixture) {
  const page = await get(fixture.origin, fixture.cookie, "/admin/auth?tab=accounts&id=u-1");
  assert.equal(page.status, 200);
  return page.body;
}

function formOf(html) {
  const start = html.indexOf('action="/admin/auth/oauth/user/default-vault"');
  assert.ok(start > 0, "the account drawer must carry the default-Vault form");
  return html.slice(start, html.indexOf("</form>", start));
}

test("the account drawer offers only Vaults the account may use", async (t) => {
  const fixture = await startFixture(t);
  const form = formOf(await drawer(fixture));
  const options = [...form.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)</g)].map((m) => ({ value: m[1], attrs: m[2] }));
  assert.deepEqual(options.map((o) => o.value), ["", "default"], "beta is allowed but not installed; alpha is installed but not allowed");
  assert.match(options[0].attrs, /selected/, "no account default yet, so inherit is selected");
});

test("a saved account default is the selected option", async (t) => {
  const fixture = await startFixture(t, "default");
  const options = [...formOf(await drawer(fixture)).matchAll(/<option value="([^"]*)"([^>]*)>/g)];
  assert.ok(options.some(([, value, attrs]) => value === "default" && /selected/.test(attrs)));
});

test("saving the account default writes it and returns to the drawer", async (t) => {
  const fixture = await startFixture(t);
  const csrf = csrfOf(await drawer(fixture));
  const saved = await post(fixture.origin, fixture.cookie, "/admin/auth/oauth/user/default-vault", { csrf, id: "u-1", defaultVaultId: "default" });
  assert.equal(saved.status, 303);
  assert.match(saved.location, /tab=accounts/);
  assert.deepEqual(fixture.provider.writes, [["u-1", "default"]]);
});

test("an empty choice means inherit and is written as null", async (t) => {
  const fixture = await startFixture(t, "default");
  const csrf = csrfOf(await drawer(fixture));
  const saved = await post(fixture.origin, fixture.cookie, "/admin/auth/oauth/user/default-vault", { csrf, id: "u-1", defaultVaultId: "" });
  assert.equal(saved.status, 303);
  assert.deepEqual(fixture.provider.writes, [["u-1", null]]);
});

test("a Vault outside the account's scope is refused and writes nothing", async (t) => {
  const fixture = await startFixture(t);
  const csrf = csrfOf(await drawer(fixture));
  const refused = await post(fixture.origin, fixture.cookie, "/admin/auth/oauth/user/default-vault", { csrf, id: "u-1", defaultVaultId: "alpha" });
  assert.equal(refused.status, 400);
  assert.deepEqual(fixture.provider.writes, []);
});

test("a Vault that is not installed is refused and writes nothing", async (t) => {
  const fixture = await startFixture(t);
  const csrf = csrfOf(await drawer(fixture));
  const refused = await post(fixture.origin, fixture.cookie, "/admin/auth/oauth/user/default-vault", { csrf, id: "u-1", defaultVaultId: "beta" });
  assert.equal(refused.status, 400);
  assert.deepEqual(fixture.provider.writes, []);
});

test("the save flash names the live tokens the new default cannot reach", async (t) => {
  const fixture = await startFixture(t);
  // A token issued before "default" was added to this account: it may not open that Vault.
  fixture.state.tokens.push({ id: "t-1", userId: "u-1", clientId: "c-1", status: "active", allowedVaults: ["beta"] });
  const csrf = csrfOf(await drawer(fixture));
  const saved = await post(fixture.origin, fixture.cookie, "/admin/auth/oauth/user/default-vault", { csrf, id: "u-1", defaultVaultId: "default" });
  assert.equal(saved.status, 303);
  const page = await get(fixture.origin, fixture.cookie, "/admin/auth?tab=accounts");
  assert.ok(zh["adm.dv.userUpdatedStale"], "the stale-token flash must exist in both catalogs");
  assert.ok(en["adm.dv.userUpdatedStale"], "the stale-token flash must exist in both catalogs");
  const shown = [zh, en].map((catalog) => catalog["adm.dv.userUpdatedStale"].replace("{count}", "1"));
  assert.ok(shown.some((text) => page.body.includes(text)), `the flash must state the count and the refusal, got: ${page.body.slice(0, 0)}`);
});

test("a missing CSRF token is refused and writes nothing", async (t) => {
  const fixture = await startFixture(t);
  const refused = await post(fixture.origin, fixture.cookie, "/admin/auth/oauth/user/default-vault", { id: "u-1", defaultVaultId: "default" });
  assert.notEqual(refused.status, 303);
  assert.deepEqual(fixture.provider.writes, []);
});

test("a signed-out caller cannot reach the route", async (t) => {
  const fixture = await startFixture(t);
  const refused = await post(fixture.origin, null, "/admin/auth/oauth/user/default-vault", { id: "u-1", defaultVaultId: "default" });
  assert.match(refused.location || "", /login/, "a signed-out POST is sent to the login page, not executed");
  assert.deepEqual(fixture.provider.writes, []);
});
