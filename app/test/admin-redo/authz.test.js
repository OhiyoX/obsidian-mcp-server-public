// Lane W3-authz — 定时授权 page + route module regression.
//
// Everything below runs against the *real* service stack: a real A3 access-policy store in a temp
// directory, the real A4 runtime, the real Admin service (`createAccessPolicyAdmin`) and the real
// `createAdminRouter` (session, CSRF, tab dispatch) over a real Express listener. The provider is a
// deterministic credential snapshot stub, because the page only consumes that snapshot.
//
// What is pinned here (prototype source: `docs/admin-ui-proto/src/5-render.js` list 348–382 /
// editor 382–456, interaction rules `docs/admin-ui-proto/README.md` 定时授权 row):
//   1. the list table's columns, cell shapes, ⋯ menu and drawer links;
//   2. the detail drawer (`?id=`, `?window=` alias) and the editor (`?edit=`/`?new=`) content;
//   3. every POST form carries the session CSRF, and no page needs script to work;
//   4. the preserved service semantics: create/update(CAS)/toggle(confirm)/delete(type-to-confirm)/
//      preview/repair, the revoke ⇒ `all` lock, the orphan-subject path and the broken-store repair
//      entry point;
//   5. a negative control proving the structural assertions can actually go red.
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
function assertConfirmInputBound(html, label) {
  const input = /<input[^>]*name="confirm"[^>]*>/.exec(html)?.[0] ?? "";
  const bound = /\bform="([^"]+)"/.exec(input)?.[1] ?? null;
  if (bound) {
    assert.ok(html.includes(`<form id="${bound}"`), `${label}: the input names form id ${bound}, which must exist`);
    return;
  }
  const index = html.indexOf('name="confirm"');
  for (const match of html.matchAll(/<form\b[^>]*>/g)) {
    const start = match.index ?? 0;
    const closes = html.indexOf("</form>", start);
    if (closes > 0 && index > start && index < closes) return;
  }
  assert.fail(`${label}: the input must belong to the POST form (inside it, or bound by form=)`);
}

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

/** The structured editor form body (the shape the rendered editor really posts). */
function formFields(overrides = {}) {
  return {
    label: "研究机器人仅工作时间",
    enabled: ["false", "true"],
    mode: "suspend",
    timezone: "Asia/Shanghai",
    subjects: [SUBJECT],
    capabilities: ["scope:obsidian.read"],
    w_mon_from_1: "09:00", w_mon_to_1: "18:00",
    w_tue_from_1: "09:00", w_tue_to_1: "18:00",
    ...overrides,
  };
}

async function createPolicy(origin, cookie, overrides = {}) {
  const csrf = csrfOf((await get(origin, cookie, `${BASE}?new=1`)).body);
  const created = await post(origin, cookie, `${BASE}/create`, { csrf, ...formFields(overrides) });
  assert.equal(created.status, 303, `create must redirect, got ${created.status}: ${created.body.slice(0, 400)}`);
  const list = (await get(origin, cookie, BASE)).body;
  const id = /[?&]id=([0-9a-f-]{36})/.exec(list)?.[1] ?? null;
  assert.ok(id, "the created policy must expose its id");
  return id;
}

// ------------------------------------------------------------------ structure

