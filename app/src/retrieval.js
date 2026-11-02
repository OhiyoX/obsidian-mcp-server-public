// `src/retrieval.js` — transitional compatibility facade (contract §10.1
// "Transitional compatibility facade", §12 "Retrieval runtime", §43-5 facade allowlist).
//
// The retrieval state machine moved to `vault-runtime/retrieval-runtime.js`: one instance
// per Vault, with its index state / operation queue / build job / refresh timer owned by
// that instance's closure instead of this module (contract §12, §43-7; W0-A doc §4.3).
//
// Every legacy export below keeps its exact previous name, signature and behavior by
// being the primary instance's own function, so no existing caller changes:
// `tools/intelligence.js`, `search/hybrid-search.js`, `related-notes.js`,
// `context-service.js`, `app/web-catalog/search-api.js`, `scripts/search-v2-baseline.mjs`
// and the retrieval/search test suites.
//
// This module is the §43-5 allowlisted facade: it reads `config.js` tunables, and the
// primary index path comes from `vault.js`'s A7 primary mapping
// (`primaryRuntime.paths.retrievalIndex`, i.e. the legacy `RETRIEVAL_INDEX_PATH`
// passed through untouched) — never from a second, independently derived path.

import {
  VAULT_DISCOVERY_ENABLED, VAULT_ADMISSIONS_PATH, VAULT_ADMISSION_ENROLLMENT_PATH,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_INDEX_CONCURRENCY,
  RETRIEVAL_AUTO_EMBED,
  RETRIEVAL_CHUNK_OVERLAP,
  RETRIEVAL_CHUNK_SIZE,
  RETRIEVAL_REFRESH_DEBOUNCE_MS,
} from "./config.js";
import { embedTexts, semanticConfiguration, semanticHealth } from "./embeddings.js";
import { getVaultIndex } from "./vault-index.js";
import { bootstrapPrimaryAuthorization } from "./vault-runtime/primary-bootstrap.js";
import { primaryAuthorizationToken, primaryAuthorized } from "./vault-runtime/primary-authorization.js";
import { primaryRuntime } from "./vault.js";
import { createRetrievalRuntime } from "./vault-runtime/retrieval-runtime.js";

await bootstrapPrimaryAuthorization({ automaticDiscovery: VAULT_DISCOVERY_ENABLED, file: VAULT_ADMISSIONS_PATH, enrollmentFile: VAULT_ADMISSION_ENROLLMENT_PATH });

// Process-shared collaborators (contract §12): the embedding provider stays one process
// client and is handed to the runtime by injection; the index content and the build-job
// state are not shared.
export { embedTexts, semanticConfiguration, semanticHealth };

// The one primary retrieval runtime for this process. `getVaultIndex` is the primary Vault's
// own index source; a secondary runtime must be given its own (lane B2/C wiring).
export const primaryRetrievalRuntime = createRetrievalRuntime({
  vaultRuntime: primaryRuntime,
  embeddingProvider: { embedTexts, semanticConfiguration },
  deps: {
    getVaultIndex,
    // W2FIX5 R2: the process-shared primary retrieval runtime re-checks the CURRENT primary consumer
    // handle on every new operation and on every already-armed refresh callback.
    authorization: { token: primaryAuthorizationToken, allowed: primaryAuthorized },
    retrievalConfig: {
      chunkSize: RETRIEVAL_CHUNK_SIZE,
      overlap: RETRIEVAL_CHUNK_OVERLAP,
      autoEmbed: RETRIEVAL_AUTO_EMBED,
      refreshDebounceMs: RETRIEVAL_REFRESH_DEBOUNCE_MS,
      embeddingBatchSize: EMBEDDING_BATCH_SIZE,
      embeddingIndexConcurrency: EMBEDDING_INDEX_CONCURRENCY,
    },
  },
});

// The legacy exports ARE the primary instance's methods (same function identity and arity),
// exactly like the B1 `vault.js` facade binds the `primaryRuntime.localFs` methods.
export const chunkMarkdown = primaryRetrievalRuntime.chunkMarkdown;
export const tokenize = primaryRetrievalRuntime.tokenize;
export const syncRetrievalIndex = primaryRetrievalRuntime.syncRetrievalIndex;
export const startRetrievalIndex = primaryRetrievalRuntime.startRetrievalIndex;
export const requestRetrievalRefresh = primaryRetrievalRuntime.requestRetrievalRefresh;
export const scheduleRetrievalRefresh = primaryRetrievalRuntime.scheduleRetrievalRefresh;
export const drainRetrievalIndex = primaryRetrievalRuntime.drainRetrievalIndex;
export const retrievalIndexStatus = primaryRetrievalRuntime.retrievalIndexStatus;
export const retrievalIndexStatusSnapshot = primaryRetrievalRuntime.retrievalIndexStatusSnapshot;
export const recall = primaryRetrievalRuntime.recall;
export const recallFromSnapshot = primaryRetrievalRuntime.recallFromSnapshot;
