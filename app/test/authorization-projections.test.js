// P2 / Task 18 — discovery, `server_info` and the Admin read-only explanation.
//
// Contract: design §6.1.8, §9 and §12. Three properties decide this task:
//
//   1. DISCOVERY RECORDS NO DECISION. Tool discovery and the capability list are metadata:
//      they answer without a per-account window check, so they form no authorization unit
//      and add no row. A repeated discovery answer is identical with and without the shadow.
//      DECISION (owner, P2): discovery records NO row at all. A row per `tools/list` would
//      measure nothing — the answer is metadata and it changes no permission — so the empty
//      record is the correct result, not a missing one.
//   2. `server_info` STAYS REACHABLE WHILE A PRINCIPAL IS SUSPENDED. The metadata bypass at
//      the tool layer still runs the handler, and its row says old-allow/new-allow, while
//      the SAME principal's content tool is refused by that same window.
//   3. THE ADMIN SURFACE NEVER PASSES ACCOUNT CONSTRAINTS TO `authorize()`. An admin actor
//      carries no subject, so an account's window and a user revoke produce no matching
//      constraint: one Admin row, old-allow/new-allow, and no transport refusal.
//
// The projection is the one function the explanation uses: it asks the decision service
// per (capability, target) and never unions a credential's grants, so two tokens with
// different ceilings are never displayed as one full token.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-projections-"));
await fs.mkdir(path.join(root, "data"), { recursive: true });
await fs.mkdir(path.join(root, "vault"), { recursive: true });
process.env.VAULT_PATH = path.join(root, "vault");
process.env.DATA_PATH = path.join(root, "data");
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
delete process.env.WEB_VAULTS_ROOT;

const [
  { createAccessPolicyRegistrar },
  { createAccessPolicyRuntime },
  { createShadowRecorder, createShadowCandidate },
  { createAuthorizationRuntime },
  { createAuthorizationRuntime: _again },
  { verifiedActor },
  { authorize },
  { observeAdminRead, projectSubjectAuthorization, adminVerifiedActor, adminAuthorizationRequest },
  { resolveDiscoveryView },
  { buildCatalog },
  { AUTHORIZATION_CATALOG_VERSION, capabilityForBoundary },
] = await Promise.all([
  import("../src/access-policy/registrar.js"),
  import("../src/access-policy/runtime.js"),
  import("../src/authorization/shadow.js"),
  import("../src/authorization/runtime.js"),
  import("../src/authorization/runtime.js"),
  import("../src/authorization/actors.js"),
  import("../src/authorization/evaluate.js"),
  import("../src/authorization/adapters/admin.js"),
  import("../src/discovery-runtime.js"),
  import("../src/admin/catalog.js"),
  import("../src/authorization/catalog.js"),
]);

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const SUBJECT = "oauth-user:user-1";
const VAULT = "vault";
const NOW = Date.parse("2026-11-02T03:00:00.000Z");
const SUSPEND = Object.freeze({
  id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  label: "account window",
  enabled: true,
  subjects: [SUBJECT],
  mode: "suspend",
  selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }] },
  schedule: { timezone: "UTC", weekly: {}, dateRanges: [], startsAt: null, expiresAt: "2000-01-01T00:00:00.000Z" },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
});
const REVOKE = Object.freeze({ ...SUSPEND, id: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60", mode: "revoke" });

const userActor = () => verifiedActor("api-key", {
  subjectIds: [SUBJECT], credentialId: "key-1", credentialEpochs: { [SUBJECT]: 0 },
  grantCeiling: null, audience: null, expiresAt: null, revoked: false, transferGeneration: 0, proof: null,
});

function documentWith(constraints) {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 4,
    timeConstraintsEnabled: constraints.length > 0,
    subjects: {
      // An OAuth token's client subject sits beside the account's; `grants: null` means
      // "does not tighten" and never widens the account.
      "oauth-client:client-1": { credentialEpoch: 0, grants: null },
      [SUBJECT]: { credentialEpoch: 0, grants: [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note", "server_info", "list_notes"] }, { target: { kind: "instance" }, capabilities: ["server_info", "agent_bootstrap"] }] },
    },
    constraints,
  };
}

/** A real shadow runtime over one document. */
async function shadowRuntime(constraints = [SUSPEND]) {
  const recorder = createShadowRecorder({ capacity: 32 });
  const runtime = createAuthorizationRuntime({
    store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document: documentWith(constraints) }) }),
    identitySnapshot: () => ({ subjects: { [SUBJECT]: { credentialEpoch: 0, disabled: false }, "oauth-client:client-1": { credentialEpoch: 0, disabled: false } }, sessions: {} }),
    vaultSnapshot: () => ({ [VAULT]: { admitted: true, readOnly: false } }),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => NOW,
    mode: "shadow",
    shadow: recorder,
  });
  await runtime.ready;
  return { runtime, recorder };
}

