// Wave B / B3: real-router wiring tests for the Web Base API and Base page route.
//
// Real Express router + real session login + real per-Vault Web Catalog + real
// HTTP. The A3 route contract, A1 evaluator and A2 record source are exercised
// through `createWebAppRouter` (not a standalone helper mount), so this file is
// the production wiring gate for `GET /api/web/v1/base` and
// `GET /app/base/<encoded-document-route>`.
//
// Contract: TODO - Web 显示 Bases 视图 §4.2/§4.3/§6.2/§8/§9/§15.6/§15.9/§21,
// WB-05/WB-07.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeBaseFixtures } from "./helpers/base-fixtures.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-base-wiring-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
process.env.WEB_DEFAULT_VAULT = "default";
process.env.WEB_CATALOG_ENABLED = "true";
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");

await fs.mkdir(data, { recursive: true });
await writeBaseFixtures(vault);

const [
  { createWebAppRouter },
  { defaultWebVaultId, resolveWebVault },
  { getWebCatalogRuntime, __resetWebCatalogRuntimesForTests },
  { queryBaseSnapshot },
  { registerWorkflowTools },
  { getVaultIndex },
  { encodeDocumentRoute },
  { toBaseQueryRecords },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
  import("../src/base-query.js"),
  import("../src/tools/workflows.js"),
  import("../src/vault-index.js"),
  import("../src/publish/service.js"),
  import("../src/app/base-record-source.js"),
]);

const HTTP_TIMEOUT_MS = 5_000;
const boundedFetch = (url, options = {}) =>
  fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS) });

async function closeHttpServer(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out closing Web Base server")), HTTP_TIMEOUT_MS)),
  ]);
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
  return { base, cookie, user, close: () => closeHttpServer(server) };
}

const getBase = (app, query = "") =>
  boundedFetch(`${app.base}/api/web/v1/base${query}`, { headers: { Cookie: app.cookie } });

let mcpServer = null;
let mcpClient = null;

