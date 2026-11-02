// B3 — per-Vault retrieval runtime.
//
// Contract: "DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置"
//   §12  Retrieval runtime: `state` / `loading` / `operationQueue` / `activeIndexJob` /
//        `refreshTimer(s)` / `lastRefreshAt` / `pendingIndexOptions` move into a per-Vault
//        runtime; the index file uses that runtime's data path; the embedding provider may
//        stay process-shared while index content and build-job state do not; a disabled
//        capability returns a structured unavailable and never silently falls back to
//        another Vault's index.
//   §27 B3 owner (`app/src/retrieval.js` + retrieval tests), §40 (A/B independence,
//   failure A must not dirty B), §43-7 (no module-level retrieval state), §45 (gates).
//   B1 seam: `scratch/multi-vault/B1/B1.HANDOFF.md` — `vaultRuntime.paths` / `localFs`.
//
// `createRetrievalRuntime({ vaultRuntime, embeddingProvider?, deps? })` owns, inside one
// closure per Vault, exactly the state BASE held as `retrieval.js` module globals (W0-A doc
// §4.3): two Vaults therefore get two independent indexes, queues, jobs and timers, and an A
// failure cannot dirty B.
//
// Isolation rules: the index file is `vaultRuntime.paths.retrievalIndex` (A7; the primary
// runtime's A7 mapping passes the legacy path through untouched, §5.1/§22.2); the embedding
// provider may be one shared process instance; `deps.getVaultIndex` is the *only* index
// source a runtime can have — there is no module-level default to fall back to, so without it
// the retrieval capability is `{ available:false, reason }` and no index read is attempted
// (§12 / §40 / SEC-MV06).
//
// This module reads no `process.env` and imports no `config.js`; every tunable and every
// collaborator is an explicit input (B1 seam style, §43-5), and this file exports no mutable
// module-level binding.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { unavailable } from "./descriptor.js";
import { chunkMarkdown, metadataFor, rankRecall, tokenize } from "./retrieval-rank.js";
import { retrievalStatusPayload, unavailableIndexPayload, unavailableJobPayload, unavailableRecallPayload } from "./retrieval-status.js";

const INDEX_VERSION = 1;

/**
 * Fallback tunables, used only when a caller omits `deps.retrievalConfig`. The compatibility
 * facade always injects the live `config.js` values, and
 * `app/test/retrieval-runtime-facade.test.js` pins those injected values against `config.js`,
 * which is the drift guard that keeps this mirror honest.
 */
export const DEFAULT_RETRIEVAL_CONFIG = Object.freeze({
  chunkSize: 1400,
  overlap: 180,
  autoEmbed: true,
  refreshDebounceMs: 1000,
  embeddingBatchSize: 32,
  embeddingIndexConcurrency: 4,
});

export const RETRIEVAL_INDEX_PROVIDER_REQUIRED =
  "no per-Vault index provider was injected (`deps.getVaultIndex`); retrieval must not read another Vault's index (contract §12, SEC-MV06)";
export const EMBEDDING_PROVIDER_REQUIRED =
  "no embedding provider was injected for this Vault; semantic recall is unavailable (contract §12)";
/** W2FIX5 R2: the structured reason a superseded/revoked primary authorization returns. */
export const RETRIEVAL_AUTHORIZATION_REVOKED = "vault_runtime_lease_revoked";

const AVAILABLE = Object.freeze({ available: true });
const DISABLED_SEMANTIC_CONFIGURATION = Object.freeze({ enabled: false, provider: "disabled", baseUrl: null, model: null, timeoutMs: null, identity: null });

function fail(detail) {
  throw new Error(`vault-runtime/retrieval-runtime: ${detail}`);
}

function describe(value) {
  return typeof value === "string" ? JSON.stringify(value) : value === null ? "null" : Array.isArray(value) ? `array(${value.length})` : `${typeof value} ${String(value)}`;
}

function normalizeRetrievalConfig(value) {
  if (value === undefined || value === null) return DEFAULT_RETRIEVAL_CONFIG;
  if (typeof value !== "object" || Array.isArray(value)) fail(`deps.retrievalConfig must be an object, got ${describe(value)}`);
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(DEFAULT_RETRIEVAL_CONFIG, key));
  if (unknown.length > 0) fail(`unknown deps.retrievalConfig keys: ${unknown.join(", ")}`);
  const resolved = {};
  for (const [key, fallback] of Object.entries(DEFAULT_RETRIEVAL_CONFIG)) {
    const candidate = value[key] === undefined ? fallback : value[key];
    if (key === "autoEmbed") {
      if (typeof candidate !== "boolean") fail(`deps.retrievalConfig.autoEmbed must be a boolean, got ${describe(candidate)}`);
    } else if (!Number.isInteger(candidate) || candidate < (key === "overlap" ? 0 : 1)) {
      fail(`deps.retrievalConfig.${key} must be ${key === "overlap" ? "a non-negative" : "a positive"} integer, got ${describe(candidate)}`);
    }
    resolved[key] = candidate;
  }
  return Object.freeze(resolved);
}

