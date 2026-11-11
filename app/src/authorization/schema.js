// P1 / Task 3 — strict authorization document schema (design §5, §8).
//
// One data boundary for `<DATA_PATH>/authorization.json`: the exact document
// shape, the frozen limits and the JSON text rules. It decides nothing, reads no
// clock and performs no I/O; `catalog.js` supplies the capability vocabulary and
// `access-policy` supplies the subject, timezone and window rules that already
// exist. A shape the design does not name is refused, a limit is refused instead
// of truncated, and a missing `grants` is never filled in.
//
// Two readings of design §5.1 hold at the same time and are kept apart here:
//   * a capability that is *known* must be grantable and must match the grant
//     target kind, otherwise the document is invalid;
//   * a capability ID that is *unknown* but well formed is kept as written: the
//     catalog only grows, so such an ID is refused where it is used
//     (`operation_unknown`), and it must never hurt the subject's other
//     capabilities or the rest of the document.
// Therefore only the ID shape is a syntax gate, and `authorizationOperation(id)`
// staying `null` is the authorization gate (evaluate.js, a later task).

import { isPolicyId } from "../access-policy/schema.js";
import { isValidSubject } from "../access-policy/subjects.js";
import { WEEKDAYS, isValidTimeZone } from "../access-policy/time.js";
import { isValidVaultId } from "../vault-runtime/descriptor.js";
import { AUTHORIZATION_CATALOG_VERSION, authorizationOperation, catalogOperationIds } from "./catalog.js";

export const AUTHORIZATION_SCHEMA_VERSION = 1;

export const AUTHORIZATION_CODES = Object.freeze({
  INVALID_DOCUMENT: "invalid_authorization_document",
  LIMIT_EXCEEDED: "authorization_limit_exceeded",
  UNSUPPORTED_SCHEMA: "unsupported_authorization_schema",
  // Design §9: a broken, unreadable or too-new state is never interpreted.
  STATE_UNAVAILABLE: "authorization_state_unavailable",
});

const { INVALID_DOCUMENT, LIMIT_EXCEEDED, UNSUPPORTED_SCHEMA, STATE_UNAVAILABLE } = AUTHORIZATION_CODES;

export const AUTHORIZATION_LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  subjects: 10000,
  targetsPerSubject: 65,
  capabilitiesPerGrant: catalogOperationIds.length,
  constraints: 512,
  subjectsPerConstraint: 32,
  selectorBranches: 64,
  capabilitiesPerBranch: 128,
  targetsPerBranch: 65,
  weeklyIntervals: 64,
  dateRanges: 64,
  labelMaxLength: 120,
  timezoneMaxLength: 80,
});

const DOCUMENT_KEYS = Object.freeze([
  "schemaVersion", "catalogVersion", "revision", "timeConstraintsEnabled", "subjects", "constraints",
]);
const SUBJECT_KEYS = Object.freeze(["credentialEpoch", "grants"]);
const GRANT_KEYS = Object.freeze(["target", "capabilities"]);
const VAULT_TARGET_KEYS = Object.freeze(["kind", "vaultId"]);
const INSTANCE_TARGET_KEYS = Object.freeze(["kind"]);
const CONSTRAINT_KEYS = Object.freeze([
  "id", "label", "enabled", "subjects", "mode", "selector", "schedule", "createdAt", "updatedAt",
]);
const SELECTOR_KEYS = Object.freeze(["anyOf"]);
const BRANCH_KEYS = Object.freeze(["surfaces", "capabilities", "targets"]);
const SCHEDULE_KEYS = Object.freeze(["timezone", "weekly", "dateRanges", "startsAt", "expiresAt"]);
const DATE_RANGE_KEYS = Object.freeze(["from", "to"]);

const MODES = new Set(["suspend", "revoke"]);
const WEEKDAY_SET = new Set(WEEKDAYS);

