// 审计身份筛选（#518）—— 工具栏此前只能按凭据**类型**收窄（`credential`），不能按某个 OAuth 客户端、
// 某个 API Key 或某条 Token 收窄。本文件钉住三件事：按记录里的原始 id **精确**匹配（不是 `q` 的子串）、
// 身份字段缺失的记录不会被选中项误匹配、以及筛选能同时生效并跟着深链/导出走。
//
// 断言走的是对外接口（`auditCsv` 的行集与 `renderAuditPage` 的 HTML），不导出内部函数。
import assert from "node:assert/strict";
import test from "node:test";
import { auditCsv, renderAuditPage } from "../../src/admin/pages/audit.js";

const CLIENTS = [
  { clientId: "c1", clientName: "Claude Desktop" },
  { clientId: "c2", clientName: "Cursor" },
];
const KEYS = [
  { id: "k1", label: "laptop" },
  { id: "configured-env", label: "环境配置 API_KEY" },
];
const ACCOUNTS = [{ id: "u1", username: "alice", displayName: "Alice" }];

const ROWS = [
  // OAuth access token t1, issued to client c1 for Alice.
  { id: "a1", at: "2026-11-01T10:00:00.000Z", action: "mcp.tool.call", credentialType: "oauth-access", credentialId: "t1", clientId: "c1", userId: "u1", outcome: "success", source: "127.0.0.1" },
  // Refresh token t2, same client/account — a different record, so it must be a different filter value.
  { id: "a2", at: "2026-11-01T10:01:00.000Z", action: "oauth.token.refresh", credentialType: "oauth-refresh", credentialId: "t2", clientId: "c1", userId: "u1", outcome: "success", source: "127.0.0.1" },
  // API Key k1 — no client, no account.
  { id: "a3", at: "2026-11-01T10:02:00.000Z", action: "mcp.tool.call", credentialType: "api-key", credentialId: "k1", outcome: "failure", reason: "scope", source: "10.0.0.5" },
  // The environment-configured Key: a real id that must be selectable like any other Key.
  { id: "a4", at: "2026-11-01T10:03:00.000Z", action: "mcp.tool.call", credentialType: "api-key", credentialId: "configured-env", outcome: "success", source: "10.0.0.6" },
  // A row for the other client, and one with no credential id at all (issued-event shape).
  { id: "a5", at: "2026-11-01T10:04:00.000Z", action: "mcp.tool.call", credentialType: "oauth-access", credentialId: "t9", clientId: "c2", userId: "u1", outcome: "success", source: "10.0.0.7" },
  { id: "a6", at: "2026-11-01T10:05:00.000Z", action: "oauth.client.authenticate", credentialType: "oauth-client", clientId: "c1", outcome: "success", source: "10.0.0.8" },
];

const model = {
  keyOf: (id) => KEYS.find((item) => item.id === id) || null,
  keyName: (item) => (item ? item.label : "—"),
  client: (id) => CLIENTS.find((item) => item.clientId === id) || null,
  clientName: (item) => (item ? item.clientName : "—"),
  acct: (id) => ACCOUNTS.find((item) => item.id === id) || null,
  acctName: (item) => (item ? item.displayName || item.username : "—"),
};

const ctx = {
  snapshot: { audit: ROWS, clients: CLIENTS, oauthUsers: ACCOUNTS, apiKeys: KEYS },
  keys: KEYS,
  clients: CLIENTS,
  oauthUsers: ACCOUNTS,
  model,
  query: {},
  csrf: "csrf-token",
};

const ids = (query) => auditCsv(ctx, query).count;

test("client filter keeps exactly the rows recorded for that client", () => {
  assert.equal(ids({ client: "c1" }), 3, "a1 + a2 + a6; a3 carries no client at all");
  assert.equal(ids({ client: "c2" }), 1);
  assert.equal(ids({}), ROWS.length);
});

test("apiKey filter matches the Key id on api-key records only", () => {
  assert.equal(ids({ apiKey: "k1" }), 1);
  assert.equal(ids({ apiKey: "configured-env" }), 1, "the environment-configured Key is selectable too");
  assert.equal(ids({ apiKey: "t1" }), 0, "a token id is never an API Key");
});

