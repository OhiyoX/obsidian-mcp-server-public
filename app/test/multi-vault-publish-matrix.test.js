// Wave D / D-publish — real dual-Vault matrix for the publish toolset.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29 Wave D — a REAL two-Vault matrix per toolset instead of assuming the changed foundation made
//       every tool per-Vault; never invent a second Vault selector;
//   §14 Publish integration (Publish already carries `vaultId` records and is the multi-Vault
//       precedent; its `resolveWebVault` dependency reaches the canonical VaultRegistry — done);
//   §13.5 other handles (the publish opaque id records its `vaultId` itself; anonymous resolve is a
//       public capability with its own security model, deliberately outside the credential allowlist);
//   §3.4 capability is a runtime fact (never guessed true, never left silently missing);
//   §21 MV-I01/MV-I03/MV-I07 · §42 SEC-MV06/SEC-MV07 · §43-5 · §47 RETURN list.
//
// Driven here: the *production* publish tools (`registerPublishTools` behind `registerObsidianCapabilities`
// → C's vault-scope registrar → A4's context patch) over the real MCP SDK, against a real primary +
// secondary Vault pair. Every assertion is an on-disk / registry fact, not a handler self-report.
//
// What this lane does NOT change (declared, §3 of the dispatch brief — the merge campaign's publish
// implementation is frozen): `src/publish/service.js`, `src/publish/target.js`,
// `src/publish/lifecycle.js`, `src/tools/publish.js`, `src/publish/target.js` and the Web/Admin
// publish surfaces. This lane only *verifies* them and flips the `publish` capability key.
//
// Declared residuals (verified, not hidden — see the lane HANDOFF):
//   * the Publish registry is ONE process-level store file (`DATA_PATH/publish/state.json`) whose
//     records are keyed by `vaultId + NUL + path`, plus one `mutationQueue` — i.e. vault-keyed records
//     in a shared store, not one store file per Vault. Contract §5.1/§5.2 do not list a publish state
//     path in either layout, and §13.5 sanctions exactly this record shape;
//   * publish resolves its Vault through the canonical Web VaultRegistry instead of
//     `requestContext().vaultRuntime`, because it needs no per-Vault runtime instance (asserted below).
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

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mv-dpublish-matrix-"));
const VAULTS_ROOT = path.join(ROOT, "vaults");
const PRIMARY_ROOT = path.join(VAULTS_ROOT, "primary");
const SECONDARY_ROOT = path.join(VAULTS_ROOT, "secondary");
const DATA_ROOT = path.join(ROOT, "data");
const SECONDARY = "secondary";
// The shared Publish registry (§13.5 vault-keyed records) and the §5.2 secondary data root that
// deliberately does NOT hold a publish store.
const PUBLISH_STATE = path.join(DATA_ROOT, "publish", "state.json");
const SECONDARY_DATA_ROOT = path.join(DATA_ROOT, "vaults", createHash("sha256").update(SECONDARY).digest("hex"));

process.env.VAULT_PATH = PRIMARY_ROOT;
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = "primary";
process.env.DATA_PATH = DATA_ROOT;
process.env.HISTORY_PATH = path.join(DATA_ROOT, "history");
process.env.TRASH_PATH = path.join(DATA_ROOT, "trash");
process.env.RETRIEVAL_INDEX_PATH = path.join(DATA_ROOT, "index", "retrieval-index.json");
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
// A fixed public origin so the returned URLs are assertable instead of environment-dependent.
process.env.PUBLIC_BASE_URL = "https://publish.example";

await fs.mkdir(path.join(PRIMARY_ROOT, "Notes"), { recursive: true });
await fs.mkdir(path.join(SECONDARY_ROOT, "Notes"), { recursive: true });
await fs.mkdir(DATA_ROOT, { recursive: true });
// Same Vault-relative path, different bodies: the strongest per-Vault discriminator.
await fs.writeFile(path.join(PRIMARY_ROOT, "Notes", "same.md"), "# primary body\n", "utf8");
await fs.writeFile(path.join(SECONDARY_ROOT, "Notes", "same.md"), "# secondary body\n", "utf8");
// A note that exists in exactly one Vault: publish must stat the selected Vault's root.
await fs.writeFile(path.join(SECONDARY_ROOT, "Notes", "only-secondary.md"), "# only secondary\n", "utf8");
await fs.writeFile(path.join(PRIMARY_ROOT, "Notes", "only-primary.md"), "# only primary\n", "utf8");

