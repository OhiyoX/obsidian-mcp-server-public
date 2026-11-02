import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-session-routes-"));
const vaultsRoot = path.join(root, "vaults");
const main = path.join(vaultsRoot, "main");
const research = path.join(vaultsRoot, "research");
const data = path.join(root, "data");
await fs.mkdir(path.join(main, ".obsidian"), { recursive: true });
await fs.mkdir(path.join(research, ".obsidian"), { recursive: true });
await fs.writeFile(path.join(main, "Note.md"), "# Main note\n", "utf8");
process.env.VAULT_PATH = main;
process.env.WEB_VAULTS_ROOT = vaultsRoot;
process.env.WEB_DEFAULT_VAULT = "main";
process.env.DATA_PATH = data;
delete process.env.OBSIDIAN_READ_ONLY;

const [{ createWebAppRouter }, { createWebSessionStore }] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/web-session-store.js"),
]);

test.after(async () => fs.rm(root, { recursive: true, force: true }));

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
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out closing Web session test server")), HTTP_TIMEOUT_MS)),
  ]);
}

function makeClock(start = 2_000_000) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms) => { state.t += ms; }, state };
}

function makeIo(failRef, method = "open") {
  return {
    ...fs,
    [method]: async (...args) => {
      if (failRef.next) {
        failRef.next = false;
        throw Object.assign(new Error("simulated persistence failure"), { code: "EIO" });
      }
      return fs[method](...args);
    },
  };
}