// The surface vocabulary is the one the catalog describes; it is derived, never
// restated, so a new surface cannot appear in a selector before it exists.
const SURFACES = new Set(catalogOperationIds.flatMap((id) => authorizationOperation(id).surfaces));

const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
// Mirrors `access-policy/schema.js` (not exported there); the new schedule reuses
// the same window algebra, so the same clock shapes are accepted.
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const START_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_PATTERN = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// `path` is a field path only: an error message must never echo document content.
function fail(code, path, reason) {
  const error = new Error(`${reason}${path ? ` at ${path}` : ""}`);
  error.name = "AuthorizationDocumentError";
  error.code = code;
  error.path = path;
  throw error;
}

function assertShape(value, keys, path, code = INVALID_DOCUMENT) {
  if (!isRecord(value)) fail(code, path, "must be an object");
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, path ? `${path}.${key}` : key, "unknown field");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(code, path ? `${path}.${key}` : key, "missing field");
  }
}

function normalizeInstant(value, path) {
  const millis = typeof value === "string" && value.length > 0 ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis)) fail(INVALID_DOCUMENT, path, "invalid ISO instant");
  return new Date(millis).toISOString();
}

function normalizeInstantOrNull(value, path) {
  return value === null ? null : normalizeInstant(value, path);
}

function isCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function normalizeSubjectIdList(raw, path, limit) {
  if (!Array.isArray(raw)) fail(INVALID_DOCUMENT, path, "must be an array");
  if (raw.length > limit) fail(LIMIT_EXCEEDED, path, "too many subjects");
  const seen = new Set();
  raw.forEach((value, index) => {
    if (!isValidSubject(value)) fail(INVALID_DOCUMENT, `${path}[${index}]`, "invalid subject id");
    if (seen.has(value)) fail(INVALID_DOCUMENT, `${path}[${index}]`, "duplicate subject");
    seen.add(value);
  });
  return [...seen].sort();
}

// A grant capability must be a well-formed ID, unique in the row, and — when the
// catalog knows it — grantable and on a matching target kind. An unknown, well
// formed ID is kept for the evaluation step to refuse.
function normalizeGrantCapabilities(raw, path, targetKind) {
  if (!Array.isArray(raw)) fail(INVALID_DOCUMENT, path, "capabilities must be an array");
  if (raw.length > AUTHORIZATION_LIMITS.capabilitiesPerGrant) fail(LIMIT_EXCEEDED, path, "too many capabilities");
  const seen = new Set();
  raw.forEach((value, index) => {
    if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) fail(INVALID_DOCUMENT, `${path}[${index}]`, "invalid capability id");
    if (seen.has(value)) fail(INVALID_DOCUMENT, `${path}[${index}]`, "duplicate capability");
    const operation = authorizationOperation(value);
    if (operation !== null) {
      if (!operation.grantable) fail(INVALID_DOCUMENT, `${path}[${index}]`, "capability is not grantable");
      if (operation.targetKind !== targetKind) fail(INVALID_DOCUMENT, `${path}[${index}]`, "capability does not match the grant target");
    }
    seen.add(value);
  });
  return [...seen].sort();
}

function normalizeSelectorCapabilities(raw, path) {
  if (!Array.isArray(raw)) fail(INVALID_DOCUMENT, path, "capabilities must be an array");
  if (raw.length > AUTHORIZATION_LIMITS.capabilitiesPerBranch) fail(LIMIT_EXCEEDED, path, "too many capabilities");
  const seen = new Set();
  raw.forEach((value, index) => {
    if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) fail(INVALID_DOCUMENT, `${path}[${index}]`, "invalid capability id");
    if (seen.has(value)) fail(INVALID_DOCUMENT, `${path}[${index}]`, "duplicate capability");
    seen.add(value);
  });
  return [...seen].sort();
}

