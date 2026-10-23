import { timingSafeEqual } from "node:crypto";
import {
  bodyClientInfo, buildRequestUsage,
} from "./request-attribution.js";
import { attachSessionAuth, registerSessionClientInfoFromRequest } from "./session-client-info.js";
import { subjectsFromMcpAuth } from "./access-policy/subjects.js";
import { headerValue, jsonRpcError } from "./http.js";
import { withRequestContext } from "./request-context.js";
import { OAUTH_ENABLED } from "./server-config.js";
import { DEFAULT_VAULT_ID, OAUTH_SCOPES } from "./oauth-provider.js";
import { requiredScopesForTools } from "./scopes.js";
import { projectCompactCall } from "./compact-tools.js";
import { isVaultScopedTool } from "./vault-scope.js";
import { effectiveVaultId } from "./default-vault.js";

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
// Hard revoke is principal-wide and must stop a credential before it can reach
// Scope/Vault checks or the MCP transport, so it is evaluated here, right after
// the credential is verified. Only `allowed === false && mode === "revoke"`
// denies: `suspend` stays a content-gate concern and a broken runtime
// (`policy_unavailable`) is never disguised as `invalid_token`.
// ---------------------------------------------------------------------------

/** Principal-wide capability set used for the auth-layer hard revoke decision. */
const HARD_REVOKE_CAPABILITIES = Object.freeze(["all"]);

function hardRevokeDecision(accessRuntime, auth) {
  if (!accessRuntime || typeof accessRuntime.evaluate !== "function") return null;
  const decision = accessRuntime.evaluate({ subjects: subjectsFromMcpAuth(auth), capabilities: [...HARD_REVOKE_CAPABILITIES] });
  if (!decision || decision.allowed !== false || decision.mode !== "revoke") return null;
  return decision;
}

function nextAllowedAtFor(accessRuntime, auth) {
  try {
    const explained = accessRuntime.explain?.({ subjects: subjectsFromMcpAuth(auth), capabilities: [...HARD_REVOKE_CAPABILITIES] });
    return explained?.nextAllowedAt ?? null;
  } catch {
    return null;
  }
}

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

