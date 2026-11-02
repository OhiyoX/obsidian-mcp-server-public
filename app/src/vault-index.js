// `src/vault-index.js` — transitional compatibility facade for the per-Vault VaultIndex
// runtime (contract §11 "Vault index runtime", §10.1 "Transitional compatibility facade",
// §43-5 facade allowlist; brief B2 §1.2).
//
// The implementation and every piece of its state moved to
// `src/vault-runtime/vault-index-runtime.js`, instantiated once here for the legacy primary
// Vault. Every export below keeps its exact previous name, signature and behavior, so callers
// (`retrieval.js`, `context-service.js`, `tools/**`, `app/**`, `related-notes.js`) are
// unchanged — that is this lane's acceptance criterion.
//
// This module is the §43-5 allowlisted facade: it is the only module that binds an index
// runtime to the process-global read limit (`MAX_READ_BYTES`) and to the primary Vault's note
// reader. It is not called by a background task without an explicit runtime (contract §10.1):
// lane B2 wires no second Vault and no background consumer.

import { MAX_READ_BYTES } from "./config.js";
import { allTagsForNote, documentMap, extractLinks, readNote } from "./obsidian.js";
import { primaryRuntime } from "./vault.js";
import { createLinkResolver, createVaultIndexRuntime } from "./vault-runtime/vault-index-runtime.js";

// Root-free helper, kept as a facade export with the identity it always had.
export { createLinkResolver };

// Legacy retrieval-refresh side effect: the index never imports the retrieval module
// statically (that would be a cycle), so the debounced refresh is scheduled dynamically,
// exactly as before. Lane B3 replaces this with the primary retrieval runtime's scheduler.
function scheduleRetrievalRefresh() {
  import("./retrieval.js").then(({ scheduleRetrievalRefresh: schedule }) => schedule()).catch((error) => {
    console.error("Automatic retrieval refresh failed:", error.message);
  });
}

// The one primary index runtime for this process. Its deps are the primary Vault's
// Vault-bound reader plus the process-wide read limit; the cache, generation,
// publicationRevision, snapshot identity, build tail and stats belong to this instance and
// never to a module global (contract §11, §43-7).
export const primaryIndexRuntime = createVaultIndexRuntime({
  vaultRuntime: primaryRuntime,
  // The reader is bound to *this* runtime explicitly: `obsidian.readNote` follows the request's
  // VaultRuntime by default (Wave D / D-files), and the primary index must never follow the ambient
  // Vault selection into another Vault's root (§11/§43-12).
  deps: { maxReadBytes: MAX_READ_BYTES, readNote: (absPath, options) => readNote(absPath, { ...options, localFs: primaryRuntime.localFs }), documentMap, extractLinks, allTagsForNote, scheduleRetrievalRefresh },
});

// Delegating wrappers keep the pre-facade export names and declared arities (frozen by
// `test/vault-index-runtime.test.js`) while the state lives on `primaryIndexRuntime`.
// `invalidateVaultIndex` stays the single public invalidation name so the frozen source map in
// `test/hot-routes-mutation-invalidation-map.test.js` keeps describing real callers.
export function getVaultIndex(options = {}) {
  return primaryIndexRuntime.getVaultIndex(options);
}

export function getCachedVaultIndex() {
  return primaryIndexRuntime.getCachedVaultIndex();
}

export function getVaultIndexStats() {
  return primaryIndexRuntime.getVaultIndexStats();
}

export function invalidateVaultIndex(paths) {
  return primaryIndexRuntime.invalidate(paths);
}
