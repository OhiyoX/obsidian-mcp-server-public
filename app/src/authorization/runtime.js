// P1 / Task 8 — the request-level committed snapshot and the runtime shell.
//
// Contract: design §6 ("生产注入的 authorization.authorize(request) 只是同步捕获
// 本进程 committed snapshot、注入时钟并调用上述纯函数的薄壳") and §7 (read the
// live facts on every call, cache only immutable data, never cache an allow).
//
// `authorize()` accepts exactly `{actor, capability, target, surface}`. A caller's
// `nowMs`, `snapshot`, body, `_meta` or header never reaches the pure function: the
// clock is injected here, the projection is captured here, and the actor must be a
// branded `verifiedActor()`. One call = one capture = one `evaluate.authorize()`
// call; nothing about the previous answer is reused.
//
// `mode` is `legacy | shadow | enforce`. `enforce` is the only mode whose response
// comes from the new model; `legacy` and `shadow` answer from the legacy backend, and
// `shadow` records the new verdict beside that answer (design §10 P2).
//
// P2 / Task 9 adds `shadow.compare({request, legacyDecision, boundaryKey})`. It
// answers nothing: it records one bounded row for the new model's verdict beside
// the old gate's verdict, and it runs in `legacy` and `shadow` mode (P3 made
// `legacy` the deployed mode before the switch). The old verdict stays the
// execution authority because compare() has no return value to execute.

import { isVerifiedActor } from "./actors.js";
import { AUTHORIZATION_DECISION_CODES, authorize as authorizePure } from "./evaluate.js";
import { currentShadowRequestId } from "./shadow.js";
import { authorizeLegacy, createLegacyDecisionBackend } from "./legacy-evaluate.js";

// The extracted legacy backend, exported through the runtime so it keeps exactly one
// importer (the P2 guard) while a composition root can inject it.
export { createLegacyDecisionBackend };

export const AUTHORIZATION_MODES = Object.freeze(["legacy", "shadow", "enforce"]);

const C = AUTHORIZATION_DECISION_CODES;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

function readerOf(source, label, { optional = false } = {}) {
  if (typeof source === "function") return source;
  if (source !== undefined && source !== null) return () => source;
  if (optional) return () => null;
  throw new TypeError(`authorization runtime needs a ${label} source`);
}

function requireStore(store) {
  if (!isRecord(store)) throw new TypeError("authorization runtime needs a store");
  for (const method of ["snapshot", "replace", "repair", "drain"]) {
    if (typeof store[method] !== "function") throw new TypeError(`authorization runtime store is missing ${method}`);
  }
  if (typeof store.ready?.then !== "function") throw new TypeError("authorization runtime store is missing ready");
  return store;
}

/**
 * `createAuthorizationRuntime({store, identitySnapshot, vaultSnapshot, publicationSnapshot, deployment, now, mode, legacy, audit})`
 * -> `{ready, authorize(request), snapshot(), summary(), drain()}`.
 *
 * Each source may be a value or a synchronous function; a function is called on
 * every decision, so a change in the identity store, the Vault registry or the
 * deployment facts applies to the next request without a restart or a logout.
 */
