// AuthZ — Admin access-policy wiring integration tests (migrated to the greenfield Admin plane).
//
// These tests mount the *real* `createAdminRouter` in a real Express app and speak real HTTP over a
// loopback socket; the shared harness (store, app, HTTP helpers) lives in
// `helpers/access-policy-admin-http.js`. The AuthZ page's own structure and preserved write
// semantics (CAS 409, toggle/delete confirmations, revoke ⇒ `all`, preview, repair, the `?capq=`
// filter) are pinned in `admin-redo/authz.test.js`, which is the page's lane regression; what stays
// here is the cross-cutting surface: the service-absent fail-closed shape, the #399 nav wiring, the
// secret/PII leak scan and the persistence of a created policy.
//
// Contract: `docs/admin/README.md` (Admin plane) + `scratch/authz/INTERFACE.md` §10.4/§10.6.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseAccessPolicyDocument } from "../src/access-policy/schema.js";
import {
  CREATE_FIELDS,
  TAB,
  csrfFrom,
  getPage,
  login,
  makeStore,
  postForm,
  startAdmin,
  tabHrefs,
  vaultGitAdminStub,
} from "./helpers/access-policy-admin-http.js";

test("the tab requires an admin session and renders 定时授权 with the provider subjects", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store });

  const anonymous = await getPage(origin, null, TAB);
  assert.equal(anonymous.response.status, 303);
  assert.equal(anonymous.response.headers.get("location"), "/admin/auth/login");

  const cookie = await login(origin);
  const home = await getPage(origin, cookie, "/admin/auth");
  assert.equal(home.response.status, 200);
  assert.ok(home.body.includes("定时授权"), "the Auth Center nav must link the new tab");
  const page = await getPage(origin, cookie, TAB);
  assert.equal(page.response.status, 200);
  assert.ok(page.body.includes("定时授权"));
  assert.ok(page.body.includes("oauth-user:u1"), "subjects come from the provider snapshot");
  assert.ok(page.body.includes("api-key:key-1"));
  assert.ok(page.body.includes("oauth-client:client-1"));
});

test("every POST requires the existing admin CSRF token", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store });
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, TAB)).body);

  const rejected = await postForm(origin, cookie, `${TAB}/create`, CREATE_FIELDS);
  assert.equal(rejected.response.status, 403);
  assert.ok(rejected.body.includes("CSRF"));
  assert.equal(store.snapshot().revision, 0, "a CSRF failure must not write");

  const accepted = await postForm(origin, cookie, `${TAB}/create`, CREATE_FIELDS, { csrf });
  assert.equal(accepted.response.status, 303);
  assert.equal(store.snapshot().revision, 1);
});

test("create persists a normalized policy and the tab lists the new row", async (t) => {
  const { file, store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store });
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, TAB)).body);

  const created = await postForm(origin, cookie, `${TAB}/create`, CREATE_FIELDS, { csrf });
  assert.equal(created.response.status, 303);
  // The write answers with the prototype's result line, so the redirect carries `?done=`.
  assert.equal(created.response.headers.get("location"), `${TAB}?done=create`);

  const persisted = parseAccessPolicyDocument(await readFile(file, "utf8"));
  assert.equal(persisted.ok, true);
  assert.equal(persisted.document.revision, 1);
  const policy = persisted.document.policies[0];
  assert.equal(policy.label, "工作时间");
  assert.deepEqual(policy.subjects, ["oauth-user:u1"]);
  assert.equal(policy.enabled, true);
  assert.equal(policy.mode, "suspend");
  assert.deepEqual(policy.capabilities, ["scope:obsidian.read"]);
  assert.equal(policy.timezone, "Asia/Shanghai");
  assert.deepEqual(policy.weekly, { mon: [["09:00", "18:00"]] });
  assert.deepEqual(policy.dateRanges, []);
  assert.equal(Object.keys(policy).length, 13);

  const page = await getPage(origin, cookie, TAB);
  assert.equal(page.response.status, 200);
  assert.ok(page.body.includes("工作时间"));
  // The list renders the merged window summary (prototype `5-render.js` windowSummary), not the raw
  // weekly grid text the form posted.
  assert.ok(page.body.includes("周一 09:00–18:00"), "the row shows the merged window summary");
});

