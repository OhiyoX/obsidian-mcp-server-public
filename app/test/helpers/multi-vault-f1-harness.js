// Wave F / F1 — shared dual-Vault harness for the completion matrices.
//
// Contract: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置` §29 (a REAL two-Vault matrix per
// toolset), §10.1 (request runtime seam), §21 (MV-I01/I02/I03/I07), §47 (no secondary → primary
// fallback). Extracted so the gap-tool matrices exercise the production registration chain exactly
// like the Wave D lanes instead of each carring its own copy of the fixture.
//
// Usage (order matters — `config.js` resolves at import time):
//   const env = await configureDualVaultEnv({ prefix: "obsidian-mv-f1-gap-" });
//   const { harness, teardown } = await createDualVaultHarness(env);
//   ...
//   await teardown();

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AUTHOR = Object.freeze({ agent: "mv-f1-matrix", model: "test" });
export const PRIMARY_ID = "primary";
export const SECONDARY_ID = "secondary";

/**
 * Create the two-Vault tree and assign the environment BEFORE any `src/**` module is imported.
 * A secondary Vault's root is a sibling under `WEB_VAULTS_ROOT`; the primary lives outside it.
 */
export async function configureDualVaultEnv({ prefix = "obsidian-mv-f1-", secondaryIds = [SECONDARY_ID] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const vaultsRoot = path.join(root, "vaults");
  const primaryRoot = path.join(vaultsRoot, PRIMARY_ID);
  const dataRoot = path.join(root, "data");
  const secondaries = {};
  for (const id of secondaryIds) secondaries[id] = path.join(vaultsRoot, id);
  for (const dir of [vaultsRoot, primaryRoot, dataRoot, ...Object.values(secondaries)]) await fs.mkdir(dir, { recursive: true });

  process.env.VAULT_PATH = primaryRoot;
  process.env.WEB_VAULTS_ROOT = vaultsRoot;
  process.env.WEB_DEFAULT_VAULT = PRIMARY_ID;
  process.env.DATA_PATH = dataRoot;
  process.env.HISTORY_PATH = path.join(dataRoot, "history");
  process.env.TRASH_PATH = path.join(dataRoot, "trash");
  process.env.RETRIEVAL_INDEX_PATH = path.join(dataRoot, "index", "retrieval-index.json");
  process.env.RETRIEVAL_AUTO_EMBED = "false";
  process.env.EMBEDDING_PROVIDER = "disabled";
  process.env.GIT_ENABLED = "false";
  process.env.VERSION_HISTORY_ENABLED = "true";
  process.env.OBSIDIAN_READ_ONLY = "false";
  process.env.WEB_CATALOG_ENABLED = "false";

  return Object.freeze({ root, vaultsRoot, primaryRoot, dataRoot, secondaries });
}

/** Import the production chain once the environment above is fixed, and build the runtime map. */
export async function createDualVaultHarness(env) {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const load = (relative) => import(pathToFileURL(path.join(appDir, relative)).href);

  const { primaryRuntime } = await load("src/vault.js");
  const { DEFAULT_VAULT_ID } = await load("src/oauth-provider.js");
  const { createVaultRegistry } = await load("src/vault-runtime/registry.js");
  const { createVaultRuntimeMap } = await load("src/vault-runtime/instances.js");
  const { WIRED_CAPABILITY_KEYS, wiredCapabilities } = await load("src/vault-runtime/capabilities.js");
  const { CAPABILITY_KEYS } = await load("src/vault-runtime/descriptor.js");
  const { registerObsidianCapabilities } = await load("src/capabilities.js");
  const { withRequestContext, withRequestContextPatch } = await load("src/request-context.js");
  const { VAULT_SCOPED_TOOLS } = await load("src/vault-scope.js");
  const { TOOL_NAMES } = await load("src/config.js");
  const { searchRuntimeFor } = await load("src/search-runtimes.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");

  const map = createVaultRuntimeMap({
    registry: createVaultRegistry({
      primaryRoot: env.primaryRoot,
      primaryId: DEFAULT_VAULT_ID,
      vaultsRoot: env.vaultsRoot,
      writable: true,
    }),
    dataRoot: env.dataRoot,
    primaryRuntime,
    deps: { requireRequestAuthor: () => AUTHOR },
  });
  await map.refresh();

  // The exact pair `server.js` injects into C's registrar: one authority, no fork.
  const vaultScopeOf = (runtimeMap = map) => ({
    resolveVaultRuntime: (id) => runtimeMap.get(id),
    vaultExists: (id) => runtimeMap.has(id),
  });

  /** A real MCP server: the production capability registration behind C's vault-scope registrar. */
  async function toolClient({ runtimeMap = map, register = registerObsidianCapabilities } = {}) {
    const server = new McpServer({ name: "mv-f1-matrix", version: "0.0.0" });
    register(server, { vaultScope: vaultScopeOf(runtimeMap) });
    const client = new Client({ name: "mv-f1-matrix", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const raw = (name, args = {}) => withRequestContextPatch({ author: AUTHOR }, () => client.callTool({ name, arguments: args }));
    const attempt = async (name, args = {}) => {
      const result = await raw(name, args);
      return { isError: result.isError === true, structured: result.structuredContent, text: result.content?.[0]?.text };
    };
    return {
      raw,
      attempt,
      call: async (name, args = {}) => {
        const { isError, structured, text } = await attempt(name, args);
        if (isError) throw new Error(`${name} failed: ${text}`);
        return structured;
      },
      close: async () => { await client.close(); await server.close(); },
    };
  }

  /** Recursive `path:size:sha256` listing; a missing root is an empty tree. */
  async function treeSnapshot(target, prefix = "") {
    const out = [];
    let entries;
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return out;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(target, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...(await treeSnapshot(absolute, relative)));
      else out.push(`${relative}:${(await fs.stat(absolute)).size}:${createHash("sha256").update(await fs.readFile(absolute)).digest("hex")}`);
    }
    return out;
  }

  const exists = (target) => fs.access(target).then(() => true, () => false);
  const drainAll = async () => { for (const id of map.ids()) await searchRuntimeFor(map.get(id)).drain(); };
  const teardown = async () => {
    try { await drainAll(); } catch { /* best effort */ }
    await fs.rm(env.root, { recursive: true, force: true });
  };

  return {
    env,
    map,
    primaryRuntime,
    DEFAULT_VAULT_ID,
    vaultScopeOf,
    toolClient,
    treeSnapshot,
    exists,
    drainAll,
    teardown,
    WIRED_CAPABILITY_KEYS,
    wiredCapabilities,
    CAPABILITY_KEYS,
    TOOL_NAMES,
    VAULT_SCOPED_TOOLS,
    withRequestContext,
  };
}
