// OAuth Token — port of `docs/admin-ui-proto/src/5-render.js` `renderTokens()` (L250–L280) onto
// real data: one row per *grant* (`catalog.js` merges the access/refresh pair through
// `grants.js`), status tabs with counts, sign-time sort, the header `清理历史记录…` action and the
// per-row revoke menu.
//
// No-JS notes (contract D0): the prototype's segment control, sort `<select>`, row menu and
// confirm dialogs are scripted. Here they are server state — the tabs are GET links, the sort is a
// GET form with a submit button, the row menu is `<details>`, and each danger action is its own
// `?confirm=` page that POSTs the router's existing endpoint with `csrf`. Nothing is rendered that
// would need script; the prototype's "复制刷新 Token ID" item is dropped because a copy button
// cannot work without script (the full id stays readable: `idc()` carries it in `title`, and the
// row shows every id).
import { pageBar, emptyState, table, mcards, seg, moreMenu, confirmPage, esc, fut, ic } from "../ui.js";
import { TOKEN_ST, statusOfToken } from "../presentation/vocab.js";
import { fmt, fmtFull, idc, rel } from "../presentation/format.js";

const TAB = "tokens";
const BASE = "/admin/auth?tab=tokens";
/** Prototype `S.tokenFilter` tabs (renderTokens L279). */
const TABS = Object.freeze([["all", "全部"], ["active", "有效"], ["rotated", "已轮换"], ["revoked", "已撤销"]]);
/** Prototype cleanup modal options (6-app.js `token-cleanup`): 7 / 30 / 90 days / all inactive. */
const RETENTION = Object.freeze([[7, "早于 7 天"], [30, "早于 30 天"], [90, "早于 90 天"], [0, "全部非活动记录"]]);

function href(params = {}) {
  const search = new URLSearchParams({ tab: TAB });
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  return `/admin/auth?${search.toString()}`;
}

function statusWord(item) {
  return (TOKEN_ST[item?.status] || [String(item?.status ?? "未知")])[0];
}

/** Prototype `访问 ${idc(acc.id)} ${status}` / `刷新 ${idc(ref.id)}` inner cells. */
function tokenLine(label, item) {
  if (!item) return `<span class="cellt">${label} <span class="muted">—</span></span>`;
  const word = item.status === "active" ? "" : ` <span class="muted">${esc(statusWord(item))}</span>`;
  return `<span class="cellt">${label} ${idc(item.id)}${word}</span>`;
}

/**
 * Row menu for a table cell. `ui.moreMenu` renders the prototype's `<details class="mn">` +
 * `.menu` panel, but two shared rules clip an overlay that leaves its cell: the prototype's
 * `.tbl td{overflow:hidden}` (a panel anchored inside `.act` is cut to that 48px column) and
 * `assets/ssr-css.js`'s `.tw{overflow-x:auto}` (anything leaving the table box is cut on both axes).
 * The action cell is therefore put back to `overflow:visible`, and the panel opens on whichever side
 * of the row it fits on. Both are inline overrides of shared files this lane does not own — they go
 * away once `ui.moreMenu` / `.tw` anchor the panel themselves (see CHECKPOINT.md).
 */
function rowMenu(items, { up = false } = {}) {
  const menu = moreMenu(items);
  if (!up) return menu;
  return menu.replace('<div class="menu" role="menu">', '<div class="menu" role="menu" style="top:auto;bottom:calc(100% + 4px)">');
}

/** The action cell — `overflow:visible` is what lets the menu panel escape the 48px column. */
const ACT_CELL = '<td class="act" style="overflow:visible">';

/** Measured geometry behind the fit check: `.tbl` row ≈62px, `.tbl th` = 36px, `.menu` item = 32px. */
const ROW_H = 62;
const HEAD_H = 36;

/** Open upwards only when downwards cannot hold the panel and upwards has more room. */
function openUpwards(index, rows, items) {
  const need = items * 32 + 16;
  const below = (rows - index - 1) * ROW_H;
  const above = index * ROW_H + HEAD_H;
  return below < need && above > below;
}

/** Menu entries: audit link + one revoke entry per token that is still revocable. */
function grantMenuItems(ctx, grant) {
  const name = ctx.model.clientName(ctx.model.client(grant.clientId));
  const items = [{ href: `/admin/auth?tab=audit&q=${encodeURIComponent(name)}`, label: "查看相关审计", icon: "list" }];
  for (const [type, item] of [["access", grant.access], ["refresh", grant.refresh]]) {
    if (!item?.id || item.status !== "active") continue;
    items.push({
      href: href({ confirm: "token-revoke", type, id: item.id }),
      label: type === "access" ? "撤销访问 Token…" : "撤销刷新 Token…",
      icon: "ban",
      danger: true,
    });
  }
  return items;
}

