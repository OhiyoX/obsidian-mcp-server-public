// P1 / Task 5 — lossless import of legacy accounts, keys, clients and tokens.
//
// Contract: design §5.3 (legacy defaults), §4.1 (grantable set, read presets,
// resource capabilities, instance metadata) and §5.2 (a credential keeps the
// ceiling it was issued with). Input is one *verified, normalized* provider
// snapshot — the shape `oauth/persistence-methods.load()` leaves behind. The
// importer reads it once, writes no file, keeps no legacy fallback and refuses
// the whole import when the snapshot cannot be trusted.
//
// Two expansions run here and they must never be confused:
//   * a subject (account, API key, or a client that carried authorization
//     fields) gets the capabilities whose protocol scopes the old record fully
//     contains: `allowedScopes × allowedVaults`;
//   * a token gets its OWN frozen ceiling: its own `scopes × allowedVaults`,
//     never the account's current set.
// The legacy temporal policy document is converted by `legacy-policy-import.js`
// (OR-preserving, one policy = one constraint); a document that cannot be
// validated raises a migration HOLD, never a silent drop.

import { isValidSubject } from "../access-policy/subjects.js";
import { DEFAULT_VAULT_ID } from "../oauth/primitives.js";
import { normalizeGeneration } from "../oauth/authorization-transfer-runtime.js";
import { isValidVaultId } from "../vault-runtime/descriptor.js";
import { configuredApiKeyVaults } from "../config.js";
import { MCP_SCOPES } from "../scopes.js";
import { AUTHORIZATION_CATALOG_VERSION, authorizationOperation, catalogOperationIds } from "./catalog.js";
import { importLegacyConstraints } from "./legacy-policy-import.js";
import { AUTHORIZATION_CODES, validateAuthorizationDocument } from "./schema.js";

export const LEGACY_IMPORT_CODES = Object.freeze({
  // The snapshot, or one record in it, is not the verified normalized provider state.
  SNAPSHOT_UNVERIFIED: "authorization_import_snapshot_unverified",
  // The document is always written in the current catalog vocabulary.
  CATALOG_MISMATCH: "authorization_import_catalog_mismatch",
  STATE_UNAVAILABLE: AUTHORIZATION_CODES.STATE_UNAVAILABLE,
});

const { SNAPSHOT_UNVERIFIED, CATALOG_MISMATCH, STATE_UNAVAILABLE } = LEGACY_IMPORT_CODES;

// The three primary-only resource reads (§4.1). A token or subject only gets them
// when its own old allowlist contains the primary Vault.
const RESOURCE_READ_CAPABILITIES = new Set(["vault_index_read", "vault_tags_read", "vault_graph_read"]);
const INSTANCE_METADATA_CAPABILITIES = Object.freeze(["agent_bootstrap", "server_info", "agent_memory_policy_read"]);
const SCOPE_SET = new Set(MCP_SCOPES);

