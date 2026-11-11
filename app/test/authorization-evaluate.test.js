// P1 / Task 7 — one pure authorization decision.
//
// Contract: design §6. `authorize(request, snapshot)` is the only algorithm: a
// trusted actor, one capability, one target, one surface and one injected instant.
// Order: trusted identity (kind, epoch, expiry, transfer fence) -> principal-wide
// revoke -> known capability / surface / target shape -> frozen ceiling with live
// grants -> target admission and availability -> time constraints -> deployment
// read-only. A grant never bypasses admission or READ_ONLY, a revocation wins over
// a scope, and a static refusal wins over a suspend. The only reuse is the time
// algebra in `access-policy/time.js`; the old runtime is never called.

import assert from "node:assert/strict";
import test from "node:test";

import { AUTHORIZATION_DECISION_CODES, authorize } from "../src/authorization/evaluate.js";
import { AUTHORIZATION_CATALOG_VERSION, authorizationOperation, catalogOperationIds } from "../src/authorization/catalog.js";
import { importLegacyConstraints } from "../src/authorization/legacy-policy-import.js";
import { validateAuthorizationDocument } from "../src/authorization/schema.js";
import { evaluatePolicySchedule } from "../src/access-policy/time.js";
import {
  INSIDE,
  OUTSIDE,
  SUBJECT,
  UUID_A,
  UUID_B,
  fidelityPolicies,
  legacyDocument,
  legacyPolicy,
  runFidelityMatrix,
} from "./helpers/authorization-fidelity-matrix.js";

const VAULT = "vault";
const OTHER = "archive-vault";
const NOW = INSIDE;
const {
  ALLOWED, INVALID_CREDENTIAL, INSUFFICIENT_SCOPE, CAPABILITY_DENIED, VAULT_ACCESS_DENIED,
  VAULT_ID_INVALID, VAULT_UNAVAILABLE, OUTSIDE_WINDOW, POLICY_UNAVAILABLE, STATE_UNAVAILABLE, OPERATION_UNKNOWN,
} = AUTHORIZATION_DECISION_CODES;

// Every grantable operation, so only the rule under test can refuse.
const ALL_VAULT_CAPABILITIES = catalogOperationIds.filter((id) => {
  const operation = authorizationOperation(id);
  return operation.grantable && operation.targetKind === "vault";
});
const ALL_INSTANCE_CAPABILITIES = catalogOperationIds.filter((id) => {
  const operation = authorizationOperation(id);
  return operation.grantable && operation.targetKind === "instance";
});
// The story Vault: read only. The other Vault: read and write.
const READ_ONLY_VAULT_CAPABILITIES = ["get_note", "list_notes", "search_notes", "list_files", "get_publish_status", "git_status", "reindex_vault"];

function grantsFor() {
  return [
    { target: { kind: "vault", vaultId: VAULT }, capabilities: [...ALL_VAULT_CAPABILITIES] },
    { target: { kind: "vault", vaultId: OTHER }, capabilities: ["get_note", "search_notes", "write_note"] },
    { target: { kind: "instance" }, capabilities: [...ALL_INSTANCE_CAPABILITIES] },
  ];
}

function documentWith({ subjects, constraints = [], timeConstraintsEnabled = false } = {}) {
  return validateAuthorizationDocument({
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 7,
    timeConstraintsEnabled,
    subjects: subjects ?? {
      [SUBJECT]: { credentialEpoch: 0, grants: grantsFor() },
    },
    constraints,
  });
}

function actor(overrides = {}) {
  return {
    kind: "oauth",
    subjectIds: [SUBJECT],
    credentialId: "credential-1",
    credentialEpochs: { [SUBJECT]: 0 },
    grantCeiling: null,
    audience: null,
    expiresAt: null,
    revoked: false,
    transferGeneration: 0,
    proof: null,
    ...overrides,
  };
}

function snapshotWith({ document, overrides = {} } = {}) {
  return {
    status: "ready",
    document: document ?? documentWith(),
    identities: { [SUBJECT]: { credentialEpoch: 0, transferGeneration: 0 } },
    vaultAdmissions: {
      [VAULT]: { admitted: true, readOnly: false },
      [OTHER]: { admitted: true, readOnly: false },
    },
    publication: null,
    deployment: { readOnly: false },
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    actor: actor(),
    capability: "get_note",
    target: { kind: "vault", vaultId: VAULT },
    surface: "mcp",
    nowMs: NOW,
    ...overrides,
  };
}

function decide(requestOverrides = {}, snapshotOverrides = {}) {
  return authorize(request(requestOverrides), snapshotWith(snapshotOverrides));
}

function constraintFrom(legacyOverrides, { timeConstraintsEnabled = true } = {}) {
  const { constraints } = importLegacyConstraints({ policyDocument: legacyDocument([legacyPolicy(legacyOverrides)]) });
  return { constraints, timeConstraintsEnabled };
}

