// W2 fix (#437 RETURN) — the process's persistent Vault SERVING gate.
//
// Authority: contract §2.1 / §4 / §10 plus the response-seat RETURN (2026-10-09, items 1/3/5):
//   "primary 不能绕过准入 … 可以保留结构性描述，不能保留可服务权限", "serving 判定须有明确允许集合，
//    未知/删除/未准备完成的 ID 默认拒绝", "publish 不能把拒绝门清空成放行",
//   "持久化已提交后发布失败必须如实报已提交降级并保持拒绝"
//   with the frozen degrade contract:
//     * admission not initialized            ⇒ structured 503 (never auto-approve, not even primary)
//     * initialized but not approved         ⇒ structured 403
//     * identity unconfirmable / dir gone    ⇒ structured 503
//     * never fall back to the primary
//
// WHITELIST, NOT BLACKLIST (the seat's independent new finding): `publish()` takes the explicit
// allow-set of the SAME committed snapshot the registry and the runtime map just swapped. An id that
// is unknown, deleted, revoked, identity-changed or whose runtime was not prepared is simply not in
// the set, so it is refused by default — clearing the previous decisions can never open it again.
//
// The gate is deliberately dumb: it stores the allow-set, the committed refusals and the pre-commit
// *sticky* refusals, and answers `isServable`/`refusalFor`. Policy (which decision maps to 503 vs
// 403) is the frozen table below. It performs no I/O.

import { publishComposedRecord, refuseComposed } from "./composed-commit.js";

export const VAULT_SERVING_REFUSED = "VAULT_SERVING_REFUSED";

/** reason ⇒ stable code + HTTP status (the seat's frozen degrade contract). */
export const SERVING_REFUSAL_RULES = Object.freeze({
  "admissions-not-initialized": { code: "VAULT_ADMISSION_NOT_INITIALIZED", httpStatus: 503 },
  "reconciliation-not-installed": { code: "VAULT_RECONCILIATION_NOT_INSTALLED", httpStatus: 503 },
  "awaiting-approval": { code: "VAULT_ADMISSION_NOT_APPROVED", httpStatus: 403 },
  "not-admitted": { code: "VAULT_ADMISSION_NOT_APPROVED", httpStatus: 403 },
  "identity-unresolved": { code: "VAULT_IDENTITY_UNRESOLVED", httpStatus: 503 },
  "identity-changed": { code: "VAULT_ADMISSION_IDENTITY_CONFLICT", httpStatus: 503 },
  "directory-missing": { code: "VAULT_DIRECTORY_UNAVAILABLE", httpStatus: 503 },
  "activation-failed": { code: "VAULT_ACTIVATION_FAILED", httpStatus: 503 },
  "runtime-prepare-failed": { code: "VAULT_RUNTIME_UNAVAILABLE", httpStatus: 503 },
  "runtime-not-prepared": { code: "VAULT_RUNTIME_UNAVAILABLE", httpStatus: 503 },
  "discovery-not-published": { code: "VAULT_DISCOVERY_NOT_PUBLISHED", httpStatus: 503 },
});

const NOT_PUBLISHED = Object.freeze({
  code: "VAULT_DISCOVERY_NOT_PUBLISHED",
  httpStatus: 503,
  admission: null,
  status: "unavailable",
  reason: "discovery-not-published",
  message: "Vault discovery has not published a serviceable inventory yet",
});

/** The default answer for any id that is not in the committed allow-set (item 3). */
const NOT_SERVABLE = Object.freeze({
  code: VAULT_SERVING_REFUSED,
  httpStatus: 503,
  admission: null,
  status: "unavailable",
  reason: "not-servable",
  message: "Vault is not in the committed servable set",
});

/**
 * Map one admission decision (the shape the registry's gate returns) to a frozen structured
 * refusal, or `null` when the decision admits the Vault. The `code` a decision already carries
 * wins over the reason table so an explicit conflict code is never rewritten.
 */
