// Task 4: Web rename and safe delete routes (POST /api/web/v1/rename, /api/web/v1/delete).
//
// Drives the real router: auth (401), CSRF (403), confirm (400), a folder rename that
// rewrites an outside link, a 409 on an occupied destination, a note delete into the
// Trash, the 404 of a retried delete, and the 503 of a Vault without a runtime.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-rename-delete-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "Projects"), { recursive: true });
await fs.writeFile(path.join(vault, "Projects/Note.md"), "# note\n", "utf8");
// A note outside the folder: the rename must rewrite the link it holds.
await fs.writeFile(path.join(vault, "Index.md"), "# index\n\nSee [[Projects/Note]].\n", "utf8");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
delete process.env.WEB_VAULTS_ROOT;
delete process.env.OBSIDIAN_READ_ONLY;

const [{ createWebAppRouter }, { primaryRuntime }] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/vault.js"),
]);

const USERS = {
  writer: {
    id: "user-writer",
    username: "writer",
    displayName: "Writer",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read", "obsidian.write"],
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

// The default Vault of this process is the temp Vault above, so its runtime serves the fixture.
async function startAuthedApp({ resolveVaultRuntime = () => primaryRuntime } = {}) {
  const app = express();
  app.use(createWebAppRouter({ provider: providerFor(), secureCookie: false, resolveVaultRuntime }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = await login(base, "writer");
  return { base, auth, close: () => new Promise((resolve) => server.close(resolve)) };
}

const post = (base, auth, route, body) =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: { Cookie: auth.cookie, "Content-Type": "application/json", "X-CSRF-Token": auth.csrf },
    body: JSON.stringify(body),
  });

// The plan engine schedules a background index refresh under `data/`, so the teardown retries.
test.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));

test("rename returns 401 without a session and 403 without CSRF", async () => {
  const { base, auth, close } = await startAuthedApp();
  try {
    const anonymous = await fetch(`${base}/api/web/v1/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "Index.md", to: "Renamed.md" }),
    });
    assert.equal(anonymous.status, 401);

    const noCsrf = await fetch(`${base}/api/web/v1/rename`, {
      method: "POST",
      headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "Index.md", to: "Renamed.md" }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(await fs.stat(path.join(vault, "Renamed.md")).then(() => true, () => false), false);
  } finally {
    await close();
  }
});

test("rename a folder rewrites an outside link and answers the new path", async () => {
  const { base, auth, close } = await startAuthedApp();
  try {
    const res = await post(base, auth, "/api/web/v1/rename", { path: "Projects", to: "Work", mutationId: "m-1" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { kind: "folder", from: "Projects", to: "Work", updatedLinksIn: ["Index.md"], files: 1 });
    assert.equal(await fs.readFile(path.join(vault, "Index.md"), "utf8"), "# index\n\nSee [[Work/Note]].\n");
    assert.equal(await fs.stat(path.join(vault, "Work/Note.md")).then((stat) => stat.isFile()), true);
    assert.equal(await fs.stat(path.join(vault, "Projects")).then(() => true, () => false), false);
    const entries = audits.filter((entry) => entry.action === "web.rename");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].detail, "default:Projects -> Work");
  } finally {
    await close();
  }
});

test("rename into an existing target answers 409 and changes nothing", async () => {
  const { base, auth, close } = await startAuthedApp();
  try {
    const res = await post(base, auth, "/api/web/v1/rename", { path: "Work", to: "Index.md", mutationId: "m-2" });
    assert.equal(res.status, 409);
    assert.equal(await fs.stat(path.join(vault, "Work/Note.md")).then((stat) => stat.isFile()), true);
  } finally {
    await close();
  }
});

test("delete requires confirm and answers 400 without it", async () => {
  const { base, auth, close } = await startAuthedApp();
  try {
    const res = await post(base, auth, "/api/web/v1/delete", { path: "Work" });
    assert.equal(res.status, 400);
    assert.equal(await fs.stat(path.join(vault, "Work")).then((stat) => stat.isDirectory()), true);
  } finally {
    await close();
  }
});

test("delete a folder answers the Trash stamp and the file count", async () => {
  const { base, auth, close } = await startAuthedApp();
  try {
    const res = await post(base, auth, "/api/web/v1/delete", { path: "Work", confirm: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kind, "folder");
    assert.equal(body.deleted, "Work");
    assert.equal(body.files, 1);
    assert.ok(body.trash);
    const trashed = path.join(data, "trash", body.trash, "Work/Note.md");
    assert.equal(await fs.readFile(trashed, "utf8"), "# note\n");
    const entries = audits.filter((entry) => entry.action === "web.delete");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].detail, "default:Work");
  } finally {
    await close();
  }
});

test("delete a note answers the Trash backup and a retry answers 404", async () => {
  const { base, auth, close } = await startAuthedApp();
  try {
    const first = await post(base, auth, "/api/web/v1/delete", { path: "Index.md", confirm: true });
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.kind, "note");
    assert.equal(body.deleted, "Index.md");
    assert.ok(body.trash);

    const second = await post(base, auth, "/api/web/v1/delete", { path: "Index.md", confirm: true });
    assert.equal(second.status, 404);
  } finally {
    await close();
  }
});

test("a vault without a runtime answers 503 vault_unavailable", async () => {
  const { base, auth, close } = await startAuthedApp({ resolveVaultRuntime: () => null });
  try {
    for (const [route, body] of [
      ["/api/web/v1/rename", { path: "Gone.md", to: "Other.md" }],
      ["/api/web/v1/delete", { path: "Gone.md", confirm: true }],
    ]) {
      const res = await post(base, auth, route, body);
      assert.equal(res.status, 503, `${route}: status`);
      assert.deepEqual(await res.json(), { error: "Vault runtime unavailable", code: "vault_unavailable" }, `${route}: body`);
    }
  } finally {
    await close();
  }
});
