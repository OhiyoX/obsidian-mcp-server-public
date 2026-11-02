// B2 — per-Vault VaultIndex runtime tests (contract §11 "Vault index runtime" + §5.3 / §43-7
// architecture constraints; brief B2 §1.1, §1.3).
//
// Jobs:
//   1. pin the *literal* instance seam (frozen fields, fail-closed deps, instance-local state)
//      that lanes B3 / B6 / Wave C dock to;
//   2. prove the contract §11 hard requirement: two Vaults own independent index runtimes, and
//      A's invalidation/rebuild never reads or moves B's generation / publicationRevision
//      (both directions);
//   3. prove builds of ONE instance are serialized behind its own build tail, while two
//      instances build in parallel (no shared tail);
//   4. prove the new modules hold no ambient state (no config.js import, no env read, no
//      module-global index state) with a self-proofed scanner and a negative fixture.
// The compatibility facade's own export/arity/delegation snapshot lives in
// `test/vault-index-facade.test.js`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(APP, "src");

// The compatibility facade reads config.js at import time, so let the scratch roots exist
// first and keep the ambient env inert (no Git, no embeddings, no retrieval debounce).
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mv-b2-index-runtime-"));
const primaryVaultRoot = path.join(scratch, "primary-vault");
await fs.mkdir(primaryVaultRoot, { recursive: true });
process.env.VAULT_PATH = primaryVaultRoot;
process.env.DATA_PATH = path.join(scratch, "data");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.RETRIEVAL_REFRESH_DEBOUNCE_MS = "60000";

const { MAX_READ_BYTES } = await import("../src/config.js");
const { allTagsForNote, documentMap, extractLinks, parseFrontmatter } = await import("../src/obsidian.js");
const { createVaultDescriptor } = await import("../src/vault-runtime/descriptor.js");
const { secondaryVaultDataPaths } = await import("../src/vault-runtime/paths.js");
const { createVaultRuntime, defaultRuntimeCapabilities } = await import("../src/vault-runtime/runtime.js");
const indexModule = await import("../src/vault-runtime/vault-index-runtime.js");
const linksModule = await import("../src/vault-runtime/vault-index-links.js");
const { createVaultIndexRuntime, VAULT_INDEX_RUNTIME_INVALID } = indexModule;

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Fixtures: two real Vaults (temp roots) with their own canonical runtimes.
// ---------------------------------------------------------------------------

