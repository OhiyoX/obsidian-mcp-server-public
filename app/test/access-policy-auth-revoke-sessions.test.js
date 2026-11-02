// AuthZ Wave B / B2 — session isolation, truthful usage (A-10) and the
// no-injected-runtime zero-regression baseline.
//
// Contract: `scratch/authz/INTERFACE.md` §10.2 and DEVELOPMENT §12/§20.5/A-10.
// Split out of `access-policy-auth-revoke.test.js`; the credential-type /
// 401-challenge / authz.deny-audit half stays there. Everything here runs against
// a real express app, a real HTTP socket, the real `createAuthMiddleware`, the
// real `PersistentOAuthProvider` (temp DATA_PATH) and the real access-policy
// runtime/store fixtures — no stubbed auth logic. The shared harness is
// `helpers/access-policy-auth-harness.js`.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  CONFIGURED_KEY,
  MCP_URL,
  WINDOW_OPEN,
  createAuthRevokeHarness,
} from "./helpers/access-policy-auth-harness.js";

const harness = await createAuthRevokeHarness();
const {
  auditFor,
  boot,
  fakeClock,
  keyRecord,
  policyFor,
  provider,
  runtimeFor,
  settle,
  spiedRuntime,
  uniqueAgent,
  waitFor,
} = harness;

after(() => harness.teardown());

test("managed API key revoke is principal-scoped: key A denied, key B untouched", async () => {
  const agentA = uniqueAgent("managed-a");
  const agentB = uniqueAgent("managed-b");
  const keyA = await provider.createApiKey("authz-b2-key-a");
  const keyB = await provider.createApiKey("authz-b2-key-b");
  const policy = policyFor({ subjects: [`api-key:${keyA.id}`] });
  const { runtime } = await runtimeFor({ policies: [policy] });
  const spied = spiedRuntime(runtime);
  const hooks = [];
  const app = await boot({ accessRuntime: spied, onHardRevoke: async (clientId, opts) => { hooks.push({ clientId, ...opts }); } });
  try {
    const denied = await app.call({ key: keyA.secret, agent: agentA });
    assert.equal(denied.status, 401);
    assert.equal(app.handled.length, 0);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].clientId, `api-key:${keyA.id}`);
    assert.deepEqual(spied.calls[0], { subjects: [`api-key:${keyA.id}`], capabilities: ["all"] });
    const entry = await auditFor({ action: "authz.deny", userAgent: agentA });
    assert.equal(entry.length, 1);
    assert.equal(entry[0].credentialId, keyA.id);
    assert.equal(entry[0].clientId, `api-key:${keyA.id}`);

    // Session isolation: revoking key A must not close or deny key B.
    const allowed = await app.call({ key: keyB.secret, agent: agentB });
    assert.equal(allowed.status, 200);
    assert.equal(hooks.length, 1);
    assert.equal(app.handled.length, 1);
    assert.equal(app.handled[0].auth.keyId, keyB.id);
    assert.equal((await auditFor({ action: "authz.deny", userAgent: agentB })).length, 0);
  } finally {
    await app.close();
  }
});

test("OAuth access token: user-level revoke denies only that user's session", async () => {
  const agentU1 = uniqueAgent("oauth-u1");
  const agentU2 = uniqueAgent("oauth-u2");
  const u1 = provider.issueTokens("client-C", ["obsidian.read"], MCP_URL, "user-1", ["default"]);
  const u2 = provider.issueTokens("client-C", ["obsidian.read"], MCP_URL, "user-2", ["default"]);
  const policy = policyFor({ subjects: ["oauth-user:user-1"] });
  const { runtime } = await runtimeFor({ policies: [policy] });
  const hooks = [];
  const app = await boot({ accessRuntime: runtime, onHardRevoke: async (clientId, opts) => { hooks.push({ clientId, ...opts }); } });
  try {
    const denied = await app.call({ bearer: u1.access_token, agent: agentU1 });
    assert.equal(denied.status, 401);
    assert.equal(app.handled.length, 0);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].clientId, "client-C");
    assert.equal(hooks[0].userId, "user-1");
    const entry = await auditFor({ action: "authz.deny", userAgent: agentU1 });
    assert.equal(entry.length, 1);
    assert.equal(entry[0].credentialType, "oauth-access");
    assert.equal(entry[0].clientId, "client-C");
    assert.equal(entry[0].userId, "user-1");
    // Same client, other user: untouched (C/U1 revoke must not close C/U2).
    const allowed = await app.call({ bearer: u2.access_token, agent: agentU2 });
    assert.equal(allowed.status, 200);
    assert.equal(hooks.length, 1);
    assert.equal(app.handled.length, 1);
    assert.equal(app.handled[0].auth.userId, "user-2");
    assert.equal((await auditFor({ action: "authz.deny", userAgent: agentU2 })).length, 0);
  } finally {
    await app.close();
  }
});

