// P1 / Task 5 — lossless import of legacy accounts, keys, clients and tokens.
//
// Contract: design §5.3 (legacy defaults) and §4.1 (grantable set, read presets,
// resources, instance metadata). The importer turns one verified, normalized
// provider snapshot into one authorization document plus the frozen per-token
// envelopes. It never reads the provider again, never writes a file, and never
// keeps an old fallback: a token keeps the Vault set it was issued with, and a
// missing account refuses the import instead of guessing rights.
//
// Policy conversion is Task 6. With `policyDocument` empty this module stands
// alone, and a non-empty policy is refused rather than silently dropped.

import assert from "node:assert/strict";
import test from "node:test";

import {
  importLegacyAuthorization,
  LEGACY_IMPORT_CODES,
} from "../src/authorization/legacy-import.js";
import { AUTHORIZATION_CATALOG_VERSION, authorizationOperation } from "../src/authorization/catalog.js";
import { serializeAuthorizationDocument, validateAuthorizationDocument } from "../src/authorization/schema.js";
import { authorize } from "../src/authorization/evaluate.js";
import { verifiedActor } from "../src/authorization/actors.js";
import { DEFAULT_VAULT_ID } from "../src/oauth/primitives.js";

const READ = ["obsidian.read"];
const WRITE = ["obsidian.read", "obsidian.write"];
const FILES = ["obsidian.read", "obsidian.files"];
const READ_FILES = ["obsidian.read", "obsidian.files"];
const PRIMARY = DEFAULT_VAULT_ID;
const OTHER = "example-vault";

function userRecord(id, scopes, vaults = [PRIMARY], extra = {}) {
  return {
    id,
    username: `user-${id}`,
    displayName: `User ${id}`,
    allowedScopes: scopes,
    allowedVaults: vaults,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    disabledAt: null,
    ...extra,
  };
}

