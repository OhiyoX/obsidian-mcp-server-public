// `src/vault-runtime/vault-index-runtime.js` — per-Vault VaultIndex runtime.
//
// Contract: "DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置"
//   §11  Vault index runtime — `createVaultIndexRuntime({ vaultRuntime, ...deps })`; note cache,
//        generation, publicationRevision, snapshot generation, build tail and stats are per Vault;
//        any invalidation must carry/bind the VaultRuntime; A's invalidation must not move B's
//        generation/publicationRevision.
//   §5.3 no ambient state  · §43-7 index runtime state must not live in a module global.
//   §43-5 a new Vault-dependent module must not import the global
//        VAULT / DATA_PATH / TRASH_PATH / HISTORY_PATH / RETRIEVAL_INDEX_PATH constants.
//
// The state that used to be module-level in `src/vault-index.js` (note cache, generation,
// publicationRevision, snapshotGeneration, snapshotIdentity, buildTail, lastRefresh, lastStats,
// indexBuilt) now lives in the closure of `createVaultIndexRuntime`. Every build/refresh/
// invalidation entry point is a method of exactly one instance, and every in-flight build closes
// over its own instance instead of reading a process global — so an invalidation can only ever
// move the generation of the Vault it was bound to.
//
// Purity constraints (brief B2 §1.3-4, contract §5.3/§43-5):
//   * no module-level mutable state: every `let` / Map below is declared inside the factory;
//   * no `config.js` import, no `process.env` read, no AsyncLocalStorage/request-context: the
//     read limit, the note reader and the parse helpers are injected by the caller;
//   * vault-bound IO comes from `vaultRuntime.localFs` (`allMarkdownFiles` / `toVaultPath`) and
//     from the injected per-Vault reader, so nothing resolves against a global root.
// The compatibility facade `src/vault-index.js` is the only module that binds these deps to the
// primary Vault today; lane B3 / Wave C bind their own per-Vault instances the same way.

import fs from "node:fs/promises";
import path from "node:path";
import { normalizeVaultInput, stripMarkdownExtension } from "./local-fs.js";
import { createLinkResolver, normalizeAliases } from "./vault-index-links.js";

// The pure record projection helpers live in `./vault-index-links.js`; the facade re-exports
// this name with the same function identity it had before the split.
export { createLinkResolver };

// Stable failure code for a mis-wired instance (never matches on prose).
export const VAULT_INDEX_RUNTIME_INVALID = "VAULT_INDEX_RUNTIME_INVALID";

// A conflict discards the attempt and retries once, so a single call performs at most two full
// builds. Exhaustion is a stable, identifiable failure.
const MAX_BUILD_ATTEMPTS = 2;
const FENCE_CONFLICT_CODE = "VAULT_INDEX_FENCE_CONFLICT";

