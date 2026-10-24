// Phase 3A-2 HTTP contract tests for GET /api/web/v2/search.
//
// Real Express router + real session login + real catalog runtime + real file reads
// (no mock JSON backend). Verifies auth-before-catalog, the disabled/not-ready 503s,
// the frozen limit/cursor/semantic contract, and that the bounded second pass never
// reads the whole Vault.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-v2-search-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
const NOTE_COUNT = 30;
for (let index = 0; index < NOTE_COUNT; index += 1) {
  const body = index === 7 ? "alpha zzunique payload" : `alpha payload number ${index}`;
  await fs.writeFile(path.join(vault, "Notes", `n-${String(index).padStart(2, "0")}.md`), `---\nstatus: ${index % 2 ? "todo" : "done"}\n---\n${body}\n`);
}
await fs.writeFile(path.join(vault, "Notes", "cjk.md"), "---\nstatus: done\n---\n中文笔记 内容\n");
process.env.VAULT_PATH = vault;
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.DATA_PATH = data;
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");

// Imported only after VAULT_PATH/DATA_PATH are set: config is read at import time.
const [
  { createWebAppRouter },
  { defaultWebVaultId, resolveWebVault },
  runtimeModule,
  candidatesModule,
  searchApiModule,
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
  import("../src/app/web-catalog/search-candidates.js"),
  import("../src/app/web-catalog/search-api.js"),
]);
const { MAX_CANDIDATES_PER_REQUEST } = candidatesModule;
const { WebCatalogHttpError, parseSearchLimit, parseSearchQuery } = searchApiModule;
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
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out closing v2 search server")), HTTP_TIMEOUT_MS)),
  ]);
}

async function startAuthedApp(stateName, { routeMetrics } = {}) {
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
  app.use(createWebAppRouter({ provider, secureCookie: false, routeMetrics }));
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

// --- pure contract (no HTTP) ---

test("search query parsing is strict and deterministic", () => {
  assert.equal(parseSearchLimit(undefined), 50);
  assert.equal(parseSearchLimit("200"), 200);
  for (const bad of ["0", "201", "-1", "1.5", "abc", "1e2", "Infinity"]) {
    assert.throws(() => parseSearchLimit(bad), (error) => error instanceof WebCatalogHttpError && error.code === "invalid-limit");
  }
  assert.deepEqual(parseSearchQuery({}), { q: "", limit: 50, cursor: null, semantic: false, caseSensitive: false });
  assert.equal(parseSearchQuery({ semantic: "true" }).semantic, true);
  assert.equal(parseSearchQuery({ caseSensitive: "1" }).caseSensitive, true);
  for (const bad of ["yes", "TRUE1", "2"]) {
    assert.throws(() => parseSearchQuery({ semantic: bad }), (error) => error.code === "invalid-semantic");
  }
  assert.throws(() => parseSearchQuery({ q: "x".repeat(1001) }), (error) => error.code === "invalid-query");
});

// --- HTTP contract ---

test("v2 search requires auth before any catalog access", async () => {
  process.env.WEB_CATALOG_ENABLED = "false";
  const app = await startAuthedApp("auth");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/search?q=alpha`);
    assert.equal(response.status, 401, "unauthenticated requests never reach catalog state");
  } finally {
    await app.close();
  }
});

test("v2 search returns 503 catalog-unavailable when the catalog is disabled", async () => {
  process.env.WEB_CATALOG_ENABLED = "false";
  const app = await startAuthedApp("disabled");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/search?q=alpha`, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "catalog-unavailable");
  } finally {
    await app.close();
  }
});

