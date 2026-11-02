// Per-vault GitConfig document schema and effective-config resolution for the
// MCP multi-Vault track, Wave A / A5.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
// §15.1/§15.2 (shape + hard bounds), §15.4/§38.1 (primary/secondary
// inheritance), §42 SEC-MV04 (no secrets in the store), §43.5/§43.11
// (architecture gates).
//
// This module is pure: no I/O, no clock, no ambient environment access, and
// never an import of `config.js` (contract §43.5). Callers pass the `GIT_*`
// baseline in explicitly, so the inheritance matrix is testable without ambient
// state. The store (`store.js`) owns durability; this module owns the frozen
// document shape, the hard bounds and the inheritance matrix.

export const GIT_CONFIG_SCHEMA = 1;

// Registry bound (contract §4.3): more records than this fail closed. The store
// never silently truncates.
export const MAX_VAULT_RECORDS = 64;

export const GIT_CONFIG_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  maxVaultRecords: MAX_VAULT_RECORDS,
  vaultIdMaxLength: 80, // contract §3.2
  remoteMaxLength: 128, // contract §15.2
  branchMaxLength: 240, // contract §15.2
  debounceSecondsMin: 5, // contract §15.2
  debounceSecondsMax: 86400,
  maxDelaySecondsMin: 1, // contract §15.2
  maxDelaySecondsMax: 86400,
  sweepIntervalSecondsMin: 30, // contract §15.2
  sweepIntervalSecondsMax: 604800,
});

export const GIT_CONFIG_CODES = Object.freeze({
  INVALID_DOCUMENT: "git_config_invalid_document",
  INVALID_RECORD: "git_config_invalid_record",
  INVALID_VAULT_ID: "git_config_invalid_vault_id",
  UNSUPPORTED_SCHEMA: "git_config_unsupported_schema",
  LIMIT_EXCEEDED: "git_config_limit_exceeded",
  STORE_IO: "git_config_store_io_error",
  STALE_REVISION: "git_config_stale_revision",
});

export class GitConfigError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "GitConfigError";
    this.code = code;
    this.details = options.details;
  }
}

export function isGitConfigError(error) {
  return error instanceof GitConfigError
    || (Boolean(error) && typeof error.code === "string" && Object.values(GIT_CONFIG_CODES).includes(error.code));
}

// Frozen canonical key order of one persisted record (contract §15.1).
export const GIT_CONFIG_RECORD_KEYS = Object.freeze([
  "enabled",
  "autoCommit",
  "autoPush",
  "autoCommitSweep",
  "debounceSeconds",
  "maxDelaySeconds",
  "sweepIntervalSeconds",
  "remote",
  "branch",
  "updatedAt",
]);

// Concrete values a fresh record (and a missing env baseline field) falls back
// to. The numeric/name values mirror the current `GIT_*` defaults (config.js
// §45-55) so primary `env-default` and persisted records agree, but nothing is
// imported here.
export const GIT_CONFIG_RECORD_DEFAULTS = Object.freeze({
  enabled: false,
  autoCommit: false,
  autoPush: false,
  autoCommitSweep: false,
  debounceSeconds: 180,
  maxDelaySeconds: 900,
  sweepIntervalSeconds: 900,
  remote: "origin",
  branch: "",
});

export const GIT_CONFIG_SOURCES = Object.freeze({
  ENV_DEFAULT: "env-default",
  PERSISTED: "persisted",
  DEFAULT_DISABLED: "default-disabled",
});

const DOCUMENT_KEYS = Object.freeze(["schema", "revision", "vaults"]);
const DOCUMENT_KEY_SET = new Set(DOCUMENT_KEYS);
const RECORD_KEY_SET = new Set(GIT_CONFIG_RECORD_KEYS);
// `updatedAt` is store-stamped, so a caller-supplied env baseline has no slot
// for it.
const BASELINE_KEYS = Object.freeze(GIT_CONFIG_RECORD_KEYS.filter((key) => key !== "updatedAt"));
const BASELINE_KEY_SET = new Set(BASELINE_KEYS);