/** The list-page contract. Kept as a function so the negative control can run the same assertions. */
function assertListStructure(html, label = "研究机器人仅工作时间") {
  const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headers, ["策略", "状态 · 模式", "主体", "限制的能力", "允许时间窗口", ""], "the prototype's six columns, in order");
  assert.match(html, /<div class="banner acc">[\s\S]*定时授权只会在既有权限基础上<b>再加限制<\/b>/, "the master banner explains the restriction direction");
  assert.match(html, /技术细节[\s\S]*策略修订号 <span class="mono">\d+<\/span>/, "the tech detail carries the CAS revision");
  assert.match(html, /<div class="futonly bm"[\s\S]*switch[\s\S]*规划中 · Stage 5/, "the master switch stays a planned, non-interactive marker");
  assert.ok(html.includes(`<div class="nm"><b>${label}</b><span class="sub2"><code class="idc"`), "the policy cell leads with the label and keeps the id on the secondary line");
  assert.match(html, /窗口外暂停/, "the status cell names the outside-the-window behaviour");
  assert.match(html, /<div class="tags">[\s\S]*读取/, "the capability column renders capability names");
  assert.match(html, /<details class="mn"><summary[^>]*aria-label="更多操作"/, "the row menu is a <details> menu, not a scripted popover");
  assert.match(html, /[?&]edit=/, "the row menu offers the editor");
  // …and the *first* `?edit=`/`?id=` link the page offers must be an editor surface (same discovery
  // rule as the Admin layout browser gate's `editorHref`): the row's primary link opens the editor
  // (prototype `data-open="policy"` → `#/authz/<id>`), while 查看详情 in the ⋯ menu opens the
  // read-only drawer. A page whose first editor-ish link opened a surface without the capability
  // picker is exactly how the #406 gate used to probe a page with zero checkboxes.
  const nonEditor = /^(tab|new|window|confirm|copy|weeklypreset|capq|q|page|pagesize|sort|order|outcome|action|credential|source|origin|focus)$/i;
  const paramsOf = (href) => [...new URLSearchParams(href.slice(href.indexOf("?") + 1))];
  const usable = (href) => href.startsWith(`${BASE}?`) && !href.includes("new=") && paramsOf(href).some(([name, value]) => value && !nonEditor.test(name));
  const firstEditorLink = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1].replace(/&amp;/g, "&")).find((href) => usable(href) && paramsOf(href).some(([name, value]) => value && /^(edit|id|policy|policyid|policy_id)$/i.test(name)));
  assert.match(firstEditorLink ?? "", /[?&]edit=/, `the first editor-ish link must open the editor, got ${firstEditorLink}`);
  assert.match(html, /[?&]confirm=delete&(?:amp;)?id=/, "the row menu routes delete through its confirm page");
  assert.match(html, /<div class="sect" id="preview"><div class="sect-h"><h2>当前状态预览<\/h2>/, "the preview section is the prototype's");
  // Wave R: the form carries `form-block` (Q11: an inline-flex form gave the `width:100%` select no
  // definite width, so the row wrapped and the preview card grew a line), `data-preview-form` (the
  // list module answers a pick in place from the server's own POST) and `data-autosubmit` (the
  // prototype's "pick and it submits" behaviour); the no-JS path is unchanged: real POST, real CSRF.
  assert.match(html, /<form class="inline-form form-block" method="post" action="\/admin\/auth\/access-policy\/preview" data-preview-form><input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="view" value="list"><div style="display:flex;gap:8px;flex-wrap:wrap"><select class="sel" name="subject"[^>]*\sdata-autosubmit/, "the preview form is a real POST form with the session CSRF (prototype `.card > div > select` shape, carried by a block inline form so the select can submit without script and without wrapping)");
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

test("the list page renders the prototype table, banners, preview form and never needs script", async (t) => {
  const { origin, cookie } = await startFixture(t);
  await createPolicy(origin, cookie);
  const page = await get(origin, cookie, `${BASE}?done=create`);
  assert.equal(page.status, 200);
  assertListStructure(page.body);
  assertEveryPostFormCarriesCsrf(page.body);
  assert.match(page.body, /<div class="result ok"[^>]*>[\s\S]*策略已创建。/, "a write result is a `.result` line, not a toast");
  assert.match(page.body, /<a class="btn primary" href="\/admin\/auth\/access-policy\?new=1">/, "the header keeps the new-policy CTA as a real link");
});

test("the empty state is the prototype's `.empty` with a working CTA", async (t) => {
  const { origin, cookie } = await startFixture(t);
  const page = await get(origin, cookie, BASE);
  assert.equal(page.status, 200);
  assert.match(page.body, /<div class="empty"><div class="ic">[\s\S]*还没有定时授权策略[\s\S]*为某个 Key、客户端或账户设置可访问的时间段/);
  assert.match(page.body, /href="\/admin\/auth\/access-policy\?new=1"/, "the empty state links to the editor");
});

test("negative control: the structural assertions are not vacuous", async (t) => {
  const { origin, cookie } = await startFixture(t);
  await createPolicy(origin, cookie, { label: "负控策略" });
  const html = (await get(origin, cookie, BASE)).body;
  assertListStructure(html, "负控策略"); // green on the real page

  // (1) removing a required element must turn the same assertions red …
  assert.throws(() => assertListStructure(html.replace(/<div class="sect" id="preview">[\s\S]*$/, ""), "负控策略"), /preview section/);
  // (2) … and so must a lost <details> row menu …
  assert.throws(() => assertListStructure(html.replace(/<details class="mn">/g, "<div class=\"mn\">"), "负控策略"), /details/);
  // (3) … and a POST form that lost its CSRF token.
  assert.throws(() => assertEveryPostFormCarriesCsrf(html.replace(/name="csrf"/g, 'name="csrf-removed"')), /CSRF/);
  // (4) escaping: a label can never inject markup, and dropping the escape is caught.
  await createPolicy(origin, cookie, { label: "<script>alert(1)</script>" });
  const hostile = (await get(origin, cookie, BASE)).body;
  assert.match(hostile, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "the label is escaped");
  assert.doesNotMatch(hostile, /<script>alert\(1\)<\/script>/, "the raw label never reaches the document");
  assert.throws(() => assertListStructure(hostile.replace(/&lt;script&gt;/g, "<script>"), "<script>alert(1)</script>"), /label|no script/);
});

