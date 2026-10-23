// Records & audit lane (W2-records) — structure pins for the three pages ported from
// `docs/admin-ui-proto/src/5-render.js`: OAuth Token (L250–L280), 发布文档 (L280–L311),
// 审计 (L311–L348).
//
// What is asserted, and why:
//   * column names/count/cell shape per page, plus the row-level class and the ⋯ menu;
//   * the no-JS contract: every `method="post"` form carries the request's `csrf` value, no
//     script-only affordance is rendered, and the danger confirmations are their own pages;
//   * honest data: a row the service did not fill renders `—`/未提供 instead of 0/成功;
//   * escaping: hostile field content never reaches the document as markup.
//
// The negative controls at the end re-run the same checkers against deliberately broken HTML
// (element removed / escaping removed) and fail if the checker stays green — a checker that cannot
// go red proves nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { renderTokensPage } from "../../src/admin/pages/tokens.js";
import { renderPublishesPage } from "../../src/admin/pages/publishes.js";
import { renderAuditPage } from "../../src/admin/pages/audit.js";
import { createModel } from "../../src/admin/presentation/model.js";
import { mergeTokenGrants } from "../../src/admin/grants.js";

const CSRF = "csrf-token-under-test";
const NOW = Date.parse("2026-10-10T10:30:00+08:00");

