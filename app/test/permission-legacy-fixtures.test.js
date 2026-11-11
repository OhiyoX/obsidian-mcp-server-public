// P0 / Task 1 — the two legacy fixtures, checked against the code that produces them.
//
// `docs/superpowers/plans/2026-11-05-permission-architecture.md` (Task 1) lists
// `legacy-state.json` and `legacy-policies.json`. P1's importer cannot be reconciled against real
// legacy shapes without them, so each file is produced by the shipped code and re-checked here on
// every run: if the provider or the policy schema changes shape, these tests go red.
//
// ---- legacy-state.json — the configuration it was produced from -----------------------------
//
// Clock: fixed at 2026-11-05T00:00:00.000Z (`mock.timers`, `apis: ["Date"]`), so "recent" and
// "past retention" mean the same thing on every run.
// File: `DATA_PATH/oauth/state.json`, pre-seeded as a pre-normalization legacy document, then
// loaded by the real provider (`createOAuthService()` → `PersistentOAuthProvider` → `load()` +
// `prune()` + `save()`); the fixture is the file it leaves behind.
//
//   - OAuth users: one with read+write+files on `vault`+`alpha` and default `alpha` (no
//     `displayName`); one read-only on `vault` with no `defaultVaultId` key at all; one disabled;
//     one whose `defaultVaultId` (`alpha`) is outside its `allowedVaults` (`vault`).
//   - OAuth clients: `legacy-client-full` with the whole authorization surface and a client-level
//     default Vault `alpha`; `legacy-client-minimal` with identity fields only.
//   - API keys: one with `defaultVaultId`, one legacy key without that key.
//   - Access tokens: current (generation 2), legacy (no `generation`, no `allowedVaults`, no
//     `createdAt`), revoked one hour ago, expired one hour ago (still retained), and one whose
//     account no longer exists. One token is 8 days past expiry and one refresh token was revoked
//     8 days ago: `prune()` must delete both, so neither may appear in the fixture.
//   - `configuredApiKeyUsage` set; `codes` and `audit` empty.
//   `passwordHash` is replaced by `<redacted-password-hash>` (bcrypt of the synthetic seed
//   password: non-deterministic and a secret), and the id `load()` mints for the legacy token is
//   replaced by `<generated-id>`. Nothing else is redacted.
//
// ---- legacy-policies.json — the configuration it was produced from --------------------------
//
// Built as data in `legacy-fixtures.js` and serialised by the real
// `serializeAccessPolicyDocument` (validate + serialise), so the file is always a document
// `app/src/access-policy/schema.js` accepts. `schemaVersion` 1, `revision` 7, 7 policies in
// Asia/Shanghai, Europe/Berlin and UTC:
//   - `surface:web` OR `tool:write_note` (the mixed OR that must stay two branches),
//   - `toolset:notes` + `resource:obsidian://vault/index`,
//   - `scope:obsidian.read` (the atom that reaches the Web session routes),
//   - `surface:oauth` (the credential lifecycle surface),
//   - a weekly window plus a date range in one policy,
//   - a `revoke` policy (`mode:"revoke"`, `capabilities:["all"]`) with a date range,
//   - a dormant policy: `enabled:false`, already expired, and its subject is an account that does
//     not exist in `legacy-state.json`. The old schema accepts it (subjects are shape-checked),
//     so the importer must HOLD instead of dropping it.
//
// Regenerate after a deliberate change (never hand-edit either file):
//   PERMISSION_LEGACY_WRITE=1 node --test test/permission-legacy-fixtures.test.js
//   node --test test/permission-legacy-fixtures.test.js   # must be green

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "permission-architecture");
const STATE_FILE = path.join(fixtures, "legacy-state.json");
const POLICY_FILE = path.join(fixtures, "legacy-policies.json");

// `src/config.js` resolves DATA_PATH at import time, so the isolated environment comes first.
const env = await (await import("./helpers/permission-baseline-env.js")).seedPermissionBaselineEnv();
const { bootLegacyState, redactLegacyState, serializeLegacyPolicies, LEGACY_FIXED_NOW } = await import("./helpers/legacy-fixtures.js");

test.after(async () => fs.rm(env.root, { recursive: true, force: true }));

const REWRITE = process.env.PERMISSION_LEGACY_WRITE === "1";
const boot = await bootLegacyState({ dataPath: env.dataPath });
const stateText = `${JSON.stringify(redactLegacyState(boot.document), null, 2)}\n`;
const policyText = serializeLegacyPolicies();
if (REWRITE) {
  await fs.writeFile(STATE_FILE, stateText, "utf8");
  await fs.writeFile(POLICY_FILE, policyText, "utf8");
  console.log(`rewrote ${STATE_FILE} and ${POLICY_FILE}`);
}

test("legacy-state.json is exactly what a boot with that configuration leaves behind", { skip: REWRITE ? "the fixtures were just rewritten; commit them and run again" : false }, async () => {
  assert.equal(await fs.readFile(STATE_FILE, "utf8"), stateText);
});

test("legacy-policies.json is exactly what the real policy schema serialises", { skip: REWRITE ? "the fixtures were just rewritten; commit them and run again" : false }, async () => {
  assert.equal(await fs.readFile(POLICY_FILE, "utf8"), policyText);
});

