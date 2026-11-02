// Access-policy decision core for AuthZ Wave A (A1).
//
// Pure functions over an injected snapshot + injected instant. No I/O, no
// ambient clock reads, no store access, and no subject/capability syntax
// parsing: matching is plain set intersection over already-normalized strings.
//
// reason literals are internal decision vocabulary; their client-visible
// counterparts live in errors.js (ACCESS_DENY_CODES).

import { evaluatePolicySchedule, nextTransition } from "./time.js";

const MAX_UNION_STEPS = 512;

function intersects(values, wanted) {
  if (!Array.isArray(values) || wanted.size === 0) return false;
  return values.some((value) => wanted.has(value));
}

function matchingPolicies(snapshot, subjects, capabilities) {
  const policies = Array.isArray(snapshot?.policies) ? snapshot.policies : [];
  const subjectSet = new Set(Array.isArray(subjects) ? subjects : []);
  const capabilitySet = new Set(Array.isArray(capabilities) ? capabilities : []);
  return policies.filter((policy) => policy?.enabled === true
    && intersects(policy.subjects, subjectSet)
    && intersects(policy.capabilities, capabilitySet));
}

function unavailableDecision() {
  return {
    allowed: false,
    mode: null,
    reason: "policy_unavailable",
    denyPolicyId: null,
    matchedPolicyIds: [],
  };
}

export function evaluateAccess({ snapshot, subjects, capabilities, nowMs }) {
  if (!snapshot || snapshot.status !== "ready") return unavailableDecision();
  const matched = matchingPolicies(snapshot, subjects, capabilities);
  if (matched.length === 0) {
    return {
      allowed: true,
      mode: null,
      reason: "no_matching_policy",
      denyPolicyId: null,
      matchedPolicyIds: [],
    };
  }
  const denied = matched.filter((policy) => !evaluatePolicySchedule(policy, nowMs).ok);
  const matchedPolicyIds = matched.map((policy) => policy.id);
  if (denied.length === 0) {
    return { allowed: true, mode: null, reason: "allowed", denyPolicyId: null, matchedPolicyIds };
  }
  // Any denial denies; hard revoke wins over suspend. denyPolicyId is the
  // first denied policy in document order that carries the final mode.
  const mode = denied.some((policy) => policy.mode === "revoke") ? "revoke" : "suspend";
  const denyPolicy = denied.find((policy) => policy.mode === mode);
  return {
    allowed: false,
    mode,
    reason: "outside_window",
    denyPolicyId: denyPolicy?.id ?? null,
    matchedPolicyIds,
  };
}

// First instant at which every matched policy is simultaneously satisfied, or
// null. Uses each policy's own nextAllowedAt as the step target (INTERFACE §4.8).
function unionNextAllowed(matched, nowMs) {
  let cursor = nowMs;
  for (let step = 0; step < MAX_UNION_STEPS; step++) {
    const unsatisfied = matched.filter((policy) => !evaluatePolicySchedule(policy, cursor).ok);
    if (unsatisfied.length === 0) return cursor;
    let next = null;
    for (const policy of unsatisfied) {
      const { nextAllowedAt } = nextTransition(policy, cursor);
      if (nextAllowedAt === null) return null;
      if (next === null || nextAllowedAt < next) next = nextAllowedAt;
    }
    if (next === null || next <= cursor) return null;
    cursor = next;
  }
  return null;
}

export function explainAccess({ snapshot, subjects, capabilities, nowMs }) {
  const decision = evaluateAccess({ snapshot, subjects, capabilities, nowMs });
  const now = new Date(nowMs).toISOString();
  if (!snapshot || snapshot.status !== "ready") {
    return { ...decision, now, timezone: null, nextChangeAt: null, nextAllowedAt: null };
  }
  const matched = matchingPolicies(snapshot, subjects, capabilities);
  if (matched.length === 0) {
    return { ...decision, now, timezone: null, nextChangeAt: null, nextAllowedAt: null };
  }
  const timezone = decision.allowed
    ? matched[0].timezone
    : (matched.find((policy) => policy.id === decision.denyPolicyId)?.timezone ?? matched[0].timezone);
  let nextChangeMs = null;
  for (const policy of matched) {
    const { nextChangeAt } = nextTransition(policy, nowMs);
    if (nextChangeAt !== null && (nextChangeMs === null || nextChangeAt < nextChangeMs)) nextChangeMs = nextChangeAt;
  }
  const nextAllowedMs = unionNextAllowed(matched, nowMs);
  return {
    ...decision,
    now,
    timezone,
    nextChangeAt: nextChangeMs === null ? null : new Date(nextChangeMs).toISOString(),
    nextAllowedAt: nextAllowedMs === null ? null : new Date(nextAllowedMs).toISOString(),
  };
}
