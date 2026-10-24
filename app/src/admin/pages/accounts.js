// OAuth 账户 — greenfield SSR port of the prototype page.
//   markup : docs/admin-ui-proto/src/5-render.js  renderAccounts()             (185–208)
//   states : docs/admin-ui-proto/src/6-app.js     drawerHtml() "new-account"   (221–223)
//                                                 drawerHtml() "account"       (238–242)
//                                                 menuItems()  "account"       (127–134)
//   rules  : docs/admin-ui-proto/README.md 「OAuth 账户」功能对照表 + docs/admin/README.md
//
// No script (CSP `default-src 'none'`, D0 HOLD). Every prototype interaction is reproduced by
// server state: the row name opens the `?id=` drawer, `?id=new` is the create drawer, `?confirm=…`
// is a confirm page (a GET page whose form POSTs), and `<details>` is the row menu. Deliberate
// deviations, all documented in the lane CHECKPOINT:
//   * the ⋯ menu has no "copy id" item (script-only affordance; the full id is selectable text);
//   * the password field has no show/hide eye (script) — it is a plain `<input type="password">`;
//   * `<details>` cannot draw the prototype's `<hr>` separator inside the menu;
//   * `?mode=pw` reproduces the prototype's `autofocus` on the password field (no script needed).
//
// Data comes from `catalog.js` only. A missing value renders as `—`; the account's disabled state is
// read from `disabledAt`, the only field the provider writes (never inferred from a missing login).
import { pageBar, searchBox, table, mcards, emptyState, moreMenu, drawer, confirmPage, kv, postForm } from "../ui.js";
import { esc, fmtDate, fmtFull, relTitle } from "../presentation/format.js";
import { st } from "../presentation/vocab.js";
import { ic } from "../assets/icons.js";
import { sessionCountsFor } from "../grants.js";

const TAB = "accounts";

/** `#/accounts[/<id>]` + its modals, kept as query state (`?tab=accounts&id=…`). */
function tabHref({ id = null, confirm = null, mode = null, q = null } = {}) {
  const parts = [`tab=${TAB}`];
  if (q) parts.push(`q=${encodeURIComponent(q)}`);
  if (id) parts.push(`id=${encodeURIComponent(id)}`);
  if (confirm) parts.push(`confirm=${encodeURIComponent(confirm)}`);
  if (mode) parts.push(`mode=${encodeURIComponent(mode)}`);
  return `/admin/auth?${parts.join("&")}`;
}

/** The provider's only disable signal (`createOAuthUser` / `updateOAuthUser` write `disabledAt`). */
function isDisabled(account) {
  return Boolean(account?.disabledAt || account?.disabled === true || account?.enabled === false);
}

/** The name line: display name first, username (or an explicit placeholder) as the second line. */
function nameCell(model, account) {
  const display = String(account.displayName || "").trim();
  const username = String(account.username || "").trim();
  const distinct = Boolean(display) && display !== username;
  // The prototype's row is `display name` over `username + id`; with no display name the title IS the
  // username, so a 「未设置显示名」 placeholder there only adds noise (owner screenshot 2026-10-21).
  const sub = distinct ? `<span class="mono">${esc(username)}</span>` : "";
  return `<a class="cell-link block" href="${esc(tabHref({ id: account.id }))}"><div class="nm"><b>${esc(model.acctName(account))}</b><span class="sub2">${sub}${model.idc(account.id)}</span></div></a>`;
}

function menu(ctx, account) {
  const disabled = isDisabled(account);
  return moreMenu([
    { href: tabHref({ id: account.id }), label: "查看与编辑", icon: "edit" },
    { href: tabHref({ id: account.id, mode: "pw" }), label: "重置密码…", icon: "lock" },
    disabled
      ? {
        action: "/admin/auth/oauth/user/toggle",
        label: "启用账户",
        icon: "play",
        csrf: ctx.csrf,
        fields: { id: account.id, disabled: "false" },
      }
      : { href: tabHref({ id: account.id, confirm: "disable" }), label: "停用账户…", icon: "pause" },
    { href: tabHref({ id: account.id, confirm: "delete" }), label: "删除账户…", icon: "trash", danger: true },
  ]);
}

