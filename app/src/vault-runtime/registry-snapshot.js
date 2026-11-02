// W2 (#437) — neutral registry snapshot shape helpers (contract §4.2).
//
// Split out of `registry.js` (which must stay inside the repository line budget) as one cohesive
// unit: "build and summarise a frozen registry snapshot". `registry.js` imports these and re-exports
// nothing new; the public surface is unchanged.

/** Deterministic code-unit ordering (independent of locale). */
export function compareCodeUnit(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function emptySnapshot(config) {
  return Object.freeze({
    ready: false,
    revision: 0,
    primaryId: config.primaryId,
    vaultsRoot: config.vaultsRoot,
    maxVaults: config.maxVaults,
    vaults: Object.freeze([]),
    // W2 (#437) admission/identity projection; empty without a gate, so the legacy path is unchanged.
    admissions: Object.freeze({}), identities: Object.freeze({}),
    skipped: Object.freeze([]),
    skippedOverflow: 0,
    preparedAt: null, durationMs: null,
  });
}

export function describeSnapshot(snapshot) {
  return Object.freeze({
    ready: snapshot.ready,
    revision: snapshot.revision,
    primaryId: snapshot.primaryId,
    vaultsRoot: snapshot.vaultsRoot,
    maxVaults: snapshot.maxVaults,
    vaults: snapshot.vaults,
    admissions: snapshot.admissions,
    identities: snapshot.identities,
    skipped: snapshot.skipped,
    skippedOverflow: snapshot.skippedOverflow,
    preparedAt: snapshot.preparedAt, durationMs: snapshot.durationMs,
    counts: Object.freeze({
      registered: snapshot.vaults.length,
      primary: snapshot.vaults.some((vault) => vault.primary) ? 1 : 0,
      skipped: snapshot.skipped.length + snapshot.skippedOverflow,
    }),
  });
}

export function freezeSkipRecord(entry) {
  return Object.freeze(entry.code === undefined ? { name: entry.name, reason: entry.reason } : { name: entry.name, reason: entry.reason, code: entry.code });
}
