// Frozen Web Base query-override contract (`sort` / `filter` / `q`) over the real
// production wiring: real Express router + real session login + real per-Vault Web
// Catalog + real HTTP + real MCP `query_base` for parity.
//
// Contract: D-PARITY-PLAN "冻结 API 契约".
//   - sort overrides the view sort; key outside the view column set -> 422 unsupported;
//     bad dir / bad JSON -> 400 invalid-sort;
//   - filter is AND-appended after base/view filters; unknown op / unknown key -> 422;
//     malformed structure -> 400 invalid-filter;
//   - q is a case-insensitive substring over the view's columns; bad type/length -> 400 invalid-query;
//   - the cursor binds sort/filter/q, so any change is 409 cursor-stale;
//   - multi-page Web concatenation equals the canonical/MCP output for the
//     equivalent declared sort/filter.
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

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-base-params-"));
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

function note(frontmatter) {
  const keys = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${keys}\n---\n# note\n`;
}

const ORDER = ["file.name", "status", "score", "title"];

function baseDoc({ name = "All", filters, viewFilters, sort, order = ORDER } = {}) {
  const lines = [];
  if (filters) lines.push(`filters: ${filters}`);
  lines.push("views:", "  - type: table", `    name: ${name}`);
  if (viewFilters) lines.push("    filters:", `      and:`, `        - ${viewFilters}`);
  if (sort) lines.push("    sort:", `      - property: ${sort.property}`, `        direction: ${sort.direction}`);
  lines.push(`    order: [${order.join(", ")}]`, "");
  return lines.join("\n");
}

async function writeFixtureVault() {
  const files = {
    "Parity/Alpha.md": note({ title: "香蕉", status: "active", score: 10, tags: "[paging]" }),
    "Parity/Beta.md": note({ title: "苹果", status: "done", score: 2, tags: "[paging]" }),
    "Parity/Gamma.md": note({ title: "Cherry", status: "active", score: 10, tags: "[paging]" }),
    "Parity/Delta.md": note({ title: "delta", status: "deferred", tags: "[paging]" }),
    "Parity/Epsilon.md": note({ title: "苹果派", status: "active", score: 7, tags: "[paging]" }),
    "Parity/Zeta.md": note({ status: "done", score: 3, tags: "[paging]" }),
    "Parity/Eta.md": note({ title: "2026", status: "active", score: 1, tags: "[paging]" }),
    "Parity/Theta.md": note({ title: "苹果", status: "done", score: 10, tags: "[paging]" }),
    "Parity/Iota.md": note({ title: "iota", status: "active", score: 5, tags: "[paging]" }),
    "Parity/Kappa.md": note({ title: "kappa", status: "active", score: 5, tags: "[paging]" }),
    "Parity/Lambda.md": note({ title: "lambda", status: "", tags: "[paging]" }),
    "Parity/Mu.md": note({ title: "mu", status: "active", score: 9, tags: "[paging]" }),

    "P.base": baseDoc({ filters: 'file.inFolder("Parity")' }),
    "PTags.base": baseDoc({ filters: 'file.inFolder("Parity")', order: ["file.name", "tags"] }),
    "PNameAsc.base": baseDoc({ filters: 'file.inFolder("Parity")', sort: { property: "file.name", direction: "ASC" } }),
    "PNameDesc.base": baseDoc({ filters: 'file.inFolder("Parity")', sort: { property: "file.name", direction: "DESC" } }),
    "PTitleDesc.base": baseDoc({ filters: 'file.inFolder("Parity")', sort: { property: "title", direction: "DESC" } }),
    "PScoreDesc.base": baseDoc({ filters: 'file.inFolder("Parity")', sort: { property: "score", direction: "DESC" } }),
    "PActiveScoreAsc.base": baseDoc({
      filters: 'file.inFolder("Parity")',
      viewFilters: 'status == "active"',
      sort: { property: "score", direction: "ASC" },
    }),
    "PLink.base": [
      'filters: file.inFolder("Parity")',
      "formulas:",
      "  note: file.asLink(title)",
      "properties:",
      "  formula.note:",
      "    displayName: Note",
      "views:",
      "  - type: table",
      "    name: Linked",
      "    order: [formula.note, file.name]",
      "",
    ].join("\n"),
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(vault, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
}

await fs.mkdir(data, { recursive: true });
await writeFixtureVault();

const [
  { createWebAppRouter },
  { defaultWebVaultId, resolveWebVault },
  { getWebCatalogRuntime, __resetWebCatalogRuntimesForTests },
  { registerWorkflowTools },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
  import("../src/tools/workflows.js"),
]);

const HTTP_TIMEOUT_MS = 10_000;
const boundedFetch = (url, options = {}) =>
  fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS) });