test("v2 search serves lexical pages with a bounded second pass and an exact cursor", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await catalog.drain();
  assert.equal(catalog.store.isStale(), false, "fixture catalog is clean");

  const app = await startAuthedApp("enabled");
  const search = (query = "") => boundedFetch(`${app.base}/api/web/v2/search${query}`, { headers: { Cookie: app.cookie } });
  try {
    // A selective lexical query: exactly one note matches, and the second pass reads
    // only candidates — never the whole Vault.
    const single = await search("?q=zzunique");
    assert.equal(single.status, 200);
    const singleBody = await single.json();
    assert.deepEqual(singleBody.items.map((item) => item.path), ["Notes/n-07.md"]);
    assert.equal(singleBody.nextCursor, null);
    assert.deepEqual(singleBody.semantic, { requested: false, used: false, error: null });
    assert.equal(singleBody.catalog.stale, false);
    assert.ok(singleBody.search.secondPassReads < NOTE_COUNT, `bounded reads: ${singleBody.search.secondPassReads}`);
    assert.ok(singleBody.search.candidates <= MAX_CANDIDATES_PER_REQUEST);
    // Frozen §6 item schema: `modifiedMs` (number | null), no `modified`.
    assert.equal(typeof singleBody.items[0].modifiedMs, "number");
    assert.equal("modified" in singleBody.items[0], false, "the frozen schema has no `modified`");
    assert.equal(typeof singleBody.items[0].matchCount, "number");

    // Pagination: every match stays reachable through the cursor, with no duplicates.
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 40; guard += 1) {
      const page = await search(`?q=alpha&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      assert.equal(page.status, 200);
      const body = await page.json();
      seen.push(...body.items.map((item) => item.path));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.length, NOTE_COUNT, `alpha matches every generated note: ${seen.length}`);
    assert.equal(new Set(seen).size, seen.length, "no duplicates across pages");

    // A 1-2 character CJK needle is a residual query, not an error.
    const shortCjk = await search("?q=%E7%AC%94%E8%AE%B0");
    assert.equal(shortCjk.status, 200);
    const cjkBody = await shortCjk.json();
    assert.deepEqual(cjkBody.items.map((item) => item.path), ["Notes/cjk.md"]);
    assert.equal(cjkBody.search.mode, "residual");
    assert.equal(cjkBody.search.rank, "path");

    // Structural query: FTS-seeded but ranked by path.
    const structural = await search("?q=tag%3Adone");
    assert.equal(structural.status, 200);
    assert.equal((await structural.json()).search.rank, "path");

    // Frozen error contract.
    for (const [query, status, code] of [
      ["?q=alpha&limit=0", 400, "invalid-limit"],
      ["?q=alpha&limit=201", 400, "invalid-limit"],
      ["?q=alpha&cursor=not-a-cursor", 400, "cursor-invalid"],
      ["?q=alpha&semantic=maybe", 400, "invalid-semantic"],
      ["?q=" + "x".repeat(1001), 400, "invalid-query"],
    ]) {
      const response = await search(query);
      assert.equal(response.status, status, `${query} -> ${status}`);
      assert.equal((await response.json()).error, code, query);
    }

    // A stale snapshot is still served, and it says so.
    catalog.store.setStale(true);
    const staleOk = await search("?q=zzunique");
    assert.equal(staleOk.status, 200);
    const staleOkBody = await staleOk.json();
    assert.equal(staleOkBody.catalog.stale, true);
    assert.deepEqual(staleOkBody.items.map((item) => item.path), ["Notes/n-07.md"]);
    catalog.store.setStale(false);

    // A candidate whose file can no longer be read is skipped and counted, never
    // silently matched and never a request failure.
    const removed = path.join(vault, "Notes", "n-07.md");
    await fs.rm(removed);
    const skipped = await search("?q=zzunique");
    assert.equal(skipped.status, 200);
    const skippedBody = await skipped.json();
    assert.equal(skippedBody.items.length, 0, "an unreadable candidate is not a match");
    assert.ok(skippedBody.search.skipped >= 1, `unreadable candidate counted: ${skippedBody.search.skipped}`);

    // Phase 3B-2: semantic=true is a real path now. With no retrieval snapshot /
    // embedding provider it degrades explicitly -- lexical results, requested=true,
    // used=false and a non-null reason -- never a silent downgrade and never v1.
    const semantic = await search("?q=alpha&semantic=true&limit=5");
    assert.equal(semantic.status, 200);
    const semanticBody = await semantic.json();
    assert.equal(semanticBody.semantic.requested, true);
    assert.equal(semanticBody.semantic.used, false);
    assert.ok(semanticBody.semantic.error, "the degradation reason must be explicit");
    assert.ok(semanticBody.items.length > 0, "the lexical fallback still answers");
    assert.equal(semanticBody.search.mode === "semantic", false, "degraded runs the lexical path");

    // A generation change invalidates the cursor with a recoverable 409.
    const first = await search("?q=alpha&limit=5");
    const staleCursor = (await first.json()).nextCursor;
    assert.ok(staleCursor);
    catalog.store.upsertNote({ path: "Notes/extra.md", content: "alpha extra", raw: "alpha extra" });
    const stale = await search(`?q=alpha&limit=5&cursor=${encodeURIComponent(staleCursor)}`);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "cursor-stale");
  } finally {
    await app.close();
  }
});

test("v2 search reports catalog-not-ready before the first reconcile", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  // A fresh catalog that has never reconciled must not be served as an empty Vault.
  // Close the previous runtime first: its SQLite handle keeps the file locked.
  __resetWebCatalogRuntimesForTests();
  await fs.rm(process.env.WEB_CATALOG_DIR, { recursive: true, force: true });
  const app = await startAuthedApp("not-ready");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v2/search?q=alpha`, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "catalog-not-ready");
  } finally {
    await app.close();
  }
});

