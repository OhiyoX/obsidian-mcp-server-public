// Lane W3-authz — 定时授权 page + route module regression, **frozen** surface.
//
// The legacy `access-policy` document stopped accepting edits (design §7 step 2 + step 5, plan
// Task 3): the per-Vault document decides, so this page is its history view. Everything below runs
// against the *real* service stack — a real A3 access-policy store in a temp directory, the real A4
// runtime, the real Admin service (`createAccessPolicyAdmin`) and the real `createAdminRouter`
// (session, CSRF, tab dispatch) over a real Express listener. The provider is a deterministic
// credential snapshot stub, because the page only consumes that snapshot.
//
// What is pinned here (prototype source: `docs/admin-ui-proto/src/5-render.js`):
//   1. the list table's columns, cell shapes, ⋯ menu and the read-only links it still offers;
//   2. the read-only detail drawer (`?id=`, `?window=` alias) and the read-only `?edit=` view —
//      every stored value is visible, and there is no `<form>` and no submit control to save it;
//   3. every legacy write (create/update/toggle/delete/preview/repair, ruling R6 for `repair`)
//      answers 409 `access_policy_frozen` and writes nothing, behind the unchanged CSRF gate;
//   4. no page needs script, and a negative control proves the structural assertions can go red.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

import express from "express";

import { createAdminRouter } from "../../src/admin/router.js";
import { createAccessPolicyAdmin } from "../../src/admin/access-policy.js";
import { createAccessPolicyRuntime } from "../../src/access-policy/runtime.js";
import { createAccessPolicyStore } from "../../src/access-policy/store.js";
import { policyNowState, policyTimelineHtml } from "../../src/admin/pages/authz.js";
import { decodeDraft, parseWeeklyText, wallClockToInstant } from "../../src/admin/routes/access-policy.js";