async function closeHttpServer(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out closing server")), HTTP_TIMEOUT_MS)),
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
  return { base, cookie, close: () => closeHttpServer(server) };
}

let app = null;

// Builds `?path=...` plus the frozen override params (JSON-encoded).
function buildQuery(basePath, { view, limit, cursor, sort, filter, q } = {}) {
  const params = new URLSearchParams();
  params.set("path", basePath);
  if (view) params.set("view", view);
  if (limit !== undefined) params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  if (sort !== undefined) params.set("sort", typeof sort === "string" ? sort : JSON.stringify(sort));
  if (filter !== undefined) params.set("filter", typeof filter === "string" ? filter : JSON.stringify(filter));
  if (q !== undefined) params.set("q", q);
  return `?${params}`;
}

async function getBase(query) {
  return boundedFetch(`${app.base}/api/web/v1/base${query}`, { headers: { Cookie: app.cookie } });
}

async function getBaseJson(options, { expectedStatus = 200 } = {}) {
  const response = await getBase(buildQuery(options.path, options));
  assert.equal(response.status, expectedStatus, `expected ${expectedStatus} for ${JSON.stringify(options)}`);
  return response.json();
}

async function collectPages({ path: basePath, sort, filter, q, pageSize = 2 }) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  let totalMatched = null;
  do {
    const body = await getBaseJson({ path: basePath, sort, filter, q, limit: pageSize, cursor });
    if (totalMatched === null) totalMatched = body.totalMatched;
    else assert.equal(body.totalMatched, totalMatched, "totalMatched is stable across pages");
    rows.push(...body.rows);
    cursor = body.nextCursor;
    pages += 1;
    assert.ok(pages <= 50, `pagination must terminate for ${basePath}`);
  } while (cursor);
  return { rows, totalMatched, pages };
}

let mcpServer = null;
let mcpClient = null;

