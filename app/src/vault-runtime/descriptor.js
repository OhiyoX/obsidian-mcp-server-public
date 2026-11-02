// Canonical Vault descriptor primitives — contract §3 (Canonical Vault model),
// Wave A / lane A1 (contract §26 A1). PURE FOUNDATION: this module has no
// consumer at this commit. A2 (registry discovery), A4 (request context) and the
// B/C lanes own consumption; nothing here may be wired into existing code yet.
//
// Architecture constraints satisfied on purpose (contract §43-5, brief §2.5):
//   * imports ONLY `node:crypto`, `node:fs/promises`, `node:path` — never
//     `config.js` global path constants (VAULT / DATA_PATH / TRASH_PATH /
//     HISTORY_PATH / RETRIEVAL_INDEX_PATH), never `app/**`, never a sibling
//     server module that transitively pulls those in;
//   * no module-level mutable state (SEC-MV07): no module global here at all;
//   * `dataKey` is derived from the id, never from a user-controlled directory
//     name (§3.3) and is never exposed as Vault identity.
//
// Fail-closed policy: every invalid input throws a structured `Error` carrying a
// stable `code` and a `[CODE] ` message prefix, so callers can wrap it without
// string matching. Missing capability facts are an error, not a silent default.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Stable error codes (also exported so consumers/tests never match on prose).
export const VAULT_ID_INVALID = "VAULT_ID_INVALID";
export const VAULT_DESCRIPTOR_INVALID = "VAULT_DESCRIPTOR_INVALID";
export const VAULT_ROOT_UNRESOLVED = "VAULT_ROOT_UNRESOLVED";
export const VAULT_ROOT_ALIAS = "VAULT_ROOT_ALIAS";

// Documented Vault ID bound (contract §3.2 "max 80"), measured in code points —
// the same unit the shared pattern below uses. `MAX_VAULT_ID_LENGTH` is derived
// documentation: the pattern is the single source of truth and the test asserts
// the two stay consistent (`MAX_VAULT_ID_LENGTH - 1 === 79` quantifier).
export const MAX_VAULT_ID_LENGTH = 80;

// Canonical Vault ID pattern. DO NOT FORK THIS RULE (contract §3.2): the single
// source of truth is the existing Web rule at
// `app/src/app/vault-registry.js:17` — `const VAULT_ID = /.../u;` — and this
// literal must stay byte-identical to it. `test/vault-runtime-descriptor.test.js`
// extracts that literal from the Web source (extractor self-proofs an exact
// single match) and compares both the pattern source and the accept/reject
// verdicts of the whole ID matrix; any drift is a red test.
const VAULT_ID = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u;

/** `.source` of the canonical pattern, for the Web parity harness. */
export const VAULT_ID_PATTERN_SOURCE = VAULT_ID.source;

// Extra rejections kept in lockstep with the Web guard at
// `app/src/app/vault-registry.js:22` (`id === "." || id === ".."`); the pattern
// already rejects both, this keeps the rule explicit and drift-detectable.
const RESERVED_IDS = Object.freeze([".", ".."]);

// Capability inventory (contract §3.4). A capability is a *runtime fact*, never
// an authorization: allowedVaults/scopes stay independent.
export const CAPABILITY_KEYS = Object.freeze([
  "notes",
  "files",
  "history",
  "trash",
  "plans",
  "retrieval",
  "semantic",
  "webCatalog",
  "publish",
  "git",
  "events",
  "memory",
  "skills",
]);

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return `${typeof value} ${String(value)}`;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value === "") {
    fail(VAULT_DESCRIPTOR_INVALID, `${label} must be a non-empty string, got ${describe(value)}`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(VAULT_DESCRIPTOR_INVALID, `${label} must be passed explicitly as a boolean, got ${describe(value)}`);
  }
  return value;
}