test("one_account_reads_one_vault_and_writes_the_other_without_name_special_cases", () => {
  const document = documentWith({
    subjects: {
      [SUBJECT]: {
        credentialEpoch: 0,
        grants: [
          { target: { kind: "vault", vaultId: VAULT }, capabilities: [...READ_ONLY_VAULT_CAPABILITIES] },
          { target: { kind: "vault", vaultId: OTHER }, capabilities: ["get_note", "search_notes", "write_note"] },
          { target: { kind: "instance" }, capabilities: [...ALL_INSTANCE_CAPABILITIES] },
        ],
      },
    },
  });
  const snapshot = snapshotWith({ document });

  assert.equal(authorize(request({ capability: "get_note", target: { kind: "vault", vaultId: VAULT } }), snapshot).allowed, true);
  const denied = authorize(request({ capability: "write_note", target: { kind: "vault", vaultId: VAULT } }), snapshot);
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, CAPABILITY_DENIED);
  assert.equal(authorize(request({ capability: "write_note", target: { kind: "vault", vaultId: OTHER } }), snapshot).allowed, true);

  // The same document with other valid ids gives the same answers: nothing is
  // special-cased on a Vault name.
  const renamedVault = "vault-9f3a1b";
  const renamedOther = "archive-77b2";
  const renamed = documentWith({
    subjects: {
      [SUBJECT]: {
        credentialEpoch: 0,
        grants: [
          { target: { kind: "vault", vaultId: renamedVault }, capabilities: [...READ_ONLY_VAULT_CAPABILITIES] },
          { target: { kind: "vault", vaultId: renamedOther }, capabilities: ["get_note", "search_notes", "write_note"] },
          { target: { kind: "instance" }, capabilities: [...ALL_INSTANCE_CAPABILITIES] },
        ],
      },
    },
  });
  const renamedSnapshot = {
    ...snapshot,
    document: renamed,
    vaultAdmissions: { [renamedVault]: { admitted: true, readOnly: false }, [renamedOther]: { admitted: true, readOnly: false } },
  };
  assert.equal(authorize(request({ capability: "get_note", target: { kind: "vault", vaultId: renamedVault } }), renamedSnapshot).allowed, true);
  assert.equal(authorize(request({ capability: "write_note", target: { kind: "vault", vaultId: renamedVault } }), renamedSnapshot).allowed, false);
  assert.equal(authorize(request({ capability: "write_note", target: { kind: "vault", vaultId: renamedOther } }), renamedSnapshot).allowed, true);
  assert.equal(authorize(request({ capability: "get_note", target: { kind: "vault", vaultId: renamedVault } }), renamedSnapshot).revision, 7);
});

test("missing_subject_missing_client_and_wrong_epoch_are_refused", () => {
  const document = documentWith();
  const snapshot = snapshotWith({ document });

  // A claimed subject the identity store does not know is not a credential.
  const unknownIdentity = authorize(request({ actor: actor({ subjectIds: ["oauth-user:someone-else"], credentialEpochs: { "oauth-user:someone-else": 0 } }) }), snapshot);
  assert.equal(unknownIdentity.allowed, false);
  assert.equal(unknownIdentity.code, INVALID_CREDENTIAL);
  // A known identity with no document record has no grant at all.
  const missingRecord = authorize(request({ actor: actor({ subjectIds: ["oauth-user:someone-else"], credentialEpochs: { "oauth-user:someone-else": 0 } }) }),
    snapshotWith({ overrides: { identities: { "oauth-user:someone-else": { credentialEpoch: 0 } } } }));
  assert.equal(missingRecord.allowed, false);
  assert.equal(missingRecord.code, VAULT_ACCESS_DENIED);

  // A claimed client that the document does not know is not a neutral ceiling.
  const missingClient = authorize(request({ actor: actor({ subjectIds: [SUBJECT, "oauth-client:unknown"], credentialEpochs: { [SUBJECT]: 0, "oauth-client:unknown": 0 } }) }), snapshot);
  assert.equal(missingClient.allowed, false);

  // Epoch drift in either store refuses the credential.
  const staleActor = authorize(request({ actor: actor({ credentialEpochs: { [SUBJECT]: 1 } }) }), snapshot);
  assert.equal(staleActor.allowed, false);
  assert.equal(staleActor.code, INVALID_CREDENTIAL);
  const staleIdentity = authorize(request(), snapshotWith({ document, overrides: { identities: { [SUBJECT]: { credentialEpoch: 2, transferGeneration: 0 } } } }));
  assert.equal(staleIdentity.allowed, false);
  assert.equal(staleIdentity.code, INVALID_CREDENTIAL);
  const advancedFence = authorize(request(), snapshotWith({ document, overrides: { identities: { [SUBJECT]: { credentialEpoch: 0, transferGeneration: 4 } } } }));
  assert.equal(advancedFence.allowed, false);
  assert.equal(advancedFence.code, INVALID_CREDENTIAL);

  // Expired and revoked credentials refuse before anything else.
  assert.equal(authorize(request({ actor: actor({ revoked: true }) }), snapshot).code, INVALID_CREDENTIAL);
  assert.equal(authorize(request({ actor: actor({ expiresAt: NOW }) }), snapshot).code, INVALID_CREDENTIAL);
  assert.equal(authorize(request({ actor: actor({ expiresAt: NOW + 1 }) }), snapshot).allowed, true);
});

