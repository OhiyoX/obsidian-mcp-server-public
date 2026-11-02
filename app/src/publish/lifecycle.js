// Publish record lifecycle vocabulary + v1→v2 state normalization: the pure decision
// model for issues #277/#278 (lane A2 of
// `Web/DEVELOPMENT - Issues 277-278 Publish 生命周期与 Markdown-only 边界收口` §5/§8.1).
//
// Pure on purpose: no file IO, no clock, no randomness, no vault or Markdown-path
// knowledge (A1's `publish/target.js` owns that), no id generation, no persistence.
// PublishService (B1) observes the target, calls one planner and applies the frozen
// decision inside its mutationQueue. Spread a decision before persisting it.
//
// Deliberate trade-offs (mirrored in the lane HANDOFF):
// 1. `revoked` (doc §5) is never written: the minimal implementation keeps no
//    tombstone and physically deletes the record. It is still recognised on read as
//    a permanently dead state so a future tombstone writer cannot serve a page.
// 2. Once observed dead (orphaned / invalid / revoked) a record never returns to
//    `active`; the doc freezes this for orphaned only, and this model extends it so
//    a flapping target cannot silently resurrect an old opaque URL. Recovery is
//    always revoke + explicit publish → new id (§5.1).
// 3. A legacy (v1) record without a lifecycle is `unknown`, never `active` (§8.1:
//    "加载 v1 record 时不得直接假设全部 active"). It becomes active only after an
//    explicit observation says "Markdown target exists".

const LIFECYCLE_ACTIVE = "active";
const LIFECYCLE_ORPHANED = "orphaned";
const LIFECYCLE_INVALID = "invalid";
const LIFECYCLE_UNKNOWN = "unknown";
const LIFECYCLE_REVOKED = "revoked";

export const PUBLISH_LIFECYCLE = Object.freeze({
  ACTIVE: LIFECYCLE_ACTIVE,
  ORPHANED: LIFECYCLE_ORPHANED,
  INVALID: LIFECYCLE_INVALID,
  UNKNOWN: LIFECYCLE_UNKNOWN,
  REVOKED: LIFECYCLE_REVOKED,
});

// States this model may write into a v2 state file. `unknown` is expected only
// between migration and the first observation of that record.
export const PERSISTABLE_LIFECYCLE_STATES = Object.freeze([
  LIFECYCLE_ACTIVE,
  LIFECYCLE_ORPHANED,
  LIFECYCLE_INVALID,
  LIFECYCLE_UNKNOWN,
]);

// Doc §8.1 allows the v1 placeholder to be spelled `unknown` or `legacy`; both read
// back as `unknown`.
export const PUBLISH_LIFECYCLE_LEGACY_ALIAS = "legacy";

export const STATE_VERSION_SOURCE = 1;
export const STATE_VERSION_TARGET = 2;

// Explicit observation kinds. Everything the planners need is a boolean; anything
// missing, non-boolean or self-contradictory is `unverifiable` → fail closed.
export const PUBLISH_OBSERVATION = Object.freeze({
  MARKDOWN: "markdown",
  MISSING: "missing",
  NON_MARKDOWN: "non_markdown",
  UNVERIFIABLE: "unverifiable",
});

export const PUBLISH_ACTIONS = Object.freeze({
  PUBLISH_CREATE: "publish_create",
  PUBLISH_REUSE: "publish_reuse",
  PUBLISH_ADOPT: "publish_adopt",
  PUBLISH_REPUBLISH: "publish_republish",
  PUBLISH_DENY: "publish_denied",
  RESOLVE_SERVE: "resolve_serve",
  RESOLVE_DENY: "resolve_deny",
  REVOKE: "revoke",
  REVOKE_NOOP: "revoke_noop",
});

// Domain error codes (doc §7). `unsupported_publish_target` must stay identical to
// the constant A1 exports; B1 must assert equality when wiring both modules.
export const PUBLISH_ERROR_CODES = Object.freeze({
  UNSUPPORTED_PUBLISH_TARGET: "unsupported_publish_target",
  PUBLISH_TARGET_MISSING: "publish_target_missing",
  PUBLISH_TARGET_UNVERIFIABLE: "publish_target_unverifiable",
  PUBLISH_RECORD_NOT_FOUND: "publish_record_not_found",
  PUBLISH_RECORD_ORPHANED: "publish_record_orphaned",
  PUBLISH_RECORD_INVALID: "publish_record_invalid",
  PUBLISH_RECORD_REVOKED: "publish_record_revoked",
});