// ------------------------------------------------------------------ drawer + editor

test("the detail drawer (`?id=` and the `?window=` alias) shows fields, window detail and the danger zone", async (t) => {
  const { origin, cookie } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
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
    assert.match(page.body, /<div class="danger-zone">[\s\S]*停止|停用策略/, "the drawer owns the danger zone");
    assert.match(page.body, /[?&]confirm=delete&(?:amp;)?id=/, "delete routes through the confirm page");
    assertEveryPostFormCarriesCsrf(page.body);
  }
  const missing = await get(origin, cookie, `${BASE}?id=00000000-0000-4000-8000-000000000000`);
  assert.equal(missing.status, 200);
  assert.match(missing.body, /策略不存在或已删除/, "an unknown id renders an empty drawer, not a crash");
});

/**
 * The editor's control contract (the Admin layout browser gate's #406 terms): the capability
 * catalogue and the subject choices are **native checkboxes**, and their prototype class shells
 * (`details.cap-g` > `summary.cap-h` > `div.cap-b`, and `div.pick-list` > `label.pick`) are what
 * wraps them — a paraphrase that drops the shell, or a `<select multiple>` stand-in, breaks the
 * gate's probe. (The `.chips > label.chip` shell an earlier lane used for the subject rows was
 * replaced in Wave P by the prototype's own `.pick` rows — the shape gate compares that shape.)
 */
function assertEditorControls(html) {
  assert.match(html, /<details class="cap-g"[^>]*><summary class="cap-h[^"]*">[\s\S]*?<div class="cap-b"><label class="chk"><input type="checkbox" name="capabilities" value=/, "capability groups are details.cap-g > summary.cap-h > div.cap-b around native checkboxes");
  assert.match(html, /<div class="pick-list scroll"><div class="pick-g"><span>[^<]+<\/span><span>\d+<\/span><\/div><label class="pick"[^>]*><input type="checkbox" name="subjects" value="api-key:key-1" checked><div class="nm"><b[^>]*>研究机器人<\/b><span class="sub2">[\s\S]*?<span class="mono">key-1<\/span>/, "subject choices are the prototype's `.pick-list` rows (`.pick-g` header + `label.pick`) wrapping native checkboxes, keeping the prototype row structure (.nm/.sub2)");
  assert.doesNotMatch(html, /<select[^>]*name="(?:subjects|capabilities)"/, "neither picker is a <select>");
  assert.doesNotMatch(html, /<input[^>]*name="(?:subjects|capabilities)"[^>]*type="hidden"/, "and neither is submitted as one opaque hidden field");
}

