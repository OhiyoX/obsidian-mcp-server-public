// Wave D / D-search — real dual-Vault search matrix (search / retrieval parity lane).
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D search lane — run a REAL two-Vault matrix through the real tools instead of
//       assuming the shared foundation made retrieval per-Vault; never invent a second Vault
//       selector;
//   §11/§12 index/retrieval runtime per Vault · §40 retrieval tests (A/B same path different
//       content, independent lexical index, reindex A does not clear B, capability-disabled is
//       structured and never silently falls back to the primary index) · §21 MV-I02/MV-I07 ·
//       §3.4 capabilities are runtime facts · §47 RETURN list.
//
// Proven here: `search_notes` / `list_notes` / `list_recent` / `list_tags` / `recall` /
// `reindex_vault` / `index_status` / `graph_health` / `get_graph` / `get_backlinks` read the
// *selected* Vault's index and retrieval instance through `requestContext().vaultRuntime`; two
// Vaults with a same-named, differently-valued note never see each other's corpus or index file;
// an omitted `vaultId` keeps the legacy primary behaviour; an id without a materialized runtime is
// refused structurally with zero Vault I/O and zero handler invocations.
//
// NOT proven here: the *concurrency* half of MV-I01/I02 is deterministic only with a controllable
// embedding provider, so it lives in `search-runtime-composition.test.js`; per-Vault Git, plans,
// workflows/Bases, skills and the Web/Admin faces belong to their own lanes (see D-search HANDOFF
// §risks for the residual cross-Vault reads those lanes still own).
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-dsearch-matrix-"));
const VAULTS_ROOT = path.join(ROOT, "vaults");
const PRIMARY_ROOT = path.join(VAULTS_ROOT, "primary");
const SECONDARY_ROOT = path.join(VAULTS_ROOT, "secondary");
const DATA_ROOT = path.join(ROOT, "data");
const SECONDARY = "secondary";

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.HISTORY_PATH = path.join(DATA_ROOT, "history");
process.env.TRASH_PATH = path.join(DATA_ROOT, "trash");
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA_ROOT, "index", "retrieval-index.json");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.RETRIEVAL_AUTO_EMBED = "false";

for (const root of [PRIMARY_ROOT, SECONDARY_ROOT, DATA_ROOT]) await fs.mkdir(root, { recursive: true });

// Same-named note, different content: the canonical §40 corpus. Each Vault also carries a marker
// only it knows, so "the other Vault's corpus" is provably invisible either way.
const SHARED_NOTE = "shared/note.md";
const PRIMARY_MARKER = "primaryonlytoken";
const SECONDARY_MARKER = "secondaryonlytoken";
await fs.mkdir(path.join(PRIMARY_ROOT, "shared"), { recursive: true });
await fs.mkdir(path.join(SECONDARY_ROOT, "shared"), { recursive: true });
await fs.writeFile(path.join(PRIMARY_ROOT, SHARED_NOTE), "# Shared\n\nprimary-only-marker alpha\n", "utf8");
await fs.writeFile(path.join(PRIMARY_ROOT, "primary-only.md"), `# Primary Only\n\n${PRIMARY_MARKER}\n`, "utf8");
await fs.writeFile(path.join(SECONDARY_ROOT, SHARED_NOTE), "# Shared\n\nsecondary-only-marker alpha\n", "utf8");
await fs.writeFile(path.join(SECONDARY_ROOT, "secondary-only.md"), `# Secondary Only\n\n${SECONDARY_MARKER}\n`, "utf8");

