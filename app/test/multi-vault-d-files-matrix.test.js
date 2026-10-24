// Wave D / D-files — real dual-Vault matrix for the files / history / trash / notes toolset.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D — run a REAL two-Vault matrix per toolset instead of assuming the changed foundation
//       made every tool per-Vault; never invent a second Vault selector;
//   §10.1 the request-scoped runtime seam · §10.2 per-Vault mutation lock · §5.1/§5.2 data layout ·
//   §3.4 capability is a runtime fact · §11/§13.1/§13.3/§13.4 per-Vault handles ·
//   §21 MV-I01/MV-I02/MV-I03/MV-I07 · §47 RETURN list (no secondary → primary fallback).
//
// Driven here: the production tools themselves (registered through `registerObsidianCapabilities`
// → C's vault-scope registrar → A4's context patch) over the real MCP SDK, against a real primary +
// secondary Vault pair. Every assertion is an on-disk fact, not a handler self-report.
//
// NOT proven here (declared, not implied): per-Vault VaultIndex / retrieval *instances* (search
// lane); per-Vault GitRuntime (wired by the later D-git lane in `src/git-runtimes.js`, where
// `trackGitMutation` resolves the *current request's* runtime and reaches the primary only when no
// Vault was selected); the
// link/graph read tools (`get_backlinks`, `get_graph`, `get_unresolved_links`, `get_orphans`,
// `get_deadends`) and the search / workflows / context / intelligence / plans / publish toolsets,
// which their own lanes own; `list_properties`/`list_aliases`/`get_note_version`/
// `compare_note_versions` therefore stay on the primary facade and keep reporting
// `available:false` in the capability graph below.
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

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-dfiles-matrix-"));
const VAULTS_ROOT = path.join(ROOT, "vaults");
const PRIMARY_ROOT = path.join(VAULTS_ROOT, "primary");
const SECONDARY_ROOT = path.join(VAULTS_ROOT, "secondary");
const DATA_ROOT = path.join(ROOT, "data");
const SECONDARY = "secondary";
const PRIMARY_HISTORY = path.join(DATA_ROOT, "history");
const PRIMARY_TRASH = path.join(DATA_ROOT, "trash");
const SECONDARY_DATA_ROOT = path.join(DATA_ROOT, "vaults", createHash("sha256").update(SECONDARY).digest("hex"));
const SECONDARY_HISTORY = path.join(SECONDARY_DATA_ROOT, "history");
const SECONDARY_TRASH = path.join(SECONDARY_DATA_ROOT, "trash");

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.HISTORY_PATH = PRIMARY_HISTORY;
process.env.TRASH_PATH = PRIMARY_TRASH;
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA_ROOT, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";
for (const dir of [PRIMARY_ROOT, SECONDARY_ROOT, DATA_ROOT]) await fs.mkdir(dir, { recursive: true });

const { primaryRuntime } = await import("../src/vault.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultRegistry } = await import("../src/vault-runtime/registry.js");
const { createVaultRuntimeMap } = await import("../src/vault-runtime/instances.js");
const { WIRED_CAPABILITY_KEYS } = await import("../src/vault-runtime/capabilities.js");
const { CAPABILITY_KEYS } = await import("../src/vault-runtime/descriptor.js");
const { currentLocalFs } = await import("../src/vault-runtime/request-vault.js");
const { createVaultScopeRegistrar, VAULT_SCOPE_DENY_CODES } = await import("../src/vault-scope-registrar.js");
const { withRequestContext, withRequestContextPatch } = await import("../src/request-context.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { VAULT_SCOPED_TOOLS } = await import("../src/vault-scope.js");
const { TOOL_NAMES } = await import("../src/config.js");

const AUTHOR = Object.freeze({ agent: "mv-dfiles-matrix", model: "test" });
const testDir = new URL("..", import.meta.url);

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

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

const sha256File = async (absPath) => createHash("sha256").update(await fs.readFile(absPath)).digest("hex");
/** Recursive `path:size:sha256` listing; a missing root is an empty tree. */
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
    else out.push(`${relative}:${(await fs.stat(abs)).size}:${await sha256File(abs)}`);
  }
  return out;
}
const exists = (absPath) => fs.access(absPath).then(() => true, () => false);

