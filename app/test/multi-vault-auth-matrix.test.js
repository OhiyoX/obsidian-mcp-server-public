// Wave C — authorization matrix over a real two/three-Vault inventory (contract §34).
//
// This file owns the cases that need a *real* canonical inventory. The transport-level half of the
// matrix (deny before the MCP transport, batch semantics, the §8 order and the §9.2 configured key)
// lives in `multi-vault-auth-characterization.test.js`, which the same lane flipped; the coverage
// table below is the single place that maps every §34 case to its owner.
//
//   §34-1  only A + call A -> allow .................... characterization "a vault-scoped tools/call…"
//   §34-2  only A + call B -> transport 前拒 ........... characterization "a vault-scoped tools/call…"
//   §34-3  only A + no vaultId (primary) -> allow ...... characterization "a vault-scoped tools/call…"
//   §34-4  only B + no vaultId (primary) -> deny ....... characterization "a vault-scoped tools/call…"
//   §34-5  A+B batch -> allow .......................... characterization "a batch unions…"
//   §34-6  only A + batch A+B -> whole deny, 0 handler . characterization "a batch unions…"
//   §34-7  global server_info -> allow, list only A .... this file
//   §34-8  unknown vaultId -> no existence leak ........ characterization "negative control: … membership"
//                                                        + this file (same refusal shape)
//   §34-9  allowedVaults holds a nonexistent id ........ this file (server_info hides it; call is a
//                                                        generic `vault_unavailable` after authorization)
//   §34-10 configured env API key -> primary only ...... characterization "the configured env API key…"
//
// The inventory is real: `WEB_VAULTS_ROOT` holds two secondary Vaults next to a primary root outside
// the root, exactly like `app/src/app/vault-registry.js` expects. Environment is assigned before the
// src modules are imported.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-scope-matrix-"));
const VAULTS_ROOT = path.join(ROOT, "vaults");
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = "alpha";
process.env.VAULT_PATH = path.join(ROOT, "vault");
process.env.DATA_PATH = path.join(ROOT, "data");
process.env.HISTORY_PATH = path.join(ROOT, "data", "history");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
await fs.mkdir(process.env.VAULT_PATH, { recursive: true });
await fs.mkdir(process.env.DATA_PATH, { recursive: true });
await fs.mkdir(path.join(VAULTS_ROOT, "beta"), { recursive: true });
await fs.mkdir(path.join(VAULTS_ROOT, "gamma"), { recursive: true });

