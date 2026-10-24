// AuthZ Wave B / B2 — HTTP auth layer hard revoke + truthful usage (A-10).
//
// Contract: `scratch/authz/INTERFACE.md` §10.2 and DEVELOPMENT §12/§20.5/A-10.
// Everything here runs against a real express app, a real HTTP socket, the real
// `createAuthMiddleware`, the real `PersistentOAuthProvider` (temp DATA_PATH) and
// the real access-policy runtime/store fixtures — no stubbed auth logic.
//
// This file keeps the credential-type / 401-challenge / authz.deny-audit half;
// the session-isolation, truthful-audit and zero-regression half lives in
// `access-policy-auth-revoke-sessions.test.js`. The shared harness (env, provider,
// runtime fixtures, real HTTP boot) is `helpers/access-policy-auth-harness.js`.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  CONFIGURED_KEY,
  MCP_URL,
  WINDOW_OPEN,
  createAuthRevokeHarness,
} from "./helpers/access-policy-auth-harness.js";

const harness = await createAuthRevokeHarness();
const { auditFor, boot, fakeClock, policyFor, provider, runtimeFor, uniqueAgent, waitFor } = harness;

after(() => harness.teardown());

test("configured-env credential outside a revoke window: 401 challenge, authz.deny audit, no handler", async () => {
  const agent = uniqueAgent("configured-revoke");
  const policy = policyFor({ subjects: ["api-key:configured-env"] });
  const { runtime } = await runtimeFor({ policies: [policy] });
  const hooks = [];
  const app = await boot({ accessRuntime: runtime, onHardRevoke: async (clientId, opts) => { hooks.push({ clientId, ...opts }); } });
  try {
    const response = await app.call({ key: CONFIGURED_KEY, agent });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") || "", /error="invalid_token"/);
    assert.match(response.headers.get("www-authenticate") || "", /resource_metadata="/);
    assert.deepEqual(await response.json(), { error: "invalid_token", error_description: "Invalid or expired access token" });
    // Deny happened in the auth layer: the MCP handler/transport never ran.
    assert.equal(app.handled.length, 0);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].clientId, "api-key:configured-env");

    const denied = await auditFor({ action: "authz.deny", userAgent: agent });
    assert.equal(denied.length, 1);
    assert.equal(denied[0].outcome, "failure");
    assert.equal(denied[0].surface, "mcp");
    assert.equal(denied[0].mode, "revoke");
    assert.equal(denied[0].policyId, policy.id);
    assert.equal(denied[0].credentialType, "api-key");
    assert.equal(denied[0].credentialId, "configured-env");
    assert.equal(denied[0].clientId, "api-key:configured-env");
    assert.equal(typeof denied[0].nextAllowedAt, "string");
    // A hard revoke deny never commits usage for the denied request.
    assert.equal((await auditFor({ action: "mcp.tool.list_notes", userAgent: agent })).length, 0);
    assert.equal(JSON.stringify(denied[0]).includes("oauth-user"), false);
  } finally {
    await app.close();
  }
});

test("configured-env credential inside the window keeps the existing allow path", async () => {
  const agent = uniqueAgent("configured-allow");
  const clock = fakeClock(WINDOW_OPEN);
  const policy = policyFor({ subjects: ["api-key:configured-env"] });
  const { runtime } = await runtimeFor({ policies: [policy], clock });
  const hooks = [];
  const app = await boot({ accessRuntime: runtime, onHardRevoke: async (clientId, opts) => { hooks.push({ clientId, ...opts }); } });
  try {
    const response = await app.call({ key: CONFIGURED_KEY, agent });
    assert.equal(response.status, 200);
    assert.equal(hooks.length, 0);
    assert.equal(app.handled.length, 1);
    assert.equal(app.handled[0].auth.keyId, "configured-env");
    assert.deepEqual(app.handled[0].context, { authzUsage: { denied: false } });
    const committed = await waitFor(async () => (await auditFor({ action: "mcp.tool.list_notes", userAgent: agent })).length);
    assert.equal(committed, 1);
    assert.equal((await auditFor({ action: "authz.deny", userAgent: agent })).length, 0);
  } finally {
    await app.close();
  }
});

test("OAuth access token: client-level revoke denies every user of that client", async () => {
  const agent = uniqueAgent("oauth-client");
  const token = provider.issueTokens("client-D", ["obsidian.read"], MCP_URL, "user-7", ["default"]);
  const policy = policyFor({ subjects: ["oauth-client:client-D"] });
  const { runtime } = await runtimeFor({ policies: [policy] });
  const app = await boot({ accessRuntime: runtime });
  try {
    const response = await app.call({ bearer: token.access_token, agent });
    assert.equal(response.status, 401);
    assert.equal(app.handled.length, 0);
    const entry = await auditFor({ action: "authz.deny", userAgent: agent });
    assert.equal(entry.length, 1);
    assert.equal(entry[0].mode, "revoke");
    assert.equal(entry[0].clientId, "client-D");
  } finally {
    await app.close();
  }
});

test("a throwing onHardRevoke hook never reverses the deny", async () => {
  const agent = uniqueAgent("hook-throws");
  const policy = policyFor({ subjects: ["api-key:configured-env"] });
  const { runtime } = await runtimeFor({ policies: [policy] });
  const app = await boot({
    accessRuntime: runtime,
    onHardRevoke: async () => { throw new Error("session close failed"); },
  });
  try {
    const response = await app.call({ key: CONFIGURED_KEY, agent });
    assert.equal(response.status, 401);
    assert.equal(app.handled.length, 0);
    assert.equal((await auditFor({ action: "authz.deny", userAgent: agent })).length, 1);
  } finally {
    await app.close();
  }
});

test("suspend policy outside its window is not rejected at the auth layer", async () => {
  const agent = uniqueAgent("suspend");
  const policy = policyFor({ mode: "suspend", subjects: ["api-key:configured-env"] });
  const { runtime } = await runtimeFor({ policies: [policy] });
  const hooks = [];
  const app = await boot({ accessRuntime: runtime, onHardRevoke: async (clientId, opts) => { hooks.push({ clientId, ...opts }); } });
  try {
    const response = await app.call({ key: CONFIGURED_KEY, agent });
    assert.equal(response.status, 200);
    assert.equal(app.handled.length, 1);
    assert.equal(hooks.length, 0);
    assert.equal((await auditFor({ action: "authz.deny", userAgent: agent })).length, 0);
    // The tool-layer gate still gets its request-level state to mark the deny.
    assert.deepEqual(app.handled[0].context, { authzUsage: { denied: false } });
  } finally {
    await app.close();
  }
});

test("a broken runtime (policy_unavailable) is never disguised as invalid_token", async () => {
  const agent = uniqueAgent("broken");
  const { runtime } = await runtimeFor({ status: "broken" });
  const app = await boot({ accessRuntime: runtime });
  try {
    const response = await app.call({ key: CONFIGURED_KEY, agent });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.equal(app.handled.length, 1);
    assert.equal((await auditFor({ action: "authz.deny", userAgent: agent })).length, 0);
  } finally {
    await app.close();
  }
});