function normalizeSurfaces(raw, path) {
  if (!Array.isArray(raw)) fail(INVALID_DOCUMENT, path, "surfaces must be an array");
  if (raw.length > SURFACES.size) fail(LIMIT_EXCEEDED, path, "too many surfaces");
  const seen = new Set();
  raw.forEach((value, index) => {
    if (!SURFACES.has(value)) fail(INVALID_DOCUMENT, `${path}[${index}]`, "unknown surface");
    if (seen.has(value)) fail(INVALID_DOCUMENT, `${path}[${index}]`, "duplicate surface");
    seen.add(value);
  });
  return [...SURFACES].filter((surface) => seen.has(surface));
}

function normalizeTarget(raw, path) {
  if (!isRecord(raw)) fail(INVALID_DOCUMENT, path, "target must be an object");
  if (raw.kind === "instance") {
    assertShape(raw, INSTANCE_TARGET_KEYS, path);
    return { kind: "instance" };
  }
  if (raw.kind === "vault") {
    assertShape(raw, VAULT_TARGET_KEYS, path);
    if (!isValidVaultId(raw.vaultId)) fail(INVALID_DOCUMENT, `${path}.vaultId`, "invalid vault id");
    return { kind: "vault", vaultId: raw.vaultId };
  }
  fail(INVALID_DOCUMENT, `${path}.kind`, "unknown target kind");
}

function targetKey(target) {
  return target.kind === "vault" ? `vault:${target.vaultId}` : "instance";
}

function normalizeGrant(raw, path) {
  assertShape(raw, GRANT_KEYS, path);
  const target = normalizeTarget(raw.target, `${path}.target`);
  return {
    target,
    capabilities: normalizeGrantCapabilities(raw.capabilities, `${path}.capabilities`, target.kind),
  };
}

function normalizeSubject(raw, path, subjectId) {
  assertShape(raw, SUBJECT_KEYS, path);
  const credentialEpoch = raw.credentialEpoch;
  if (!Number.isInteger(credentialEpoch) || credentialEpoch < 0) fail(INVALID_DOCUMENT, `${path}.credentialEpoch`, "epoch must be a non-negative integer");

  // Only an OAuth client may carry `null`, and it means "does not tighten", never
  // "may do everything" (design §5.1).
  if (raw.grants === null) {
    if (!subjectId.startsWith("oauth-client:")) fail(INVALID_DOCUMENT, `${path}.grants`, "only an OAuth client may hold a null ceiling");
    return { credentialEpoch, grants: null };
  }
  if (!Array.isArray(raw.grants)) fail(INVALID_DOCUMENT, `${path}.grants`, "grants must be an array or null");
  if (raw.grants.length > AUTHORIZATION_LIMITS.targetsPerSubject) fail(LIMIT_EXCEEDED, `${path}.grants`, "too many targets");
  const seenTargets = new Set();
  const grants = raw.grants.map((grant, index) => {
    const normalized = normalizeGrant(grant, `${path}.grants[${index}]`);
    const key = targetKey(normalized.target);
    if (seenTargets.has(key)) fail(INVALID_DOCUMENT, `${path}.grants[${index}].target`, "duplicate target");
    seenTargets.add(key);
    return normalized;
  });
  return { credentialEpoch, grants };
}

function normalizeSubjects(raw) {
  if (!isRecord(raw)) fail(INVALID_DOCUMENT, "subjects", "subjects must be an object");
  const ids = Object.keys(raw);
  if (ids.length > AUTHORIZATION_LIMITS.subjects) fail(LIMIT_EXCEEDED, "subjects", "too many subjects");
  const subjects = {};
  ids.forEach((id, index) => {
    if (!isValidSubject(id)) fail(INVALID_DOCUMENT, `subjects[${index}]`, "invalid subject id");
    subjects[id] = normalizeSubject(raw[id], `subjects[${index}]`, id);
  });
  return subjects;
}

