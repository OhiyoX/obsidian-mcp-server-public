// W2 (#437) — the `vault-admissions.json` document schema: shape, cross-validation and the
// persisted projections. Contract §2.2 / §2.3 / §3.1.
//
// Split out of `admission-store.js` (which must stay inside the repository line budget) as one
// cohesive unit: "what a valid document is". It performs no I/O and owns no writer — the store is
// the only writer. `admission-store.js` re-exports these names so consumers keep one import site.

import { assertVaultIdentity, isVaultIdentity } from "./identity.js";
import { isValidVaultId } from "./descriptor.js";

/** Stable machine-readable failure codes; consumers/tests never match on prose. */
export const ADMISSIONS_CORRUPT = "VAULT_ADMISSIONS_CORRUPT";
export const ADMISSIONS_CAPACITY_EXCEEDED = "VAULT_ADMISSIONS_CAPACITY_EXCEEDED";

/** Frozen schema version of `vault-admissions.json` (contract §2.2). */
export const ADMISSIONS_VERSION = 1;

/** Admission axis (contract §2.1) — the runtime axis is a projection and is never persisted here. */
export const ADMISSION_PENDING = "pending";
export const ADMISSION_APPROVED = "approved";
export const ADMISSION_DECISIONS = Object.freeze([ADMISSION_PENDING, ADMISSION_APPROVED]);

/**
 * Persistent capacity guard (contract §1: 历史 `unavailable` 记录不自动删除，另设持久化容量保护).
 * Exceeding it is an explicit failure, never a silent truncation of history.
 */
export const MAX_ADMISSION_ENTRIES = 512;

