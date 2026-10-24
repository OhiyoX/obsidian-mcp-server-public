// Wave C: `view.limit` bounded-prefix pagination acceptance matrix.
//
// Contract: Web transport `limit` is a page window, never a Base view semantic
// override; pagination must not materialize the full result set. Real Express
// router + real session + real per-Vault Web Catalog + real HTTP, plus a unit
// spy on the B3 adapter that proves the exact `min(viewLimit, prefixNeeded)`
// fetch budget.
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

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-base-view-limit-"));
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

const NOTE_COUNT = 200;

function note(frontmatter, body = "") {
  const keys = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${keys}\n---\n${body}`;
}

function limitBase(limit, name = "V") {
  return [
    'filters: file.inFolder("Paging")',
    "views:",
    "  - type: table",
    `    name: ${name}`,
    limit ? `    limit: ${limit}` : null,
    "    order:",
    "      - file.name",
    "    sort:",
    "      - property: file.name",
    "        direction: ASC",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

// Always writes the literal `limit:` line, including invalid ones (fail-closed fixtures).
function rawLimitBase(limitLiteral, name = "V") {
  return [
    'filters: file.inFolder("Paging")',
    "views:",
    "  - type: table",
    `    name: ${name}`,
    `    limit: ${limitLiteral}`,
    "    order:",
    "      - file.name",
    "",
  ].join("\n");
}

async function writeFixtureVault() {
  const files = {};
  for (let index = 0; index < NOTE_COUNT; index += 1) {
    const name = `N${String(index).padStart(3, "0")}`;
    files[`Paging/${name}.md`] = note(
      { title: `Title ${name}`, type: "doc", status: index % 2 === 0 ? "active" : "done", tags: "[paging]" },
      `# ${name}\n`,
    );
  }
  files["Limit30.base"] = limitBase(30);
  files["Limit50.base"] = limitBase(50);
  files["Limit80.base"] = limitBase(80);
  files["Limit150.base"] = limitBase(150);
  files["Unlimited.base"] = limitBase(null);
  files["BadLimitFractional.base"] = rawLimitBase("150.5");
  files["BadLimitNegative.base"] = rawLimitBase("-5");
  files["BadLimitZero.base"] = rawLimitBase("0");
  files["BadLimitString.base"] = rawLimitBase('"150"');
  files["AsLinkLimit.base"] = [
    'filters: file.inFolder("Paging")',
    "formulas:",
    "  note: file.asLink(title)",
    "properties:",
    "  formula.note:",
    "    displayName: Note",
    "views:",
    "  - type: table",
    "    name: Linked",
    "    limit: 60",
    "    order:",
    "      - formula.note",
    "      - file.name",
    "    sort:",
    "      - property: file.name",
    "        direction: ASC",
    "",
  ].join("\n");
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
  { encodeBaseCursor },
  { registerWorkflowTools },
  { createBaseSnapshotEvaluator },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
  import("../src/app/base-cursor.js"),
  import("../src/tools/workflows.js"),
  import("../src/app/base-snapshot-adapter.js"),
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
  return { base, cookie, user, close: () => closeHttpServer(server) };
}

const getBase = (app, query = "") =>
  boundedFetch(`${app.base}/api/web/v1/base${query}`, { headers: { Cookie: app.cookie } });

async function getBaseJson(app, query) {
  const response = await getBase(app, query);
  assert.equal(response.status, 200, `expected 200 for ${query}`);
  return response.json();
}

