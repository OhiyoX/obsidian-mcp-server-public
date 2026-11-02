// Wave D / D-intelligence — real dual-Vault context / memory / skills matrix.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D "intelligence/context/memory/skills" module lane — run a REAL two-Vault matrix
//       through the real tools instead of assuming the shared foundation made them per-Vault;
//       never invent a second Vault selector;
//   §3.4 capabilities are runtime facts (flip a key only with a fully routed toolset);
//   §11/§12 per-Vault index/retrieval · §21 MV-I01/MV-I02/MV-I03/MV-I07 · §40 retrieval matrix ·
//   §47 (a selected Vault is never served by the primary runtime) · §10.1 request facade.
//
// Proven here: `get_note_context` (via `context-service.js`), `memory_capture` / `memory_recall`
// and `skill_list` / `skill_match` / `skill_validate` / `skill_export` / `skill_import` (via
// `skills.js`) resolve the *selected* Vault through `requestContext().vaultRuntime` + the
// `vault-runtime/request-vault.js` facade + the D-search search-runtime seam; a secondary read,
// write, index invalidation, retrieval sync and ZIP round-trip stay inside the secondary Vault;
// an omitted `vaultId` keeps the legacy primary behaviour; a selection with no materialized runtime,
// or one the caller is not authorized for, is refused structurally with zero Vault I/O and zero
// handler invocations.
//
// NOT proven here: the deterministic concurrency proof of MV-I01/I02 (it needs a controllable
// embedding provider and lives in `search-runtime-composition.test.js`); `server_info`'s per-Vault
// capability *projection* (§18.1), which needs the Wave F §31 single-registry convergence — this
// lane flips the runtime-map facts but does not own that projection. See HANDOFF §risks.
//
// Environment is assigned before the src modules are imported (`config.js` resolves at load).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-dintel-matrix-"));
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

const { MEMORY_PATH, SKILLS_PATH } = await import("../src/config.js");
const { primaryRuntime } = await import("../src/vault.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultRegistry } = await import("../src/vault-runtime/registry.js");
const { createVaultRuntimeMap } = await import("../src/vault-runtime/instances.js");
const { CAPABILITY_KEYS } = await import("../src/vault-runtime/descriptor.js");
const { WIRED_CAPABILITY_KEYS } = await import("../src/vault-runtime/capabilities.js");
const { createVaultScopeRegistrar, VAULT_SCOPE_DENY_CODES } = await import("../src/vault-scope-registrar.js");
const { requireRequestAuthor } = await import("../src/request-context.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { searchRuntimeFor, SEARCH_RUNTIME_REFUSED } = await import("../src/search-runtimes.js");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const existsPath = (abs) => fs.access(abs).then(() => true, () => false);

async function write(root, relative, content) {
  const abs = path.join(root, relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

/** Recursive `<rel>:sha256` listing (missing roots read as empty). Used for zero-side-effect proofs. */
async function treeSnapshot(root) {
  const entries = [];
  async function walk(current) {
    const dirents = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) await walk(abs);
      else entries.push(`${path.relative(root, abs).split(path.sep).join("/")}:${sha256(await fs.readFile(abs))}`);
    }
  }
  await walk(root);
  return entries;
}

const skillFile = (name, marker) => `---\nname: ${name}\ndescription: ${name} for the dual-Vault intelligence matrix ${marker}.\n---\n\n# ${name}\n\n${marker}\n`;
const memoryFile = (title, memoryKind, marker) => `---\ntitle: ${title}\ntype: memory\nmemory_kind: ${memoryKind}\n---\n# ${title}\n\n${marker}\n`;

// Same-named notes with different content per Vault, each staying inside its own Vault.
await write(PRIMARY_ROOT, "ctx/target.md", "---\ntitle: Primary Target\ntype: note\n---\n# Primary Target\n\nprimarycontexttoken\n");
await write(SECONDARY_ROOT, "ctx/target.md", "---\ntitle: Secondary Target\ntype: note\n---\n# Secondary Target\n\nsecondarycontexttoken\n");
await write(SECONDARY_ROOT, "ctx/backlink.md", "# Backlink\n\n[[target]]\n\nsecondarycontexttoken\n");
await write(PRIMARY_ROOT, `${MEMORY_PATH}/2026-01-01 Existing Memory.md`, memoryFile("Primary Existing Memory", "fact", "primarymemorytoken"));
await write(SECONDARY_ROOT, `${MEMORY_PATH}/2026-01-01 Existing Memory.md`, memoryFile("Secondary Existing Memory", "fact", "secondarymemorytoken"));
await write(PRIMARY_ROOT, `${SKILLS_PATH}/primary-skill/SKILL.md`, skillFile("primary-skill", "primaryskilltoken"));
await write(SECONDARY_ROOT, `${SKILLS_PATH}/secondary-skill/SKILL.md`, skillFile("secondary-skill", "secondaryskilltoken"));

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
async function withServer(vaultScope, callback, serverName = "mv-dintel-matrix") {
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

/** Build each Vault's index through the real tool so cached-index readers have a snapshot. */
async function indexBoth(map) {
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    await ok("reindex_vault", { vaultId: DEFAULT_VAULT_ID, embeddings: false });
    await ok("reindex_vault", { vaultId: SECONDARY, embeddings: false });
  });
  await drainAll(map);
}

test.after(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

// -------------------------------------------------------------------------------------------------
// 1. §29 context lane — the note context bundle follows the selected Vault
// -------------------------------------------------------------------------------------------------

test("§29 context lane: get_note_context reads only the selected Vault's note, backlinks and index", async () => {
  const map = await newMap();
  await indexBoth(map);
  const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const secondary = await ok("get_note_context", { vaultId: SECONDARY, path: "ctx/target.md" });
    assert.equal(secondary.status, "ok");
    assert.equal(secondary.items[0].metadata.title, "Secondary Target");
    assert.deepEqual(secondary.items.filter((item) => item.kind === "backlink").map((item) => item.path), ["ctx/backlink.md"]);
    const primary = await ok("get_note_context", { vaultId: DEFAULT_VAULT_ID, path: "ctx/target.md" });
    assert.equal(primary.items[0].metadata.title, "Primary Target");
    assert.deepEqual(primary.items.filter((item) => item.kind === "backlink"), [], "the primary must not see the secondary backlink");
  });
  assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "a secondary context read must leave the primary byte-identical");
  await drainAll(map);
});

