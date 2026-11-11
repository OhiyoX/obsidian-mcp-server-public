// P2 / Task 10 — the MCP adapter: normalize one MCP request, and map a new denial
// onto the response families the server already returns.
//
// Contract: design §6.1.1-3 and §4.2. The adapter only maps and validates; it never
// computes a grant and never decides. The actor comes from the verified `authInfo`
// (never from a body, an argument or `_meta`), the target comes from the canonical
// default-Vault rule (never from a second table), and the Compact projection is done
// by the caller with `projectCompactCall`, so both algorithms see one name and one
// target.
//
// Two rules keep the shadow honest:
//   * an operation that is outside the temporal plane (`session_bootstrap`,
//     `vault_select`, ...) or that has no MCP boundary is `null` here, so no
//     adapter calls `authorize()` for it (the exemption belongs to the operation);
//   * an actor that cannot be built from a verified credential is `null`, so an
//     unauthenticated boundary records nothing instead of inventing a deny.

import { CONFIGURED_ENV_SUBJECT, subjectsFromAuthInfo } from "../../access-policy/subjects.js";
import { effectiveVaultId } from "../../default-vault.js";
import { verifiedActor } from "../actors.js";
import { credentialFactsFor } from "../credential-facts.js";
import { authorizationOperation, capabilityForBoundary, isOutsideTemporalPlane, surfaceForBoundary } from "../catalog.js";
import { AUTHORIZATION_DECISION_CODES } from "../evaluate.js";

const C = AUTHORIZATION_DECISION_CODES;

/**
 * The old layer's outcome, named in the same vocabulary as the new codes, so a row
 * compares a verdict with a verdict. Each name is the family the legacy response
 * already carries (401 `invalid_token`, 403 `insufficient_scope`, 403
 * `access_denied`, the tool refusal codes).
 */