const { primaryRuntime } = await import("../src/vault.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultRegistry } = await import("../src/vault-runtime/registry.js");
const { createVaultRuntimeMap } = await import("../src/vault-runtime/instances.js");
const { createVaultScopeRegistrar, VAULT_SCOPE_DENY_CODES } = await import("../src/vault-scope-registrar.js");
const { requireRequestAuthor } = await import("../src/request-context.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { searchRuntimeFor } = await import("../src/search-runtimes.js");

const SECONDARY_DATA_KEY = createHash("sha256").update(SECONDARY).digest("hex");
const SECONDARY_DATA_ROOT = path.join(DATA_ROOT, "vaults", SECONDARY_DATA_KEY);
const SECONDARY_INDEX = path.join(SECONDARY_DATA_ROOT, "index", "retrieval-index.json");
const PRIMARY_INDEX = path.join(DATA_ROOT, "index", "retrieval-index.json");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readFileOr = async (file) => fs.readFile(file).then((bytes) => sha256(bytes), (error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));

const newMap = async () => {
  const map = createVaultRuntimeMap({
    registry: createVaultRegistry({ primaryRoot: PRIMARY_ROOT, primaryId: DEFAULT_VAULT_ID, vaultsRoot: VAULTS_ROOT, writable: true }),
    dataRoot: DATA_ROOT,
    primaryRuntime,
    deps: { requireRequestAuthor },
  });
  await map.refresh();
  return map;
};

const vaultScopeOf = (map) => ({ resolveVaultRuntime: (id) => map.get(id), vaultExists: (id) => map.has(id) });

/** Real MCP server (every capability) wired through C's registrar, driven by the real SDK. */
async function withServer(vaultScope, callback, serverName = "mv-dsearch-matrix") {
  const server = new McpServer({ name: serverName, version: "0.0.0" });
  registerObsidianCapabilities(server, { vaultScope });
  const client = new Client({ name: serverName, version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, structured: result.structuredContent, raw: result };
  };
  const ok = async (name, args) => {
    const { isError, structured, raw } = await call(name, args);
    assert.equal(isError, false, `${name} failed: ${raw.content?.[0]?.text}`);
    return structured;
  };
  try {
    return await callback({ call, ok });
  } finally {
    await client.close();
    await server.close();
  }
}

/** Quiesce both Vaults' retrieval timers/queues (per-Vault; draining A never drains B). */
async function drainAll(map) {
  for (const id of map.ids()) await searchRuntimeFor(map.get(id)).drain();
}

test.after(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

// -------------------------------------------------------------------------------------------------
// 1. §29/§40 corpus isolation: a secondary search sees only the secondary corpus
// -------------------------------------------------------------------------------------------------

test("§29 search lane: search_notes(vaultId=secondary) returns only the secondary corpus", async () => {
  const map = await newMap();
  const indexBefore = await readFileOr(PRIMARY_INDEX);
  const primaryTreeBefore = await fs.readFile(path.join(PRIMARY_ROOT, SHARED_NOTE), "utf8");
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const secondary = await ok("search_notes", { vaultId: SECONDARY, query: SECONDARY_MARKER, semantic: false });
    assert.deepEqual(secondary.results.map((item) => item.path), ["secondary-only.md"]);
    assert.match(secondary.results[0].snippets.join(" "), /secondaryonlytoken/);
    assert.equal(secondary.totalScanned, 2, "the secondary index must hold exactly the secondary corpus");
    assert.equal(secondary.index.files, 2);

    // The same-named note carries different content in each Vault (§40).
    const secondaryShared = await ok("search_notes", { vaultId: SECONDARY, query: "alpha", semantic: false });
    assert.deepEqual(secondaryShared.results.map((item) => item.path), [SHARED_NOTE]);
    assert.match(secondaryShared.results[0].snippets.join(" "), /secondary-only-marker/);

    // The primary's marker is not reachable through the secondary selection.
    const crossMarker = await ok("search_notes", { vaultId: SECONDARY, query: PRIMARY_MARKER, semantic: false });
    assert.deepEqual(crossMarker.results, [], "a secondary search must never see the primary corpus");
    // A path that exists only in the primary is invisible to the secondary.
    const crossPath = await ok("search_notes", { vaultId: SECONDARY, query: "alpha", pathRegex: "primary-only", semantic: false });
    assert.deepEqual(crossPath.results, []);

    // ... and the reverse: the primary index does not see the secondary corpus.
    const primary = await ok("search_notes", { query: SECONDARY_MARKER, semantic: false });
    assert.deepEqual(primary.results, [], "the primary index must not see the secondary corpus");
    const primaryShared = await ok("search_notes", { query: "alpha", semantic: false });
    assert.deepEqual(primaryShared.results.map((item) => item.path), [SHARED_NOTE]);
    assert.match(primaryShared.results[0].snippets.join(" "), /primary-only-marker/);
    assert.equal(primaryShared.totalScanned, 2);
  });
  assert.equal(await readFileOr(PRIMARY_INDEX), indexBefore, "secondary reads must not create or touch the primary retrieval index");
  assert.equal(await fs.readFile(path.join(PRIMARY_ROOT, SHARED_NOTE), "utf8"), primaryTreeBefore);
});

test("§29 search lane: list_notes / list_recent / list_tags / graph tools follow the selected Vault", async () => {
  const map = await newMap();
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const secondaryFiles = await ok("list_notes", { vaultId: SECONDARY, recursive: true, includeDirectories: false });
    assert.deepEqual(secondaryFiles.entries.map((entry) => entry.path).sort(), [SHARED_NOTE, "secondary-only.md"].sort());

    const primaryFiles = await ok("list_notes", { recursive: true, includeDirectories: false });
    assert.deepEqual(primaryFiles.entries.map((entry) => entry.path).sort(), [SHARED_NOTE, "primary-only.md"].sort());

    const secondaryRecent = await ok("list_recent", { vaultId: SECONDARY });
    assert.equal(secondaryRecent.totalCount, 2);
    const secondaryTags = await ok("list_tags", { vaultId: SECONDARY, includeNotes: true });
    assert.equal(secondaryTags.notes.length, 2);

    const graph = await ok("get_graph", { vaultId: SECONDARY });
    assert.deepEqual(graph.nodes.map((node) => node.id).sort(), [SHARED_NOTE, "secondary-only.md"].sort());
    const health = await ok("graph_health", { vaultId: SECONDARY, includeDetails: true });
    assert.equal(health.notes, 2);
  });
});

