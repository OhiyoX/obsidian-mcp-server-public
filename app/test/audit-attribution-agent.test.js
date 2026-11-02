// Issue #285 — Agent attribution layering (clientInfo > meta > session > apiKeyLabel > ua).
//
// The audit row must answer "which agent, and WHY that value" without inventing
// precision: a placeholder client name is not an identity, a credential label is
// only a fallback, and the UA hint never outranks a declared identity.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { classifyGenericUserAgent, identifyAgentFromUserAgent } from "../src/agent-identity.js";
import {
  AGENT_SOURCE_PRIORITY, bodyClientInfo, bodyMetaAgent, buildRequestUsage,
  preferAgentAttribution, resolveAgentAttribution,
} from "../src/request-attribution.js";
import { resetSessionAuthorsForTests, setSessionAuthor } from "../src/session-author.js";

function usageOf({ body, headers = {}, ip = "203.0.113.7", peer = ip, trust = false } = {}) {
  const app = { get: (key) => (key === "trust proxy" ? trust : undefined) };
  return buildRequestUsage({ method: "POST", body, headers, ip, socket: { remoteAddress: peer }, app });
}

test("agent attribution follows the layer priority and labels its source", () => {
  const full = resolveAgentAttribution({ clientInfoName: "pi", clientInfoVersion: "1.2", metaAgent: "meta-agent", sessionAgent: "session-agent", apiKeyLabel: "备注 Key", uaAgent: "codex" });
  assert.deepEqual(full, { agent: "pi", agentSource: "clientInfo", clientInfoName: "pi", clientInfoVersion: "1.2" });
  assert.deepEqual(resolveAgentAttribution({ metaAgent: "meta-agent", sessionAgent: "session-agent", apiKeyLabel: "备注 Key", uaAgent: "codex" }), { agent: "meta-agent", agentSource: "meta", clientInfoName: null, clientInfoVersion: null });
  assert.deepEqual(resolveAgentAttribution({ sessionAgent: "session-agent", apiKeyLabel: "备注 Key", uaAgent: "codex" }), { agent: "session-agent", agentSource: "session", clientInfoName: null, clientInfoVersion: null });
  assert.deepEqual(resolveAgentAttribution({ apiKeyLabel: "备注 Key", uaAgent: "codex" }), { agent: "备注 Key", agentSource: "apiKeyLabel", clientInfoName: null, clientInfoVersion: null });
  assert.deepEqual(resolveAgentAttribution({ uaAgent: "codex" }), { agent: "codex", agentSource: "ua", clientInfoName: null, clientInfoVersion: null });
  assert.deepEqual(resolveAgentAttribution({}), { agent: null, agentSource: "none", clientInfoName: null, clientInfoVersion: null });
});

test("clientInfo wins over UA, and label wins over UA only when no better layer exists", () => {
  // clientInfo present ⇒ UA must not win.
  assert.equal(resolveAgentAttribution({ clientInfoName: "pi", uaAgent: "codex" }).agentSource, "clientInfo");
  // no clientInfo ⇒ the API Key label outranks the UA rule.
  assert.equal(resolveAgentAttribution({ apiKeyLabel: "桌面 Key", uaAgent: "codex" }).agent, "桌面 Key");
  assert.equal(resolveAgentAttribution({ apiKeyLabel: "桌面 Key", uaAgent: "codex" }).agentSource, "apiKeyLabel");
  // no label, no clientInfo ⇒ UA rule (real host token) is the fallback.
  assert.equal(resolveAgentAttribution({ uaAgent: "codex" }).agentSource, "ua");
  // nothing at all ⇒ unknown + none (never a fabricated agent).
  assert.deepEqual(resolveAgentAttribution({ metaAgent: "  ", clientInfoName: "mcp-client", uaAgent: null }), { agent: null, agentSource: "none", clientInfoName: null, clientInfoVersion: null });
});

