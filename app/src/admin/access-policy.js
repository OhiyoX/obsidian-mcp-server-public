// Admin access-policy service for AuthZ Wave B / B4.
//
// Contract: `scratch/authz/INTERFACE.md` §10.4 (+ §7/§8) and DEVELOPMENT §17.
// This module is the *only* place that writes policies from the Admin surface.
// It never re-implements the document shape: every candidate goes through the
// frozen A3 `validateAccessPolicyDocument`, and every commit goes through the
// frozen store CAS (`store.mutate` / `store.replace` / `store.repairBroken`).
//
// Hard rules carried over from the frozen contract:
//  - stale CAS is never last-write-wins: the store decides, we surface
//    `{ ok:false, code:"stale_policy_revision", current }` unchanged;
//  - a rejected draft must leave the store untouched (we validate before the
//    store call, and the store validates again);
//  - the Admin plane has *no* policy gate: nothing here calls
//    `runtime.evaluate` to allow/deny an Admin action. Only the read-only
//    `previewForSubject` calls `runtime.explain`;
//  - no Vault content, no credential secret and no full policy JSON is read or
//    returned. Subjects are opaque identity labels, not secrets.
//
// Types are plain objects; the module is framework-free.

import { ACCESS_POLICY_CODES, isAccessPolicyError } from "../access-policy/errors.js";
import {
  ACCESS_POLICY_SCHEMA_VERSION,
  newPolicyId,
  parseAccessPolicyDocument,
  validateAccessPolicyDocument,
} from "../access-policy/schema.js";
import { CONFIGURED_ENV_SUBJECT, isValidSubject } from "../access-policy/subjects.js";

// Admin-only codes. These are not deny/broken transport codes (those stay in
// `errors.js` ACCESS_DENY_CODES); they describe an Admin form/route failure and
// are mapped by Wave C (not-found -> 404, unavailable -> 503, stale -> 409).
export const ACCESS_POLICY_ADMIN_CODES = Object.freeze({
  UNKNOWN_POLICY_ID: "unknown_access_policy_id",
  STORE_UNAVAILABLE: "access_policy_store_unavailable",
});

const WEEKDAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// CAS token resolution. `undefined`/empty means "use the current revision"
// (create with no prior read); anything present but not a non-negative integer
// resolves to -1, which can never equal a committed revision, so a malformed
// form token fails closed instead of silently bypassing the CAS.
function asRevision(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : -1;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return -1;
}

// ---------------------------------------------------------------------------
// Form-friendly coercion. A structured draft (already an array/object) passes
// through unchanged so the schema remains the single validity authority; only
// the obvious text encodings the Admin form produces are decoded here.
// ---------------------------------------------------------------------------

function coerceFlag(value, fallback) {
  // Hidden+checkbox posts both values; take the last (checkbox) when array.
  if (Array.isArray(value)) return coerceFlag(value[value.length - 1], fallback);
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === "on" || value === "1") return true;
  if (value === false || value === "false" || value === "off" || value === "0") return false;
  return value; // schema rejects anything else
}

function coerceList(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return fallback ?? [];
  if (typeof value === "string") return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  return value; // schema rejects
}

function coerceInstant(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback ?? null;
  return value;
}

/** `mon 09:00-18:00` lines -> `{ mon: [["09:00","18:00"]] }`. */
function coerceWeekly(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback ?? {};
  if (isRecord(value)) return value;
  if (typeof value !== "string") return value;
  const weekly = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([A-Za-z]{3})\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(line);
    if (!match) return { "": [] }; // unknown weekday -> INVALID_POLICY, fail closed
    (weekly[match[1].toLowerCase()] ??= []).push([match[2], match[3]]);
  }
  return weekly;
}

/** `2026-10-01..2026-10-07` lines -> `[{ from, to }]`. */
function coerceDateRanges(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return fallback ?? [];
  if (typeof value !== "string") return value;
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s*\.\.\s*/);
    return { from: parts[0], to: parts[1] ?? parts[0] };
  });
}

/** Stable line rendering of a weekly grid; the inverse of `coerceWeekly`. */
export function formatWeeklyText(weekly) {
  const lines = [];
  for (const day of WEEKDAYS) {
    const intervals = weekly?.[day];
    if (!Array.isArray(intervals)) continue;
    for (const interval of intervals) {
      if (Array.isArray(interval) && interval.length === 2) lines.push(`${day} ${interval[0]}-${interval[1]}`);
    }
  }
  return lines.join("\n");
}

