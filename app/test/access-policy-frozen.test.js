// The legacy `access-policy` document is frozen (design §7 step 2 + step 5, plan Task 3).
//
// The per-Vault model now lives in its own durable document (Tasks 1-2), so the legacy document is
// history: its page still *shows* what is stored, honestly, and it accepts no write at all. `repair`
// is refused too (ruling R6): repairing a broken legacy store would resurrect editing.
//
// Every write is refused *before* it reaches the service, so the proof is threefold: the status, the
// frozen error code, and a service whose write methods are never called while the stored revision
// does not move.

import assert from "node:assert/strict";
import test from "node:test";

import { createAccessPolicyAdmin } from "../src/admin/access-policy.js";
import { LEGACY_POLICY_FROZEN_CODE } from "../src/admin/routes/access-policy.js";
import {
  CREATE_FIELDS,
  TAB,
  csrfFrom,
  getPage,
  login,
  makeStore,
  postForm,
  startAdmin,
} from "./helpers/access-policy-admin-http.js";

// Monday 2026-10-05, 05:00 UTC = 13:00 Asia/Shanghai (inside the stored 周一 09:00–18:00 window).
const MONDAY_INSIDE = Date.parse("2026-10-05T05:00:00.000Z");

/** The six legacy write endpoints, in the order the plan lists them. */
const WRITE_ENDPOINTS = Object.freeze(["create", "update", "toggle", "delete", "preview", "repair"]);

/** Every service entry a legacy write could reach — including `repair`'s and `preview`'s. */
const SERVICE_METHODS = Object.freeze([
  "createPolicy", "updatePolicy", "attachSubject", "setEnabled", "deletePolicy",
  "repairFromCandidate", "previewForSubject",
]);

/** A pass-through service copy that records which methods a refused request reached. */
function recordServiceCalls(admin) {
  const calls = [];
  const recorder = { ...admin };
  for (const name of SERVICE_METHODS) {
    if (typeof admin[name] !== "function") continue;
    recorder[name] = (...args) => {
      calls.push(name);
      return admin[name](...args);
    };
  }
  return { recorder, calls };
}

/** Seed the legacy document *through the service* — the freeze is a route/UI rule, not a store one. */
async function seedPolicy(store) {
  const admin = createAccessPolicyAdmin({ store, now: () => MONDAY_INSIDE });
  const created = await admin.createPolicy({ ...CREATE_FIELDS });
  assert.equal(created.ok, true, "the fixture policy must be stored");
  return { admin, policy: created.policy };
}

/** The page's own markup, minus the app shell's two forms (theme switch, logout — not this surface). */
function pageForms(body) {
  return body.replace(/<form class="inline-form" method="post" action="\/admin\/auth\/(?:theme|logout)">[\s\S]*?<\/form>/g, "");
}

test("every legacy write answers 409 access_policy_frozen and never reaches the service", async (t) => {
  const { store } = await makeStore(t);
  const { admin, policy } = await seedPolicy(store);
  const revision = store.snapshot().revision;
  const { recorder, calls } = recordServiceCalls(admin);
  const { origin } = await startAdmin(t, { store, accessPolicyAdmin: recorder });
  const cookie = await login(origin);
  const csrf = csrfFrom((await getPage(origin, cookie, TAB)).body);

  const bodies = {
    create: { ...CREATE_FIELDS },
    update: { ...CREATE_FIELDS, id: policy.id, expectedRevision: String(revision) },
    toggle: { id: policy.id, enabled: "false", confirmed: "1", expectedRevision: String(revision) },
    delete: { id: policy.id, confirm: policy.label, expectedRevision: String(revision) },
    preview: { subject: "oauth-user:u1", view: "list" },
    repair: { document: JSON.stringify({ schemaVersion: 1, revision: 0, policies: [] }), confirm: "覆盖" },
  };

  for (const endpoint of WRITE_ENDPOINTS) {
    const refused = await postForm(origin, cookie, `${TAB}/${endpoint}`, bodies[endpoint], { csrf });
    assert.equal(refused.response.status, 409, `${endpoint} must be refused with 409`);
    assert.match(String(refused.response.headers.get("content-type")), /application\/json/, `${endpoint} answers a machine-readable body`);
    const body = JSON.parse(refused.body);
    assert.equal(body.error, LEGACY_POLICY_FROZEN_CODE, `${endpoint} carries the frozen code`);
    assert.equal(body.error, "access_policy_frozen");
    assert.equal(store.snapshot().revision, revision, `${endpoint} must write nothing`);
  }

  // Ruling R6: the refusal copy itself has to say that repair is frozen as well.
  const repair = JSON.parse((await postForm(origin, cookie, `${TAB}/repair`, bodies.repair, { csrf })).body);
  assert.match(String(repair.message), /修复/, "the refusal copy names the frozen repair path");

  assert.deepEqual(calls, [], "no refused write may reach the admin service");
  assert.deepEqual(store.snapshot().policies, [policy], "the stored policy is untouched");
});

