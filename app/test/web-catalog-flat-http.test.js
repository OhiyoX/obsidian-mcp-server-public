// HTTP contract tests for the flat page (`GET /api/web/v2/tree?flat=1`).
//
// Real Express router + real session login + real catalog runtime: the flat page is
// the same route/gate/auth as the tree page, so the parser, the store read and the
// error mapping are all exercised through HTTP (not mocked).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-v2-flat-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "Notes", "Deep"), { recursive: true });
await fs.writeFile(path.join(vault, "Root.md"), "# root\n");
await fs.writeFile(path.join(vault, "Notes", "A.md"), "# a\n");
await fs.writeFile(path.join(vault, "Notes", "B.md"), "# b\n");
await fs.writeFile(path.join(vault, "Notes", "C.md"), "# c\n");
await fs.writeFile(path.join(vault, "Notes", "Deep", "D.md"), "# d\n");
await fs.writeFile(path.join(vault, "photo.png"), "not a note\n");
await fs.writeFile(path.join(vault, "Ref.base"), "views: []\n");
process.env.VAULT_PATH = vault;
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.DATA_PATH = data;
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");

const [{ createWebAppRouter }, { defaultWebVaultId }, runtimeModule] = await Promise.all([
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
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out closing v2 flat server")), HTTP_TIMEOUT_MS)),
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

async function readyCatalog() {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await import("../src/app/vault-registry.js").then((module) => module.resolveWebVault(defaultWebVaultId()));
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await catalog.drain();
  assert.equal(catalog.store.isStale(), false, "fixture catalog is clean");
  return catalog;
}

test("v2 flat page requires auth and lists note-only rows across the whole Vault", async () => {
  await readyCatalog();
  const app = await startAuthedApp("auth");
  const get = (query = "") =>
    boundedFetch(`${app.base}/api/web/v2/tree${query}`, { headers: { Cookie: app.cookie } });
  try {
    const anonymous = await boundedFetch(`${app.base}/api/web/v2/tree?flat=1`);
    assert.equal(anonymous.status, 401, "the flat page never bypasses the tree route gate");

    const response = await get("?flat=1&sort=path&direction=asc&limit=100");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.parent, "");
    assert.equal(body.catalog.stale, false);
    assert.equal(body.nextCursor, null);
    assert.deepEqual(
      [...body.items].map((item) => item.path).sort(),
      ["Notes/A.md", "Notes/B.md", "Notes/C.md", "Notes/Deep/D.md", "Root.md"],
    );
    for (const item of body.items) {
      assert.equal(item.kind, "note");
      assert.deepEqual(Object.keys(item).sort(), ["kind", "modified", "name", "path", "title"]);
    }
    assert.equal(body.items.some((item) => item.path === "photo.png" || item.path === "Ref.base" || item.path === "Notes"), false);
  } finally {
    await app.close();
  }
});

test("v2 flat page pages to the end with a keyset cursor for both supported orderings", async () => {
  await readyCatalog();
  const app = await startAuthedApp("paging");
  const get = (query) =>
    boundedFetch(`${app.base}/api/web/v2/tree${query}`, { headers: { Cookie: app.cookie } });
  try {
    for (const [sort, direction] of [["path", "asc"], ["modified", "desc"]]) {
      const whole = (await (await get(`?flat=1&sort=${sort}&direction=${direction}&limit=500`)).json()).items.map((item) => item.path);
      assert.equal(whole.length, 5);
      const paged = [];
      let cursor = null;
      let pages = 0;
      do {
        const url = `?flat=1&sort=${sort}&direction=${direction}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const response = await get(url);
        assert.equal(response.status, 200, url);
        const body = await response.json();
        paged.push(...body.items.map((item) => item.path));
        cursor = body.nextCursor;
        pages += 1;
        assert.equal(pages <= 4, true);
      } while (cursor);
      assert.deepEqual(paged, whole, `${sort} ${direction} paging`);
      assert.equal(pages, 3, `${sort} ${direction} needs three pages at limit 2`);
    }
  } finally {
    await app.close();
  }
});

test("v2 flat page rejects a parent, an anchor, an unsupported sort and an unknown flat flag", async () => {
  await readyCatalog();
  const app = await startAuthedApp("invalid");
  const get = (query) =>
    boundedFetch(`${app.base}/api/web/v2/tree${query}`, { headers: { Cookie: app.cookie } });
  try {
    const cases = [
      ["?flat=1&parent=Notes", 400, "flat-parent-conflict"],
      ["?flat=1&parent=/abs", 400, "flat-parent-conflict"],
      ["?flat=1&anchorPath=Root.md", 400, "invalid-anchor"],
      ["?flat=1&sort=name", 400, "invalid-sort"],
      ["?flat=1&sort=score", 400, "invalid-sort"],
      ["?flat=1&sort=created", 400, "invalid-sort"],
      ["?flat=1&direction=sideways", 400, "invalid-sort"],
      ["?flat=0", 400, "invalid-flat"],
      ["?flat=yes", 400, "invalid-flat"],
      ["?flat=1&limit=0", 400, "invalid-limit"],
      ["?flat=1&limit=501", 400, "invalid-limit"],
    ];
    for (const [query, status, code] of cases) {
      const response = await get(query);
      assert.equal(response.status, status, `${query} status`);
      assert.equal((await response.json()).error, code, `${query} code`);
    }
    // An explicit empty parent is the root, not a parent: the flat page is served.
    assert.equal((await get("?flat=1&parent=")).status, 200);
  } finally {
    await app.close();
  }
});

test("a flat cursor and a tree cursor are never interchangeable, and a stale one is a 409", async () => {
  const catalog = await readyCatalog();
  const app = await startAuthedApp("cursor");
  const get = (query) =>
    boundedFetch(`${app.base}/api/web/v2/tree${query}`, { headers: { Cookie: app.cookie } });
  try {
    const flatFirst = await get("?flat=1&sort=path&direction=asc&limit=2");
    const flatCursor = (await flatFirst.json()).nextCursor;
    assert.ok(flatCursor, "the flat page needs a continuation");

    const treeFirst = await get("?parent=&sort=path&direction=asc&limit=2").catch(() => null);
    assert.equal(treeFirst?.status ?? 0, 400, "the tree page does not accept sort=path");
    const treePage = await get("?parent=&sort=modified&direction=desc&limit=2");
    const treeCursor = (await treePage.json()).nextCursor;
    assert.ok(treeCursor, "the root tree page needs a continuation");

    const flatOnTree = await get(`?parent=&sort=modified&direction=desc&limit=2&cursor=${encodeURIComponent(flatCursor)}`);
    assert.equal(flatOnTree.status, 400);
    assert.equal((await flatOnTree.json()).error, "cursor-invalid", "a flat cursor has no tree identity");

    const treeOnFlat = await get(`?flat=1&sort=modified&direction=desc&limit=2&cursor=${encodeURIComponent(treeCursor)}`);
    assert.equal(treeOnFlat.status, 400);
    assert.equal((await treeOnFlat.json()).error, "cursor-invalid", "a tree cursor has no flat identity");

    const mismatch = await get(`?flat=1&sort=path&direction=asc&limit=2&cursor=${encodeURIComponent(treeCursor)}`);
    assert.equal(mismatch.status, 400);

    // A stale catalog generation invalidates the cursor as a recoverable 409.
    catalog.store.bumpGeneration();
    const stale = await get(`?flat=1&sort=path&direction=asc&limit=2&cursor=${encodeURIComponent(flatCursor)}`);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "cursor-stale");
  } finally {
    await app.close();
  }
});
