// P2 / Task 11 — the Web main routes, the default selection and the error families.
//
// Contract: design §6.1.4 and §10 P2. The real Web router runs over real HTTP with a
// real session cookie and the real session store. Beside each old gate the new model
// answers the same request, and only one bounded row is recorded. The old gate alone
// decides the status, the body and the session store writes.
//
// The compared sequence (read routes plus the CSRF and 401 refusals) runs twice — with
// and without the shadow — and every outcome must be identical. Write routes are then
// exercised once each: their answers are the legacy ones and each records one row.
//
// The exempt operations are proven exempt: the public login chrome, the app shell and
// the two session routes map to `session_bootstrap` / `vault_select` and record no row.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-web-shadow-"));
const vaultRoot = path.join(root, "vault");
const secondaryRoot = path.join(root, "vaults", "secondary");
const data = path.join(root, "data");
await fs.mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
await fs.mkdir(path.join(secondaryRoot, ".obsidian"), { recursive: true });
await fs.mkdir(data, { recursive: true });
await fs.writeFile(path.join(vaultRoot, "Note.md"), "# Readable note\n", "utf8");
await fs.writeFile(path.join(secondaryRoot, "private.md"), "# Secondary sentinel: forbidden\n", "utf8");
process.env.VAULT_PATH = vaultRoot;
process.env.VAULTS_ROOT = path.join(root, "vaults");
process.env.WEB_VAULTS_ROOT = path.join(root, "vaults");
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.DATA_PATH = data;
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

const [
  { createWebAppRouter },
  { defaultWebVaultId },
  { PublishService, encodeDocumentRoute },
  { createAuthorizationRuntime },
  { createShadowCandidate, createShadowRecorder },
  { currentWebSessionIdentity, mapWebAuthorizationDenial, webAuthorizationRequest, webVerifiedActor },
  { createWebSessionStore, WEB_SESSION_COOKIE },
  { AUTHORIZATION_CATALOG_VERSION },
  { AUTHORIZATION_DECISION_CODES },
] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/app/vault-registry.js"),
  import("../src/publish/service.js"),
  import("../src/authorization/runtime.js"),
  import("../src/authorization/shadow.js"),
  import("../src/authorization/adapters/web.js"),
  import("../src/app/web-session-store.js"),
  import("../src/authorization/catalog.js"),
  import("../src/authorization/evaluate.js"),
]);

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const C = AUTHORIZATION_DECISION_CODES;
const NOW = Date.parse("2026-11-02T03:00:00.000Z");
const TTL_MS = 3_600_000;
const VAULT_CAPABILITIES = Object.freeze([
  "get_note", "list_notes", "list_files", "search_notes", "list_tags", "get_note_context",
  "get_publish_status", "manage_publish", "write_note", "manage_folders", "get_file", "write_file",
]);
const INSTANCE_CAPABILITIES = Object.freeze(["vault_list_read", "vault_create"]);
const ALLOW = Object.freeze({ allowed: true, mode: null, reason: "no_matching_policy", denyPolicyId: null, matchedPolicyIds: [] });
const DENY_SUSPEND = Object.freeze({ allowed: false, mode: "suspend", reason: "outside_window", denyPolicyId: "policy-1", matchedPolicyIds: ["policy-1"] });

const userOf = (overrides = {}) => ({
  id: "user-1", username: "owner", displayName: "Owner", updatedAt: "v1",
  allowedScopes: ["obsidian.read", "obsidian.write"], allowedVaults: ["vault"], defaultVaultId: "vault",
  disabledAt: null, ...overrides,
});

function candidateDocument() {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 2,
    timeConstraintsEnabled: false,
    subjects: {
      "oauth-user:user-1": {
        credentialEpoch: 0,
        grants: [
          { target: { kind: "vault", vaultId: defaultWebVaultId() }, capabilities: [...VAULT_CAPABILITIES] },
          { target: { kind: "instance" }, capabilities: [...INSTANCE_CAPABILITIES] },
        ],
      },
    },
    constraints: [],
  };
}