function normalizeWeekly(raw, path) {
  if (!isRecord(raw)) fail(INVALID_DOCUMENT, path, "weekly must be an object");
  const byDay = new Map();
  let total = 0;
  for (const key of Object.keys(raw)) {
    if (!WEEKDAY_SET.has(key)) fail(INVALID_DOCUMENT, `${path}.${key}`, "unknown weekday");
    const intervals = raw[key];
    if (!Array.isArray(intervals)) fail(INVALID_DOCUMENT, `${path}.${key}`, "intervals must be an array");
    total += intervals.length;
    if (total > AUTHORIZATION_LIMITS.weeklyIntervals) fail(LIMIT_EXCEEDED, path, "too many weekly intervals");
    const bucket = byDay.get(key) ?? [];
    intervals.forEach((interval, index) => {
      const intervalPath = `${path}.${key}[${index}]`;
      if (!Array.isArray(interval) || interval.length !== 2) fail(INVALID_DOCUMENT, intervalPath, "interval must be [start, end]");
      const [start, end] = interval;
      if (typeof start !== "string" || !START_PATTERN.test(start) || typeof end !== "string" || !END_PATTERN.test(end)) {
        fail(INVALID_DOCUMENT, intervalPath, "invalid window boundary");
      }
      if (start >= end) fail(INVALID_DOCUMENT, intervalPath, "window must not cross midnight");
      bucket.push([start, end]);
    });
    byDay.set(key, bucket);
  }
  const weekly = {};
  for (const day of WEEKDAYS) {
    const bucket = byDay.get(day);
    if (!bucket || bucket.length === 0) continue;
    weekly[day] = bucket;
  }
  return weekly;
}

function normalizeDateRanges(raw, path) {
  if (!Array.isArray(raw)) fail(INVALID_DOCUMENT, path, "dateRanges must be an array");
  if (raw.length > AUTHORIZATION_LIMITS.dateRanges) fail(LIMIT_EXCEEDED, path, "too many date ranges");
  return raw.map((range, index) => {
    assertShape(range, DATE_RANGE_KEYS, `${path}[${index}]`);
    if (!isCalendarDate(range.from) || !isCalendarDate(range.to)) fail(INVALID_DOCUMENT, `${path}[${index}]`, "invalid calendar date");
    if (range.from > range.to) fail(INVALID_DOCUMENT, `${path}[${index}]`, "from must not be after to");
    return { from: range.from, to: range.to };
  });
}

function normalizeSchedule(raw, path) {
  assertShape(raw, SCHEDULE_KEYS, path);
  const timezone = raw.timezone;
  if (typeof timezone !== "string" || timezone.length === 0) fail(INVALID_DOCUMENT, `${path}.timezone`, "invalid timezone");
  if (timezone.length > AUTHORIZATION_LIMITS.timezoneMaxLength) fail(LIMIT_EXCEEDED, `${path}.timezone`, "timezone too long");
  if (!isValidTimeZone(timezone)) fail(INVALID_DOCUMENT, `${path}.timezone`, "invalid timezone");
  const startsAt = normalizeInstantOrNull(raw.startsAt, `${path}.startsAt`);
  const expiresAt = normalizeInstantOrNull(raw.expiresAt, `${path}.expiresAt`);
  if (startsAt !== null && expiresAt !== null && startsAt >= expiresAt) {
    fail(INVALID_DOCUMENT, `${path}.startsAt`, "startsAt must be before expiresAt");
  }
  return {
    timezone,
    weekly: normalizeWeekly(raw.weekly, `${path}.weekly`),
    dateRanges: normalizeDateRanges(raw.dateRanges, `${path}.dateRanges`),
    startsAt,
    expiresAt,
  };
}

function normalizeBranch(raw, path) {
  assertShape(raw, BRANCH_KEYS, path);
  // `null` = unrestricted; `[]` is not "no restriction", it is a mistake (§8).
  const field = (name, normalize) => {
    const value = raw[name];
    if (value === null) return null;
    if (Array.isArray(value) && value.length === 0) fail(INVALID_DOCUMENT, `${path}.${name}`, "empty branch field");
    return normalize(value, `${path}.${name}`);
  };
  return {
    surfaces: field("surfaces", normalizeSurfaces),
    capabilities: field("capabilities", normalizeSelectorCapabilities),
    targets: field("targets", normalizeBranchTargets),
  };
}