const DOCUMENT_KEYS = Object.freeze(["version", "revision", "migration", "entries", "registry"]);
const REGISTRY_KEYS = Object.freeze(["revision", "vaults", "skipped"]);
const MIGRATION_KEYS = Object.freeze(["done", "doneAt", "source", "configDigest"]);
const ENTRY_KEYS = Object.freeze([
  "identity",
  "admission",
  "firstSeenAt",
  "lastSeenAt",
  "approvedAt",
  "approvedBy",
  "generation",
  "note",
  "identityConflict",
]);
const REGISTRY_VAULT_KEYS = Object.freeze(["id", "root", "canonicalRoot", "primary", "writable", "identity"]);

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return Array.isArray(value) ? `array(${value.length})` : `${typeof value} ${String(value)}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export { isPlainObject };

function isoOrNull(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(ADMISSIONS_CORRUPT, `${label} must be an ISO-8601 timestamp or null, got ${describe(value)}`);
  return value;
}

function requireExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(ADMISSIONS_CORRUPT, `${label} has unknown field(s): ${unknown.join(", ")}`);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) fail(ADMISSIONS_CORRUPT, `${label} is missing field(s): ${missing.join(", ")}`);
}

function validateEntry(id, raw) {
  if (!isPlainObject(raw)) fail(ADMISSIONS_CORRUPT, `entries[${JSON.stringify(id)}] must be an object, got ${describe(raw)}`);
  requireExactKeys(raw, ENTRY_KEYS, `entries[${JSON.stringify(id)}]`);
  if (raw.identity !== null && !isVaultIdentity(raw.identity)) {
    fail(ADMISSIONS_CORRUPT, `entries[${JSON.stringify(id)}].identity is not a valid v1 identity record (or null): ${describe(raw.identity)}`);
  }
  if (!ADMISSION_DECISIONS.includes(raw.admission)) {
    fail(ADMISSIONS_CORRUPT, `entries[${JSON.stringify(id)}].admission must be one of ${ADMISSION_DECISIONS.join("|")}, got ${describe(raw.admission)}`);
  }
  isoOrNull(raw.firstSeenAt, `entries[${JSON.stringify(id)}].firstSeenAt`);
  isoOrNull(raw.lastSeenAt, `entries[${JSON.stringify(id)}].lastSeenAt`);
  isoOrNull(raw.approvedAt, `entries[${JSON.stringify(id)}].approvedAt`);
  if (!Number.isInteger(raw.generation) || raw.generation < 1) {
    fail(ADMISSIONS_CORRUPT, `entries[${JSON.stringify(id)}].generation must be a positive integer, got ${describe(raw.generation)}`);
  }
  if (raw.note !== null && typeof raw.note !== "string") {
    fail(ADMISSIONS_CORRUPT, `entries[${JSON.stringify(id)}].note must be a string or null, got ${describe(raw.note)}`);
  }
  if (typeof raw.identityConflict !== "boolean") {
    fail(ADMISSIONS_CORRUPT, `entries[${JSON.stringify(id)}].identityConflict must be a boolean, got ${describe(raw.identityConflict)}`);
  }
  if (raw.admission === ADMISSION_APPROVED) {
    if (raw.approvedAt === null || typeof raw.approvedBy !== "string" || raw.approvedBy.trim() === "") {
      fail(ADMISSIONS_CORRUPT, `entries[${JSON.stringify(id)}] is approved but has no approvedAt/approvedBy: an approval must carry a trusted operator identity`);
    }
    if (raw.identity === null) fail(ADMISSIONS_CORRUPT, `entries[${JSON.stringify(id)}] is approved without an identity binding (contract §3.1)`);
  }
  if (raw.admission === ADMISSION_PENDING && (raw.approvedAt !== null || raw.approvedBy !== null)) {
    fail(ADMISSIONS_CORRUPT, `entries[${JSON.stringify(id)}] is pending but still carries approval metadata`);
  }
  return raw;
}

/**
 * Strict, fail-closed validation of a whole `vault-admissions.json` document (contract §2.2
 * "交叉校验（加载时，fail-closed）"). Exported so tests and diagnostics can validate a file without
 * constructing a store.
 */
export function validateAdmissionState(raw) {
  if (!isPlainObject(raw)) fail(ADMISSIONS_CORRUPT, `admissions document must be a JSON object, got ${describe(raw)}`);
  requireExactKeys(raw, DOCUMENT_KEYS, "admissions document");
  if (raw.version !== ADMISSIONS_VERSION) {
    fail(ADMISSIONS_CORRUPT, `unsupported admissions version ${describe(raw.version)} (this build understands v${ADMISSIONS_VERSION}); refusing to guess`);
  }
  if (!Number.isInteger(raw.revision) || raw.revision < 0) {
    fail(ADMISSIONS_CORRUPT, `revision must be a non-negative integer, got ${describe(raw.revision)}`);
  }
  if (!isPlainObject(raw.migration)) fail(ADMISSIONS_CORRUPT, `migration must be an object, got ${describe(raw.migration)}`);
  requireExactKeys(raw.migration, MIGRATION_KEYS, "migration");
  if (typeof raw.migration.done !== "boolean") fail(ADMISSIONS_CORRUPT, "migration.done must be a boolean");
  const migrationDoneAt = isoOrNull(raw.migration.doneAt, "migration.doneAt");
  if (raw.migration.done) {
    if (migrationDoneAt === null || typeof raw.migration.source !== "string" || raw.migration.source.trim() === "") {
      fail(ADMISSIONS_CORRUPT, "migration.done is true but doneAt/source are missing (the marker must be self-describing)");
    }
    if (typeof raw.migration.configDigest !== "string" || raw.migration.configDigest.trim() === "") {
      fail(ADMISSIONS_CORRUPT, "migration.done is true but configDigest is missing");
    }
  }
  if (!isPlainObject(raw.entries)) fail(ADMISSIONS_CORRUPT, `entries must be an object, got ${describe(raw.entries)}`);
  if (!isPlainObject(raw.registry)) fail(ADMISSIONS_CORRUPT, `registry must be an object, got ${describe(raw.registry)}`);
  requireExactKeys(raw.registry, REGISTRY_KEYS, "registry");
  if (!Number.isInteger(raw.registry.revision) || raw.registry.revision !== raw.revision) {
    fail(ADMISSIONS_CORRUPT, `registry.revision (${describe(raw.registry.revision)}) must equal revision (${describe(raw.revision)}): the admission decision and the registry snapshot must share one commit point (contract §2.2)`);
  }
  if (!isPlainObject(raw.registry.vaults)) fail(ADMISSIONS_CORRUPT, "registry.vaults must be an object");
  if (!Array.isArray(raw.registry.skipped)) fail(ADMISSIONS_CORRUPT, "registry.skipped must be an array");

  const entryIds = Object.keys(raw.entries);
  if (entryIds.length > MAX_ADMISSION_ENTRIES) {
    fail(ADMISSIONS_CAPACITY_EXCEEDED, `admissions hold ${entryIds.length} entries, above the ${MAX_ADMISSION_ENTRIES} persistent capacity guard: refusing to load (no silent truncation)`);
  }
  for (const id of entryIds) {
    if (!isValidVaultId(id)) fail(ADMISSIONS_CORRUPT, `entries key ${describe(id)} is not a canonical Vault ID`);
    validateEntry(id, raw.entries[id]);
  }
  for (const id of Object.keys(raw.registry.vaults)) {
    if (!isValidVaultId(id)) fail(ADMISSIONS_CORRUPT, `registry.vaults key ${describe(id)} is not a canonical Vault ID`);
    if (!Object.hasOwn(raw.entries, id)) {
      fail(ADMISSIONS_CORRUPT, `registry.vaults references ${describe(id)} but no entry exists: a served Vault always has an admission record (contract §2.2)`);
    }
    const vault = raw.registry.vaults[id];
    if (!isPlainObject(vault)) fail(ADMISSIONS_CORRUPT, `registry.vaults[${JSON.stringify(id)}] must be an object`);
    requireExactKeys(vault, REGISTRY_VAULT_KEYS, `registry.vaults[${JSON.stringify(id)}]`);
    if (vault.id !== id) fail(ADMISSIONS_CORRUPT, `registry.vaults[${JSON.stringify(id)}].id must equal its key`);
    if (typeof vault.root !== "string" || vault.root === "") fail(ADMISSIONS_CORRUPT, `registry.vaults[${JSON.stringify(id)}].root must be a non-empty string`);
    if (vault.canonicalRoot !== null && (typeof vault.canonicalRoot !== "string" || vault.canonicalRoot === "")) {
      fail(ADMISSIONS_CORRUPT, `registry.vaults[${JSON.stringify(id)}].canonicalRoot must be a non-empty string or null`);
    }
    if (typeof vault.primary !== "boolean" || typeof vault.writable !== "boolean") {
      fail(ADMISSIONS_CORRUPT, `registry.vaults[${JSON.stringify(id)}] must declare boolean primary/writable`);
    }
    if (vault.identity !== null && !isVaultIdentity(vault.identity)) {
      fail(ADMISSIONS_CORRUPT, `registry.vaults[${JSON.stringify(id)}].identity is not a valid v1 identity record (or null)`);
    }
    const entry = raw.entries[id];
    if (entry.admission === ADMISSION_APPROVED && (vault.identity === null || vault.identity.digest !== entry.identity.digest)) {
      fail(ADMISSIONS_CORRUPT, `approved entry ${describe(id)} and its registry record disagree on identity: refusing to load a partially-applied commit (contract §2.2)`);
    }
  }
  return raw;
}

/** A fresh, uninitialized document (contract §2.3: no implicit migration, no implicit approval). */
export function emptyAdmissionState() {
  return {
    version: ADMISSIONS_VERSION,
    revision: 0,
    migration: { done: false, doneAt: null, source: null, configDigest: null },
    entries: {},
    registry: { revision: 0, vaults: {}, skipped: [] },
  };
}

// ---------------------------------------------------------------------------
// W2 fix (#437 RETURN item 1) — the MANAGED-MODE ENROLLMENT sentinel.
//
// The seat's repro: an instance that was initialized, had its record deleted, and was restarted with
// the discovery switch off fell back to legacy and served everything. `vault-admissions.json`'s own
// absence cannot distinguish "never managed" from "state lost", so the managed-mode fact and the
// trusted identity bindings live in a SEPARATE durable sentinel that records NO admission decision
// (it never grants `approved`/`pending`) and can only ever refuse MORE, never admit more.
// ---------------------------------------------------------------------------

/** Frozen schema version of the managed-mode enrollment sentinel. */
export const ENROLLMENT_VERSION = 1;
// W2FIX3 (item 2): `revision` is the durable FLOOR of the authoritative record revision the sentinel
// has already witnessed. It is written BEFORE the record (item 1), so `sentinel.revision >
// record.revision` means a mutation was attempted but its record write did not land — the frozen
// conservative recovery rule is to refuse that stale record instead of trusting an older approval.
const ENROLLMENT_KEYS = Object.freeze(["version", "managed", "managedSince", "revision", "bindings"]);
const ENROLLMENT_BINDING_KEYS = Object.freeze(["identity", "generation", "enrolledAt"]);