/** The legacy A4 gate's answer, programmable per app. */
function legacyRuntime(decision = ALLOW) {
  const calls = { evaluate: [], explain: [], audit: [] };
  return {
    status: "ready",
    calls,
    evaluate(input) { calls.evaluate.push(input); return decision; },
    explain(input) { calls.explain.push(input); return { nextAllowedAt: null }; },
    audit(event) { calls.audit.push(event); },
  };
}

/** The session store the router uses, with a counter for its writes. */
function instrumentedStore() {
  const store = createWebSessionStore({ file: null });
  const stats = { create: 0, mutate: 0, revoke: 0, delete: 0 };
  return {
    stats,
    now: () => store.now(),
    snapshot: (token) => store.snapshot(token),
    touchIfCurrent: (hash, version, mutation) => store.touchIfCurrent(hash, version, mutation),
    mutateSession: (id, mutation) => { stats.mutate += 1; return store.mutateSession(id, mutation); },
    deleteSession: (token) => { stats.delete += 1; return store.deleteSession(token); },
    revoke: (token) => { stats.revoke += 1; return store.revoke(token); },
    checkpoint: () => store.checkpoint(),
    createSession: (token, record) => { stats.create += 1; return store.createSession(token, record); },
  };
}

const boundedFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });
const readOutcome = async (response) => ({ status: response.status, body: await response.text() });

async function closeServer(server) {
  await new Promise((resolve) => {
    server.closeIdleConnections?.();
    server.close(() => resolve());
  });
}

/** One in-process app: the real router, a real session store, an optional shadow. */
async function startApp({ legacy = legacyRuntime(), shadow = true, user = userOf(), document = candidateDocument(), label = "app" } = {}) {
  const audits = [];
  const account = user;
  const provider = {
    authenticateOAuthUser: async (username, password) => username === account.username && password === "password" ? account : null,
    oauthUserSessionRecord: async (id) => id === account.id ? account : null,
    updateOAuthUser: async (id, patch) => { Object.assign(account, patch, { updatedAt: `${account.updatedAt}+1` }); audits.push({ action: "user.update", detail: id }); return { user: { ...account } }; },
    recordAudit(entry) { audits.push(entry); },
  };
  const store = instrumentedStore();
  const recorder = createShadowRecorder({ capacity: 256 });
  const runtime = createAuthorizationRuntime({
    store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document }) }),
    identitySnapshot: () => ({
      subjects: { [`oauth-user:${account.id}`]: { credentialEpoch: 0, disabled: false } },
      sessions: currentWebSessionIdentity()?.sessions ?? {},
    }),
    vaultSnapshot: () => ({
      [defaultWebVaultId()]: { admitted: true, readOnly: false },
      secondary: { admitted: true, readOnly: false },
    }),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => NOW,
    mode: "shadow",
    shadow: recorder,
  });
  await runtime.ready;

  const app = express();
  app.use(createWebAppRouter({
    provider,
    secureCookie: false,
    publishService: new PublishService({ file: path.join(data, `${label}-publish.json`) }),
    webSessionStore: store,
    accessRuntime: legacy,
    authorizationShadow: shadow ? runtime.shadow : null,
  }));
  const server = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A live session created through the store, so the test owns the CSRF token. */
  async function newSession({ vaultId = defaultWebVaultId() } = {}) {
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(16).toString("base64url");
    const at = Date.now();
    const created = await store.createSession(token, {
      userId: account.id, userUpdatedAt: account.updatedAt, csrf, vaultId,
      createdAt: at, expiresAt: at + TTL_MS, lastSeenAt: at,
    });
    assert.equal(created.ok, true, "the test session must exist");
    return { cookie: `${WEB_SESSION_COOKIE}=${token}`, csrf, token };
  }

  return {
    base, legacy, user: account, audits, store, recorder,
    rows: () => recorder.rows(),
    summary: () => recorder.summary(),
    newSession,
    close: () => closeServer(server),
    login: async () => {
      const response = await boundedFetch(`${base}/auth/login`, {
        method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: account.username, password: "password" }),
      });
      assert.equal(response.status, 303);
      return response.headers.get("set-cookie").split(";", 1)[0];
    },
  };
}