// -------------------------------------------------------------------------------------------------
// 2. §29 memory lane — capture/recall stay inside the selected Vault
// -------------------------------------------------------------------------------------------------

test("§29 memory lane: memory_capture writes in the selected Vault and memory_recall never crosses Vaults", async () => {
  const map = await newMap();
  await indexBoth(map);
  const primaryMemoryBefore = await treeSnapshot(path.join(PRIMARY_ROOT, MEMORY_PATH));
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const captured = await ok("memory_capture", { vaultId: SECONDARY, title: "Secondary Captured Memory", content: "The secondary managed memory body has secondarycapturemarker.", kind: "fact" });
    assert.equal(captured.managedRoot, MEMORY_PATH);
    assert.ok(captured.path.startsWith(`${MEMORY_PATH}/`), captured.path);
    assert.equal(await existsPath(path.join(PRIMARY_ROOT, captured.path)), false, "no cross-Vault write");
    assert.match(await fs.readFile(path.join(SECONDARY_ROOT, captured.path), "utf8"), /secondarycapturemarker/);

    const secondaryRecall = await ok("memory_recall", { vaultId: SECONDARY, query: "secondarycapturemarker", semantic: false });
    assert.deepEqual(secondaryRecall.results.map((item) => item.path), [captured.path]);
    const primaryRecall = await ok("memory_recall", { vaultId: DEFAULT_VAULT_ID, query: "secondarycapturemarker", semantic: false });
    assert.deepEqual(primaryRecall.results, [], "a primary recall must not return the secondary memory");

    const secondaryExisting = await ok("memory_recall", { vaultId: SECONDARY, query: "secondarymemorytoken", semantic: false });
    assert.deepEqual(secondaryExisting.results.map((item) => item.path), [`${MEMORY_PATH}/2026-01-01 Existing Memory.md`]);
    const primaryExisting = await ok("memory_recall", { vaultId: DEFAULT_VAULT_ID, query: "primarymemorytoken", semantic: false });
    assert.deepEqual(primaryExisting.results.map((item) => item.path), [`${MEMORY_PATH}/2026-01-01 Existing Memory.md`]);
  });
  assert.deepEqual(await treeSnapshot(path.join(PRIMARY_ROOT, MEMORY_PATH)), primaryMemoryBefore, "the primary managed memory must not change");
  await drainAll(map);
});