/**
 * `vaultRuntime` is a B1 `createVaultRuntime` result (`paths.retrievalIndex` is this runtime's
 * index file). `embeddingProvider` is an optional process-shared `{ embedTexts,
 * semanticConfiguration }`. `deps` carries `getVaultIndex` (this Vault's own index source),
 * `retrievalConfig` (tunables) and `log`. Returns a frozen instance whose methods are the
 * compatibility facade's exports.
 */
export function createRetrievalRuntime(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail(`createRetrievalRuntime expects an input object, got ${describe(input)}`);

  const vaultRuntime = input.vaultRuntime;
  if (vaultRuntime === null || typeof vaultRuntime !== "object" || Array.isArray(vaultRuntime)) fail(`vaultRuntime must be a VaultRuntime (B1 createVaultRuntime result), got ${describe(vaultRuntime)}`);
  if (typeof vaultRuntime.id !== "string" || vaultRuntime.id === "") fail(`vaultRuntime.id must be a non-empty string, got ${describe(vaultRuntime.id)}`);
  const paths = vaultRuntime.paths;
  if (paths === null || typeof paths !== "object" || Array.isArray(paths)) fail(`vaultRuntime.paths must be the A7 vaultDataPaths result, got ${describe(paths)}`);
  const indexPath = paths.retrievalIndex;
  if (typeof indexPath !== "string" || indexPath === "" || indexPath.includes("\0")) fail(`vaultRuntime.paths.retrievalIndex must be a non-empty path string (A7 layout), got ${describe(indexPath)}`);

  const embeddingProvider = input.embeddingProvider === undefined ? null : input.embeddingProvider;
  if (embeddingProvider !== null && (
    typeof embeddingProvider !== "object" || Array.isArray(embeddingProvider)
    || typeof embeddingProvider.embedTexts !== "function"
    || typeof embeddingProvider.semanticConfiguration !== "function"
  )) {
    fail("embeddingProvider must be null or an object with embedTexts() and semanticConfiguration() (contract §12: the provider may be process-shared, the index/job state must not be)");
  }

  const deps = input.deps === undefined ? {} : input.deps;
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) fail(`deps must be an object, got ${describe(deps)}`);
  const indexProvider = deps.getVaultIndex;
  if (indexProvider !== undefined && typeof indexProvider !== "function") fail(`deps.getVaultIndex must be a function, got ${describe(indexProvider)}`);
  const retrievalConfig = normalizeRetrievalConfig(deps.retrievalConfig);
  const log = deps.log === undefined ? console : deps.log;
  if (log === null || typeof log !== "object" || typeof log.error !== "function") fail("deps.log must be a console-like object with an error() method");

  // W2FIX5 (#437 W2FIX4 item B / R2): an optional per-generation authorization for a PROCESS-SHARED
  // runtime (the primary singleton). `token()` returns the generation this callback was armed under;
  // `allowed()` re-checks the current handle's lease. `null` (the default) keeps the legacy unguarded
  // behaviour for a per-Vault instance whose handle is already lease-guarded by its facade.
  const authorization = deps.authorization === undefined || deps.authorization === null ? null : deps.authorization;
  if (authorization !== null && (typeof authorization.token !== "function" || typeof authorization.allowed !== "function")) {
    fail("deps.authorization must expose token() and allowed() when provided");
  }
  const mayRun = () => authorization === null || authorization.allowed() === true;
  const authToken = () => (authorization === null ? null : authorization.token());

  const capability = typeof indexProvider === "function" ? AVAILABLE : unavailable(RETRIEVAL_INDEX_PROVIDER_REQUIRED);

  // Per-instance state — BASE's `retrieval.js` module globals, now closure-local (§12/§43-7).
  let state;
  let loading;
  let operationQueue = Promise.resolve();
  let activeIndexJob;
  let lastRefreshAt = 0;
  let pendingIndexOptions;
  let refreshTimer;
  let refreshTimerOptions;

  function semanticConfiguration() {
    return embeddingProvider === null ? DISABLED_SEMANTIC_CONFIGURATION : embeddingProvider.semanticConfiguration();
  }

  function semanticCapability() {
    if (embeddingProvider === null) return unavailable(EMBEDDING_PROVIDER_REQUIRED);
    let configuration;
    try {
      configuration = embeddingProvider.semanticConfiguration();
    } catch (error) {
      return unavailable(`embedding provider configuration is unavailable: ${error.message}`);
    }
    if (configuration === null || typeof configuration !== "object" || configuration.enabled !== true) {
      const provider = configuration !== null && typeof configuration === "object" ? String(configuration.provider || "disabled") : "unknown";
      return unavailable(`embedding provider ${JSON.stringify(provider)} is disabled for this process; semantic recall is unavailable for Vault ${JSON.stringify(vaultRuntime.id)} (contract §12)`);
    }
    return AVAILABLE;
  }

  function statusPayload(current, reason) {
    return retrievalStatusPayload({ indexPath, indexVersion: INDEX_VERSION, current, semantic: semanticConfiguration(), capability, semanticCapability: semanticCapability(), indexJob: jobSnapshot(), reason });
  }

  function enqueue(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  }

  function jobSnapshot(job = activeIndexJob) {
    if (!job) return null;
    return { ...job, result: undefined, error: job.error || undefined, queuedFollowUp: Boolean(pendingIndexOptions) };
  }

  function emptyState() {
    return { version: INDEX_VERSION, updatedAt: null, embeddingModel: null, notes: {} };
  }

  async function loadState() {
    if (state) return state;
    if (loading) return loading;
    loading = (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(indexPath, "utf-8"));
        state = parsed.version === INDEX_VERSION ? parsed : emptyState();
      } catch (error) {
        if (error?.code !== "ENOENT") log.error("Retrieval index load failed:", error.message);
        state = emptyState();
      }
      return state;
    })();
    return loading;
  }

  async function saveState(index) {
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    const temp = `${indexPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(index)}\n`, "utf-8");
      await fs.rename(temp, indexPath);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async function addEmbeddings(chunks, job) {
    const batchSize = retrievalConfig.embeddingBatchSize;
    const batches = [];
    for (let start = 0; start < chunks.length; start += batchSize) batches.push(chunks.slice(start, start + batchSize));
    let nextBatch = 0;
    async function worker() {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++];
        const vectors = await embeddingProvider.embedTexts(batch.map((chunk) => `${chunk.heading}\n${chunk.text}`), { priority: "background" });
        batch.forEach((chunk, index) => { chunk.embedding = vectors[index]; });
        if (job) { job.embeddedChunks += batch.length; job.completedBatches += 1; job.currentBatchSize = batch.length; job.updatedAt = new Date().toISOString(); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(retrievalConfig.embeddingIndexConcurrency, batches.length) }, () => worker()));
  }

  async function syncIndexUnlocked(options = {}, job, capturedToken) {
    // F4: recheck authorization at execution time for queued operations
    if (!mayRun()) {
      if (job) { job.status = "cancelled"; job.updatedAt = new Date().toISOString(); }
      return unavailableIndexPayload(RETRIEVAL_AUTHORIZATION_REVOKED);
    }
    // F4: detect generation change (token mismatch) for queued operations
    if (capturedToken !== undefined && capturedToken !== authToken()) {
      if (job) { job.status = "cancelled"; job.updatedAt = new Date().toISOString(); }
      return unavailableIndexPayload(RETRIEVAL_AUTHORIZATION_REVOKED);
    }
    const current = structuredClone(await loadState());
    const vault = await indexProvider({ force: options.force });
    if (job) { job.status = "running"; job.totalNotes = vault.records.length; job.updatedAt = new Date().toISOString(); }
    const semantic = semanticConfiguration();
    if (semantic.enabled && current.embeddingModel !== semantic.identity) {
      for (const note of Object.values(current.notes)) for (const chunk of note.chunks || []) delete chunk.embedding;
      current.embeddingModel = semantic.identity;
    }
    const seen = new Set();
    let added = 0;
    let updated = 0;
    let removed = 0;
    let reused = 0;
    let embeddedChunks = 0;
    let semanticError = null;
    for (const record of vault.records) {
      seen.add(record.path);
      const existing = current.notes[record.path];
      if (!options.force && existing?.revision === record.revision) {
        if (options.embeddings && semantic.enabled) {
          const missing = existing.chunks.filter((chunk) => !chunk.embedding);
          try {
            await addEmbeddings(missing, job);
            embeddedChunks += missing.length;
          } catch (error) {
            semanticError = error.message;
          }
        }
        reused += 1;
        continue;
      }
      const chunks = chunkMarkdown(record, { chunkSize: retrievalConfig.chunkSize, overlap: retrievalConfig.overlap });
      const priorByHash = new Map((existing?.chunks || []).map((chunk) => [chunk.hash, chunk.embedding]));
      for (const chunk of chunks) if (priorByHash.has(chunk.hash)) chunk.embedding = priorByHash.get(chunk.hash);
      if (options.embeddings && semantic.enabled) {
        const missing = chunks.filter((chunk) => !chunk.embedding);
        try {
          await addEmbeddings(missing, job);
          embeddedChunks += missing.length;
        } catch (error) {
          semanticError = error.message;
        }
      }
      current.notes[record.path] = { path: record.path, revision: record.revision, stat: record.stat, metadata: metadataFor(record), chunks };
      if (job) { job.processedNotes += 1; job.updatedAt = new Date().toISOString(); job.currentPath = record.path; }
      if (existing) updated += 1;
      else added += 1;
    }
    for (const notePath of Object.keys(current.notes)) {
      if (!seen.has(notePath)) {
        delete current.notes[notePath];
        removed += 1;
      }
    }
    current.updatedAt = new Date().toISOString();
    await saveState(current);
    state = current;
    return { notes: Object.keys(current.notes).length, chunks: Object.values(current.notes).reduce((sum, note) => sum + note.chunks.length, 0), added, updated, removed, reused, embeddedChunks, semanticError, updatedAt: current.updatedAt, vaultIndex: vault.stats };
  }

  function syncRetrievalIndex(options = {}) {
    if (!capability.available) return unavailableIndexPayload(capability.reason);
    // F4 (#437 W2FIX5): direct sync must respect the same mayRun gate as startRetrievalIndex:306
    // and requestRetrievalRefresh:335, so a revoked/superseded generation cannot write new index
    // files even when called directly (not via the debounced timer path).
    if (!mayRun()) return unavailableIndexPayload(RETRIEVAL_AUTHORIZATION_REVOKED);
    // F4: capture the current token so the queued operation can detect generation changes
    const token = authToken();
    return enqueue(() => syncIndexUnlocked(options, null, token));
  }

  function startPendingIndexJob() {
    if (!pendingIndexOptions) return;
    const options = pendingIndexOptions;
    pendingIndexOptions = undefined;
    startRetrievalIndex(options);
  }

  function startRetrievalIndex(options = {}) {
    if (!capability.available) return unavailableJobPayload(capability.reason);
    // R2: a revoked/superseded generation must not start a real index job, even when the caller is an
    // already-armed timer closure that captured the process-shared instance before the revoke.
    if (!mayRun()) return unavailableJobPayload(RETRIEVAL_AUTHORIZATION_REVOKED);
    if (activeIndexJob && ["queued", "running"].includes(activeIndexJob.status)) {
      const previous = pendingIndexOptions || {};
      pendingIndexOptions = { ...previous, ...options };
      if (previous.embeddings || options.embeddings) pendingIndexOptions.embeddings = true;
      if (previous.force || options.force) pendingIndexOptions.force = true;
      return jobSnapshot();
    }
    const job = { id: randomUUID(), status: "queued", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), totalNotes: 0, processedNotes: 0, completedBatches: 0, embeddedChunks: 0, currentPath: null, currentBatchSize: 0, error: null };
    activeIndexJob = job;
    // F4: capture token for generation change detection
    const token = authToken();
    const task = enqueue(() => syncIndexUnlocked(options, job, token));
    task.then((result) => {
      // F4: if the queued operation was cancelled due to revoke, preserve the job's cancelled status
      if (job.status !== "cancelled") {
        job.status = "completed";
        job.result = result;
      }
      job.updatedAt = new Date().toISOString();
      job.finishedAt = job.updatedAt;
      startPendingIndexJob();
    }).catch((error) => {
      job.status = "failed";
      job.error = error.message;
      job.updatedAt = new Date().toISOString();
      job.finishedAt = job.updatedAt;
      startPendingIndexJob();
    });
    return jobSnapshot(job);
  }

  function requestRetrievalRefresh(options = {}) {
    if (!capability.available) return unavailableJobPayload(capability.reason);
    if (!mayRun()) return unavailableJobPayload(RETRIEVAL_AUTHORIZATION_REVOKED);
    if (!retrievalConfig.autoEmbed && options.embeddings === undefined) options = { ...options, embeddings: false };
    if (Date.now() - lastRefreshAt < 10000) return jobSnapshot();
    lastRefreshAt = Date.now();
    return startRetrievalIndex({ embeddings: retrievalConfig.autoEmbed, ...options });
  }

  function scheduleRetrievalRefresh(options = {}) {
    if (!capability.available) return unavailableJobPayload(capability.reason);
    if (!mayRun()) return unavailableJobPayload(RETRIEVAL_AUTHORIZATION_REVOKED);
    if (refreshTimer) return jobSnapshot();
    refreshTimerOptions = options;
    // The token is captured at ARM time; the callback refuses when the generation moved (a durable
    // revoke, or a re-approval that handed out a new lease) even though it is invoked directly.
    const token = authToken();
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const scheduled = refreshTimerOptions ?? options;
      refreshTimerOptions = undefined;
      if (authorization !== null && authToken() !== token) return;
      if (!mayRun()) return;
      try {
        requestRetrievalRefresh(scheduled);
      } catch (error) {
        log.error("Automatic retrieval refresh failed:", error.message);
      }
    }, retrievalConfig.refreshDebounceMs);
    refreshTimer.unref?.();
    return jobSnapshot();
  }

  // Lifecycle barrier for teardown/tests: promote a pending debounced refresh into the real
  // queued write its timer would have made, then resolve only when the refresh timer slot and
  // this instance's operation queue are both quiescent (the queue never rejects; failures are
  // reported through the job status). Per Vault, so draining A never drains B.
  async function drainRetrievalIndex() {
    for (;;) {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
        const options = refreshTimerOptions ?? {};
        refreshTimerOptions = undefined;
        // R2: an unauthorized (revoked/superseded) generation CANCELS the not-yet-started debounce
        // instead of promoting it into a fresh write; only work that already entered the queue is
        // awaited below.
        if (mayRun()) requestRetrievalRefresh(options);
      }
      const queue = operationQueue;
      await queue;
      await Promise.resolve();
      if (!refreshTimer && operationQueue === queue) return;
    }
  }

  async function retrievalIndexStatus() {
    if (!capability.available) return statusPayload(null, capability.reason);
    return statusPayload(await loadState());
  }

  // Snapshot-only status: reads the in-memory committed state and performs no disk IO. Returns
  // null when retrieval has never been loaded (or the capability is disabled) so a caller that
  // must not cold-load the retrieval JSON can report unavailability instead of forcing a read.
  function retrievalIndexStatusSnapshot() {
    if (!capability.available || !state) return null;
    return statusPayload(state);
  }

  function chunkMarkdownForVault(record, options = {}) {
    return chunkMarkdown(record, {
      chunkSize: options.chunkSize || retrievalConfig.chunkSize,
      overlap: options.overlap ?? retrievalConfig.overlap,
    });
  }

  async function recall(query, options = {}) {
    if (!String(query || "").trim()) throw new Error("Recall query is required");
    if (!capability.available) return unavailableRecallPayload({ query, reason: capability.reason, index: statusPayload(null, capability.reason) });
    await loadState();
    requestRetrievalRefresh();
    const current = await loadState();
    return { ...(await rankRecall(current, query, options, { semanticConfiguration, embedTexts: embeddingProvider?.embedTexts })), index: await retrievalIndexStatus() };
  }

  // Snapshot-only recall: never schedules a refresh or cold-loads the JSON. Throws when the
  // capability is available but nothing was ever loaded, so callers degrade truthfully instead
  // of reading a stale/empty index; a capability-disabled Vault returns the structured form.
  async function recallFromSnapshot(query, options = {}) {
    if (!String(query || "").trim()) throw new Error("Recall query is required");
    if (!capability.available) return unavailableRecallPayload({ query, reason: capability.reason, index: statusPayload(null, capability.reason) });
    if (!state) throw new Error("Retrieval snapshot unavailable");
    return { ...(await rankRecall(state, query, options, { semanticConfiguration, embedTexts: embeddingProvider?.embedTexts })), unavailable: false };
  }

  return Object.freeze({
    vaultId: vaultRuntime.id,
    indexPath,
    capability,
    semanticCapability,
    retrievalConfig,
    chunkMarkdown: chunkMarkdownForVault,
    tokenize,
    syncRetrievalIndex,
    startRetrievalIndex,
    requestRetrievalRefresh,
    scheduleRetrievalRefresh,
    drainRetrievalIndex,
    retrievalIndexStatus,
    retrievalIndexStatusSnapshot,
    recall,
    recallFromSnapshot,
  });
}
