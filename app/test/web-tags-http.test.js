// HTTP contract tests for GET /api/web/v1/tags (sidebar Tags panel).
//
// Real Express router + real login session + real per-Vault Web Catalog + real HTTP
// (no route mocks): auth/scope status mapping, `no-store`, the frozen DTO, canonical
// `note_tags` projection, deterministic ordering (count desc + tag ASC tie-break) and
// repeat-request byte stability, the limit contract, GET-only, and the I/O gate
// (no recursive readdir, no Markdown fs.readFile) that proves the answer is an
// index-only Catalog aggregate instead of a Vault scan.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-tags-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.WEB_DEFAULT_VAULT = "default";
process.env.DATA_PATH = data;
process.env.WEB_CATALOG_ENABLED = "true";
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.RETRIEVAL_AUTO_EMBED = "false";

// Counts: alpha 3, beta 2, a/b 1, a/b/c 1, 运维 1. `Alpha`/`Beta` prove the canonical
// projection lowercases, and a/b/c proves the `/` hierarchy survives untouched.
await fs.mkdir(vault, { recursive: true });
await fs.writeFile(path.join(vault, "A.md"), "---\ntags:\n  - Alpha\n  - a/b\n  - a/b/c\n---\n# A\n", "utf8");
await fs.writeFile(path.join(vault, "B.md"), "---\ntags: [alpha, beta]\n---\n# B\n", "utf8");
await fs.writeFile(path.join(vault, "C.md"), "---\ntags: [ALPHA]\n---\n# C\n", "utf8");
await fs.writeFile(path.join(vault, "D.md"), "# D\n\nInline #Beta and #运维 here.\n", "utf8");
await fs.writeFile(path.join(vault, "Plain.md"), "# Plain\n\nNo tags at all.\n", "utf8");

const [
  { createWebAppRouter },
  { defaultWebVaultId, resolveWebVault },
  { getWebCatalogRuntime, __resetWebCatalogRuntimesForTests },
  { registerTagsRoute },
  { classifyWebApiError },
  { createAccessPolicyRuntime },
  { fakeClock, fakeStore, policyFixture, snapshotFixture },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
  import("../src/app/tags-route.js"),
  import("../src/app/web-api-error.js"),
  import("../src/access-policy/runtime.js"),
  import("./helpers/access-policy-fixtures.js"),
]);

test.after(async () => {
  // Closing every catalog runtime releases the sqlite handles before the temp dir is
  // removed (Windows keeps `-shm`/`-wal` busy while a connection is still open).
  __resetWebCatalogRuntimesForTests();
  await fs.rm(root, { recursive: true, force: true });
});

const HTTP_TIMEOUT_MS = 10_000;
const boundedFetch = (url, options = {}) => fetch(url, {
  ...options,
  signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS),
});

async function closeHttpServer(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  let timeoutId;
  const timedOut = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Timed out closing tags test server")), HTTP_TIMEOUT_MS);
  });
  try {
    await Promise.race([closed, timedOut]);
  } finally {
    clearTimeout(timeoutId);
  }
}

let catalogRuntime = null;
async function ensureCatalog() {
  if (catalogRuntime) return catalogRuntime;
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  catalogRuntime = getWebCatalogRuntime(vaultRecord);
  catalogRuntime.setCoverage(true, "test");
  await catalogRuntime.drain();
  assert.equal(catalogRuntime.store.isStale(), false, "fixture catalog must be clean");
  return catalogRuntime;
}

async function startAuthedApp(stateName, accessRuntime) {
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
  app.use(createWebAppRouter({ provider, secureCookie: false, accessRuntime }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await boundedFetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "password" }),
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    return { base, cookie, user, close: () => closeHttpServer(server) };
  } catch (error) {
    await closeHttpServer(server).catch(() => {});
    throw error;
  }
}

async function startRoutedApp(currentVault, name) {
  const app = express();
  // Mirrors the real `/api/web/v1` security middleware (routes.js securityHeaders).
  app.use("/api/web/v1", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  registerTagsRoute(app, { requireApi: (_req, _res, next) => next(), currentVault });
  app.use((error, _req, res, _next) => {
    const response = classifyWebApiError(error);
    res.status(response.status).json({ error: response.error });
  });
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, name, close: () => closeHttpServer(server) };
}

