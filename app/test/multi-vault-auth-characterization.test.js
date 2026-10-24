// MCP multi-Vault auth matrix — W0-E characterization flipped by Wave C.
//
// Truth source: `Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置.md`
// §1.4, §1.5, §7, §8, §9, §9.1, §9.2, §25 W0-E, §28, §34, §43-3, §44. Companion doc:
// `docs/multi-vault/W0-E-auth-characterization.md`.
//
// What this file now freezes on the Wave C head (the W0-E file described the pre-#285 head; Wave C
// is the owner of these semantics and updated both the assertions and the companion doc in the same
// commit, as the W0-E header demands):
//  1. `auth.js requestedVaults()` classifies a `tools/call` through the canonical vault-scope
//     registry: a vault-scoped tool requires `args.vaultId ?? DEFAULT_VAULT_ID`, a global tool
//     (`agent_bootstrap` / `server_info`) and an unknown name require nothing.  (§9, §9.1, §43-3)
//  2. `deniedVault()` still denies at the HTTP auth layer with `403 {error:"access_denied"}` plus an
//     `auth.reject` audit record, and the MCP handler never runs.                       (§9)
//  3. A JSON-RPC batch unions the required vault ids of its vault-scoped members.       (§9)
//  4. The configured env API key is primary-only and is refused at the HTTP layer too.  (§9.2)
//  5. `server_info` is additive: `defaultVaultId` plus the caller-filtered Vault list.  (§18.1)
//
// Slice ownership of the changes these assertions follow:
//  - slice C (this lane) replaced the Publish-only set with the canonical vault-scope registry, moved
//    the vault gate to the contract §8 order (scopes before vaults) and added the §9.2 gate;
//  - A4 (#285 owner) changed the attribution/audit layer, not the vault semantics;
//  - #254/#277/#278 do not touch this surface.
//
// Everything runs against real modules: the real `createAuthMiddleware`, the real
// `PersistentOAuthProvider` (temp DATA_PATH), a real express app and a real HTTP socket whose
// `/mcp` handler counts invocations, plus a real in-process MCP client for `server_info`.
// No auth logic is stubbed.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIGURED_KEY, MCP_URL, createAuthRevokeHarness } from "./helpers/access-policy-auth-harness.js";
import { CAPABILITY_KEYS } from "../src/vault-runtime/descriptor.js";

// `src/config.js` resolves VAULT/DATA at module evaluation, so the lane Vault has to exist
// before the harness dynamically imports the source modules. DATA_PATH belongs to the harness
// (its own temp root); VAULT_PATH is this lane's temp Vault.
const LANE_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-w0e-auth-"));
process.env.VAULT_PATH = path.join(LANE_ROOT, "vault");
await mkdir(process.env.VAULT_PATH, { recursive: true });

const harness = await createAuthRevokeHarness();
const { provider, uniqueAgent, boot, auditFor, teardown } = harness;

