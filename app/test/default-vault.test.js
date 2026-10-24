import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-default-vault-"));
process.env.VAULT_PATH = path.join(root, "vault");
process.env.DATA_PATH = path.join(root, "data");
process.env.HISTORY_PATH = path.join(root, "data", "history");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
await fs.mkdir(process.env.VAULT_PATH, { recursive: true });
await fs.mkdir(process.env.DATA_PATH, { recursive: true });

const { effectiveVaultId, normalizeDefaultVaultId } = await import("../src/default-vault.js");
const { requestedVaults } = await import("../src/auth.js");
const { createVaultScopeRegistrar } = await import("../src/vault-scope-registrar.js");
const { requestContext } = await import("../src/request-context.js");
const { DEFAULT_VAULT_ID } = await import("../src/oauth-provider.js");

test("explicit vaultId beats credential default; missing preference preserves global default", () => {
  assert.equal(effectiveVaultId({}, {}, DEFAULT_VAULT_ID), DEFAULT_VAULT_ID);
  assert.equal(effectiveVaultId({}, { defaultVaultId: "research" }, DEFAULT_VAULT_ID), "research");
  assert.equal(effectiveVaultId({ vaultId: "project" }, { defaultVaultId: "research" }, DEFAULT_VAULT_ID), "project");
  assert.equal(effectiveVaultId({ vaultId: "" }, { defaultVaultId: "research" }, DEFAULT_VAULT_ID), "");
  assert.equal(effectiveVaultId({ vaultId: null }, { defaultVaultId: "research" }, DEFAULT_VAULT_ID), null);
  assert.equal(effectiveVaultId({}, { extra: { defaultVaultId: "research" } }, DEFAULT_VAULT_ID), "research");
});

test("a preference can never extend the allowed Vault set", () => {
  assert.equal(normalizeDefaultVaultId(null, ["research"]), null);
  assert.equal(normalizeDefaultVaultId("research", ["research"]), "research");
  assert.throws(() => normalizeDefaultVaultId("project", ["research"]), /allowed Vaults/);
  for (const invalid of ["", ".", "..", "../vault", "a/b", "x".repeat(81), {}, 15]) {
    assert.throws(() => normalizeDefaultVaultId(invalid), /Invalid default Vault ID/);
  }
});

test("HTTP preflight projects the credential preference for every call, including batches", () => {
  const call = (args) => ({ method: "tools/call", params: { name: "list_notes", arguments: args } });
  const auth = { defaultVaultId: "research", allowedVaults: ["research", "project"] };
  assert.deepEqual(requestedVaults({ body: call({}) }, auth), ["research"]);
  assert.deepEqual(requestedVaults({ body: call({ vaultId: "project" }) }, auth), ["project"]);
  assert.deepEqual(requestedVaults({ body: [call({}), call({ vaultId: "project" })] }, auth), ["research", "project"]);
  assert.deepEqual(requestedVaults({ body: call({}) }, { allowedVaults: [] }), [DEFAULT_VAULT_ID]);
  assert.deepEqual(requestedVaults({ body: call({ vaultId: "" }) }, auth), ["\\u0000invalid-vault-id"]);
  assert.deepEqual(requestedVaults({ body: call({ vaultId: null }) }, auth), ["\\u0000invalid-vault-id"]);
});

function makeRegistrar() {
  const calls = { handled: 0, lookedUp: [] };
  const tools = new Map();
  const upstream = {
    server: { getClientVersion: () => ({ name: "test", version: "1" }) },
    registerTool(name, config, handler) { tools.set(name, handler); return { name }; },
  };
  const registrar = createVaultScopeRegistrar(upstream, {
    vaultExists: async (id) => { calls.lookedUp.push(id); return true; },
    resolveVaultRuntime: (id) => ({ id }),
  });
  registrar.registerTool("list_notes", { inputSchema: {} }, async () => {
    calls.handled += 1;
    return requestContext()?.vaultId;
  });
  return { handler: tools.get("list_notes"), calls };
}

test("one live handler routes separate credential identities to independent defaults", async () => {
  const { handler, calls } = makeRegistrar();
  const one = { authInfo: { defaultVaultId: "research", allowedVaults: ["research", "project"] } };
  const two = { authInfo: { defaultVaultId: "project", allowedVaults: ["project"] } };
  assert.equal(await handler({}, one), "research");
  assert.equal(await handler({}, two), "project");
  assert.equal(await handler({ vaultId: "project" }, one), "project");
  assert.equal(calls.handled, 3);
});

test("removed permission and invalid explicit target refuse before any Vault runtime", async () => {
  const { handler, calls } = makeRegistrar();
  const authInfo = { defaultVaultId: "research", allowedVaults: [DEFAULT_VAULT_ID] };
  const denied = await handler({}, { authInfo });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.code, "vault_access_denied");
  assert.equal(calls.handled, 0);
  assert.deepEqual(calls.lookedUp, []);
  const empty = await handler({ vaultId: "" }, { authInfo });
  assert.equal(empty.isError, true);
  assert.equal(empty.structuredContent.code, "vault_id_invalid");
  assert.equal(calls.handled, 0);
});