export function createAuthorizationRuntime({
  store,
  identitySnapshot,
  vaultSnapshot,
  publicationSnapshot = null,
  deployment,
  now,
  mode = "legacy",
  legacy = null,
  audit = null,
  shadow = null,
} = {}) {
  requireStore(store);
  if (typeof now !== "function") throw new TypeError("authorization runtime needs an injected clock");
  if (!AUTHORIZATION_MODES.includes(mode)) throw new TypeError(`unknown authorization mode ${String(mode)}`);
  if (legacy !== null && typeof legacy !== "object") throw new TypeError("the legacy backend must be an object or null");
  if (audit !== null && typeof audit !== "function") throw new TypeError("the audit sink must be a function or null");
  if (shadow !== null && (typeof shadow !== "object" || typeof shadow.record !== "function")) {
    throw new TypeError("the shadow record must be an observer or null");
  }

  const readIdentity = readerOf(identitySnapshot, "identity snapshot");
  const readVaults = readerOf(vaultSnapshot, "Vault snapshot");
  const readPublication = readerOf(publicationSnapshot, "publication snapshot", { optional: true });
  const readDeployment = readerOf(deployment, "deployment facts");

  let isReady = false;
  const counters = { decisions: 0, allowed: 0, denied: 0, auditFailures: 0, byCode: Object.create(null), captured: null };
  // The first capture of one shadow request is the one that counts; a second layer of
  // the same request must not overwrite it with a later instant (§10 step 5).
  let capturedScope = null;

  const ready = Promise.resolve(store.ready).then(() => { isReady = true; }, () => { isReady = false; });

  function capturedClock() {
    try {
      const value = now();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  // Live session membership and expiry (§6): a logout or an expiry applies to the
  // next request, even while an event stream is still open.
  function sessionRefusal(actor, identity, nowMs) {
    const sessions = identity?.sessions;
    if (sessions === undefined) {
      return actor.kind === "web-session" ? deny(C.INVALID_CREDENTIAL, "transport") : null;
    }
    if (!isRecord(sessions)) return deny(C.STATE_UNAVAILABLE, "transport");
    const session = sessions[actor.credentialId];
    if (session === undefined) {
      return actor.kind === "web-session" ? deny(C.INVALID_CREDENTIAL, "transport") : null;
    }
    if (!isRecord(session)) return deny(C.STATE_UNAVAILABLE, "transport");
    if (session.active === false) return deny(C.INVALID_CREDENTIAL, "transport");
    if (Number.isFinite(session.expiresAt) && !(nowMs < session.expiresAt)) return deny(C.INVALID_CREDENTIAL, "transport");
    if (typeof session.subjectId === "string" && !actor.subjectIds.includes(session.subjectId)) return deny(C.INVALID_CREDENTIAL, "transport");
    return null;
  }

  function decide(request, nowMs) {
    // `comparable` states whether this answer is a policy answer at all: a runtime
    // that is not ready, or a clock that cannot be read, is not a comparison input.
    if (!isReady) return { decision: deny(C.STATE_UNAVAILABLE, "transport"), comparable: false, reason: "runtime_not_ready" };
    const actor = isRecord(request) ? request.actor : null;
    if (!isVerifiedActor(actor)) return { decision: deny(C.INVALID_CREDENTIAL, "transport") };
    if (nowMs === null) return { decision: deny(C.POLICY_UNAVAILABLE, "operation"), comparable: false, reason: "clock_unreadable" };

    const stored = store.snapshot();
    const identity = readIdentity();
    const refusal = sessionRefusal(actor, identity, nowMs);
    if (refusal !== null) return { decision: refusal };

    const projection = {
      status: isRecord(stored) ? stored.status : "broken",
      document: isRecord(stored) ? stored.document ?? null : null,
      identities: isRecord(identity?.subjects) ? identity.subjects : {},
      vaultAdmissions: readVaults(),
      publication: readPublication(),
      deployment: readDeployment(),
    };
    const captured = { revision: isRecord(stored) && Number.isInteger(stored.revision) ? stored.revision : null, nowMs };

    return {
      decision: authorizePure({
        actor,
        capability: request.capability,
        target: request.target,
        surface: request.surface,
        nowMs,
      }, projection),
      captured,
    };
  }

  function count(decision) {
    counters.decisions += 1;
    if (decision.allowed) counters.allowed += 1;
    else counters.denied += 1;
    counters.byCode[decision.code] = (counters.byCode[decision.code] ?? 0) + 1;
  }

  function authorize(request) {
    // Only `enforce` answers from the new model. `legacy` and `shadow` answer from the
    // temporary legacy backend, and that is on purpose (design §10 P2): the new verdict
    // never changes a response. In `shadow` the same call is also the old side of the
    // comparison, so a shadow row compares the old algorithm with the new one instead of
    // the new model with itself. `compare()` is the only place that computes the new
    // verdict in this mode.
    if (mode !== "enforce") {
      const legacyDecision = authorizeLegacy(request, { legacy });
      count(legacyDecision);
      // The audit sink runs for this mode too: a legacy decision is a decision, and a
      // caller that injected a sink must see it (a throwing sink still changes nothing).
      if (audit !== null) {
        try {
          audit(legacyDecision);
        } catch {
          counters.auditFailures += 1;
        }
      }
      return legacyDecision;
    }
    let decision;
    try {
      const captured = decide(request, capturedClock());
      decision = captured.decision;
      if (captured.captured !== undefined) counters.captured = captured.captured;
    } catch {
      // A projection or a decision that cannot be read is a deny, never an allow.
      decision = deny(C.STATE_UNAVAILABLE, "transport");
    }
    count(decision);
    if (audit !== null) {
      try {
        audit(decision);
      } catch {
        // A non-fatal audit failure must not change the decision.
        counters.auditFailures += 1;
      }
    }
    return decision;
  }

  /**
   * `compare({request, legacyDecision, boundaryKey}) -> void`
   *
   * One capture, one instant, one target for both algorithms: the old verdict is
   * handed in by the caller that already computed it, the new verdict is computed
   * here from the same request, and only a whitelisted row is recorded. Nothing is
   * returned, so no adapter can execute a shadow verdict by mistake. Every failure
   * of the record (a throwing sink, a stale candidate, an unreadable projection)
   * leaves the old answer untouched.
   */
  function compare({ request, legacyDecision, boundaryKey, phase = null, comparable: stated = null, reason = null } = {}) {
    // P3: the boundaries execute this runtime's answer, so `legacy` mode is now the mode
    // that runs in production before the P4 switch — and it must keep recording. The
    // recorder still answers nothing, and `enforce` (where the new model decides) has
    // nothing left to compare.
    if (mode === "enforce" || shadow === null) return;
    try {
      const nowMs = capturedClock();
      const { decision, comparable, captured, reason: decideReason } = decide(request, nowMs);
      const scope = currentShadowRequestId();
      if (captured !== undefined && (scope === null || scope !== capturedScope)) {
        counters.captured = captured;
        capturedScope = scope;
      }
      // One layer verdict. The recorder folds the layers of one authorization unit
      // into one row and takes the effective old answer from the deciding layer.
      shadow.record({
        boundary: boundaryKey ?? null,
        phase,
        surface: isRecord(request) ? request.surface : null,
        capability: isRecord(request) ? request.capability : null,
        targetKind: isRecord(request?.target) ? request.target.kind : null,
        targetId: isRecord(request?.target) ? (request.target.vaultId ?? request.target.id ?? null) : null,
        legacyAllowed: isRecord(legacyDecision) && typeof legacyDecision.allowed === "boolean" ? legacyDecision.allowed : null,
        legacyCode: isRecord(legacyDecision) ? legacyDecision.code : null,
        newAllowed: decision.allowed,
        newCode: decision.code,
        sourceRevision: typeof store.sourceRevision === "function" ? store.sourceRevision() : null,
        newRevision: decision.revision,
        inconclusiveReason: comparable === false
          ? (decideReason ?? "unreadable_entry")
          : (stated === false ? (reason ?? "unreadable_entry") : null),
      });
    } catch {
      // The shadow never changes an answer.
    }
  }

  function snapshot() {
    const stored = store.snapshot();
    return Object.freeze({
      status: isRecord(stored) ? stored.status : "broken",
      revision: isRecord(stored) && Number.isInteger(stored.revision) ? stored.revision : null,
      mode,
      capturedAt: counters.captured === null ? null : counters.captured.nowMs,
    });
  }

  function summary() {
    return Object.freeze({
      mode,
      ready: isReady,
      legacy: legacy !== null,
      decisions: counters.decisions,
      allowed: counters.allowed,
      denied: counters.denied,
      byCode: Object.freeze({ ...counters.byCode }),
      auditFailures: counters.auditFailures,
      captured: counters.captured === null ? null : Object.freeze({ ...counters.captured }),
      shadow: shadow === null ? null : shadow.summary(),
    });
  }

  function drain() {
    return Promise.resolve(store.drain()).then(() => {});
  }

  // The injected shadow seam: `compare` adds one layer verdict, `begin` opens one
  // authorization-unit context (one row per request), `requestId` names the context in
  // flight. A transport uses these three; nothing here returns a verdict.
  const shadowSeam = Object.freeze({
    compare,
    begin: (options) => (typeof shadow?.begin === "function" ? shadow.begin(options) : null),
    requestId: () => (typeof shadow?.requestId === "function" ? shadow.requestId() : null),
  });

  return Object.freeze({ ready, authorize, shadow: shadowSeam, snapshot, summary, drain });
}

/**
 * `createAuthorizationSeam({authorization, accessRuntime}) -> {authorize(request)}`
 *
 * The one decision the boundaries call (P3). An injected runtime decides — and, in
 * `legacy` mode, delegates to the extracted backend. Without one (an in-process caller, a
 * unit test, a composition root that injects only the old plane) the same extracted
 * backend answers through the same mapper, so there is exactly one decision path and no
 * boundary keeps a local rule of its own. It lives here so the legacy backend keeps exactly
 * one importer (P2 guard).
 */
export function createAuthorizationSeam({ authorization = null, accessRuntime = null } = {}) {
  if (authorization !== null && typeof authorization.authorize === "function") return authorization;
  const legacy = createLegacyDecisionBackend({ accessRuntime });
  return Object.freeze({ authorize: (request) => authorizeLegacy(request, { legacy }) });
}