// D0 (approved 2026-10-18) script policy, in one place:
//   * a fragment (a page module's content) renders no script at all;
//   * an authenticated document renders exactly one same-origin, whitelisted enhancement module;
//   * neither may contain an inline handler or a javascript: URL.
const D0_MODULE_SCRIPT = /^<script type="module" src="\/admin\/auth\/assets\/[a-z-]+\.js"><\/script>$/i;
function assertScriptPolicy(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>(?:<\/script>)?/gi)].map((match) => match[0]);
  if (scripts.length > 0) {
    assert.equal(scripts.length, 1, "no script beyond the one whitelisted same-origin module");
    assert.match(scripts[0], D0_MODULE_SCRIPT, "the single script is the whitelisted same-origin module");
  }
  assert.doesNotMatch(html, /[\s"']on(?:click|change|input|submit|load|error|mouseover|focus|blur|toggle|keydown|keyup)\s*=/i, "no inline event handlers");
  assert.doesNotMatch(html, /javascript:/i, "no javascript: URLs");
}

const ADMIN_PASSWORD = "authz-lane-admin-password";
const BASE = "/admin/auth/access-policy";
const SUBJECT = "api-key:key-1";

function snapshot({ apiKeys = [{ id: "key-1", label: "研究机器人", prefix: "obmcp_abcd", allowedScopes: ["obsidian.read"], allowedVaults: ["default"], createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, lastSource: null }] } = {}) {
  return {
    apiKeys,
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

async function startFixture(t, { state = { snapshot: snapshot() }, corrupt = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "admin-redo-authz-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "access-policy.json");
  if (corrupt) await writeFile(file, '{ "schemaVersion": 1, "revision": 0, "policies": [ }');
  const store = createAccessPolicyStore({ file });
  await store.ready;
  const runtime = createAccessPolicyRuntime({ enabled: true, store });
  await runtime.ready;
  const admin = createAccessPolicyAdmin({ store, runtime });
  const provider = makeProvider(state);
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
  return { origin, cookie, store, admin, runtime, provider, state };
}

async function get(origin, cookie, path) {
  const response = await fetch(`${origin}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}

async function post(origin, cookie, path, fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item ?? ""));
  }
  const response = await fetch(`${origin}${path}`, {
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

/** The stored policy shape (the service's own draft grammar, not the removed form encoding). */
function storedDraft(overrides = {}) {
  return {
    label: "研究机器人仅工作时间",
    enabled: true,
    mode: "suspend",
    timezone: "Asia/Shanghai",
    subjects: [SUBJECT],
    capabilities: ["scope:obsidian.read"],
    weekly: { mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]] },
    ...overrides,
  };
}

/**
 * Seed the document through the *service*: Task 3 froze the write routes, not the store, so a fixture
 * can still be stored — and the frozen page then has something honest to show.
 */
async function seedPolicy(fixture, overrides = {}) {
  const created = await fixture.admin.createPolicy(storedDraft(overrides));
  assert.equal(created.ok, true, `the fixture policy must be stored: ${JSON.stringify(created)}`);
  return created.policy.id;
}

/** The page's own markup, minus the app shell's two forms (theme switch, logout — not this surface). */
function pageMarkup(html) {
  return html.replace(/<form class="inline-form" method="post" action="\/admin\/auth\/(?:theme|logout)">[\s\S]*?<\/form>/g, "");
}

// ------------------------------------------------------------------ structure

/** The list-page contract. Kept as a function so the negative control can run the same assertions. */
function assertListStructure(html, label = "研究机器人仅工作时间") {
  // Sortable headers (2026-10-31) wrap the label in <a class="ths"> and may append a glyph.
  const headers = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((match) => match[1].replace(/<span class="ind"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "").trim());
  assert.deepEqual(headers, ["策略", "状态 · 模式", "主体", "限制的能力", "允许时间窗口", ""], "the prototype's six columns, in order");
  assert.match(html, /<div class="banner amber" data-frozen="access_policy_frozen" data-authorization-mode="[a-z]+">[\s\S]*本页已冻结（只读）[\s\S]*href="\/admin\/auth\/authz"/, "the frozen banner names the fact and points at the new page");
  assert.match(html, /<div class="banner acc">[\s\S]*定时授权只会在既有权限基础上<b>再加限制<\/b>/, "the master banner explains the restriction direction");
  assert.match(html, /技术细节[\s\S]*策略修订号 <span class="mono">\d+<\/span>/, "the tech detail carries the CAS revision");
  assert.match(html, /<div class="futonly bm"[\s\S]*switch[\s\S]*规划中 · Stage 5/, "the master switch stays a planned, non-interactive marker");
  assert.ok(html.includes(`<div class="nm"><b>${label}</b><span class="sub2"><code class="idc"`), "the policy cell leads with the label and keeps the id on the secondary line");
  assert.match(html, /窗口外暂停/, "the status cell names the outside-the-window behaviour");
  assert.match(html, /<div class="tags">[\s\S]*读取/, "the capability column renders capability names");
  assert.match(html, /<details class="mn"><summary[^>]*aria-label="更多操作"/, "the row menu is a <details> menu, not a scripted popover");
  // Frozen: the row links only the read-only surfaces, and the first policy link is the drawer.
  assert.doesNotMatch(html, /[?&]edit=/, "no editor link survives the freeze");
  assert.match(html, /href="\/admin\/auth\/access-policy\?id=[0-9a-f-]{36}"/, "the row opens the read-only drawer");
  assert.doesNotMatch(html, /[?&]confirm=delete/, "delete has no entry point any more");
  assert.doesNotMatch(html, /[?&]copy=/, "copy has no entry point any more");
  assert.doesNotMatch(html, /[?&]new=1/, "the new-policy CTA is gone");
  assert.doesNotMatch(html, /<div class="sect" id="preview">/, "the POST-driven 当前状态预览 is gone");
  assert.doesNotMatch(html, /access-policy\/(?:create|update|toggle|delete|preview|repair)/, "no legacy write endpoint is offered");
  assertScriptPolicy(html);
  assert.doesNotMatch(html, /data-act=/, "no script-only affordances");
  assert.doesNotMatch(html, /<button[^>]*data-menu=/, "no script-only row-menu buttons");
}

function assertEveryPostFormCarriesCsrf(html) {
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((match) => match[0]);
  const posting = forms.filter((form) => /method="post"/i.test(form));
  assert.ok(posting.length > 0, "the page must render at least one POST form");
  for (const form of posting) {
    assert.match(form, /name="csrf" value="[^"]+"/, `every POST form must carry CSRF: ${form.slice(0, 120)}`);
  }
}

test("the frozen list renders the prototype table and banners, and offers no write affordance", async (t) => {
  const fixture = await startFixture(t);
  const { origin, cookie } = fixture;
  await seedPolicy(fixture);
  const page = await get(origin, cookie, BASE);
  assert.equal(page.status, 200);
  assertListStructure(page.body);
  // Only the app shell's own forms are left; the page itself posts nothing.
  assertEveryPostFormCarriesCsrf(page.body);
  assert.doesNotMatch(pageMarkup(page.body), /<form/, "the frozen list renders no form of its own");
});

test("the empty state is the prototype's `.empty`, with no write CTA", async (t) => {
  const { origin, cookie } = await startFixture(t);
  const page = await get(origin, cookie, BASE);
  assert.equal(page.status, 200);
  assert.match(page.body, /<div class="empty"><div class="ic">[\s\S]*还没有定时授权策略[\s\S]*为某个 Key、客户端或账户设置可访问的时间段/);
  assert.doesNotMatch(pageMarkup(page.body), /href="\/admin\/auth\/access-policy\?new=1"/, "the empty state offers no editor link");
  assert.match(page.body, /data-frozen="access_policy_frozen"/, "the banner stands in for the removed CTA");
});

test("negative control: the structural assertions are not vacuous", async (t) => {
  const fixture = await startFixture(t);
  const { origin, cookie } = fixture;
  await seedPolicy(fixture, { label: "负控策略" });
  const html = (await get(origin, cookie, BASE)).body;
  assertListStructure(html, "负控策略"); // green on the real page

  // (1) losing the frozen banner must turn the same assertions red …
  assert.throws(() => assertListStructure(html.replace(/data-frozen="access_policy_frozen"/, 'data-frozen="x"'), "负控策略"), /frozen banner/);
  // (2) … and so must a lost <details> row menu …
  assert.throws(() => assertListStructure(html.replace(/<details class="mn">/g, "<div class=\"mn\">"), "负控策略"), /details/);
  // (3) … and a POST form that lost its CSRF token.
  assert.throws(() => assertEveryPostFormCarriesCsrf(html.replace(/name="csrf"/g, 'name="csrf-removed"')), /CSRF/);
  // (4) escaping: a label can never inject markup, and dropping the escape is caught.
  await seedPolicy(fixture, { label: "<script>alert(1)</script>" });
  const hostile = (await get(origin, cookie, BASE)).body;
  assert.match(hostile, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "the label is escaped");
  assert.doesNotMatch(hostile, /<script>alert\(1\)<\/script>/, "the raw label never reaches the document");
  assert.throws(() => assertListStructure(hostile.replace(/&lt;script&gt;/g, "<script>"), "<script>alert(1)</script>"), /label|no script/);
});

// ------------------------------------------------------------------ drawer + read-only view

test("the detail drawer (`?id=` and the `?window=` alias) shows the stored policy and no write control", async (t) => {
  const fixture = await startFixture(t);
  const { origin, cookie } = fixture;
  const id = await seedPolicy(fixture);
  for (const query of [`id=${id}`, `window=${id}`]) {
    const page = await get(origin, cookie, `${BASE}?${query}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<div class="scrim on" data-scrim><\/div><aside class="drawer on"/, "the drawer is the prototype's open state");
    assert.match(page.body, /研究机器人仅工作时间/, "the drawer title is the policy label");
    assert.match(page.body, /<div class="k">策略 ID<\/div>/, "the drawer keeps the key/value fields");
    assert.match(page.body, /<div class="k">窗口外的处理方式<\/div>/, "the drawer names the outside-window mode");
    assert.match(page.body, /<div class="dsec"><h3>主体/, "subjects are a drawer section");
    assert.match(page.body, /<div class="dsec"><h3>限制的能力/, "capabilities are a drawer section");
    assert.match(page.body, /<div class="tl"><span class="(?:today)?">一<\/span>/, "the 7-day timeline renders");
    assert.match(page.body, /仅表示生效时间窗口，不代表永久有效或当前允许/, "the frozen window disclaimer survives");
    // Frozen: the drawer is a read-only detail view — no danger zone, no delete, no toggle, no edit.
    assert.doesNotMatch(page.body, /<div class="danger-zone">/, "the danger zone is gone");
    assert.doesNotMatch(page.body, /access-policy\/(?:toggle|delete)/, "no toggle or delete endpoint is offered");
    assert.doesNotMatch(page.body, /[?&]confirm=delete/, "delete has no confirmation page any more");
    assert.match(page.body, /<footer class="dfoot">[\s\S]*关闭/, "the drawer foot only closes it");
    assertEveryPostFormCarriesCsrf(page.body);
  }
  const missing = await get(origin, cookie, `${BASE}?id=00000000-0000-4000-8000-000000000000`);
  assert.equal(missing.status, 200);
  assert.match(missing.body, /策略不存在或已删除/, "an unknown id renders an empty drawer, not a crash");
});

test("the ?edit= view renders every stored field group, with no form and no submit control", async (t) => {
  const fixture = await startFixture(t);
  const { origin, cookie } = fixture;
  const id = await seedPolicy(fixture);
  const page = await get(origin, cookie, `${BASE}?edit=${id}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /<div class="ped">/, "the prototype editor shell, reused read-only");
  for (const legend of ["基本信息", "主体", "限制的能力", "允许访问的时间"]) {
    assert.match(page.body, new RegExp(`<legend>${legend}`), `fieldset ${legend} is present`);
  }
  assert.match(page.body, /<div class="k">标签<\/div><div>研究机器人仅工作时间<\/div>/, "the label is shown");
  assert.match(page.body, /<span class="mono">Asia\/Shanghai<\/span>/, "the timezone is shown");
  assert.match(page.body, /研究机器人/, "the stored subject is shown");
  assert.match(page.body, /title="scope:obsidian\.read">读取<\/span>/, "the stored capability is shown");
  assert.match(page.body, /<div class="k">周一<\/div><div><span class="mono">09:00–18:00<\/span><\/div>/, "the stored weekly interval is shown");
  assert.match(page.body, /<aside class="ped-side"><div class="stick">/, "the preview column is the prototype aside");
  assert.match(page.body, /<div class="sect-h"><h2>生效预览<\/h2>/, "the preview derives from the stored policy");
  assert.match(page.body, /对主体的影响/, "the per-subject impact block renders");
  // The freeze, in markup: nothing to type into and nothing to submit.
  const markup = pageMarkup(page.body);
  assert.equal(markup.includes("<form"), false, "the read-only view carries no form");
  assert.equal(markup.includes('type="submit"'), false, "and no submit control");
  assert.equal(markup.includes('name="label"'), false, "no editable field survives");
  assert.equal(markup.includes('name="conflict"'), false);
  assert.doesNotMatch(page.body, /[?&]confirm=delete/, "no delete entry point");
  assert.doesNotMatch(page.body, /[?&]addSlot=1|[?&]weeklyPreset=/, "no draft round trip");
  assert.match(page.body, /只读：历史策略不再接受写入/, "the page says it is read-only");

  // `?new=` and `?copy=` cannot open a draft either: they land on the frozen list.
  for (const query of ["?new=1", `?copy=${id}`]) {
    const draftPage = await get(origin, cookie, `${BASE}${query}`);
    assert.equal(draftPage.status, 200);
    assert.equal(pageMarkup(draftPage.body).includes("<form"), false, `${query} renders no form`);
    assert.match(draftPage.body, /data-frozen="access_policy_frozen"/, `${query} shows the frozen banner`);
  }
});

// ------------------------------------------------------------------ the freeze itself

test("every legacy write answers 409 access_policy_frozen and writes nothing", async (t) => {
  const fixture = await startFixture(t);
  const { origin, cookie, store } = fixture;
  const id = await seedPolicy(fixture);
  const revision = store.snapshot().revision;
  const csrf = csrfOf((await get(origin, cookie, BASE)).body);

  const bodies = {
    create: { label: "新策略", mode: "suspend", timezone: "Asia/Shanghai", subjects: [SUBJECT], capabilities: ["scope:obsidian.read"], weekly: { mon: [["09:00", "18:00"]] } },
    update: { id, label: "改名", expectedRevision: revision },
    toggle: { id, enabled: "false", confirmed: "1", expectedRevision: revision },
    delete: { id, confirm: "研究机器人仅工作时间", expectedRevision: revision },
    preview: { subject: SUBJECT, view: "list" },
    repair: { document: '{"schemaVersion":1,"revision":0,"policies":[]}', confirm: "覆盖" },
  };
  for (const [endpoint, body] of Object.entries(bodies)) {
    const refused = await post(origin, cookie, `${BASE}/${endpoint}`, { csrf, ...body });
    assert.equal(refused.status, 409, `${endpoint} must be refused with 409`);
    const payload = JSON.parse(refused.body);
    assert.equal(payload.error, "access_policy_frozen", `${endpoint} carries the frozen code`);
    assert.equal(payload.movedTo, "/admin/auth/authz", `${endpoint} names where the work moved to`);
    assert.equal(store.snapshot().revision, revision, `${endpoint} must write nothing`);
  }
  // Ruling R6: the refusal copy itself says that `repair` is frozen too.
  const repair = JSON.parse((await post(origin, cookie, `${BASE}/repair`, { csrf, ...bodies.repair })).body);
  assert.match(String(repair.message), /修复/, "the refusal copy names the frozen repair path");
  // The CSRF gate still comes first: no token, no evaluation at all.
  const noCsrf = await post(origin, cookie, `${BASE}/create`, bodies.create);
  assert.equal(noCsrf.status, 403);
  assert.equal(store.snapshot().policies.length, 1, "the seeded policy is untouched by every refusal");
});

test("an orphaned subject is still banner-ed, read-only", async (t) => {
  const state = { snapshot: snapshot() };
  const fixture = await startFixture(t, { state });
  const { origin, cookie } = fixture;
  const id = await seedPolicy(fixture);
  // The credential behind the policy disappears from the snapshot.
  state.snapshot = snapshot({ apiKeys: [] });
  const list = await get(origin, cookie, BASE);
  assert.match(list.body, /<b>1 个孤立主体<\/b>/, "the prototype's amber orphan banner");
  assert.match(list.body, /它们不会再匹配任何请求/, "the banner says what an orphan really means");
  assert.match(list.body, /<span class="tag danger">孤立<\/span>/, "and the row-level 孤立 tag");
  const view = await get(origin, cookie, `${BASE}?edit=${id}`);
  assert.match(view.body, /<span class="pill" title="api-key:key-1">[\s\S]{0,200}<span class="tag danger">孤立<\/span>/, "the read-only view still shows the orphaned subject, marked 孤立");
});

test("a broken store still renders the page, says the repair is frozen and offers no repair form", async (t) => {
  const { origin, cookie, store } = await startFixture(t, { corrupt: true });
  assert.equal(store.snapshot().status, "broken", "the fixture really starts with an unreadable policy file");
  const page = await get(origin, cookie, BASE);
  assert.equal(page.status, 200, "the Admin plane is never gated by the store it manages");
  assert.match(page.body, /<b>策略存储不可用<\/b>/, "the broken-store banner is rendered");
  assert.match(page.body, /修复入口同样已冻结/, "it says repair is frozen as well (ruling R6)");
  assert.equal(page.body.includes('name="document"'), false, "no repair textarea");
  assert.equal(page.body.includes("用此文档覆盖修复"), false, "no repair CTA");

  const csrf = csrfOf(page.body);
  const refused = await post(origin, cookie, `${BASE}/repair`, { csrf, document: '{"schemaVersion":1,"revision":0,"policies":[]}', confirm: "覆盖" });
  assert.equal(refused.status, 409);
  assert.equal(JSON.parse(refused.body).error, "access_policy_frozen");
  assert.equal(store.snapshot().status, "broken", "the store stays exactly as it was found");
});

// ------------------------------------------------------------------ read-only presentation

test("the policy presentation fails closed instead of claiming 允许", () => {
  assert.equal(policyNowState({ mode: "suspend", timezone: "Not/AZone", weekly: { mon: [["09:00", "18:00"]] } }).ok, null, "an unknown timezone is 无法判定");
  assert.equal(policyNowState({ mode: "suspend", timezone: "Asia/Shanghai", weekly: { mon: [["18:00", "09:00"]] } }).ok, null, "a cross-midnight interval is unparsable");
  const future = policyNowState({ mode: "suspend", timezone: "UTC", weekly: {}, startsAt: "2999-01-01T00:00:00.000Z" });
  assert.equal(future.ok, false);
  assert.equal(future.why, "尚未到生效起点");
  const expired = policyNowState({ mode: "suspend", timezone: "UTC", weekly: {}, expiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal(expired.ok, false);
  assert.equal(expired.why, "已过失效终点");
  const timeline = policyTimelineHtml({ timezone: "Asia/Shanghai", weekly: { mon: [["09:00", "18:00"]] } });
  assert.match(timeline, /left:37\.5%/, "09:00 is 37.5% into the day");
  assert.doesNotMatch(timeline, /left:0%;width:100%/, "a weekly-constrained day is not drawn as all-day");
});

test("the decoders keep the service's own grammar and reject what they cannot read", () => {
  assert.deepEqual(parseWeeklyText("mon 09:00-18:00\ntue 10:00-12:00"), { mon: [["09:00", "18:00"]], tue: [["10:00", "12:00"]] });
  assert.equal(parseWeeklyText("mon 9-18"), null, "malformed lines are not guessed");
  assert.equal(wallClockToInstant("2026-10-01T09:00", "Asia/Shanghai"), "2026-10-01T01:00:00.000Z");
  assert.equal(wallClockToInstant("2026-10-01T01:00:00.000Z", "Asia/Shanghai"), "2026-10-01T01:00:00.000Z", "an ISO instant passes through");
  const draft = decodeDraft({ label: "  x  ", enabled: ["false", "true"], csrf: "c", id: "p", mode: "revoke", capabilities: ["scope:obsidian.read"], w_mon_from_1: "", w_mon_to_1: "" });
  assert.equal(draft.label, "x");
  assert.equal(draft.enabled, true, "the checkbox wins over its hidden false partner");
  assert.deepEqual(draft.capabilities, ["all"]);
  assert.equal("csrf" in draft, false);
  assert.equal("id" in draft, false, "the path id is authoritative, never the body");
  const legacy = decodeDraft({ label: "legacy", mode: "suspend", subjects: "api-key:key-1", capabilities: "scope:obsidian.read tool:list_notes", weekly: "mon 00:00-24:00" });
  assert.deepEqual(legacy.subjects, ["api-key:key-1"], "a single-value text field is one subject");
  assert.deepEqual(legacy.capabilities, ["scope:obsidian.read", "tool:list_notes"], "a text capability list keeps the service's own splitting");
  assert.deepEqual(legacy.weekly, { mon: [["00:00", "24:00"]] });
});