export const PUBLISH_MIGRATION_ISSUES = Object.freeze({
  STATE_NOT_AN_OBJECT: "state_not_an_object",
  RECORDS_NOT_AN_ARRAY: "records_not_an_array",
  RECORD_NOT_AN_OBJECT: "record_not_an_object",
  RECORD_ID_MISSING: "record_id_missing",
  RECORD_VAULT_ID_MISSING: "record_vault_id_missing",
  RECORD_PATH_MISSING: "record_path_missing",
  RECORD_LIFECYCLE_MISSING: "record_lifecycle_missing",
  RECORD_LIFECYCLE_UNRECOGNIZED: "record_lifecycle_unrecognized",
  RECORD_ID_DUPLICATE: "record_id_duplicate",
  RECORD_DOCUMENT_DUPLICATE: "record_document_duplicate",
});

export const PUBLISH_ID_POLICY = Object.freeze({ NEW: "new", SAME: "same", NONE: "none" });

const HTTP = Object.freeze({ OK: 200, NOT_FOUND: 404, BAD_REQUEST: 400 });

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

function decision(fields) {
  return Object.freeze({
    ok: true,
    action: null,
    httpStatus: HTTP.OK,
    idPolicy: PUBLISH_ID_POLICY.NONE,
    lifecycle: null,
    transition: null,
    removeRecord: false,
    changed: false,
    revoked: null,
    errorCode: null,
    ...fields,
  });
}

const deny = (fields) => decision({ ok: false, action: PUBLISH_ACTIONS.RESOLVE_DENY, ...fields });
const publishDeny = (fields) => decision({ ok: false, action: PUBLISH_ACTIONS.PUBLISH_DENY, ...fields });
const transitionOf = (from, to, errorCode, reason, httpStatus = HTTP.NOT_FOUND) =>
  Object.freeze({
    httpStatus,
    lifecycle: to,
    transition: Object.freeze({ from, to }),
    changed: true,
    errorCode,
    reason,
  });

/**
 * Classify an explicit observation into `PUBLISH_OBSERVATION`.
 * Shape: `{ exists: boolean, isMarkdown: boolean, observedMissing?: boolean }`.
 * `observedMissing === true` is the authoritative "we looked and it was absent"
 * signal of doc §5.2; `exists === false` means the same. `observedMissing: true`
 * together with `exists: true` is contradictory → `unverifiable`.
 */
export function classifyObservation(observation) {
  if (!isPlainObject(observation)) return PUBLISH_OBSERVATION.UNVERIFIABLE;
  const { exists, isMarkdown, observedMissing } = observation;
  if (observedMissing === true) {
    return exists === true ? PUBLISH_OBSERVATION.UNVERIFIABLE : PUBLISH_OBSERVATION.MISSING;
  }
  if (observedMissing !== undefined && observedMissing !== false) return PUBLISH_OBSERVATION.UNVERIFIABLE;
  if (exists === false) return PUBLISH_OBSERVATION.MISSING;
  if (exists === true && isMarkdown === true) return PUBLISH_OBSERVATION.MARKDOWN;
  if (exists === true && isMarkdown === false) return PUBLISH_OBSERVATION.NON_MARKDOWN;
  return PUBLISH_OBSERVATION.UNVERIFIABLE;
}

/** Read a lifecycle value; `null` for absent (v1) or unrecognised values. */
export function readLifecycle(record) {
  if (!isPlainObject(record)) return null;
  const raw = record.lifecycle;
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === PUBLISH_LIFECYCLE_LEGACY_ALIAS) return LIFECYCLE_UNKNOWN;
  if (value === LIFECYCLE_REVOKED) return LIFECYCLE_REVOKED;
  return PERSISTABLE_LIFECYCLE_STATES.includes(value) ? value : null;
}

