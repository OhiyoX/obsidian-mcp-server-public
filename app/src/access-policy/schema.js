// Access-policy document schema for AuthZ Wave A / A3.
//
// Contract: `scratch/authz/INTERFACE.md` §7. This module is the single
// enforcement point for the frozen document shape, the hard bounds and the
// subject/capability knownness. It is pure: no I/O, no clock, no ambient
// timezone, no module-level mutable state.
//
// The error taxonomy comes from A1 (`errors.js`); the timezone validator and
// the subject/capability vocabularies come from A1/A2 (`time.js`,
// `capabilities.js`). Nothing is restated here.

import { randomUUID } from "node:crypto";
import { ACCESS_POLICY_CODES, AccessPolicyError, isAccessPolicyError } from "./errors.js";
import { isValidCapabilityShape, unknownCapabilities, unknownSubjects } from "./capabilities.js";
import { isValidTimeZone } from "./time.js";

export const ACCESS_POLICY_SCHEMA_VERSION = 1;

export const ACCESS_POLICY_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  maxPolicies: 512,
  maxSubjectsPerPolicy: 32,
  maxCapabilitiesPerPolicy: 64,
  maxWeeklyIntervalsPerPolicy: 64,
  maxDateRangesPerPolicy: 64,
  labelMaxLength: 120,
  timezoneMaxLength: 80,
});

// Frozen key sets. The normalized policy key order below is part of the
// contract (§7.2): the persisted document must always carry exactly these 13
// keys in this order.
const DOCUMENT_KEYS = Object.freeze(["schemaVersion", "revision", "policies"]);
const POLICY_KEYS = Object.freeze([
  "id", "label", "enabled", "subjects", "mode", "capabilities", "timezone",
  "weekly", "dateRanges", "startsAt", "expiresAt", "createdAt", "updatedAt",
]);
const DOCUMENT_KEY_SET = new Set(DOCUMENT_KEYS);
const POLICY_KEY_SET = new Set(POLICY_KEYS);

const MODES = new Set(["suspend", "revoke"]);
const WEEKDAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const WEEKDAY_SET = new Set(WEEKDAYS);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const START_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_PATTERN = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// `path`/`reason` only carry a field path and a static reason: an error message
// must never echo document content (INTERFACE §7.12).
function fail(code, path, reason) {
  const where = path ? ` at ${path}` : "";
  throw new AccessPolicyError(code, `${reason}${where}`, { details: { path } });
}

function rejectUnknownKeys(record, allowed, path, code) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(code, path ? `${path}.${key}` : key, "unknown field");
  }
}

export function newPolicyId() {
  return randomUUID();
}

export function isPolicyId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizeInstant(value, path) {
  const millis = typeof value === "string" && value.length > 0 ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, path, "invalid ISO instant");
  return new Date(millis).toISOString();
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

function normalizeStringList(raw, path, limit) {
  if (!Array.isArray(raw)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, path, "must be an array");
  if (raw.length > limit) fail(ACCESS_POLICY_CODES.LIMIT_EXCEEDED, path, "too many entries");
  const seen = new Set();
  const normalized = [];
  raw.forEach((value, index) => {
    if (typeof value !== "string") fail(ACCESS_POLICY_CODES.INVALID_POLICY, `${path}[${index}]`, "must be a string");
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  });
  return normalized;
}

function normalizeCapabilityList(raw, path) {
  if (!Array.isArray(raw)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, path, "must be an array");
  if (raw.length > ACCESS_POLICY_LIMITS.maxCapabilitiesPerPolicy) {
    fail(ACCESS_POLICY_CODES.LIMIT_EXCEEDED, path, "too many capabilities");
  }
  const seen = new Set();
  const normalized = [];
  raw.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      fail(ACCESS_POLICY_CODES.INVALID_POLICY, `${path}[${index}]`, "must be a non-empty string");
    }
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  });
  return normalized;
}

