// P1 / Task 3 — strict authorization document schema (design §5, §8).
//
// The document is the single persisted permission state. Everything here is a
// data boundary only: no decision, no clock, no I/O. A shape the design does not
// name is refused, a limit is refused instead of truncated, and a JSON text with
// duplicate keys is refused before it can collapse a security field.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORIZATION_CODES,
  AUTHORIZATION_LIMITS,
  parseAuthorizationDocument,
  serializeAuthorizationDocument,
  validateAuthorizationDocument,
} from "../src/authorization/schema.js";
import {
  AUTHORIZATION_CATALOG_VERSION,
  authorizationOperation,
  catalogOperationIds,
} from "../src/authorization/catalog.js";

const { INVALID_DOCUMENT, LIMIT_EXCEEDED, STATE_UNAVAILABLE, UNSUPPORTED_SCHEMA } = AUTHORIZATION_CODES;

const UUID_A = "3f1e6b2c-9a4d-4a53-9d1f-0c2b7e5a1c11";
const UUID_B = "7c9e1f42-2b3d-4c88-8e6f-1a2b3c4d5e6f";

function validDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision: 1,
    timeConstraintsEnabled: false,
    subjects: {
      "oauth-user:u1": {
        credentialEpoch: 0,
        grants: [
          { target: { kind: "vault", vaultId: "vault" }, capabilities: ["get_note", "search_notes"] },
          { target: { kind: "vault", vaultId: "example-vault" }, capabilities: ["get_note", "write_note"] },
          { target: { kind: "instance" }, capabilities: ["agent_bootstrap", "server_info"] },
        ],
      },
      "oauth-client:c1": { credentialEpoch: 0, grants: null },
    },
    constraints: [],
    ...overrides,
  };
}

function validConstraint(overrides = {}) {
  return {
    id: UUID_A,
    label: "nightly suspend",
    enabled: true,
    subjects: ["oauth-user:u1"],
    mode: "suspend",
    selector: { anyOf: [{ surfaces: ["web"], capabilities: ["write_note"], targets: null }] },
    schedule: {
      timezone: "Asia/Shanghai",
      weekly: { mon: [["09:00", "18:00"]] },
      dateRanges: [{ from: "2026-11-01", to: "2026-11-30" }],
      startsAt: null,
      expiresAt: null,
    },
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  };
}