const { listWebVaults } = await import("../src/app/vault-registry.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { createVaultScopeRegistrar } = await import("../src/vault-scope-registrar.js");
const { requestContext } = await import("../src/request-context.js");
const { registerInfoTools } = await import("../src/tools/info.js");

const PRIMARY = "alpha";
const SECONDARY = ["beta", "gamma"];

function infoHandlers() {
  const handlers = new Map();
  registerInfoTools({
    registerTool(name, config, handler) { handlers.set(name, { config, handler }); },
    getClientVersion: () => ({ name: "", version: "" }),
  });
  return handlers;
}

test("the fixture really is a three-Vault canonical inventory", async () => {
  const inventory = await listWebVaults();
  assert.deepEqual(inventory.vaults.map((vault) => vault.id), [PRIMARY, ...SECONDARY]);
  assert.equal(inventory.vaults[0].primary, true);
  assert.equal(DEFAULT_VAULT_ID, PRIMARY, "the auth plane and the registry must agree on the default id");
});

test("§34-7: server_info is allowed for a caller that may only see one secondary Vault", async () => {
  const handlers = infoHandlers();
  const result = await handlers.get("server_info").handler({}, { authInfo: { scopes: [], allowedVaults: [SECONDARY[0]] } });
  const info = result.structuredContent;
  assert.equal(info.ok, true);
  assert.equal(info.defaultVaultId, PRIMARY);
  assert.deepEqual(info.vaults.map((vault) => vault.id), [SECONDARY[0]], "only the allowed secondary may appear");
  assert.equal(info.vaults[0].primary, false);
  // The other Vaults exist but must not leak through any field of the response.
  assert.doesNotMatch(JSON.stringify(info.vaults), /alpha|gamma/);
});

test("§34-7/§34-9: the Vault list is the caller allowlist ∩ registry, never a superset", async () => {
  const handlers = infoHandlers();
  const both = await handlers.get("server_info").handler({}, { authInfo: { allowedVaults: [PRIMARY, SECONDARY[1]] } });
  assert.deepEqual(both.structuredContent.vaults.map((vault) => vault.id), [PRIMARY, SECONDARY[1]]);
  // A nonexistent (or not-yet-registered) id in the allowlist simply does not appear.
  const withGhost = await handlers.get("server_info").handler({}, { authInfo: { allowedVaults: [PRIMARY, "ghost"] } });
  assert.deepEqual(withGhost.structuredContent.vaults.map((vault) => vault.id), [PRIMARY]);
  // No credential allowlist in play => the whole inventory is visible (no-auth mode).
  const unrestricted = await handlers.get("server_info").handler({}, {});
  assert.deepEqual(unrestricted.structuredContent.vaults.map((vault) => vault.id), [PRIMARY, ...SECONDARY]);
});

test("§34-3/§34-4: the default Vault is the primary fixture, real inventory included", async () => {
  const handlers = new Map();
  const registrar = createVaultScopeRegistrar({
    registerTool(name, config, handler) { handlers.set(name, { config, handler }); },
    getClientVersion: () => ({ name: "", version: "" }),
  });
  registrar.registerTool("get_note", { inputSchema: {} }, () => requestContext());

  const primaryOnly = await handlers.get("get_note").handler({}, { authInfo: { allowedVaults: [PRIMARY] } });
  assert.equal(primaryOnly.vaultId, PRIMARY);
  assert.equal(primaryOnly.vaultRuntime?.primary, true);

  const secondaryOnly = await handlers.get("get_note").handler({}, { authInfo: { allowedVaults: [SECONDARY[0]] } });
  assert.equal(secondaryOnly.isError, true, "a secondary-only credential may not reach the default Vault");
  assert.deepEqual(secondaryOnly.structuredContent, { code: "vault_access_denied", vaultId: PRIMARY });
});

test("§34-9: an authorized but nonexistent Vault is a generic unavailable refusal, after authorization", async () => {
  const handlers = new Map();
  createVaultScopeRegistrar({
    registerTool(name, config, handler) { handlers.set(name, { config, handler }); },
    getClientVersion: () => ({ name: "", version: "" }),
  }).registerTool("get_note", { inputSchema: {} }, () => requestContext());
  const ghost = await handlers.get("get_note").handler({ vaultId: "ghost" }, { authInfo: { allowedVaults: ["ghost"] } });
  assert.equal(ghost.isError, true);
  assert.deepEqual(ghost.structuredContent, { code: "vault_unavailable", vaultId: "ghost" });
  assert.doesNotMatch(ghost.content[0].text, /root|path|ENOENT/i, "no filesystem detail may leak");

  // A registered secondary is admitted and gets its own id — never the primary runtime (SEC-MV06).
  const beta = await handlers.get("get_note").handler({ vaultId: SECONDARY[0] }, { authInfo: { allowedVaults: [SECONDARY[0]] } });
  assert.equal(beta.vaultId, SECONDARY[0]);
  assert.equal(beta.vaultRuntime, undefined);
});

test("§34-2/§34-8: the refusal shape does not depend on whether the Vault exists", async () => {
  const handlers = new Map();
  createVaultScopeRegistrar({
    registerTool(name, config, handler) { handlers.set(name, { config, handler }); },
    getClientVersion: () => ({ name: "", version: "" }),
  }).registerTool("get_note", { inputSchema: {} }, () => requestContext());
  const allowed = { authInfo: { allowedVaults: [PRIMARY] } };
  const existing = await handlers.get("get_note").handler({ vaultId: SECONDARY[0] }, allowed);
  const ghost = await handlers.get("get_note").handler({ vaultId: "ghost" }, allowed);
  // The refusal echoes only the id the caller itself sent (no inventory fact), so the two responses
  // differ in exactly that field and in nothing else.
  assert.equal(existing.structuredContent.code, "vault_access_denied");
  assert.equal(ghost.structuredContent.code, "vault_access_denied");
  assert.deepEqual(
    { ...existing.structuredContent, vaultId: null },
    { ...ghost.structuredContent, vaultId: null },
    "unauthorized callers cannot tell an existing Vault from a nonexistent one",
  );
  assert.deepEqual(Object.keys(existing.structuredContent).sort(), Object.keys(ghost.structuredContent).sort());
});
