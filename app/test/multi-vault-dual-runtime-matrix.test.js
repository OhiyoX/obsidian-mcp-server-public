// Wave D / D0 — real dual-Vault runtime matrix (notes baseline).
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D (first module lane: run a REAL two-Vault matrix instead of assuming the changed
//       foundation made every toolset per-Vault; never invent a second Vault selector);
//   §10.1 the runtime seam · §10.2 per-runtime mutation lock · §5.2 secondary data layout ·
//   §4.2 registry snapshot semantics · §3.4 capabilities · §18.1 server_info Vault face ·
//   §21 MV-I01/MV-I02/MV-I03/MV-I07 · §47 RETURN list (no secondary→primary fallback).
//
// Proven here: one canonical registry snapshot becomes one runtime per Vault; C's registrar hands
// the selected instance to the handler through the request context; every notes-face effect of a
// secondary request lands in that Vault's own root and data root; an omitted `vaultId` keeps the
// legacy primary behaviour; two Vaults share no lock, no path and no corpus; an id without a
// materialized runtime is refused instead of being served by the primary one.
//
// NOT proven here (declared, not implied): per-Vault VaultIndex / retrieval *instances* are not
// materialized by this lane (the search lane owns those factories). §4 asserts the bounded,
// provable substitute — distinct per-Vault index paths plus corpus isolation — and says so.
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

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-d0-matrix-"));
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
await fs.mkdir(PRIMARY_ROOT, { recursive: true });
await fs.mkdir(SECONDARY_ROOT, { recursive: true });
await fs.mkdir(DATA_ROOT, { recursive: true });

const { primaryRuntime } = await import("../src/vault.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultRegistry } = await import("../src/vault-runtime/registry.js");
const { createVaultRuntime } = await import("../src/vault-runtime/runtime.js");
const { createVaultRuntimeMap, VAULT_RUNTIME_MAP_NOT_READY, VAULT_RUNTIME_MAP_PRIMARY_CONFLICT } = await import("../src/vault-runtime/instances.js");
const { createVaultScopeRegistrar } = await import("../src/vault-scope-registrar.js");
const { requestContext, withRequestContextPatch, requireRequestAuthor } = await import("../src/request-context.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { listWebVaults } = await import("../src/app/vault-registry.js");

// A canonical vault-scoped tool name (classification is name-based, A3); this test-local server
// registers only this handler, so the probe travels the real registrar path.
const PROBE_TOOL = "get_note";
const AUTHOR = Object.freeze({ agent: "mv-d0-matrix", model: "test" });
const SECONDARY_DATA_ROOT = path.join(DATA_ROOT, "vaults", createHash("sha256").update(SECONDARY).digest("hex"));
const SECONDARY_HISTORY = path.join(SECONDARY_DATA_ROOT, "history");
const SECONDARY_TRASH = path.join(SECONDARY_DATA_ROOT, "trash");

// --------------------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------------------

const newRegistry = ({ primaryId = DEFAULT_VAULT_ID, primaryRoot = PRIMARY_ROOT, vaultsRoot = VAULTS_ROOT } = {}) =>
  createVaultRegistry({ primaryRoot, primaryId, vaultsRoot, writable: true });

async function newMap(options = {}) {
  const map = createVaultRuntimeMap({
    registry: options.registry ?? newRegistry(),
    dataRoot: DATA_ROOT,
    primaryRuntime,
    deps: { requireRequestAuthor },
    ...(options.map ?? {}),
  });
  if (options.skipRefresh !== true) await map.refresh();
  return map;
}

/** The exact pair server.js injects into the vault-scope registrar (one authority, no fork). */
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

const exists = async (absPath) => fs.access(absPath).then(() => true, () => false);

async function write(absPath, data) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, data, "utf8");
}

// --------------------------------------------------------------------------------------
// Probe: the notes face of one Vault runtime, driven through the real registrar
// --------------------------------------------------------------------------------------

function probeHandler(args = {}) {
  const context = requestContext();
  const runtime = context?.vaultRuntime;
  if (!runtime) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "no-vault-runtime", vaultId: context?.vaultId ?? null }) }], isError: true };
  }
  const fsApi = runtime.localFs;
  const shape = {
    vaultId: context.vaultId,
    runtimeId: runtime.id,
    runtimePrimary: runtime.primary,
    root: fsApi.root,
    historyRoot: fsApi.historyRoot,
    trashRoot: fsApi.trashRoot,
    retrievalIndex: runtime.paths?.retrievalIndex ?? null,
  };
  const run = async () => {
    switch (args.action) {
      case "write": {
        const abs = fsApi.resolveVaultPath(args.path, { assumeMarkdown: true });
        const written = await fsApi.atomicWriteFile(abs, args.text ?? "", { encoding: "utf-8" });
        return { ...shape, path: fsApi.toVaultPath(abs), revision: written.revision };
      }
      case "read": {
        const abs = fsApi.resolveVaultPath(args.path, { assumeMarkdown: true });
        return { ...shape, text: await fsApi.readLimitedText(abs), revision: await fsApi.fileRevision(abs) };
      }
      case "list":
        return { ...shape, files: (await fsApi.allMarkdownFiles()).map((abs) => fsApi.toVaultPath(abs)).sort() };
      case "versions":
        return { ...shape, versions: (await fsApi.listFileVersions(args.path)).map((version) => version.versionId) };
      case "readversion": {
        const version = await fsApi.readFileVersion(args.versionId);
        return { ...shape, content: version.content, originalPath: version.path };
      }
      case "trash": {
        const abs = fsApi.resolveVaultPath(args.path, { assumeMarkdown: true });
        const backupPath = fsApi.toTrashPath(await fsApi.backupBeforeDelete(abs));
        return { ...shape, backupPath, entries: (await fsApi.listTrashEntries()).map((entry) => entry.backupPath) };
      }
      case "readtrash": {
        const entry = await fsApi.readTrashEntry(args.backupPath);
        return { ...shape, content: entry.content, originalPath: entry.originalPath };
      }
      case "health":
        return { ...shape, health: await fsApi.getVaultHealth() };
      default:
        return { ...shape, error: `unknown-action:${args.action}` };
    }
  };
  return run().then(
    (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
    (error) => ({ content: [{ type: "text", text: JSON.stringify({ ...shape, error: error?.message || String(error) }) }], isError: true }),
  );
}