test.before(async () => {
  await ensureCatalog();
  app = await startAuthedApp("params");
  mcpServer = new McpServer({ name: "web-base-params", version: "1" });
  registerWorkflowTools(mcpServer);
  mcpClient = new Client({ name: "web-base-params-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  await mcpClient.connect(clientTransport);
});

test.after(async () => {
  if (app) await app.close();
  if (mcpClient) await mcpClient.close();
  if (mcpServer) await mcpServer.close();
  __resetWebCatalogRuntimesForTests();
  await fs.rm(root, { recursive: true, force: true });
});

async function mcpPaths(basePath) {
  const mcp = await mcpClient.callTool({ name: "query_base", arguments: { path: basePath } });
  assert.equal(mcp.isError, undefined, mcp.content?.[0]?.text);
  const body = JSON.parse(mcp.content[0].text);
  return { paths: body.rows.map((row) => row.path), totalMatched: body.totalMatched };
}

// ── Positive: sort ──────────────────────────────────────────────────────────
test("sort asc/desc overrides the view sort and agrees with the canonical order", async () => {
  const asc = await getBaseJson({ path: "P.base", sort: [{ key: "file.name", dir: "asc" }] });
  assert.deepEqual(asc.rows.map((row) => row.path), (await mcpPaths("PNameAsc.base")).paths);

  const desc = await getBaseJson({ path: "P.base", sort: [{ key: "file.name", dir: "desc" }] });
  assert.deepEqual(desc.rows.map((row) => row.path), (await mcpPaths("PNameDesc.base")).paths);

  // An override replaces the view's own sort rather than appending to it.
  const overridden = await getBaseJson({ path: "PNameAsc.base", sort: [{ key: "score", dir: "desc" }] });
  assert.deepEqual(overridden.rows.map((row) => row.path), (await mcpPaths("PScoreDesc.base")).paths);
});

test("sort handles Chinese values and missing values with a stable path tie-break", async () => {
  const desc = await getBaseJson({ path: "P.base", sort: [{ key: "title", dir: "desc" }] });
  assert.deepEqual(desc.rows.map((row) => row.path), (await mcpPaths("PTitleDesc.base")).paths);

  const asc = await getBaseJson({ path: "P.base", sort: [{ key: "score", dir: "asc" }] });
  const scores = asc.rows.map((row) => row.values.score);
  const present = scores.filter((value) => value !== null && value !== undefined);
  assert.deepEqual(present, [...present].sort((a, b) => a - b), "ascending numeric order");
  // Missing values sort last; ties keep the canonical path tie-break.
  const firstMissing = scores.findIndex((value) => value === null || value === undefined);
  assert.ok(firstMissing === -1 || firstMissing === present.length, "missing values are last");
  const ten = asc.rows.filter((row) => row.values.score === 10).map((row) => row.path);
  assert.deepEqual(ten, [...ten].sort(), "score tie-break is the path");
});

test("multi-column sort structure is accepted and follows declaration order", async () => {
  const multi = await getBaseJson({ path: "P.base", sort: [{ key: "score", dir: "desc" }, { key: "file.name", dir: "asc" }] });
  const [first, second] = multi.rows.map((row) => row.path);
  assert.equal(first, "Parity/Alpha.md");
  assert.equal(second, "Parity/Gamma.md");
});

// ── Positive: filter / q / combination ──────────────────────────────────────
test("filter operators and AND combinations narrow the result", async () => {
  const active = await getBaseJson({ path: "P.base", filter: [{ key: "status", op: "is", value: "active" }] });
  const expected = (await mcpPaths("PActiveScoreAsc.base")).totalMatched;
  assert.equal(active.totalMatched, expected);

  const combined = await getBaseJson({
    path: "P.base",
    filter: [
      { key: "title", op: "contains", value: "苹果" },
      { key: "status", op: "is-not", value: "active" },
      { key: "score", op: "gte", value: 10 },
    ],
  });
  assert.deepEqual(combined.rows.map((row) => row.path), ["Parity/Theta.md"]);

  const empty = await getBaseJson({ path: "P.base", filter: [{ key: "status", op: "is-empty", value: null }] });
  assert.deepEqual(empty.rows.map((row) => row.path), ["Parity/Lambda.md"]);

  for (const op of ["contains", "starts-with", "ends-with"]) {
    const body = await getBaseJson({ path: "P.base", filter: [{ key: "title", op, value: "苹果" }] });
    assert.ok(body.totalMatched >= 1, op);
  }
});

test("q matches across the view columns, case-insensitively, and is scoped to them", async () => {
  const chinese = await getBaseJson({ path: "P.base", q: "苹果" });
  assert.deepEqual(chinese.rows.map((row) => row.path).sort(), ["Parity/Beta.md", "Parity/Epsilon.md", "Parity/Theta.md"]);

  const upper = await getBaseJson({ path: "P.base", q: "CHERRY" });
  assert.deepEqual(upper.rows.map((row) => row.path), ["Parity/Gamma.md"]);

  const statusMatch = await getBaseJson({ path: "P.base", q: "active" });
  assert.equal(statusMatch.totalMatched, 7, "the 7 active notes, matched through the status column");

  // `tags` is a column of PTags.base and is searchable there...
  const tagged = await getBaseJson({ path: "PTags.base", q: "paging" });
  assert.equal(tagged.totalMatched, 12);
  // ...but not of P.base, so the same needle matches nothing there.
  const scoped = await getBaseJson({ path: "P.base", q: "paging" });
  assert.equal(scoped.totalMatched, 0);
});

test("sort + filter + q combine and paginate in a stable order", async () => {
  const options = {
    path: "P.base",
    sort: [{ key: "score", dir: "asc" }],
    filter: [{ key: "status", op: "is", value: "active" }],
    q: "a",
  };
  const paged = await collectPages({ ...options, pageSize: 2 });
  const single = await getBaseJson({ ...options, limit: 500 });
  assert.deepEqual(paged.rows, single.rows);
  assert.equal(paged.totalMatched, single.totalMatched);
  assert.ok(paged.pages > 1);
});

test("q and filter reach structured asLink displayName/path cells", async () => {
  const byText = await getBaseJson({ path: "PLink.base", q: "苹果" });
  assert.deepEqual(byText.rows.map((row) => row.path).sort(), ["Parity/Beta.md", "Parity/Epsilon.md", "Parity/Theta.md"]);

  // A record without `title` falls back to its basename as the link displayName.
  const fallback = await getBaseJson({ path: "PLink.base", q: "zeta" });
  assert.deepEqual(fallback.rows.map((row) => row.path), ["Parity/Zeta.md"]);

  const byFilter = await getBaseJson({ path: "PLink.base", filter: [{ key: "formula.note", op: "contains", value: "苹果" }] });
  assert.deepEqual(byFilter.rows.map((row) => row.path).sort(), ["Parity/Beta.md", "Parity/Epsilon.md", "Parity/Theta.md"]);

  // Sorting by a formula column reuses the canonical comparator: equal
  // displayNames keep the path tie-break.
  const sorted = await getBaseJson({ path: "PLink.base", sort: [{ key: "formula.note", dir: "asc" }] });
  const appleTies = sorted.rows
    .filter((row) => row.values["formula.note"].displayName === "苹果")
    .map((row) => row.path);
  assert.deepEqual(appleTies, ["Parity/Beta.md", "Parity/Theta.md"]);
  assert.equal(sorted.totalMatched, 12);
});

// ── MCP / canonical zero drift ──────────────────────────────────────────────
test("multi-page Web concatenation equals canonical/MCP output for the equivalent sort+filter", async () => {
  const paged = await collectPages({
    path: "P.base",
    pageSize: 2,
    sort: [{ key: "score", dir: "asc" }],
    filter: [{ key: "status", op: "is", value: "active" }],
  });
  const mcp = await mcpPaths("PActiveScoreAsc.base");
  assert.deepEqual(paged.rows.map((row) => row.path), mcp.paths);
  assert.equal(paged.totalMatched, mcp.totalMatched);
});

test("MCP query_base output is unchanged when no overrides are supplied", async () => {
  const baseline = await mcpPaths("P.base");
  // The same Base through the Web API without overrides yields the identical rows.
  const web = await getBaseJson({ path: "P.base", limit: 500 });
  assert.deepEqual(web.rows.map((row) => row.path), baseline.paths);
  assert.equal(web.totalMatched, baseline.totalMatched);
});

// ── Failure boundaries (fail closed, validated before any Vault/catalog IO) ──
test("bad sort parameters are 400 invalid-sort", async () => {
  const cases = [
    { path: "P.base", sort: "{not json" },
    { path: "P.base", sort: '{"key":"score"}' },
    { path: "P.base", sort: [null] },
    { path: "P.base", sort: [{ dir: "asc" }] },
    { path: "P.base", sort: [{ key: "" }] },
    { path: "P.base", sort: [{ key: "score", dir: "up" }] },
    { path: "P.base", sort: [{ key: "score", dir: 1 }] },
  ];
  for (const options of cases) {
    const body = await getBaseJson(options, { expectedStatus: 400 });
    assert.equal(body.error, "invalid-sort", JSON.stringify(options));
  }
});

test("bad filter parameters are 400 invalid-filter", async () => {
  const cases = [
    { path: "P.base", filter: "{not json" },
    { path: "P.base", filter: '{"key":"status","op":"is","value":"active"}' },
    { path: "P.base", filter: [null] },
    { path: "P.base", filter: [{ op: "is", value: "active" }] },
    { path: "P.base", filter: [{ key: "status", value: "active" }] },
    { path: "P.base", filter: [{ key: "status", op: "" }] },
  ];
  for (const options of cases) {
    const body = await getBaseJson(options, { expectedStatus: 400 });
    assert.equal(body.error, "invalid-filter", JSON.stringify(options));
  }
});

test("an unsupported op or a key outside the column set is 422 unsupported", async () => {
  const cases = [
    { path: "P.base", filter: [{ key: "status", op: "like", value: "a" }] },
    { path: "P.base", filter: [{ key: "priority", op: "is", value: "P1" }] },
    { path: "P.base", filter: { or: [{ key: "priority", op: "is", value: "P1" }] } },
    { path: "P.base", sort: [{ key: "priority", dir: "asc" }] },
  ];
  for (const options of cases) {
    const body = await getBaseJson(options, { expectedStatus: 422 });
    assert.equal(body.error, "unsupported", JSON.stringify(options));
  }
});

test("an invalid q is 400 invalid-query", async () => {
  const tooLong = await getBaseJson({ path: "P.base", q: "x".repeat(257) }, { expectedStatus: 400 });
  assert.equal(tooLong.error, "invalid-query");
  const max = await getBase(`?path=P.base&q=${"x".repeat(256)}`);
  assert.equal(max.status, 200, "256 chars is the inclusive ceiling");

  // A repeated parameter arrives as an array, which is not a single string.
  const response = await getBase("?path=P.base&q=a&q=b");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid-query");
});

test("parameter validation runs before Vault/catalog access", async () => {
  // Missing.base would be a 404 if the reader ran; the malformed sort must win.
  const body = await getBaseJson({ path: "Missing.base", sort: "{not json" }, { expectedStatus: 400 });
  assert.equal(body.error, "invalid-sort");
});

// ── Cursor identity binds sort/filter/q ─────────────────────────────────────
test("the cursor is stale when sort, filter or q changes", async () => {
  const sort = [{ key: "score", dir: "asc" }];
  const first = await getBaseJson({ path: "P.base", limit: 2, sort });
  assert.ok(first.nextCursor);

  // Equivalent but differently-written sort (dir omitted) is not stale.
  const same = await getBaseJson({ path: "P.base", limit: 2, sort: [{ key: "score" }], cursor: first.nextCursor });
  assert.equal(same.rows.length, 2);

  for (const changed of [
    { sort: [{ key: "score", dir: "desc" }] },
    { sort: [{ key: "file.name", dir: "asc" }] },
    { filter: [{ key: "status", op: "is", value: "active" }] },
    { q: "alpha", sort },
    { sort: undefined },
  ]) {
    const body = await getBaseJson({ path: "P.base", limit: 2, sort, ...changed, cursor: first.nextCursor }, { expectedStatus: 409 });
    assert.equal(body.error, "cursor-stale", JSON.stringify(changed));
  }
});

test("a cursor minted with sort/filter/q is accepted on the next page", async () => {
  const options = {
    path: "P.base",
    limit: 2,
    sort: [{ key: "score", dir: "asc" }],
    filter: [{ key: "status", op: "is", value: "active" }],
    q: "a",
  };
  const first = await getBaseJson(options);
  assert.ok(first.nextCursor);
  const second = await getBaseJson({ ...options, cursor: first.nextCursor });
  assert.equal(second.rows.length, 2);
  assert.notDeepEqual(second.rows[0].path, first.rows[0].path);
});
