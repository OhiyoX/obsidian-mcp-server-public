// Plan Task 5 — the Admin write routes for per-Vault constraints.
//
// The acceptance set is the plan's Step 1, one case per assertion: a create redirects back to the
// base and stores the Vault scope, a losing CAS answers 409 *with the draft*, an unknown Vault
// answers 400 and names it, the plane switch writes `timeConstraintsEnabled`, a delete removes the
// constraint, and no POST is reachable without its CSRF field. Every case runs through the real
// `createAdminRouter` — a stub middleware cannot prove that `requireAdmin`/`requireCsrf` come first.
//
// The last case pins the six catalog rows: the boundary table must name every route this module
// registers — the page and its five writes — on `admin_authorization_manage`, or the permission
// matrix loses them.

import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createAdminRouter } from "../src/admin/router.js";
import { registerAuthorizationRoutes } from "../src/admin/routes/authz.js";
import { AUTHORIZATION_CATALOG_VERSION, capabilityForBoundary } from "../src/authorization/catalog.js";
import { createConstraintAdmin } from "../src/authorization/constraint-admin.js";
import { serializeAuthorizationDocument } from "../src/authorization/schema.js";
import { createAuthorizationStore } from "../src/authorization/store.js";

const BASE = "/admin/auth/authz";
const PASSWORD = "test-only-admin-password";
const SUBJECT = "oauth-user:user-1";
const STAMP = "2026-11-01T00:00:00.000Z";

const io = {
  mkdir: (target, options) => mkdir(target, options),
  readFile: (target) => readFile(target),
  open: (target, flags, mode) => open(target, flags, mode),
  rename: (from, to) => rename(from, to),
  unlink: (target) => unlink(target),
  chmod: (target, mode) => chmod(target, mode),
};

/** The Admin routes a constraint write can reach, in the order the plan lists them. */
const ENDPOINTS = Object.freeze(["create", "update", "toggle", "delete", "plane"]);

function document() {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 1,
    timeConstraintsEnabled: true,
    subjects: {},
    constraints: [],
  };
}

function providerStub() {
  return {
    ready: Promise.resolve(),
    recordAudit: () => {},
    async authorizationSnapshot() {
      return { oauthUsers: [], clients: [], apiKeys: [], tokens: [], audit: [], configuredApiKeyUsage: { lastUsedAt: null, lastSource: null } };
    },
  };
}

/** The real Admin router over a real constraint store, a real login and a real CSRF token. */
async function start(t, { withService = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "admin-authz-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "authorization.json");
  await writeFile(file, serializeAuthorizationDocument(document()));
  const store = createAuthorizationStore({ file, io });
  await store.ready;
  const service = createConstraintAdmin({ store, vaultIds: ["a", "b"], now: () => STAMP });

  const app = express();
  app.use("/admin/auth", createAdminRouter({
    provider: providerStub(),
    adminPassword: PASSWORD,
    secureCookie: false,
    ...(withService ? { authorizationAdmin: service } : {}),
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
  assert.equal(login.status, 303, "the admin password must log in");
  const setCookies = typeof login.headers.getSetCookie === "function"
    ? login.headers.getSetCookie()
    : [login.headers.get("set-cookie")];
  const cookie = setCookies.filter(Boolean).map((item) => item.split(";")[0]).join("; ");
  const page = await fetch(`${origin}/admin/auth`, { headers: { cookie }, redirect: "manual" });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(csrf, "the Auth Center page must expose a CSRF token");
  return { store, service, origin, cookie, csrf };
}

function form(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item ?? "");
  }
  return params;
}

async function post({ origin, cookie }, endpoint, fields) {
  const response = await fetch(`${origin}${BASE}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: form(fields),
    redirect: "manual",
  });
  return { response, body: await response.text() };
}

/** The same POST, made the way a browser makes it: it asks for a page, not for JSON. */
async function postHtml(harness, endpoint, fields) {
  const response = await fetch(`${harness.origin}${BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: harness.cookie,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    body: form(fields),
    redirect: "manual",
  });
  return { response, body: await response.text() };
}

/** The submitted shape a create/update needs; `weekly` uses the frozen editor's weekday grid. */
function draftFields(overrides = {}) {
  return {
    label: "weekday hours",
    subjects: [SUBJECT],
    mode: "suspend",
    capabilities: ["get_note"],
    vaultIds: ["a"],
    timezone: "Asia/Shanghai",
    w_mon_from_0: "09:00",
    w_mon_to_0: "18:00",
    ...overrides,
  };
}

test("create answers 303 to the base and stores the Vault scope", async (t) => {
  const harness = await start(t);
  const { response } = await post(harness, "create", { csrf: harness.csrf, expectedRevision: "1", ...draftFields() });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), BASE, "a form posts back to its own list");
  const document = harness.store.snapshot();
  assert.equal(document.revision, 2);
  const [constraint] = document.document.constraints;
  assert.equal(constraint.subjects.length, 1);
  assert.deepEqual(constraint.selector.anyOf[0].targets, [{ kind: "vault", vaultId: "a" }]);
  assert.deepEqual(constraint.schedule.weekly, { mon: [["09:00", "18:00"]] });
  assert.equal(constraint.schedule.timezone, "Asia/Shanghai");
});

