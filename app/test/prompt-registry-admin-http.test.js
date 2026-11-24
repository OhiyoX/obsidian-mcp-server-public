// P1 Task 5: the publishing API, behind the console's own session and CSRF.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createAdminRouter } from "../src/admin/router.js";
import { bundledBasePack } from "../src/prompt-registry/bundled.js";
import { createPromptAdminService } from "../src/prompt-registry/service.js";
import { createPromptRegistryStore } from "../src/prompt-registry/store.js";

const PASSWORD = "test-only-admin-password";
const PACK_ROOT = new URL("../prompts/base/", import.meta.url).pathname;
const bundled = bundledBasePack();
const firstKey = Object.keys(bundled.values).sort()[0];

function providerStub(audit = []) {
  return {
    ready: Promise.resolve(),
    recordAudit: (entry) => void audit.push(entry),
    async authorizationSnapshot() {
      return { oauthUsers: [], clients: [], apiKeys: [], tokens: [], audit: [], configuredApiKeyUsage: { lastUsedAt: null, lastSource: null } };
    },
  };
}

/** The real Admin router plus a real Registry store, over a real socket. */
async function start(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "prompt-admin-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createPromptRegistryStore({
    headFile: path.join(dir, "agent-prompts.json"),
    packsDir: path.join(dir, "packs"),
    bundledBase: bundled,
  });
  await store.ready;
  const audit = [];
  const service = createPromptAdminService({ store, bundledBase: bundled, audit: async (entry) => void audit.push(entry) });

  const app = express();
  app.use("/admin/auth", createAdminRouter({
    provider: providerStub(audit),
    adminPassword: PASSWORD,
    secureCookie: false,
    promptRegistryStore: store,
    promptAdminService: service,
  }));
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${origin}/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: "manual",
  });
  assert.equal(login.status, 303);
  const setCookies = typeof login.headers.getSetCookie === "function"
    ? login.headers.getSetCookie()
    : [login.headers.get("set-cookie")];
  const cookie = setCookies.filter(Boolean).map((item) => item.split(";")[0]).join("; ");
  return { store, service, audit, origin, cookie };
}

/** The shipped pack as the API receives it: manifest + one text per file. */
async function packBody(root = PACK_ROOT) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const files = {};
  const walk = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else if (entry.name.endsWith(".md")) files[relative] = await readFile(path.join(directory, entry.name), "utf8");
    }
  };
  await walk(root);
  return { manifest, files };
}

