// AuthZ — Admin access-policy wiring integration tests (migrated to the greenfield Admin plane).
//
// These tests mount the *real* `createAdminRouter` in a real Express app and speak real HTTP over a
// loopback socket; the shared harness (store, app, HTTP helpers) lives in
// `helpers/access-policy-admin-http.js`. What stays here is the cross-cutting surface: the
// service-absent fail-closed shape, the #399 nav wiring, the secret/PII leak scan and the frozen
// write surface (Task 3 of the per-Vault plan: every legacy write answers 409
// `access_policy_frozen` and the page only shows what is stored). The page's own frozen structure is
// pinned in `access-policy-frozen.test.js`.
//
// Contract: `docs/admin/README.md` (Admin plane) + `scratch/authz/INTERFACE.md` §10.4/§10.6.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createAccessPolicyAdmin } from "../src/admin/access-policy.js";
import { parseAccessPolicyDocument } from "../src/access-policy/schema.js";
import {
  CREATE_FIELDS,
  MONDAY_INSIDE,
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

/**
 * Seed the legacy document through the *service*: Task 3 froze the write *routes*, not the store, so
 * a fixture can still be stored (and the page has something honest to show).
 */
async function seedPolicy(store, overrides = {}) {
  const admin = createAccessPolicyAdmin({ store, now: () => MONDAY_INSIDE });
  const created = await admin.createPolicy({ ...CREATE_FIELDS, ...overrides });
  assert.equal(created.ok, true, "the fixture policy must be stored");
  return created.policy;
}

test("the tab requires an admin session and renders the frozen 定时授权 page", async (t) => {
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
  // Frozen (Task 3): the page names the fact and points at the new constraint page. The credential
  // subjects the old 当前状态预览 listed are gone with the POST preview, so nothing on this surface
  // offers a subject picker any more.
  assert.match(page.body, /data-frozen="access_policy_frozen"/, "the read-only banner names the freeze");
  assert.match(page.body, /href="\/admin\/auth\/authz"/, "the banner points at the new page");
  assert.equal(page.body.includes('name="subject"'), false, "no subject picker survives the freeze");
});

test("every POST requires the existing admin CSRF token, and a valid one is still refused", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store });
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, TAB)).body);

  const rejected = await postForm(origin, cookie, `${TAB}/create`, CREATE_FIELDS);
  assert.equal(rejected.response.status, 403);
  assert.ok(rejected.body.includes("CSRF"));
  assert.equal(store.snapshot().revision, 0, "a CSRF failure must not write");

  // The CSRF gate stays in front of the freeze: a well-authenticated, well-tokened write is refused
  // with the frozen code, and it still writes nothing.
  const refused = await postForm(origin, cookie, `${TAB}/create`, CREATE_FIELDS, { csrf });
  assert.equal(refused.response.status, 409);
  assert.equal(JSON.parse(refused.body).error, "access_policy_frozen");
  assert.equal(store.snapshot().revision, 0, "a frozen write must not write");
});

