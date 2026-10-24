// Wave D / D-workflows — real dual-Vault matrix for the workflows / Bases toolset.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D — run a REAL two-Vault matrix per toolset instead of assuming the changed
//       foundation made every tool per-Vault; never invent a second Vault selector;
//   §10.1 the request-scoped runtime seam · §11 the per-Vault VaultIndex is the Base query's
//       record source · §3.4 capability is a runtime fact · §21 MV-I02/MV-I03/MV-I07 ·
//   §37 a mutation of Vault A must not move Vault B's index generation ·
//   §43-5 facade allowlist · §47 RETURN list (no secondary → primary fallback).
//
// Driven here: the production tools themselves (`registerObsidianCapabilities` → C's vault-scope
// registrar → A4's context patch) over the real MCP SDK, against a real primary + secondary Vault
// pair carrying same-named, different-content `.base` documents and notes. Every assertion is an
// on-disk fact or a per-Vault instance identity, not a handler self-report.
//
// NOT proven here (declared, not implied): no new capability key is flipped by this lane (see
// `test/workflow-runtime-routing.test.js` §3.4); the Base *domain* service (`src/base-query.js`) and
// the Web Base route (`src/app/base-*.js`) are out of scope — the Web face keeps its own routing
// (contract §29: Web 面的 Bases 路由不在本刀).
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

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-dworkflows-matrix-"));
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
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

const note = (frontmatter, body = "") =>
  `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n${body}`;
// Same file names, different content on purpose: a routing mistake cannot be hidden by a path.
const SHARED_BASE = (viewName, direction) =>
  `filters: file.inFolder("notes")\nviews:\n  - type: table\n    name: ${viewName}\n    order:\n      - file.path\n      - marker\n    sort:\n      - property: file.path\n        direction: ${direction}\n`;
const FIXTURES = {
  [path.join(PRIMARY_ROOT, "notes", "alpha.md")]: note({ marker: "pri-alpha", status: "active" }, "# Primary alpha\n\n- [ ] pri-task\n"),
  [path.join(PRIMARY_ROOT, "notes", "beta.md")]: note({ marker: "pri-beta", status: "active", aliases: "[PriBeta]" }, "# Primary beta\n"),
  [path.join(PRIMARY_ROOT, "bases", "shared.base")]: SHARED_BASE("PRIMARY_VIEW", "DESC"),
  [path.join(PRIMARY_ROOT, "bases", "primary-only.base")]: 'filters: file.inFolder("notes")\n',
  [path.join(SECONDARY_ROOT, "notes", "alpha.md")]: note({ marker: "sec-alpha", status: "active" }, "# Secondary alpha\n\n- [ ] sec-task\n"),
  [path.join(SECONDARY_ROOT, "notes", "beta.md")]: note({ marker: "sec-beta", status: "active", aliases: "[SecBeta]" }, "# Secondary beta\n"),
  [path.join(SECONDARY_ROOT, "bases", "shared.base")]: SHARED_BASE("SECONDARY_VIEW", "ASC"),
  [path.join(SECONDARY_ROOT, "bases", "secondary-only.base")]: 'filters: file.inFolder("notes")\n',
};
for (const [absolute, content] of Object.entries(FIXTURES)) {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}
await fs.mkdir(DATA_ROOT, { recursive: true });