// -------------------------------------------------------------------------------------------------
// 2. §11/§12 per-Vault index paths + per-Vault index_status counts
// -------------------------------------------------------------------------------------------------

test("§11/§12: the two Vaults own distinct A7 index paths and per-Vault index_status counts", async () => {
  const map = await newMap();
  const primaryLayers = ["root", "history", "trash", "retrievalIndex", "transfersUploads", "mutationJournal", "mutationIdempotency"];
  const primaryPaths = map.get(DEFAULT_VAULT_ID).paths;
  const secondaryPaths = map.get(SECONDARY).paths;
  for (const key of primaryLayers) {
    if (key === "root") continue; // primary legacy mapping has no `root` key
    assert.notEqual(primaryPaths[key], secondaryPaths[key], `A7 ${key} must differ per Vault (§5.1/§5.2)`);
  }
  assert.equal(secondaryPaths.root, SECONDARY_DATA_ROOT);
  assert.equal(secondaryPaths.retrievalIndex, SECONDARY_INDEX);
  assert.equal(secondaryPaths.history, path.join(SECONDARY_DATA_ROOT, "history"));
  assert.equal(secondaryPaths.trash, path.join(SECONDARY_DATA_ROOT, "trash"));
  assert.equal(primaryPaths.retrievalIndex, PRIMARY_INDEX);

  const primaryIndexBefore = await readFileOr(PRIMARY_INDEX);
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const cold = await ok("index_status", { vaultId: SECONDARY });
    assert.equal(cold.path, SECONDARY_INDEX, "index_status must report this Vault's retrieval index file");
    assert.equal(cold.available, true, "retrieval is wired for a materialized secondary (§3.4)");
    assert.equal(cold.capability.available, true);
    assert.equal(cold.notes, 0, "a cold per-Vault index starts empty");

    const job = await ok("reindex_vault", { vaultId: SECONDARY, embeddings: false });
    assert.ok(job.id, "reindex_vault must return this Vault's own job snapshot");
    await drainAll(map);

    const warm = await ok("index_status", { vaultId: SECONDARY });
    assert.equal(warm.path, SECONDARY_INDEX);
    assert.equal(warm.notes, 2, "the secondary index holds exactly the secondary corpus");
    assert.equal(warm.capability.available, true);
    assert.equal(warm.semantic.enabled, false, "the shared provider is disabled in this environment");
    assert.equal(warm.semanticCapability.available, false, "degrade is reported, never caught silently");
    assert.ok(String(warm.semanticCapability.reason).length > 0);
  });
  assert.equal(await readFileOr(PRIMARY_INDEX), primaryIndexBefore, "reindexing the secondary must not touch the primary retrieval index");

  // The secondary index file really exists under this Vault's data root and lists only its corpus.
  const stored = JSON.parse(await fs.readFile(SECONDARY_INDEX, "utf8"));
  assert.deepEqual(Object.keys(stored.notes).sort(), [SHARED_NOTE, "secondary-only.md"].sort());
  assert.match(JSON.stringify(stored.notes[SHARED_NOTE]), /secondary-only-marker/);

  await withServer(vaultScopeOf(map), async ({ ok }) => {
    await ok("reindex_vault", { embeddings: false });
    await drainAll(map);
    const primary = await ok("index_status", {});
    assert.equal(primary.path, PRIMARY_INDEX);
    assert.equal(primary.notes, 2);
  });
});

// -------------------------------------------------------------------------------------------------
// 3. §40 retrieval isolation: recall + reindex never cross Vaults
// -------------------------------------------------------------------------------------------------

test("§40: recall(vaultId) ranks this Vault's retrieval index only, and reindex A never clears B", async () => {
  const map = await newMap();
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    await ok("reindex_vault", { vaultId: SECONDARY, embeddings: false });
    await drainAll(map);
    const secondaryHit = await ok("recall", { vaultId: SECONDARY, query: SECONDARY_MARKER, semantic: false });
    assert.deepEqual(secondaryHit.results.map((item) => item.path), ["secondary-only.md"]);
    const secondaryMiss = await ok("recall", { vaultId: SECONDARY, query: PRIMARY_MARKER, semantic: false });
    assert.deepEqual(secondaryMiss.results, [], "the secondary retrieval must never read the primary index (§12)");

    await ok("reindex_vault", { embeddings: false, force: true });
    await drainAll(map);
    const primaryHit = await ok("recall", { query: PRIMARY_MARKER, semantic: false });
    assert.deepEqual(primaryHit.results.map((item) => item.path), ["primary-only.md"]);
    const primaryMiss = await ok("recall", { query: SECONDARY_MARKER, semantic: false });
    assert.deepEqual(primaryMiss.results, []);

    // Reindexing the primary did not clear the secondary's index state.
    const secondaryAfter = await ok("index_status", { vaultId: SECONDARY });
    assert.equal(secondaryAfter.notes, 2);
  });
});