const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { TOOL_NAMES } = await import("../src/config.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { GLOBAL_TOOLS, VAULT_SCOPED_TOOLS } = await import("../src/vault-scope.js");

const ALL_SCOPES = ["obsidian.read", "obsidian.write", "obsidian.files"];
const DEFAULT_VAULT = DEFAULT_VAULT_ID;
// Wave C: the canonical registry (contract §7) is the only classification source; `auth.js` consumes
// it directly, so the ratchet below compares the middleware's behaviour with the production set.
const SCOPED_TOOLS_TODAY = [...VAULT_SCOPED_TOOLS];
const VAULT_DENIED_BODY = { error: "access_denied", error_description: "Vault access denied" };
// Single-Vault health keys (vault.js:488) plus the server-level keys of tools/info.js, plus the
// contract §18.1 additive Vault face (`defaultVaultId` + `vaults`).
const SERVER_INFO_KEYS = [
  "commit", "dataPath", "defaultVaultId", "defaultVaultSource", "deployedAt", "deployedAtFormatted", "discovery", "effectiveDefaultVaultId", "historyPath", "index",
  "maxReadBytes", "maxVersionsPerFile", "ok", "onboarding", "readOnly", "tools", "trashPath", "vaultPath", "vaults",
  "version", "versionHistoryEnabled",
];
const SAFE_VAULT_KEYS = ["capabilities", "id", "name", "primary", "writable"];

after(async () => {
  await teardown();
  await rm(LANE_ROOT, { recursive: true, force: true });
});

let sequence = 0;

function toolCall(name, args = {}) {
  sequence += 1;
  return { jsonrpc: "2.0", id: sequence, method: "tools/call", params: { name, arguments: args } };
}

/** Real OAuth access token; `allowedVaults` is the credential allowlist carried by the record. */
function accessToken(allowedVaults, scopes = ALL_SCOPES) {
  sequence += 1;
  return provider.issueTokens(`w0e-client-${sequence}`, scopes, MCP_URL, null, allowedVaults).access_token;
}

async function withApp(run) {
  const app = await boot();
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

async function post(app, { bearer, key, body, agent }) {
  const response = await app.call({ bearer, key, body, agent });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

/**
 * Number of names on which two scope sets disagree. Used by the ratchet assertion and by its
 * negative control, so the control exercises the very comparison the ratchet relies on.
 */
function scopeSetDifferences(classified, expected) {
  const names = [...new Set([...classified, ...expected])].sort();
  return names.filter((name) => classified.includes(name) !== expected.includes(name));
}

// ---------------------------------------------------------------------------
// 1. `requestedVaults()` (auth.js:64-70) — machine-verifiable form of old-red 2.
// ---------------------------------------------------------------------------

test("a vault-scoped tools/call reads args.vaultId and falls back to the default Vault (§9)", async () => {
  // Contract §9 + §34-1..§34-4. The canonical registry decides which tools are scoped; the
  // required Vault of a scoped call is `args.vaultId ?? DEFAULT_VAULT_ID`.
  const defaultOnly = accessToken([DEFAULT_VAULT]);
  const secondaryOnly = accessToken(["secondary"]);
  const agent = uniqueAgent("scoped-vaultid-honoured");
  await withApp(async (app) => {
    // (a) default-only credential + explicit secondary Vault → the argument is now the requirement.
    const denied = await post(app, { bearer: defaultOnly, body: toolCall("list_notes", { vaultId: "secondary" }), agent });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, VAULT_DENIED_BODY);
    // (b) mirror image: the same call is allowed for a credential that holds `secondary`, which
    // proves (a) honoured `vaultId` instead of defaulting to the default Vault.
    const honoured = await post(app, { bearer: secondaryOnly, body: toolCall("list_notes", { vaultId: "secondary" }), agent });
    assert.equal(honoured.status, 200);
    // (c) secondary-only credential + no vaultId → default Vault (the primary fixture) → denied.
    const missing = await post(app, { bearer: secondaryOnly, body: toolCall("list_notes", { path: "a.md" }), agent });
    assert.equal(missing.status, 403);
    assert.deepEqual(missing.body, VAULT_DENIED_BODY);
    // Only (b) reached the handler: every deny precedes the MCP transport.
    assert.equal(app.handled.length, 1);
  });
});

test("§8 order: an unauthorized Vault on a credential that also lacks a scope answers insufficient_scope", async () => {
  // Contract §8 ("HTTP credential verify -> required scopes -> requested vault IDs -> allowedVaults").
  // Pre-Wave-C the vault gate ran first and this request answered `access_denied` (W0-E finding).
  const wrongVault = accessToken([DEFAULT_VAULT], ["obsidian.read"]);
  const agent = uniqueAgent("scope-before-vault");
  await withApp(async (app) => {
    const response = await post(app, { bearer: wrongVault, body: toolCall("write_note", { path: "a.md", content: "x", vaultId: "secondary" }), agent });
    assert.equal(response.status, 403);
    assert.equal(response.body.error, "insufficient_scope");
    assert.ok(response.headers.get("www-authenticate")?.includes('error="insufficient_scope"'));
    assert.equal(app.handled.length, 0);
    const reject = await auditFor({ action: "auth.reject", userAgent: agent });
    assert.equal(reject.length, 1);
    assert.match(reject[0].detail, /^missing scope: /);
  });
});

test("the two Publish tools read args.vaultId and fall back to the default Vault", async () => {
  // Contract §34-3,§34-4. Wave C keeps this reading rule but sources the set from the canonical
  // registry and enforces it through the canonical (registrar-injected) `vaultId` input.
  const defaultOnly = accessToken([DEFAULT_VAULT]);
  const secondaryOnly = accessToken(["secondary"]);
  const both = accessToken([DEFAULT_VAULT, "secondary"]);
  const agent = uniqueAgent("scoped-vaultid");
  const cases = [
    { token: secondaryOnly, tool: "get_publish_status", args: { path: "a.md", vaultId: "secondary" }, status: 200 },
    { token: secondaryOnly, tool: "get_publish_status", args: { path: "a.md" }, status: 403 },
    { token: defaultOnly, tool: "manage_publish", args: { action: "status", path: "a.md" }, status: 200 },
    { token: defaultOnly, tool: "manage_publish", args: { action: "status", path: "a.md", vaultId: "secondary" }, status: 403 },
    { token: both, tool: "manage_publish", args: { action: "status", path: "a.md", vaultId: "secondary" }, status: 200 },
  ];
  await withApp(async (app) => {
    for (const item of cases) {
      const response = await post(app, { bearer: item.token, body: toolCall(item.tool, item.args), agent });
      assert.equal(response.status, item.status, `${item.tool} ${JSON.stringify(item.args)}`);
      if (item.status === 403) assert.deepEqual(response.body, VAULT_DENIED_BODY);
    }
    assert.equal(app.handled.length, 3);
  });
});

// ---------------------------------------------------------------------------
// 2. Ratchet over the whole canonical catalog.
// ---------------------------------------------------------------------------

test("ratchet: across all 91 canonical tools only the canonical vault-scoped set is vault-gated", async () => {
  // Contract §7 + §9.1 (every registered tool must be classified). The classification is
  // observed through the real middleware: a tool whose required vault is `secondary` while the
  // credential holds only `default` is denied; global tools and unknown names are allowed.
  assert.equal(TOOL_NAMES.length, 91, "canonical tool count ratchet: 89 after .29 (patch_base) + 1 for #630 create_base_entry + 1 for #470 wave A start_direct_upload");
  assert.deepEqual([...GLOBAL_TOOLS], ["agent_bootstrap", "server_info"]);
  assert.equal(SCOPED_TOOLS_TODAY.length, TOOL_NAMES.length - GLOBAL_TOOLS.length);
  for (const name of SCOPED_TOOLS_TODAY) assert.ok(TOOL_NAMES.includes(name), `${name} is not canonical`);
  const defaultOnly = accessToken([DEFAULT_VAULT]);
  const agent = uniqueAgent("scope-ratchet");
  await withApp(async (app) => {
    const classified = [];
    for (const name of TOOL_NAMES) {
      const response = await post(app, { bearer: defaultOnly, body: toolCall(name, { vaultId: "secondary" }), agent });
      if (response.status === 200) continue;
      assert.equal(response.status, 403, `${name}: unexpected status ${response.status}`);
      assert.deepEqual(response.body, VAULT_DENIED_BODY, name);
      classified.push(name);
    }
    assert.deepEqual(scopeSetDifferences(classified, SCOPED_TOOLS_TODAY), [], "vault-scoped tool set changed");
    assert.deepEqual([...classified].sort(), [...SCOPED_TOOLS_TODAY].sort());
  });
});

// ---------------------------------------------------------------------------
// 3. Batch semantics (`requestMessages` + the `Set` in auth.js:69).
// ---------------------------------------------------------------------------

test("a batch unions the required Vault of its vault-scoped members (§9)", async () => {
  // Contract §9 (batch unions required vault ids) — every vault-scoped member contributes its own
  // `args.vaultId ?? DEFAULT_VAULT_ID`; one unauthorized id denies the whole HTTP request.
  const defaultOnly = accessToken([DEFAULT_VAULT]);
  const secondaryOnly = accessToken(["secondary"]);
  const both = accessToken([DEFAULT_VAULT, "secondary"]);
  const agent = uniqueAgent("batch-mixed");
  const globalPair = [toolCall("list_notes", { vaultId: "secondary" }), toolCall("get_note", { path: "a.md", vaultId: "secondary" })];
  const mixedPair = [toolCall("manage_publish", { action: "status", path: "a.md", vaultId: "secondary" }), toolCall("list_notes", {})];
  await withApp(async (app) => {
    // Both members name `secondary`: allowed only for a credential that holds it.
    const allowed = await post(app, { bearer: both, body: globalPair, agent });
    assert.equal(allowed.status, 200);
    const denied = await post(app, { bearer: defaultOnly, body: globalPair, agent });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, VAULT_DENIED_BODY);
    // Mixed batch: explicit `secondary` ∪ implicit default — the second member contributes the
    // default Vault instead of collapsing the whole request to it (pre-Wave-C short-circuit).
    const mixedAllowed = await post(app, { bearer: both, body: mixedPair, agent });
    assert.equal(mixedAllowed.status, 200);
    const mixedDenied = await post(app, { bearer: secondaryOnly, body: mixedPair, agent });
    assert.equal(mixedDenied.status, 403);
    assert.deepEqual(mixedDenied.body, VAULT_DENIED_BODY);
    assert.equal(app.handled.length, 2);
  });
});

test("an all-vault-scoped batch unions and dedupes vault ids before any handler", async () => {
  // Contract §9 ("batch 去重全部 required vault IDs"; 任一缺失 → handler 0 次执行).
  const defaultOnly = accessToken([DEFAULT_VAULT]);
  const both = accessToken([DEFAULT_VAULT, "secondary"]);
  const agent = uniqueAgent("batch-scoped");
  const sameVault = [toolCall("get_publish_status", { path: "a.md", vaultId: "secondary" }), toolCall("manage_publish", { action: "status", path: "a.md", vaultId: "secondary" })];
  const twoVaults = [toolCall("get_publish_status", { path: "a.md", vaultId: "secondary" }), toolCall("get_publish_status", { path: "a.md", vaultId: "ghost" })];
  await withApp(async (app) => {
    const deduped = await post(app, { bearer: both, body: sameVault, agent });
    assert.equal(deduped.status, 200);
    const missing = await post(app, { bearer: defaultOnly, body: sameVault, agent });
    assert.equal(missing.status, 403);
    assert.deepEqual(missing.body, VAULT_DENIED_BODY);
    // One unauthorized id denies the entire batch, including the member that would pass.
    const partial = await post(app, { bearer: both, body: twoVaults, agent });
    assert.equal(partial.status, 403);
    assert.deepEqual(partial.body, VAULT_DENIED_BODY);
    assert.equal(app.handled.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. Denial shape, audit record and the "handler 0 runs" mechanism.
// ---------------------------------------------------------------------------

test("characterization: the vault denial shape and audit record are frozen", async () => {
  // Contract §9 / §34-2. `deniedVault()` returns a vault id; the middleware answers with a plain
  // HTTP 403 (no JSON-RPC error envelope, no WWW-Authenticate) and never calls `next()`, so
  // Express never reaches the MCP router. Slice C keeps this deny surface.
  const secondaryOnly = accessToken(["secondary"]);
  const agent = uniqueAgent("deny-shape");
  await withApp(async (app) => {
    const response = await post(app, { bearer: secondaryOnly, body: toolCall("get_publish_status", { path: "a.md" }), agent });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, VAULT_DENIED_BODY);
    assert.deepEqual(Object.keys(response.body).sort(), ["error", "error_description"]);
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.equal(app.handled.length, 0);

    const reject = await auditFor({ action: "auth.reject", userAgent: agent });
    assert.equal(reject.length, 1);
    const entry = reject[0];
    assert.deepEqual(
      {
        action: entry.action, outcome: entry.outcome, credentialType: entry.credentialType,
        vaults: entry.vaults, scopes: entry.scopes, tool: entry.tool, method: entry.method, detail: entry.detail,
      },
      {
        action: "auth.reject", outcome: "failure", credentialType: "oauth-access",
        vaults: ["secondary"], scopes: ALL_SCOPES, tool: "get_publish_status", method: "tools/call",
        detail: `vault access denied: ${DEFAULT_VAULT}`,
      },
    );
    assert.equal(typeof entry.clientId, "string");
    // No principal field on this record: attribution for this denial is #285's scope (A4).
    assert.equal(entry.userId, undefined);
  });
});

test("the configured env API key is primary-only at the HTTP layer (§9.2)", async () => {
  // Contract §9.2 keeps the configured key on the primary/default Vault. Wave C closes the HTTP-layer
  // hole W0-E found (auth.js used to set `allowedVaults: [DEFAULT_VAULT_ID]` and never evaluate
  // `deniedVault()`): the key is now refused before the transport for any other vaultId.
  const agent = uniqueAgent("configured-key");
  await withApp(async (app) => {
    const denied = await post(app, { key: CONFIGURED_KEY, body: toolCall("get_publish_status", { path: "a.md", vaultId: "secondary" }), agent });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, VAULT_DENIED_BODY);
    assert.equal(app.handled.length, 0);
    const reject = await auditFor({ action: "auth.reject", userAgent: agent });
    assert.equal(reject.length, 1);
    assert.deepEqual(
      { credentialType: reject[0].credentialType, credentialId: reject[0].credentialId, vaults: reject[0].vaults, detail: reject[0].detail },
      { credentialType: "api-key", credentialId: "configured-env", vaults: [DEFAULT_VAULT], detail: "vault access denied: secondary" },
    );
    // The same key still reaches the default Vault, so the gate is not a blanket refusal.
    const allowed = await post(app, { key: CONFIGURED_KEY, body: toolCall("get_publish_status", { path: "a.md" }), agent });
    assert.equal(allowed.status, 200);
    assert.equal(app.handled.length, 1);
    assert.equal((await auditFor({ action: "auth.reject", userAgent: agent })).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 5. `server_info` visibility (contract §25 W0-E / §18.1 target).
// ---------------------------------------------------------------------------

test("server_info exposes the caller-filtered Vault face additively (§18.1)", async () => {
  // Contract §18.1: `defaultVaultId` plus `allowedVaults ∩ registry` with safe metadata only.
  // No caller credential is present here, so the full (single-Vault fixture) inventory is visible.
  const server = new McpServer({ name: "w0e-server-info-probe", version: "0.0.0" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "w0e-server-info-probe", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "server_info", arguments: {} });
    const info = result.structuredContent;
    assert.equal(info.ok, true);
    assert.equal(typeof info.vaultPath, "string");
    assert.equal(typeof info.dataPath, "string");
    assert.deepEqual(Object.keys(info).sort(), [...SERVER_INFO_KEYS].sort());
    assert.equal(info.defaultVaultId, DEFAULT_VAULT);
    assert.equal(info.effectiveDefaultVaultId, DEFAULT_VAULT);
    assert.equal(info.defaultVaultSource, "server");
    assert.ok(Array.isArray(info.vaults) && info.vaults.length === 1);
    assert.deepEqual(Object.keys(info.vaults[0]).sort(), SAFE_VAULT_KEYS);
    assert.equal(info.vaults[0].id, DEFAULT_VAULT);
    assert.equal(info.vaults[0].primary, true);
    // `capabilities` is the canonical A2 map keyed by CAPABILITY_KEYS, all fail-closed for now.
    assert.deepEqual(Object.keys(info.vaults[0].capabilities).sort(), [...CAPABILITY_KEYS].sort());
    for (const value of Object.values(info.vaults[0].capabilities)) {
      assert.equal(typeof value.available, "boolean");
    }
    // No root / data path / remote / credential may travel inside a Vault item.
    for (const key of ["root", "canonicalRoot", "dataPath", "remote", "credentials", "vaultPath", "token"]) {
      assert.equal(key in info.vaults[0], false, `server_info.vaults[] must not expose ${key} (contract §18.1)`);
    }
    assert.doesNotMatch(JSON.stringify(info.vaults), /root|remote|token|secret/i);
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Negative controls: the oracle and the ratchet comparison must be able to fail.
// ---------------------------------------------------------------------------

test("negative control: the vault-scope classification is exact set membership, not a guess", async () => {
  const defaultOnly = accessToken([DEFAULT_VAULT]);
  const agent = uniqueAgent("classification-control");
  await withApp(async (app) => {
    const statusOf = async (name, token) => (await post(app, { bearer: token, body: toolCall(name, { vaultId: "secondary" }), agent })).status;
    // A name outside the canonical catalog is treated as global ...
    assert.equal(await statusOf("__w0e_not_a_canonical_tool__", defaultOnly), 200);
    // ... and so are near-miss spellings of a scoped tool: trailing space, wrong case. A future
    // rewrite to a prefix/whitespace/case-insensitive test would turn these red.
    assert.equal(await statusOf("manage_publish ", defaultOnly), 200);
    assert.equal(await statusOf("Manage_Publish", defaultOnly), 200);
    assert.equal(await statusOf("List_Notes", defaultOnly), 200);
    // Identical credential and identical `vaultId`; only the name differs. The exact canonical
    // names are denied, so the oracle really discriminates on set membership.
    assert.equal(await statusOf("manage_publish", defaultOnly), 403);
    assert.equal(await statusOf("get_publish_status", defaultOnly), 403);
    assert.equal(await statusOf("list_notes", defaultOnly), 403);
    assert.equal(await statusOf("server_info", defaultOnly), 200);
  });
});

test("negative control: the ratchet comparison detects a mutated scope set", () => {
  // Guards the assertion in the ratchet test itself: if the observed set ever gained or lost a
  // name, `scopeSetDifferences` reports it instead of silently passing.
  assert.deepEqual(scopeSetDifferences(SCOPED_TOOLS_TODAY, SCOPED_TOOLS_TODAY), []);
  assert.deepEqual(scopeSetDifferences([...SCOPED_TOOLS_TODAY, "server_info"], SCOPED_TOOLS_TODAY), ["server_info"]);
  assert.deepEqual(scopeSetDifferences(SCOPED_TOOLS_TODAY.filter((name) => name !== "list_notes"), SCOPED_TOOLS_TODAY), ["list_notes"]);
  assert.deepEqual(scopeSetDifferences([], []), []);
});