function row(ctx, account, selectedId) {
  const { model } = ctx;
  const disabled = isDisabled(account);
  const linked = model.linkedClients(account.id);
  const rowCls = [disabled ? "dim" : "", selectedId === account.id ? "cur" : ""].filter(Boolean).join(" ");
  const linkedCell = linked.length
    ? linked.map((client) => `<a href="${esc(`/admin/auth?tab=clients&id=${encodeURIComponent(client.clientId)}`)}">${esc(model.clientName(client))}</a>`).join("、")
    : `<span class="muted">—</span>`;
  const loginCell = account.lastLoginAt
    ? `${relTitle(account.lastLoginAt)} <span class="muted mono">${esc(account.lastSource || "—")}</span>`
    : `<span class="muted">从未登录</span>`;
  return `<tr${rowCls ? ` class="${rowCls}"` : ""}>
    <td>${nameCell(model, account)}</td>
    <td>${disabled ? st("已停用", "off") : st("启用", "ok")}</td>
    <td><div class="tags">${model.scopeTags(account.allowedScopes)}${model.vaultTags(account.allowedVaults)}</div></td>
    <td class="cellt">${linkedCell}</td>
    <td class="cellt">${loginCell}</td>
    <td class="cellt muted">${esc(fmtDate(account.createdAt))}</td>
    <td class="act">${menu(ctx, account)}</td></tr>`;
}

function card(ctx, account) {
  const { model } = ctx;
  const disabled = isDisabled(account);
  const linked = model.linkedClients(account.id);
  return `<div class="mc"><div class="b">
    <a class="cell-link block" href="${esc(tabHref({ id: account.id }))}"><div class="nm"><b>${esc(model.acctName(account))}</b><span class="sub2">${esc(account.username || "")}${disabled ? " · 已停用" : ""}</span></div></a>
    <div class="tags">${model.scopeTags(account.allowedScopes)}${model.vaultTags(account.allowedVaults)}</div>
    <div class="meta"><span>${account.lastLoginAt ? `登录 ${relTitle(account.lastLoginAt)}` : "从未登录"}</span><span>${linked.length} 个客户端</span></div>
  </div>${menu(ctx, account)}</div>`;
}

/**
 * The page-bar / empty-state create affordance.
 *
 * The prototype's CTA is a `<button data-act="new-account">`, not a link (`5-render.js` 200), and the
 * plane renders no script, so `?id=new` is reached through a GET form. It must **not** be an
 * `<a href="…&id=new">` anchor: on a list page every `?id=` anchor is a *detail* entry (the row's
 * name link), and the prototype-parity probe resolves the live `?id=` drawer from the first such
 * anchor (`scripts/proto-parity/gate.mjs: liveDrawerId`). A create anchor there makes the gate
 * compare the create drawer against the prototype's account drawer — a false difference, not a
 * missing section (the account drawer already matches `6-app.js` 227–236 section for section).
 */
function createCta(label) {
  return `<form class="inline-form" method="get" action="/admin/auth"><input type="hidden" name="tab" value="${TAB}"><input type="hidden" name="id" value="new"><button class="btn primary" type="submit">${ic("plus")}<span class="hide-m">${label}</span></button></form>`;
}

/** Prereq pickers shared by the create drawer and the permission form (prototype `scopeChecks`). */
function pickers(ctx, { scopes = [], vaults = [] } = {}) {
  const vaultList = Array.isArray(ctx.vaults) ? ctx.vaults : [];
  const vaultBlock = vaultList.length
    ? ctx.model.vaultOptions(vaults)
    : `<p class="help">服务端未提供 Vault 清单，无法勾选允许的 Vault。请先到「Vault 与 Git」页刷新清单。</p>`;
  return { scopes: ctx.model.scopeOptions(scopes), vaults: vaultBlock };
}

