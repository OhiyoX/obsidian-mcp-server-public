// 主体侧栏的定时授权配置（2026-10-31 owner request）— Key / OAuth 客户端 / 账户 的详情抽屉里
// 能直接看到这个主体命中的规则，并「应用已有规则」。
//
// Everything runs against the real stack: a real access-policy store in a temp dir, the real runtime,
// the real Admin service and the real `createAdminRouter` over a real Express listener; the provider
// is a deterministic credential snapshot stub (the pages only consume that snapshot).
//
// What is pinned:
//   1. all three subject drawers render the section with their own subject id and tab;
//   2. the apply form is a real POST carrying the session CSRF and a 303 comes back to that drawer;
//   3. attaching touches *nothing but* the subject list (window, capabilities, mode, enabled, label
//      survive; the revision moves), and re-applying is a no-op;
//   4. every refusal (stale CAS, unknown policy, unknown subject, missing CSRF) writes nothing and
//      says so instead of claiming success;
//   5. `?new=1&subject=…` pre-fills the editor with a subject this request already knows;
//   6. a negative control proving the structural assertions can actually go red.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

import express from "express";

import { createAdminRouter } from "../../src/admin/router.js";
import { createAccessPolicyAdmin } from "../../src/admin/access-policy.js";
import { createAccessPolicyRuntime } from "../../src/access-policy/runtime.js";
import { createAccessPolicyStore } from "../../src/access-policy/store.js";

const ADMIN_PASSWORD = "subject-authz-admin-password";
const BASE = "/admin/auth/access-policy";
const KEY_SUBJECT = "api-key:key-1";
const CLIENT_SUBJECT = "oauth-client:client-1";
const USER_SUBJECT = "oauth-user:u-1";

function snapshot() {
  return {
    apiKeys: [{
      id: "key-1", label: "研究机器人", prefix: "obmcp_abcd", allowedScopes: ["obsidian.read"],
      allowedVaults: ["default"], createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, lastSource: null,
    }],
    clients: [{ clientId: "client-1", clientName: "ChatGPT Connector", redirectUris: [], connectionOrigins: [], createdAt: null, lastUsedAt: null, lastSource: null }],
    oauthUsers: [{ id: "u-1", username: "bob", displayName: "Bob Li", allowedScopes: [], allowedVaults: [], createdAt: null, lastLoginAt: null }],
    tokens: [],
    audit: [],
    configuredApiKeyUsage: { lastUsedAt: null, lastSource: null },
  };
}

function makeProvider(state) {
  return {
    ready: Promise.resolve(),
    audits: [],
    recordAudit(event) { this.audits.push(event); },
    async authorizationSnapshot() { return state.snapshot; },
  };
}

async function startFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "admin-redo-subject-authz-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createAccessPolicyStore({ file: path.join(dir, "access-policy.json") });
  await store.ready;
  const runtime = createAccessPolicyRuntime({ enabled: true, store });
  await runtime.ready;
  const admin = createAccessPolicyAdmin({ store, runtime });
  const provider = makeProvider({ snapshot: snapshot() });
  provider.accessRuntime = runtime;
  const app = express();
  app.use("/admin/auth", createAdminRouter({ provider, adminPassword: ADMIN_PASSWORD, secureCookie: false, accessPolicyAdmin: admin }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/admin/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 303, "the fixture login must succeed");
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  return { origin, cookie, store, admin, runtime };
}

