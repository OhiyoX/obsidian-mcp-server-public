// P0 / Task 1 Step 3 (smoke) — drive the real plane once and check the rows it produces.
//
// This is not the full matrix. It proves the collector sees real answers and real refusal points,
// including the one open question the design refuses to guess: can a secondary-only credential
// read a primary-only MCP resource today?

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-permission-baseline-"));
const VAULTS_ROOT = path.join(ROOT, "vaults");
const PRIMARY = path.join(VAULTS_ROOT, "vault");
const SECONDARY = path.join(VAULTS_ROOT, "alpha");
process.env.WEB_VAULTS_ROOT = VAULTS_ROOT;
process.env.WEB_DEFAULT_VAULT = "vault";
process.env.VAULT_PATH = PRIMARY;
process.env.DATA_PATH = path.join(ROOT, "data");
process.env.API_KEY = "permission-baseline-env-key";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:18923";
process.env.OAUTH_ADMIN_PASSWORD = "baseline-admin-password";
process.env.OAUTH_INITIAL_USERNAME = "baseline-owner";
process.env.OAUTH_INITIAL_PASSWORD = "baseline-oauth-password";
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
await fs.mkdir(path.join(PRIMARY, ".obsidian"), { recursive: true });
await fs.mkdir(path.join(SECONDARY, ".obsidian"), { recursive: true });
await fs.mkdir(process.env.DATA_PATH, { recursive: true });
await fs.writeFile(path.join(PRIMARY, "note.md"), "# primary note\n", "utf8");
await fs.writeFile(path.join(SECONDARY, "note.md"), "# secondary note\n", "utf8");
// A file that exists ONLY in the primary Vault: its presence in a secondary-only read is the leak.
await fs.writeFile(path.join(PRIMARY, "primary-only-marker.md"), "# only in primary\n", "utf8");
await fs.writeFile(path.join(SECONDARY, "alpha-only-marker.md"), "# only in alpha\n", "utf8");

const { createPermissionPlane, observeCase, toolCall, resourceRead } = await import("./helpers/permission-plane.js");

after(async () => fs.rm(ROOT, { recursive: true, force: true }));

const MCP_URL = "http://127.0.0.1:18923/mcp";

test("the plane records real allows, real transport refusals and the primary resource question", async (t) => {
  const plane = await createPermissionPlane({ envKey: process.env.API_KEY, primaryVault: PRIMARY });
  t.after(() => plane.close());

  const user = await plane.provider.createOAuthUser({
    username: "baseline-user", password: "baseline-user-password", displayName: "Baseline",
    allowedScopes: ["obsidian.read", "obsidian.write"], allowedVaults: ["vault", "alpha"],
  });
  await plane.provider.clientsStore.registerClient({
    client_id: "baseline-client", client_id_issued_at: Math.floor(Date.now() / 1000), client_name: "Baseline",
    redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  });
  const full = await plane.provider.issueTokens("baseline-client", ["obsidian.read", "obsidian.write"], MCP_URL, user.id, ["vault", "alpha"]);
  const secondaryOnly = await plane.provider.issueTokens("baseline-client", ["obsidian.read"], MCP_URL, user.id, ["alpha"]);

  const actors = {
    envKey: { id: "env-key", headers: (key) => ({ "X-API-Key": key }) },
    oauthFull: { id: "oauth-full", headers: () => ({ Authorization: `Bearer ${full.access_token}` }) },
    oauthSecondary: { id: "oauth-secondary", headers: () => ({ Authorization: `Bearer ${secondaryOnly.access_token}` }) },
    anonymous: { id: "anonymous", headers: () => ({}) },
  };

  const rows = [];
  const record = async (actorCase, request, targetCase, surface = "mcp") => {
    const observed = await observeCase(plane, { actor: actors[actorCase], request, vaultRoot: VAULTS_ROOT, targetCase });
    rows.push({ actorCase, surface, targetCase, ...observed });
    return observed;
  };

  // 1. the environment key on its own primary Vault: allowed, and it really runs
  const primaryRead = await record("envKey", toolCall("list_notes", {}), "vault:primary");
  assert.equal(primaryRead.allowed, true, "the configured key may read the primary Vault");

  // 2. the same key aimed at a secondary Vault it does not hold: transport refusal, no write
  const deniedSecondary = await record("envKey", toolCall("list_notes", { vaultId: "alpha" }), "vault:secondary");
  assert.equal(deniedSecondary.allowed, false);
  assert.equal(deniedSecondary.denialPoint, "transport");
  assert.equal(deniedSecondary.handlerCalls, 0);

  // 3. no credential at all: refused before anything runs
  const anonymous = await record("anonymous", toolCall("list_notes", {}), "vault:primary");
  assert.equal(anonymous.allowed, false);
  assert.equal(anonymous.denialPoint, "transport");

  // 4. a real write that succeeds is a handler call, and it changes the tree
  const write = await record("oauthFull", toolCall("write_note", { path: "written.md", content: "# written\n" }), "vault:primary");
  assert.equal(write.allowed, true);
  assert.equal(write.handlerCalls, 1, "a successful write must be visible as a content change");

  // 5. the open question: a secondary-only token reading a primary-only resource
  const resource = await record("oauthSecondary", resourceRead("obsidian://vault/index"), "vault:primary", "mcp-resource");

  // 6. a resource with the full credential, for contrast
  const resourceFull = await record("oauthFull", resourceRead("obsidian://vault/index"), "vault:primary", "mcp-resource");
  assert.equal(resourceFull.allowed, true);
  assert.doesNotMatch(JSON.stringify(resourceFull.sample), /error/i, "the full credential's resource read is a real answer");

  // The open question is answered and repaired (design §11.3-3, owner-approved tightening):
  // `fix/resource-vault-scope` gates the three `obsidian://vault/*` reads in the Vault registrar,
  // so a credential that holds only another Vault is refused at the operation gate and reads no
  // content. The refusal stays off the transport: the SDK client still gets an answer.
  assert.equal(resource.status, 200);
  assert.equal(resource.allowed, false);
  assert.equal(resource.errorFamily, "vault_access_denied");
  assert.equal(resource.denialPoint, "operation_gate");
  assert.equal(resource.handlerCalls, 0, "a refused resource read runs no handler");

  const summary = rows.map((r) => `${r.actorCase} ${r.surface} ${r.targetCase} allowed=${r.allowed} family=${r.errorFamily ?? "-"} at=${r.denialPoint}`);
  console.log(JSON.stringify({ rows: summary }, null, 2));
  assert.ok(rows.length >= 6);
});