// weekly => { mon: [["09:00","18:00"], ...], ... }. Day keys normalize to the
// three-letter lowercase form; intervals never cross midnight; empty days are
// dropped so that "no weekly constraint" is the canonical `{}`.
function normalizeWeekly(raw, path) {
  if (raw === undefined) return {};
  if (!isRecord(raw)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, path, "weekly must be an object");
  const byDay = new Map();
  let total = 0;
  for (const key of Object.keys(raw)) {
    const day = key.toLowerCase();
    if (!WEEKDAY_SET.has(day)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, `${path}.${key}`, "unknown weekday");
    const intervals = raw[key];
    if (!Array.isArray(intervals)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, `${path}.${key}`, "intervals must be an array");
    total += intervals.length;
    if (total > ACCESS_POLICY_LIMITS.maxWeeklyIntervalsPerPolicy) {
      fail(ACCESS_POLICY_CODES.LIMIT_EXCEEDED, path, "too many weekly intervals");
    }
    const bucket = byDay.get(day) ?? [];
    intervals.forEach((interval, index) => {
      const intervalPath = `${path}.${key}[${index}]`;
      if (!Array.isArray(interval) || interval.length !== 2) fail(ACCESS_POLICY_CODES.INVALID_POLICY, intervalPath, "interval must be [start, end]");
      const [start, end] = interval;
      if (typeof start !== "string" || !START_PATTERN.test(start) || typeof end !== "string" || !END_PATTERN.test(end)) {
        fail(ACCESS_POLICY_CODES.INVALID_WINDOW, intervalPath, "invalid window boundary");
      }
      if (start >= end) fail(ACCESS_POLICY_CODES.INVALID_WINDOW, intervalPath, "window must not cross midnight");
      bucket.push([start, end]);
    });
    byDay.set(day, bucket);
  }
  const weekly = {};
  for (const day of WEEKDAYS) {
    const bucket = byDay.get(day);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
    weekly[day] = bucket;
  }
  return weekly;
}

function normalizeDateRanges(raw, path) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, path, "dateRanges must be an array");
  if (raw.length > ACCESS_POLICY_LIMITS.maxDateRangesPerPolicy) {
    fail(ACCESS_POLICY_CODES.LIMIT_EXCEEDED, path, "too many date ranges");
  }
  return raw.map((range, index) => {
    const rangePath = `${path}[${index}]`;
    if (!isRecord(range)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, rangePath, "range must be an object");
    rejectUnknownKeys(range, new Set(["from", "to"]), rangePath, ACCESS_POLICY_CODES.INVALID_POLICY);
    const { from, to } = range;
    if (!isCalendarDate(from) || !isCalendarDate(to)) fail(ACCESS_POLICY_CODES.INVALID_WINDOW, rangePath, "invalid calendar date");
    if (from > to) fail(ACCESS_POLICY_CODES.INVALID_WINDOW, rangePath, "from must not be after to");
    return { from, to };
  });
}

function normalizePolicy(raw, index) {
  const path = `policies[${index}]`;
  if (!isRecord(raw)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, path, "policy must be an object");
  rejectUnknownKeys(raw, POLICY_KEY_SET, path, ACCESS_POLICY_CODES.INVALID_POLICY);

  if (!isPolicyId(raw.id)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, `${path}.id`, "invalid policy id");
  if (typeof raw.label !== "string" || raw.label.length < 1 || /[\r\n]/.test(raw.label)) {
    fail(ACCESS_POLICY_CODES.INVALID_POLICY, `${path}.label`, "label must be a single line");
  }
  if (raw.label.length > ACCESS_POLICY_LIMITS.labelMaxLength) fail(ACCESS_POLICY_CODES.LIMIT_EXCEEDED, `${path}.label`, "label too long");
  if (typeof raw.enabled !== "boolean") fail(ACCESS_POLICY_CODES.INVALID_POLICY, `${path}.enabled`, "enabled must be boolean");
  if (!MODES.has(raw.mode)) fail(ACCESS_POLICY_CODES.INVALID_POLICY, `${path}.mode`, "invalid mode");

  const subjects = normalizeStringList(raw.subjects, `${path}.subjects`, ACCESS_POLICY_LIMITS.maxSubjectsPerPolicy);
  const capabilities = normalizeCapabilityList(raw.capabilities, `${path}.capabilities`);

  // Mode rules are enforced before the knownness pass so a revoke policy that
  // carries extra capabilities always reports the revoke contract violation.
  if (raw.mode === "revoke") {
    if (capabilities.length !== 1 || capabilities[0] !== "all") {
      fail(ACCESS_POLICY_CODES.REVOKE_REQUIRES_ALL, `${path}.capabilities`, "revoke requires exactly [all]");
    }
  } else if (capabilities.length === 0) {
    fail(ACCESS_POLICY_CODES.INVALID_POLICY, `${path}.capabilities`, "suspend requires at least one capability");
  }

  const timezone = raw.timezone;
  if (typeof timezone !== "string" || timezone.length < 1) fail(ACCESS_POLICY_CODES.INVALID_TIMEZONE, `${path}.timezone`, "invalid timezone");
  if (timezone.length > ACCESS_POLICY_LIMITS.timezoneMaxLength) fail(ACCESS_POLICY_CODES.LIMIT_EXCEEDED, `${path}.timezone`, "timezone too long");
  if (!isValidTimeZone(timezone)) fail(ACCESS_POLICY_CODES.INVALID_TIMEZONE, `${path}.timezone`, "invalid timezone");

  const weekly = normalizeWeekly(raw.weekly, `${path}.weekly`);
  const dateRanges = normalizeDateRanges(raw.dateRanges, `${path}.dateRanges`);

  const startsAt = raw.startsAt === undefined || raw.startsAt === null ? null : normalizeInstant(raw.startsAt, `${path}.startsAt`);
  const expiresAt = raw.expiresAt === undefined || raw.expiresAt === null ? null : normalizeInstant(raw.expiresAt, `${path}.expiresAt`);
  if (startsAt !== null && expiresAt !== null && startsAt >= expiresAt) {
    fail(ACCESS_POLICY_CODES.INVALID_WINDOW, `${path}.startsAt`, "startsAt must be before expiresAt");
  }
  if (Object.keys(weekly).length === 0 && dateRanges.length === 0 && startsAt === null && expiresAt === null) {
    fail(ACCESS_POLICY_CODES.INVALID_POLICY, path, "policy needs at least one time constraint");
  }

  const createdAt = normalizeInstant(raw.createdAt, `${path}.createdAt`);
  const updatedAt = normalizeInstant(raw.updatedAt, `${path}.updatedAt`);

  // Knownness (semantics) after syntax. `isValidCapabilityShape` is the syntax
  // gate; `unknownCapabilities`/`unknownSubjects` are the canonical membership
  // gate. Both fail closed with the vocabulary codes.
  const shaped = capabilities.filter((capability) => !isValidCapabilityShape(capability));
  if (shaped.length > 0 || unknownCapabilities(capabilities).length > 0) {
    fail(ACCESS_POLICY_CODES.UNKNOWN_CAPABILITY, `${path}.capabilities`, "unknown capability");
  }
  if (unknownSubjects(subjects).length > 0) {
    fail(ACCESS_POLICY_CODES.UNKNOWN_SUBJECT, `${path}.subjects`, "unknown subject");
  }

  return {
    id: raw.id,
    label: raw.label,
    enabled: raw.enabled,
    subjects,
    mode: raw.mode,
    capabilities,
    timezone,
    weekly,
    dateRanges,
    startsAt,
    expiresAt,
    createdAt,
    updatedAt,
  };
}