/** The compared sequence: reads, the shell, refusals. No write reaches the disk. */
async function runSequence(app) {
  const session = await app.newSession();
  const outcomes = {};
  const get = async (label, url, headers = {}) => {
    outcomes[label] = await readOutcome(await boundedFetch(`${app.base}${url}`, { redirect: "manual", headers: { Cookie: session.cookie, ...headers } }));
  };

  await get("loginChrome", "/auth/login");
  await get("loginCss", "/auth/theme.css");
  await get("locale", "/app/language?locale=en");
  await get("shell", "/app");
  await get("session", "/api/web/v1/session");
  await get("notePage", `/app/note/${encodeDocumentRoute(defaultWebVaultId(), "Note.md")}`);
  await get("noteApi", "/api/web/v1/note?path=Note.md");
  await get("noteList", "/api/web/v1/notes");
  await get("linkResolve", "/api/web/v1/link/resolve?source=Note.md&target=Note");
  await get("vaults", "/api/web/v1/vaults");
  await get("themes", "/api/web/v1/themes");
  await get("publishStatus", "/api/web/v1/publish?path=Note.md");
  await get("deepLinkOtherVault", `/app/note/${encodeDocumentRoute("secondary", "private.md")}`);

  // The session route: a manual switch needs the CSRF token and stays inside allowedVaults.
  outcomes.selectNoCsrf = await readOutcome(await boundedFetch(`${app.base}/api/web/v1/vault/select`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: session.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "secondary" }),
  }));
  outcomes.selectDenied = await readOutcome(await boundedFetch(`${app.base}/api/web/v1/vault/select`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: session.cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
    body: JSON.stringify({ id: "secondary" }),
  }));
  outcomes.selectCurrent = await readOutcome(await boundedFetch(`${app.base}/api/web/v1/vault/select`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: session.cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
    body: JSON.stringify({ id: defaultWebVaultId() }),
  }));

  // CSRF is refused before any authorization gate.
  outcomes.writeNoCsrf = await readOutcome(await boundedFetch(`${app.base}/api/web/v1/note`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: session.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ path: "blocked.md", content: "# blocked\n" }),
  }));
  outcomes.noSession = await readOutcome(await boundedFetch(`${app.base}/api/web/v1/note?path=Note.md`, { redirect: "manual" }));

  // The rendered pages embed their own session's CSRF token, which is per session and
  // per run. It is the test's own value, so replacing it compares every other byte.
  for (const key of Object.keys(outcomes)) {
    // Two values belong to the run, not to the answer: the session's own CSRF token and
    // the loopback origin the request arrived on. Both are test-owned and are replaced
    // before the strict comparison of everything else.
    outcomes[key] = {
      status: outcomes[key].status,
      body: outcomes[key].body.split(session.csrf).join("<csrf>").split(app.base).join("<base>"),
    };
  }
  return { outcomes, session };
}