async function makeVault(name, notes) {
  const base = path.join(scratch, name);
  const root = path.join(base, "vault");
  await fs.mkdir(root, { recursive: true });
  for (const [relative, content] of Object.entries(notes)) {
    const abs = path.join(root, relative);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  const dataRoot = path.join(base, "data");
  const descriptor = await createVaultDescriptor({
    id: name,
    root,
    primary: false,
    writable: true,
    capabilities: defaultRuntimeCapabilities("b2 fixture wires nothing"),
  });
  const paths = secondaryVaultDataPaths({ dataRoot, dataKey: descriptor.dataKey });
  return createVaultRuntime({ descriptor, paths, dataRoot });
}

/**
 * The exact seam the facade uses for the primary Vault, rebuilt from a runtime instead of the
 * process root: a Vault-bound reader plus the pure parse helpers and the injected read limit.
 */
function boundDeps(runtime, { maxReadBytes = 1024 * 1024, onRefresh = () => {} } = {}) {
  const { localFs } = runtime;
  return {
    maxReadBytes,
    readNote: async (absPath, options = {}) => {
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
    },
    documentMap,
    extractLinks,
    allTagsForNote,
    scheduleRetrievalRefresh: onRefresh,
  };
}

const indexFor = (runtime, options) => createVaultIndexRuntime({ vaultRuntime: runtime, deps: boundDeps(runtime, options) });

/** Comparable, fully derived state tuple: any cross-instance leak shows up here. */
function stateOf(index) {
  const cached = index.getCachedVaultIndex();
  return {
    generation: index.generation,
    publicationRevision: index.publicationRevision,
    snapshotGeneration: index.snapshotGeneration,
    indexBuilt: index.indexBuilt,
    freshness: index.getVaultIndexStats().freshness,
    records: cached ? cached.records.map((record) => record.path) : null,
  };
}

// ---------------------------------------------------------------------------
// Instance seam (§11)
// ---------------------------------------------------------------------------

const INSTANCE_KEYS = [
  "buildTail", "generation", "getCachedVaultIndex", "getVaultIndex", "getVaultIndexStats", "indexBuilt", "invalidate",
  "lastRefresh", "lastStats", "localFs", "maxReadBytes", "noteCache", "primary", "publicationRevision", "root",
  "snapshotGeneration", "snapshotIdentity", "vaultId", "vaultRuntime",
];

test("instance seam is frozen, Vault-bound and exposes the §11 state exactly", async () => {
  const runtime = await makeVault("seam", { "Note.md": "# Note\n" });
  const index = indexFor(runtime);

  assert.deepEqual(Object.keys(index).sort(), INSTANCE_KEYS);
  assert.ok(Object.isFrozen(index), "the instance seam must be frozen");
  assert.equal(index.vaultRuntime, runtime, "the instance must carry its VaultRuntime by identity");
  assert.equal(index.vaultId, runtime.id);
  assert.equal(index.root, runtime.root);
  assert.equal(index.primary, false);
  assert.equal(index.localFs, runtime.localFs);
  assert.equal(index.maxReadBytes, 1024 * 1024);

  // Cold state, exactly the pre-facade zero/null shape.
  assert.ok(index.noteCache instanceof Map);
  assert.equal(index.noteCache.size, 0);
  assert.equal(index.generation, 0);
  assert.equal(index.publicationRevision, 0);
  assert.equal(index.snapshotGeneration, null);
  assert.equal(index.snapshotIdentity, null);
  assert.equal(index.indexBuilt, false);
  assert.equal(index.lastRefresh, null);
  assert.deepEqual(index.lastStats, { files: 0, reparsed: 0, reused: 0, removed: 0, skipped: 0, durationMs: 0 });
  assert.equal(typeof index.buildTail?.then, "function");
  assert.equal(index.getCachedVaultIndex(), null);
  const stats = index.getVaultIndexStats();
  assert.equal(stats.cachedNotes, 0);
  assert.equal(stats.freshness, "cold");
  assert.equal(stats.coverage, null);

  // Accessors are read-only and hand out copies, never writable internals.
  assert.throws(() => { index.generation = 7; }, TypeError);
  assert.throws(() => { index.noteCache = new Map(); }, TypeError);
  index.lastStats.files = 99;
  assert.equal(index.lastStats.files, 0, "lastStats must be handed out as a copy");
  assert.deepEqual(index.snapshotIdentity, null);

  // Module state is not exported: the runtime module has no ambient cache.
  for (const name of ["noteCache", "vaultGeneration", "publicationRevision", "buildTail", "lastStats"]) {
    assert.equal(name in indexModule, false, `${name} must not be a module export`);
  }
});

test("deps fail closed: no ambient reader, parser or read limit", async () => {
  const runtime = await makeVault("deps", { "Note.md": "# Note\n" });
  const valid = boundDeps(runtime);

  assert.throws(() => createVaultIndexRuntime({ vaultRuntime: null }), /vaultRuntime must be a VaultRuntime/);
  assert.throws(() => createVaultIndexRuntime({ vaultRuntime: { id: "", root: runtime.root, localFs: runtime.localFs } }), /vaultRuntime\.id must be a non-empty string/);
  assert.throws(() => createVaultIndexRuntime({ vaultRuntime: runtime, deps: [] }), /deps must be an object/);

  assert.throws(() => createVaultIndexRuntime({ vaultRuntime: runtime }), (error) => {
    assert.equal(error.code, VAULT_INDEX_RUNTIME_INVALID);
    for (const name of ["readNote", "documentMap", "extractLinks", "allTagsForNote"]) {
      assert.match(error.message, new RegExp(name), `${name} must be reported as missing`);
    }
    return true;
  });
  assert.throws(() => createVaultIndexRuntime({ vaultRuntime: runtime, deps: { ...valid, maxReadBytes: 0 } }), /maxReadBytes must be a positive integer/);
  assert.throws(() => createVaultIndexRuntime({ vaultRuntime: runtime, deps: { ...valid, maxReadBytes: undefined } }), /maxReadBytes must be a positive integer/);
  assert.throws(() => createVaultIndexRuntime({ vaultRuntime: runtime, deps: { ...valid, readNote: "nope" } }), /readNote/);
  assert.throws(() => createVaultIndexRuntime({ vaultRuntime: runtime, deps: { ...valid, toVaultPath: 5 } }), /toVaultPath must be a function/);

  // A valid instance may still omit the optional deps: they default to this runtime's own
  // services (never to a process root) and to a no-op refresh scheduler.
  const bare = createVaultIndexRuntime({ vaultRuntime: runtime, deps: { ...valid, allMarkdownFiles: undefined, toVaultPath: undefined, scheduleRetrievalRefresh: undefined } });
  const built = await bare.getVaultIndex();
  assert.deepEqual(built.records.map((record) => record.path), ["Note.md"]);
  assert.ok(Object.isFrozen(bare.snapshotIdentity), "the published snapshot identity must be frozen");
});

test("the instance owns the vault-relative projection (a reader's own path is ignored)", async () => {
  const runtime = await makeVault("projection", { "Keep.md": "# Keep\n", "Deep/Inner.md": "# Inner\n" });
  const deps = boundDeps(runtime);
  const reader = deps.readNote;
  deps.readNote = async (absPath) => ({ ...(await reader(absPath)), path: "WRONG/Foreign.md" });
  const index = createVaultIndexRuntime({ vaultRuntime: runtime, deps });
  const built = await index.getVaultIndex();
  assert.deepEqual(built.records.map((record) => record.path).sort(), ["Deep/Inner.md", "Keep.md"]);
  assert.deepEqual(built.records.map((record) => record.name).sort(), ["Inner.md", "Keep.md"]);
  for (const record of built.records) assert.ok(!record.path.includes("WRONG"));
  assert.deepEqual([...index.noteCache.keys()].sort(), ["Deep/Inner.md", "Keep.md"]);
});

// ---------------------------------------------------------------------------
// Contract §11 hard requirement: A/B independence
// ---------------------------------------------------------------------------

test("A/B independence: A's invalidation and rebuild never move B's generation/publicationRevision", async () => {
  const runtimeA = await makeVault("iso-a", { "Alpha.md": "# Alpha\n\n[[Beta]]\n", "Beta.md": "# Beta\n" });
  const runtimeB = await makeVault("iso-b", { "Gamma.md": "# Gamma\n", "Delta.md": "# Delta\n" });
  let refreshesA = 0;
  let refreshesB = 0;
  const indexA = indexFor(runtimeA, { onRefresh: () => { refreshesA += 1; } });
  const indexB = indexFor(runtimeB, { onRefresh: () => { refreshesB += 1; } });

  assert.notEqual(indexA.noteCache, indexB.noteCache, "each instance owns its own cache Map");
  assert.notEqual(indexA, indexB);

  // A publishes; B must stay exactly cold.
  const coldB = stateOf(indexB);
  await indexA.getVaultIndex();
  assert.deepEqual(stateOf(indexA).records, ["Alpha.md", "Beta.md"]);
  assert.deepEqual(stateOf(indexB), coldB);
  assert.equal(indexB.generation, 0);
  assert.equal(indexB.publicationRevision, 0);
  assert.equal(indexB.noteCache.size, 0);
  assert.equal(indexB.getCachedVaultIndex(), null);
  assert.equal(refreshesB, 0);

  // A's path invalidation + rebuild: A moves, B does not (direction A -> B).
  const publishedB = stateOf(indexB);
  indexA.invalidate("Alpha.md");
  assert.equal(indexA.generation, 1);
  assert.equal(indexA.getVaultIndexStats().freshness, "dirty");
  assert.equal(refreshesA, 1);
  assert.equal(refreshesB, 0);
  assert.deepEqual(stateOf(indexB), publishedB);
  await indexA.getVaultIndex();
  assert.equal(indexA.publicationRevision, 2);
  assert.deepEqual(stateOf(indexB), publishedB);

  // B builds and invalidates: B moves, A does not (direction B -> A).
  const publishedA = stateOf(indexA);
  await indexB.getVaultIndex();
  assert.deepEqual(stateOf(indexB).records, ["Delta.md", "Gamma.md"]);
  assert.equal(indexB.publicationRevision, 1);
  assert.equal(indexB.generation, 0);
  assert.deepEqual(stateOf(indexA), publishedA);

  indexB.invalidate("Gamma.md");
  assert.equal(indexB.generation, 1);
  assert.equal(refreshesB, 1);
  assert.equal(refreshesA, 1);
  assert.deepEqual(stateOf(indexA), publishedA);

  // Full invalidation returns only the calling instance to cold.
  indexA.invalidate();
  assert.equal(indexA.getCachedVaultIndex(), null);
  assert.equal(indexA.getVaultIndexStats().freshness, "cold");
  assert.equal(indexA.snapshotGeneration, null);
  assert.equal(indexB.getVaultIndexStats().freshness, "dirty");
  // Path invalidation drops that one record but keeps the snapshot cached (pre-facade semantics).
  assert.deepEqual(indexB.getCachedVaultIndex().records.map((record) => record.path), ["Delta.md"]);
  assert.equal(indexB.publicationRevision, 1);
  assert.equal(indexB.snapshotGeneration, 0);
  assert.equal(refreshesA, 2);
});

test("a failed instance build marks only its own snapshot dirty", async () => {
  const runtimeA = await makeVault("fail-a", { "One.md": "# One\n", "Two.md": "# Two\n" });
  const runtimeB = await makeVault("fail-b", { "Other.md": "# Other\n" });
  const indexB = indexFor(runtimeB);
  await indexB.getVaultIndex();
  const publishedB = stateOf(indexB);

  const deps = boundDeps(runtimeA);
  const realRead = deps.readNote;
  let failReads = false;
  deps.readNote = async (absPath, options) => {
    if (failReads && absPath.endsWith("Two.md")) throw new Error("synthetic index read failure");
    return realRead(absPath, options);
  };
  const indexA = createVaultIndexRuntime({ vaultRuntime: runtimeA, deps });
  await indexA.getVaultIndex();
  failReads = true;
  await assert.rejects(() => indexA.getVaultIndex({ force: true }), /synthetic index read failure/);

  assert.equal(indexA.getVaultIndexStats().freshness, "dirty");
  assert.equal(indexA.publicationRevision, 1, "a failed refresh must not publish");
  assert.deepEqual(indexA.getCachedVaultIndex().records.map((record) => record.path), ["One.md", "Two.md"]);
  assert.deepEqual(stateOf(indexB), publishedB, "B must be unaffected by A's failed build");
});

// ---------------------------------------------------------------------------
// Build serialization: one tail per instance, no tail between instances
// ---------------------------------------------------------------------------

function gatedIndex(runtime, tracker) {
  const deps = boundDeps(runtime);
  const base = runtime.localFs.allMarkdownFiles;
  deps.allMarkdownFiles = async (options) => {
    tracker.inFlight += 1;
    tracker.maxInFlight = Math.max(tracker.maxInFlight, tracker.inFlight);
    await new Promise((resolve) => tracker.gates.push(resolve));
    try {
      return await base(options);
    } finally {
      tracker.inFlight -= 1;
    }
  };
  return createVaultIndexRuntime({ vaultRuntime: runtime, deps });
}

const tracker = () => ({ gates: [], inFlight: 0, maxInFlight: 0 });
const release = (track, count = track.gates.length) => {
  for (const resolve of track.gates.splice(0, count)) resolve();
};

test("same-instance builds queue behind one build tail (only one enumeration at a time)", async () => {
  const runtime = await makeVault("serial", { "One.md": "# One\n", "Two.md": "# Two\n" });
  const track = tracker();
  const index = gatedIndex(runtime, track);

  const first = index.getVaultIndex({ force: true });
  const second = index.getVaultIndex({ force: true });
  await flush();
  assert.equal(track.gates.length, 1, "the second build must stay parked behind the instance build tail");
  assert.equal(track.maxInFlight, 1);
  assert.equal(index.buildTail instanceof Promise, true);

  release(track, 1);
  await first;
  await flush();
  assert.equal(track.gates.length, 1, "the queued build starts only after the first one settles");
  assert.equal(track.maxInFlight, 1, "two builds of one instance must never enumerate concurrently");
  release(track, 1);
  await second;

  assert.equal(track.maxInFlight, 1);
  assert.equal(index.publicationRevision, 2);
  assert.equal(index.getVaultIndexStats().freshness, "clean");
});

test("two instances build in parallel: no build tail is shared across Vaults", async () => {
  const runtimeA = await makeVault("par-a", { "A.md": "# A\n" });
  const runtimeB = await makeVault("par-b", { "B.md": "# B\n" });
  const trackA = tracker();
  const trackB = tracker();
  const indexA = gatedIndex(runtimeA, trackA);
  const indexB = gatedIndex(runtimeB, trackB);

  const first = indexA.getVaultIndex();
  const second = indexB.getVaultIndex();
  await flush();
  assert.equal(trackA.gates.length, 1, "A must be inside its own enumeration");
  assert.equal(trackB.gates.length, 1, "B must not be blocked by A");
  assert.equal(trackA.maxInFlight, 1);
  assert.equal(trackB.maxInFlight, 1);
  assert.notEqual(indexA.buildTail, indexB.buildTail);

  release(trackA);
  release(trackB);
  const [builtA, builtB] = await Promise.all([first, second]);
  assert.deepEqual(builtA.records.map((record) => record.path), ["A.md"]);
  assert.deepEqual(builtB.records.map((record) => record.path), ["B.md"]);
  assert.equal(indexA.publicationRevision, 1);
  assert.equal(indexB.publicationRevision, 1);
});

// ---------------------------------------------------------------------------
// §5.3 / §43-5 / §43-7 source constraints for the new modules
// ---------------------------------------------------------------------------

const FORBIDDEN_GLOBALS = ["VAULT", "DATA_PATH", "TRASH_PATH", "HISTORY_PATH", "RETRIEVAL_INDEX_PATH", "MEMORY_PATH", "SKILLS_PATH"];

function importStatements(text) {
  return [...text.matchAll(/import\s+(?:([^"';]*?)\s+from\s+)?"([^"]+)";/g)].map((match) => ({
    clause: (match[1] ?? "").trim(),
    specifier: match[2],
    bindings: match[1] === undefined ? [] : [...match[1].matchAll(/(?:\{([^}]*)\}|([\w$]+))/g)].flatMap((piece) =>
      piece[1] !== undefined ? piece[1].split(",").map((name) => name.trim()).filter(Boolean) : [piece[2]]),
  }));
}
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
function violations(rawText) {
  const text = stripComments(rawText);
  const found = [];
  if (/AsyncLocalStorage/.test(text)) found.push("AsyncLocalStorage");
  if (/request-context/.test(text)) found.push("request-context");
  if (/process\.env/.test(text)) found.push("process.env");
  if (/\brequire\s*\(/.test(text)) found.push("require(");
  if (/^(?:let|var)\s/m.test(text)) found.push("module-level let/var");
  if (/^(?:const|let|var)\s+\w+\s*=\s*new\s+(?:Map|Set)\s*\(/m.test(text)) found.push("module-level collection");
  return found;
}
const source = (relative) => fs.readFile(path.join(SRC, relative), "utf8");

test("scanner self-proof: the ambient-state oracle is not vacuous", () => {
  const bad = [
    'import { MAX_READ_BYTES } from "./config.js";',
    "const noteCache = new Map();",
    "let buildTail = Promise.resolve();",
    "const limit = process.env.MAX_READ_BYTES;",
  ].join("\n");
  assert.deepEqual(violations(bad), ["process.env", "module-level let/var", "module-level collection"]);
  const good = [
    'import path from "node:path";',
    "export function createVaultIndexRuntime({ vaultRuntime }) {",
    "  const noteCache = new Map();",
    "  let buildTail = Promise.resolve();",
    "}",
  ].join("\n");
  assert.deepEqual(violations(good), [], "factory-local state must not be reported as ambient");
  assert.deepEqual(importStatements(bad).map((entry) => entry.specifier), ["./config.js"]);
});

test("new runtime modules hold no ambient state, no config.js import and no global root", async () => {
  const runtimeSource = await source("vault-runtime/vault-index-runtime.js");
  const linksSource = await source("vault-runtime/vault-index-links.js");
  for (const [name, text] of [["vault-index-runtime.js", runtimeSource], ["vault-index-links.js", linksSource]]) {
    assert.deepEqual(violations(text), [], `${name} must not use ALS, env, require or module-level mutable state`);
    for (const forbidden of FORBIDDEN_GLOBALS) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(stripComments(text)), `${name} must not reference ${forbidden}`);
    }
    assert.ok(!/from\s+"\.\.\/config\.js"|from\s+"\.\/config\.js"/.test(text), `${name} must not import config.js`);
  }
  assert.deepEqual(importStatements(runtimeSource).map((entry) => entry.specifier).sort(),
    ["./local-fs.js", "./vault-index-links.js", "node:fs/promises", "node:path"]);
  assert.deepEqual(importStatements(linksSource).map((entry) => entry.specifier).sort(),
    ["./local-fs.js", "node:path"]);

  // The §11 state lives inside the factory closure (two-space indent), never at module scope.
  for (const anchor of [
    "\n  const noteCache = new Map();",
    "\n  let vaultGeneration = 0;",
    "\n  let publicationRevision = 0;",
    "\n  let snapshotGeneration = null;",
    "\n  let snapshotIdentity = null;",
    "\n  let lastRefresh = null;",
    "\n  let lastStats = emptyStats();",
    "\n  let buildTail = Promise.resolve();",
  ]) {
    assert.ok(runtimeSource.includes(anchor), `runtime state must be declared inside the factory: ${anchor.trim()}`);
    assert.ok(!new RegExp(`^${anchor.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(runtimeSource), `runtime state must not be module-level: ${anchor.trim()}`);
  }
  assert.match(runtimeSource, /^export \{ createLinkResolver \};$/m, "the runtime re-exports the root-free resolver");
  assert.match(linksSource, /^export function createLinkResolver\(records\) \{$/m, "the links module owns the resolver definition");
});

test("the compatibility facade holds no index state and only delegates", async () => {
  const facadeSource = await source("vault-index.js");
  assert.deepEqual(violations(facadeSource), [], "the facade must not carry module-level mutable state");
  const delegation = { getVaultIndex: "getVaultIndex", getCachedVaultIndex: "getCachedVaultIndex", getVaultIndexStats: "getVaultIndexStats", invalidateVaultIndex: "invalidate" };
  for (const [name, method] of Object.entries(delegation)) {
    assert.ok(facadeSource.includes(`return primaryIndexRuntime.${method}(`), `facade ${name} must delegate to ${method}`);
  }
  assert.match(facadeSource, /export const primaryIndexRuntime = createVaultIndexRuntime\(\{/, "the facade must build the primary index runtime once");
  assert.match(facadeSource, /vaultRuntime: primaryRuntime/, "the primary index runtime must be bound to the primary VaultRuntime");
});
