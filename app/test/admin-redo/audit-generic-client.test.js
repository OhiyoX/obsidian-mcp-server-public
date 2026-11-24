// Issue #285, last item — the audit Agent column for a client that declares no identity.
//
// `buildRequestUsage()` records `genericClient` (undici/node/requests/…) next to `agent`, and the
// column used to show `—` for such a row: the audit knew the client was programmatic and said
// nothing. It now names it as a generic client and keeps saying that no identity was declared, so
// the operator never mistakes it for a real Agent label. Display only — no auth reads this.
import assert from "node:assert/strict";
import test from "node:test";
import { renderAuditPage } from "../../src/admin/pages/audit.js";
import { createModel } from "../../src/admin/presentation/model.js";

const AUDIT = [
  // A programmatic client: no identity, a classified User-Agent.
  {
    id: "au-undici", time: "2026-10-10T02:29:00.000Z", action: "mcp.initialize", outcome: "success",
    credentialType: "api-key", credentialId: "k-bot", source: "192.168.1.5", sourceKind: "direct",
    userAgent: "undici", genericClient: "undici", origin: "obsidian.example.com",
  },
  // A known client: the UA names it, so the identity is shown, never the generic wording.
  {
    id: "au-cursor", time: "2026-10-10T02:20:00.000Z", action: "mcp.tool.get_note", outcome: "success",
    credentialType: "api-key", credentialId: "k-bot", source: "192.168.1.6", sourceKind: "direct",
    userAgent: "cursor/1.0", genericClient: null, agent: "cursor", agentSource: "ua", origin: "obsidian.example.com",
  },
  // A Key label outranks the User-Agent: its provenance must not be overridden.
  {
    id: "au-label", time: "2026-10-10T02:10:00.000Z", action: "mcp.tool.list_notes", outcome: "success",
    credentialType: "api-key", credentialId: "k-bot", source: "192.168.1.7", sourceKind: "direct",
    userAgent: "node", genericClient: "node", agent: "Research bot", agentSource: "apiKeyLabel", origin: "obsidian.example.com",
  },
  // Nothing at all: still `—`, never an invented client.
  {
    id: "au-none", time: "2026-10-10T02:00:00.000Z", action: "admin.login", outcome: "failure",
    credentialType: "none", source: "203.0.113.45", sourceKind: "public", origin: "obsidian.example.com",
  },
];

const KEYS = [{ id: "k-bot", label: "Research bot", prefix: "obmcp_a97db1bd", immutable: false, allowedScopes: [], allowedVaults: [], createdAt: "2026-09-28T00:00:00.000Z", lastUsedAt: null }];
const model = createModel({ now: Date.parse("2026-10-10T10:30:00+08:00"), snapshot: { audit: AUDIT, oauthUsers: [], clients: [], tokens: [] }, keys: KEYS, vaults: [] });
const page = renderAuditPage({ model, snapshot: { audit: AUDIT, oauthUsers: [], clients: [], tokens: [] }, csrf: "csrf", query: {} });
const html = `${page.content}${page.detailPanel}`;

/** One row's Agent cell, by the credential/source that identifies it. */
function agentCellOf(source) {
  const row = html.split("<tr").find((part) => part.includes(`>${source}<`) && part.includes('class="nm"'));
  assert.ok(row, `row for source ${source} not found`);
  return row.match(/<span class="ell">([^<]*)<\/span><span class="sub2">([^<]*)<\/span>/)[0];
}

test("a programmatic client shows as a generic client instead of a blank Agent", () => {
  assert.match(html, /<span class="ell">通用客户端（undici）<\/span><span class="sub2">无身份声明<\/span>/);
  assert.match(html, /Agent 来源： 无身份声明<\/div>/, "the drawer says the identity is absent, not inferred");
});

test("a known client and a Key label keep their own identity and provenance", () => {
  assert.match(html, /<span class="ell">cursor<\/span><span class="sub2">由 UA 推测<\/span>/);
  assert.match(html, /<span class="ell">Research bot<\/span><span class="sub2">Key 备注<\/span>/);
  assert.doesNotMatch(html, /通用客户端（node）/, "a row that has an identity never shows the generic wording");
});

test("no identity and no classified User-Agent still renders a dash", () => {
  assert.equal(agentCellOf("203.0.113.45").includes("通用客户端"), false);
  assert.match(html, /<span class="ell">—<\/span><span class="sub2"><\/span>/);
});

test("the generic wording is one row's text only: no script, no undefined", () => {
  assert.doesNotMatch(html, /<script|onclick=|javascript:/i);
  assert.doesNotMatch(html, /undefined/);
});