test("token filter matches access and refresh records by their own id", () => {
  assert.equal(ids({ token: "t1" }), 1);
  assert.equal(ids({ token: "t2" }), 1, "a refresh token is its own record, not the access token's id");
  assert.equal(ids({ token: "t9" }), 1);
  assert.equal(ids({ token: "k1" }), 0, "an API Key id is never a token");
  assert.equal(ids({ token: "c1" }), 0, "a client id is never a token");
});

test("identity filters combine with the existing ones", () => {
  assert.equal(ids({ client: "c1", outcome: "failure" }), 0);
  assert.equal(ids({ apiKey: "k1", outcome: "failure" }), 1);
  assert.equal(ids({ client: "c1", credential: "oauth-access" }), 1, "a5 belongs to c2, so only a1 is left");
  assert.equal(ids({ q: "Alice", token: "t1" }), 1);
});

test("the toolbar offers one option per recorded identity, valued by the raw id", () => {
  const { content } = renderAuditPage(ctx);
  assert.match(content, /<select[^>]*name="client"/);
  assert.match(content, /<select[^>]*name="apiKey"/);
  assert.match(content, /<select[^>]*name="token"/);
  for (const value of ["c1", "c2", "k1", "configured-env", "t1", "t2"]) {
    assert.ok(content.includes(`value="${value}"`), `option carries the raw id ${value}`);
  }
  assert.ok(content.includes("Claude Desktop"), "the client option shows its readable name");
  assert.ok(content.includes("laptop"), "the Key option shows its label");
});

test("a deep link keeps the identity filter in the export and the pager", () => {
  const { content } = renderAuditPage({ ...ctx, query: { token: "t1" } });
  assert.ok(content.includes("token=t1"), "the export href carries the filter");
  assert.ok(content.includes("export.csv"), "the export link is still there");
  assert.match(content, /<select[^>]*name="token"[\s\S]*?<option value="t1" selected/, "the select shows the active value");
  assert.ok(content.includes("共 1 条") || content.includes("共&nbsp;1"), "the pager counts the filtered set");
});

test("identity filters compare whole ids, not prefixes", () => {
  // `c1`/`c10`, `t1`/`t12` and `k1`/`k12` are the pairs a substring filter would confuse.
  const prefixed = {
    ...ctx,
    snapshot: {
      ...ctx.snapshot,
      audit: [
        ...ROWS,
        { id: "a8", at: "2026-11-01T10:06:00.000Z", action: "mcp.tool.call", credentialType: "oauth-access", credentialId: "t12", clientId: "c10", userId: "u1", outcome: "success" },
        { id: "a9", at: "2026-11-01T10:07:00.000Z", action: "mcp.tool.call", credentialType: "api-key", credentialId: "k12", outcome: "success" },
      ],
    },
  };
  assert.equal(auditCsv(prefixed, { client: "c1" }).count, 3, "c10 is a different client");
  assert.equal(auditCsv(prefixed, { client: "c10" }).count, 1);
  assert.equal(auditCsv(prefixed, { token: "t1" }).count, 1, "t12 is a different token");
  assert.equal(auditCsv(prefixed, { token: "t12" }).count, 1);
  assert.equal(auditCsv(prefixed, { apiKey: "k1" }).count, 1, "k12 is a different Key");
  assert.equal(auditCsv(prefixed, { apiKey: "k12" }).count, 1);
});

test("an API Key row never becomes a client option", () => {
  // API-key records carry `clientId: "api-key:<keyId>"` (`src/oauth-provider.js`); the client model
  // cannot resolve that id, so it must not appear as a client — the Key has its own filter.
  const keyed = {
    ...ctx,
    snapshot: {
      ...ctx.snapshot,
      audit: [...ROWS, { id: "a7", at: "2026-11-01T10:06:00.000Z", action: "mcp.tool.call", credentialType: "api-key", credentialId: "k1", clientId: "api-key:k1", outcome: "success" }],
    },
  };
  const { content } = renderAuditPage(keyed);
  assert.ok(!content.includes('value="api-key:k1"'), "an id the client model cannot resolve is not offered as a client");
  assert.ok(content.includes('value="k1"'), "the same Key is still offered by the API Key filter");
});

test("an identity filter that matches nothing keeps its own value selectable", () => {
  const { content } = renderAuditPage({ ...ctx, query: { client: "c9" } });
  assert.match(content, /<option value="c9" selected/, "an id with no rows still shows as the active filter");
  assert.ok(content.includes("c9"), "and the reset link is offered");
});