test("the frozen list renders the stored policies read-only, with the banner pointing at the new page", async (t) => {
  const { store } = await makeStore(t);
  const { policy } = await seedPolicy(store);
  const { origin } = await startAdmin(t, { store });
  const cookie = await login(origin);
  const revision = store.snapshot().revision;

  const page = await getPage(origin, cookie, TAB);
  assert.equal(page.response.status, 200);
  // Still honest: the stored row, its window summary and its now verdict.
  assert.ok(page.body.includes(policy.label), "the stored policy is still listed");
  assert.ok(page.body.includes("周一 09:00–18:00"), "the row keeps its merged window summary");
  assert.ok(page.body.includes("允许") || page.body.includes("限制"), "the row keeps its now verdict");
  // The banner, and where the operator goes now.
  assert.match(page.body, /本页已冻结/);
  assert.match(page.body, /href="\/admin\/auth\/authz"/);
  assert.match(page.body, new RegExp(`data-frozen="${LEGACY_POLICY_FROZEN_CODE}"`));
  // No write affordance survives: no POST form on this surface, no new/copy/delete/repair entry point.
  assert.doesNotMatch(pageForms(page.body), /<form[^>]+action="\/admin\/auth\/access-policy/, "no legacy POST form");
  assert.equal(page.body.includes(`?new=1`), false, "no 新建 policy link");
  assert.equal(page.body.includes("?copy="), false, "no 复制 policy link");
  assert.equal(page.body.includes("?confirm=delete"), false, "no delete confirmation link");
  assert.equal(page.body.includes(`action="${TAB}/repair"`), false, "no repair form");
  assert.equal(store.snapshot().revision, revision, "a read-only GET must not write");
});

test("the frozen editor renders the stored policy with no form and no submit control", async (t) => {
  const { store } = await makeStore(t);
  const { policy } = await seedPolicy(store);
  const { origin } = await startAdmin(t, { store });
  const cookie = await login(origin);
  const revision = store.snapshot().revision;

  const editor = await getPage(origin, cookie, `${TAB}?edit=${policy.id}`);
  assert.equal(editor.response.status, 200);
  // The stored values are still readable — nothing is hidden, it is only not editable.
  assert.ok(editor.body.includes(policy.label));
  assert.ok(editor.body.includes("Asia/Shanghai"));
  assert.match(editor.body, /本页已冻结/);
  // No form, no submit control, no draft-editing round trips (`?day=`, `?addSlot=`, `?weeklyPreset=`).
  const stripped = pageForms(editor.body);
  assert.equal(stripped.includes("<form"), false, "the frozen editor renders no form");
  assert.equal(stripped.includes(`type="submit"`), false, "the frozen editor renders no submit control");
  assert.equal(editor.body.includes("?new=1"), false, "no 新建 link from the frozen editor");

  // `?new=` and `?copy=` cannot even open a draft surface.
  for (const query of ["?new=1", `?copy=${policy.id}`]) {
    const draftPage = await getPage(origin, cookie, `${TAB}${query}`);
    assert.equal(draftPage.response.status, 200);
    assert.equal(pageForms(draftPage.body).includes("<form"), false, `${query} renders no form`);
    assert.equal(draftPage.body.includes("?addSlot=1"), false, `${query} offers no draft round trip`);
  }
  assert.equal(store.snapshot().revision, revision, "no read may write");
});

/**
 * I1: the frozen banner may not claim that the stored legacy policies are inert.
 *
 * `AUTHORIZATION_MODE` defaults to `legacy` and this release deploys it; `src/authorization/runtime.js`
 * answers from the legacy backend in every mode except `enforce`, so in `legacy` (and `shadow`) the
 * stored policies ARE the deciding state. The banner therefore states the mode the request is served
 * in and words the consequence for that mode. Both modes are pinned here, through the same page module
 * and the same router, so the copy cannot drift away from the runtime flag.
 */
test("the frozen banner states the authorization mode, and its claim follows that mode", async (t) => {
  const { store } = await makeStore(t);
  const { policy } = await seedPolicy(store);
  // `shadow` decides exactly like `legacy` (the shadow only RECORDS a second verdict), so it is pinned
  // with it: an operator who reads the wrong half of the pair could re-create a window that still
  // restricts access.
  const modes = ["legacy", "shadow", "enforce"];
  const seen = {};
  for (const mode of modes) {
    const { origin } = await startAdmin(t, { store, authorization: { summary: () => ({ mode }) } });
    const cookie = await login(origin);
    const page = await getPage(origin, cookie, TAB);
    assert.equal(page.response.status, 200);
    assert.match(page.body, new RegExp(`data-authorization-mode="${mode}"`), `the banner names the served mode (${mode})`);
    // The mode is rendered as plain text inside the sentence (no script, no span that could be
    // styled away): the operator reads which mode decided the truth of the sentence above it.
    assert.match(page.body, new RegExp(`当前授权模式：${mode}`), `the rendered copy states ${mode}`);
    seen[mode] = page.body;
    // In both modes the page states the one fact that cannot rot: no write.
    assert.match(page.body, /不接受任何写入/);
  }
  // legacy and shadow: the stored policies still decide, and the per-Vault model is not in effect yet
  // (ruling R10: the opening clause may not say it already is).
  for (const mode of ["legacy", "shadow"]) {
    assert.match(seen[mode], /仍然参与判定/, `${mode} mode must not claim the stored policies are inert`);
    assert.doesNotMatch(seen[mode], /不再参与判定/, `${mode} mode may not say the policies stopped deciding`);
    assert.match(seen[mode], /仍在建设中/, `${mode} mode says the constraint model is still being built`);
    assert.doesNotMatch(seen[mode], /由按 Vault 的约束模型裁定/, `${mode} mode may not say the constraints decide`);
  }
  assert.match(seen.enforce, /不再参与判定/, "enforce mode says the cutover happened");
  assert.doesNotMatch(seen.enforce, /仍然参与判定/, "enforce mode may not say the policies still decide");
  assert.match(seen.enforce, /由按 Vault 的约束模型裁定/, "enforce mode says the constraints run the plane");
  assert.doesNotMatch(seen.enforce, /仍在建设中/, "enforce mode may not say the model is still being built");

  // A router without an authorization runtime cannot read the mode: the page says so instead of guessing.
  const bare = await startAdmin(t, { store });
  const barePage = await getPage(bare.origin, await login(bare.origin), TAB);
  assert.match(barePage.body, /data-authorization-mode="unknown"/);
  assert.match(barePage.body, /读不到授权模式/, "an unreadable mode is stated, not invented");
  assert.doesNotMatch(barePage.body, /未提供/, "the mode is not reported as an absent value: it could not be read");
  assert.doesNotMatch(barePage.body, /仍然参与判定|不再参与判定/, "an unknown mode claims nothing about deciding");
});

/**
 * I1: the frozen page renders no per-policy verdict and no master switch where the policies decide
 * nothing — on the list, the `?id=` drawer and the `?edit=` view.
 *
 * `legacy` and `shadow` answer from the stored policies, so every verdict there is true and stays
 * (this test would go red if the move hid them) — and so does a mode that cannot be read: it is not
 * `enforce`, and its banner says the mode could not be read. In `enforce` the constraints decide: a
 * 现在（…） verdict or a switch read from the legacy runtime would contradict the banner right above
 * them.
 */
test("no surface states a legacy policy verdict where the constraints decide instead", async (t) => {
  const { store } = await makeStore(t);
  const { policy } = await seedPolicy(store);
  const NOW_VERDICT = /现在允许|现在受限|无法判定/;
  const DRAWER_VERDICT = /现在（/;
  const MASTER_SWITCH = /AuthZ 总开关/;
  const SUBJECT_IMPACT = /对主体的影响/;

  for (const [label, authorization] of [
    ["legacy", { summary: () => ({ mode: "legacy" }) }],
    ["shadow", { summary: () => ({ mode: "shadow" }) }],
    ["enforce", { summary: () => ({ mode: "enforce" }) }],
    ["unknown", null],
  ]) {
    const { origin } = await startAdmin(t, authorization ? { store, authorization } : { store });
    const cookie = await login(origin);
    const list = await getPage(origin, cookie, TAB);
    const drawer = await getPage(origin, cookie, `${TAB}?id=${policy.id}`);
    const editor = await getPage(origin, cookie, `${TAB}?edit=${policy.id}`);
    for (const [name, page] of [["list", list], ["drawer", drawer], ["editor", editor]]) {
      assert.equal(page.response.status, 200, `the ${label} ${name} must render`);
    }
    const decides = label !== "enforce";
    if (decides) {
      assert.match(list.body, NOW_VERDICT, `${label}: the list keeps the now verdict it can still prove`);
      assert.match(list.body, MASTER_SWITCH, `${label}: the master switch is still a live state`);
      assert.match(drawer.body, DRAWER_VERDICT, `${label}: the drawer keeps its now verdict`);
      assert.match(editor.body, DRAWER_VERDICT, `${label}: the editor keeps its now verdict`);
      assert.match(editor.body, SUBJECT_IMPACT, `${label}: the editor keeps the per-subject impact`);
    } else {
      assert.doesNotMatch(list.body, NOW_VERDICT, `${label}: the list must not state a legacy verdict`);
      assert.doesNotMatch(list.body, MASTER_SWITCH, `${label}: the master switch may not look live`);
      assert.doesNotMatch(drawer.body, DRAWER_VERDICT, `${label}: the drawer must not state a legacy verdict`);
      assert.doesNotMatch(editor.body, DRAWER_VERDICT, `${label}: the editor must not state a legacy verdict`);
      assert.doesNotMatch(editor.body, SUBJECT_IMPACT, `${label}: the editor must not state a per-subject impact`);
      // What it does say instead: the stored window, and where to configure timed authorization now.
      assert.match(list.body, /href="\/admin\/auth\/authz"/, `${label}: the page still links to the constraint page`);
      assert.match(drawer.body, /允许时间窗口/, `${label}: the drawer still shows the stored window`);
    }
  }
});

/**
 * Minor: a frozen endpoint must not be an oracle without a session.
 *
 * The refusal is the *third* step of the chain (`requireAdmin` → `requireCsrf` → refusal), so an
 * unauthenticated POST must answer the login redirect, not the frozen 409. Until now that claim rested
 * on middleware order alone; this pins it on every one of the seven endpoints, and pins that none of
 * them wrote anything.
 */
test("a frozen write without a session redirects to the login page, and never answers the frozen 409", async (t) => {
  const { store } = await makeStore(t);
  const { policy } = await seedPolicy(store);
  const revision = store.snapshot().revision;
  const { origin } = await startAdmin(t, { store });
  const endpoints = ["create", "update", "toggle", "delete", "preview", "repair", "subjects"];

  for (const endpoint of endpoints) {
    const response = await fetch(`${origin}${TAB}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id: policy.id, label: "x", csrf: "no-session" }),
      redirect: "manual",
    });
    assert.equal(response.status, 303, `${endpoint} without a session must redirect to the login page`);
    assert.match(String(response.headers.get("location")), /\/admin\/auth\/login/, `${endpoint} redirects to the login page`);
    const body = await response.text();
    assert.equal(body.includes(LEGACY_POLICY_FROZEN_CODE), false, `${endpoint} must not expose the frozen code to an anonymous caller`);
  }
  assert.equal(store.snapshot().revision, revision, "no anonymous request may write");
});
