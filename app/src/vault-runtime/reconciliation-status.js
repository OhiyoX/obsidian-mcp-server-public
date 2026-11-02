// W2 (#437) — the reconciliation service's run bookkeeping / observability projection (contract §6).
//
// Split out of `reconciliation.js` (which must stay inside the repository line budget) as one
// cohesive unit: "what a finished round publishes as status". It owns the per-Vault runtime
// projection, the bounded round history and the last-success/last-error facts. It never performs I/O
// and never decides anything: `reconciliation.js` calls `observeRoundStart`/`mutateStatus`/`finalize`.

import { RUNTIME_ERROR, RUNTIME_INITIALIZING } from "./reconciliation-vocabulary.js";

const HISTORY_LIMIT = 20;

function emptyVaultStatus() {
  return {
    admission: null,
    status: "unavailable",
    reason: null,
    code: null,
    identityDigest: null,
    lastSeenAt: null,
    lastSuccessAt: null,
    failureCount: 0,
    discoveryMs: null,
  };
}

export function createRunBookkeeping({ registry, roundBudgetMs, maxEntriesPerParent, now = () => Date.now(), logger = console } = {}) {
  const vaultStatus = new Map();
  const history = [];
  let lastRunAt = null;
  let lastSuccessAt = null;
  let lastDurationMs = null;
  let failureCount = 0;
  let lastDiff = null;
  let lastError = null;
  let revision = null;

  function mutateStatus(id, patch) {
    const current = vaultStatus.get(id) ?? emptyVaultStatus();
    vaultStatus.set(id, { ...current, ...patch });
  }

  /**
   * Mark every candidate `initializing` for the new round and return the ids that were `error`
   * BEFORE this round (an activation retry must not depend on the projection we just overwrote).
   */
  function observeRoundStart() {
    const previouslyErrored = new Set();
    for (const vault of registry.snapshot().vaults) {
      if (vaultStatus.get(vault.id)?.status === RUNTIME_ERROR) previouslyErrored.add(vault.id);
      mutateStatus(vault.id, { status: RUNTIME_INITIALIZING, reason: "reconciling" });
    }
    return previouslyErrored;
  }

  function noteFailure(id, { reason, code }) {
    mutateStatus(id, { status: RUNTIME_ERROR, reason, code: code ?? null, failureCount: (vaultStatus.get(id)?.failureCount ?? 0) + 1 });
  }

  function finalize(record, outcome) {
    const finishedAt = now();
    lastRunAt = record.startedAt;
    lastDurationMs = Math.max(0, finishedAt - record.startedAt);
    lastDiff = outcome.diff ?? lastDiff;
    if (outcome.status === "committed") {
      lastSuccessAt = finishedAt;
      lastError = null;
    } else if (outcome.status === "failed" || outcome.status === "not-published") {
      failureCount += 1;
      lastError = { stage: outcome.stage, code: outcome.error?.code ?? null, message: String(outcome.error?.message ?? outcome.error ?? "") };
      logger?.warn?.(`[vault-reconciliation] ${outcome.status} at ${outcome.stage}: ${lastError.message}`);
    }
    if (outcome.status === "committed-degraded" && outcome.error) {
      lastError = { stage: outcome.stage, code: outcome.error?.code ?? null, message: String(outcome.error?.message ?? outcome.error ?? "") };
    }
    const summary = Object.freeze({
      runId: record.id,
      trigger: record.trigger,
      status: outcome.status,
      stage: outcome.stage ?? null,
      revision: outcome.revision ?? revision,
      diff: outcome.diff ?? null,
      durationMs: lastDurationMs,
      created: outcome.created ?? Object.freeze([]),
      released: outcome.released ?? 0,
    });
    history.push(summary);
    if (history.length > HISTORY_LIMIT) history.shift();
    return summary;
  }

  function status(flight) {
    const snapshot = registry.snapshot();
    const vaults = {};
    for (const [id, value] of vaultStatus) vaults[id] = { ...value };
    return Object.freeze({
      revision: snapshot.ready ? snapshot.revision : null,
      commits: typeof registry.commits === "function" ? registry.commits() : null,
      inFlight: flight.inFlight,
      pendingRerun: flight.pendingRerun,
      coalesced: flight.coalesced,
      runs: flight.runs,
      failures: failureCount,
      lastRunAt,
      lastSuccessAt,
      lastDurationMs,
      lastError,
      diff: lastDiff,
      history: Object.freeze([...history]),
      vaults: Object.freeze(vaults),
      scheduled: Object.freeze({ watcher: false, periodic: false, debounceMs: 500, periodicMs: 60000, budgetMs: roundBudgetMs, maxEntriesPerParent }),
    });
  }

  return Object.freeze({
    mutateStatus,
    observeRoundStart,
    noteFailure,
    finalize,
    status,
    current: (id) => vaultStatus.get(id) ?? null,
    setRevision: (value) => {
      revision = value;
    },
  });
}
