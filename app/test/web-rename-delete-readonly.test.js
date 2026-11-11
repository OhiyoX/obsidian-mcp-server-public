// A read-only deployment (OBSIDIAN_READ_ONLY=true) must fail rename and delete closed
// with 403, the same answer the folder route gives. READ_ONLY is read at module import
// time, so this lives in its own test file/process.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-rename-ro-"));
const vault = path.join(root, "vault");
await fs.mkdir(path.join(vault, "Projects"), { recursive: true });
await fs.writeFile(path.join(vault, "Projects/Note.md"), "# note\n", "utf8");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
process.env.OBSIDIAN_READ_ONLY = "true";
delete process.env.WEB_VAULTS_ROOT;

const [{ createWebAppRouter }, { primaryRuntime }] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/vault.js"),
]);

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
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

async function startAuthedApp() {
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false, resolveVaultRuntime: () => primaryRuntime }));
  const server = await new Promise((resolve) => {
    const instance = http.createServer(app).listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
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
  return { base, cookie, csrf, close: () => new Promise((resolve) => server.close(resolve)) };
}

const post = (base, auth, route, body) =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: { Cookie: auth.cookie, "Content-Type": "application/json", "X-CSRF-Token": auth.csrf },
    body: JSON.stringify(body),
  });

const exists = (target) => fs.stat(target).then(() => true, () => false);

test("a read-only server rejects rename with 403 and moves nothing", async () => {
  const { base, cookie, csrf, close } = await startAuthedApp();
  try {
    const response = await post(base, { cookie, csrf }, "/api/web/v1/rename", { path: "Projects", to: "Work", mutationId: "m-ro-1" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Server is read-only" });
    assert.equal(await exists(path.join(vault, "Work")), false);
    assert.equal(await exists(path.join(vault, "Projects/Note.md")), true);
    assert.deepEqual(audits.filter((entry) => entry.action === "web.rename"), []);
  } finally {
    await close();
  }
});

test("a read-only server rejects delete with 403 and keeps the note", async () => {
  const { base, cookie, csrf, close } = await startAuthedApp();
  try {
    const response = await post(base, { cookie, csrf }, "/api/web/v1/delete", { path: "Projects/Note.md", confirm: true });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Server is read-only" });
    assert.equal(await exists(path.join(vault, "Projects/Note.md")), true);
    assert.deepEqual(audits.filter((entry) => entry.action === "web.delete"), []);
  } finally {
    await close();
  }
});