const BOOLEAN_FIELDS = Object.freeze(["enabled", "autoCommit", "autoPush", "autoCommitSweep"]);
// Store-side key guard only. The canonical Vault ID authority is A1
// (`vault-runtime/descriptor.js`, contract §3.2); this module cannot import the
// Web registry because that module imports `config.js`.
const VAULT_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u;
// Plain git short names: no scheme, no credential separator, no whitespace or
// control characters, no parent segment, no leading dash.
const REF_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// `path`/`reason` carry a field path and a static reason only: an error message
// must never echo document content (the store holds operator configuration).
function fail(code, path, reason) {
  const where = path ? ` at ${path}` : "";
  throw new GitConfigError(code, `${reason}${where}`, { details: { path } });
}

function rejectUnknownKeys(record, allowed, path, code) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(code, path ? `${path}.${key}` : key, "unknown field");
  }
}

function requireBoolean(raw, path, label) {
  if (typeof raw !== "boolean") fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must be boolean`);
  return raw;
}

function requireInteger(raw, path, label, min, max) {
  if (!Number.isInteger(raw)) fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must be an integer`);
  if (raw < min || raw > max) fail(GIT_CONFIG_CODES.LIMIT_EXCEEDED, path, `${label} outside the allowed range`);
  return raw;
}

function normalizeInstant(raw, path, label) {
  const millis = typeof raw === "string" && raw.length > 0 ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(millis)) fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must be an ISO instant`);
  return new Date(millis).toISOString();
}

// A git ref/remote *name*, never a URL and never a credential-bearing
// `user@host:path` form (contract §15.2, §42 SEC-MV04).
function normalizeRefName(raw, path, label, maxLength, allowEmpty) {
  if (typeof raw !== "string") fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must be a string`);
  if (raw.length > maxLength) fail(GIT_CONFIG_CODES.LIMIT_EXCEEDED, path, `${label} too long`);
  if (raw.length === 0) {
    if (allowEmpty) return "";
    fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must not be empty`);
  }
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must be control-character free`);
  if (raw.includes("://")) fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must not be a URL`);
  if (raw.includes("@") || raw.includes(":")) fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must not carry credentials`);
  if (raw.startsWith("-")) fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must not start with a dash`);
  if (raw.includes("..")) fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must not contain a parent segment`);
  if (!REF_NAME_PATTERN.test(raw)) fail(GIT_CONFIG_CODES.INVALID_RECORD, path, `${label} must be a plain git name`);
  return raw;
}

export function isValidGitConfigVaultId(value) {
  if (typeof value !== "string" || value.length < 1) return false;
  if (value.length > GIT_CONFIG_LIMITS.vaultIdMaxLength) return false;
  if (value === "." || value === "..") return false;
  return VAULT_ID_PATTERN.test(value);
}

// Normalizes one complete record. Every key is required: callers merge patches
// over `GIT_CONFIG_RECORD_DEFAULTS` (or over the committed record) first, so a
// half-filled record can never reach disk.
export function normalizeGitConfigRecord(raw, path = "record") {
  if (!isRecord(raw)) fail(GIT_CONFIG_CODES.INVALID_RECORD, path, "record must be an object");
  rejectUnknownKeys(raw, RECORD_KEY_SET, path, GIT_CONFIG_CODES.INVALID_RECORD);
  for (const key of GIT_CONFIG_RECORD_KEYS) {
    if (raw[key] === undefined) fail(GIT_CONFIG_CODES.INVALID_RECORD, `${path}.${key}`, "missing field");
  }
  return {
    enabled: requireBoolean(raw.enabled, `${path}.enabled`, "enabled"),
    autoCommit: requireBoolean(raw.autoCommit, `${path}.autoCommit`, "autoCommit"),
    autoPush: requireBoolean(raw.autoPush, `${path}.autoPush`, "autoPush"),
    autoCommitSweep: requireBoolean(raw.autoCommitSweep, `${path}.autoCommitSweep`, "autoCommitSweep"),
    debounceSeconds: requireInteger(
      raw.debounceSeconds, `${path}.debounceSeconds`, "debounceSeconds",
      GIT_CONFIG_LIMITS.debounceSecondsMin, GIT_CONFIG_LIMITS.debounceSecondsMax,
    ),
    maxDelaySeconds: requireInteger(
      raw.maxDelaySeconds, `${path}.maxDelaySeconds`, "maxDelaySeconds",
      GIT_CONFIG_LIMITS.maxDelaySecondsMin, GIT_CONFIG_LIMITS.maxDelaySecondsMax,
    ),
    sweepIntervalSeconds: requireInteger(
      raw.sweepIntervalSeconds, `${path}.sweepIntervalSeconds`, "sweepIntervalSeconds",
      GIT_CONFIG_LIMITS.sweepIntervalSecondsMin, GIT_CONFIG_LIMITS.sweepIntervalSecondsMax,
    ),
    remote: normalizeRefName(raw.remote, `${path}.remote`, "remote", GIT_CONFIG_LIMITS.remoteMaxLength, false),
    branch: normalizeRefName(raw.branch, `${path}.branch`, "branch", GIT_CONFIG_LIMITS.branchMaxLength, true),
    updatedAt: normalizeInstant(raw.updatedAt, `${path}.updatedAt`, "updatedAt"),
  };
}