function createDrawer(ctx) {
  const { scopes, vaults } = pickers(ctx, { scopes: ["obsidian.read"], vaults: (ctx.vaults || []).filter((v) => v.primary).map((v) => v.id) });
  return drawer({
    title: "新建 OAuth 账户",
    closeHref: tabHref(),
    bodyHtml: `<form id="new-account" method="post" action="/admin/auth/oauth/user/create">
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <div class="dsec"><div class="grid2">
      <div class="fld"><label>用户名 <small>username</small></label><input class="inp" name="username" placeholder="3–64 位，例如 carol" required><span class="help">授权页登录用，创建后不可改名</span></div>
      <div class="fld"><label>显示名 <span class="muted">可选</span></label><input class="inp" name="displayName" placeholder="例如 Carol Wu"></div>
    </div>
    <div class="fld" style="margin-top:12px"><label>初始密码</label><input class="inp" type="password" name="password" autocomplete="new-password" placeholder="至少 12 位"><span class="help">与管理密码相互独立；用户在客户端的授权页使用</span></div></div>
    <div class="dsec"><h3>权限上限</h3><div class="grid2" style="gap:0">${scopes}</div></div>
    <div class="dsec"><h3>允许的 Vault</h3>${vaults}</div>
  </form>`,
    footHtml: `<span class="help"></span><a class="btn ghost" href="${esc(tabHref())}">取消</a><button class="btn primary" type="submit" form="new-account">创建账户</button>`,
  });
}

function accountDrawer(ctx, account, mode) {
  const { model, query } = ctx;
  const disabled = isDisabled(account);
  const linked = model.linkedClients(account.id);
  const pick = pickers(ctx, { scopes: account.allowedScopes || [], vaults: account.allowedVaults || [] });
  // What the save button is actually about to cost: the account's live access + refresh tokens.
  const counts = sessionCountsFor(Array.isArray(ctx.grants) ? ctx.grants : [], account.id);
  const linkedCell = linked.length
    ? linked.map((client) => `<a href="${esc(`/admin/auth?tab=clients&id=${encodeURIComponent(client.clientId)}`)}">${esc(model.clientName(client))}</a>`).join("、")
    : `<span class="muted">无</span>`;
  const body = `
  <div class="dsec">${kv([
    ["用户名", esc(account.username || "—"), 'class="mono"'],
    ["显示名", account.displayName ? esc(account.displayName) : `<span class="muted">未设置</span>`],
    ["账户 ID", model.idc(account.id, account.id)],
    ["创建", esc(fmtFull(account.createdAt))],
    ["最后登录", account.lastLoginAt ? `${esc(fmtFull(account.lastLoginAt))} <span class="muted mono">· ${esc(account.lastSource || "—")}</span>` : `<span class="muted">从未登录</span>`],
    ["已授权客户端", linkedCell],
  ])}</div>
  <form class="dsec" method="post" action="/admin/auth/oauth/user/scopes">
    <h3>权限上限与 Vault</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="id" value="${esc(account.id)}">
    ${pick.scopes}
    <div style="height:8px"></div>
    ${pick.vaults}
    <div class="banner amber" style="margin:12px 0 0">${ic("alert")}<div>该账户现有 ${counts.total} 个 token（${counts.access} access / ${counts.refresh} refresh，${counts.clients || linked.length} 个客户端）：<b>收紧权限会撤销它们全部</b>，需重新授权；<b>只新增 Vault 或权限不会撤销</b>，旧会话仍只拥有它签发时的那组 Vault。</div></div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" type="submit">保存权限</button></div>
  </form>
  <form class="dsec" method="post" action="/admin/auth/oauth/user/password">
    <h3>重置密码</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="id" value="${esc(account.id)}">
    <div style="display:flex;gap:8px"><input class="inp grow" type="password" name="password" autocomplete="new-password" placeholder="新密码，至少 12 位"${mode === "pw" ? " autofocus" : ""}><button class="btn" type="submit">重置</button></div>
    <span class="help">重置后该账户的已有授权会被撤销</span>
  </form>
  <div class="dsec"><h3>危险操作</h3><div class="danger-zone">
    <div class="dz"><div class="t"><b>${disabled ? "启用账户" : "停用账户"}</b>${disabled ? "恢复登录能力；客户端需重新授权" : "禁止登录并撤销全部授权，可随时恢复"}</div>
      ${disabled
        ? postForm({ action: "/admin/auth/oauth/user/toggle", csrf: ctx.csrf, fields: { id: account.id, disabled: "false" }, label: "启用" })
        : `<a class="btn danger-o" href="${esc(tabHref({ id: account.id, confirm: "disable" }))}">停用…</a>`}</div>
    <div class="dz"><div class="t"><b>删除账户</b>永久删除，不能撤销</div><a class="btn danger-o" href="${esc(tabHref({ id: account.id, confirm: "delete" }))}">删除…</a></div>
  </div></div>
  <div class="dsec"><a href="${esc(`/admin/auth?tab=audit&q=${encodeURIComponent(model.acctName(account))}`)}" class="btn ghost sm">${ic("list")}查看此账户的审计记录</a></div>`;
  return drawer({
    title: model.acctName(account),
    subtitle: disabled ? "已停用" : "",
    closeHref: tabHref({ q: query.q }),
    bodyHtml: body,
  });
}

