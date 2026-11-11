// AuthZ Wave B / B3 — Web content-plane temporal gate + SSE revalidation.
//
// Contract: `scratch/authz/INTERFACE.md` §10.3 (frozen 2026-10-05, base = Wave A
// integration head `45e838f`). This module is a thin adapter: it never parses
// schedules, never touches the Vault / a stat / a loader / a cache, and never
// mutates the durable Web session. It only normalizes the already-authenticated
// `req.webSession` into frozen AuthZ subjects (A2), maps a route class onto the
// frozen Web capabilities (A2), and asks the A4 runtime for a decision.
//
// Gate-before-content (A-06): every rejection happens here, before the caller's
// vault/stat/loader/cache handler can run. `req.webSession` is a precondition
// set by `requireApi`/`requirePage`; this module only reads its `userId`.
//
// Fail closed (A-11): a missing/empty Web subject, a non-`outside_window` deny
// (including a broken policy plane) and any evaluator exception resolve to a
// rejection (403/503), never to an allow.
//
// CSRF order (frozen): the caller wires `requireApi -> requireCsrf ->
// requireWebWrite/Files`, so an invalid CSRF token always yields the existing
// CSRF response and never reaches this gate (a temporal error can therefore not
// leak CSRF-token state). The gate itself does not inspect tokens.

import { capabilitiesForWebRoute } from "../access-policy/capabilities.js";
import { ACCESS_DENY_CODES } from "../access-policy/errors.js";
import {
  WEB_LEGACY_VERDICTS, mapWebAuthorizationDenial, observeWebAuthorization, webAuthorizationRequest, webVerifiedActor, withWebSessionIdentity,
} from "../authorization/adapters/web.js";
import { createAuthorizationSeam } from "../authorization/runtime.js";

const { OUTSIDE_WINDOW, POLICY_UNAVAILABLE } = ACCESS_DENY_CODES;

/**
 * Frozen per-route capability instances (INTERFACE §10.3):
 *   read     = obsidian.read
 *   write    = obsidian.read + obsidian.write
 *   files    = obsidian.read + obsidian.files
 *   metadata = never evaluated (A-07); an empty requirement set cannot deny
 *              even if a future caller evaluated it by mistake.
 */
/**
 * The single Scope the old Web handlers re-checked before touching content. It is one
 * Scope, not the route's whole class (a handler added `obsidian.files` on top of the read
 * class, and `obsidian.write` on top of the write class).
 */
export const WEB_ROUTE_SCOPE_CHECKS = Object.freeze({
  write: Object.freeze(["all", "surface:web", "scope:obsidian.write"]),
  files: Object.freeze(["all", "surface:web", "scope:obsidian.files"]),
});

export const WEB_CAPABILITIES = Object.freeze({
  read: Object.freeze(capabilitiesForWebRoute({ scopes: ["obsidian.read"] })),
  write: Object.freeze(capabilitiesForWebRoute({ scopes: ["obsidian.read", "obsidian.write"] })),
  files: Object.freeze(capabilitiesForWebRoute({ scopes: ["obsidian.read", "obsidian.files"] })),
  metadata: Object.freeze([]),
});

/**
 * Frozen per-route needs table for the Web *write* surface (WRITE-SURFACE-DESIGN
 * §3.1). Key = `<METHOD> <path>` exactly as registered on the Web router, value =
 * the scopes the route must hold. Every entry is the existing `write` class
 * (`[obsidian.read, obsidian.write]`); the table exists so that a *new* write
 * route cannot inherit the write pipeline by accident.
 *
 * Deny by default (issue #625): a write route whose key is missing here is
 * refused with 403 `web_write_route_not_registered` before any handler/Vault
 * work — with or without an injected policy runtime. Adding a Web write route
 * therefore means adding a row here; that is the whole contract.
 *
 * Deliberately absent: the auth plane (`POST /auth/login`, `POST /auth/logout`)
 * and the session plane (`POST /api/web/v1/vault/select`, which only switches the
 * session's current vault inside `allowedVaults`). None of them runs the write
 * pipeline, so none of them is gated by this table.
 */
export const WEB_WRITE_ROUTE_NEEDS = Object.freeze({
  "POST /api/web/v1/note": Object.freeze(["obsidian.read", "obsidian.write"]),
  "POST /api/web/v1/folder": Object.freeze(["obsidian.read", "obsidian.write"]),
  "POST /api/web/v1/rename": Object.freeze(["obsidian.read", "obsidian.write"]),
  "POST /api/web/v1/delete": Object.freeze(["obsidian.read", "obsidian.write"]),
  "POST /api/web/v1/asset": Object.freeze(["obsidian.read", "obsidian.write"]),
  "POST /api/web/v1/vault": Object.freeze(["obsidian.read", "obsidian.write"]),
  "POST /api/web/v1/publish": Object.freeze(["obsidian.read", "obsidian.write"]),
  "PATCH /api/web/v1/base": Object.freeze(["obsidian.read", "obsidian.write"]),
});