// -------------------------------------------------------------------------------------------------
// 3. §29 skills lane — list/validate/export/import/match stay inside the selected Vault
// -------------------------------------------------------------------------------------------------

test("§29 skills lane: skill_list/validate/export/import/match resolve only the selected Vault", async () => {
  const map = await newMap();
  await indexBoth(map);
  const primarySkillsBefore = await treeSnapshot(path.join(PRIMARY_ROOT, SKILLS_PATH));
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const listed = await ok("skill_list", { vaultId: SECONDARY });
    assert.equal(listed.managedRoot, SKILLS_PATH);
    assert.deepEqual(listed.skills.map((item) => item.name), ["secondary-skill"]);
    const primaryListed = await ok("skill_list", { vaultId: DEFAULT_VAULT_ID });
    assert.deepEqual(primaryListed.skills.map((item) => item.name), ["primary-skill"]);

    const validated = await ok("skill_validate", { vaultId: SECONDARY, path: "secondary-skill" });
    assert.equal(validated.valid, true);
    assert.equal(validated.path, `${SKILLS_PATH}/secondary-skill`);

    const matched = await ok("skill_match", { vaultId: SECONDARY, query: "secondary vault skill dual matrix", semantic: false });
    assert.ok(matched.matches.some((item) => item.skill === "secondary-skill"), "the secondary package must match");
    assert.ok(!matched.matches.some((item) => item.skill === "primary-skill"), "the primary package must be invisible");
    assert.equal(matched.executionAuthorized, false);

    const exported = await ok("skill_export", { vaultId: SECONDARY, skill: "secondary-skill" });
    assert.equal(exported.path, `${SKILLS_PATH}/_packages/secondary-skill.zip`);
    assert.ok(await existsPath(path.join(SECONDARY_ROOT, exported.path)), "the ZIP must land in the secondary Vault");
    assert.equal(await existsPath(path.join(PRIMARY_ROOT, exported.path)), false, "no cross-Vault ZIP");

    const incoming = `${SKILLS_PATH}/_packages/incoming.zip`;
    await fs.mkdir(path.dirname(path.join(SECONDARY_ROOT, incoming)), { recursive: true });
    await fs.writeFile(path.join(SECONDARY_ROOT, incoming), Buffer.from(zipSync({ "imported-skill/SKILL.md": new TextEncoder().encode(skillFile("imported-skill", "importedskilltoken")) })));
    const imported = await ok("skill_import", { vaultId: SECONDARY, archivePath: incoming, dryRun: false });
    assert.equal(imported.destination, `${SKILLS_PATH}/imported-skill`);
    assert.ok(await existsPath(path.join(SECONDARY_ROOT, imported.destination, "SKILL.md")));
    assert.equal(await existsPath(path.join(PRIMARY_ROOT, imported.destination)), false, "no cross-Vault import");
  });
  assert.deepEqual(await treeSnapshot(path.join(PRIMARY_ROOT, SKILLS_PATH)), primarySkillsBefore, "the primary managed Skills area must not change");
  await drainAll(map);
});

// -------------------------------------------------------------------------------------------------
// 4. §21 MV-I07 — an omitted vaultId keeps the legacy primary behaviour
// -------------------------------------------------------------------------------------------------

test("§21 MV-I07: omitting vaultId keeps the legacy primary behaviour for the lane's tools", async () => {
  const map = await newMap();
  await indexBoth(map);
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    assert.deepEqual(await ok("skill_list", {}), await ok("skill_list", { vaultId: DEFAULT_VAULT_ID }));
    assert.deepEqual(
      await ok("memory_recall", { query: "primarymemorytoken", semantic: false }),
      await ok("memory_recall", { vaultId: DEFAULT_VAULT_ID, query: "primarymemorytoken", semantic: false }),
    );
    const implicit = await ok("get_note_context", { path: "ctx/target.md" });
    assert.deepEqual(implicit, await ok("get_note_context", { vaultId: DEFAULT_VAULT_ID, path: "ctx/target.md" }));
    assert.equal(implicit.items[0].metadata.title, "Primary Target");
  });
  await drainAll(map);
});

