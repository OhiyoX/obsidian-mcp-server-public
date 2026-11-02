// W2FIX3 (#437 RETURN 2, item 4) — the per-id runtime lease manager of the runtime map.
//
// Split out of `instances.js` (line budget) as one cohesive unit: "when is the consumer facade for a
// Vault id still current, and when must it be re-minted". The map owns the instances; this module
// owns the lease arithmetic and the currency predicate that binds a handle to a real identity AND
// authorization generation — never merely to an id plus a boolean.
//
// Pure calculator: every fact (serving decision, admission generation/identity) is an injected
// callback reading the SAME committed registry snapshot consumers use.

import { createLeasedRuntime, createRuntimeLease, revokeRuntimeLease } from "./runtime-lease.js";

/**
 * `createLeaseManager({ isServable, generationOf, identityDigestOf })`
 *
 *   isServable(id)      — the gate's answer (a durable revoke tightens this synchronously)
 *   generationOf(id)    — the committed admission generation, or null when unavailable
 *   identityDigestOf(id)— the committed identity digest, or null
 */
export function createLeaseManager({ isServable, generationOf, identityDigestOf, identityIsCurrent = () => true }) {
  /** The ONE currency predicate shared by the consumer facade and the background guard. */
  function isCurrent(lease) {
    if (lease === null || lease === undefined || lease.revoked === true) return false;
    if (!isServable(lease.id)) return false;
    if (!identityIsCurrent(lease.id)) {
      revokeRuntimeLease(lease, "identity-changed");
      return false;
    }
    const generation = generationOf(lease.id);
    if (generation !== null && generation !== lease.generation) return false;
    const digest = identityDigestOf(lease.id);
    if (digest !== null && lease.identityDigest !== null && digest !== lease.identityDigest) return false;
    return true;
  }

  /**
   * Mint a fresh lease for a confirmed authorization, including a latched revocation whose local
   * generation equals the subsequent approval generation. Only a healthy equal-generation lease
   * is reusable. The OLD
   * lease stays revoked/behind so a captured facade is dead for good; the runtime instance is reused.
   * Returns true when the entry's handle must be rebuilt.
   */
  function refresh(entry) {
    const generation = generationOf(entry.lease.id);
    if (generation === null || generation < entry.lease.generation) return false;
    if (generation === entry.lease.generation && entry.lease.revoked !== true) return false;
    // Re-resolution cannot undo a latch using an older approval, a refusal or missing/changed proof.
    if (!isServable(entry.lease.id) || !identityIsCurrent(entry.lease.id)) return false;
    const digest = identityDigestOf(entry.lease.id);
    if (entry.lease.identityDigest !== null && digest !== entry.lease.identityDigest) return false;
    if (entry.lease.revoked !== true) revokeRuntimeLease(entry.lease, "superseded");
    entry.lease = createRuntimeLease(entry.lease.id, { identityDigest: digest, generation });
    entry.handle = null;
    return true;
  }

  function mint(id) {
    return createRuntimeLease(id, { identityDigest: identityDigestOf(id), generation: generationOf(id) ?? 0 });
  }

  function bindPrimary(entry, onPrimaryLease) {
    if (typeof onPrimaryLease !== "function") return;
    refresh(entry);
    const lease = entry.lease;
    if (entry.handle === null) entry.handle = createLeasedRuntime(entry.runtime, lease, () => isCurrent(lease));
    onPrimaryLease(lease, () => isCurrent(lease));
  }
  return Object.freeze({ isCurrent, refresh, mint, bindPrimary });
}