const { primaryRuntime } = await import("../src/vault.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultRegistry } = await import("../src/vault-runtime/registry.js");
const { createVaultRuntimeMap } = await import("../src/vault-runtime/instances.js");
const { CAPABILITY_KEYS } = await import("../src/vault-runtime/descriptor.js");
const { WIRED_CAPABILITY_KEYS, wiredCapabilities } = await import("../src/vault-runtime/capabilities.js");
const { createVaultScopeRegistrar, VAULT_SCOPE_DENY_CODES } = await import("../src/vault-scope-registrar.js");
const { withRequestContextPatch } = await import("../src/request-context.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { registerPublishTools } = await import("../src/tools/publish.js");
const { publishService } = await import("../src/publish/service.js");
const { VAULT_SCOPED_TOOLS } = await import("../src/vault-scope.js");
const { TOOL_NAMES } = await import("../src/config.js");

const AUTHOR = Object.freeze({ agent: "mv-dpublish-matrix", model: "test" });
const testDir = new URL("..", import.meta.url);
const OPEN_ID = /^\/publish\/[A-Za-z0-9_-]{43}$/;

test.after(async () => fs.rm(ROOT, { force: true, recursive: true }));

// ---------------------------------------------------------------------------------------
// Fixtures / helpers
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
const exists = (absPath) => fs.access(absPath).then(() => true, () => false);
const countRecords = async (vaultId) => (await publishService.list({ vaultIds: [vaultId] })).length;
/** The raw shared store: the *fact* this lane must not misdescribe as per-Vault-file. */
async function rawStore() {
  try {
    return JSON.parse(await fs.readFile(PUBLISH_STATE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// `src/publish/service.js` exports one process-level registry (the declared residual of this lane),
// so each test starts from an empty registry — through the service's own public API, never by
// poking its internal state.
async function resetStore() {
  for (const record of await publishService.list({ includeInactive: true })) await publishService.revokeById(record.id);
  await fs.rm(PUBLISH_STATE, { force: true });
}
test.beforeEach(resetStore);

/** A real MCP server: the production capability registration behind C's vault-scope registrar. */
async function toolClient(map) {
  const server = new McpServer({ name: "mv-dpublish-matrix", version: "0.0.0" });
  registerObsidianCapabilities(server, { vaultScope: vaultScopeOf(map) });
  const client = new Client({ name: "mv-dpublish-matrix", version: "0.0.0" });
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

/**
 * Direct-handler harness with the registrar's real gate in front of the handler, plus a handler-run
 * counter — the only way to prove "the handler never ran" (§47: authorization before any Vault I/O)
 * rather than inferring it from the absence of a result.
 */
function countingTools({ vaultExists, resolveVaultRuntime = (id) => (id === DEFAULT_VAULT_ID ? primaryRuntime : undefined) }, allowedVaults) {
  const handlers = new Map();
  const runs = new Map();
  const inner = { registerTool: (name, _descriptor, handler) => { handlers.set(name, handler); } };
  const base = createVaultScopeRegistrar(inner, { resolveVaultRuntime, vaultExists });
  const registrar = {
    ...base,
    registerTool: (name, config, handler) => base.registerTool(name, config, (...args) => {
      runs.set(name, (runs.get(name) || 0) + 1);
      return handler(...args);
    }),
  };
  registerPublishTools(registrar);
  const extra = allowedVaults === undefined ? undefined : { authInfo: { clientId: "mv-dpublish-matrix", allowedVaults } };
  return {
    runs: (name) => runs.get(name) || 0,
    call: (name, args) => handlers.get(name)(args, extra),
  };
}

const pathFreeProse = (result) => (result.content || []).map((item) => item.text ?? "").join("\n");
function assertRefused(result, code, label) {
  assert.equal(result.isError, true, `${label} must be refused: ${pathFreeProse(result)}`);
  assert.equal(result.structuredContent?.code, code, `${label} body: ${pathFreeProse(result)}`);
}

// ---------------------------------------------------------------------------------------
// 1. §1.3 — secondary publish/status/revoke affect only the secondary Vault's records
// ---------------------------------------------------------------------------------------

test("§1.3 dual-Vault: a secondary publish/status/revoke touches only the secondary's records", async () => {
  const map = await newMap();
  assert.deepEqual([...map.ids()].sort(), [DEFAULT_VAULT_ID, SECONDARY]);
  assert.equal(map.unguarded(DEFAULT_VAULT_ID), primaryRuntime, "the primary instance must stay the src/vault.js instance");

  const sessions = await toolClient(map);
  try {
    assert.equal(await countRecords(DEFAULT_VAULT_ID), 0, "the baseline store must be empty");
    assert.equal(await countRecords(SECONDARY), 0);

    const published = await sessions.call("manage_publish", { action: "publish", path: "Notes/same.md", vaultId: SECONDARY });
    assert.equal(published.vaultId, SECONDARY, "the record must carry the selected Vault");
    assert.equal(published.path, "Notes/same.md");
    assert.equal(published.published, true);
    assert.equal(published.changed, true);
    assert.match(published.publicPath, OPEN_ID);
    assert.equal(published.publicUrl, `https://publish.example${published.publicPath}`);
    assert.ok(!JSON.stringify(published).includes(ROOT), "a publish payload must never leak a server path (§15 S03)");

    // On-disk truth: exactly one record, bound to the secondary Vault.
    const store = await rawStore();
    assert.equal(store.version, 2);
    assert.equal(store.records.length, 1, "a secondary publish must add exactly one record");
    assert.equal(store.records[0].vaultId, SECONDARY);
    assert.equal(store.records[0].path, "Notes/same.md");
    assert.equal(store.records[0].id, published.publicPath.slice("/publish/".length));

    // Primary zero side-effect: the same Vault-relative path stays unpublished on the primary.
    assert.equal((await sessions.call("get_publish_status", { path: "Notes/same.md", vaultId: DEFAULT_VAULT_ID })).published, false);
    assert.equal(await countRecords(DEFAULT_VAULT_ID), 0, "no primary record may be created by a secondary publish");

    // The secondary reads back its own record, idempotently.
    const status = await sessions.call("get_publish_status", { path: "Notes/same.md", vaultId: SECONDARY });
    assert.equal(status.published, true);
    assert.equal(status.publicPath, published.publicPath);
    const again = await sessions.call("manage_publish", { action: "publish", path: "Notes/same.md", vaultId: SECONDARY });
    assert.equal(again.changed, false, "republishing an active target is idempotent");
    assert.equal(again.publicPath, published.publicPath);

    // §13.5 store shape, as a fact: one shared file with vault-keyed records, and NO per-Vault store
    // file under the §5.2 secondary data root.
    assert.equal(await exists(PUBLISH_STATE), true, "the Publish registry keeps its single shared store file");
    assert.equal(await exists(path.join(SECONDARY_DATA_ROOT, "publish")), false, "this lane does not (and must not) invent a per-Vault publish store");

    const revoked = await sessions.call("manage_publish", { action: "revoke", path: "Notes/same.md", vaultId: SECONDARY });
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.changed, true);
    assert.equal(await countRecords(SECONDARY), 0, "the secondary record must be gone");
    assert.equal((await sessions.call("get_publish_status", { path: "Notes/same.md", vaultId: DEFAULT_VAULT_ID })).published, false);
    assert.equal((await rawStore()).records.length, 0);
  } finally {
    await sessions.close();
  }
});

// ---------------------------------------------------------------------------------------
// 2. §13.5 — the same Vault-relative path is two independent records, one per Vault
// ---------------------------------------------------------------------------------------

test("§13.5 dual-Vault: the same path in both Vaults stays two independent opaque records", async () => {
  const map = await newMap();
  const sessions = await toolClient(map);
  try {
    const primary = await sessions.call("manage_publish", { action: "publish", path: "Notes/same.md", vaultId: DEFAULT_VAULT_ID });
    const secondary = await sessions.call("manage_publish", { action: "publish", path: "Notes/same.md", vaultId: SECONDARY });
    assert.equal(primary.vaultId, DEFAULT_VAULT_ID, "the primary record must carry the primary Vault");
    assert.equal(secondary.vaultId, SECONDARY, "the secondary record must carry the secondary Vault");
    assert.notEqual(primary.publicPath, secondary.publicPath, "the opaque ids must be distinct (§15 S04)");

    const records = (await rawStore()).records;
    assert.equal(records.length, 2, "one record per Vault, keyed by vaultId + path");
    assert.deepEqual(records.map((record) => record.vaultId).sort(), [DEFAULT_VAULT_ID, SECONDARY].sort());
    assert.ok(records.every((record) => record.path === "Notes/same.md"));

    // Revoking the secondary record must not disturb the primary's.
    assert.equal((await sessions.call("manage_publish", { action: "revoke", path: "Notes/same.md", vaultId: SECONDARY })).revoked, true);
    const surviving = await sessions.call("get_publish_status", { path: "Notes/same.md", vaultId: DEFAULT_VAULT_ID });
    assert.equal(surviving.published, true);
    assert.equal(surviving.publicPath, primary.publicPath, "the primary keeps its original opaque id");
    assert.equal((await sessions.call("get_publish_status", { path: "Notes/same.md", vaultId: SECONDARY })).published, false);
    assert.equal((await rawStore()).records.length, 1);

    assert.equal((await sessions.call("manage_publish", { action: "revoke", path: "Notes/same.md", vaultId: DEFAULT_VAULT_ID })).revoked, true);
    assert.equal((await rawStore()).records.length, 0);
  } finally {
    await sessions.close();
  }
});

// ---------------------------------------------------------------------------------------
// 3. §1.3/§42 — the target gate stats the SELECTED Vault's root, never the primary's
// ---------------------------------------------------------------------------------------

test("§42: the publish target gate resolves inside the selected Vault (no primary fallback)", async () => {
  const map = await newMap();
  const sessions = await toolClient(map);
  try {
    const secondaryOnly = await sessions.call("manage_publish", { action: "publish", path: "Notes/only-secondary.md", vaultId: SECONDARY });
    assert.equal(secondaryOnly.published, true);
    assert.equal(secondaryOnly.vaultId, SECONDARY);

    // The identical path does not exist in the primary Vault → structured miss, nothing written.
    const primaryMiss = await sessions.raw("manage_publish", { action: "publish", path: "Notes/only-secondary.md", vaultId: DEFAULT_VAULT_ID });
    assertRefused(primaryMiss, "publish_target_missing", "publishing a secondary-only note in the primary");
    const secondaryMiss = await sessions.raw("manage_publish", { action: "publish", path: "Notes/only-primary.md", vaultId: SECONDARY });
    assertRefused(secondaryMiss, "publish_target_missing", "publishing a primary-only note in the secondary");
    assert.equal(await countRecords(DEFAULT_VAULT_ID), 0, "a refused publish must not create a record");
    assert.equal(await countRecords(SECONDARY), 1);

    // `get_publish_status` uses the same per-Vault resolution (statWebNote on the selected root).
    assertRefused(await sessions.raw("get_publish_status", { path: "Notes/only-primary.md", vaultId: SECONDARY }), "publish_target_missing", "status of a primary-only note in the secondary");
    assert.equal((await sessions.call("get_publish_status", { path: "Notes/only-primary.md", vaultId: DEFAULT_VAULT_ID })).published, false);

    const primaryOnly = await sessions.call("manage_publish", { action: "publish", path: "Notes/only-primary.md", vaultId: DEFAULT_VAULT_ID });
    assert.equal(primaryOnly.published, true);
    assert.equal(primaryOnly.vaultId, DEFAULT_VAULT_ID);
    const records = (await rawStore()).records;
    assert.deepEqual(records.map((record) => [record.vaultId, record.path]).sort(), [
      [DEFAULT_VAULT_ID, "Notes/only-primary.md"],
      [SECONDARY, "Notes/only-secondary.md"],
    ].sort());
  } finally {
    await sessions.close();
  }
});

// ---------------------------------------------------------------------------------------
// 4. §21 MV-I07 — no vaultId keeps the legacy primary semantics
// ---------------------------------------------------------------------------------------

test("§21 MV-I07: without vaultId the publish face keeps the primary Vault semantics", async () => {
  const map = await newMap();
  const sessions = await toolClient(map);
  try {
    const legacy = await sessions.call("manage_publish", { action: "publish", path: "Notes/only-primary.md" });
    assert.equal(legacy.vaultId, DEFAULT_VAULT_ID);
    const explicit = await sessions.call("get_publish_status", { path: "Notes/only-primary.md", vaultId: DEFAULT_VAULT_ID });
    const implicit = await sessions.call("get_publish_status", { path: "Notes/only-primary.md" });
    assert.deepEqual(implicit, explicit, "an omitted vaultId must be byte-identical to the explicit primary selection");

    // A primary-only path is still a structured miss when no Vault is selected (no silent retargeting).
    assertRefused(await sessions.raw("manage_publish", { action: "publish", path: "Notes/only-secondary.md" }), "publish_target_missing", "primary default with a secondary-only path");
    assert.equal(await countRecords(SECONDARY), 0, "the primary default must never write a secondary record");
  } finally {
    await sessions.close();
  }
});

// ---------------------------------------------------------------------------------------
// 5. §47 — refusal happens before the handler, with no Vault I/O and no store write
// ---------------------------------------------------------------------------------------

test("§47: an unmaterialized, unauthorized or invalid Vault is refused before the handler runs", async () => {
  assert.equal(await exists(PUBLISH_STATE), false, "a fresh run must start without a store");

  // (a) vaultExists:false — the id is not materialized by the D0 map (server.js wiring).
  const denied = countingTools({ vaultExists: () => false });
  assertRefused(await denied.call("manage_publish", { action: "publish", path: "Notes/only-primary.md", vaultId: SECONDARY }), VAULT_SCOPE_DENY_CODES.UNAVAILABLE, "unmaterialized secondary");
  assertRefused(await denied.call("get_publish_status", { path: "Notes/only-primary.md", vaultId: "no-such-vault" }), VAULT_SCOPE_DENY_CODES.UNAVAILABLE, "unknown Vault");
  assert.equal(denied.runs("manage_publish"), 0, "an unmaterialized Vault must never reach the handler (§47)");
  assert.equal(denied.runs("get_publish_status"), 0);
  assert.equal(await exists(PUBLISH_STATE), false, "a refused request must not create the store (0 Vault I/O)");

  // (b) authorization: an allowedVaults list that excludes the selection is refused, handler never runs.
  const unauthorized = countingTools({ vaultExists: () => true }, [DEFAULT_VAULT_ID]);
  assertRefused(await unauthorized.call("manage_publish", { action: "publish", path: "Notes/only-primary.md", vaultId: SECONDARY }), VAULT_SCOPE_DENY_CODES.ACCESS_DENIED, "unauthorized secondary");
  assert.equal(unauthorized.runs("manage_publish"), 0, "authorization must precede any Vault work (§34/§47)");
  assert.equal(await exists(PUBLISH_STATE), false);
  // §34-3: no vaultId with a primary-only credential is allowed (MV-I07).
  const allowedPrimary = await unauthorized.call("get_publish_status", { path: "Notes/only-primary.md" });
  assert.notEqual(allowedPrimary.isError, true, pathFreeProse(allowedPrimary));
  assert.equal(unauthorized.runs("get_publish_status"), 1);

  // (c) a malformed id is a stable structured refusal.
  const invalid = countingTools({ vaultExists: () => true });
  assertRefused(await invalid.call("manage_publish", { action: "publish", path: "Notes/only-primary.md", vaultId: "../escape" }), VAULT_SCOPE_DENY_CODES.INVALID_ID, "traversing vaultId");
  assert.equal(invalid.runs("manage_publish"), 0);

  // (d) the wired case still works and only then writes.
  const wired = countingTools({ vaultExists: (id) => id === DEFAULT_VAULT_ID || id === SECONDARY });
  const ok = await wired.call("manage_publish", { action: "publish", path: "Notes/only-primary.md", vaultId: DEFAULT_VAULT_ID });
  assert.notEqual(ok.isError, true, pathFreeProse(ok));
  assert.equal(wired.runs("manage_publish"), 1);
  assert.equal((await rawStore()).records.length, 1);

  await publishService.revoke(DEFAULT_VAULT_ID, "Notes/only-primary.md");
  await fs.rm(path.join(DATA_ROOT, "publish"), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------
// 6. §13.5 — the anonymous opaque-id resolve binds the record's own Vault
// ---------------------------------------------------------------------------------------

test("§13.5: an opaque id resolves its own Vault's note, and a revoked id never revives", async () => {
  const map = await newMap();
  const sessions = await toolClient(map);
  try {
    const primary = await sessions.call("manage_publish", { action: "publish", path: "Notes/same.md", vaultId: DEFAULT_VAULT_ID });
    const secondary = await sessions.call("manage_publish", { action: "publish", path: "Notes/same.md", vaultId: SECONDARY });

    // The public route's service half (`GET /publish/:id` → publishService.resolve) must read the
    // *record's* Vault, not the process default.
    const secondaryResolved = await publishService.resolve(secondary.publicPath.slice("/publish/".length));
    assert.equal(secondaryResolved.record.vaultId, SECONDARY);
    assert.equal(secondaryResolved.note.content, "# secondary body\n", "an opaque id must serve the body from its own Vault");
    const primaryResolved = await publishService.resolve(primary.publicPath.slice("/publish/".length));
    assert.equal(primaryResolved.record.vaultId, DEFAULT_VAULT_ID);
    assert.equal(primaryResolved.note.content, "# primary body\n");

    // Revoking one Vault's record never touches the other's, and the retired id stays dead (§5.1).
    await sessions.call("manage_publish", { action: "revoke", path: "Notes/same.md", vaultId: SECONDARY });
    assert.equal(await publishService.resolve(secondary.publicPath.slice("/publish/".length)), null);
    const stillThere = await publishService.resolve(primary.publicPath.slice("/publish/".length));
    assert.equal(stillThere.note.content, "# primary body\n");
  } finally {
    await sessions.close();
  }
  await publishService.revoke(DEFAULT_VAULT_ID, "Notes/same.md");
});

// ---------------------------------------------------------------------------------------
// 7. §3.4 — the flipped `publish` key is a runtime fact, and no other key is over-claimed
// ---------------------------------------------------------------------------------------

test("§3.4: `publish` is flipped only together with a per-Vault toolset (and stays fail-closed otherwise)", async () => {
  const map = await newMap();
  const capabilities = map.get(SECONDARY).capabilities;

  assert.deepEqual(
    [...WIRED_CAPABILITY_KEYS].sort(),
    // D-plans landed after this lane and legitimately added `plans`; Wave F / F1 (§31) then
    // converged `retrieval`. The claim below is the ten-key Wave D + F1 set (extended, never
    // loosened — exact equality stays).
    ["files", "git", "history", "memory", "notes", "plans", "publish", "retrieval", "skills", "trash"],
    "the wired set must be exactly the Wave D + F1 claim — any extra key here would be an over-claim (§3.4)",
  );
  assert.deepEqual(capabilities.publish, { available: true }, "publish is wired by this lane and must be reported available");
  const graph = wiredCapabilities();
  assert.deepEqual([...WIRED_CAPABILITY_KEYS].sort(), Object.keys(graph).filter((key) => graph[key].available === true).sort());
  for (const key of CAPABILITY_KEYS) {
    if (WIRED_CAPABILITY_KEYS.includes(key)) continue;
    assert.equal(graph[key].available, false, `${key} is not wired by a Wave D lane or Wave F / F1 and must stay fail closed (§3.4)`);
    assert.ok(graph[key].reason.length > 0, `${key} must carry a visible reason`);
  }

  // The claimed tools are canonical + vault-scoped, and the mapping matches the static catalog.
  const PUBLISH_TOOLS = Object.freeze(["get_publish_status", "manage_publish"]);
  for (const name of PUBLISH_TOOLS) {
    assert.ok(TOOL_NAMES.includes(name), `${name} must be a canonical tool`);
    assert.ok(VAULT_SCOPED_TOOLS.includes(name), `${name} must be classified vault-scoped`);
  }

  // The seam: the handler reads the *selected* `requestContext().vaultId` and the service resolves it
  // through the canonical Web VaultRegistry. Publish deliberately does NOT consume
  // `vault-runtime/request-vault.js` (it needs no per-Vault runtime instance) and must never fall
  // back to the primary façade or the global VAULT root (§43-5 / §47).
  const publishToolSource = await fs.readFile(new URL("src/tools/publish.js", testDir), "utf8");
  for (const required of ["request-context.js", "requestContext()", "vaultId", "publish/service.js"]) {
    assert.ok(publishToolSource.includes(required), `src/tools/publish.js must route through ${required}`);
  }
  assert.ok(!publishToolSource.includes('from "../vault.js"'), "src/tools/publish.js must not consume the primary façade");
  assert.ok(!publishToolSource.includes('from "../config.js"'), "src/tools/publish.js must not import a global config root");
  const serviceSource = await fs.readFile(new URL("src/publish/service.js", testDir), "utf8");
  // Wave F / F1 (§14): the dependency is the canonical registry's own resolver, not the Web-shaped
  // projection, and it is imported from the one canonical registry module.
  assert.ok(serviceSource.includes("resolveCanonicalVault"), "src/publish/service.js must resolve the Vault through the canonical registry resolver (§14)");
  assert.ok(serviceSource.includes('from "../app/vault-registry.js"'), "the resolver must come from the canonical registry module");
  assert.ok(!/from "\.[.\/]*vault-runtime\/registry\.js"/.test(serviceSource), "src/publish/service.js must not construct/import a second registry");
});

// ---------------------------------------------------------------------------------------
// 8. §21 MV-I01/MV-I03 — the shared mutation lane never cross-assigns a Vault
// ---------------------------------------------------------------------------------------

test("§21 MV-I01/MV-I03: concurrent publishes in two Vaults stay bound to their own Vault", async () => {
  const map = await newMap();
  const sessions = await toolClient(map);
  try {
    const [primary, secondary] = await Promise.all([
      sessions.call("manage_publish", { action: "publish", path: "Notes/same.md", vaultId: DEFAULT_VAULT_ID }),
      sessions.call("manage_publish", { action: "publish", path: "Notes/same.md", vaultId: SECONDARY }),
    ]);
    assert.equal(primary.vaultId, DEFAULT_VAULT_ID);
    assert.equal(secondary.vaultId, SECONDARY);

    // Four more concurrent calls (two per Vault, same path): the shared queue may serialize them, but
    // it must never hand one Vault's record to the other.
    await Promise.all([
      sessions.call("manage_publish", { action: "publish", path: "Notes/same.md", vaultId: DEFAULT_VAULT_ID }),
      sessions.call("manage_publish", { action: "publish", path: "Notes/same.md", vaultId: SECONDARY }),
      sessions.call("get_publish_status", { path: "Notes/same.md", vaultId: DEFAULT_VAULT_ID }),
      sessions.call("get_publish_status", { path: "Notes/same.md", vaultId: SECONDARY }),
    ]);

    const records = (await rawStore()).records;
    assert.equal(records.length, 2, "concurrency must not duplicate or drop a record");
    assert.deepEqual(records.map((record) => record.vaultId).sort(), [DEFAULT_VAULT_ID, SECONDARY].sort());
    assert.equal(records.find((record) => record.vaultId === DEFAULT_VAULT_ID).id, primary.publicPath.slice("/publish/".length));
    assert.equal(records.find((record) => record.vaultId === SECONDARY).id, secondary.publicPath.slice("/publish/".length));
    assert.deepEqual([...new Set(records.map((record) => record.id))].length, 2, "the two opaque ids stay distinct");
  } finally {
    await sessions.close();
  }
  await publishService.revoke(DEFAULT_VAULT_ID, "Notes/same.md");
  await publishService.revoke(SECONDARY, "Notes/same.md");
});