/** Client-visible code for a write route that is missing from the table. */
export const WEB_WRITE_ROUTE_NOT_REGISTERED = "web_write_route_not_registered";

/** The route's registered needs, or `null` when the route is not registered. */
export function webWriteRouteNeeds(routeKey) {
  return typeof routeKey === "string" && Object.prototype.hasOwnProperty.call(WEB_WRITE_ROUTE_NEEDS, routeKey)
    ? WEB_WRITE_ROUTE_NEEDS[routeKey]
    : null;
}

/** Capabilities for a registered route; `null` (fail closed) for anything else. */
function webWriteRouteCapabilities(routeKey) {
  const needs = webWriteRouteNeeds(routeKey);
  return needs ? capabilitiesForWebRoute({ scopes: needs }) : null;
}

/**
 * Deny-by-default refusal for a Web write route that is not in the table. It is
 * stateless on purpose: the wiring defect is independent of the temporal plane,
 * so it must also fire when no policy runtime is injected.
 */
export function denyUnregisteredWriteRoute(_req, res) {
  res.status(403).json({ error: WEB_WRITE_ROUTE_NOT_REGISTERED });
}

const passThrough = (_req, _res, next) => next();

/**
 * The catalog key a Web gate decides for. A structural test reads it from the mounted
 * router's handler chain, so one gated route can never mask an ungated sibling.
 */
export const WEB_ROUTE_GATE = Symbol("authorization.web-route-gate");

function markedGate(gate, routeKey) {
  if (routeKey !== null) gate[WEB_ROUTE_GATE] = routeKey;
  return gate;
}

/**
 * Append one gate to the chain a registration received. The composition root passes
 * the plain `requireApi`/`requirePage` chain; a direct caller may pass an array, and
 * the gate is always appended last, so its position in the pipeline is unchanged.
 */
export function chainWith(requireFn, gate) {
  return [...(Array.isArray(requireFn) ? requireFn : [requireFn]), gate];
}

/**
 * Resolve the middleware for one Web write route (`<METHOD> <path>`):
 *   - not registered  ⇒ deny-by-default, runtime or not;
 *   - registered + injected policy ⇒ that route's needs, evaluated by the policy
 *     plane (the same capabilities `requireWebWrite` carries for every entry);
 *   - registered, no policy (Stage 0) ⇒ passThrough, the unchanged legacy chain.
 */
export function webWriteRouteGate(policy, routeKey, { shadow = null } = {}) {
  if (policy) return policy.requireWebWriteRoute(routeKey, { shadow });
  if (!webWriteRouteNeeds(routeKey)) return denyUnregisteredWriteRoute;
  // Stage 0 has no temporal gate, so the old answer is an allow. It is still recorded
  // beside the new model, which is the whole point of the shadow.
  return observationOnly(shadow, routeKey);
}

/**
 * The P2 observation of a route that has no temporal gate at all (Stage 0): the old
 * answer is an allow, and the middleware chain is otherwise unchanged.
 */
function observationOnly(shadow, routeKey, vaultIdOf = null) {
  if (shadow === null || shadow === undefined || typeof shadow.compare !== "function") return passThrough;
  return markedGate(function observeWebRoute(req, _res, next) {
    observeWebAuthorization({
      shadow,
      session: sessionOf(req),
      routeKey,
      vaultId: vaultIdOf === null ? null : vaultIdOf(req),
      legacyDecision: WEB_LEGACY_VERDICTS.allowed,
    });
    next();
  }, routeKey);
}

/** A read route with its catalog boundary key; observation only in P2. */
export function webReadRouteGate(policy, routeKey, { shadow = null, vaultIdOf = null } = {}) {
  if (policy) return policy.requireWebReadFor(routeKey, { vaultIdOf, shadow });
  return observationOnly(shadow, routeKey, vaultIdOf);
}

/** The Vault file read (`GET /api/web/v1/asset`) with its catalog boundary key. */
export function webFilesRouteGate(policy, routeKey, { shadow = null, vaultIdOf = null } = {}) {
  if (policy) return policy.requireWebFilesFor(routeKey, { vaultIdOf, shadow });
  return observationOnly(shadow, routeKey, vaultIdOf);
}

function sessionOf(req) {
  return req && typeof req === "object" && req.webSession ? req.webSession : null;
}

// One audit per denial (A-10). The runtime stamps `time` from its injected clock
// and truncates to the 15-field whitelist; this adapter only supplies decision
// facts. No Vault field, no token/secret, no raw subject id. An audit failure
// must never flip the decision back to allow.
function emitDenyAudit(runtime, event) {
  try {
    if (typeof runtime.audit === "function") runtime.audit(event);
  } catch {
    /* audit is best-effort; the deny stands */
  }
}

