// P0 / Task 1 — the two legacy fixtures, produced from the shipped code, not from imagination.
//
// The legacy configuration behind `legacy-state.json` (reproducible by reading this function):
//
//   * fixed clock: 2026-11-05T00:00:00.000Z (`mock.timers` with `apis: ["Date"]`), so "recent" and
//     "beyond retention" mean the same thing on every run;
//   * `DATA_PATH/oauth/state.json` is pre-seeded with a pre-normalization document — tokens without
//     `generation`/`allowedVaults`/`createdAt`, users without `displayName`, a client with no
//     authorization fields, API keys with and without a default Vault;
//   * the real provider is then constructed (`createOAuthService`, i.e. `PersistentOAuthProvider`)
//     and must come up `ready`; `load()` normalizes and `save()`s, and `prune()` drops records past
//     retention. The fixture is the file the provider leaves behind.
//
// The only removed value is `passwordHash` (a bcrypt hash of the synthetic seed password): it
// cannot be made deterministic and it is a secret. Every other value is fixed by the seed or
// normalised by `src/oauth/persistence-methods.js`, so the file is byte-stable.
//
// The legacy policy document behind `legacy-policies.json` is built here as data and then run
// through the real `serializeAccessPolicyDocument` (validate + serialise), so the fixture is always
// a document `app/src/access-policy/schema.js` accepts.

import fs from "node:fs/promises";
import path from "node:path";

import { hashPassword } from "../../src/oauth/primitives.js";
import { serializeAccessPolicyDocument } from "../../src/access-policy/schema.js";

/** The one instant every legacy record is relative to. */
export const LEGACY_FIXED_NOW = Date.parse("2026-11-05T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const USERS = Object.freeze({
  mixed: "11111111-1111-4111-8111-111111111111",
  primary: "22222222-2222-4222-8222-222222222222",
  disabled: "33333333-3333-4333-8333-333333333333",
  staleDefault: "44444444-4444-4444-8444-444444444444",
  deleted: "99999999-9999-4999-8999-999999999999",
});

/** 64-hex record keys stand in for `sha256(token)`: shape-correct, derived from no secret. */
const KEY = (byte) => byte.repeat(32);
const TOKEN_KEYS = Object.freeze({
  active: KEY("a1"),
  legacyNoEnvelope: KEY("b2"),
  revoked: KEY("c3"),
  expiredRetained: KEY("d4"),
  deletedAccount: KEY("e5"),
  expiredPastRetention: KEY("f6"),
  refreshRotated: KEY("17"),
  refreshRevokedPastRetention: KEY("28"),
});

const iso = (ms) => new Date(ms).toISOString();