// `readLimitedText` reports an oversized file as a plain Error whose message starts with this
// prefix. Only that explicit condition is treated as a per-file skip; a permission or unknown
// read failure must still propagate.
const SIZE_LIMIT_ERROR = /^File exceeds MAX_READ_BYTES \(/;

// A per-Vault index must never fall back to an ambient reader or an ambient read limit
// (contract §5.3), so these deps are mandatory and validated at construction time.
const REQUIRED_FUNCTION_DEPS = Object.freeze(["readNote", "documentMap", "extractLinks", "allTagsForNote"]);
const OPTIONAL_FUNCTION_DEPS = Object.freeze(["allMarkdownFiles", "toVaultPath", "scheduleRetrievalRefresh"]);

function fail(detail) {
  throw Object.assign(new Error(`[${VAULT_INDEX_RUNTIME_INVALID}] ${detail}`), { code: VAULT_INDEX_RUNTIME_INVALID });
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function emptyStats() {
  return { files: 0, reparsed: 0, reused: 0, removed: 0, skipped: 0, durationMs: 0 };
}

function isKnownSizeLimitError(error) {
  return SIZE_LIMIT_ERROR.test(String(error?.message ?? ""));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the frozen, per-Vault VaultIndex runtime (contract §11).
 *
 * `vaultRuntime` is the instance this index belongs to (its `id`/`root`/`localFs`); `deps`
 * must supply a Vault-bound `readNote` plus the pure parse helpers, and the injected read
 * limit. Missing or mistyped deps throw `VAULT_INDEX_RUNTIME_INVALID` — never a silent
 * ambient fallback.
 *
 * @param {{ vaultRuntime: object, deps?: object }} input
 */
export function createVaultIndexRuntime({ vaultRuntime, deps } = {}) {
  if (vaultRuntime === null || typeof vaultRuntime !== "object" || Array.isArray(vaultRuntime)) {
    fail(`vaultRuntime must be a VaultRuntime (createVaultRuntime result), got ${describe(vaultRuntime)}`);
  }
  if (typeof vaultRuntime.id !== "string" || vaultRuntime.id === "") {
    fail(`vaultRuntime.id must be a non-empty string, got ${describe(vaultRuntime.id)}`);
  }
  const { localFs } = vaultRuntime;
  if (typeof vaultRuntime.root !== "string" || vaultRuntime.root === "" || localFs === null || typeof localFs !== "object") {
    fail("vaultRuntime must carry a root and a localFs service");
  }
  if (deps !== undefined && (deps === null || typeof deps !== "object" || Array.isArray(deps))) {
    fail(`deps must be an object when provided, got ${describe(deps)}`);
  }
  const supplied = deps ?? {};

  const missing = REQUIRED_FUNCTION_DEPS.filter((name) => typeof supplied[name] !== "function");
  if (missing.length > 0) {
    fail(`deps must inject a Vault-bound function for: ${missing.join(", ")} (no ambient reader fallback)`);
  }
  if (!Number.isInteger(supplied.maxReadBytes) || supplied.maxReadBytes <= 0) {
    fail(`deps.maxReadBytes must be a positive integer, got ${describe(supplied.maxReadBytes)}`);
  }

  // Vault-bound defaults come from this instance's own service, never from a process root.
  const allMarkdownFiles = supplied.allMarkdownFiles ?? localFs.allMarkdownFiles;
  const toVaultPath = supplied.toVaultPath ?? localFs.toVaultPath;
  const scheduleRetrievalRefresh = supplied.scheduleRetrievalRefresh ?? (() => {});
  for (const [name, value] of [["allMarkdownFiles", allMarkdownFiles], ["toVaultPath", toVaultPath], ["scheduleRetrievalRefresh", scheduleRetrievalRefresh]]) {
    if (typeof value !== "function") fail(`deps.${name} must be a function, got ${describe(value)}`);
  }
  for (const name of OPTIONAL_FUNCTION_DEPS) {
    if (supplied[name] !== undefined && typeof supplied[name] !== "function") fail(`deps.${name} must be a function, got ${describe(supplied[name])}`);
  }

  const maxReadBytes = supplied.maxReadBytes;
  const readNote = supplied.readNote;
  const documentMap = supplied.documentMap;
  const extractLinks = supplied.extractLinks;
  const allTagsForNote = supplied.allTagsForNote;

  // -------------------------------------------------------------------------
  // Instance state (previously module-level in src/vault-index.js, contract §11)
  // -------------------------------------------------------------------------
  const noteCache = new Map();
  let lastRefresh = null;
  let indexBuilt = false;
  let lastStats = emptyStats();

  // Process-local freshness bookkeeping. `vaultGeneration` is the logical Vault
  // generation and the build fence token; `publicationRevision` counts successful
  // atomic publications; `snapshotGeneration` is the generation the currently
  // published snapshot was built against; `snapshotIdentity` is the declared
  // coverage identity (`includeHidden`) of that snapshot. All four reset to their
  // zero/null state on process restart; none is persisted and none may be
  // compared across processes. Freshness is always derived, never tracked
  // separately:
  //   cold  -> no published snapshot (`indexBuilt === false`)
  //   clean -> snapshotGeneration === vaultGeneration
  //   dirty -> a snapshot exists but snapshotGeneration !== vaultGeneration
  let vaultGeneration = 0;
  let publicationRevision = 0;
  let snapshotGeneration = null;
  let snapshotIdentity = null;

  // Every actual build is serialized through this instance's own promise tail. The
  // tail always settles, so a rejected build cannot poison the queue, and
  // force/options can never open a second build lane. Two instances never share it.
  let buildTail = Promise.resolve();

  function withBuildLock(task) {
    const run = buildTail.then(task, task);
    buildTail = run.then(() => {}, () => {});
    return run;
  }

  function currentFreshness() {
    if (!indexBuilt) return "cold";
    return snapshotGeneration === vaultGeneration ? "clean" : "dirty";
  }

  function currentCoverage() {
    if (!indexBuilt) return null;
    return {
      includeHidden: snapshotIdentity?.includeHidden === true,
      completeness: lastStats.skipped > 0 ? "partial" : "complete",
      skipped: lastStats.skipped,
    };
  }

  // Additive read-time stats. The existing `lastStats` count/timing fields still
  // describe the most recent successful publication; generation/freshness are
  // synthesized from current state so a dirty snapshot is never misreported as
  // clean and a failed attempt never overwrites the last successful counters.
  function indexIdentityStats() {
    return {
      vaultGeneration,
      snapshotGeneration,
      publicationRevision,
      freshness: currentFreshness(),
      coverage: currentCoverage(),
    };
  }

  function captureBaseline() {
    const records = new Map();
    for (const entry of noteCache.values()) records.set(entry.record.path, entry.record.revision);
    return {
      clean: indexBuilt && snapshotGeneration === vaultGeneration,
      identity: snapshotIdentity,
      records,
    };
  }

  function sameBaselineIdentity(baselineIdentity, identity) {
    return Boolean(baselineIdentity) && baselineIdentity.includeHidden === identity.includeHidden;
  }

  function baselineRecordsChanged(baselineRecords, nextCache) {
    if (baselineRecords.size !== nextCache.size) return true;
    for (const entry of nextCache.values()) {
      if (baselineRecords.get(entry.record.path) !== entry.record.revision) return true;
    }
    return false;
  }

  // On failure the previously published snapshot stays in memory. It is marked
  // dirty by bumping the generation only when it was clean; an already-dirty
  // generation is retained so repeated failures cannot manufacture fake content
  // generations. A cold index (no snapshot) stays cold.
  function markSnapshotDirty() {
    if (indexBuilt && snapshotGeneration === vaultGeneration) vaultGeneration += 1;
  }

  async function attemptBuild(options) {
    const includeHidden = Boolean(options.includeHidden);
    const identity = Object.freeze({ includeHidden });
    // The fence token must be captured before enumeration, so any invalidation
    // that lands while this build awaits is observed by the final recheck.
    const fenceGeneration = vaultGeneration;
    const baseline = captureBaseline();
    const started = Date.now();

    const files = await allMarkdownFiles({ includeHidden });
    const seen = new Set();
    // Build the next snapshot off to the side. A failed or fenced refresh must
    // never mutate the last successfully published cache observed by
    // getCachedVaultIndex().
    const nextCache = new Map(noteCache);
    let reparsed = 0;
    let reused = 0;
    let skipped = 0;

    for (const abs of files) {
      // The instance owns the vault-relative projection: the reader supplies
      // content/frontmatter/revision/stat for an absolute path, and this index
      // decides the path its own root implies.
      const vaultPath = toVaultPath(abs);
      seen.add(vaultPath);
      // Indexing opts into parser-only malformed-frontmatter degradation below.
      // Permission errors and other unexpected failures still propagate; only the
      // explicit size-limit condition is treated as a recoverable per-file skip.
      const stat = await fs.stat(abs);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      const cached = nextCache.get(vaultPath);
      if (!options.force && cached?.signature === signature) {
        reused += 1;
        continue;
      }
      if (stat.size > maxReadBytes) {
        // Proactive precise size gate: skip an oversized note without reading it.
        nextCache.delete(vaultPath);
        skipped += 1;
        continue;
      }
      let note;
      try {
        note = await readNote(abs, { tolerateMalformedFrontmatter: true });
      } catch (error) {
        // Malformed frontmatter has already been degraded inside readNote's
        // parser-only catch. If an error escapes here it is not a YAML parse
        // failure. Only a size race is skippable; EACCES/unknown IO still abort.
        if (!isKnownSizeLimitError(error)) throw error;
        nextCache.delete(vaultPath);
        skipped += 1;
        continue;
      }
      const projected = { ...note, path: vaultPath };
      const map = documentMap(projected);
      nextCache.set(vaultPath, {
        signature,
        record: {
          path: vaultPath,
          name: path.posix.basename(vaultPath),
          basename: stripMarkdownExtension(path.posix.basename(vaultPath)),
          aliases: normalizeAliases(projected.frontmatter),
          frontmatter: projected.frontmatter,
          tags: allTagsForNote(projected),
          content: projected.content,
          raw: projected.raw,
          revision: projected.revision,
          stat: projected.stat,
          headings: map.headings,
          blocks: map.blocks,
          links: extractLinks(projected.content, vaultPath),
        },
      });
      reparsed += 1;
    }

    let removed = 0;
    for (const cachedPath of nextCache.keys()) {
      if (!seen.has(cachedPath)) {
        nextCache.delete(cachedPath);
        removed += 1;
      }
    }

    let records = [...nextCache.values()].map((entry) => entry.record).sort((a, b) => a.path.localeCompare(b.path));
    const prefix = options.pathPrefix ? normalizeVaultInput(options.pathPrefix).replace(/\/$/, "") : "";
    if (prefix) records = records.filter((record) => record.path === prefix || record.path.startsWith(`${prefix}/`));
    const resolveLink = createLinkResolver([...nextCache.values()].map((entry) => entry.record));

    // From here to the end of the publish there is no await. A generation change
    // observed here means an invalidation landed during this build, so the whole
    // attempt is discarded and retried; the old snapshot is never overwritten by
    // a nextCache that predates the invalidation.
    if (vaultGeneration !== fenceGeneration) return null;

    // A clean, same-identity snapshot whose observed paths/revisions changed is
    // an externally observed content change: bump once, atomically with publish.
    // A dirty rebuild starts from an already-incremented generation and must not
    // add another content-change bump. A different includeHidden identity is not
    // a content change. This is an observed-refresh guarantee, not filesystem
    // snapshot isolation.
    if (baseline.clean && sameBaselineIdentity(baseline.identity, identity) && baselineRecordsChanged(baseline.records, nextCache)) {
      vaultGeneration += 1;
    }

    // Publish atomically only after every file has been processed successfully.
    noteCache.clear();
    for (const [cachedPath, entry] of nextCache) noteCache.set(cachedPath, entry);
    lastRefresh = new Date().toISOString();
    lastStats = { files: files.length, reparsed, reused, removed, skipped, durationMs: Date.now() - started };
    snapshotGeneration = vaultGeneration;
    snapshotIdentity = identity;
    indexBuilt = true;
    publicationRevision += 1;

    return {
      records,
      resolveLink,
      stats: { ...lastStats, lastRefresh, ...indexIdentityStats() },
    };
  }

  async function runBuild(options) {
    for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt += 1) {
      let result;
      try {
        result = await attemptBuild(options);
      } catch (error) {
        markSnapshotDirty();
        throw error;
      }
      if (result) return result;
    }
    markSnapshotDirty();
    const error = new Error("Vault index build conflicted with concurrent invalidations");
    error.code = FENCE_CONFLICT_CODE;
    throw error;
  }

  /** Every call, including force and pathPrefix projections, performs a real serialized refresh. */
  function getVaultIndex(options = {}) {
    return withBuildLock(() => runBuild(options));
  }

  // Read-only snapshot of the last successfully built index. Performs no
  // filesystem IO and returns null when the index has never been built (cold).
  // Callers that must not trigger a cold vault-wide build use this instead of
  // getVaultIndex.
  function getCachedVaultIndex() {
    if (!indexBuilt) return null;
    const records = [...noteCache.values()].map((entry) => entry.record).sort((a, b) => a.path.localeCompare(b.path));
    return {
      records,
      resolveLink: createLinkResolver(records),
      stats: { ...lastStats, lastRefresh, cached: true, ...indexIdentityStats() },
    };
  }

  /**
   * Runtime-bound invalidation (contract §11): the instance is the authority, so
   * this can only move this Vault's generation. `paths` (string | string[]) drops
   * those records and advances the generation once; `[]` is an index no-op with
   * the retrieval-refresh side effect kept; no argument invalidates everything.
   */
  function invalidate(paths) {
    if (!paths) {
      vaultGeneration += 1;
      noteCache.clear();
      indexBuilt = false;
      snapshotGeneration = null;
      snapshotIdentity = null;
      scheduleRetrievalRefresh();
      return;
    }
    const items = Array.isArray(paths) ? paths : [paths];
    // A non-empty invalidation, including paths absent from the cache, always
    // advances the generation once per call before returning so a concurrent
    // in-flight build cannot publish over it. `[]` is an index no-op that still
    // keeps the existing retrieval-refresh scheduling side effect.
    if (items.length > 0) {
      vaultGeneration += 1;
      for (const item of items) noteCache.delete(normalizeVaultInput(item));
    }
    scheduleRetrievalRefresh();
  }

  function getVaultIndexStats() {
    return { cachedNotes: noteCache.size, lastRefresh, ...lastStats, ...indexIdentityStats() };
  }

  return Object.freeze({
    // Identity of the Vault this index belongs to.
    vaultRuntime,
    vaultId: vaultRuntime.id,
    root: vaultRuntime.root,
    primary: vaultRuntime.primary === true,
    localFs,
    maxReadBytes,
    // Instance-exclusive state (contract §11). Read-only accessors: the runtime is frozen,
    // and only this instance's own methods may move these values.
    get noteCache() { return noteCache; },
    get generation() { return vaultGeneration; },
    get publicationRevision() { return publicationRevision; },
    get snapshotGeneration() { return snapshotGeneration; },
    get snapshotIdentity() { return snapshotIdentity; },
    get indexBuilt() { return indexBuilt; },
    get lastRefresh() { return lastRefresh; },
    get lastStats() { return { ...lastStats }; },
    get buildTail() { return buildTail; },
    // Entry points. `invalidate` is the runtime-bound twin of the facade's
    // `invalidateVaultIndex`: the public facade name stays the single "caller name" in the
    // source map (`test/hot-routes-mutation-invalidation-map.test.js`), while the state it
    // moves is this instance's.
    getVaultIndex,
    getCachedVaultIndex,
    getVaultIndexStats,
    invalidate,
  });
}
