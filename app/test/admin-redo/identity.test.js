// Lane W1-identity acceptance tests: the three identity pages (OAuth 账户 / API Key / OAuth 客户端)
// rendered through the real `catalog.js` seam on a fabricated service snapshot.
//
// What this pins, from docs/admin-ui-proto/src/5-render.js (185–250), src/6-app.js (219–256, 127–137)
// and docs/admin/README.md:
//   * the prototype's column set and cell shapes for all three tables;
//   * the `?id=` drawer / the `?id=new` create drawer (reached by a GET form, never by an anchor the
//     parity probe could resolve as a detail entry) / `?confirm=…` confirm-page states, including the
//     read-only `configured-env` Key and the #364 transfer states;
//   * the no-script contract: no `<script>`, no `data-act`/`data-open` hooks, and every POST form
//     carries the session `csrf` token.
// Three negative controls run the same predicates against deliberately broken HTML, so a predicate
// that cannot fail is visible as such.

import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalog } from "../../src/admin/catalog.js";
import { renderAccountsPage } from "../../src/admin/pages/accounts.js";
import { renderKeysPage } from "../../src/admin/pages/keys.js";
import { renderClientsPage } from "../../src/admin/pages/clients.js";

const CSRF = "csrf-lane-w1";
const ACCESS_POLICY_BASE = "/admin/auth/access-policy";
const NOW = Date.parse("2026-10-12T08:00:00Z");

// Prototype screenshot ids (scratch/admin-parity/out/proto) so a failure is easy to look up.
const U_ALICE = "2819e4a9-6c1d-4b8e-9f20-5a7c3e1d0b42";
const U_AUDIT = "6b03f7d2-1111-4b8e-9f20-5a7c3e1d0b42";
const U_CAROL = "c4d8a0e1-2222-4b8e-9f20-5a7c3e1d0b42";
const C_CURSOR = "0f6a2d91-8b47-4c3e-a5d1-2e9b7c4f8a60";
const C_OTHER = "aa11bb22-8b47-4c3e-a5d1-2e9b7c4f8a60";
const K_DESKTOP = "87ca7263-0f4e-4a1b-b6d9-3c5e81f20a7d";
const T_PENDING = "tr-1";

const account = (overrides) => ({
  id: U_ALICE,
  username: "alice",
  displayName: "Alice Chen",
  allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
  allowedVaults: ["vault"],
  createdAt: "2026-08-30T02:30:00Z",
  disabledAt: null,
  lastLoginAt: "2026-10-12T06:00:00Z",
  lastSource: "192.168.1.24",
  ...overrides,
});

function grant(id, type, userId, clientId, overrides = {}) {
  return {
    id,
    type,
    userId,
    clientId,
    generation: 0,
    scopes: ["obsidian.read"],
    allowedVaults: ["vault"],
    createdAt: "2026-10-01T02:00:00Z",
    lastUsedAt: "2026-10-12T05:00:00Z",
    lastSource: "192.168.1.24",
    lastUserAgent: "obsidian-mcp-client/1.0",
    connectionOrigin: "https://cursor.example",
    status: "active",
    ...overrides,
  };
}

const SNAPSHOT = Object.freeze({
  oauthUsers: [
    account(),
    account({ id: U_AUDIT, username: "audit-user", displayName: "audit-user", allowedScopes: ["obsidian.read"], disabledAt: "2026-10-05T00:00:00Z", lastLoginAt: null, lastSource: null }),
    account({ id: U_CAROL, username: "carol", displayName: "Carol Wu", allowedScopes: ["obsidian.read"], lastLoginAt: null, lastSource: null }),
  ],
  clients: [
    {
      clientId: C_CURSOR,
      clientName: "Cursor IDE",
      redirectUris: ["https://cursor.example/callback", "https://cursor.example/callback-2"],
      connectionOrigins: ["https://cursor.example"],
      registeredOrigin: "https://cursor.example",
      lastRequestedOrigin: "https://cursor.example",
      lastAuthorizedOrigin: "https://cursor.example",
      lastConnectionOrigin: "https://cursor.example",
      createdAt: "2026-09-01T01:00:00Z",
      lastUsedAt: "2026-10-12T05:00:00Z",
      lastSource: "10.0.0.5",
      lastUserAgent: "obsidian-mcp-client/1.0",
    },
    {
      clientId: C_OTHER,
      clientName: "",
      redirectUris: [],
      connectionOrigins: [],
      registeredOrigin: null,
      lastRequestedOrigin: null,
      lastAuthorizedOrigin: null,
      lastConnectionOrigin: null,
      createdAt: null,
      lastUsedAt: null,
      lastSource: null,
      lastUserAgent: null,
    },
  ],
  tokens: [
    grant("at-1", "access", U_ALICE, C_CURSOR),
    grant("rt-1", "refresh", U_ALICE, C_CURSOR),
    grant("at-2", "access", U_AUDIT, C_CURSOR, { status: "revoked", revokedAt: "2026-10-05T00:00:00Z" }),
  ],
  apiKeys: [
    {
      id: K_DESKTOP,
      label: "桌面客户端",
      prefix: "obmcp_ab12cd34ef56",
      createdAt: "2026-09-10T03:00:00Z",
      lastUsedAt: "2026-10-12T04:00:00Z",
      lastSource: "192.168.1.31",
      lastUserAgent: "node-fetch/1.0",
      allowedScopes: ["obsidian.read"],
      allowedVaults: ["vault"],
    },
  ],
  audit: [],
});