async function get(origin, cookie, urlPath) {
  const response = await fetch(`${origin}${urlPath}`, { headers: { cookie }, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}

async function post(origin, cookie, urlPath, fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item ?? ""));
  }
  const response = await fetch(`${origin}${urlPath}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: params.toString(),
  });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}

function csrfOf(body) {
  const match = /name="csrf" value="([^"]+)"/.exec(body);
  assert.ok(match, "the page must expose a CSRF token");
  return match[1];
}

function formFields(overrides = {}) {
  return {
    label: "研究机器人仅工作时间",
    enabled: ["false", "true"],
    mode: "suspend",
    timezone: "Asia/Shanghai",
    subjects: [KEY_SUBJECT],
    capabilities: ["scope:obsidian.read"],
    w_mon_from_1: "09:00", w_mon_to_1: "18:00",
    ...overrides,
  };
}

/** Create the canonical policy (subject = the Key) and bring back its id + the stored document. */
async function createPolicy(origin, cookie, overrides = {}) {
  const csrf = csrfOf((await get(origin, cookie, `${BASE}?new=1`)).body);
  const created = await post(origin, cookie, `${BASE}/create`, { csrf, ...formFields(overrides) });
  assert.equal(created.status, 303, `create must redirect, got ${created.status}: ${created.body.slice(0, 400)}`);
  const list = (await get(origin, cookie, BASE)).body;
  const id = /[?&]id=([0-9a-f-]{36})/.exec(list)?.[1] ?? null;
  assert.ok(id, "the created policy must expose its id");
  return id;
}

async function storedPolicy(store, id) {
  const current = store.snapshot();
  return current.policies.find((policy) => policy.id === id) ?? null;
}

// ------------------------------------------------------------------ structure

/** The section contract, kept as a function so the negative control can run the same assertions. */
function assertSubjectSection(html, { subject, tab, subjectId, appliedLabel = "研究机器人仅工作时间", candidateLabel = "客户端仅午休" }) {
  assert.match(html, /<div class="dsec" id="authz"><h3>定时授权<\/h3>/, "the drawer carries the 定时授权 section");
  assert.match(html, /只在这个主体已有的权限上再加限制，不会放大权限/, "the section states the restriction direction");
  assert.ok(html.includes(`name="subject" value="${subject}"`), `the form carries this page's subject (${subject})`);
  assert.ok(html.includes(`name="tab" value="${tab}"`), `the form carries the tab it must return to (${tab})`);
  assert.ok(html.includes(`name="subjectId" value="${subjectId}"`), `the form carries the drawer id it must return to (${subjectId})`);
  assert.match(html, /<form class="inline-form form-block" method="post" action="\/admin\/auth\/access-policy\/subjects">/, "applying is a real POST form");
  assert.match(html, /<input type="hidden" name="expectedRevision" value="\d+">/, "the form carries the CAS revision it rendered with");
  assert.match(html, new RegExp(`<option value="">选一条已有规则…</option>`), "the picker starts empty and never preselects a rule");
  assert.ok(html.includes(candidateLabel), "a rule that does not yet carry the subject is offered");
  assert.match(html, /新建规则/, "the section links to the editor for a brand-new rule");
  assert.match(html, /[?&]new=1&(?:amp;)?subject=/, "the new-rule link prefills the subject");
  assert.ok(appliedLabel ? html.includes(appliedLabel) : true, "an applied rule is listed by its label");
  assert.doesNotMatch(html, /<script(?![^>]*src="\/admin\/auth\/assets\/)/i, "the drawer adds no script");
  assert.doesNotMatch(html, /[\s"']on(?:click|change|input|submit|load|error)\s*=/i, "no inline handlers");
}

test("all three subject drawers render the 定时授权 section with their own subject and tab", async (t) => {
  const { origin, cookie } = await startFixture(t);
  // Two rules so every drawer has both halves: one that already carries the subject (the applied
  // list) and one that does not (the 应用已有规则 picker).
  await createPolicy(origin, cookie, { label: "研究机器人仅工作时间" });
  await createPolicy(origin, cookie, { label: "客户端仅午休", subjects: [CLIENT_SUBJECT] });

  const keys = await get(origin, cookie, "/admin/auth?tab=keys&id=key-1");
  assert.equal(keys.status, 200);
  assertSubjectSection(keys.body, { subject: KEY_SUBJECT, tab: "keys", subjectId: "key-1" });

  const clients = await get(origin, cookie, "/admin/auth?tab=clients&id=client-1");
  assert.equal(clients.status, 200);
  assertSubjectSection(clients.body, {
    subject: CLIENT_SUBJECT, tab: "clients", subjectId: "client-1",
    appliedLabel: "客户端仅午休", candidateLabel: "研究机器人仅工作时间",
  });

  const accounts = await get(origin, cookie, "/admin/auth?tab=accounts&id=u-1");
  assert.equal(accounts.status, 200);
  assert.match(accounts.body, /不受定时授权限制/, "a subject no rule names is reported as unrestricted");
  assertSubjectSection(accounts.body, { subject: USER_SUBJECT, tab: "accounts", subjectId: "u-1", appliedLabel: "" });
});

test("negative control: the structural assertions are not vacuous", async (t) => {
  const { origin, cookie } = await startFixture(t);
  const emptyDrawer = await get(origin, cookie, "/admin/auth?tab=keys&id=key-1");
  assert.match(emptyDrawer.body, /不受定时授权限制/, "with no policy the drawer says so");
  assert.match(emptyDrawer.body, /没有其他可应用的规则/, "and offers only the new-rule link");
  assert.throws(
    () => assertSubjectSection(emptyDrawer.body, { subject: CLIENT_SUBJECT, tab: "keys", subjectId: "key-1" }),
    /the form carries this page's subject/,
    "the same assertions must reject the wrong subject",
  );
  await createPolicy(origin, cookie, { label: "研究机器人仅工作时间" });
  await createPolicy(origin, cookie, { label: "客户端仅午休", subjects: [CLIENT_SUBJECT] });
  const filled = await get(origin, cookie, "/admin/auth?tab=keys&id=key-1");
  assert.throws(
    () => assertSubjectSection(filled.body, { subject: KEY_SUBJECT, tab: "clients", subjectId: "key-1" }),
    /return to \(clients\)/,
  );
});

// ------------------------------------------------------------------ behaviour

test("applying an existing rule attaches the subject and changes nothing else", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const before = await storedPolicy(store, id);
  const revisionBefore = store.snapshot().revision;

  const drawer = await get(origin, cookie, "/admin/auth?tab=clients&id=client-1");
  const csrf = csrfOf(drawer.body);
  const applied = await post(origin, cookie, `${BASE}/subjects`, {
    csrf, id, subject: CLIENT_SUBJECT, tab: "clients", subjectId: "client-1", expectedRevision: revisionBefore,
  });
  assert.equal(applied.status, 303, `attach must redirect, got ${applied.status}: ${applied.body.slice(0, 300)}`);
  assert.equal(applied.location, "/admin/auth?tab=clients&id=client-1&done=authz-attach", "the redirect returns to the drawer it came from");

  const after = await storedPolicy(store, id);
  assert.deepEqual(after.subjects.slice().sort(), [CLIENT_SUBJECT, KEY_SUBJECT].sort(), "the subject is added");
  for (const field of ["label", "enabled", "mode", "timezone", "capabilities", "weekly", "dateRanges", "startsAt", "expiresAt", "createdAt"]) {
    assert.deepEqual(after[field], before[field], `attaching must not touch ${field}`);
  }
  assert.notEqual(after.updatedAt, before.updatedAt, "the write is stamped");
  assert.equal(store.snapshot().revision, revisionBefore + 1, "the revision moves exactly once");

  const back = await get(origin, cookie, applied.location);
  assert.match(back.body, /已把这个主体加入所选规则/, "the drawer confirms the write");
});

test("re-applying an already attached subject is a no-op, not a second write", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const revision = store.snapshot().revision;
  const csrf = csrfOf((await get(origin, cookie, "/admin/auth?tab=keys&id=key-1")).body);
  const again = await post(origin, cookie, `${BASE}/subjects`, { csrf, id, subject: KEY_SUBJECT, tab: "keys", subjectId: "key-1", expectedRevision: revision });
  assert.equal(again.status, 303);
  assert.equal(again.location, "/admin/auth?tab=keys&id=key-1&done=authz-attach");
  assert.equal(store.snapshot().revision, revision, "an unchanged policy must not bump the revision");
  assert.deepEqual((await storedPolicy(store, id)).subjects, [KEY_SUBJECT], "and must not duplicate the subject");
});

test("a stale revision is refused, writes nothing and says so", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const revision = store.snapshot().revision;
  // somebody else moves the store first
  await store.replace(revision, store.snapshot().policies.map((policy) => ({ ...policy })));
  const csrf = csrfOf((await get(origin, cookie, "/admin/auth?tab=clients&id=client-1")).body);
  const refused = await post(origin, cookie, `${BASE}/subjects`, { csrf, id, subject: CLIENT_SUBJECT, tab: "clients", subjectId: "client-1", expectedRevision: revision });
  assert.equal(refused.status, 303);
  assert.match(refused.location, /authzError=stale_policy_revision/, "the drawer is told the CAS refused it");
  assert.deepEqual((await storedPolicy(store, id)).subjects, [KEY_SUBJECT], "nothing was written");
  const back = await get(origin, cookie, refused.location);
  assert.match(back.body, /规则在提交前被其他人修改了/, "the message names the real cause");
});

test("an unknown policy or an unknown subject is refused before the write", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const revision = store.snapshot().revision;
  const csrf = csrfOf((await get(origin, cookie, "/admin/auth?tab=clients&id=client-1")).body);

  const missing = await post(origin, cookie, `${BASE}/subjects`, { csrf, id: "00000000-0000-4000-8000-000000000000", subject: CLIENT_SUBJECT, tab: "clients", subjectId: "client-1", expectedRevision: revision });
  assert.match(missing.location, /authzError=unknown_access_policy_id/);

  const ghost = await post(origin, cookie, `${BASE}/subjects`, { csrf, id, subject: "api-key:not-in-the-snapshot", tab: "clients", subjectId: "client-1", expectedRevision: revision });
  assert.match(ghost.location, /authzError=unknown_access_policy_subject/);

  assert.equal(store.snapshot().revision, revision, "neither refusal wrote anything");
  assert.deepEqual((await storedPolicy(store, id)).subjects, [KEY_SUBJECT]);
});

