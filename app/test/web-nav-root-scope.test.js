// Issue #471 (I471-NAV narrow slice): every internal navigation to the app root, and the
// post-login default return, must use the slash-bearing `/app/`.
//
// Why this exists: #487 (P1) ships an app manifest whose `id` = `start_url` = `scope` = `/app/`.
// Scope membership is a same-origin prefix test on the resolved URL, so the slash-less `/app` is
// *outside* the scope the engine resolves. The repo still shipped internal paths that navigate
// there — the vault switch/create `location.replace("/app")`, the history-carried welcome route,
// the login `next` default and the session-expiry 303 target — and the installed (standalone)
// engine's behaviour for a cross-scope navigation is unverified. This slice normalises the
// targets instead of widening `scope` (the seat's ruling A).
//
// What is read here, per assertion (no reading is taken from another module's summary):
//   1. `safeNext` as a contract table, including the open-redirect / traversal rejections the
//      slice must NOT relax.
//   2. The scope the engine resolves from the committed manifest (when P1 is present) or from a
//      fixture with P1's exact shape, compared with the same prefix test the seat's
//      `scripts/web-regression/pwa-install.mjs` scene applies to the resolved URLs.
//   3. A product-source ratchet: each navigation-shaped app-root target is captured by literal
//      form and must be inside the scope, and every site this slice touched must still be found
//      (so a revert to the slash-less form cannot pass vacuously).
//   4. The shipped `features/vault/controller.js` driven for real with a stubbed navigation sink
//      (vault switch and vault create) — the browser gate has a single-vault fixture, so this
//      path is measured here and NOT in `scripts/web-regression/`.
//   5. A real Express router on a real socket: anonymous `/app` and `/app/`, the deep-link
//      `next`, the post-login landing, hostile `next` values, and a full
//      session-expiry -> login -> return round trip.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The scope the P1 manifest resolves to. Asserted against the committed manifest below, so a
// future manifest change cannot silently move the ratchet's target.
const APP_ROOT = "/app/";