test("the editor renders every prototype field group and posts the structured form", async (t) => {
  const { origin, cookie } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const page = await get(origin, cookie, `${BASE}?edit=${id}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /<div class="ped">/, "the prototype editor shell");
  assert.match(page.body, /<form class="ped-form" id="authz-form" method="post" action="\/admin\/auth\/access-policy\/update">/);
  for (const legend of ["基本信息", "主体", "限制的能力", "允许访问的时间"]) {
    assert.match(page.body, new RegExp(`<legend>${legend}`), `fieldset ${legend} is present`);
  }
  assert.match(page.body, /name="label"[^>]*maxlength="120"[^>]*value="研究机器人仅工作时间"/, "the label field is prefilled");
  assert.match(page.body, /name="mode" value="suspend" checked/, "the mode radios keep the stored mode");
  assert.match(page.body, /name="timezone"[^>]*value="Asia\/Shanghai"/, "the timezone is a real field");
  assert.match(page.body, /name="w_mon_from_1" value="09:00"/, "the weekly grid keeps the stored interval");
  assert.match(page.body, /name="subjects" value="api-key:key-1" checked/, "the stored subject is checked");
  assert.match(page.body, /name="capabilities" value="scope:obsidian.read" checked/, "the stored capability is checked");
  assertEditorControls(page.body);
  assert.match(page.body, /<aside class="ped-side"><div class="stick">/, "the preview column is the prototype aside");
  assert.match(page.body, /<div class="sect-h"><h2>生效预览<\/h2>/, "the preview derives from the draft");
  assert.match(page.body, /对主体的影响/, "the per-subject impact block renders");
  assert.match(page.body, /name="capq"/, "the capability filter is reachable (`?capq=`)");
  assert.match(page.body, /name="subjq"/, "the subject filter is reachable (`?subjq=`)");
  assert.match(page.body, /<div class="ped-foot">[\s\S]*form="authz-form">保存策略/, "the sticky foot submits the form");
  assert.match(page.body, /href="\/admin\/auth\/access-policy\?confirm=delete&(?:amp;)?id=/, "the editor keeps the delete entry point");
  assertEveryPostFormCarriesCsrf(page.body);

  const created = await get(origin, cookie, `${BASE}?new=1`);
  assert.match(created.body, /新建策略/, "the create editor is reachable");
  assert.match(created.body, /id="fld-label" name="label" maxlength="120" required[^>]*value=""/, "a new policy starts empty");

  const filtered = await get(origin, cookie, `${BASE}?edit=${id}&capq=tool:list_n`);
  assert.match(filtered.body, /name="capabilities" value="scope:obsidian.read" checked/, "the filter never drops the stored selection (RETURN-3 P1)");
  // The prototype's capability panel has no “已选但不匹配筛选” note line (Wave P removed the one the
  // plane used to add): the kept selection is visible as the group header's `.tag.acc 已选 N` and as
  // the `.pill` in the selected row, and the filter-keeps-selection contract is asserted above and by
  // `admin-layout-capq`. The panel still renders the filter and the groups, in the prototype's shape.
  assert.match(filtered.body, /<div class="picker"><label class="search">[\s\S]*?name="capq"[\s\S]*?<details class="cap-g"/, "the capability filter sits inside the panel (prototype `.picker > .search`), not in a toolbar of its own");

  const subjectFiltered = await get(origin, cookie, `${BASE}?edit=${id}&subjq=zzz-no-such-subject`);
  assert.match(subjectFiltered.body, /name="subjects" value="api-key:key-1" checked/, "the subject filter keeps the checked subject visible");
  assert.doesNotMatch(subjectFiltered.body, /name="subjects" value="oauth-user:u-1"/, "and narrows the unchecked ones away");
  const subjectKept = await get(origin, cookie, `${BASE}?edit=${id}&subjq=key-1`);
  assert.match(subjectKept.body, /name="subjects" value="api-key:key-1" checked/, "matching by id keeps the subject");
});

test("negative control: the editor's control contract is not vacuous", async (t) => {
  const { origin, cookie } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const html = (await get(origin, cookie, `${BASE}?edit=${id}`)).body;
  assertEditorControls(html); // green on the real page
  // (1) unwrapping the prototype group shell must turn the same assertion red …
  assert.throws(() => assertEditorControls(html.replace(/<div class="cap-b">/g, '<div class="cap-b-removed">')), /cap-g/);
  // (2) … and so must a subject control that is no longer a checkbox inside a chip …
  assert.throws(() => assertEditorControls(html.replace(/<label class="pick"/g, '<span class="pick"')), /pick/);
  // (3) … and a catalogue replaced by one opaque native multi-select.
  assert.throws(() => assertEditorControls(html.replace(/<div class="picker">[\s\S]*$/, '<select name="capabilities" multiple><option>all</option></select>')), /select|cap-g/);
});

/**
 * Every boundary value the weekly grid renders has to be one a **browser** will submit back.
 *
 * `<input type="time">` only holds 00:00–23:59, so a `24:00` end (the schema's end-of-day value,
 * which the editor's own 「每天」preset writes) is silently emptied by the browser: the form then
 * posts an asymmetric row and the service answers `INVALID_WINDOW` 400 — an untouched save fails.
 * This helper fails when a value the browser discards is handed to a native time input again.
 */
function assertWeeklyBoundaries(html) {
  const ends = [...html.matchAll(/name="w_[a-z]{3}_to_(\d+)" value="([^"]*)"/g)].map((match) => match[2]);
  assert.deepEqual(ends.filter((value) => value && !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/.test(value)), [], "every rendered end boundary is a clock time or 24:00");
  assert.ok(ends.includes("24:00"), "a full-day end is carried as the schema's 24:00");
  const timeInputs = [...html.matchAll(/<input[^>]*type="time"[^>]*>/g)].map((match) => match[0]);
  for (const tag of timeInputs) {
    const value = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
    assert.ok(value === "" || /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value), `a native time input must not be handed a value the browser empties: ${tag}`);
  }
}

test("the 「每天」preset writes the empty weekly record, and an explicit 24:00 still round-trips", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const csrf = csrfOf((await get(origin, cookie, `${BASE}?new=1`)).body);

  // 2026-10-21: 「每天」 now means the EMPTY weekly record (the field's own hint: 留空 = 每天全天). It used
  // to write seven explicit 00:00–24:00 intervals, which rendered seven meaningless rows and stored noise.
  const preset = await get(origin, cookie, `${BASE}?new=1&weeklyPreset=all`);
  assert.equal(preset.status, 200);
  assert.equal(/class="wrow"/.test(preset.body), false, "the every-day preset renders no per-day ROWS");
  assert.match(preset.body, /当前等价于「每天全天」/, "the editor says why there are no rows");
  assert.match(preset.body, /name="w_mon_to_1" value="24:00"/, "the value still travels as a hidden field");
  // Submit exactly what the collapsed page renders (hidden fields included) — the point of the collapse
  // is that the seven all-day intervals still reach the server.
  const presetFields = Object.fromEntries([...preset.body.matchAll(/name="(w_[a-z]{3}_(?:from|to)_\d+)" value="([^"]*)"/g)].map((match) => [match[1], match[2]]));
  assert.equal(Object.keys(presetFields).length, 14, "seven days x from/to are carried as hidden fields");
  const createdPreset = await post(origin, cookie, `${BASE}/create`, { csrf, ...formFields({ label: "每天全天", ...presetFields }) });
  assert.equal(createdPreset.status, 303, `an untouched preset form must save, got ${createdPreset.status}`);
  const presetPolicy = store.snapshot().policies.find((item) => item.label === "每天全天");
  assert.deepEqual(presetPolicy.weekly, { mon: [["00:00", "24:00"]], tue: [["00:00", "24:00"]], wed: [["00:00", "24:00"]], thu: [["00:00", "24:00"]], fri: [["00:00", "24:00"]], sat: [["00:00", "24:00"]], sun: [["00:00", "24:00"]] }, "the collapsed rows still submit seven all-day intervals");

  // The 24:00 boundary still has to survive the form: an explicit slot keeps a TEXT field (a native
  // `type=time` would drop 24:00), and the rendered value comes back to the server unchanged.
  const explicit = await post(origin, cookie, `${BASE}/create`, {
    csrf, ...formFields({ label: "显式全天", w_mon_from_1: "00:00", w_mon_to_1: "24:00" }),
  });
  assert.equal(explicit.status, 303, `an explicit 24:00 slot must save, got ${explicit.status}`);
  const explicitPolicy = store.snapshot().policies.find((item) => item.label === "显式全天");
  assert.deepEqual(explicitPolicy.weekly.mon, [["00:00", "24:00"]], "the Monday slot round-trips 24:00");
  const editor = await get(origin, cookie, `${BASE}?edit=${explicitPolicy.id}`);
  assertWeeklyBoundaries(editor.body);
  assert.match(editor.body, /name="w_mon_to_1" value="24:00"/);

  // A policy written as seven explicit all-day intervals means the same thing; the editor collapses it
  // into one line instead of seven 00:00–24:00 rows (that noise is what the owner saw).
  const allDays = {};
  for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) { allDays[`w_${day}_from_1`] = "00:00"; allDays[`w_${day}_to_1`] = "24:00"; }
  const createdAll = await post(origin, cookie, `${BASE}/create`, { csrf, ...formFields({ label: "七天显式", ...allDays }) });
  assert.equal(createdAll.status, 303, `an explicit seven-day policy must save, got ${createdAll.status}`);
  const allPolicy = store.snapshot().policies.find((item) => item.label === "七天显式");
  const collapsed = await get(origin, cookie, `${BASE}?edit=${allPolicy.id}`);
  assert.equal(/class="wrow"/.test(collapsed.body), false, "seven explicit all-day intervals collapse to no rows");
  assert.match(collapsed.body, /当前等价于「每天全天」/, "and the editor says so");
  // Negative control: the same pin goes red when a 24:00 end is put into a native time input.
  assert.throws(
    () => assertWeeklyBoundaries(editor.body.replace(/name="w_mon_to_1" value="24:00"/, 'type="time" name="w_mon_to_1" value="24:00"')),
    /time input/,
  );
});

// ------------------------------------------------------------------ preserved semantics

test("an untouched `?capq=`-filtered save keeps the stored selection", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const filtered = await get(origin, cookie, `${BASE}?edit=${id}&capq=tool:list_n`);
  assert.match(filtered.body, /name="capabilities" value="scope:obsidian.read" checked/, "the filtered editor still renders the stored capability, checked (RETURN-3 P1)");
  // Exactly what the rendered page would submit: the checked boxes only.
  const checked = (field) => [...filtered.body.matchAll(new RegExp(`name="${field}" value="([^"]+)" checked>`, "g"))].map((match) => match[1].replace(/&amp;/g, "&"));
  const capabilities = checked("capabilities");
  const subjects = checked("subjects");
  assert.deepEqual(capabilities, ["scope:obsidian.read"], "the filtered form carries the selection the filter narrowed away");
  assert.deepEqual(subjects, [SUBJECT], "…and the stored subject");
  const saved = await post(origin, cookie, `${BASE}/update`, {
    csrf: csrfOf(filtered.body), id, ...formFields({ subjects, capabilities }), expectedRevision: store.snapshot().revision,
  });
  assert.equal(saved.status, 303, `an untouched filtered save must succeed, got ${saved.status}`);
  assert.deepEqual(store.snapshot().policies[0].capabilities, ["scope:obsidian.read"], "the filtered-out selection is not silently revoked");
  assert.deepEqual(store.snapshot().policies[0].subjects, [SUBJECT]);
});