function expectParseCode(text, code) {
  const result = parseAuthorizationDocument(text);
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result).slice(0, 200)}`);
  assert.equal(result.document, undefined);
  assert.equal(result.code, code);
}

function expectInvalid(value, code) {
  assert.throws(
    () => validateAuthorizationDocument(value),
    (error) => {
      assert.equal(error.code, code, error.message);
      return true;
    },
  );
}

test("schema_rejects_duplicate_keys_missing_grants_and_unknown_versions", () => {
  // Duplicate keys must die in the JSON text, not in a JS object.
  expectParseCode('{"schemaVersion":1,"schemaVersion":2}', STATE_UNAVAILABLE);
  const document = validDocument();
  const text = serializeAuthorizationDocument(document);
  const duplicated = text.replace('"credentialEpoch": 0', '"credentialEpoch": 0, "credentialEpoch": 0');
  assert.notEqual(duplicated, text, "the fixture must really carry a repeated key");
  expectParseCode(duplicated, STATE_UNAVAILABLE);
  // A repeated key deeper in the tree (inside a grant target) is the same boundary.
  const nested = text.replace('"kind": "vault"', '"kind": "vault", "kind": "instance"');
  assert.notEqual(nested, text, "the nested fixture must really carry a repeated key");
  expectParseCode(nested, STATE_UNAVAILABLE);

  const missingGrants = validDocument();
  delete missingGrants.subjects["oauth-user:u1"].grants;
  expectParseCode(JSON.stringify(missingGrants), INVALID_DOCUMENT);

  // Only an OAuth client may hold `null`, and it is not a grant.
  expectParseCode(JSON.stringify(validDocument({ schemaVersion: 2 })), UNSUPPORTED_SCHEMA);
  expectParseCode(JSON.stringify(validDocument({ catalogVersion: AUTHORIZATION_CATALOG_VERSION + 1 })), STATE_UNAVAILABLE);

  const clientNull = validDocument();
  assert.equal(parseAuthorizationDocument(JSON.stringify(clientNull)).document.subjects["oauth-client:c1"].grants, null);
});

test("schema_parses_the_design_example_document", () => {
  const document = validDocument();
  const parsed = parseAuthorizationDocument(serializeAuthorizationDocument(document));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.document, document);
});

test("schema_accepts_an_older_catalog_version_and_keeps_its_meaning", () => {
  const older = validDocument({ catalogVersion: AUTHORIZATION_CATALOG_VERSION - 1 });
  const parsed = parseAuthorizationDocument(JSON.stringify(older));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.document.catalogVersion, AUTHORIZATION_CATALOG_VERSION - 1);
  assert.doesNotThrow(() => validateAuthorizationDocument(older));
  // A document older than the catalog is not re-written to the current version.
  assert.equal(serializeAuthorizationDocument(parsed.document).includes(`"catalogVersion": ${AUTHORIZATION_CATALOG_VERSION - 1}`), true);
});

test("schema_refuses_unknown_fields_at_every_level", () => {
  const top = validDocument();
  top.unknownField = 1;
  expectInvalid(top, INVALID_DOCUMENT);

  const subject = validDocument();
  subject.subjects["oauth-user:u1"].password = "x";
  expectInvalid(subject, INVALID_DOCUMENT);

  const grant = validDocument();
  grant.subjects["oauth-user:u1"].grants[0].expiresAt = null;
  expectInvalid(grant, INVALID_DOCUMENT);

  const target = validDocument();
  target.subjects["oauth-user:u1"].grants[0].target.path = "/vault/note.md";
  expectInvalid(target, INVALID_DOCUMENT);

  const constraint = validDocument({ constraints: [validConstraint({ expression: "true" })] });
  expectInvalid(constraint, INVALID_DOCUMENT);
});

test("schema_refuses_null_grants_for_every_subject_but_an_oauth_client", () => {
  for (const subjectId of ["oauth-user:u1", "api-key:k1"]) {
    const document = validDocument();
    document.subjects[subjectId] = { credentialEpoch: 0, grants: null };
    expectInvalid(document, INVALID_DOCUMENT);
    expectParseCode(JSON.stringify(document), INVALID_DOCUMENT);
  }
  // `grants: []` is a real value = no rights, not a missing field.
  const empty = validDocument();
  empty.subjects["oauth-user:u1"].grants = [];
  assert.equal(parseAuthorizationDocument(JSON.stringify(empty)).ok, true);
});

test("schema_refuses_invalid_ids_epochs_targets_and_grant_rows", () => {
  const badSubjectId = validDocument();
  badSubjectId.subjects["alice"] = { credentialEpoch: 0, grants: [] };
  expectInvalid(badSubjectId, INVALID_DOCUMENT);

  const bareSubjectId = validDocument();
  bareSubjectId.subjects["oauth-user:"] = { credentialEpoch: 0, grants: [] };
  expectInvalid(bareSubjectId, INVALID_DOCUMENT);

  const negativeEpoch = validDocument();
  negativeEpoch.subjects["oauth-user:u1"].credentialEpoch = -1;
  expectInvalid(negativeEpoch, INVALID_DOCUMENT);

  const fractionalEpoch = validDocument();
  fractionalEpoch.subjects["oauth-user:u1"].credentialEpoch = 1.5;
  expectInvalid(fractionalEpoch, INVALID_DOCUMENT);

  const missingEpoch = validDocument();
  delete missingEpoch.subjects["oauth-user:u1"].credentialEpoch;
  expectInvalid(missingEpoch, INVALID_DOCUMENT);

  const unknownTargetKind = validDocument();
  unknownTargetKind.subjects["oauth-user:u1"].grants[0].target = { kind: "vaults", vaultId: "vault" };
  expectInvalid(unknownTargetKind, INVALID_DOCUMENT);

  const emptyVaultId = validDocument();
  emptyVaultId.subjects["oauth-user:u1"].grants[0].target = { kind: "vault", vaultId: "" };
  expectInvalid(emptyVaultId, INVALID_DOCUMENT);

  const duplicateTarget = validDocument();
  duplicateTarget.subjects["oauth-user:u1"].grants.push({
    target: { kind: "vault", vaultId: "vault" },
    capabilities: ["list_notes"],
  });
  expectInvalid(duplicateTarget, INVALID_DOCUMENT);

  const duplicateCapability = validDocument();
  duplicateCapability.subjects["oauth-user:u1"].grants[0].capabilities = ["get_note", "get_note"];
  expectInvalid(duplicateCapability, INVALID_DOCUMENT);

  const missingRevision = validDocument();
  delete missingRevision.revision;
  expectInvalid(missingRevision, INVALID_DOCUMENT);

  const zeroRevision = validDocument({ revision: 0 });
  expectInvalid(zeroRevision, INVALID_DOCUMENT);

  const missingFlag = validDocument();
  delete missingFlag.timeConstraintsEnabled;
  expectInvalid(missingFlag, INVALID_DOCUMENT);

  const missingConstraints = validDocument();
  delete missingConstraints.constraints;
  expectInvalid(missingConstraints, INVALID_DOCUMENT);

  const missingSubjects = validDocument();
  delete missingSubjects.subjects;
  expectInvalid(missingSubjects, INVALID_DOCUMENT);
});

test("schema_refuses_malformed_unknown_and_non_grantable_capabilities", () => {
  for (const capability of ["", 42, "Get_Note", "get-note", "get note", null]) {
    const document = validDocument();
    document.subjects["oauth-user:u1"].grants[0].capabilities = [capability];
    expectInvalid(document, INVALID_DOCUMENT);
  }

  // Known but not grantable: control-plane operations are injected by a trusted
  // verifier and can never be written into a subject grant.
  const adminGrant = validDocument();
  adminGrant.subjects["oauth-user:u1"].grants[2].capabilities = ["admin_metadata_read"];
  expectInvalid(adminGrant, INVALID_DOCUMENT);

  const systemGrant = validDocument();
  systemGrant.subjects["oauth-user:u1"].grants[0].capabilities = ["system_git_push"];
  expectInvalid(systemGrant, INVALID_DOCUMENT);

  const selectGrant = validDocument();
  selectGrant.subjects["oauth-user:u1"].grants[0].capabilities = ["vault_select"];
  expectInvalid(selectGrant, INVALID_DOCUMENT);

  // The target kind of the operation and of the grant must agree.
  const wrongKind = validDocument();
  wrongKind.subjects["oauth-user:u1"].grants[0].capabilities = ["agent_memory_policy_read"];
  expectInvalid(wrongKind, INVALID_DOCUMENT);

  const wrongKindOther = validDocument();
  wrongKindOther.subjects["oauth-user:u1"].grants[2].capabilities = ["get_note"];
  expectInvalid(wrongKindOther, INVALID_DOCUMENT);
});

test("schema_accepts_an_unknown_well_formed_capability_without_touching_the_rest", () => {
  // Design §5.1: an unknown capability ID is refused when that operation is
  // requested (`operation_unknown`), not by refusing the whole document, and it
  // never affects the other capabilities of the same subject.
  const document = validDocument();
  document.subjects["oauth-user:u1"].grants[0].capabilities = ["future_vault_tool", "get_note"];

  const parsed = parseAuthorizationDocument(JSON.stringify(document));
  assert.equal(parsed.ok, true);
  assert.equal(authorizationOperation("future_vault_tool"), null);
  assert.deepEqual(parsed.document.subjects["oauth-user:u1"].grants[0].capabilities, ["future_vault_tool", "get_note"]);
  assert.deepEqual(parsed.document.subjects["oauth-user:u1"].grants[2].capabilities, ["agent_bootstrap", "server_info"]);
  assert.equal(authorizationOperation("get_note").targetKind, "vault");
});

test("schema_enforces_the_frozen_limits_without_truncating", () => {
  assert.equal(AUTHORIZATION_LIMITS.fileBytes, 16 * 1024 * 1024);
  assert.equal(AUTHORIZATION_LIMITS.subjects, 10000);
  assert.equal(AUTHORIZATION_LIMITS.targetsPerSubject, 65);
  assert.equal(AUTHORIZATION_LIMITS.constraints, 512);
  assert.equal(AUTHORIZATION_LIMITS.subjectsPerConstraint, 32);
  assert.equal(AUTHORIZATION_LIMITS.selectorBranches, 64);
  assert.equal(AUTHORIZATION_LIMITS.capabilitiesPerBranch, 128);
  assert.equal(AUTHORIZATION_LIMITS.capabilitiesPerGrant, catalogOperationIds.length);

  const atLimit = validDocument();
  for (let index = 0; index < AUTHORIZATION_LIMITS.subjects - 2; index += 1) {
    atLimit.subjects[`api-key:k${index}`] = { credentialEpoch: 0, grants: [] };
  }
  assert.equal(Object.keys(atLimit.subjects).length, AUTHORIZATION_LIMITS.subjects);
  assert.doesNotThrow(() => validateAuthorizationDocument(atLimit));

  const overLimit = structuredClone(atLimit);
  overLimit.subjects["api-key:extra"] = { credentialEpoch: 0, grants: [] };
  expectInvalid(overLimit, LIMIT_EXCEEDED);

  const targets = validDocument();
  targets.subjects["oauth-user:u1"].grants = [];
  for (let index = 0; index < AUTHORIZATION_LIMITS.targetsPerSubject; index += 1) {
    targets.subjects["oauth-user:u1"].grants.push({ target: { kind: "vault", vaultId: `vault-${index}` }, capabilities: [] });
  }
  assert.doesNotThrow(() => validateAuthorizationDocument(targets));
  targets.subjects["oauth-user:u1"].grants.push({ target: { kind: "instance" }, capabilities: [] });
  expectInvalid(targets, LIMIT_EXCEEDED);

  const capabilities = validDocument();
  capabilities.subjects["oauth-user:u1"].grants[0].capabilities = [];
  for (let index = 0; index < AUTHORIZATION_LIMITS.capabilitiesPerGrant; index += 1) {
    capabilities.subjects["oauth-user:u1"].grants[0].capabilities.push(`future_capability_${index}`);
  }
  assert.doesNotThrow(() => validateAuthorizationDocument(capabilities));
  capabilities.subjects["oauth-user:u1"].grants[0].capabilities.push("future_capability_extra");
  expectInvalid(capabilities, LIMIT_EXCEEDED);

  const branches = validDocument({ constraints: [] });
  const branchList = (count) => Array.from({ length: count }, () => ({ surfaces: null, capabilities: null, targets: null }));
  branches.constraints = [validConstraint({ selector: { anyOf: branchList(AUTHORIZATION_LIMITS.selectorBranches) } })];
  assert.doesNotThrow(() => validateAuthorizationDocument(branches));
  branches.constraints[0].selector.anyOf = branchList(AUTHORIZATION_LIMITS.selectorBranches + 1);
  expectInvalid(branches, LIMIT_EXCEEDED);

  const branchCapabilities = validDocument({ constraints: [] });
  branchCapabilities.constraints = [validConstraint({
    selector: {
      anyOf: [{
        surfaces: null,
        capabilities: Array.from({ length: AUTHORIZATION_LIMITS.capabilitiesPerBranch }, (_, index) => `future_capability_${index}`),
        targets: null,
      }],
    },
  })];
  assert.doesNotThrow(() => validateAuthorizationDocument(branchCapabilities));
  branchCapabilities.constraints[0].selector.anyOf[0].capabilities.push("future_capability_extra");
  expectInvalid(branchCapabilities, LIMIT_EXCEEDED);

  const constraintSubjects = validDocument({ constraints: [] });
  constraintSubjects.constraints = [validConstraint({
    subjects: Array.from({ length: AUTHORIZATION_LIMITS.subjectsPerConstraint + 1 }, (_, index) => `oauth-user:u${index}`),
  })];
  expectInvalid(constraintSubjects, LIMIT_EXCEEDED);

  const manyConstraints = validDocument({ constraints: [] });
  manyConstraints.constraints = Array.from({ length: AUTHORIZATION_LIMITS.constraints + 1 }, (_, index) => validConstraint({
    id: `3f1e6b2c-9a4d-4a53-9d1f-${String(index).padStart(12, "0")}`,
  }));
  expectInvalid(manyConstraints, LIMIT_EXCEEDED);

  const longLabel = validDocument({ constraints: [validConstraint({ label: "x".repeat(AUTHORIZATION_LIMITS.labelMaxLength + 1) })] });
  expectInvalid(longLabel, LIMIT_EXCEEDED);

  const longTimezone = validDocument({ constraints: [validConstraint({
    schedule: { timezone: "x".repeat(AUTHORIZATION_LIMITS.timezoneMaxLength + 1), weekly: {}, dateRanges: [], startsAt: null, expiresAt: null },
  })] });
  expectInvalid(longTimezone, LIMIT_EXCEEDED);

  const weeklyOverflow = validDocument({ constraints: [validConstraint({
    schedule: {
      timezone: "UTC",
      weekly: { mon: Array.from({ length: AUTHORIZATION_LIMITS.weeklyIntervals + 1 }, () => ["09:00", "10:00"]) },
      dateRanges: [],
      startsAt: null,
      expiresAt: null,
    },
  })] });
  expectInvalid(weeklyOverflow, LIMIT_EXCEEDED);

  const dateRangeOverflow = validDocument({ constraints: [validConstraint({
    schedule: {
      timezone: "UTC",
      weekly: {},
      dateRanges: Array.from({ length: AUTHORIZATION_LIMITS.dateRanges + 1 }, () => ({ from: "2026-11-01", to: "2026-11-02" })),
      startsAt: null,
      expiresAt: null,
    },
  })] });
  expectInvalid(dateRangeOverflow, LIMIT_EXCEEDED);
});

test("schema_refuses_a_document_over_sixteen_mebibytes", () => {
  const head = '{"schemaVersion":1}';
  const text = `${head}${" ".repeat(AUTHORIZATION_LIMITS.fileBytes + 1 - head.length)}`;
  assert.equal(Buffer.byteLength(text), AUTHORIZATION_LIMITS.fileBytes + 1);
  expectParseCode(text, STATE_UNAVAILABLE);
  expectParseCode("x".repeat(AUTHORIZATION_LIMITS.fileBytes + 1), STATE_UNAVAILABLE);
  // A non-string input is not a document either.
  expectParseCode(null, STATE_UNAVAILABLE);
  expectParseCode("", STATE_UNAVAILABLE);
  expectParseCode("not json", STATE_UNAVAILABLE);
});

test("schema_validates_constraint_branches_and_the_revoke_shape", () => {
  const ok = validDocument({ constraints: [validConstraint()] });
  assert.doesNotThrow(() => validateAuthorizationDocument(ok));

  const emptyBranchList = validDocument({ constraints: [validConstraint({ selector: { anyOf: [] } })] });
  expectInvalid(emptyBranchList, INVALID_DOCUMENT);

  for (const field of ["surfaces", "capabilities", "targets"]) {
    const emptyArray = validDocument({ constraints: [validConstraint({ selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null, [field]: [] }] } })] });
    expectInvalid(emptyArray, INVALID_DOCUMENT);
  }

  const unknownSurface = validDocument({ constraints: [validConstraint({ selector: { anyOf: [{ surfaces: ["grpc"], capabilities: null, targets: null }] } })] });
  expectInvalid(unknownSurface, INVALID_DOCUMENT);

  const nestedExpression = validDocument({ constraints: [validConstraint({ selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }], not: { anyOf: [] } } })] });
  expectInvalid(nestedExpression, INVALID_DOCUMENT);

  const partialRevoke = validDocument({ constraints: [validConstraint({ mode: "revoke", selector: { anyOf: [{ surfaces: ["mcp"], capabilities: null, targets: null }] } })] });
  expectInvalid(partialRevoke, INVALID_DOCUMENT);

  const twoBranchRevoke = validDocument({ constraints: [validConstraint({
    mode: "revoke",
    selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }, { surfaces: null, capabilities: null, targets: null }] },
  })] });
  expectInvalid(twoBranchRevoke, INVALID_DOCUMENT);

  const fullRevoke = validDocument({ constraints: [validConstraint({ mode: "revoke", selector: { anyOf: [{ surfaces: null, capabilities: null, targets: null }] } })] });
  assert.doesNotThrow(() => validateAuthorizationDocument(fullRevoke));

  const badMode = validDocument({ constraints: [validConstraint({ mode: "grant" })] });
  expectInvalid(badMode, INVALID_DOCUMENT);

  const badId = validDocument({ constraints: [validConstraint({ id: "not-a-uuid" })] });
  expectInvalid(badId, INVALID_DOCUMENT);

  const badTimezone = validDocument({ constraints: [validConstraint({
    schedule: { timezone: "Mars/Olympus", weekly: {}, dateRanges: [], startsAt: null, expiresAt: null },
  })] });
  expectInvalid(badTimezone, INVALID_DOCUMENT);

  const missingScheduleField = validDocument({ constraints: [validConstraint({
    schedule: { timezone: "UTC", weekly: {}, dateRanges: [], startsAt: null },
  })] });
  expectInvalid(missingScheduleField, INVALID_DOCUMENT);

  const badInstant = validDocument({ constraints: [validConstraint({ createdAt: "yesterday" })] });
  expectInvalid(badInstant, INVALID_DOCUMENT);

  const badSubject = validDocument({ constraints: [validConstraint({ subjects: ["alice"] })] });
  expectInvalid(badSubject, INVALID_DOCUMENT);
});

test("schema_round_trips_and_never_adds_state", () => {
  const document = validDocument({
    timeConstraintsEnabled: true,
    constraints: [validConstraint(), validConstraint({ id: UUID_B, mode: "suspend", label: "weekend" })],
  });
  const text = serializeAuthorizationDocument(document);
  assert.equal(text.endsWith("\n"), true);
  const parsed = parseAuthorizationDocument(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.document, document);
  assert.equal(serializeAuthorizationDocument(parsed.document), text);

  const broken = validDocument();
  delete broken.subjects["oauth-user:u1"].grants;
  assert.throws(() => serializeAuthorizationDocument(broken), (error) => error.code === INVALID_DOCUMENT);
  // `grants` is never filled in, and a subject is never dropped.
  assert.equal("grants" in broken.subjects["oauth-user:u1"], false);
});
