// HTTP contract tests for GET /api/web/v1/note-context/incoming (sidebar Phase 3).
//
// Real Express router + real login session + real per-Vault Web Catalog + real HTTP
// (no route mocks): auth/scope/path status mapping, `no-store`, the frozen DTO,
// source ordering + per-source dedupe, canonical resolver parity with the outgoing
// endpoint on the same fixture, repeat-request byte stability, and the I/O gate
// (no recursive readdir, no Markdown fs.readFile) that proves the answer is derived
// from the Catalog projections instead of a Vault scan.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-note-context-incoming-"));
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

const TARGET_BODY = "# Target\n\nSelf: [[Target]]\n";
const ALPHA_BODY = "[[Target]]\n[[Target|别名]]\n[Alpha md](Target.md#AlphaHeading)\n";
const BETA_BODY = "[Beta md](Target.md#Section)\n";
const GAMMA_BODY = "[[Target]]\n";
const DEEP_NOTE_BODY = "[[Target]]\n";

const BULK_SOURCES = 201;
const bulkPath = (index) => `Bulk/S${String(index).padStart(3, "0")}.md`;

await fs.mkdir(path.join(vault, "Sub"), { recursive: true });
await fs.mkdir(path.join(vault, "Deep"), { recursive: true });
await fs.mkdir(path.join(vault, "Bulk"), { recursive: true });
await fs.writeFile(path.join(vault, "Target.md"), TARGET_BODY, "utf8");
await fs.writeFile(path.join(vault, "Alpha.md"), ALPHA_BODY, "utf8");
await fs.writeFile(path.join(vault, "Beta.md"), BETA_BODY, "utf8");
await fs.writeFile(path.join(vault, "Sub", "Gamma.md"), GAMMA_BODY, "utf8");
await fs.writeFile(path.join(vault, "Alias.md"), '---\naliases:\n  - TargetAlias\n---\n[[TargetAlias]]\n', "utf8");
await fs.writeFile(path.join(vault, "Unresolved.md"), "[[Missing]]\n", "utf8");
await fs.writeFile(path.join(vault, "External.md"), "[[https://example.com/x]]\n", "utf8");
// A same-directory sibling wins over the root note: Deep/Note.md must NOT be a
// backlink of Target.md, exactly like outgoing resolves it.
await fs.writeFile(path.join(vault, "Deep", "Target.md"), "# Deep target\n", "utf8");
await fs.writeFile(path.join(vault, "Deep", "Note.md"), DEEP_NOTE_BODY, "utf8");
await fs.writeFile(path.join(vault, "BulkTarget.md"), "# Bulk target\n", "utf8");
for (let index = 0; index < BULK_SOURCES; index += 1) {
  await fs.writeFile(path.join(vault, bulkPath(index)), "[[BulkTarget]]\n", "utf8");
}