// Absent lifecycle → `unknown` (v1, decided by first observation). Present but
// unrecognised → `invalid`: fail closed (doc §15 S07).
function effectiveLifecycle(record) {
  if (!isPlainObject(record)) return LIFECYCLE_INVALID;
  const value = readLifecycle(record);
  if (value !== null) return value;
  return record.lifecycle === undefined || record.lifecycle === null ? LIFECYCLE_UNKNOWN : LIFECYCLE_INVALID;
}

const planInput = (input) => {
  const source = isPlainObject(input) ? input : {};
  return { record: isPlainObject(source.record) ? source.record : null, observation: source.observation };
};

/**
 * Normalize one record for a v2 state file. Never throws: an unusable record yields
 * `{ record: null, issues: [...] }` so one bad entry cannot stop the service from
 * starting (doc §8.1). Duplicate detection happens in `migratePublishState`.
 */
export function normalizeLegacyRecord(record) {
  const ISSUES = PUBLISH_MIGRATION_ISSUES;
  if (!isPlainObject(record)) return Object.freeze({ record: null, issues: Object.freeze([ISSUES.RECORD_NOT_AN_OBJECT]) });

  const fatal = [];
  if (!nonEmptyString(record.id)) fatal.push(ISSUES.RECORD_ID_MISSING);
  if (!nonEmptyString(record.vaultId)) fatal.push(ISSUES.RECORD_VAULT_ID_MISSING);
  if (!nonEmptyString(record.path)) fatal.push(ISSUES.RECORD_PATH_MISSING);
  if (fatal.length > 0) return Object.freeze({ record: null, issues: Object.freeze(fatal) });

  const issues = [];
  let lifecycle = readLifecycle(record);
  if (lifecycle === null) {
    const absent = record.lifecycle === undefined || record.lifecycle === null;
    lifecycle = absent ? LIFECYCLE_UNKNOWN : LIFECYCLE_INVALID;
    issues.push(absent ? ISSUES.RECORD_LIFECYCLE_MISSING : ISSUES.RECORD_LIFECYCLE_UNRECOGNIZED);
  }

  const record_ = Object.freeze({
    id: record.id,
    vaultId: record.vaultId,
    path: record.path,
    lifecycle,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    createdBy: typeof record.createdBy === "string" ? record.createdBy : null,
  });
  return Object.freeze({ record: record_, issues: Object.freeze(issues) });
}

/**
 * Normalize a whole loaded state file: `{ version: 2, sourceVersion, records, issues, dropped }`.
 * Malformed records are dropped with a `records[i]: <issue>` entry instead of
 * aborting the load; duplicates (same `id`, or same `vaultId + NUL + path`) keep
 * the first occurrence. A structurally broken file only produces issues — B1
 * decides whether that is fatal (doc §8.1 allows that case).
 */
export function migratePublishState(state) {
  const empty = (sourceVersion, issue) =>
    Object.freeze({
      version: STATE_VERSION_TARGET,
      sourceVersion,
      records: Object.freeze([]),
      issues: Object.freeze([issue]),
      dropped: 0,
    });
  if (!isPlainObject(state)) return empty(null, PUBLISH_MIGRATION_ISSUES.STATE_NOT_AN_OBJECT);
  const sourceVersion = Number.isInteger(state.version) ? state.version : null;
  if (!Array.isArray(state.records)) return empty(sourceVersion, PUBLISH_MIGRATION_ISSUES.RECORDS_NOT_AN_ARRAY);

  const records = [];
  const issues = [];
  const ids = new Set();
  const documents = new Set();
  for (const [index, entry] of state.records.entries()) {
    const normalized = normalizeLegacyRecord(entry);
    for (const issue of normalized.issues) issues.push(`records[${index}]: ${issue}`);
    const record = normalized.record;
    if (!record) continue;
    if (ids.has(record.id)) {
      issues.push(`records[${index}]: ${PUBLISH_MIGRATION_ISSUES.RECORD_ID_DUPLICATE}`);
      continue;
    }
    const documentKey = `${record.vaultId}\0${record.path}`;
    if (documents.has(documentKey)) {
      issues.push(`records[${index}]: ${PUBLISH_MIGRATION_ISSUES.RECORD_DOCUMENT_DUPLICATE}`);
      continue;
    }
    ids.add(record.id);
    documents.add(documentKey);
    records.push(record);
  }

  return Object.freeze({
    version: STATE_VERSION_TARGET,
    sourceVersion,
    records: Object.freeze(records),
    issues: Object.freeze(issues),
    dropped: state.records.length - records.length,
  });
}