// -------------------------------------------------------------------------------------------------
// 4. MV-I07 primary compatibility + MV-I02 no cross-Vault blocking at the tool layer
// -------------------------------------------------------------------------------------------------

test("§21 MV-I07: an omitted vaultId is byte-equivalent to the explicit primary Vault", async () => {
  const map = await newMap();
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const omitted = await ok("search_notes", { query: "alpha", semantic: false });
    const explicit = await ok("search_notes", { vaultId: DEFAULT_VAULT_ID, query: "alpha", semantic: false });
    assert.deepEqual(explicit.results, omitted.results);
    assert.equal(explicit.totalScanned, omitted.totalScanned);
  });
});

test("§21 MV-I02: concurrent primary + secondary reindex jobs stay independent", async () => {
  const map = await newMap();
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const [primaryJob, secondaryJob] = await Promise.all([
      ok("reindex_vault", { embeddings: false }),
      ok("reindex_vault", { vaultId: SECONDARY, embeddings: false }),
    ]);
    assert.notEqual(primaryJob.id, secondaryJob.id, "each Vault owns its own retrieval job (§12)");
    await drainAll(map);
    const primary = await ok("index_status", {});
    const secondary = await ok("index_status", { vaultId: SECONDARY });
    assert.equal(primary.notes, 2);
    assert.equal(secondary.notes, 2);
    assert.notEqual(primary.path, secondary.path);
  });
});

// -------------------------------------------------------------------------------------------------
// 5. Fail closed: no materialized runtime / unknown id => structured refusal, zero handler calls
// -------------------------------------------------------------------------------------------------

test("§47: an unknown vaultId is refused by the registrar and the handler never runs", async () => {
  let handlerCalls = 0;
  const server = new McpServer({ name: "mv-dsearch-scope", version: "0.0.0" });
  createVaultScopeRegistrar(server, { resolveVaultRuntime: () => undefined, vaultExists: () => false }).registerTool(
    "search_notes",
    { description: "counting probe on a canonical vault-scoped name", inputSchema: { query: z.string().optional() } },
    async () => { handlerCalls += 1; return { content: [{ type: "text", text: "{}" }] }; },
  );
  const client = new Client({ name: "mv-dsearch-scope", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const denied = await client.callTool({ name: "search_notes", arguments: { vaultId: "ghost", query: "alpha" } });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
    assert.equal(handlerCalls, 0, "the handler must not run for an unknown Vault");
  } finally {
    await client.close();
    await server.close();
  }
});

test("§47/SEC-MV06: a selected Vault without a materialized runtime is refused, never served by the primary index", async () => {
  const lostIndexBefore = await readFileOr(SECONDARY_INDEX);
  await withServer({ resolveVaultRuntime: () => undefined, vaultExists: () => true }, async ({ call, ok }) => {
    for (const [name, args] of [
      ["search_notes", { vaultId: SECONDARY, query: "alpha", semantic: false }],
      ["recall", { vaultId: SECONDARY, query: "alpha", semantic: false }],
      ["index_status", { vaultId: SECONDARY }],
      ["reindex_vault", { vaultId: SECONDARY, embeddings: false }],
      ["graph_health", { vaultId: SECONDARY }],
      ["list_notes", { vaultId: SECONDARY }],
      ["get_graph", { vaultId: SECONDARY }],
    ]) {
      const { isError, structured, raw } = await call(name, args);
      assert.equal(isError, true, `${name} must fail closed for a secondary selection without a runtime`);
      assert.equal(structured?.code, "vault_retrieval_unavailable", `${name}: ${raw.content?.[0]?.text}`);
      assert.equal(structured?.vaultId, SECONDARY);
      assert.equal(structured?.results, undefined, `${name} must not return another Vault's results`);
    }
    // The explicit primary selection still works (MV-I07) even though the resolver reports no
    // runtime for it: a primary selection is not a "broken secondary".
    const primary = await ok("search_notes", { vaultId: DEFAULT_VAULT_ID, query: "alpha", semantic: false });
    assert.deepEqual(primary.results.map((item) => item.path), [SHARED_NOTE]);
  });
  assert.equal(await readFileOr(SECONDARY_INDEX), lostIndexBefore, "a refused request performs zero Vault I/O");
});
