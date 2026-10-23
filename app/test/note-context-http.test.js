// HTTP contract tests for GET /api/web/v1/note-context/outgoing (sidebar Phase 2).
//
// Real Express + real http.createServer + real login session (no route mocks).
// Verifies auth/scope/path status mapping, no-store, the frozen DTO, dedupe and
// first-occurrence order, and canonical `extractLinks` parity with the same
// fixture the vault index uses.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-note-context-http-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.DATA_PATH = data;

const NOTE_BODY = `# Links

![[images/pixel.png]]
[[Target|别名]]
[[Target]]
[[Other#Section]]
[[Beta]]
[[Missing]]
[[Folder/Doc]]
[[v2026.09.25.11 发布与 NAS 部署]]
[[https://wiki.example/x]]
[[javascript:alert(1)]]
[x](https://example.com)
`;

await fs.mkdir(path.join(vault, "images"), { recursive: true });
await fs.mkdir(path.join(vault, "Folder"), { recursive: true });
await fs.writeFile(path.join(vault, "images", "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
await fs.writeFile(path.join(vault, "Note.md"), NOTE_BODY, "utf8");
await fs.writeFile(path.join(vault, "Target.md"), "# Target\n", "utf8");
await fs.writeFile(path.join(vault, "Other.md"), "# Other\n", "utf8");
await fs.writeFile(path.join(vault, "Folder", "Doc.md"), "# Doc\n", "utf8");
await fs.writeFile(path.join(vault, "v2026.09.25.11 发布与 NAS 部署.md"), "# 点号标题\n", "utf8");
await fs.writeFile(path.join(vault, "AliasTarget.md"), '---\naliases:\n  - Beta\n---\n# Alias target\n', "utf8");
// Frontmatter wiki links are a separate projection and must not appear in body links.
await fs.writeFile(
  path.join(vault, "WithFrontmatter.md"),
  '---\naliases:\n  - "[[Target]]"\n---\n# Body\n\n[[Missing]]\n',
  "utf8",
);

const [
  { createWebAppRouter },
  { defaultWebVaultId },
  { PublishService },
  { extractLinks },
  { registerNoteContextRoute },
  { classifyWebApiError },
  { createAccessPolicyRuntime },
  { fakeClock, fakeStore, policyFixture, snapshotFixture },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/publish/service.js"),
  import("../src/obsidian.js"),
  import("../src/app/note-context.js"),
  import("../src/app/web-api-error.js"),
  import("../src/access-policy/runtime.js"),
  import("./helpers/access-policy-fixtures.js"),
]);

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const HTTP_TIMEOUT_MS = 5_000;
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
    timeoutId = setTimeout(() => reject(new Error("Timed out closing note-context test server")), HTTP_TIMEOUT_MS);
  });
  try {
    await Promise.race([closed, timedOut]);
  } finally {
    clearTimeout(timeoutId);
  }
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
  const audits = [];
  const provider = {
    authenticateOAuthUser: async (username, password) => (username === "owner" && password === "password" ? user : null),
    oauthUserSessionRecord: async (id) => (id === user.id ? user : null),
    recordAudit(entry) { audits.push(entry); },
  };
  const app = express();
  app.use(createWebAppRouter({
    provider,
    secureCookie: false,
    publishService: new PublishService({ file: path.join(data, `${stateName}.json`) }),
    accessRuntime,
  }));
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
    const cookieHeader = login.headers.get("set-cookie");
    assert.ok(cookieHeader, "login must return a session cookie");
    const cookie = cookieHeader.split(";", 1)[0];
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

function dedupeConsecutive(values) {
  const out = [];
  for (const value of values) {
    if (out.at(-1) !== value) out.push(value);
  }
  return out;
}

test("outgoing request without a session is 401 and never reaches the vault", async () => {
  const app = await startAuthedApp("anon");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/note-context/outgoing?path=Note.md`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Login required" });
  } finally {
    await app.close();
  }
});

test("outgoing links reuse canonical extraction, resolve kinds, dedupe and keep first-occurrence order", async () => {
  const app = await startAuthedApp("links");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/note-context/outgoing?path=Note.md`, {
      headers: { Cookie: app.cookie },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();

    assert.equal(body.vaultId, defaultWebVaultId());
    assert.equal(body.path, "Note.md");
    assert.match(body.revision, /^sha256:[0-9a-f]{64}$/);

    const noteResponse = await boundedFetch(`${app.base}/api/web/v1/note?path=Note.md`, {
      headers: { Cookie: app.cookie },
    });
    assert.equal(noteResponse.status, 200);
    assert.equal(body.revision, (await noteResponse.json()).revision, "revision must match the note API");

    // Canonical parity: the same `extractLinks` projection the vault index uses.
    const canonicalTargets = extractLinks(NOTE_BODY, "Note.md").map((link) => link.target);
    assert.deepEqual(canonicalTargets, [
      "images/pixel.png",
      "Target",
      "Target",
      "Other",
      "Beta",
      "Missing",
      "Folder/Doc",
      "v2026.09.25.11 发布与 NAS 部署",
      "https://wiki.example/x",
      "javascript:alert(1)",
    ]);
    assert.deepEqual(body.links.map((link) => link.target), dedupeConsecutive(canonicalTargets));

    assert.deepEqual(body.links, [
      { target: "images/pixel.png", kind: "asset", resolvedPath: null, alias: null, heading: null },
      { target: "Target", kind: "note", resolvedPath: "Target.md", alias: "别名", heading: null },
      { target: "Other", kind: "note", resolvedPath: "Other.md", alias: null, heading: "Section" },
      { target: "Beta", kind: "note", resolvedPath: "AliasTarget.md", alias: null, heading: null },
      { target: "Missing", kind: "unresolved", resolvedPath: null, alias: null, heading: null },
      { target: "Folder/Doc", kind: "note", resolvedPath: "Folder/Doc.md", alias: null, heading: null },
      {
        target: "v2026.09.25.11 发布与 NAS 部署",
        kind: "note",
        resolvedPath: "v2026.09.25.11 发布与 NAS 部署.md",
        alias: null,
        heading: null,
      },
      { target: "https://wiki.example/x", kind: "external", resolvedPath: null, alias: null, heading: null },
      { target: "javascript:alert(1)", kind: "external", resolvedPath: null, alias: null, heading: null },
    ]);
  } finally {
    await app.close();
  }
});