export function renderAccountsPage(ctx) {
  const { model, snapshot, query = {} } = ctx;
  const accounts = Array.isArray(snapshot?.oauthUsers) ? snapshot.oauthUsers : [];
  const q = String(query.q || "").trim().toLowerCase();
  const selectedId = String(query.id || "");
  const confirm = String(query.confirm || "");
  const mode = String(query.mode || "");
  const list = q
    ? accounts.filter((account) => `${account.username || ""} ${account.displayName || ""}`.toLowerCase().includes(q))
    : accounts;
  const target = accounts.find((account) => String(account.id) === selectedId) || null;

  const tableHtml = table(
    [["账户", "24%"], ["状态", "10%"], ["权限上限 · Vault", "24%"], ["已授权客户端", "16%"], ["最后登录", "14%"], ["创建", "10%"], ["", "", "act"]],
    list.map((account) => row(ctx, account, selectedId)),
    emptyState(
      "user",
      q ? "没有匹配的账户" : "还没有 OAuth 账户",
      q ? "换个关键词试试" : "创建账户后，用户即可在客户端的授权页登录",
      q ? "" : createCta("新建账户"),
    ),
  );

  const actions = createCta("新建账户");
  const staleConfirm = confirm && !target
    ? `<div class="result err" role="status">${ic("alert")}<div>该账户不存在或已删除，未执行任何操作。</div></div>`
    : "";
  const content = `${pageBar({ title: "OAuth 账户", count: accounts.length, actions })}<div class="content scroll"><div class="page">
  <p class="lede">账户用于客户端的 OAuth 同意页登录，与管理密码相互独立。</p>
  <div class="toolbar">${searchBox({ placeholder: "搜索用户名或显示名", value: query.q, hidden: { tab: TAB } })}</div>
  ${staleConfirm}${tableHtml}${mcards(list.map((account) => card(ctx, account)))}
  </div></div>`;

  let detailPanel = "";
  if (confirm === "delete" && target) {
    detailPanel = confirmPage({
      title: `删除账户「${model.acctName(target)}」？`,
      bodyHtml: "将永久删除账户并撤销其全部 Token，审计记录中的名称会显示为「已删除 / 未知」。此操作不能撤销。",
      typed: target.username,
      ok: "永久删除",
      backHref: tabHref({ id: target.id }),
      action: "/admin/auth/oauth/user/delete",
      csrf: ctx.csrf,
      fields: { id: target.id },
    });
  } else if (confirm === "disable" && target) {
    detailPanel = confirmPage({
      title: `停用「${model.acctName(target)}」？`,
      bodyHtml: `停用后该账户<b>无法登录授权页</b>，并会<b>撤销其全部已有授权</b>（${model.linkedClients(target.id).length} 个客户端需要重新授权）。之后可以重新启用。`,
      ok: "停用账户",
      backHref: tabHref({ id: target.id }),
      action: "/admin/auth/oauth/user/toggle",
      csrf: ctx.csrf,
      fields: { id: target.id, disabled: "true" },
    });
  } else if (selectedId === "new") {
    detailPanel = createDrawer(ctx);
  } else if (selectedId) {
    detailPanel = target
      ? accountDrawer(ctx, target, mode)
      : drawer({
        title: "账户不存在",
        closeHref: tabHref({ q: query.q }),
        bodyHtml: `<div class="dsec">${emptyState("user", "账户不存在或已删除", "")}</div>`,
      });
  }
  return { content, detailPanel };
}