test("web_shadow_preserves_404_csrf_and_default_vault_selection", async () => {
  const withShadow = await startApp({ label: "with-shadow" });
  const withoutShadow = await startApp({ shadow: false, label: "without-shadow" });
  try {
    const shadowRun = await runSequence(withShadow);
    const plainRun = await runSequence(withoutShadow);
    const shadow = shadowRun.outcomes;
    const plain = plainRun.outcomes;

    // 1. Every answer is identical: the old gate and the handlers decide both times.
    for (const key of Object.keys(plain)) assert.deepEqual(shadow[key], plain[key], `${key} must be unchanged by the shadow`);
    assert.equal(shadow.shell.status, 200);
    assert.equal(shadow.notePage.status, 200);
    assert.equal(shadow.noteApi.status, 200);
    assert.equal(shadow.noteList.status, 200);
    assert.equal(shadow.vaults.status, 200);
    assert.equal(shadow.themes.status, 200);
    assert.equal(shadow.publishStatus.status, 200);
    assert.equal(shadow.selectCurrent.status, 200);
    assert.deepEqual(JSON.parse(shadow.selectCurrent.body), { current: "vault" });

    // 2. CSRF first, 401 without a session, 404 for a deep link that crosses Vaults.
    assert.equal(shadow.writeNoCsrf.status, 403);
    assert.match(shadow.writeNoCsrf.body, /CSRF/);
    await assert.rejects(fs.stat(path.join(vaultRoot, "blocked.md")), "a CSRF refusal writes nothing");
    assert.equal(shadow.noSession.status, 401);
    assert.deepEqual(JSON.parse(shadow.noSession.body), { error: "Login required" });
    assert.equal(shadow.deepLinkOtherVault.status, 404);
    assert.equal(shadow.deepLinkOtherVault.body.includes("sentinel"), false);
    assert.equal(shadow.selectNoCsrf.status, 403);

    // 3. The Vault list keeps its `allowedVaults` filter inside the handler, and the
    //    manual switch stays inside the same list.
    assert.deepEqual(JSON.parse(shadow.vaults.body).vaults.map((entry) => entry.id), ["vault"]);
    assert.deepEqual(JSON.parse(shadow.selectDenied.body), { error: "Vault access denied" });
    assert.deepEqual(JSON.parse(shadow.session.body).vaultId, "vault");

    // 4. The old gate is the only gate that ran, and no session write came from the shadow.
    assert.ok(withShadow.legacy.calls.evaluate.length > 0);
    assert.equal(withoutShadow.legacy.calls.evaluate.length, withShadow.legacy.calls.evaluate.length);
    assert.deepEqual(withShadow.store.stats, withoutShadow.store.stats, "the shadow changes no session store write");

    // 5. Rows exist only with the shadow, once per gated request, and only for
    //    non-exempt operations.
    assert.equal(withoutShadow.summary().compared, 0, "no shadow, no record");
    const summary = withShadow.summary();
    assert.ok(summary.compared > 0);
    assert.equal(summary.matches + summary.differences + summary.inconclusive, summary.compared);
    assert.ok(summary.matches > 0, "the imported candidate agrees with the plain Web reads");
    assert.equal(new Set(withShadow.rows().map((row) => row.requestId)).size, withShadow.rows().length, "one row per request");
    for (const key of ["GET /app/note/*", "GET /api/web/v1/note", "GET /api/web/v1/notes", "GET /api/web/v1/vaults", "GET /api/web/v1/themes", "GET /api/web/v1/publish", "GET /api/web/v1/link/resolve"]) {
      assert.ok(summary.coveredBoundaryKeys.includes(key), `the record must cover ${key}`);
    }
    for (const key of ["GET /app", "GET /app/", "GET /auth/login", "GET /auth/theme.css", "GET /app/language", "GET /api/web/v1/session", "POST /api/web/v1/vault/select"]) {
      assert.equal(summary.coveredBoundaryKeys.includes(key), false, `${key} must never be authorized`);
    }

    // 6. The APPROVED tightening (design §11.3 #4): a deep link that crosses Vaults.
    //    The old page gate allows the request and the handler answers 404; the new
    //    model refuses with `vault_access_denied`. That one difference is expected,
    //    named and asserted here — it is not noise.
    const crossVault = withShadow.rows().filter((row) => row.capability === "get_note" && row.newCode === C.VAULT_ACCESS_DENIED);
    assert.equal(crossVault.length, 1, "exactly one named difference for the cross-Vault deep link");
    assert.equal(crossVault[0].boundary, "GET /app/note/*");
    assert.equal(crossVault[0].oldAllowed, true, "the old page gate allowed the request");
    assert.equal(crossVault[0].newAllowed, false, "the new model refuses before the content read");
    assert.equal(shadow.deepLinkOtherVault.status, 404, "and the old handler answer is unchanged in P2");

    // 7. The record carries no path, body, cookie, CSRF token or subject.
    const text = JSON.stringify(summary) + JSON.stringify(withShadow.rows());
    for (const leak of ["Note.md", "Readable note", "private.md", shadowRun.session.token, shadowRun.session.csrf, "oauth-user:", "owner"]) {
      assert.equal(text.includes(leak), false, `the record must not carry ${leak}`);
    }
  } finally {
    await withShadow.close();
    await withoutShadow.close();
  }
});