/** A real MCP server: the production capability registration behind C's vault-scope registrar. */
async function toolClient(map, { register = registerObsidianCapabilities } = {}) {
  const server = new McpServer({ name: "mv-dfiles-matrix", version: "0.0.0" });
  register(server, { vaultScope: vaultScopeOf(map) });
  const client = new Client({ name: "mv-dfiles-matrix", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const raw = (name, args = {}) => withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name, arguments: args }));
  return {
    raw,
    call: async (name, args = {}) => {
      const result = await raw(name, args);
      assert.notEqual(result.isError, true, `${name} failed: ${result.content?.[0]?.text}`);
      assert.ok(result.structuredContent, `${name} must return structuredContent`);
      return result.structuredContent;
    },
    close: async () => { await client.close(); await server.close(); },
  };
}

// ---------------------------------------------------------------------------------------
// 1. §29 files/history/trash/notes lane — every routed effect lands in the selected Vault
// ---------------------------------------------------------------------------------------

test("§29 files/history/trash lane: vaultId=secondary keeps every routed effect inside the secondary Vault", async () => {
  const map = await newMap();
  assert.deepEqual([...map.ids()].sort(), [DEFAULT_VAULT_ID, SECONDARY]);
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime, "the primary instance must stay the src/vault.js instance");
  assert.notEqual(map.get(SECONDARY).localFs, primaryRuntime.localFs, "SEC-MV06: the secondary must own its filesystem service");

  const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
  const primaryHistoryBefore = await treeSnapshot(PRIMARY_HISTORY);
  const primaryTrashBefore = await treeSnapshot(PRIMARY_TRASH);
  const sessions = await toolClient(map);
  try {
    // notes face: create, overwrite (snapshot), read, metadata
    const created = await sessions.call("write_note", { vaultId: SECONDARY, path: "notes/alpha.md", content: "# alpha\n\nfirst\n" });
    assert.equal(created.created, true);
    assert.equal(created.path, "notes/alpha.md");
    assert.equal(await exists(path.join(SECONDARY_ROOT, "notes", "alpha.md")), true, "the write must land in the selected Vault, not the primary one");
    assert.match(await fs.readFile(path.join(SECONDARY_ROOT, "notes", "alpha.md"), "utf8"), /# alpha\n\nfirst\n$/);

    const overwritten = await sessions.call("write_note", { vaultId: SECONDARY, path: "notes/alpha.md", content: "# alpha\n\nsecond\n", overwrite: true });
    assert.equal(overwritten.created, false);
    assert.ok(overwritten.preWriteVersionId, "the overwrite must snapshot the first revision");
    assert.equal((await sessions.call("get_note", { vaultId: SECONDARY, path: "notes/alpha.md" })).content, "# alpha\n\nsecond\n");
    assert.equal((await sessions.call("get_metadata", { vaultId: SECONDARY, path: "notes/alpha.md" })).path, "notes/alpha.md");

    // append + frontmatter + tags stay on the secondary file
    assert.equal((await sessions.call("append_to_note", { vaultId: SECONDARY, path: "notes/alpha.md", content: "appended" })).created, false);
    assert.equal((await sessions.call("manage_frontmatter", { vaultId: SECONDARY, path: "notes/alpha.md", action: "set", key: "status", value: "draft" })).frontmatter.status, "draft");
    const tagged = await sessions.call("manage_tags", { vaultId: SECONDARY, path: "notes/alpha.md", action: "add", tags: ["alpha-tag"], location: "both" });
    assert.ok(tagged.all.includes("alpha-tag"));
    const secondaryAlpha = await fs.readFile(path.join(SECONDARY_ROOT, "notes", "alpha.md"), "utf8");
    assert.match(secondaryAlpha, /status: draft/);
    assert.match(secondaryAlpha, /alpha-tag/);
    assert.match(secondaryAlpha, /appended/);

    // folders + directory face
    assert.equal((await sessions.call("manage_folders", { vaultId: SECONDARY, action: "create", folder: "Projects" })).created, "Projects");
    assert.equal((await fs.stat(path.join(SECONDARY_ROOT, "Projects"))).isDirectory(), true);
    const listed = (await sessions.call("list_files", { vaultId: SECONDARY, recursive: true, depth: 5 })).entries.map((entry) => entry.path);
    assert.ok(listed.includes("notes/alpha.md"));
    assert.ok(listed.includes("Projects"));

    // history face: list → restore → delete
    const versions = await sessions.call("list_versions", { vaultId: SECONDARY, path: "notes/alpha.md" });
    assert.ok(versions.versions.length >= 1, "the overwrite must have produced a pre-write snapshot");
    assert.equal(versions.versions[0].path, "notes/alpha.md");
    assert.ok((await treeSnapshot(SECONDARY_HISTORY)).length > 0, "snapshots must live under the secondary's own history root (§5.2)");
    const restored = await sessions.call("restore_version", { vaultId: SECONDARY, versionId: versions.versions.at(-1).versionId, overwrite: true });
    assert.equal(restored.restoredPath, "notes/alpha.md");
    assert.match(await fs.readFile(path.join(SECONDARY_ROOT, "notes", "alpha.md"), "utf8"), /# alpha\n\nfirst\n$/);
    const purged = await sessions.call("delete_version", { vaultId: SECONDARY, versionId: versions.versions[0].versionId });
    assert.equal(purged.deletedVersion, versions.versions[0].versionId);

    // move
    const moved = await sessions.call("move_note", { vaultId: SECONDARY, from: "notes/alpha.md", to: "archive/alpha.md" });
    assert.deepEqual(moved.moved, { from: "notes/alpha.md", to: "archive/alpha.md" });
    assert.equal(await exists(path.join(SECONDARY_ROOT, "notes", "alpha.md")), false);
    assert.equal(await exists(path.join(SECONDARY_ROOT, "archive", "alpha.md")), true);

    // trash face: delete → list → restore → purge
    const deleted = await sessions.call("delete_note", { vaultId: SECONDARY, path: "archive/alpha.md", backup: true });
    assert.equal(deleted.deleted, "archive/alpha.md");
    assert.ok(deleted.backup, "the delete must return its trash backup path");
    assert.equal(await exists(path.join(SECONDARY_ROOT, "archive", "alpha.md")), false);
    const trash = await sessions.call("list_trash", { vaultId: SECONDARY, limit: 50 });
    assert.deepEqual(trash.entries.map((entry) => entry.backupPath), [deleted.backup]);
    assert.equal(trash.entries[0].originalPath, "archive/alpha.md");
    assert.ok((await treeSnapshot(SECONDARY_TRASH)).length > 0, "the backup must live under the secondary's own trash root (§5.2)");
    assert.equal((await sessions.call("restore_from_trash", { vaultId: SECONDARY, backupPath: deleted.backup, overwrite: true })).restoredPath, "archive/alpha.md");
    assert.equal(await exists(path.join(SECONDARY_ROOT, "archive", "alpha.md")), true);
    assert.equal((await sessions.call("delete_trash_entry", { vaultId: SECONDARY, backupPath: deleted.backup })).deletedBackup, deleted.backup);
    assert.deepEqual((await sessions.call("list_trash", { vaultId: SECONDARY, limit: 50 })).entries, []);

    // file face: a non-Markdown file written and read through the file toolset
    await sessions.call("write_file", { vaultId: SECONDARY, path: "assets/data.json", content: '{"a":1}\n', acceptedOnly: false });
    assert.equal(await fs.readFile(path.join(SECONDARY_ROOT, "assets", "data.json"), "utf8"), '{"a":1}\n');
    const pulled = await sessions.call("get_file", { vaultId: SECONDARY, path: "assets/data.json", encoding: "text", acceptedOnly: false });
    assert.equal(pulled.content, '{"a":1}\n');
    assert.equal(pulled.path, "assets/data.json");
  } finally {
    await sessions.close();
  }

  assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "the primary content root must be untouched");
  assert.deepEqual(await treeSnapshot(PRIMARY_HISTORY), primaryHistoryBefore, "primary history must be untouched");
  assert.deepEqual(await treeSnapshot(PRIMARY_TRASH), primaryTrashBefore, "primary trash must be untouched");
  assert.equal(await exists(path.join(PRIMARY_ROOT, "notes")), false);
  assert.equal(await exists(path.join(PRIMARY_ROOT, "archive")), false);
  assert.equal(await exists(path.join(PRIMARY_ROOT, "assets")), false);
});