test("a stored policy is still listed read-only, and a create is refused", async (t) => {
  const { file, store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store });
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, TAB)).body);

  // A create through the frozen route writes nothing…
  const created = await postForm(origin, cookie, `${TAB}/create`, CREATE_FIELDS, { csrf });
  assert.equal(created.response.status, 409);
  assert.equal(JSON.parse(created.body).error, "access_policy_frozen");
  assert.equal(store.snapshot().revision, 0, "the refused create must not reach the store");

  // … while a policy already in the document is still listed, with the same normalized shape.
  await seedPolicy(store);
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
  const seeded = await seedPolicy(store, {
    weekly: "mon 09:00-18:00\ntue 09:00-18:00\nwed 09:00-18:00\nthu 09:00-18:00\nfri 09:00-18:00",
    dateRanges: "2026-10-01..2026-10-07",
    startsAt: "2026-10-05T01:00:00.000Z",
    expiresAt: "2026-10-06T01:00:00.000Z",
  });
  const policyId = seeded.id;
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

  // Frozen: the ?edit= view shows the same stored values without a draft input — the full date range
  // and both bounds (wall clock + the stored UTC instant) stay readable.
  const editor = await getPage(origin, cookie, `${TAB}?edit=${policyId}`);
  assert.equal(editor.response.status, 200);
  assert.match(editor.body, /2026-10-01\.\.2026-10-07/, "the stored date range is readable");
  assert.match(editor.body, /<span class="mono">2026-10-05 09:00<\/span> <span class="muted mono">2026-10-05T01:00:00\.000Z<\/span>/, "the start bound keeps its wall clock and its stored UTC instant");
  assert.match(editor.body, /<span class="mono">2026-10-06 09:00<\/span> <span class="muted mono">2026-10-06T01:00:00\.000Z<\/span>/, "the expiry bound keeps its wall clock and its stored UTC instant");
  assert.equal(editor.body.includes("<form"), true, "only the app shell's own forms remain");
  assert.equal(editor.body.includes('name="range_from_1"'), false, "no draft input survives the freeze");
  assert.equal(store.snapshot().revision, revisionBefore, "opening the read-only view must not write");

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
  const seeded = await seedPolicy(store);
  const policyId = seeded.id;

  // Three refused writes — a well-formed delete, an unknown id and an invalid draft — plus a hostile
  // label. All four are refused by the freeze, so the scan has to read the refusal bodies: they must
  // carry the frozen code and nothing of the submitted draft.
  const stale = await postForm(origin, cookie, `${TAB}/delete`, { id: policyId, confirm: seeded.label, expectedRevision: "0" }, { csrf });
  const unknown = await postForm(origin, cookie, `${TAB}/delete`, { id: "policy-does-not-exist", confirm: seeded.label, expectedRevision: "1" }, { csrf });
  const invalid = await postForm(origin, cookie, `${TAB}/create`, {
    ...CREATE_FIELDS,
    label: "未知能力",
    capabilities: ["tool:definitely-not-a-tool"],
  }, { csrf });
  const hostile = await postForm(origin, cookie, `${TAB}/create`, {
    ...CREATE_FIELDS,
    label: "<script>alert(1)</script>",
    capabilities: ["tool:definitely-not-a-tool"],
  }, { csrf });
  for (const [name, refused] of Object.entries({ stale, unknown, invalid, hostile })) {
    assert.equal(refused.response.status, 409, `${name} is refused by the freeze`);
    assert.equal(JSON.parse(refused.body).error, "access_policy_frozen", `${name} carries the frozen code`);
    assert.equal(refused.body.includes("未知能力"), false, `${name} must not echo the submitted label`);
    assert.equal(refused.body.includes("<script>alert(1)</script>"), false, `${name} must not echo a hostile label`);
  }
  assert.equal(store.snapshot().revision, 1, "no refused write may commit");

  // Full policy JSON markers plus credential material must never be echoed. Raw substrings like
  // "secret"/"token"/"password" are intentionally not used: the prototype stylesheet
  // legitimately contains `.secret`/`[type=password]` and the sidebar contains "OAuth Token".
  const readOnly = await getPage(origin, cookie, `${TAB}?edit=${policyId}`);
  for (const [name, body] of Object.entries({
    page: page.body,
    readOnly: readOnly.body,
    stale: stale.body,
    unknown: unknown.body,
    invalid: invalid.body,
  })) {
    for (const marker of ["schemaVersion", "\"policies\"", "clientSecret", "accessToken", "refreshToken", "\"createdAt\"", "\"updatedAt\"", "\"revision\""]) {
      assert.equal(body.includes(marker), false, `${name} response leaked ${marker}`);
    }
    assert.doesNotMatch(body, /Bearer [A-Za-z0-9._-]{8,}/, `${name} response leaked a bearer token`);
  }
  // The list read before the write cannot echo the submitted draft at all.
  assert.equal(page.body.includes("工作时间"), false, "the pre-write list response echoed the submitted draft");
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
  // Task 7 item B: the 定时授权 entry opens the constraint page, so no nav row points at the frozen
  // legacy page any more. The frozen page stays reachable as the read-only link the new page renders.
  assert.ok(accessPolicyTabs.includes("/admin/auth/authz"), "the 定时授权 entry leads to the constraint page");
  assert.equal(accessPolicyTabs.includes(TAB), false, "the frozen page is not a nav entry any more");
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
    "/admin/auth/authz",
    "/admin/auth/vault-git",
  ]);
  assert.ok(/class="app"/.test(accessPolicy.body), "AuthZ must use the prototype app shell");
  assert.equal(/<nav class="tabs"/.test(accessPolicy.body), false, "AuthZ must not emit horizontal tabs");
  assert.ok(/href="\/admin\/auth\/authz"[^>]*data-hotkey="z"/.test(accessPolicy.body), "the 定时授权 nav row keeps its target and hotkey");

  // And the frozen page is still one click away: the constraint page renders it as its history link.
  const constraints = await getPage(origin, cookie, "/admin/auth/authz");
  assert.equal(constraints.response.status, 200, "the constraint page must render");
  assert.ok(constraints.body.includes(`href="${TAB}"`), "the new page links the frozen page");
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
  assert.ok(hrefs.includes("/admin/auth/authz"), "the 定时授权 tab must not regress");
  assert.equal(hrefs.includes(TAB), false, "and it points at the constraint page, not the frozen one");
  assert.ok(hrefs.includes("/admin/auth/vault-git"));
  assert.equal(hrefs.length, 9);
  assert.ok(/class="app"/.test(page.body), "Vault must use the prototype app shell");
  assert.equal(/<nav class="tabs"/.test(page.body), false, "Vault must not emit horizontal tabs");
  assert.ok(/href="\/admin\/auth\/vault-git"[^>]*aria-current="page"|class="ni on"[^>]*href="\/admin\/auth\/vault-git"/.test(page.body), "vault-git nav active");
});