const VAULTS = [{ id: "vault", name: "主库", primary: true }];

/** The real catalog seam on a stub provider, plus the router-supplied context fields. */
async function ctxFor(query = {}) {
  const provider = {
    ready: Promise.resolve(),
    authorizationSnapshot: async () => structuredClone(SNAPSHOT),
  };
  const catalog = await buildCatalog({
    deps: {
      provider,
      listVaults: async () => ({ vaults: VAULTS }),
      configuredApiKeyEnabled: true,
      accessPolicyAdmin: {
        listPolicies: async () => ({
          status: "ready",
          revision: 3,
          policies: [{ id: "p1", label: "工作时段只读", enabled: true, subjects: [`api-key:${K_DESKTOP}`], weekly: [] }],
          orphaned: [],
        }),
      },
    },
    req: { headers: {} },
    query,
    now: NOW,
  });
  return { ...catalog, csrf: CSRF, session: { csrf: CSRF }, accessPolicyBase: ACCESS_POLICY_BASE, vaultGitBase: "/admin/auth/vault-git" };
}

const render = async (page, query) => {
  const ctx = await ctxFor(query);
  if (page === "accounts") return renderAccountsPage(ctx);
  if (page === "keys") return renderKeysPage(ctx);
  return renderClientsPage(ctx);
};

// ---------------------------------------------------------------- predicates under test

