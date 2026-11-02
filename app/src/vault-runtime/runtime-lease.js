// W2 fix (#437 RETURN item 4) — the per-Vault runtime LEASE.
//
// Authority: contract §4 step ⑤ + §5 ("旧运行时退役必须处理在途引用与后台写入，不能只从 Map 删除") and
// the response-seat RETURN (2026-10-09, item 4): a handle captured before a revoke / replace / delete
// must not keep serving NEW operations. Re-checking the registry on the next `map.get` is not enough,
// because the caller already holds the instance.
//
// Semantics (frozen here):
//   * every secondary runtime the map hands out is wrapped in ONE memoized lease-guarded handle;
//   * the guard re-checks the lease (and the registry's serving decision) at every function call —
//     an operation that already entered the underlying function is unaffected ("in-flight operations
//     finish safely"), a NEW call after the revoke/replace/retire fails explicitly;
//   * the lease is revoked synchronously when the instance is retired/replaced — even if the same
//     Vault id is later re-admitted, the old handle can never become valid again;
//   * data properties (`id`/`root`/`primary`/`descriptor`/`paths`/`capabilities`) pass through, so
//     consumers/caches can still key on the handle.
//
// This module is a pure calculator: no I/O, no module-level mutable state, explicit parameters.

export const VAULT_RUNTIME_LEASE_REVOKED = "VAULT_RUNTIME_LEASE_REVOKED";

/**
 * W2FIX3 item 4: the lease state of a leased facade, readable by the background subsystems that
 * need to re-check "is this handle still current?" on EVERY new operation (not only on the next
 * `map.get`). Non-enumerable-safe: the symbol is set before `Object.freeze`, so `Object.entries`
 * (used to build the facade) never sees it, but the guard seam can.
 */
export const LEASE_STATE = Symbol("vaultRuntimeLeaseState");

/**
 * One lease per materialized runtime instance (secondary AND primary, item 4). `generation` is the
 * AUTHORIZATION generation this handle was minted for — the map keeps it equal to the admission
 * entry's generation, so a revoke (bump) or a subsequent re-approval (another bump) irreversibly
 * kills the previously handed-out facade. `identityDigest` binds the handle to the identity it was
 * minted for. `revoked` is latched: it is never cleared.
 */
export function createRuntimeLease(id, { identityDigest = null, generation = 0 } = {}) {
  return { id, identityDigest, generation, revoked: false, reason: null };
}

/** Revoke (retire/replace/release). Idempotent; the reason is kept for the structured refusal. */
export function revokeRuntimeLease(lease, reason = "retired") {
  if (lease === null || lease === undefined) return lease;
  if (!lease.revoked) {
    lease.revoked = true;
    lease.reason = reason;
    lease.generation += 1;
  }
  return lease;
}

function leaseError(lease) {
  const error = new Error(
    `[${VAULT_RUNTIME_LEASE_REVOKED}] the Vault runtime handle for ${JSON.stringify(lease?.id)} is no longer current ` +
      `(${lease?.reason ?? "revoked"}): re-resolve the Vault before issuing another operation (contract §5)`,
  );
  error.name = "VaultRuntimeLeaseRevoked";
  error.code = VAULT_RUNTIME_LEASE_REVOKED;
  error.status = 503;
  error.httpStatus = 503;
  error.reason = lease?.reason ?? "revoked";
  error.vaultId = lease?.id ?? null;
  return error;
}

/**
 * `createLeasedRuntime(runtime, lease, isCurrent?)` → ONE memoizable lease-guarded FACADE.
 *
 * `isCurrent()` defaults to "the lease has not been revoked"; the map passes a predicate that also
 * consults the registry's serving gate, so a `revoke()` that tightens the gate invalidates captured
 * handles immediately — before the (possibly coalesced) scan round finishes.
 *
 * Why a plain facade and not a Proxy: the runtime (and `localFs`) are `Object.freeze`d, and the Proxy
 * invariant forbids a `get` trap from substituting a value for a frozen non-configurable data
 * property. A facade built from `Object.entries` is a fresh plain object, so one nested level of
 * service objects (`localFs`, and any future per-Vault service the factory exposes) is wrapped too:
 * `handle.localFs.readLimitedText(...)` re-checks the lease exactly like a call on the runtime.
 * The facade is memoized by the caller (one object per retired-able instance), which keeps the
 * `git-runtimes.js`/`search-runtimes.js` WeakMap caches keyed on the handle working.
 */
export function createLeasedRuntime(runtime, lease, isCurrent = null, depth = 1) {
  const current = typeof isCurrent === "function" ? isCurrent : () => lease === null || lease === undefined || lease.revoked !== true;
  const assertCurrent = () => {
    if (!current()) throw leaseError(lease);
  };
  const facade = {};
  for (const [key, value] of Object.entries(runtime)) {
    if (typeof value === "function") {
      facade[key] = function leasedCall(...args) {
        assertCurrent();
        return value.apply(runtime, args);
      };
    } else if (depth > 0 && value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).some((entry) => typeof entry === "function")) {
      // Only wrap nested SERVICE objects (they expose callable operations); pure data (`descriptor`,
      // `paths`, `capabilities`) keeps its original reference so identity/deep comparisons still work.
      facade[key] = createLeasedRuntime(value, lease, current, depth - 1);
    } else {
      facade[key] = value;
    }
  }
  // The guard seam (item 5): a background subsystem (Git sweep, retrieval timers) receives this
  // facade and can re-check currency on every new operation through `isHandleCurrent()`.
  Object.defineProperty(facade, LEASE_STATE, {
    value: Object.freeze({ lease, check: current, assert: assertCurrent, runtime }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(facade);
}

/** The unguarded instance behind a leased facade, or `null` for a raw/unrelated object. */
export function guardedRuntimeOf(handle) {
  const state = handle !== null && typeof handle === "object" ? handle[LEASE_STATE] : null;
  return state?.runtime ?? null;
}

/** The live lease carried by a leased facade, or `null` for a raw/unrelated object. */
export function leaseOfHandle(handle) {
  const state = handle !== null && typeof handle === "object" ? handle[LEASE_STATE] : null;
  return state?.lease ?? null;
}

/**
 * W2FIX3 item 5 — may this handle schedule NEW background work? A raw object (the process-shared
 * primary instances, unit tests) is unguarded. A LEASED facade must still be current, so a
 * background consumer that re-arms a timer AFTER `revoke` (e.g. an index invalidation produced by an
 * in-flight build that outlives `drain()`) is refused instead of resurrecting work for a revoked
 * Vault. `revoke` is therefore impossible to undo by a late re-arm.
 */
export function mayScheduleWork(handle) {
  if (handle === null || typeof handle !== "object") return true;
  if (handle[LEASE_STATE] === undefined) return true;
  return isHandleCurrent(handle);
}

/** Does a leased facade still satisfy its lease (and the caller's currency predicate)? */
export function isHandleCurrent(handle) {
  const state = handle !== null && typeof handle === "object" ? handle[LEASE_STATE] : null;
  if (state === null) return false;
  try {
    return state.check() === true;
  } catch {
    return false;
  }
}

/** Non-secret status projection for `reconciliation.status()` / `/healthz`. */
export function describeRuntimeLease(lease) {
  if (lease === null || lease === undefined) return Object.freeze({ lease: null });
  return Object.freeze({ lease: { id: lease.id, generation: lease.generation, revoked: lease.revoked, reason: lease.reason } });
}