const { primaryRuntime } = await import("../src/vault.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultRegistry } = await import("../src/vault-runtime/registry.js");
const { createVaultRuntimeMap } = await import("../src/vault-runtime/instances.js");
const { primaryIndexRuntime } = await import("../src/vault-index.js");
const { searchRuntimeFor } = await import("../src/search-runtimes.js");
const { resolveWorkflowRuntime, refusalForError } = await import("../src/workflow-runtimes.js");
const { createVaultScopeRegistrar, VAULT_SCOPE_DENY_CODES } = await import("../src/vault-scope-registrar.js");
const { withRequestContext, withRequestContextPatch } = await import("../src/request-context.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");

const AUTHOR = Object.freeze({ agent: "mv-dworkflows-matrix", model: "test" });

const newMap = async () => {
  const map = createVaultRuntimeMap({
    registry: createVaultRegistry({ primaryRoot: PRIMARY_ROOT, primaryId: DEFAULT_VAULT_ID, vaultsRoot: VAULTS_ROOT, writable: true }),
    dataRoot: DATA_ROOT,
    primaryRuntime,
    deps: { requireRequestAuthor: () => AUTHOR },
  });
  await map.refresh();
  return map;
};
/** The exact pair server.js injects into C's registrar: one authority, no fork. */
const vaultScopeOf = (map) => ({ resolveVaultRuntime: (id) => map.get(id), vaultExists: (id) => map.has(id) });

async function treeSnapshot(root, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const abs = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await treeSnapshot(abs, relative)));
    else out.push(`${relative}:${(await fs.stat(abs)).size}:${createHash("sha256").update(await fs.readFile(abs)).digest("hex")}`);
  }
  return out;
}
const exists = (absPath) => fs.access(absPath).then(() => true, () => false);

/** A real MCP server: the production capability registration behind C's vault-scope registrar. */
async function toolClient(map, { vaultScope = vaultScopeOf(map) } = {}) {
  const server = new McpServer({ name: "mv-dworkflows-matrix", version: "0.0.0" });
  registerObsidianCapabilities(server, { vaultScope });
  const client = new Client({ name: "mv-dworkflows-matrix", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const raw = (name, args = {}) => withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name, arguments: args }));
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    assert.notEqual(result.isError, true, `${name} failed: ${result.content?.[0]?.text}`);
    return result.structuredContent;
  };
  return { raw, call, close: async () => { await client.close(); await server.close(); } };
}
/** Row projection of one Base query: `{path, values}` — `values` is keyed by property name. */
const rowsOf = (payload) => payload.rows.map((row) => ({ path: row.path, marker: row.values.marker }));

// ---------------------------------------------------------------------------------------
// 1. §29 workflows/Bases lane — same-named Bases and notes resolve inside the selected Vault
// ---------------------------------------------------------------------------------------

test("§29 workflows/Bases lane: vaultId=secondary reads only the secondary Base and corpus", async () => {
  const map = await newMap();
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime, "the primary instance must stay the src/vault.js instance");
  const secondaryRuntime = map.get(SECONDARY);
  assert.notEqual(secondaryRuntime.localFs, primaryRuntime.localFs, "SEC-MV06: the secondary owns its filesystem service");
  assert.notEqual(searchRuntimeFor(secondaryRuntime).index, primaryIndexRuntime, "the secondary must own its index instance");

  const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
  const sessions = await toolClient(map);
  try {
    // the same file name returns each Vault's own document (view name + raw bytes)
    const secondaryBase = await sessions.call("get_base", { vaultId: SECONDARY, path: "bases/shared.base" });
    assert.equal(secondaryBase.path, "bases/shared.base");
    assert.equal(secondaryBase.valid, true);
    assert.match(secondaryBase.raw, /SECONDARY_VIEW/);
    assert.doesNotMatch(secondaryBase.raw, /PRIMARY_VIEW/, "get_base must never read the primary Vault's Base");
    const primaryBase = await sessions.call("get_base", { vaultId: DEFAULT_VAULT_ID, path: "bases/shared.base" });
    assert.match(primaryBase.raw, /PRIMARY_VIEW/);
    assert.doesNotMatch(primaryBase.raw, /SECONDARY_VIEW/);

    // the Base query evaluates against this Vault's own records
    const secondaryRows = await sessions.call("query_base", { vaultId: SECONDARY, path: "bases/shared.base" });
    assert.equal(secondaryRows.view, "SECONDARY_VIEW", "the selected view comes from the selected Vault's Base");
    assert.deepEqual(rowsOf(secondaryRows), [
      { path: "notes/alpha.md", marker: "sec-alpha" },
      { path: "notes/beta.md", marker: "sec-beta" },
    ]);
    assert.equal(secondaryRows.totalMatched, 2, "only the secondary corpus is visible");
    assert.equal(secondaryRows.index.files, 2, "the secondary index enumerates the secondary Vault only");
    const primaryRows = await sessions.call("query_base", { vaultId: DEFAULT_VAULT_ID, path: "bases/shared.base" });
    assert.equal(primaryRows.view, "PRIMARY_VIEW");
    assert.deepEqual(rowsOf(primaryRows).map((row) => row.marker), ["pri-beta", "pri-alpha"], "the primary view keeps its own DESC sort");
    assert.equal(primaryRows.index.files, 2);

    // discovery: each Vault lists its own .base documents
    const secondaryBases = (await sessions.call("list_bases", { vaultId: SECONDARY })).bases.map((entry) => entry.path);
    assert.deepEqual(secondaryBases, ["bases/secondary-only.base", "bases/shared.base"]);
    const primaryBases = (await sessions.call("list_bases", { vaultId: DEFAULT_VAULT_ID })).bases.map((entry) => entry.path);
    assert.deepEqual(primaryBases, ["bases/primary-only.base", "bases/shared.base"]);
  } finally {
    await sessions.close();
  }
  assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "reading a secondary Vault must leave the primary tree byte-identical");
});