/** True only for records that may appear as a `published:`/anonymous candidate (doc §9). */
export function isPublishedCandidate(record) {
  return effectiveLifecycle(record) === LIFECYCLE_ACTIVE;
}

/**
 * §5.1 publish(vaultId, path).
 * Input `{ record, observation }`: `record` is whatever record is currently bound to
 * the canonical path (any lifecycle, or `null`). Returns a frozen decision with
 * `idPolicy` (`new`/`same`/`none`), the resulting `lifecycle`, an optional
 * `transition` to persist, `removeRecord` (replace the dead record so the
 * one-record-per-path invariant holds), `changed`, `httpStatus`, `errorCode`, `reason`.
 */
export function planPublish(input) {
  const { record, observation } = planInput(input);
  const kind = classifyObservation(observation);
  const { MARKDOWN, MISSING, NON_MARKDOWN } = PUBLISH_OBSERVATION;
  const E = PUBLISH_ERROR_CODES;

  if (!record) {
    if (kind === MARKDOWN) {
      return decision({
        action: PUBLISH_ACTIONS.PUBLISH_CREATE,
        idPolicy: PUBLISH_ID_POLICY.NEW,
        lifecycle: LIFECYCLE_ACTIVE,
        changed: true,
        reason: "publish_new_record",
      });
    }
    const [httpStatus, errorCode, reason] =
      kind === MISSING
        ? [HTTP.NOT_FOUND, E.PUBLISH_TARGET_MISSING, "publish_target_missing"]
        : kind === NON_MARKDOWN
          ? [HTTP.BAD_REQUEST, E.UNSUPPORTED_PUBLISH_TARGET, "publish_target_not_markdown"]
          : [HTTP.BAD_REQUEST, E.PUBLISH_TARGET_UNVERIFIABLE, "publish_target_unverifiable"];
    return publishDeny({ httpStatus, errorCode, reason });
  }

  const current = effectiveLifecycle(record);
  const live = current === LIFECYCLE_ACTIVE || current === LIFECYCLE_UNKNOWN;
  const denyObservation = (nextLifecycle, errorCode, reason, httpStatus) =>
    live
      ? publishDeny(transitionOf(current, nextLifecycle, errorCode, reason, httpStatus))
      : publishDeny({ httpStatus, errorCode, reason });

  if (kind === MARKDOWN) {
    if (current === LIFECYCLE_ACTIVE) {
      return decision({
        action: PUBLISH_ACTIONS.PUBLISH_REUSE,
        idPolicy: PUBLISH_ID_POLICY.SAME,
        lifecycle: LIFECYCLE_ACTIVE,
        reason: "publish_active_idempotent",
      });
    }
    if (current === LIFECYCLE_UNKNOWN) {
      return decision({
        action: PUBLISH_ACTIONS.PUBLISH_ADOPT,
        idPolicy: PUBLISH_ID_POLICY.SAME,
        lifecycle: LIFECYCLE_ACTIVE,
        transition: Object.freeze({ from: LIFECYCLE_UNKNOWN, to: LIFECYCLE_ACTIVE }),
        changed: true,
        reason: "publish_legacy_verified_markdown",
      });
    }
    // orphaned / invalid / revoked: old record stays dead, replaced by a new id.
    return decision({
      action: PUBLISH_ACTIONS.PUBLISH_REPUBLISH,
      idPolicy: PUBLISH_ID_POLICY.NEW,
      lifecycle: LIFECYCLE_ACTIVE,
      removeRecord: true,
      changed: true,
      reason: `publish_republish_${current}`,
    });
  }

  if (kind === MISSING) {
    return denyObservation(LIFECYCLE_ORPHANED, E.PUBLISH_TARGET_MISSING, "publish_target_missing", HTTP.NOT_FOUND);
  }
  if (kind === NON_MARKDOWN) {
    return denyObservation(LIFECYCLE_INVALID, E.UNSUPPORTED_PUBLISH_TARGET, "publish_target_not_markdown", HTTP.BAD_REQUEST);
  }
  return publishDeny({
    httpStatus: live ? HTTP.NOT_FOUND : HTTP.BAD_REQUEST,
    errorCode: E.PUBLISH_TARGET_UNVERIFIABLE,
    reason: "publish_target_unverifiable",
  });
}