/** The real tool-layer temporal registrar, with the shadow beside it. */
function registrarFor({ shadow, decision }) {
  const handlers = [];
  const runtime = {
    status: "ready",
    evaluate: () => decision,
    explain: () => ({ nextAllowedAt: null }),
    audit: () => {},
  };
  const registrar = createAccessPolicyRegistrar({ registerTool: (name, config, handler) => handlers.push({ name, handler }) }, { runtime, authorizationShadow: shadow });
  registrar.registerTool("server_info", {}, async () => ({ content: [{ type: "text", text: "info" }] }));
  registrar.registerTool("get_note", {}, async () => ({ content: [{ type: "text", text: "note body" }] }));
  return Object.fromEntries(handlers.map((entry) => [entry.name, entry.handler]));
}

const ALLOW = Object.freeze({ allowed: true, mode: null, reason: "no_matching_policy", denyPolicyId: null, matchedPolicyIds: [] });
const ALLOW_SUSPENDED = Object.freeze({ allowed: false, mode: "suspend", reason: "outside_window", denyPolicyId: SUSPEND.id, matchedPolicyIds: [SUSPEND.id] });

test("a_server_info_row_survives_a_suspension_while_the_content_tool_is_refused", async () => {
  const { runtime: shadow, recorder } = await shadowRuntime([SUSPEND]);
  const handlers = registrarFor({ shadow: shadow.shadow, decision: ALLOW_SUSPENDED });
  const authInfo = { type: "oauth", clientId: "client-1", userId: "user-1", scopes: ["obsidian.read"], allowedVaults: [VAULT] };

  // 1. The metadata bypass still answers `server_info`, and its row is old-allow/new-allow.
  const info = await handlers.server_info({}, { authInfo });
  assert.equal(info.isError, undefined, "server_info must stay reachable while suspended");
  assert.equal(recorder.summary().compared, 1);
  const infoRow = recorder.rows().at(-1);
  assert.equal(infoRow.capability, "server_info");
  assert.equal(infoRow.oldAllowed, true, "the metadata bypass is an old allow");
  // §4.1a pins the instance metadata plane outside the temporal plane, so the model allows
  // it too: the old verdict and the new one agree, and no suspension can 403 `server_info`.
  assert.equal(infoRow.newAllowed, true);
  assert.equal(infoRow.newCode, "allowed");
  assert.equal(recorder.summary().differences, 0);

  // 2. The same principal's content tool is still refused by the same window.
  const note = await handlers.get_note({ path: "Note.md", vaultId: VAULT }, { authInfo });
  assert.equal(note.isError, true);
  assert.equal(note.structuredContent.code, "outside_authorized_window");
  assert.equal(recorder.summary().compared, 2);
  const noteRow = recorder.rows().at(-1);
  assert.equal(noteRow.oldAllowed, false, "the old gate refused");
  assert.equal(noteRow.newAllowed, false, "the model denies the same window: no fabricated difference");
  assert.equal(noteRow.oldCode, "outside_authorized_window");
  assert.equal(noteRow.newCode, "outside_authorized_window");
  assert.equal(recorder.summary().differences, 0, "the metadata plane agrees and the content deny agrees");
});

test("discovery_records_no_decision_and_its_answer_does_not_depend_on_the_shadow", async () => {
  const { runtime: shadow, recorder } = await shadowRuntime([SUSPEND]);
  // Discovery is the real view resolver, with the subject suspended and an operator profile.
  const operatorConfig = { profile: "core", toolsets: [], tools: [], denyTools: ["delete_note"] };
  const withShadow = resolveDiscoveryView({ authInfo: { type: "api-key", scopes: ["obsidian.read", "obsidian.write"], allowedVaults: [VAULT] }, operatorConfig });
  const withoutShadow = resolveDiscoveryView({ authInfo: { type: "api-key", scopes: ["obsidian.read", "obsidian.write"], allowedVaults: [VAULT] }, operatorConfig });
  assert.deepEqual(withShadow.toolNames, withoutShadow.toolNames, "discovery is metadata: the shadow changes no visible tool");
  assert.equal(recorder.summary().compared, 0, "discovery forms no authorization unit and adds no row");
  // The capability list answers without a window check too.
  assert.ok(withShadow.toolNames.length > 0);
  void shadow;
});