test("the_default_vault_selection_falls_back_without_a_shadow_row", async () => {
  // A session whose stored Vault is no longer allowed falls back to the account
  // default, never to an arbitrary Vault, and the shadow does not change it.
  const app = await startApp({ label: "fallback" });
  try {
    const stale = await app.newSession({ vaultId: "secondary" });
    const response = await boundedFetch(`${app.base}/api/web/v1/session`, { headers: { Cookie: stale.cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).vaultId, "vault");
    assert.equal(app.summary().coveredBoundaryKeys.includes("GET /api/web/v1/session"), false);
  } finally {
    await app.close();
  }
});

test("web_write_routes_keep_the_legacy_answer_and_record_one_row", async () => {
  const app = await startApp({ label: "writes" });
  try {
    const session = await app.newSession();
    assert.equal(app.summary().compared, 0);

    // CSRF is checked before the write gate: no row, no file.
    const noCsrf = await boundedFetch(`${app.base}/api/web/v1/note`, {
      method: "POST", redirect: "manual",
      headers: { Cookie: session.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "no-csrf.md", content: "# no\n" }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(app.summary().compared, 0, "a CSRF refusal records no authorization row");

    const note = await boundedFetch(`${app.base}/api/web/v1/note`, {
      method: "POST", redirect: "manual",
      headers: { Cookie: session.cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ path: "written.md", content: "# written\n" }),
    });
    assert.equal(note.status, 200);
    assert.equal((await note.json()).path, "written.md");
    assert.deepEqual(app.rows().map((row) => row.capability), ["write_note"]);
    assert.equal(app.rows()[0].oldAllowed, true);
    assert.equal(app.rows()[0].newAllowed, true);

    const folder = await boundedFetch(`${app.base}/api/web/v1/folder`, {
      method: "POST", redirect: "manual",
      headers: { Cookie: session.cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ path: "pages" }),
    });
    assert.equal(folder.status, 201);
    assert.deepEqual(app.rows().map((row) => row.capability), ["write_note", "manage_folders"]);

    const publish = await boundedFetch(`${app.base}/api/web/v1/publish`, {
      method: "POST", redirect: "manual",
      headers: { Cookie: session.cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ path: "Note.md", action: "publish" }),
    });
    assert.equal(publish.status, 200);
    assert.equal((await publish.json()).published, true);
    assert.deepEqual(app.rows().map((row) => row.capability), ["write_note", "manage_folders", "manage_publish"]);
    assert.equal(app.summary().compared, 3, "one row per write request, no duplicates");

    // The legacy scope rule still refuses before any Vault write when the account holds
    // no write scope; the shadow neither allows it nor blocks it.
    const readOnly = await startApp({ label: "read-only", user: userOf({ allowedScopes: ["obsidian.read"] }) });
    try {
      const viewOnly = await readOnly.newSession();
      const denied = await boundedFetch(`${readOnly.base}/api/web/v1/note`, {
        method: "POST", redirect: "manual",
        headers: { Cookie: viewOnly.cookie, "Content-Type": "application/json", "X-CSRF-Token": viewOnly.csrf },
        body: JSON.stringify({ path: "read-only.md", content: "# no\n" }),
      });
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: "Account does not have write permission" });
      await assert.rejects(fs.stat(path.join(vaultRoot, "read-only.md")));
    } finally {
      await readOnly.close();
    }
  } finally {
    await app.close();
  }
});

test("a_web_shadow_difference_still_answers_with_the_old_verdict", async () => {
  const denying = await startApp({ legacy: legacyRuntime(DENY_SUSPEND), label: "deny-shadow" });
  const denyingPlain = await startApp({ legacy: legacyRuntime(DENY_SUSPEND), shadow: false, label: "deny-plain" });
  try {
    const withRow = (await runSequence(denying)).outcomes;
    const plain = (await runSequence(denyingPlain)).outcomes;
    for (const key of Object.keys(plain)) assert.deepEqual(withRow[key], plain[key], `${key} must be unchanged by a shadow difference`);
    // The temporal deny keeps the 403 family on the gate, and the note body is never read.
    assert.equal(withRow.noteApi.status, 403);
    assert.deepEqual(JSON.parse(withRow.noteApi.body), { error: "outside_authorized_window", mode: "suspend", policyId: "policy-1", nextAllowedAt: null });
    // The candidate document carries no constraint, so the new model would allow:
    // a real difference exists and still changed no answer.
    assert.ok(denying.summary().differences > 0);
    assert.equal(denying.summary().matches + denying.summary().differences + denying.summary().inconclusive, denying.summary().compared);
  } finally {
    await denying.close();
    await denyingPlain.close();
  }
});