// ---------------------------------------------------------------------------------------
// 2. §29 — a write through the workflows face stays inside the selected Vault
// ---------------------------------------------------------------------------------------

test("§29 workflows lane: write_base lands in the selected Vault and never in the primary one", async () => {
  const map = await newMap();
  const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
  const sessions = await toolClient(map);
  try {
    const written = await sessions.call("write_base", {
      vaultId: SECONDARY,
      path: "bases/written.base",
      base: { filters: 'file.inFolder("notes")', views: [{ type: "table", name: "WRITTEN", order: ["file.path"] }] },
    });
    assert.equal(written.path, "bases/written.base");
    assert.equal(written.created, true);
    assert.match(await fs.readFile(path.join(SECONDARY_ROOT, "bases", "written.base"), "utf8"), /WRITTEN/);
    assert.equal(await exists(path.join(PRIMARY_ROOT, "bases", "written.base")), false, "no cross-Vault write");
    assert.deepEqual((await sessions.call("list_bases", { vaultId: SECONDARY })).bases.map((entry) => entry.path), [
      "bases/secondary-only.base",
      "bases/shared.base",
      "bases/written.base",
    ]);
    // an invalid Base still fails closed, and the failure does not touch the primary Vault
    const invalid = await sessions.raw("write_base", { vaultId: SECONDARY, path: "bases/bad.base", base: { views: "not-an-array" } });
    assert.equal(invalid.isError, true, "canonical Base validation must still fail closed");
    assert.match(invalid.content[0].text, /views must be an array/);
    assert.equal(await exists(path.join(SECONDARY_ROOT, "bases", "bad.base")), false, "an invalid Base must not be written");
  } finally {
    await sessions.close();
  }
  assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "a secondary write must not modify the primary tree");
});

// ---------------------------------------------------------------------------------------
// 3. §21 MV-I07 — no vaultId keeps the legacy primary semantics
// ---------------------------------------------------------------------------------------

test("§21 MV-I07: without vaultId the workflows/Bases face stays on the primary Vault", async () => {
  const map = await newMap();
  const secondaryBefore = await treeSnapshot(SECONDARY_ROOT);
  const sessions = await toolClient(map);
  try {
    const omitted = await sessions.call("query_base", { path: "bases/shared.base" });
    const explicit = await sessions.call("query_base", { vaultId: DEFAULT_VAULT_ID, path: "bases/shared.base" });
    assert.equal(omitted.view, "PRIMARY_VIEW");
    // the `index` block carries per-build freshness stats, so compare the semantic payload
    const semantic = ({ index, ...rest }) => { assert.equal(index.files, 2); return rest; };
    assert.deepEqual(semantic(omitted), semantic(explicit), "an omitted vaultId must equal an explicit primary vaultId (MV-I07)");
    assert.deepEqual((await sessions.call("list_bases", {})).bases.map((entry) => entry.path), ["bases/primary-only.base", "bases/shared.base"]);
  } finally {
    await sessions.close();
  }
  assert.deepEqual(await treeSnapshot(SECONDARY_ROOT), secondaryBefore, "a primary request must not touch the secondary tree");
});

