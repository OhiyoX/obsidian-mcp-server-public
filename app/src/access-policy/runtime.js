// Access-policy runtime for AuthZ Wave A / A4.
//
// Contract: `scratch/authz/INTERFACE.md` §9. The runtime is a thin state machine
// and composition layer: it owns the enabled/ready/broken status, awaits the
// injected store's `ready`, and combines `store.snapshot()` with the pure
// decision core (`evaluateAccess` / `explainAccess`). It never re-implements
// schedule or matching logic and never reads the ambient clock — `now` is
// injected (default `Date.now`) and every emitted timestamp comes from it.
//
// Fail-closed rules:
//  - `enabled=false` is zero-touch: no store access, no I/O, allow-all decision
//    (Stage 0 semantics: the feature is inert);
//  - `enabled=true` starts `broken` and only becomes `ready` once the store
//    reports a successful load, so a not-yet-loaded or failed store can never be
//    mistaken for an empty policy set.

import { evaluateAccess, explainAccess } from "./evaluate.js";

// Frozen audit whitelist (INTERFACE §9.4). Anything else — Vault paths, note
// titles, revisions, content, tokens/secrets, full policy objects — is stripped.
const AUDIT_FIELDS = Object.freeze([
  "action", "outcome", "surface", "mode", "policyId",
  "credentialType", "credentialId", "clientId", "userId",
  "capabilities", "time", "nextAllowedAt", "source", "userAgent", "agent",
]);

const DISABLED_SNAPSHOT = Object.freeze({
  status: "disabled",
  revision: null,
  policies: Object.freeze([]),
});

function allowedDecision() {
  return {
    allowed: true,
    mode: null,
    reason: "no_matching_policy",
    denyPolicyId: null,
    matchedPolicyIds: [],
  };
}

// Field truncation only. `time` is always stamped from the injected clock and
// overrides any caller value; absent whitelist fields are omitted rather than
// filled with `undefined`.
function truncateAudit(event, time) {
  const source = event && typeof event === "object" && !Array.isArray(event) ? event : {};
  const entry = {};
  for (const field of AUDIT_FIELDS) {
    if (field === "time") {
      entry.time = time;
      continue;
    }
    if (source[field] !== undefined) entry[field] = source[field];
  }
  return entry;
}

class AccessPolicyRuntime {
  constructor({ enabled, store, now = Date.now, audit = () => {} } = {}) {
    this.enabled = enabled === true;
    // `store` is dropped while disabled so a disabled runtime cannot reach it
    // even accidentally (the caller may pass null, or anything at all).
    this.store = this.enabled ? store : null;
    this.clock = now;
    this.auditAdapter = audit;
    this.status = "disabled";
    this.ready = Promise.resolve();
    if (this.enabled) {
      this.status = "broken"; // fail closed until the store load settles
      this.ready = this.#initialize();
    }
  }

  async #initialize() {
    const store = this.store;
    if (!store || typeof store.ready?.then !== "function") return; // stays broken
    let result;
    try {
      result = await store.ready;
    } catch {
      this.status = "broken";
      return;
    }
    this.status = result?.status === "ready" ? "ready" : "broken";
  }

  summary() {
    if (!this.enabled) return { enabled: false, status: "disabled", policyCount: 0 };
    const snapshot = this.store?.snapshot?.();
    return {
      enabled: true,
      status: this.status,
      policyCount: Array.isArray(snapshot?.policies) ? snapshot.policies.length : 0,
    };
  }

  snapshot() {
    if (!this.enabled) return DISABLED_SNAPSHOT;
    return this.store.snapshot();
  }

  evaluate({ subjects, capabilities } = {}) {
    if (!this.enabled) return allowedDecision();
    return evaluateAccess({
      snapshot: this.store.snapshot(),
      subjects,
      capabilities,
      nowMs: this.clock(),
    });
  }

  explain({ subjects, capabilities } = {}) {
    const nowMs = this.clock();
    if (!this.enabled) {
      return {
        ...allowedDecision(),
        now: new Date(nowMs).toISOString(),
        timezone: null,
        nextChangeAt: null,
        nextAllowedAt: null,
      };
    }
    return explainAccess({ snapshot: this.store.snapshot(), subjects, capabilities, nowMs });
  }

  audit(event) {
    this.auditAdapter(truncateAudit(event, new Date(this.clock()).toISOString()));
  }

  drain() {
    if (!this.enabled) return Promise.resolve();
    return this.store.drain();
  }
}

export function createAccessPolicyRuntime(options = {}) {
  return new AccessPolicyRuntime(options);
}