const PROBE_SCHEMA = {
  action: z.enum(["write", "read", "list", "versions", "readversion", "trash", "readtrash", "health"]),
  path: z.string().optional(),
  text: z.string().optional(),
  versionId: z.string().optional(),
  backupPath: z.string().optional(),
};

/** A test-local server whose only tool is the probe, registered through C's registrar. */
async function probeClient(vaultScope) {
  const server = new McpServer({ name: "mv-d0-matrix", version: "0.0.0" });
  createVaultScopeRegistrar(server, vaultScope).registerTool(PROBE_TOOL, {
    description: "Wave D / D0 dual-Vault matrix probe (test-local handler on a canonical vault-scoped name).",
    inputSchema: PROBE_SCHEMA,
  }, probeHandler);
  const client = new Client({ name: "mv-d0-matrix", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const raw = async (args) => {
    const result = await withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name: PROBE_TOOL, arguments: args }));
    return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
  };
  return {
    call: async (args) => {
      const { isError, payload } = await raw(args);
      assert.equal(isError, false, `probe call failed: ${payload.error}`);
      return payload;
    },
    raw,
    close: async () => { await client.close(); await server.close(); },
  };
}

// --------------------------------------------------------------------------------------
// 1. Explicit vaultId=secondary keeps the whole notes face inside the secondary Vault
// --------------------------------------------------------------------------------------