/** A fresh sentinel with no bindings (an explicitly managed instance that has approved nothing yet). */
export function emptyEnrollmentState(managedSince) {
  return { version: ENROLLMENT_VERSION, managed: true, managedSince, revision: 0, bindings: {} };
}

/**
 * Build the next document from a base state; always called inside the store's serialized task. Moved
 * here (line budget) because it is pure schema arithmetic with no I/O and no policy.
 *
 * `revisionFloor` (W2FIX4 item C) is the durable sentinel revision the caller has already witnessed.
 * An explicit recovery after a RECORD LOSS has `base === null` (revision 0), but the managed-mode
 * sentinel still floors the revision: writing below it would make the very next load refuse the
 * record as stale, so the next revision is `max(base, floor) + 1`.
 */
export function buildNextAdmissionDocument({ base, entries, registry, revisionFloor = 0 }) {
  const source = base ?? emptyAdmissionState();
  const floor = Number.isInteger(revisionFloor) && revisionFloor > source.revision ? revisionFloor : source.revision;
  const revision = floor + 1;
  const nextEntries = entries === undefined ? { ...source.entries } : entries;
  const count = Object.keys(nextEntries).length;
  if (count > MAX_ADMISSION_ENTRIES) {
    fail(
      ADMISSIONS_CAPACITY_EXCEEDED,
      `persisting ${count} admission entries would exceed the ${MAX_ADMISSION_ENTRIES} capacity guard: ` +
        "refusing the write instead of dropping history (contract §1)",
    );
  }
  const nextRegistry =
    registry === undefined
      ? { vaults: { ...source.registry.vaults }, skipped: [...source.registry.skipped] }
      : { vaults: registry.vaults ?? {}, skipped: registry.skipped ?? [] };
  return {
    version: ADMISSIONS_VERSION,
    revision,
    migration: { ...source.migration },
    entries: nextEntries,
    registry: { ...nextRegistry, revision },
  };
}

