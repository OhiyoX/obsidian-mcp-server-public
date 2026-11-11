import { timingSafeEqual } from "node:crypto";
import {
  bodyClientInfo, buildRequestUsage,
} from "./request-attribution.js";
import { attachSessionAuth, registerSessionClientInfoFromRequest } from "./session-client-info.js";
import { headerValue, jsonRpcError } from "./http.js";
import { withRequestContext } from "./request-context.js";
import { OAUTH_ENABLED } from "./server-config.js";
import { configuredApiKeyVaults } from "./config.js";
import { DEFAULT_VAULT_ID, OAUTH_SCOPES } from "./oauth-provider.js";
import { requiredScopesForTools } from "./scopes.js";
import { projectCompactCall } from "./compact-tools.js";
import { isVaultScopedTool } from "./vault-scope.js";
import { effectiveVaultId } from "./default-vault.js";
import { mapMcpAuthorizationDenial, mcpAuthorizationRequest, mcpVerifiedActor } from "./authorization/adapters/mcp.js";
import { AUTHORIZATION_DECISION_CODES } from "./authorization/evaluate.js";
import { createAuthorizationSeam } from "./authorization/runtime.js";
import { withShadowRequest } from "./authorization/shadow.js";

const DEFAULT_API_KEY_HEADER = "X-API-Key";

export const API_KEY = process.env.API_KEY || "";
export const API_KEY_HEADER_NAME = process.env.API_KEY_HEADER || DEFAULT_API_KEY_HEADER;
export const API_KEY_HEADER = API_KEY_HEADER_NAME.toLowerCase();
export const apiKeyRequired = Boolean(API_KEY);
export const oauthEnabled = OAUTH_ENABLED;
export const authMode = OAUTH_ENABLED ? (API_KEY ? "hybrid" : "oauth") : (API_KEY ? "api-key" : "none");

function safeEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authCorsHeaders() {
  if (API_KEY_HEADER === DEFAULT_API_KEY_HEADER.toLowerCase()) return [DEFAULT_API_KEY_HEADER];
  return [API_KEY_HEADER_NAME, DEFAULT_API_KEY_HEADER];
}