// #434 (migrated to the new AuthZ page): the 允许时间窗口 cell carries the merged weekly summary and
// the visible markers; `?window=<id>` opens the standalone drawer with the same view-model summary,
// the frozen scope disclaimer and the 7-day timeline. The full date range and the absolute bounds
// live in the editor's 允许访问的时间 fieldset — the prototype's own home for them (`5-render.js`
// `drow` / `datetime-local` + the UTC echo). Every read-only GET must leave the store untouched.
test("#434: the 窗口 cell carries the summary/markers and ?window= opens the detail drawer", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store });
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, TAB)).body);
  await postForm(origin, cookie, `${TAB}/create`, {
    ...CREATE_FIELDS,
    weekly: "mon 09:00-18:00\ntue 09:00-18:00\nwed 09:00-18:00\nthu 09:00-18:00\nfri 09:00-18:00",
    dateRanges: "2026-10-01..2026-10-07",
    startsAt: "2026-10-05T01:00:00.000Z",
    expiresAt: "2026-10-06T01:00:00.000Z",
  }, { csrf });
  const policyId = store.snapshot().policies[0].id;
  const revisionBefore = store.snapshot().revision;

  const list = await getPage(origin, cookie, TAB);
  assert.equal(list.response.status, 200);
  const cell = /<td><div class="nm"><span class="ell">([\s\S]*?)<\/span><span class="sub2">([\s\S]*?)<\/span><\/div><\/td>/.exec(list.body);
  assert.ok(cell, "the policy row must render its 允许时间窗口 cell");
  const [, summary, marks] = cell;
  assert.equal(summary, "工作日 09:00–18:00", "the merged weekly summary renders, not the raw grid");
  for (const marker of ["另有限定日期", "另有开始时间", "另有截止时间"]) {
    assert.ok(marks.includes(`<span class="tag">${marker}</span>`), `visible marker ${marker}: ${marks}`);
  }
  assert.ok(list.body.includes(`href="${TAB}?id=${policyId}"`), "the row identity links the standalone drawer");
  assert.equal(list.body.includes('<aside class="drawer on"'), false, "the drawer stays closed until requested");
  assert.equal(store.snapshot().revision, revisionBefore, "a read-only list GET must not write");

  const opened = await getPage(origin, cookie, `${TAB}?window=${policyId}`);
  assert.equal(opened.response.status, 200);
  const drawer = /<aside class="drawer on"[\s\S]*?<\/aside>/.exec(opened.body)?.[0] ?? "";
  assert.ok(drawer, "the detail drawer renders for ?window=");
  assert.ok(drawer.includes(`<b>${summary}</b>`), "the drawer repeats the same view-model summary as the cell");
  for (const marker of ["另有限定日期", "另有开始时间", "另有截止时间"]) {
    assert.ok(drawer.includes(marker), `the drawer keeps the marker ${marker}`);
  }
  assert.match(drawer, /仅表示生效时间窗口，不代表永久有效或当前允许/, "the frozen window disclaimer is visible");
  assert.match(drawer, /<div class="k">时区<\/div><div><span class="mono">Asia\/Shanghai<\/span>/);
  assert.equal((drawer.match(/<div class="tr">/g) ?? []).length, 7, "the timeline lists Mon→Sun");
  assert.match(drawer, /<div class="w" style="left:37\.5%;width:37\.5%" title="09:00–18:00">/, "the worked interval is drawn");
  assert.equal(store.snapshot().revision, revisionBefore, "a read-only ?window= GET must not write");

  const editor = await getPage(origin, cookie, `${TAB}?edit=${policyId}`);
  assert.match(editor.body, /name="range_from_1" value="2026-10-01"/);
  assert.match(editor.body, /name="range_to_1" value="2026-10-07"/);
  assert.match(editor.body, /name="startsAt" value="2026-10-05T09:00"/, "09:00 Asia/Shanghai is the wall clock for the stored instant");
  assert.match(editor.body, /name="expiresAt" value="2026-10-06T09:00"/);
  assert.match(editor.body, /存储为 <span class="mono">2026-10-05T01:00:00\.000Z<\/span>/, "the stored UTC instant is echoed");
  assert.equal(store.snapshot().revision, revisionBefore, "opening the editor must not write");

  const unknown = await getPage(origin, cookie, `${TAB}?window=does-not-exist`);
  assert.equal(unknown.response.status, 200);
  // The drawer's own not-found branch: an honest empty drawer, never another policy's window data.
  const emptyDrawer = /<aside class="drawer on"[\s\S]*?<\/aside>/.exec(unknown.body)?.[0] ?? "";
  assert.match(emptyDrawer, /策略不存在或已删除/);
  assert.equal(emptyDrawer.includes("允许时间窗口"), false, "a crafted id renders no window detail");
  assert.equal(store.snapshot().revision, revisionBefore, "the unknown-id GET must not write either");
});




