// HTTP contract tests for GET /api/web/v1/note-context/unlinked (U2 desktop parity).
//
// Real Express router + real login session + real per-Vault Web Catalog + real HTTP
// (no route mocks). The desktop section is the Outgoing links pane's "Unlinked
// mentions": text IN the current note that matches another note's name or alias and
// is not already linked, one entry per matched line, one chip per candidate note.
//
// The I/O gate proves the answer is derived from the Catalog index: no recursive
// readdir and no Markdown fs.readFile on this path (the indexed text is read through
// the store's public `readIndexedNoteText()` accessor, never from the Vault filesystem
// and never through the test-only raw handle — see the P0 guard test).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-note-context-unlinked-"));
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

// `Target.md` is the subject: it links to Linked.md and to README.md, so those are
// already linked; it mentions Architecture / README / AliasWord in plain text.
const TARGET_BODY = [
  "---",
  "tags: [u2]",
  "---",
  "# Target",
  "",
  "Link to [[Linked]] and a plain Architecture mention.",
  "Architecture again.",
  "Alias mention: AliasWord.",
  "Plain README mention.",
  "Self mention: Target and [[README]].",
  "",
].join("\n");

await fs.mkdir(path.join(vault, "Sub"), { recursive: true });
await fs.writeFile(path.join(vault, "Target.md"), TARGET_BODY, "utf8");
await fs.writeFile(path.join(vault, "Linked.md"), "# Linked\n", "utf8");
await fs.writeFile(path.join(vault, "Architecture.md"), "# Architecture\n", "utf8");
await fs.writeFile(path.join(vault, "README.md"), "# README\n", "utf8");
await fs.writeFile(path.join(vault, "Sub", "README.md"), "# Sub README\n", "utf8");
await fs.writeFile(path.join(vault, "AliasNote.md"), "---\naliases:\n  - AliasWord\n---\n# Alias note\n", "utf8");
// A Windows-style CRLF note: line scanning must not drift its offsets.
await fs.writeFile(path.join(vault, "CrlfTarget.md"), "Line one\r\nArchitecture here\r\n", "utf8");
// Other notes mentioning Target must NOT appear: the section is outgoing, not backlinks.
await fs.writeFile(path.join(vault, "MentionsTarget.md"), "Plain Target mention.\n", "utf8");

const [
  { createWebAppRouter },
  { defaultWebVaultId, resolveWebVault },
  { getWebCatalogRuntime, __resetWebCatalogRuntimesForTests },
  { registerNoteContextRoute },
  { classifyWebApiError },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/app/web-catalog/runtime.js"),
  import("../src/app/note-context.js"),
  import("../src/app/web-api-error.js"),
]);

test.after(async () => {
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
    timeoutId = setTimeout(() => reject(new Error("Timed out closing unlinked test server")), HTTP_TIMEOUT_MS);
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

async function startAuthedApp(stateName, options = {}) {
  const user = {
    id: `user-${stateName}`,
    username: "owner",
    displayName: "Owner",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read"],
    allowedVaults: options.allowedVaults ?? [defaultWebVaultId()],
  };
  const provider = {
    authenticateOAuthUser: async (username, password) => (username === "owner" && password === "password" ? user : null),
    oauthUserSessionRecord: async (id) => (id === user.id ? user : null),
    recordAudit() {},
  };
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false, accessRuntime: options.accessRuntime }));
  if (options.classify) app.use(classifyWebApiError);
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

const getUnlinked = (app, query) =>
  boundedFetch(`${app.base}/api/web/v1/note-context/unlinked${query}`, { headers: { Cookie: app.cookie } });

test.before(async () => {
  await ensureCatalog();
});