const VAULTS = [
  { id: "vault", name: "主库", primary: true },
  { id: "research", name: "研究库", primary: false },
];
const USERS = [
  { id: "u-alice", username: "alice", displayName: "Alice Chen", allowedScopes: ["obsidian.read"], allowedVaults: ["vault"] },
  { id: "u-bob", username: "bob", displayName: "Bob Li", allowedScopes: ["obsidian.read"], allowedVaults: ["research"] },
];
const CLIENTS = [
  { clientId: "c-claude", clientName: "Claude Desktop", redirectUris: ["http://127.0.0.1:33418/callback"], connectionOrigins: ["https://obsidian.example.com"] },
  { clientId: "c-cursor", clientName: "", redirectUris: ["cursor://callback"], connectionOrigins: [] },
];
const KEYS = [
  { id: "configured-env", label: "环境配置 API_KEY", prefix: "不可显示", immutable: true, allowedScopes: ["obsidian.read"], allowedVaults: ["vault"], createdAt: null, lastUsedAt: null },
  { id: "k-bot", label: "Research bot", prefix: "obmcp_a97db1bd", immutable: false, allowedScopes: ["obsidian.read"], allowedVaults: ["research"], createdAt: "2026-09-28T00:00:00.000Z", lastUsedAt: "2026-10-10T02:00:00.000Z" },
];
const TOKENS = [
  // active grant: both records live, so both must offer a revoke entry.
  { id: "tok-access-active", type: "access", clientId: "c-claude", userId: "u-alice", scopes: ["obsidian.read", "obsidian.write"], allowedVaults: ["vault"], createdAt: "2026-10-10T07:00:00.000Z", lastUsedAt: "2026-10-10T10:21:00.000Z", lastSource: "192.168.1.24", connectionOrigin: "https://obsidian.example.com", status: "active" },
  { id: "tok-refresh-active", type: "refresh", clientId: "c-claude", userId: "u-alice", scopes: ["obsidian.read", "obsidian.write"], allowedVaults: ["vault"], createdAt: "2026-10-10T07:00:00.000Z", lastUsedAt: "2026-10-10T10:21:00.000Z", lastSource: "192.168.1.24", connectionOrigin: "https://obsidian.example.com", status: "active" },
  // revoked grant: no menu at all (prototype `t.status === "active" ? moreBtn : ""`).
  { id: "tok-access-revoked", type: "access", clientId: "c-cursor", userId: "u-bob", scopes: ["obsidian.read"], allowedVaults: ["research"], createdAt: "2026-10-09T00:00:00.000Z", lastUsedAt: null, status: "revoked" },
  { id: "tok-refresh-revoked", type: "refresh", clientId: "c-cursor", userId: "u-bob", scopes: ["obsidian.read"], allowedVaults: ["research"], createdAt: "2026-10-09T00:00:00.000Z", lastUsedAt: null, status: "revoked" },
];
const PUBLICATIONS = [
  { id: "pZ8kq2Lm4Rt7", vaultId: "vault", path: "Projects/Alpha.md", lifecycle: "active", createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z", createdBy: "mcp:Claude Desktop/gpt-5.6" },
  { id: "tQ6yd0Fe2Jk8", vaultId: "vault", path: "Drafts/Old idea.md", lifecycle: "orphaned", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", createdBy: "web:alice" },
];
const AUDIT = [
  {
    id: "au-1", time: "2026-10-10T02:29:00.000Z", action: "mcp.tool.write_note", method: "tools/call", tool: "write_note",
    outcome: "success", credentialType: "api-key", credentialId: "k-bot", clientId: "api-key:k-bot", scopes: ["obsidian.read"],
    source: "192.168.1.5", sourcePeer: "192.168.1.5", sourceKind: "direct", forwardedChain: [], sourceTrusted: false,
    userAgent: "undici", agent: "undici", agentSource: "ua", origin: "obsidian.example.com",
  },
  {
    id: "au-2", time: "2026-10-10T02:15:00.000Z", action: "admin.login", outcome: "failure", credentialType: "none",
    source: "198.51.100.7", sourcePeer: "172.18.0.1", sourceKind: "trusted-proxy", sourceTrusted: true, sourceTrustedEntry: "172.18.0.1",
    forwardedChain: ["198.51.100.7"], userAgent: "python-requests/2.32.3", reason: "管理密码错误", origin: "obsidian.example.com",
  },
  {
    id: "au-3", time: "2026-10-10T01:00:00.000Z", action: "authz.denied", outcome: "failure", credentialType: "oauth-access",
    clientId: "c-claude", userId: "u-alice", source: "192.168.1.24", sourceKind: "loopback", userAgent: "Claude-User/1.0",
    agent: "Claude Desktop", agentSource: "clientInfo", detail: "定时授权拒绝：当前不在允许窗口", tool: "get_note",
  },
];

const model = createModel({ now: NOW, snapshot: { oauthUsers: USERS, clients: CLIENTS, audit: AUDIT, tokens: TOKENS }, keys: KEYS, vaults: VAULTS, publications: PUBLICATIONS });
const grants = mergeTokenGrants(TOKENS);

const tokensCtx = (overrides = {}) => ({ model, grants, csrf: CSRF, query: {}, ...overrides });
const publishesCtx = (overrides = {}) => ({ model, publications: PUBLICATIONS, csrf: CSRF, query: {}, publicBaseUrl: "https://obsidian.example.com", ...overrides });
const auditCtx = (overrides = {}) => ({ model, snapshot: { audit: AUDIT, oauthUsers: USERS, clients: CLIENTS, tokens: TOKENS }, csrf: CSRF, query: {}, ...overrides });

const html = (page) => `${page.content}${page.detailPanel || ""}`;
const headers = (markup) => [...markup.matchAll(/<thead><tr>(.*?)<\/tr><\/thead>/gs)].flatMap((match) => [...match[1].matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((cell) => cell[1]));
const postForms = (markup) => [...markup.matchAll(/<form[^>]*method="post"[^>]*>[\s\S]*?<\/form>/g)].map((match) => match[0]);

/**
 * The structural checks. Each returns a list of violations; `render + check` must be empty for a
 * real page and non-empty for the deliberately broken HTML in the negative controls below.
 */
function violations(source, checks) {
  return checks.filter(([, probe]) => !probe(source)).map(([name]) => name);
}

const TOKEN_CHECKS = [
  ["columns", (s) => JSON.stringify(headers(s)) === JSON.stringify(["客户端 · 账户", "Token（短 ID）", "权限 · Vault", "最后使用 · 签发", "状态", ""])],
  ["merged grant row", (s) => s.includes("访问 <code class=\"idc\"") && s.includes("刷新 <code class=\"idc\"")],
  ["account secondary line", (s) => s.includes("Alice Chen")],
  ["status tabs with counts", (s) => /class="seg"[\s\S]*全部[\s\S]*有效[\s\S]*已轮换[\s\S]*已撤销/.test(s) && s.includes('<span class="n">2</span>')],
  ["sort control", (s) => s.includes('name="order"') && s.includes("签发时间：从新到旧")],
  ["cleanup action", (s) => s.includes('href="/admin/auth?tab=tokens&amp;confirm=token-cleanup')],
  ["row menu", (s) => s.includes('<details class="mn">') && s.includes("撤销访问 Token…") && s.includes("撤销刷新 Token…")],
  ["revoked grant has no menu", (s) => !/tok-access-revoked[\s\S]{0,400}<details class="mn">/.test(s)],
  ["revoke menu entries", (s) => s.includes("撤销访问 Token…") && s.includes("撤销刷新 Token…")],
  ["mobile cards", (s) => s.includes('class="mcards"') && s.includes('class="mc"')],
  ["dim class on inactive row", (s) => s.includes('<tr class="dim">')],
  ["no script", (s) => !/<script|onclick=|javascript:/i.test(s)],
  ["no stray undefined", (s) => !/undefined/.test(s)],
];

/** Checks that only hold once a confirmation page is the rendered state. */
const TOKEN_REVOKE_CHECKS = [
  ["revoke confirm posts type+id", (s) => s.includes('action="/admin/auth/oauth/token/revoke"') && s.includes('name="type" value="refresh"') && s.includes('name="id" value="tok-refresh-active"')],
  ["revoke confirm opens as an overlay dialog", (s) => s.includes('class="scrim on"') && s.includes('role="alertdialog"')],
];
const TOKEN_CLEANUP_CHECKS = [
  ["cleanup confirm posts the retention", (s) => s.includes('action="/admin/auth/oauth/token/cleanup"') && s.includes('name="olderThanDays"')],
];

const PUBLISH_CHECKS = [
  ["columns", (s) => JSON.stringify(headers(s)) === JSON.stringify(["文档", "状态", "公开链接", "发布者", "发布时间", ""])],
  ["document cell", (s) => s.includes("Alpha") && s.includes('class="tag acc"') && s.includes("Projects/Alpha.md")],
  ["active status", (s) => s.includes("公开中")],
  ["retired status", (s) => s.includes("已失效 · 源笔记不存在")],
  ["retired banner", (s) => s.includes('<div class="banner amber">') && s.includes("1 条记录已失效")],
  ["public link only for active records", (s) => s.includes("https://obsidian.example.com/publish/pZ8kq2Lm4Rt7") && !/publish\/tQ6yd0Fe2Jk8/.test(s)],
  ["publisher cell resolves the actor", (s) => s.includes("Claude Desktop") && s.includes("gpt-5.6") && s.includes("Web 用户")],
  ["published time + planned views marker", (s) => s.includes("访问统计") && s.includes('class="fut"')],
  ["row menu", (s) => s.includes('<details class="mn">') && s.includes("撤销公开链接…")],
  ["mobile cards", (s) => s.includes('class="mcards"')],
  ["no script", (s) => !/<script|onclick=|javascript:/i.test(s)],
  ["no stray undefined", (s) => !/undefined/.test(s)],
];

/** Checks that only hold once the revoke confirmation page is the rendered state. */
const PUBLISH_CONFIRM_CHECKS = [
  ["revoke confirm posts the id", (s) => s.includes('action="/admin/auth/publish/revoke"') && s.includes('name="id" value="pZ8kq2Lm4Rt7"')],
];

const AUDIT_CHECKS = [
  ["columns", (s) => JSON.stringify(headers(s)) === JSON.stringify(["时间", "结果", "动作", "凭据", "Agent", "来源", ""])],
  ["result cell", (s) => s.includes('<span class="st ok"><span class="dot"></span>成功') && s.includes('<span class="st danger"><span class="dot"></span>失败')],
  ["failed row tint", (s) => (s.match(/<tr class="fail"/g) || []).length === 2],
  ["action cell label + key", (s) => s.includes('title="mcp.tool.write_note"') && s.includes("MCP 工具调用") && s.includes('<span class="sub2">MCP</span>')],
  ["credential cell resolves key name", (s) => s.includes("API Key · Research bot")],
  ["credential cell anonymous", (s) => s.includes("匿名")],
  ["agent cell + provenance", (s) => s.includes("由 UA 推测") && s.includes("客户端自报")],
  ["source cell classification", (s) => s.includes("内网") && s.includes("反代（受信）") && s.includes("本机直连")],
  ["row detail is a details disclosure", (s) => s.includes('<details class="ua">') && s.includes('<div class="uax"')],
  ["row detail carries the failure reason", (s) => s.includes("失败原因：管理密码错误")],
  ["row detail carries action key/origin/credential/UA", (s) => s.includes("动作键") && s.includes("obsidian.example.com") && s.includes("python-requests/2.32.3")],
  ["row detail carries the real forward chain", (s) => s.includes("转发链：") && s.includes("← 反代 172.18.0.1（受信）")],
  ["filters are GET query state", (s) => s.includes('method="get"') && s.includes('action="/admin/auth"') && s.includes('href="/admin/auth?tab=audit&amp;outcome=failure"')],
  ["credential filter options", (s) => s.includes('name="credential"') && s.includes("所有凭据")],
  ["page size options", (s) => s.includes('name="pageSize"') && s.includes(">25<")],
  ["default outcome segment is the current one", (s) => s.includes('<a href="/admin/auth?tab=audit" class="on" aria-current="page">全部</a>')],
  ["default view offers no reset link", (s) => !/>重置<\/a>/.test(s)],
  ["clear-log entry in the ⋯ menu", (s) => s.includes('href="/admin/auth?tab=audit&amp;confirm=clear"') && s.includes('<details class="mn">')],
  ["export stays a planned marker without a control", (s) => s.includes("导出 CSV") && s.includes('class="fut"') && !/<button[^>]*>[^<]*导出 CSV/.test(s)],
  ["mobile cards", (s) => s.includes('class="mcards"')],
  ["no script", (s) => !/<script|onclick=|javascript:/i.test(s)],
  ["no stray undefined", (s) => !/undefined/.test(s)],
];

/** Checks that only hold once the type-to-confirm clear-log page is the rendered state. */
const AUDIT_CLEAR_CHECKS = [
  ["clear-log modal types the confirmation", (s) => s.includes('pattern="清空日志"') && s.includes('输入 <code>清空日志</code> 以确认')],
  ["clear-log modal posts with csrf to the existing route", (s) => s.includes('action="/admin/auth/audit/clear"') && new RegExp(`name="csrf" value="${CSRF}"`).test(s)],
  ["clear-log submit button is not disabled", (s) => /<button class="btn danger" type="submit">清空日志<\/button>/.test(s)],
];

test("OAuth Token page: prototype columns, merged grants, status tabs, confirmation pages", () => {
  const page = renderTokensPage(tokensCtx());
  assert.deepEqual(violations(html(page), TOKEN_CHECKS), []);
  assert.equal(page.detailPanel, "", "no drawer on the token list");
});

test("OAuth Token page: confirm pages are reachable state, not script", () => {
  const revoke = renderTokensPage(tokensCtx({ query: { confirm: "token-revoke", type: "refresh", id: "tok-refresh-active" } }));
  assert.match(revoke.detailPanel, /class="scrim on"/);
  assert.match(revoke.detailPanel, /role="alertdialog"/);
  assert.deepEqual(violations(html(revoke), [...TOKEN_CHECKS, ...TOKEN_REVOKE_CHECKS]), []);
  const cleanup = renderTokensPage(tokensCtx({ query: { confirm: "token-cleanup", days: 90 } }));
  assert.match(cleanup.detailPanel, /name="olderThanDays" value="90"/);
  // the retention choice is the modal's own state: the current one is posted, the others stay one
  // click away (the prototype's <select> options all remain reachable)
  assert.match(cleanup.detailPanel, /早于 90 天/);
  for (const days of ["7", "30"]) assert.match(cleanup.detailPanel, new RegExp(`days=${days}"`));
  assert.match(cleanup.detailPanel, /days=0">全部非活动记录/);
  assert.deepEqual(violations(html(cleanup), [...TOKEN_CHECKS, ...TOKEN_CLEANUP_CHECKS]), []);
});

test("OAuth Token page: status filter + sort order are query state", () => {
  const active = renderTokensPage(tokensCtx({ query: { status: "active" } }));
  assert.match(active.content, /<span class="cnt">1<\/span>/, "count reflects the filtered list");
  assert.doesNotMatch(active.content, /tok-access-revoked/);
  const ascending = renderTokensPage(tokensCtx({ query: { order: "asc" } }));
  assert.ok(ascending.content.indexOf("c-cursor") === -1 || ascending.content.indexOf("tok-refresh-active") >= 0);
  assert.match(ascending.content, /value="asc" selected/);
});

test("OAuth Token page: unknown grant renders — and never a fabricated 0", () => {
  const empty = renderTokensPage(tokensCtx({ grants: [], model: createModel({ now: NOW, snapshot: {}, keys: [], vaults: [] }) }));
  assert.match(empty.content, /没有该状态的 Token/);
  assert.match(empty.content, /绑定域名：<span class="muted">未提供<\/span>/);
});

test("发布文档 page: prototype columns, retired banner, revoke confirmation", () => {
  const page = renderPublishesPage(publishesCtx());
  assert.deepEqual(violations(html(page), PUBLISH_CHECKS), []);
  const confirm = renderPublishesPage(publishesCtx({ query: { confirm: "publish-revoke", id: "pZ8kq2Lm4Rt7" } }));
  assert.match(confirm.detailPanel, /撤销「Alpha」的公开链接？/);
  assert.deepEqual(violations(html(confirm), [...PUBLISH_CHECKS, ...PUBLISH_CONFIRM_CHECKS]), []);
});

test("发布文档 page: no records ⇒ prototype empty state, no banner, no public base url ⇒ no link", () => {
  const empty = renderPublishesPage(publishesCtx({ publications: [] }));
  assert.match(empty.content, /还没有公开的文档/);
  assert.doesNotMatch(empty.content, /class="banner amber"/);
  const noBase = renderPublishesPage(publishesCtx({ publicBaseUrl: "" }));
  assert.doesNotMatch(noBase.content, /obsidian\.example\.com\/publish/);
  assert.match(noBase.content, /\/publish\/pZ8kq2…/);
});

test("发布文档 page: the publisher cell renders the recorded actor, never a guessed one", () => {
  const at = (id, createdBy) => ({ id, vaultId: "vault", path: `${id}.md`, lifecycle: "active", createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", createdBy });
  const page = renderPublishesPage(publishesCtx({ publications: [at("p1", "admin-session"), at("p2", "mcp:c-claude"), at("p3", "mcp:Claude Code/gpt-5.6"), at("p4", null)] }));
  assert.match(page.content, /管理员会话/, "the Admin route module's actor literal resolves");
  assert.match(page.content, /Claude Desktop/, "an mcp actor that names a registered client resolves to its name");
  assert.match(page.content, /MCP · gpt-5.6/, "an mcp actor with an author keeps agent + model apart");
  assert.match(page.content, /<div class="muted">—<\/div>/, "a record with no recorded publisher renders —");
});

test("审计 page: prototype columns, fail tint, filters, pagination, clear-log confirmation", () => {
  const page = renderAuditPage(auditCtx());
  assert.deepEqual(violations(html(page), AUDIT_CHECKS), []);
  assert.match(page.content, /共 3 条 · <span style="color:var\(--danger\)">2 条失败<\/span>/);
  const clear = renderAuditPage(auditCtx({ query: { confirm: "clear" } }));
  assert.deepEqual(violations(html(clear), [...AUDIT_CHECKS, ...AUDIT_CLEAR_CHECKS]), []);
});

test("审计 page: failure filter narrows rows, page size and page are real query state", () => {
  const failed = renderAuditPage(auditCtx({ query: { outcome: "failure" } }));
  assert.doesNotMatch(failed.content, /write_note<\/span>/, "the success row is filtered out");
  assert.match(failed.content, /共 2 条/);
  assert.match(failed.content, /<a href="[^"]*outcome=failure" class="on" aria-current="page">失败<\/a>/, "the failure segment is the current one");
  assert.match(failed.content, />重置<\/a>/, "a non-default filter offers the reset link");
  const cosmetic = renderAuditPage(auditCtx({ query: { pageSize: "25" } }));
  assert.deepEqual(violations(html(cosmetic), AUDIT_CHECKS), []);
  const filtered = renderAuditPage(auditCtx({ query: { q: "python-requests" } }));
  assert.match(filtered.content, /共 1 条/);
  const paged = renderAuditPage(auditCtx({ query: { pageSize: "25", page: "7" } }));
  // Prototype pager: no `第 x / y 页` text — the current page is the `.pg` item marked `.on`
  // (`renderAudit`'s own pager). An out-of-range `?page=` therefore shows up as page 1 marked current.
  assert.match(paged.content, /<div class="pg"><button type="button" disabled>‹<\/button><span class="on" aria-current="page">1<\/span>/, "an out-of-range page falls back to the last page (here the only page, marked current)");
});

test("审计 page: the source cell classifies the address when no sourceKind was recorded", () => {
  const row = (source, extra = {}) => ({ ...AUDIT[0], id: `au-${source}`, source, sourceKind: undefined, forwardedChain: [], ...extra });
  const page = renderAuditPage(auditCtx({ snapshot: { ...auditCtx().snapshot, audit: [row("127.0.0.1"), row("192.168.1.9"), row("198.51.100.7"), row("10.0.0.9", { sourceKind: "untrusted-forwarded", forwardedChain: ["203.0.113.7"] })] } }));
  const cells = [...page.content.matchAll(/<span class="mono">([^<]+)<\/span><div class="muted">([^<]+)<\/div>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(cells, [["127.0.0.1", "本机直连"], ["192.168.1.9", "内网"], ["198.51.100.7", "公网"], ["10.0.0.9", "经未受信转发"]]);
  assert.match(page.content, /X-Forwarded-For：<span style="font-family:var\(--mono\)">203\.0\.113\.7<\/span>（未受信，仅诊断）/);
});

test("审计 page: the row-detail panel never claims the `.tbl .mono` keep contract", () => {
  // The panel is the one table descendant that is *supposed* to break a long value
  // (`.uax{word-break:break-all}`), so its monospaced values must not carry `.mono`: the layout
  // gate reads every `.tbl .mono` as an unbreakable token whose computed `white-space` must be
  // `nowrap`, and a wrapped `.mono` inside `td.act` is a real violation of that contract.
  const panel = /<details class="ua">[\s\S]*?<\/details>/g;
  const panels = html(renderAuditPage(auditCtx())).match(panel) || [];
  assert.ok(panels.length >= 3, "every audit row carries a detail panel");
  const PANEL_CHECKS = [["panel keeps its mono face inline instead of the contract class", (s) => !/<span class="mono"/.test(s)]];
  for (const markup of panels) assert.deepEqual(violations(markup, PANEL_CHECKS), []);
  assert.match(panels[1], /失败原因：管理密码错误/);
  // negative control: the same probe must go red against the contract-claiming markup.
  assert.ok(violations('<div class="uax">动作键 <span class="mono">admin.login</span></div>', PANEL_CHECKS).includes("panel keeps its mono face inline instead of the contract class"));
});

test("审计 page: an empty result renders the prototype empty state and no pager", () => {
  const page = renderAuditPage(auditCtx({ query: { q: "no-such-thing" } }));
  assert.match(page.content, /没有匹配的审计记录/);
  assert.match(page.content, /class="empty"/);
  assert.doesNotMatch(page.content, /class="pager"/);
});

test("no-JS contract: every POST form carries the request csrf, and no page renders script", () => {
  const pages = [
    html(renderTokensPage(tokensCtx({ query: { confirm: "token-revoke", type: "access", id: "tok-access-active" } }))),
    html(renderTokensPage(tokensCtx({ query: { confirm: "token-cleanup" } }))),
    html(renderPublishesPage(publishesCtx({ query: { confirm: "publish-revoke", id: "pZ8kq2Lm4Rt7" } }))),
    html(renderAuditPage(auditCtx({ query: { confirm: "clear" } }))),
  ];
  for (const markup of pages) {
    const forms = postForms(markup);
    assert.ok(forms.length > 0, "the page renders at least one POST form");
    for (const form of forms) {
      assert.match(form, new RegExp(`name="csrf" value="${CSRF}"`), "every POST form carries the csrf token");
    }
    assert.doesNotMatch(markup, /<script|on[a-z]+="|javascript:/i);
  }
});

test("hostile field content is escaped on every page", () => {
  const hostile = `"><img src=x onerror=alert(1)>`;
  const tokenPage = renderTokensPage(tokensCtx({ grants: mergeTokenGrants([{ id: "tok-x", type: "refresh", clientId: "c-claude", userId: "u-alice", scopes: [hostile], allowedVaults: [hostile], createdAt: "2026-10-10T00:00:00.000Z", status: "active" }]) }));
  const publishPage = renderPublishesPage(publishesCtx({ publications: [{ id: "p-x", vaultId: hostile, path: `Notes/${hostile}.md`, lifecycle: "active", createdAt: "2026-10-10T00:00:00.000Z", createdBy: hostile }] }));
  const auditPage = renderAuditPage(auditCtx({ snapshot: { ...auditCtx().snapshot, audit: [{ ...AUDIT[0], agent: hostile, tool: hostile, detail: hostile }] } }));
  for (const markup of [html(tokenPage), html(publishPage), html(auditPage)]) {
    assert.doesNotMatch(markup, /<img src=x/, "raw markup from a service field must not reach the document");
    assert.match(markup, /&lt;img src=x/, "the value is present, escaped");
  }
});

// ---------------------------------------------------------------- negative controls
// Each control breaks exactly one required property of the real output and asserts that the same
// checker used above goes red. If a checker cannot fail, the green run above means nothing.
test("negative control: dropping a required element turns the structure checks red", () => {
  const tokenHtml = html(renderTokensPage(tokensCtx()));
  assert.deepEqual(violations(tokenHtml, TOKEN_CHECKS), []);
  const withoutMenu = tokenHtml.replace(/<details class="mn">[\s\S]*?<\/details>/g, "");
  assert.ok(violations(withoutMenu, TOKEN_CHECKS).includes("row menu"), "removing the ⋯ menu must fail the row-menu check");

  const publishHtml = html(renderPublishesPage(publishesCtx()));
  const withoutBanner = publishHtml.replace(/<div class="banner amber">[\s\S]*?<\/div><\/div>/, "");
  assert.ok(violations(withoutBanner, PUBLISH_CHECKS).includes("retired banner"), "removing the amber banner must fail the banner check");

  const auditHtml = html(renderAuditPage(auditCtx()));
  const withoutDetail = auditHtml.replace(/<details class="ua">[\s\S]*?<\/details>/g, "");
  assert.ok(violations(withoutDetail, AUDIT_CHECKS).includes("row detail is a details disclosure"), "removing the disclosure must fail the disclosure check");
});

test("negative control: un-escaping a service value turns the escaping check red", () => {
  const hostile = `"><img src=x onerror=alert(1)>`;
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const escaped = `<b>${esc(hostile)}</b>`;
  const probes = [["raw markup", (s) => !/<img src=x/.test(s)], ["escaped value present", (s) => /&lt;img src=x/.test(s)]];
  assert.deepEqual(violations(escaped, probes), []);
  assert.ok(violations(`<b>${hostile}</b>`, probes).includes("raw markup"), "an unescaped value must fail the escaping probe");
});