function row(ctx, grant, { index = 0, rows = 1 } = {}) {
  const model = ctx.model;
  const account = grant.userId ? model.acct(grant.userId) : null;
  const usedAt = grant.lastUsed?.lastUsedAt || null;
  const issued = grant.issued?.createdAt || null;
  const items = grant.status === "active" ? grantMenuItems(ctx, grant) : [];
  const menu = items.length ? rowMenu(items, { up: openUpwards(index, rows, items.length) }) : "";
  return `<tr class="${grant.status === "active" ? "" : "dim"}">
<td><div class="nm"><b>${esc(model.clientName(model.client(grant.clientId)))}</b><span class="sub2">${esc(model.acctName(account))}</span></div></td>
<td><div class="nm">${tokenLine("访问", grant.access)}${tokenLine("刷新", grant.refresh)}</div></td>
<td><div class="tags">${model.scopeTags(grant.scopes)}${model.vaultTags(grant.vaults)}</div></td>
<td class="cellt">${usedAt ? `${rel(usedAt)} <span class="muted mono">${esc(grant.lastUsed?.lastSource || "—")}</span>` : `<span class="muted">未使用</span>`}<div class="muted" title="${esc(fmtFull(issued))}">签发 ${esc(fmt(issued))}</div></td>
<td>${statusOfToken(grant.status)}</td>
${ACT_CELL}${menu}</td></tr>`;
}

/** Mobile card (prototype `mcards`): client, account, primary token id, status and sign time. */
function card(ctx, grant) {
  const model = ctx.model;
  const account = grant.userId ? model.acct(grant.userId) : null;
  const primary = grant.refresh || grant.access || grant.primary;
  const issued = grant.issued?.createdAt || null;
  return `<div class="mc"><div class="b"><div class="nm"><b>${esc(model.clientName(model.client(grant.clientId)))}</b><span class="sub2">${esc(model.acctName(account))} · ${idc(primary?.id)}</span></div><div class="meta">${statusOfToken(grant.status)}<span>签发 ${esc(fmt(issued))}</span></div></div>${grant.status === "active" ? rowMenu(grantMenuItems(ctx, grant)) : ""}</div>`;
}

/**
 * Confirmation pages (`?confirm=…`). The prototype revokes a whole grant in one dialog; the
 * router only exposes `POST /oauth/token/revoke {type,id}` (per record), so each token gets its own
 * entry and the dialog states exactly which credential dies and which one survives.
 */
function confirmTokenRevoke(ctx, query) {
  const type = String(query.type || "") === "refresh" ? "refresh" : "access";
  const id = String(query.id || "");
  const grant = ctx.grants.find((item) => item.access?.id === id || item.refresh?.id === id) || null;
  const item = grant ? (type === "refresh" ? grant.refresh : grant.access) : null;
  const client = grant ? ctx.model.clientName(ctx.model.client(grant.clientId)) : "—";
  const account = grant?.userId ? ctx.model.acctName(ctx.model.acct(grant.userId)) : "—";
  const word = type === "access" ? "访问 Token" : "刷新 Token";
  const body = item
    ? type === "access"
      ? `<b>${esc(client)}</b> 以 <b>${esc(account)}</b> 身份的访问 Token 将立即失效；该授权的刷新 Token 仍然有效，客户端可以用它换取新的访问 Token（若目标是彻底终止授权，请同时撤销刷新 Token）。`
      : `<b>${esc(client)}</b> 以 <b>${esc(account)}</b> 身份的刷新 Token 将立即失效，客户端需要重新授权；已签发的访问 Token 在其到期前仍然有效。`
    : "该 Token 记录已不存在，撤销只会返回空结果。";
  return confirmPage({
    title: "撤销此授权？",
    bodyHtml: body,
    listItems: [
      `凭据：<span class="mono">${esc(word)}</span>`,
      `Token ID：<span class="mono">${esc(id || "—")}</span>`,
      item ? `签发：${esc(fmtFull(item.createdAt))} · 状态：${esc(statusWord(item))}` : "",
    ].filter(Boolean),
    ok: "撤销",
    action: "/admin/auth/oauth/token/revoke",
    csrf: ctx.csrf,
    fields: { type, id },
    backHref: BASE,
    extraHtml: `<label class="chk futonly" style="margin:0 -8px 8px"><input type="checkbox" checked disabled><span>同时断开该客户端的在线 MCP 会话 ${fut("#441")}</span></label>`,
  });
}

/**
 * `清理历史记录…` (prototype 6-app.js `token-cleanup`): the retention choice is the `days` query
 * parameter — `ui.confirmPage` renders `extraHtml` outside its own form, so a named `<select>`
 * could not be submitted; four GET links keep every prototype option reachable in one click.
 */
