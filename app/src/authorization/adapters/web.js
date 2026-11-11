// P2 / Task 11 — the Web adapter: normalize one Web request, carry the live session
// half of the identity projection, and map a new denial onto the existing families.
//
// Contract: design §6.1.4 and §6. The adapter maps and validates only; it never
// decides and never computes a grant.
//
// Three rules keep the shadow honest:
//   * `session_bootstrap` and `vault_select` are outside the temporal plane, so an
//     adapter returns `null` for them and nothing calls `authorize()` (design §9).
//     The public login chrome and the app shell therefore record no row;
//   * the Web actor carries a non-secret session key (the store's token hash), never
//     the cookie and never the raw token, and the identity projection carries the live
//     `sessions` entry the runtime requires (a missing entry denies every Web session);
//   * the target is the resolved one: the session's current Vault, or the decoded deep
//     link that the route already resolved before any content was read.

import { AsyncLocalStorage } from "node:async_hooks";

import { withShadowRequest } from "../shadow.js";

import { subjectsFromWebSession } from "../../access-policy/subjects.js";
import { decodeDocumentRoute } from "../../publish/service.js";
import { verifiedActor } from "../actors.js";
import { authorizationOperation, capabilityForBoundary, isOutsideTemporalPlane, surfaceForBoundary } from "../catalog.js";
import { AUTHORIZATION_DECISION_CODES } from "../evaluate.js";

const C = AUTHORIZATION_DECISION_CODES;

/**
 * The old Web gate's answer, named in the same vocabulary as the new codes. Each name
 * is the family the legacy response already carries: the 403 `outside_authorized_window`
 * temporal deny and the 503 `authorization_policy_unavailable` refusal.
 */
export const WEB_LEGACY_VERDICTS = Object.freeze({
  allowed: Object.freeze({ allowed: true, code: C.ALLOWED }),
  outsideWindow: Object.freeze({ allowed: false, code: C.OUTSIDE_WINDOW }),
  policyUnavailable: Object.freeze({ allowed: false, code: C.POLICY_UNAVAILABLE }),
});

const SUBJECT_ID_PATTERN_SAFE = /[\s\u0000-\u001f\u007f*]/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * `deepLinkVaultId(encoded) -> string|null`
 *
 * The target a `/app/note/*`, `/app/base/*` or `/app/canvas/*` deep link states,
 * decoded before any content is read. A malformed route states no target, and the
 * route's own error family owns that case (`null`, never a guess).
 */
export function deepLinkVaultId(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  try {
    const target = decodeDocumentRoute(encoded);
    return typeof target.vaultId === "string" && target.vaultId.length > 0 ? target.vaultId : null;
  } catch {
    return null;
  }
}

/**
 * `webVerifiedActor({session, epochs}) -> VerifiedActor|null`
 *
 * Kind `web-session`, one account subject, and the session's own non-secret key as
 * `credentialId`. The credential's `expiresAt` stays `null` on purpose: the live
 * expiry of a Web session belongs to the identity projection (§6 keeps session
 * membership and expiry there, so a logout applies to the next request).
 */
export function webVerifiedActor({ session, epochs = null } = {}) {
  if (!isRecord(session)) return null;
  const subjects = subjectsFromWebSession(session);
  if (subjects.length === 0) return null;
  const credentialId = typeof session.credentialId === "string" ? session.credentialId : "";
  if (credentialId.length === 0 || credentialId.length > 160 || SUBJECT_ID_PATTERN_SAFE.test(credentialId)) return null;
  const credentialEpochs = {};
  for (const subjectId of subjects) {
    const value = isRecord(epochs) ? epochs[subjectId] : undefined;
    credentialEpochs[subjectId] = Number.isInteger(value) && value >= 0 ? value : 0;
  }
  try {
    return verifiedActor("web-session", {
      subjectIds: subjects,
      credentialId,
      credentialEpochs,
      grantCeiling: null,
      audience: null,
      expiresAt: null,
      revoked: false,
      transferGeneration: 0,
      proof: null,
    });
  } catch {
    return null;
  }
}

/**
 * `webAuthorizationRequest({session, routeKey, vaultId, epochs})`
 * -> `{actor, capability, target, surface}|null`
 *
 * `routeKey` is the catalog boundary key (`<METHOD> <path>`), so the capability and the
 * surface come from the one catalog map and never from a second requirements table.
 * `vaultId` is the target the route already resolved (a decoded deep link); when it is
 * absent the session's current Vault is the target.
 */
export function webAuthorizationRequest({ session, routeKey, vaultId = null, epochs = null, legacy = null } = {}) {
  if (typeof routeKey !== "string" || routeKey.length === 0) return null;
  const capability = capabilityForBoundary(routeKey);
  const surface = surfaceForBoundary(routeKey);
  if (capability === null || surface !== "web") return null;
  const operation = authorizationOperation(capability);
  if (operation === null || !operation.surfaces.includes("web")) return null;
  // The exemption belongs to the operation, never to a request field.
  if (isOutsideTemporalPlane(capability)) return null;

  const actor = webVerifiedActor({ session, epochs });
  if (actor === null) return null;

  let target;
  if (operation.targetKind === "vault") {
    const id = typeof vaultId === "string" && vaultId.length > 0 ? vaultId : session?.vaultId;
    target = { kind: "vault", vaultId: id };
  } else if (operation.targetKind === "instance") {
    target = { kind: "instance" };
  } else {
    // A publication target is not a Web content boundary (§6.1.6 owns it).
    return null;
  }
  // The transitional bridge's frozen old input (the route's old capability class, its phase).
  // Data the old gate read, never a verdict; the new algorithm ignores it (P6 deletes it).
  return legacy === null ? { actor, capability, target, surface } : { actor, capability, target, surface, legacy };
}

