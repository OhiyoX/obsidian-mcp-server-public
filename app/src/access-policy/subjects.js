// AuthZ Wave A / A2 — runtime identity -> policy subject normalization.
//
// Pure module: no I/O, no clock, no module-level mutable state. It maps an
// already-authenticated runtime identity onto the frozen subject namespace of
// `scratch/authz/INTERFACE.md` §5. It never reads username/displayName/token
// and never derives a subject from a secret or a hash.

/** Frozen subject types (INTERFACE §5.1). */
export const SUBJECT_TYPES = Object.freeze(["api-key", "oauth-client", "oauth-user"]);

/** The one sentinel subject: the operator-configured environment API key. */
export const CONFIGURED_ENV_SUBJECT = "api-key:configured-env";

const CONFIGURED_ENV_KEY_ID = "configured-env";
const MAX_ID_LENGTH = 160;
const SUBJECT_TYPE_SET = new Set(SUBJECT_TYPES);
// An id is 1..160 characters with no whitespace, no control character and no
// wildcard. A subject must never become a pattern.
const INVALID_ID_PATTERN = /[\s\u0000-\u001f\u007f*]/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function isValidId(id) {
  return id.length >= 1 && id.length <= MAX_ID_LENGTH && !INVALID_ID_PATTERN.test(id);
}

/**
 * Parse `<type>:<id>` into `{ type, id }`, or `null` when the subject is not a
 * frozen-namespace subject. Missing/empty ids, whitespace, control characters
 * and `*` are rejected: fail closed, never wildcard.
 */
export function parseSubject(subject) {
  if (typeof subject !== "string") return null;
  const separator = subject.indexOf(":");
  if (separator < 1) return null;
  const type = subject.slice(0, separator);
  if (!SUBJECT_TYPE_SET.has(type)) return null;
  const id = subject.slice(separator + 1);
  if (!isValidId(id)) return null;
  return { type, id };
}

export function isValidSubject(subject) {
  return parseSubject(subject) !== null;
}

// Candidates are fenced here: every returned subject must be a valid frozen
// subject. An empty/absent id can therefore never surface as `oauth-user:`,
// `oauth-client:` or `api-key:` (no wildcard, fail closed).
function finalize(candidates) {
  const unique = new Set();
  for (const candidate of candidates) {
    if (isValidSubject(candidate)) unique.add(candidate);
  }
  return [...unique].sort();
}

function apiKeySubject(keyId) {
  const id = text(keyId);
  return id === CONFIGURED_ENV_KEY_ID ? CONFIGURED_ENV_SUBJECT : `api-key:${id}`;
}

function oauthClientSubject(clientId) {
  return `oauth-client:${text(clientId)}`;
}

function oauthUserSubject(userId) {
  return `oauth-user:${text(userId)}`;
}

/** `req.auth` shape (app/src/auth.js). */
export function subjectsFromMcpAuth(auth) {
  if (!isRecord(auth)) return [];
  if (text(auth.type) === "api-key") return finalize([apiKeySubject(auth.keyId)]);
  return finalize([oauthClientSubject(auth.clientId), oauthUserSubject(auth.userId)]);
}

/** MCP `extra.authInfo` shape (SDK fields plus `extra.*` carried by this app). */
export function subjectsFromAuthInfo(authInfo) {
  if (!isRecord(authInfo)) return [];
  const extra = isRecord(authInfo.extra) ? authInfo.extra : {};
  const type = text(authInfo.type) || text(extra.type);
  if (type === "api-key") return finalize([apiKeySubject(firstText(authInfo.keyId, extra.keyId))]);
  return finalize([
    oauthClientSubject(firstText(authInfo.clientId, extra.clientId)),
    oauthUserSubject(firstText(authInfo.userId, extra.userId)),
  ]);
}

/** `req.webSession` shape (app/src/app/web-session-resolve.js). */
export function subjectsFromWebSession(session) {
  if (!isRecord(session)) return [];
  return finalize([oauthUserSubject(session.userId)]);
}

/** Direct OAuth record mapping: client-only, or client + user token. */
export function subjectsFromOAuthRecord(clientId, userId) {
  return finalize([oauthClientSubject(clientId), oauthUserSubject(userId)]);
}