// ---------------------------------------------------------------------------------------
// 2. §21 MV-I07 — no vaultId keeps the legacy primary semantics
// ---------------------------------------------------------------------------------------

test("§21 MV-I07: without vaultId every routed effect stays on the primary Vault", async () => {
  const map = await newMap();
  const secondaryBefore = await treeSnapshot(SECONDARY_ROOT);
  const primaryHistoryBefore = await treeSnapshot(PRIMARY_HISTORY);
  const primaryTrashBefore = await treeSnapshot(PRIMARY_TRASH);
  const sessions = await toolClient(map);
  try {
    const written = await sessions.call("write_note", { path: "inbox/legacy.md", content: "# legacy\n" });
    assert.equal(written.path, "inbox/legacy.md");
    assert.match(await fs.readFile(path.join(PRIMARY_ROOT, "inbox", "legacy.md"), "utf8"), /# legacy\n$/);
    assert.equal((await sessions.call("get_note", { vaultId: DEFAULT_VAULT_ID, path: "inbox/legacy.md" })).content, "# legacy\n");
    assert.deepEqual((await sessions.call("list_versions", { path: "inbox/legacy.md" })).versions, [], "the first write creates no snapshot");

    const second = await sessions.call("write_note", { path: "inbox/legacy.md", content: "# legacy two\n", overwrite: true });
    assert.ok(second.preWriteVersionId, "an overwrite snapshots into the legacy primary history root");
    assert.equal((await sessions.call("list_versions", { path: "inbox/legacy.md" })).versions.length, 1);
    const primaryHistoryAfter = await treeSnapshot(PRIMARY_HISTORY);
    assert.ok(primaryHistoryAfter.length > primaryHistoryBefore.length, "the snapshot must grow the legacy primary history root");
    assert.ok(primaryHistoryAfter.some((entry) => entry.startsWith("inbox/legacy.md/")), "the snapshot must be filed under the primary-relative note path");

    await sessions.call("delete_note", { path: "inbox/legacy.md", backup: true });
    const trash = await sessions.call("list_trash", { limit: 50 });
    assert.equal(trash.entries.length, 1);
    assert.equal(trash.entries[0].originalPath, "inbox/legacy.md");
    assert.ok((await treeSnapshot(PRIMARY_TRASH)).length > primaryTrashBefore.length, "the backup must land in the legacy primary trash root");
    assert.equal(await exists(path.join(PRIMARY_ROOT, "inbox", "legacy.md")), false);
  } finally {
    await sessions.close();
  }
  assert.deepEqual(await treeSnapshot(SECONDARY_ROOT), secondaryBefore, "a primary request must not touch the secondary Vault");
});

// ---------------------------------------------------------------------------------------
// 3. §21 MV-I01/MV-I02/MV-I03 — per-Vault locks and no cross-Vault bleed
// ---------------------------------------------------------------------------------------

test("§21 MV-I01/MV-I02: routed mutations serialize inside a Vault, never block or bleed across Vaults", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  assert.notEqual(primaryRuntime.localFs.historyRoot, secondaryRuntime.localFs.historyRoot);
  const inVault = (vaultId, runtime, task) => withRequestContext({ author: AUTHOR, vaultId, vaultRuntime: runtime }, task);
  const routedLock = (vaultId, runtime, task) => inVault(vaultId, runtime, () => currentLocalFs().withMutationLock(task));

  // (a) a held secondary lock must not delay the primary Vault's routed lock (MV-I02)
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = routedLock(SECONDARY, secondaryRuntime, async () => { order.push("secondary:start"); await gate; order.push("secondary:end"); });
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = Date.now();
  await routedLock(DEFAULT_VAULT_ID, primaryRuntime, async () => { order.push("primary:ran-while-secondary-held"); });
  assert.deepEqual(order, ["secondary:start", "primary:ran-while-secondary-held"], "the primary lock must not wait behind a secondary lock");
  assert.ok(Date.now() - startedAt < 5_000, "the primary mutation must not block on another Vault's lock");
  release();
  await held;

  // (b) same-Vault routed locks stay strictly serial (MV-I01)
  const serial = [];
  await Promise.all([
    routedLock(SECONDARY, secondaryRuntime, async () => { serial.push("a:start"); await new Promise((resolve) => setTimeout(resolve, 20)); serial.push("a:end"); }),
    routedLock(SECONDARY, secondaryRuntime, async () => { serial.push("b:start"); serial.push("b:end"); }),
  ]);
  assert.deepEqual(serial, ["a:start", "a:end", "b:start", "b:end"], "same-Vault mutations stay serial (MV-I01)");

  // (c) concurrent real tool writes to two Vaults land only in their own root (MV-I02/MV-I03)
  const sessions = await toolClient(map);
  try {
    await Promise.all([
      sessions.call("write_note", { path: "concurrent/primary.md", content: "one\n" }),
      sessions.call("write_note", { vaultId: SECONDARY, path: "concurrent/secondary.md", content: "two\n" }),
    ]);
  } finally {
    await sessions.close();
  }
  assert.match(await fs.readFile(path.join(PRIMARY_ROOT, "concurrent", "primary.md"), "utf8"), /one\n$/);
  assert.match(await fs.readFile(path.join(SECONDARY_ROOT, "concurrent", "secondary.md"), "utf8"), /two\n$/);
  assert.equal(await exists(path.join(PRIMARY_ROOT, "concurrent", "secondary.md")), false, "no cross-Vault write");
  assert.equal(await exists(path.join(SECONDARY_ROOT, "concurrent", "primary.md")), false, "no cross-Vault write");
});