test("the_web_adapter_builds_one_target_and_never_authorizes_an_exempt_operation", () => {
  const session = { userId: "user-1", credentialId: "web-session:abc123", vaultId: "vault", allowedVaults: ["vault"], expiresAt: NOW + 60_000 };
  assert.equal(webVerifiedActor({ session }).kind, "web-session");
  const read = webAuthorizationRequest({ session, routeKey: "GET /api/web/v1/note" });
  assert.equal(read.capability, "get_note");
  assert.deepEqual(read.target, { kind: "vault", vaultId: "vault" });
  assert.equal(read.surface, "web");
  // A decoded deep link states its own target.
  assert.deepEqual(webAuthorizationRequest({ session, routeKey: "GET /app/note/*", vaultId: "secondary" }).target, { kind: "vault", vaultId: "secondary" });
  // Instance operations, and the exempt shell/session routes.
  assert.deepEqual(webAuthorizationRequest({ session, routeKey: "GET /api/web/v1/vaults" }).target, { kind: "instance" });
  for (const routeKey of ["GET /app", "GET /app/", "GET /auth/login", "POST /auth/login", "GET /auth/theme.css", "GET /api/web/v1/session", "POST /api/web/v1/vault/select", "GET /app/language"]) {
    assert.equal(webAuthorizationRequest({ session, routeKey }), null, `${routeKey} is exempt or not a content boundary`);
  }
  assert.equal(webAuthorizationRequest({ session: null, routeKey: "GET /api/web/v1/note" }), null);
  // The actor carries a non-secret session key, never the cookie or the token.
  const actor = webVerifiedActor({ session });
  assert.equal(actor.credentialId, "web-session:abc123");
  assert.equal(JSON.stringify(actor).includes(session.vaultId), false, "the actor carries no Vault id");

  // The denial mapping keeps today's families for the P3/P4 bridge.
  const outside = { allowed: false, code: C.OUTSIDE_WINDOW, mode: "suspend", denyConstraintId: "c-1", nextAllowedAt: null };
  assert.deepEqual(mapWebAuthorizationDenial(outside, { page: false }), { status: 403, body: { error: C.OUTSIDE_WINDOW, mode: "suspend", policyId: "c-1", nextAllowedAt: null } });
  assert.equal(mapWebAuthorizationDenial(outside, { page: true }).status, 403);
  assert.deepEqual(mapWebAuthorizationDenial({ allowed: false, code: C.POLICY_UNAVAILABLE }, { page: false }), { status: 503, body: { error: C.POLICY_UNAVAILABLE } });
  assert.deepEqual(mapWebAuthorizationDenial({ allowed: false, code: C.INVALID_CREDENTIAL }, { page: false }), { status: 401, body: { error: "Login required" } });
  assert.deepEqual(mapWebAuthorizationDenial({ allowed: false, code: C.INVALID_CREDENTIAL }, { page: true }), { status: 303, redirect: "/auth/login" });
  assert.deepEqual(mapWebAuthorizationDenial({ allowed: false, code: C.VAULT_ACCESS_DENIED }, { page: true }), { status: 404 });
  assert.equal(mapWebAuthorizationDenial({ allowed: true, code: C.ALLOWED }, { page: false }), null);

  // The candidate store is read-only: the shadow can never execute a permission write.
  const candidate = createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document: candidateDocument() }) });
  assert.deepEqual(candidate.replace(1, candidateDocument()), { ok: false, revision: null, code: "authorization_shadow_read_only" });
  assert.deepEqual(candidate.repair(candidateDocument()), { ok: false, revision: null, code: "authorization_shadow_read_only" });
});