export function createAuthMiddleware(oauthService, { accessRuntime, onHardRevoke } = {}) {
  const runtime = accessRuntime || null;
  const hardRevokeHook = typeof onHardRevoke === "function" ? onHardRevoke : null;

  // Never throws: a failing audit or session-close hook must not turn a deny into
  // an allow. The response is always the existing `invalid_token` challenge family
  // and never carries policy details.
  async function denyHardRevoke(req, res, auth, credential, decision, usage) {
    try {
      oauthService?.provider.recordAudit({
        ...usage,
        action: "authz.deny",
        outcome: "failure",
        surface: "mcp",
        mode: "revoke",
        policyId: decision.denyPolicyId ?? null,
        nextAllowedAt: nextAllowedAtFor(runtime, auth),
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

  return async (req, res, next) => {
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
    const requiredScopes = requestedScopes(req);
    // Only a request that the tool-layer time gate can deny needs its usage
    // deferred; without an injected runtime there is nothing to gate, so every
    // request keeps the original immediate commit path unchanged.
    const deferral = runtime && usage.tool ? usageDeferral(res) : null;

    if (API_KEY && [bearer, apiKeyHeader].filter(Boolean).some((candidate) => safeEquals(candidate, API_KEY))) {
      attachSessionAuth(req, usage, { type: "api-key", clientId: "api-key:configured-env", scopes: [...OAUTH_SCOPES], allowedVaults: [DEFAULT_VAULT_ID], keyId: "configured-env" });
      const denied = hardRevokeDecision(runtime, req.auth);
      if (denied) {
        await denyHardRevoke(req, res, req.auth, { credentialType: "api-key", credentialId: "configured-env", clientId: req.auth.clientId }, denied, usage);
        return;
      }
      // Contract §9.2 ("Configured env API key") + §8 order: the key holds every OAuth scope,
      // so its scope gate is vacuously satisfied, but the Vault gate is not. A configured key
      // stays primary-only and must be refused here — before `next()` — for any other vaultId.
      const keyVaultDenied = deniedVault(req.auth, req);
      if (keyVaultDenied) {
        oauthService?.provider.recordAudit({ ...usage, action: "auth.reject", credentialType: "api-key", credentialId: "configured-env", clientId: req.auth.clientId, scopes: req.auth.scopes, vaults: req.auth.allowedVaults, outcome: "failure", detail: `vault access denied: ${keyVaultDenied}` });
        res.status(403).json({ error: "access_denied", error_description: "Vault access denied" });
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
          // With a runtime injected the gate must precede every usage commit, so
          // the credential is only formed here and the final record is written
          // after the hard revoke decision (A-10). Without a runtime this is the
          // untouched legacy `verifyApiKey` path.
          auth = runtime
            ? await oauthService.provider.verifyApiKeyDeferred(candidate)
            : await oauthService.provider.verifyApiKey(candidate, usage);
        } catch {
          continue;
        }
        attachSessionAuth(req, usage, auth);
        const denied = hardRevokeDecision(runtime, auth);
        if (denied) {
          await denyHardRevoke(req, res, auth, { credentialType: "api-key", credentialId: auth.keyId, clientId: auth.clientId }, denied, usage);
          return;
        }
        const missing = requiredScopes.filter((scope) => !auth.scopes.includes(scope));
        if (missing.length) {
          oauthService.provider.recordAudit({ ...usage, action: "auth.reject", credentialType: "api-key", credentialId: auth.keyId, clientId: auth.clientId, scopes: auth.scopes, outcome: "failure", detail: `missing scope: ${missing.join(" ")}` });
          res.setHeader("WWW-Authenticate", oauthChallenge(oauthService, [...new Set([...auth.scopes, ...missing])], "insufficient_scope", "Additional permission is required", req));
          res.status(403).json({ error: "insufficient_scope", error_description: `Missing scope: ${missing.join(" ")}` });
          return;
        }
        // Contract §8 order: required scopes are evaluated *before* the requested vault ids, so an
        // unauthorized Vault on a credential that also lacks a scope answers `insufficient_scope`.
        const vaultDenied = deniedVault(auth, req);
        if (vaultDenied) {
          oauthService.provider.recordAudit({ ...usage, action: "auth.reject", credentialType: "api-key", credentialId: auth.keyId, clientId: auth.clientId, scopes: auth.scopes, vaults: auth.allowedVaults, outcome: "failure", detail: `vault access denied: ${vaultDenied}` });
          res.status(403).json({ error: "access_denied", error_description: "Vault access denied" });
          return;
        }
        if (deferral) {
          deferral.schedule(() => oauthService.provider.noteApiKeyUse(auth, usage));
          deferral.run(next);
          return;
        }
        if (runtime) await oauthService.provider.noteApiKeyUse(auth, usage);
        next();
        return;
      }
    }

    if (oauthService && bearer) {
      try {
        const expectedResource = oauthService.resourceForOrigin(requestOrigin);
        const auth = { ...(await oauthService.provider.verifyAccessToken(bearer, expectedResource)), type: "oauth" };
        attachSessionAuth(req, usage, auth);
        const denied = hardRevokeDecision(runtime, auth);
        if (denied) {
          await denyHardRevoke(req, res, auth, { credentialType: "oauth-access", clientId: auth.clientId, userId: auth.userId }, denied, usage);
          return;
        }
        const missing = requiredScopes.filter((scope) => !auth.scopes.includes(scope));
        if (missing.length) {
          oauthService.provider.recordAudit({ ...usage, action: "auth.reject", credentialType: "oauth-access", clientId: auth.clientId, outcome: "failure", detail: `missing scope: ${missing.join(" ")}` });
          res.setHeader("WWW-Authenticate", oauthChallenge(oauthService, [...new Set([...auth.scopes, ...requiredScopes])], "insufficient_scope", "Additional permission is required", req));
          res.status(403).json({ error: "insufficient_scope", error_description: `Missing scope: ${missing.join(" ")}` });
          return;
        }
        // Contract §8 order: scopes before requested vault ids (see the api-key branch above).
        const vaultDenied = deniedVault(auth, req);
        if (vaultDenied) {
          oauthService.provider.recordAudit({ ...usage, action: "auth.reject", credentialType: "oauth-access", clientId: auth.clientId, scopes: auth.scopes, vaults: auth.allowedVaults, outcome: "failure", detail: `vault access denied: ${vaultDenied}` });
          res.status(403).json({ error: "access_denied", error_description: "Vault access denied" });
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
  };
}