function normalizeBranchTargets(raw, path) {
  if (!Array.isArray(raw)) fail(INVALID_DOCUMENT, path, "targets must be an array");
  if (raw.length > AUTHORIZATION_LIMITS.targetsPerBranch) fail(LIMIT_EXCEEDED, path, "too many targets");
  const seen = new Set();
  return raw.map((value, index) => {
    const target = normalizeTarget(value, `${path}[${index}]`);
    const key = targetKey(target);
    if (seen.has(key)) fail(INVALID_DOCUMENT, `${path}[${index}]`, "duplicate target");
    seen.add(key);
    return target;
  });
}

function normalizeSelector(raw, path) {
  assertShape(raw, SELECTOR_KEYS, path);
  const branches = raw.anyOf;
  if (!Array.isArray(branches)) fail(INVALID_DOCUMENT, `${path}.anyOf`, "anyOf must be an array");
  if (branches.length === 0) fail(INVALID_DOCUMENT, `${path}.anyOf`, "anyOf needs at least one branch");
  if (branches.length > AUTHORIZATION_LIMITS.selectorBranches) fail(LIMIT_EXCEEDED, `${path}.anyOf`, "too many branches");
  return { anyOf: branches.map((branch, index) => normalizeBranch(branch, `${path}.anyOf[${index}]`)) };
}

function normalizeConstraint(raw, path) {
  assertShape(raw, CONSTRAINT_KEYS, path);
  if (!isPolicyId(raw.id)) fail(INVALID_DOCUMENT, `${path}.id`, "invalid constraint id");
  if (typeof raw.label !== "string" || raw.label.length < 1 || /[\r\n]/.test(raw.label)) {
    fail(INVALID_DOCUMENT, `${path}.label`, "label must be a single line");
  }
  if (raw.label.length > AUTHORIZATION_LIMITS.labelMaxLength) fail(LIMIT_EXCEEDED, `${path}.label`, "label too long");
  if (typeof raw.enabled !== "boolean") fail(INVALID_DOCUMENT, `${path}.enabled`, "enabled must be boolean");
  if (!MODES.has(raw.mode)) fail(INVALID_DOCUMENT, `${path}.mode`, "invalid mode");

  const subjects = normalizeSubjectIdList(raw.subjects, `${path}.subjects`, AUTHORIZATION_LIMITS.subjectsPerConstraint);
  const selector = normalizeSelector(raw.selector, `${path}.selector`);

  // `revoke` is all-or-nothing: exactly one branch with all three fields null
  // (§8). A partial revoke would be a scoped suspension in disguise.
  if (raw.mode === "revoke") {
    const [branch] = selector.anyOf;
    if (selector.anyOf.length !== 1 || branch.surfaces !== null || branch.capabilities !== null || branch.targets !== null) {
      fail(INVALID_DOCUMENT, `${path}.selector.anyOf`, "revoke requires exactly one unrestricted branch");
    }
  }

  return {
    id: raw.id,
    label: raw.label,
    enabled: raw.enabled,
    subjects,
    mode: raw.mode,
    selector,
    schedule: normalizeSchedule(raw.schedule, `${path}.schedule`),
    createdAt: normalizeInstant(raw.createdAt, `${path}.createdAt`),
    updatedAt: normalizeInstant(raw.updatedAt, `${path}.updatedAt`),
  };
}

function normalizeConstraints(raw) {
  if (!Array.isArray(raw)) fail(INVALID_DOCUMENT, "constraints", "constraints must be an array");
  if (raw.length > AUTHORIZATION_LIMITS.constraints) fail(LIMIT_EXCEEDED, "constraints", "too many constraints");
  const seenIds = new Set();
  return raw.map((constraint, index) => {
    const normalized = normalizeConstraint(constraint, `constraints[${index}]`);
    if (seenIds.has(normalized.id)) fail(INVALID_DOCUMENT, `constraints[${index}].id`, "duplicate constraint id");
    seenIds.add(normalized.id);
    return normalized;
  });
}

