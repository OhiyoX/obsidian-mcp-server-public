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
import { subjectsFromWebSession } from "../access-policy/subjects.js";

const { OUTSIDE_WINDOW, POLICY_UNAVAILABLE } = ACCESS_DENY_CODES;

/**
 * Frozen per-route capability instances (INTERFACE §10.3):
 *   read     = obsidian.read
 *   write    = obsidian.read + obsidian.write
 *   files    = obsidian.read + obsidian.files
 *   metadata = never evaluated (A-07); an empty requirement set cannot deny
 *              even if a future caller evaluated it by mistake.
 */
const WEB_CAPABILITIES = Object.freeze({
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
 * Resolve the middleware for one Web write route (`<METHOD> <path>`):
 *   - not registered  ⇒ deny-by-default, runtime or not;
 *   - registered + injected policy ⇒ that route's needs, evaluated by the policy
 *     plane (the same capabilities `requireWebWrite` carries for every entry);
 *   - registered, no policy (Stage 0) ⇒ passThrough, the unchanged legacy chain.
 */
export function webWriteRouteGate(policy, routeKey) {
  if (policy) return policy.requireWebWriteRoute(routeKey);
  return webWriteRouteNeeds(routeKey) ? passThrough : denyUnregisteredWriteRoute;
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
 * Evaluate one Web route class. Returns `null` when the request may proceed,
 * otherwise `{ status, body, audit }`. Reads `runtime.status` at call time so a
 * runtime that settles from `broken` to `ready` is picked up without rebinding.
 */
function evaluateGate(runtime, session, capabilities) {
  if (runtime.status === "disabled") return null; // Stage 0: zero behaviour change.
  const subjects = subjectsFromWebSession(session);
  if (subjects.length === 0) return brokenResult(capabilities); // fail closed on an unusable subject
  let decision;
  try {
    decision = runtime.evaluate({ subjects, capabilities });
  } catch {
    return brokenResult(capabilities);
  }
  if (decision?.allowed === true) return null;
  // Only a real temporal deny (outside_window + a concrete mode) is a 403.
  // Anything else — including `policy_unavailable` — fails closed as 503.
  if (decision?.reason !== "outside_window" || !decision.mode) return brokenResult(capabilities);
  let explain = null;
  try {
    explain = runtime.explain({ subjects, capabilities });
  } catch {
    explain = null; // nextAllowedAt degrades to null; the deny still stands
  }
  return denyResult(capabilities, decision, explain);
}

function makeGate(runtime, capabilities) {
  return function requireWeb(req, res, next) {
    const result = evaluateGate(runtime, sessionOf(req), capabilities);
    if (!result) return next();
    emitDenyAudit(runtime, result.audit);
    return res.status(result.status).json(result.body);
  };
}

/**
 * Web content-plane AuthZ adapter (INTERFACE §10.3).
 *
 * @param {{ runtime: { status: string, evaluate: Function, explain: Function, audit?: Function } }} options
 */
export function createWebAccessPolicy({ runtime } = {}) {
  if (!runtime || typeof runtime.evaluate !== "function") {
    throw new TypeError("createWebAccessPolicy requires an access-policy runtime");
  }

  /**
   * SSE heartbeat revalidation. Returns the live session to keep the stream
   * open, or `null` to close it. `null` covers: no session, an unusable subject,
   * a temporal deny (suspend or revoke) and a broken/unavailable policy plane
   * (fail closed). The second argument lets a caller pass a freshly re-resolved
   * session; it defaults to `req.webSession`.
   */
  function revalidateWebRead(req, session = sessionOf(req)) {
    if (!session) return null;
    if (runtime.status === "disabled") return session;
    const capabilities = WEB_CAPABILITIES.read;
    const subjects = subjectsFromWebSession(session);
    if (subjects.length === 0) return null;
    let decision;
    try {
      decision = runtime.evaluate({ subjects, capabilities });
    } catch {
      return null;
    }
    if (decision?.allowed === true) return session;
    if (decision?.reason === "outside_window" && decision.mode) {
      let explain = null;
      try {
        explain = runtime.explain({ subjects, capabilities });
      } catch {
        explain = null;
      }
      emitDenyAudit(runtime, denyResult(capabilities, decision, explain).audit);
    } else {
      emitDenyAudit(runtime, brokenResult(capabilities).audit);
    }
    return null;
  }

  return {
    requireWebMetadata(_req, _res, next) {
      return next(); // metadata / repair plane is never evaluated (A-07).
    },
    requireWebRead: makeGate(runtime, WEB_CAPABILITIES.read),
    requireWebWrite: makeGate(runtime, WEB_CAPABILITIES.write),
    requireWebFiles: makeGate(runtime, WEB_CAPABILITIES.files),
    /** #625: the per-route gate — registered routes get their recorded needs,
     *  everything else is refused before the handler runs. */
    requireWebWriteRoute(routeKey) {
      const capabilities = webWriteRouteCapabilities(routeKey);
      return capabilities ? makeGate(runtime, capabilities) : denyUnregisteredWriteRoute;
    },
    revalidateWebRead,
    webCapabilities: WEB_CAPABILITIES,
  };
}
