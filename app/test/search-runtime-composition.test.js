// Wave D / D-search — composition, registry and concurrency contract for the per-Vault search
// runtime.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §11 Vault index runtime · §12 Retrieval runtime (per-Vault state/queue/job/timers; a disabled
//       capability is structured and never falls back) · §3.4 capabilities are runtime facts
//       (flip only what is wired) · §21 MV-I01 same-Vault serialization / MV-I02 cross-Vault
//       independence · §29 Wave D search lane · §40 retrieval tests · §41 secondary retrieval is
//       built lazily · §43-5/§43-7 · §47.
//
// The dual-Vault *tool* matrix lives in `multi-vault-search-matrix.test.js`; this file covers the
// layer below it, where the deterministic assertions live:
//   * the capability flip is honest — `capabilities.retrieval` / `capabilities.semantic` are the
//     retrieval runtime's own facts (negative control NC-2 breaks exactly this);
//   * one lazily built search runtime per materialized Vault runtime, the primary reusing the
//     process's existing index/retrieval instances;
//   * fail-closed composition (missing parser/read limit; an instance of another Vault);
//   * the resolver: no selection -> primary; a secondary selection without a runtime -> refusal;
//   * MV-I01/I02 with a gated embedding provider (the only deterministic way to prove
//     "A blocked does not block B" and "same-Vault work serializes").
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-dsearch-compose-"));
const VAULT_ROOT = path.join(ROOT, "vaults");
const DATA_ROOT = path.join(ROOT, "data");
const PRIMARY_ROOT = path.join(VAULT_ROOT, "primary");

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULT_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.HISTORY_PATH = path.join(DATA_ROOT, "history");
process.env.TRASH_PATH = path.join(DATA_ROOT, "trash");
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA_ROOT, "index", "retrieval-index.json");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.RETRIEVAL_AUTO_EMBED = "false";

await fs.mkdir(PRIMARY_ROOT, { recursive: true });
await fs.mkdir(DATA_ROOT, { recursive: true });

const { MAX_READ_BYTES } = await import("../src/config.js");
const { allTagsForNote, documentMap, extractLinks, parseFrontmatter } = await import("../src/obsidian.js");
const { primaryRuntime } = await import("../src/vault.js");
const { primaryIndexRuntime } = await import("../src/vault-index.js");
const { primaryRetrievalRuntime } = await import("../src/retrieval.js");
const { createVaultRuntime } = await import("../src/vault-runtime/runtime.js");
const { secondaryVaultDataPaths } = await import("../src/vault-runtime/paths.js");
const { vaultDataKey } = await import("../src/vault-runtime/descriptor.js");
const { VAULT_SEARCH_RUNTIME_INVALID, createVaultSearchRuntime } = await import("../src/vault-runtime/search-runtime.js");
const { SEARCH_RUNTIME_REFUSED, releaseSearchRuntime, resolveSearchRuntime, searchRuntimeFor } = await import("../src/search-runtimes.js");
const { withRequestContext } = await import("../src/request-context.js");

const INDEX_DEPS = Object.freeze({ parseFrontmatter, documentMap, extractLinks, allTagsForNote, maxReadBytes: MAX_READ_BYTES });

/** A real secondary B1 runtime with its own A7 data layout (the shape D0's map builds). */
function makeVaultRuntime(id) {
  const root = path.join(VAULT_ROOT, id);
  const dataKey = vaultDataKey(id);
  return {
    root,
    runtime: createVaultRuntime({
      descriptor: { id, name: id, root, primary: false, writable: true },
      paths: secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey }),
      dataRoot: path.join(DATA_ROOT, "vaults", dataKey),
    }),
  };
}

async function seed(root, marker) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "one.md"), `# One\n\n${marker} alpha\n`, "utf8");
  await fs.writeFile(path.join(root, "two.md"), `# Two\n\n${marker} beta\n`, "utf8");
}

const sha256File = async (file) => fs.readFile(file).then((bytes) => bytes.toString("base64"), () => null);