test("a later layer only overrides when it has strictly higher priority", () => {
  const ua = { agent: "codex", agentSource: "ua" };
  assert.equal(preferAgentAttribution(ua, { agent: "桌面 Key", agentSource: "apiKeyLabel" }).agentSource, "apiKeyLabel");
  const clientInfo = { agent: "pi", agentSource: "clientInfo", clientInfoName: "pi", clientInfoVersion: "9" };
  assert.deepEqual(preferAgentAttribution(clientInfo, { agent: "桌面 Key", agentSource: "apiKeyLabel" }), clientInfo);
  const session = { agent: "session-agent", agentSource: "session" };
  assert.equal(preferAgentAttribution(session, { agent: "桌面 Key", agentSource: "apiKeyLabel" }).agent, "session-agent");
  assert.deepEqual(preferAgentAttribution(ua, null), { agent: "codex", agentSource: "ua", clientInfoName: null, clientInfoVersion: null });
  assert.equal(AGENT_SOURCE_PRIORITY.clientInfo < AGENT_SOURCE_PRIORITY.meta, true);
  assert.equal(AGENT_SOURCE_PRIORITY.session < AGENT_SOURCE_PRIORITY.apiKeyLabel, true);
  assert.equal(AGENT_SOURCE_PRIORITY.apiKeyLabel < AGENT_SOURCE_PRIORITY.ua, true);
});

test("generic placeholder client names are not an identity", () => {
  for (const name of ["mcp-client", "MCP-Client", "unknown", "generic", ""]) {
    assert.equal(resolveAgentAttribution({ clientInfoName: name }).agentSource, "none");
  }
  assert.equal(resolveAgentAttribution({ clientInfoName: "mcp-client", sessionAgent: "session-agent" }).agent, "session-agent");
});

test("body helpers read only the request's own initialize / _meta declarations", () => {
  assert.deepEqual(bodyClientInfo({ method: "initialize", params: { clientInfo: { name: "pi", version: "9" } } }), { name: "pi", version: "9" });
  assert.equal(bodyClientInfo({ method: "tools/call", params: { clientInfo: { name: "pi" } } }), null);
  assert.equal(bodyClientInfo([{ method: "initialize", params: { clientInfo: { name: "  " } } }]), null);
  assert.equal(bodyMetaAgent({ method: "tools/call", params: { _meta: { "obsidian/author": { agent: "codex" } } } }), "codex");
  assert.equal(bodyMetaAgent({ method: "tools/call", params: { _meta: { author: "legacy-meta" } } }), "legacy-meta");
  assert.equal(bodyMetaAgent({ method: "tools/call", params: {} }), null);
});

test("buildRequestUsage layers initialize clientInfo, _meta, session and UA per request", () => {
  const initialize = usageOf({ body: { method: "initialize", params: { clientInfo: { name: "pi", version: "9" } } }, headers: { "user-agent": "undici" } });
  assert.equal(initialize.agent, "pi");
  assert.equal(initialize.agentSource, "clientInfo");
  assert.equal(initialize.clientInfoName, "pi");
  assert.equal(initialize.clientInfoVersion, "9");
  assert.equal(initialize.genericClient, "undici");

  const meta = usageOf({ body: { method: "tools/call", params: { name: "list_notes", _meta: { "obsidian/author": { agent: "codex" } } } }, headers: { "user-agent": "undici" } });
  assert.equal(meta.agent, "codex");
  assert.equal(meta.agentSource, "meta");
  assert.equal(meta.clientInfoName, null);
  assert.equal(meta.tool, "list_notes");

  resetSessionAuthorsForTests();
  setSessionAuthor("session-1", { agent: "session-agent", model: "m" }, "api-key:k1");
  const session = usageOf({ body: { method: "tools/call", params: { name: "list_notes" } }, headers: { "mcp-session-id": "session-1", "user-agent": "python-requests/2.31" } });
  assert.equal(session.agent, "session-agent");
  assert.equal(session.agentSource, "session");

  const uaOnly = usageOf({ body: { method: "tools/call", params: { name: "list_notes" } }, headers: { "user-agent": "codex_cli_rs/1.2.3" } });
  assert.equal(uaOnly.agent, "codex");
  assert.equal(uaOnly.agentSource, "ua");
  assert.equal(uaOnly.genericClient, null);

  const nothing = usageOf({ body: { method: "tools/list", params: {} }, headers: { "user-agent": "undici" } });
  assert.equal(nothing.agent, null);
  assert.equal(nothing.agentSource, "none");
  assert.equal(nothing.genericClient, "undici");
  resetSessionAuthorsForTests();
});