/** Validate and normalize a document value; throws `AuthorizationDocumentError`. */
export function validateAuthorizationDocument(value) {
  if (!isRecord(value)) fail(INVALID_DOCUMENT, "", "document must be an object");
  if (value.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION) fail(UNSUPPORTED_SCHEMA, "schemaVersion", "unsupported schema version");
  assertShape(value, DOCUMENT_KEYS, "");
  if (!Number.isInteger(value.catalogVersion) || value.catalogVersion < 0) fail(INVALID_DOCUMENT, "catalogVersion", "catalogVersion must be a non-negative integer");
  // The catalog only grows and never changes the meaning of an ID, so an older
  // document stays readable; a newer one cannot be interpreted (§5.1).
  if (value.catalogVersion > AUTHORIZATION_CATALOG_VERSION) fail(STATE_UNAVAILABLE, "catalogVersion", "catalog version is newer than this server");
  if (!Number.isInteger(value.revision) || value.revision < 1) fail(INVALID_DOCUMENT, "revision", "revision must be a positive integer");
  if (typeof value.timeConstraintsEnabled !== "boolean") fail(INVALID_DOCUMENT, "timeConstraintsEnabled", "must be boolean");
  return {
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    catalogVersion: value.catalogVersion,
    revision: value.revision,
    timeConstraintsEnabled: value.timeConstraintsEnabled,
    subjects: normalizeSubjects(value.subjects),
    constraints: normalizeConstraints(value.constraints),
  };
}

/** True when any JSON object in `text` repeats a key (JSON.parse keeps the last). */
function hasDuplicateObjectKey(text) {
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\"") {
      let key = "";
      index += 1;
      while (index < text.length && text[index] !== "\"") {
        if (text[index] === "\\") {
          const escape = text[index + 1];
          if (escape === "u") {
            key += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
            index += 6;
          } else {
            key += ESCAPED_CHARS[escape] ?? escape;
            index += 2;
          }
          continue;
        }
        key += text[index];
        index += 1;
      }
      index += 1;
      const frame = stack.at(-1);
      if (frame?.object && frame.expectKey) {
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
        frame.expectKey = false;
      }
      continue;
    }
    if (char === "{") {
      stack.push({ object: true, keys: new Set(), expectKey: true });
      index += 1;
      continue;
    }
    if (char === "[") {
      stack.push({ object: false });
      index += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
      index += 1;
      continue;
    }
    if (char === "," && stack.at(-1)?.object) stack.at(-1).expectKey = true;
    index += 1;
  }
  return false;
}

const ESCAPED_CHARS = Object.freeze({ "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" });

/**
 * Parse JSON text into a validated document.
 * `{ok:true,document}` | `{ok:false,code}` — never a partially accepted state.
 */
export function parseAuthorizationDocument(text) {
  if (typeof text !== "string" || text.length === 0) return { ok: false, code: STATE_UNAVAILABLE };
  if (Buffer.byteLength(text, "utf8") > AUTHORIZATION_LIMITS.fileBytes) return { ok: false, code: STATE_UNAVAILABLE };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: STATE_UNAVAILABLE };
  }
  if (hasDuplicateObjectKey(text)) return { ok: false, code: STATE_UNAVAILABLE };
  try {
    return { ok: true, document: validateAuthorizationDocument(value) };
  } catch (error) {
    return { ok: false, code: typeof error?.code === "string" ? error.code : INVALID_DOCUMENT };
  }
}

/** Validate, then serialize: the written file is always a valid document. */
export function serializeAuthorizationDocument(value) {
  return `${JSON.stringify(validateAuthorizationDocument(value), null, 2)}\n`;
}