// Builds a complete record from defaults, an optional existing record and a
// patch, then validates it. `updatedAt` is always supplied by the caller.
export function buildGitConfigRecord({ patch, base, updatedAt } = {}) {
  const seed = { ...GIT_CONFIG_RECORD_DEFAULTS, ...(base ?? {}) };
  if (patch !== undefined && patch !== null) {
    if (!isRecord(patch)) fail(GIT_CONFIG_CODES.INVALID_RECORD, "patch", "patch must be an object");
    rejectUnknownKeys(patch, RECORD_KEY_SET, "patch", GIT_CONFIG_CODES.INVALID_RECORD);
    Object.assign(seed, patch);
  }
  seed.updatedAt = updatedAt;
  return normalizeGitConfigRecord(seed);
}

function normalizeVaultMap(raw, path) {
  if (!isRecord(raw)) fail(GIT_CONFIG_CODES.INVALID_DOCUMENT, path, "vaults must be an object");
  const ids = Object.keys(raw);
  if (ids.length > GIT_CONFIG_LIMITS.maxVaultRecords) fail(GIT_CONFIG_CODES.LIMIT_EXCEEDED, path, "too many vault records");
  const vaults = {};
  for (const id of ids.sort()) {
    if (!isValidGitConfigVaultId(id)) fail(GIT_CONFIG_CODES.INVALID_VAULT_ID, `${path}.${id}`, "invalid vault id");
    vaults[id] = normalizeGitConfigRecord(raw[id], `${path}.${id}`);
  }
  return vaults;
}

export function validateGitConfigDocument(document) {
  if (!isRecord(document)) fail(GIT_CONFIG_CODES.INVALID_DOCUMENT, "", "document must be an object");
  if (document.schema !== GIT_CONFIG_SCHEMA) fail(GIT_CONFIG_CODES.UNSUPPORTED_SCHEMA, "schema", "unsupported schema version");
  rejectUnknownKeys(document, DOCUMENT_KEY_SET, "", GIT_CONFIG_CODES.INVALID_DOCUMENT);
  if (!Number.isInteger(document.revision) || document.revision < 0) {
    fail(GIT_CONFIG_CODES.INVALID_DOCUMENT, "revision", "revision must be a non-negative integer");
  }
  return {
    schema: GIT_CONFIG_SCHEMA,
    revision: document.revision,
    vaults: normalizeVaultMap(document.vaults, "vaults"),
  };
}

export function parseGitConfigDocument(raw) {
  try {
    if (typeof raw === "string") {
      if (Buffer.byteLength(raw, "utf8") > GIT_CONFIG_LIMITS.fileBytes) {
        return { ok: false, code: GIT_CONFIG_CODES.LIMIT_EXCEEDED, detail: "document exceeds the size limit" };
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, code: GIT_CONFIG_CODES.INVALID_DOCUMENT, detail: "invalid JSON document" };
      }
      return { ok: true, document: validateGitConfigDocument(parsed) };
    }
    return { ok: true, document: validateGitConfigDocument(raw) };
  } catch (error) {
    if (isGitConfigError(error)) return { ok: false, code: error.code, detail: error.details?.path || error.message };
    return { ok: false, code: GIT_CONFIG_CODES.INVALID_DOCUMENT, detail: "unexpected validation failure" };
  }
}