// ---------------------------------------------------------------------------------------
// 4. §11/§37 — the index readers follow the selected Vault; A's write never moves B's index
// ---------------------------------------------------------------------------------------

test("§11/§37: index-backed workflows tools read the selected Vault and invalidate only it", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  const secondaryIndex = searchRuntimeFor(secondaryRuntime).index;
  const routed = await withRequestContext(
    { author: AUTHOR, vaultId: SECONDARY, vaultRuntime: secondaryRuntime },
    async () => resolveWorkflowRuntime(),
  );
  assert.equal(routed.index, secondaryIndex, "the handler seam must reuse the one per-Vault index instance");
  assert.equal(routed.localFs, secondaryRuntime.localFs);

  const sessions = await toolClient(map);
  try {
    const tasks = await sessions.call("list_tasks", { vaultId: SECONDARY, query: "task" });
    assert.equal(tasks.tasks.length, 1, "only the secondary Vault has a task");
    assert.equal(tasks.tasks[0].text, "sec-task");
    const properties = await sessions.call("list_properties", { vaultId: SECONDARY });
    assert.deepEqual(properties.properties.map((entry) => entry.name), ["aliases", "marker", "status"]);
    assert.equal(properties.properties.find((entry) => entry.name === "marker").count, 2);
    assert.deepEqual((await sessions.call("list_aliases", { vaultId: SECONDARY })).aliases, [{ alias: "SecBeta", path: "notes/beta.md" }]);

    const primaryBefore = { generation: primaryIndexRuntime.generation, revision: primaryIndexRuntime.publicationRevision };
    const secondaryGenerationBefore = secondaryIndex.generation;
    const updated = await sessions.call("update_task", {
      vaultId: SECONDARY,
      ref: `${tasks.tasks[0].path}:${tasks.tasks[0].line}`,
      status: "done",
    });
    assert.equal(updated.status, "x");
    assert.match(await fs.readFile(path.join(SECONDARY_ROOT, "notes", "alpha.md"), "utf8"), /- \[x\] sec-task/);
    assert.ok(secondaryIndex.generation > secondaryGenerationBefore, "the written Vault's index generation must advance");
    assert.equal(primaryIndexRuntime.generation, primaryBefore.generation, "§37: A's mutation must not move B's index generation");
    assert.equal(primaryIndexRuntime.publicationRevision, primaryBefore.revision, "§37: A's mutation must not republish B's index");
  } finally {
    await sessions.close();
  }
});

// ---------------------------------------------------------------------------------------
// 5. §21 MV-I02 — two Vaults query concurrently without blocking or bleeding
// ---------------------------------------------------------------------------------------

test("§21 MV-I02: concurrent queries on two Vaults keep their own index and corpus", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  const secondaryIndex = searchRuntimeFor(secondaryRuntime).index;
  const sessions = await toolClient(map);
  try {
    const startedAt = Date.now();
    const [secondary, primary] = await Promise.all([
      sessions.call("query_base", { vaultId: SECONDARY, path: "bases/shared.base" }),
      sessions.call("query_base", { vaultId: DEFAULT_VAULT_ID, path: "bases/shared.base" }),
    ]);
    assert.ok(Date.now() - startedAt < 5_000, "cross-Vault queries must not serialize behind each other");
    assert.equal(secondary.view, "SECONDARY_VIEW");
    assert.equal(primary.view, "PRIMARY_VIEW");
    assert.notEqual(secondaryIndex, primaryIndexRuntime);
    const secondaryRecords = (await secondaryIndex.getVaultIndex()).records;
    assert.deepEqual(secondaryRecords.map((record) => record.frontmatter.marker), ["sec-alpha", "sec-beta"]);
    assert.deepEqual((await primaryIndexRuntime.getVaultIndex()).records.map((record) => record.frontmatter.marker), ["pri-alpha", "pri-beta"]);
  } finally {
    await sessions.close();
  }
});

// ---------------------------------------------------------------------------------------
// 6. §47 — a Vault without a materialized runtime is refused structurally, never served
// ---------------------------------------------------------------------------------------

