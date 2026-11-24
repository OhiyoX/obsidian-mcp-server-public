// #285 — `POST /admin/auth/api-key/agent` stores the operator's display-purpose Agent label.
//
// Runs through the real Admin router, a real login and a real CSRF token on a real HTTP socket,
// over the real `PersistentOAuthProvider` (so the audit row and the stored bytes are the ones a
// deployment writes). One case per boundary the design names: set, clear, the 40-character edge,
// control characters, a missing CSRF field, an unknown id, and a restart that reloads the file.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";

const PASSWORD = "test-only-admin-password";
const ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-key-agent-label-"));
process.env.DATA_PATH = ROOT;
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:18999";
process.env.OAUTH_ADMIN_PASSWORD = PASSWORD;
process.env.OAUTH_INITIAL_USERNAME = "test-owner";
process.env.OAUTH_INITIAL_PASSWORD = "test-oauth-password";
process.env.API_KEY = "configured-env-test-key";
process.env.MCP_PATH = "/mcp";
process.env.GIT_ENABLED = "false";

const { createOAuthService } = await import("../src/oauth-provider.js");
const { createAdminRouter } = await import("../src/admin/router.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth/primitives.js");

after(async () => {
  await rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** One Admin plane on one provider: login, then the session's CSRF token. */
async function boot() {
  const provider = createOAuthService().provider;
  await provider.ready;
  const app = express();
  app.use("/admin/auth", createAdminRouter({ provider, adminPassword: PASSWORD, secureCookie: false }));
  const server = app.listen(0);
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: "manual",
  });
  assert.equal(login.status, 303, "the admin password must log in");
  const cookies = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie")];
  const cookie = cookies.filter(Boolean).map((item) => item.split(";")[0]).join("; ");
  const page = await fetch(`${origin}/admin/auth?tab=keys`, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(csrf, "the Auth Center page must expose a CSRF token");
  return {
    provider,
    csrf,
    origin,
    cookie,
    post: (fields) => fetch(`${origin}/admin/auth/api-key/agent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams(fields),
      redirect: "manual",
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const storedKey = async (provider, id) => (await provider.authorizationSnapshot()).apiKeys.find((key) => key.id === id);

test("setting a label redirects to the list, stores it, and writes one audit row", async (t) => {
  const admin = await boot();
  t.after(() => admin.close());
  const key = await admin.provider.createApiKey("桌面客户端");

  const answer = await admin.post({ csrf: admin.csrf, id: key.id, agent: "  pi-pocket  " });
  assert.equal(answer.status, 303);
  assert.equal(answer.headers.get("location"), "/admin/auth?tab=keys");
  assert.equal((await storedKey(admin.provider, key.id)).agentLabel, "pi-pocket", "the value is trimmed");

  const rows = (await admin.provider.authorizationSnapshot()).audit.filter((row) => row.action === "api-key.agent-label" && row.credentialId === key.id);
  assert.equal(rows.length, 1, "exactly one label row");
  assert.equal(rows[0].detail, " → pi-pocket", "the row records old → new");
});

test("an empty field clears the label, and the audit row keeps the old value", async (t) => {
  const admin = await boot();
  t.after(() => admin.close());
  const key = await admin.provider.createApiKey("清空演示");
  assert.equal((await admin.post({ csrf: admin.csrf, id: key.id, agent: "codex-cli" })).status, 303);

  assert.equal((await admin.post({ csrf: admin.csrf, id: key.id, agent: "   " })).status, 303);
  assert.equal((await storedKey(admin.provider, key.id)).agentLabel, null, "an empty field unbinds the key");
  const rows = (await admin.provider.authorizationSnapshot()).audit.filter((row) => row.action === "api-key.agent-label" && row.credentialId === key.id);
  // The audit list is newest-first.
  assert.deepEqual(rows.map((row) => row.detail), ["codex-cli → ", " → codex-cli"]);
});

test("40 characters is accepted and 41 is refused without writing", async (t) => {
  const admin = await boot();
  t.after(() => admin.close());
  const key = await admin.provider.createApiKey("边界演示");

  assert.equal((await admin.post({ csrf: admin.csrf, id: key.id, agent: "a".repeat(40) })).status, 303);
  assert.equal((await storedKey(admin.provider, key.id)).agentLabel, "a".repeat(40));

  const refused = await admin.post({ csrf: admin.csrf, id: key.id, agent: "b".repeat(41) });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /最多 40 个字符/);
  assert.equal((await storedKey(admin.provider, key.id)).agentLabel, "a".repeat(40), "a refused write stores nothing");
});

test("control characters and line breaks are refused", async (t) => {
  const admin = await boot();
  t.after(() => admin.close());
  const key = await admin.provider.createApiKey("控制字符演示");

  // Bidi overrides (U+202E) and zero-width spaces (U+200B) are format characters: they would
  // let a label read as different text in the list and the audit column. U+0085 (NEL) is a C1
  // control character: it would break the single-line label.
  for (const agent of ["pi\npocket", "pi\tpocket", "pi\u0007pocket", "pi\u0085pocket", "<span>\u202E</span>", "pi\u200Bpocket", "pi\uFEFFpocket"]) {
    const refused = await admin.post({ csrf: admin.csrf, id: key.id, agent });
    assert.equal(refused.status, 400, `${JSON.stringify(agent)} must be refused`);
    assert.match(await refused.text(), /不能包含控制字符或换行/);
  }
  assert.equal((await storedKey(admin.provider, key.id)).agentLabel, null);
});

test("a call that sets the scope and the label together writes both audit rows", async (t) => {
  const admin = await boot();
  t.after(() => admin.close());
  const key = await admin.provider.createApiKey("双写演示");

  await admin.provider.updateApiKey(key.id, {
    allowedScopes: ["obsidian.read"],
    allowedVaults: [DEFAULT_VAULT_ID],
    agentLabel: "pi-pocket",
  });

  const rows = (await admin.provider.authorizationSnapshot()).audit
    .filter((row) => row.credentialId === key.id && row.action.startsWith("api-key.") && row.action !== "api-key.create");
  assert.deepEqual(rows.map((row) => row.action).sort(), ["api-key.agent-label", "api-key.authorization.update"], "a label write must not suppress the authorization row");

  // Each row keeps its own payload: the authorization row states the new grant, the label row the change.
  const authorization = rows.find((row) => row.action === "api-key.authorization.update");
  assert.deepEqual({ scopes: authorization.scopes, vaults: authorization.vaults }, { scopes: ["obsidian.read"], vaults: [DEFAULT_VAULT_ID] });
  const label = rows.find((row) => row.action === "api-key.agent-label");
  assert.equal(label.detail, " → pi-pocket");
  assert.equal(label.detail.split(" → ").length, 2, "the label row keeps the old → new shape");
});

test("a POST without the CSRF field is refused by the router", async (t) => {
  const admin = await boot();
  t.after(() => admin.close());
  const key = await admin.provider.createApiKey("csrf 演示");

  const refused = await admin.post({ id: key.id, agent: "pi-pocket" });
  assert.equal(refused.status, 403);
  assert.equal((await storedKey(admin.provider, key.id)).agentLabel, null);
});

test("an unknown key id answers 404 and creates nothing", async (t) => {
  const admin = await boot();
  t.after(() => admin.close());
  const before = (await admin.provider.authorizationSnapshot()).apiKeys.length;

  const refused = await admin.post({ csrf: admin.csrf, id: "no-such-key", agent: "pi-pocket" });
  assert.equal(refused.status, 404);
  assert.equal((await admin.provider.authorizationSnapshot()).apiKeys.length, before);
});

test("the label is still there after a restart reloads the store from disk", async (t) => {
  const admin = await boot();
  const key = await admin.provider.createApiKey("重启演示");
  assert.equal((await admin.post({ csrf: admin.csrf, id: key.id, agent: "hermes" })).status, 303);
  await admin.provider.drainPersistence();
  await admin.close();

  // A fresh provider reads `DATA_PATH/oauth/state.json` again: that is what a restart does.
  const restarted = createOAuthService().provider;
  await restarted.ready;
  assert.equal((await storedKey(restarted, key.id)).agentLabel, "hermes");
});