export function toServingRefusal(decision) {
  if (decision !== null && typeof decision === "object" && decision.admitted === true) return null;
  const reason = decision?.reason ?? null;
  const rule = reason !== null && Object.hasOwn(SERVING_REFUSAL_RULES, reason) ? SERVING_REFUSAL_RULES[reason] : null;
  const code = decision?.code ?? rule?.code ?? VAULT_SERVING_REFUSED;
  return Object.freeze({
    code,
    httpStatus: rule?.httpStatus ?? 503,
    admission: decision?.admission ?? null,
    status: decision?.status ?? "unavailable",
    reason,
    message: `Vault is not serving (${reason ?? code})`,
  });
}

/**
 * The explicit allow-set + refusal map of a committed registry snapshot's admission projection.
 * This is the ONE derivation used by `registry.commit`; the reconciliation service overrides it
 * with the same computation intersected with the committed runtime map (item 3).
 */
export function admissionServingSets(admissions = {}) {
  const allowed = [];
  const refusals = new Map();
  for (const [id, decision] of Object.entries(admissions ?? {})) {
    if (decision?.admitted === true) allowed.push(id);
    else refusals.set(id, toServingRefusal({ admitted: false, admission: decision?.admission ?? null, status: decision?.status ?? "unavailable", reason: decision?.reason ?? "not-admitted", code: decision?.code ?? null }));
  }
  return { allowed, refusals };
}

/** A structured refusal error a resolver can throw without leaking inventory facts (§15 S03). */
export function servingRefusalError(vaultId, refusal) {
  const error = new Error(refusal?.message ?? "Vault is not available");
  error.name = "VaultServingRefused";
  error.code = refusal?.code ?? VAULT_SERVING_REFUSED;
  error.status = refusal?.httpStatus ?? 503;
  error.httpStatus = refusal?.httpStatus ?? 503;
  error.reason = refusal?.reason ?? null;
  error.vaultId = vaultId;
  return error;
}

function normalizeRefusal(value) {
  if (value === null || value === undefined) return null;
  return value.httpStatus === undefined ? toServingRefusal({ admitted: false, ...value }) : Object.freeze({ ...value });
}

/**
 * `createVaultServingGate()` — armed/disarmed, an explicit committed allow-set, sticky pre-commit
 * refusals, one re-baseline per successful compose publish.
 *
 *   arm()                          — enforcement on; until `publish()` nothing is servable (fail closed)
 *   disarm()                       — back to the pre-W2 pass-through (no admission management)
 *   refuse(id, refusal)            — tighten NOW (step ①/②); survives a later persist failure
 *   publish(allowedIds, refusals)  — re-baseline from the committed snapshot (§4 step ④)
 *   isServable(id)                 — the one question every resolver asks (allow-set + sticky)
 *   refusalFor(id)                 — the structured refusal, or null when servable
 */
