// Issue #285 — session→clientInfo binding and the API Key label fallback.
//
// The binding is deliberately per (sessionId, authClientId): one API Key may be
// shared by several agents, so a credential-wide "last clientInfo" would
// mis-attribute sessions. Every miss must degrade attribution, never invent it.

import assert from "node:assert/strict";
import test from "node:test";

import { attributeApiKeyLabel, resolveAgentAttribution } from "../src/request-attribution.js";
import {
  SESSION_CLIENT_INFO_MAX_ENTRIES, applySessionClientInfo, attachSessionAuth, clearSessionClientInfo,
  configureSessionClientInfoForTests, getSessionClientInfo, recordSessionClientInfo, resetSessionClientInfoForTests,
} from "../src/session-client-info.js";

function requestFor(sessionId, authClientId, authorization) {
  const req = { headers: sessionId === undefined ? {} : { "mcp-session-id": sessionId } };
  if (authorization !== undefined) req.auth = { clientId: authClientId };
  return req;
}

test.beforeEach(() => resetSessionClientInfoForTests());
test.afterEach(() => resetSessionClientInfoForTests());

test("records and resolves clientInfo per session + credential", () => {
  assert.equal(recordSessionClientInfo("session-a", "api-key:k1", { name: "pi", version: "1.4" }), true);
  assert.deepEqual(getSessionClientInfo("session-a", "api-key:k1"), { name: "pi", version: "1.4" });
  assert.equal(getSessionClientInfo("session-a", "api-key:k1").version, "1.4");
});

test("fails closed for a missing, unknown or ambiguous key", () => {
  recordSessionClientInfo("session-a", "api-key:k1", { name: "pi" });
  assert.equal(getSessionClientInfo("session-b", "api-key:k1"), undefined, "another session must not read session-a");
  assert.equal(getSessionClientInfo("session-a", "api-key:k2"), undefined, "another credential must not read session-a");
  assert.equal(getSessionClientInfo("session-a", undefined), undefined);
  assert.equal(getSessionClientInfo(undefined, "api-key:k1"), undefined);
  assert.equal(getSessionClientInfo("", ""), undefined);
  assert.equal(recordSessionClientInfo("session-a", "api-key:k1", { name: "mcp-client" }), false, "placeholder names are not an identity");
  assert.equal(recordSessionClientInfo("session-a", "api-key:k1", { name: "   " }), false);
});

test("two sessions sharing one credential stay isolated", () => {
  recordSessionClientInfo("session-pi", "api-key:shared", { name: "pi", version: "1" });
  recordSessionClientInfo("session-codex", "api-key:shared", { name: "codex", version: "2" });
  assert.equal(getSessionClientInfo("session-pi", "api-key:shared").name, "pi");
  assert.equal(getSessionClientInfo("session-codex", "api-key:shared").name, "codex");
  clearSessionClientInfo("session-pi");
  assert.equal(getSessionClientInfo("session-pi", "api-key:shared"), undefined);
  assert.equal(getSessionClientInfo("session-codex", "api-key:shared").name, "codex", "clearing one session never affects another");
});

test("idle expiry degrades attribution instead of reusing a stale identity", () => {
  configureSessionClientInfoForTests({ idleTtlMs: 15 });
  recordSessionClientInfo("session-a", "api-key:k1", { name: "pi" });
  assert.equal(getSessionClientInfo("session-a", "api-key:k1").name, "pi");
  return new Promise((resolve) => setTimeout(resolve, 30)).then(() => {
    assert.equal(getSessionClientInfo("session-a", "api-key:k1"), undefined);
  });
});