test("the attach endpoint keeps the session CSRF contract", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const revision = store.snapshot().revision;
  const refused = await post(origin, cookie, `${BASE}/subjects`, { csrf: "not-the-token", id, subject: CLIENT_SUBJECT, tab: "clients", subjectId: "client-1", expectedRevision: revision });
  assert.equal(refused.status, 403, "a bad CSRF token must be rejected");
  assert.equal(store.snapshot().revision, revision, "and must not write");
});

test("`?new=1&subject=…` prefills the editor only with a subject this request knows", async (t) => {
  const { origin, cookie } = await startFixture(t);
  const known = await get(origin, cookie, `${BASE}?new=1&subject=${encodeURIComponent(CLIENT_SUBJECT)}`);
  assert.equal(known.status, 200);
  assert.ok(known.body.includes(`value="${CLIENT_SUBJECT}"`), "the known subject arrives as a checked pick");
  assert.match(known.body, /ChatGPT Connector/, "and is spelled out by name");

  const unknown = await get(origin, cookie, `${BASE}?new=1&subject=${encodeURIComponent("api-key:not-in-the-snapshot")}`);
  assert.equal(unknown.status, 200);
  assert.ok(!unknown.body.includes('value="api-key:not-in-the-snapshot"'), "an unknown subject is never seeded");
});
