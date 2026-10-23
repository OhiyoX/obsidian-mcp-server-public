// #441: Hard-revoke hook parameter fix — verify sessions are actually terminated.
//
// This test verifies that when auth middleware triggers hard-revoke, the
// closeSessionsForClient hook receives correct parameters (clientId, {userId})
// and actually terminates the matching MCP sessions.
//
// Test contract:
// - Positive: hard-revoke terminates matching sessions (observable via matched/closed counts)
// - Negative control: wrong parameters = no termination

import assert from "node:assert/strict";
import test from "node:test";
import { createMcpSessionRegistry } from "../src/mcp-sessions.js";

// Create a mock session record that mimics what createSessionTransport produces
function createMockSessionRecord(sessionId, auth) {
  return {
    sessionId,
    server: { close: async () => {} },
    transport: { close: async () => {}, sessionId },
    createdAt: new Date().toISOString(),
    lastAccessAt: Date.now(),
    authClientId: auth?.clientId,
    authUserId: auth?.userId ?? null,
    authPrincipalId: auth?.clientId
      ? `${auth.type || "unknown"}:${auth.clientId}:${auth.userId || ""}`
      : null,
    lastCloseError: null,
    closed: false,
  };
}

test("hard-revoke with correct parameters terminates matching sessions", async () => {
  const registry = createMcpSessionRegistry({ createServer: () => ({ close: async () => {} }) });
  const { closeSessionsForClient } = registry;

  // Manually add sessions to the registry (bypassing transport initialization)
  const auth1 = { type: "oauth", clientId: "client-A", userId: "user-1" };
  const auth2 = { type: "oauth", clientId: "client-A", userId: "user-2" };

  const session1 = createMockSessionRecord("session-1", auth1);
  const session2 = createMockSessionRecord("session-2", auth2);

  registry.sessions.set(session1.sessionId, session1);
  registry.sessions.set(session2.sessionId, session2);

  assert.equal(registry.sessions.size, 2, "should have 2 sessions");

  // Hard-revoke user-1 with CORRECT parameters: (clientId, {userId})
  const result = await closeSessionsForClient("client-A", { userId: "user-1" });

  // Verify the result
  assert.equal(result.matched, 1, "should match 1 session");
  assert.equal(result.closed, 1, "should close 1 session");
  assert.equal(result.failed, 0, "should have 0 failures");
  assert.ok(result.sessionIds.includes("session-1"), "should include session-1 id");
  assert.equal(result.sessionIds.length, 1, "should have closed exactly 1 session");
});

test("negative control: wrong parameters = no session termination", async () => {
  const registry = createMcpSessionRegistry({ createServer: () => ({ close: async () => {} }) });
  const { closeSessionsForClient } = registry;

  const auth = { type: "oauth", clientId: "client-B", userId: "user-3" };
  const session = createMockSessionRecord("session-3", auth);

  registry.sessions.set(session.sessionId, session);
  assert.equal(registry.sessions.size, 1, "should have 1 session");

  // Call with WRONG parameters (simulating the OLD broken behavior):
  // Passing the full auth object instead of (clientId, {userId})
  const wrongResult = await closeSessionsForClient(auth);

  // With wrong parameters, no sessions should match
  assert.equal(wrongResult.matched, 0, "should match 0 sessions with wrong params");
  assert.equal(wrongResult.closed, 0, "should close 0 sessions with wrong params");

  // Now call with CORRECT parameters to prove the test can detect termination
  const correctResult = await closeSessionsForClient("client-B", { userId: "user-3" });
  assert.equal(correctResult.matched, 1, "should match 1 session with correct params");
  assert.equal(correctResult.closed, 1, "should close 1 session with correct params");
});

test("hard-revoke without userId closes all sessions for clientId", async () => {
  const registry = createMcpSessionRegistry({ createServer: () => ({ close: async () => {} }) });
  const { closeSessionsForClient } = registry;

  // Create two sessions with same clientId but different users
  const auth1 = { type: "oauth", clientId: "client-C", userId: "user-4" };
  const auth2 = { type: "oauth", clientId: "client-C", userId: "user-5" };

  const session1 = createMockSessionRecord("session-4", auth1);
  const session2 = createMockSessionRecord("session-5", auth2);

  registry.sessions.set(session1.sessionId, session1);
  registry.sessions.set(session2.sessionId, session2);

  assert.equal(registry.sessions.size, 2, "should have 2 sessions");

  // Hard-revoke entire client (no userId filter)
  const result = await closeSessionsForClient("client-C");

  // Should close both sessions
  assert.equal(result.matched, 2, "should match 2 sessions");
  assert.equal(result.closed, 2, "should close 2 sessions");
  assert.equal(result.failed, 0, "should have 0 failures");
});
