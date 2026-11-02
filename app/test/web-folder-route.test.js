// U6: Web folder create route (POST /api/web/v1/folder).
//
// Covers the whole write pipeline: 401 (no login) -> 403 (missing obsidian.write
// scope) -> 403 (CSRF) -> 400 (absolute / `..` / hidden / excluded / empty) ->
// 409 (already exists) -> 201 + real directory on disk + catalog node + audit.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-folder-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
await fs.writeFile(path.join(vault, "Existing.md"), "# existing\n");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.WEB_CATALOG_ENABLED = "true";
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
delete process.env.WEB_VAULTS_ROOT;
delete process.env.OBSIDIAN_READ_ONLY;

const [{ createWebAppRouter }, runtimeModule] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/web-catalog/runtime.js"),
]);
const { __resetWebCatalogRuntimesForTests, getWebCatalogRuntimeById } = runtimeModule;

const USERS = {
  writer: {
    id: "user-writer",
    username: "writer",
    displayName: "Writer",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read", "obsidian.write"],
    allowedVaults: ["default"],
  },
  reader: {
    id: "user-reader",
    username: "reader",
    displayName: "Reader",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read"],
    allowedVaults: ["default"],
  },
};

const audits = [];

function providerFor() {
  return {
    authenticateOAuthUser: async (username, password) =>
      password === "password" && USERS[username] ? USERS[username] : null,
    oauthUserSessionRecord: async (id) => Object.values(USERS).find((user) => user.id === id) ?? null,
    recordAudit: (entry) => audits.push(entry),
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function login(base, username) {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password: "password" }),
  });
  assert.equal(response.status, 303, `login failed for ${username}`);
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const appHtml = await (await fetch(`${base}/app`, { headers: { Cookie: cookie } })).text();
  const csrf = appHtml.match(/name="csrf-token" content="([^"]+)"/)[1];
  return { cookie, csrf };
}

const postFolder = (base, auth, body) =>
  fetch(`${base}/api/web/v1/folder`, {
    method: "POST",
    headers: { Cookie: auth.cookie, "Content-Type": "application/json", "X-CSRF-Token": auth.csrf },
    body: JSON.stringify(body),
  });

test.after(async () => {
  __resetWebCatalogRuntimesForTests();
  delete process.env.WEB_CATALOG_ENABLED;
  delete process.env.WEB_CATALOG_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

test("folder create enforces auth, scope, CSRF and path validation; then creates a real node", async () => {
  const app = express();
  app.use(createWebAppRouter({ provider: providerFor(), secureCookie: false }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 401: no session at all.
    const anonymous = await fetch(`${base}/api/web/v1/folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "Anon" }),
    });
    assert.equal(anonymous.status, 401);

    const writer = await login(base, "writer");
    const reader = await login(base, "reader");

    // 403: authenticated but without obsidian.write.
    const noScope = await postFolder(base, reader, { path: "NoScope" });
    assert.equal(noScope.status, 403);
    assert.deepEqual(await noScope.json(), { error: "Account does not have write permission" });

    // 403: CSRF missing.
    const noCsrf = await fetch(`${base}/api/web/v1/folder`, {
      method: "POST",
      headers: { Cookie: writer.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "NoCsrf" }),
    });
    assert.equal(noCsrf.status, 403);

    // 400: invalid names/paths.
    for (const bad of ["", "  ", "/absolute", "C:/windows", "..", "a/../b", ".hidden", "Notes/.secret", "node_modules", "a//b/.."]) {
      const response = await postFolder(base, writer, { path: bad });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
    // None of the rejected paths leaked a directory.
    for (const leaked of ["NoScope", "NoCsrf", "absolute", "b", ".hidden", "Notes"]) {
      assert.equal(await fs.stat(path.join(vault, leaked)).then(() => true, () => false), false, `${leaked} must not exist`);
    }

    // 201: a real folder, indexed as a directory node (read-your-writes).
    const created = await postFolder(base, writer, { path: "Projects/New Folder" });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { path: "Projects/New Folder", created: true });
    const stat = await fs.stat(path.join(vault, "Projects", "New Folder"));
    assert.equal(stat.isDirectory(), true);

    // The catalog runtime published the node in the same request flow.
    const runtime = getWebCatalogRuntimeById("default");
    assert.ok(runtime, "the folder write created the catalog runtime");
    assert.equal(runtime.store.locate("Projects")?.kind, "directory");
    assert.equal(runtime.store.locate("Projects/New Folder")?.kind, "directory");

    // 409: an existing folder is a conflict, and the folder is untouched.
    const duplicate = await postFolder(base, writer, { path: "Projects/New Folder" });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "Folder already exists" });

    // 409 also for a path that exists as a file.
    const fileCollision = await postFolder(base, writer, { path: "Existing.md" });
    assert.equal(fileCollision.status, 409);

    // Audit: one web.folder.create entry with the vault-qualified path.
    const createdAudits = audits.filter((entry) => entry.action === "web.folder.create");
    assert.equal(createdAudits.length, 1);
    assert.match(createdAudits[0].detail, /^default:Projects\/New Folder$/);
    assert.equal(createdAudits[0].credentialId, USERS.writer.id);

    // The v2 tree really exposes the new empty folder after a reconcile.
    await runtime.drain();
    const tree = await (await fetch(`${base}/api/web/v2/tree?parent=Projects&sort=name&direction=asc`, { headers: { Cookie: writer.cookie } })).json();
    assert.deepEqual(tree.items.map((item) => [item.kind, item.path]), [["directory", "Projects/New Folder"]]);
    const rootTree = await (await fetch(`${base}/api/web/v2/tree?parent=&sort=name&direction=asc`, { headers: { Cookie: writer.cookie } })).json();
    assert.ok(rootTree.items.some((item) => item.kind === "directory" && item.path === "Projects"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
