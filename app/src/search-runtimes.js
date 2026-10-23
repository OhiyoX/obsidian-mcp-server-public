// Wave D / D-search — process wiring + per-Vault cache for the search runtime.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D search lane (one real per-Vault index/retrieval instance, no second Vault
//       selector), §11 (Vault index runtime), §12 (retrieval runtime; the embedding provider may
//       be process-shared, index/job state may not), §6 (the selected VaultRuntime arrives through
//       the request context), §3.4 (capabilities are runtime facts), §21 MV-I02/MV-I07,
//       §41 (secondary retrieval is built lazily, never on startup), §43-5, §47.
//
// Position in the chain:
//
//   vault-scope registrar  ->  request context { vaultId, vaultRuntime }  ->  this resolver
//
// This module is the one place that binds the process-independent collaborators (pure parsers, the
// read limit, retrieval tunables, the shared embedding provider) to the per-Vault B1 runtime that
// C's registrar selected. It owns exactly two things:
//
//   1. `searchRuntimeFor(vaultRuntime)` — the per-Vault cache. One composed search runtime per
//      materialized B1 runtime; built lazily on first use (§41 "no eager retrieval build for
//      every Vault on startup"), released with its B1 instance because the cache is a WeakMap
//      keyed by the instance (no id-keyed inventory, no leak after a runtime-map refresh). The
//      registry holds *references*, never Vault state: the index cache/generation/build tail and
//      the retrieval state/queue/job/timers all live inside the instances (§11/§12/§43-7), which
//      is the same shape the W0-A inventory records for `src/app/web-catalog/runtime.js`.
//   2. `resolveSearchRuntime()` — the handler-side resolver. It reads the *selected* Vault from
//      the request context and never guesses: a request with a secondary selection but no
//      materialized runtime is refused structurally (`vault_retrieval_unavailable`) instead of
//      being served by the primary index (SEC-MV06 / §47). A call with no Vault selection at all
//      (direct in-process registration, e.g. `registerSearchTools(server)`) keeps the legacy
//      primary semantics of §21 MV-I07.
//
// The primary Vault deliberately reuses the process's existing index/retrieval instances
// (`src/vault-index.js` / `src/retrieval.js`), so legacy callers and the primary facade keep one
// identity and one state; a secondary Vault gets its own composed instance.

import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_INDEX_CONCURRENCY,
  MAX_READ_BYTES,
  RETRIEVAL_AUTO_EMBED,
  RETRIEVAL_CHUNK_OVERLAP,
  RETRIEVAL_CHUNK_SIZE,
  RETRIEVAL_REFRESH_DEBOUNCE_MS,
} from "./config.js";
import { embedTexts, semanticConfiguration } from "./embeddings.js";
import { allTagsForNote, documentMap, extractLinks, parseFrontmatter } from "./obsidian.js";
import { requestContext } from "./request-context.js";
import { primaryRetrievalRuntime } from "./retrieval.js";
import { primaryRuntime } from "./vault.js";
import { bindPrimaryAuthorization, releasePrimaryAuthorization } from "./vault-runtime/primary-authorization.js";
import { createLeasedRuntime, guardedRuntimeOf, isHandleCurrent, leaseOfHandle } from "./vault-runtime/runtime-lease.js";
import { primaryIndexRuntime } from "./vault-index.js";
import { createVaultSearchRuntime } from "./vault-runtime/search-runtime.js";

/** Stable refusal code for a Vault selection this process has no search runtime for. */
export const SEARCH_RUNTIME_REFUSED = "vault_retrieval_unavailable";
/** Stable code for a malformed resolver input (never matched on prose). */
export const SEARCH_RUNTIME_INVALID = "vault_retrieval_runtime_invalid";

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

/** Structured refusal carrying the Vault the caller itself asked for (never inventory facts). */
function refuse(vaultId, detail) {
  throw Object.assign(new Error(`[${SEARCH_RUNTIME_REFUSED}] ${detail}`), { code: SEARCH_RUNTIME_REFUSED, vaultId });
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return `${typeof value} ${String(value)}`;
}