/**
 * §5.1 resolve(id), the anonymous read path. Only `active` + verified Markdown is
 * served. A missing/non-Markdown target on an active (or un-observed legacy) record
 * returns the transition to persist alongside the 404; the caller must persist it in
 * the same mutationQueue (doc §5.2). Dead states never revive.
 */
export function planResolve(input) {
  const { record, observation } = planInput(input);
  const E = PUBLISH_ERROR_CODES;
  if (!record) {
    return deny({
      httpStatus: HTTP.NOT_FOUND,
      errorCode: E.PUBLISH_RECORD_NOT_FOUND,
      reason: "resolve_record_not_found",
    });
  }

  const current = effectiveLifecycle(record);
  const kind = classifyObservation(observation);
  const denials = {
    [LIFECYCLE_ORPHANED]: [E.PUBLISH_RECORD_ORPHANED, "resolve_orphaned_denied"],
    [LIFECYCLE_INVALID]: [E.PUBLISH_RECORD_INVALID, "resolve_invalid_denied"],
    [LIFECYCLE_REVOKED]: [E.PUBLISH_RECORD_REVOKED, "resolve_revoked_denied"],
  };
  if (denials[current]) {
    const [errorCode, reason] = denials[current];
    return deny({ httpStatus: HTTP.NOT_FOUND, errorCode, reason });
  }

  // Live records: `unknown` is the not-yet-observed legacy state; the first
  // observation decides and is persisted.
  const adopt = current === LIFECYCLE_UNKNOWN;
  if (kind === PUBLISH_OBSERVATION.MARKDOWN) {
    if (!adopt) return decision({ action: PUBLISH_ACTIONS.RESOLVE_SERVE, lifecycle: LIFECYCLE_ACTIVE, reason: "resolve_active_markdown" });
    return decision({
      action: PUBLISH_ACTIONS.RESOLVE_SERVE,
      lifecycle: LIFECYCLE_ACTIVE,
      transition: Object.freeze({ from: LIFECYCLE_UNKNOWN, to: LIFECYCLE_ACTIVE }),
      changed: true,
      reason: "resolve_legacy_markdown_adopted",
    });
  }
  if (kind === PUBLISH_OBSERVATION.MISSING) {
    const errorCode = adopt ? E.PUBLISH_RECORD_ORPHANED : E.PUBLISH_TARGET_MISSING;
    const reason = adopt ? "resolve_legacy_missing" : "resolve_active_missing";
    return deny(transitionOf(current, LIFECYCLE_ORPHANED, errorCode, reason));
  }
  if (kind === PUBLISH_OBSERVATION.NON_MARKDOWN) {
    const reason = adopt ? "resolve_legacy_non_markdown" : "resolve_active_non_markdown";
    return deny(transitionOf(current, LIFECYCLE_INVALID, E.PUBLISH_RECORD_INVALID, reason));
  }
  return deny({
    httpStatus: HTTP.NOT_FOUND,
    errorCode: E.PUBLISH_TARGET_UNVERIFIABLE,
    reason: adopt ? "resolve_legacy_unverifiable" : "resolve_active_unverifiable",
  });
}

/**
 * §5.1 revoke by canonical path. Takes `{ record }` only: revoke must never stat the
 * target (the #277 root cause), so any lifecycle is revocable and a missing target
 * still succeeds. An absent record is a successful no-op (`revoked: false`, HTTP 200),
 * never a 404 (§13.3).
 */
export function planRevoke(input) {
  const { record } = planInput(input);
  if (!record) {
    return decision({
      action: PUBLISH_ACTIONS.REVOKE_NOOP,
      revoked: false,
      changed: false,
      reason: "revoke_record_absent",
    });
  }
  return decision({
    action: PUBLISH_ACTIONS.REVOKE,
    lifecycle: effectiveLifecycle(record),
    removeRecord: true,
    revoked: true,
    changed: true,
    reason: "revoke_record_removed",
  });
}