// AuthZ window fixture: the frozen Asia/Shanghai Mon–Fri 09:00–18:00 grid shared
// with test/access-policy-web.test.js. OUTSIDE is Monday 20:00 local and INSIDE is
// Monday 10:00 local, so the next allowed instant is Tuesday 09:00 local.
const INSIDE_WINDOW_MS = Date.parse("2026-10-05T02:00:00.000Z");
const OUTSIDE_WINDOW_MS = Date.parse("2026-10-05T12:00:00.000Z");
const NEXT_ALLOWED_AT = "2026-10-06T01:00:00.000Z";

// Real A4 runtime + real Web adapter over programmatic fixtures (no fake gate):
// the request path below runs the production evaluator, not a stub.
async function startWindowedApp(stateName) {
  const clock = fakeClock(OUTSIDE_WINDOW_MS);
  const policy = policyFixture({ subjects: [`oauth-user:user-${stateName}`] });
  const store = fakeStore({ snapshot: snapshotFixture({ policies: [policy] }) });
  const runtime = createAccessPolicyRuntime({ enabled: true, store, now: () => clock.now() });
  await runtime.ready;
  return { app: await startAuthedApp(stateName, runtime), clock, policy };
}

function assertOutsideWindowDeny(body, policy) {
  assert.deepEqual(Object.keys(body).sort(), ["error", "mode", "nextAllowedAt", "policyId"]);
  assert.equal(body.error, "outside_authorized_window");
  assert.equal(body.mode, "suspend");
  assert.equal(body.policyId, policy.id);
  assert.equal(body.nextAllowedAt, NEXT_ALLOWED_AT);
}

const getTags = (app, query = "") => boundedFetch(`${app.base}/api/web/v1/tags${query}`, { headers: { Cookie: app.cookie } });

test.before(async () => {
  await ensureCatalog();
});

test("tags without a session is 401 and never reaches the catalog", async () => {
  const app = await startAuthedApp("anon");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/tags`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Login required" });
  } finally {
    await app.close();
  }
});

test("tags default to count desc with a tag ASC tie-break and the canonical projection text", async () => {
  const app = await startAuthedApp("default");
  try {
    const response = await getTags(app);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.vaultId, defaultWebVaultId());
    // Lowercased, no leading `#`, `/` hierarchy preserved — exactly the note_tags text.
    assert.deepEqual(body.tags, [
      { tag: "alpha", count: 3 },
      { tag: "beta", count: 2 },
      { tag: "a/b", count: 1 },
      { tag: "a/b/c", count: 1 },
      { tag: "运维", count: 1 },
    ]);
    assert.equal(body.total, 5);
    assert.equal(body.truncated, false);
    assert.equal(body.tags.some((item) => item.tag.startsWith("#")), false, "canonical tag text never carries #");
  } finally {
    await app.close();
  }
});

test("sort=name orders by tag text and respects direction; count keeps the name tie-break", async () => {
  const app = await startAuthedApp("sort");
  try {
    const byName = await (await getTags(app, "?sort=name&direction=asc")).json();
    assert.deepEqual(byName.tags.map((item) => item.tag), ["a/b", "a/b/c", "alpha", "beta", "运维"]);
    const byNameDesc = await (await getTags(app, "?sort=name&direction=desc")).json();
    assert.deepEqual(byNameDesc.tags.map((item) => item.tag), [...byName.tags.map((item) => item.tag)].reverse());
    const countAsc = await (await getTags(app, "?sort=count&direction=asc")).json();
    assert.deepEqual(countAsc.tags.map((item) => item.tag), ["a/b", "a/b/c", "运维", "beta", "alpha"]);
  } finally {
    await app.close();
  }
});

test("limit bounds the page, reports total/truncated and stays deterministic", async () => {
  const app = await startAuthedApp("limit");
  try {
    const response = await getTags(app, "?limit=2");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.tags, [{ tag: "alpha", count: 3 }, { tag: "beta", count: 2 }]);
    assert.equal(body.total, 5);
    assert.equal(body.truncated, true);

    const first = await getTags(app, "?sort=count&direction=desc&limit=500");
    const second = await getTags(app, "?sort=count&direction=desc&limit=500");
    assert.equal(await first.text(), await second.text(), "repeated identical requests are byte-identical");

    // Same count, different limits: both prefixes must agree.
    const wide = await (await getTags(app, "?limit=500")).json();
    assert.deepEqual(wide.tags.slice(0, 2), body.tags);
  } finally {
    await app.close();
  }
});

