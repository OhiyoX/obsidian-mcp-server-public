// Phase 2A-2 HTTP contract tests for GET /api/web/v2/tree.
//
// Real Express router + real session login + real catalog runtime (no mock JSON
// backend). Verifies auth-before-catalog, the disabled/not-ready 503s, the frozen
// limit contract, cursor/anchor identity errors and the stale snapshot semantics.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-v2-tree-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
await fs.writeFile(path.join(vault, "Root.md"), "# root\n");
await fs.writeFile(path.join(vault, "Notes", "A.md"), "# a\n");
await fs.writeFile(path.join(vault, "Notes", "B.md"), "# b\n");
process.env.VAULT_PATH = vault;
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.DATA_PATH = data;
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");

const [{ createWebAppRouter }, { defaultWebVaultId, resolveWebVault }, runtimeModule] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
]);
const { getWebCatalogRuntime, __resetWebCatalogRuntimesForTests } = runtimeModule;

test.after(async () => {
  __resetWebCatalogRuntimesForTests();
  delete process.env.WEB_CATALOG_ENABLED;
  await fs.rm(root, { recursive: true, force: true });
});

const HTTP_TIMEOUT_MS = 5_000;
const boundedFetch = (url, options = {}) =>
  fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS) });

async function closeHttpServer(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out closing v2 tree server")), HTTP_TIMEOUT_MS)),
  ]);
}

async function startAuthedApp(stateName) {
  const user = {
    id: `user-${stateName}`,
    username: "owner",
    displayName: "Owner",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read"],
    allowedVaults: [defaultWebVaultId()],
  };
  const provider = {
    authenticateOAuthUser: async (username, password) => (username === "owner" && password === "password" ? user : null),
    oauthUserSessionRecord: async (id) => (id === user.id ? user : null),
    recordAudit() {},
  };
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await boundedFetch(`${base}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "owner", password: "password" }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  return { base, cookie, close: () => closeHttpServer(server) };
}

test("v2 tree requires auth before any catalog access", async () => {
  process.env.WEB_CATALOG_ENABLED = "false";
  const app = await startAuthedApp("auth");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/tree`);
    assert.equal(response.status, 401, "unauthenticated requests never reach catalog state");
  } finally {
    await app.close();
  }
});

test("v2 tree returns 503 catalog-unavailable when the catalog is disabled", async () => {
  process.env.WEB_CATALOG_ENABLED = "false";
  const app = await startAuthedApp("disabled");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/tree`, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "catalog-unavailable");
  } finally {
    await app.close();
  }
});

test("v2 tree serves the catalog page and enforces limit/cursor/anchor/stale contract", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await catalog.drain();
  assert.equal(catalog.store.isStale(), false, "fixture catalog is clean");

  const app = await startAuthedApp("enabled");
  const get = (query = "") =>
    boundedFetch(`${app.base}/api/web/v2/tree${query}`, { headers: { Cookie: app.cookie } });
  try {
    const ok = await get();
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.parent, "");
    assert.deepEqual(body.items.map((item) => item.path), ["Notes", "Root.md"]);
    assert.equal(body.catalog.stale, false);

    const badLimit = await get("?limit=0");
    assert.equal(badLimit.status, 400);
    assert.equal((await badLimit.json()).error, "invalid-limit");

    const badCursor = await get("?cursor=not-a-cursor");
    assert.equal(badCursor.status, 400);
    assert.equal((await badCursor.json()).error, "cursor-invalid");

    const badParent = await get("?parent=/abs");
    assert.equal(badParent.status, 400);
    assert.equal((await badParent.json()).error, "invalid-path");

    const badAnchor = await get("?anchorPath=a/../b");
    assert.equal(badAnchor.status, 400);
    assert.equal((await badAnchor.json()).error, "invalid-path");

    const both = await get("?cursor=not-a-cursor&anchorPath=Root.md");
    assert.equal(both.status, 400);
    assert.equal((await both.json()).error, "invalid-anchor", "cursor + anchor are mutually exclusive");

    const missingAnchor = await get("?anchorPath=Missing.md");
    assert.equal(missingAnchor.status, 404);
    assert.equal((await missingAnchor.json()).error, "anchor-not-found");

    const anchored = await get("?parent=Notes&anchorPath=Notes/A.md");
    assert.equal(anchored.status, 200);
    assert.equal((await anchored.json()).items[0].path, "Notes/A.md");

    // A stale snapshot is still served (200 + stale), and a missing anchor becomes 409.
    catalog.store.setStale(true);
    const staleOk = await get();
    assert.equal(staleOk.status, 200);
    assert.equal((await staleOk.json()).catalog.stale, true);
    const staleAnchor = await get("?anchorPath=Missing.md");
    assert.equal(staleAnchor.status, 409);
    assert.equal((await staleAnchor.json()).error, "anchor-not-indexed");

    // Cursor invalidation is a recoverable 409, not a 500.
    catalog.store.setStale(false);
    const page = await get("?limit=1");
    const cursor = (await page.json()).nextCursor;
    assert.ok(cursor);
    catalog.store.bumpGeneration();
    const staleCursor = await get(`?limit=1&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(staleCursor.status, 409);
    assert.equal((await staleCursor.json()).error, "cursor-stale");
  } finally {
    await app.close();
  }
});

test("#428 the catalog open line never leaks the server path into an HTTP response", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await catalog.drain();

  const app = await startAuthedApp("leakfree");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/tree`, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 200);
    const text = await response.text();
    // The open line names the vault id, the absolute file and the source; only the first is public.
    assert.ok(text.includes('"stale"'), "fixture body really contains catalog state");
    assert.ok(!text.includes(process.env.WEB_CATALOG_DIR), "catalog directory must not appear in the tree body");
    assert.ok(!text.includes(`${vaultRecord.id}.sqlite`), "catalog file must not appear in the tree body");
    assert.ok(!text.includes(vaultRecord.root), "vault root must not appear in the tree body");
  } finally {
    await app.close();
  }
});

test("v2 tree returns an attachment entry with kind=file and its badge extension", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await fs.writeFile(path.join(vault, "Notes", "photo.PNG"), "not a note\n");
  await catalog.drain();

  const app = await startAuthedApp("file");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/tree?parent=Notes`, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 200);
    const items = (await response.json()).items;
    const asset = items.find((item) => item.path === "Notes/photo.PNG");
    assert.ok(asset, "the attachment is visible in the tree page");
    assert.equal(asset.kind, "file");
    assert.equal(asset.extension, "png");
    assert.equal(asset.title, "photo.PNG");
    assert.equal(asset.name, "photo.PNG");
    assert.equal(items[0].path, "Notes/A.md", "document ordering is unchanged");
  } finally {
    await app.close();
  }
});