// The process-independent collaborators every Vault shares (§12: the embedding provider is one
// process client; the tunables and the read limit are process constants). The *reader* is not
// shared: the composer builds a Vault-bound reader from each Vault's own `localFs`, because the
// primary compatibility reader is rooted at the primary Vault and would refuse secondary paths.
const SHARED_DEPS = Object.freeze({
  parseFrontmatter,
  documentMap,
  extractLinks,
  allTagsForNote,
  maxReadBytes: MAX_READ_BYTES,
  retrievalConfig: Object.freeze({
    chunkSize: RETRIEVAL_CHUNK_SIZE,
    overlap: RETRIEVAL_CHUNK_OVERLAP,
    autoEmbed: RETRIEVAL_AUTO_EMBED,
    refreshDebounceMs: RETRIEVAL_REFRESH_DEBOUNCE_MS,
    embeddingBatchSize: EMBEDDING_BATCH_SIZE,
    embeddingIndexConcurrency: EMBEDDING_INDEX_CONCURRENCY,
  }),
  embeddingProvider: Object.freeze({ embedTexts, semanticConfiguration }),
  log: console,
});

// The primary Vault's search runtime is the process's existing index/retrieval instances, so an
// omitted `vaultId` keeps byte-identical legacy behaviour (§21 MV-I07).
const PRIMARY_SEARCH_RUNTIME = createVaultSearchRuntime({
  vaultRuntime: primaryRuntime,
  index: primaryIndexRuntime,
  retrieval: primaryRetrievalRuntime,
});

const SECONDARY_RUNTIMES = new WeakMap();
// W2FIX5 R2: the per-generation facade over the process-shared primary search runtime, cached by the
// consumer handle so an old handle keeps its old (dead) facade and never inherits a re-approval.
const PRIMARY_FACADES = new WeakMap();

/**
 * The search runtime for one B1 Vault runtime. The primary returns the process instance (a raw handle)
 * or, for a LEASED primary handle, a per-generation facade; any other Vault gets (at most) one lazily
 * built instance, cached by runtime identity so a runtime released by D0's map cannot be served again.
 */
export function searchRuntimeFor(vaultRuntime) {
  // W2FIX3 item 4: the primary reaches consumers through a lease-guarded facade that reuses the SAME
  // underlying process instance, so unwrap it before the legacy identity check.
  if (vaultRuntime === primaryRuntime || guardedRuntimeOf(vaultRuntime) === primaryRuntime) {
    const lease = leaseOfHandle(vaultRuntime);
    if (lease === null) return PRIMARY_SEARCH_RUNTIME;
    // W2FIX5 R2: bind the process-shared primary's index/retrieval (and every already-armed callback)
    // to THIS handle's generation — idempotently, so a repeat resolve of a current handle keeps the
    // live timer valid — and hand out a fixed-generation facade instead of the raw singleton.
    bindPrimaryAuthorization(lease, () => isHandleCurrent(vaultRuntime));
    let facade = PRIMARY_FACADES.get(vaultRuntime);
    if (facade === undefined) {
      facade = createLeasedRuntime(PRIMARY_SEARCH_RUNTIME, lease, () => isHandleCurrent(vaultRuntime));
      PRIMARY_FACADES.set(vaultRuntime, facade);
    }
    return facade;
  }
  if (vaultRuntime === null || typeof vaultRuntime !== "object" || Array.isArray(vaultRuntime) || typeof vaultRuntime.id !== "string" || vaultRuntime.id === "") {
    fail(SEARCH_RUNTIME_INVALID, `searchRuntimeFor expects a materialized VaultRuntime, got ${describe(vaultRuntime)}`);
  }
  let runtime = SECONDARY_RUNTIMES.get(vaultRuntime);
  if (runtime === undefined) {
    runtime = createVaultSearchRuntime({ vaultRuntime, deps: SHARED_DEPS });
    SECONDARY_RUNTIMES.set(vaultRuntime, runtime);
  }
  return runtime;
}