test("§47: an unmaterialized or unknown Vault is refused before the handler runs", async () => {
  const map = await newMap();
  assert.equal(map.release(SECONDARY), true, "drop the secondary so the map no longer materializes it");
  assert.equal(map.get(SECONDARY), undefined, "an unmaterialized id must never resolve to the primary runtime");

  let handlerRuns = 0;
  const server = new McpServer({ name: "mv-dworkflows-refusal", version: "0.0.0" });
  createVaultScopeRegistrar(server, vaultScopeOf(map)).registerTool("query_base", {
    description: "Wave D / D-workflows refusal probe on a canonical vault-scoped name.",
    inputSchema: { path: z.string() },
  }, () => { handlerRuns += 1; return { content: [{ type: "text", text: "{}" }], structuredContent: {} }; });
  const client = new Client({ name: "mv-dworkflows-refusal", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const probe = async (vaultId) => {
    const result = await withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name: "query_base", arguments: { vaultId, path: "bases/shared.base" } }));
    return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
  };
  try {
    for (const vaultId of [SECONDARY, "no-such-vault"]) {
      const denied = await probe(vaultId);
      assert.equal(denied.isError, true);
      assert.equal(denied.payload.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
      assert.equal(handlerRuns, 0, "the handler must not run for a Vault without a runtime (§47)");
    }
    await probe(DEFAULT_VAULT_ID);
    assert.equal(handlerRuns, 1, "the materialized primary Vault still serves the tool");
  } finally {
    await client.close();
    await server.close();
  }

  // resolver-level: the registrar knows the id but this process has no runtime for it
  const secondaryBefore = await treeSnapshot(SECONDARY_ROOT);
  const orphan = await toolClient(map, { vaultScope: { resolveVaultRuntime: (id) => (id === DEFAULT_VAULT_ID ? primaryRuntime : undefined), vaultExists: () => true } });
  try {
    for (const name of ["get_base", "list_bases", "query_base", "list_properties"]) {
      const result = await orphan.raw(name, { vaultId: SECONDARY, path: "bases/shared.base" });
      assert.equal(result.isError, true, `${name} must fail closed for a selection without a runtime`);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.code, "vault_unavailable", `${name} must answer with the structured refusal`);
      assert.equal(payload.vaultId, SECONDARY);
    }
    await orphan.call("list_bases", { vaultId: DEFAULT_VAULT_ID });
  } finally {
    await orphan.close();
  }
  assert.deepEqual(await treeSnapshot(SECONDARY_ROOT), secondaryBefore, "a refused call must perform no Vault I/O");
  assert.equal(map.get(SECONDARY), undefined, "a refused selection must not materialize a runtime");
  assert.equal(primaryIndexRuntime.vaultId, DEFAULT_VAULT_ID, "the primary index instance stays the process one");
});

// ---------------------------------------------------------------------------------------
// 7. §47 — the resolver's own refusal contract is machine-readable
// ---------------------------------------------------------------------------------------

test("§47: resolveWorkflowRuntime never falls back to the primary Vault and refusal is structured", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  const noRuntime = await withRequestContext({ author: AUTHOR, vaultId: SECONDARY }, async () => {
    try {
      resolveWorkflowRuntime();
      return null;
    } catch (error) {
      return error;
    }
  });
  assert.equal(noRuntime?.code, "vault_unavailable");
  assert.equal(noRuntime?.vaultId, SECONDARY);
  const refusal = refusalForError(noRuntime);
  assert.deepEqual(refusal.structuredContent, { code: "vault_unavailable", vaultId: SECONDARY });
  assert.equal(refusal.isError, true);
  assert.equal(refusalForError(new Error("unrelated")), null, "only this seam's codes are turned into refusals");

  // no Vault selection keeps the legacy primary identity (MV-I07)
  const legacy = await withRequestContext({ author: AUTHOR }, () => resolveWorkflowRuntime());
  assert.equal(legacy.localFs, primaryRuntime.localFs);
  assert.equal(legacy.index, primaryIndexRuntime);
  // a materialized secondary resolves to its own instance, never the primary one
  const routed = await withRequestContext({ author: AUTHOR, vaultId: SECONDARY, vaultRuntime: secondaryRuntime }, () => resolveWorkflowRuntime());
  assert.equal(routed.index, searchRuntimeFor(secondaryRuntime).index);
  assert.notEqual(routed.index, primaryIndexRuntime);
});