test.before(async () => {
  await ensureCatalog();
  mcpServer = new McpServer({ name: "web-base-wiring", version: "1" });
  registerWorkflowTools(mcpServer);
  mcpClient = new Client({ name: "web-base-wiring-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  await mcpClient.connect(clientTransport);
});

test.after(async () => {
  if (mcpClient) await mcpClient.close();
  if (mcpServer) await mcpServer.close();
  __resetWebCatalogRuntimesForTests();
  await fs.rm(root, { recursive: true, force: true });
});

test("toBaseQueryRecords maps catalog records into the frozen A1 record shape", () => {
  const [record] = toBaseQueryRecords([
    {
      path: "WB/One.md",
      basename: "One",
      frontmatter: { title: "One Title" },
      tags: ["work"],
      links: ["Two", "Three"],
      size: 42,
      created: "2026-09-01T00:00:00.000Z",
      modified: "2026-09-02T00:00:00.000Z",
      revision: "sha256:deadbeef",
    },
  ]);
  assert.deepEqual(record, {
    path: "WB/One.md",
    basename: "One",
    frontmatter: { title: "One Title" },
    tags: ["work"],
    links: [{ target: "Two" }, { target: "Three" }],
    stat: { size: 42, created: "2026-09-01T00:00:00.000Z", modified: "2026-09-02T00:00:00.000Z" },
  });
});

test("unauthenticated GET /api/web/v1/base is 401 before any catalog access", async () => {
  const app = await startAuthedApp("anon");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/base?path=Default.base`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Login required" });
  } finally {
    await app.close();
  }
});

test("GET /api/web/v1/base serves the §8 DTO from the real catalog", async () => {
  const app = await startAuthedApp("dto");
  try {
    const response = await getBase(app, "?path=Default.base");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const body = await response.json();

    assert.equal(body.vaultId, defaultWebVaultId());
    assert.equal(body.path, "Default.base");
    assert.equal(body.route, `/app/base/${encodeDocumentRoute(defaultWebVaultId(), "Default.base")}`);
    assert.match(body.revision, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(body.views, [
      { name: "First", type: "table" },
      { name: "Second", type: "table" },
    ]);
    assert.deepEqual(body.view, { name: "First", type: "table" });
    assert.deepEqual(body.columns.map((column) => column.key), ["file.name", "status"]);
    assert.equal(body.totalMatched, 12);
    assert.equal(body.truncated, false);
    assert.equal(body.nextCursor, null);
    assert.equal(body.supportedSubset, true);
    assert.deepEqual(body.capabilities, { editable: false, grouping: true, aggregation: false });
    assert.equal(typeof body.catalog.catalogId, "string");
    assert.ok(body.catalog.catalogId.length > 0);
    assert.equal(body.catalog.stale, false);
    assert.ok(Number.isInteger(body.catalog.generation));
    assert.equal(body.rows.length, 12);
    assert.ok(body.rows.every((row) => row.path.endsWith(".md") && typeof row.values === "object"));

    const secondView = await getBase(app, "?path=Default.base&view=Second");
    assert.equal(secondView.status, 200);
    const secondBody = await secondView.json();
    assert.deepEqual(secondBody.view, { name: "Second", type: "table" });
    assert.equal(secondBody.totalMatched, 12);
  } finally {
    await app.close();
  }
});

test("GET /api/web/v1/base maps bad params and bad paths to 400/404", async () => {
  const app = await startAuthedApp("errors");
  try {
    const cases = [
      ["?path=Default.base&limit=0", 400, "invalid-limit"],
      ["?path=Default.base&limit=501", 400, "invalid-limit"],
      ["?path=Default.base&limit=abc", 400, "invalid-limit"],
      ["?path=Default.base&offset=5", 400, "unsupported-parameter"],
      ["?path=Default.base&view=", 200, null],
      ["", 400, "invalid-path"],
      ["?path=Missing.base", 404, "base-not-found"],
      ["?path=WB/One.md", 404, "base-not-found"],
      ["?path=../secret.base", 404, "base-not-found"],
      ["?path=/abs/secret.base", 404, "base-not-found"],
      ["?path=Bad/InvalidYaml.base", 422, "invalid-yaml"],
      ["?path=Bad/UnsupportedFileProp.base", 422, "unsupported"],
      ["?path=NoViews.base&view=Nope", 404, "view-not-found"],
    ];
    for (const [query, status, code] of cases) {
      const response = await getBase(app, query);
      assert.equal(response.status, status, `status for ${query}`);
      if (code) assert.equal((await response.json()).error, code, `code for ${query}`);
    }
  } finally {
    await app.close();
  }
});

test("GET /api/web/v1/base fails closed when the session loses its Vault grant", async () => {
  const app = await startAuthedApp("denied");
  try {
    // Provider state is authoritative on every request. Revoking every Vault grant
    // invalidates the session (401) rather than falling back to the primary Vault.
    // The literal A3 403 branch is not reachable through createWebAppRouter because
    // resolveWebSession always self-heals vaultId into allowedVaults; it is covered
    // by A3's injected-dependency route test.
    app.user.allowedVaults = [];
    const response = await getBase(app, "?path=Default.base");
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Login required" });
  } finally {
    await app.close();
  }
});

test("GET /api/web/v1/base paginates and invalidates a cursor after a generation bump (409)", async () => {
  const app = await startAuthedApp("cursor");
  try {
    const first = await getBase(app, "?path=Default.base&limit=1");
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.rows.length, 1);
    assert.equal(firstBody.truncated, true);
    assert.ok(firstBody.nextCursor);

    const second = await getBase(app, `?path=Default.base&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.rows.length, 1);
    assert.notEqual(secondBody.rows[0].path, firstBody.rows[0].path, "page 2 must not repeat page 1");

    await ensureCatalog().then((runtime) => runtime.store.bumpGeneration());
    const stale = await getBase(app, `?path=Default.base&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "cursor-stale");

    const invalid = await getBase(app, "?path=Default.base&cursor=not-a-cursor");
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "cursor-invalid");
  } finally {
    await app.close();
  }
});

test("GET /api/web/v1/base is 503 catalog-incomplete with no rows when a projection fault exists", async () => {
  const runtime = await ensureCatalog();
  const store = runtime.store;
  store.upsertNote({ path: "Fault/Injected.md", frontmatterFault: "simulated codec failure" });
  assert.equal(store.baseProjectionStatus().complete, false);
  const app = await startAuthedApp("incomplete");
  try {
    const response = await getBase(app, "?path=Default.base");
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "catalog-incomplete");
    assert.equal(body.rows, undefined, "an incomplete projection must never return partial rows");
  } finally {
    await app.close();
    store.removePath("Fault/Injected.md");
    assert.equal(store.baseProjectionStatus().complete, true, "fault cleanup must self-heal");
  }
});

test("GET /api/web/v1/base never scans the Vault and reads only the target .base (WB-05)", async (t) => {
  const app = await startAuthedApp("io");
  const originals = { readdir: fs.readdir, readFile: fs.readFile, open: fs.open };
  const calls = { readdir: [], readFile: [], open: [] };
  t.mock.method(fs, "readdir", async (...args) => {
    calls.readdir.push(String(args[0]));
    return originals.readdir(...args);
  });
  t.mock.method(fs, "readFile", async (...args) => {
    calls.readFile.push(String(args[0]));
    return originals.readFile(...args);
  });
  t.mock.method(fs, "open", async (...args) => {
    calls.open.push(String(args[0]));
    return originals.open(...args);
  });
  try {
    const response = await getBase(app, "?path=Default.base");
    assert.equal(response.status, 200);
    assert.equal(calls.readdir.length, 0, `no recursive readdir, saw: ${calls.readdir.join(", ")}`);
    const markdownReads = calls.readFile.filter((candidate) => candidate.toLowerCase().endsWith(".md"));
    assert.deepEqual(markdownReads, [], `no Markdown fs.readFile, saw: ${markdownReads.join(", ")}`);
    const baseOpens = calls.open.filter((candidate) => candidate.toLowerCase().endsWith(".base"));
    assert.ok(baseOpens.length >= 1, "the target .base itself is read");
    assert.ok(baseOpens.every((candidate) => path.basename(candidate) === "Default.base"));
  } finally {
    await app.close();
  }
});

test("GET /app/base/<encoded> serves the workspace shell with initial-base-path and #base-host", async () => {
  const app = await startAuthedApp("page");
  try {
    const encoded = encodeDocumentRoute(defaultWebVaultId(), "Default.base");
    const response = await boundedFetch(`${app.base}/app/base/${encoded}`, { headers: { Cookie: app.cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /name="initial-base-path" content="Default\.base"/);
    assert.match(html, /id="base-host" hidden/);
    assert.match(html, /class="document workspace-leaf-content view-content"/);
    assert.match(html, /id="editor"/, "the Markdown editor shell is still present for note navigation");
    assert.doesNotMatch(html, /name="initial-note-path"/);
  } finally {
    await app.close();
  }
});

test("GET /app/base 404s for an unauthorized Vault, unknown path or invalid encoding", async () => {
  const app = await startAuthedApp("page-errors");
  try {
    const unauthorized = await boundedFetch(
      `${app.base}/app/base/${encodeDocumentRoute("other-vault", "Default.base")}`,
      { headers: { Cookie: app.cookie } },
    );
    assert.equal(unauthorized.status, 404);

    const missing = await boundedFetch(
      `${app.base}/app/base/${encodeDocumentRoute(defaultWebVaultId(), "Missing.base")}`,
      { headers: { Cookie: app.cookie } },
    );
    assert.equal(missing.status, 404);

    const notBase = await boundedFetch(
      `${app.base}/app/base/${encodeDocumentRoute(defaultWebVaultId(), "WB/One.md")}`,
      { headers: { Cookie: app.cookie } },
    );
    assert.equal(notBase.status, 404);

    const invalid = await boundedFetch(`${app.base}/app/base/Garbage`, { headers: { Cookie: app.cookie } });
    assert.equal(invalid.status, 404);

    const unauthenticated = await boundedFetch(`${app.base}/app/base/Garbage`, { redirect: "manual" });
    assert.equal(unauthenticated.status, 303, "page routes redirect anonymous visitors to login");
  } finally {
    await app.close();
  }
});

// Cross-source parity (contract §21): the same fixture queried through the Web
// catalog record source and through MCP `query_base` (vault-index records) must
// agree on totalMatched, ordered row paths and values (including structured asLink).
const PARITY_CASES = [
  { base: "Default.base" },
  { base: "Default.base", view: "Second" },
  { base: "Filters.base" },
  { base: "Logic.base" },
  { base: "Sort.base", view: "SortAsc" },
  { base: "Sort.base", view: "SortDesc" },
  { base: "TieBreak.base" },
  { base: "Formula.base" },
  { base: "Nested.base" },
  { base: "AsLinkName.base" },
  { base: "AsLinkProperty.base" },
];

test("Web catalog records and MCP query_base agree for the same fixture (Web↔MCP parity)", async () => {
  const app = await startAuthedApp("parity");
  try {
    for (const spec of PARITY_CASES) {
      const query = new URLSearchParams({ path: spec.base });
      if (spec.view) query.set("view", spec.view);
      const web = await getBase(app, `?${query}`);
      assert.equal(web.status, 200, `Web ${spec.base}${spec.view ? `/${spec.view}` : ""}`);
      const webBody = await web.json();

      const mcpArgs = { path: spec.base };
      if (spec.view) mcpArgs.view = spec.view;
      const mcp = await mcpClient.callTool({ name: "query_base", arguments: mcpArgs });
      assert.equal(mcp.isError, undefined, `MCP ${spec.base}: ${mcp.content?.[0]?.text}`);
      const mcpBody = JSON.parse(mcp.content[0].text);

      const label = `${spec.base}${spec.view ? `/${spec.view}` : ""}`;
      assert.equal(webBody.totalMatched, mcpBody.totalMatched, `${label}: totalMatched`);
      assert.equal(webBody.view.name, mcpBody.view, `${label}: view name`);
      assert.deepEqual(
        webBody.rows.map((row) => row.path),
        mcpBody.rows.map((row) => row.path),
        `${label}: ordered row paths`,
      );
      assert.deepEqual(webBody.rows, mcpBody.rows, `${label}: row values (incl. structured asLink)`);
    }
  } finally {
    await app.close();
  }
});

test("the Web page window matches MCP when both receive the same explicit limit", async () => {
  const app = await startAuthedApp("parity-limit");
  try {
    const web = await getBase(app, "?path=Limit.base&limit=2");
    assert.equal(web.status, 200);
    const webBody = await web.json();
    const mcp = await mcpClient.callTool({ name: "query_base", arguments: { path: "Limit.base", limit: 2 } });
    assert.equal(mcp.isError, undefined, mcp.content?.[0]?.text);
    const mcpBody = JSON.parse(mcp.content[0].text);
    assert.equal(webBody.totalMatched, mcpBody.totalMatched);
    assert.deepEqual(webBody.rows, mcpBody.rows);
    assert.equal(webBody.rows.length, 2);
  } finally {
    await app.close();
  }
});

// Guard against the Web catalog and the MCP vault-index drifting apart: the same
// fixture through A1 with each record source must produce identical snapshots.
test("A1 queryBaseSnapshot is identical for catalog and vault-index records", async () => {
  const vaultRecord = await resolveWebVault(defaultWebVaultId());
  const runtime = await ensureCatalog();
  const metadata = runtime.store.listDocumentMetadata();
  const catalogRecords = toBaseQueryRecords(
    runtime.store.readDocumentRecords(metadata.filter((row) => row.kind === "note").map((row) => row.path)),
  );
  const indexRecords = (await getVaultIndex()).records;
  assert.equal(catalogRecords.length, indexRecords.length, "same note membership");
  const raw = await fs.readFile(path.join(vault, "Formula.base"), "utf8");
  const fromCatalog = queryBaseSnapshot({ raw, records: catalogRecords });
  const fromIndex = queryBaseSnapshot({ raw, records: indexRecords });
  assert.deepEqual(fromCatalog.rows, fromIndex.rows);
  assert.equal(fromCatalog.totalMatched, fromIndex.totalMatched);
  assert.deepEqual(fromCatalog.columns, fromIndex.columns);
  assert.equal(vaultRecord.id, defaultWebVaultId());
});