async function jsonPost({ origin, cookie }, route, body, { csrf } = {}) {
  return fetch(`${origin}/admin/auth/prompt-registry${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ csrf, ...body }),
    redirect: "manual",
  });
}

test("the state endpoint answers only an Admin session", async (t) => {
  const { origin } = await start(t);
  const anonymous = await fetch(`${origin}/admin/auth/prompt-registry/state`, { redirect: "manual" });
  assert.equal(anonymous.status, 303, "no session redirects to login, like every Admin page");
  assert.match(anonymous.headers.get("location"), /login/);
});

test("the session endpoint hands out the CSRF token for a JSON client", async (t) => {
  const { origin, cookie } = await start(t);
  const response = await fetch(`${origin}/admin/auth/prompt-registry/session`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.csrf, "string");
  assert.ok(body.csrf.length > 10);
  assert.equal(body.revision, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a logged-in publish needs CSRF, then commits a new revision", async (t) => {
  const { origin, cookie, store, audit } = await start(t);
  const session = await (await fetch(`${origin}/admin/auth/prompt-registry/session`, { headers: { cookie } })).json();
  const pack = await packBody();

  const noCsrf = await jsonPost({ origin, cookie }, "/base/publish", { expectedRevision: 0, reason: "unit", pack });
  assert.equal(noCsrf.status, 403);

  const publish = await jsonPost({ origin, cookie }, "/base/publish", { expectedRevision: 0, reason: "unit", pack }, { csrf: session.csrf });
  assert.equal(publish.status, 200);
  const body = await publish.json();
  assert.equal(body.revision, 1);
  assert.equal(body.state.revision, 1);
  assert.equal(store.snapshot().revision, 1);
  assert.ok(audit.some((entry) => entry.action === "base.publish" && entry.outcome === "success"));
});

test("stale revisions are 409, invalid packs are 422, and neither changes anything", async (t) => {
  const { origin, cookie, store } = await start(t);
  const session = await (await fetch(`${origin}/admin/auth/prompt-registry/session`, { headers: { cookie } })).json();
  const pack = await packBody();

  const invalid = await jsonPost({ origin, cookie }, "/base/publish", { expectedRevision: 0, reason: "unit", pack: { values: {} } }, { csrf: session.csrf });
  assert.equal(invalid.status, 422);

  const first = await jsonPost({ origin, cookie }, "/base/publish", { expectedRevision: 0, reason: "unit", pack }, { csrf: session.csrf });
  assert.equal(first.status, 200);

  const stale = await jsonPost({ origin, cookie }, "/base/publish", { expectedRevision: 0, reason: "unit", pack }, { csrf: session.csrf });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "PROMPT_STALE_REVISION");
  assert.equal(store.snapshot().revision, 1);
});

test("GET never changes the revision and exposes no prompt text", async (t) => {
  const { origin, cookie, store } = await start(t);
  const before = store.snapshot().revision;
  const response = await fetch(`${origin}/admin/auth/prompt-registry/state`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.revision, before);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(bundled.values[firstKey]), false);
  assert.equal(serialized.includes(PASSWORD), false);
  for (const field of ["status", "revision", "baseDigest", "bundledBaseDigest", "effectiveDigest", "overrideCount", "history"]) {
    assert.ok(Object.hasOwn(body, field), field);
  }
});

test("preview reports the diff without publishing", async (t) => {
  const { origin, cookie, store } = await start(t);
  const session = await (await fetch(`${origin}/admin/auth/prompt-registry/session`, { headers: { cookie } })).json();
  const pack = await packBody();
  const response = await jsonPost({ origin, cookie }, "/base/preview", { pack }, { csrf: session.csrf });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.valid, true);
  assert.deepEqual(body.diff.changedKeys, [], "the shipped pack equals the bundled one");
  assert.equal(store.snapshot().revision, 0);
});

test("rollback and adopt-bundled stay behind the same guards", async (t) => {
  const { origin, cookie, store } = await start(t);
  const session = await (await fetch(`${origin}/admin/auth/prompt-registry/session`, { headers: { cookie } })).json();
  const pack = await packBody();
  await jsonPost({ origin, cookie }, "/base/publish", { expectedRevision: 0, reason: "unit", pack }, { csrf: session.csrf });

  const adopt = await jsonPost({ origin, cookie }, "/base/adopt-bundled", { expectedRevision: 1, reason: "back to shipped" }, { csrf: session.csrf });
  assert.equal(adopt.status, 200);
  assert.equal(store.snapshot().revision, 2);

  const rollback = await jsonPost({ origin, cookie }, "/rollback", { expectedRevision: 2, targetRevision: 1, reason: "unit" }, { csrf: session.csrf });
  assert.equal(rollback.status, 200);
  assert.equal(store.snapshot().revision, 3);

  const unknown = await jsonPost({ origin, cookie }, "/rollback", { expectedRevision: 3, targetRevision: 99, reason: "unit" }, { csrf: session.csrf });
  assert.equal(unknown.status, 404);
});

test("a publish without a reason is refused by the service", async (t) => {
  const { origin, cookie, store } = await start(t);
  const session = await (await fetch(`${origin}/admin/auth/prompt-registry/session`, { headers: { cookie } })).json();
  const pack = await packBody();
  const response = await jsonPost({ origin, cookie }, "/base/publish", { expectedRevision: 0, pack }, { csrf: session.csrf });
  assert.equal(response.status, 400);
  assert.equal(store.snapshot().revision, 0);
});