// ---------------------------------------------------------------------------------------
// 4. §3.4 — the reported capability facts match what this lane actually wired
// ---------------------------------------------------------------------------------------

// The canonical tools whose per-Vault routing this lane delivers, by capability key. Declared in
// the test (not production) so the assertion below ties the reported capability graph to the real
// canonical tool registry instead of mirroring a constant.
const WIRED_TOOLS = Object.freeze({
  notes: Object.freeze(["get_note", "get_metadata", "write_note", "append_to_note", "patch_note", "replace_in_note", "manage_frontmatter", "manage_tags"]),
  files: Object.freeze(["list_files", "pull_note_file", "get_file", "pull_file", "write_file", "start_file_upload", "upload_file_chunk", "file_upload_status", "cancel_file_upload", "create_archive", "inspect_archive", "read_archive_entry", "extract_archive", "get_canvas", "write_canvas", "manage_folders"]),
  history: Object.freeze(["list_versions", "restore_version", "delete_version"]),
  trash: Object.freeze(["list_trash", "restore_from_trash", "delete_trash_entry"]),
  // Wave D / D-git added the git face: `tools/git.js` resolves each Vault's own GitRuntime through
  // `src/git-runtimes.js`. Declared here (not only in the git lane's own matrix) so this lane's
  // capability-drift assertion below stays exact instead of silently stale.
  git: Object.freeze(["git_status", "git_diff", "git_log", "git_commit", "git_pull", "git_push"]),
  // Wave D / D-intelligence added the memory + skills face: `src/skills.js` and
  // `src/tools/intelligence.js` resolve the Vault-relative managed memory/Skills roots and the
  // index/retrieval side effects through the request runtime; `get_note_context` does the same via
  // `src/context-service.js`. Declared here, like the git face above, so this lane's
  // capability-drift assertion stays exact instead of silently stale.
  memory: Object.freeze(["memory_capture", "memory_recall"]),
  skills: Object.freeze(["skill_list", "skill_match", "skill_validate", "skill_export", "skill_import"]),
  // Wave D / D-plans added the plans / recovery face: `src/tools/plans.js` creates / reads /
  // applies plans whose paths, revisions, versions, Trash sources, mutation lock, journal, 24h
  // idempotency records and post-commit index invalidation all resolve through the selected
  // Vault's runtime (`src/mutation-plans.js`, `src/batch-write.js`, `src/batch-journal.js`).
  // Declared here, like the git and memory/skills faces above, so this lane's capability-drift
  // assertion stays exact instead of silently stale.
  plans: Object.freeze(["plan_note_changes", "plan_move_note", "plan_delete_note", "plan_restore_version", "plan_restore_from_trash", "get_note_plan", "apply_note_plan", "get_note_version", "compare_note_versions"]),
  // Wave D / D-publish added the publish face: `tools/publish.js` reads the *selected*
  // `requestContext().vaultId` and `src/publish/service.js` resolves it through the canonical Web
  // VaultRegistry, so records are keyed per Vault and every stat/read/write lands in the selected
  // Vault's own root. Declared here (not only in the publish lane's own matrix) so this lane's
  // capability-drift assertion below stays exact instead of silently stale. Unlike the faces above,
  // publish needs no per-Vault *runtime instance* — it resolves the Vault itself — so
  // `src/tools/publish.js` is deliberately NOT added to `ROUTED_MODULES` (which asserts the
  // `vault-runtime/request-vault.js` seam); the routing proof for this key lives in
  // `multi-vault-publish-matrix.test.js`.
  publish: Object.freeze(["get_publish_status", "manage_publish"]),
  // Wave F / F1 (§31): the map-level `retrieval` key converged once B2's VaultIndex + B3's retrieval
  // runtime were materialized per Vault (D-search) and every index/retrieval consumer was routed.
  // The tools below are the ones whose behaviour depends on the SELECTED Vault's own index/retrieval
  // instance; the D-search matrix proves the search subset and `multi-vault-full-matrix.test.js`
  // proves the remainder (link/graph readers, `find_related`/`suggest_links`, `get_note_context`).
  // Declared here, like the faces above, so this lane's capability-drift assertion stays exact.
  retrieval: Object.freeze([
    "search_notes", "list_notes", "list_recent", "list_tags", "get_backlinks", "get_graph",
    "get_unresolved_links", "get_orphans", "get_deadends", "index_status", "reindex_vault", "recall",
    "find_related", "graph_health", "suggest_links", "get_note_context",
  ]),
});
const ROUTED_MODULES = Object.freeze([
  "src/tools/notes.js", "src/tools/files.js", "src/tools/links.js", "src/obsidian.js",
  "src/mutation-plans.js", "src/batch-write.js", "src/batch-journal.js", "src/file-transfer.js",
  "src/tools/intelligence.js", "src/skills.js", "src/context-service.js",
]);