function keyRecord(id, scopes, vaults = [PRIMARY], extra = {}) {
  return {
    id,
    label: `key-${id}`,
    allowedScopes: scopes,
    allowedVaults: vaults,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function tokenRecord(id, overrides = {}) {
  return {
    id,
    clientId: "client-1",
    userId: "user-1",
    generation: 0,
    scopes: READ,
    allowedVaults: [PRIMARY],
    resource: "https://mcp.example.test",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: Date.parse("2026-06-01T00:00:00.000Z"),
    lastUsedAt: null,
    ...overrides,
  };
}

// A provider snapshot in the shape `persistence-methods.load()` leaves behind:
// maps keyed the way the store keys them, records already normalized.
function snapshot({ users = {}, keys = {}, accessTokens = {}, refreshTokens = {}, clients = {}, clientUsage = {}, configuredApiKeyUsage = {}, ...rest } = {}) {
  return {
    oauthUsers: users,
    apiKeys: keys,
    accessTokens,
    refreshTokens,
    clients,
    clientUsage,
    configuredApiKeyUsage,
    oauthUsersInitialized: true,
    ...rest,
  };
}

function importOrThrow(input) {
  return importLegacyAuthorization(input);
}

function grantFor(document, subjectId, vaultId) {
  const subject = document.subjects[subjectId];
  assert.notEqual(subject, undefined, `missing subject ${subjectId}`);
  assert.notEqual(subject.grants, null, `${subjectId} must not be a null ceiling`);
  const row = subject.grants.find((grant) => grant.target.kind === "vault" && grant.target.vaultId === vaultId);
  return row ? row.capabilities : null;
}

function instanceCapabilities(document, subjectId) {
  const row = document.subjects[subjectId].grants.find((grant) => grant.target.kind === "instance");
  return row ? row.capabilities : [];
}

function envelopeFor(result, tokenId) {
  const envelope = result.credentialEnvelopes[tokenId];
  assert.notEqual(envelope, undefined, `missing envelope ${tokenId}`);
  return envelope;
}

function envelopeCapabilities(envelope, vaultId) {
  const row = envelope.authorization.grantCeiling.find((grant) => grant.target.kind === "vault" && grant.target.vaultId === vaultId);
  return row ? row.capabilities : null;
}

test("import_token_ceiling_uses_its_own_vault_snapshot_not_current_account", () => {
  const result = importOrThrow({
    providerSnapshot: snapshot({
      users: { "user-1": userRecord("user-1", WRITE, [PRIMARY, OTHER]) },
      accessTokens: { "digest-access-1": tokenRecord("token-1", { scopes: WRITE, allowedVaults: [PRIMARY] }) },
    }),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });

  // The account now holds two Vaults and may write both.
  assert.equal(grantFor(result.document, "oauth-user:user-1", OTHER).includes("write_note"), true);

  // The token was issued with one Vault: it can write that one and nothing else.
  const envelope = envelopeFor(result, "token-1");
  assert.equal(envelopeCapabilities(envelope, PRIMARY).includes("write_note"), true);
  const importedTokenCanWriteExample = envelopeCapabilities(envelope, OTHER) !== null;
  assert.equal(importedTokenCanWriteExample, false);
  assert.equal(JSON.stringify(envelope.authorization.grantCeiling).includes(OTHER), false);
  assert.deepEqual(envelope.subjectId, "oauth-user:user-1");
  assert.deepEqual(envelope.allowedVaults, [PRIMARY]);
});

test("import_account_and_key_read_presets_include_the_three_instance_metadata_capabilities", () => {
  const result = importOrThrow({
    providerSnapshot: snapshot({
      users: { "user-1": userRecord("user-1", READ) },
      keys: { "digest-key-1": keyRecord("key-1", WRITE) },
    }),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });

  const accountInstance = instanceCapabilities(result.document, "oauth-user:user-1");
  for (const capability of ["agent_bootstrap", "server_info", "agent_memory_policy_read"]) {
    assert.equal(accountInstance.includes(capability), true, `account preset is missing ${capability}`);
  }
  // No write scope, so no Vault creation.
  assert.equal(accountInstance.includes("vault_create"), false);

  const keyInstance = instanceCapabilities(result.document, "api-key:key-1");
  for (const capability of ["agent_bootstrap", "server_info", "agent_memory_policy_read", "vault_create"]) {
    assert.equal(keyInstance.includes(capability), true, `key preset is missing ${capability}`);
  }
  assert.equal(grantFor(result.document, "api-key:key-1", PRIMARY).includes("write_note"), true);
});

test("import_grants_resource_capabilities_to_the_primary_vault_only", () => {
  const withPrimary = importOrThrow({
    providerSnapshot: snapshot({ users: { "user-1": userRecord("user-1", READ, [OTHER, PRIMARY]) } }),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });
  const primaryRow = grantFor(withPrimary.document, "oauth-user:user-1", PRIMARY);
  const otherRow = grantFor(withPrimary.document, "oauth-user:user-1", OTHER);
  for (const capability of ["vault_index_read", "vault_tags_read", "vault_graph_read"]) {
    assert.equal(primaryRow.includes(capability), true, `primary row is missing ${capability}`);
    assert.equal(otherRow === null || !otherRow.includes(capability), true, `non-primary row must not carry ${capability}`);
  }
  assert.equal(otherRow.includes("get_note"), true, "a non-primary Vault still reads its notes");

  const withoutPrimary = importOrThrow({
    providerSnapshot: snapshot({ users: { "user-2": userRecord("user-2", WRITE, [OTHER]) } }),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });
  const row = grantFor(withoutPrimary.document, "oauth-user:user-2", OTHER);
  for (const capability of ["vault_index_read", "vault_tags_read", "vault_graph_read"]) {
    assert.equal(row.includes(capability), false, `${capability} must not appear when the old allowlist has no primary Vault`);
  }
  assert.equal(JSON.stringify(withoutPrimary.document).includes("vault_index_read"), false);
});

test("import_client_without_authorization_fields_is_a_null_ceiling", () => {
  const result = importOrThrow({
    providerSnapshot: snapshot({
      clients: {
        "client-plain": { client_id: "client-plain", redirect_uris: ["http://127.0.0.1/callback"], client_id_issued_at: 1 },
        "client-scoped": {
          client_id: "client-scoped",
          redirect_uris: ["https://example.test/callback"],
          allowedScopes: READ,
          allowedVaults: [PRIMARY],
        },
      },
    }),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });

  assert.equal(result.document.subjects["oauth-client:client-plain"].grants, null);
  assert.equal(result.document.subjects["oauth-client:client-plain"].credentialEpoch, 0);
  const scoped = result.document.subjects["oauth-client:client-scoped"].grants;
  assert.equal(Array.isArray(scoped), true);
  assert.equal(scoped[0].capabilities.includes("get_note"), true);
  // A client never inherits an account's rights on its own.
  assert.equal(JSON.stringify(result.document.subjects["oauth-client:client-scoped"]).includes("write_note"), false);
});

test("import_refuses_an_account_or_key_without_a_verified_snapshot", () => {
  const refuse = (input, code) => {
    assert.throws(
      () => importLegacyAuthorization(input),
      (error) => {
        assert.equal(error.code, code, error.message);
        return true;
      },
    );
  };

  refuse({ providerSnapshot: null, policyDocument: null, catalogVersion: AUTHORIZATION_CATALOG_VERSION }, LEGACY_IMPORT_CODES.SNAPSHOT_UNVERIFIED);
  refuse({ policyDocument: null, catalogVersion: AUTHORIZATION_CATALOG_VERSION }, LEGACY_IMPORT_CODES.SNAPSHOT_UNVERIFIED);
  refuse({
    providerSnapshot: { oauthUsers: {}, clients: {} },
    policyDocument: null,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  }, LEGACY_IMPORT_CODES.SNAPSHOT_UNVERIFIED);
  refuse({
    providerSnapshot: { oauthUsers: {}, apiKeys: {}, accessTokens: {}, refreshTokens: {}, clients: {} },
    policyDocument: null,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  }, LEGACY_IMPORT_CODES.SNAPSHOT_UNVERIFIED);
  // A record that was never normalized by the provider is not a verified snapshot.
  refuse({
    providerSnapshot: snapshot({ users: { "user-1": { id: "user-1", username: "user-1" } } }),
    policyDocument: null,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  }, LEGACY_IMPORT_CODES.SNAPSHOT_UNVERIFIED);
  refuse({
    providerSnapshot: snapshot({ keys: { "digest-key-1": { id: "key-1", label: "k" } } }),
    policyDocument: null,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  }, LEGACY_IMPORT_CODES.SNAPSHOT_UNVERIFIED);
});

test("import_keeps_expired_revoked_generation_and_ttl_values", () => {
  const expiresAt = Date.parse("2026-02-01T00:00:00.000Z");
  const revokedAt = "2026-01-15T00:00:00.000Z";
  const result = importOrThrow({
    providerSnapshot: snapshot({
      users: { "user-1": userRecord("user-1", READ) },
      accessTokens: {
        "digest-access-1": tokenRecord("token-expired", { expiresAt, revokedAt, generation: 3 }),
      },
      refreshTokens: {
        "digest-refresh-1": tokenRecord("refresh-1", { expiresAt, generation: 3 }),
      },
    }),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });

  const expired = envelopeFor(result, "token-expired");
  // §7 credential envelope: version, catalogVersion, subjectEpochs, grantCeiling,
  // protocolScopes — the frozen consent, not a second authority.
  // §7 nests the frozen consent under `authorization`, as Task 23 will write it.
  assert.deepEqual(Object.keys(expired.authorization).sort(), ["catalogVersion", "grantCeiling", "protocolScopes", "subjectEpochs", "version"]);
  assert.equal(expired.authorization.version, 1);
  assert.equal(expired.authorization.catalogVersion, AUTHORIZATION_CATALOG_VERSION);
  assert.deepEqual(expired.authorization.subjectEpochs, { "oauth-user:user-1": 0 });
  assert.deepEqual(expired.authorization.protocolScopes, ["obsidian.read"]);
  assert.equal(Array.isArray(expired.authorization.grantCeiling), true);
  assert.equal(expired.expiresAt, expiresAt, "the TTL value is kept verbatim");
  assert.equal(expired.revokedAt, revokedAt);
  assert.equal(expired.generation, 3);
  assert.equal(expired.kind, "access-token");
  assert.equal(expired.createdAt, "2026-01-01T00:00:00.000Z");

  const refresh = envelopeFor(result, "refresh-1");
  assert.equal(refresh.kind, "refresh-token");
  assert.equal(refresh.generation, 3);
  assert.equal(refresh.revokedAt, null);
});

test("import_read_only_files_scope_keeps_delete_file_without_claiming_the_read_only_preset", () => {
  const result = importOrThrow({
    providerSnapshot: snapshot({
      users: {
        "user-files": userRecord("user-files", READ_FILES),
        "user-read": userRecord("user-read", READ),
      },
    }),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });

  const filesRow = grantFor(result.document, "oauth-user:user-files", PRIMARY);
  // The baseline lets this account delete a file, so the import keeps that power.
  assert.equal(filesRow.includes("delete_file"), true);
  assert.equal(authorizationOperation("delete_file").contentEffect, "mutate");
  // It is not write, and it is not the new read-only preset either.
  assert.equal(filesRow.includes("write_note"), false);

  const entry = result.report.subjects.find((subject) => subject.subjectId === "oauth-user:user-files");
  assert.deepEqual(entry.legacyReadOnlyMutations, ["delete_file"]);

  const readEntry = result.report.subjects.find((subject) => subject.subjectId === "oauth-user:user-read");
  assert.deepEqual(readEntry.legacyReadOnlyMutations, []);
  assert.equal(grantFor(result.document, "oauth-user:user-read", PRIMARY).includes("delete_file"), false);
  // Everything the plain read preset grants is a read.
  for (const capability of grantFor(result.document, "oauth-user:user-read", PRIMARY)) {
    assert.equal(authorizationOperation(capability).contentEffect, "read", capability);
  }
});

test("import_converts_a_legacy_policy_document_and_holds_on_a_broken_one", () => {
  const base = {
    providerSnapshot: snapshot({ users: { "user-1": userRecord("user-1", READ) } }),
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  };
  // An absent or empty policy document converts nothing (Task 6 owns conversion).
  for (const policyDocument of [undefined, null, { schemaVersion: 1, revision: 0, policies: [] }]) {
    const result = importLegacyAuthorization({ ...base, policyDocument });
    assert.deepEqual(result.document.constraints, []);
    assert.deepEqual(result.report.policyIdMap, {});
    assert.equal(result.report.counts.constraints, 0);
  }

  // One legacy policy becomes one constraint and is reported by its own id.
  const policy = {
    id: "3f1e6b2c-9a4d-4a53-9d1f-0c2b7e5a1c11",
    label: "legacy window",
    enabled: true,
    subjects: ["oauth-user:user-1"],
    mode: "suspend",
    capabilities: ["surface:web", "tool:write_note"],
    timezone: "UTC",
    weekly: { mon: [["09:00", "18:00"]] },
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
  const converted = importLegacyAuthorization({ ...base, policyDocument: { schemaVersion: 1, revision: 1, policies: [policy] } });
  assert.equal(converted.document.constraints.length, 1);
  assert.equal(converted.document.constraints[0].id, policy.id);
  assert.deepEqual(converted.report.policyIdMap[policy.id], { "surface:web": [0], "tool:write_note": [1] });

  // A broken policy document (even dormant) blocks the whole import.
  assert.throws(
    () => importLegacyAuthorization({
      ...base,
      policyDocument: { schemaVersion: 1, revision: 1, policies: [{ ...policy, enabled: false, capabilities: ["tool:not_a_real_tool"] }] },
    }),
    (error) => {
      assert.equal(error.code, "authorization_migration_hold");
      return true;
    },
  );
});

test("import_is_byte_identical_for_equal_input_and_produces_a_valid_document", () => {
  const build = () => ({
    providerSnapshot: snapshot({
      users: { "user-2": userRecord("user-2", WRITE, [PRIMARY, OTHER]), "user-1": userRecord("user-1", READ) },
      keys: { "digest-key-1": keyRecord("key-1", READ, [OTHER, PRIMARY]) },
      accessTokens: { "digest-access-1": tokenRecord("token-1", { scopes: WRITE, allowedVaults: [PRIMARY, OTHER] }) },
      refreshTokens: {},
      clients: { "client-plain": { client_id: "client-plain", redirect_uris: ["http://127.0.0.1/cb"] } },
      configuredApiKeyUsage: { lastUsedAt: "2026-01-05T00:00:00.000Z" },
    }),
    policyDocument: null,
    timeConstraintsEnabled: true,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });

  const first = importOrThrow(build());
  const second = importOrThrow(build());
  assert.equal(JSON.stringify(first), JSON.stringify(second), "equal input must give a byte-identical result");
  assert.equal(serializeAuthorizationDocument(first.document), serializeAuthorizationDocument(second.document));
  assert.deepEqual(Object.keys(first.document.subjects), ["api-key:key-1", "oauth-client:client-plain", "oauth-user:user-1", "oauth-user:user-2"]);
  assert.doesNotThrow(() => validateAuthorizationDocument(first.document));
  assert.equal(first.document.schemaVersion, 1);
  assert.equal(first.document.catalogVersion, AUTHORIZATION_CATALOG_VERSION);
  assert.equal(first.document.revision, 1);
  assert.equal(first.document.timeConstraintsEnabled, true);
  // No `API_KEY` in this process, so the environment key is not configured and is
  // reported (not silently skipped).
  assert.equal(Object.hasOwn(first.document.subjects, "api-key:configured-env"), false);
  assert.deepEqual(first.report.skipped, []);
  assert.equal(first.report.subjects.find((entry) => entry.environment).configured, false);
});

test("import_keeps_the_configured_environment_key_as_a_subject", () => {
  const build = (environmentKey) => importLegacyAuthorization({
    providerSnapshot: snapshot({}),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    environmentKey,
  });

  const configured = build({ configured: true, vaults: [PRIMARY, OTHER] });
  const subject = configured.document.subjects["api-key:configured-env"];
  assert.notEqual(subject, undefined, "the environment key must be a real subject, not a skip");
  const row = (vaultId) => subject.grants.find((grant) => grant.target.kind === "vault" && grant.target.vaultId === vaultId).capabilities;
  // §5.2: every legacy tool capability on the primary Vault plus API_KEY_VAULTS.
  for (const capability of ["get_note", "write_note", "delete_file", "git_push", "manage_publish"]) {
    assert.equal(row(PRIMARY).includes(capability), true, capability);
    assert.equal(row(OTHER).includes(capability), true, capability);
  }
  const instance = subject.grants.find((grant) => grant.target.kind === "instance").capabilities;
  for (const capability of ["agent_bootstrap", "server_info", "agent_memory_policy_read"]) {
    assert.equal(instance.includes(capability), true, capability);
  }
  // §5.2 compiles the legacy TOOL capabilities only: Vault creation and the Vault
  // list are Web session routes, so the key must not receive them.
  assert.equal(instance.includes("vault_create"), false);
  assert.equal(instance.includes("vault_list_read"), false);
  assert.equal(JSON.stringify(configured.document.subjects["api-key:configured-env"]).includes("vault_create"), false);
  const entry = configured.report.subjects.find((item) => item.environment);
  assert.equal(entry.configured, true);
  assert.deepEqual(configured.report.skipped, []);
  // The imported document authorizes the key for real: no deny at P2.
  const decision = authorize(
    {
      actor: verifiedActor("environment-key", {
        subjectIds: ["api-key:configured-env"],
        credentialId: "configured-env",
        credentialEpochs: { "api-key:configured-env": 0 },
        grantCeiling: null,
        audience: null,
        expiresAt: null,
        revoked: false,
        transferGeneration: null,
        proof: null,
      }),
      capability: "get_note",
      target: { kind: "vault", vaultId: OTHER },
      surface: "mcp",
      nowMs: 1_700_000_000_000,
    },
    {
      status: "ready",
      document: configured.document,
      identities: { "api-key:configured-env": { credentialEpoch: 0 } },
      vaultAdmissions: { [PRIMARY]: { admitted: true }, [OTHER]: { admitted: true } },
      publication: null,
      deployment: { readOnly: false },
    },
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "allowed");

  const absent = build({ configured: false, vaults: [PRIMARY] });
  assert.equal(Object.hasOwn(absent.document.subjects, "api-key:configured-env"), false);
  assert.equal(absent.report.subjects.find((item) => item.environment).configured, false);
});

test("import_keeps_a_legacy_token_without_a_user_id_on_its_own_ceiling", () => {
  // §5.2 row "历史无 userId 的 OAuth token": keep its own migrated ceiling, intersect
  // it with the client ceiling, and never borrow the current account's rights.
  const result = importLegacyAuthorization({
    providerSnapshot: snapshot({
      users: { "user-1": userRecord("user-1", WRITE, [PRIMARY, OTHER]) },
      clients: { "client-1": { client_id: "client-1", redirect_uris: ["https://example.test/cb"] } },
      accessTokens: {
        "digest-legacy": tokenRecord("token-legacy", { userId: null, scopes: READ, allowedVaults: [PRIMARY] }),
      },
    }),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });

  const envelope = envelopeFor(result, "token-legacy");
  assert.equal(envelope.userId, null);
  assert.equal(envelope.subjectId, null, "a token with no user must not name one");
  assert.deepEqual(envelope.authorization.subjectEpochs, {});
  assert.deepEqual(envelope.authorization.protocolScopes, READ);
  assert.deepEqual(envelope.authorization.grantCeiling.map((grant) => grant.target.kind === "vault" ? grant.target.vaultId : "instance").sort(), [PRIMARY, "instance"].sort());

  // The client subject is neutral (no authorization fields), so the token ceiling
  // decides: the primary Vault yes, the account's second Vault no.
  const client = result.document.subjects["oauth-client:client-1"];
  assert.equal(client.grants, null);
  const decisionFor = (vaultId) => authorize(
    {
      actor: verifiedActor("oauth", {
        subjectIds: ["oauth-client:client-1"],
        credentialId: "token-legacy",
        credentialEpochs: { "oauth-client:client-1": 0 },
        grantCeiling: envelope.authorization.grantCeiling,
        audience: null,
        expiresAt: null,
        revoked: false,
        transferGeneration: 0,
        proof: null,
      }),
      capability: "get_note",
      target: { kind: "vault", vaultId },
      surface: "mcp",
      nowMs: 1_700_000_000_000,
    },
    {
      status: "ready",
      document: result.document,
      identities: { "oauth-client:client-1": { credentialEpoch: 0 } },
      vaultAdmissions: { [PRIMARY]: { admitted: true }, [OTHER]: { admitted: true } },
      publication: null,
      deployment: { readOnly: false },
    },
  ).allowed;
  assert.equal(decisionFor(PRIMARY), true);
  assert.equal(decisionFor(OTHER), false, "a token with no userId must not inherit the account's Vaults");
});

test("import_refuses_a_managed_key_that_takes_the_environment_key_id", () => {
  assert.throws(
    () => importLegacyAuthorization({
      providerSnapshot: snapshot({ keys: { "digest-key-1": keyRecord("configured-env", READ) } }),
      policyDocument: null,
      timeConstraintsEnabled: false,
      catalogVersion: AUTHORIZATION_CATALOG_VERSION,
      environmentKey: { configured: true, vaults: [PRIMARY] },
    }),
    (error) => {
      assert.equal(error.code, "authorization_import_snapshot_unverified");
      return true;
    },
  );
});

test("import_refuses_a_catalog_version_that_is_not_the_current_one", () => {
  const base = { providerSnapshot: snapshot({ users: { "user-1": userRecord("user-1", READ) } }), policyDocument: null };
  assert.throws(
    () => importLegacyAuthorization({ ...base, catalogVersion: AUTHORIZATION_CATALOG_VERSION + 1 }),
    (error) => error.code === LEGACY_IMPORT_CODES.STATE_UNAVAILABLE,
  );
  assert.throws(
    () => importLegacyAuthorization({ ...base, catalogVersion: AUTHORIZATION_CATALOG_VERSION - 1 }),
    (error) => error.code === LEGACY_IMPORT_CODES.CATALOG_MISMATCH,
  );
  assert.doesNotThrow(() => importLegacyAuthorization({ ...base, catalogVersion: AUTHORIZATION_CATALOG_VERSION }));
});

test("import_never_invents_rights_for_a_token_whose_account_is_gone", () => {
  const result = importOrThrow({
    providerSnapshot: snapshot({
      accessTokens: { "digest-access-1": tokenRecord("token-orphan", { userId: "deleted-user" }) },
    }),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });
  const envelope = envelopeFor(result, "token-orphan");
  assert.equal(envelope.subjectId, "oauth-user:deleted-user");
  assert.equal(Object.hasOwn(result.document.subjects, "oauth-user:deleted-user"), false);
});

test("import_does_not_turn_a_legacy_null_vault_list_into_the_current_account_set", () => {
  // `load()` already normalizes a token's missing Vault list to its account's set
  // or the primary Vault; the importer must use what the record says and nothing else.
  const result = importOrThrow({
    providerSnapshot: snapshot({
      users: { "user-1": userRecord("user-1", WRITE, [PRIMARY, OTHER]) },
      accessTokens: { "digest-access-1": tokenRecord("token-1", { scopes: WRITE, allowedVaults: [OTHER] }) },
    }),
    policyDocument: null,
    timeConstraintsEnabled: false,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
  });
  const envelope = envelopeFor(result, "token-1");
  const vaultRows = envelope.authorization.grantCeiling.filter((grant) => grant.target.kind === "vault");
  assert.deepEqual(vaultRows.map((grant) => grant.target.vaultId), [OTHER]);
  assert.equal(envelopeCapabilities(envelope, PRIMARY), null);
  // The instance metadata row is not a Vault right and never widens one.
  assert.equal(envelope.authorization.grantCeiling.some((grant) => grant.target.kind === "instance"), true);
  assert.equal(envelopeCapabilities(envelope, OTHER).includes("get_note"), true);
});
