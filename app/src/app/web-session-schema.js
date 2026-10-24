import { createHash } from "node:crypto";

export const WEB_SESSION_COOKIE = "obsidian_web_session";
export const WEB_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const WEB_SESSION_CHECKPOINT_MS = 60 * 1000;
export const WEB_SESSION_SCHEMA_VERSION = 1;
export const MAX_WEB_SESSION_RECORDS = 10_000;
export const MAX_WEB_SESSION_FILE_BYTES = 32 * 1024 * 1024;
export const WEB_SESSION_TOP_LEVEL_KEYS = ["version", "sessions"];

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECORD_KEYS = ["userId", "userUpdatedAt", "csrf", "vaultId", "createdAt", "expiresAt", "lastSeenAt"];
const FIELD_BOUNDS = { userId: 1024, userUpdatedAt: 64, csrf: 256, vaultId: 1024 };

export class WebSessionStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WebSessionStoreError";
    this.code = code;
    this.webSessionStoreFailure = true;
  }
}

export function isValidWebSessionToken(value) {
  if (typeof value !== "string" || !RAW_TOKEN_PATTERN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    // Round-trip check: reject non-canonical 43-char encodings that decode to 32
    // bytes but could not have been produced by randomBytes(32).toString("base64url").
    return bytes.length === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function hashWebSessionToken(rawToken) {
  return createHash("sha256").update(String(rawToken), "utf8").digest("hex");
}

const utf8Length = (value) => Buffer.byteLength(String(value), "utf8");

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Strict record validation. Any deviation fails the whole store closed. */
export function validateRecord(tokenHash, record) {
  if (!HASH_PATTERN.test(tokenHash)) throw new WebSessionStoreError("invalid_key", "Web session key must be a lowercase SHA-256 hex digest");
  if (!isPlainObject(record)) throw new WebSessionStoreError("invalid_record", "Web session record must be an object");
  const keys = Object.keys(record);
  for (const key of keys) {
    if (!RECORD_KEYS.includes(key)) throw new WebSessionStoreError("invalid_record", `Web session record has unsupported field: ${key}`);
  }
  for (const key of RECORD_KEYS) {
    if (!(key in record)) throw new WebSessionStoreError("invalid_record", `Web session record is missing field: ${key}`);
  }
  for (const key of ["userId", "userUpdatedAt", "csrf", "vaultId"]) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0 || utf8Length(value) > FIELD_BOUNDS[key]) {
      throw new WebSessionStoreError("invalid_record", `Web session field ${key} is not a bounded non-empty string`);
    }
  }
  for (const key of ["createdAt", "expiresAt", "lastSeenAt"]) {
    if (!isValidTimestamp(record[key])) throw new WebSessionStoreError("invalid_record", `Web session field ${key} is not a finite timestamp`);
  }
  if (!(record.createdAt <= record.lastSeenAt && record.lastSeenAt <= record.expiresAt)) {
    throw new WebSessionStoreError("invalid_record", "Web session timestamps must satisfy createdAt <= lastSeenAt <= expiresAt");
  }
  return {
    userId: record.userId,
    userUpdatedAt: record.userUpdatedAt,
    csrf: record.csrf,
    vaultId: record.vaultId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastSeenAt: record.lastSeenAt,
  };
}
