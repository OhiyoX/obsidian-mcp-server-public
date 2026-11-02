import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-http-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
await fs.writeFile(path.join(vault, "Public.md"), "---\ntitle: Public metadata title\ndescription: Public description\ntags: [public-tag]\nsecret: must-not-leak\nsummary: Explicit public summary\npublish_properties: [summary]\n---\n# Public body\n\nHello [[Private Note]] ![[image.png]] ![Manual preview](secret.pdf)", "utf8");
await fs.writeFile(path.join(vault, "image.png"), Buffer.from("PRIVATE_IMAGE_MARKER"));
await fs.writeFile(path.join(vault, "secret.pdf"), Buffer.from("%PDF-PRIVATE_ATTACHMENT_MARKER"));
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
delete process.env.WEB_VAULTS_ROOT;

const [{ createWebAppRouter }, { PublishService }, { registerPublishTools }, { createVaultScopeRegistrar }] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/publish/service.js"),
  import("../src/tools/publish.js"),
  import("../src/vault-scope-registrar.js"),
]);

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve(server));
  });
}

test.after(async () => fs.rm(root, { recursive: true, force: true }));

test("private document routes require Vault-scoped login and Publish exposes only one sanitized note", async () => {
  const user = {
    id: "user-1",
    username: "owner",
    displayName: "Owner",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read", "obsidian.write"],
    allowedVaults: ["default"],
  };
  const provider = {
    authenticateOAuthUser: async (username, password) => username === "owner" && password === "password" ? user : null,
    oauthUserSessionRecord: async (id) => id === user.id ? user : null,
    recordAudit() {},
  };
  const publishService = new PublishService({ file: path.join(data, "publish", "http-state.json") });
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false, publishService }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "password" }),
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const appResponse = await fetch(`${base}/app`, { headers: { Cookie: cookie } });
    const appHtml = await appResponse.text();
    const csrf = appHtml.match(/name="csrf-token" content="([^"]+)"/)[1];

    const before = await (await fetch(`${base}/api/web/v1/publish?path=Public.md`, { headers: { Cookie: cookie } })).json();
    assert.equal(before.published, false);
    assert.match(before.privatePath, /^\/app\/note\//);
    assert.equal(before.privateUrl, `${base}${before.privatePath}`);
    const opened = await (await fetch(`${base}/api/web/v1/note?path=Public.md`, { headers: { Cookie: cookie } })).json();
    assert.equal(opened.path, "Public.md");
    assert.equal(opened.vaultId, "default");
    assert.equal(opened.route, before.privatePath);
    const noPublished = await (await fetch(`${base}/api/web/v1/notes?q=published%3Atrue`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(noPublished.notes, []);
    const initiallyPrivate = await (await fetch(`${base}/api/web/v1/notes?q=published%3Afalse`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(initiallyPrivate.notes.map((item) => item.path), ["Public.md"]);

    const anonymousPrivate = await fetch(`${base}${before.privatePath}`, { redirect: "manual" });
    assert.equal(anonymousPrivate.status, 303);
    assert.match(anonymousPrivate.headers.get("location"), /^\/auth\/login\?next=/);
    const authenticatedPrivate = await fetch(`${base}${before.privatePath}`, { headers: { Cookie: cookie } });
    assert.equal(authenticatedPrivate.status, 200);
    assert.match(await authenticatedPrivate.text(), /name="initial-note-path" content="Public\.md"/);

    const publish = await fetch(`${base}/api/web/v1/publish`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ action: "publish", path: "Public.md" }),
    });
    assert.equal(publish.status, 200);
    const published = await publish.json();
    assert.equal(published.published, true);
    assert.match(published.publicPath, /^\/publish\/[A-Za-z0-9_-]{43}$/);
    const publishedNotes = await (await fetch(`${base}/api/web/v1/notes?q=published%3Atrue`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(publishedNotes.notes.map((item) => item.path), ["Public.md"]);
    const privateNotes = await (await fetch(`${base}/api/web/v1/notes?q=published%3Afalse`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(privateNotes.notes, []);

    const publicResponse = await fetch(`${base}${published.publicPath}`);
    const publicHtml = await publicResponse.text();
    assert.equal(publicResponse.status, 200);
    assert.match(publicResponse.headers.get("content-security-policy"), /media-src 'none'/);
    assert.match(publicResponse.headers.get("x-robots-tag"), /noindex/);
    assert.match(publicHtml, /Public body/);
    assert.match(publicHtml, /Public metadata title/);
    assert.match(publicHtml, /Public description/);
    assert.match(publicHtml, /public-tag/);
    assert.match(publicHtml, /Explicit public summary/);
    assert.doesNotMatch(publicHtml, /publish_properties/);
    assert.doesNotMatch(publicHtml, /must-not-leak/);
    assert.doesNotMatch(publicHtml, /secret:/);
    assert.match(publicHtml, /附件未公开/);
    assert.match(publicHtml, /Manual preview/);
    assert.doesNotMatch(publicHtml, /image\.png/);
    assert.doesNotMatch(publicHtml, /secret\.pdf/);
    assert.doesNotMatch(publicHtml, /PRIVATE_IMAGE_MARKER|PRIVATE_ATTACHMENT_MARKER/);
    assert.doesNotMatch(publicHtml, /\[\[Private Note]]/);

    const anonymousAsset = await fetch(`${base}/api/web/v1/asset?path=image.png&from=Public.md`);
    assert.equal(anonymousAsset.status, 401);
    assert.deepEqual(await anonymousAsset.json(), { error: "Login required" });

    const noFilesAsset = await fetch(`${base}/api/web/v1/asset?path=image.png&from=Public.md`, {
      headers: { Cookie: cookie },
    });
    assert.equal(noFilesAsset.status, 403);
    assert.deepEqual(await noFilesAsset.json(), { error: "Account does not have file permission" });

    assert.match(publicHtml, /\/app\/assets\/app\.css/);
    assert.match(publicHtml, /\/app\/assets\/theme-boot\.js/);
    assert.match(publicHtml, /\/app\/assets\/publish\.css/);
    assert.match(publicHtml, /\/app\/assets\/publish\.js/);
    assert.match(publicHtml, /publish-theme-toggle/);

    const revoke = await fetch(`${base}/api/web/v1/publish`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ action: "revoke", path: "Public.md" }),
    });
    assert.equal(revoke.status, 200);
    assert.equal((await revoke.json()).published, false);
    assert.equal((await fetch(`${base}${published.publicPath}`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCP Publish tools take the credential Vault boundary from the vault-scope registrar", async () => {
  const tools = new Map();
  // Wave C (contract §7.3/§43-4): the handler holds no allowlist any more — the vault-scope
  // registrar owns the canonical `vaultId` injection and the credential boundary.
  const registrar = createVaultScopeRegistrar(
    { registerTool: (name, descriptor, handler) => tools.set(name, { descriptor, handler }), getClientVersion: () => ({ name: "", version: "" }) },
    { vaultExists: async () => true },
  );
  registerPublishTools(registrar);
  assert.ok(tools.has("get_publish_status"));
  assert.ok(tools.has("manage_publish"));
  assert.ok(tools.get("get_publish_status").descriptor.inputSchema.vaultId, "the canonical field is injected");

  const denied = await tools.get("get_publish_status").handler(
    { path: "Public.md", vaultId: "other" },
    { authInfo: { clientId: "test", allowedVaults: ["default"] } },
  );
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.structuredContent, { code: "vault_access_denied", vaultId: "other" });

  const published = await tools.get("manage_publish").handler(
    { action: "publish", path: "Public.md", vaultId: "default" },
    { authInfo: { clientId: "test", allowedVaults: ["default"] } },
  );
  assert.equal(published.isError, undefined);
  assert.equal(published.structuredContent.published, true);
  const revoked = await tools.get("manage_publish").handler(
    { action: "revoke", path: "Public.md", vaultId: "default" },
    { authInfo: { clientId: "test", allowedVaults: ["default"] } },
  );
  assert.equal(revoked.structuredContent.published, false);
});
