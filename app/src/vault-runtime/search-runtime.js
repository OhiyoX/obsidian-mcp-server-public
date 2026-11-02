// Wave D / D-search — per-Vault search runtime: one VaultIndex runtime + one retrieval runtime
// bound to exactly one B1 `VaultRuntime`.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §11 Vault index runtime — note cache / generation / publicationRevision / snapshot identity /
//        build tail / stats become instance state; any invalidation carries the runtime;
//   §12 Retrieval runtime — state / loading / operationQueue / activeIndexJob / refresh timers /
//        lastRefreshAt become instance state; the index file uses *this* runtime's data path; the
//        embedding provider may be process-shared while index content and build-job state are
//        not; a disabled capability returns a structured unavailable and never falls back to
//        another Vault's index;
//   §29 Wave D search lane — materialize real per-Vault instances; never invent a second Vault
//        selector; no lane may assume the shared foundation made every toolset per-Vault;
//   §3.4 capabilities are runtime facts (flip only the keys actually wired);
//   §5.3 no ambient worker state · §21 MV-I01/I02 · §40 · §43-5 · §43-7.
//
// Position: this module owns exactly one thing — the composition of B2's `createVaultIndexRuntime`
// and B3's `createRetrievalRuntime` for a single Vault. It is a *pure composition seam*:
//
//   * no `config.js` import, no `process.env` read, no AsyncLocalStorage and no module-level
//     mutable state (§5.3/§43-5/§43-7). The pure parse helpers, the read limit, the retrieval
//     tunables and the process-shared embedding provider are explicit inputs, so a Vault-bound
//     reader can never be an ambient fallback;
//   * the Vault-bound note reader is built from *this* Vault's `localFs` (`readLimitedText` /
//     `toVaultPath` / `fileRevision`), because the primary compatibility reader
//     (`src/obsidian.js#readNote`) is rooted at the primary Vault and would refuse every
//     secondary path (B2's `boundDeps` test seam is the same construction). A caller may inject
//     its own `deps.readNote` instead;
//   * every instance is bound to `vaultRuntime` and validated back against it (SEC-MV06): an
//     injected index/retrieval instance whose `vaultId` differs from this Vault is refused
//     instead of published, exactly like D0's runtime map refuses a cross-Vault runtime;
//   * the retrieval runtime is given this Vault's index as its *only* index source
//     (`deps.getVaultIndex`) — which is what makes the flipped `retrieval` capability honest —
//     and the index runtime schedules its refreshes against *this* Vault's retrieval runtime, so
//     an index invalidation can only ever move this Vault's retrieval job;
//   * capabilities stay runtime facts: the merged map copies the B1 runtime's map and replaces
//     `retrieval` / `semantic` with this composition's own facts. `retrieval` becomes available
//     because this Vault's index really is wired as its index source; `semantic` stays
//     unavailable-with-reason whenever the shared provider is disabled (`degrade ≠ catch`).
//
// The per-process cache of these instances (one per materialized Vault, lazily built) lives in
// the wiring module `src/search-runtimes.js`; this module never caches anything.

import fs from "node:fs/promises";
import { mayScheduleWork } from "./runtime-lease.js";
import { createVaultIndexRuntime } from "./vault-index-runtime.js";
import { createRetrievalRuntime } from "./retrieval-runtime.js";

/** Stable machine-readable failure code; consumers/tests never match on prose. */
export const VAULT_SEARCH_RUNTIME_INVALID = "VAULT_SEARCH_RUNTIME_INVALID";

// The pure parse helpers (plus the injected read limit) are mandatory when this composer builds
// the instances: an index must never fall back to an ambient reader or parser (§5.3).
const REQUIRED_INDEX_DEPS = Object.freeze(["parseFrontmatter", "documentMap", "extractLinks", "allTagsForNote"]);

/**
 * Build the Vault-bound note reader the index runtime consumes. `localFs` is this Vault's own
 * filesystem service, so the reader can only ever touch this Vault's root (SEC-MV01) and reports
 * this Vault's relative path. The body mirrors the primary compatibility reader
 * (`src/obsidian.js#readNote`) exactly, including its parser-only malformed-frontmatter
 * degradation: a read/stat/revision failure still propagates and is never mistaken for bad YAML.
 */
