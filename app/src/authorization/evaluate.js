// P1 / Task 7 — the single pure authorization decision.
//
// Contract: design §6. `authorize(request, snapshot)` is the only algorithm; an
// adapter calls it and never checks a grant array itself. It is pure: no I/O, no
// ambient clock, no module state. The only reuse is the time algebra of
// `access-policy/time.js`; the legacy runtime is never called for a decision.
//
// Order (design §6):
//   anonymous publication delegation (independent of the permission state)
//   -> permission state readable (`loading` denies exactly like `broken`)
//   -> trusted actor: kind, proof, expiry, revocation, epoch, transfer fence
//   -> principal-wide revoke
//   -> known capability, surface and target shape
//   -> frozen ceiling with live grants (union inside a subject, intersect ceilings)
//   -> target admission and availability
//   -> suspend constraints
//   -> deployment / Vault read-only
//
// A decision carries no subject id, Vault id, path, title or body: only codes, the
// document revision, constraint UUIDs and an instant.

import { isValidSubject } from "../access-policy/subjects.js";
import { evaluatePolicySchedule, nextTransition } from "../access-policy/time.js";
import { isValidVaultId } from "../vault-runtime/descriptor.js";
import { authorizationOperation, isOutsideTemporalPlane } from "./catalog.js";

export const AUTHORIZATION_DECISION_CODES = Object.freeze({
  ALLOWED: "allowed",
  INVALID_CREDENTIAL: "invalid_credential",
  INSUFFICIENT_SCOPE: "insufficient_scope",
  CAPABILITY_DENIED: "capability_denied",
  VAULT_ACCESS_DENIED: "vault_access_denied",
  VAULT_ID_INVALID: "vault_id_invalid",
  VAULT_UNAVAILABLE: "vault_unavailable",
  OUTSIDE_WINDOW: "outside_authorized_window",
  POLICY_UNAVAILABLE: "authorization_policy_unavailable",
  STATE_UNAVAILABLE: "authorization_state_unavailable",
  OPERATION_UNKNOWN: "operation_unknown",
});

const C = AUTHORIZATION_DECISION_CODES;

