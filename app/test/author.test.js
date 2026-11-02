import assert from "node:assert/strict";
import test from "node:test";
import { resolveRequestAuthor, stampFrontmatter, isGenericClientName, getInitializedClientInfo } from "../src/request-context.js";
import { clearSessionAuthor, setSessionAuthor } from "../src/session-author.js";

const server = { getClientVersion: () => ({ name: "codex" }) };
const nestedServer = { server: { getClientVersion: () => ({ name: "codex", version: "1" }) } };
const genericServer = { getClientVersion: () => ({ name: "mcp-client" }) };

test("initialized client info is read from McpServer.server when needed", () => {
  assert.deepEqual(getInitializedClientInfo(server), { name: "codex", version: "" });
  assert.deepEqual(getInitializedClientInfo(nestedServer), { name: "codex", version: "1" });
  assert.deepEqual(getInitializedClientInfo({}), { name: "", version: "" });
});

test("MCP author metadata is derived when omitted and bound to the initialized client", () => {
  const extra = { _meta: { "obsidian/author": { agent: "codex", model: "gpt-5.6" } } };
  const author = resolveRequestAuthor(server, extra);
  assert.deepEqual(author, { agent: "codex", model: "gpt-5.6" });
  assert.deepEqual(stampFrontmatter({ title: "Example" }, author), {
    title: "Example",
    mcp_author: { agent: "codex", model: "gpt-5.6" },
  });
  assert.deepEqual(resolveRequestAuthor(server, { _meta: {} }), { agent: "codex", model: "unspecified" });
  assert.deepEqual(resolveRequestAuthor(nestedServer, { _meta: {} }), { agent: "codex", model: "unspecified" });
  assert.throws(() => resolveRequestAuthor(server, { _meta: { "obsidian/author": { agent: "other", model: "gpt-5.6" } } }), /match initialized client/);
});

test("generic MCP client names allow bootstrap/session author instead of mcp-client", () => {
  const previousAgent = process.env.MCP_DEFAULT_AUTHOR_AGENT;
  const previousModel = process.env.MCP_DEFAULT_AUTHOR_MODEL;
  delete process.env.MCP_DEFAULT_AUTHOR_AGENT;
  delete process.env.MCP_DEFAULT_AUTHOR_MODEL;
  assert.equal(isGenericClientName("mcp-client"), true);
  assert.equal(isGenericClientName("cursor"), false);
  const sessionId = "test-session-author";
  clearSessionAuthor(sessionId);
  assert.deepEqual(resolveRequestAuthor(genericServer, { _meta: {}, sessionId }), {
    agent: "mcp-client",
    model: "unspecified",
  });
  setSessionAuthor(sessionId, { agent: "cursor", model: "composer" });
  assert.deepEqual(resolveRequestAuthor(genericServer, { _meta: {}, sessionId }), {
    agent: "cursor",
    model: "composer",
  });
  assert.deepEqual(
    resolveRequestAuthor(genericServer, {
      sessionId,
      _meta: { "obsidian/author": { agent: "cursor", model: "composer-2" } },
    }),
    { agent: "cursor", model: "composer-2" },
  );
  clearSessionAuthor(sessionId);
  if (previousAgent == null) delete process.env.MCP_DEFAULT_AUTHOR_AGENT;
  else process.env.MCP_DEFAULT_AUTHOR_AGENT = previousAgent;
  if (previousModel == null) delete process.env.MCP_DEFAULT_AUTHOR_MODEL;
  else process.env.MCP_DEFAULT_AUTHOR_MODEL = previousModel;
});

test("real clients like codex keep their own agent even when MCP_DEFAULT_AUTHOR_AGENT is set", () => {
  const previous = process.env.MCP_DEFAULT_AUTHOR_AGENT;
  process.env.MCP_DEFAULT_AUTHOR_AGENT = "cursor";
  try {
    const sessionId = "test-codex-session";
    clearSessionAuthor(sessionId);
    assert.deepEqual(resolveRequestAuthor(server, { _meta: {}, sessionId }), {
      agent: "codex",
      model: "unspecified",
    });
    assert.deepEqual(resolveRequestAuthor(nestedServer, { _meta: {}, sessionId }), {
      agent: "codex",
      model: "unspecified",
    });
    setSessionAuthor(sessionId, { agent: "codex", model: "gpt-5.6" });
    assert.deepEqual(resolveRequestAuthor(server, { _meta: {}, sessionId }), {
      agent: "codex",
      model: "gpt-5.6",
    });
    assert.deepEqual(
      resolveRequestAuthor(server, {
        sessionId,
        _meta: { "obsidian/author": { agent: "codex", model: "gpt-5.6-sol" } },
      }),
      { agent: "codex", model: "gpt-5.6-sol" },
    );
    assert.throws(
      () => resolveRequestAuthor(server, { _meta: { "obsidian/author": { agent: "cursor", model: "composer" } } }),
      /match initialized client/,
    );
    clearSessionAuthor(sessionId);
  } finally {
    if (previous === undefined) delete process.env.MCP_DEFAULT_AUTHOR_AGENT;
    else process.env.MCP_DEFAULT_AUTHOR_AGENT = previous;
  }
});