test("vaultIds=all stores targets null, and update/toggle write through the same routes", async (t) => {
  const harness = await start(t);
  const created = await post(harness, "create", { csrf: harness.csrf, expectedRevision: "1", ...draftFields({ vaultIds: ["all"] }) });
  assert.equal(created.response.status, 303);
  const [first] = harness.store.snapshot().document.constraints;
  assert.equal(first.selector.anyOf[0].targets, null, "「全部 Vault」 is targets:null, not a list");

  const updated = await post(harness, "update", {
    csrf: harness.csrf, expectedRevision: "2", id: first.id, ...draftFields({ label: "weekday hours (renamed)" }),
  });
  assert.equal(updated.response.status, 303);
  assert.equal(harness.store.snapshot().document.constraints[0].label, "weekday hours (renamed)");

  const toggled = await post(harness, "toggle", { csrf: harness.csrf, expectedRevision: "3", id: first.id, enabled: "false" });
  assert.equal(toggled.response.status, 303);
  assert.equal(harness.store.snapshot().document.constraints[0].enabled, false);
});

test("a stale revision answers 409 and hands the draft back", async (t) => {
  const harness = await start(t);
  const first = await post(harness, "create", { csrf: harness.csrf, expectedRevision: "1", ...draftFields() });
  assert.equal(first.response.status, 303);

  // The same expectedRevision again: another writer already moved the document to revision 2.
  const stale = await post(harness, "create", { csrf: harness.csrf, expectedRevision: "1", ...draftFields({ label: "second window" }) });
  assert.equal(stale.response.status, 409);
  assert.match(String(stale.response.headers.get("content-type")), /application\/json/);
  const body = JSON.parse(stale.body);
  assert.equal(body.error, "stale_authorization_revision");
  assert.equal(body.draft.label, "second window", "the operator's typing comes back with the refusal");
  assert.deepEqual(body.draft.vaultIds, ["a"]);
  assert.equal(harness.store.snapshot().document.constraints.length, 1, "the losing write stored nothing");
});