test("no response leaks a secret, a token or the full policy JSON", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store });
  const cookie = await login(origin);
  const page = await getPage(origin, cookie, TAB);
  const csrf = csrfFrom(page.body);
  await postForm(origin, cookie, `${TAB}/create`, CREATE_FIELDS, { csrf });
  const policyId = store.snapshot().policies[0].id;

  // A stale CAS, an unknown id and a rejected draft — the three refusals that render an error
  // answer. The new plane keeps every write behind the same service + CSRF, so the leak scan has
  // to read their real bodies: a stale delete must clear the server-side label check first (the
  // typed-label confirmation is what the page demands), and an invalid draft is a value the
  // service's own schema rejects (an unknown capability), not a shape the page normalises away.
  const stale = await postForm(origin, cookie, `${TAB}/delete`, { id: policyId, confirm: CREATE_FIELDS.label, expectedRevision: "0" }, { csrf });
  const unknown = await postForm(origin, cookie, `${TAB}/delete`, { id: "policy-does-not-exist", confirm: CREATE_FIELDS.label, expectedRevision: "1" }, { csrf });
  const invalid = await postForm(origin, cookie, `${TAB}/create`, {
    ...CREATE_FIELDS,
    label: "未知能力",
    capabilities: ["tool:definitely-not-a-tool"],
  }, { csrf });
  assert.equal(stale.response.status, 409);
  assert.equal(unknown.response.status, 404);
  assert.equal(invalid.response.status, 400);
  assert.equal(store.snapshot().revision, 1, "no refused write may commit");

  // Full policy JSON markers plus credential material must never be echoed. Raw substrings like
  // "secret"/"token"/"password" are intentionally not used: the prototype stylesheet
  // legitimately contains `.secret`/`[type=password]` and the sidebar contains "OAuth Token".
  // The page *does* re-render the operator's own refused draft (the no-JS contract: the form comes
  // back filled), so that echo is checked for escaping below instead of being forbidden.
  for (const [name, body] of Object.entries({ page: page.body, stale: stale.body, unknown: unknown.body, invalid: invalid.body })) {
    for (const marker of ["schemaVersion", "\"policies\"", "clientSecret", "accessToken", "refreshToken", "\"createdAt\"", "\"updatedAt\"", "\"revision\""]) {
      assert.equal(body.includes(marker), false, `${name} response leaked ${marker}`);
    }
    assert.doesNotMatch(body, /Bearer [A-Za-z0-9._-]{8,}/, `${name} response leaked a bearer token`);
  }
  // The list read before the write cannot echo the submitted draft at all.
  assert.equal(page.body.includes("工作时间"), false, "the pre-write list response echoed the submitted draft");

  // A hostile draft comes back escaped — the refusal path re-renders the submitted form, so this is
  // where an unescaped echo would land.
  const hostile = await postForm(origin, cookie, `${TAB}/create`, {
    ...CREATE_FIELDS,
    label: "<script>alert(1)</script>",
    capabilities: ["tool:definitely-not-a-tool"],
  }, { csrf });
  assert.equal(hostile.response.status, 400);
  assert.match(hostile.body, /value="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/, "the submitted draft is re-rendered escaped");
  assert.doesNotMatch(hostile.body, /<script>alert\(1\)<\/script>/, "the raw draft never reaches the document");
  assert.equal(store.snapshot().revision, 1, "a refused draft must not persist");
});