/** Stable line rendering of date ranges; the inverse of `coerceDateRanges`. */
export function formatDateRangesText(dateRanges) {
  return (Array.isArray(dateRanges) ? dateRanges : [])
    .map((range) => `${range?.from ?? ""}..${range?.to ?? ""}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Build a full 13-key candidate from a draft + optional existing policy. The
// schema then normalizes/validates it; nothing here decides validity.
function normalizeDraft(draft, { base = null, nowIso, revision = 0 } = {}) {
  const source = isRecord(draft) ? draft : {};
  const seed = {
    id: source.id ?? base?.id ?? newPolicyId(),
    label: source.label ?? base?.label,
    enabled: coerceFlag(source.enabled, base?.enabled ?? true),
    subjects: coerceList(source.subjects, base?.subjects ?? []),
    mode: source.mode ?? base?.mode,
    capabilities: coerceList(source.capabilities, base?.capabilities ?? []),
    timezone: source.timezone ?? base?.timezone,
    weekly: coerceWeekly(source.weekly, base?.weekly ?? {}),
    dateRanges: coerceDateRanges(source.dateRanges, base?.dateRanges ?? []),
    startsAt: coerceInstant(source.startsAt, base?.startsAt ?? null),
    expiresAt: coerceInstant(source.expiresAt, base?.expiresAt ?? null),
    createdAt: base ? base.createdAt : nowIso,
    updatedAt: nowIso,
  };
  try {
    const document = validateAccessPolicyDocument({
      schemaVersion: ACCESS_POLICY_SCHEMA_VERSION,
      revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
      policies: [seed],
    });
    return { ok: true, policy: document.policies[0] };
  } catch (error) {
    if (isAccessPolicyError(error)) return { ok: false, code: error.code, detail: error.details?.path };
    throw error;
  }
}

/**
 * Subjects referenced by `policies` that are absent from `knownSubjects`.
 * Sorted, unique, and informational only: the caller must never auto-delete a
 * policy because its subject disappeared from the provider snapshot.
 */
export function orphanedSubjects(policies, knownSubjects) {
  const known = new Set((Array.isArray(knownSubjects) ? knownSubjects : []).filter((item) => typeof item === "string"));
  const found = new Set();
  for (const policy of Array.isArray(policies) ? policies : []) {
    for (const subject of policy?.subjects ?? []) {
      if (typeof subject === "string" && !known.has(subject)) found.add(subject);
    }
  }
  return [...found].sort();
}

/**
 * Current credential subjects from an `oauth-provider.authorizationSnapshot()`
 * shape, plus the optional configured-env synthetic API-key record. Invalid
 * ids are dropped (fail closed) and the result is sorted and unique.
 */
export function snapshotSubjects(snapshot, { configuredApiKeyEnabled = false } = {}) {
  const found = new Set();
  if (configuredApiKeyEnabled) found.add(CONFIGURED_ENV_SUBJECT);
  for (const key of snapshot?.apiKeys ?? []) if (key?.id) found.add(`api-key:${key.id}`);
  for (const client of snapshot?.clients ?? []) if (client?.clientId) found.add(`oauth-client:${client.clientId}`);
  for (const user of snapshot?.oauthUsers ?? []) if (user?.id) found.add(`oauth-user:${user.id}`);
  return [...found].filter((subject) => isValidSubject(subject)).sort();
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * `createAccessPolicyAdmin({ store, runtime, now })`.
 *
 * `store`   : the frozen A3 store (owns the single access-policy file).
 * `runtime` : the frozen A4 runtime (read-only `explain`/`snapshot`).
 * `now`     : injectable epoch-ms clock, used only to stamp createdAt/updatedAt.
 *
 * Every method is async. None of them gate on policy time: the Admin plane must
 * stay reachable while the policy store is broken, otherwise a corrupt file
 * would lock the repair door.
 */
export function createAccessPolicyAdmin({ store, runtime, now = Date.now } = {}) {
  const clockIso = () => new Date(now()).toISOString();
  const snapshot = () => (store && typeof store.snapshot === "function")
    ? store.snapshot()
    : { status: "unavailable", revision: null, policies: Object.freeze([]) };

  function unavailable(current = snapshot()) {
    return {
      ok: false,
      code: ACCESS_POLICY_ADMIN_CODES.STORE_UNAVAILABLE,
      current: { status: current.status, revision: current.revision },
    };
  }

  function requireReady() {
    const current = snapshot();
    return current.status === "ready" ? null : unavailable(current);
  }

  function withPolicy(result, policy) {
    return result?.ok ? { ...result, policy } : result;
  }

  async function listPolicies({ subjects } = {}) {
    const current = snapshot();
    return {
      status: current.status,
      revision: current.revision,
      policies: current.policies,
      orphaned: Array.isArray(subjects) ? orphanedSubjects(current.policies, subjects) : [],
    };
  }

  async function createPolicy(draft, expectedRevision) {
    const blocked = requireReady();
    if (blocked) return blocked;
    const current = snapshot();
    const revision = asRevision(expectedRevision, current.revision);
    const normalized = normalizeDraft(draft, { base: null, nowIso: clockIso(), revision });
    if (!normalized.ok) return normalized;
    const result = await store.mutate(revision, (policies) => [...policies, normalized.policy]);
    return withPolicy(result, normalized.policy);
  }

  async function updatePolicy(id, draft, expectedRevision) {
    const blocked = requireReady();
    if (blocked) return blocked;
    const current = snapshot();
    const base = current.policies.find((policy) => policy.id === id);
    if (!base) return { ok: false, code: ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID };
    const revision = asRevision(expectedRevision, current.revision);
    const normalized = normalizeDraft(draft, { base, nowIso: clockIso(), revision });
    if (!normalized.ok) return normalized;
    const next = current.policies.map((policy) => (policy.id === id ? normalized.policy : policy));
    const result = await store.replace(revision, next);
    return withPolicy(result, normalized.policy);
  }

  async function setEnabled(id, enabled, expectedRevision) {
    const blocked = requireReady();
    if (blocked) return blocked;
    const flag = coerceFlag(enabled, null);
    if (typeof flag !== "boolean") return { ok: false, code: ACCESS_POLICY_CODES.INVALID_POLICY, detail: "enabled" };
    const current = snapshot();
    if (!current.policies.some((policy) => policy.id === id)) {
      return { ok: false, code: ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID };
    }
    const revision = asRevision(expectedRevision, current.revision);
    const next = current.policies.map((policy) => (policy.id === id
      ? { ...policy, enabled: flag, updatedAt: clockIso() }
      : policy));
    const result = await store.replace(revision, next);
    return withPolicy(result, next.find((policy) => policy.id === id));
  }

  async function deletePolicy(id, expectedRevision) {
    const blocked = requireReady();
    if (blocked) return blocked;
    const current = snapshot();
    if (!current.policies.some((policy) => policy.id === id)) {
      return { ok: false, code: ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID };
    }
    const revision = asRevision(expectedRevision, current.revision);
    return store.replace(revision, current.policies.filter((policy) => policy.id !== id));
  }

  async function previewForSubject(subject, capabilities) {
    if (!runtime || typeof runtime.explain !== "function") {
      return {
        subject,
        decision: { allowed: true, mode: null, reason: "no_matching_policy", denyPolicyId: null, matchedPolicyIds: [] },
        now: clockIso(),
        timezone: null,
        nextChangeAt: null,
        nextAllowedAt: null,
      };
    }
    // Preview the *whole* subject: union the capabilities of every policy that
    // names it, so a scoped suspend policy is not silently skipped when the
    // caller did not supply an explicit capability list.
    const policyCapabilities = [
      ...new Set((runtime.snapshot?.().policies ?? [])
        .filter((policy) => Array.isArray(policy.subjects) && policy.subjects.includes(subject))
        .flatMap((policy) => policy.capabilities ?? [])),
    ];
    const wanted = Array.isArray(capabilities) ? capabilities : policyCapabilities;
    const explain = runtime.explain({ subjects: [subject], capabilities: wanted });
    return {
      subject,
      decision: {
        allowed: explain.allowed,
        mode: explain.mode,
        reason: explain.reason,
        denyPolicyId: explain.denyPolicyId,
        matchedPolicyIds: explain.matchedPolicyIds,
      },
      now: explain.now,
      timezone: explain.timezone,
      nextChangeAt: explain.nextChangeAt,
      nextAllowedAt: explain.nextAllowedAt,
    };
  }

  async function repairFromCandidate(document) {
    if (!store || typeof store.repairBroken !== "function") return unavailable();
    const parsed = parseAccessPolicyDocument(document);
    if (!parsed.ok) return { ok: false, code: parsed.code, detail: parsed.detail };
    return store.repairBroken({ policies: parsed.document.policies });
  }

  return {
    listPolicies,
    createPolicy,
    updatePolicy,
    setEnabled,
    deletePolicy,
    previewForSubject,
    repairFromCandidate,
  };
}
