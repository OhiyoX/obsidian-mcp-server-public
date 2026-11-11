// P2 / Task 19 — the temporary legacy decision backend, isolated.
//
// Contract: design §10 P2 and §6.1. This module is the ONLY place that may turn an old
// plane verdict into an `AuthorizationDecision`. The runtime calls it in `legacy` and
// `shadow` mode, because in both of them the response must be the old verdict: a shadow
// row compares that answer with the new model, it never replaces it. `enforce` must not
// reach it at all. Its removal belongs to P6.
//
// The old rules are NOT re-derived here. The backend is injected (`snapshot.legacy`)
// together with the frozen old inputs it needs, so nothing can be inferred backwards from
// the new grants, and a missing backend is a deny rather than a guess.
//
// `LEGACY_BACKEND_BOUNDARIES` is the complete list of boundaries that can reach the old
// backend. It is derived from `catalog.js` (never typed by hand), so a new boundary cannot
// enter the product without a decision about which side of the line it sits on:
//   * the trusted contexts (admin, publish, system) decide from their own proof;
//   * an operation outside the temporal plane is never evaluated (§4.1a);
//   * every other boundary is a legacy-backend boundary.

import { requiredScopesForTools } from "../scopes.js";
import { isVaultScopedTool } from "../vault-scope.js";
import { authorizationOperation, capabilityForBoundary, catalogBoundaryKeys, isOutsideTemporalPlane, surfaceForBoundary } from "./catalog.js";
import { AUTHORIZATION_DECISION_CODES } from "./evaluate.js";