test("forged_proof_and_unknown_or_misshapen_requests_are_refused", () => {
  const snapshot = snapshotWith();
  const forgedAdmin = authorize(request({ actor: actor({ kind: "admin-session", proof: null }), capability: "admin_metadata_read", surface: "admin", target: { kind: "instance" } }), snapshot);
  assert.equal(forgedAdmin.allowed, false);
  assert.equal(forgedAdmin.code, INVALID_CREDENTIAL);

  const proofForAnotherKind = authorize(request({ actor: actor({ proof: { kind: "publication", id: "p1" } }) }), snapshot);
  assert.equal(proofForAnotherKind.allowed, false);
  assert.equal(proofForAnotherKind.code, INVALID_CREDENTIAL);

  const unknownOperation = authorize(request({ capability: "no_such_operation" }), snapshot);
  assert.equal(unknownOperation.allowed, false);
  assert.equal(unknownOperation.code, OPERATION_UNKNOWN);

  const wrongSurface = authorize(request({ capability: "get_note", surface: "admin" }), snapshot);
  assert.equal(wrongSurface.allowed, false);
  assert.equal(wrongSurface.code, CAPABILITY_DENIED);

  const wrongTargetKind = authorize(request({ capability: "get_note", target: { kind: "instance" } }), snapshot);
  assert.equal(wrongTargetKind.allowed, false);
  assert.equal(wrongTargetKind.code, CAPABILITY_DENIED);

  const badVaultId = authorize(request({ capability: "get_note", target: { kind: "vault", vaultId: "../etc" } }), snapshot);
  assert.equal(badVaultId.allowed, false);
  assert.equal(badVaultId.code, VAULT_ID_INVALID);
});

test("an_unbindable_ceiling_is_refused_by_the_pure_function_too", () => {
  // `verifiedActor()` holds this invariant, but `authorize()` must hold it on its own:
  // a ceiling with no subject to bind it is an unverifiable claim, not a grant.
  const handBuilt = {
    kind: "admin-session",
    subjectIds: [],
    credentialId: "admin-1",
    credentialEpochs: {},
    grantCeiling: [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note"] }],
    audience: null,
    expiresAt: null,
    revoked: false,
    transferGeneration: null,
    proof: { kind: "admin-session" },
  };
  const decision = authorize({ actor: handBuilt, capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "admin", nowMs: NOW }, snapshotWith());
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, INVALID_CREDENTIAL);
  // A trusted kind with no ceiling and no subjects is still fine.
  const trusted = authorize({
    actor: { ...handBuilt, grantCeiling: null },
    capability: "admin_metadata_read",
    target: { kind: "instance" },
    surface: "admin",
    nowMs: NOW,
  }, snapshotWith());
  assert.equal(trusted.allowed, true);
});

test("a_grant_never_bypasses_admission_or_read_only", () => {
  const snapshot = snapshotWith();
  const notAdmitted = authorize(request(), snapshotWith({ overrides: { vaultAdmissions: { [VAULT]: { admitted: false } } } }));
  assert.equal(notAdmitted.allowed, false);
  assert.equal(notAdmitted.code, VAULT_UNAVAILABLE);

  // A Vault the caller has no grant on answers like any other missing grant, so the
  // decision is not an existence oracle.
  const unknownVault = authorize(request({ target: { kind: "vault", vaultId: "vault-unknown" }, capability: "get_note" }), snapshot);
  assert.equal(unknownVault.allowed, false);
  assert.equal(unknownVault.code, VAULT_ACCESS_DENIED);
  // With the grant but no admission, the Vault is unavailable.
  const unadmittedButGranted = authorize(request({ capability: "get_note" }), snapshotWith({ overrides: { vaultAdmissions: {} } }));
  assert.equal(unadmittedButGranted.allowed, false);
  assert.equal(unadmittedButGranted.code, VAULT_UNAVAILABLE);

  const readOnlyVault = authorize(request({ capability: "write_note" }), snapshotWith({ overrides: { vaultAdmissions: { [VAULT]: { admitted: true, readOnly: true } } } }));
  assert.equal(readOnlyVault.allowed, false);
  assert.equal(readOnlyVault.code, CAPABILITY_DENIED);
  assert.equal(authorize(request({ capability: "get_note" }), snapshotWith({ overrides: { vaultAdmissions: { [VAULT]: { admitted: true, readOnly: true } } } })).allowed, true);

  const readOnlyDeployment = snapshotWith({ overrides: { deployment: { readOnly: true } } });
  assert.equal(authorize(request({ capability: "write_note" }), readOnlyDeployment).allowed, false);
  assert.equal(authorize(request({ capability: "write_note" }), readOnlyDeployment).code, CAPABILITY_DENIED);
  assert.equal(authorize(request({ capability: "get_note" }), readOnlyDeployment).allowed, true);
});