const [
  { createWebAppRouter },
  { defaultWebVaultId, resolveWebVault },
  { getWebCatalogRuntime, __resetWebCatalogRuntimesForTests },
  { registerNoteContextRoute },
  { classifyWebApiError },
  { createAccessPolicyRuntime },
  { fakeClock, fakeStore, policyFixture, snapshotFixture },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
  import("../src/app/note-context.js"),
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
    timeoutId = setTimeout(() => reject(new Error("Timed out closing incoming test server")), HTTP_TIMEOUT_MS);
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

const getIncoming = (app, query) =>
  boundedFetch(`${app.base}/api/web/v1/note-context/incoming${query}`, { headers: { Cookie: app.cookie } });

const getOutgoing = (app, query) =>
  boundedFetch(`${app.base}/api/web/v1/note-context/outgoing${query}`, { headers: { Cookie: app.cookie } });

test.before(async () => {
  await ensureCatalog();
});

test("incoming without a session is 401 and never reaches the catalog", async () => {
  const app = await startAuthedApp("anon");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/note-context/incoming?path=Target.md`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Login required" });
  } finally {
    await app.close();
  }
});

test("incoming lists resolved sources in sourcePath order with per-source dedupe", async () => {
  const app = await startAuthedApp("links");
  try {
    const response = await getIncoming(app, "?path=Target.md");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();

    assert.equal(body.vaultId, defaultWebVaultId());
    assert.equal(body.path, "Target.md");
    assert.match(body.revision, /^sha256:[0-9a-f]{64}$/);
    assert.equal(body.truncated, false);

    // `Alpha.md` links Target twice (a wiki link and a Markdown link); the first
    // catalog target wins and one row per source is kept. `Beta.md` keeps the raw
    // Markdown target, so its heading is recoverable. `Deep/Note.md` resolves to its
    // same-directory sibling and `Alias.md` resolves to itself, so neither is a
    // backlink of Target.md.
    assert.deepEqual(body.links, [
      { sourcePath: "Alpha.md", target: "Target", alias: null, heading: null },
      { sourcePath: "Beta.md", target: "Target.md#Section", alias: null, heading: "Section" },
      { sourcePath: "Sub/Gamma.md", target: "Target", alias: null, heading: null },
      { sourcePath: "Target.md", target: "Target", alias: null, heading: null },
    ]);

    const noteResponse = await boundedFetch(`${app.base}/api/web/v1/note?path=Target.md`, {
      headers: { Cookie: app.cookie },
    });
    assert.equal(noteResponse.status, 200);
    assert.equal(body.revision, (await noteResponse.json()).revision, "revision must match the note API");

    const outgoingResponse = await getOutgoing(app, "?path=Target.md");
    assert.equal(outgoingResponse.status, 200);
    assert.equal(body.revision, (await outgoingResponse.json()).revision, "revision must match the outgoing API");
  } finally {
    await app.close();
  }
});

test("incoming resolution is the same canonical decision outgoing reports", async () => {
  const app = await startAuthedApp("parity");
  try {
    // Outgoing from the ambiguous/same-directory source: the resolver picks the
    // same-directory sibling, so it can never show up as a Target.md backlink.
    const deep = await getOutgoing(app, `?path=${encodeURIComponent("Deep/Note.md")}`);
    assert.equal(deep.status, 200);
    const deepBody = await deep.json();
    assert.deepEqual(deepBody.links, [
      { target: "Target", kind: "note", resolvedPath: "Deep/Target.md", alias: null, heading: null },
    ]);

    // Alias targets resolve to the alias owner, not to Target.md.
    const alias = await getOutgoing(app, "?path=Alias.md");
    assert.equal(alias.status, 200);
    assert.deepEqual((await alias.json()).links, [
      { target: "TargetAlias", kind: "note", resolvedPath: "Alias.md", alias: null, heading: null },
    ]);

    // A source that outgoing resolves to Target.md is exactly a backlink of it.
    const alpha = await getOutgoing(app, "?path=Alpha.md");
    const alphaBody = await alpha.json();
    assert.equal(alphaBody.links[0].resolvedPath, "Target.md");
    const incoming = await getIncoming(app, "?path=Target.md");
    const incomingBody = await incoming.json();
    assert.equal(incomingBody.links.some((link) => link.sourcePath === "Alpha.md"), true);
    assert.equal(incomingBody.links.some((link) => link.sourcePath === "Deep/Note.md"), false);
    assert.equal(incomingBody.links.some((link) => link.sourcePath === "Alias.md"), false);
    assert.equal(incomingBody.links.some((link) => link.sourcePath === "Unresolved.md"), false);
    assert.equal(incomingBody.links.some((link) => link.sourcePath === "External.md"), false);
  } finally {
    await app.close();
  }
});

test("repeated identical requests are byte-identical (stable order and dedupe)", async () => {
  const app = await startAuthedApp("stable");
  try {
    const first = await getIncoming(app, "?path=Target.md");
    const second = await getIncoming(app, "?path=Target.md");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(await first.text(), await second.text());
  } finally {
    await app.close();
  }
});

test("more than 200 sources are truncated by sourcePath and report truncated:true", async () => {
  const app = await startAuthedApp("truncated");
  try {
    const response = await getIncoming(app, "?path=BulkTarget.md");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.links.length, 200);
    assert.equal(body.truncated, true);
    assert.equal(body.links[0].sourcePath, bulkPath(0));
    assert.equal(body.links[199].sourcePath, bulkPath(199));
    assert.equal(body.links.some((link) => link.sourcePath === bulkPath(200)), false);
    const sorted = body.links.map((link) => link.sourcePath);
    assert.deepEqual(sorted, [...sorted].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  } finally {
    await app.close();
  }
});

test("an outside-window session is a 403 outside_authorized_window before any catalog access", async (t) => {
  const { app, clock, policy } = await startWindowedApp("gate");
  const { store } = await ensureCatalog();
  const spied = {
    metaGet: t.mock.method(store, "metaGet"),
    catalogId: t.mock.method(store, "catalogId"),
    locate: t.mock.method(store, "locate"),
    listDocumentMetadata: t.mock.method(store, "listDocumentMetadata"),
    readDocumentRecords: t.mock.method(store, "readDocumentRecords"),
  };
  const callCounts = () => Object.fromEntries(Object.entries(spied).map(([key, spy]) => [key, spy.mock.callCount()]));
  try {
    const denied = await getIncoming(app, "?path=Target.md");
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assertOutsideWindowDeny(await denied.json(), policy);
    // Gate-before-content: the deny short-circuits before any catalog access.
    assert.deepEqual(callCounts(), { metaGet: 0, catalogId: 0, locate: 0, listDocumentMetadata: 0, readDocumentRecords: 0 });

    // Reverse control: the same policy and route allow inside the window.
    clock.set(INSIDE_WINDOW_MS);
    const allowed = await getIncoming(app, "?path=Target.md");
    assert.equal(allowed.status, 200);
    assert.ok(callCounts().locate > 0, "the same request inside the window must reach the catalog");
  } finally {
    await app.close();
  }
});

test("incoming never scans the Vault: no readdir and no Markdown fs.readFile", async (t) => {
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
    const response = await getIncoming(app, "?path=Target.md");
    assert.equal(response.status, 200);
    assert.equal(calls.readdir.length, 0, `no recursive readdir, saw: ${calls.readdir.join(", ")}`);
    const markdownReads = calls.readFile.filter((candidate) => candidate.toLowerCase().endsWith(".md"));
    assert.deepEqual(markdownReads, [], `no Markdown fs.readFile, saw: ${markdownReads.join(", ")}`);
  } finally {
    await app.close();
  }
});

test("invalid, non-markdown, traversal and missing paths are a leak-free 404", async () => {
  const app = await startAuthedApp("paths");
  try {
    const cases = [
      `${app.base}/api/web/v1/note-context/incoming`,
      `${app.base}/api/web/v1/note-context/incoming?path=`,
      `${app.base}/api/web/v1/note-context/incoming?path=Deep%2FTarget.base`,
      `${app.base}/api/web/v1/note-context/incoming?path=..%2Foutside.md`,
      `${app.base}/api/web/v1/note-context/incoming?path=%2Fetc%2Fpasswd.md`,
      `${app.base}/api/web/v1/note-context/incoming?path=Nope.md`,
      `${app.base}/api/web/v1/note-context/incoming?path=.hidden%2Fsecret.md`,
    ];
    for (const url of cases) {
      const response = await boundedFetch(url, { headers: { Cookie: app.cookie } });
      assert.equal(response.status, 404, `expected 404 for ${url}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { error: "Not found" });
      assert.equal(text.includes(root), false, "error body must not leak the absolute vault root");
    }
  } finally {
    await app.close();
  }
});