/**
 * Predicate form of the canonical ID rule. Non-strings are rejected without
 * coercion: callers must pass the id as a string (Web-side `String(...).trim()`
 * normalization is a Web concern, not part of this rule).
 */
export function isValidVaultId(id) {
  if (typeof id !== "string") return false;
  if (RESERVED_IDS.includes(id)) return false;
  return VAULT_ID.test(id);
}

/**
 * Throwing form of the canonical ID rule. Returns the id unchanged on success.
 * Error: `code = VAULT_ID_INVALID`, message prefix `[VAULT_ID_INVALID] `.
 */
export function validateVaultId(id) {
  if (!isValidVaultId(id)) {
    fail(
      VAULT_ID_INVALID,
      `invalid Vault ID ${describe(id)}: expected ${MAX_VAULT_ID_LENGTH} code points max matching the shared Web VAULT_ID rule ` +
        `(first code point a letter/number, then letters/numbers/space/./_/()/-, and not "." or "..")`,
    );
  }
  return id;
}

/**
 * Stable secondary-state key for a Vault (contract §3.3): full 64 hex chars of
 * `sha256(id)`, so `DATA_PATH` sub-state never depends on a user-controlled
 * directory name. Not an identity and not an authorization token.
 */
export function vaultDataKey(id) {
  validateVaultId(id);
  return createHash("sha256").update(id).digest("hex");
}

/**
 * Explicit "this capability is not wired" fact (contract §3.4). A reason is
 * mandatory — silent capability defaults are forbidden, because secondary Vaults
 * must fail closed with a visible reason instead of quietly losing features.
 */
export function unavailable(reason) {
  if (typeof reason !== "string" || reason.trim() === "") {
    fail(
      VAULT_DESCRIPTOR_INVALID,
      `unavailable(reason) requires a non-empty reason, got ${describe(reason)} (no silent capability default)`,
    );
  }
  return Object.freeze({ available: false, reason: reason.trim() });
}

function normalizeCapability(key, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(VAULT_DESCRIPTOR_INVALID, `capability "${key}" must be an object, got ${describe(value)}`);
  }
  if (typeof value.available !== "boolean") {
    fail(VAULT_DESCRIPTOR_INVALID, `capability "${key}" must declare a boolean "available", got ${describe(value.available)}`);
  }
  const keys = Object.keys(value).sort();
  const allowed = value.available ? ["available"] : ["available", "reason"];
  if (keys.length !== allowed.length || keys.some((entry, index) => entry !== allowed[index])) {
    fail(
      VAULT_DESCRIPTOR_INVALID,
      `capability "${key}" must use exactly {${allowed.join(", ")}} for available:${value.available}, got {${keys.join(", ")}}`,
    );
  }
  if (value.available) return Object.freeze({ available: true });
  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    fail(VAULT_DESCRIPTOR_INVALID, `capability "${key}" is unavailable but has no non-empty reason`);
  }
  return Object.freeze({ available: false, reason: value.reason.trim() });
}

function normalizeCapabilities(capabilities) {
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    fail(VAULT_DESCRIPTOR_INVALID, `capabilities must be an object keyed by CAPABILITY_KEYS, got ${describe(capabilities)}`);
  }
  const missing = CAPABILITY_KEYS.filter((key) => !Object.hasOwn(capabilities, key));
  if (missing.length > 0) {
    fail(
      VAULT_DESCRIPTOR_INVALID,
      `capabilities must declare every key explicitly (contract §3.4); missing: ${missing.join(", ")}`,
    );
  }
  const unknown = Object.keys(capabilities).filter((key) => !CAPABILITY_KEYS.includes(key));
  if (unknown.length > 0) {
    fail(VAULT_DESCRIPTOR_INVALID, `unknown capability keys: ${unknown.join(", ")}`);
  }
  const normalized = {};
  for (const key of CAPABILITY_KEYS) normalized[key] = normalizeCapability(key, capabilities[key]);
  return Object.freeze(normalized);
}