const SURFACES = new Set(["mcp", "web", "oauth", "admin", "publish", "system"]);
const ACTOR_KINDS = new Set([
  "oauth", "api-key", "environment-key", "web-session", "admin-session", "publication", "system", "deployment-anonymous",
]);
const PROOF_KINDS = new Set(["admin-session", "publication", "system", "deployment-anonymous"]);
const OAUTH_LIFECYCLE = new Set(["oauth_authorize", "oauth_code_exchange", "oauth_refresh"]);
// §9: while the permission state is broken, only the no-content repair surface
// stays open. `server_info` and `agent_bootstrap` expose no Vault content.
const REPAIR_CAPABILITIES = new Set(["server_info", "agent_bootstrap"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decision({ allowed, code, enforcement = "operation", mode = null, revision = null, matched = [], denyId = null, nextAllowedAt = null }) {
  return Object.freeze({
    allowed,
    code,
    enforcement,
    mode,
    revision,
    matchedConstraintIds: Object.freeze([...matched]),
    denyConstraintId: denyId,
    nextAllowedAt,
  });
}

function allow(revision, matched = []) {
  return decision({ allowed: true, code: C.ALLOWED, revision, matched });
}

function deny(code, { enforcement = "operation", mode = null, revision = null, matched = [], denyId = null, nextAllowedAt = null } = {}) {
  return decision({ allowed: false, code, enforcement, mode, revision, matched, denyId, nextAllowedAt });
}

function sameTarget(left, right) {
  if (!isRecord(left) || !isRecord(right) || left.kind !== right.kind) return false;
  if (left.kind === "vault") return left.vaultId === right.vaultId;
  if (left.kind === "publication") return left.id === right.id;
  return true;
}

function branchMatches(branch, { surface, capability, target }) {
  if (branch?.surfaces !== null && !branch?.surfaces?.includes(surface)) return false;
  if (branch?.capabilities !== null && !branch?.capabilities?.includes(capability)) return false;
  if (branch?.targets !== null && !branch?.targets?.some((candidate) => sameTarget(candidate, target))) return false;
  return true;
}

function matchingConstraints(constraints, { subjects, surface, capability, target }) {
  const subjectSet = new Set(subjects);
  return (Array.isArray(constraints) ? constraints : []).filter((constraint) => constraint?.enabled === true
    && Array.isArray(constraint.subjects)
    && constraint.subjects.some((subject) => subjectSet.has(subject))
    && Array.isArray(constraint.selector?.anyOf)
    && constraint.selector.anyOf.some((branch) => branchMatches(branch, { surface, capability, target })));
}

/** `{ ok }` from the shared algebra; a structure that cannot be read is `broken`. */
function evaluateSchedule(constraint, nowMs) {
  try {
    if (!isRecord(constraint?.schedule)) return { ok: false, broken: true };
    const result = evaluatePolicySchedule(constraint.schedule, nowMs);
    return isRecord(result) ? result : { ok: false, broken: true };
  } catch {
    return { ok: false, broken: true };
  }
}

function nextOpening(constraint, nowMs) {
  try {
    // `nextTransition` answers `{nextChangeAt, nextAllowedAt}`; the option value is epoch ms.
    const { nextAllowedAt } = nextTransition(constraint.schedule, nowMs);
    return Number.isFinite(nextAllowedAt) ? new Date(nextAllowedAt).toISOString() : null;
  } catch {
    return null;
  }
}

/** Capabilities a grant list gives on one target. `hasRow` is "this grant mentions it". */
function capabilitiesOnTarget(grants, target) {
  const capabilities = new Set();
  let hasRow = false;
  for (const grant of Array.isArray(grants) ? grants : []) {
    if (!sameTarget(grant?.target, target)) continue;
    hasRow = true;
    for (const capability of Array.isArray(grant.capabilities) ? grant.capabilities : []) capabilities.add(capability);
  }
  return { hasRow, capabilities };
}

/**
 * Every ceiling that applies: one per subject record (a `null` client record is
 * neutral and skipped) plus the actor's frozen ceiling when it has one.
 */
function collectCeilings({ actor, document, target }) {
  const rows = [];
  let missingSubject = false;
  for (const subjectId of actor.subjectIds) {
    const record = document.subjects[subjectId];
    if (!isRecord(record)) {
      missingSubject = true;
      continue;
    }
    if (record.grants === null) continue; // "does not tighten", not "may do everything"
    rows.push(capabilitiesOnTarget(record.grants, target));
  }
  let ceilingRow = null;
  if (Array.isArray(actor.grantCeiling)) {
    ceilingRow = capabilitiesOnTarget(actor.grantCeiling, target);
    rows.push(ceilingRow);
  }
  return { rows, ceilingRow, missingSubject };
}

function effectiveCapabilities(rows) {
  if (rows.length === 0) return new Set();
  const [first, ...rest] = rows.map((row) => row.capabilities);
  const effective = new Set();
  for (const capability of first) {
    if (rest.every((other) => other.has(capability))) effective.add(capability);
  }
  return effective;
}

function repairSurfaceAllowed({ actor, capability, surface, target }) {
  if (REPAIR_CAPABILITIES.has(capability)) return true;
  const operation = authorizationOperation(capability);
  return isRecord(actor)
    && actor.kind === "admin-session"
    && actor.proof?.kind === "admin-session"
    && operation !== null
    && operation.id.startsWith("admin_")
    && SURFACES.has(surface)
    && operation.surfaces.includes(surface)
    && target?.kind === operation.targetKind;
}

/** The anonymous publication delegation: its own record decides, never the document. */
function authorizePublication({ actor, capability, surface, target, snapshot }) {
  const proof = isRecord(actor) ? actor.proof ?? null : null;
  if (!isRecord(actor) || actor.kind !== "publication" || !isRecord(proof) || proof.kind !== "publication" || typeof proof.id !== "string") {
    return deny(C.INVALID_CREDENTIAL, { enforcement: "transport" });
  }
  if (capability !== "publish_document_read" || surface !== "publish" || !isRecord(target) || target.kind !== "publication" || target.id !== proof.id) {
    return deny(C.INVALID_CREDENTIAL, { enforcement: "transport" });
  }
  const record = isRecord(snapshot) && isRecord(snapshot.publication) ? snapshot.publication : null;
  if (!record || record.id !== proof.id || record.active === false || typeof record.vaultId !== "string" || typeof record.path !== "string") {
    // The adapter maps this to the existing 404 for an unusable link.
    return deny(C.INVALID_CREDENTIAL, { enforcement: "transport" });
  }
  return allow(null);
}

function proofMatchesActor(actor) {
  const proof = actor.proof ?? null;
  const needsProof = actor.kind === "admin-session" || actor.kind === "publication" || actor.kind === "system" || actor.kind === "deployment-anonymous";
  if (proof === null) return !needsProof;
  if (!isRecord(proof) || !PROOF_KINDS.has(proof.kind)) return false;
  switch (actor.kind) {
    case "admin-session": return proof.kind === "admin-session";
    case "publication": return proof.kind === "publication";
    case "system": return proof.kind === "system" && typeof proof.vaultId === "string" && (proof.task === "commit" || proof.task === "push");
    case "deployment-anonymous": return proof.kind === "deployment-anonymous";
    default: return false; // a proof on a credential actor is a forgery
  }
}

function verifyActor({ actor, identities, document, nowMs, revision }) {
  const refuse = () => deny(C.INVALID_CREDENTIAL, { enforcement: "transport", revision });
  if (!isRecord(actor) || !ACTOR_KINDS.has(actor.kind)) return refuse();
  if (actor.revoked !== false) return refuse();
  if (actor.expiresAt !== null && actor.expiresAt !== undefined && !(nowMs < actor.expiresAt)) return refuse();
  if (!Array.isArray(actor.subjectIds) || actor.subjectIds.some((subjectId) => !isValidSubject(subjectId))) return refuse();
  if (!isRecord(actor.credentialEpochs)) return refuse();
  if (actor.grantCeiling !== null && actor.grantCeiling !== undefined && !Array.isArray(actor.grantCeiling)) return refuse();
  // A ceiling with no subject to bind it is an unverifiable claim: every trusted
  // kind that has no subject must also have no ceiling (design §6).
  if (actor.subjectIds.length === 0 && Array.isArray(actor.grantCeiling)) return refuse();
  // A background task or the console is not a person's credential: a subject there
  // would let one account's window stop a task, or turn a user revoke into a
  // transport refusal of the console.
  if ((actor.kind === "system" || actor.kind === "admin-session") && actor.subjectIds.length > 0) return refuse();
  if (!proofMatchesActor(actor)) return refuse();

  for (const subjectId of actor.subjectIds) {
    const identity = identities[subjectId];
    if (!isRecord(identity) || identity.disabled === true) return refuse();
    const epoch = actor.credentialEpochs[subjectId];
    if (!Number.isInteger(epoch) || epoch < 0) return refuse();
    if (identity.credentialEpoch !== epoch) return refuse();
    const subjectRecord = document.subjects[subjectId];
    if (isRecord(subjectRecord) && subjectRecord.credentialEpoch !== epoch) return refuse();
    // A transferred or revoked grant pair advances the fence; the old credential dies.
    if (Number.isInteger(identity.transferGeneration) && Number.isInteger(actor.transferGeneration)
      && identity.transferGeneration !== actor.transferGeneration) {
      return refuse();
    }
  }
  return null;
}

/** The suspend decision: one rule for every operation except the OAuth lifecycle. */
function suspendRefusal({ operation, matched, nowMs, revision }) {
  if (operation.surfaces.includes("oauth")) return null; // §8: only a revoke denies there
  const suspension = matched.find((constraint) => constraint.mode === "suspend" && !evaluateSchedule(constraint, nowMs).ok);
  if (!suspension) return null;
  return deny(C.OUTSIDE_WINDOW, {
    enforcement: "operation",
    mode: "suspend",
    revision,
    matched: matched.map((constraint) => constraint.id),
    denyId: suspension.id,
    nextAllowedAt: nextOpening(suspension, nowMs),
  });
}

function authorizeControl({ operation, actor, target, surface, document, admissions, deployment, revision, matched, nowMs }) {
  const refuseWithSuspension = () => suspendRefusal({ operation, matched, nowMs, revision });
  if (OAUTH_LIFECYCLE.has(operation.id)) {
    // §6.1.3: only the OAuth actor drives its own lifecycle; a revoke was already
    // handled above and maps the legacy 401.
    return actor.kind === "oauth" ? allow(revision) : deny(C.INVALID_CREDENTIAL, { enforcement: "transport", revision });
  }
  if (operation.id.startsWith("admin_")) {
    return actor.kind === "admin-session" && actor.proof?.kind === "admin-session"
      ? allow(revision)
      : deny(C.INVALID_CREDENTIAL, { enforcement: "transport", revision });
  }
  if (operation.id.startsWith("system_git_")) {
    const task = operation.id === "system_git_push" ? "push" : "commit";
    if (actor.kind !== "system" || actor.proof?.kind !== "system" || actor.proof.task !== task || actor.proof.vaultId !== target.vaultId) {
      return deny(C.INVALID_CREDENTIAL, { enforcement: "transport", revision });
    }
    const admission = admissions[target.vaultId];
    if (!isRecord(admission) || admission.admitted !== true) return deny(C.VAULT_UNAVAILABLE, { revision });
    if (deployment.readOnly === true) return deny(C.CAPABILITY_DENIED, { revision });
    return refuseWithSuspension() ?? allow(revision, matched.map((constraint) => constraint.id));
  }
  if (operation.id === "session_bootstrap") {
    // The public auth pages and the app shell authorize no content and hold no
    // grant; the temporal plane never reaches them (catalog exemption).
    return allow(revision);
  }
  if (operation.id === "vault_select") {
    // §4.1: derived from a per-Vault read; it never grants a write and is not granted.
    const { rows, missingSubject } = collectCeilings({ actor, document, target });
    const admission = admissions[target.vaultId];
    if (!isRecord(admission) || admission.admitted !== true) return deny(C.VAULT_UNAVAILABLE, { revision });
    if (missingSubject || rows.length === 0 || !rows.every((row) => row.hasRow)) return deny(C.VAULT_ACCESS_DENIED, { revision });
    const readable = [...effectiveCapabilities(rows)].some((capability) => authorizationOperation(capability)?.contentEffect === "read");
    if (!readable) return deny(C.CAPABILITY_DENIED, { revision });
    // The Vault list carried the legacy read gate, so the window applies to it.
    return refuseWithSuspension() ?? allow(revision, matched.map((constraint) => constraint.id));
  }
  if (operation.id === "publish_document_read") {
    // Only the anonymous publication delegation may read a published document.
    return deny(C.INVALID_CREDENTIAL, { enforcement: "transport", revision });
  }
  return deny(C.CAPABILITY_DENIED, { revision });
}

/**
 * `authorize(request, snapshot) -> AuthorizationDecision`.
 * Request: `{actor, capability, target, surface, nowMs}`.
 * Snapshot: `{status, document, identities, vaultAdmissions, publication, deployment}`.
 */
export function authorize(request, snapshot) {
  if (!isRecord(request)) return deny(C.INVALID_CREDENTIAL, { enforcement: "transport" });
  const { actor, capability, surface, target, nowMs } = request;

  // 1. The anonymous publication delegation does not depend on the permission state.
  if (isRecord(actor) && (actor.kind === "publication" || actor.proof?.kind === "publication")) {
    return authorizePublication({ actor, capability, surface, target, snapshot });
  }

  // 2. The permission state must be readable; `loading` denies exactly like `broken`.
  const status = isRecord(snapshot) ? snapshot.status : null;
  if (status !== "ready" && status !== "broken" && status !== "loading") {
    return deny(C.STATE_UNAVAILABLE, { enforcement: "transport" });
  }
  if (status !== "ready") {
    const operation = authorizationOperation(capability);
    if (repairSurfaceAllowed({ actor, capability, surface, target }) && (REPAIR_CAPABILITIES.has(capability) || operation !== null)) {
      return allow(null);
    }
    return deny(C.STATE_UNAVAILABLE, { enforcement: "transport" });
  }

  const document = snapshot.document;
  const identities = snapshot.identities;
  const admissions = snapshot.vaultAdmissions;
  const deployment = snapshot.deployment;
  if (!isRecord(document) || !isRecord(document.subjects) || !Array.isArray(document.constraints)
    || !isRecord(identities) || !isRecord(admissions) || !isRecord(deployment)) {
    return deny(C.STATE_UNAVAILABLE, { enforcement: "transport" });
  }
  const revision = Number.isInteger(document.revision) ? document.revision : null;

  // 3. An unreadable clock is a policy condition, never a silent allow.
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return deny(C.POLICY_UNAVAILABLE, { revision });

  // 4. Trusted identity.
  const actorRefusal = verifyActor({ actor, identities, document, nowMs, revision });
  if (actorRefusal !== null) return actorRefusal;

  // 5. Time constraints: the catalog declares the identity/public-shell operations
  //    outside the temporal plane, so the exemption is a property of the operation
  //    and no request string can select it. A deployment that never enabled the
  //    plane has no constraints at all.
  const operation = authorizationOperation(capability);
  const temporalActive = document.timeConstraintsEnabled === true
    && !(operation !== null && isOutsideTemporalPlane(operation.id));
  const matched = temporalActive
    ? matchingConstraints(document.constraints, { subjects: actor.subjectIds, surface, capability, target })
    : [];
  const matchedIds = matched.map((constraint) => constraint.id);

  for (const constraint of matched) {
    if (evaluateSchedule(constraint, nowMs).broken === true) return deny(C.POLICY_UNAVAILABLE, { revision, matched: matchedIds });
  }

  // 6. Principal-wide revoke: it wins over any capability, and it maps the transport.
  const revocation = matched.find((constraint) => constraint.mode === "revoke" && !evaluateSchedule(constraint, nowMs).ok);
  if (revocation) {
    return deny(C.OUTSIDE_WINDOW, {
      enforcement: "transport",
      mode: "revoke",
      revision,
      matched: matchedIds,
      denyId: revocation.id,
      nextAllowedAt: nextOpening(revocation, nowMs),
    });
  }

  // 7. Known capability, surface and target shape.
  if (operation === null) return deny(C.OPERATION_UNKNOWN, { revision });
  if (!SURFACES.has(surface) || !operation.surfaces.includes(surface)) return deny(C.CAPABILITY_DENIED, { revision, matched: matchedIds });
  if (!isRecord(target) || !["vault", "instance", "publication"].includes(target.kind)) return deny(C.CAPABILITY_DENIED, { revision });
  if (operation.targetKind !== target.kind) return deny(C.CAPABILITY_DENIED, { revision });
  if (target.kind === "vault" && !isValidVaultId(target.vaultId)) return deny(C.VAULT_ID_INVALID, { revision });

  // 8. Control operations are decided by their trusted context, not by a grant.
  if (operation.grantable === false) {
    return authorizeControl({ operation, actor, target, surface, document, admissions, deployment, revision, matched, nowMs });
  }

  // 9. Frozen ceiling with live grants.
  const { rows, ceilingRow, missingSubject } = collectCeilings({ actor, document, target });
  const vaultTarget = target.kind === "vault";
  const noRightsCode = vaultTarget ? C.VAULT_ACCESS_DENIED : C.CAPABILITY_DENIED;
  if (missingSubject || rows.length === 0 || !rows.every((row) => row.hasRow)) {
    return deny(noRightsCode, { revision, matched: matchedIds });
  }
  const effective = effectiveCapabilities(rows);
  if (!effective.has(capability)) {
    const liveHadIt = rows.some((row) => row !== ceilingRow && row.capabilities.has(capability));
    if (liveHadIt && ceilingRow !== null && !ceilingRow.capabilities.has(capability)) {
      // A protocol/OAuth ceiling gap keeps its compatibility code.
      return deny(C.INSUFFICIENT_SCOPE, { revision, matched: matchedIds });
    }
    return deny(C.CAPABILITY_DENIED, { revision, matched: matchedIds });
  }

  // 10. Admission: a grant cannot make an absent or unadmitted Vault usable.
  const admission = vaultTarget ? admissions[target.vaultId] : null;
  if (vaultTarget && (!isRecord(admission) || admission.admitted !== true)) {
    return deny(C.VAULT_UNAVAILABLE, { revision, matched: matchedIds });
  }

  // 11. Suspend constraints.
  const suspension = suspendRefusal({ operation, matched, nowMs, revision });
  if (suspension) return suspension;

  // 12. Read-only deployment or Vault.
  if (operation.contentEffect === "mutate") {
    if (deployment.readOnly === true || (isRecord(admission) && admission.readOnly === true)) {
      return deny(C.CAPABILITY_DENIED, { revision, matched: matchedIds });
    }
  }
  return allow(revision, matchedIds);
}