function gatedProvider({ blockFirst = false } = {}) {
  let started = 0;
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    provider: {
      semanticConfiguration: () => ({ enabled: true, provider: "test", baseUrl: null, model: "test-model", timeoutMs: null, identity: "test:test-model" }),
      embedTexts: async (texts) => {
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (started === 1 && blockFirst) await gate;
          return texts.map(() => [0.25, 0.5]);
        } finally {
          active -= 1;
        }
      },
    },
    release: () => release(),
    stats: () => ({ started, maxActive, active }),
  };
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the gated provider");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test.after(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

// -------------------------------------------------------------------------------------------------
// 1. §3.4 capability flip is honest (NC-2 target)
// -------------------------------------------------------------------------------------------------

test("§3.4: capabilities.retrieval/semantic are the retrieval runtime's own facts, never over-claimed", () => {
  const { runtime: vaultRuntime } = makeVaultRuntime("caps");
  const search = createVaultSearchRuntime({ vaultRuntime, deps: { ...INDEX_DEPS } });
  assert.equal(vaultRuntime.capabilities.retrieval.available, false, "the B1 factory stays fail closed");
  assert.equal(search.capability.available, true, "this composition wires the Vault's own index as the retrieval source");
  assert.deepEqual(search.capabilities.retrieval, search.retrieval.capability, "the merged map must not over-claim retrieval");
  assert.deepEqual(search.capabilities.semantic, search.retrieval.semanticCapability(), "the merged map must not over-claim semantic");
  assert.equal(search.capabilities.semantic.available, false, "the shared provider is disabled here");
  assert.ok(String(search.capabilities.semantic.reason).length > 0, "an unavailable capability carries a visible reason");
  assert.equal(search.capabilities.notes, vaultRuntime.capabilities.notes, "untouched keys are copied verbatim");
  assert.equal(search.vaultId, vaultRuntime.id);
  assert.equal(search.index, search.index);
  assert.notEqual(search.index, search.retrieval, "two distinct instances");
});

test("§12/§47: composition fails closed on a missing parser/read limit or a foreign instance", () => {
  const { runtime: a } = makeVaultRuntime("a");
  const { runtime: b } = makeVaultRuntime("b");
  for (const broken of [
    { ...INDEX_DEPS, parseFrontmatter: undefined },
    { ...INDEX_DEPS, documentMap: undefined },
    { ...INDEX_DEPS, extractLinks: "nope" },
    { ...INDEX_DEPS, allTagsForNote: null },
    { ...INDEX_DEPS, maxReadBytes: 0 },
  ]) {
    assert.throws(() => createVaultSearchRuntime({ vaultRuntime: a, deps: broken }), (error) => error.code === VAULT_SEARCH_RUNTIME_INVALID);
  }
  assert.throws(() => createVaultSearchRuntime({ vaultRuntime: null, deps: { ...INDEX_DEPS } }), (error) => error.code === VAULT_SEARCH_RUNTIME_INVALID);
  // A Vault may not be handed another Vault's instances (SEC-MV06), and a half-injected pair is
  // refused instead of silently discarding the caller's instance.
  const foreign = createVaultSearchRuntime({ vaultRuntime: a, deps: { ...INDEX_DEPS } });
  assert.throws(
    () => createVaultSearchRuntime({ vaultRuntime: b, index: foreign.index, retrieval: foreign.retrieval }),
    (error) => error.code === VAULT_SEARCH_RUNTIME_INVALID,
  );
  assert.throws(
    () => createVaultSearchRuntime({ vaultRuntime: b, index: foreign.index, deps: { ...INDEX_DEPS } }),
    (error) => error.code === VAULT_SEARCH_RUNTIME_INVALID,
  );
});

// -------------------------------------------------------------------------------------------------
// 2. Lazy per-Vault cache: one instance per runtime, primary identity preserved
// -------------------------------------------------------------------------------------------------

