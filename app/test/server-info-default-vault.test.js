// #647 — the `server_info` deploy identity must come from ONE source.
//
// The regression this pins: `server_info` derived `defaultVaultId` /
// `effectiveDefaultVaultId` from the REGISTRY plane (`defaultWebVaultId()` =
// `WEB_DEFAULT_VAULT || basename(VAULT)`), while the HTTP gate (`auth.js`) and the MCP
// execution boundary (`vault-scope-registrar.js`) both use `DEFAULT_VAULT_ID`
// (`WEB_DEFAULT_VAULT || "vault"`). With `WEB_DEFAULT_VAULT` unset and a Vault directory whose
// basename is not `vault`, the two planes answered differently: the metadata named a Vault the
// routing boundary would never choose. The existing `server_info` assertion in
// `multi-vault-auth-characterization.test.js` could not see it because that lane's Vault is
// literally named `vault`, i.e. the two expressions coincide.
//
// This file therefore does the opposite on purpose: the lane Vault is named `alpha`, so the two
// planes MUST disagree unless `server_info` reads the auth plane. That disagreement is asserted
// first (as the documented trap), then the fix is asserted (the reported id is the auth plane's).
//
// Everything is real: `src/config.js` resolves its paths at module evaluation, so the temp Vault
// exists before the module graph loads; `server_info` is driven through a real in-process MCP
// client against the real `registerObsidianCapabilities`.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Multi-Vault mode is what makes the two planes separable:
//   auth plane   DEFAULT_VAULT_ID    = WEB_DEFAULT_VAULT || "vault"      (src/oauth/primitives.js)
//   registry plane defaultWebVaultId = WEB_DEFAULT_VAULT || basename(VAULT) (src/app/vault-registry.js)
// With WEB_DEFAULT_VAULT unset and the primary Vault directory named `alpha`, the auth plane says
// "vault" while the registry plane says "alpha" — exactly the split #647 describes. (In single-Vault
// mode both answer "default", which is why the existing assertion could never see it.)
const LANE_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-647-"));
const VAULTS_ROOT = path.join(LANE_ROOT, "vaults");
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.VAULT_PATH = path.join(VAULTS_ROOT, "alpha");
process.env.DATA_PATH = path.join(LANE_ROOT, "data");
delete process.env.WEB_DEFAULT_VAULT;
await mkdir(process.env.VAULT_PATH, { recursive: true });
await mkdir(process.env.DATA_PATH, { recursive: true });

const { DEFAULT_VAULT_ID } = await import("../src/oauth/primitives.js");
const { defaultWebVaultId } = await import("../src/app/vault-registry.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");

after(async () => {
  await rm(LANE_ROOT, { recursive: true, force: true });
});

test("the two planes really do disagree in this fixture (the trap #647 describes)", () => {
  assert.equal(DEFAULT_VAULT_ID, "vault", "the auth plane falls back to the literal `vault`");
  assert.equal(defaultWebVaultId(), "alpha", "the registry plane falls back to the primary Vault's basename");
  assert.notEqual(DEFAULT_VAULT_ID, defaultWebVaultId(),
    "if these ever coincide again, this file stops proving anything — keep the fixture names apart");
});

test("server_info reports the AUTH plane's default Vault, not the registry plane's", async () => {
  const server = new McpServer({ name: "issue-647-probe", version: "0.0.0" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "issue-647-probe", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "server_info", arguments: {} });
    const info = result.structuredContent;
    assert.equal(info.ok, true);
    // The reported identity is the one the routing boundary uses.
    assert.equal(info.defaultVaultId, DEFAULT_VAULT_ID,
      "server_info.defaultVaultId must come from the same export the gate and the registrar read");
    // `effectiveDefaultVaultId` is null when that Vault is not in the caller's visible set; what it
    // must never be is the registry plane's answer.
    assert.notEqual(info.effectiveDefaultVaultId, defaultWebVaultId(),
      "server_info must not name a Vault the routing boundary would never choose");
    assert.ok(info.effectiveDefaultVaultId === DEFAULT_VAULT_ID || info.effectiveDefaultVaultId === null,
      `effectiveDefaultVaultId must be the auth plane's id or null, got ${JSON.stringify(info.effectiveDefaultVaultId)}`);
  } finally {
    await client.close();
    await server.close();
  }
});