test("a full registry evicts the oldest entry and only degrades", () => {
  configureSessionClientInfoForTests({ maxEntries: 2 });
  recordSessionClientInfo("session-1", "api-key:k1", { name: "first" });
  recordSessionClientInfo("session-2", "api-key:k2", { name: "second" });
  recordSessionClientInfo("session-3", "api-key:k3", { name: "third" });
  assert.equal(getSessionClientInfo("session-1", "api-key:k1"), undefined, "evicted entry must not be reused");
  assert.equal(getSessionClientInfo("session-2", "api-key:k2").name, "second");
  assert.equal(getSessionClientInfo("session-3", "api-key:k3").name, "third");
  assert.equal(SESSION_CLIENT_INFO_MAX_ENTRIES > 0, true);
});

test("attachSessionAuth upgrades only when the session proves the association", () => {
  recordSessionClientInfo("session-a", "api-key:k1", { name: "pi", version: "1" });
  const uaUsage = { agent: "codex", agentSource: "ua" };
  attachSessionAuth(requestFor("session-a", "api-key:k1"), uaUsage, { clientId: "api-key:k1" });
  assert.equal(uaUsage.agent, "pi");
  assert.equal(uaUsage.agentSource, "clientInfo");
  assert.equal(uaUsage.clientInfoName, "pi");
  assert.equal(uaUsage.clientInfoVersion, "1");

  // Wrong credential ⇒ no upgrade (the row keeps its honest lower layer).
  const other = { agent: "codex", agentSource: "ua" };
  attachSessionAuth(requestFor("session-a", "api-key:k2"), other, { clientId: "api-key:k2" });
  assert.equal(other.agent, "codex");
  assert.equal(other.agentSource, "ua");
  assert.equal(other.clientInfoName, undefined);

  // clientInfo is the top layer, so it upgrades a session/meta/ua row.
  const sessionUsage = { agent: "session-agent", agentSource: "session" };
  applySessionClientInfo(sessionUsage, requestFor("session-a", "api-key:k1", "api-key:k1"));
  assert.equal(sessionUsage.agent, "pi");
  assert.equal(sessionUsage.agentSource, "clientInfo");

  // No provable session ⇒ the envelope is left exactly as it was.
  const untouched = { agent: "codex", agentSource: "ua" };
  applySessionClientInfo(untouched, requestFor(undefined, "api-key:k1", "api-key:k1"));
  assert.deepEqual(untouched, { agent: "codex", agentSource: "ua" });
});

test("API Key label is a fallback layer, not a clientInfo claim", () => {
  const uaOnly = { agent: "codex", agentSource: "ua", tool: "list_notes" };
  const labelled = attributeApiKeyLabel(uaOnly, "桌面客户端 Key");
  assert.equal(labelled.agent, "桌面客户端 Key");
  assert.equal(labelled.agentSource, "apiKeyLabel");
  assert.equal(labelled.clientInfoName, null);
  assert.equal(labelled.tool, "list_notes", "unrelated usage fields must survive the join");

  const declared = { agent: "pi", agentSource: "clientInfo", clientInfoName: "pi", clientInfoVersion: "1" };
  assert.deepEqual(attributeApiKeyLabel(declared, "桌面客户端 Key"), declared);

  assert.deepEqual(attributeApiKeyLabel(uaOnly, ""), uaOnly);
  assert.deepEqual(attributeApiKeyLabel(uaOnly, null), uaOnly);
  assert.equal(attributeApiKeyLabel(uaOnly, "  ").agentSource, "ua", "whitespace label is not a value");
});

test("the full priority chain is observable end to end", () => {
  recordSessionClientInfo("session-a", "api-key:k1", { name: "pi", version: "1" });
  const usage = resolveAgentAttribution({ uaAgent: "codex" });
  assert.equal(usage.agentSource, "ua");
  applySessionClientInfo(usage, { headers: { "mcp-session-id": "session-a" }, auth: { clientId: "api-key:k1" } });
  assert.equal(usage.agentSource, "clientInfo");
  const unchanged = attributeApiKeyLabel(usage, "桌面客户端 Key");
  assert.equal(unchanged.agentSource, "clientInfo");
});