test("generic UA classification is display-only and never a specific agent", () => {
  assert.equal(classifyGenericUserAgent("undici"), "undici");
  assert.equal(classifyGenericUserAgent("node"), "node");
  assert.equal(classifyGenericUserAgent("node-fetch/1.0"), "node");
  assert.equal(classifyGenericUserAgent("python-requests/2.31.0"), "requests");
  assert.equal(classifyGenericUserAgent("python3.12 httpx/0.27"), "httpx");
  assert.equal(classifyGenericUserAgent("axios/1.7.2"), "axios");
  assert.equal(classifyGenericUserAgent("okhttp/4.12.0"), "okhttp");
  assert.equal(classifyGenericUserAgent("Go-http-client/2.0"), "go-http-client");
  assert.equal(classifyGenericUserAgent(""), "generic");
  assert.equal(classifyGenericUserAgent("   "), "generic");
  // A real declared host is never downgraded to "generic client".
  assert.equal(classifyGenericUserAgent("codex_cli_rs/0.9"), null);
  assert.equal(classifyGenericUserAgent("Mozilla/5.0 Chrome/140"), null);
});

test("identifyAgentFromUserAgent semantics are unchanged", () => {
  assert.equal(identifyAgentFromUserAgent("codex_cli_rs/1.2.3"), "codex");
  assert.equal(identifyAgentFromUserAgent("Cursor/0.48 MCP"), "cursor");
  assert.equal(identifyAgentFromUserAgent("OpenAI-MCP-Connector/1.0"), "chatgpt");
  assert.equal(identifyAgentFromUserAgent("WorkBuddy/1"), "workbuddy");
  assert.equal(identifyAgentFromUserAgent("OpenClaw/2026.9"), "openclaw");
  assert.equal(identifyAgentFromUserAgent("Hermes-Agent/1"), "hermes");
  assert.equal(identifyAgentFromUserAgent("claude-ai"), "claude");
  assert.equal(identifyAgentFromUserAgent("Visual Studio Code"), "vscode");
  assert.equal(identifyAgentFromUserAgent("mcp-inspector/1"), "mcp-inspector");
  assert.equal(identifyAgentFromUserAgent("Mozilla/5.0 Chrome/140"), null);
  assert.equal(identifyAgentFromUserAgent("undici"), null);
});

test("no authorization surface consumes the UA classifiers", () => {
  const srcRoot = path.resolve(import.meta.dirname, "..", "src");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const relative = path.relative(srcRoot, path.join(dir, entry.name)).replaceAll("\\", "/");
      const content = fs.readFileSync(path.join(dir, entry.name), "utf8");
      const usesGeneric = /classifyGenericUserAgent/.test(content);
      const usesHint = /identifyAgentFromUserAgent/.test(content);
      const allowedGeneric = new Set(["agent-identity.js", "request-attribution.js", "admin/auth-center-cells.js"]);
      const allowedHint = new Set(["agent-identity.js", "request-attribution.js", "request-context.js"]);
      if (usesGeneric && !allowedGeneric.has(relative)) offenders.push(`${relative}:classifyGenericUserAgent`);
      if (usesHint && !allowedHint.has(relative)) offenders.push(`${relative}:identifyAgentFromUserAgent`);
      if (/^(access-policy\/|scopes\.js$|vault-scope\.js$)/.test(relative) && (usesGeneric || usesHint)) {
        offenders.push(`${relative}:classifier-in-authorization-surface`);
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, []);
});