test("invalid sort, direction and limit are deterministic 400s and never clamped", async () => {
  const app = await startAuthedApp("invalid");
  try {
    const cases = [
      ["?sort=bogus", "invalid-sort"],
      ["?sort=count&direction=sideways", "invalid-direction"],
      ["?sort=bogus&direction=bogus", "invalid-sort"],
      ["?limit=0", "invalid-limit"],
      ["?limit=501", "invalid-limit"],
      ["?limit=1.5", "invalid-limit"],
      ["?limit=abc", "invalid-limit"],
      ["?limit=-1", "invalid-limit"],
    ];
    for (const [query, code] of cases) {
      const response = await getTags(app, query);
      assert.equal(response.status, 400, `expected 400 for ${query}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: code }, `expected ${code} for ${query}`);
    }
    // Boundaries are accepted.
    assert.equal((await getTags(app, "?limit=1")).status, 200);
    assert.equal((await getTags(app, "?limit=500")).status, 200);
  } finally {
    await app.close();
  }
});

test("an outside-window session is a 403 outside_authorized_window before any catalog access", async (t) => {
  const { app, clock, policy } = await startWindowedApp("gate");
  const { store } = await ensureCatalog();
  const listTagsSpy = t.mock.method(store, "listTags");
  const metaGetSpy = t.mock.method(store, "metaGet");
  const originals = { readdir: fs.readdir, readFile: fs.readFile };
  const reads = { readdir: [], readFile: [] };
  t.mock.method(fs, "readdir", async (...args) => { reads.readdir.push(String(args[0])); return originals.readdir(...args); });
  t.mock.method(fs, "readFile", async (...args) => { reads.readFile.push(String(args[0])); return originals.readFile(...args); });
  try {
    const denied = await getTags(app);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assertOutsideWindowDeny(await denied.json(), policy);
    // Gate-before-content: the deny short-circuits before any catalog query or Vault scan.
    assert.deepEqual({ listTags: listTagsSpy.mock.callCount(), metaGet: metaGetSpy.mock.callCount() }, { listTags: 0, metaGet: 0 });
    assert.deepEqual(reads, { readdir: [], readFile: [] });

    // Reverse control: the same policy and route allow inside the window.
    clock.set(INSIDE_WINDOW_MS);
    const allowed = await getTags(app);
    assert.equal(allowed.status, 200);
    assert.ok(listTagsSpy.mock.callCount() > 0, "the same request inside the window must reach the catalog");
  } finally {
    await app.close();
  }
});

test("tags never scans the Vault: no readdir and no Markdown fs.readFile", async (t) => {
  const app = await startAuthedApp("io");
  const originals = { readdir: fs.readdir, readFile: fs.readFile };
  const calls = { readdir: [], readFile: [] };
  t.mock.method(fs, "readdir", async (...args) => {
    calls.readdir.push(String(args[0]));
    return originals.readdir(...args);
  });
  t.mock.method(fs, "readFile", async (...args) => {
    calls.readFile.push(String(args[0]));
    return originals.readFile(...args);
  });
  try {
    const response = await getTags(app, "?sort=count&direction=desc");
    assert.equal(response.status, 200);
    assert.equal(calls.readdir.length, 0, `no recursive readdir, saw: ${calls.readdir.join(", ")}`);
    const markdownReads = calls.readFile.filter((candidate) => candidate.toLowerCase().endsWith(".md"));
    assert.deepEqual(markdownReads, [], `no Markdown fs.readFile, saw: ${markdownReads.join(", ")}`);
  } finally {
    await app.close();
  }
});

test("an out-of-allowlist Vault is 403 under the real error classifier and stays leak-free", async () => {
  const app = await startRoutedApp(async () => { throw new Error("Vault access denied"); }, "denied");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/tags`);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: "Vault access denied" });
    assert.equal(text.includes(root), false, "error body must not leak the absolute vault root");
  } finally {
    await app.close();
  }
});

test("an unreconciled catalog is 503 catalog-not-ready, not an empty tag list", async () => {
  const app = await startRoutedApp(async () => ({ id: `unready-${Date.now()}`, root: vault }), "unready");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/tags`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: "catalog-not-ready" });
    assert.equal(text.includes(root), false);
  } finally {
    await app.close();
  }
});

test("the tags route is read-only: POST has no handler", async () => {
  const app = await startAuthedApp("readonly");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/tags`, {
      method: "POST",
      headers: { Cookie: app.cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});