// Phase 3B-2: the semantic path itself (join -> bounded second pass), driven through
// an injected retrieval snapshot so no embedding provider is required.
test("v2 search runs the semantic join when retrieval has a snapshot", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await catalog.drain();

  const { resolveSearchPage } = await import("../src/app/web-catalog/search-api.js");
  const getRuntime = () => catalog;
  const recall = async () => ({
    results: [
      { path: "Notes/n-08.md", score: 0.9, reasons: ["semantic"] },
      { path: "Notes/does-not-exist.md", score: 0.8 }, // catalog join drops it
      { path: "/abs/Notes/n-00.md", score: 0.7 }, // non-canonical -> fail closed
    ],
    semanticUsed: true,
    semanticError: null,
  });

  const payload = await resolveSearchPage({ vault: vaultRecord, query: { q: "alpha", semantic: "true", limit: "5" }, getRuntime, recall });
  assert.equal(payload.semantic.requested, true);
  assert.equal(payload.semantic.used, true);
  assert.equal(payload.semantic.error, null);
  assert.equal(payload.search.mode, "semantic");
  assert.equal(payload.search.window, 3, "the window is min(offered, 200)");
  assert.equal(payload.search.examined, 3);
  assert.deepEqual(payload.items.map((item) => item.path), ["Notes/n-08.md"]);
  assert.equal(payload.search.skippedMissing, 1);
  assert.equal(payload.search.skippedPath, 1);
  assert.equal(payload.nextCursor, null, "the semantic stream is a single bounded page");

  // A catalog mutation during the join must never mix snapshots: explicit degradation.
  // The real facade with a generation that moves after the join.
  let generationCalls = 0;
  const racing = {
    ...catalog.store,
    generation: () => {
      generationCalls += 1;
      return generationCalls > 1 ? catalog.store.generation() + 1 : catalog.store.generation();
    },
  };
  const raced = await resolveSearchPage({
    vault: vaultRecord,
    query: { q: "alpha", semantic: "true", limit: "5" },
    getRuntime: () => ({ store: racing, status: () => ({ covered: true }) }),
    recall,
  });
  assert.equal(raced.semantic.requested, true);
  assert.equal(raced.semantic.used, false);
  assert.match(String(raced.semantic.error), /Catalog changed during semantic retrieval/);
  assert.equal(raced.search.mode !== "semantic", true, "degraded runs the lexical path");
});

// Phase 3B-2 review: semantic orchestration state machine.
test("semantic without embeddings degrades to a complete lexical fallback", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await catalog.drain();
  const { resolveSearchPage } = await import("../src/app/web-catalog/search-api.js");

  // Reachable state: the snapshot exists, embeddings do not, and no error is reported.
  const recall = async () => ({ results: [{ path: "Notes/n-08.md", score: 0.9 }], semanticUsed: false, semanticError: null });
  const payload = await resolveSearchPage({
    vault: vaultRecord,
    query: { q: "alpha", semantic: "true", limit: "5" },
    getRuntime: () => catalog,
    recall,
  });
  assert.equal(payload.semantic.requested, true);
  assert.equal(payload.semantic.used, false);
  assert.ok(payload.semantic.error, "the reason must be explicit even when retrieval reports none");
  assert.equal(payload.search.mode === "semantic", false, "used=false must run the lexical path");
  assert.ok(payload.nextCursor, "the lexical fallback keeps its own pagination");
});