test("§41: one lazily built search runtime per materialized Vault runtime; primary reuses the process instances", () => {
  const { runtime: vaultRuntime } = makeVaultRuntime("cache");
  const first = searchRuntimeFor(vaultRuntime);
  assert.equal(searchRuntimeFor(vaultRuntime), first, "the cache returns one instance per Vault");
  assert.equal(first.vaultId, "cache");
  assert.equal(first.index.vaultId, "cache");
  assert.equal(first.retrieval.vaultId, "cache");
  assert.equal(first.index.vaultRuntime, vaultRuntime);

  const primary = searchRuntimeFor(primaryRuntime);
  assert.equal(primary, searchRuntimeFor(primaryRuntime));
  assert.equal(primary.index, primaryIndexRuntime, "the primary keeps the src/vault-index.js instance");
  assert.equal(primary.retrieval, primaryRetrievalRuntime, "the primary keeps the src/retrieval.js instance");
  assert.equal(primary.primary, true);

  assert.equal(releaseSearchRuntime(vaultRuntime), true);
  assert.equal(releaseSearchRuntime(vaultRuntime), false);
  const rebuilt = searchRuntimeFor(vaultRuntime);
  assert.notEqual(rebuilt, first, "a released instance is never served again");
  assert.equal(rebuilt.index.generation, 0, "the rebuilt instance starts with cold, empty state");
  assert.equal(releaseSearchRuntime(primaryRuntime), false, "the primary instance belongs to the process");
});

// -------------------------------------------------------------------------------------------------
// 3. Resolver contract: no selection -> primary; broken secondary -> structured refusal
// -------------------------------------------------------------------------------------------------

test("§47/SEC-MV06: resolveSearchRuntime never answers a secondary selection with the primary index", () => {
  const primary = withRequestContext({}, () => resolveSearchRuntime());
  assert.equal(primary.vaultRuntime, primaryRuntime);
  assert.equal(withRequestContext({ vaultId: primaryRuntime.id }, () => resolveSearchRuntime()).vaultRuntime, primaryRuntime);

  const { runtime: vaultRuntime } = makeVaultRuntime("resolved");
  const selected = withRequestContext({ vaultId: "resolved", vaultRuntime }, () => resolveSearchRuntime());
  assert.equal(selected.vaultId, "resolved");
  assert.notEqual(selected, primary);

  for (const context of [{ vaultId: "ghost" }, { vaultId: "ghost", vaultRuntime: null }, { vaultRuntime: { id: "" } }]) {
    assert.throws(() => withRequestContext(context, () => resolveSearchRuntime()), (error) => {
      assert.ok([SEARCH_RUNTIME_REFUSED, "vault_retrieval_runtime_invalid"].includes(error.code));
      return true;
    });
  }
  // A malformed runtime in the context is not a fallback to primary either.
  assert.throws(() => withRequestContext({ vaultId: "ghost" }, () => resolveSearchRuntime()), (error) => error.code === SEARCH_RUNTIME_REFUSED && error.vaultId === "ghost");
});

// -------------------------------------------------------------------------------------------------
// 4. §21 MV-I01/MV-I02 with a gated provider
// -------------------------------------------------------------------------------------------------

test("§21 MV-I02: a Vault blocked in embedding never blocks another Vault's retrieval", async () => {
  const gateA = gatedProvider({ blockFirst: true });
  const gateB = gatedProvider();
  const a = makeVaultRuntime("gate-a");
  const b = makeVaultRuntime("gate-b");
  await seed(a.root, "gateatoken");
  await seed(b.root, "gatebtoken");
  const searchA = createVaultSearchRuntime({ vaultRuntime: a.runtime, deps: { ...INDEX_DEPS, embeddingProvider: gateA.provider } });
  const searchB = createVaultSearchRuntime({ vaultRuntime: b.runtime, deps: { ...INDEX_DEPS, embeddingProvider: gateB.provider } });
  try {
    const firstA = searchA.retrieval.syncRetrievalIndex({ embeddings: true });
    await until(() => gateA.stats().active === 1);
    // B must complete while A is still inside embedTexts.
    const bResult = await searchB.retrieval.syncRetrievalIndex({ embeddings: true });
    assert.equal(bResult.notes, 2, "B's retrieval is independent of A's in-flight job (§21 MV-I02)");
    assert.equal(gateA.stats().active, 1, "A is still blocked, so B really ran concurrently");
    gateA.release();
    assert.equal((await firstA).notes, 2);
  } finally {
    gateA.release();
    await searchA.drain();
    await searchB.drain();
    releaseSearchRuntime(a.runtime);
    releaseSearchRuntime(b.runtime);
  }
});