test("unlinked without a session is 401 and never reaches the catalog", async () => {
  const app = await startAuthedApp("anon");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/note-context/unlinked?path=Target.md`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Login required" });
  } finally {
    await app.close();
  }
});

test("unlinked lists the current note's plain-text mentions of other notes", async () => {
  const app = await startAuthedApp("mentions");
  try {
    const response = await getUnlinked(app, "?path=Target.md");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();

    assert.equal(body.vaultId, defaultWebVaultId());
    assert.equal(body.path, "Target.md");
    assert.match(body.revision, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Array.isArray(body.mentions), true);
    assert.equal(body.truncated, false);

    // Frontmatter is stripped from the scan: body line 3 carries the plain
    // Architecture mention, line 4 another one, line 5 the alias, line 6 README.
    const byLine = new Map(body.mentions.map((entry) => [entry.line, entry]));
    assert.deepEqual([...byLine.keys()].sort((a, b) => a - b), [3, 4, 5, 6]);

    const architectureLine = byLine.get(3);
    assert.equal(architectureLine.excerpt, "Link to [[Linked]] and a plain Architecture mention.");
    const architectureAt = architectureLine.excerpt.indexOf("Architecture");
    assert.deepEqual(architectureLine.highlights, [{ start: architectureAt, end: architectureAt + "Architecture".length }]);
    assert.deepEqual(architectureLine.chips, [{ name: "Architecture", path: "Architecture.md" }]);

    const alias = byLine.get(5);
    assert.match(alias.excerpt, /AliasWord/);
    assert.deepEqual(alias.chips, [{ name: "AliasWord", path: "AliasNote.md" }]);

    // README is ambiguous: both README.md and Sub/README.md are candidates.
    const readme = byLine.get(6);
    assert.equal(readme.excerpt, "Plain README mention.");
    assert.deepEqual([...new Set(readme.chips.map((chip) => chip.name))], ["README"]);
    assert.deepEqual([...new Set(readme.chips.map((chip) => chip.path))].sort(), ["README.md", "Sub/README.md"]);
  } finally {
    await app.close();
  }
});

test("the request path never reaches the test-only raw handle", async (t) => {
  const runtime = await ensureCatalog();
  const app = await startAuthedApp("no-testdb");
  try {
    const before = await (await getUnlinked(app, "?path=Target.md")).json();
    assert.equal(before.mentions.length, 4, "fixture baseline before the hook is armed");

    // `testDb` is an explicitly test-only hook. If the route called it, the store
    // would throw and the route would degrade to 503; a 200 with byte-identical
    // output therefore proves the read goes through the public accessor.
    t.mock.method(runtime.store, "testDb", () => {
      throw new Error("testDb is a test-only hook; production code must use readIndexedNoteText");
    });

    const response = await getUnlinked(app, "?path=Target.md");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), before);
  } finally {
    await app.close();
  }
});

test("already-linked text, self mentions and link targets never become mentions", async () => {
  const app = await startAuthedApp("exclusions");
  try {
    const body = await (await getUnlinked(app, "?path=Target.md")).json();
    const names = new Set(body.mentions.flatMap((entry) => entry.chips.map((chip) => chip.name)));
    // `[[Linked]]` is an existing link; `[[README]]` is a link target and `Target` is
    // the current note itself.
    assert.equal(names.has("Linked"), false, "a text inside an existing link is not an unlinked mention");
    assert.equal(names.has("Target"), false, "the current note is never a mention candidate");
    assert.equal(names.has("README"), true, "a plain README mention still counts");
  } finally {
    await app.close();
  }
});

test("the endpoint is outgoing: notes that mention the subject are not listed", async () => {
  const app = await startAuthedApp("direction");
  try {
    const body = await (await getUnlinked(app, "?path=Target.md")).json();
    assert.equal(body.mentions.some((entry) => entry.chips.some((chip) => chip.path === "MentionsTarget.md")), false);
  } finally {
    await app.close();
  }
});

test("CRLF notes are scanned without offset drift", async () => {
  const app = await startAuthedApp("crlf");
  try {
    const body = await (await getUnlinked(app, "?path=CrlfTarget.md")).json();
    assert.equal(body.mentions.length, 1);
    assert.equal(body.mentions[0].line, 2);
    assert.equal(body.mentions[0].excerpt, "Architecture here");
    assert.deepEqual(body.mentions[0].highlights, [{ start: 0, end: "Architecture".length }]);
  } finally {
    await app.close();
  }
});

test("repeat requests are byte-stable", async () => {
  const app = await startAuthedApp("stable");
  try {
    const first = await (await getUnlinked(app, "?path=Target.md")).text();
    const second = await (await getUnlinked(app, "?path=Target.md")).text();
    assert.equal(first, second);
  } finally {
    await app.close();
  }
});

test("invalid, non-markdown, traversal and missing paths are a leak-free 404", async () => {
  const app = await startAuthedApp("paths");
  try {
    const cases = [
      `${app.base}/api/web/v1/note-context/unlinked`,
      `${app.base}/api/web/v1/note-context/unlinked?path=`,
      `${app.base}/api/web/v1/note-context/unlinked?path=Target.base`,
      `${app.base}/api/web/v1/note-context/unlinked?path=..%2Foutside.md`,
      `${app.base}/api/web/v1/note-context/unlinked?path=%2Fetc%2Fpasswd.md`,
      `${app.base}/api/web/v1/note-context/unlinked?path=Nope.md`,
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

test("unlinked never scans the Vault: no readdir and no Markdown fs.readFile", async (t) => {
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
    const response = await getUnlinked(app, "?path=Target.md");
    assert.equal(response.status, 200);
    assert.equal(calls.readdir.length, 0, `no readdir, saw: ${calls.readdir.join(", ")}`);
    const markdownReads = calls.readFile.filter((candidate) => candidate.toLowerCase().endsWith(".md"));
    assert.deepEqual(markdownReads, [], `no Markdown fs.readFile, saw: ${markdownReads.join(", ")}`);
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
      `http://127.0.0.1:${server.address().port}/api/web/v1/note-context/unlinked?path=Target.md`,
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

test("an unreconciled catalog is 503 catalog-not-ready, not an empty mention list", async () => {
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
      `http://127.0.0.1:${server.address().port}/api/web/v1/note-context/unlinked?path=Target.md`,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "catalog-not-ready" });
  } finally {
    await closeHttpServer(server);
  }
});

test("a non-GET method is 404 (GET-only route)", async () => {
  const app = await startAuthedApp("method");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/note-context/unlinked?path=Target.md`, {
      method: "POST",
      headers: { Cookie: app.cookie },
    });
    assert.notEqual(response.status, 200);
  } finally {
    await app.close();
  }
});