export const MCP_LEGACY_VERDICTS = Object.freeze({
  allowed: Object.freeze({ allowed: true, code: C.ALLOWED }),
  invalidCredential: Object.freeze({ allowed: false, code: C.INVALID_CREDENTIAL }),
  insufficientScope: Object.freeze({ allowed: false, code: C.INSUFFICIENT_SCOPE }),
  vaultAccessDenied: Object.freeze({ allowed: false, code: C.VAULT_ACCESS_DENIED }),
  // A principal-wide revoke is an outside-window deny that maps the transport (401).
  revoked: Object.freeze({ allowed: false, code: C.OUTSIDE_WINDOW, enforcement: "transport", mode: "revoke" }),
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function authType(authInfo) {
  return textOf(authInfo?.type) || textOf(authInfo?.extra?.type);
}

// The deployment's own key is `environment-key`, a managed key is `api-key`, and an
// OAuth token is `oauth` (design §5.2). The subject decides the first two, because
// both arrive with `type: "api-key"`.
function credentialKind(authInfo, subjects) {
  if (authType(authInfo) !== "api-key") return "oauth";
  return subjects.length === 1 && subjects[0] === CONFIGURED_ENV_SUBJECT ? "environment-key" : "api-key";
}

/**
 * `mcpVerifiedActor({authInfo, epochs, grantCeiling}) -> VerifiedActor|null`
 *
 * The credential kind and id come from the verified authentication result. The frozen
 * ceiling and the committed epochs come from the composition root's facts (Task 23),
 * because an adapter cannot read the permission state and a default would be a lie:
 * `null` would widen a narrow token and `0` would refuse a committed epoch. A caller
 * that states its own value keeps it; without installed facts the legacy default 0
 * applies.
 */
export function mcpVerifiedActor({ authInfo, epochs = null, grantCeiling = null } = {}) {
  if (!isRecord(authInfo)) return null;
  const subjects = subjectsFromAuthInfo(authInfo);
  if (subjects.length === 0) return null;
  const kind = credentialKind(authInfo, subjects);
  const keyId = textOf(authInfo.keyId) || textOf(authInfo.extra?.keyId);
  const credentialId = kind === "oauth"
    ? `oauth:${textOf(authInfo.clientId)}:${textOf(authInfo.userId)}`.replace(/:+$/, "")
    : `api-key:${keyId === "configured-env" ? "configured-env" : keyId}`;
  if (credentialId.length > 160) return null;
  const facts = epochs === null || grantCeiling === null ? credentialFactsFor(authInfo) : null;
  const committedEpochs = isRecord(epochs) ? epochs : facts?.epochs ?? null;
  const credentialEpochs = {};
  for (const subjectId of subjects) {
    const value = isRecord(committedEpochs) ? committedEpochs[subjectId] : undefined;
    credentialEpochs[subjectId] = Number.isInteger(value) && value >= 0 ? value : 0;
  }
  const ceiling = grantCeiling === null ? facts?.grantCeiling ?? null : grantCeiling;
  try {
    return verifiedActor(kind, {
      subjectIds: subjects,
      credentialId,
      credentialEpochs,
      grantCeiling: ceiling,
      audience: null,
      expiresAt: null,
      revoked: false,
      transferGeneration: 0,
      proof: null,
    });
  } catch {
    // An unbuildable actor records nothing: an authorization row needs a real one.
    return null;
  }
}

/**
 * `mcpAuthorizationRequest({authInfo, name, args, resourceUri, primaryVaultId, epochs, grantCeiling})`
 * -> `{actor, capability, target, surface}|null`
 *
 * `name` must already be the Compact projection of the member (the HTTP gate and
 * the discovery dispatcher both project first). `args` are the projected arguments.
 * A resource always reads the primary Vault: resources never follow the ambient
 * Vault selection (contract §19).
 *
 * `actorOptional` exists for the one boundary whose old gate decided from the Scope
 * and Vault data alone: the direct-upload writer. A credential whose principal cannot
 * be named still has an old answer to replay, so the request is formed with a `null`
 * actor instead of being refused here. `enforce` mode still denies it (the runtime
 * brands the actor), and every other boundary keeps the strict default.
 */
export function mcpAuthorizationRequest({ authInfo, name, args = null, resourceUri = null, primaryVaultId, epochs = null, grantCeiling = null, legacy = null, actorOptional = false } = {}) {
  const boundaryKey = typeof resourceUri === "string" ? resourceUri : name;
  if (typeof boundaryKey !== "string" || boundaryKey.length === 0) return null;
  const capability = capabilityForBoundary(boundaryKey);
  const surface = surfaceForBoundary(boundaryKey);
  // Unknown boundary: discovery/protocol owns that semantics, not the authorizer.
  if (capability === null || surface !== "mcp") return null;
  const operation = authorizationOperation(capability);
  if (operation === null || !operation.surfaces.includes("mcp")) return null;
  // The exemption is a property of the operation, never of a request field. An exempt
  // identity or shell operation is never authorized (an adapter must not call `authorize()`
  // for it) and records nothing. The instance metadata plane is the one exempt family that
  // still forms a unit: it is a real tool call with a real actor, and its row is what proves
  // that a suspension does not reach it. The test is derived from the catalog itself
  // (§4.1a: an exempt operation is `grantable:false`, or an instance read).
  if (isOutsideTemporalPlane(capability)) {
    const metadataPlane = operation.grantable !== false && operation.targetKind === "instance" && operation.contentEffect === "read";
    if (!metadataPlane) return null;
  }
  if (typeof primaryVaultId !== "string" || primaryVaultId.length === 0) return null;

  const actor = mcpVerifiedActor({ authInfo, epochs, grantCeiling });
  if (actor === null && actorOptional !== true) return null;

  let target;
  if (operation.targetKind === "vault") {
    const vaultId = typeof resourceUri === "string" ? primaryVaultId : effectiveVaultId(args, authInfo, primaryVaultId);
    target = { kind: "vault", vaultId };
  } else if (operation.targetKind === "instance") {
    target = { kind: "instance" };
  } else {
    // A publication target is not an MCP boundary.
    return null;
  }
  // The transitional bridge's frozen old input (scopes, allowlist, phase). It is data the
  // old plane read, never a verdict; the new algorithm ignores it (P6 deletes it).
  return legacy === null ? { actor, capability, target, surface } : { actor, capability, target, surface, legacy };
}

function resultPayload(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { ...payload },
    isError: true,
  };
}

/**
 * `mapMcpAuthorizationDenial(decision, phase, evidence) -> response|null`
 *
 * The P3/P4 bridge: the existing families, unchanged. `phase: "transport"` gives
 * the HTTP body the middleware already returns; any other phase gives the tool or
 * resource refusal shape. P2 enforces nothing, so nothing calls this yet, and an
 * allow maps to `null`.
 */
export function mapMcpAuthorizationDenial(decision, phase = "operation", { vaultId = null, missingScopes = [] } = {}) {
  if (!isRecord(decision) || decision.allowed === true) return null;
  const code = decision.code;
  if (phase === "transport") {
    if (code === C.INVALID_CREDENTIAL || (code === C.OUTSIDE_WINDOW && decision.mode === "revoke")) {
      return { status: 401, body: { error: "invalid_token", error_description: "Invalid or expired access token" } };
    }
    if (code === C.INSUFFICIENT_SCOPE) {
      const missing = Array.isArray(missingScopes) ? missingScopes.join(" ") : "";
      return { status: 403, body: { error: "insufficient_scope", error_description: `Missing scope: ${missing}`.trim() } };
    }
    return { status: 403, body: { error: "access_denied", error_description: "Vault access denied" } };
  }
  if (code === C.OUTSIDE_WINDOW) {
    return resultPayload({
      code: C.OUTSIDE_WINDOW,
      mode: decision.mode ?? null,
      policyId: decision.denyConstraintId ?? null,
      nextAllowedAt: decision.nextAllowedAt ?? null,
    });
  }
  if (code === C.POLICY_UNAVAILABLE) return resultPayload({ code });
  if (code === C.VAULT_ACCESS_DENIED || code === C.VAULT_ID_INVALID || code === C.VAULT_UNAVAILABLE) {
    return resultPayload(vaultId === null ? { code } : { code, vaultId });
  }
  return resultPayload({ code });
}

/**
 * `observeDirectUploadAuthorization({shadow, authInfo, vaultId, primaryVaultId, legacyDecision})`
 *
 * The direct-upload data plane (`PUT`/`PATCH /uploads/:uploadId`) is the control tool
 * `start_direct_upload` on the Vault the handle is BOUND to, never on the ambient
 * default. The bound Vault is passed as an explicit target, so the same canonical
 * default-Vault rule applies and nothing is guessed from the account preference.
 * Called after the handle is located and before the body is read.
 */
export function observeDirectUploadAuthorization({ shadow, authInfo, vaultId, primaryVaultId, legacyDecision }) {
  if (typeof vaultId !== "string" || vaultId.length === 0) return;
  observeMcpAuthorization({
    shadow,
    authInfo,
    name: "start_direct_upload",
    args: { vaultId },
    primaryVaultId,
    legacyDecision,
    phase: "upload",
  });
}

/**
 * The old temporal gate's answer, in the row vocabulary: the two tool-refusal
 * codes the legacy payload already carries.
 */
export function observedToolVerdict(decision) {
  if (decision?.allowed === true) return MCP_LEGACY_VERDICTS.allowed;
  const broken = decision?.reason === "policy_unavailable";
  return Object.freeze({ allowed: false, code: broken ? C.POLICY_UNAVAILABLE : C.OUTSIDE_WINDOW });
}

/**
 * `observeMcpAuthorization({...}) -> void`
 *
 * The one call site shape every MCP boundary uses: normalize the actor and the
 * target once, hand the same values to the new algorithm through the runtime, and
 * say nothing back. A boundary that cannot be normalized (an unknown name, an
 * unverified actor, an exempt operation) records nothing.
 */
export function observeMcpAuthorization({
  shadow, authInfo, name = null, args = null, resourceUri = null, primaryVaultId,
  epochs = null, legacyDecision, phase = "tool", comparable = null, reason = null,
}) {
  if (shadow === null || shadow === undefined || typeof shadow.compare !== "function") return;
  const request = mcpAuthorizationRequest({ authInfo, name, args, resourceUri, primaryVaultId, epochs });
  if (request === null) return;
  shadow.compare({
    request,
    legacyDecision,
    boundaryKey: typeof resourceUri === "string" ? resourceUri : name,
    phase,
    comparable,
    reason,
  });
}