function brokenResult(capabilities) {
  return {
    status: 503,
    body: { error: POLICY_UNAVAILABLE },
    audit: { action: "authz.deny", outcome: "failure", surface: "web", mode: null, policyId: null, capabilities },
  };
}

function denyResult(capabilities, decision, explain) {
  return {
    status: 403,
    body: {
      error: OUTSIDE_WINDOW,
      mode: decision.mode,
      policyId: decision.denyPolicyId ?? null,
      nextAllowedAt: explain?.nextAllowedAt ?? null,
    },
    audit: {
      action: "authz.deny",
      outcome: "failure",
      surface: "web",
      mode: decision.mode,
      policyId: decision.denyPolicyId ?? null,
      capabilities,
      nextAllowedAt: explain?.nextAllowedAt ?? null,
    },
  };
}

/**
 * P3: one decision per Web boundary, taken by the authorization runtime. `capabilities` is
 * the old capability class of the route and travels with the request as frozen legacy data;
 * nothing here reads a Scope or a Vault list to decide.
 */
function decideRoute({ decide, session, routeKey, capabilities, vaultId }) {
  const request = routeKey === null
    // A keyless class gate guards the content of the session's own Vault; the canonical
    // Vault read is what that class protected.
    ? classRequest({ session, capabilities, vaultId })
    : webAuthorizationRequest({ session, routeKey, vaultId, legacy: { phase: "web", capabilities } });
  // An unbuildable request — no verified session identity, or a route the catalog does not
  // map — is the old unusable-subject refusal: fail closed, never an allow.
  if (request === null) return { request: null, decision: null };
  return { request, decision: withWebSessionIdentity(session, () => decide.authorize(request)) };
}

function classRequest({ session, capabilities, vaultId = null }) {
  const actor = webVerifiedActor({ session });
  const vault = typeof vaultId === "string" && vaultId.length > 0 ? vaultId : session?.vaultId;
  if (actor === null || typeof vault !== "string" || vault.length === 0) return null;
  return { actor, capability: "get_note", target: { kind: "vault", vaultId: vault }, surface: "web", legacy: { phase: "web", capabilities } };
}

/** The old gate's answer as a response, or `null` for an allow. */
function refusalOf(decision, capabilities) {
  if (decision === null || decision.allowed === true) return null;
  const mapped = mapWebAuthorizationDenial(decision, { page: false });
  return {
    status: mapped.status,
    body: mapped.body,
    audit: {
      action: "authz.deny",
      outcome: "failure",
      surface: "web",
      mode: decision.mode ?? null,
      policyId: decision.denyConstraintId ?? null,
      capabilities,
      // The broken plane carries no next window (A-11): the field stays absent, as before.
      ...(decision.code === ACCESS_DENY_CODES.POLICY_UNAVAILABLE ? {} : { nextAllowedAt: decision.nextAllowedAt ?? null }),
    },
  };
}

function makeGate(decide, capabilities, { shadow = null, routeKey = null, vaultIdOf = null, auditRuntime = null, inert = null } = {}) {
  return markedGate(function requireWeb(req, res, next) {
    const session = sessionOf(req);
    const vaultId = vaultIdOf === null ? null : vaultIdOf(req);
    // Stage 0 (`AUTHZ_ENABLED=false`, no authorization runtime injected): the temporal plane
    // is off and performs no check at all — the frozen zero-difference behaviour. The flag is
    // read per request, so a runtime that settles later is picked up without a rebind.
    const off = typeof inert === "function" ? inert() === true : inert === true;
    const { request, decision } = off
      ? { request: null, decision: null }
      : decideRoute({ decide, session, routeKey, capabilities, vaultId });
    // One row per request, recorded after the decision and before any answer or handler.
    // Observation only: the decision alone answers below.
    if (routeKey !== null) {
      observeWebAuthorization({
        shadow,
        session,
        routeKey,
        vaultId,
        legacyDecision: decision === null || decision.allowed === true ? WEB_LEGACY_VERDICTS.allowed : decision,
      });
    }
    const result = off ? null : (request === null ? brokenResult(capabilities) : refusalOf(decision, capabilities));
    if (!result) return next();
    emitDenyAudit(auditRuntime, result.audit);
    return res.status(result.status).json(result.body);
  }, routeKey);
}

/**
 * The Web projection asks (design §6.1.4): the questions the router needs BESIDES the route
 * gate — "may this session use this Vault at all?" and "may it call this route?", which a
 * display flag needs. Both are decisions, so the runtime takes them; in `legacy` mode the
 * extracted backend answers with the credential's Vault allowlist and the old Scope class.
 */