let streamSequence = 0;

/**
 * `observeStreamDelivery({shadow, session, vaultId, legacyDecision}) -> void`
 *
 * One delivered SSE frame (or one heartbeat) is its own authorization unit: it opens a
 * NESTED scope, records one row, and ends it at once. Without the nesting the open
 * stream's request scope would hold the frame rows until the stream closes. Observation
 * only: nothing is returned and no frame is suppressed.
 */
export function observeStreamDelivery({ shadow, session, vaultId, legacyDecision = WEB_LEGACY_VERDICTS.allowed } = {}) {
  if (shadow === null || shadow === undefined || typeof shadow.compare !== "function") return;
  const routeKey = "GET /api/web/v1/events";
  const request = webAuthorizationRequest({ session, routeKey, vaultId });
  if (request === null) return;
  const run = () => withWebSessionIdentity(session, () => shadow.compare({ request, legacyDecision, boundaryKey: routeKey, phase: "stream" }));
  if (typeof shadow.begin !== "function") {
    run();
    return;
  }
  const scope = shadow.begin({ requestId: `sse-${streamSequence += 1}` });
  try {
    withShadowRequest(scope, run);
  } finally {
    scope.end();
  }
}

/** The live session half of the identity projection for the request in flight. */
const sessionScope = new AsyncLocalStorage();

function identityOf(session) {
  const actor = webVerifiedActor({ session });
  if (actor === null) return { sessions: {} };
  const subjectId = actor.subjectIds[0] ?? null;
  const expiresAt = Number.isFinite(session?.expiresAt) ? session.expiresAt : null;
  return { sessions: { [actor.credentialId]: { active: true, expiresAt, subjectId } } };
}

/**
 * Run `fn` with this request's session identity visible to the runtime's identity
 * source. The store already refused an absent, expired or revoked session before the
 * gate ran, so an entry here is `active`; the projection still carries the expiry, so
 * the runtime's own live check applies.
 */
export function withWebSessionIdentity(session, fn) {
  return sessionScope.run(identityOf(session), fn);
}

/** The session identity of the request in flight, or `null` (an MCP request, say). */
export function currentWebSessionIdentity() {
  return sessionScope.getStore() ?? null;
}

/**
 * `observeWebAuthorization({shadow, session, routeKey, vaultId, legacyDecision}) -> void`
 *
 * The one call shape every Web boundary uses. It returns nothing, so a route cannot
 * execute a shadow verdict by mistake, and an unbuildable request (an exempt route, an
 * unknown boundary, an unusable session) records nothing.
 */
export function observeWebAuthorization({ shadow, session, routeKey, vaultId = null, legacyDecision }) {
  if (shadow === null || shadow === undefined || typeof shadow.compare !== "function") return;
  const request = webAuthorizationRequest({ session, routeKey, vaultId });
  if (request === null) return;
  withWebSessionIdentity(session, () => shadow.compare({ request, legacyDecision, boundaryKey: routeKey, phase: "web" }));
}

/**
 * `mapWebAuthorizationDenial(decision, {page}) -> {status, body}|{status, redirect}|null`
 *
 * The P3/P4 bridge with today's families: the temporal 403 payload, the 503 broken
 * policy, the API 401 `Login required`, and for a page the login redirect or the 404
 * that hides a Vault the person may not see. An allow maps to `null`. P2 enforces
 * nothing, so no production path calls this yet.
 */
export function mapWebAuthorizationDenial(decision, { page = false } = {}) {
  if (!isRecord(decision) || decision.allowed === true) return null;
  const code = decision.code;
  if (code === C.OUTSIDE_WINDOW) {
    return {
      status: 403,
      body: {
        error: C.OUTSIDE_WINDOW,
        mode: decision.mode ?? null,
        policyId: decision.denyConstraintId ?? null,
        nextAllowedAt: decision.nextAllowedAt ?? null,
      },
    };
  }
  if (code === C.POLICY_UNAVAILABLE) return { status: 503, body: { error: C.POLICY_UNAVAILABLE } };
  if (code === C.STATE_UNAVAILABLE) return { status: 503, body: { error: C.STATE_UNAVAILABLE } };
  if (code === C.INVALID_CREDENTIAL) {
    return page ? { status: 303, redirect: "/auth/login" } : { status: 401, body: { error: "Login required" } };
  }
  if (code === C.VAULT_ACCESS_DENIED || code === C.VAULT_ID_INVALID || code === C.VAULT_UNAVAILABLE) {
    return page ? { status: 404 } : { status: 403, body: { error: "Vault access denied" } };
  }
  return { status: 403, body: { error: code } };
}