/**
 * The search runtime selected by the ambient request context (§6).
 *
 *   * no context at all  -> the primary runtime (no Vault was selected; legacy semantics);
 *   * a selected Vault   -> that Vault's runtime, or a structured refusal when this process has
 *                           no materialized runtime for it. A secondary selection is *never*
 *                           served by the primary index (SEC-MV06 / §47).
 */
export function resolveSearchRuntime() {
  const context = requestContext();
  if (context === undefined) return PRIMARY_SEARCH_RUNTIME;
  const { vaultRuntime, vaultId } = context;
  if (vaultRuntime !== undefined && vaultRuntime !== null) {
    if (typeof vaultRuntime.id !== "string" || vaultRuntime.id === "") {
      fail(SEARCH_RUNTIME_INVALID, `the request context carries a malformed vaultRuntime (${describe(vaultRuntime?.id)}); refusing instead of guessing a Vault`);
    }
    return searchRuntimeFor(vaultRuntime);
  }
  if (vaultId === undefined || vaultId === null || vaultId === primaryRuntime.id) return PRIMARY_SEARCH_RUNTIME;
  refuse(
    vaultId,
    `Vault ${describe(vaultId)} was selected but no search runtime is materialized for it; retrieval never falls back to another Vault's index (SEC-MV06)`,
  );
}

/**
 * MCP-shaped structured refusal for `SEARCH_RUNTIME_REFUSED` (mirrors the vault-scope
 * registrar's `vault_unavailable` payload), or `null` for any other error so a tool handler can
 * write `return refusalForError(error) ?? err(error)`.
 */
export function refusalForError(error) {
  if (error?.code !== SEARCH_RUNTIME_REFUSED) return null;
  const payload = { code: error.code };
  if (typeof error.vaultId === "string") payload.vaultId = error.vaultId;
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { ...payload },
    isError: true,
  };
}

/**
 * Release one cached secondary instance (ops/tests): quiesce its retrieval timer and queue, then
 * forget it. A LEASED primary handle that was never cached (never called searchRuntimeFor) is still
 * released: the lease proves it's a managed handle from the map. A raw primary B1 VaultRuntime (no
 * lease, never from the map) returns false: the primary instance belongs to the process, never
 * released through this registry.
 */
export function releaseSearchRuntime(vaultRuntime) {
  // W2FIX5 R2: the process-shared primary is cached under its consumer handle too, so a durable
  // revoke must (a) latch the primary authorization as refusing and (b) quiesce the shared retrieval
  // timer. With the authorization released, `drain` CANCELS the pending debounce instead of promoting
  // it into a fresh index write.
  const lease = leaseOfHandle(vaultRuntime);
  if (lease !== null && guardedRuntimeOf(vaultRuntime) === primaryRuntime) {
    releasePrimaryAuthorization(lease);
    PRIMARY_FACADES.delete(vaultRuntime);
    PRIMARY_SEARCH_RUNTIME.retrieval.drainRetrievalIndex();
    return true;
  }
  // If this is a LEASED primary handle (from the map) that was never cached, drain the primary runtime.
  // A raw primary runtime (no lease) returns false because it belongs to the process.
  if (lease !== null && vaultRuntime?.primary === true && vaultRuntime?.id === primaryRuntime?.id) {
    releasePrimaryAuthorization(lease);
    PRIMARY_SEARCH_RUNTIME.retrieval.drainRetrievalIndex();
    return true;
  }
  const runtime = SECONDARY_RUNTIMES.get(vaultRuntime);
  if (runtime === undefined) return false;
  SECONDARY_RUNTIMES.delete(vaultRuntime);
  runtime.drain();
  return true;
}