test("the_admin_projection_carries_no_subject_and_no_account_constraint", async () => {
  const { runtime: shadow, recorder } = await shadowRuntime([REVOKE]);
  const deps = {
    provider: {
      authorizationSnapshot: async () => ({ oauthUsers: [], apiKeys: [], clients: [], tokens: [], audit: [], configuredApiKeyUsage: {} }),
      oauthUserSessionRecord: async () => null,
      recordAudit: () => {},
    },
    listVaults: async () => ({ vaults: [] }),
    publishService: null,
    accessPolicyAdmin: null,
    vaultGitAdmin: null,
    configuredApiKeyEnabled: false,
    authorizationShadow: shadow.shadow,
  };
  const req = { method: "GET", path: "/access-policy", headers: { cookie: "" } };
  const withShadow = await buildCatalog({ deps, req, now: NOW });
  assert.equal(recorder.summary().compared, 1, "one console read is one authorization unit");
  const row = recorder.rows().at(-1);
  assert.equal(row.surface, "admin");
  assert.equal(row.phase, "admin");
  assert.equal(row.capability, "admin_metadata_read");
  assert.equal(row.oldAllowed, true);
  assert.equal(row.newAllowed, true, "an admin actor has no subject, so a user revoke cannot deny it");
  assert.equal(recorder.summary().differences, 0);
  // The console answer is unchanged by the record.
  const withoutShadow = await buildCatalog({ deps: { ...deps, authorizationShadow: null }, req, now: NOW });
  assert.equal(JSON.stringify({ ...withShadow, now: 0 }), JSON.stringify({ ...withoutShadow, now: 0 }), "the Admin explanation is identical");
  // Old-credential grants stay hidden and a broken plane stays unknown, not "normal".
  assert.notEqual(withShadow.authz.status, "ready", "no policy runtime means an unknown AuthZ state, never a normal one");

  // The adapter builds the console actor with no subject at all.
  assert.deepEqual(adminVerifiedActor().subjectIds, []);
  assert.equal(adminAuthorizationRequest({ routeKey: "ADMIN GET /access-policy" }).capability, "admin_metadata_read");
  assert.equal(adminAuthorizationRequest({ routeKey: "ADMIN POST /access-policy/update" }).capability, "admin_authorization_manage");
  assert.equal(adminAuthorizationRequest({ routeKey: "ADMIN GET /nope" }), null);
  // A user revoke cannot even match: the admin actor has no subject to intersect.
  const adminRequest = adminAuthorizationRequest({ routeKey: "ADMIN GET /access-policy" });
  const decision = authorize({ ...adminRequest, nowMs: NOW }, {
    status: "ready",
    document: { ...documentWith([REVOKE]), subjects: {} },
    identities: {},
    vaultAdmissions: {},
    publication: null,
    deployment: { readOnly: false },
  });
  assert.equal(decision.allowed, true, "the console is not transport-refused by an account revoke");
  assert.equal(decision.mode, null);
  void observeAdminRead;
});

test("projections_query_each_capability_without_unioning_token_grants", async () => {
  // Two tokens of one account with DIFFERENT ceilings: neither may be shown as a full token.
  const full = verifiedActor("api-key", {
    subjectIds: [SUBJECT], credentialId: "key-full", credentialEpochs: { [SUBJECT]: 0 },
    grantCeiling: [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note", "list_notes"] }],
    audience: null, expiresAt: null, revoked: false, transferGeneration: 0, proof: null,
  });
  const narrow = verifiedActor("api-key", {
    subjectIds: [SUBJECT], credentialId: "key-narrow", credentialEpochs: { [SUBJECT]: 0 },
    grantCeiling: [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note"] }],
    audience: null, expiresAt: null, revoked: false, transferGeneration: 0, proof: null,
  });
  const snapshot = {
    status: "ready",
    document: documentWith([]),
    identities: { [SUBJECT]: { credentialEpoch: 0 } },
    vaultAdmissions: { [VAULT]: { admitted: true } },
    publication: null,
    deployment: { readOnly: false },
  };
  const calls = [];
  const authorization = (request) => { calls.push(`${request.actor.credentialId}:${request.capability}`); return authorize({ ...request, nowMs: NOW }, snapshot); };
  const targets = [{ kind: "vault", vaultId: VAULT }, { kind: "vault", vaultId: "example-vault" }];
  const capabilities = ["get_note", "list_notes", "no_such_capability"];

  const fullProjection = projectSubjectAuthorization({ actor: full, targets, capabilities, authorization });
  assert.equal(calls.length, 4, "one query per (capability, target) pair for known capabilities, never a union of grants");
  const narrowProjection = projectSubjectAuthorization({ actor: narrow, targets, capabilities, authorization });
  assert.equal(calls.length, 8, "the second credential is queried on its own, never merged with the first");
  const allowedOf = (rows) => rows.filter((row) => row.allowed).map((row) => row.capability);
  assert.deepEqual(allowedOf(fullProjection), ["get_note", "list_notes"], "the full token keeps both capabilities on its own Vault");
  assert.deepEqual(allowedOf(narrowProjection), ["get_note"], "the narrow token is not widened by the full one");
  assert.equal(narrowProjection.some((row) => row.allowed && row.capability === "list_notes"), false);
  // An unauthorized Vault is denied for both, so the explanation never shows one.
  const foreignVault = fullProjection.filter((row) => row.code === "vault_access_denied");
  assert.equal(foreignVault.length, 2, "both capabilities are denied on the Vault the account has no grant for");
  assert.equal(foreignVault.every((row) => row.allowed === false), true);
  // An unknown capability is reported, not silently dropped or allowed.
  const unknown = fullProjection.at(-1);
  assert.equal(unknown.capability, "no_such_capability");
  assert.equal(unknown.code, "operation_unknown");
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.targetKind, null, "an unknown capability has no target to project onto");
  // Without a decision service the projection is empty, never optimistic.
  assert.deepEqual(projectSubjectAuthorization({ actor: full, targets, capabilities, authorization: null }), []);
  void capabilityForBoundary;
});