export function apiKeyMiddleware(req, res, next) {
  if (!API_KEY) {
    next();
    return;
  }

  const authorization = headerValue(req, "authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const apiKeyHeader = headerValue(req, API_KEY_HEADER) || "";
  const candidates = [bearer, apiKeyHeader].filter(Boolean);

  if (candidates.some((candidate) => safeEquals(candidate, API_KEY))) {
    next();
    return;
  }

  res.setHeader("WWW-Authenticate", "Bearer");
  jsonRpcError(res, 401, -32001, "Unauthorized: missing or invalid API key");
}

function requestMessages(req) {
  return Array.isArray(req.body) ? req.body : [req.body];
}

function requestedScopes(req) {
  const tools = requestMessages(req)
    .filter((message) => message?.method === "tools/call")
    .map((message) => projectCompactCall(message?.params?.name, message?.params?.arguments).name)
    .filter(Boolean);
  return requiredScopesForTools(tools);
}

// Contract §9 ("HTTP allowedVault gate"): the required Vault set is derived from the
// canonical vault-scope registry (`vault-scope.js`, contract §43-3 — never a second
// hand-maintained set). Global tools (§7.1) and unknown tool names (§9.1) add no Vault
// requirement; identity defaults apply only when vaultId was omitted.
export function requestedVaults(req, auth) {
  const calls = requestMessages(req).filter((message) => message?.method === "tools/call");
  if (!calls.length) return null;
  const required = new Set();
  for (const call of calls) {
    const projected = projectCompactCall(call?.params?.name, call?.params?.arguments);
    if (!isVaultScopedTool(projected.name)) continue;
    const id = effectiveVaultId(projected.args, auth, DEFAULT_VAULT_ID);
    required.add(typeof id === "string" && id ? id : "\\u0000invalid-vault-id");
  }
  return [...required];
}

function deniedVault(auth, req) {
  const required = requestedVaults(req, auth);
  if (!required) return null;
  return required.find((vaultId) => !auth.allowedVaults.includes(vaultId)) || null;
}

function oauthChallenge(oauthService, scopes, error, description, req) {
  const origin = oauthService.resolveOrigin?.(req) || String(oauthService.issuer.origin || oauthService.issuer.href).replace(/\/+$/, "");
  const resourcePath = oauthService.resourceForOrigin?.(origin)?.pathname || oauthService.resource.pathname;
  const metadata = new URL(`/.well-known/oauth-protected-resource${resourcePath}`, `${origin}/`).href;
  const fields = [];
  if (error) fields.push(`error="${error}"`);
  if (description) fields.push(`error_description="${description.replaceAll('"', "'")}"`);
  fields.push(`resource_metadata="${metadata}"`);
  fields.push(`scope="${scopes.join(" ")}"`);
  return `Bearer ${fields.join(", ")}`;
}

/** Request-level audit envelope; attribution layering lives in request-attribution.js. */
function requestUsage(req) {
  return buildRequestUsage(req);
}

// ---------------------------------------------------------------------------
// AuthZ Wave B / B2 — hard revoke at the HTTP auth layer + truthful usage (A-10).
//
// P3 / Task 20: this layer no longer decides anything. It authenticates, gathers the
// frozen data the old plane read (the Compact projection, the requested Vault, the
// credential's Scope and Vault lists), and hands ONE authorization request per
// `tools/call` member plus one principal-wide revoke request to the runtime. The
// runtime's verdict is the answer: a hard revoke is still a transport 401, a whole-batch
// static refusal still refuses the batch, and the Scope family still precedes the Vault
// family (design §6.1.1).
// ---------------------------------------------------------------------------

/** Principal-wide capability set the old auth layer used for its hard-revoke decision. */
const HARD_REVOKE_CAPABILITIES = Object.freeze(["all"]);

/**
 * Request-level usage deferral for `tools/call` requests.
 *
 * `state` is handed to the request context as `authzUsage` (frozen key name), so
 * the access-policy registrar can flip `denied` when the tool-layer time gate
 * rejects the call. The captured commit then never runs, which is what makes the
 * final audit truthful (A-10) instead of reporting a success for a denied call.
 */
function usageDeferral(res) {
  const state = { denied: false };
  let commit = null;
  res.on("finish", () => {
    const pending = commit;
    commit = null;
    if (state.denied || !pending) return;
    Promise.resolve().then(pending).catch(() => {});
  });
  return {
    state,
    schedule(fn) { commit = fn; },
    run(next) { return withRequestContext({ authzUsage: state }, () => next()); },
  };
}

export { requestedScopes };

export function createAuthMiddleware(oauthService, { accessRuntime, authorization = null, onHardRevoke, authorizationShadow = null } = {}) {
  // The one decision. An injected runtime decides (and, in `legacy` mode, delegates to the
  // extracted old algorithm); without one the same extracted backend answers. No branch
  // below reads a Scope list or a Vault list to decide.
  const decide = createAuthorizationSeam({ authorization, accessRuntime });
  const decisionLayer = authorization ?? accessRuntime ?? null;
  const hardRevokeHook = typeof onHardRevoke === "function" ? onHardRevoke : null;
  const shadow = authorizationShadow;

  /**
   * The frozen old input of one decision: the credential's protocol Scopes and its Vault
   * allowlist, captured at authentication, plus which old gate is asking. Data only.
   */
  function legacyFacts(auth, phase) {
    return { phase, scopes: [...(auth?.scopes ?? [])], allowedVaults: [...(auth?.allowedVaults ?? [])] };
  }

  function membersOf(req) {
    return requestMessages(req)
      .filter((message) => message?.method === "tools/call")
      .map((message) => projectCompactCall(message?.params?.name, message?.params?.arguments));
  }

  /** One authorization request per `tools/call` member, from the canonical adapter. */
  function memberRequests(req, auth) {
    const requests = [];
    for (const projected of membersOf(req)) {
      const request = mcpAuthorizationRequest({
        authInfo: auth,
        name: projected.name,
        args: projected.args,
        primaryVaultId: DEFAULT_VAULT_ID,
        legacy: legacyFacts(auth, "transport"),
      });
      // Unknown name or an exempt operation: the old plane had no rule for it, so the
      // protocol keeps that answer and nothing is decided here.
      if (request !== null) requests.push({ projected, request });
    }
    return requests;
  }

  function observe(request, projected, decision, phase = "transport") {
    if (shadow === null || typeof shadow.compare !== "function" || request === null) return;
    shadow.compare({ request, legacyDecision: decision, boundaryKey: projected?.name ?? null, phase });
  }

  /**
   * The principal-wide unit: one decision per request, transport enforcement only. A
   * suspend and a broken plane stay content-layer concerns, exactly as before.
   */
  function revokeRefusal(req, auth) {
    const actor = mcpVerifiedActor({ authInfo: auth });
    if (actor === null) {
      // A credential without a usable subject was reachable before only through the old
      // Scope/Vault arrays; an unbuildable principal is refused, never admitted.
      return Object.freeze({
        allowed: false, code: AUTHORIZATION_DECISION_CODES.INVALID_CREDENTIAL, enforcement: "transport",
        mode: null, revision: null, matchedConstraintIds: [], denyConstraintId: null, nextAllowedAt: null,
      });
    }
    // The target is irrelevant to a principal-wide rule; the phase names it.
    const decision = decide.authorize({
      actor,
      capability: "server_info",
      target: { kind: "instance" },
      surface: "mcp",
      legacy: legacyFacts(auth, "revoke"),
    });
    if (decision.allowed !== false || decision.enforcement !== "transport") return null;
    return decision;
  }

  /**
   * The static families this layer may refuse. An operation denial (a suspend window, a
   * capability gap, an unreadable plane) is NOT one of them: admission accepts the batch
   * transport, and the tool/resource wrapper re-asks and refuses the content (§6.1.3).
   */
  const STATIC_REFUSAL_CODES = new Set([
    AUTHORIZATION_DECISION_CODES.INVALID_CREDENTIAL,
    AUTHORIZATION_DECISION_CODES.INSUFFICIENT_SCOPE,
    AUTHORIZATION_DECISION_CODES.VAULT_ACCESS_DENIED,
    AUTHORIZATION_DECISION_CODES.VAULT_ID_INVALID,
    AUTHORIZATION_DECISION_CODES.VAULT_UNAVAILABLE,
  ]);

  function refusesAdmission(decision) {
    if (decision?.allowed !== false) return false;
    return decision.enforcement === "transport" || STATIC_REFUSAL_CODES.has(decision.code);
  }

  /**
   * The batch refusal: every member is decided, any static deny refuses the whole batch,
   * and the family never depends on member order (a transport denial first, then the Scope
   * family, then the Vault family).
   */
  function admissionRefusal(req, auth) {
    const entries = memberRequests(req, auth).map((entry) => ({ ...entry, decision: decide.authorize(entry.request) }));
    for (const entry of entries) observe(entry.request, entry.projected, entry.decision);
    const refused = entries.filter((entry) => refusesAdmission(entry.decision));
    if (refused.length === 0) return null;
    return refused.find((entry) => entry.decision.enforcement === "transport")
      ?? refused.find((entry) => entry.decision.code === AUTHORIZATION_DECISION_CODES.INSUFFICIENT_SCOPE)
      ?? refused[0];
  }

  /** One audit record per refusal; the fields are the ones the old families carried. */
  function recordRefusal(usage, credential, auth, detail) {
    try {
      oauthService?.provider?.recordAudit?.({
        ...usage,
        action: "auth.reject",
        credentialType: credential.credentialType,
        ...(credential.credentialId ? { credentialId: credential.credentialId } : {}),
        ...(credential.clientId ?? auth?.clientId ? { clientId: credential.clientId ?? auth.clientId } : {}),
        ...(auth?.scopes ? { scopes: auth.scopes } : {}),
        ...(auth?.allowedVaults ? { vaults: auth.allowedVaults } : {}),
        outcome: "failure",
        detail,
      });
    } catch {}
  }

  function refuse(req, res, refused, { credential, usage, challenge = null }) {
    const decision = refused.decision;
    // The missing Scope names are the ones the existing challenge and body describe; they
    // are presentation data for the family the decision already chose.
    const missing = decision.code === AUTHORIZATION_DECISION_CODES.INSUFFICIENT_SCOPE
      ? requiredScopesForTools([refused.projected.name]).filter((scope) => !(credential.auth?.scopes ?? []).includes(scope))
      : [];
    const body = mapMcpAuthorizationDenial(decision, "transport", { missingScopes: missing });
    if (body === null) return false;
    if (decision.code === AUTHORIZATION_DECISION_CODES.INSUFFICIENT_SCOPE) {
      recordRefusal(usage, credential.descriptor, credential.auth, `missing scope: ${missing.join(" ")}`);
      if (oauthService) {
        const scopes = challenge === null
          ? [...new Set([...(credential.auth?.scopes ?? []), ...missing])]
          : challenge(missing);
        res.setHeader("WWW-Authenticate", oauthChallenge(oauthService, scopes, "insufficient_scope", "Additional permission is required", req));
      }
      res.status(403).json(body.body);
      return true;
    }
    if (body.status === 401) return false; // the caller owns the 401 family (its own challenge)
    recordRefusal(usage, credential.descriptor, credential.auth, refusalDetail(decision, refused));
    res.status(body.status).json(body.body);
    return true;
  }

  function refusalDetail(decision, refused) {
    if (decision.code === AUTHORIZATION_DECISION_CODES.VAULT_ACCESS_DENIED) {
      const vaultId = refused.request?.target?.kind === "vault" ? refused.request.target.vaultId : "";
      return `vault access denied: ${vaultId}`;
    }
    return `authorization denied: ${decision.code}`;
  }

  // Never throws: a failing audit or session-close hook must not turn a deny into an
  // allow. The response is always the existing `invalid_token` challenge family and
  // never carries policy details.
  async function denyHardRevoke(req, res, auth, credential, decision, usage) {
    try {
      oauthService?.provider.recordAudit({
        ...usage,
        action: "authz.deny",
        outcome: "failure",
        surface: "mcp",
        mode: "revoke",
        policyId: decision.denyConstraintId ?? null,
        nextAllowedAt: decision.nextAllowedAt ?? null,
        credentialType: credential.credentialType,
        ...(credential.credentialId ? { credentialId: credential.credentialId } : {}),
        ...(credential.clientId ? { clientId: credential.clientId } : {}),
        ...(credential.userId ? { userId: credential.userId } : {}),
      });
    } catch {}
    if (hardRevokeHook) {
      try {
        await hardRevokeHook(auth.clientId, { userId: auth.userId });
      } catch {}
    }
    if (oauthService) {
      res.setHeader("WWW-Authenticate", oauthChallenge(oauthService, OAUTH_SCOPES, "invalid_token", "Invalid or expired access token", req));
      res.status(401).json({ error: "invalid_token", error_description: "Invalid or expired access token" });
      return;
    }
    res.setHeader("WWW-Authenticate", "Bearer");
    jsonRpcError(res, 401, -32001, "Unauthorized: missing or invalid API key");
  }

  // One authorization-unit context per HTTP request: the transport layer below and
  // the tool/Vault layers of the same request share it, so the recorder can emit one
  // row per `tools/call` member instead of one per layer (§10 step 5).
  let shadowRequests = 0;

  /**
   * The revoke unit, for every credential branch. Returns true when the request was
   * answered (a 401), false when the runtime admitted the principal.
   */
  async function revokedAtAdmission(req, res, auth, credential, usage) {
    const decision = revokeRefusal(req, auth);
    if (decision === null) return false;
    // Every member still gets its own row, with the principal-wide verdict as its old side.
    for (const entry of memberRequests(req, auth)) observe(entry.request, entry.projected, decision, "transport");
    await denyHardRevoke(req, res, auth, credential, decision, usage);
    return true;
  }

  async function authenticate(req, res, next) {
    if (!API_KEY && !oauthService) {
      next();
      return;
    }

    const authorization = headerValue(req, "authorization") || "";
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
    const apiKeyHeader = headerValue(req, API_KEY_HEADER) || "";
    const usage = requestUsage(req);
    const initializeClientInfo = bodyClientInfo(req.body);
    if (initializeClientInfo) registerSessionClientInfoFromRequest(req, res, initializeClientInfo);
    const requestOrigin = oauthService?.resolveOrigin?.(req);
    if (requestOrigin) usage.origin = requestOrigin;
    // Only a request that the tool-layer time gate can deny needs its usage
    // deferred; without an injected decision layer there is nothing to gate, so every
    // request keeps the original immediate commit path unchanged.
    const deferral = decisionLayer && usage.tool ? usageDeferral(res) : null;

    if (API_KEY && [bearer, apiKeyHeader].filter(Boolean).some((candidate) => safeEquals(candidate, API_KEY))) {
      // Contract §9.2 (amended 2026-10-29): the configured key holds every OAuth scope; its Vault
      // grants are the primary plus whatever the deployment adds in `API_KEY_VAULTS` (the list
      // adds grants, it never removes the primary).
      const configuredVaults = [...new Set([DEFAULT_VAULT_ID, ...(configuredApiKeyVaults() ?? [])])];
      attachSessionAuth(req, usage, { type: "api-key", clientId: "api-key:configured-env", scopes: [...OAUTH_SCOPES], allowedVaults: [...configuredVaults], keyId: "configured-env" });
      const credential = { credentialType: "api-key", credentialId: "configured-env", clientId: req.auth.clientId };
      if (await revokedAtAdmission(req, res, req.auth, credential, usage)) return;
      const refused = admissionRefusal(req, req.auth);
      if (refused !== null) {
        refuse(req, res, refused, { credential: { auth: req.auth, descriptor: credential }, usage });
        return;
      }
      if (oauthService) {
        const commit = () => oauthService.provider.noteConfiguredApiKeyUse(usage);
        if (deferral) deferral.schedule(commit);
        else await commit();
      }
      if (deferral) {
        deferral.run(next);
        return;
      }
      next();
      return;
    }

    if (oauthService) {
      for (const candidate of [bearer, apiKeyHeader].filter(Boolean)) {
        let auth;
        try {
          // With a decision layer injected the gate must precede every usage commit, so
          // the credential is only formed here and the final record is written
          // after the hard revoke decision (A-10). Without one this is the
          // untouched legacy `verifyApiKey` path.
          auth = decisionLayer
            ? await oauthService.provider.verifyApiKeyDeferred(candidate)
            : await oauthService.provider.verifyApiKey(candidate, usage);
        } catch {
          continue;
        }
        attachSessionAuth(req, usage, auth);
        const credential = { credentialType: "api-key", credentialId: auth.keyId, clientId: auth.clientId };
        if (await revokedAtAdmission(req, res, auth, credential, usage)) return;
        const refused = admissionRefusal(req, auth);
        if (refused !== null) {
          refuse(req, res, refused, {
            credential: { auth, descriptor: credential },
            usage,
            challenge: (missing) => [...new Set([...auth.scopes, ...missing])],
          });
          return;
        }
        if (deferral) {
          deferral.schedule(() => oauthService.provider.noteApiKeyUse(auth, usage));
          deferral.run(next);
          return;
        }
        if (decisionLayer) await oauthService.provider.noteApiKeyUse(auth, usage);
        next();
        return;
      }
    }

    if (oauthService && bearer) {
      try {
        const expectedResource = oauthService.resourceForOrigin(requestOrigin);
        const auth = { ...(await oauthService.provider.verifyAccessToken(bearer, expectedResource)), type: "oauth" };
        attachSessionAuth(req, usage, auth);
        const credential = { credentialType: "oauth-access", clientId: auth.clientId, userId: auth.userId };
        if (await revokedAtAdmission(req, res, auth, credential, usage)) return;
        const refused = admissionRefusal(req, auth);
        if (refused !== null) {
          refuse(req, res, refused, {
            credential: { auth, descriptor: credential },
            usage,
            challenge: () => [...new Set([...auth.scopes, ...requiredScopesForTools([refused.projected.name])])],
          });
          return;
        }
        if (deferral) {
          deferral.schedule(() => oauthService.provider.noteAccessTokenUse(bearer, usage));
          deferral.run(next);
          return;
        }
        await oauthService.provider.noteAccessTokenUse(bearer, usage);
        next();
        return;
      } catch {
        if (res.headersSent) return;
        oauthService.provider.recordAudit({ ...usage, action: "auth.reject", credentialType: "unknown", outcome: "failure", detail: "invalid credential" });
        res.setHeader("WWW-Authenticate", oauthChallenge(oauthService, OAUTH_SCOPES, "invalid_token", "Invalid or expired access token", req));
        res.status(401).json({ error: "invalid_token", error_description: "Invalid or expired access token" });
        return;
      }
    }

    if (oauthService) {
      oauthService.provider.recordAudit({ ...usage, action: "auth.reject", credentialType: "none", outcome: "failure", detail: "missing credential" });
      res.setHeader("WWW-Authenticate", oauthChallenge(oauthService, OAUTH_SCOPES, undefined, undefined, req));
      res.status(401).json({ error: "invalid_token", error_description: "Missing access token" });
      return;
    }

    res.setHeader("WWW-Authenticate", "Bearer");
    jsonRpcError(res, 401, -32001, "Unauthorized: missing or invalid API key");
  }

  return async (req, res, next) => {
    if (shadow === null || typeof shadow.begin !== "function") return authenticate(req, res, next);
    const scope = shadow.begin({ requestId: `mcp-${shadowRequests += 1}` });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      try {
        scope.end();
      } catch {
        // The shadow never changes an answer.
      }
    };
    res.on("finish", end);
    res.on("close", end);
    return withShadowRequest(scope, () => authenticate(req, res, next));
  };
}