// Follow `nextCursor` to exhaustion and concatenate the pages. Fails closed if the
// cursor chain never terminates (a bounded harness, not an unbounded wait).
async function collectPages(app, basePath, pageSize) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  let totalMatched = null;
  do {
    const query = new URLSearchParams({ path: basePath, limit: String(pageSize) });
    if (cursor) query.set("cursor", cursor);
    const body = await getBaseJson(app, `?${query}`);
    rows.push(...body.rows);
    totalMatched = body.totalMatched;
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
  mcpServer = new McpServer({ name: "web-base-view-limit", version: "1" });
  registerWorkflowTools(mcpServer);
  mcpClient = new Client({ name: "web-base-view-limit-client", version: "1" });
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

async function mcpSnapshot(basePath, extra = {}) {
  const mcp = await mcpClient.callTool({ name: "query_base", arguments: { path: basePath, ...extra } });
  assert.equal(mcp.isError, undefined, mcp.content?.[0]?.text);
  return JSON.parse(mcp.content[0].text);
}

// ── The adapter's fetch budget (spy) ────────────────────────────────────────
test("the B3 adapter fetches exactly min(viewLimit, prefixNeeded), never the full set", () => {
  const calls = [];
  const evaluate = (input) => {
    calls.push(input.limit);
    return {
      views: [{ name: "V", type: "table" }],
      view: "V",
      columns: [],
      rows: [],
      totalMatched: NOTE_COUNT,
      truncated: false,
      supportedSubset: true,
    };
  };
  const evaluateBaseSnapshot = createBaseSnapshotEvaluator(evaluate);
  const limited = 'filters: file.inFolder("Paging")\nviews:\n  - type: table\n    name: V\n    limit: 150\n    order: [file.name]\n';
  const unlimited = 'filters: file.inFolder("Paging")\nviews:\n  - type: table\n    name: V\n    order: [file.name]\n';
  const fractional = 'filters: file.inFolder("Paging")\nviews:\n  - type: table\n    name: V\n    limit: 150.5\n    order: [file.name]\n';
  const zero = 'filters: file.inFolder("Paging")\nviews:\n  - type: table\n    name: V\n    limit: 0\n    order: [file.name]\n';

  const result = evaluateBaseSnapshot({ raw: limited, viewName: null, records: [], limit: 100 });
  assert.equal(calls.at(-1), 100, "prefix below the view limit is unchanged");
  assert.equal(result.viewLimit, 150);
  assert.equal(result.view.name, "V");

  evaluateBaseSnapshot({ raw: limited, viewName: null, records: [], limit: 200 });
  assert.equal(calls.at(-1), 150, "prefix above the view limit is capped at viewLimit");

  evaluateBaseSnapshot({ raw: unlimited, viewName: null, records: [], limit: 200 });
  assert.equal(calls.at(-1), 200, "no view limit keeps the transport prefix");
  assert.equal(evaluateBaseSnapshot({ raw: unlimited, viewName: null, records: [], limit: 200 }).viewLimit, null);

  // Invalid view.limit fails closed in canonical validation before the fetch budget
  // is computed; it must never be silently treated as "no limit" (FIX-2).
  for (const raw of [fractional, zero]) {
    assert.throws(
      () => evaluateBaseSnapshot({ raw, viewName: null, records: [], limit: 200 }),
      (error) => error?.code === "invalid-schema" && /views\[0\]\.limit must be a positive integer/.test(error.message),
    );
  }
});

// ── Real HTTP / real Catalog acceptance matrix ──────────────────────────────
test("view.limit < pageSize returns only viewLimit rows and stops", async () => {
  const app = await startAuthedApp("lt");
  try {
    const body = await getBaseJson(app, "?path=Limit30.base");
    assert.equal(body.rows.length, 30, "default pageSize 100 must not exceed viewLimit 30");
    assert.equal(body.totalMatched, NOTE_COUNT, "totalMatched is the true match count");
    assert.equal(body.truncated, false);
    assert.equal(body.nextCursor, null);
  } finally {
    await app.close();
  }
});

test("view.limit == pageSize returns a single full page", async () => {
  const app = await startAuthedApp("eq");
  try {
    const body = await getBaseJson(app, "?path=Limit50.base&limit=50");
    assert.equal(body.rows.length, 50);
    assert.equal(body.totalMatched, NOTE_COUNT);
    assert.equal(body.truncated, false);
    assert.equal(body.nextCursor, null);
  } finally {
    await app.close();
  }
});

test("pageSize < view.limit < 2*pageSize pages 100 + 50 and stops at viewLimit", async () => {
  const app = await startAuthedApp("between");
  try {
    const page1 = await getBaseJson(app, "?path=Limit150.base&limit=100");
    assert.equal(page1.rows.length, 100);
    assert.equal(page1.totalMatched, NOTE_COUNT);
    assert.equal(page1.truncated, true);
    assert.ok(page1.nextCursor);

    const page2 = await getBaseJson(app, `?path=Limit150.base&limit=100&cursor=${encodeURIComponent(page1.nextCursor)}`);
    assert.equal(page2.rows.length, 50, "the second page stops at viewLimit, not at totalMatched");
    assert.equal(page2.truncated, false);
    assert.equal(page2.nextCursor, null);

    const paths = [...page1.rows, ...page2.rows].map((row) => row.path);
    assert.equal(paths.length, 150);
    assert.equal(new Set(paths).size, 150, "no duplicated rows across pages");
  } finally {
    await app.close();
  }
});

test("offset < view.limit truncates the tail page at viewLimit", async () => {
  const app = await startAuthedApp("tail");
  try {
    const page1 = await getBaseJson(app, "?path=Limit80.base&limit=50");
    assert.equal(page1.rows.length, 50);
    assert.equal(page1.truncated, true);
    const page2 = await getBaseJson(app, `?path=Limit80.base&limit=50&cursor=${encodeURIComponent(page1.nextCursor)}`);
    assert.equal(page2.rows.length, 30, "80 rows at pageSize 50 => 50 + 30");
    assert.equal(page2.truncated, false);
    assert.equal(page2.nextCursor, null);
  } finally {
    await app.close();
  }
});

test("offset == view.limit and offset > view.limit are empty pages with no cursor", async () => {
  const app = await startAuthedApp("past-end");
  try {
    const first = await getBaseJson(app, "?path=Limit80.base&limit=50");
    const identity = {
      catalogId: first.catalog.catalogId,
      generation: first.catalog.generation,
      path: first.path,
      revision: first.revision,
      view: first.view.name,
    };
    for (const offset of [80, 120]) {
      const cursor = encodeBaseCursor({ ...identity, offset });
      const body = await getBaseJson(app, `?path=Limit80.base&limit=50&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(body.rows.length, 0, `offset ${offset} must be empty`);
      assert.equal(body.nextCursor, null, `offset ${offset} has no further page`);
      assert.equal(body.truncated, false);
      assert.equal(body.totalMatched, NOTE_COUNT, "totalMatched still reports the real match count");
    }
  } finally {
    await app.close();
  }
});

test("no view limit keeps the existing Web pagination behavior unchanged", async () => {
  const app = await startAuthedApp("unlimited");
  try {
    const { rows, totalMatched, pages } = await collectPages(app, "Unlimited.base", 50);
    assert.equal(rows.length, NOTE_COUNT);
    assert.equal(totalMatched, NOTE_COUNT);
    assert.equal(pages, 4, "200 rows / 50 => 4 pages");
  } finally {
    await app.close();
  }
});

test("Web multi-page concatenation equals the MCP default output (order, paths, values, totalMatched)", async () => {
  const app = await startAuthedApp("parity");
  try {
    for (const [basePath, pageSize] of [
      ["Limit30.base", 25],
      ["Limit80.base", 30],
      ["Limit150.base", 100],
      ["Unlimited.base", 75],
      ["AsLinkLimit.base", 25],
    ]) {
      const web = await collectPages(app, basePath, pageSize);
      const mcp = await mcpSnapshot(basePath);
      assert.equal(web.totalMatched, mcp.totalMatched, `${basePath}: totalMatched`);
      assert.deepEqual(
        web.rows.map((row) => row.path),
        mcp.rows.map((row) => row.path),
        `${basePath}: ordered row paths`,
      );
      assert.deepEqual(web.rows, mcp.rows, `${basePath}: row values (incl. structured asLink)`);
    }
  } finally {
    await app.close();
  }
});

test("invalid view.limit fails closed on the real Web route (422 invalid-schema)", async () => {
  const app = await startAuthedApp("bad-limit");
  try {
    for (const basePath of ["BadLimitFractional.base", "BadLimitNegative.base", "BadLimitZero.base", "BadLimitString.base"]) {
      const response = await getBase(app, `?path=${basePath}`);
      assert.equal(response.status, 422, `${basePath}: status`);
      assert.deepEqual(await response.json(), { error: "invalid-schema" }, `${basePath}: code`);
    }
  } finally {
    await app.close();
  }
});

test("invalid view.limit produces the same canonical error for MCP and Web", async () => {
  const app = await startAuthedApp("parity-bad-limit");
  try {
    for (const basePath of ["BadLimitFractional.base", "BadLimitNegative.base", "BadLimitZero.base", "BadLimitString.base"]) {
      const web = await getBase(app, `?path=${basePath}`);
      assert.equal(web.status, 422, `${basePath}: Web status`);
      assert.deepEqual(await web.json(), { error: "invalid-schema" }, `${basePath}: Web code`);

      const mcp = await mcpClient.callTool({ name: "query_base", arguments: { path: basePath } });
      assert.equal(mcp.isError, true, `${basePath}: MCP must be an error`);
      assert.equal(
        mcp.content[0].text,
        "Error: Invalid Base: views[0].limit must be a positive integer",
        `${basePath}: MCP canonical message`,
      );
    }
  } finally {
    await app.close();
  }
});

test("structured asLink values survive pagination as typed cells", async () => {
  const app = await startAuthedApp("aslink");
  try {
    const { rows } = await collectPages(app, "AsLinkLimit.base", 25);
    assert.equal(rows.length, 60);
    const cell = rows[0].values["formula.note"];
    assert.ok(cell && typeof cell === "object", "formula.note must be a structured cell");
    assert.equal(cell.kind, "asLink");
    assert.equal(typeof cell.path, "string");
  } finally {
    await app.close();
  }
});

test("a view-limit page never scans the Vault or reads Markdown (I/O contract holds)", async (t) => {
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
    const page1 = await getBaseJson(app, "?path=Limit150.base&limit=50");
    await getBaseJson(app, `?path=Limit150.base&limit=50&cursor=${encodeURIComponent(page1.nextCursor)}`);
    assert.equal(calls.readdir.length, 0, `no recursive readdir, saw: ${calls.readdir.join(", ")}`);
    const markdownReads = calls.readFile.filter((candidate) => candidate.toLowerCase().endsWith(".md"));
    assert.deepEqual(markdownReads, [], `no Markdown fs.readFile, saw: ${markdownReads.join(", ")}`);
    const baseOpens = calls.open.filter((candidate) => candidate.toLowerCase().endsWith(".base"));
    assert.ok(baseOpens.length >= 1, "the target .base itself is read");
    assert.ok(baseOpens.every((candidate) => path.basename(candidate) === "Limit150.base"));
  } finally {
    await app.close();
  }
});