// ---------------------------------------------------------------------------------------
// 8. §10.1/§29/§47 — `create_base_entry` (#630) is the BEHAVIOURAL guard for the per-request
// runtime. The text pins in `test/workflow-runtime-routing.test.js` are a lint: they can only
// see where `resolveWorkflowRuntime()` is written, so a handler that resolves inside its body
// but CACHES the result on a module-scope binding serves the first request's Vault to every
// later request while keeping the lint green (review r3, NC5). What is asserted here instead is
// the observable fact the seam exists for: the SECOND call in one process, in a different Vault,
// must land in that second Vault. The order below is deliberate — secondary first — because that
// is the order in which a process-wide cached runtime does the damage.
// ---------------------------------------------------------------------------------------

test("§10.1/§29: create_base_entry (#630) writes into the CURRENT request's Vault, never the first one's", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  const secondaryIndex = searchRuntimeFor(secondaryRuntime).index;
  const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
  const secondaryGenerationBefore = secondaryIndex.generation;
  const sessions = await toolClient(map);
  try {
    // (1) the request selects the SECONDARY Vault: the note must land in the secondary Vault,
    // derived from the secondary's own same-named `.base`, and the primary tree must not move.
    const secondaryCreate = await sessions.call("create_base_entry", {
      vaultId: SECONDARY,
      path: "bases/shared.base",
      file: "routed-from-secondary.md",
      values: { marker: "sec-created" },
    });
    assert.equal(secondaryCreate.created, true);
    assert.equal(secondaryCreate.path, "notes/routed-from-secondary.md", "the note lands in the derived folder of the selected Vault's Base");
    assert.equal(secondaryCreate.basePath, "bases/shared.base");
    assert.equal(secondaryCreate.folderSource, "view-filters");
    const secondaryNote = await fs.readFile(path.join(SECONDARY_ROOT, "notes", "routed-from-secondary.md"), "utf8");
    assert.match(secondaryNote, /marker: sec-created/);
    assert.equal(await exists(path.join(PRIMARY_ROOT, "notes", "routed-from-secondary.md")), false, "SEC-MV06: a secondary create must not write the primary Vault");
    assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "a secondary create must leave the primary tree byte-identical");
    assert.ok(secondaryIndex.generation > secondaryGenerationBefore, "§11: the written Vault's index generation must advance");
    const secondaryRows = await sessions.call("query_base", { vaultId: SECONDARY, path: "bases/shared.base" });
    assert.ok(
      rowsOf(secondaryRows).some((row) => row.path === "notes/routed-from-secondary.md" && row.marker === "sec-created"),
      "the new entry must be visible to the very index query_base reads in this Vault",
    );

    // (2) then the PRIMARY Vault, in the SAME process. A module-scope cache of the resolved
    // runtime is exactly what makes this second call land in the first Vault instead.
    const primaryCreate = await sessions.call("create_base_entry", {
      path: "bases/shared.base",
      file: "routed-from-primary.md",
      values: { marker: "pri-created" },
    });
    assert.equal(primaryCreate.path, "notes/routed-from-primary.md");
    const primaryNote = await fs.readFile(path.join(PRIMARY_ROOT, "notes", "routed-from-primary.md"), "utf8");
    assert.match(primaryNote, /marker: pri-created/);
    assert.equal(await exists(path.join(SECONDARY_ROOT, "notes", "routed-from-primary.md")), false, "a primary create must not write the secondary Vault");
    assert.deepEqual(
      (await sessions.call("list_bases", { vaultId: DEFAULT_VAULT_ID })).bases.map((entry) => entry.path),
      ["bases/primary-only.base", "bases/shared.base"],
      "the primary's own Base inventory is the one that serves an unselected/primary create",
    );
  } finally {
    await sessions.close();
  }
});