test("§3.4: the runtime map reports exactly the wired capability keys available and keeps the rest fail closed", async () => {
  const map = await newMap();
  const secondary = map.get(SECONDARY).capabilities;
  assert.deepEqual([...WIRED_CAPABILITY_KEYS].sort(), Object.keys(WIRED_TOOLS).sort(), "declared wiring and reported keys must not drift");
  for (const key of CAPABILITY_KEYS) {
    if (WIRED_CAPABILITY_KEYS.includes(key)) {
      assert.deepEqual(secondary[key], { available: true }, `${key} is wired by this lane and must be reported available`);
    } else {
      assert.equal(secondary[key].available, false, `${key} is not wired by this lane and must stay fail closed (§3.4)`);
      assert.ok(secondary[key].reason.length > 0, `${key} must carry a visible reason`);
    }
  }
  // every claimed tool is canonical + vault-scoped, and every routed module really consumes the seam
  for (const tools of Object.values(WIRED_TOOLS)) {
    for (const name of tools) {
      assert.ok(TOOL_NAMES.includes(name), `${name} must be a canonical tool`);
      assert.ok(VAULT_SCOPED_TOOLS.includes(name), `${name} must be classified vault-scoped`);
    }
  }
  for (const relative of ROUTED_MODULES) {
    const source = await fs.readFile(new URL(relative, testDir), "utf8");
    assert.ok(source.includes("vault-runtime/request-vault.js"), `${relative} must consume the request runtime, not the primary facade`);
  }
});