test("an out-of-allowlist Vault is 403 under the real error classifier and stays leak-free", async () => {
  const app = express();
  app.use("/api/web/v1", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  registerNoteContextRoute(app, {
    requireApi: (req, _res, next) => { req.webSession = { userId: "u", allowedVaults: ["default"], vaultId: "default" }; next(); },
    currentVault: async () => { throw new Error("Vault access denied"); },
  });
  app.use("/api/web/v1", (error, _req, res, _next) => {
    const response = classifyWebApiError(error);
    res.status(response.status).json({ error: response.error });
  });
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const response = await boundedFetch(
      `http://127.0.0.1:${server.address().port}/api/web/v1/note-context/incoming?path=Target.md`,
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: "Vault access denied" });
    assert.equal(text.includes(root), false);
  } finally {
    await closeHttpServer(server);
  }
});

test("an unreconciled catalog is 503 catalog-not-ready, not an empty backlink list", async () => {
  // Same Vault root, different Vault id: its catalog file was never reconciled, so
  // "no backlinks" would be a lie and the route must fail closed.
  const app = express();
  registerNoteContextRoute(app, {
    requireApi: (_req, _res, next) => next(),
    currentVault: async () => ({ id: `unready-${Date.now()}`, root: vault }),
  });
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const response = await boundedFetch(
      `http://127.0.0.1:${server.address().port}/api/web/v1/note-context/incoming?path=Target.md`,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "catalog-not-ready" });
  } finally {
    await closeHttpServer(server);
  }
});

test("an incomplete catalog projection is 503 catalog-incomplete and never partial", async () => {
  const runtime = await ensureCatalog();
  const store = runtime.store;
  store.upsertNote({ path: "Fault/Injected.md", frontmatterFault: "simulated codec failure" });
  assert.equal(store.baseProjectionStatus().complete, false);
  const app = await startAuthedApp("incomplete");
  try {
    const response = await getIncoming(app, "?path=Target.md");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, { error: "catalog-incomplete" });
  } finally {
    await app.close();
    store.removePath("Fault/Injected.md");
    assert.equal(store.baseProjectionStatus().complete, true, "fault cleanup must self-heal");
  }
});

test("the incoming route is read-only: POST has no handler", async () => {
  const app = await startAuthedApp("readonly");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/note-context/incoming?path=Target.md`, {
      method: "POST",
      headers: { Cookie: app.cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});