export function serializeGitConfigDocument(document) {
  const normalized = validateGitConfigDocument(document);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

// A caller-supplied `GIT_*` baseline. Only the record fields minus `updatedAt`
// are accepted; unknown keys (for example a `token`) fail closed.
function normalizeBaseline(raw, path) {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) fail(GIT_CONFIG_CODES.INVALID_RECORD, path, "env defaults must be an object");
  rejectUnknownKeys(raw, BASELINE_KEY_SET, path, GIT_CONFIG_CODES.INVALID_RECORD);
  const baseline = {};
  for (const key of BOOLEAN_FIELDS) {
    if (raw[key] !== undefined) baseline[key] = requireBoolean(raw[key], `${path}.${key}`, key);
  }
  if (raw.debounceSeconds !== undefined) baseline.debounceSeconds = requireInteger(raw.debounceSeconds, `${path}.debounceSeconds`, "debounceSeconds", GIT_CONFIG_LIMITS.debounceSecondsMin, GIT_CONFIG_LIMITS.debounceSecondsMax);
  if (raw.maxDelaySeconds !== undefined) baseline.maxDelaySeconds = requireInteger(raw.maxDelaySeconds, `${path}.maxDelaySeconds`, "maxDelaySeconds", GIT_CONFIG_LIMITS.maxDelaySecondsMin, GIT_CONFIG_LIMITS.maxDelaySecondsMax);
  if (raw.sweepIntervalSeconds !== undefined) baseline.sweepIntervalSeconds = requireInteger(raw.sweepIntervalSeconds, `${path}.sweepIntervalSeconds`, "sweepIntervalSeconds", GIT_CONFIG_LIMITS.sweepIntervalSecondsMin, GIT_CONFIG_LIMITS.sweepIntervalSecondsMax);
  if (raw.remote !== undefined) baseline.remote = normalizeRefName(raw.remote, `${path}.remote`, "remote", GIT_CONFIG_LIMITS.remoteMaxLength, false);
  if (raw.branch !== undefined) baseline.branch = normalizeRefName(raw.branch, `${path}.branch`, "branch", GIT_CONFIG_LIMITS.branchMaxLength, true);
  return baseline;
}

function effectiveResult(vaultId, primary, values, source, updatedAt) {
  return Object.freeze({
    vaultId,
    primary,
    enabled: values.enabled,
    autoCommit: values.autoCommit,
    autoPush: values.autoPush,
    autoCommitSweep: values.autoCommitSweep,
    debounceSeconds: values.debounceSeconds,
    maxDelaySeconds: values.maxDelaySeconds,
    sweepIntervalSeconds: values.sweepIntervalSeconds,
    remote: values.remote,
    branch: values.branch,
    updatedAt: updatedAt ?? null,
    source,
  });
}

// Contract §15.4 / §38.1 inheritance matrix.
//
//   primary   + record    -> persisted (persisted wins over env)
//   primary   + no record -> env-default (effective == the GIT_* baseline)
//   secondary + record    -> persisted
//   secondary + no record -> default-disabled (every toggle forced false; the
//                            timing/remote/branch values stay displayable)
//
// `envDefaults` is the caller's `GIT_*` mapping. This module never reads the
// environment itself.
export function resolveEffectiveGitConfig({ vaultId, primary, record, envDefaults } = {}) {
  if (!isValidGitConfigVaultId(vaultId)) fail(GIT_CONFIG_CODES.INVALID_VAULT_ID, "vaultId", "invalid vault id");
  if (typeof primary !== "boolean") fail(GIT_CONFIG_CODES.INVALID_DOCUMENT, "primary", "primary must be boolean");
  const baseline = normalizeBaseline(envDefaults, "envDefaults");
  const persisted = record === undefined || record === null ? null : normalizeGitConfigRecord(record, "record");
  const values = { ...GIT_CONFIG_RECORD_DEFAULTS, ...baseline, ...(persisted ?? {}) };
  if (persisted) return effectiveResult(vaultId, primary, values, GIT_CONFIG_SOURCES.PERSISTED, persisted.updatedAt);
  if (primary) return effectiveResult(vaultId, primary, values, GIT_CONFIG_SOURCES.ENV_DEFAULT, null);
  return effectiveResult(vaultId, primary, Object.freeze({
    ...values,
    enabled: false,
    autoCommit: false,
    autoPush: false,
    autoCommitSweep: false,
  }), GIT_CONFIG_SOURCES.DEFAULT_DISABLED, null);
}
