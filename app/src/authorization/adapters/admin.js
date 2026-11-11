// P2 / Task 18 — the Admin surface as a read-only explanation, plus subject projections.
// A new file outside the plan's file list: pure mapping plus observation, no decision.
//
// Contract: design §6.1.8 and §12. The console is not a person's credential: an
// `admin-session` actor carries NO subject (design §6), so no account's time window and
// no user revoke can change a console answer, and a console request is never turned into
// a transport refusal by an account constraint. The console never reads content; it only
// explains the catalog.
//
// `projectSubjectAuthorization` is the one projection used by every explanation: it asks
// the decision service once per (capability, target) and never unions a credential's
// grants, so two tokens with different ceilings can never be shown as one full token.

import { verifiedActor } from "../actors.js";
import { withShadowRequest } from "../shadow.js";
import { authorizationOperation, capabilityForBoundary, isOutsideTemporalPlane, surfaceForBoundary } from "../catalog.js";
import { AUTHORIZATION_DECISION_CODES } from "../evaluate.js";

const C = AUTHORIZATION_DECISION_CODES;

/** The old console's answer: an authenticated Admin session may read the explanation. */
export const ADMIN_LEGACY_VERDICTS = Object.freeze({
  allowed: Object.freeze({ allowed: true, code: C.ALLOWED }),
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `adminVerifiedActor() -> VerifiedActor` — one console session, no subject, one proof. */
export function adminVerifiedActor() {
  return verifiedActor("admin-session", {
    subjectIds: [],
    credentialId: "admin:session",
    credentialEpochs: {},
    grantCeiling: null,
    audience: null,
    expiresAt: null,
    revoked: false,
    transferGeneration: 0,
    proof: { kind: "admin-session" },
  });
}

/**
 * `adminAuthorizationRequest({routeKey, vaultId, epochs}) -> AuthorizationRequest|null`
 *
 * The Admin boundary key is `ADMIN <METHOD> <path>`, exactly as the P0 manifest records it,
 * so the capability and the surface come from the one catalog map.
 */
export function adminAuthorizationRequest({ routeKey, vaultId = null, epochs = null } = {}) {
  if (typeof routeKey !== "string" || routeKey.length === 0) return null;
  const capability = capabilityForBoundary(routeKey);
  const surface = surfaceForBoundary(routeKey);
  if (capability === null || surface !== "admin") return null;
  const operation = authorizationOperation(capability);
  if (operation === null || !operation.surfaces.includes("admin")) return null;
  if (isOutsideTemporalPlane(capability)) return null;
  let target;
  if (operation.targetKind === "vault") {
    if (typeof vaultId !== "string" || vaultId.length === 0) return null;
    target = { kind: "vault", vaultId };
  } else if (operation.targetKind === "instance") {
    target = { kind: "instance" };
  } else {
    return null;
  }
  // The transitional bridge phase: a trusted control surface, whose own verifier produced the
  // proof before this request existed (P3/P6: the field disappears with the bridge).
  return { actor: adminVerifiedActor(), capability, target, surface, legacy: { phase: "admin" } };
}

let adminSequence = 0;

/**
 * `observeAdminRead({shadow, routeKey, vaultId, legacyDecision}) -> void`
 *
 * One row per console read, in its own nested scope (a page read is its own unit). The
 * actor has no subject, so an account window or a user revoke can only ever produce a
 * non-matching constraint, never a deny and never a transport refusal.
 */
export function observeAdminRead({ shadow, routeKey, vaultId = null, legacyDecision = ADMIN_LEGACY_VERDICTS.allowed } = {}) {
  if (shadow === null || shadow === undefined || typeof shadow.compare !== "function") return;
  const request = adminAuthorizationRequest({ routeKey, vaultId });
  if (request === null) return;
  const run = () => shadow.compare({ request, legacyDecision, boundaryKey: routeKey, phase: "admin" });
  if (typeof shadow.begin !== "function") {
    run();
    return;
  }
  const scope = shadow.begin({ requestId: `admin-${adminSequence += 1}` });
  try {
    withShadowRequest(scope, run);
  } finally {
    scope.end();
  }
}

/**
 * `projectSubjectAuthorization({actor, targets, capabilities, authorization}) -> DecisionProjection[]`
 *
 * One decision per (capability, target) pair, from the ONE decision service. No union: a
 * credential's own ceiling is part of its actor, so two tokens with different ceilings
 * produce different projections and can never be displayed as one full token. A pair the
 * service cannot answer is `inconclusive`, never `allowed`.
 */
export function projectSubjectAuthorization({ actor, targets = [], capabilities = [], authorization = null } = {}) {
  const ask = typeof authorization === "function" ? authorization : (typeof authorization?.authorize === "function" ? (request) => authorization.authorize(request) : null);
  if (ask === null || !Array.isArray(targets) || !Array.isArray(capabilities)) return [];
  const projections = [];
  for (const capability of capabilities) {
    const operation = authorizationOperation(capability);
    if (operation === null) {
      projections.push({ capability, targetKind: null, allowed: false, code: C.OPERATION_UNKNOWN, mode: null });
      continue;
    }
    for (const target of targets) {
      if (!isRecord(target) || target.kind !== operation.targetKind) continue;
      let decision;
      try {
        decision = ask({ actor, capability, target, surface: operation.surfaces[0] ?? "admin" });
      } catch {
        decision = null;
      }
      projections.push({
        capability,
        targetKind: target.kind,
        allowed: isRecord(decision) && decision.allowed === true,
        code: isRecord(decision) && typeof decision.code === "string" ? decision.code : C.STATE_UNAVAILABLE,
        mode: isRecord(decision) ? decision.mode ?? null : null,
      });
    }
  }
  return projections;
}