test("§29 notes lane: vaultId=secondary writes, reads, lists, versions and trashes inside the secondary Vault only", async () => {
  const map = await newMap();
  assert.deepEqual([...map.ids()].sort(), [DEFAULT_VAULT_ID, SECONDARY]);
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime, "the primary instance must be the src/vault.js instance (§21 MV-I02)");
  assert.notEqual(map.get(SECONDARY), primaryRuntime, "a secondary must never be handed the primary runtime (SEC-MV06)");

  const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
  const primaryHistoryBefore = await treeSnapshot(path.join(DATA_ROOT, "history"));
  const primaryTrashBefore = await treeSnapshot(path.join(DATA_ROOT, "trash"));
  const sessions = await probeClient(vaultScopeOf(map));
  try {
    const first = await sessions.call({ vaultId: SECONDARY, action: "write", path: "notes/alpha.md", text: "# alpha\n\nfirst\n" });
    assert.equal(first.vaultId, SECONDARY);
    assert.equal(first.runtimeId, SECONDARY);
    assert.equal(first.runtimePrimary, false);
    assert.equal(first.root, SECONDARY_ROOT);
    assert.equal(first.historyRoot, SECONDARY_HISTORY, "history must live in this Vault's own data root (§5.2)");
    assert.equal(first.trashRoot, SECONDARY_TRASH);
    assert.equal(await fs.readFile(path.join(SECONDARY_ROOT, "notes", "alpha.md"), "utf8"), "# alpha\n\nfirst\n");

    await sessions.call({ vaultId: SECONDARY, action: "write", path: "notes/alpha.md", text: "# alpha\n\nsecond\n" });
    const read = await sessions.call({ vaultId: SECONDARY, action: "read", path: "notes/alpha.md" });
    assert.equal(read.text, "# alpha\n\nsecond\n");
    assert.equal(read.root, SECONDARY_ROOT);

    assert.deepEqual((await sessions.call({ vaultId: SECONDARY, action: "list" })).files, ["notes/alpha.md"]);

    const versions = await sessions.call({ vaultId: SECONDARY, action: "versions", path: "notes/alpha.md" });
    assert.equal(versions.versions.length, 1, "the second write must have snapshotted the first revision");
    const version = await sessions.call({ vaultId: SECONDARY, action: "readversion", versionId: versions.versions[0] });
    assert.equal(version.content, "# alpha\n\nfirst\n");
    assert.equal(version.originalPath, "notes/alpha.md");
    assert.ok((await treeSnapshot(SECONDARY_HISTORY)).length > 0, "the snapshot must exist under this Vault's history root");

    const trashed = await sessions.call({ vaultId: SECONDARY, action: "trash", path: "notes/alpha.md" });
    assert.match(trashed.backupPath, /^[\dTZ.:-]+\/notes\/alpha\.md$/, `unexpected trash path ${trashed.backupPath}`);
    assert.deepEqual(trashed.entries, [trashed.backupPath]);
    assert.ok((await treeSnapshot(SECONDARY_TRASH)).length > 0);
    const entry = await sessions.call({ vaultId: SECONDARY, action: "readtrash", backupPath: trashed.backupPath });
    assert.equal(entry.content, "# alpha\n\nsecond\n");
    assert.equal(entry.originalPath, "notes/alpha.md");

    const health = await sessions.call({ vaultId: SECONDARY, action: "health" });
    assert.equal(health.health.ok, true);
    assert.equal(health.health.vaultPath, SECONDARY_ROOT);
    assert.equal(health.health.dataPath, SECONDARY_DATA_ROOT, "health must report this Vault's data root, not the process data root");
    assert.equal(health.health.historyPath, SECONDARY_HISTORY);
    assert.equal(health.health.trashPath, SECONDARY_TRASH);
  } finally {
    await sessions.close();
  }

  assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "the primary content root must be untouched");
  assert.deepEqual(await treeSnapshot(path.join(DATA_ROOT, "history")), primaryHistoryBefore, "primary history must be untouched");
  assert.deepEqual(await treeSnapshot(path.join(DATA_ROOT, "trash")), primaryTrashBefore, "primary trash must be untouched");
  assert.equal(await exists(path.join(PRIMARY_ROOT, "notes")), false);
  assert.notEqual(map.get(SECONDARY).localFs, primaryRuntime.localFs, "the secondary must own its filesystem service");
});

// --------------------------------------------------------------------------------------
// 2. No vaultId keeps the legacy primary semantics (§21 MV-I07)
// --------------------------------------------------------------------------------------

