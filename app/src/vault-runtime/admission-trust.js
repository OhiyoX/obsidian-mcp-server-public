// W2FIX3 (#437 RETURN 2) — the trusted READ-ONLY projection of the admission store.
//
// Split out of `admission-store.js` (line budget) as one cohesive unit: "what does the trusted state
// say about ONE id, and what is the CAS base of the next round?". Everything here answers from the
// in-memory validated record PLUS the surviving managed-mode sentinel, and never writes anything:
//
//   * `bindingFor(id)`       — the trusted identity binding: the record first, then the sentinel, so a
//                              lost record does not lose the binding (item 1);
//   * `generationFloorFor(id)`— the generation floor is the MAXIMUM of the record and the sentinel
//                              binding; a higher sentinel floor is never ignored while a record exists
//                              (item 2 — the sentinel is written BEFORE the record);
//   * `snapshotState()`      — the revision + entries a reconciliation round must build on, i.e. the
//                              compare-and-swap base of the next commit (item 3).
//
// Pure calculator: all facts are injected accessors, there is no I/O and no ambient state.

/**
 * `createAdmissionTrust({ getState, getEnrollment, requireLoaded })`
 *
 *   getState()     — the current validated record, or `null` when it is absent/not loaded
 *   getEnrollment()— the current validated sentinel, or `null` when there is none
 *   requireLoaded()— the store's own guard (throws when a mutation runs before `load()`)
 */
export function createAdmissionTrust({ getState, getEnrollment, requireLoaded }) {
  /** The CAS base of the next persistence round (item 3): one revision + a copy of the entries. */
  function snapshotState() {
    requireLoaded();
    const state = getState();
    return Object.freeze({
      revision: state === null ? 0 : state.revision,
      entries: Object.freeze({ ...(state?.entries ?? {}) }),
      initialized: state !== null && state.migration.done === true,
    });
  }

  function bindingFor(id) {
    const persisted = getState()?.entries?.[id]?.identity ?? null;
    if (persisted !== null) return persisted;
    return getEnrollment()?.bindings?.[id]?.identity ?? null;
  }

  function generationFloorFor(id) {
    const persisted = getState()?.entries?.[id]?.generation ?? 0;
    const sentinel = getEnrollment()?.bindings?.[id]?.generation ?? 0;
    return Math.max(persisted, sentinel);
  }

  return Object.freeze({ snapshotState, bindingFor, generationFloorFor });
}