// Same-origin scope membership. This is the prefix test `pwa-install.mjs` applies to the resolved
// absolute URLs; `scope` carries its trailing slash, so `/app` is outside while `/app/` and
// `/app/...` are inside.
const inScope = (scopePath, target) => String(target).split(/[?#]/, 1)[0].startsWith(scopePath);

const P1_MANIFEST_SHAPE = {
  name: "Obsidian Web",
  short_name: "Obsidian Web",
  id: "/app/",
  start_url: "/app/",
  scope: "/app/",
  display: "standalone",
  lang: "zh-CN",
  icons: [{ src: "/app/assets/icon-192.png?v=0000000000000000", sizes: "192x192", type: "image/png", purpose: "any" }],
};

// ---------------------------------------------------------------------------------------------
// Fixture Vault + environment. `src/config.js` snapshots the environment at import time, so every
// application module is imported dynamically after these assignments.
// ---------------------------------------------------------------------------------------------
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-nav-root-scope-"));
const vaultsRoot = path.join(fixtureRoot, "vaults");
const mainVault = path.join(vaultsRoot, "main");
const researchVault = path.join(vaultsRoot, "research");
await fs.mkdir(path.join(mainVault, ".obsidian"), { recursive: true });
await fs.mkdir(path.join(researchVault, ".obsidian"), { recursive: true });
await fs.writeFile(path.join(mainVault, "Note.md"), "# Nav root note\n\nbody\n", "utf8");
process.env.VAULT_PATH = mainVault;
process.env.WEB_VAULTS_ROOT = vaultsRoot;
process.env.WEB_DEFAULT_VAULT = "main";
process.env.DATA_PATH = path.join(fixtureRoot, "data");
delete process.env.OBSIDIAN_READ_ONLY;

const [
  { createWebAppRouter },
  { createWebSessionStore },
  { safeNext },
  { WEB_SESSION_TTL_MS },
  { encodeDocumentRoute },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/web-session-store.js"),
  import("../src/app/auth-routes.js"),
  import("../src/app/web-session-schema.js"),
  import("../src/publish/service.js"),
]);

const scopeFixtureRoot = path.join(fixtureRoot, "scope-fixture");
test.after(async () => fs.rm(fixtureRoot, { recursive: true, force: true }));

let scopeContract = null;
/** Resolve the app scope the way the engine does: `new URL(manifest.scope, manifestUrl)`. */
async function readScopeContract(t) {
  if (scopeContract) return scopeContract;
  const committed = path.join(appRoot, "src/app/assets/manifest.webmanifest");
  let manifestPath = committed;
  let source = "committed P1 manifest (#487)";
  try {
    await fs.access(committed);
  } catch {
    await fs.mkdir(scopeFixtureRoot, { recursive: true });
    manifestPath = path.join(scopeFixtureRoot, "manifest.webmanifest");
    await fs.writeFile(manifestPath, JSON.stringify(P1_MANIFEST_SHAPE, null, 2), "utf8");
    source = "P1-shaped fixture (the committed manifest ships with PR #487, which is not in this base)";
  }
  const manifestUrl = "https://local.invalid/app/assets/manifest.webmanifest";
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  scopeContract = {
    source,
    manifest,
    scopePath: new URL(manifest.scope, manifestUrl).pathname,
    startUrlPath: new URL(manifest.start_url, manifestUrl).pathname,
    idPath: new URL(manifest.id, manifestUrl).pathname,
  };
  t?.diagnostic?.(`scope source: ${source}`);
  return scopeContract;
}

// ---------------------------------------------------------------------------------------------
// 1. `safeNext` contract (pure), plus the scope prefix verdicts the slice is built on.
// ---------------------------------------------------------------------------------------------
test("#471 nav root: the manifest scope is `/app/`, so the slash-less root is outside it", async (t) => {
  const { scopePath, startUrlPath, idPath, source, manifest } = await readScopeContract(t);
  assert.equal(manifest.id, APP_ROOT, `manifest id (${source})`);
  assert.equal(manifest.start_url, APP_ROOT, `manifest start_url (${source})`);
  assert.equal(manifest.scope, APP_ROOT, `manifest scope (${source})`);
  assert.equal(scopePath, APP_ROOT);
  assert.equal(startUrlPath, APP_ROOT);
  assert.equal(idPath, APP_ROOT);
  // The discriminating pair: the pre-fix navigation target was outside the resolved scope, the
  // post-fix target is inside it. `pwa-install.mjs` records the same two verdicts in Chromium.
  assert.equal(inScope(scopePath, "/app"), false, "the slash-less app root is outside the scope");
  assert.equal(inScope(scopePath, APP_ROOT), true, "the slash-bearing app root is inside the scope");
  assert.equal(inScope(scopePath, "/app/note/A"), true);
  assert.equal(inScope(scopePath, "/app/base/B?view=table"), true);
  assert.equal(inScope(scopePath, "/admin/auth"), false);
});

test("#471 nav root: safeNext keeps its accept-set and defaults to the slash-bearing app root", () => {
  const cases = [
    [undefined, APP_ROOT, "absent next falls back to the app root"],
    ["", APP_ROOT, "empty next falls back to the app root"],
    ["/app", APP_ROOT, "the slash-less app root is accepted and normalised"],
    [APP_ROOT, APP_ROOT, "the slash form is stable"],
    ["/app?view=list", "/app/?view=list", "a root query survives the normalisation"],
    ["/app/note/Folder/A.md", "/app/note/Folder/A.md", "note deep links are unchanged"],
    ["/app/note/A.md?tab=editor", "/app/note/A.md?tab=editor", "note query stays"],
    ["/app/base/B.base?view=table", "/app/base/B.base?view=table", "Base deep links keep their query"],
    ["/app/note/../../admin", APP_ROOT, "path traversal out of the scope is rejected"],
    ["/admin/auth", APP_ROOT, "another same-origin surface is rejected"],
    ["/application", APP_ROOT, "a sibling prefix is not the app root"],
    ["/app-evil/note", APP_ROOT, "a hyphenated sibling is not the app root"],
    ["//evil.example/app", APP_ROOT, "a protocol-relative target is rejected"],
    ["https://evil.example/app", APP_ROOT, "a cross-origin target is rejected"],
    ["https://local.invalid/app/", APP_ROOT, "a same-origin absolute target is accepted"],
    ["javascript:alert(1)", APP_ROOT, "a script URL is rejected"],
    ["/app/note/A\\..\\admin", APP_ROOT, "a backslash target is rejected"],
    ["/app/\nX-Injected: 1", APP_ROOT, "a newline target is rejected"],
  ];
  for (const [value, expected, label] of cases) {
    assert.equal(safeNext(value), expected, `${label} (input: ${JSON.stringify(value)})`);
    assert.equal(inScope(APP_ROOT, safeNext(value)), true, `${label} lands inside the scope`);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Product-source ratchet: every navigation-shaped app-root target inside the scope.
// ---------------------------------------------------------------------------------------------
const APP_TARGET_PATTERNS = [
  /location\.(?:replace|assign)\(\s*["'`](\/app[^"'`$]*)/g,
  /location\.href\s*=\s*["'`](\/app[^"'`$]*)/g,
  /\b(?:href|route|next|nextTarget|start_url|startUrl)\s*[:=]\s*(?:\(\)\s*=>\s*)?["'`](\/app[^"'`$]*)/g,
  // A module-level constant that holds the app root: `WELCOME_ROUTE`, or the Admin plane's
  // `WEB_HREF` (`src/admin/layout.js`, `src/admin/pages/login.js`). The value is still read
  // verbatim, so a revert to the slash-less `/app` stays captured and turns this check red.
  /\b[A-Z][A-Z0-9_]*(?:HREF|ROUTE|TARGET|URL|PATH)\s*=\s*["'`](\/app[^"'`$]*)/g,
];

async function collectSourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (path.relative(appRoot, absolute).replaceAll("\\", "/") === "src/app/assets") continue;
      files.push(...await collectSourceFiles(absolute));
    } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

async function collectAppRootTargets() {
  const files = [
    ...await collectSourceFiles(path.join(appRoot, "src")),
    ...await collectSourceFiles(path.join(appRoot, "frontend")),
  ];
  const found = [];
  for (const file of files) {
    const relative = path.relative(appRoot, file).replaceAll("\\", "/");
    const lines = (await fs.readFile(file, "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      for (const pattern of APP_TARGET_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(line)) !== null) found.push({ file: relative, line: index + 1, target: match[1] });
      }
    }
  }
  return found;
}

// Files this slice unified. Each must still contribute at least one target, so reverting a site to
// the slash-less form turns this check red instead of silently emptying the ratchet.
const UNIFIED_SITES = [
  "frontend/app/features/vault/controller.js",
  "frontend/app/features/navigation/welcome-transition.js",
  "frontend/app/features/navigation/bind-navigation.js",
  "src/app/pages.js",
  "src/app/web-session-resolve.js",
  "src/admin/layout.js",
];

test("#471 nav root: no product source navigates to the slash-less app root", async (t) => {
  const { scopePath } = await readScopeContract(t);
  const found = await collectAppRootTargets();
  assert.ok(found.length > 0, "the ratchet must capture at least one app-root target");
  for (const { file, line, target } of found) {
    assert.equal(inScope(scopePath, target), true, `${file}:${line} targets "${target}", outside ${scopePath}`);
    assert.notEqual(target, "/app", `${file}:${line} still uses the slash-less app root`);
  }
  const files = new Set(found.map((entry) => entry.file));
  for (const site of UNIFIED_SITES) {
    assert.ok(files.has(site), `${site} must carry an app-root target in the slash form (found: ${[...files].sort().join(", ")})`);
  }
  const vaultController = found.filter((entry) => entry.file === "frontend/app/features/vault/controller.js");
  assert.equal(vaultController.length, 2, `the vault switch and vault create are both captured: ${JSON.stringify(vaultController)}`);
  t.diagnostic(`app-root targets captured: ${found.length} in ${files.size} files`);
});

// ---------------------------------------------------------------------------------------------
// 3. The shipped vault controller, driven for real (the vault switch and the vault create).
// ---------------------------------------------------------------------------------------------
test("#471 nav root: the vault switch and vault create navigate to the slash-bearing app root", async (t) => {
  const { initializeVaultController } = await import("../frontend/app/features/vault/controller.js");
  const { scopePath } = await readScopeContract(t);
  const previousLocation = globalThis.location;
  const previousPrompt = globalThis.prompt;
  const previousDocument = globalThis.document;
  const navigations = [];
  globalThis.location = { replace: (target) => navigations.push(target) };
  globalThis.prompt = () => "second vault";
  globalThis.document = { createElement: (tagName) => ({ tagName, value: "", textContent: "", selected: false }) };
  // One controller per gesture: a successful mutation keeps `lifecycle.switching` latched (the
  // page is expected to navigate away), so a second gesture needs a fresh controller.
  const drive = async (gesture) => {
    const handlers = {};
    const options = [];
    const vaultSelect = {
      replaceChildren: () => { options.length = 0; },
      append: (option) => options.push(option),
      addEventListener: (type, handler) => { handlers[type] = handler; },
    };
    const createButton = { hidden: true, onclick: null };
    const controller = initializeVaultController({
      api: async (route) => (route === "/api/web/v1/vaults"
        ? { current: "main", canCreate: true, vaults: [{ id: "main", name: "main" }, { id: "research", name: "research" }] }
        : { ok: true }),
      toast: () => {},
      session: {
        isDirty: () => false,
        setWritesSuspended: () => {},
        invalidateInFlightReads: () => {},
        whenSavesIdle: async () => {},
      },
      state: { vaultId: "main" },
      lifecycle: { switching: false },
      saveButton: { disabled: false },
      vaultSelect,
      createButton,
      abortOpen: () => {},
      abortRefresh: () => {},
      syncStatus: () => {},
    });
    await controller.load();
    assert.equal(createButton.hidden, false, "the fixture allows vault creation");
    if (gesture === "switch") await handlers.change({ target: { value: "research" } });
    else await createButton.onclick();
  };
  try {
    const before = navigations.length;
    await drive("switch");
    assert.deepEqual(navigations.slice(before), ["/app/"], "switching a Vault navigates to the slash-bearing app root");
    const beforeCreate = navigations.length;
    await drive("create");
    assert.deepEqual(navigations.slice(beforeCreate), ["/app/"], "creating a Vault navigates to the slash-bearing app root");
    for (const target of navigations) assert.equal(inScope(scopePath, target), true, `${target} is inside ${scopePath}`);
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPrompt === undefined) delete globalThis.prompt;
    else globalThis.prompt = previousPrompt;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

// ---------------------------------------------------------------------------------------------
// 4. Real Express HTTP: login return, hostile `next`, and the expiry round trip.
// ---------------------------------------------------------------------------------------------

test("#471 nav root: the session manager's own default redirects the bare root to the plain login URL", async () => {
  // `routes.js` always injects `nextTarget: safeNext(req.originalUrl)`, so the adapter's own
  // default is exercised directly here instead of only being captured by the source ratchet.
  const { createWebSessionManager } = await import("../src/app/web-session-resolve.js");
  const store = { now: () => 2_000_000 };
  const provider = { oauthUserSessionRecord: async () => null };
  const redirectFor = (manager, originalUrl) => new Promise((resolve) => {
    const res = { redirect: (status, location) => resolve({ status, location }) };
    manager.requirePage({ headers: {}, originalUrl }, res, () => resolve({ status: 200, location: null }));
  });
  const manager = createWebSessionManager({ store, provider });
  assert.deepEqual(await redirectFor(manager, "/app/"), { status: 303, location: "/auth/login" }, "the bare app root needs no next parameter");
  assert.deepEqual(await redirectFor(manager, "/app/note/A"), { status: 303, location: "/auth/login" }, "the adapter's own default never invents a next parameter");
  // This is the wiring `routes.js` installs; the deep link is what survives it.
  const wired = createWebSessionManager({ store, provider, nextTarget: (req) => safeNext(req.originalUrl) });
  assert.deepEqual(await redirectFor(wired, "/app/note/A"), { status: 303, location: "/auth/login?next=%2Fapp%2Fnote%2FA" }, "a deep link keeps its next parameter");
});

test("#471 nav root: loginPage's own default next is the slash-bearing app root", async () => {
  // The error branches (`/app` error handler, failed logout) render the login chrome without an
  // explicit `next`, so its parameter default is read directly off the shipped page function.
  const { loginPage } = await import("../src/app/pages.js");
  assert.match(loginPage("", {}, undefined), /name="next" value="\/app\/"/);
});

const HTTP_TIMEOUT_MS = 5_000;
const boundedFetch = (url, options = {}) => fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS) });

function makeClock() {
  const state = { t: 2_000_000 };
  return { now: () => state.t, advance: (ms) => { state.t += ms; } };
}

async function boot() {
  const clock = makeClock();
  const user = {
    id: "user-1",
    username: "owner",
    displayName: "Owner",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read", "obsidian.write"],
    allowedVaults: ["main", "research"],
  };
  const store = createWebSessionStore({ file: path.join(fixtureRoot, `sessions-${Math.random().toString(16).slice(2)}.json`), now: clock.now });
  await store.ready;
  const provider = {
    authenticateOAuthUser: async (username, password) => (username === "owner" && password === "password" ? user : null),
    oauthUserSessionRecord: async (id) => (id === user.id ? user : null),
    recordAudit: () => {},
  };
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false, publishService: {}, webSessionStore: store }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    clock,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    login: async (next) => {
      const body = new URLSearchParams({ username: "owner", password: "password" });
      if (next !== undefined) body.set("next", next);
      const response = await boundedFetch(`${base}/auth/login`, {
        method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const setCookie = response.headers.get("set-cookie");
      return { response, location: response.headers.get("location"), cookie: setCookie ? setCookie.split(";", 1)[0] : null };
    },
  };
}

test("#471 nav root: anonymous /app and /app/ both redirect to the plain login URL", async () => {
  const app = await boot();
  try {
    for (const requestPath of ["/app", "/app/"]) {
      const response = await boundedFetch(`${app.base}${requestPath}`, { redirect: "manual" });
      assert.equal(response.status, 303, `${requestPath} requires a session`);
      assert.equal(response.headers.get("location"), "/auth/login", `${requestPath} must not carry a redundant next`);
    }
    const login = await boundedFetch(`${app.base}/auth/login`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /name="next" value="\/app\/"/, "the login page's default next is the slash-bearing app root");
  } finally {
    await app.close();
  }
});

test("#471 nav root: the post-login landing is the slash-bearing app root", async () => {
  const app = await boot();
  try {
    const absent = await app.login();
    assert.equal(absent.response.status, 303);
    assert.equal(absent.location, "/app/", "login without a next lands inside the scope");
    const slashless = await app.login("/app");
    assert.equal(slashless.location, "/app/", "the accepted slash-less root is normalised");
    const slashForm = await app.login("/app/");
    assert.equal(slashForm.location, "/app/");
  } finally {
    await app.close();
  }
});

test("#471 nav root: hostile or out-of-surface next values stay inside the app scope", async () => {
  const app = await boot();
  try {
    const hostile = [
      "/admin/auth", "/application", "/app-evil", "//evil.example/app", "https://evil.example/app", "/app/note/../../admin",
    ];
    for (const value of hostile) {
      const { location } = await app.login(value);
      assert.equal(location, "/app/", `${value} must fall back to the app root (got ${location})`);
      assert.ok(!String(location).includes("evil.example"), `${value} must not be echoed`);
    }
  } finally {
    await app.close();
  }
});

test("#471 nav root: note and Base deep links survive the login round trip with their query", async () => {
  const app = await boot();
  try {
    const noteRoute = `/app/note/${encodeDocumentRoute("main", "Note.md")}`;
    // `/app/note/Note.md` is the readable form: the server keeps the session gate first and only
    // canonicalises the route after login, so `next` is the readable URL itself.
    const targets = [
      ["/app/note/Note.md", "/app/note/Note.md"],
      [`${noteRoute}?tab=editor`, `${noteRoute}?tab=editor`],
      ["/app/base/Default.base?view=table", "/app/base/Default.base?view=table"],
    ];
    for (const [anonymousPath, expectedNext] of targets) {
      const anonymous = await boundedFetch(`${app.base}${anonymousPath}`, { redirect: "manual" });
      assert.equal(anonymous.status, 303, `${anonymousPath} requires a session`);
      const loginUrl = anonymous.headers.get("location");
      assert.equal(loginUrl, `/auth/login?next=${encodeURIComponent(expectedNext)}`, `${anonymousPath} carries its deep link into login`);
      const page = await boundedFetch(`${app.base}${loginUrl}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /name="next"/, `${anonymousPath}: the login page keeps the deep link field`);
      const { location } = await app.login(expectedNext);
      assert.equal(location, expectedNext, `${anonymousPath} returns to the same deep link`);
    }
  } finally {
    await app.close();
  }
});

test("#471 nav root: session expiry -> login -> return lands inside the scope, root and deep link alike", async () => {
  const app = await boot();
  try {
    const first = await app.login();
    assert.equal(first.location, "/app/");
    const shell = await boundedFetch(`${app.base}/app`, { headers: { Cookie: first.cookie } });
    assert.equal(shell.status, 200, "the shell renders for the fresh session");

    app.clock.advance(WEB_SESSION_TTL_MS + 60_000);

    const expiredRoot = await boundedFetch(`${app.base}/app`, { headers: { Cookie: first.cookie }, redirect: "manual" });
    assert.equal(expiredRoot.status, 303, "the expired root session is refused");
    assert.equal(expiredRoot.headers.get("location"), "/auth/login", "the bare root needs no next");
    const afterRoot = await app.login();
    assert.equal(afterRoot.location, "/app/", "after expiry the root return stays inside the scope");

    const noteRoute = `/app/note/${encodeDocumentRoute("main", "Note.md")}`;
    const second = await app.login();
    app.clock.advance(WEB_SESSION_TTL_MS + 60_000);
    const expiredDeepLink = await boundedFetch(`${app.base}${noteRoute}`, { headers: { Cookie: second.cookie }, redirect: "manual" });
    assert.equal(expiredDeepLink.status, 303);
    assert.equal(expiredDeepLink.headers.get("location"), `/auth/login?next=${encodeURIComponent(noteRoute)}`);
    const afterDeepLink = await app.login(noteRoute);
    assert.equal(afterDeepLink.location, noteRoute, "after expiry the deep link is restored unchanged");
    const notePage = await boundedFetch(`${app.base}${afterDeepLink.location}`, { headers: { Cookie: afterDeepLink.cookie } });
    assert.equal(notePage.status, 200, "the restored deep link renders the note shell");
  } finally {
    await app.close();
  }
});
