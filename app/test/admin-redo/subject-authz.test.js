// 主体侧栏的定时授权（2026-10-31 owner request）— Key / OAuth 客户端 / 账户 的详情抽屉里能直接
// 看到这个主体命中的约束。
//
// Design §6.6 / plan Task 7 item D: the section is read-only on the per-Vault model, and the write
// lives where the document does — the constraint editor's subject picker. Everything runs against the
// real stack: a real constraint document on disk, the real constraint service, the real Admin service
// and the real `createAdminRouter` over a real Express listener; the provider is a deterministic
// credential snapshot stub (the pages only consume that snapshot).
//
// What is pinned:
//   1. all three subject drawers render the section without one control in it, and the applied list
//      names the constraint that carries the subject;
//   2. the section states which backend decides, and follows the mode: in `legacy` it says these
//      constraints are recorded and do not decide, in `enforce` that they do;
//   3. the frozen legacy endpoint stays frozen — a pointer is kept because the two endpoints read
//      almost alike and neither may write from here;
//   4. a negative control proving the structural assertions can actually go red.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createAdminRouter } from "../../src/admin/router.js";
import { AUTHORIZATION_CATALOG_VERSION } from "../../src/authorization/catalog.js";
import { createConstraintAdmin } from "../../src/authorization/constraint-admin.js";
import { serializeAuthorizationDocument } from "../../src/authorization/schema.js";
import { createAuthorizationStore } from "../../src/authorization/store.js";

const ADMIN_PASSWORD = "subject-authz-admin-password";
const BASE = "/admin/auth/authz";
const KEY_SUBJECT = "api-key:key-1";
const CLIENT_SUBJECT = "oauth-client:client-1";
const USER_SUBJECT = "oauth-user:u-1";
const STAMP = "2026-11-01T00:00:00.000Z";

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

