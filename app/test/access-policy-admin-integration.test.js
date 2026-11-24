// AuthZ — the retired legacy Admin surface is gone, and 定时授权 still reaches the constraint page.
//
// Owner ruling 2026-11-12: the Admin speaks the per-Vault constraint model only. The legacy
// `access-policy` page, its `?edit=` view and its seven write routes are retired, so every legacy
// path answers 404 and the seven frozen 409 `access_policy_frozen` responses disappear with them.
// `/admin/auth/authz` is the whole 定时授权 surface.
//
// What stays is *data*: `data/access-policy.json` is still read once by the seed
// (`src/authorization/seed.js`) and by the legacy decision backend, so `AUTHORIZATION_MODE=legacy`
// remains a valid rollback. Those paths are pinned by the service-level tests
// (`access-policy-store`, `-runtime`, `authorization-seed`, `authorization-legacy-backend`).

import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATE_FIELDS,
  TAB,
  getPage,
  login,
  makeStore,
  postForm,
  startAdmin,
  tabHrefs,
  vaultGitAdminStub,
} from "./helpers/access-policy-admin-http.js";

/** The seven legacy writes (`src/admin/routes/access-policy.js`, deleted). */
const LEGACY_WRITES = Object.freeze(["create", "update", "toggle", "delete", "preview", "repair", "subjects"]);

test("every legacy page path answers 404 for a session", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store, vaultGitAdmin: vaultGitAdminStub() });

  // Without a session the shell's own GET guard still redirects to the login page: it runs before any
  // route matches, so an anonymous request never learns whether the path exists.
  const anonymous = await getPage(origin, null, TAB);
  assert.equal(anonymous.response.status, 303);

  const cookie = await login(origin);
  for (const pathname of [TAB, `${TAB}?id=00000000-0000-4000-8000-000000000000`, `${TAB}?edit=00000000-0000-4000-8000-000000000000`, `${TAB}?window=00000000-0000-4000-8000-000000000000`, `${TAB}?new=1`]) {
    const page = await getPage(origin, cookie, pathname);
    assert.equal(page.response.status, 404, `${pathname} must be gone`);
  }
});

test("the seven legacy write routes answer 404, and no refusal code survives", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store });
  const cookie = await login(origin);
  // A real session and a real CSRF token: the route itself is gone, so the write cannot be refused
  // by a gate that no longer exists. Nothing reaches the store either way.
  const csrf = /name="csrf" value="([^"]+)"/.exec((await getPage(origin, cookie, "/admin/auth")).body)?.[1] ?? null;
  assert.ok(csrf, "the Auth Center renders a CSRF token");
  for (const action of LEGACY_WRITES) {
    const sent = await postForm(origin, cookie, `${TAB}/${action}`, CREATE_FIELDS, { csrf });
    assert.equal(sent.response.status, 404, `POST ${TAB}/${action} must be gone`);
    assert.equal(sent.body.includes("access_policy_frozen"), false, `${action} must not answer the retired code`);
  }
  assert.equal(store.snapshot().revision, 0, "no legacy write reached the store");
});

test("the nav's 定时授权 entry still reaches the constraint page", async (t) => {
  const { store } = await makeStore(t);
  const { origin } = await startAdmin(t, { store, vaultGitAdmin: vaultGitAdminStub() });
  const cookie = await login(origin);
  const home = await getPage(origin, cookie, "/admin/auth");
  assert.equal(home.response.status, 200);
  const hrefs = tabHrefs(home.body);
  assert.ok(hrefs.includes("/admin/auth/authz"), `the 定时授权 entry must lead to the constraint page: ${hrefs.join(", ")}`);
  assert.equal(hrefs.some((href) => href.includes("access-policy")), false, "no nav entry points at the retired page");
  const page = await getPage(origin, cookie, "/admin/auth/authz");
  assert.equal(page.response.status, 200, "the constraint page is served");
  assert.ok(page.body.includes("定时授权"), "and it is titled 定时授权");
});