export function createWebAuthorizationAsks({ authorization = null, accessRuntime = null } = {}) {
  const decide = createAuthorizationSeam({ authorization, accessRuntime });

  function vault(session, vaultId) {
    const actor = webVerifiedActor({ session });
    if (actor === null || typeof vaultId !== "string" || vaultId.length === 0) return false;
    const request = {
      actor,
      // The containment question is the canonical Vault read: any content route of this
      // Vault is reached only through this answer.
      capability: "get_note",
      target: { kind: "vault", vaultId },
      surface: "web",
      legacy: { phase: "web-vault", allowedVaults: [...(session?.allowedVaults ?? [])] },
    };
    return withWebSessionIdentity(session, () => decide.authorize(request)).allowed === true;
  }

  function route(session, routeKey, capabilities) {
    // The route's own Scope class, as the old handler re-checked it before touching content.
    const request = webAuthorizationRequest({ session, routeKey, vaultId: null, legacy: { phase: "web-scope", scopes: [...(session?.allowedScopes ?? [])], capabilities } });
    if (request === null) return false;
    return withWebSessionIdentity(session, () => decide.authorize(request)).allowed === true;
  }

  return { vault, route };
}

/** The Web target containment decision alone (one question, one authority). */
export function createWebVaultContainment(options = {}) {
  return createWebAuthorizationAsks(options).vault;
}

/**
 * Web content-plane AuthZ adapter (INTERFACE §10.3).
 *
 * @param {{ runtime: object, authorization?: object|null, authorizationShadow?: object|null }} options
 */
export function createWebAccessPolicy({ runtime, authorization = null, authorizationShadow = null } = {}) {
  if (!runtime && !authorization) throw new TypeError("createWebAccessPolicy requires an access-policy runtime");
  const shadow = authorizationShadow;
  // A disabled legacy plane stays inert, but only while it is the one authority: with the
  // authorization runtime injected, that runtime decides.
  const stage0 = () => authorization === null && runtime?.status === "disabled";
  // P3: the runtime decides. `runtime` stays the audit sink and the old temporal plane the
  // extracted legacy backend reads; it answers nothing by itself.
  const decide = createAuthorizationSeam({ authorization, accessRuntime: runtime });
  const auditRuntime = runtime;

  /**
   * SSE heartbeat revalidation. Returns the live session to keep the stream
   * open, or `null` to close it. `null` covers: no session, an unbuildable request
   * (fail closed), a deny (suspend or revoke) and a broken/unavailable plane.
   */
  function revalidateWebRead(req, session = sessionOf(req)) {
    if (!session) return null;
    if (stage0()) return session;
    const { request, decision } = decideRoute({
      decide,
      session,
      routeKey: "GET /api/web/v1/events",
      capabilities: WEB_CAPABILITIES.read,
      vaultId: null,
    });
    if (request === null) return null;
    if (decision.allowed === true) return session;
    emitDenyAudit(auditRuntime, refusalOf(decision, WEB_CAPABILITIES.read)?.audit ?? brokenResult(WEB_CAPABILITIES.read).audit);
    return null;
  }

  return {
    requireWebMetadata(_req, _res, next) {
      return next(); // metadata / repair plane is never evaluated (A-07).
    },
    requireWebRead: makeGate(decide, WEB_CAPABILITIES.read, { auditRuntime, inert: stage0 }),
    requireWebWrite: makeGate(decide, WEB_CAPABILITIES.write, { auditRuntime, inert: stage0 }),
    requireWebFiles: makeGate(decide, WEB_CAPABILITIES.files, { auditRuntime, inert: stage0 }),
    /** A read route that states its catalog boundary key, so the decision has one unit. */
    requireWebReadFor(routeKey, { vaultIdOf = null, shadow: override } = {}) {
      return makeGate(decide, WEB_CAPABILITIES.read, { shadow: override === undefined ? shadow : override, routeKey, vaultIdOf, auditRuntime });
    },
    /** The Vault file read, with its own boundary key. */
    requireWebFilesFor(routeKey, { vaultIdOf = null, shadow: override } = {}) {
      return makeGate(decide, WEB_CAPABILITIES.files, { shadow: override === undefined ? shadow : override, routeKey, vaultIdOf, auditRuntime });
    },
    /** #625: the per-route gate — registered routes get their recorded needs,
     *  everything else is refused before the handler runs. */
    requireWebWriteRoute(routeKey, { shadow: override } = {}) {
      const capabilities = webWriteRouteCapabilities(routeKey);
      return capabilities ? makeGate(decide, capabilities, { shadow: override === undefined ? shadow : override, routeKey, auditRuntime }) : denyUnregisteredWriteRoute;
    },
    revalidateWebRead,
    webCapabilities: WEB_CAPABILITIES,
  };
}