/**
 * Merge a record's bindings into the sentinel WITHOUT ever lowering a binding (item 1). A conflict
 * (same id, different digest) is corruption: the record is never allowed to launder a binding. The
 * top-level `revision` floor only ever moves forward (item 2).
 */
export function mergeEnrollmentBindings(base, entries, at, revision = null) {
  const bindings = { ...(base?.bindings ?? {}) };
  let changed = base === null || base === undefined;
  const nextRevision = Math.max(base?.revision ?? 0, Number.isInteger(revision) && revision >= 0 ? revision : 0);
  if (nextRevision !== (base?.revision ?? 0)) changed = true;
  for (const [id, entry] of Object.entries(entries ?? {})) {
    if (entry?.identity === null || entry?.identity === undefined) continue;
    const known = bindings[id];
    if (known === undefined) {
      bindings[id] = { identity: entry.identity, generation: entry.generation ?? 1, enrolledAt: at };
      changed = true;
      continue;
    }
    if (known.identity.digest !== entry.identity.digest) {
      fail(
        ADMISSIONS_CORRUPT,
        `the managed-mode sentinel already binds ${describe(id)} to a different identity than the record being written; refusing to ` +
          "overwrite a trusted binding (contract §3.1)",
      );
    }
    if ((entry.generation ?? 1) > known.generation) {
      bindings[id] = { ...known, generation: entry.generation, enrolledAt: at };
      changed = true;
    }
  }
  return { bindings, changed, revision: nextRevision };
}

export function validateEnrollmentState(raw) {
  if (!isPlainObject(raw)) fail(ADMISSIONS_CORRUPT, `enrollment sentinel must be a JSON object, got ${describe(raw)}`);
  requireExactKeys(raw, ENROLLMENT_KEYS, "enrollment sentinel");
  if (raw.version !== ENROLLMENT_VERSION) {
    fail(ADMISSIONS_CORRUPT, `unsupported enrollment version ${describe(raw.version)} (this build understands v${ENROLLMENT_VERSION})`);
  }
  if (raw.managed !== true) fail(ADMISSIONS_CORRUPT, "enrollment sentinel must carry managed=true");
  isoOrNull(raw.managedSince, "enrollment.managedSince");
  if (raw.managedSince === null) fail(ADMISSIONS_CORRUPT, "enrollment.managedSince must be an ISO-8601 timestamp");
  if (!Number.isInteger(raw.revision) || raw.revision < 0) {
    fail(ADMISSIONS_CORRUPT, `enrollment.revision must be a non-negative integer, got ${describe(raw.revision)}`);
  }
  if (!isPlainObject(raw.bindings)) fail(ADMISSIONS_CORRUPT, `enrollment.bindings must be an object, got ${describe(raw.bindings)}`);
  const ids = Object.keys(raw.bindings);
  if (ids.length > MAX_ADMISSION_ENTRIES) {
    fail(ADMISSIONS_CAPACITY_EXCEEDED, `enrollment holds ${ids.length} bindings, above the ${MAX_ADMISSION_ENTRIES} capacity guard: refusing to load`);
  }
  for (const id of ids) {
    if (!isValidVaultId(id)) fail(ADMISSIONS_CORRUPT, `enrollment.bindings key ${describe(id)} is not a canonical Vault ID`);
    const binding = raw.bindings[id];
    if (!isPlainObject(binding)) fail(ADMISSIONS_CORRUPT, `enrollment.bindings[${JSON.stringify(id)}] must be an object`);
    requireExactKeys(binding, ENROLLMENT_BINDING_KEYS, `enrollment.bindings[${JSON.stringify(id)}]`);
    if (!isVaultIdentity(binding.identity)) {
      fail(ADMISSIONS_CORRUPT, `enrollment.bindings[${JSON.stringify(id)}].identity is not a valid v1 identity record`);
    }
    if (!Number.isInteger(binding.generation) || binding.generation < 1) {
      fail(ADMISSIONS_CORRUPT, `enrollment.bindings[${JSON.stringify(id)}].generation must be a positive integer, got ${describe(binding.generation)}`);
    }
    isoOrNull(binding.enrolledAt, `enrollment.bindings[${JSON.stringify(id)}].enrolledAt`);
  }
  return raw;
}

