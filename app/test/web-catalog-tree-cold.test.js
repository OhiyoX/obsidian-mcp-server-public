// Phase 2A-2 regressions: a cold tree request must not start a reconcile, and a
// runtime/store open failure must be a 503 availability error (not a 500).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-v2-cold-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
await fs.writeFile(path.join(vault, "Notes", "A.md"), "# a\n");
process.env.VAULT_PATH = vault;
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.DATA_PATH = data;
process.env.WEB_CATALOG_ENABLED = "true";
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");

const [{ createWebAppRouter }, { defaultWebVaultId, resolveWebVault }, runtimeModule, { openWebCatalogStore }] =
  await Promise.all([
    import("../src/app/routes.js"),
    import("../src/app/vault-registry.js"),
    import("../src/app/web-catalog/runtime.js"),
    import("../src/app/web-catalog/store.js"),
  ]);
const {
  catalogFileFor,
  closeWebCatalogRuntime,
  createWebCatalogRuntime,
  getWebCatalogRuntime,
  __resetWebCatalogRuntimesForTests,
  __setWebCatalogRuntimeFactoryForTests,
} = runtimeModule;

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
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out closing cold server")), HTTP_TIMEOUT_MS)),
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

test("a cold tree request returns 503 not-ready and never starts a reconcile", async () => {
  __resetWebCatalogRuntimesForTests();
  let listCount = 0;
  __setWebCatalogRuntimeFactoryForTests((v) =>
    createWebCatalogRuntime({
      vault: v,
      store: openWebCatalogStore({ file: catalogFileFor(v) }),
      source: {
        list: async () => {
          listCount += 1;
          return [];
        },
        read: async () => {
          throw new Error("unexpected read");
        },
      },
      logger: { error() {} },
    }),
  );

  const app = await startAuthedApp("cold");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/tree`, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "catalog-not-ready");
    assert.equal(listCount, 0, "a cold tree request must not run source.list()");

    const vaultRecord = await resolveWebVault(defaultWebVaultId());
    const runtime = getWebCatalogRuntime(vaultRecord, { startReconcile: false });
    assert.equal(runtime.isStarted(), false, "the tree read path never started a reconcile");
  } finally {
    await app.close();
  }
});

test("a runtime/store open failure returns 503 catalog-unavailable", async () => {
  __resetWebCatalogRuntimesForTests();
  __setWebCatalogRuntimeFactoryForTests(() => {
    throw new Error("sqlite open failed");
  });

  const app = await startAuthedApp("openfail");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/tree`, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "catalog-unavailable");
  } finally {
    await app.close();
  }
});

test("a warm persisted snapshot is readable but reported stale until coverage returns", async () => {
  __resetWebCatalogRuntimesForTests();
  let listCount = 0;
  const countingFactory = (v) =>
    createWebCatalogRuntime({
      vault: v,
      store: openWebCatalogStore({ file: catalogFileFor(v) }),
      source: {
        list: async () => {
          listCount += 1;
          return [{ path: "Notes/A.md", size: 3, modifiedMs: 1000, signature: "sig" }];
        },
        read: async (rel) => ({
          path: rel,
          content: "# a\n",
          frontmatter: {},
          revision: "rev-1",
          stat: { size: 3, modified: new Date(1000).toISOString(), created: new Date(0).toISOString() },
        }),
      },
      logger: { error() {} },
    });
  __setWebCatalogRuntimeFactoryForTests(countingFactory);

  // Previous process: reconcile with coverage and publish a clean, persisted snapshot.
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const warm = getWebCatalogRuntime(vaultRecord);
  warm.setCoverage(true, "previous-process");
  await warm.drain();
  assert.equal(warm.store.isStale(), false, "fixture persisted clean");
  const listsAfterWarm = listCount;
  closeWebCatalogRuntime(vaultRecord.id);

  // New process: registry empty, no watcher coverage yet. Re-inject the counting factory.
  __resetWebCatalogRuntimesForTests();
  __setWebCatalogRuntimeFactoryForTests(countingFactory);

  const app = await startAuthedApp("warm");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/tree`, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 200, "a warm persisted snapshot is readable");
    const body = await response.json();
    assert.deepEqual(body.items.map((item) => item.path), ["Notes"], "the persisted snapshot is served");
    assert.equal(body.catalog.stale, true, "persisted clean is not current clean without coverage");

    const notesPage = await boundedFetch(`${app.base}/api/web/v2/tree?parent=Notes`, { headers: { Cookie: app.cookie } });
    assert.equal(notesPage.status, 200);
    assert.deepEqual((await notesPage.json()).items.map((item) => item.path), ["Notes/A.md"]);

    assert.equal(listCount, listsAfterWarm, "a cold warm-snapshot read must not run source.list()");
    assert.equal(
      getWebCatalogRuntime(vaultRecord, { startReconcile: false }).isStarted(),
      false,
      "the tree read path never started a reconcile",
    );
  } finally {
    await app.close();
  }
});
