import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-auth-gate-"));
const vaultsRoot = path.join(root, "vaults");
const main = path.join(vaultsRoot, "main");
const research = path.join(vaultsRoot, "research");
const data = path.join(root, "data");
await fs.mkdir(path.join(main, ".obsidian"), { recursive: true });
await fs.mkdir(path.join(research, ".obsidian"), { recursive: true });
await fs.writeFile(path.join(main, "Public.md"), "---\nsecret: must-not-leak\n---\n# Public main body\n", "utf8");
await fs.writeFile(path.join(research, "Secret.md"), "---\nsecret: cross-vault-must-not-leak\n---\n# TOP SECRET research body\n", "utf8");
process.env.VAULT_PATH = main;
process.env.WEB_VAULTS_ROOT = vaultsRoot;
process.env.WEB_DEFAULT_VAULT = "main";
process.env.DATA_PATH = data;
delete process.env.OBSIDIAN_READ_ONLY;

const [{ createWebAppRouter }, { PublishService, encodeDocumentRoute }] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/publish/service.js"),
]);

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HTTP_TIMEOUT_MS = 5_000;
const boundedFetch = (url, options = {}) => fetch(url, {
  ...options,
  signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS),
});

async function closeHttpServer(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out closing Web test server")), HTTP_TIMEOUT_MS)),
  ]);
}

/**
 * Boot a Web router for a user whose Vault allowlist is `allowedVaults` and
 * log in, returning the session cookie. Every Vault in `vaultsRoot` is real on
 * disk; only the allowlist decides what the session may reach.
 */