// 8b. §10.1/§29 — the stronger half of the same fact: "current" is not "the first runtime this
// process ever saw for this vaultId". `src/vault-runtime/instances.js` REPLACES a Vault's runtime
// instance when its descriptor changes (`descriptorKey`, §3.4) and releases it on `release()`; the
// map's own `align()` re-materializes such a Vault on the next commit. A module-scope
// `Map<vaultId, runtime>` — the shape review r4 injected as NC6, under which every assertion above
// and every text pin in `test/workflow-runtime-routing.test.js` stayed green — hands the SECOND
// create the retired handle of the first one. That is observable only here: same Vault, two runtime
// generations, one process.
test("§10.1/§29: create_base_entry re-reads the runtime after a Vault is re-materialized (no module-scope cache survives)", async () => {
  const map = await newMap();
  const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
  const sessions = await toolClient(map);
  try {
    // (1) the first create is served by the secondary's FIRST runtime generation. `SECONDARY_VIEW`
    // is a view only the secondary's same-named `.base` declares, so it also proves WHICH document
    // the defaults were read from.
    const firstRuntime = map.get(SECONDARY);
    assert.notEqual(firstRuntime, undefined, "the secondary must be materialized before the swap");
    const first = await sessions.call("create_base_entry", {
      vaultId: SECONDARY,
      path: "bases/shared.base",
      view: "SECONDARY_VIEW",
      file: "rematerialized-first.md",
      values: { marker: "sec-first" },
    });
    assert.equal(first.created, true);
    assert.equal(first.path, "notes/rematerialized-first.md");
    assert.equal(first.basePath, "bases/shared.base");
    assert.equal(first.view, "SECONDARY_VIEW", "the primary's same-named Base declares no such view");
    assert.match(await fs.readFile(path.join(SECONDARY_ROOT, "notes", "rematerialized-first.md"), "utf8"), /marker: sec-first/);

    // (2) the runtime GENERATION changes. Path used: `map.release(SECONDARY)` (the map's public
    // ops/test seam: it drops this id from the committed instance map and revokes the handle's lease
    // synchronously) followed by `map.align()` — the map's documented incremental materialization
    // path ("an unchanged Vault keeps its instance, a new Vault gets one, and a removed Vault is
    // released"). A released id is indistinguishable from a Vault that has just appeared, so
    // `align()` builds a FRESH instance + lease for it exactly as it would for that Vault; the map
    // (and C's registrar) expose no other re-materialization seam, so this is the equivalent path.
    assert.equal(map.release(SECONDARY), true, "the first runtime generation must still be materialized when it is released");
    assert.equal(map.get(SECONDARY), undefined, "a released Vault is not handed out any more");
    const aligned = map.align();
    assert.deepEqual(aligned.created, [SECONDARY], "align() re-materializes the released Vault from the registry snapshot");
    assert.deepEqual(aligned.failed, [], "the re-materialization must not have failed");
    const secondRuntime = map.get(SECONDARY);
    assert.notEqual(secondRuntime, firstRuntime, "the re-materialized Vault must be a NEW handle (new lease/generation), never the retired one");

    // (3) the second create must be served by the NEW runtime: it lands in the secondary Vault, the
    // primary tree stays byte-identical, `basePath` is answered from the new runtime's own storage,
    // and the new generation's own index observes the write.
    const newIndex = searchRuntimeFor(secondRuntime).index;
    const generationBefore = newIndex.generation;
    const second = await sessions.call("create_base_entry", {
      vaultId: SECONDARY,
      path: "bases/shared.base",
      view: "SECONDARY_VIEW",
      file: "rematerialized-second.md",
      values: { marker: "sec-second" },
    });
    assert.equal(second.created, true);
    assert.equal(second.path, "notes/rematerialized-second.md");
    assert.equal(second.basePath, "bases/shared.base");
    assert.equal(second.view, "SECONDARY_VIEW");
    assert.match(await fs.readFile(path.join(SECONDARY_ROOT, "notes", "rematerialized-second.md"), "utf8"), /marker: sec-second/);
    assert.equal(await exists(path.join(PRIMARY_ROOT, "notes", "rematerialized-second.md")), false, "the re-materialized generation must not write the primary Vault");
    assert.ok(newIndex.generation > generationBefore, "the write must be observed by the CURRENT generation's index, not by the retired one");
  } finally {
    await sessions.close();
  }
  assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "re-materializing the secondary must leave the primary tree byte-identical");
});