function createVaultNoteReader(localFs, parseFrontmatter) {
  return async function readNote(absPath, options = {}) {
    const raw = await localFs.readLimitedText(absPath);
    const stat = await fs.stat(absPath);
    let parsed;
    try {
      parsed = parseFrontmatter(raw);
    } catch (error) {
      if (!options.tolerateMalformedFrontmatter) throw error;
      parsed = { data: {}, content: raw };
    }
    return {
      path: localFs.toVaultPath(absPath),
      raw,
      content: parsed.content,
      frontmatter: parsed.data,
      revision: await localFs.fileRevision(absPath),
      stat: { size: stat.size, created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString() },
    };
  };
}

function fail(detail) {
  throw Object.assign(new Error(`[${VAULT_SEARCH_RUNTIME_INVALID}] ${detail}`), { code: VAULT_SEARCH_RUNTIME_INVALID });
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return `${typeof value} ${String(value)}`;
}

function assertVaultRuntime(vaultRuntime) {
  if (vaultRuntime === null || typeof vaultRuntime !== "object" || Array.isArray(vaultRuntime)) {
    fail(`vaultRuntime must be a B1 createVaultRuntime result, got ${describe(vaultRuntime)}`);
  }
  if (typeof vaultRuntime.id !== "string" || vaultRuntime.id === "") fail(`vaultRuntime.id must be a non-empty string, got ${describe(vaultRuntime.id)}`);
  if (typeof vaultRuntime.root !== "string" || vaultRuntime.root === "" || vaultRuntime.localFs === null || typeof vaultRuntime.localFs !== "object") {
    fail("vaultRuntime must carry a root and a localFs service");
  }
  if (vaultRuntime.capabilities === null || typeof vaultRuntime.capabilities !== "object" || Array.isArray(vaultRuntime.capabilities)) {
    fail(`vaultRuntime.capabilities must be the B1 capability map, got ${describe(vaultRuntime.capabilities)} (contract §3.4)`);
  }
}

/**
 * `createVaultSearchRuntime({ vaultRuntime, index?, retrieval?, deps? })`
 *
 *   vaultRuntime — the B1 instance this search runtime belongs to (its id / root / localFs / A7
 *                  paths). Required.
 *   index        — optional pre-built index runtime (the primary Vault reuses the process's
 *                  existing `src/vault-index.js` instance). Its `vaultId` must match.
 *   retrieval    — optional pre-built retrieval runtime (the primary Vault reuses
 *                  `src/retrieval.js`). Its `vaultId` must match.
 *   deps         — required when `index`/`retrieval` are omitted: `parseFrontmatter`, `documentMap`,
 *                  `extractLinks`, `allTagsForNote`, `maxReadBytes`, plus optional `readNote`
 *                  (a caller-supplied Vault-bound reader), `retrievalConfig`, `embeddingProvider`
 *                  and `log`.
 *
 * Returns a frozen `{ vaultRuntime, vaultId, root, primary, index, retrieval, capability,
 * semanticCapability, capabilities, drain }`.
 */
