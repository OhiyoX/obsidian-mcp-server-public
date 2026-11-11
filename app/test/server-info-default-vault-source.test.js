// #642 follow-up: `server_info.defaultVaultSource` must name WHICH layer supplied the default
// Vault — the API key, the OAuth client, the OAuth account, or the server primary — so an
// operator can tell "my client sets it" from "my account sets it".

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-dv-source-"));
process.env.VAULT_PATH = path.join(root, "vault");
process.env.DATA_PATH = path.join(root, "data");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
await mkdir(process.env.VAULT_PATH, { recursive: true });
await mkdir(process.env.DATA_PATH, { recursive: true });

const { registerInfoTools } = await import("../src/tools/info.js");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const tools = new Map();
registerInfoTools({ registerTool(name, _config, handler) { tools.set(name, handler); return { name }; } });

async function sourceOf(authInfo) {
  const result = await tools.get("server_info")({}, authInfo ? { authInfo } : {});
  return result.structuredContent.defaultVaultSource;
}

test("an unauthenticated call reports the server primary", async () => {
  assert.equal(await sourceOf(undefined), "server");
  assert.equal(await sourceOf({ allowedVaults: ["vault"] }), "server");
});

test("each credential layer names itself", async () => {
  const vaults = ["vault"];
  assert.equal(await sourceOf({ type: "api-key", keyId: "k1", allowedVaults: vaults, defaultVaultId: "vault" }), "api-key");
  assert.equal(await sourceOf({ type: "oauth", allowedVaults: vaults, defaultVaultId: "vault", defaultVaultLayer: "client" }), "client");
  assert.equal(await sourceOf({ type: "oauth", allowedVaults: vaults, defaultVaultId: "vault", defaultVaultLayer: "account" }), "account");
});