test("revocation_wins_over_a_scope_and_a_static_refusal_wins_over_a_suspend", () => {
  const revoke = constraintFrom({ id: UUID_A, mode: "revoke", capabilities: ["all"] });
  const revokeSnapshot = snapshotWith({ document: documentWith({ constraints: revoke.constraints, timeConstraintsEnabled: true }) });
  const revoked = authorize(request({ capability: "get_note", nowMs: OUTSIDE }), revokeSnapshot);
  assert.equal(revoked.allowed, false);
  assert.equal(revoked.code, OUTSIDE_WINDOW);
  assert.equal(revoked.mode, "revoke");
  assert.equal(revoked.enforcement, "transport", "a revoke maps the legacy 401");
  assert.equal(revoked.denyConstraintId, UUID_A);
  // Inside its window the revoke is inactive, so the same request is allowed.
  assert.equal(authorize(request({ capability: "get_note", nowMs: INSIDE }), revokeSnapshot).allowed, true);

  // No grant plus a suspend outside its window: the static refusal is reported, not
  // the window (the window must never mask a capability problem).
  const suspend = constraintFrom({ id: UUID_B, capabilities: ["surface:web", "tool:write_note"] });
  const noGrant = documentWith({ subjects: { [SUBJECT]: { credentialEpoch: 0, grants: [
    { target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note"] },
  ] } }, constraints: suspend.constraints, timeConstraintsEnabled: true });
  const staticRefusal = authorize(request({ capability: "write_note", nowMs: OUTSIDE }), snapshotWith({ document: noGrant }));
  assert.equal(staticRefusal.allowed, false);
  assert.equal(staticRefusal.code, CAPABILITY_DENIED);
  assert.equal(staticRefusal.mode, null);

  // With the grant, the suspend reports the window, its mode and the next opening.
  const suspended = authorize(request({ capability: "write_note", surface: "mcp", nowMs: OUTSIDE }), snapshotWith({ document: documentWith({ constraints: suspend.constraints, timeConstraintsEnabled: true }) }));
  assert.equal(suspended.allowed, false);
  assert.equal(suspended.code, OUTSIDE_WINDOW);
  assert.equal(suspended.mode, "suspend");
  assert.equal(suspended.enforcement, "operation");
  assert.equal(suspended.denyConstraintId, UUID_B);
  assert.deepEqual(suspended.matchedConstraintIds, [UUID_B]);
  assert.equal(typeof suspended.nextAllowedAt, "string");
  assert.equal(Date.parse(suspended.nextAllowedAt) > OUTSIDE, true);
  // Inside the window the same request is allowed.
  assert.equal(authorize(request({ capability: "write_note", nowMs: INSIDE }), snapshotWith({ document: documentWith({ constraints: suspend.constraints, timeConstraintsEnabled: true }) })).allowed, true);
});

test("inside_one_subject_grants_union_and_several_ceilings_intersect", () => {
  const document = documentWith(); // the subject holds every grantable Vault capability
  const snapshot = snapshotWith({ document });

  // Rows of one grant list union for the same target (a runtime projection may
  // carry one row per grant while a validated document keeps one per target).
  const union = actor({ grantCeiling: [
    { target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note"] },
    { target: { kind: "vault", vaultId: VAULT }, capabilities: ["write_note"] },
  ] });
  assert.equal(authorize(request({ capability: "get_note", actor: union }), snapshot).allowed, true);
  assert.equal(authorize(request({ capability: "write_note", actor: union }), snapshot).allowed, true);

  // A frozen token ceiling narrows the live grants, and the compat code says so.
  const narrowed = authorize(request({ capability: "write_note", actor: actor({ grantCeiling: [
    { target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note"] },
  ] }) }), snapshot);
  assert.equal(narrowed.allowed, false);
  assert.equal(narrowed.code, INSUFFICIENT_SCOPE);

  // The other direction: a ceiling cannot add a right the live grants lack.
  const readOnlyLive = documentWith({
    subjects: {
      [SUBJECT]: {
        credentialEpoch: 0,
        grants: [{ target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note", "search_notes"] }],
      },
    },
  });
  const added = authorize(request({ capability: "delete_file", actor: actor({ grantCeiling: [
    { target: { kind: "vault", vaultId: VAULT }, capabilities: ["get_note", "delete_file"] },
  ] }) }), snapshotWith({ document: readOnlyLive }));
  assert.equal(added.allowed, false);
  assert.equal(added.code, CAPABILITY_DENIED);

  // A client with `null` is neutral; a client with `[]` grants nothing.
  const clientDocument = documentWith({
    subjects: {
      [SUBJECT]: { credentialEpoch: 0, grants: grantsFor() },
      "oauth-client:neutral": { credentialEpoch: 0, grants: null },
      "oauth-client:empty": { credentialEpoch: 0, grants: [] },
    },
  });
  const identities = (clientId) => ({ overrides: { identities: { [SUBJECT]: { credentialEpoch: 0 }, [clientId]: { credentialEpoch: 0 } } } });
  const clientActor = (clientId) => actor({ subjectIds: [SUBJECT, clientId], credentialEpochs: { [SUBJECT]: 0, [clientId]: 0 } });
  assert.equal(authorize(request({ capability: "get_note", actor: clientActor("oauth-client:neutral") }), snapshotWith({ document: clientDocument, ...identities("oauth-client:neutral") })).allowed, true);
  const emptied = authorize(request({ capability: "get_note", actor: clientActor("oauth-client:empty") }), snapshotWith({ document: clientDocument, ...identities("oauth-client:empty") }));
  assert.equal(emptied.allowed, false);
  assert.equal(emptied.code, VAULT_ACCESS_DENIED);
});

test("control_operations_follow_their_trusted_proof", () => {
  const document = documentWith();
  const snapshot = snapshotWith({ document });
  const oauthRequest = (overrides = {}) => request({
    capability: "oauth_refresh",
    surface: "oauth",
    target: { kind: "instance" },
    ...overrides,
  });

  // The OAuth lifecycle is allowed to the OAuth actor and refused to anyone else.
  assert.equal(authorize(oauthRequest(), snapshot).allowed, true);
  const webActorOnOauth = authorize(oauthRequest({ actor: actor({ kind: "web-session" }) }), snapshot);
  assert.equal(webActorOnOauth.allowed, false);
  assert.equal(webActorOnOauth.code, INVALID_CREDENTIAL);
  // A revoke still denies it (that is the legacy 401).
  const revoke = constraintFrom({ id: UUID_A, mode: "revoke", capabilities: ["all"] });
  assert.equal(authorize(oauthRequest({ nowMs: OUTSIDE }), snapshotWith({ document: documentWith({ constraints: revoke.constraints, timeConstraintsEnabled: true }) })).allowed, false);

  // Admin control needs the admin-session proof.
  const adminRequest = (overrides = {}) => request({ capability: "admin_metadata_read", surface: "admin", target: { kind: "instance" }, ...overrides });
  assert.equal(authorize(adminRequest({ actor: actor({ kind: "admin-session", subjectIds: [], credentialEpochs: {}, proof: { kind: "admin-session" } }) }), snapshot).allowed, true);
  assert.equal(authorize(adminRequest({ actor: actor({ kind: "admin-session", subjectIds: [], credentialEpochs: {}, proof: { kind: "system", vaultId: VAULT, task: "commit" } }) }), snapshot).code, INVALID_CREDENTIAL);

  // System Git needs the matching task and Vault.
  const systemRequest = (capability, proof) => request({ capability, surface: "system", target: { kind: "vault", vaultId: VAULT }, actor: actor({ kind: "system", subjectIds: [], credentialEpochs: {}, proof }) });
  assert.equal(authorize(systemRequest("system_git_commit", { kind: "system", vaultId: VAULT, task: "commit" }), snapshot).allowed, true);
  assert.equal(authorize(systemRequest("system_git_push", { kind: "system", vaultId: VAULT, task: "commit" }), snapshot).code, INVALID_CREDENTIAL);
  assert.equal(authorize(systemRequest("system_git_commit", { kind: "system", vaultId: OTHER, task: "commit" }), snapshot).code, INVALID_CREDENTIAL);

  // An anonymous publication delegation resolves only its own active record.
  const publicationSnapshot = snapshotWith({
    document,
    overrides: { publication: { id: "pub-1", vaultId: VAULT, path: "notes/a.md", active: true } },
  });
  const publicationRequest = (id) => request({
    capability: "publish_document_read",
    surface: "publish",
    target: { kind: "publication", id },
    actor: actor({ kind: "publication", subjectIds: [], credentialEpochs: {}, proof: { kind: "publication", id } }),
  });
  assert.equal(authorize(publicationRequest("pub-1"), publicationSnapshot).allowed, true);
  assert.equal(authorize(publicationRequest("pub-2"), publicationSnapshot).code, INVALID_CREDENTIAL);
  // A broken authorization state does not revoke an existing public link.
  assert.equal(authorize(publicationRequest("pub-1"), { ...publicationSnapshot, status: "broken", document: null }).allowed, true);
  assert.equal(authorize(publicationRequest("pub-1"), { ...publicationSnapshot, publication: null }).code, INVALID_CREDENTIAL);

  // The Vault choice is derived from a per-Vault read, and grants no write.
  const selectRequest = request({ capability: "vault_select", surface: "web" });
  assert.equal(authorize(selectRequest, snapshot).allowed, true);
  assert.equal(authorize(selectRequest, snapshotWith({ document: documentWith({ subjects: { [SUBJECT]: { credentialEpoch: 0, grants: [
    { target: { kind: "vault", vaultId: VAULT }, capabilities: ["delete_file"] },
  ] } } }) })).allowed, false);
});

test("loading_and_broken_snapshots_deny_content_but_keep_the_repair_surface", () => {
  for (const status of ["loading", "broken"]) {
    const contentSnapshot = { status, document: null, identities: {}, vaultAdmissions: {}, publication: null, deployment: { readOnly: false } };
    const denied = authorize(request({ capability: "get_note" }), contentSnapshot);
    assert.equal(denied.allowed, false, status);
    assert.equal(denied.code, STATE_UNAVAILABLE);
    assert.equal(denied.enforcement, "transport");
    assert.equal(denied.revision, null);

    // The no-content repair surface stays open (§9): bootstrap and instance metadata.
    for (const capability of ["server_info", "agent_bootstrap"]) {
      assert.equal(authorize(request({ capability, target: { kind: "instance" } }), contentSnapshot).allowed, true, `${status} ${capability}`);
    }
    const admin = authorize(request({
      capability: "admin_metadata_read",
      surface: "admin",
      target: { kind: "instance" },
      actor: actor({ kind: "admin-session", subjectIds: [], credentialEpochs: {}, proof: { kind: "admin-session" } }),
    }), contentSnapshot);
    assert.equal(admin.allowed, true, status);
  }
});

test("an_empty_or_corrupt_state_denies_instead_of_guessing", () => {
  for (const snapshot of [
    undefined,
    null,
    {},
    { status: "ready" },
    { status: "ready", document: {} },
    { status: "weird", document: documentWith() },
  ]) {
    const decision = authorize(request(), snapshot);
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, STATE_UNAVAILABLE);
    assert.equal(decision.revision, null);
  }
  // A valid but empty document grants nothing.
  const empty = authorize(request(), snapshotWith({ document: documentWith({ subjects: {} }) }));
  assert.equal(empty.allowed, false);
  assert.equal(empty.code, VAULT_ACCESS_DENIED);

  // An invalid clock or a constraint whose schedule cannot be read is a policy
  // condition, never a silent allow.
  assert.equal(authorize(request({ nowMs: Number.NaN }), snapshotWith()).code, POLICY_UNAVAILABLE);
  assert.equal(authorize(request({ nowMs: "2026-11-02" }), snapshotWith()).code, POLICY_UNAVAILABLE);
  const brokenSchedule = {
    ...documentWith({ constraints: constraintFrom({}).constraints, timeConstraintsEnabled: true }),
  };
  brokenSchedule.constraints = [{ ...brokenSchedule.constraints[0], schedule: { ...brokenSchedule.constraints[0].schedule, timezone: "Mars/Olympus" } }];
  const broken = authorize(request({ capability: "get_note" }), snapshotWith({ document: brokenSchedule }));
  assert.equal(broken.allowed, false);
  assert.equal(broken.code, POLICY_UNAVAILABLE);
});

test("the_decision_carries_no_subject_id_and_no_content", () => {
  const decisions = [
    decide(),
    decide({ capability: "write_note", target: { kind: "vault", vaultId: OTHER } }),
    decide({ capability: "get_note" }, { document: documentWith({ constraints: constraintFrom({ mode: "revoke", capabilities: ["all"] }).constraints, timeConstraintsEnabled: true }) }),
  ];
  for (const decision of decisions) {
    const text = JSON.stringify(decision);
    for (const forbidden of ["oauth-user:", SUBJECT, `"${VAULT}"`, "notes/", ".md", "secret", "token"]) {
      assert.equal(text.includes(forbidden), false, `${forbidden} leaked into ${text}`);
    }
    assert.deepEqual(Object.keys(decision).sort(), [
      "allowed", "code", "denyConstraintId", "enforcement", "matchedConstraintIds", "mode", "nextAllowedAt", "revision",
    ]);
  }
  assert.equal(decisions[0].code, ALLOWED);
});

test("windows_and_timezones_use_the_existing_time_algebra", () => {
  const schedule = {
    timezone: "Asia/Shanghai",
    weekly: { mon: [["09:00", "18:00"]] },
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
  };
  for (const timezone of ["UTC", "Asia/Shanghai", "America/New_York"]) {
    // Spring forward in New York (2026-03-08) is the DST edge.
    const instants = [
      Date.parse("2026-03-08T06:59:59.000Z"),
      Date.parse("2026-03-08T07:00:00.000Z"),
      Date.parse("2026-03-08T12:00:00.000Z"),
      Date.parse("2026-03-08T18:00:00.000Z"),
      Date.parse("2026-11-01T05:00:00.000Z"), // fall back
      INSIDE,
      OUTSIDE,
    ];
    const constraint = {
      id: UUID_A,
      label: "window",
      enabled: true,
      subjects: [SUBJECT],
      mode: "suspend",
      selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }] },
      schedule: { ...schedule, timezone },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    const document = documentWith({ constraints: [constraint], timeConstraintsEnabled: true });
    for (const nowMs of instants) {
      const expected = evaluatePolicySchedule(constraint.schedule, nowMs).ok;
      const decision = authorize(request({ capability: "get_note", nowMs }), snapshotWith({ document }));
      assert.equal(decision.allowed, expected, `${timezone} ${new Date(nowMs).toISOString()}`);
    }
  }

  // startsAt / expiresAt at plus and minus one millisecond.
  const startsAt = Date.parse("2026-11-02T00:00:00.000Z");
  const expiresAt = Date.parse("2026-11-03T00:00:00.000Z");
  const constraint = {
    id: UUID_B,
    label: "bounded",
    enabled: true,
    subjects: [SUBJECT],
    mode: "suspend",
    selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }] },
    schedule: { timezone: "UTC", weekly: {}, dateRanges: [], startsAt: new Date(startsAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
  const document = documentWith({ constraints: [constraint], timeConstraintsEnabled: true });
  const at = (nowMs) => authorize(request({ capability: "get_note", nowMs }), snapshotWith({ document }));
  assert.equal(at(startsAt - 1).allowed, false, "one millisecond before the start is outside");
  assert.equal(at(startsAt - 1).code, OUTSIDE_WINDOW);
  assert.equal(at(startsAt).allowed, true, "the first instant inside is allowed");
  assert.equal(at(expiresAt - 1).allowed, true);
  assert.equal(at(expiresAt).allowed, false, "the expiry instant is already outside");
});

test("several_suspends_and_revokes_together", () => {
  const inside = legacyPolicy({ id: UUID_A, label: "inside", capabilities: ["all"], weekly: { mon: [["09:00", "18:00"]] } });
  const outside = legacyPolicy({ id: UUID_B, label: "outside", capabilities: ["tool:write_note"], weekly: { mon: [["19:00", "20:00"]] } });
  const { constraints } = importLegacyConstraints({ policyDocument: legacyDocument([inside, outside]) });
  const document = documentWith({ constraints, timeConstraintsEnabled: true });

  // Both constraints match the write at 20:00 and both are outside their windows;
  // the reported one is the first in document order, as the legacy evaluator did.
  const writeOutside = authorize(request({ capability: "write_note", nowMs: OUTSIDE }), snapshotWith({ document }));
  assert.equal(writeOutside.allowed, false);
  assert.equal(writeOutside.mode, "suspend");
  assert.equal(writeOutside.denyConstraintId, UUID_A);
  assert.deepEqual(writeOutside.matchedConstraintIds, [UUID_A, UUID_B]);

  // Only the all-selector suspend matches a read, and 20:00 is outside 09:00-18:00.
  const readOutside = authorize(request({ capability: "get_note", nowMs: OUTSIDE }), snapshotWith({ document }));
  assert.equal(readOutside.allowed, false);
  assert.equal(readOutside.denyConstraintId, UUID_A);
  assert.deepEqual(readOutside.matchedConstraintIds, [UUID_A]);

  // Both constraints inside their windows: allowed.
  assert.equal(authorize(request({ capability: "get_note", nowMs: INSIDE }), snapshotWith({ document })).allowed, true);

  // A revoke and a suspend both outside: the revoke wins and maps the transport.
  const revoke = legacyPolicy({ id: UUID_A, label: "revoke", mode: "revoke", capabilities: ["all"] });
  const mixed = importLegacyConstraints({ policyDocument: legacyDocument([legacyPolicy({ id: UUID_B, label: "suspend" }), revoke]) }).constraints;
  const mixedDecision = authorize(request({ capability: "get_note", nowMs: OUTSIDE }), snapshotWith({ document: documentWith({ constraints: mixed, timeConstraintsEnabled: true }) }));
  assert.equal(mixedDecision.allowed, false);
  assert.equal(mixedDecision.mode, "revoke");
  assert.equal(mixedDecision.enforcement, "transport");
});

test("time_constraints_off_leave_the_grants_in_charge", () => {
  const revoke = constraintFrom({ mode: "revoke", capabilities: ["all"] }, { timeConstraintsEnabled: false });
  const document = documentWith({ constraints: revoke.constraints, timeConstraintsEnabled: false });
  assert.equal(authorize(request({ capability: "get_note" }), snapshotWith({ document })).allowed, true);
});

test("old_and_new_verdicts_agree_across_the_full_matrix_through_authorize", () => {
  const policies = fidelityPolicies();
  const { constraints } = importLegacyConstraints({ policyDocument: legacyDocument(policies) });
  const byId = new Map(constraints.map((constraint) => [constraint.id, constraint]));

  const { rows, comparable, inconclusive, boundaries, differences } = runFidelityMatrix({
    policies,
    evaluateNew: ({ policy, boundary, instant }) => {
      const document = documentWith({ constraints: [byId.get(policy.id)], timeConstraintsEnabled: true });
      const operation = authorizationOperation(boundary.capability);
      const target = operation.targetKind === "instance" ? { kind: "instance" } : { kind: "vault", vaultId: VAULT };
      return authorize({
        actor: actor(),
        capability: boundary.capability,
        target,
        surface: boundary.surface,
        nowMs: instant.nowMs,
      }, snapshotWith({ document })).allowed;
    },
  });

  assert.equal(boundaries.length, 145);
  assert.equal(rows.length, 2610);
  // §4.1a now exempts the instance metadata plane (`agent_bootstrap`, `server_info`,
  // `agent_memory_policy_read`), so those three boundaries are no longer gated rows: the
  // legacy gate never evaluated them either (A-07's bypass), and the matrix counts them as
  // inconclusive instead of pretending a policy decided them. Every other row is unchanged.
  assert.equal(comparable.length, 2340);
  assert.equal(inconclusive.length, 270);
  assert.deepEqual(differences, [], "no fidelity difference is allowed in this phase");
  assert.deepEqual(comparable.map((row) => row.old), comparable.map((row) => row.new));
});

test("the_exemption_is_the_operations_and_the_vault_list_stays_gated", () => {
  const webSuspension = constraintFrom({ capabilities: ["surface:web"] });
  const document = documentWith({ constraints: webSuspension.constraints, timeConstraintsEnabled: true });
  const at = (capability, surface = "web", target = { kind: "instance" }) => authorize({
    actor: actor(),
    capability,
    target,
    surface,
    nowMs: OUTSIDE,
  }, snapshotWith({ document }));

  // The two identity/session operations stay open: a window never locks them out.
  assert.equal(at("vault_select", "web", { kind: "vault", vaultId: VAULT }).allowed, true);
  assert.equal(at("session_bootstrap").allowed, true);
  // The Vault list has its own gated operation, so the window still applies.
  const gated = at("vault_list_read");
  assert.equal(gated.allowed, false);
  assert.equal(gated.code, OUTSIDE_WINDOW);
  // A request that carries an invented `boundary` field gains nothing: the exemption
  // is the operation's, so the field cannot select one.
  const invented = authorize({
    actor: actor(),
    capability: "vault_list_read",
    target: { kind: "instance" },
    surface: "web",
    boundary: "GET /api/web/v1/session",
    nowMs: OUTSIDE,
  }, snapshotWith({ document }));
  assert.equal(invented.allowed, false);
  assert.equal(invented.code, OUTSIDE_WINDOW);
  // An exempt capability in the same request path is allowed: the contrast proves the
  // field is inert and the operation is what matters.
  assert.equal(at("vault_select", "web", { kind: "vault", vaultId: VAULT }).allowed, true);
});

test("a_trusted_task_or_console_actor_carries_no_subject", () => {
  const document = documentWith();
  const systemActor = actor({ kind: "system", subjectIds: [SUBJECT], credentialEpochs: { [SUBJECT]: 0 }, proof: { kind: "system", vaultId: VAULT, task: "commit" } });
  const systemDecision = authorize({
    actor: systemActor,
    capability: "system_git_commit",
    target: { kind: "vault", vaultId: VAULT },
    surface: "system",
    nowMs: NOW,
  }, snapshotWith({ document }));
  assert.equal(systemDecision.allowed, false);
  assert.equal(systemDecision.code, INVALID_CREDENTIAL);

  const adminActor = actor({ kind: "admin-session", subjectIds: [SUBJECT], credentialEpochs: { [SUBJECT]: 0 }, proof: { kind: "admin-session" } });
  const adminDecision = authorize({
    actor: adminActor,
    capability: "admin_metadata_read",
    target: { kind: "instance" },
    surface: "admin",
    nowMs: NOW,
  }, snapshotWith({ document }));
  assert.equal(adminDecision.allowed, false);
  assert.equal(adminDecision.code, INVALID_CREDENTIAL);

  // A background commit during a user's suspend window is not stopped by it.
  const suspension = constraintFrom({ capabilities: ["all"] });
  const suspended = snapshotWith({ document: documentWith({ constraints: suspension.constraints, timeConstraintsEnabled: true }) });
  const backgroundTask = authorize({
    actor: actor({ kind: "system", subjectIds: [], credentialEpochs: {}, proof: { kind: "system", vaultId: VAULT, task: "commit" } }),
    capability: "system_git_commit",
    target: { kind: "vault", vaultId: VAULT },
    surface: "system",
    nowMs: OUTSIDE,
  }, suspended);
  assert.equal(backgroundTask.allowed, true);
});

test("the_repair_surface_stays_open_without_an_actor_and_nothing_else_does", () => {
  // §9 keeps a no-content repair surface while the state is broken. The pure function
  // allows it without an actor; the runtime (see its own test) never lets an
  // unbranded caller reach that path, so the split cannot widen silently.
  const broken = { status: "broken", document: null, identities: {}, vaultAdmissions: {}, publication: null, deployment: { readOnly: false } };
  for (const capability of ["server_info", "agent_bootstrap"]) {
    const decision = authorize({ capability, target: { kind: "instance" }, surface: "mcp", nowMs: NOW }, broken);
    assert.equal(decision.allowed, true, capability);
  }
  const content = authorize({ capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp", nowMs: NOW }, broken);
  assert.equal(content.allowed, false);
  assert.equal(content.code, STATE_UNAVAILABLE);
  // A content capability never joins the repair surface, even with an actor.
  const withActor = authorize({ actor: actor(), capability: "get_note", target: { kind: "vault", vaultId: VAULT }, surface: "mcp", nowMs: NOW }, broken);
  assert.equal(withActor.allowed, false);
});
