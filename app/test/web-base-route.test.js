// HTTP contract tests for GET /api/web/v1/base (A3 HTTP contract).
//
// Real Express + real http.createServer with injected fake auth/records/evaluate,
// and the real root-scoped Base reader against a synthetic tmp vault. Verifies the
// frozen status mapping (§9), DTO (§8), cursor identity, no-store/security headers
// and the absence of any POST write path.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const [
  { registerBaseRoute },
  { readBaseInRoot },
  { BASE_ORDER_CONTRACT_VERSION, encodeBaseCursor },
] = await Promise.all([
  import("../src/app/base-route.js"),
  import("../src/app/base-reader.js"),
  import("../src/app/base-cursor.js"),
]);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-base-route-"));
const vaultDir = path.join(root, "vault");
const outside = path.join(root, "outside");
await fs.mkdir(path.join(vaultDir, "Folder"), { recursive: true });
await fs.mkdir(path.join(vaultDir, "Dir.base"), { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.writeFile(path.join(vaultDir, "Project.base"), "views:\n  - name: All\n");
await fs.writeFile(path.join(vaultDir, "Note.md"), "# note\n");
await fs.writeFile(path.join(outside, "secret.base"), "views: []\n");

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const HTTP_TIMEOUT_MS = 5_000;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// Mirrors routes.js `securityHeaders`, which createWebAppRouter applies to
// `/api/web/v1` in production. B3 wires this route inside that router; the test
// reproduces the same prefix middleware so the headers are asserted end-to-end.
function securityHeaders(_req, res, next) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  next();
}

// Only used when a symlink cannot be created on Windows without Developer Mode.
async function symlinkOrSkip(t, target, linkPath, type) {
  const attempts = process.platform === "win32" && type === "dir" ? ["dir", "junction"] : [type];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      await fs.symlink(target, linkPath, attempt);
      return true;
    } catch (error) {
      lastError = error;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) throw error;
    }
  }
  t.skip(`symlink privilege unavailable on Windows: ${lastError?.code}`);
  return false;
}

function makeEvaluate(options = {}) {
  const viewName = options.viewName ?? "All";
  const views = options.views ?? [
    { name: "All", type: "table" },
    { name: "Recent", type: "table" },
  ];
  const columns = options.columns ?? [{ key: "file.name", label: "Name", kind: "property" }];
  const total = options.total ?? 3;
  const rows = Array.from({ length: total }, (_, index) => ({
    path: `Notes/N${String(index).padStart(3, "0")}.md`,
    values: { "file.name": `N${index}` },
  }));
  const calls = [];
  const evaluate = async (input) => {
    calls.push(input);
    if (options.throwError) throw options.throwError;
    const resolvedView = views.find((view) => view.name === input.viewName) || { name: viewName, type: "table" };
    return {
      views,
      view: resolvedView,
      columns,
      rows: rows.slice(0, input.limit),
      totalMatched: rows.length,
      truncated: rows.length > input.limit,
      supportedSubset: options.supportedSubset ?? true,
    };
  };
  evaluate.calls = calls;
  evaluate.rows = rows;
  return evaluate;
}

function makeDeps(overrides = {}) {
  const catalog = overrides.catalog ?? { catalogId: "cat-1", generation: 3, stale: false };
  const deps = {
    requireApi(req, res, next) {
      if (req.get("x-test-auth") !== "ok") return res.status(401).json({ error: "Login required" });
      req.webSession = { allowedScopes: ["obsidian.read"] };
      next();
    },
    async currentVault(req) {
      const id = req.get("x-test-vault") || "primary";
      if (id === "denied") throw new Error("Vault access denied");
      return { id, root: vaultDir };
    },
    readBase: readBaseInRoot,
    async loadRecords({ vault, basePath }) {
      if (overrides.loadRecords) return overrides.loadRecords({ vault, basePath });
      return { records: overrides.records ?? [], catalog, complete: overrides.complete ?? true };
    },
    evaluateSnapshot: overrides.evaluate ?? makeEvaluate(),
  };
  if (overrides.parseBaseError) deps.parseBaseError = overrides.parseBaseError;
  deps.catalog = catalog;
  return deps;
}