function fail(code, message) {
  const error = new Error(message);
  error.name = "LegacyImportError";
  error.code = code;
  throw error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The protocol-scope expansion: an operation is in when its scopes are all held. */
function expandByScopes(scopes) {
  const vault = [];
  const instance = [];
  const primaryOnly = [];
  for (const id of catalogOperationIds) {
    const operation = authorizationOperation(id);
    if (!operation.grantable) continue;
    if (!operation.oauthScopes.every((scope) => scopes.has(scope))) continue;
    if (operation.targetKind === "instance") instance.push(id);
    else if (operation.targetKind === "vault") (RESOURCE_READ_CAPABILITIES.has(id) ? primaryOnly : vault).push(id);
  }
  return { vault, instance, primaryOnly };
}

function readScopes(raw, label) {
  if (!Array.isArray(raw) || raw.length === 0) fail(SNAPSHOT_UNVERIFIED, `${label} has no normalized allowedScopes`);
  const scopes = new Set();
  for (const scope of raw) {
    if (typeof scope !== "string" || !SCOPE_SET.has(scope)) fail(SNAPSHOT_UNVERIFIED, `${label} carries an unsupported scope`);
    scopes.add(scope);
  }
  return scopes;
}

function readVaults(raw, label) {
  if (!Array.isArray(raw) || raw.length === 0) fail(SNAPSHOT_UNVERIFIED, `${label} has no normalized allowedVaults`);
  for (const vaultId of raw) {
    if (!isValidVaultId(vaultId)) fail(SNAPSHOT_UNVERIFIED, `${label} carries an invalid Vault id`);
  }
  return [...new Set(raw)].sort();
}

/** Grant rows for one old `scopes × vaults` pair. */
function grantsFor({ scopes, vaults, primaryVaultId, exclude = null }) {
  const expanded = expandByScopes(scopes);
  const keep = (capability) => exclude === null || !exclude.has(capability);
  const grants = [];
  for (const vaultId of vaults) {
    const capabilities = [...expanded.vault.filter(keep), ...(vaultId === primaryVaultId ? expanded.primaryOnly.filter(keep) : [])];
    if (capabilities.length === 0) continue;
    grants.push({ target: { kind: "vault", vaultId }, capabilities });
  }
  const instance = expanded.instance.filter(keep);
  if (instance.length > 0) {
    grants.push({ target: { kind: "instance" }, capabilities: instance });
  }
  return grants;
}

function capabilitiesOf(grants) {
  const seen = new Set();
  for (const grant of grants) for (const capability of grant.capabilities) seen.add(capability);
  return [...seen];
}

// An old read-only account could still mutate through a capability whose legacy
// Scope was read+files (`delete_file`). Behaviour is preserved, and the report
// says so, so the result is never presented as the new read-only preset.
function legacyReadOnlyMutations(grants, scopes) {
  if (scopes.has("obsidian.write")) return [];
  return capabilitiesOf(grants).filter((capability) => authorizationOperation(capability)?.contentEffect === "mutate").sort();
}

function subjectIdFor(kind, id) {
  const subjectId = `${kind}:${id}`;
  if (!isValidSubject(subjectId)) fail(SNAPSHOT_UNVERIFIED, `invalid subject id for ${kind}`);
  return subjectId;
}

function requireRecord(record, label) {
  if (!isRecord(record)) fail(SNAPSHOT_UNVERIFIED, `${label} is not a record`);
  return record;
}

function importClients(clients, primaryVaultId) {
  const subjects = [];
  const report = [];
  for (const [clientId, raw] of Object.entries(requireRecord(clients, "clients"))) {
    requireRecord(raw, `client ${clientId}`);
    if (raw.client_id !== undefined && raw.client_id !== clientId) fail(SNAPSHOT_UNVERIFIED, `client ${clientId} does not match its record`);
    const subjectId = subjectIdFor("oauth-client", clientId);
    const hasScopes = raw.allowedScopes !== undefined;
    const hasVaults = raw.allowedVaults !== undefined;
    if (!hasScopes && !hasVaults) {
      // §5.1: a client with no authorization fields does not tighten anything.
      subjects.push([subjectId, { credentialEpoch: 0, grants: null }]);
      report.push({ subjectId, kind: "oauth-client", scopes: [], vaults: [], grants: [], legacyReadOnlyMutations: [] });
      continue;
    }
    if (!hasScopes || !hasVaults) fail(SNAPSHOT_UNVERIFIED, `client ${clientId} has only half of its authorization fields`);
    const scopes = readScopes(raw.allowedScopes, `client ${clientId}`);
    const vaults = readVaults(raw.allowedVaults, `client ${clientId}`);
    const grants = grantsFor({ scopes, vaults, primaryVaultId });
    subjects.push([subjectId, { credentialEpoch: 0, grants }]);
    report.push({
      subjectId,
      kind: "oauth-client",
      scopes: [...scopes].sort(),
      vaults,
      grants,
      legacyReadOnlyMutations: legacyReadOnlyMutations(grants, scopes),
    });
  }
  return { subjects, report };
}

function importAccounts(users, primaryVaultId) {
  const subjects = [];
  const report = [];
  const epochs = {};
  for (const [userId, raw] of Object.entries(requireRecord(users, "oauthUsers"))) {
    requireRecord(raw, `account ${userId}`);
    if (raw.id !== userId) fail(SNAPSHOT_UNVERIFIED, `account ${userId} does not match its record`);
    const subjectId = subjectIdFor("oauth-user", userId);
    const scopes = readScopes(raw.allowedScopes, `account ${userId}`);
    const vaults = readVaults(raw.allowedVaults, `account ${userId}`);
    const grants = grantsFor({ scopes, vaults, primaryVaultId });
    subjects.push([subjectId, { credentialEpoch: 0, grants }]);
    report.push({
      subjectId,
      kind: "oauth-user",
      scopes: [...scopes].sort(),
      vaults,
      grants,
      legacyReadOnlyMutations: legacyReadOnlyMutations(grants, scopes),
    });
    epochs[subjectId] = 0;
  }
  return { subjects, report, epochs };
}

function importApiKeys(apiKeys, primaryVaultId) {
  const subjects = [];
  const report = [];
  for (const [digestKey, raw] of Object.entries(requireRecord(apiKeys, "apiKeys"))) {
    requireRecord(raw, `api key ${digestKey}`);
    // The store keys a key by a digest of its secret; the subject uses the record id.
    if (typeof raw.id !== "string" || raw.id.length === 0) fail(SNAPSHOT_UNVERIFIED, "an API key record has no id");
    // The environment key owns `api-key:configured-env`; a managed key must not
    // silently collide with it and report two subjects under one id.
    if (raw.id === "configured-env") fail(SNAPSHOT_UNVERIFIED, "a managed API key must not reuse the environment key id");
    const subjectId = subjectIdFor("api-key", raw.id);
    const scopes = readScopes(raw.allowedScopes, `api key ${raw.id}`);
    const vaults = readVaults(raw.allowedVaults, `api key ${raw.id}`);
    const grants = grantsFor({ scopes, vaults, primaryVaultId });
    subjects.push([subjectId, { credentialEpoch: 0, grants }]);
    report.push({
      subjectId,
      kind: "api-key",
      scopes: [...scopes].sort(),
      vaults,
      grants,
      legacyReadOnlyMutations: legacyReadOnlyMutations(grants, scopes),
    });
  }
  return { subjects, report };
}

function importTokens(records, kind, primaryVaultId, catalogVersion, into) {
  for (const [tokenKey, raw] of Object.entries(requireRecord(records, kind))) {
    requireRecord(raw, `${kind} ${tokenKey}`);
    if (typeof raw.id !== "string" || raw.id.length === 0) fail(SNAPSHOT_UNVERIFIED, `a ${kind} record has no id`);
    if (Object.hasOwn(into, raw.id)) fail(SNAPSHOT_UNVERIFIED, `duplicate credential id in ${kind}`);
    const scopes = readScopes(raw.scopes, `${kind} ${raw.id}`);
    // The token keeps the Vault set it was issued with; the account is not consulted.
    const vaults = readVaults(raw.allowedVaults, `${kind} ${raw.id}`);
    const userId = typeof raw.userId === "string" && raw.userId.length > 0 ? raw.userId : null;
    const clientId = typeof raw.clientId === "string" ? raw.clientId : null;
    into[raw.id] = {
      id: raw.id,
      kind: kind === "accessTokens" ? "access-token" : "refresh-token",
      clientId,
      userId,
      // §5.2: a historical token with no userId keeps its own frozen ceiling and is
      // intersected with the client ceiling; it borrows nothing from an account.
      subjectId: userId === null ? null : subjectIdFor("oauth-user", userId),
      allowedVaults: vaults,
      generation: normalizeGeneration(raw.generation),
      resource: typeof raw.resource === "string" ? raw.resource : null,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
      // TTL values are kept verbatim (the legacy store records epoch milliseconds).
      expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : null,
      revokedAt: typeof raw.revokedAt === "string" ? raw.revokedAt : null,
      // §7 credential envelope: the frozen consent nests as `authorization`, not as
      // flat fields, so Task 23 writes this shape instead of migrating it.
      authorization: {
        version: 1,
        catalogVersion,
        subjectEpochs: userId === null ? {} : { [subjectIdFor("oauth-user", userId)]: 0 },
        grantCeiling: grantsFor({ scopes, vaults, primaryVaultId }),
        protocolScopes: [...scopes].sort(),
      },
    };
  }
}

/**
 * `importLegacyAuthorization({providerSnapshot, policyDocument, timeConstraintsEnabled, catalogVersion})`
 * -> `{document, credentialEnvelopes, webEpochs, report}`.
 */
const ENVIRONMENT_KEY_SUBJECT = "api-key:configured-env";
const ENVIRONMENT_KEY_EXCLUDED = new Set(["vault_create", "vault_list_read"]);

/**
 * The configured environment key (§5.2): the deployment's own key, compiled from
 * `API_KEY` presence plus `DEFAULT_VAULT_ID` and `API_KEY_VAULTS`. It keeps every
 * legacy tool capability on those Vaults, because that is what it holds today; a
 * config change still needs a restart (§5.1 keeps it non-editable). It is imported
 * as a subject, never skipped: a skipped key denies every request at P2.
 */
function importEnvironmentKey({ environmentKey, primaryVaultId }) {
  const configured = environmentKey === null || environmentKey === undefined
    ? Boolean(process.env.API_KEY)
    : environmentKey.configured === true;
  const report = {
    subjectId: ENVIRONMENT_KEY_SUBJECT,
    kind: "api-key",
    scopes: [],
    vaults: [],
    grants: [],
    legacyReadOnlyMutations: [],
    environment: true,
    configured,
  };
  if (!configured) return { subjects: [], report };
  const declaredVaults = environmentKey?.vaults ?? [...new Set([primaryVaultId, ...(configuredApiKeyVaults() ?? [])])];
  const scopes = new Set(MCP_SCOPES);
  const vaults = readVaults(declaredVaults, "the configured environment key");
  // §5.2 compiles the legacy tool capabilities. Vault creation and the Vault list
  // are Web session routes, so the key must not receive them.
  const grants = grantsFor({ scopes, vaults, primaryVaultId, exclude: ENVIRONMENT_KEY_EXCLUDED });
  return {
    subjects: [[ENVIRONMENT_KEY_SUBJECT, { credentialEpoch: 0, grants }]],
    report: { ...report, scopes: [...scopes].sort(), vaults, grants, legacyReadOnlyMutations: legacyReadOnlyMutations(grants, scopes) },
  };
}

export function importLegacyAuthorization({
  providerSnapshot,
  policyDocument = null,
  timeConstraintsEnabled = false,
  catalogVersion = AUTHORIZATION_CATALOG_VERSION,
  primaryVaultId = DEFAULT_VAULT_ID,
  environmentKey = null,
} = {}) {
  if (!Number.isInteger(catalogVersion)) fail(CATALOG_MISMATCH, "catalogVersion must be the catalog version this build understands");
  if (catalogVersion > AUTHORIZATION_CATALOG_VERSION) fail(STATE_UNAVAILABLE, "catalog version is newer than this server");
  if (catalogVersion !== AUTHORIZATION_CATALOG_VERSION) fail(CATALOG_MISMATCH, "an import always writes the current catalog vocabulary");
  if (typeof timeConstraintsEnabled !== "boolean") fail(SNAPSHOT_UNVERIFIED, "timeConstraintsEnabled must be the recorded value");

  if (!isRecord(providerSnapshot)) fail(SNAPSHOT_UNVERIFIED, "no verified provider snapshot");
  for (const key of ["oauthUsers", "apiKeys", "accessTokens", "refreshTokens", "clients"]) {
    if (!isRecord(providerSnapshot[key])) fail(SNAPSHOT_UNVERIFIED, `the verified provider snapshot has no ${key}`);
  }
  if (providerSnapshot.oauthUsersInitialized !== true) fail(SNAPSHOT_UNVERIFIED, "the provider snapshot is not an initialized account state");
  if (!isValidVaultId(primaryVaultId)) fail(SNAPSHOT_UNVERIFIED, "primaryVaultId is not a valid Vault id");

  // Policy conversion comes first: a HOLD must prevent every other output.
  const policy = importLegacyConstraints({ policyDocument });

  const accounts = importAccounts(providerSnapshot.oauthUsers, primaryVaultId);
  const keys = importApiKeys(providerSnapshot.apiKeys, primaryVaultId);
  const clients = importClients(providerSnapshot.clients, primaryVaultId);
  const environment = importEnvironmentKey({ environmentKey, primaryVaultId });

  const envelopeRecords = {};
  importTokens(providerSnapshot.accessTokens, "accessTokens", primaryVaultId, catalogVersion, envelopeRecords);
  importTokens(providerSnapshot.refreshTokens, "refreshTokens", primaryVaultId, catalogVersion, envelopeRecords);
  const credentialEnvelopes = Object.fromEntries(Object.keys(envelopeRecords).sort().map((id) => [id, envelopeRecords[id]]));

  const pairs = [...accounts.subjects, ...keys.subjects, ...clients.subjects, ...environment.subjects]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const subjects = Object.fromEntries(pairs);
  // Nothing is skipped silently: a subject that is not imported is reported with a
  // reason, and the environment key is imported (it is a real credential today).
  const skipped = [];

  const document = validateAuthorizationDocument({
    schemaVersion: 1,
    catalogVersion,
    revision: 1,
    timeConstraintsEnabled,
    subjects,
    constraints: policy.constraints,
  });

  const subjectReports = [...accounts.report, ...keys.report, ...clients.report, environment.report]
    .sort((left, right) => (left.subjectId < right.subjectId ? -1 : left.subjectId > right.subjectId ? 1 : 0));
  const report = {
    catalogVersion,
    counts: {
      subjects: subjectReports.length,
      vaultGrants: subjectReports.reduce((total, entry) => total + entry.grants.filter((grant) => grant.target.kind === "vault").length, 0),
      instanceGrants: subjectReports.filter((entry) => entry.grants.some((grant) => grant.target.kind === "instance")).length,
      envelopes: Object.keys(credentialEnvelopes).length,
      constraints: policy.constraints.length,
      skipped: skipped.length,
    },
    subjects: subjectReports,
    skipped,
    // Old selector -> anyOf branch indices, for the migration report (Task 23/24).
    policyIdMap: policy.idMap,
    // Documented for the migration report only; it is not an authorization input.
    instanceMetadataCapabilities: [...INSTANCE_METADATA_CAPABILITIES],
  };

  const webEpochs = Object.fromEntries(Object.keys(accounts.epochs).sort().map((subjectId) => [subjectId, accounts.epochs[subjectId]]));
  return { document, credentialEnvelopes, webEpochs, report };
}
