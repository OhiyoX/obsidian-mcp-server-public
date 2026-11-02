// Access-policy error taxonomy for AuthZ Wave A (A1).
//
// The string values below are frozen contract: they are the client-visible
// policy codes (DEVELOPMENT §15 / §10.4) and the Admin HTTP 409 code. Do not
// rename or re-map them; adapters (Wave B) map codes to transport shapes.

export const ACCESS_POLICY_CODES = Object.freeze({
  INVALID_DOCUMENT: "invalid_access_policy",
  INVALID_POLICY: "invalid_access_policy_record",
  UNSUPPORTED_SCHEMA: "unsupported_access_policy_schema",
  LIMIT_EXCEEDED: "access_policy_limit_exceeded",
  UNKNOWN_SUBJECT: "unknown_access_policy_subject",
  UNKNOWN_CAPABILITY: "unknown_access_policy_capability",
  INVALID_TIMEZONE: "invalid_access_policy_timezone",
  INVALID_WINDOW: "invalid_access_policy_window",
  REVOKE_REQUIRES_ALL: "revoke_requires_all_capability",
  STALE_REVISION: "stale_policy_revision",
  STORE_IO: "access_policy_store_io_error",
});

export const ACCESS_DENY_CODES = Object.freeze({
  OUTSIDE_WINDOW: "outside_authorized_window",
  POLICY_UNAVAILABLE: "authorization_policy_unavailable",
});

export class AccessPolicyError extends Error {
  constructor(code, message, { details } = {}) {
    super(message ?? code);
    this.name = "AccessPolicyError";
    this.code = code;
    this.details = details;
  }
}

export function isAccessPolicyError(value) {
  return value instanceof AccessPolicyError
    || (value instanceof Error && value.name === "AccessPolicyError" && typeof value.code === "string");
}