/** A record that is behind the durable sentinel floor: refuse it rather than trust an older approval. */
export const ADMISSIONS_RECOVERY_REQUIRED = "VAULT_ADMISSIONS_RECOVERY_REQUIRED";

/**
 * Cross-check: a record and the sentinel may never disagree about an id they both carry, and the
 * record may never be BEHIND the sentinel's durable floors (W2FIX3 item 2).
 *
 * Frozen conservative recovery rule: the sentinel is written BEFORE the record, so
 * `sentinel.revision > record.revision` (or `binding.generation > entry.generation`) means a mutation
 * was durably announced but its record write did not land. The stale record's `approved` is then NOT
 * the current authorization — the store refuses the read-back (fail closed, file untouched) instead
 * of serving an older decision. A later explicit operator mutation re-floors the record.
 */
export function assertEnrollmentAgreesWithRecord(record, enrollment) {
  if (enrollment === null || enrollment === undefined) return;
  if (Number.isInteger(enrollment.revision) && record.revision < enrollment.revision) {
    fail(
      ADMISSIONS_RECOVERY_REQUIRED,
      `the admission record is at revision ${record.revision} but the managed-mode sentinel already witnessed revision ` +
        `${enrollment.revision}: a mutation was announced but its record write did not land. Refusing to read back an older ` +
        "record (its approvals are not the current authorization, contract §2.2/item 2)",
    );
  }
  for (const [id, entry] of Object.entries(record?.entries ?? {})) {
    const binding = enrollment.bindings?.[id];
    if (binding === undefined) continue;
    if (entry.identity !== null && entry.identity.digest !== binding.identity.digest) {
      fail(
        ADMISSIONS_CORRUPT,
        `the admission record and the managed-mode sentinel disagree on the identity binding of ${describe(id)}: refusing to start with a ` +
          "partially applied commit (contract §2.2/§3.1)",
      );
    }
    if (Number.isInteger(binding.generation) && entry.generation < binding.generation) {
      fail(
        ADMISSIONS_RECOVERY_REQUIRED,
        `the admission record holds generation ${entry.generation} for ${describe(id)} but the managed-mode sentinel already witnessed ` +
          `generation ${binding.generation}: refusing to treat the older approval as the current authorization (contract §2.2/item 2)`,
      );
    }
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export const cloneAdmissionState = (value) => deepFreeze(JSON.parse(JSON.stringify(value)));

/** Deep-frozen clone of a validated enrollment sentinel. */
export const cloneEnrollmentState = (value) => deepFreeze(JSON.parse(JSON.stringify(value)));

/** Re-exported for the store's `initialize()` identity-binding check (contract §3.1). */
export { assertVaultIdentity };

/**
 * Persisted projection of a registry snapshot (contract §2.2 `registry`). Only the facts needed to
 * re-verify an admission decision are stored (id/root/canonicalRoot/primary/writable/identity);
 * capabilities and runtime handles are deliberately NOT persisted.
 */
export function serializeRegistrySnapshot(snapshot, entries = {}) {
  if (snapshot === null || typeof snapshot !== "object") return { vaults: {}, skipped: [] };
  const identities = snapshot.identities ?? {};
  const vaults = {};
  for (const vault of snapshot.vaults ?? []) {
    // A refused structural primary remains in the snapshot. Persist its ORIGINAL binding,
    // never the replacement observation/null; runtime readiness is reconstructed after restart.
    const bound = snapshot.admissions?.[vault.id]?.admitted === false ? entries[vault.id]?.identity : null;
    vaults[vault.id] = {
      id: vault.id,
      root: vault.root,
      canonicalRoot: vault.canonicalRoot ?? null,
      primary: vault.primary === true,
      writable: vault.writable === true,
      identity: bound ?? identities[vault.id] ?? vault.identity ?? null,
    };
  }
  return { vaults, skipped: [] };
}