test("a semantic-degraded continuation stays lexical and never re-enters semantic", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await catalog.drain();
  const { resolveSearchPage } = await import("../src/app/web-catalog/search-api.js");

  let recallCalls = 0;
  const unavailable = async () => {
    recallCalls += 1;
    throw new Error("Retrieval snapshot unavailable");
  };
  const first = await resolveSearchPage({
    vault: vaultRecord,
    query: { q: "alpha", semantic: "true", limit: "5" },
    getRuntime: () => catalog,
    recall: unavailable,
  });
  assert.equal(first.semantic.used, false);
  assert.ok(first.semantic.error);
  assert.ok(first.nextCursor, "the degraded page still pages");
  const page1 = first.items.map((item) => item.path);
  assert.equal(recallCalls, 1);

  // Retrieval would succeed now, but the continuation must not consult it.
  const nowReady = async () => {
    recallCalls += 1;
    return { results: [{ path: "Notes/n-08.md", score: 0.9 }], semanticUsed: true, semanticError: null };
  };
  const second = await resolveSearchPage({
    vault: vaultRecord,
    query: { q: "alpha", semantic: "true", limit: "5", cursor: first.nextCursor },
    getRuntime: () => catalog,
    recall: nowReady,
  });
  assert.equal(recallCalls, 1, "a continuation must never re-attempt semantic");
  assert.equal(second.semantic.requested, true);
  assert.equal(second.semantic.used, false);
  assert.match(String(second.semantic.error), /lexical fallback/);
  assert.equal(second.search.mode === "semantic", false);
  const page2 = second.items.map((item) => item.path);
  assert.equal(page2.length > 0, true);
  assert.equal(page2.some((path) => page1.includes(path)), false, "no overlap between pages");
  assert.notEqual(second.nextCursor, first.nextCursor, "the cursor advances");
});

// Phase 4A: the v1 deprecation evidence fails closed at the route level.
test("v1 notes answers 503 evidence-unavailable when its counter cannot be recorded", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const catalog = getWebCatalogRuntime(vaultRecord);
  catalog.setCoverage(true, "test");
  await catalog.drain();

  const { createRouteMetrics } = await import("../src/app/route-metrics.js");
  const fsSync = (await import("node:fs")).default;
  const { file } = await (async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "route-metrics-http-"));
    return { file: path.join(root, "route-metrics.json") };
  })();

  // Healthy store: the compatibility endpoint still works.
  const healthy = createRouteMetrics({ file });
  const okApp = await startAuthedApp("metrics-ok", { routeMetrics: healthy });
  try {
    const response = await boundedFetch(`${okApp.base}/api/web/v1/notes?q=`, { headers: { Cookie: okApp.cookie } });
    assert.equal(response.status, 200, "a recorded v1 request still succeeds");
    assert.equal(healthy.totals()["web.v1.notes.requests"] >= 1, true);
  } finally {
    await okApp.close();
    healthy.dispose();
  }

  // Broken store: the same request must NOT look like a normal success, otherwise a
  // broken evidence file would read as a clean zero and the 7-day gate could never be
  // trusted. (This is the fail-closed alternative to an external durable ops channel.)
  const failing = createRouteMetrics({
    file,
    writer: () => { const error = new Error("nospc"); error.code = "ENOSPC"; throw error; },
    logger: { error: () => {} },
  });
  const brokenApp = await startAuthedApp("metrics-broken", { routeMetrics: failing });
  try {
    const response = await boundedFetch(`${brokenApp.base}/api/web/v1/notes?q=`, { headers: { Cookie: brokenApp.cookie } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "evidence-unavailable");
  } finally {
    await brokenApp.close();
    failing.dispose();
    fsSync.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
