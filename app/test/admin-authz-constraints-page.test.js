// Plan Task 6 — the 「定时授权」 page speaks the per-Vault constraint model.
//
// The acceptance set is the plan's Step 1, one case per test, case 8 included: the page must state
// WHICH BACKEND DECIDES (ruling R8) and it must be right in every mode. Two rulings are pinned here
// because they are easy to lose:
//   * R9 — the page renders no script and no inline handler, and the preview card is read-only;
//   * R10 — the frozen legacy banner's opening clause follows the mode (pinned in
//     `access-policy-frozen.test.js`, which owns that page's copy).
//
// The model is built by the real `buildCatalog` over stub services, so a constraint reaches the page
// the way it reaches it in production: the document from the constraint service, the atoms from the
// legacy store, the operations from the authorization catalog. The last two tests drive the real
// Admin router, because a page nothing serves is not a page.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createAdminRouter } from "../src/admin/router.js";
import { decodeConstraintDraft } from "../src/admin/routes/authz.js";
import { buildCatalog } from "../src/admin/catalog.js";
import { renderAuthzPage } from "../src/admin/pages/authz-constraints.js";
import { draftOf, operationPicker, renderAuthzConstraintsEditor } from "../src/admin/pages/authz-constraints-editor.js";
import { AUTHORIZATION_CATALOG_VERSION, catalogOperationIds } from "../src/authorization/catalog.js";
import { createConstraintAdmin } from "../src/authorization/constraint-admin.js";
import { serializeAuthorizationDocument } from "../src/authorization/schema.js";
import { createAuthorizationStore } from "../src/authorization/store.js";
import { adminCatalogFor } from "../src/i18n/admin.js";

const NOW = Date.parse("2026-11-09T04:00:00.000Z"); // 12:00 in Asia/Shanghai
const STAMP = "2026-11-01T00:00:00.000Z";
const BASE = "/admin/auth/authz";
const PASSWORD = "test-only-admin-password";
const SUBJECT = "oauth-user:user-1";
const CONSTRAINT_ID = "11111111-1111-4111-8111-111111111111";

const io = {
  mkdir: (target, options) => import("node:fs/promises").then((fs) => fs.mkdir(target, options)),
  readFile: (target) => import("node:fs/promises").then((fs) => fs.readFile(target)),
  open: (...args) => import("node:fs/promises").then((fs) => fs.open(...args)),
  rename: (from, to) => import("node:fs/promises").then((fs) => fs.rename(from, to)),
  unlink: (target) => import("node:fs/promises").then((fs) => fs.unlink(target)),
  chmod: (target, mode) => import("node:fs/promises").then((fs) => fs.chmod(target, mode)),
};

/** One stored constraint: Monday–Friday 09:00–18:00 on Vault "a", unless a case says otherwise. */
function constraint(overrides = {}) {
  return {
    id: CONSTRAINT_ID,
    label: "work hours",
    enabled: true,
    subjects: [SUBJECT],
    mode: "suspend",
    selector: { anyOf: [{ surfaces: null, capabilities: ["get_note"], targets: [{ kind: "vault", vaultId: "a" }] }] },
    schedule: {
      timezone: "Asia/Shanghai",
      weekly: { mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]], wed: [["09:00", "18:00"]], thu: [["09:00", "18:00"]], fri: [["09:00", "18:00"]] },
      dateRanges: [],
      startsAt: null,
      expiresAt: null,
    },
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

