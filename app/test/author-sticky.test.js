import assert from "node:assert/strict";
import test from "node:test";
import { resolveRequestAuthor } from "../src/request-context.js";
import { clearSessionAuthor, resetSessionAuthorsForTests, setSessionAuthor } from "../src/session-author.js";

test("bootstrap author sticks across MCP session ids for the same auth client", () => {
  resetSessionAuthorsForTests();
  const genericServer = { getClientVersion: () => ({ name: "mcp-client" }) };
  setSessionAuthor("session-a", { agent: "cursor", model: "grok" }, "api-key:test-bot");
  clearSessionAuthor("session-a");
  assert.deepEqual(
    resolveRequestAuthor(genericServer, {
      _meta: {},
      sessionId: "session-b",
      authInfo: { clientId: "api-key:test-bot", scopes: [] },
    }),
    { agent: "cursor", model: "grok" },
  );
  // Different auth client must not inherit sticky author.
  assert.deepEqual(
    resolveRequestAuthor(genericServer, {
      _meta: {},
      sessionId: "session-c",
      authInfo: { clientId: "api-key:other", scopes: [] },
    }),
    { agent: "mcp-client", model: "unspecified" },
  );
  resetSessionAuthorsForTests();
});

test("a sticky author does not cross a shared key's user-agent boundary", () => {
  resetSessionAuthorsForTests();
  const genericServer = { getClientVersion: () => ({ name: "mcp-client" }) };
  setSessionAuthor("session-a", { agent: "codex", model: "gpt-6" }, "api-key:shared", "codex-mcp-client/0.166.0");
  clearSessionAuthor("session-a");

  // The same agent (same UA) keeps its declared identity after a session churn.
  assert.deepEqual(
    resolveRequestAuthor(genericServer, {
      _meta: {},
      sessionId: "session-b",
      authInfo: { clientId: "api-key:shared", scopes: [] },
      requestInfo: { headers: { "user-agent": "codex-mcp-client/0.166.0" } },
    }),
    { agent: "codex", model: "gpt-6" },
  );

  // Another agent on the same key must fall back to the placeholder, not Codex.
  assert.deepEqual(
    resolveRequestAuthor(genericServer, {
      _meta: {},
      sessionId: "session-c",
      authInfo: { clientId: "api-key:shared", scopes: [] },
      requestInfo: { headers: { "user-agent": "undici" } },
    }),
    { agent: "mcp-client", model: "unspecified" },
  );
  resetSessionAuthorsForTests();
});