test("a browser refusal renders the page with the submitted draft and the current revision", async (t) => {
  const harness = await start(t);
  // A first write moves the document to revision 2; the form below still carries revision 1.
  assert.equal((await post(harness, "create", { csrf: harness.csrf, expectedRevision: "1", ...draftFields() })).response.status, 303);

  const stale = await postHtml(harness, "create", { csrf: harness.csrf, expectedRevision: "1", ...draftFields({ label: "second window", surfaces: ["mcp"] }) });
  assert.equal(stale.response.status, 409, "the operator gets the refusal itself, not a 200 page");
  assert.match(String(stale.response.headers.get("content-type")), /text\/html/);
  assert.match(stale.body, /保存没有生效/, "a plain-words banner says the save did not apply");
  assert.match(stale.body, /当前修订号是 2/, "and names the revision the refusal came from");
  assert.match(stale.body, /name="label" value="second window"/, "the operator's typing is still in the form");
  assert.match(stale.body, /name="surfaces" value="mcp" checked/, "and so is the surface choice, which a blank set would widen to every surface");
  assert.match(stale.body, /name="expectedRevision" value="2"/, "the form carries the CURRENT revision");
  assert.equal(harness.store.snapshot().document.constraints.length, 1, "the refused write still stored nothing");
  assert.doesNotMatch(stale.body, /<script(?![^>]*src="\/admin\/auth\/assets\/)/i, "no inline script on the page");
  assert.doesNotMatch(stale.body, /[\s"']on(?:click|change|input|submit|load|error)\s*=/i, "no inline handlers");

  // One resubmit with the fresh revision succeeds: the page is a way forward, not a dead end.
  const retry = await post(harness, "create", { csrf: harness.csrf, expectedRevision: "2", ...draftFields({ label: "second window" }) });
  assert.equal(retry.response.status, 303);
  assert.deepEqual(harness.store.snapshot().document.constraints.map((constraint) => constraint.label), ["weekday hours", "second window"]);
});

test("a browser refusal names the Vault it could not find, and a delete's refusal states the list", async (t) => {
  const harness = await start(t);
  const unknown = await postHtml(harness, "create", { csrf: harness.csrf, expectedRevision: "1", ...draftFields({ vaultIds: ["not-admitted"] }) });
  assert.equal(unknown.response.status, 400);
  assert.match(unknown.body, /Vault not-admitted 不存在或尚未接入/, "the banner names the Vault by id");
  assert.match(unknown.body, /name="label" value="weekday hours"/, "and the rest of the draft survived");

  // A write that carries no draft renders the list page, with the same plain-words banner.
  const removed = await postHtml(harness, "delete", { csrf: harness.csrf, expectedRevision: "1", id: "11111111-1111-4111-8111-111111111111" });
  assert.equal(removed.response.status, 404);
  assert.match(removed.body, /保存没有生效：这条约束已经不在了/);
  assert.match(removed.body, /data-authorization-mode=/, "the list page is the real page, shell included");
});

test("a client that asks for JSON still gets the JSON body", async (t) => {
  const harness = await start(t);
  assert.equal((await post(harness, "create", { csrf: harness.csrf, expectedRevision: "1", ...draftFields() })).response.status, 303);
  const response = await fetch(`${harness.origin}${BASE}/create`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: harness.cookie, accept: "application/json" },
    body: form({ csrf: harness.csrf, expectedRevision: "1", ...draftFields({ label: "json client" }) }),
    redirect: "manual",
  });
  assert.equal(response.status, 409);
  assert.match(String(response.headers.get("content-type")), /application\/json/);
  const body = JSON.parse(await response.text());
  assert.equal(body.error, "stale_authorization_revision");
  assert.equal(body.draft.label, "json client", "the promise Task 5 made is kept");
});

test("an unknown Vault answers 400 and names the Vault", async (t) => {
  const harness = await start(t);
  const refused = await post(harness, "create", { csrf: harness.csrf, expectedRevision: "1", ...draftFields({ vaultIds: ["b-not-admitted"] }) });

  assert.equal(refused.response.status, 400);
  const body = JSON.parse(refused.body);
  assert.equal(body.error, "unknown_vault");
  assert.equal(body.vaultId, "b-not-admitted", "the refusal names the Vault the operator picked");
  assert.equal(body.path, "vaultIds[0]", "and the field, so the editor can mark it");
  assert.equal(harness.store.snapshot().revision, 1, "nothing was written");
  assert.deepEqual(harness.store.snapshot().document.constraints, []);
});

test("the plane switch answers 303 and writes the document flag", async (t) => {
  const harness = await start(t);
  const switched = await post(harness, "plane", { csrf: harness.csrf, expectedRevision: "1", enabled: "false" });

  assert.equal(switched.response.status, 303);
  assert.equal(switched.response.headers.get("location"), BASE);
  assert.equal(harness.store.snapshot().document.timeConstraintsEnabled, false);

  const back = await post(harness, "plane", { csrf: harness.csrf, expectedRevision: "2", enabled: "true" });
  assert.equal(back.response.status, 303);
  assert.equal(harness.store.snapshot().document.timeConstraintsEnabled, true);
});

test("delete answers 303 and the constraint is gone", async (t) => {
  const harness = await start(t);
  const created = await post(harness, "create", { csrf: harness.csrf, expectedRevision: "1", ...draftFields() });
  assert.equal(created.response.status, 303);
  const [constraint] = harness.store.snapshot().document.constraints;

  const removed = await post(harness, "delete", { csrf: harness.csrf, expectedRevision: "2", id: constraint.id });
  assert.equal(removed.response.status, 303);
  assert.deepEqual(harness.store.snapshot().document.constraints, []);
  assert.equal(harness.store.snapshot().revision, 3);

  // A second delete of the same id is not a silent success.
  const missing = await post(harness, "delete", { csrf: harness.csrf, expectedRevision: "3", id: constraint.id });
  assert.equal(missing.response.status, 404);
  assert.equal(JSON.parse(missing.body).error, "constraint_not_found");
});

test("every POST without the CSRF field answers 403 and writes nothing", async (t) => {
  const harness = await start(t);
  const bodies = {
    create: { expectedRevision: "1", ...draftFields() },
    update: { expectedRevision: "1", id: "11111111-1111-4111-8111-111111111111", ...draftFields() },
    toggle: { expectedRevision: "1", id: "11111111-1111-4111-8111-111111111111", enabled: "false" },
    delete: { expectedRevision: "1", id: "11111111-1111-4111-8111-111111111111" },
    plane: { expectedRevision: "1", enabled: "false" },
  };
  for (const endpoint of ENDPOINTS) {
    const refused = await post(harness, endpoint, { ...bodies[endpoint], csrf: "not-the-token" });
    assert.equal(refused.response.status, 403, `${endpoint} must refuse a wrong token`);
  }
  const snapshot = harness.store.snapshot();
  assert.equal(snapshot.revision, 1, "no refused request moved the document");
  assert.deepEqual(snapshot.document.constraints, []);
  assert.equal(snapshot.document.timeConstraintsEnabled, true);
});

test("no POST is reachable without a session", async (t) => {
  const harness = await start(t);
  const anonymous = await fetch(`${harness.origin}${BASE}/create`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ ...draftFields(), csrf: harness.csrf, expectedRevision: "1" }),
    redirect: "manual",
  });
  assert.equal(anonymous.status, 303, "an unauthenticated write is the login redirect, never a refusal it could learn from");
  assert.equal(anonymous.headers.get("location"), "/admin/auth/login");
  assert.equal(harness.store.snapshot().revision, 1);
});

