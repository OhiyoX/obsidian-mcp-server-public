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