/** The pre-normalization document: the legacy configuration, written as an old state file. */
async function legacyStateSeed() {
  const passwordHash = await hashPassword("legacy-fixture-password");
  const user = (overrides) => ({
    username: "legacy-user",
    passwordHash,
    allowedScopes: ["obsidian.read"],
    allowedVaults: ["vault"],
    createdAt: iso(LEGACY_FIXED_NOW - 30 * DAY),
    updatedAt: iso(LEGACY_FIXED_NOW - 30 * DAY),
    disabledAt: null,
    lastLoginAt: null,
    lastSource: null,
    lastUserAgent: null,
    ...overrides,
  });
  const token = (overrides) => ({
    clientId: "legacy-client-full",
    userId: USERS.mixed,
    scopes: ["obsidian.read", "obsidian.write"],
    allowedVaults: ["vault"],
    resource: "http://127.0.0.1:18923/mcp",
    createdAt: iso(LEGACY_FIXED_NOW - 2 * 3600 * 1000),
    expiresAt: LEGACY_FIXED_NOW + 3600 * 1000,
    lastUsedAt: null,
    lastSource: null,
    lastUserAgent: null,
    ...overrides,
  });

  return {
    clients: {
      // A client with the whole authorization surface (what `registerClient` writes today).
      "legacy-client-full": {
        client_id: "legacy-client-full",
        client_id_issued_at: Math.floor((LEGACY_FIXED_NOW - 10 * DAY) / 1000),
        client_name: "Legacy Full Client",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      // A legacy client with no authorization fields at all: identity only.
      "legacy-client-minimal": {
        client_id: "legacy-client-minimal",
        client_id_issued_at: Math.floor((LEGACY_FIXED_NOW - 20 * DAY) / 1000),
      },
    },
    clientUsage: {
      "legacy-client-full": {
        createdAt: iso(LEGACY_FIXED_NOW - 10 * DAY),
        defaultVaultId: "alpha",
        origins: ["https://client.example"],
        registeredOrigin: "https://client.example",
        lastUsedAt: null,
        lastSource: null,
        lastUserAgent: null,
      },
      "legacy-client-minimal": { createdAt: iso(LEGACY_FIXED_NOW - 20 * DAY) },
    },
    codes: {},
    accessTokens: {
      // A current token: generation 2, its own frozen Vault set.
      [TOKEN_KEYS.active]: token({ id: "5a5a5a5a-5555-4555-8555-555555555555", generation: 2 }),
      // A legacy token: no generation, no Vault set, no createdAt, no usage fields.
      [TOKEN_KEYS.legacyNoEnvelope]: {
        clientId: "legacy-client-minimal",
        userId: USERS.primary,
        scopes: ["obsidian.read"],
        resource: "http://127.0.0.1:18923/mcp",
        expiresAt: LEGACY_FIXED_NOW + 1800 * 1000,
      },
      // Revoked one hour ago: still inside retention, so it must survive the prune.
      [TOKEN_KEYS.revoked]: token({ id: "6b6b6b6b-6666-4666-8666-666666666666", generation: 1, revokedAt: iso(LEGACY_FIXED_NOW - 3600 * 1000) }),
      // Expired one hour ago but still retained: expiresAt is in the past, the record is not.
      [TOKEN_KEYS.expiredRetained]: token({ id: "7c7c7c7c-7777-4777-8777-777777777777", expiresAt: LEGACY_FIXED_NOW - 3600 * 1000 }),
      // A token whose account is gone: its Vault set must fall back, never widen.
      [TOKEN_KEYS.deletedAccount]: token({ id: "8d8d8d8d-8888-4888-8888-888888888888", userId: USERS.deleted, allowedVaults: undefined }),
      // Past retention: prune() must delete this one, so it cannot appear in the fixture.
      [TOKEN_KEYS.expiredPastRetention]: token({ id: "9e9e9e9e-9999-4999-8999-999999999999", expiresAt: LEGACY_FIXED_NOW - 8 * DAY }),
    },
    refreshTokens: {
      // A rotated refresh token (`usedAt` set), still valid.
      [TOKEN_KEYS.refreshRotated]: token({
        id: "1f1f1f1f-1111-4111-8111-111111111111",
        allowedVaults: ["vault", "alpha"],
        expiresAt: LEGACY_FIXED_NOW + 30 * DAY,
        usedAt: LEGACY_FIXED_NOW - 600 * 1000,
      }),
      // Revoked past retention: must be pruned.
      [TOKEN_KEYS.refreshRevokedPastRetention]: token({
        id: "2a2a2a2a-2222-4222-8222-222222222222",
        expiresAt: LEGACY_FIXED_NOW + 30 * DAY,
        revokedAt: iso(LEGACY_FIXED_NOW - 8 * DAY),
      }),
    },
    apiKeys: {
      "key-read-primary": {
        id: "aa11aa11-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        label: "legacy read key",
        prefix: "obmcp_fixture0001_",
        createdAt: iso(LEGACY_FIXED_NOW - 7 * DAY),
        lastUsedAt: iso(LEGACY_FIXED_NOW - 2 * DAY),
        lastSource: "127.0.0.1",
        lastUserAgent: "legacy-fixture/1",
        allowedScopes: ["obsidian.read"],
        allowedVaults: ["vault"],
        defaultVaultId: "vault",
      },
      // A legacy key with no default Vault: the preference is absent, not the primary.
      "key-legacy-no-default": {
        id: "bb22bb22-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        label: "legacy mixed key",
        prefix: "obmcp_fixture0002_",
        createdAt: iso(LEGACY_FIXED_NOW - 9 * DAY),
        lastUsedAt: null,
        lastSource: null,
        lastUserAgent: null,
        allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
        allowedVaults: ["vault", "alpha"],
      },
    },
    oauthUsers: {
      [USERS.mixed]: user({
        id: USERS.mixed,
        username: "legacy-mixed",
        // No `displayName`: `load()` fills it from the username.
        allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
        allowedVaults: ["vault", "alpha"],
        defaultVaultId: "alpha",
      }),
      [USERS.primary]: user({
        id: USERS.primary,
        username: "legacy-primary",
        displayName: "Legacy Primary",
        // No `defaultVaultId` at all: the preference inherits the primary Vault.
      }),
      [USERS.disabled]: user({
        id: USERS.disabled,
        username: "legacy-disabled",
        displayName: "Legacy Disabled",
        disabledAt: iso(LEGACY_FIXED_NOW - 5 * DAY),
      }),
      [USERS.staleDefault]: user({
        id: USERS.staleDefault,
        username: "legacy-stale-default",
        displayName: "Legacy Stale Default",
        allowedVaults: ["vault"],
        // A default outside `allowedVaults`: recorded as-is, refused at call time, never rewritten.
        defaultVaultId: "alpha",
      }),
    },
    oauthUsersInitialized: false,
    configuredApiKeyUsage: {
      lastUsedAt: iso(LEGACY_FIXED_NOW - 3 * DAY),
      lastSource: "127.0.0.1",
      lastUserAgent: "legacy-fixture/1",
    },
    audit: [],
  };
}

/** Drop what cannot be fixed: the bcrypt hash is both non-deterministic and a secret. */
export function redactLegacyState(document) {
  const clone = JSON.parse(JSON.stringify(document));
  for (const user of Object.values(clone.oauthUsers ?? {})) {
    if ("passwordHash" in user) user.passwordHash = "<redacted-password-hash>";
  }
  // `load()` mints an `id` for a legacy token record that never had one. A fresh UUID cannot be
  // fixed, so the fixture records the fact instead of the value.
  const minted = clone.accessTokens?.[TOKEN_KEYS.legacyNoEnvelope];
  if (minted && typeof minted.id === "string" && /^[0-9a-f-]{36}$/i.test(minted.id)) minted.id = "<generated-id>";
  return clone;
}

/**
 * Seed the legacy state file, boot the real provider under the fixed clock, and return the
 * normalized document it left on disk.
 */
export async function bootLegacyState({ dataPath }) {
  const { mock } = await import("node:test");
  const file = path.join(dataPath, "oauth", "state.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  mock.timers.enable({ apis: ["Date"], now: LEGACY_FIXED_NOW });
  try {
    await fs.writeFile(file, `${JSON.stringify(await legacyStateSeed(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const { createOAuthService } = await import("../../src/oauth-provider.js");
    const oauthService = createOAuthService();
    await oauthService.provider.ready;
    return { provider: oauthService.provider, file, document: JSON.parse(await fs.readFile(file, "utf8")), tokenKeys: TOKEN_KEYS };
  } finally {
    mock.timers.reset();
  }
}

// ---------------------------------------------------------------------------------------------
// legacy-policies.json — the selector combinations the import must preserve, plus one dormant
// policy that is broken (a disabled policy whose subject no longer exists). The design forbids
// dropping a dormant policy as "disabled" (§2.3/§8): the importer must HOLD it, and the old schema
// accepts it because a subject is validated by shape, not by existence.
// ---------------------------------------------------------------------------------------------

const POLICY_ID = Object.freeze({
  // Capability list is an OR: `surface:web` and `tool:write_note` must become two branches.
  mixedOr: "0a000000-0000-4000-8000-00000000000a",
  // `toolset:` + `resource:` selectors, both MCP-only.
  toolsetResource: "0b000000-0000-4000-8000-00000000000b",
  // `scope:` selector — the atom that reaches the Web session routes (`GET /api/web/v1/session`).
  scopeSession: "0c000000-0000-4000-8000-00000000000c",
  // `surface:oauth`: the credential/session lifecycle surface.
  oauthSurface: "0d000000-0000-4000-8000-00000000000d",
  // Weekly window AND a date range in one policy.
  windowAndRange: "0e000000-0000-4000-8000-00000000000e",
  // Revoke mode with a date range.
  revoke: "0f000000-0000-4000-8000-00000000000f",
  // Dormant (disabled) and broken (its subject is not in the identity snapshot; already expired).
  dormantBroken: "10000000-0000-4000-8000-000000000010",
});

function policy(overrides) {
  return {
    label: "legacy policy",
    enabled: true,
    subjects: [`oauth-user:${USERS.mixed}`],
    mode: "suspend",
    capabilities: ["all"],
    timezone: "Asia/Shanghai",
    weekly: {},
    dateRanges: [],
    startsAt: null,
    expiresAt: null,
    createdAt: iso(LEGACY_FIXED_NOW - 20 * DAY),
    updatedAt: iso(LEGACY_FIXED_NOW - 20 * DAY),
    ...overrides,
  };
}

/** The document `legacy-policies.json` holds, before the real validator normalises it. */
export function legacyPolicyDocument() {
  return {
    schemaVersion: 1,
    revision: 7,
    policies: [
      policy({
        id: POLICY_ID.mixedOr,
        label: "OR: web surface or the write_note tool",
        subjects: [`oauth-user:${USERS.mixed}`, `api-key:configured-env`],
        capabilities: ["surface:web", "tool:write_note"],
        timezone: "Asia/Shanghai",
        weekly: { mon: [["09:00", "18:00"]], tue: [["09:00", "12:00"], ["13:00", "18:00"]] },
      }),
      policy({
        id: POLICY_ID.toolsetResource,
        label: "toolset and resource selectors",
        subjects: [`oauth-client:legacy-client-full`],
        capabilities: ["toolset:notes", "resource:obsidian://vault/index"],
        weekly: { sat: [["10:00", "14:00"]] },
      }),
      policy({
        id: POLICY_ID.scopeSession,
        label: "scope selector covering the Web session routes",
        subjects: [`oauth-user:${USERS.primary}`],
        capabilities: ["scope:obsidian.read"],
        weekly: { wed: [["08:00", "20:00"]] },
      }),
      policy({
        id: POLICY_ID.oauthSurface,
        label: "OAuth credential lifecycle surface",
        subjects: [`oauth-client:legacy-client-minimal`],
        capabilities: ["surface:oauth"],
        weekly: { thu: [["00:00", "24:00"]] },
      }),
      policy({
        id: POLICY_ID.windowAndRange,
        label: "weekly window and a date range together",
        subjects: [`api-key:key-read-primary`],
        capabilities: ["toolset:search", "scope:obsidian.files"],
        timezone: "Europe/Berlin",
        weekly: { fri: [["09:30", "17:30"]] },
        dateRanges: [{ from: "2026-11-01", to: "2026-11-30" }],
      }),
      policy({
        id: POLICY_ID.revoke,
        label: "revoke the full client",
        subjects: [`oauth-client:legacy-client-full`],
        mode: "revoke",
        capabilities: ["all"],
        timezone: "UTC",
        dateRanges: [{ from: "2026-01-01", to: "2027-01-01" }],
        startsAt: iso(LEGACY_FIXED_NOW - 3 * DAY),
      }),
      policy({
        id: POLICY_ID.dormantBroken,
        label: "dormant: subject no longer exists",
        enabled: false,
        subjects: [`oauth-user:${USERS.deleted}`],
        capabilities: ["tool:get_note"],
        weekly: { mon: [["09:00", "10:00"]] },
        expiresAt: iso(LEGACY_FIXED_NOW - 4 * DAY),
      }),
    ],
  };
}

/** The exact bytes `legacy-policies.json` must hold: the real validator's own serialisation. */
export function serializeLegacyPolicies() {
  return serializeAccessPolicyDocument(legacyPolicyDocument());
}