test("truthful audit: a tool-layer temporal deny leaves no success record and no lastUsedAt", async () => {
  const agent = uniqueAgent("truthful-deny");
  const key = await provider.createApiKey("authz-b2-truthful-deny");
  const policy = policyFor({ mode: "suspend", subjects: [`api-key:${key.id}`] });
  const { runtime } = await runtimeFor({ policies: [policy] }); // outside window: auth layer allows, tool layer denies
  const app = await boot({
    accessRuntime: runtime,
    onCall: ({ context }) => { if (context?.authzUsage) context.authzUsage.denied = true; },
  });
  try {
    const response = await app.call({ key: key.secret, agent });
    assert.equal(response.status, 200);
    assert.equal(app.handled.length, 1);
    await settle();
    assert.equal((await auditFor({ action: "mcp.tool.list_notes", credentialId: key.id })).length, 0);
    assert.equal((await auditFor({ action: "authz.deny", userAgent: agent })).length, 0);
    assert.equal((await keyRecord(key.id)).lastUsedAt, null);
  } finally {
    await app.close();
  }
});

test("truthful audit: an allowed tools/call commits exactly one success and stamps lastUsedAt", async () => {
  const agent = uniqueAgent("truthful-allow");
  const key = await provider.createApiKey("authz-b2-truthful-allow");
  const policy = policyFor({ mode: "suspend", subjects: [`api-key:${key.id}`] });
  const clock = fakeClock(WINDOW_OPEN);
  const { runtime } = await runtimeFor({ policies: [policy], clock });
  const app = await boot({
    accessRuntime: runtime,
    onCall: ({ context }) => { if (context?.authzUsage) context.authzUsage.denied = false; },
  });
  try {
    const response = await app.call({ key: key.secret, agent });
    assert.equal(response.status, 200);
    const committed = await waitFor(async () => (await auditFor({ action: "mcp.tool.list_notes", credentialId: key.id })).length);
    assert.equal(committed, 1);
    assert.equal((await auditFor({ action: "mcp.tool.list_notes", credentialId: key.id }))[0].outcome, "success");
    const record = await waitFor(async () => {
      const current = await keyRecord(key.id);
      return current?.lastUsedAt ? current : null;
    });
    assert.ok(record.lastUsedAt);
  } finally {
    await app.close();
  }
});

test("a request without tools/call keeps committing usage immediately", async () => {
  const agent = uniqueAgent("initialize");
  const keyAgent = uniqueAgent("initialize-key");
  const key = await provider.createApiKey("authz-b2-initialize-key");
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  const policy = policyFor({ mode: "suspend", subjects: ["api-key:configured-env"] });
  const { runtime } = await runtimeFor({ policies: [policy] });
  const app = await boot({ accessRuntime: runtime });
  try {
    const response = await app.call({ key: CONFIGURED_KEY, agent, body: initialize });
    assert.equal(response.status, 200);
    // Immediate: the success record already exists when the response arrives, and
    // no request-level authzUsage state was created.
    assert.equal((await auditFor({ action: "mcp.initialize", userAgent: agent })).length, 1);
    assert.equal(app.handled[0].context, undefined);

    const keyResponse = await app.call({ key: key.secret, agent: keyAgent, body: initialize });
    assert.equal(keyResponse.status, 200);
    assert.equal((await auditFor({ action: "mcp.initialize", credentialId: key.id })).length, 1);
    assert.ok((await keyRecord(key.id)).lastUsedAt);
    assert.equal(app.handled[1].context, undefined);
  } finally {
    await app.close();
  }
});

