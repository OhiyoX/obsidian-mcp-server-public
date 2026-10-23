// Shared harness for the AuthZ hard-revoke HTTP auth tests (Wave B / B2).
//
// Contract: `scratch/authz/INTERFACE.md` §10.2 and DEVELOPMENT §12/§20.5/A-10.
// `createAuthRevokeHarness()` performs the split's former module-level setup —
// temporary DATA_PATH, the real `PersistentOAuthProvider`, the real
// `createAuthMiddleware` and the real access-policy runtime/store fixtures — so
// the two `access-policy-auth-revoke*.test.js` files exercise the same real HTTP
// path without stubbing auth logic. Nothing here is asserted on its own; the
// assertions live in the test files.
//
// The env must be assigned before the src modules are imported, because
// `src/config.js` and the OAuth provider read DATA_PATH at module evaluation, so
// every src import stays dynamic inside the factory.

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

// Asia/Shanghai instants against the fixture weekly grid (Mon–Fri 09:00–18:00).
export const WINDOW_CLOSED = Date.UTC(2026, 9, 4, 0, 0); // Sun 08:00 — outside
export const WINDOW_OPEN = Date.UTC(2026, 9, 7, 2, 0); // Wed 10:00 — inside
export const CONFIGURED_KEY = "configured-env-test-key";
export const MCP_URL = "http://127.0.0.1:18923/mcp";

export async function createAuthRevokeHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-authz-auth-revoke-"));
  process.env.DATA_PATH = root;
  process.env.PUBLIC_BASE_URL = "http://127.0.0.1:18923";
  process.env.OAUTH_ADMIN_PASSWORD = "test-only-password";
  process.env.OAUTH_INITIAL_USERNAME = "test-owner";
  process.env.OAUTH_INITIAL_PASSWORD = "test-oauth-password";
  process.env.API_KEY = CONFIGURED_KEY;
  process.env.MCP_PATH = "/mcp";
  process.env.GIT_ENABLED = "false";

  const [
    { createAuthMiddleware },
    { createOAuthService },
    { requestContext },
    { createAccessPolicyRuntime },
    fixtures,
  ] = await Promise.all([
    import("../../src/auth.js"),
    import("../../src/oauth-provider.js"),
    import("../../src/request-context.js"),
    import("../../src/access-policy/runtime.js"),
    import("./access-policy-fixtures.js"),
  ]);

  const { fakeClock, fakeStore, policyFixture, snapshotFixture } = fixtures;

  const oauthService = createOAuthService();
  const provider = oauthService.provider;

  let sequence = 0;
  /** Unique per-test user agent, so the shared provider's audit can be filtered. */
  function uniqueAgent(label) {
    sequence += 1;
    return `authz-b2-${label}-${sequence}`;
  }

  function policyFor({ mode = "revoke", subjects, capabilities = ["all"] }) {
    return policyFixture({ mode, capabilities, subjects, timezone: "Asia/Shanghai" });
  }

  /** Real runtime over a real (fake-io) store; returns the policy ids it evaluates. */
  async function runtimeFor({ policies = [], clock = fakeClock(WINDOW_CLOSED), status = "ready" } = {}) {
    const store = fakeStore({
      snapshot: snapshotFixture({ status, revision: status === "ready" ? 1 : null, policies }),
    });
    const runtime = createAccessPolicyRuntime({ enabled: true, store, now: clock.now });
    await runtime.ready;
    return { runtime, clock, store };
  }

  /** Wraps a runtime so the exact subject/capability inputs can be asserted. */
  function spiedRuntime(runtime) {
    const calls = [];
    return {
      calls,
      status: runtime.status,
      evaluate(input) {
        calls.push(input);
        return runtime.evaluate(input);
      },
      explain(input) {
        return runtime.explain(input);
      },
    };
  }

  async function boot({ accessRuntime, onHardRevoke, onCall } = {}) {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(createAuthMiddleware(oauthService, { accessRuntime, onHardRevoke }));
    const handled = [];
    app.post("/mcp", async (req, res) => {
      const context = requestContext();
      handled.push({ body: req.body, auth: req.auth, context });
      if (onCall) await onCall({ context, req, res });
      res.status(200).json({ ok: true, principal: req.auth?.clientId ?? null });
    });
    const server = await new Promise((resolve, reject) => {
      const instance = http.createServer(app);
      instance.once("error", reject);
      instance.listen(0, "127.0.0.1", () => resolve(instance));
    });
    return {
      handled,
      close: () => new Promise((resolve, reject) => {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        server.close((error) => error ? reject(error) : resolve());
      }),
      async call({ key, bearer, tool = "list_notes", body, agent }) {
        return fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": agent,
            ...(key ? { "X-API-Key": key } : {}),
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          },
          body: JSON.stringify(body ?? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } }),
        });
      },
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async function auditFor({ action, userAgent, credentialId } = {}) {
    const snapshot = await provider.authorizationSnapshot();
    return snapshot.audit.filter((entry) =>
      (!action || entry.action === action)
      && (!userAgent || entry.userAgent === userAgent)
      && (!credentialId || entry.credentialId === credentialId));
  }

  async function keyRecord(id) {
    const snapshot = await provider.authorizationSnapshot();
    return snapshot.apiKeys.find((item) => item.id === id) ?? null;
  }

  async function teardown() {
    await provider.drainPersistence();
    await fs.rm(root, { recursive: true, force: true });
  }

  return {
    oauthService,
    provider,
    fakeClock,
    uniqueAgent,
    policyFor,
    runtimeFor,
    spiedRuntime,
    boot,
    settle,
    waitFor,
    auditFor,
    keyRecord,
    teardown,
  };
}