/** One stored suspend constraint: Monday 09:00-18:00, `get_note` on Vault "default". */
function constraint({ id, label, subjects, mode = "suspend", capabilities = ["get_note"], vaultIds = ["default"] }) {
  return {
    id,
    label,
    enabled: true,
    subjects,
    mode,
    selector: {
      anyOf: [mode === "revoke"
        ? { surfaces: null, capabilities: null, targets: null }
        : {
          surfaces: null,
          capabilities,
          targets: vaultIds === null ? null : vaultIds.map((vaultId) => ({ kind: "vault", vaultId })),
        }],
    },
    schedule: {
      timezone: "Asia/Shanghai",
      weekly: { mon: [["09:00", "18:00"]] },
      dateRanges: [],
      startsAt: null,
      expiresAt: null,
    },
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

const KEY_CONSTRAINT = "11111111-1111-4111-8111-111111111111";
const CLIENT_CONSTRAINT = "22222222-2222-4222-8222-222222222222";

async function startFixture(t, { mode = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "admin-redo-subject-authz-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "authorization.json");
  await writeFile(file, serializeAuthorizationDocument({
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 5,
    timeConstraintsEnabled: true,
    subjects: {},
    constraints: [
      constraint({ id: KEY_CONSTRAINT, label: "研究机器人仅工作时间", subjects: [KEY_SUBJECT] }),
      constraint({ id: CLIENT_CONSTRAINT, label: "客户端仅午休", subjects: [CLIENT_SUBJECT], vaultIds: null }),
    ],
  }));
  const fs = await import("node:fs/promises");
  const store = createAuthorizationStore({
    file,
    io: { mkdir: fs.mkdir, readFile: fs.readFile, open: fs.open, rename: fs.rename, unlink: fs.unlink, chmod: fs.chmod },
  });
  await store.ready;
  const service = createConstraintAdmin({ store, vaultIds: ["default"], now: () => STAMP });
  const provider = makeProvider({ snapshot: snapshot() });

  const app = express();
  app.use("/admin/auth", createAdminRouter({
    provider,
    adminPassword: ADMIN_PASSWORD,
    secureCookie: false,
    listVaults: async () => ({ vaults: [{ id: "default", name: "Default" }] }),
    authorizationAdmin: service,
    ...(mode ? { authorization: { summary: () => ({ mode }) } } : {}),
  }));
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
  return { origin, cookie, store, service };
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

/**
 * The 定时授权 section of a drawer page, cut out of the whole document.
 *
 * Whole-page predicates cannot pin "no control here": every drawer page has forms, selects and
 * buttons of its own below the section, so the assertions must read this block and nothing else.
 */
function sectionOf(html) {
  const start = html.indexOf('<div class="dsec" id="authz">');
  assert.ok(start >= 0, "the drawer carries the 定时授权 section");
  const rest = html.slice(start);
  const next = rest.slice(1).search(/<(?:form|div) class="dsec"/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The section contract, kept as a function so the negative control can run the same assertions. */
function assertSubjectSection(html, { appliedLabel = "研究机器人仅工作时间" } = {}) {
  const section = sectionOf(html);
  assert.match(section, /<div class="dsec" id="authz"><h3>定时授权<\/h3>/, "the section keeps the prototype's head");
  assert.match(section, /只在这个主体已有的权限上再加限制，不会放大权限/, "the section states the restriction direction");
  // An APPLIED row links to the constraint's editor and names it.
  if (appliedLabel) {
    assert.match(section, new RegExp(`\\?edit=[^"]*"[^>]*>${appliedLabel}<\\/a>`), "an applied constraint is listed by its label");
    assert.match(section, /查看<\/a>/, "and each row offers its 查看 link");
  }
  // Read-only: attaching a subject is the constraint editor's subject picker, not this drawer. Every
  // predicate below is a structural signature the prototype does not have, so the shape ratchet
  // cannot absorb one of them coming back.
  assert.doesNotMatch(section, /<form\b/, "no form in the section");
  assert.doesNotMatch(section, /<select\b|<option\b/, "no rule picker in the section");
  assert.doesNotMatch(section, /<button\b/, "no button in the section");
  assert.doesNotMatch(section, /<input\b|name="subject"|<p class=/, "no control and no new paragraph kind");
  assert.doesNotMatch(section, /应用已有规则|新建规则/, "no attach or new-rule label is offered");
  assert.doesNotMatch(section, /action="\/admin\/auth\/(?:access-policy|authz)\//, "nothing in the section writes");
  // The one pointer, and the only thing the section spends: the page that owns the document.
  assert.match(section, new RegExp(`href="${BASE}"`), "the banner points at the 定时授权 page");
  assert.match(section, /只读：要把这个主体加进某条约束/, "and says where a subject joins a constraint");
  assert.doesNotMatch(html, /<script(?![^>]*src="\/admin\/auth\/assets\/)/i, "the drawer adds no script");
  assert.doesNotMatch(html, /[\s"']on(?:click|change|input|submit|load|error)\s*=/i, "no inline handlers");
}

/**
 * The applied constraint, stripped of the two fields a write must move.
 *
 * `updatedAt` and the document revision are the CAS's own bookkeeping: a write stamps the record.
 * Everything else must be byte-identical.
 */
async function storedConstraint(store, id) {
  const current = store.snapshot();
  return current.document.constraints.find((item) => item.id === id) ?? null;
}

// ------------------------------------------------------------------ structure

test("all three subject drawers render the 定时授权 section with their own subject", async (t) => {
  const { origin, cookie } = await startFixture(t);

  const keys = await get(origin, cookie, "/admin/auth?tab=keys&id=key-1");
  assert.equal(keys.status, 200);
  assertSubjectSection(keys.body);

  const clients = await get(origin, cookie, "/admin/auth?tab=clients&id=client-1");
  assert.equal(clients.status, 200);
  assertSubjectSection(clients.body, { appliedLabel: "客户端仅午休" });

  const accounts = await get(origin, cookie, "/admin/auth?tab=accounts&id=u-1");
  assert.equal(accounts.status, 200);
  assert.match(accounts.body, /不受定时授权限制/, "a subject no constraint names is reported as unrestricted");
  assertSubjectSection(accounts.body, { appliedLabel: "" });
});

test("negative control: the structural assertions are not vacuous", async (t) => {
  const { origin, cookie } = await startFixture(t);
  // The accounts drawer is restricted by nothing, so it carries no applied label.
  const accounts = await get(origin, cookie, "/admin/auth?tab=accounts&id=u-1");
  assert.match(accounts.body, /不受定时授权限制/, "with no matching constraint the drawer says so");
  assert.throws(
    () => assertSubjectSection(accounts.body, { appliedLabel: "研究机器人仅工作时间" }),
    /an applied constraint is listed by its label/,
    "the same assertions must reject a drawer that lists no applied constraint",
  );
  const keys = await get(origin, cookie, "/admin/auth?tab=keys&id=key-1");
  assertSubjectSection(keys.body);
  assert.throws(
    () => assertSubjectSection(keys.body, { appliedLabel: "客户端仅午休" }),
    /an applied constraint is listed by its label/,
    "a label that is not in this section cannot pass",
  );
});

// ------------------------------------------------------------------ which backend decides

test("the section says which backend decides, and follows the mode", async (t) => {
  // `legacy` and `shadow` record these constraints and answer from the legacy backend
  // (`authorization/runtime.js`), so the verdicts above them are a record, not a restriction.
  const legacy = await startFixture(t, { mode: "legacy" });
  const section = sectionOf((await get(legacy.origin, legacy.cookie, "/admin/auth?tab=keys&id=key-1")).body);
  assert.match(section, /data-authorization-mode="legacy"/, "the section names the served mode");
  assert.match(section, /data-decides="legacy"/, "and that the legacy backend decides");
  assert.match(section, /约束会记录，但暂不裁定/, "so it does not state the restriction as fact");
  assert.doesNotMatch(section, /约束正在裁定/);

  // `enforce` is the one mode where they decide; the same banner says so.
  const enforce = await startFixture(t, { mode: "enforce" });
  const decided = sectionOf((await get(enforce.origin, enforce.cookie, "/admin/auth?tab=keys&id=key-1")).body);
  assert.match(decided, /data-authorization-mode="enforce"/);
  assert.match(decided, /data-decides="constraints"/);
  assert.match(decided, /约束正在裁定/);
  assert.doesNotMatch(decided, /暂不裁定/);

  // A mode that cannot be read claims nothing about which backend decides.
  const bare = await startFixture(t);
  const unknown = sectionOf((await get(bare.origin, bare.cookie, "/admin/auth?tab=keys&id=key-1")).body);
  assert.match(unknown, /data-authorization-mode="unknown"/);
  assert.doesNotMatch(unknown, /data-decides="(legacy|constraints)"/);
});

// ------------------------------------------------------------------ behaviour

test("the legacy attach endpoint stays frozen and writes nothing", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const revision = store.snapshot().revision;
  const csrf = csrfOf((await get(origin, cookie, "/admin/auth?tab=clients&id=client-1")).body);

  const legacy = await post(origin, cookie, "/admin/auth/access-policy/subjects", {
    csrf, id: CLIENT_CONSTRAINT, subject: USER_SUBJECT, tab: "clients", subjectId: "client-1", expectedRevision: revision,
  });
  // No legacy store is wired into this router, so the frozen route answers its own "not configured"
  // shape; either way it must not write the per-Vault document.
  assert.notEqual(legacy.status, 303, "the frozen endpoint never attaches");
  assert.equal(store.snapshot().revision, revision);
  assert.deepEqual((await storedConstraint(store, CLIENT_CONSTRAINT)).subjects, [CLIENT_SUBJECT]);
});