test("without the injected service the tab is absent and no access-policy route exists", async (t) => {
  const { origin } = await startAdmin(t, { accessPolicyAdmin: null });
  const cookie = await login(origin);

  const home = await getPage(origin, cookie, "/admin/auth");
  assert.equal(home.response.status, 200);
  assert.deepEqual(tabHrefs(home.body).includes(TAB), false, "the nav (sidebar and mobile sheet) must not offer the 定时授权 tab without the service");
  assert.equal(home.body.includes(`href="${TAB}"`), false, "no dead link to the unregistered page");

  const tab = await getPage(origin, cookie, TAB);
  assert.equal(tab.response.status, 404, "the route must not be registered without the service");
});

// ---------------------------------------------------------- #399 nav wiring --
// The access-policy routes register before the vault-git routes, so both route modules must read the
// counterpart's base late (per request) through the router's `view` seam.

test("#399: the access-policy page renders the same 9-tab nav as the Auth Center once vault-git is injected", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store, vaultGitAdmin: vaultGitAdminStub() });
  const cookie = await login(origin);

  const accessPolicy = await getPage(origin, cookie, TAB);
  assert.equal(accessPolicy.response.status, 200);
  const accessPolicyTabs = tabHrefs(accessPolicy.body);
  assert.ok(accessPolicyTabs.includes("/admin/auth/vault-git"), "the access-policy page must link the Vault 与 Git tab");
  assert.ok(accessPolicyTabs.includes("/admin/auth/access-policy"));
  assert.equal(accessPolicyTabs.length, 9);

  const overview = await getPage(origin, cookie, "/admin/auth?tab=overview");
  assert.equal(overview.response.status, 200);
  const overviewTabs = tabHrefs(overview.body);
  assert.deepEqual(accessPolicyTabs, overviewTabs, "both pages must render the identical, ordered tab set");
  assert.deepEqual(overviewTabs, [
    "/admin/auth?tab=overview",
    "/admin/auth?tab=accounts",
    "/admin/auth?tab=keys",
    "/admin/auth?tab=clients",
    "/admin/auth?tab=tokens",
    "/admin/auth?tab=publishes",
    "/admin/auth?tab=audit",
    "/admin/auth/access-policy",
    "/admin/auth/vault-git",
  ]);
  assert.ok(/class="app"/.test(accessPolicy.body), "AuthZ must use the prototype app shell");
  assert.equal(/<nav class="tabs"/.test(accessPolicy.body), false, "AuthZ must not emit horizontal tabs");
  assert.ok(/href="\/admin\/auth\/access-policy"[^>]*aria-current="page"|class="ni on"[^>]*href="\/admin\/auth\/access-policy"/.test(accessPolicy.body), "access-policy nav active");
});

test("#399 negative control: without the vault-git service the tab is absent and /vault-git is 404", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store, vaultGitAdmin: null });
  const cookie = await login(origin);

  const accessPolicy = await getPage(origin, cookie, TAB);
  assert.equal(accessPolicy.response.status, 200, "the access-policy page must still render");
  const hrefs = tabHrefs(accessPolicy.body);
  assert.equal(hrefs.length, 8, "only the access-policy tab is added on top of the 7 base tabs");
  assert.equal(hrefs.includes("/admin/auth/vault-git"), false);
  assert.equal(accessPolicy.body.includes("Vault 与 Git"), false);

  const vaultGit = await getPage(origin, cookie, "/admin/auth/vault-git");
  assert.equal(vaultGit.response.status, 404, "the route must not be registered without the service");
});

test("#399 reverse: the vault-git page keeps its 定时授权 tab and the same 9-tab nav", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store, vaultGitAdmin: vaultGitAdminStub() });
  const cookie = await login(origin);

  const page = await getPage(origin, cookie, "/admin/auth/vault-git");
  assert.equal(page.response.status, 200);
  const hrefs = tabHrefs(page.body);
  assert.ok(hrefs.includes("/admin/auth/access-policy"), "the 定时授权 tab must not regress");
  assert.ok(hrefs.includes("/admin/auth/vault-git"));
  assert.equal(hrefs.length, 9);
  assert.ok(/class="app"/.test(page.body), "Vault must use the prototype app shell");
  assert.equal(/<nav class="tabs"/.test(page.body), false, "Vault must not emit horizontal tabs");
  assert.ok(/href="\/admin\/auth\/vault-git"[^>]*aria-current="page"|class="ni on"[^>]*href="\/admin\/auth\/vault-git"/.test(page.body), "vault-git nav active");
});