test("changing default between calls is immediate and does not make handles change Vault", async () => {
  const { handler, calls } = makeRegistrar();
  const authInfo = { defaultVaultId: "research", allowedVaults: ["research", "project"] };
  assert.equal(await handler({}, { authInfo }), "research");
  authInfo.defaultVaultId = "project";
  assert.equal(await handler({}, { authInfo }), "project");
  // Any follow-up carrying the explicit original vaultId remains bound to its original Vault.
  assert.equal(await handler({ vaultId: "research" }, { authInfo }), "research");
  assert.equal(calls.handled, 3);
});

test("key preferences persist without changing grants; shrinking allowlist cannot strand a default", async () => {
  const { persistenceMethods } = await import("../src/oauth/persistence-methods.js");
  const record = { id: "key-a", allowedScopes: ["obsidian.read"], allowedVaults: ["alpha", "beta"] };
  const state = {
    ready: Promise.resolve(),
    data: { apiKeys: { hash: record }, clients: { clientA: {} }, clientUsage: {} },
    audit: [],
    recordAudit(item) { this.audit.push(item); },
    async save() { this.persisted = structuredClone(this.data); },
  };
  const changed = await persistenceMethods.updateApiKey.call(state, "key-a", { defaultVaultId: "alpha" });
  assert.equal(changed.defaultVaultId, "alpha");
  assert.equal(state.persisted.apiKeys.hash.defaultVaultId, "alpha");
  assert.deepEqual(changed.allowedVaults, ["alpha", "beta"]);
  await assert.rejects(
    persistenceMethods.updateApiKey.call(state, "key-a", { allowedVaults: ["beta"] }),
    /allowed Vaults/,
  );
  assert.deepEqual(record.allowedVaults, ["alpha", "beta"], "a failed mutation must be atomic");
  assert.equal(record.defaultVaultId, "alpha");
  const cleared = await persistenceMethods.updateApiKey.call(state, "key-a", { defaultVaultId: null });
  assert.equal(cleared.defaultVaultId, null);
});

test("OAuth client preferences are persistent per registered client, not inferred from UA", async () => {
  const { persistenceMethods } = await import("../src/oauth/persistence-methods.js");
  const state = {
    ready: Promise.resolve(),
    data: { apiKeys: {}, clients: { pi: {}, codex: {} }, clientUsage: {} },
    audit: [],
    recordAudit(item) { this.audit.push(item); },
    async save() { this.persisted = structuredClone(this.data); },
  };
  assert.equal(await persistenceMethods.updateOAuthClientDefaultVault.call(state, "missing", "alpha"), false);
  assert.equal(await persistenceMethods.updateOAuthClientDefaultVault.call(state, "pi", "alpha"), true);
  assert.equal(await persistenceMethods.updateOAuthClientDefaultVault.call(state, "codex", "beta"), true);
  assert.equal(state.persisted.clientUsage.pi.defaultVaultId, "alpha");
  assert.equal(state.persisted.clientUsage.codex.defaultVaultId, "beta");
  await assert.rejects(persistenceMethods.updateOAuthClientDefaultVault.call(state, "pi", "../escape"), /Invalid default Vault ID/);
  assert.equal(state.data.clientUsage.pi.defaultVaultId, "alpha");
});

test("HTTP middleware applies live API Key defaults before transport dispatch", async () => {
  const { createAuthMiddleware } = await import("../src/auth.js");
  const key = { type: "api-key", clientId: "api-key:k1", keyId: "k1",
    scopes: ["obsidian.read"], allowedVaults: ["research"], defaultVaultId: "research" };
  const service = {
    provider: {
      async verifyApiKey(secret) {
        assert.equal(secret, "secret");
        return { ...key, allowedVaults: [...key.allowedVaults] };
      },
      recordAudit() {},
    },
  };
  const middleware = createAuthMiddleware(service);
  const execute = async (args = {}) => {
    const req = { method: "POST", path: "/mcp", headers: { "x-api-key": "secret" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_notes", arguments: args } } };
    const res = {
      code: 200, body: null, setHeader() {},
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; },
    };
    let called = 0;
    await middleware(req, res, () => { called += 1; });
    return { req, res, called };
  };
  assert.equal((await execute()).called, 1);
  key.allowedVaults = ["default-only"];
  const denied = await execute();
  assert.equal(denied.called, 0);
  assert.equal(denied.res.code, 403);
  assert.equal(denied.res.body.error, "access_denied");
  key.allowedVaults = ["research"];
  const override = await execute({ vaultId: "default-only" });
  assert.equal(override.res.code, 403, "explicit override cannot acquire extra privileges");
  assert.equal(override.called, 0);
});

test("OAuth access-token requests derive default from trusted verification, not caller-supplied identity", async () => {
  const { createAuthMiddleware } = await import("../src/auth.js");
  const service = {
    resourceForOrigin: () => new URL("https://example.test/mcp"),
    provider: {
      async verifyApiKey() { throw new Error("not a managed API key"); },
      async verifyAccessToken() {
        return { type: "oauth", clientId: "client-one", userId: "user-one",
          scopes: ["obsidian.read"], allowedVaults: ["research"], defaultVaultId: "research" };
      },
      recordAudit() {},
      async noteAccessTokenUse() {},
    },
  };
  const middleware = createAuthMiddleware(service);
  const req = { method: "POST", path: "/mcp", headers: { authorization: "Bearer opaque-token" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_notes", arguments: {} } } };
  const res = {
    code: 200, setHeader() {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let called = 0;
  await middleware(req, res, () => { called += 1; });
  assert.equal(called, 1);
  assert.equal(req.auth.defaultVaultId, "research");
});