function confirmTokenCleanup(ctx, query) {
  const asked = Number(query.days);
  const days = RETENTION.some(([value]) => value === asked) ? asked : 30;
  const chosen = RETENTION.find(([value]) => value === days)[1];
  const other = RETENTION.filter(([value]) => value !== days)
    .map(([value, label]) => `<a href="${esc(href({ confirm: "token-cleanup", days: value }))}">${esc(label)}</a>`)
    .join(" · ");
  const inactive = ctx.grants.filter((grant) => grant.status !== "active").length;
  return confirmPage({
    title: "清理历史 Token 记录",
    bodyHtml: "只删除已撤销、已过期或已轮换的记录，<b>有效 Token 不受影响</b>。",
    listItems: [`当前有 ${esc(String(inactive))} 条授权不在「有效」状态。`],
    ok: "清理",
    action: "/admin/auth/oauth/token/cleanup",
    csrf: ctx.csrf,
    fields: { olderThanDays: String(days) },
    backHref: BASE,
    extraHtml: `<div class="fld"><label>清理范围</label><div class="l mono">${esc(chosen)}</div><div class="help">改为：${other}</div></div>`,
  });
}

function confirm(ctx) {
  const kind = String(ctx.query?.confirm || "");
  if (kind === "token-revoke") return confirmTokenRevoke(ctx, ctx.query || {});
  if (kind === "token-cleanup") return confirmTokenCleanup(ctx, ctx.query || {});
  return "";
}

export function renderTokensPage(ctx) {
  const model = ctx.model;
  const query = ctx.query || {};
  const grants = Array.isArray(ctx.grants) ? ctx.grants : [];
  const filter = TABS.some(([key]) => key === String(query.status || "")) ? String(query.status) : "all";
  const order = String(query.order || "") === "asc" ? "asc" : "desc";

  const counts = { all: grants.length, active: 0, rotated: 0, revoked: 0 };
  for (const grant of grants) if (counts[grant.status] !== undefined) counts[grant.status] += 1;
  const listed = (filter === "all" ? grants : grants.filter((grant) => grant.status === filter))
    .slice()
    .sort((left, right) => (order === "asc" ? 1 : -1) * (Date.parse(left.issued?.createdAt || 0) - Date.parse(right.issued?.createdAt || 0)));

  const origins = [...new Set(grants.map((grant) => grant.connectionOrigin).filter(Boolean))];
  const bound = origins.length
    ? origins.map((origin) => `<span class="mono">${esc(origin)}</span>`).join("、")
    : '<span class="muted">未提供</span>';

  const tabItems = TABS.map(([key, label]) => ({ label, count: counts[key], href: href({ status: key === "all" ? "" : key, order }), on: filter === key }));
  // Q11 同类排查的结论：这个按钮**不**收起。它的 `select` 属于 GET 工具栏，拖拽列表的原地切换（`admin-feature-lists`）
  // 已经在 change 时用 pushState 换掉 `.content`；再叠一层“隐藏按钮 + data-autosubmit”就会在同一个 change 上
  // 再发一次真实 GET（整页重载），比它替换的行为更差。按钮留着是诚实的兼底控制，也是无脚本时唯一能排序的路径。
  const sortForm = `<form class="inline-form" method="get" action="/admin/auth">
<input type="hidden" name="tab" value="${TAB}">
${filter === "all" ? "" : `<input type="hidden" name="status" value="${esc(filter)}">`}
<select class="sel sm" name="order" aria-label="排序" title="排序"><option value="desc"${order === "desc" ? " selected" : ""}>签发时间：从新到旧</option><option value="asc"${order === "asc" ? " selected" : ""}>签发时间：从旧到新</option></select>
<button class="btn ghost sm" type="submit">排序</button></form>`;

  const actions = `<a class="btn" href="${esc(href({ confirm: "token-cleanup", days: 30 }))}">${ic("trash")}<span class="hide-m">清理历史记录…</span></a>`;
  const content = `${pageBar({ title: "OAuth Token", count: listed.length, actions })}<div class="content scroll"><div class="page">
<p class="lede">一次授权（grant）包含访问 Token 与刷新 Token，按授权合并为一行。绑定域名：${bound}（来自 Token 的 resource）。</p>
<div class="toolbar">${seg(tabItems)}<span class="grow"></span>${sortForm}</div>
${table([["客户端 · 账户", "22%"], ["Token（短 ID）", "22%"], ["权限 · Vault", "22%"], ["最后使用 · 签发", "18%"], ["状态", "10%"], ["", "", "act"]], listed.map((grant, index) => row(ctx, grant, { index, rows: listed.length })), emptyState("ticket", "没有该状态的 Token", "切换上方筛选查看其他记录"))}${mcards(listed.map((grant) => card(ctx, grant)))}
</div></div>`;
  return { content, detailPanel: confirm(ctx) };
}