export function createVaultServingGate() {
  let armed = false;
  let committed = false;
  let allowed = new Set();
  let refused = new Map();
  const sticky = new Map();
  // W2FIX5 (#437 W2FIX4 item A / R1): when the ONE composed commit is attached, the committed
  // allow-set/refusals live in that record and this gate is a pure reader. The sticky refusals are
  // cleared in `adopt(record)`, which every writer of the record calls in the SAME synchronous step it
  // publishes, so a tightening can still happen early (it survives a fault) but a re-baseline is never
  // observable apart from the two other faces.
  let composed = null;
  let adoptedRevision = -1;

  function recordServing() {
    return composed?.current()?.serving ?? null;
  }

  // The record is authoritative ONLY once one exists. Before the first composed publish (a registry-only
  // or gate-only process, and every pre-W2 fixture) this gate still owns its committed allow-set; reading
  // a `null` record instead would fail every legacy consumer closed.
  function usingRecord() {
    return composed !== null && composed.current() !== null;
  }

  return Object.freeze({
    attachComposed(source) {
      composed = source;
      return true;
    },
    /**
     * W2FIX5: the switch hook. Every writer of the composed record (the registry's standalone publish,
     * the runtime map's `commit`, this gate's own `publish`) calls it in the same synchronous step, so
     * the sticky refusals are re-baselined exactly at the switch — never earlier (a tightening must
     * survive a later fault) and never lazily (a sticky refusal set after the switch must not be lost).
     */
    adopt(record) {
      if (record !== composed?.current() || record.revision <= adoptedRevision) return false;
      adoptedRevision = record.revision;
      sticky.clear();
      return true;
    },
    arm() {
      armed = true;
    },
    disarm() {
      armed = false;
      committed = false;
      sticky.clear();
      allowed = new Set();
      refused = new Map();
    },
    refuse(id, refusal) {
      const normalized = normalizeRefusal(refusal);
      if (typeof id === "string" && normalized !== null) sticky.set(id, normalized);
    },
    /**
     * Re-baseline from the ONE committed snapshot: `allowedIds` is the explicit allow-set (an id not
     * listed is refused by default) and `refusals` the committed per-id explanations. Sticky refusals
     * are cleared here because the committed snapshot already reflects them.
     */
    publish(allowedIds = [], refusals = null) {
      if (usingRecord()) {
        // Re-baseline the SERVING face by publishing a complete record: the registry snapshot and the
        // runtime map are carried over untouched, so clearing the refusal can never open a Vault whose
        // runtime is not committed (the allow-set is still the caller's explicit one).
        const record = composed.current();
        const requested = [...allowedIds];
        if (requested.some(id => !record.serving.allowedSet.has(id))) refuseComposed("serving-only publication cannot expand the committed allow-set");
        // A serving owner can tighten a complete current record, but cannot reopen an id or clear
        // a sticky refusal. Only a new validated reconciliation revision can grant again.
        if (requested.length !== record.serving.allowed.length) publishComposedRecord(composed, {
          serving: { allowed: requested, refusals },
        });
        return;
      }
      committed = true;
      sticky.clear();
      allowed = new Set(allowedIds);
      refused = new Map();
      const entries = refusals instanceof Map ? refusals.entries() : Object.entries(refusals ?? {});
      for (const [id, value] of entries) {
        const normalized = normalizeRefusal(value);
        if (normalized !== null) refused.set(id, normalized);
      }
    },
    isServable(id) {
      if (!armed) return true;
      if (usingRecord()) {
        const serving = recordServing();
        return serving !== null && typeof id === "string" && serving.allowedSet.has(id) && !sticky.has(id);
      }
      return committed && typeof id === "string" && allowed.has(id) && !sticky.has(id);
    },
    refusalFor(id) {
      if (!armed) return null;
      if (usingRecord()) {
        const serving = recordServing();
        const stickyRefusal = sticky.get(id);
        if (stickyRefusal !== undefined) return stickyRefusal;
        if (serving === null) return NOT_PUBLISHED;
        if (typeof id === "string" && serving.allowedSet.has(id)) return null;
        return serving.refusals.get(id) ?? NOT_SERVABLE;
      }
      const stickyRefusal = sticky.get(id);
      if (stickyRefusal !== undefined) return stickyRefusal;
      if (!committed) return NOT_PUBLISHED;
      if (typeof id === "string" && allowed.has(id)) return null;
      return refused.get(id) ?? NOT_SERVABLE;
    },
    armed: () => armed,
    published: () => (usingRecord() ? recordServing() !== null : committed),
    allowed: () => (usingRecord() ? Object.freeze([...(recordServing()?.allowed ?? [])]) : Object.freeze([...allowed])),
    composedRecord: () => (composed === null ? null : composed.current()),
    refusals: () => Object.freeze(Object.fromEntries(sticky)),
  });
}