test("§21 MV-I07: without vaultId every notes-face effect stays on the primary Vault", async () => {
  const map = await newMap();
  const secondaryBefore = await treeSnapshot(SECONDARY_ROOT);
  const sessions = await probeClient(vaultScopeOf(map));
  try {
    const implicit = await sessions.call({ action: "write", path: "inbox/legacy.md", text: "# legacy\n" });
    assert.equal(implicit.vaultId, DEFAULT_VAULT_ID, "an omitted vaultId must select the primary Vault");
    assert.equal(implicit.runtimeId, DEFAULT_VAULT_ID);
    assert.equal(implicit.root, PRIMARY_ROOT);
    assert.equal(implicit.historyRoot, path.join(DATA_ROOT, "history"), "primary keeps its legacy data paths (§5.1)");
    assert.equal(implicit.trashRoot, path.join(DATA_ROOT, "trash"));
    assert.equal(await fs.readFile(path.join(PRIMARY_ROOT, "inbox", "legacy.md"), "utf8"), "# legacy\n");

    const implicitList = await sessions.call({ action: "list" });
    const explicitList = await sessions.call({ vaultId: DEFAULT_VAULT_ID, action: "list" });
    assert.deepEqual(implicitList.files, explicitList.files, "explicit and omitted primary selection must agree");
    assert.ok(implicitList.files.includes("inbox/legacy.md"));
  } finally {
    await sessions.close();
  }
  assert.deepEqual(await treeSnapshot(SECONDARY_ROOT), secondaryBefore, "a primary request must not touch the secondary Vault");
});

// --------------------------------------------------------------------------------------
// 3. Runtime isolation: independent locks, no cross-pollution (§21 MV-I01/I02/I03)
// --------------------------------------------------------------------------------------