test("§21 MV-I01: same-Vault retrieval work stays serialized behind one operation queue", async () => {
  const gate = gatedProvider({ blockFirst: true });
  const vault = makeVaultRuntime("serialized");
  await seed(vault.root, "serializedtoken");
  const search = createVaultSearchRuntime({ vaultRuntime: vault.runtime, deps: { ...INDEX_DEPS, embeddingProvider: gate.provider } });
  try {
    const first = search.retrieval.syncRetrievalIndex({ embeddings: true });
    await until(() => gate.stats().active === 1);
    const second = search.retrieval.syncRetrievalIndex({ embeddings: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(gate.stats().started, 1, "the second same-Vault sync must not enter the provider while the first is in flight");
    assert.equal(gate.stats().maxActive, 1);
    gate.release();
    assert.equal((await first).notes, 2);
    assert.equal((await second).notes, 2);
    assert.equal(gate.stats().started, 2, "the queued follow-up runs after the first settles");
    assert.equal(gate.stats().maxActive, 1, "no two same-Vault builds ever overlap");
  } finally {
    gate.release();
    await search.drain();
    releaseSearchRuntime(vault.runtime);
  }
});

// -------------------------------------------------------------------------------------------------
// 5. §40 failure containment: a broken embedding provider degrades one Vault only
// -------------------------------------------------------------------------------------------------

test("§40: an embedding failure degrades that Vault's report without dirtying another Vault", async () => {
  const good = gatedProvider();
  const broken = {
    semanticConfiguration: () => ({ enabled: true, provider: "test", baseUrl: null, model: "test-model", timeoutMs: null, identity: "test:test-model" }),
    embedTexts: async () => { throw new Error("embedding backend down"); },
  };
  const healthy = makeVaultRuntime("healthy");
  const failing = makeVaultRuntime("failing");
  await seed(healthy.root, "healthytoken");
  await seed(failing.root, "failingtoken");
  const healthySearch = createVaultSearchRuntime({ vaultRuntime: healthy.runtime, deps: { ...INDEX_DEPS, embeddingProvider: good.provider } });
  const failingSearch = createVaultSearchRuntime({ vaultRuntime: failing.runtime, deps: { ...INDEX_DEPS, embeddingProvider: broken } });
  try {
    assert.equal((await healthySearch.retrieval.syncRetrievalIndex({ embeddings: true })).notes, 2);
    const healthyFile = healthySearch.retrieval.indexPath;
    const healthyBytes = await sha256File(healthyFile);

    const degraded = await failingSearch.retrieval.syncRetrievalIndex({ embeddings: true });
    assert.equal(degraded.notes, 2, "a lexical index is still built");
    assert.match(String(degraded.semanticError), /embedding backend down/, "degrade is reported, never caught silently");
    assert.equal(degraded.embeddedChunks, 0);

    assert.equal(await sha256File(healthyFile), healthyBytes, "a failing Vault must not dirty another Vault's index file");
    assert.equal((await healthySearch.retrieval.retrievalIndexStatus()).embeddedChunks, 2, "the healthy Vault keeps its embeddings");
    // The failing Vault's semantic *capability* is a configuration fact, not a call result.
    assert.equal(failingSearch.retrieval.semanticCapability().available, true);
  } finally {
    await healthySearch.drain();
    await failingSearch.drain();
    releaseSearchRuntime(healthy.runtime);
    releaseSearchRuntime(failing.runtime);
  }
});