test("create decodes the structured grid, interprets bounds in the policy timezone and locks revoke to all", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const csrf = csrfOf((await get(origin, cookie, `${BASE}?new=1`)).body);
  const created = await post(origin, cookie, `${BASE}/create`, {
    csrf,
    ...formFields({
      label: "国庆窗口",
      w_mon_from_1: "09:00", w_mon_to_1: "18:00",
      w_mon_from_2: "20:00", w_mon_to_2: "22:00",
      range_from_1: "2026-10-01", range_to_1: "2026-10-07",
      startsAt: "2026-10-01T09:00",
      expiresAt: "2026-10-08T09:00",
    }),
  });
  assert.equal(created.status, 303);
  const policy = store.snapshot().policies.find((item) => item.label === "国庆窗口");
  assert.deepEqual(policy.weekly, { mon: [["09:00", "18:00"], ["20:00", "22:00"]], tue: [["09:00", "18:00"]] }, "the per-day grid becomes the schema's weekly record");
  assert.deepEqual(policy.dateRanges, [{ from: "2026-10-01", to: "2026-10-07" }]);
  assert.equal(policy.startsAt, "2026-10-01T01:00:00.000Z", "09:00 Asia/Shanghai is stored as the UTC instant");
  assert.equal(policy.expiresAt, "2026-10-08T01:00:00.000Z");

  const revoke = await post(origin, cookie, `${BASE}/create`, {
    csrf,
    ...formFields({ label: "硬撤销窗口", mode: "revoke", capabilities: ["scope:obsidian.read", "tool:list_notes"] }),
  });
  assert.equal(revoke.status, 303);
  const stored = store.snapshot().policies.find((item) => item.label === "硬撤销窗口");
  assert.deepEqual(stored.capabilities, ["all"], "revoke is locked to all (the schema's own invariant)");
  const editor = (await get(origin, cookie, `${BASE}?edit=${stored.id}`)).body;
  assert.match(editor, /<div class="cap-b"><label class="chk"><input type="checkbox" checked disabled><span><b>全部能力<\/b>/, "the revoke lock keeps the prototype group shell around its locked checkbox");
  assert.match(editor, /<input type="hidden" name="capabilities" value="all">/, "the editor renders the locked capability");
  assert.match(editor, /「撤销」模式只能作用于<b>全部能力<\/b>/, "and says why");

  // Compatibility probe: the previous form (and the existing browser gates) post `weekly` and
  // `dateRanges` as line text and `capabilities` as a whitespace-separated string. The service used
  // to split those itself; the decoder must keep accepting them.
  const legacy = await post(origin, cookie, `${BASE}/create`, {
    csrf,
    label: "旧表单编码",
    enabled: "true",
    mode: "suspend",
    timezone: "Asia/Shanghai",
    subjects: "api-key:key-1",
    capabilities: "scope:obsidian.read tool:list_notes",
    weekly: "mon 00:00-24:00",
    dateRanges: "2026-10-01..2026-10-07",
  });
  assert.equal(legacy.status, 303, "the legacy text encoding still creates a policy");
  const legacyStored = store.snapshot().policies.find((item) => item.label === "旧表单编码");
  assert.deepEqual(legacyStored.capabilities, ["scope:obsidian.read", "tool:list_notes"], "a whitespace-separated capability string is split exactly like the service did");
  assert.deepEqual(legacyStored.weekly, { mon: [["00:00", "24:00"]] });
  assert.deepEqual(legacyStored.dateRanges, [{ from: "2026-10-01", to: "2026-10-07" }]);
});

