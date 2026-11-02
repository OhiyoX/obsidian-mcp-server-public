// W2FIX3 (#437 RETURN 2) — the per-Vault admission gate of the reconciliation service.
//
// Split out of `reconciliation.js` (line budget) as one cohesive unit: "given one round's decision
// buffer, decide whether a discovered Vault may be served". The gate NEVER writes `approved`; it only
// observes identity and reads the persisted admission decision (contract §2.1/§3.1/§4.1 step ①).

import { RUNTIME_READY, RUNTIME_UNAVAILABLE } from "./reconciliation-vocabulary.js";

/**
 * `createGateFactory({ admissions, resolveIdentity, refuse, now })`
 * Returns `createGate(run)` → an async `(descriptor) => decision` bound to one round's entries.
 */
export function createGateFactory({ admissions, resolveIdentity, refuse, now }) {
  return function createGate(run) {
    return async (descriptor) => {
      const startedAt = now();
      const entry = run.entries[descriptor.id];
      if (admissions !== null && !admissions.isInitialized()) {
        run.observations[descriptor.id] = { identity: null, conflict: false, touched: false, discoveryMs: 0 };
        return refuse(descriptor, { admitted: false, admission: null, status: "pending", reason: "admissions-not-initialized", identity: null, generation: null });
      }
      let identity = null;
      try {
        identity = await resolveIdentity({ root: descriptor.root });
      } catch (error) {
        const proofMissing = error?.code === "VAULT_INCARNATION_UNRESOLVED";
        const conflict = Boolean(proofMissing && entry?.identity);
        const pending = proofMissing && error.missing === true && !entry?.identity && admissions !== null;
        run.observations[descriptor.id] = { identity: null, conflict, touched: proofMissing, discoveryMs: Math.max(0, now() - startedAt) };
        return refuse(descriptor, { admitted: false, admission: entry?.admission ?? (pending ? "pending" : null),
          status: pending ? "pending" : RUNTIME_UNAVAILABLE, reason: conflict ? "identity-changed" : pending ? "awaiting-approval" : "identity-unresolved",
          code: conflict ? "VAULT_ADMISSION_IDENTITY_CONFLICT" : error?.code ?? null, identity: null, generation: entry?.generation ?? null });
      }
      run.observations[descriptor.id] = { identity, conflict: false, touched: true, discoveryMs: Math.max(0, now() - startedAt) };

      if (admissions === null) return { admitted: true, admission: null, status: RUNTIME_READY, reason: null, identity, generation: null };
      if (!admissions.isInitialized()) {
        // §2.3: an uninitialized file must not auto-approve anything, not even the configured primary.
        return refuse(descriptor, { admitted: false, admission: null, status: "pending", reason: "admissions-not-initialized", code: null, identity, generation: null });
      }
      if (entry === undefined) return refuse(descriptor, { admitted: false, admission: "pending", status: "pending", reason: "awaiting-approval", code: null, identity, generation: null });
      if (entry.identity?.identityVersion === 1 || (entry.identity !== null && entry.identity.digest !== identity.digest)) {
        // §3.1: the persisted binding wins; the id is refused and not reusable (new ID required).
        run.observations[descriptor.id].conflict = true;
        return refuse(descriptor, { admitted: false, admission: entry.admission, status: RUNTIME_UNAVAILABLE, reason: "identity-changed", code: "VAULT_ADMISSION_IDENTITY_CONFLICT", identity, generation: entry.generation });
      }
      if (entry.admission !== "approved") return refuse(descriptor, { admitted: false, admission: entry.admission, status: "pending", reason: "awaiting-approval", code: null, identity, generation: entry.generation });
      // W2FIX3 item 4: the authorization generation travels with the committed decision so the runtime
      // map can bind its consumer handles to the SAME generation the gate serves.
      return { admitted: true, admission: "approved", status: RUNTIME_READY, reason: null, identity, generation: entry.generation };
    };
  };
}