test("the catalog names a boundary row for each route, the page included", async (t) => {
  // The rows the permission matrix reads: one per registered route, all on the control operation.
  // Task 6 added the page (`GET /authz`), so the pin names it too: a surface that renders the
  // document is a boundary like the writes it offers.
  const router = express.Router();
  const { base } = registerAuthorizationRoutes(router, {
    service: null,
    requireAdmin: (_req, _res, next) => next(),
    requireCsrf: (_req, _res, next) => next(),
  });
  assert.equal(base, BASE);

  const registered = router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
  // The base is mounted at `/admin/auth`, so the router sees `/authz/...` itself.
  const routePath = BASE.slice("/admin/auth".length);
  // One row per registered route: the page and its five writes. Task 7's attach route is gone — the
  // editor's subject picker posts the whole draft to `/update`, so nothing writes from a subject.
  const expected = [`GET ${routePath}`, ...ENDPOINTS.map((endpoint) => `POST ${routePath}/${endpoint}`)];
  assert.deepEqual(registered.sort(), expected.sort());

  assert.equal(capabilityForBoundary(`ADMIN GET /authz`), "admin_authorization_manage");
  assert.equal(capabilityForBoundary("ADMIN POST /authz/subjects"), null, "the removed attach route owns no boundary row");
  for (const endpoint of ENDPOINTS) {
    const boundary = `ADMIN POST /authz/${endpoint}`;
    assert.equal(capabilityForBoundary(boundary), "admin_authorization_manage", boundary);
  }
});

test("with no service the routes answer 503 and leave the manifest row standing", async (t) => {
  // The boundary rows exist whether or not a deployment injected the service, so the surface must
  // answer honestly instead of disappearing: 503 after the same session and CSRF checks as any write.
  const harness = await start(t, { withService: false });
  for (const endpoint of ENDPOINTS) {
    const refused = await post(harness, endpoint, { csrf: harness.csrf, expectedRevision: "1", ...draftFields() });
    assert.equal(refused.response.status, 503, `${endpoint} must answer 503 without a service`);
    assert.equal(JSON.parse(refused.body).error, "authorization_admin_unavailable", endpoint);
  }
  // A wrong token is still refused first, so the 503 is not an oracle either.
  const csrf = await post(harness, "create", { csrf: "not-the-token", expectedRevision: "1", ...draftFields() });
  assert.equal(csrf.response.status, 403);
});

