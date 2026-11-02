// Shared real-HTTP harness for the admin access-policy tests.
//
// `access-policy-admin-integration.test.js` grew past the line budget when the RETURN-3
// capability-filter regression joined it, so the harness it always owned moved here verbatim:
// the real `createAuthAdminRouter` mounted in a real Express app, an A3 file-backed store in a
// temporary directory, and the loopback HTTP helpers (`login` / `getPage` / `postForm`). Only
// the OAuth provider is a deterministic stand-in, because `createAuthAdminRouter` reads just its
// credential snapshot (subject picker) and records admin login audits.
//
// Contract: `scratch/authz/INTERFACE.md` §10.4/§10.6 + the C2 BRIEF §2.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import express from "express";

import { createAccessPolicyStore } from "../../src/access-policy/store.js";
import { createAccessPolicyAdmin } from "../../src/admin/access-policy.js";
import { createAdminRouter } from "../../src/admin/router.js";

export const ADMIN_PASSWORD = "admin-password-for-tests";
export const TAB = "/admin/auth/access-policy";

// Monday 2026-10-05, 05:00 UTC = 13:00 Asia/Shanghai (inside 09:00-18:00).
export const MONDAY_INSIDE = Date.parse("2026-10-05T05:00:00.000Z");
// Same Monday, 11:00 UTC = 19:00 Asia/Shanghai (outside the window).
export const MONDAY_OUTSIDE = Date.parse("2026-10-05T11:00:00.000Z");

export const CREATE_FIELDS = {
  label: "工作时间",
  mode: "suspend",
  enabled: "true",
  timezone: "Asia/Shanghai",
  startsAt: "",
  expiresAt: "",
  subjects: ["oauth-user:u1"],
  capabilities: ["scope:obsidian.read"],
  weekly: "mon 09:00-18:00",
  dateRanges: "",
};

export function providerStub() {
  return {
    ready: Promise.resolve(),
    audits: [],
    recordAudit(event) {
      this.audits.push(event);
    },
    async authorizationSnapshot() {
      return {
        oauthUsers: [{ id: "u1", username: "ada", displayName: "Ada", allowedScopes: [], allowedVaults: [], createdAt: null, lastLoginAt: null, lastSource: null }],
        clients: [{ clientId: "client-1", clientName: "桌面客户端", redirectUris: [], connectionOrigins: [], createdAt: null, lastUsedAt: null, lastSource: null }],
        apiKeys: [{ id: "key-1", label: "桌面 Key", prefix: "（不可显示）", allowedScopes: [], allowedVaults: [], createdAt: null, lastUsedAt: null, lastSource: null }],
        tokens: [],
        audit: [],
        configuredApiKeyUsage: { lastUsedAt: null, lastSource: null },
      };
    },
  };
}

export async function makeStore(t, { corrupt = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "c2-admin-access-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "access-policy.json");
  if (corrupt) await writeFile(file, "{ this is not a policy document");
  const store = createAccessPolicyStore({ file });
  await store.ready;
  return { dir, file, store };
}

export async function startAdmin(t, {
  store = null,
  runtime = null,
  now = undefined,
  accessPolicyAdmin = undefined,
  vaultGitAdmin = null,
  configuredApiKeyEnabled = false,
} = {}) {
  const app = express();
  const admin = accessPolicyAdmin !== undefined
    ? accessPolicyAdmin
    : (store ? createAccessPolicyAdmin({ store, runtime, now }) : null);
  app.use("/admin/auth", createAdminRouter({
    provider: providerStub(),
    adminPassword: ADMIN_PASSWORD,
    secureCookie: false,
    configuredApiKeyEnabled,
    accessPolicyAdmin: admin,
    vaultGitAdmin,
  }));
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}` };
}

export async function login(origin) {
  const response = await fetch(`${origin}/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
    redirect: "manual",
  });
  assert.equal(response.status, 303, "a valid admin password must log in");
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")];
  return setCookies.filter(Boolean).map((item) => item.split(";")[0]).join("; ");
}

export async function getPage(origin, cookie, pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return { response, body: await response.text() };
}

export function csrfFrom(body) {
  const match = /name="csrf" value="([^"]+)"/.exec(body);
  assert.ok(match, "the rendered page must expose a CSRF token");
  return match[1];
}

/** The Auth Center tab strip: the ordered `href` list of every rendered `.tab`. */
export function tabHrefs(body) {
  // Admin UI v2: Auth Center + AuthZ + Vault all use left/side `.ni` (app-shell). Legacy `.tabs` kept as fallback only.
  const side = /<nav class="side-body[^"]*"[^>]*>([\s\S]*?)<\/nav>/.exec(body);
  const tabs = /<nav class="tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(body);
  const nav = side || tabs;
  assert.ok(nav, "the page must render the Auth Center tab nav");
  return [...nav[1].matchAll(/<a class="(?:tab|ni)[^"]*" href="([^"]+)"/g)].map((match) => match[1]);
}

/** Minimal Vault–Git admin stand-in: the nav-wiring tests only exercise the tab strip. */
export function vaultGitAdminStub() {
  return { model: async () => ({ vaults: [], revision: 0, status: "ready", broken: null, defaultVaultId: null, notice: null }) };
}

export async function postForm(origin, cookie, pathname, fields, { csrf = null } = {}) {
  const params = new URLSearchParams();
  if (csrf) params.append("csrf", csrf);
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item ?? "");
  }
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: params,
    redirect: "manual",
  });
  return { response, body: await response.text() };
}