test("disabling asks first and only applies with the confirm POST; enabling applies directly", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const csrf = csrfOf((await get(origin, cookie, `${BASE}?id=${id}`)).body);

  const asked = await post(origin, cookie, `${BASE}/toggle`, { csrf, id, enabled: "false", expectedRevision: "1" });
  assert.equal(asked.status, 200);
  assert.match(asked.body, /<div class="modal show"[\s\S]*停用「研究机器人仅工作时间」？/, "a disable renders the prototype confirm modal");
  assert.match(asked.body, /停用后该策略不再限制任何主体/, "the consequence is spelled out");
  assert.equal(store.snapshot().policies[0].enabled, true, "nothing is written before the confirmation");

  const confirmed = await post(origin, cookie, `${BASE}/toggle`, { csrf, id, enabled: "false", expectedRevision: "1", confirmed: "1" });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.location, `${BASE}?done=toggle`);
  assert.equal(store.snapshot().policies[0].enabled, false);

  const enabled = await post(origin, cookie, `${BASE}/toggle`, { csrf, id, enabled: "true", expectedRevision: store.snapshot().revision });
  assert.equal(enabled.status, 303, "enabling needs no confirmation (prototype hierarchy)");
  assert.equal(store.snapshot().policies[0].enabled, true);
});