test("frontmatter links never leak into the outgoing body list", async () => {
  const app = await startAuthedApp("frontmatter");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/note-context/outgoing?path=WithFrontmatter.md`, {
      headers: { Cookie: app.cookie },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.links.map((link) => link.target), ["Missing"]);
  } finally {
    await app.close();
  }
});

test("invalid, non-markdown, traversal and missing paths are a leak-free 404", async () => {
  const app = await startAuthedApp("paths");
  try {
    const cases = [
      `${app.base}/api/web/v1/note-context/outgoing`,
      `${app.base}/api/web/v1/note-context/outgoing?path=`,
      `${app.base}/api/web/v1/note-context/outgoing?path=images%2Fpixel.png`,
      `${app.base}/api/web/v1/note-context/outgoing?path=..%2Foutside.md`,
      `${app.base}/api/web/v1/note-context/outgoing?path=%2Fetc%2Fpasswd.md`,
      `${app.base}/api/web/v1/note-context/outgoing?path=Nope.md`,
      `${app.base}/api/web/v1/note-context/outgoing?path=.hidden%2Fsecret.md`,
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
    requireApi: (req, _res, next) => { req.webSession = { userId: "u", allowedVaults: ["vault"], vaultId: "vault" }; next(); },
    currentVault: async () => {
      // Mirrors routes.js `currentVault` when the session Vault is outside allowedVaults.
      throw new Error("Vault access denied");
    },
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
    const response = await boundedFetch(`http://127.0.0.1:${server.address().port}/api/web/v1/note-context/outgoing?path=Note.md`);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: "Vault access denied" });
    assert.equal(text.includes(root), false);
  } finally {
    await closeHttpServer(server);
  }
});

test("the workspace shell exposes the note-context link section hosts", async () => {
  const { appPage } = await import("../src/app/pages.js");
  const page = appPage({ username: "owner", displayName: "Owner", csrf: "csrf-token" }, {});
  assert.match(page, /id="outgoing-list"/);
  // Desktop Backlinks-panel copy (H2): the outgoing section is titled
  // 「当前笔记中的链接」; the incoming/backlinks host is added next to it.
  assert.match(page, /aria-label="当前笔记中的链接"/);
  assert.match(page, /id="incoming-list"/);
  assert.match(page, /aria-label="链接当前笔记"/);
});

test("an outside-window session is a 403 outside_authorized_window before any vault read", async (t) => {
  const { app, clock, policy } = await startWindowedApp("gate");
  const originals = { stat: fs.stat, readFile: fs.readFile, open: fs.open };
  const calls = { stat: [], readFile: [], open: [] };
  t.mock.method(fs, "stat", async (...args) => { calls.stat.push(String(args[0])); return originals.stat(...args); });
  t.mock.method(fs, "readFile", async (...args) => { calls.readFile.push(String(args[0])); return originals.readFile(...args); });
  t.mock.method(fs, "open", async (...args) => { calls.open.push(String(args[0])); return originals.open(...args); });
  try {
    const url = `${app.base}/api/web/v1/note-context/outgoing?path=Note.md`;
    const denied = await boundedFetch(url, { headers: { Cookie: app.cookie } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assertOutsideWindowDeny(await denied.json(), policy);
    // Gate-before-content: the deny short-circuits before any stat/body read.
    assert.deepEqual(calls, { stat: [], readFile: [], open: [] }, "the window deny must precede every Vault read");

    // Reverse control: the same policy and route allow inside the window.
    clock.set(INSIDE_WINDOW_MS);
    const allowed = await boundedFetch(url, { headers: { Cookie: app.cookie } });
    assert.equal(allowed.status, 200);
    assert.ok(calls.readFile.length > 0, "the same request inside the window must read the note body");
  } finally {
    await app.close();
  }
});

test("the outgoing route is read-only: POST has no handler", async () => {
  const app = await startAuthedApp("readonly");
  try {
    const response = await boundedFetch(`${app.base}/api/web/v1/note-context/outgoing?path=Note.md`, {
      method: "POST",
      headers: { Cookie: app.cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});