test("a booted server supplies the service: create answers 303 and lands in the document and the audit ring", async (t) => {
  // The only test that proves `server.js` really passes `authorizationAdmin`: everything else uses
  // the router directly. A boot without it would answer 503 here.
  const { freePort, serverEnv, startServer, seedVault, stopChild, waitForAudit } = await import("./helpers/server-spawn-fixtures.js");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "admin-authz-boot-"));
  await seedVault(root);
  const port = await freePort();
  const env = serverEnv({ port, root, extra: { OAUTH_ADMIN_PASSWORD: PASSWORD, AUTHZ_ENABLED: "false" } });
  const server = await startServer(env);
  t.after(async () => {
    await stopChild(server.child);
    await rm(root, { recursive: true, force: true });
  });

  const authorizationFile = path.join(root, "data", "authorization.json");
  const { revision } = JSON.parse(await readFile(authorizationFile, "utf8"));
  assert.equal(revision, 1, "the first boot seeds the durable document once");

  const login = await fetch(`${server.base}/admin/auth/login`, {
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
  const page = await fetch(`${server.base}/admin/auth`, { headers: { cookie }, redirect: "manual" });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(csrf, "the booted Auth Center page must expose a CSRF token");

  const send = (endpoint, fields) => fetch(`${server.base}${BASE}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: form({ csrf, expectedRevision: String(revision), ...fields }),
    redirect: "manual",
  });

  // A Vault id the booted deployment does not admit is refused by name: the admitted list is live.
  const refused = await send("create", draftFields({ vaultIds: ["not-a-vault-of-this-deployment"] }));
  assert.equal(refused.status, 400);
  assert.equal(JSON.parse(await refused.text()).error, "unknown_vault");

  // 「全部 Vault」 needs no id, so the proof of the wiring does not depend on the boot's Vault naming.
  const response = await send("create", draftFields({ vaultIds: ["all"] }));
  const refusal = response.status === 303 ? "" : await response.clone().text();
  assert.equal(response.status, 303, refusal);
  assert.equal(response.headers.get("location"), BASE);

  const stored = JSON.parse(await readFile(authorizationFile, "utf8"));
  assert.equal(stored.revision, 2);
  assert.equal(stored.constraints.length, 1);
  assert.equal(stored.constraints[0].selector.anyOf[0].targets, null, "「全部 Vault」 is targets:null");

  // §6.9: one record in the trail the Admin audit tab reads, and it carries the window, not the
  // subject. The ring is flushed by the provider's own debounced save, so poll like the other
  // audit tests do instead of reading a file the write has not reached yet.
  const audit = await waitForAudit(root, (entries) => entries.some((entry) => entry.action === "authz.constraint.created"));
  const records = audit.filter((entry) => entry.action === "authz.constraint.created");
  assert.equal(records.length, 1, "one audit record per accepted write");
  assert.equal(records[0].credentialType, "admin-session");
  assert.match(records[0].detail, /^rev 2: /);
  // A certain write carries no doubt. The uncertain branch (renamed file, failed directory flush)
  // cannot be fabricated against a booted server on a local filesystem — the store only reaches it
  // when `fsync` on the directory fails — so it is stated as unverified instead of being skipped here.
  assert.equal("durabilityUncertain" in records[0], false, "a durable write carries no doubt");
  assert.equal(JSON.stringify(records[0]).includes("oauth-user:"), false, "the record never carries a subject id");

  // §6.9: a changed window is readable in the trail. Monday 09:00-18:00 becomes Monday-Friday
  // 10:00-11:00, and the record shows both the old and the new hours — the reviewer's probe found
  // that the timezone alone reached the trail, so a previous window could not be reconstructed.
  const weekdays = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"]
    .flatMap((day) => [[`w_${day}_from_0`, "10:00"], [`w_${day}_to_0`, "11:00"]]));
  const changed = await send("update", {
    id: stored.constraints[0].id,
    expectedRevision: String(stored.revision),
    ...draftFields({ vaultIds: ["all"] }),
    ...weekdays,
  });
  assert.equal(changed.status, 303, await changed.clone().text());

  const afterChange = await waitForAudit(root, (entries) => entries.some((entry) => entry.action === "authz.constraint.updated"));
  const [update] = afterChange.filter((entry) => entry.action === "authz.constraint.updated");
  assert.match(update.detail, /mon 09:00-18:00 → /, "the trail shows the window the change replaced");
  assert.match(update.detail, /mon-fri 10:00-11:00/, "equal weekdays collapse to a range, with the new hours");
  assert.equal(/oauth-user:/.test(update.detail), false, "and still no subject id");
});