test("§21 MV-I01/MV-I02: per-Vault locks serialize inside a Vault and never block or pollute across Vaults", async () => {
  const map = await newMap();
  const primaryFs = primaryRuntime.localFs;
  const secondaryFs = map.get(SECONDARY).localFs;
  assert.notEqual(primaryFs.historyRoot, secondaryFs.historyRoot);

  const order = [];
  let releaseSecondary;
  const gate = new Promise((resolve) => { releaseSecondary = resolve; });
  const held = secondaryFs.withMutationLock(async () => {
    order.push("secondary:start");
    await gate;
    order.push("secondary:end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = Date.now();
  await primaryFs.withMutationLock(async () => { order.push("primary:ran-while-secondary-held"); });
  assert.deepEqual(order, ["secondary:start", "primary:ran-while-secondary-held"], "the primary lock must not wait behind a secondary lock");
  assert.ok(Date.now() - startedAt < 5_000, "the primary write must not wait for the secondary lock");
  releaseSecondary();
  await held;

  const serial = [];
  await Promise.all([
    secondaryFs.withMutationLock(async () => { serial.push("a:start"); await new Promise((resolve) => setTimeout(resolve, 20)); serial.push("a:end"); }),
    secondaryFs.withMutationLock(async () => { serial.push("b:start"); serial.push("b:end"); }),
  ]);
  assert.deepEqual(serial, ["a:start", "a:end", "b:start", "b:end"], "same-Vault mutations stay strictly serial (MV-I01)");

  const inAuthor = (task) => withRequestContextPatch({ author: AUTHOR }, task);
  await Promise.all([
    inAuthor(() => primaryFs.atomicWriteFile(primaryFs.resolveVaultPath("concurrent/primary.md"), "one\n", { encoding: "utf-8" })),
    inAuthor(() => secondaryFs.atomicWriteFile(secondaryFs.resolveVaultPath("concurrent/secondary.md"), "two\n", { encoding: "utf-8" })),
  ]);
  await inAuthor(() => primaryFs.atomicWriteFile(primaryFs.resolveVaultPath("concurrent/primary.md"), "one-again\n", { encoding: "utf-8" }));
  assert.equal(await fs.readFile(path.join(PRIMARY_ROOT, "concurrent", "primary.md"), "utf8"), "one-again\n");
  assert.equal(await fs.readFile(path.join(SECONDARY_ROOT, "concurrent", "secondary.md"), "utf8"), "two\n");
  assert.equal(await exists(path.join(PRIMARY_ROOT, "concurrent", "secondary.md")), false, "no cross-Vault write");
  assert.equal(await exists(path.join(SECONDARY_ROOT, "concurrent", "primary.md")), false, "no cross-Vault write");
  assert.equal(primaryFs.historyRoot, path.join(DATA_ROOT, "history"));
  assert.equal(secondaryFs.historyRoot, SECONDARY_HISTORY);
  assert.ok((await treeSnapshot(primaryFs.historyRoot)).length > 0, "the primary snapshot uses the legacy history root");
  assert.ok((await treeSnapshot(SECONDARY_HISTORY)).length > 0, "the secondary snapshot uses its own history root");
});

// --------------------------------------------------------------------------------------
// 4. Index / retrieval: per-Vault paths + corpus isolation (bounded substitute, see header)
// --------------------------------------------------------------------------------------

test("§11/§12 bounded substitute: per-Vault index paths are distinct and no runtime enumerates the other corpus", async () => {
  const map = await newMap();
  const secondaryRuntime = map.get(SECONDARY);
  assert.equal(primaryRuntime.paths.retrievalIndex, process.env.RETRIEVAL_INDEX_PATH, "primary keeps its legacy index path (§5.1)");
  assert.equal(secondaryRuntime.paths.retrievalIndex, path.join(SECONDARY_DATA_ROOT, "index", "retrieval-index.json"), "secondary uses its own A7 index path (§12)");
  for (const key of ["retrievalIndex", "history", "trash", "transfersUploads", "mutationJournal", "mutationIdempotency"]) {
    assert.notEqual(primaryRuntime.paths[key], secondaryRuntime.paths[key], `${key} must be per-Vault`);
  }

  await write(path.join(PRIMARY_ROOT, "primary-only.md"), "# primary only\n");
  await write(path.join(SECONDARY_ROOT, "secondary-only.md"), "# secondary only\n");
  const primaryFiles = await primaryRuntime.localFs.allMarkdownFiles();
  const secondaryFiles = await secondaryRuntime.localFs.allMarkdownFiles();
  const secondaryRelative = secondaryFiles.map((abs) => secondaryRuntime.localFs.toVaultPath(abs));
  assert.ok(secondaryRelative.includes("secondary-only.md"), "the secondary runtime must enumerate its own corpus");
  assert.equal(secondaryRelative.includes("primary-only.md"), false, "a per-Vault runtime must never read the other Vault's corpus");
  for (const abs of secondaryFiles) assert.ok(abs.startsWith(`${SECONDARY_ROOT}${path.sep}`), `path outside the secondary root: ${abs}`);
  for (const abs of primaryFiles) assert.ok(abs.startsWith(`${PRIMARY_ROOT}${path.sep}`), `path outside the primary root: ${abs}`);
  assert.deepEqual(primaryFiles.filter((abs) => secondaryFiles.includes(abs)), [], "the two Vault corpora must not overlap");
});

// --------------------------------------------------------------------------------------
// 5. server_info's Vault face matches the map's visibility (§18.1)
// --------------------------------------------------------------------------------------

test("§18.1: server_info lists exactly the Vaults the runtime map materialized", async () => {
  const map = await newMap();
  const server = new McpServer({ name: "mv-d0-server-info", version: "0.0.0" });
  registerObsidianCapabilities(server, { vaultScope: vaultScopeOf(map) });
  const client = new Client({ name: "mv-d0-server-info", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name: "server_info", arguments: {} }));
    assert.notEqual(result.isError, true, `server_info failed: ${result.content[0].text}`);
    const payload = JSON.parse(result.content[0].text);
    const inventory = await listWebVaults();
    assert.equal(payload.defaultVaultId, DEFAULT_VAULT_ID);
    assert.deepEqual(payload.vaults.map((vault) => vault.id).sort(), [...map.ids()].sort());
    assert.deepEqual(payload.vaults.map((vault) => vault.id).sort(), inventory.vaults.map((vault) => vault.id).sort(), "one inventory authority (§43-3)");
    for (const vault of payload.vaults) {
      assert.equal("root" in vault, false, "server_info must not leak a Vault root (§18.1/SEC-MV08)");
      assert.ok(Object.keys(vault.capabilities).length > 0, "capabilities must stay the canonical fail-closed map (§3.4)");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// --------------------------------------------------------------------------------------
// 6. Alignment is incremental and releases removed Vaults (§4.2)
// --------------------------------------------------------------------------------------

test("§4.2: refresh aligns incrementally — unchanged Vaults keep their instance, removed Vaults are released once", async () => {
  const disposals = [];
  const map = createVaultRuntimeMap({
    registry: newRegistry(),
    dataRoot: DATA_ROOT,
    primaryRuntime,
    deps: { requireRequestAuthor },
    createRuntime: (input) => {
      const runtime = createVaultRuntime(input);
      return { ...runtime, dispose: () => disposals.push(runtime.id) };
    },
  });

  const first = await map.refresh();
  assert.deepEqual([...first.created].sort(), [SECONDARY]);
  assert.equal(first.released, 0);
  assert.equal(map.size(), 2);
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime);

  const unchanged = await map.refresh();
  assert.deepEqual(unchanged.created, [], "an unchanged registry must not rebuild anything");
  assert.deepEqual(unchanged.reused, [SECONDARY]);
  assert.deepEqual(disposals, [], "a reused Vault keeps its lock, cache and pending work");

  const thirdRoot = path.join(VAULTS_ROOT, "third");
  await fs.mkdir(thirdRoot, { recursive: true });
  const added = await map.refresh();
  assert.deepEqual([...added.created], ["third"]);
  assert.deepEqual([...added.reused], [SECONDARY]);
  assert.equal(map.size(), 3);

  await fs.rm(thirdRoot, { recursive: true, force: true });
  const removed = await map.refresh();
  assert.equal(removed.released, 1);
  assert.deepEqual(disposals, ["third"], "the removed Vault must be released exactly once");
  assert.equal(map.has("third"), false);
  assert.equal(map.get("third"), undefined);
  assert.equal(map.size(), 2);
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime, "the primary instance is never rebuilt or released");
  assert.equal(map.dispose(), 1, "dispose() releases every secondary only");
  assert.deepEqual(disposals, ["third", SECONDARY]);
  assert.equal(map.size(), 1);
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime);
});

// --------------------------------------------------------------------------------------
// 7. Fail-closed edges: no ready snapshot, no second primary, no primary fallback
// --------------------------------------------------------------------------------------

test("a registry without a ready snapshot is refused and never resolves a secondary (§4.2/SEC-MV06)", async () => {
  const map = createVaultRuntimeMap({ registry: newRegistry(), dataRoot: DATA_ROOT, primaryRuntime, deps: { requireRequestAuthor } });
  assert.throws(() => map.align(), (error) => error.code === VAULT_RUNTIME_MAP_NOT_READY);
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime, "the primary instance is present from construction");
  assert.equal(map.get(SECONDARY), undefined);
  assert.equal(map.has(SECONDARY), false);
});

test("a registry whose primary is not the injected primary runtime is refused (§21 MV-I02, no second primary)", async () => {
  const otherRoot = path.join(ROOT, "other-vault");
  await fs.mkdir(otherRoot, { recursive: true });
  const registry = newRegistry({ primaryId: "other", primaryRoot: otherRoot, vaultsRoot: null });
  await registry.refresh();
  const map = createVaultRuntimeMap({ registry, dataRoot: DATA_ROOT, primaryRuntime, deps: { requireRequestAuthor } });
  assert.throws(() => map.align(), (error) => error.code === VAULT_RUNTIME_MAP_PRIMARY_CONFLICT);
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime);
  assert.equal(map.get("other"), undefined, "the map must never materialize a rival primary");
});

test("a vaultId without a materialized runtime is refused, never served by the primary runtime (§47)", async () => {
  const map = await newMap();
  assert.equal(map.release(SECONDARY), true);
  assert.equal(map.has(SECONDARY), false);
  assert.equal(map.get(SECONDARY), undefined, "an unregistered id must never resolve to the primary runtime");
  const sessions = await probeClient(vaultScopeOf(map));
  try {
    const unmaterialized = await sessions.raw({ vaultId: SECONDARY, action: "read", path: "notes/alpha.md" });
    assert.equal(unmaterialized.isError, true);
    assert.equal(unmaterialized.payload.code, "vault_unavailable");
    assert.equal(unmaterialized.payload.runtimeId, undefined, "the handler must not have run");
    const unknown = await sessions.raw({ vaultId: "no-such-vault", action: "read", path: "notes/alpha.md" });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.payload.code, "vault_unavailable");
  } finally {
    await sessions.close();
  }
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime);
  assert.equal(map.release(DEFAULT_VAULT_ID), false, "the primary runtime is owned by the process, not by this map");
});
