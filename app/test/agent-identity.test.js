import assert from "node:assert/strict";
import test from "node:test";
import { identifyAgentFromUserAgent, requestUserAgent } from "../src/agent-identity.js";
import { resolveRequestAuthor } from "../src/request-context.js";

test("User-Agent agent detection recognizes supported clients without treating browsers as agents", () => {
  assert.equal(identifyAgentFromUserAgent("codex_cli_rs/1.2.3"), "codex");
  assert.equal(identifyAgentFromUserAgent("Cursor/0.48 MCP"), "cursor");
  assert.equal(identifyAgentFromUserAgent("OpenAI-MCP-Connector/1.0"), "chatgpt");
  assert.equal(identifyAgentFromUserAgent("Mozilla/5.0 Chrome/140"), null);
});

test("request User-Agent is normalized and only falls back when clientInfo is generic", () => {
  const extra = { requestInfo: { headers: { "User-Agent": "OpenClaw/2026.9\r\nignored" } } };
  assert.equal(requestUserAgent(extra), "OpenClaw/2026.9  ignored");
  assert.deepEqual(resolveRequestAuthor({ getClientVersion: () => ({ name: "mcp-client" }) }, extra), { agent: "openclaw", model: "unspecified" });
  assert.deepEqual(resolveRequestAuthor({ getClientVersion: () => ({ name: "declared-client" }) }, extra), { agent: "declared-client", model: "unspecified" });
});
