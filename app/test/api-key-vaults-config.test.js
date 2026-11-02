// Configured env API key across Vaults — contract §9.2 amendment (2026-10-29).
//
// Before this change `API_KEY` (the deployment's configured key, `credentialId: configured-env`)
// was hard-wired to `[DEFAULT_VAULT_ID]`: an MCP client authenticating with it could never call a
// Vault-scoped tool on a second Vault, and the Admin plane reported it as immutable and
// primary-only. `API_KEY_VAULTS` (comma/whitespace separated ids) now grants more Vaults to that
// key; unset or empty keeps the historical primary-only rule.
//
// Everything runs against the real `createAuthMiddleware`, the real `PersistentOAuthProvider`
// (temp DATA_PATH) and a real HTTP socket whose `/mcp` handler counts invocations — no auth logic
// is stubbed. The Admin half reads the same source through `buildCatalog`.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { CONFIGURED_KEY, createAuthRevokeHarness } from "./helpers/access-policy-auth-harness.js";

// `src/config.js` resolves VAULT at module evaluation; give it a real directory first.
const LANE_ROOT = await mkdtemp(path.join(os.tmpdir(), "obsidian-api-key-vaults-"));
process.env.VAULT_PATH = path.join(LANE_ROOT, "vault");
await mkdir(process.env.VAULT_PATH, { recursive: true });

const harness = await createAuthRevokeHarness();
const { auditFor, boot, uniqueAgent } = harness;

const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");
const { buildCatalog } = await import("../src/admin/catalog.js");

const VAULT_DENIED_BODY = { error: "access_denied", error_description: "Vault access denied" };

beforeEach(() => {
  delete process.env.API_KEY_VAULTS;
});

after(async () => {
  delete process.env.API_KEY_VAULTS;
  await harness.teardown();
  await rm(LANE_ROOT, { recursive: true, force: true });
});

function toolCall(name, args) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

test("without API_KEY_VAULTS the configured key stays primary-only (§9.2 default)", async () => {
  const agent = uniqueAgent("env-key-primary");
  const app = await boot({});
  try {
    const denied = await app.call({ key: CONFIGURED_KEY, agent, body: toolCall("list_notes", { vaultId: "secondary" }) });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), VAULT_DENIED_BODY);
    assert.equal(app.handled.length, 0);

    const allowed = await app.call({ key: CONFIGURED_KEY, agent, body: toolCall("list_notes", {}) });
    assert.equal(allowed.status, 200);
    assert.equal(app.handled.length, 1);
    assert.deepEqual(app.handled[0].auth.allowedVaults, [DEFAULT_VAULT_ID]);
    assert.equal(app.handled[0].auth.keyId, "configured-env");

    const reject = await auditFor({ action: "auth.reject", userAgent: agent });
    assert.equal(reject.length, 1);
    assert.equal(reject[0].detail, "vault access denied: secondary");
  } finally {
    await app.close();
  }
});

test("API_KEY_VAULTS grants the configured key further Vaults and keeps the gate", async () => {
  process.env.API_KEY_VAULTS = ` ${DEFAULT_VAULT_ID} , secondary,secondary `;
  const agent = uniqueAgent("env-key-widened");
  const app = await boot({});
  try {
    const granted = await app.call({ key: CONFIGURED_KEY, agent, body: toolCall("list_notes", { vaultId: "secondary" }) });
    assert.equal(granted.status, 200);
    assert.equal(app.handled.length, 1);
    // The duplicate in the env value collapses; the configured order is preserved.
    assert.deepEqual(app.handled[0].auth.allowedVaults, [DEFAULT_VAULT_ID, "secondary"]);

    const stillDenied = await app.call({ key: CONFIGURED_KEY, agent, body: toolCall("list_notes", { vaultId: "third-vault" }) });
    assert.equal(stillDenied.status, 403);
    assert.deepEqual(await stillDenied.json(), VAULT_DENIED_BODY);
    assert.equal(app.handled.length, 1, "the denied call never reaches the MCP handler");

    const reject = await auditFor({ action: "auth.reject", userAgent: agent });
    assert.equal(reject.length, 1);
    assert.deepEqual(
      { credentialId: reject[0].credentialId, vaults: reject[0].vaults, detail: reject[0].detail },
      { credentialId: "configured-env", vaults: [DEFAULT_VAULT_ID, "secondary"], detail: "vault access denied: third-vault" },
    );
  } finally {
    await app.close();
  }
});

test("API_KEY_VAULTS adds grants; it never removes the primary Vault", async () => {
  // A deployment that names only a second Vault keeps the key's home Vault: the list is additive,
  // so an operator cannot accidentally lock the configured key out of the primary Vault.
  process.env.API_KEY_VAULTS = "secondary";
  const agent = uniqueAgent("env-key-no-primary");
  const app = await boot({});
  try {
    const home = await app.call({ key: CONFIGURED_KEY, agent, body: toolCall("list_notes", {}) });
    assert.equal(home.status, 200);
    assert.deepEqual(app.handled[0].auth.allowedVaults, [DEFAULT_VAULT_ID, "secondary"]);

    const other = await app.call({ key: CONFIGURED_KEY, agent, body: toolCall("list_notes", { vaultId: "secondary" }) });
    assert.equal(other.status, 200);
  } finally {
    await app.close();
  }
});

test("a separator-only API_KEY_VAULTS value keeps the default", async () => {
  process.env.API_KEY_VAULTS = " , ,";
  const agent = uniqueAgent("env-key-separators");
  const app = await boot({});
  try {
    const response = await app.call({ key: CONFIGURED_KEY, agent, body: toolCall("list_notes", {}) });
    assert.equal(response.status, 200);
    assert.deepEqual(app.handled[0].auth.allowedVaults, [DEFAULT_VAULT_ID]);
  } finally {
    await app.close();
  }
});

test("a JSON-RPC batch is denied as a whole when one member names another Vault", async () => {
  process.env.API_KEY_VAULTS = "secondary";
  const agent = uniqueAgent("env-key-batch");
  const app = await boot({});
  try {
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_notes", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_notes", arguments: { vaultId: "third-vault" } } },
    ];
    const denied = await app.call({ key: CONFIGURED_KEY, agent, body: batch });
    assert.equal(denied.status, 403);
    assert.equal(app.handled.length, 0);
  } finally {
    await app.close();
  }
});

test("the Admin projection reports the configured key's real Vault grants", async () => {
  const { provider } = harness;
  const listVaults = async () => ({ vaults: [{ id: DEFAULT_VAULT_ID, primary: true }, { id: "secondary", primary: false }] });
  const deps = { provider, listVaults, configuredApiKeyEnabled: true, publicBaseUrl: "http://127.0.0.1:18923" };
  const request = { headers: {}, cookies: {} };

  const before = await buildCatalog({ deps, req: request });
  const primaryOnly = before.keys.find((key) => key.id === "configured-env");
  assert.deepEqual(primaryOnly.allowedVaults, [DEFAULT_VAULT_ID]);

  process.env.API_KEY_VAULTS = `${DEFAULT_VAULT_ID},secondary`;
  const after = await buildCatalog({ deps, req: request });
  const widened = after.keys.find((key) => key.id === "configured-env");
  assert.deepEqual(widened.allowedVaults, [DEFAULT_VAULT_ID, "secondary"]);
  assert.equal(widened.immutable, true, "the env key stays read-only in the Admin plane");
});