/** The legacy policy an imported constraint came from: same id, one legacy atom. */
function legacyPolicy(id = CONSTRAINT_ID) {
  return {
    id,
    label: "work hours",
    enabled: true,
    subjects: [SUBJECT],
    capabilities: ["scope:obsidian.read"],
    mode: "suspend",
    timezone: "Asia/Shanghai",
    weekly: { mon: [["09:00", "18:00"]] },
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function providerStub() {
  return {
    ready: Promise.resolve(),
    recordAudit: () => {},
    async authorizationSnapshot() {
      return {
        oauthUsers: [{ id: "user-1", username: "user-1", displayName: "User One", allowedScopes: ["obsidian.read"], allowedVaults: ["a"] }],
        clients: [], apiKeys: [], tokens: [], audit: [],
        configuredApiKeyUsage: { lastUsedAt: null, lastSource: null },
      };
    },
  };
}

/** The page model, assembled by the real catalog over stub services. */
async function pageModel({
  constraints = [constraint()],
  revision = 3,
  timeConstraintsEnabled = true,
  status = "ready",
  policies = [],
  vaults = [{ id: "a", name: "Work" }, { id: "b", name: "Life" }],
  withService = true,
} = {}) {
  const constraintAdmin = withService
    ? {
      list: () => (status === "ready"
        ? { revision, timeConstraintsEnabled, constraints }
        : { revision: null, code: "authorization_store_broken", timeConstraintsEnabled: null, constraints: [] }),
    }
    : null;
  const catalog = await buildCatalog({
    now: NOW,
    req: { method: "GET", path: BASE, headers: {} },
    query: {},
    deps: {
      provider: providerStub(),
      listVaults: async () => ({ vaults }),
      accessPolicyAdmin: { listPolicies: async () => ({ status: "ready", revision: 7, policies, orphaned: [] }) },
      authorizationAdmin: constraintAdmin,
    },
  });
  return catalog;
}

function pageOf(catalog, options = {}) {
  return renderAuthzPage(catalog.constraintPage, { base: BASE, now: NOW, csrf: "csrf-token", ...options });
}

function editorOf(catalog, options = {}) {
  const constraintId = options.constraint?.id ?? null;
  return renderAuthzConstraintsEditor(catalog.constraintPage, {
    base: BASE,
    now: NOW,
    csrf: "csrf-token",
    constraint: options.constraint ?? null,
    draft: draftOf(options.constraint ?? null, { vaults: catalog.constraintPage.vaults }),
    ...options,
    ...(constraintId ? { constraint: options.constraint } : {}),
  });
}

/* ---------------------------------------------------------------- case 1 */

test("case 1: the scope cell shows the Vault's id, and 「全部 Vault」 for targets:null", async () => {
  const scoped = await pageModel();
  const scopedHtml = pageOf(scoped).content;
  // The cell carries the id itself, in mono, because the id is what the constraint stores.
  assert.match(scopedHtml, /<td><div class="tags"><span class="tag" title="a"><span class="mono">a<\/span>/);
  assert.doesNotMatch(scopedHtml, /<span class="tag amber">全部 Vault<\/span><\/td>/, "a Vault-scoped constraint is not reported as unscoped");

  const unscoped = await pageModel({
    constraints: [constraint({ selector: { anyOf: [{ surfaces: null, capabilities: ["get_note"], targets: null }] } })],
  });
  const unscopedHtml = pageOf(unscoped).content;
  assert.match(unscopedHtml, /<span class="tag amber">全部 Vault<\/span><\/td>/, "targets:null renders 全部 Vault in the scope cell");
  assert.doesNotMatch(unscopedHtml, /<span class="mono">a<\/span>/);
});

/* ---------------------------------------------------------------- case 2 */

test("case 2: one multi-select lists every admitted Vault, and no inline handler exists", async () => {
  const catalog = await pageModel();
  const html = editorOf(catalog).content;
  const selects = [...html.matchAll(/<select[^>]*>/g)].map((match) => match[0]);
  // `vaultIds` is the field the route decodes (`decodeConstraintDraft`): the plan's sketch says
  // `name="vaults"`, but a field the service never reads could not store a scope at all.
  const vaultSelect = selects.find((tag) => /name="vaultIds"/.test(tag));
  assert.ok(vaultSelect, `the editor renders its Vault scope as one select (tags: ${JSON.stringify(selects)})`);
  assert.match(vaultSelect, /\bmultiple\b/, "the Vault scope is a multi-select");
  const scopeBlock = /<select[^>]*name="vaultIds"[\s\S]*?<\/select>/.exec(html)?.[0] ?? "";
  assert.match(scopeBlock, /value="all"/, "「全部 Vault」 is a choice of its own");
  for (const vault of catalog.constraintPage.vaults) {
    assert.match(scopeBlock, new RegExp(`value="${vault.id}"`), `Vault ${vault.id} is listed`);
    assert.match(scopeBlock, new RegExp(vault.name), `Vault ${vault.id} shows its name`);
  }
  // No inline handler anywhere: CSP is `default-src 'none'`, so a handler could never run.
  assert.deepEqual([...html.matchAll(/\son[a-z]+=/g)].map((match) => match[0]), [], "no inline event handler");
});

/* ---------------------------------------------------------------- case 3 */

test("case 3: the picker offers catalog operation ids and no legacy atom for a new constraint", async () => {
  const catalog = await pageModel();
  const html = editorOf(catalog).content;
  const picker = /<select[^>]*name="addOperation"[\s\S]*?<\/select>/.exec(html)?.[0];
  assert.ok(picker, "the picker is a real select in the form");
  const values = [...picker.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]).filter(Boolean);
  assert.ok(values.length > 20, `the picker offers the catalog, actual ${values.length} options`);
  const operations = new Set(catalog.constraintPage.operations.map((operation) => operation.id));
  assert.deepEqual(values.filter((value) => !operations.has(value)), [], "every option is a catalog operation");
  assert.deepEqual(values.filter((value) => value.includes(":")), [], "no `tool:`/`scope:` atom is offered");
  assert.ok(values.every((value) => catalogOperationIds.includes(value)), "every option is one of the catalog's own ids");
  // Grouped by surface, as design §6.3 asks.
  assert.ok(/<optgroup label="[^"]+"/.test(picker), "the operations are grouped by surface");
  // A NEW constraint cannot carry an atom either: an empty document offers no chip to inherit.
  const fresh = await pageModel({ constraints: [] });
  const freshHtml = editorOf(fresh).content;
  assert.equal(/data-imported-atoms/.test(freshHtml), false, "a new constraint inherits no atom");
  assert.equal(/<input[^>]*name="capabilities"[^>]*value="[^"]*:[^"]*"/.test(freshHtml), false, "and starts with no atom chip");
  assert.equal(operationPicker(catalog.constraintPage.operations, { chosen: [] }).includes(":"), false, "no atom can be chosen");
});

/* ---------------------------------------------------------------- case 4 */

test("case 4: an imported constraint shows its atom as a read-only chip plus its operations", async () => {
  const catalog = await pageModel({ policies: [legacyPolicy()] });
  const html = pageOf(catalog, { query: { id: CONSTRAINT_ID } }).detailPanel;
  const chips = /<div class="tags" data-imported-atoms>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  assert.match(chips, /scope:obsidian\.read/, "the atom it came from is named");
  assert.match(chips, /class="tag acc readonly"/, "the atom is a read-only chip");
  assert.doesNotMatch(chips, /<input|<button|<option/, "the atom cannot be edited");
  assert.match(html, /get_note/, "the operations it expanded to are shown next to it");
  assert.match(html, /只读：/, "the page says why the atom cannot be edited");

  // The atoms come from the legacy store by the constraint's own id: no import, no chip.
  const plain = await pageModel({ policies: [] });
  const plainHtml = pageOf(plain, { query: { id: CONSTRAINT_ID } }).detailPanel;
  assert.equal(/data-imported-atoms/.test(plainHtml), false, "a constraint nobody imported shows no atom");
});

/* ---------------------------------------------------------------- case 5 */

test("case 5: the master switch is a form POST, and its being off raises the warning banner", async () => {
  const on = pageOf(await pageModel({ timeConstraintsEnabled: true })).content;
  const off = pageOf(await pageModel({ timeConstraintsEnabled: false })).content;
  for (const [label, html] of [["on", on], ["off", off]]) {
    const form = /<form[^>]*action="\/admin\/auth\/authz\/plane"[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0];
    assert.ok(form, `the switch posts to ${BASE}/plane (${label})`);
    assert.match(form, /method="post"/, "the switch is a POST");
    assert.match(form, /name="csrf"/, "the switch carries the CSRF token");
    assert.match(form, /name="expectedRevision" value="3"/, "the switch carries the revision it read");
  }
  assert.match(on, /name="enabled" value="false"/, "switching on state posts the opposite value");
  assert.match(off, /name="enabled" value="true"/);
  assert.match(off, /data-plane-off/, "while the plane is off the page carries the warning banner");
  assert.equal(/data-plane-off/.test(on), false, "and only while it is off");
  assert.match(off, /总开关已停用/, "the warning says the windows are inert");

  // A store that cannot be read has no known switch position: no switch at all.
  const broken = pageOf(await pageModel({ status: "broken" })).content;
  assert.equal(/\/authz\/plane/.test(broken), false, "an unreadable store renders no switch");
  assert.match(broken, /约束存储不可用/, "and says why");
});

/* ---------------------------------------------------------------- case 6 */

test("case 6: every visible string the new pages use resolves through t() in both catalogs", async () => {
  const zh = adminCatalogFor("zh-CN");
  const en = adminCatalogFor("en");
  const keys = Object.keys(zh).filter((key) => key.startsWith("adm.authz2."));
  assert.ok(keys.length > 40, `the page's own keys are catalogued, actual ${keys.length}`);
  for (const key of keys) {
    assert.ok(String(en[key] ?? "").trim(), `${key} is missing from en`);
  }
  // Nothing visible is written into the modules as a literal: the Admin i18n gate scans the sources
  // for `adm.*` key literals, and this pins the keys those literals are (so a rename cannot hide).
  const catalog = await pageModel({ policies: [legacyPolicy()] });
  for (const html of [pageOf(catalog).content, pageOf(catalog, { query: { id: CONSTRAINT_ID } }).detailPanel, editorOf(catalog).content]) {
    assert.doesNotMatch(html, /undefined|\{mode\}|\{count\}|\{state\}|\{revision\}|\{surface\}/, "no placeholder survived the render");
  }
});

/* ---------------------------------------------------------------- case 7 */

test("case 7: the page carries no <script> and no handler, and its preview card is read-only", async () => {
  const catalog = await pageModel({ policies: [legacyPolicy()] });
  const pages = [pageOf(catalog).content, pageOf(catalog, { query: { id: CONSTRAINT_ID } }).detailPanel, editorOf(catalog).content];
  for (const html of pages) {
    assert.equal(/<script/i.test(html), false, "no script element");
    assert.equal(/\son[a-z]+=/i.test(html), false, "no inline handler");
    assert.equal(/javascript:/i.test(html), false, "no javascript: URL");
  }
  const preview = /<aside class="ped-side" data-preview="constraints">([\s\S]*?)<\/aside>/.exec(editorOf(catalog).content)?.[1] ?? "";
  assert.ok(preview, "the editor renders the preview card");
  assert.doesNotMatch(preview, /<form|<button|<input/i, "the preview card submits nothing");
  assert.match(preview, /只读预览/, "and says so");
  assert.match(preview, /现在/, "the verdict on it is the server's");
});

/* ---------------------------------------------------------------- case 8 (R8) */

test("case 8: the page states which backend decides, and its claim follows the mode", async () => {
  const catalog = await pageModel();
  const seen = {};
  for (const mode of ["legacy", "shadow", "enforce"]) {
    const html = pageOf(catalog, { authorizationMode: mode }).content;
    assert.match(html, new RegExp(`data-authorization-mode="${mode}"`), `the page names the served mode (${mode})`);
    seen[mode] = html;
  }
  // legacy and shadow: recorded, not deciding.
  for (const mode of ["legacy", "shadow"]) {
    assert.match(seen[mode], /data-decides="legacy"/, `${mode} says the legacy backend decides`);
    assert.match(seen[mode], /约束会记录，但暂不裁定/, `${mode} says these constraints do not decide yet`);
    assert.doesNotMatch(seen[mode], /约束正在裁定/, `${mode} may not claim the constraints decide`);
    assert.match(seen[mode], new RegExp(`授权模式 ${mode}`), `${mode} is rendered as plain text`);
  }
  // enforce: they decide.
  assert.match(seen.enforce, /data-decides="constraints"/);
  assert.match(seen.enforce, /约束正在裁定/);
  assert.doesNotMatch(seen.enforce, /暂不裁定/);

  // A mode that cannot be read claims nothing about which backend decides.
  const bare = pageOf(catalog, { authorizationMode: null }).content;
  assert.match(bare, /data-authorization-mode="unknown"/);
  assert.match(bare, /data-decides="unknown"/);
  assert.match(bare, /读不到授权模式/);
  assert.doesNotMatch(bare, /data-decides="(legacy|constraints)"/);

  // The editor says it too: the operator decides whether to save a window that cannot apply.
  const editor = editorOf(catalog, { authorizationMode: "legacy" }).content;
  assert.match(editor, /data-authorization-mode="legacy"/);
  assert.match(editor, /暂不裁定/);
});

/* ---------------------------------------------------------------- the route's picker field */

test("the picker's field joins the ticked operations: one picker, real checkboxes, no script", () => {
  const draft = decodeConstraintDraft({ label: "x", capabilities: ["get_note"], addOperation: "write_note", vaultIds: ["all"], timezone: "UTC" });
  assert.deepEqual([...draft.capabilities].sort(), ["get_note", "write_note"], "the picked operation joins the ticked set");
  assert.equal(draft.vaultIds, null, "vaultIds=all is every Vault");
  // Picking the same operation twice cannot store it twice: the schema refuses a duplicate.
  assert.deepEqual(decodeConstraintDraft({ capabilities: ["get_note"], addOperation: "get_note" }).capabilities, ["get_note"]);
  // A revoke constraint is unrestricted by the schema's own invariant, whatever the form says.
  assert.equal(decodeConstraintDraft({ mode: "revoke", addOperation: "get_note" }).capabilities, null);
});

/* ---------------------------------------------------------------- the router */

/** The real Admin router over a real constraint store, a real login and a real CSRF token. */
async function start(t, { mode = "legacy", withService = true, constraints = [constraint()] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "admin-authz-page-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "authorization.json");
  await writeFile(file, serializeAuthorizationDocument({
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 3,
    timeConstraintsEnabled: true,
    subjects: {},
    constraints,
  }));
  const fs = await import("node:fs/promises");
  const store = createAuthorizationStore({
    file,
    io: {
      mkdir: fs.mkdir, readFile: fs.readFile, open: fs.open, rename: fs.rename, unlink: fs.unlink, chmod: fs.chmod,
    },
  });
  await store.ready;
  const service = createConstraintAdmin({ store, vaultIds: ["a", "b"], now: () => STAMP });

  const app = express();
  app.use("/admin/auth", createAdminRouter({
    provider: providerStub(),
    adminPassword: PASSWORD,
    secureCookie: false,
    listVaults: async () => ({ vaults: [{ id: "a", name: "Work" }, { id: "b", name: "Life" }] }),
    // The frozen legacy store: its routes are what give the shell a legacy base, and its page is the
    // read-only link this page must offer (Task 7 item B).
    accessPolicyAdmin: { listPolicies: async () => ({ status: "ready", revision: 7, policies: [legacyPolicy()], orphaned: [] }) },
    authorization: { summary: () => ({ mode }) },
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
  const setCookies = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie")];
  const cookie = setCookies.filter(Boolean).map((item) => item.split(";")[0]).join("; ");
  return { origin, cookie, store, service };
}

test("the router serves the page, its editor and the drawer, and says the mode it was served in", async (t) => {
  const harness = await start(t, { mode: "enforce" });
  const list = await fetch(`${harness.origin}${BASE}`, { headers: { cookie: harness.cookie } });
  assert.equal(list.status, 200);
  const listHtml = await list.text();
  assert.match(listHtml, /<aside class="drawer on"|class="tbl"/, "the list renders inside the Admin shell");
  assert.match(listHtml, /data-authorization-mode="enforce"/, "the shell carries the page's mode banner");
  assert.match(listHtml, /<span class="mono">a<\/span>/, "the stored Vault scope reaches the page");

  const drawer = await (await fetch(`${harness.origin}${BASE}?id=${CONSTRAINT_ID}`, { headers: { cookie: harness.cookie } })).text();
  assert.match(drawer, /work hours/, "the drawer names the constraint");
  assert.match(drawer, /class="drawer on"/);

  const editor = await (await fetch(`${harness.origin}${BASE}?edit=${CONSTRAINT_ID}`, { headers: { cookie: harness.cookie } })).text();
  assert.match(editor, /name="vaultIds"/, "the editor renders its Vault scope");
  assert.match(editor, new RegExp(`action="${BASE}/update"`), "and posts to the update route");
  assert.match(editor, /data-preview="constraints"/, "with the read-only preview card");

  const fresh = await (await fetch(`${harness.origin}${BASE}?new=1`, { headers: { cookie: harness.cookie } })).text();
  assert.match(fresh, new RegExp(`action="${BASE}/create"`), "?new=1 posts to the create route");

  // A bookmarked editor URL for a constraint that is gone must not open a form.
  const gone = await (await fetch(`${harness.origin}${BASE}?edit=22222222-2222-4222-8222-222222222222`, { headers: { cookie: harness.cookie } })).text();
  assert.equal(/name="vaultIds"/.test(gone), false, "a missing constraint opens no editor");
});

test("the sidebar's 定时授权 entry reaches this page, and the frozen page is a read-only link from it", async (t) => {
  const harness = await start(t, { mode: "enforce" });
  const html = await (await fetch(`${harness.origin}${BASE}`, { headers: { cookie: harness.cookie } })).text();

  // One nav entry named 定时授权, and it points at the page that works (Task 7 item B).
  const sidebar = /<nav class="side-body[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
  assert.ok(sidebar, "the shell renders the sidebar");
  const entry = [...sidebar.matchAll(/<a class="ni[^"]*"[^>]*>[\s\S]*?<\/a>/g)]
    .map((match) => match[0])
    .find((anchor) => anchor.includes("定时授权"));
  assert.ok(entry, "the sidebar carries the 定时授权 entry");
  assert.match(entry, new RegExp(`href="${BASE}"`), "the entry leads to the constraint page, not to the frozen one");
  assert.equal(sidebar.includes('href="/admin/auth/access-policy"'), false, "the frozen page is not a nav entry any more");
  assert.match(sidebar, /<a class="ni[^"]*"[^>]*href="\/admin\/auth\/authz"[^>]*data-hotkey="z"/, "the hotkey survives the move");

  // The frozen page is reachable here, as a plain read-only link.
  assert.match(html, /<a class="btn ghost" href="\/admin\/auth\/access-policy">历史策略（只读）<\/a>/, "the history link is on the page");
  assert.doesNotMatch(html, /action="\/admin\/auth\/access-policy\//, "and it offers no legacy write");

  // The mobile primary row carries the same destination.
  const mnav = /<nav class="mnav"[\s\S]*?<details class="mmore">/.exec(html)?.[0] ?? "";
  assert.match(mnav, new RegExp(`<a href="${BASE}"`), "the mobile primary row reaches the same page");
});

test("the 定时授权 badge counts the constraints, the same rows the page lists", async (t) => {
  // One legacy policy and two constraints: the two numbers diverge, and the badge sits on the entry
  // that opens the constraint page. It used to carry the legacy count while opening this list.
  const harness = await start(t, { constraints: [constraint(), constraint({ id: "22222222-2222-4222-8222-222222222222", label: "lunch", subjects: [] })] });
  const html = await (await fetch(`${harness.origin}${BASE}`, { headers: { cookie: harness.cookie } })).text();

  const sidebar = /<nav class="side-body[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
  const entry = [...sidebar.matchAll(/<a class="ni[^"]*"[^>]*>[\s\S]*?<\/a>/g)]
    .map((match) => match[0])
    .find((anchor) => anchor.includes("定时授权"));
  assert.ok(entry, "the sidebar carries the 定时授权 entry");
  assert.match(entry, new RegExp(`href="${BASE}"`), "and it opens the constraint page");
  assert.match(entry, /<span class="cnt">2<\/span>/, "its badge is the constraint count, not the legacy policy count");
  assert.match(html, /<span class="cnt">1<\/span><\/a>/, "the one legacy policy does not reach this badge");
  assert.match(html, /<header class="bar"><h1>定时授权<span class="cnt">2<\/span>/, "the page bar counts the same rows");
});

test("a GET without a session redirects to the login page, and without the service the page refuses honestly", async (t) => {
  const harness = await start(t, { withService: false });
  const anonymous = await fetch(`${harness.origin}${BASE}`, { redirect: "manual" });
  assert.equal(anonymous.status, 303, "the page is behind the Admin session");
  assert.match(String(anonymous.headers.get("location")), /\/admin\/auth\/login/);

  const page = await fetch(`${harness.origin}${BASE}`, { headers: { cookie: harness.cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /authorization_admin_unavailable/, "the page names the missing service");
  assert.equal(/name="vaultIds"/.test(html), false, "and offers no editor it could not save");
});

/* ---------------------------------------------------------------- fix round 1 (review C1, I1, I2, M1, M2) */

/**
 * Whatever a browser posts for a form nobody touched: every input's value, the checked boxes, and
 * the selected options of every select. The review's probes submitted hand-built bodies; a no-op
 * save has to be measured from the page's own form, or the probe can agree with a bug.
 */
function formFields(html, formId = "authz-constraint") {
  const form = new RegExp(`<form[^>]*id="${formId}"[\\s\\S]*?</form>`).exec(html)?.[0] ?? "";
  const params = [];
  for (const [tag] of form.matchAll(/<input\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    if (!name) continue;
    const type = (/\btype="([^"]*)"/.exec(tag)?.[1] ?? "text").toLowerCase();
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/.test(tag)) continue;
    params.push([name, /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? ""]);
  }
  for (const [block] of form.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)) {
    const head = /<select\b[^>]*>/.exec(block)[0];
    const name = /\bname="([^"]*)"/.exec(head)?.[1];
    if (!name) continue;
    const options = [...block.matchAll(/<option\b[^>]*>/g)].map((option) => option[0]);
    const selected = options.filter((option) => /\bselected\b/.test(option));
    const chosen = selected.length ? selected : (/\bmultiple\b/.test(head) ? [] : options.slice(0, 1));
    for (const option of chosen) {
      const value = /\bvalue="([^"]*)"/.exec(option)?.[1] ?? "";
      if (value) params.push([name, value]);
    }
  }
  return params;
}

/** Open the editor for a stored constraint, and submit its own form, untouched. */
async function saveUnchanged(harness, fields) {
  const editor = await (await fetch(`${harness.origin}${BASE}?edit=${CONSTRAINT_ID}`, { headers: { cookie: harness.cookie } })).text();
  const body = new URLSearchParams(fields ? fields(editor) : formFields(editor));
  const response = await fetch(`${harness.origin}${BASE}/update`, {
    method: "POST",
    headers: { cookie: harness.cookie, "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  return { editor, response };
}

function storedConstraint(harness) {
  return harness.service.list().constraints.find((item) => item.id === CONSTRAINT_ID);
}

test("C1: a stored subject the snapshot no longer lists survives an untouched save", async (t) => {
  const ghost = "oauth-user:ghost";
  const harness = await start(t, { constraints: [constraint({ subjects: [SUBJECT, ghost] })] });
  // The document normalizes the order once, when it is written, so "unchanged" is measured against
  // what the store holds now, not against the seed's order.
  const before = storedConstraint(harness).subjects;
  assert.deepEqual([...before].sort(), [ghost, SUBJECT].sort(), "the seeded constraint names the orphan");

  const { editor, response } = await saveUnchanged(harness);
  const picker = /data-subject-picker[\s\S]*?<\/div>/.exec(editor)?.[0] ?? "";
  assert.match(picker, new RegExp(`name="subjects" value="${ghost}" checked`), "the orphan is a ticked row, so the form carries it");
  assert.match(picker, /class="tag danger"/, "and it is marked with the danger tag the list and the drawer use");
  assert.match(picker, /快照里已经没有这个主体/, "with the reason, in the picker's own words");
  assert.equal(response.status, 303, "the save applies");
  assert.deepEqual(storedConstraint(harness).subjects, before, "the stored subjects are unchanged, orphan included");
});

test("I1: a no-op save keeps the stored surfaces, and the page shows them", async (t) => {
  const stored = constraint({ selector: { anyOf: [{ surfaces: ["mcp"], capabilities: ["get_note"], targets: [{ kind: "vault", vaultId: "a" }] }] } });
  const harness = await start(t, { constraints: [stored] });

  const { editor, response } = await saveUnchanged(harness);
  assert.match(editor, /name="surfaces" value="mcp" checked/, "the stored surface is ticked in a real control");
  assert.match(editor, /生效的运行面/, "the page shows the surfaces it will write");
  assert.match(editor, /一个都不勾 = 所有运行面/, "and states the rule for an empty set");
  assert.equal(response.status, 303, "the save applies");
  assert.deepEqual(storedConstraint(harness).selector.anyOf[0].surfaces, ["mcp"], "the selector's surfaces are unchanged by a save nobody touched");
});

test("I2: a constraint that restricts every operation reads as 全部操作, not as none chosen", async (t) => {
  const every = constraint({ selector: { anyOf: [{ surfaces: null, capabilities: null, targets: [{ kind: "vault", vaultId: "a" }] }] } });
  const harness = await start(t, { constraints: [every] });

  const { editor, response } = await saveUnchanged(harness);
  assert.match(editor, /data-every-operation/, "the editor renders the every-operation state");
  assert.match(editor, /全部操作/, "in the words the list and the drawer use");
  assert.doesNotMatch(editor, /还没有选择操作/, "not as 「no operation chosen」, the opposite meaning");
  assert.match(editor, /本页无法改写/, "the page names the state it cannot write");
  assert.match(editor, /只能删除/, "and says delete is what is left");
  assert.match(editor, /<button class="btn primary" type="submit" form="authz-constraint" disabled/, "the save button is off");
  assert.match(editor, new RegExp(`action="${BASE}/delete"`), "the delete form is still there");
  assert.equal(response.status, 400, "a crafted submit of that same form is refused, not stored in a different shape");
  assert.equal(storedConstraint(harness).selector.anyOf[0].capabilities, null, "the stored selector is unchanged");
});

test("I2: a Vault the registry no longer admits is named, and the constraint is delete-only", async (t) => {
  const gone = constraint({ selector: { anyOf: [{ surfaces: null, capabilities: ["get_note"], targets: [{ kind: "vault", vaultId: "gone" }] }] } });
  const harness = await start(t, { constraints: [gone] });

  const { editor, response } = await saveUnchanged(harness);
  assert.match(editor, /它指定的 Vault 已不再接入/, "the page names what is stored");
  assert.match(editor, /gone/, "the raw Vault id is on the page, not swallowed by a filter");
  assert.match(editor, /<button class="btn primary" type="submit" form="authz-constraint" disabled/, "the save button is off");
  assert.equal(response.status, 400, "a crafted submit is refused");
  assert.deepEqual(storedConstraint(harness).selector.anyOf[0].targets, [{ kind: "vault", vaultId: "gone" }], "the stored targets are unchanged");
});

test("M1: the preview card names the deciding backend, and the banner says the same", async () => {
  const catalog = await pageModel();
  for (const [mode, expected] of [["legacy", "legacy"], ["shadow", "legacy"], ["enforce", "constraints"], [null, "unknown"]]) {
    const html = editorOf(catalog, { authorizationMode: mode }).content;
    assert.match(html, new RegExp(`data-preview-decides="${expected}"`), `the card claims the deciding backend for ${mode}`);
    assert.match(html, new RegExp(`data-decides="${expected}"`), `and the page banner agrees for ${mode}`);
  }
});

test("M2: the preview card says it shows the saved window", async () => {
  const catalog = await pageModel();
  const preview = /<aside class="ped-side" data-preview="constraints">([\s\S]*?)<\/aside>/.exec(editorOf(catalog).content)?.[1] ?? "";
  assert.match(preview, /按已保存的约束计算/, "the card says its input is the saved constraint");
  assert.match(preview, /不跟随未保存的改动/, "and that unsaved changes do not reach it");
  const everyOperation = /<aside class="ped-side" data-preview="constraints">([\s\S]*?)<\/aside>/.exec(editorOf(catalog, {
    constraint: constraint({ selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }] } }),
  }).content)?.[1] ?? "";
  assert.match(everyOperation, /全部操作/, "the card reads the every-operation state as 全部操作 too");
});

test("I2: a constraint with several selector branches is delete-only, not collapsed into one", async () => {
  // The importer gives each legacy atom its own `anyOf` branch, so this is the imported case: the
  // editor writes ONE branch, and a save would replace the others.
  const imported = constraint({
    selector: { anyOf: [
      { surfaces: null, capabilities: ["get_note"], targets: [{ kind: "vault", vaultId: "a" }] },
      { surfaces: ["mcp"], capabilities: null, targets: [{ kind: "vault", vaultId: "b" }] },
    ] },
  });
  const html = editorOf(await pageModel({ constraints: [imported] }), { constraint: imported }).content;
  assert.match(html, /它有 2 个并列分支/, "the page names the branch count");
  assert.match(html, /只能删除/, "and says the constraint is delete-only");
  assert.match(html, /<button class="btn primary" type="submit" form="authz-constraint" disabled/, "the save button is off");
});