async function startServer(deps, { security = true } = {}) {
  const app = express();
  if (security) app.use("/api/web/v1", securityHeaders);
  const router = express.Router();
  registerBaseRoute(router, deps);
  app.use(router);
  app.use((error, _req, res, _next) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Vault access denied") return res.status(403).json({ error: "Vault access denied" });
    res.status(500).json({ error: "Request failed" });
  });
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () =>
      new Promise((resolve) => {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function request(server, query = "", { method = "GET", vault = "primary", auth = "ok" } = {}) {
  return fetch(`${server.base}/api/web/v1/base${query}`, {
    method,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { "x-test-auth": auth, "x-test-vault": vault },
  });
}

test("unauthenticated requests are 401 before any Base access", async () => {
  const server = await startServer(makeDeps());
  try {
    const response = await request(server, "?path=Project.base", { auth: "no" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Login required");
  } finally {
    await server.close();
  }
});

test("a vault outside the account allowlist is 403 and never reads a Base", async () => {
  const server = await startServer(makeDeps());
  try {
    const response = await request(server, "?path=Project.base", { vault: "denied" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "Vault access denied");
  } finally {
    await server.close();
  }
});

test("path problems are 404 without leaking absolute paths", async () => {
  const server = await startServer(makeDeps());
  try {
    for (const bad of ["Missing.base", "Note.md", "Dir.base", "../outside/secret.base", "/etc/passwd.base", "C:/tmp/x.base"]) {
      const response = await request(server, `?path=${encodeURIComponent(bad)}`);
      assert.equal(response.status, 404, bad);
      const body = await response.json();
      assert.equal(body.error, "base-not-found", bad);
      assert.equal(JSON.stringify(body).includes(root), false, "no absolute fixture path in body");
    }
  } finally {
    await server.close();
  }
});

test("final and intermediate symlinks are 404", async (t) => {
  const finalLink = path.join(vaultDir, "Escape.base");
  const dirLink = path.join(vaultDir, "EscapeDir");
  const createdFinal = await symlinkOrSkip(t, path.join(outside, "secret.base"), finalLink, "file");
  const createdDir = await symlinkOrSkip(t, outside, dirLink, "dir");
  if (!createdFinal && !createdDir) return;
  const server = await startServer(makeDeps());
  try {
    if (createdFinal) {
      const response = await request(server, "?path=Escape.base");
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, "base-not-found");
    }
    if (createdDir) {
      const response = await request(server, "?path=EscapeDir/secret.base");
      assert.equal(response.status, 404);
    }
  } finally {
    await server.close();
  }
});

test("limit contract: default 100, only decimal integers 1..500", async () => {
  const evaluate = makeEvaluate({ total: 3 });
  const server = await startServer(makeDeps({ evaluate }));
  try {
    const ok = await request(server, "?path=Project.base");
    assert.equal(ok.status, 200);
    assert.equal(evaluate.calls.at(-1).limit, 100, "default limit is 100");

    for (const value of ["0", "-1", "1.5", "501", "NaN", "abc", " "]) {
      const response = await request(server, `?path=Project.base&limit=${encodeURIComponent(value)}`);
      assert.equal(response.status, 400, `limit=${value}`);
      assert.equal((await response.json()).error, "invalid-limit");
    }

    const max = await request(server, "?path=Project.base&limit=500");
    assert.equal(max.status, 200);
  } finally {
    await server.close();
  }
});

test("public pageNumber/offset parameters are rejected", async () => {
  const server = await startServer(makeDeps());
  try {
    for (const query of ["?path=Project.base&offset=10", "?path=Project.base&pageNumber=2"]) {
      const response = await request(server, query);
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error, "unsupported-parameter");
    }
  } finally {
    await server.close();
  }
});

test("a malformed cursor is 400 cursor-invalid", async () => {
  const server = await startServer(makeDeps());
  try {
    const response = await request(server, "?path=Project.base&cursor=not-a-cursor");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "cursor-invalid");
  } finally {
    await server.close();
  }
});

test("a stale cursor (generation or revision moved) is 409 cursor-stale", async () => {
  const deps = makeDeps({ evaluate: makeEvaluate({ total: 5 }) });
  const server = await startServer(deps);
  try {
    const first = await (await request(server, "?path=Project.base&limit=2")).json();
    assert.ok(first.nextCursor);

    deps.catalog.generation = 4;
    const stale = await request(server, `?path=Project.base&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "cursor-stale");

    // The same cursor is accepted again once the identity matches.
    deps.catalog.generation = 3;
    const fresh = await request(server, `?path=Project.base&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.equal(fresh.status, 200);
  } finally {
    await server.close();
  }
});

test("a cursor bound to another view/base revision is 409", async () => {
  const deps = makeDeps({ evaluate: makeEvaluate({ total: 5 }) });
  const server = await startServer(deps);
  try {
    const first = await (await request(server, "?path=Project.base&limit=2")).json();
    await fs.writeFile(path.join(vaultDir, "Project.base"), "views:\n  - name: All\n  - name: Changed\n");
    const stale = await request(server, `?path=Project.base&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "cursor-stale");
  } finally {
    await fs.writeFile(path.join(vaultDir, "Project.base"), "views:\n  - name: All\n");
    await server.close();
  }
});

test("Base semantics errors map to 422 and view-not-found to 404", async () => {
  for (const code of ["invalid-yaml", "invalid-schema", "unsupported"]) {
    const deps = makeDeps({
      evaluate: async () => {
        throw Object.assign(new Error(`base ${code} at /srv/private/vault/Project.base`), { code });
      },
    });
    const server = await startServer(deps);
    try {
      const response = await request(server, "?path=Project.base");
      assert.equal(response.status, 422, code);
      const body = await response.json();
      assert.equal(body.error, code);
      assert.equal(JSON.stringify(body).includes("/srv/private"), false);
    } finally {
      await server.close();
    }
  }

  const deps = makeDeps({
    evaluate: async () => {
      throw Object.assign(new Error("Base view not found: Nope"), { code: "view-not-found" });
    },
  });
  const server = await startServer(deps);
  try {
    const response = await request(server, "?path=Project.base&view=Nope");
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "view-not-found");
  } finally {
    await server.close();
  }
});

test("an optional parseBaseError hook maps provider errors", async () => {
  const deps = makeDeps({
    evaluate: async () => {
      throw Object.assign(new Error("plain provider error"), { baseCode: "invalid-base" });
    },
    parseBaseError: (error) => (error?.baseCode ? { status: 422, code: "invalid-base" } : null),
  });
  const server = await startServer(deps);
  try {
    const response = await request(server, "?path=Project.base");
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, "invalid-base");
  } finally {
    await server.close();
  }
});

test("an unsupportedSubset=false evaluation fails closed with 422", async () => {
  const server = await startServer(makeDeps({ evaluate: makeEvaluate({ supportedSubset: false }) }));
  try {
    const response = await request(server, "?path=Project.base");
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, "unsupported");
  } finally {
    await server.close();
  }
});

test("catalog-not-ready and an incomplete projection are 503", async () => {
  const notReady = await startServer(makeDeps({ loadRecords: () => ({ records: [], catalog: null, complete: true }) }));
  try {
    const response = await request(notReady, "?path=Project.base");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "catalog-not-ready");
  } finally {
    await notReady.close();
  }

  const incomplete = await startServer(makeDeps({ complete: false }));
  try {
    const response = await request(incomplete, "?path=Project.base");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "catalog-incomplete");
  } finally {
    await incomplete.close();
  }
});

test("a stale catalog still serves the snapshot with catalog.stale=true", async () => {
  const deps = makeDeps({ catalog: { catalogId: "cat-1", generation: 3, stale: true } });
  const server = await startServer(deps);
  try {
    const response = await request(server, "?path=Project.base");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.catalog.stale, true);
    assert.equal(body.truncated, false);
  } finally {
    await server.close();
  }
});

test("unknown IO is 500 with a generic body and no stack or path", async () => {
  const deps = makeDeps({
    loadRecords: () => {
      throw Object.assign(new Error("disk failure at /srv/private/data/catalog.sqlite"), { code: "EIO" });
    },
  });
  const server = await startServer(deps);
  try {
    const response = await request(server, "?path=Project.base");
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.equal(JSON.parse(text).error, "Request failed");
    assert.equal(text.includes("/srv/private"), false);
    assert.equal(text.includes("stack"), false);
    assert.equal(text.includes("catalog.sqlite"), false);
  } finally {
    await server.close();
  }
});

test("success DTO matches the frozen §8 contract", async () => {
  const evaluate = makeEvaluate({ total: 2 });
  const server = await startServer(makeDeps({ evaluate }));
  try {
    const response = await request(server, "?path=Project.base");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        "capabilities",
        "catalog",
        "columns",
        // U12: additive read-only projection of the two declared filter layers
        // (`所有视图` / `当前视图`). Shape pinned in web-bases-all-views-section.test.js.
        "filters",
        // lane desktop-re/panel-properties: additive property catalog (the desktop
        // Properties menu's full row set). Shape pinned in base-property-catalog.test.js.
        "propertyCatalog",
        "nextCursor",
        "path",
        "revision",
        "route",
        "rows",
        "supportedSubset",
        "totalMatched",
        "truncated",
        "view",
        "views",
        // lane desktop-re/panel-sort: additive projection of the SELECTED view's declared
        // `sort:` in the frozen override shape (`[{key, dir}]`), so the sort menu opens on
        // the document's own row. Shape pinned in web-bases-sort-seed.test.js.
        // lane desktop-re/bases-grouping: additive projection of the SELECTED view's
        // declared `groupBy` (`{property, direction} | null`), so the `分组依据` menu opens
        // on the document's own rule. Shape pinned in web-bases-grouping.test.js /
        // web-bases-grouping-seed assertions below.
        "viewGroupBy",
        "viewSort",
        "vaultId",
      ].sort(),
    );
    assert.equal(body.vaultId, "primary");
    assert.equal(body.path, "Project.base");
    assert.match(body.route, /^\/app\/base\/[A-Za-z0-9_-]+$/);
    assert.match(body.revision, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(body.views, [
      { name: "All", type: "table" },
      { name: "Recent", type: "table" },
    ]);
    assert.deepEqual(body.view, { name: "All", type: "table" });
    assert.deepEqual(body.columns, [{ key: "file.name", label: "Name", kind: "property" }]);
    assert.equal(body.rows.length, 2);
    assert.deepEqual(body.rows[0], { path: "Notes/N000.md", values: { "file.name": "N0" } });
    assert.equal(body.totalMatched, 2);
    assert.equal(body.truncated, false);
    assert.equal(body.nextCursor, null);
    assert.equal(body.supportedSubset, true);
    assert.deepEqual(body.capabilities, { editable: false, grouping: true, aggregation: false });
    // The mocked evaluator returns no summary: the route still emits the key with two
    // null layers, so a client never has to tell "absent" from "not supported".
    assert.deepEqual(body.filters, { base: null, view: null });
    assert.deepEqual(body.catalog, { catalogId: "cat-1", generation: 3, stale: false });
  } finally {
    await server.close();
  }
});

test("pagination windows the frozen evaluate signature and ends with nextCursor=null", async () => {
  const evaluate = makeEvaluate({ total: 5 });
  const server = await startServer(makeDeps({ evaluate }));
  try {
    const page1 = await (await request(server, "?path=Project.base&limit=2")).json();
    assert.equal(page1.rows.length, 2);
    assert.equal(page1.truncated, true);
    assert.ok(page1.nextCursor);
    assert.equal(evaluate.calls.at(-1).limit, 2, "first window evaluates offset+limit");

    const page2 = await (
      await request(server, `?path=Project.base&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`)
    ).json();
    assert.equal(page2.rows[0].path, "Notes/N002.md");
    assert.equal(page2.truncated, true);
    assert.equal(evaluate.calls.at(-1).limit, 4, "second window evaluates offset+limit");

    const page3 = await (
      await request(server, `?path=Project.base&limit=2&cursor=${encodeURIComponent(page2.nextCursor)}`)
    ).json();
    assert.equal(page3.rows.length, 1);
    assert.equal(page3.rows[0].path, "Notes/N004.md");
    assert.equal(page3.truncated, false);
    assert.equal(page3.nextCursor, null);
    assert.equal(page3.totalMatched, 5);
  } finally {
    await server.close();
  }
});

test("the response is no-store and carries the existing security headers", async () => {
  const deps = makeDeps();
  const server = await startServer(deps, { security: true });
  try {
    const response = await request(server, "?path=Project.base");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.ok(response.headers.get("content-security-policy"));
    assert.match(response.headers.get("content-type"), /application\/json/);
  } finally {
    await server.close();
  }
});

test("the Base route itself sets no-store even without the router middleware", async () => {
  const server = await startServer(makeDeps(), { security: false });
  try {
    const response = await request(server, "?path=Project.base");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await server.close();
  }
});

test("GET Base requires no write scope", async () => {
  const server = await startServer(makeDeps());
  try {
    const response = await request(server, "?path=Project.base");
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test("the grouping DTO is passed through, and stays absent when the domain omits it", async () => {
  // Cut-4 `groups` is an A1 field the route re-projects like `columns`/`rows`: the
  // kanban layout needs it, and a document without groupBy/summaries must keep the
  // pre-cut-4 DTO byte-identical (hence the conditional key).
  const groups = [
    { key: "active", keyType: "string", count: 2, rowPaths: ["Notes/N000.md", "Notes/N001.md"] },
    { key: null, keyType: "null", count: 1, rowPaths: ["Notes/N002.md"] },
  ];
  const plain = await startServer(makeDeps());
  try {
    const body = await (await request(plain, "?path=Project.base")).json();
    assert.equal("groups" in body, false, "no grouping declaration => no key at all");
  } finally {
    await plain.close();
  }
  const deps = makeDeps();
  const base = deps.evaluateSnapshot;
  deps.evaluateSnapshot = async (input) => ({ ...(await base(input)), groups });
  const server = await startServer(deps);
  try {
    const response = await request(server, "?path=Project.base");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.groups, groups);
    // The page window still slices `rows`; the partition is the domain's post-limit one.
    assert.equal(body.rows.length, 3);
  } finally {
    await server.close();
  }
});

test("there is no POST Base mutation route", async () => {
  const server = await startServer(makeDeps());
  try {
    const response = await request(server, "?path=Project.base", { method: "POST" });
    assert.equal(response.status, 404, "Express has no POST /api/web/v1/base handler");
    const text = await response.text();
    assert.match(text, /Cannot POST/i);
  } finally {
    await server.close();
  }
});