// ---------------------------------------------------------------------------------------
// 5. §47 — an unmaterialized Vault is refused before the handler runs
// ---------------------------------------------------------------------------------------

test("§47: a Vault without a materialized runtime is refused structurally and the handler never runs", async () => {
  const map = await newMap();
  assert.equal(map.release(SECONDARY), true, "drop the secondary so the map no longer materializes it");
  assert.equal(map.get(SECONDARY), undefined, "an unmaterialized id must never resolve to the primary runtime");

  let handlerRuns = 0;
  const server = new McpServer({ name: "mv-dfiles-refusal", version: "0.0.0" });
  createVaultScopeRegistrar(server, vaultScopeOf(map)).registerTool("get_note", {
    description: "Wave D / D-files refusal probe on a canonical vault-scoped name.",
    inputSchema: { path: z.string() },
  }, () => { handlerRuns += 1; return { content: [{ type: "text", text: "{}" }], structuredContent: {} }; });
  const client = new Client({ name: "mv-dfiles-refusal", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const probe = async (vaultId) => {
    const result = await withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name: "get_note", arguments: { vaultId, path: "notes/alpha.md" } }));
    return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
  };
  try {
    const unmaterialized = await probe(SECONDARY);
    assert.equal(unmaterialized.isError, true);
    assert.equal(unmaterialized.payload.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
    assert.equal(handlerRuns, 0, "the handler must not run for an unmaterialized Vault (§47)");
    const unknown = await probe("no-such-vault");
    assert.equal(unknown.isError, true);
    assert.equal(unknown.payload.code, VAULT_SCOPE_DENY_CODES.UNAVAILABLE);
    assert.equal(handlerRuns, 0, "an unknown Vault must never reach the handler either");
    await probe(DEFAULT_VAULT_ID);
    assert.equal(handlerRuns, 1, "the materialized primary Vault still serves the tool");
  } finally {
    await client.close();
    await server.close();
  }
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime);
});