test("delete needs the typed label; a mismatch writes nothing and the confirm page explains it", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const confirmPage = await get(origin, cookie, `${BASE}?confirm=delete&id=${id}`);
  assert.equal(confirmPage.status, 200);
  assert.match(confirmPage.body, /<div class="modal show"[\s\S]*删除策略「研究机器人仅工作时间」？/);
  assert.match(confirmPage.body, /输入 <code>研究机器人仅工作时间<\/code> 以确认/);
  assert.match(confirmPage.body, /name="confirm"[^>]*required/, "type-to-confirm is a real input");
  // The typed input must be INSIDE the POST form, or a submission without JS would silently drop the
  // field and the server (by design) would refuse forever — the prototype's own order (input above the
  // button row) must be kept while doing so.
  {
    // The typed input is associated with the POST form: inside it, or a direct child of `.modal` that
    // names the form by id (the prototype's own child order, which the JS-off gate compares).
    assertConfirmInputBound(confirmPage.body, "the typed confirm input (no-JS delete)");
    const modal = /<div class="modal show"[\s\S]*?<\/div><\/div>/.exec(confirmPage.body)?.[0] ?? "";
    assert.ok(modal.indexOf('name="confirm"') < modal.indexOf('class="acts"'), "the input stays above the button row (prototype order)");
  }
  assertEveryPostFormCarriesCsrf(confirmPage.body);

  const csrf = csrfOf(confirmPage.body);
  const wrong = await post(origin, cookie, `${BASE}/delete`, { csrf, id, confirm: "研究机器人", expectedRevision: store.snapshot().revision });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body, /确认文字与策略名称不一致/, "a wrong label is reported, not ignored");
  assert.equal(store.snapshot().policies.length, 1, "the policy survives a failed confirmation");

  const right = await post(origin, cookie, `${BASE}/delete`, { csrf, id, confirm: "研究机器人仅工作时间", expectedRevision: store.snapshot().revision });
  assert.equal(right.status, 303);
  assert.equal(store.snapshot().policies.length, 0);
});

test("a stale CAS is a 409 that keeps the submitted draft and the stale revision", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const id = await createPolicy(origin, cookie);
  const editor = await get(origin, cookie, `${BASE}?edit=${id}`);
  const csrf = csrfOf(editor.body);
  // Another admin saves first, moving the store to revision 2.
  const other = await post(origin, cookie, `${BASE}/update`, { csrf, id, ...formFields({ label: "他人的改动" }), expectedRevision: "1" });
  assert.equal(other.status, 303);
  assert.equal(store.snapshot().revision, 2, "the other admin's save moved the revision");

  const stale = await post(origin, cookie, `${BASE}/update`, {
    csrf, id, ...formFields({ label: "我的改动" }), expectedRevision: "1",
  });
  assert.equal(stale.status, 409);
  assert.match(stale.body, /<b>保存冲突<\/b>/, "the prototype's conflict banner");
  assert.match(stale.body, /载入最新版本/, "the conflict banner offers the fresh version");
  assert.match(stale.body, /value="我的改动"/, "the operator's own draft is preserved");
  assert.match(stale.body, /name="expectedRevision" value="1"/, "the stale revision is kept, so a resubmit is rejected again");
  assert.equal(store.snapshot().policies[0].label, "他人的改动", "nothing was overwritten");

  // After reloading the latest revision the same draft saves.
  const fresh = await post(origin, cookie, `${BASE}/update`, { csrf, id, ...formFields({ label: "我的改动" }), expectedRevision: "2" });
  assert.equal(fresh.status, 303);
  assert.equal(store.snapshot().policies[0].label, "我的改动");
});