test("§21 MV-I07: create_base_entry without vaultId stays on the primary Vault and never the secondary", async () => {
  const map = await newMap();
  const secondaryBefore = await treeSnapshot(SECONDARY_ROOT);
  const sessions = await toolClient(map);
  try {
    const created = await sessions.call("create_base_entry", { path: "bases/shared.base", file: "legacy-primary.md" });
    assert.equal(created.path, "notes/legacy-primary.md");
    assert.match(await fs.readFile(path.join(PRIMARY_ROOT, "notes", "legacy-primary.md"), "utf8"), /marker: null/, "the primary's own Base supplies the defaults");
    assert.equal(await exists(path.join(SECONDARY_ROOT, "notes", "legacy-primary.md")), false, "MV-I07: an omitted vaultId must never reach the secondary Vault");
  } finally {
    await sessions.close();
  }
  assert.deepEqual(await treeSnapshot(SECONDARY_ROOT), secondaryBefore, "an omitted vaultId must leave the secondary tree byte-identical");
});

test("§47: create_base_entry is refused structurally for an unmaterialized, unknown or unguarded Vault selection", async () => {
  const map = await newMap();
  assert.equal(map.release(SECONDARY), true, "drop the secondary so the map no longer materializes it");
  assert.equal(map.get(SECONDARY), undefined, "an unmaterialized id must never resolve to the primary runtime");

  // Registrar level: the refusal must happen BEFORE the handler runs, so no `.md` is planned.
  let handlerRuns = 0;
  const server = new McpServer({ name: "mv-dworkflows-create-refusal", version: "0.0.0" });
  createVaultScopeRegistrar(server, vaultScopeOf(map)).registerTool("create_base_entry", {
    description: "Wave D / D-workflows refusal probe for the #630 create face.",
    inputSchema: { path: z.string() },
  }, () => { handlerRuns += 1; return { content: [{ type: "text", text: "{}" }], structuredContent: {} }; });
  const client = new Client({ name: "mv-dworkflows-create-refusal", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const probe = async (vaultId) => {
    const result = await withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name: "create_base_entry", arguments: { vaultId, path: "bases/shared.base" } }));
    return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
  };
  try {
    for (const vaultId of [SECONDARY, "no-such-vault"]) {
      const denied = await probe(vaultId);
      assert.equal(denied.isError, true);
      assert.equal(denied.payload.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
      assert.equal(handlerRuns, 0, "the create handler must not run for a Vault without a runtime (§47)");
    }
    await probe(DEFAULT_VAULT_ID);
    assert.equal(handlerRuns, 1, "the materialized primary Vault still serves the create tool");
  } finally {
    await client.close();
    await server.close();
  }

  // Resolver level: the registrar knows the id, this process has no runtime for it. The seam must
  // refuse structurally instead of serving the create from the primary Vault's storage.
  const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
  const secondaryBefore = await treeSnapshot(SECONDARY_ROOT);
  const orphan = await toolClient(map, { vaultScope: { resolveVaultRuntime: (id) => (id === DEFAULT_VAULT_ID ? primaryRuntime : undefined), vaultExists: () => true } });
  try {
    const result = await orphan.raw("create_base_entry", { vaultId: SECONDARY, path: "bases/shared.base", file: "orphan.md" });
    assert.equal(result.isError, true, "create_base_entry must fail closed for a selection without a runtime");
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.code, "vault_unavailable", "the create face must answer with the structured refusal");
    assert.equal(payload.vaultId, SECONDARY);
    assert.equal(await exists(path.join(SECONDARY_ROOT, "notes", "orphan.md")), false, "a refused create must perform no Vault write");
    assert.equal(await exists(path.join(PRIMARY_ROOT, "notes", "orphan.md")), false, "§47: a refusal must never fall back to the primary Vault's storage");
  } finally {
    await orphan.close();
  }
  assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "a refused create must perform no Vault I/O");
  assert.deepEqual(await treeSnapshot(SECONDARY_ROOT), secondaryBefore, "a refused create must perform no Vault I/O");
  assert.equal(map.get(SECONDARY), undefined, "a refused selection must not materialize a runtime");
});
