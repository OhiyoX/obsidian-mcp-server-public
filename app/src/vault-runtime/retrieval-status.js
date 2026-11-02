// B3 — pure retrieval status / job / result payload builders.
//
// Contract: "DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置" §12 (Retrieval runtime),
// §27 B3, §40 (structured capability-disabled responses), §43-7 (no module-level runtime
// state), §43-5 (a new Vault-dependent module imports no global path constant).
//
// Extracted from `retrieval-runtime.js` to stay inside the repository's line module gate
// and because these builders are genuinely pure: every per-Vault fact (index path, capability
// entry, semantic configuration, job snapshot) is an explicit parameter, so the exact
// `index_status` payload shape that `src/tool-contracts.js` declares lives in one place.
//
// No module-level mutable state, no `config.js` import, no `process.env`, no global path
// constant.

/**
 * One `retrievalIndexStatus()` payload. `current` is this runtime's committed index state
 * (or `null` for the capability-disabled form, which then carries `reason` instead of an
 * implicitly-empty "real" index).
 */
export function retrievalStatusPayload({ indexPath, indexVersion, current, semantic, capability, semanticCapability, indexJob, reason }) {
  const notes = current ? Object.values(current.notes) : [];
  const chunks = notes.flatMap((note) => note.chunks);
  return {
    available: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    path: indexPath,
    version: current ? current.version : indexVersion,
    updatedAt: current ? current.updatedAt : null,
    notes: notes.length,
    chunks: chunks.length,
    embeddedChunks: chunks.filter((chunk) => Array.isArray(chunk.embedding)).length,
    embeddingModel: current ? current.embeddingModel : null,
    semantic,
    capability,
    semanticCapability,
    indexJob: current ? indexJob : null,
  };
}

/** `startRetrievalIndex` / `reindex_vault` payload for a capability-disabled Vault. */
export function unavailableJobPayload(reason) {
  return {
    unavailable: true,
    available: false,
    reason,
    id: null,
    status: "unavailable",
    startedAt: null,
    updatedAt: null,
    totalNotes: 0,
    processedNotes: 0,
    completedBatches: 0,
    embeddedChunks: 0,
    currentPath: null,
    currentBatchSize: 0,
    error: null,
    queuedFollowUp: false,
  };
}

/** `syncRetrievalIndex` payload for a capability-disabled Vault. */
export function unavailableIndexPayload(reason) {
  return { unavailable: true, available: false, reason, notes: 0, chunks: 0, added: 0, updated: 0, removed: 0, reused: 0, embeddedChunks: 0, semanticError: null, updatedAt: null, vaultIndex: null };
}

/**
 * `recall` / `recallFromSnapshot` payload for a capability-disabled Vault: report the query
 * and the structured reason, return no results, and never read (or echo) another Vault's index.
 */
export function unavailableRecallPayload({ query, reason, index }) {
  return {
    query,
    results: [],
    totalCandidates: 0,
    semanticUsed: false,
    semanticError: null,
    unavailable: true,
    available: false,
    reason,
    index,
  };
}