// -------------------------------------------------------------------------------------------------
// 5. §47 — an unmaterialized Vault selection is refused, never served by the primary
// -------------------------------------------------------------------------------------------------

test("§47: an unmaterialized Vault selection is refused structurally with zero Vault I/O", async () => {
  const map = await newMap();
  await indexBoth(map);
  const secondaryBefore = await treeSnapshot(SECONDARY_ROOT);

  // (a) registrar level: an id the inventory does not know never reaches a handler.
  let handlerRuns = 0;
  const probe = new McpServer({ name: "mv-dintel-refusal", version: "0.0.0" });
  createVaultScopeRegistrar(probe, { resolveVaultRuntime: (id) => map.get(id), vaultExists: () => false })
    .registerTool("skill_list", { description: "Wave D / D-intelligence refusal probe.", inputSchema: {} }, () => {
      handlerRuns += 1;
      return { content: [{ type: "text", text: "{}" }], structuredContent: {} };
    });
  const probeClient = new Client({ name: "mv-dintel-refusal", version: "0.0.0" });
  const [probeClientTransport, probeServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([probe.connect(probeServerTransport), probeClient.connect(probeClientTransport)]);
  try {
    const denied = await probeClient.callTool({ name: "skill_list", arguments: { vaultId: "no-such-vault" } });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
    assert.equal(handlerRuns, 0, "an unknown Vault must never reach the handler (§47)");
  } finally {
    await probeClient.close();
    await probe.close();
  }

  // (b) resolver level: a known Vault with no materialized runtime refuses inside the lane's tools.
  const laneTools = [
    ["get_note_context", { path: "ctx/target.md" }],
    ["memory_capture", { title: "Refused", content: "refused body" }],
    ["skill_list", {}],
    ["skill_match", { query: "anything" }],
    ["skill_validate", { path: "secondary-skill" }],
    ["skill_export", { skill: "secondary-skill" }],
    ["skill_import", { archivePath: `${SKILLS_PATH}/_packages/missing.zip` }],
  ];
  await withServer(
    { resolveVaultRuntime: (id) => (id === DEFAULT_VAULT_ID ? primaryRuntime : undefined), vaultExists: () => true },
    async ({ call }) => {
      for (const [name, args] of laneTools) {
        const result = await call(name, { ...args, vaultId: SECONDARY });
        assert.equal(result.isError, true, `${name} must refuse an unmaterialized Vault`);
        assert.equal(result.structured.code, SEARCH_RUNTIME_REFUSED, `${name} must carry the structured refusal`);
        assert.equal(result.structured.vaultId, SECONDARY);
      }
      const primary = await call("skill_list", { vaultId: DEFAULT_VAULT_ID });
      assert.equal(primary.isError, false, "the materialized primary still serves the lane");
    },
  );
  assert.deepEqual(await treeSnapshot(SECONDARY_ROOT), secondaryBefore, "refusals must perform zero Vault I/O");
  await drainAll(map);
});

// -------------------------------------------------------------------------------------------------
// 5b. §34/§47 — an unauthorized Vault selection is refused before the handler runs
// -------------------------------------------------------------------------------------------------

test("§34/§47: an unauthorized Vault selection is refused before any handler runs", async () => {
  const map = await newMap();
  let handlerRuns = 0;
  const handlers = new Map();
  const shell = {
    server: {},
    getClientVersion: () => undefined,
    registerTool(name, config, handler) {
      handlers.set(name, { config, handler });
      return { name };
    },
  };
  createVaultScopeRegistrar(shell, vaultScopeOf(map)).registerTool(
    "memory_capture",
    { description: "Wave D / D-intelligence authorization probe.", inputSchema: {} },
    () => { handlerRuns += 1; return { content: [{ type: "text", text: "{}" }], structuredContent: {} }; },
  );
  const denied = await handlers.get("memory_capture").handler({ vaultId: SECONDARY }, { authInfo: { allowedVaults: [DEFAULT_VAULT_ID] } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.code, VAULT_SCOPE_DENY_CODES.ACCESS_DENIED);
  assert.equal(handlerRuns, 0, "an unauthorized Vault must never reach the handler (§34/§47)");
});

// -------------------------------------------------------------------------------------------------
// 6. §3.4 — memory/skills are flipped only together with a fully routed toolset
// -------------------------------------------------------------------------------------------------

test("§3.4: the memory and skills capabilities are flipped only with routed tools", async () => {
  const map = await newMap();
  const capabilities = map.get(SECONDARY).capabilities;
  for (const key of ["memory", "skills"]) {
    assert.ok(WIRED_CAPABILITY_KEYS.includes(key), `${key} is flipped by this lane`);
    assert.deepEqual(capabilities[key], { available: true }, `${key} must be reported available`);
  }
  for (const key of CAPABILITY_KEYS) {
    if (WIRED_CAPABILITY_KEYS.includes(key)) continue;
    assert.equal(capabilities[key].available, false, `${key} is not wired by this lane and must stay fail closed (§3.4)`);
    assert.ok(capabilities[key].reason.length > 0, `${key} must carry a visible reason`);
  }
  // The flipped keys must correspond to modules that really consume the request runtime — a key
  // flipped while a module still reads the primary facade is exactly the over-claim this guards.
  const source = (relative) => fs.readFile(path.join(APP_ROOT, relative), "utf8");
  const skillsSource = await source("src/skills.js");
  assert.ok(skillsSource.includes("vault-runtime/request-vault.js"), "src/skills.js must consume the request runtime");
  assert.doesNotMatch(skillsSource, /from "\.\/vault\.js"/, "src/skills.js must not import the primary facade");
  const contextSource = await source("src/context-service.js");
  assert.ok(contextSource.includes("vault-runtime/request-vault.js"), "src/context-service.js must consume the request runtime");
  assert.ok(contextSource.includes("./search-runtimes.js"), "src/context-service.js must consume the per-Vault search runtime");
  assert.doesNotMatch(contextSource, /from "\.\/vault-index\.js"|from "\.\/vault\.js"/, "src/context-service.js must not read the primary index facade");
  const intelligenceSource = await source("src/tools/intelligence.js");
  assert.ok(intelligenceSource.includes("vault-runtime/request-vault.js"), "src/tools/intelligence.js must consume the request runtime");
  assert.doesNotMatch(intelligenceSource, /from "\.\.\/vault\.js"|from "\.\.\/vault-index\.js"/, "the memory/skills tools must not read the primary facade");
  assert.doesNotMatch(intelligenceSource, /[^.\w]invalidateVaultIndex\(|[^.\w]syncRetrievalIndex\(/, "the memory write must invalidate/sync this Vault's runtime, not the facade");
  assert.ok(intelligenceSource.includes("runtime.index.invalidate(") && intelligenceSource.includes("runtime.retrieval.syncRetrievalIndex("), "memory_capture must move this Vault's index/retrieval state");
  assert.ok(intelligenceSource.includes("resolveSearchRuntime().retrieval.recall("), "skill_match must rank this Vault's chunks");
  assert.ok((await source("src/tools/context.js")).includes("refusalForError"), "get_note_context must surface the structured refusal");
  await drainAll(map);
});

// -------------------------------------------------------------------------------------------------
// 7. §21 MV-I02 — concurrent lane writes stay inside their own Vault
// -------------------------------------------------------------------------------------------------

test("§21 MV-I01/MV-I02: concurrent memory captures serialize per Vault and never cross Vaults", async () => {
  const map = await newMap();
  await indexBoth(map);
  await withServer(vaultScopeOf(map), async ({ ok }) => {
    const [primary, secondary] = await Promise.all([
      ok("memory_capture", { vaultId: DEFAULT_VAULT_ID, title: "Primary Concurrent Memory", content: "primaryconcurrentmarker" }),
      ok("memory_capture", { vaultId: SECONDARY, title: "Secondary Concurrent Memory", content: "secondaryconcurrentmarker" }),
    ]);
    assert.ok(await existsPath(path.join(PRIMARY_ROOT, primary.path)));
    assert.ok(await existsPath(path.join(SECONDARY_ROOT, secondary.path)));
    assert.equal(await existsPath(path.join(PRIMARY_ROOT, secondary.path)), false, "no cross-Vault write");
    assert.equal(await existsPath(path.join(SECONDARY_ROOT, primary.path)), false, "no cross-Vault write");
  });
  await drainAll(map);
});