export function validateAccessPolicyDocument(document) {
  if (!isRecord(document)) fail(ACCESS_POLICY_CODES.INVALID_DOCUMENT, "", "document must be an object");
  if (document.schemaVersion !== ACCESS_POLICY_SCHEMA_VERSION) {
    fail(ACCESS_POLICY_CODES.UNSUPPORTED_SCHEMA, "schemaVersion", "unsupported schema version");
  }
  rejectUnknownKeys(document, DOCUMENT_KEY_SET, "", ACCESS_POLICY_CODES.INVALID_DOCUMENT);
  if (!Number.isInteger(document.revision) || document.revision < 0) {
    fail(ACCESS_POLICY_CODES.INVALID_DOCUMENT, "revision", "revision must be a non-negative integer");
  }
  if (!Array.isArray(document.policies)) fail(ACCESS_POLICY_CODES.INVALID_DOCUMENT, "policies", "policies must be an array");
  if (document.policies.length > ACCESS_POLICY_LIMITS.maxPolicies) {
    fail(ACCESS_POLICY_CODES.LIMIT_EXCEEDED, "policies", "too many policies");
  }
  const seenIds = new Set();
  const policies = document.policies.map((policy, index) => {
    const normalized = normalizePolicy(policy, index);
    if (seenIds.has(normalized.id)) fail(ACCESS_POLICY_CODES.INVALID_DOCUMENT, `policies[${index}].id`, "duplicate policy id");
    seenIds.add(normalized.id);
    return normalized;
  });
  return { schemaVersion: ACCESS_POLICY_SCHEMA_VERSION, revision: document.revision, policies };
}

export function parseAccessPolicyDocument(raw) {
  try {
    if (typeof raw === "string") {
      if (raw.length > ACCESS_POLICY_LIMITS.fileBytes) {
        return { ok: false, code: ACCESS_POLICY_CODES.LIMIT_EXCEEDED, detail: "document exceeds the size limit" };
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, code: ACCESS_POLICY_CODES.INVALID_DOCUMENT, detail: "invalid JSON document" };
      }
      return { ok: true, document: validateAccessPolicyDocument(parsed) };
    }
    return { ok: true, document: validateAccessPolicyDocument(raw) };
  } catch (error) {
    if (isAccessPolicyError(error)) return { ok: false, code: error.code, detail: error.details?.path || error.message };
    return { ok: false, code: ACCESS_POLICY_CODES.INVALID_DOCUMENT, detail: "unexpected validation failure" };
  }
}

export function serializeAccessPolicyDocument(document) {
  const normalized = validateAccessPolicyDocument(document);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}
