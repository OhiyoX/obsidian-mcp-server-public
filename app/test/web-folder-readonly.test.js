// U6: a read-only deployment (OBSIDIAN_READ_ONLY=true) must fail the folder write
// closed with 403 and must never touch the Vault. READ_ONLY is read at module import
// time, so this lives in its own test file/process.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-folder-ro-"));
const vault = path.join(root, "vault");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
process.env.WEB_CATALOG_ENABLED = "true";
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
process.env.OBSIDIAN_READ_ONLY = "true";
delete process.env.WEB_VAULTS_ROOT;

const { createWebAppRouter } = await import("../src/app/routes.js");

const user = {
  id: "user-ro",
  username: "writer",
  displayName: "Writer",
  updatedAt: "v1",
  allowedScopes: ["obsidian.read", "obsidian.write"],
  allowedVaults: ["default"],
};
const audits = [];
const provider = {
  authenticateOAuthUser: async (username, password) => password === "password" && username === "writer" ? user : null,
  oauthUserSessionRecord: async (id) => id === user.id ? user : null,
  recordAudit: (entry) => audits.push(entry),
};

test.after(async () => {
  delete process.env.OBSIDIAN_READ_ONLY;
  await fs.rm(root, { recursive: true, force: true });
});

test("a read-only server rejects folder create with 403 and creates nothing", async () => {
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false }));
  const server = await new Promise((resolve) => {
    const instance = http.createServer(app).listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "writer", password: "password" }),
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const appHtml = await (await fetch(`${base}/app`, { headers: { Cookie: cookie } })).text();
    const csrf = appHtml.match(/name="csrf-token" content="([^"]+)"/)[1];

    const response = await fetch(`${base}/api/web/v1/folder`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ path: "ReadOnlyFolder" }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Server is read-only" });
    assert.equal(await fs.stat(path.join(vault, "ReadOnlyFolder")).then(() => true, () => false), false);
    assert.deepEqual(audits.filter((entry) => entry.action === "web.folder.create"), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