test("an orphaned subject is banner-ed, survives a save (advisory, not a blocker) and is removable", async (t) => {
  const state = { snapshot: snapshot() };
  const { origin, cookie, store } = await startFixture(t, { state });
  const id = await createPolicy(origin, cookie);
  // The credential behind the policy disappears from the snapshot.
  state.snapshot = snapshot({ apiKeys: [] });
  const list = await get(origin, cookie, BASE);
  assert.match(list.body, /<b>1 个孤立主体<\/b>/, "the prototype's amber orphan banner");
  assert.match(list.body, /它们不会再匹配任何请求/, "the banner says what an orphan really means");
  assert.match(list.body, /<span class="tag danger">孤立<\/span>/, "and the row-level 孤立 tag");

  // Advisory, not a save blocker: the frozen schema validates the subject *namespace*, not the
  // live snapshot, so a policy may keep referencing a deleted credential.
  const csrf = csrfOf((await get(origin, cookie, `${BASE}?id=${id}`)).body);
  const kept = await post(origin, cookie, `${BASE}/update`, { csrf, id, ...formFields(), expectedRevision: store.snapshot().revision });
  assert.equal(kept.status, 303, "an orphaned subject does not block a save");
  assert.deepEqual(store.snapshot().policies[0].subjects, [SUBJECT]);

  // A subject outside the frozen namespace is still rejected, against the preserved draft.
  const invalid = await post(origin, cookie, `${BASE}/update`, {
    csrf, id, ...formFields({ subjects: ["api-key:bad id*"] }), expectedRevision: store.snapshot().revision,
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body, /未知或非法的 subject/, "the service's UNKNOWN_SUBJECT hint is shown");
  assert.match(invalid.body, /value="研究机器人仅工作时间"/, "the draft survives the rejection");
  assert.deepEqual(store.snapshot().policies[0].subjects, [SUBJECT], "nothing was written");

  const fixed = await post(origin, cookie, `${BASE}/update`, {
    csrf, id, ...formFields({ subjects: ["oauth-user:u-1"] }), expectedRevision: store.snapshot().revision,
  });
  assert.equal(fixed.status, 303, "removing the orphan subject saves");
  assert.deepEqual(store.snapshot().policies[0].subjects, ["oauth-user:u-1"]);
});

test("preview asks the runtime and refuses a subject outside the snapshot", async (t) => {
  const { origin, cookie } = await startFixture(t);
  await createPolicy(origin, cookie);
  const csrf = csrfOf((await get(origin, cookie, BASE)).body);

  const known = await post(origin, cookie, `${BASE}/preview`, { csrf, subject: SUBJECT, view: "list" });
  assert.equal(known.status, 200);
  assert.match(known.body, /服务端判定：<b>(允许|拒绝)<\/b>/, "the runtime's own decision is shown");
  assert.match(known.body, /命中策略 \d+/, "and the matched policy count");
  assert.match(known.body, /不受定时授权限制|此刻允许|此刻暂停/, "plus the per-policy estimate");

  const unknown = await post(origin, cookie, `${BASE}/preview`, { csrf, subject: "oauth-user:ghost", view: "list" });
  assert.equal(unknown.status, 200);
  assert.match(unknown.body, /该主体不在当前凭据快照中/, "an unknown subject is refused, not explained");
});

test("a broken store still renders the repair entry point and can be repaired end to end", async (t) => {
  const { origin, cookie, store } = await startFixture(t, { corrupt: true });
  assert.equal(store.snapshot().status, "broken", "the fixture really starts with an unreadable policy file");
  const page = await get(origin, cookie, BASE);
  assert.equal(page.status, 200, "the Admin plane is never gated by the store it manages");
  assert.match(page.body, /<b>策略存储不可用<\/b>/, "the repair banner is rendered");
  assert.match(page.body, /name="document"[^>]*required/, "the repair form carries a real textarea");
  assert.match(page.body, /用此文档覆盖修复…/, "and the prototype's repair CTA");
  assert.match(page.body, /aria-disabled="true" title="策略存储不可用，修复后再新建"/, "creating is disabled while the store is broken (no fake CTA)");
  assertEveryPostFormCarriesCsrf(page.body);

  const document = '{"schemaVersion":1,"revision":0,"policies":[]}';
  const csrf = csrfOf(page.body);
  const asked = await post(origin, cookie, `${BASE}/repair`, { csrf, document });
  assert.equal(asked.status, 200);
  assert.match(asked.body, /输入 <code>覆盖<\/code> 以确认/, "repair is a two-step, typed confirmation");
  const done = await post(origin, cookie, `${BASE}/repair`, { csrf, document, confirm: "覆盖" });
  assert.equal(done.status, 303, "the confirmed repair commits");
  assert.equal(store.snapshot().status, "ready", "and the store is readable again");
});

test("repair goes through its own confirm page and an invalid document changes nothing", async (t) => {
  const { origin, cookie, store } = await startFixture(t);
  const csrf = csrfOf((await get(origin, cookie, BASE)).body);
  const document = '{"schemaVersion":1,"revision":0,"policies":[]}';
  const asked = await post(origin, cookie, `${BASE}/repair`, { csrf, document });
  assert.equal(asked.status, 200);
  assert.match(asked.body, /<div class="modal show"[\s\S]*用粘贴的文档覆盖策略存储？/, "the repair confirm is a modal page");
  assert.match(asked.body, /输入 <code>覆盖<\/code> 以确认/, "typed confirmation");
  assert.match(asked.body, /name="document" value="\{&quot;schemaVersion/, "the submitted document is carried into the confirm step");

  const rejected = await post(origin, cookie, `${BASE}/repair`, { csrf, document: "not json", confirm: "覆盖" });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /策略文档格式不正确/, "an invalid document is explained");
});

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