export function createVaultSearchRuntime(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail(`createVaultSearchRuntime expects an input object, got ${describe(input)}`);

  const { vaultRuntime } = input;
  assertVaultRuntime(vaultRuntime);

  let indexRuntime = input.index;
  let retrievalRuntime = input.retrieval;

  // Instances are injected as a pair (the primary Vault reuses both process instances) or not at
  // all. A half-injected pair would silently discard the caller's instance, so it is refused.
  if ((indexRuntime === undefined) !== (retrievalRuntime === undefined)) {
    fail(`index and retrieval must be injected together or omitted together (got index=${describe(indexRuntime)}, retrieval=${describe(retrievalRuntime)})`);
  }

  if (indexRuntime === undefined) {
    const deps = input.deps === undefined ? {} : input.deps;
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) fail(`deps must be an object when provided, got ${describe(deps)}`);
    const missing = REQUIRED_INDEX_DEPS.filter((name) => typeof deps[name] !== "function");
    if (missing.length > 0) fail(`deps must inject a Vault-bound function for: ${missing.join(", ")} (no ambient reader fallback)`);
    if (!Number.isInteger(deps.maxReadBytes) || deps.maxReadBytes <= 0) fail(`deps.maxReadBytes must be a positive integer, got ${describe(deps.maxReadBytes)}`);
    if (deps.readNote !== undefined && typeof deps.readNote !== "function") fail(`deps.readNote must be a Vault-bound function when provided, got ${describe(deps.readNote)}`);
    // §43-5 / SEC-MV01: the reader is bound to this Vault's localFs, never to the process root.
    const readNote = deps.readNote ?? createVaultNoteReader(vaultRuntime.localFs, deps.parseFrontmatter);

    // `indexRef` / `retrievalRef` close the index ⇄ retrieval cycle (retrieval reads this Vault's
    // index; the index schedules this Vault's retrieval refresh) without either instance ever
    // reaching for an ambient default or another Vault (§12, SEC-MV06).
    let indexRef;
    let retrievalRef;
    retrievalRuntime = createRetrievalRuntime({
      vaultRuntime,
      embeddingProvider: deps.embeddingProvider === undefined ? null : deps.embeddingProvider,
      deps: {
        getVaultIndex: (options) => indexRef.getVaultIndex(options),
        retrievalConfig: deps.retrievalConfig,
        log: deps.log,
      },
    });
    retrievalRef = retrievalRuntime;
    indexRuntime = createVaultIndexRuntime({
      vaultRuntime,
      deps: {
        readNote,
        documentMap: deps.documentMap,
        extractLinks: deps.extractLinks,
        allTagsForNote: deps.allTagsForNote,
        maxReadBytes: deps.maxReadBytes,
        // W2FIX3 item 5: the index runtime is the one place that can re-arm a background retrieval
        // refresh, so it re-checks the consumer handle's lease on EVERY arm. For a raw/shared handle
        // (the primary process instance, tests) this is a no-op; for a revoked facade it refuses to
        // schedule, so a timer can never be resurrected after `revoke`/`drain`.
        scheduleRetrievalRefresh: () => (mayScheduleWork(vaultRuntime) ? retrievalRef.scheduleRetrievalRefresh() : undefined),
      },
    });
    indexRef = indexRuntime;
  }

  // SEC-MV06 / §47 "secondary error fallback primary": an injected instance must be an instance
  // of *this* Vault. Anything else is refused instead of published.
  if (indexRuntime.vaultId !== vaultRuntime.id) {
    fail(`an injected index runtime must belong to Vault ${describe(vaultRuntime.id)}, got ${describe(indexRuntime.vaultId)} — never substitute another Vault's index`);
  }
  if (retrievalRuntime.vaultId !== vaultRuntime.id) {
    fail(`an injected retrieval runtime must belong to Vault ${describe(vaultRuntime.id)}, got ${describe(retrievalRuntime.vaultId)} — never substitute another Vault's retrieval`);
  }

  // §3.4: the composition's own capability facts. `retrieval` is genuinely available because the
  // index source above is this Vault's own index; `semantic` is the shared provider's fact and
  // keeps its explicit reason when disabled.
  const capability = retrievalRuntime.capability;
  const semanticCapability = retrievalRuntime.semanticCapability();
  const capabilities = Object.freeze({ ...vaultRuntime.capabilities, retrieval: capability, semantic: semanticCapability });

  return Object.freeze({
    vaultRuntime,
    vaultId: vaultRuntime.id,
    root: vaultRuntime.root,
    primary: vaultRuntime.primary === true,
    index: indexRuntime,
    retrieval: retrievalRuntime,
    capability,
    semanticCapability,
    capabilities,
    // Lifecycle barrier for teardown/tests: promote this Vault's pending debounced refresh into
    // the queued write its timer would have made, then resolve when its timer slot and operation
    // queue are both quiescent. Draining A never drains B (per-Vault queues, §12).
    drain: () => retrievalRuntime.drainRetrievalIndex(),
  });
}