async function resolveCanonicalRoot(root) {
  try {
    return await fs.realpath(root);
  } catch (error) {
    fail(VAULT_ROOT_UNRESOLVED, `cannot resolve the real path of root ${JSON.stringify(root)}: ${error.code || error.message}`);
  }
}

/**
 * Build a frozen canonical VaultDescriptor (contract §3.1).
 *
 * `{ id, name, root, primary, writable, capabilities, canonicalRoot? }` in,
 * `{ id, name, root, canonicalRoot, primary, writable, dataKey, capabilities }`
 * out, deeply frozen (descriptor, capabilities map and each capability entry).
 *
 * `canonicalRoot` defaults to `fs.realpath(root)`; an unresolvable root throws
 * `VAULT_ROOT_UNRESOLVED` so the caller (registry/startup) decides the policy
 * instead of this primitive guessing one.
 *
 * Lane decisions (explicit, no silent default): `root` must be absolute,
 * `primary`/`writable` must be booleans, `name` defaults to `id`, and every
 * `CAPABILITY_KEYS` entry must be present.
 */
export async function createVaultDescriptor(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail(VAULT_DESCRIPTOR_INVALID, `descriptor input must be an object, got ${describe(input)}`);
  }
  const id = validateVaultId(input.id);
  const name = input.name === undefined || input.name === null ? id : requireNonEmptyString(input.name, "name");
  const root = requireNonEmptyString(input.root, "root");
  if (!path.isAbsolute(root)) {
    fail(VAULT_DESCRIPTOR_INVALID, `root must be an absolute path, got ${JSON.stringify(root)}`);
  }
  const primary = requireBoolean(input.primary, "primary");
  const writable = requireBoolean(input.writable, "writable");
  const capabilities = normalizeCapabilities(input.capabilities);
  const canonicalRoot =
    input.canonicalRoot === undefined || input.canonicalRoot === null
      ? await resolveCanonicalRoot(root)
      : requireNonEmptyString(input.canonicalRoot, "canonicalRoot");
  return Object.freeze({
    id,
    name,
    root,
    canonicalRoot,
    primary,
    writable,
    dataKey: vaultDataKey(id),
    capabilities,
  });
}

/**
 * SEC-MV02 authorization-alias prevention (contract §3.2 / §42): two different
 * Vault IDs must never resolve to the same canonical root, otherwise
 * `allowedVaults` authorizes an alias of a Vault the caller was not granted.
 * Throws `VAULT_ROOT_ALIAS`; returns the validated list for chaining.
 */
export function assertDistinctRoots(descriptors) {
  if (!Array.isArray(descriptors)) {
    fail(VAULT_DESCRIPTOR_INVALID, `assertDistinctRoots expects an array, got ${describe(descriptors)}`);
  }
  const byRoot = new Map();
  for (const descriptor of descriptors) {
    if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      fail(VAULT_DESCRIPTOR_INVALID, `descriptor entry must be an object, got ${describe(descriptor)}`);
    }
    const id = validateVaultId(descriptor.id);
    if (typeof descriptor.canonicalRoot !== "string" || descriptor.canonicalRoot === "") {
      fail(VAULT_DESCRIPTOR_INVALID, `descriptor ${JSON.stringify(id)} has no canonicalRoot to compare`);
    }
    const seen = byRoot.get(descriptor.canonicalRoot);
    if (seen === undefined) {
      byRoot.set(descriptor.canonicalRoot, id);
      continue;
    }
    if (seen !== id) {
      fail(
        VAULT_ROOT_ALIAS,
        `Vault IDs ${JSON.stringify(seen)} and ${JSON.stringify(id)} resolve to the same canonical root ` +
          `${JSON.stringify(descriptor.canonicalRoot)}: a Vault ID must not be an authorization alias (SEC-MV02)`,
      );
    }
  }
  return descriptors;
}