async function boot({ userRef, clock = makeClock(), failRef = { next: false }, ioMethod = "open", storeFile } = {}) {
  const file = storeFile || path.join(data, `sessions-${Math.random().toString(16).slice(2)}.json`);
  const store = createWebSessionStore({ file, now: clock.now, io: makeIo(failRef, ioMethod) });
  await store.ready;
  const provider = {
    authenticateOAuthUser: async (username, password) => username === "owner" && password === "password" ? userRef.user : null,
    oauthUserSessionRecord: async (id) => (userRef.user && id === userRef.user.id && !userRef.user.disabledAt ? userRef.user : null),
    updateOAuthUser: async (id, { allowedVaults }) => {
      userRef.user = { ...userRef.user, allowedVaults, updatedAt: `v${Number(userRef.user.updatedAt.slice(1)) + 1}` };
      return { user: userRef.user, revokedClientIds: [] };
    },
    recordAudit() {},
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
    base, store, clock, failRef, provider,
    close: () => closeHttpServer(server),
    async login() {
      const response = await boundedFetch(`${base}/auth/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "owner", password: "password" }),
      });
      const setCookie = response.headers.get("set-cookie");
      const cookie = setCookie ? setCookie.split(";", 1)[0] : null;
      let csrf = null;
      if (cookie) {
        const page = await boundedFetch(`${base}/app`, { headers: { Cookie: cookie } });
        csrf = (await page.text()).match(/name="csrf-token" content="([^"]+)"/)?.[1] || null;
      }
      return { response, cookie, csrf };
    },
  };
}

function makeUser(overrides = {}) {
  return {
    id: "user-1",
    username: "owner",
    displayName: "Owner",
    updatedAt: "v1",
    allowedScopes: ["obsidian.read", "obsidian.write"],
    allowedVaults: ["main", "research"],
    ...overrides,
  };
}

test("login does not emit a cookie and leaves no session when the durable create fails", async () => {
  const userRef = { user: makeUser() };
  const failRef = { next: true };
  const app = await boot({ userRef, failRef });
  try {
    const { response, cookie } = await app.login();
    assert.equal(response.status, 503);
    assert.equal(cookie, null);
    assert.equal(app.store.activeCount(), 0);
    assert.equal((await boundedFetch(`${app.base}/api/web/v1/session`)).status, 401);
  } finally {
    await app.close();
  }
});

test("logout clears the cookie only after a durable delete and the same cookie is 401 afterwards", async () => {
  const userRef = { user: makeUser() };
  const app = await boot({ userRef });
  try {
    const { cookie, csrf } = await app.login();
    assert.ok(cookie && csrf);
    assert.equal((await boundedFetch(`${app.base}/api/web/v1/session`, { headers: { Cookie: cookie } })).status, 200);
    const logout = await boundedFetch(`${app.base}/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(logout.status, 303);
    assert.match(logout.headers.get("set-cookie") || "", /obsidian_web_session=;/);
    assert.equal((await boundedFetch(`${app.base}/api/web/v1/session`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    await app.close();
  }
});

test("a failed durable logout delete returns an error, denies immediately, and retries on the next drain", async () => {
  const userRef = { user: makeUser() };
  const failRef = { next: false };
  const app = await boot({ userRef, failRef });
  try {
    const { cookie, csrf } = await app.login();
    assert.ok(cookie && csrf);
    failRef.next = true;
    const logout = await boundedFetch(`${app.base}/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(logout.status, 503);
    assert.equal((await boundedFetch(`${app.base}/api/web/v1/session`, { headers: { Cookie: cookie } })).status, 401);
    const drained = await app.store.drain();
    assert.equal(drained.ok, true);
    assert.equal(app.store.activeCount(), 0);
  } finally {
    await app.close();
  }
});

test("vault select durable failure returns 503 and keeps the committed vault", async () => {
  const userRef = { user: makeUser() };
  const failRef = { next: false };
  const app = await boot({ userRef, failRef, ioMethod: "rename" });
  try {
    const { cookie, csrf } = await app.login();
    assert.ok(cookie && csrf);
    failRef.next = true;
    const selected = await boundedFetch(`${app.base}/api/web/v1/vault/select`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ id: "research" }),
    });
    assert.equal(selected.status, 503);
    const probe = await boundedFetch(`${app.base}/api/web/v1/session`, { headers: { Cookie: cookie } });
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).vaultId, "main");
  } finally {
    await app.close();
  }
});

test("vault create provider success plus session persist failure is a non-atomic failure that fails closed later", async () => {
  const userRef = { user: makeUser() };
  const failRef = { next: false };
  const app = await boot({ userRef, failRef, ioMethod: "rename" });
  try {
    const { cookie, csrf } = await app.login();
    assert.ok(cookie && csrf);
    failRef.next = true;
    const created = await boundedFetch(`${app.base}/api/web/v1/vault`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ name: "newvault" }),
    });
    assert.equal(created.status, 503);
    assert.equal(userRef.user.updatedAt, "v2");
    const probe = await boundedFetch(`${app.base}/api/web/v1/session`, { headers: { Cookie: cookie } });
    assert.equal(probe.status, 401);
  } finally {
    await app.close();
  }
});

test("the request-side overdue fence forces a durable checkpoint before an authenticated success", async () => {
  const userRef = { user: makeUser() };
  const clock = makeClock();
  const failRef = { next: false };
  const app = await boot({ userRef, clock, failRef });
  try {
    const { cookie } = await app.login();
    assert.ok(cookie);
    clock.advance(61_000);
    const probe = await boundedFetch(`${app.base}/api/web/v1/session`, { headers: { Cookie: cookie } });
    assert.equal(probe.status, 200);
    const disk = JSON.parse(await fs.readFile(app.store.file, "utf8"));
    assert.equal(Object.keys(disk.sessions).length, 1);
  } finally {
    await app.close();
  }
});

test("a failed overdue checkpoint returns 503 instead of a successful renewal", async () => {
  const userRef = { user: makeUser() };
  const clock = makeClock();
  const failRef = { next: false };
  const app = await boot({ userRef, clock, failRef });
  try {
    const { cookie } = await app.login();
    assert.ok(cookie);
    clock.advance(61_000);
    failRef.next = true;
    const probe = await boundedFetch(`${app.base}/api/web/v1/session`, { headers: { Cookie: cookie } });
    assert.equal(probe.status, 503);
  } finally {
    await app.close();
  }
});

test("disabled, deleted and revision-mismatched provider users fail closed and delete the session", async () => {
  for (const mutation of ["disabled", "deleted", "revision"]) {
    const userRef = { user: makeUser() };
    const app = await boot({ userRef });
    try {
      const { cookie } = await app.login();
      assert.ok(cookie);
      if (mutation === "disabled") userRef.user = { ...userRef.user, disabledAt: new Date().toISOString() };
      if (mutation === "deleted") userRef.user = null;
      if (mutation === "revision") userRef.user = { ...userRef.user, updatedAt: "v2" };
      const probe = await boundedFetch(`${app.base}/api/web/v1/session`, { headers: { Cookie: cookie } });
      assert.equal(probe.status, 401, mutation);
      assert.equal(app.store.activeCount(), 0, mutation);
    } finally {
      await app.close();
    }
  }
});

test("a removed write scope denies the write route and a removed vault cannot be reached", async () => {
  const userRef = { user: makeUser() };
  const app = await boot({ userRef });
  try {
    const { cookie, csrf } = await app.login();
    assert.ok(cookie && csrf);
    userRef.user = { ...userRef.user, allowedScopes: ["obsidian.read"] };
    const denied = await boundedFetch(`${app.base}/api/web/v1/vault`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ name: "blocked" }),
    });
    assert.equal(denied.status, 403);
    userRef.user = { ...userRef.user, allowedVaults: ["research"] };
    const probe = await boundedFetch(`${app.base}/api/web/v1/session`, { headers: { Cookie: cookie } });
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).vaultId, "research");
  } finally {
    await app.close();
  }
});