test("A-10 for non-tools/call: a hard revoke deny still leaves no success record", async () => {
  const agent = uniqueAgent("initialize-revoked");
  const keyAgent = uniqueAgent("initialize-revoked-key");
  const key = await provider.createApiKey("authz-b2-initialize-revoked");
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  const { runtime } = await runtimeFor({
    policies: [policyFor({ subjects: ["api-key:configured-env"] }), policyFor({ subjects: [`api-key:${key.id}`] })],
  });
  const app = await boot({ accessRuntime: runtime });
  try {
    const response = await app.call({ key: CONFIGURED_KEY, agent, body: initialize });
    assert.equal(response.status, 401);
    assert.equal(app.handled.length, 0);
    await settle();
    assert.equal((await auditFor({ action: "mcp.initialize", userAgent: agent })).length, 0);
    assert.equal((await auditFor({ action: "authz.deny", userAgent: agent })).length, 1);

    const keyResponse = await app.call({ key: key.secret, agent: keyAgent, body: initialize });
    assert.equal(keyResponse.status, 401);
    assert.equal(app.handled.length, 0);
    await settle();
    assert.equal((await auditFor({ action: "mcp.initialize", credentialId: key.id })).length, 0);
    assert.equal((await keyRecord(key.id)).lastUsedAt, null);
    assert.equal((await auditFor({ action: "authz.deny", userAgent: keyAgent })).length, 1);
  } finally {
    await app.close();
  }
});

test("no injected runtime: zero behaviour change for every credential type", async () => {
  const agentEnv = uniqueAgent("no-runtime-env");
  const agentKey = uniqueAgent("no-runtime-key");
  const agentOauth = uniqueAgent("no-runtime-oauth");
  const key = await provider.createApiKey("authz-b2-no-runtime");
  const token = provider.issueTokens("client-E", ["obsidian.read"], MCP_URL, "user-9", ["default"]);
  const hooks = [];
  const app = await boot({ onHardRevoke: async (clientId, opts) => { hooks.push({ clientId, ...opts }); } });
  try {
    const envResponse = await app.call({ key: CONFIGURED_KEY, agent: agentEnv });
    assert.equal(envResponse.status, 200);
    assert.equal((await auditFor({ action: "mcp.tool.list_notes", userAgent: agentEnv })).length, 1);

    const keyResponse = await app.call({ key: key.secret, agent: agentKey });
    assert.equal(keyResponse.status, 200);
    assert.equal((await auditFor({ action: "mcp.tool.list_notes", credentialId: key.id })).length, 1);
    assert.ok((await keyRecord(key.id)).lastUsedAt);

    const oauthResponse = await app.call({ bearer: token.access_token, agent: agentOauth });
    assert.equal(oauthResponse.status, 200);
    assert.equal((await auditFor({ action: "mcp.tool.list_notes", userAgent: agentOauth })).length, 1);

    assert.equal(hooks.length, 0);
    assert.equal(app.handled.length, 3);
    for (const entry of app.handled) assert.equal(entry.context, undefined);
  } finally {
    await app.close();
  }
});

test("verifyApiKeyDeferred + noteApiKeyUse reproduce verifyApiKey's audit and usage exactly", async () => {
  // Same label on both keys: the key label is now an audit attribution layer
  // (issue #285), so distinct labels would make the parity comparison meaningless.
  const immediate = await provider.createApiKey("authz-b2-parity");
  const deferred = await provider.createApiKey("authz-b2-parity");
  const usage = { action: "mcp.tool.list_notes", method: "tools/call", tool: "list_notes", source: "127.0.0.1", userAgent: "authz-b2-parity", agent: "authz-b2" };

  const principal = await provider.verifyApiKey(immediate.secret, usage);
  const deferredPrincipal = await provider.verifyApiKeyDeferred(deferred.secret);
  await provider.noteApiKeyUse(deferredPrincipal, usage);

  const snapshot = await provider.authorizationSnapshot();
  const find = (id) => snapshot.audit.find((entry) => entry.credentialId === id && entry.action === "mcp.tool.list_notes");
  const left = find(immediate.id);
  const right = find(deferred.id);
  assert.ok(left && right);
  const stable = (entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !["id", "time", "credentialId", "clientId"].includes(key)));
  assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
  assert.deepEqual(stable(left), stable(right));
  assert.equal(right.clientId, `api-key:${deferred.id}`);
  assert.ok((await keyRecord(deferred.id)).lastUsedAt);
  // `verifyApiKeyDeferred` itself must not touch the record or the audit.
  const untouched = await provider.createApiKey("authz-b2-parity-untouched");
  await provider.verifyApiKeyDeferred(untouched.secret);
  assert.equal((await keyRecord(untouched.id)).lastUsedAt, null);
  assert.equal((await provider.authorizationSnapshot()).audit.some((entry) => entry.credentialId === untouched.id && entry.action !== "api-key.create"), false);
  assert.equal(principal.keyId, immediate.id);
  assert.deepEqual(deferredPrincipal.scopes, principal.scopes);
  assert.deepEqual(deferredPrincipal.allowedVaults, principal.allowedVaults);
});
