// #625 harness: one real Express Web app (`createWebAppRouter`) over a real Vault
// on disk, with a real login (writer = obsidian.read+write, reader = read only)
// and a real CSRF token, plus the write-route matrix the two #625 test files
// drive. Nothing here fakes a gate: the middleware chain is the shipped one.
//
// `OBSIDIAN_READ_ONLY` and the Vault env are read at module-import time and Node
// runs each test FILE in its own process, so the caller picks the mode here and
// `src/app/routes.js` is imported after the env is in place.
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

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

/** A real 1x1 PNG (same fixture as web-asset-upload.test.js): the asset route sniffs magic bytes. */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Every registered Web write route, with the smallest body that reaches its own
 * validation. `key` is the frozen table key (`<METHOD> <path>`).
 */
export const WRITE_ROUTE_CALLS = Object.freeze([
  { key: "POST /api/web/v1/note", method: "POST", path: "/api/web/v1/note", body: { path: "Fresh.md", content: "# fresh\n" } },
  { key: "POST /api/web/v1/folder", method: "POST", path: "/api/web/v1/folder", body: { path: "NewFolder" } },
  { key: "POST /api/web/v1/asset", method: "POST", path: "/api/web/v1/asset", body: PNG_1X1, headers: { "x-file-name": "a.png" } },
  { key: "POST /api/web/v1/vault", method: "POST", path: "/api/web/v1/vault", body: { name: "Another" } },
  { key: "POST /api/web/v1/publish", method: "POST", path: "/api/web/v1/publish", body: { action: "unsupported-action" } },
  { key: "PATCH /api/web/v1/base", method: "PATCH", path: "/api/web/v1/base", body: { path: "Note.base", mutations: [] } },
]);

export function providerFor({ audits = [] } = {}) {
  return {
    authenticateOAuthUser: async (username, password) =>
      password === "password" && USERS[username] ? USERS[username] : null,
    oauthUserSessionRecord: async (id) => Object.values(USERS).find((user) => user.id === id) ?? null,
    recordAudit: (entry) => audits.push(entry),
  };
}

async function login(base, username) {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password: "password" }),
  });
  if (response.status !== 303) throw new Error(`login failed for ${username}: ${response.status}`);
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const html = await (await fetch(`${base}/app`, { headers: { Cookie: cookie } })).text();
  return { cookie, csrf: html.match(/name="csrf-token" content="([^"]+)"/)[1] };
}

/** One HTTP call in the shape the route expects (raw Buffer for the asset route). */
export async function callRoute(base, route, auth = null, { csrf = true, body = route.body, headers = route.headers ?? {} } = {}) {
  const sent = { ...headers };
  if (auth) sent.Cookie = auth.cookie;
  if (csrf && auth) sent["X-CSRF-Token"] = auth.csrf;
  const raw = Buffer.isBuffer(body);
  if (!raw) sent["Content-Type"] = "application/json";
  const response = await fetch(`${base}${route.path}`, {
    method: route.method,
    headers: sent,
    body: raw ? body : JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

/**
 * Build the real Web app. `accessRuntime` is injected into `createWebAppRouter`
 * when given (the policy plane runs); omitted, the router keeps the Stage 0
 * pass-through wiring.
 *
 * `root` is optional: the caller may pre-create one temp root and share it across
 * several surfaces in the same process (the Vault/`DATA_PATH` env is read once at
 * module-import time, so a second root in one process would be ignored).
 */
export async function startWebWriteSurface({ root: providedRoot, readOnly = false, accessRuntime, label = "web-route-needs" } = {}) {
  const root = providedRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), `obsidian-${label}-`));
  const ownsRoot = !providedRoot;
  const vault = path.join(root, "vault");
  await fs.mkdir(vault, { recursive: true });
  await fs.writeFile(path.join(vault, "Note.md"), "# note\n", "utf8");
  process.env.VAULT_PATH = vault;
  process.env.DATA_PATH = path.join(root, "data");
  process.env.WEB_CATALOG_ENABLED = "true";
  process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
  if (readOnly) process.env.OBSIDIAN_READ_ONLY = "true";
  else delete process.env.OBSIDIAN_READ_ONLY;
  delete process.env.WEB_VAULTS_ROOT;
  delete process.env.WEB_DEFAULT_VAULT;

  const [{ createWebAppRouter }, { __resetWebCatalogRuntimesForTests }] = await Promise.all([
    import("../../src/app/routes.js"),
    import("../../src/app/web-catalog/runtime.js"),
  ]);

  const router = createWebAppRouter({ provider: providerFor(), secureCookie: false, accessRuntime });
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => {
    const instance = http.createServer(app).listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    root,
    vault,
    router,
    base,
    writer: await login(base, "writer"),
    reader: await login(base, "reader"),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      __resetWebCatalogRuntimesForTests();
      delete process.env.OBSIDIAN_READ_ONLY;
      delete process.env.WEB_CATALOG_ENABLED;
      delete process.env.WEB_CATALOG_DIR;
      if (ownsRoot) await fs.rm(root, { recursive: true, force: true });
    },
  };
}