/** `<thead>` labels, in order (the prototype's column set). */
function columnsOf(html) {
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? "";
  return [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((match) => match[1].replace(/\s+/g, " ").trim());
}

const columnsAre = (html, expected) => JSON.stringify(columnsOf(html)) === JSON.stringify(expected);

/** Every POST form must carry the session CSRF token (the no-JS write path). */
function postFormsWithoutCsrf(html) {
  const forms = [...html.matchAll(/<form[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/g)];
  return forms.filter((match) => !/name="csrf" value="[^"]+"/.test(match[1]));
}

const postFormCount = (html) => [...html.matchAll(/<form[^>]*method="post"/g)].length;

/**
 * The prototype-parity gate's own resolution rule (`scripts/proto-parity/gate.mjs: liveDrawerId`):
 * the live `?id=` drawer is the page's **first** `?id=` anchor. A create affordance rendered as such
 * an anchor would feed the gate the create drawer, so the assertion below pins that the first one is
 * a row's detail entry.
 */
function firstIdParam(html) {
  for (const match of html.matchAll(/<a[^>]+href="([^"]+)"/g)) {
    const found = /[?&]id=([^&#]+)/.exec(match[1].replace(/&amp;/g, "&"));
    if (found) return decodeURIComponent(found[1]);
  }
  return null;
}

/** No script, and no affordance that only script could drive. */
const scriptFree = (html) => !html.includes("<script") && !html.includes("data-act=") && !html.includes("data-open=") && !html.includes('data-menu="');

/**
 * Event-handler attributes that actually landed inside a tag. Matching the raw text would flag the
 * escaped payload (`&lt;img … onerror=…&gt;`) as if it were live markup, so the check is anchored to
 * a real opening tag.
 */
const rawEventHandlers = (html) => [...html.matchAll(/<[a-z][a-z0-9]*\b[^>]*?\son[a-z]+\s*=/gi)].map((match) => match[0].slice(0, 60));

// ---------------------------------------------------------------- OAuth 账户

const ACCOUNT_COLUMNS = ["账户", "状态", "权限上限 · Vault", "已授权客户端", "最后登录", "创建", ""];

test("accounts: prototype table columns, widths and cell shapes", async () => {
  const { content } = await render("accounts", { tab: "accounts" });
  assert.ok(columnsAre(content, ACCOUNT_COLUMNS), `columns: ${JSON.stringify(columnsOf(content))}`);
  for (const width of ["24%", "10%", "24%", "16%", "14%", "10%"]) assert.ok(content.includes(`<col style="width:${width}">`), `col width ${width}`);
  assert.match(content, /<h1>OAuth 账户<span class="cnt">3<\/span><\/h1>/);
  assert.ok(content.includes('<p class="lede">账户用于客户端的 OAuth 同意页登录，与管理密码相互独立。</p>'));
  // 名称优先: display name + username second line + short id (prototype 189).
  assert.match(content, /<b>Alice Chen<\/b><span class="sub2"><span class="mono">alice<\/span><code class="idc" title="完整 ID：2819e4a9/);
  // 2026-10-21: an account whose display name equals its username keeps ONLY the id on the second line —
  // the old 「未设置显示名」 placeholder was noise on the real plane (owner screenshot). The row must still
  // carry its short id, and the placeholder must be gone.
  assert.equal(content.includes("未设置显示名"), false, "no placeholder in the name cell");
  assert.match(content, /<b>audit-user<\/b><span class="sub2"><code class="idc" title="完整 ID：/);
  // 状态: dot + word; a disabled account also dims its row.
  assert.ok(content.includes('<span class="st ok"><span class="dot"></span>启用</span>'));
  assert.ok(content.includes('<span class="st off"><span class="dot"></span>已停用</span>'));
  assert.match(content, /<tr class="dim">/);
  // 已授权客户端 links to the client drawer; the disabled account has none (`&` is escaped in hrefs).
  assert.ok(content.includes(`<a href="/admin/auth?tab=clients&amp;id=${C_CURSOR}">Cursor IDE</a>`));
  // 最后登录: relative time + source IP; 创建: date only.
  assert.match(content, /<span title="2026-10-12 06:00:00">.*<\/span> <span class="muted mono">192\.168\.1\.24<\/span>/);
  assert.ok(content.includes('<td class="cellt muted">2026-08-30</td>'));
  assert.ok(content.includes('<span class="muted">从未登录</span>'));
  // Row menu + create button + search box. The create affordance is a GET form (the prototype's CTA
  // is a `<button>`); it must not be an `<a href="…&id=new">` anchor, or the parity probe would read
  // the create drawer as this page's detail drawer.
  assert.ok(content.includes('<details class="mn">'));
  assert.ok(content.includes('<form class="inline-form" method="get" action="/admin/auth"><input type="hidden" name="tab" value="accounts"><input type="hidden" name="id" value="new"><button class="btn primary" type="submit">'));
  assert.ok(content.includes('<span class="hide-m">新建账户</span>'));
  const firstAccountId = firstIdParam(content);
  assert.equal(firstAccountId, U_ALICE, 'the first ?id= anchor on the list page is a row detail link, never the create state');
  assert.ok(content.includes(`<td><a class="cell-link block" href="/admin/auth?tab=accounts&amp;id=${U_ALICE}">`), 'and it is the row name link');
  assert.ok(content.includes('<form class="search" method="get" action="/admin/auth"><input type="hidden" name="tab" value="accounts">'));
  assert.ok(scriptFree(content), "accounts list must not render script-only affordances");
});

test("accounts: empty search result keeps the prototype .empty wording", async () => {
  const { content } = await render("accounts", { tab: "accounts", q: "nobody" });
  assert.ok(content.includes('<div class="empty">'));
  assert.ok(content.includes("<b>没有匹配的账户</b>"));
  assert.ok(content.includes("<span>换个关键词试试</span>"));
});

test("accounts: ?id= drawer reproduces the prototype detail panel", async () => {
  const { detailPanel } = await render("accounts", { tab: "accounts", id: U_ALICE });
  assert.ok(detailPanel.includes('<aside class="drawer on" id="drawer"'));
  assert.match(detailPanel, /<h1>Alice Chen/);
  for (const key of ["用户名", "显示名", "账户 ID", "创建", "最后登录", "已授权客户端"]) assert.ok(detailPanel.includes(`<div class="k">${key}</div>`), `kv ${key}`);
  assert.ok(detailPanel.includes('<div class="mono">alice</div>'));
  assert.ok(detailPanel.includes(`title="完整 ID：${U_ALICE}"`), "账户 ID shows the full id");
  // Permission form: real POST + CSRF + the amber "will revoke" banner with the linked-client count.
  assert.ok(detailPanel.includes('<form class="dsec" method="post" action="/admin/auth/oauth/user/scopes">'));
  assert.ok(detailPanel.includes(`<input type="hidden" name="id" value="${U_ALICE}">`));
  assert.ok(detailPanel.includes('name="allowedScope"'));
  assert.ok(detailPanel.includes('name="allowedVault" value="vault"'));
  assert.ok(detailPanel.includes('<div class="banner amber" style="margin:12px 0 0">'));
  // 2026-10-21: the banner now states what a save actually costs (the account's live access + refresh
  // tokens) and the form offers 「仅新增授权，不撤销现有会话」. The old copy only named the client count,
  // which is how granting one Vault revoked 255 tokens without the operator seeing it coming.
  assert.match(detailPanel, /该账户现有 \d+ 个 token（\d+ access \/ \d+ refresh/);
  assert.ok(detailPanel.includes("收紧权限会撤销它们全部"), "the cost of narrowing is stated");
  assert.ok(detailPanel.includes("只新增 Vault 或权限不会撤销"), "the additive case is stated as automatic");
  // Password form + danger zone + audit deep link.
  assert.ok(detailPanel.includes('action="/admin/auth/oauth/user/password"'));
  assert.ok(!detailPanel.includes("autofocus"), "plain drawer does not autofocus");
  assert.ok(detailPanel.includes('<div class="danger-zone">'));
  assert.ok(detailPanel.includes('<a class="btn danger-o" href="/admin/auth?tab=accounts&amp;id=' + U_ALICE + '&amp;confirm=disable">停用…</a>'));
  assert.ok(detailPanel.includes('/admin/auth?tab=audit&amp;q=Alice%20Chen'));
  assert.ok(scriptFree(detailPanel));
});

test("accounts: ?mode=pw autofocuses the password field, a disabled account gets 启用 instead of 停用", async () => {
  const pw = await render("accounts", { tab: "accounts", id: U_ALICE, mode: "pw" });
  assert.ok(pw.detailPanel.includes('name="password" autocomplete="new-password" placeholder="新密码，至少 12 位" autofocus'));
  const disabled = await render("accounts", { tab: "accounts", id: U_AUDIT });
  assert.ok(disabled.detailPanel.includes('<form class="inline-form" method="post" action="/admin/auth/oauth/user/toggle">'));
  assert.ok(disabled.detailPanel.includes('<input type="hidden" name="disabled" value="false">'));
  assert.ok(disabled.detailPanel.includes("启用账户"));
});

test("accounts: ?id=new create drawer posts the four server fields with CSRF", async () => {
  const { detailPanel } = await render("accounts", { tab: "accounts", id: "new" });
  assert.match(detailPanel, /<h1>新建 OAuth 账户/);
  assert.ok(detailPanel.includes('<form id="new-account" method="post" action="/admin/auth/oauth/user/create">'));
  for (const name of ["username", "displayName", "password"]) assert.ok(detailPanel.includes(`name="${name}"`), `field ${name}`);
  assert.ok(detailPanel.includes('<input type="hidden" name="csrf" value="' + CSRF + '">'));
  assert.ok(detailPanel.includes('form="new-account"'), "footer submit button targets the form without script");
});

test("accounts: confirm pages are GET states whose form POSTs the write", async () => {
  const disable = await render("accounts", { tab: "accounts", id: U_ALICE, confirm: "disable" });
  assert.ok(disable.detailPanel.includes('<div class="modal show"'));
  assert.ok(disable.detailPanel.includes("停用后该账户<b>无法登录授权页</b>"));
  assert.match(disable.detailPanel, /<form\b[^>]*method="post" action="\/admin\/auth\/oauth\/user\/toggle"/);
  assert.ok(disable.detailPanel.includes('<input type="hidden" name="disabled" value="true">'));
  assert.ok(disable.detailPanel.includes('href="/admin/auth?tab=accounts&amp;id=' + U_ALICE + '"'), "cancel returns to the drawer");

  const del = await render("accounts", { tab: "accounts", id: U_ALICE, confirm: "delete" });
  assert.ok(del.detailPanel.includes('<input class="inp" name="confirm"'));
  assert.ok(del.detailPanel.includes("输入 <code>alice</code> 以确认"));
  assert.ok(del.detailPanel.includes('action="/admin/auth/oauth/user/delete"'));
  // A stale confirm link for a deleted account must not render a dead modal.
  const stale = await render("accounts", { tab: "accounts", id: "gone", confirm: "delete" });
  assert.ok(!stale.detailPanel.includes('<div class="modal show"'), "no confirm modal for a missing account");
  assert.ok(stale.detailPanel.includes('aria-label="账户不存在"'));
  assert.ok(stale.content.includes("该账户不存在或已删除，未执行任何操作。"));
});

test("accounts: unknown ?id= renders the prototype's not-found empty state", async () => {
  const { detailPanel } = await render("accounts", { tab: "accounts", id: "gone" });
  assert.match(detailPanel, /<h1>账户不存在/);
  assert.ok(detailPanel.includes("账户不存在或已删除"));
});

// ---------------------------------------------------------------- API Key

const KEY_COLUMNS = ["名称 / 前缀", "权限 · Vault", "最后调用", "来源", "创建", ""];

test("keys: prototype columns, env Key read-only row, named Key row", async () => {
  const { content } = await render("keys", { tab: "keys" });
  assert.ok(columnsAre(content, KEY_COLUMNS), `columns: ${JSON.stringify(columnsOf(content))}`);
  for (const width of ["26%", "26%", "20%", "12%", "10%"]) assert.ok(content.includes(`<col style="width:${width}">`), `col width ${width}`);
  assert.match(content, /<h1>API Key<span class="cnt">2<\/span><\/h1>/);
  assert.ok(content.includes('<p class="lede">每个 Key 独立设置权限范围与可访问的 Vault。Key 明文只在创建时显示一次。</p>'));
  // The synthetic deployment Key: kind + note instead of a prefix, lock cell instead of a menu,
  // "随部署" instead of a creation date.
  assert.ok(content.includes('<span class="kind">环境变量</span><span class="muted">由部署 .env 提供</span>'));
  assert.ok(content.includes('<span class="ibtn lock-cell" title="环境配置 Key 只读：在受保护的 .env 中轮换">'));
  assert.ok(content.includes('<td class="cellt muted">随部署</td>'));
  assert.ok(content.includes('<b>环境配置 API_KEY</b>'));
  // The real Key: prefix + short id, last call with the raw UA (title-attributed), source IP.
  assert.ok(content.includes('<span class="mono">obmcp_ab12cd34ef56…</span>'));
  assert.ok(content.includes('title="node-fetch/1.0"'));
  assert.ok(content.includes('<td class="cellt mono muted">192.168.1.31</td>'));
  assert.ok(content.includes('<td class="cellt muted">2026-09-10</td>'));
  assert.match(content, /<details class="mn">/);
  // Same create affordance contract as the accounts page: a GET form, not an `?id=new` anchor.
  assert.ok(content.includes('<form class="inline-form" method="get" action="/admin/auth"><input type="hidden" name="tab" value="keys"><input type="hidden" name="id" value="new"><button class="btn primary" type="submit">'));
  const firstKeyId = firstIdParam(content);
  assert.ok(firstKeyId && firstKeyId !== 'new', `the first ?id= anchor on the keys page must be a detail entry, saw ${firstKeyId}`);
  assert.ok(content.includes(`<td><a class="cell-link block" href="/admin/auth?tab=keys&amp;id=${firstKeyId}">`), 'and it is a row name link');
  assert.ok(scriptFree(content));
  // The env row's action cell has no menu at all.
  const envRow = /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*环境配置 API_KEY(?:(?!<\/tr>)[\s\S])*<\/tr>/.exec(content)?.[0] ?? "";
  assert.ok(envRow.length > 0, "env Key row found");
  assert.ok(!envRow.includes("<details"), "env Key row must not offer a menu");
});

test("keys: ?id= drawer — env Key is read-only, a real Key is editable and links its policies", async () => {
  const env = await render("keys", { tab: "keys", id: "configured-env" });
  assert.match(env.detailPanel, /<h1>环境配置 API_KEY<span class="cnt">只读<\/span><\/h1>/);
  assert.ok(env.detailPanel.includes('<div class="banner ">'), "info banner about API_KEY");
  assert.ok(env.detailPanel.includes("来自部署环境变量"));
  assert.ok(env.detailPanel.includes('<div class="mono">—（环境变量）</div>'));
  assert.ok(env.detailPanel.includes("随部署"));
  assert.ok(!env.detailPanel.includes("danger-zone"), "env Key has no danger zone");
  assert.ok(env.detailPanel.includes("环境配置 Key 的权限来自部署配置，不能在管理端修改。"));

  const real = await render("keys", { tab: "keys", id: K_DESKTOP });
  assert.match(real.detailPanel, /<h1>桌面客户端/);
  assert.ok(real.detailPanel.includes('name="allowedScope"'));
  assert.ok(real.detailPanel.includes('<form class="dsec" method="post" action="/admin/auth/api-key/scopes">'));
  assert.ok(real.detailPanel.includes(`${ACCESS_POLICY_BASE}?edit=p1`), "policy link uses the access-policy base");
  assert.ok(real.detailPanel.includes('<div class="danger-zone">'));
  assert.ok(real.detailPanel.includes('href="/admin/auth?tab=keys&amp;id=' + K_DESKTOP + '&amp;confirm=delete"'));
  assert.ok(real.detailPanel.includes("绑定 Agent"));
  assert.ok(real.detailPanel.includes("规划中 · #285"));
  assert.ok(scriptFree(real.detailPanel));
});

test("keys: delete confirm types the Key name; empty search keeps .empty", async () => {
  const { detailPanel } = await render("keys", { tab: "keys", id: K_DESKTOP, confirm: "delete" });
  assert.ok(detailPanel.includes("输入 <code>桌面客户端</code> 以确认"));
  assert.ok(detailPanel.includes('action="/admin/auth/api-key/delete"'));
  const empty = await render("keys", { tab: "keys", q: "nope" });
  assert.ok(empty.content.includes("<b>没有匹配的 Key</b>"));
  assert.ok(empty.content.includes("<span>换个关键词试试</span>"));
});

// ---------------------------------------------------------------- OAuth 客户端

const CLIENT_COLUMNS = ["客户端", "已授权账户", "连接域名", "最后调用", "回调地址", ""];

const withPendingTransfer = (ctx) => ({ ...ctx, transfers: [{ id: T_PENDING, clientId: C_CURSOR, sourceUserId: U_ALICE, targetUserId: U_CAROL, status: "pending", createdAt: "2026-10-11T02:00:00Z", expiresAt: "2026-10-18T02:00:00Z" }] });

test("clients: prototype columns, linked accounts, connection domains, callbacks", async () => {
  const { content } = await render("clients", { tab: "clients" });
  assert.ok(columnsAre(content, CLIENT_COLUMNS), `columns: ${JSON.stringify(columnsOf(content))}`);
  for (const width of ["24%", "22%", "18%", "16%", "20%"]) assert.ok(content.includes(`<col style="width:${width}">`), `col width ${width}`);
  assert.match(content, /<h1>OAuth 客户端<span class="cnt">2<\/span><\/h1>/);
  assert.ok(content.includes('<p class="lede">客户端通过动态注册（DCR）自动出现。连接域名来自实际授权与调用，不从回调地址推测。</p>'));
  assert.ok(content.includes(`<a href="/admin/auth?tab=accounts&amp;id=${U_ALICE}">Alice Chen</a>`));
  assert.ok(content.includes('<span class="muted">无有效授权</span>'));
  // 连接域名: host + the sources the provider actually recorded; never inferred from the callback.
  assert.ok(content.includes('<span title="来源：注册、授权、调用">cursor.example</span>'));
  assert.ok(content.includes('cursor.example/callback</span> <span class="tag">+1</span>'));
  assert.ok(content.includes('title="https://cursor.example/callback\nhttps://cursor.example/callback-2"'), "callback title lists every URI");
  // Unnamed client keeps the italic placeholder.
  assert.ok(content.includes('style="font-style:italic;font-weight:400;color:var(--tx2)"'));
  assert.ok(scriptFree(content));
});

test("clients: drawer, callbacks (no script copy), transfer form and danger zone", async () => {
  const { detailPanel } = await render("clients", { tab: "clients", id: C_CURSOR });
  assert.match(detailPanel, /<h1>Cursor IDE/);
  for (const key of ["客户端 ID", "已授权账户", "连接域名", "注册", "最后调用"]) assert.ok(detailPanel.includes(`<div class="k">${key}</div>`), `kv ${key}`);
  assert.ok(detailPanel.includes(`title="完整 ID：${C_CURSOR}"`));
  assert.ok(detailPanel.includes('cursor.example <span class="muted">· 来源 注册 / 授权 / 调用</span>'));
  assert.ok(detailPanel.includes("<h3>回调地址 · 2</h3>"));
  assert.equal([...detailPanel.matchAll(/<div class="li">/g)].length, 2);
  assert.ok(!detailPanel.includes("#i-copy"), "no clipboard affordance without script");
  // Transfer form: a GET form into the confirm state, with the real source/target selects.
  assert.ok(detailPanel.includes('<form class="dsec" method="get" action="/admin/auth">'));
  assert.ok(detailPanel.includes('<input type="hidden" name="confirm" value="transfer">'));
  assert.ok(detailPanel.includes(`<option value="${U_ALICE}">Alice Chen（alice）</option>`));
  assert.ok(detailPanel.includes(`<option value="${U_CAROL}">Carol Wu（carol）</option>`));
  assert.ok(detailPanel.includes("<option disabled>audit-user · 已停用</option>"));
  assert.ok(detailPanel.includes("规划中 · #364 待决"));
  assert.ok(detailPanel.includes('<div class="danger-zone">'));
  assert.ok(detailPanel.includes('href="/admin/auth?tab=clients&amp;id=' + C_CURSOR + '&amp;confirm=revoke"'));
  assert.ok(scriptFree(detailPanel));
});

test("clients: begin-transfer confirm page posts clientId + source + target", async () => {
  const { detailPanel } = await render("clients", { tab: "clients", id: C_CURSOR, confirm: "transfer", sourceUserId: U_ALICE, targetUserId: U_CAROL });
  assert.match(detailPanel, /<form\b[^>]*method="post" action="\/admin\/auth\/oauth\/client\/transfer"/);
  for (const [name, value] of [["clientId", C_CURSOR], ["sourceUserId", U_ALICE], ["targetUserId", U_CAROL]]) {
    assert.ok(detailPanel.includes(`<input type="hidden" name="${name}" value="${value}">`), `hidden ${name}`);
  }
  assert.ok(detailPanel.includes("将立即撤销 <b>Alice Chen</b>"));
  assert.ok(detailPanel.includes('class="btn primary" type="submit"'), "begin-transfer is not a red danger action");
  // A disabled or absent target must not render a confirm page at all (the drawer stays open
  // behind the error line, so the selects can be fixed).
  const bad = await render("clients", { tab: "clients", id: C_CURSOR, confirm: "transfer", sourceUserId: U_ALICE, targetUserId: U_AUDIT });
  assert.ok(!bad.detailPanel.includes('action="/admin/auth/oauth/client/transfer"'), "no confirm page for an ineligible target");
  assert.ok(bad.detailPanel.includes('<aside class="drawer on"'), "the drawer stays available");
  assert.ok(bad.content.includes("请选择未停用且不同于源账户的目标账户，再发起转移。"));
});

test("clients: a pending transfer shows the amber state, disables the form and offers cancel", async () => {
  const ctx = await ctxFor({ tab: "clients", id: C_CURSOR });
  const view = renderClientsPage(withPendingTransfer(ctx));
  assert.ok(view.content.includes('<span class="tag amber" title="已撤销原账户授权，等待目标账户在客户端重新同意">转移中 → Carol Wu</span>'));
  assert.ok(view.detailPanel.includes('<div class="banner amber">'));
  assert.ok(view.detailPanel.includes("<b>授权转移待完成</b>"));
  assert.ok(view.detailPanel.includes('action="/admin/auth/oauth/client/transfer/cancel"'));
  assert.ok(view.detailPanel.includes(`<input type="hidden" name="transferId" value="${T_PENDING}">`));
  assert.ok(view.detailPanel.includes('name="targetUserId" disabled'));
  assert.ok(view.detailPanel.includes("已有一项转移待完成"));
  assert.ok(view.detailPanel.includes("取消只停止自动完成，不会恢复源账户已被撤销的旧凭证。"));
  assert.ok(view.content.includes(`confirm=cancel-transfer%3A${T_PENDING}`), "the row menu offers the cancel state");
  assert.ok(scriptFree(view.detailPanel));

  const cancel = await renderClientsPage(withPendingTransfer(await ctxFor({ tab: "clients", id: C_CURSOR, confirm: `cancel-transfer:${T_PENDING}` })));
  assert.match(cancel.detailPanel, /<form\b[^>]*method="post" action="\/admin\/auth\/oauth\/client\/transfer\/cancel"/);
  assert.ok(cancel.detailPanel.includes("取消不会恢复源账户"));
  assert.ok(cancel.detailPanel.includes("<b>Alice Chen</b> 已被撤销的旧凭证"));
});

test("clients: a pending transfer past its deadline is not reported as a live pending", async () => {
  const ctx = await ctxFor({ tab: "clients", id: C_CURSOR });
  const stale = { ...withPendingTransfer(ctx), transfers: [{ ...withPendingTransfer(ctx).transfers[0], expiresAt: "2026-10-05T02:00:00Z" }], now: NOW };
  const view = renderClientsPage(stale);
  assert.ok(view.content.includes("转移期限已过 → Carol Wu"));
  assert.ok(view.detailPanel.includes("<b>授权转移期限已过</b>"));
  assert.ok(view.detailPanel.includes("不可完成"));
});

test("clients: delete confirm types the client name", async () => {
  const { detailPanel } = await render("clients", { tab: "clients", id: C_CURSOR, confirm: "delete" });
  assert.ok(detailPanel.includes("输入 <code>Cursor IDE</code> 以确认"));
  assert.ok(detailPanel.includes('action="/admin/auth/oauth/client/delete"'));
});

// ---------------------------------------------------------------- no-script contract

test("no-JS contract: every POST form carries csrf and no page renders script hooks", async () => {
  const states = [
    ["accounts", { tab: "accounts" }], ["accounts", { tab: "accounts", id: U_ALICE }], ["accounts", { tab: "accounts", id: "new" }],
    ["accounts", { tab: "accounts", id: U_ALICE, confirm: "disable" }], ["accounts", { tab: "accounts", id: U_ALICE, confirm: "delete" }],
    ["accounts", { tab: "accounts", id: U_AUDIT }],
    ["keys", { tab: "keys" }], ["keys", { tab: "keys", id: K_DESKTOP }], ["keys", { tab: "keys", id: K_DESKTOP, confirm: "delete" }],
    ["keys", { tab: "keys", id: "configured-env" }], ["keys", { tab: "keys", id: "new" }],
    ["clients", { tab: "clients" }], ["clients", { tab: "clients", id: C_CURSOR }], ["clients", { tab: "clients", id: C_CURSOR, confirm: "delete" }],
    ["clients", { tab: "clients", id: C_CURSOR, confirm: "revoke" }],
  ];
  let forms = 0;
  for (const [page, query] of states) {
    const view = await render(page, query);
    for (const html of [view.content, view.detailPanel]) {
      assert.deepEqual(postFormsWithoutCsrf(html), [], `${page} ${JSON.stringify(query)}: POST form without csrf`);
      assert.ok(scriptFree(html), `${page} ${JSON.stringify(query)}: script-only hook rendered`);
      assert.deepEqual(rawEventHandlers(html), [], `${page} ${JSON.stringify(query)}: inline event handler rendered`);
      forms += postFormCount(html);
    }
  }
  assert.ok(forms >= 12, `expected the states to render real POST forms, saw ${forms}`);
});

// ---------------------------------------------------------------- negative controls

test("negative control: the column predicate goes red when a required column is dropped", async () => {
  const { content } = await render("accounts", { tab: "accounts" });
  assert.ok(columnsAre(content, ACCOUNT_COLUMNS));
  const tampered = content.replace("<th>状态</th>", "");
  assert.equal(columnsAre(tampered, ACCOUNT_COLUMNS), false, "dropping the 状态 column must fail the predicate");
  const renamed = content.replace("<th>已授权客户端</th>", "<th>Clients</th>");
  assert.equal(columnsAre(renamed, ACCOUNT_COLUMNS), false, "renaming a column must fail the predicate");
});

test("negative control: the escaping predicate goes red on an unescaped display name", async () => {
  const hostile = '"><img src=x onerror=alert(1)>';
  const ctx = await ctxFor({ tab: "accounts" });
  ctx.snapshot.oauthUsers[0].displayName = hostile;
  const { content } = renderAccountsPage(ctx);
  assert.deepEqual(rawEventHandlers(content), [], "page must not emit an event-handler attribute");
  assert.ok(!content.includes(hostile), "the raw payload must not survive escaping");
  assert.ok(content.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"), "payload is escaped, so it stays visible as text");
  // Same predicate against unescaped interpolation (what a forgotten `esc()` would emit):
  const unescaped = `<b>${hostile}</b>`;
  assert.notDeepEqual(rawEventHandlers(unescaped), [], "the predicate is sensitive to a missing esc()");
});

test("negative control: the csrf predicate goes red when a form loses its token", async () => {
  const { detailPanel } = await render("accounts", { tab: "accounts", id: U_ALICE });
  assert.deepEqual(postFormsWithoutCsrf(detailPanel), []);
  const tampered = detailPanel.replace(`<input type="hidden" name="csrf" value="${CSRF}">`, "");
  assert.ok(postFormsWithoutCsrf(tampered).length > 0, "a POST form without csrf must be detected");
});

test("negative control: the script-hook predicate goes red on a data-act affordance", async () => {
  const { content } = await render("clients", { tab: "clients" });
  assert.ok(scriptFree(content));
  assert.equal(scriptFree(`${content}<button data-act="new-account">新建账户</button>`), false, "a script-only hook must be detected");
});