const C = AUTHORIZATION_DECISION_CODES;
const TRUSTED_SURFACES = new Set(["admin", "publish", "system"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The boundaries whose verdict the legacy temporal plane really produced. */
export const LEGACY_BACKEND_BOUNDARIES = Object.freeze(
  catalogBoundaryKeys.filter((key) => {
    const capability = capabilityForBoundary(key);
    const surface = surfaceForBoundary(key);
    if (capability === null || surface === null) return false;
    if (TRUSTED_SURFACES.has(surface)) return false;
    if (isOutsideTemporalPlane(capability)) return false;
    return authorizationOperation(capability) !== null;
  }),
);

/** The trusted-context boundaries: they never reach the legacy backend. */
export const TRUSTED_BOUNDARIES = Object.freeze(
  catalogBoundaryKeys.filter((key) => TRUSTED_SURFACES.has(surfaceForBoundary(key))),
);

/** The exempt boundaries: the legacy plane never evaluated them either (§4.1a). */
export const EXEMPT_BOUNDARIES = Object.freeze(
  catalogBoundaryKeys.filter((key) => isOutsideTemporalPlane(capabilityForBoundary(key))),
);

function deny(code, enforcement = "operation") {
  return Object.freeze({
    allowed: false,
    code,
    enforcement,
    mode: null,
    revision: null,
    matchedConstraintIds: Object.freeze([]),
    denyConstraintId: null,
    nextAllowedAt: null,
  });
}

/**
 * `authorizeLegacy(request, snapshot) -> AuthorizationDecision`
 *
 * `snapshot.legacy` is the injected old backend and the frozen old inputs:
 * `{evaluate(request) -> {allowed, reason, mode, denyPolicyId, enforcement, nextAllowedAt}}`.
 * The old reason names the family; this module only maps it to the decision code the rest
 * of the plane speaks. Nothing is inferred from the new grants, and no backend is a deny.
 */
export function authorizeLegacy(request, snapshot) {
  const legacy = isRecord(snapshot) ? snapshot.legacy : null;
  if (!isRecord(legacy) || typeof legacy.evaluate !== "function") return deny(C.STATE_UNAVAILABLE, "transport");
  if (!isRecord(request)) return deny(C.INVALID_CREDENTIAL, "transport");
  let verdict;
  try {
    verdict = legacy.evaluate(request);
  } catch {
    return deny(C.POLICY_UNAVAILABLE, "operation");
  }
  if (!isRecord(verdict) || typeof verdict.allowed !== "boolean") return deny(C.STATE_UNAVAILABLE, "transport");
  if (verdict.allowed === true) {
    return Object.freeze({
      allowed: true, code: C.ALLOWED, enforcement: "operation", mode: null, revision: null,
      matchedConstraintIds: Object.freeze([]), denyConstraintId: null, nextAllowedAt: null,
    });
  }
  const code = verdict.reason === "policy_unavailable" ? C.POLICY_UNAVAILABLE
    : verdict.reason === "outside_window" ? C.OUTSIDE_WINDOW
      : verdict.reason === "invalid_credential" ? C.INVALID_CREDENTIAL
        : verdict.reason === "insufficient_scope" ? C.INSUFFICIENT_SCOPE
          : verdict.reason === "vault_access_denied" ? C.VAULT_ACCESS_DENIED
            : C.CAPABILITY_DENIED;
  return Object.freeze({
    allowed: false,
    code,
    enforcement: verdict.enforcement === "transport" || code === C.INVALID_CREDENTIAL ? "transport" : "operation",
    mode: verdict.mode ?? null,
    revision: null,
    matchedConstraintIds: Object.freeze([]),
    denyConstraintId: verdict.denyPolicyId ?? null,
    nextAllowedAt: verdict.nextAllowedAt ?? null,
  });
}

// ---------------------------------------------------------------------------
// P3 / Task 20 — the extracted old algorithm, behind the same `authorize()`.
//
// Contract: design §10 P3 ("legacy/shadow 后端仍可用，旧算法从 handler 中抽出") and
// §6.1. The boundaries no longer decide: they gather the data the old plane read and
// hand it in as `request.legacy`, and this backend answers with the old verdict. Its
// removal belongs to P6.
//
// `request.legacy` is the frozen old input of ONE decision:
//   * `phase`       which old gate is asking (transport admission, the temporal gate,
//                   the Vault allowlist, a trusted control surface);
//   * `scopes`      the credential's protocol Scope list, captured at authentication;
//   * `allowedVaults` the credential's Vault allowlist, captured at authentication;
//   * `capabilities` the old capability set of the layer (absent = the old plane
//                   performed no check at all, e.g. the frozen metadata bypass);
//   * `bypass`      the metadata plane, which the old plane never evaluated (§A-07).
// None of these is a verdict, and no grant is inferred from the new model.

const STATIC_PHASES = new Set(["transport"]);
const TEMPORAL_PHASES = new Set(["tool", "resource", "web"]);
const TRUSTED_PHASES = new Set(["admin", "publish", "system", "trusted"]);

function allowedVerdict() {
  return { allowed: true, reason: "no_matching_policy", mode: null, denyPolicyId: null, enforcement: "operation", nextAllowedAt: null };
}

function refusedVerdict(reason, extra = {}) {
  return { allowed: false, reason, mode: null, denyPolicyId: null, enforcement: "operation", nextAllowedAt: null, ...extra };
}

function textList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * `createLegacyDecisionBackend({accessRuntime, ...}) -> {evaluate(request)}`
 *
 * `accessRuntime` is the old temporal plane. Without one the old plane performed no time
 * check, so every temporal phase allows — exactly what the old gates did when they were
 * built without a policy runtime.
 */
export function createLegacyDecisionBackend({ accessRuntime = null } = {}) {
  const temporal = accessRuntime !== null && typeof accessRuntime.evaluate === "function" ? accessRuntime : null;

  function subjectsOf(actor) {
    return Array.isArray(actor?.subjectIds) ? [...actor.subjectIds] : [];
  }

  // The old `hardRevokeDecision`: only a principal-wide revoke denies here. A suspend and a
  // broken plane stay content-layer concerns (design §6.1.3).
  function revoke(request) {
    if (temporal === null) return allowedVerdict();
    const subjects = subjectsOf(request.actor);
    const capabilities = ["all"];
    const decision = temporal.evaluate({ subjects, capabilities });
    if (!isRecord(decision) || decision.allowed !== false || decision.mode !== "revoke") return allowedVerdict();
    let nextAllowedAt = null;
    try {
      nextAllowedAt = temporal.explain?.({ subjects, capabilities })?.nextAllowedAt ?? null;
    } catch {
      nextAllowedAt = null;
    }
    return refusedVerdict("outside_window", { mode: "revoke", enforcement: "transport", denyPolicyId: decision.denyPolicyId ?? null, nextAllowedAt });
  }

  // The old protocol Scope check, then the old Vault allowlist, in the frozen order
  // (contract §8: an insufficient Scope precedes an unauthorized Vault).
  function staticCheck(request, facts) {
    const scopes = textList(facts.scopes);
    const missing = requiredScopesForTools([request.capability]).filter((scope) => !scopes.includes(scope));
    if (missing.length > 0) return refusedVerdict("insufficient_scope");
    if (!isVaultScopedTool(request.capability)) return allowedVerdict();
    const vaultId = request.target?.kind === "vault" ? request.target.vaultId : null;
    if (vaultId === null || !textList(facts.allowedVaults).includes(vaultId)) return refusedVerdict("vault_access_denied");
    return allowedVerdict();
  }

  // The old Web Scope class rule: the handler re-checked the account's protocol Scopes
  // before it touched content.
  function scopeClass(request, facts) {
    const scopes = textList(facts.scopes);
    const needed = textList(facts.capabilities)
      .filter((capability) => capability.startsWith("scope:"))
      .map((capability) => capability.slice("scope:".length));
    if (needed.every((scope) => scopes.includes(scope))) return allowedVerdict();
    return refusedVerdict("insufficient_scope");
  }

  function vaultMembership(request, facts) {
    const vaultId = request.target?.kind === "vault" ? request.target.vaultId : null;
    if (vaultId === null || !textList(facts.allowedVaults).includes(vaultId)) return refusedVerdict("vault_access_denied");
    return allowedVerdict();
  }

  // The old temporal gate: an allow, the 403 deny, or the broken-plane refusal.
  function temporalCheck(request, facts) {
    if (facts.bypass === true) return allowedVerdict();
    const capabilities = textList(facts.capabilities);
    if (capabilities.length === 0 || temporal === null) return allowedVerdict();
    const subjects = subjectsOf(request.actor);
    const decision = temporal.evaluate({ subjects, capabilities });
    if (isRecord(decision) && decision.allowed === true) return allowedVerdict();
    if (!isRecord(decision) || decision.reason !== "outside_window" || !decision.mode) {
      return refusedVerdict("policy_unavailable");
    }
    let nextAllowedAt = null;
    try {
      nextAllowedAt = temporal.explain?.({ subjects, capabilities })?.nextAllowedAt ?? null;
    } catch {
      nextAllowedAt = null;
    }
    return refusedVerdict("outside_window", { mode: decision.mode, denyPolicyId: decision.denyPolicyId ?? null, nextAllowedAt });
  }

  function evaluate(request) {
    const facts = isRecord(request?.legacy) ? request.legacy : null;
    const phase = typeof facts?.phase === "string" ? facts.phase : "";
    switch (phase) {
      case "revoke": return revoke(request);
      // The old layers that only checked the credential's Vault allowlist: the Vault-scope
      // wrapper (a duplicate defence) and the Web target containment.
      case "vault-scope":
      case "web-vault": return vaultMembership(request, facts);
      case "web-scope": return scopeClass(request, facts);
      // The direct-upload data plane carried its own Scope rule AND the same temporal gate
      // the MCP tool goes through.
      case "upload": {
        const scopes = textList(facts.scopes);
        const missing = textList(facts.requiredScopes).filter((scope) => !scopes.includes(scope));
        if (missing.length > 0) return refusedVerdict("insufficient_scope");
        return temporalCheck(request, facts);
      }
      case "admin":
      case "publish":
      case "system": return allowedVerdict();
      default: break;
    }
    if (STATIC_PHASES.has(phase)) return staticCheck(request, facts);
    if (TEMPORAL_PHASES.has(phase)) return temporalCheck(request, facts);
    // No old gate asked for this decision: the bridge cannot reproduce an answer, so it
    // does not invent one.
    return refusedVerdict("policy_unavailable");
  }

  return { evaluate };
}