test("the state fixture keeps every legacy edge case testable", async () => {
  const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  const keys = boot.tokenKeys;

  // 1. Retention really ran: the two records past the 7-day window are gone.
  assert.equal(state.accessTokens[keys.expiredPastRetention], undefined, "an 8-day-expired access token must be pruned");
  assert.equal(state.refreshTokens[keys.refreshRevokedPastRetention], undefined, "an 8-day-revoked refresh token must be pruned");

  // 2. generation: a legacy record is generation 0; a current one keeps its number.
  assert.equal(state.accessTokens[keys.legacyNoEnvelope].generation, 0);
  assert.equal(state.accessTokens[keys.active].generation, 2);
  assert.equal(state.accessTokens[keys.legacyNoEnvelope].id, "<generated-id>", "the provider minted an id at load");

  // 3. A legacy token without `allowedVaults` gets its account's set; a deleted account falls back.
  assert.deepEqual(state.accessTokens[keys.legacyNoEnvelope].allowedVaults, ["vault"]);
  assert.deepEqual(state.accessTokens[keys.deletedAccount].allowedVaults, ["vault"], "a token of a deleted account must not widen");

  // 4. revoked / expired / rotated are recorded, not erased.
  assert.equal(typeof state.accessTokens[keys.revoked].revokedAt, "string");
  assert.ok(state.accessTokens[keys.expiredRetained].expiresAt < state.accessTokens[keys.active].expiresAt, "the expired-but-retained token stays stored");
  assert.equal(typeof state.refreshTokens[keys.refreshRotated].usedAt, "number", "a rotated refresh token keeps the epoch-ms `usedAt` the rotation wrote");

  // 5. A stale account default is recorded as-is (never rewritten to the primary Vault).
  const users = Object.values(state.oauthUsers);
  const stale = users.find((user) => user.username === "legacy-stale-default");
  assert.equal(stale.defaultVaultId, "alpha");
  assert.deepEqual(stale.allowedVaults, ["vault"]);
  const inherit = users.find((user) => user.username === "legacy-primary");
  assert.equal("defaultVaultId" in inherit, false, "a missing preference stays missing");
  assert.equal(inherit.displayName, "Legacy Primary");
  const missingName = users.find((user) => user.username === "legacy-mixed");
  assert.equal(missingName.displayName, "legacy-mixed", "load() fills a legacy displayName from the username");
  assert.ok(users.some((user) => typeof user.disabledAt === "string"), "the disabled account is preserved");

  // 6. Clients with and without authorization fields, and the key preference cases.
  assert.deepEqual(state.clients["legacy-client-minimal"], { client_id: "legacy-client-minimal", client_id_issued_at: state.clients["legacy-client-minimal"].client_id_issued_at });
  assert.ok(Array.isArray(state.clients["legacy-client-full"].redirect_uris));
  assert.equal(state.clientUsage["legacy-client-full"].defaultVaultId, "alpha");
  assert.equal(Object.values(state.apiKeys).some((key) => "defaultVaultId" in key), true);
  assert.equal(Object.values(state.apiKeys).some((key) => !("defaultVaultId" in key)), true);

  // 7. No secret survived: the only removed value is the bcrypt hash.
  for (const user of users) assert.equal(user.passwordHash, "<redacted-password-hash>");
});

test("the policy fixture keeps every selector the import must preserve testable", async () => {
  const document = JSON.parse(await fs.readFile(POLICY_FILE, "utf8"));
  const policies = document.policies;
  assert.equal(document.schemaVersion, 1);
  assert.equal(policies.length, 7);

  const capabilities = policies.flatMap((policy) => policy.capabilities);
  for (const atom of ["surface:web", "surface:oauth", "tool:write_note", "toolset:notes", "resource:obsidian://vault/index", "scope:obsidian.read", "scope:obsidian.files", "all"]) {
    assert.ok(capabilities.includes(atom), `the fixture must hold the ${atom} selector`);
  }

  // The mixed OR: one policy, two selectors, never merged into an AND.
  const mixed = policies.find((policy) => policy.capabilities.includes("surface:web") && policy.capabilities.includes("tool:write_note"));
  assert.ok(mixed, "one policy must carry both the surface and the tool selector");

  // A weekly window and a date range must both exist, in the same policy too.
  assert.ok(policies.some((policy) => Object.keys(policy.weekly).length > 0 && policy.dateRanges.length > 0));
  assert.ok(policies.some((policy) => policy.dateRanges.length > 0 && Object.keys(policy.weekly).length === 0));

  // Revoke keeps exactly [all]; the document has exactly one revoke policy.
  const revokes = policies.filter((policy) => policy.mode === "revoke");
  assert.equal(revokes.length, 1);
  assert.deepEqual(revokes[0].capabilities, ["all"]);

  // The dormant policy: disabled, expired, and its subject is absent from the identity fixture.
  const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  const knownSubjects = new Set(Object.keys(state.oauthUsers).map((id) => `oauth-user:${id}`));
  const dormant = policies.filter((policy) => policy.enabled === false);
  assert.ok(dormant.length >= 1, "a dormant policy must exist so the importer's HOLD is testable");
  const broken = dormant.find((policy) => policy.subjects.some((subject) => !knownSubjects.has(subject)));
  assert.ok(broken, "the dormant policy must reference a subject that no longer exists");
  assert.ok(broken.expiresAt !== null && Date.parse(broken.expiresAt) < LEGACY_FIXED_NOW, "the dormant policy is already expired");
});