async function startAuthedApp(allowedVaults, stateName, options = {}) {
  const user = {
    id: "user-1",
    username: "owner",
    displayName: "Owner",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read", "obsidian.write"],
    allowedVaults,
  };
  let failSessionLookup = false;
  const provider = {
    authenticateOAuthUser: async (username, password) => username === "owner" && password === "password" ? user : null,
    oauthUserSessionRecord: async (id) => {
      if (failSessionLookup) throw new Error(options.sessionErrorMessage || "injected async session lookup failure");
      return id === user.id ? user : null;
    },
    recordAudit() {},
  };
  const app = express();
  app.use(createWebAppRouter({
    provider,
    secureCookie: false,
    publishService: new PublishService({ file: path.join(data, "publish", stateName) }),
    resolveOrigin: options.internalErrorMessage
      ? () => { throw new Error(options.internalErrorMessage); }
      : undefined,
  }));
  const server = await new Promise((resolve) => {
    const instance = http.createServer(app).listen(0, "127.0.0.1", () => resolve(instance));
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
  return {
    base,
    cookie,
    server,
    injectSessionFailure() { failSessionLookup = true; },
    close: () => closeHttpServer(server),
  };
}

test("private note route fails closed for a forbidden Vault and never reveals target metadata", async () => {
  const { base, cookie, close } = await startAuthedApp(["main"], "auth-gate-state.json");
  try {
    // Baseline: an allowed Vault note is reachable through its encoded private route.
    const allowed = await fetch(`${base}/app/note/${encodeDocumentRoute("main", "Public.md")}`, { headers: { Cookie: cookie } });
    assert.equal(allowed.status, 200);
    assert.match(await allowed.text(), /name="initial-note-path" content="Public\.md"/);

    // Forbidden cross-Vault target: bare 404 with no body/metadata leak.
    const forbidden = await fetch(`${base}/app/note/${encodeDocumentRoute("research", "Secret.md")}`, { headers: { Cookie: cookie } });
    const forbiddenBody = await forbidden.text();
    assert.equal(forbidden.status, 404);
    assert.doesNotMatch(forbiddenBody, /TOP SECRET|Secret|cross-vault-must-not-leak|research/);
    assert.doesNotMatch(forbiddenBody, new RegExp(escapeRegExp(research)));

    // Missing note in an allowed Vault: indistinguishable from the forbidden response.
    const missing = await fetch(`${base}/app/note/${encodeDocumentRoute("main", "Does-not-exist.md")}`, { headers: { Cookie: cookie } });
    const missingBody = await missing.text();
    assert.equal(missing.status, 404);
    assert.equal(forbidden.status, missing.status);
    assert.equal(forbiddenBody, missingBody);
    assert.equal(forbidden.headers.get("content-type"), missing.headers.get("content-type"));

    // Unknown Vault id must behave exactly like a forbidden/missing target.
    const unknownVault = await fetch(`${base}/app/note/${encodeDocumentRoute("nonexistent", "Secret.md")}`, { headers: { Cookie: cookie } });
    assert.equal(unknownVault.status, 404);
    assert.equal(await unknownVault.text(), forbiddenBody);
  } finally {
    await close();
  }
});

test("private note route enforces the allowlist in both directions", async () => {
  // Inverse allowlist: the non-default Vault is readable and the default Vault is forbidden.
  const { base, cookie, close } = await startAuthedApp(["research"], "auth-gate-inverse-state.json");
  try {
    const ownVault = await fetch(`${base}/app/note/${encodeDocumentRoute("research", "Secret.md")}`, { headers: { Cookie: cookie } });
    assert.equal(ownVault.status, 200);
    assert.match(await ownVault.text(), /name="initial-note-path" content="Secret\.md"/);

    const forbidden = await fetch(`${base}/app/note/${encodeDocumentRoute("main", "Public.md")}`, { headers: { Cookie: cookie } });
    const missing = await fetch(`${base}/app/note/${encodeDocumentRoute("research", "Does-not-exist.md")}`, { headers: { Cookie: cookie } });
    const forbiddenBody = await forbidden.text();
    assert.equal(forbidden.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(forbiddenBody, await missing.text());
    assert.doesNotMatch(forbiddenBody, /Public main body|must-not-leak/);
  } finally {
    await close();
  }
});

test("private note route rejects traversal into a forbidden Vault without metadata leakage", async () => {
  const { base, cookie, close } = await startAuthedApp(["main"], "auth-gate-traversal-state.json");
  try {
    const baseline = await fetch(`${base}/app/note/${encodeDocumentRoute("main", "Public.md")}`, { headers: { Cookie: cookie } });
    assert.equal(baseline.status, 200);

    const forbidden = await fetch(`${base}/app/note/${encodeDocumentRoute("research", "Secret.md")}`, { headers: { Cookie: cookie } });
    const forbiddenBody = await forbidden.text();

    const traversalTargets = [
      // Encoded route that tries to climb out of the allowed Vault root.
      `/app/note/${encodeDocumentRoute("main", "../research/Secret.md")}`,
      // Readable (unencoded) fallback route with traversal segments.
      "/app/note/..%2Fresearch%2FSecret",
      "/app/note/%2E%2E%2Fresearch%2FSecret.md",
      // Absolute path escape attempt.
      "/app/note//research/Secret.md",
    ];
    for (const target of traversalTargets) {
      const response = await fetch(`${base}${target}`, { headers: { Cookie: cookie }, redirect: "manual" });
      const body = await response.text();
      assert.equal(response.status, 404, `expected 404 for ${target}`);
      assert.equal(body, forbiddenBody, `body must not vary for ${target}`);
      assert.doesNotMatch(body, /TOP SECRET|cross-vault-must-not-leak/);
    }
  } finally {
    await close();
  }
});

test("anonymous private-link requests reveal nothing before login for allowed and forbidden targets", async () => {
  const { base, close } = await startAuthedApp(["main"], "auth-gate-anon-state.json");
  try {
    const allowedAnon = await fetch(`${base}/app/note/${encodeDocumentRoute("main", "Public.md")}`, { redirect: "manual" });
    const forbiddenAnon = await fetch(`${base}/app/note/${encodeDocumentRoute("research", "Secret.md")}`, { redirect: "manual" });
    assert.equal(allowedAnon.status, 303);
    assert.equal(forbiddenAnon.status, 303);
    // The only client-supplied data echoed back is the original request URL.
    assert.match(allowedAnon.headers.get("location"), /^\/auth\/login\?next=/);
    assert.match(forbiddenAnon.headers.get("location"), /^\/auth\/login\?next=/);
    assert.doesNotMatch(decodeURIComponent(forbiddenAnon.headers.get("location")), /TOP SECRET|Secret\.md|cross-vault-must-not-leak/);
  } finally {
    await close();
  }
});

test("Web API HTTP boundary classifies client errors and logs only unexpected failures", async () => {
  const internalMarker = "INTERNAL_WEB_API_FAILURE_MUST_NOT_LEAK_/srv/private/state.db";
  const { base, cookie, close } = await startAuthedApp(
    ["main"],
    "auth-gate-http-error-state.json",
    { internalErrorMessage: internalMarker },
  );
  const originalConsoleError = console.error;
  const serverErrors = [];
  console.error = (...args) => serverErrors.push(args.map(String).join(" "));
  try {
    const missing = await boundedFetch(`${base}/api/web/v1/note?path=${encodeURIComponent("Does-not-exist.md")}`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Not found" });
    assert.equal(serverErrors.length, 0, "expected ENOENT must not pollute serverErrors");

    const invalidSearch = await boundedFetch(
      `${base}/api/web/v1/notes?q=${encodeURIComponent('file:"broken')}`,
      { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(invalidSearch.status, 400);
    assert.deepEqual(await invalidSearch.json(), { error: "Invalid search query" });
    assert.equal(serverErrors.length, 0, "expected search 4xx must not pollute serverErrors");

    const invalidJson = await boundedFetch(`${base}/api/web/v1/note`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: '{"content":',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), { error: "Invalid JSON request body" });
    assert.equal(serverErrors.length, 0, "expected JSON parse 4xx must not pollute serverErrors");

    const internal = await boundedFetch(
      `${base}/api/web/v1/publish?path=${encodeURIComponent("Public.md")}`,
      {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(5000),
      },
    );
    const internalBody = await internal.text();
    assert.equal(internal.status, 500);
    assert.deepEqual(JSON.parse(internalBody), { error: "Request failed" });
    assert.doesNotMatch(internalBody, /INTERNAL_WEB_API_FAILURE|\/srv\/private|state\.db/);
    assert.equal(serverErrors.length, 1, "unexpected internal failures must be logged once");
    assert.match(serverErrors[0], /INTERNAL_WEB_API_FAILURE/);
  } finally {
    console.error = originalConsoleError;
    await close();
  }
});

test("async requireSession rejection reaches the API error boundary exactly once", async () => {
  const sessionMarker = "ASYNC_SESSION_LOOKUP_FAILURE_MUST_NOT_LEAK_/srv/private/session.db";
  const { base, cookie, injectSessionFailure, close } = await startAuthedApp(
    ["main"],
    "auth-gate-session-error-state.json",
    { sessionErrorMessage: sessionMarker },
  );
  const originalConsoleError = console.error;
  const serverErrors = [];
  console.error = (...args) => serverErrors.push(args.map(String).join(" "));
  try {
    injectSessionFailure();
    const response = await boundedFetch(`${base}/api/web/v1/session`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(body), { error: "Request failed" });
    assert.doesNotMatch(body, /ASYNC_SESSION_LOOKUP_FAILURE|\/srv\/private|session\.db/);
    assert.equal(serverErrors.length, 1, "async session lookup failure must be logged exactly once");
    assert.match(serverErrors[0], /ASYNC_SESSION_LOOKUP_FAILURE/);
  } finally {
    console.error = originalConsoleError;
    await close();
  }
});

test("Publish API ignores client-supplied Vault ids and keeps forbidden paths indistinguishable from missing", async () => {
  const { base, cookie, close } = await startAuthedApp(["main"], "auth-gate-api-state.json");
  try {
    const appHtml = await (await fetch(`${base}/app`, { headers: { Cookie: cookie } })).text();
    const csrf = appHtml.match(/name="csrf-token" content="([^"]+)"/)[1];

    // A cross-Vault path traversal must not publish the research note.
    const traversal = await fetch(`${base}/api/web/v1/publish`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ action: "publish", path: "../research/Secret.md", vaultId: "research" }),
    });
    const traversalBody = await traversal.text();
    assert.equal(traversal.status, 400);
    assert.doesNotMatch(traversalBody, /TOP SECRET|cross-vault-must-not-leak/);
    assert.doesNotMatch(traversalBody, new RegExp(escapeRegExp(research)));
    assert.deepEqual(await new PublishService({ file: path.join(data, "publish", "auth-gate-api-state.json") }).list(), []);

    // Forbidden path vs missing path: same status and body, no filesystem root leak.
    const forbiddenStatus = await fetch(`${base}/api/web/v1/publish?path=${encodeURIComponent("../research/Secret.md")}`, { headers: { Cookie: cookie } });
    const missingStatus = await fetch(`${base}/api/web/v1/publish?path=${encodeURIComponent("Does-not-exist.md")}`, { headers: { Cookie: cookie } });
    const forbiddenBody = await forbiddenStatus.text();
    const missingBody = await missingStatus.text();
    assert.equal(forbiddenStatus.status, missingStatus.status);
    assert.equal(forbiddenBody, missingBody);
    assert.doesNotMatch(forbiddenBody, new RegExp(escapeRegExp(vaultsRoot)));
    assert.doesNotMatch(missingBody, new RegExp(escapeRegExp(vaultsRoot)));
    assert.doesNotMatch(missingBody, /Does-not-exist/);
  } finally {
    await close();
  }
});
