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
import { pageBar, emptyState, table, mcards, seg, moreMenu, confirmPage, esc, ic } from "../ui.js";
import { TOKEN_ST, statusOfToken } from "../presentation/vocab.js";
import { fmt, fmtFull, idc, rel } from "../presentation/format.js";
import { t } from "../../i18n/context.js";
import { readSort, sortRows } from "../table-sort.js";

const TAB = "tokens";
const BASE = "/admin/auth?tab=tokens";
/** Prototype `S.tokenFilter` tabs (renderTokens L279). */
const TABS = Object.freeze([["all", "adm.tokens.tab.all"], ["active", "adm.tokens.tab.active"], ["rotated", "adm.tokens.tab.rotated"], ["revoked", "adm.tokens.tab.revoked"]]);
/** Prototype cleanup modal options (6-app.js `token-cleanup`): 7 / 30 / 90 days / all inactive. */
const RETENTION = Object.freeze([[7, "adm.tokens.retention.7"], [30, "adm.tokens.retention.30"], [90, "adm.tokens.retention.90"], [0, "adm.tokens.retention.all"]]);

function href(params = {}) {
  const search = new URLSearchParams({ tab: TAB });
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  return `/admin/auth?${search.toString()}`;
}

function statusWord(item) {
  return (TOKEN_ST[item?.status] || [String(item?.status ?? t("adm.label.unknown"))])[0];
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
  const items = [{ href: `/admin/auth?tab=audit&q=${encodeURIComponent(name)}`, label: t("adm.tokens.menu.audit"), icon: "list" }];
  for (const [type, item] of [["access", grant.access], ["refresh", grant.refresh]]) {
    if (!item?.id || item.status !== "active") continue;
    items.push({
      href: href({ confirm: "token-revoke", type, id: item.id }),
      label: type === "access" ? t("adm.tokens.menu.revokeAccess") : t("adm.tokens.menu.revokeRefresh"),
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
<td><div class="nm">${tokenLine(t("adm.tokens.accessShort"), grant.access)}${tokenLine(t("adm.tokens.refreshShort"), grant.refresh)}</div></td>
<td><div class="tags">${model.scopeTags(grant.scopes)}${model.vaultTags(grant.vaults)}</div></td>
<td class="cellt">${usedAt ? `${rel(usedAt)} <span class="muted mono">${esc(grant.lastUsed?.lastSource || "—")}</span>` : `<span class="muted">${esc(t("adm.tokens.unused"))}</span>`}<div class="muted" title="${esc(fmtFull(issued))}">${esc(t("adm.tokens.issued", { time: fmt(issued) }))}</div></td>
<td>${statusOfToken(grant.status)}</td>
${ACT_CELL}${menu}</td></tr>`;
}

/** Mobile card (prototype `mcards`): client, account, primary token id, status and sign time. */
function card(ctx, grant) {
  const model = ctx.model;
  const account = grant.userId ? model.acct(grant.userId) : null;
  const primary = grant.refresh || grant.access || grant.primary;
  const issued = grant.issued?.createdAt || null;
  return `<div class="mc"><div class="b"><div class="nm"><b>${esc(model.clientName(model.client(grant.clientId)))}</b><span class="sub2">${esc(model.acctName(account))} · ${idc(primary?.id)}</span></div><div class="meta">${statusOfToken(grant.status)}<span>${esc(t("adm.tokens.issued", { time: fmt(issued) }))}</span></div></div>${grant.status === "active" ? rowMenu(grantMenuItems(ctx, grant)) : ""}</div>`;
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
  const word = type === "access" ? t("adm.tokens.accessLabel") : t("adm.tokens.refreshLabel");
  const body = item
    ? type === "access"
      ? t("adm.tokens.revokeAccessBody", { client: esc(client), account: esc(account) })
      : t("adm.tokens.revokeRefreshBody", { client: esc(client), account: esc(account) })
    : t("adm.tokens.revokeMissing");
  return confirmPage({
    title: t("adm.tokens.revokeTitle"),
    bodyHtml: body,
    listItems: [
      `${esc(t("adm.tokens.revokeCredential"))} <span class="mono">${esc(word)}</span>`,
      `${esc(t("adm.tokens.revokeTokenId"))} <span class="mono">${esc(id || "—")}</span>`,
      item ? t("adm.tokens.revokeMeta", { issued: esc(fmtFull(item.createdAt)), status: esc(statusWord(item)) }) : "",
    ].filter(Boolean),
    ok: t("adm.tokens.revokeOk"),
    action: "/admin/auth/oauth/token/revoke",
    csrf: ctx.csrf,
    fields: { type, id },
    backHref: BASE,
    // #441 is not planned: every revoke path calls `onCredentialRevoked`, which is wired to
    // `closeSessionsForClient`, so the client's live MCP sessions really do end with the grant. The
    // line states that behaviour instead of offering a disabled checkbox with a "planned" marker.
    extraHtml: `<p class="help" style="margin:0 0 8px">${esc(t("adm.tokens.disconnectSessions"))}</p>`,
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
  const chosen = t(RETENTION.find(([value]) => value === days)[1]);
  const other = RETENTION.filter(([value]) => value !== days)
    .map(([value, labelKey]) => `<a href="${esc(href({ confirm: "token-cleanup", days: value }))}">${esc(t(labelKey))}</a>`)
    .join(" · ");
  const inactive = ctx.grants.filter((grant) => grant.status !== "active").length;
  return confirmPage({
    title: t("adm.tokens.cleanupTitle"),
    bodyHtml: t("adm.tokens.cleanupBody"),
    listItems: [esc(t("adm.tokens.cleanupInactive", { count: inactive }))],
    ok: t("adm.tokens.cleanupOk"),
    action: "/admin/auth/oauth/token/cleanup",
    csrf: ctx.csrf,
    fields: { olderThanDays: String(days) },
    backHref: BASE,
    extraHtml: `<div class="fld"><label>${esc(t("adm.tokens.cleanupRange"))}</label><div class="l mono">${esc(chosen)}</div><div class="help">${esc(t("adm.tokens.cleanupChange"))} ${other}</div></div>`,
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
  const filtered = filter === "all" ? grants : grants.filter((grant) => grant.status === filter);
  // Two orders live here and they must not fight: the toolbar's 签发顺序 select owns `order` when no
  // column is chosen, and a column header owns it once one is (the same URL parameter, so the select
  // and the header always agree about direction).
  const sort = readSort(query, ["client", "token", "scopes", "used", "status"], null, order);
  const listed = sort.key
    ? sortRows(filtered, sort, {
      client: (grant) => model.clientName(model.client(grant.clientId)),
      token: (grant) => grant.refresh?.id || grant.access?.id || null,
      scopes: (grant) => (Array.isArray(grant.scopes) ? grant.scopes.length : 0),
      used: (grant) => grant.lastUsedAt ?? grant.issued?.createdAt ?? null,
      status: (grant) => statusWord(grant),
    })
    : filtered
      .slice()
      .sort((left, right) => (order === "asc" ? 1 : -1) * (Date.parse(left.issued?.createdAt || 0) - Date.parse(right.issued?.createdAt || 0)));

  const origins = [...new Set(grants.map((grant) => grant.connectionOrigin).filter(Boolean))];
  const bound = origins.length
    ? origins.map((origin) => `<span class="mono">${esc(origin)}</span>`).join("、")
    : `<span class="muted">${esc(t("adm.tokens.boundMissing"))}</span>`;

  const tabItems = TABS.map(([key, labelKey]) => ({ label: t(labelKey), count: counts[key], href: href({ status: key === "all" ? "" : key, order }), on: filter === key }));
  // Q11 同类排查的结论：这个按钮**不**收起。它的 `select` 属于 GET 工具栏，拖拽列表的原地切换（`admin-feature-lists`）
  // 已经在 change 时用 pushState 换掉 `.content`；再叠一层“隐藏按钮 + data-autosubmit”就会在同一个 change 上
  // 再发一次真实 GET（整页重载），比它替换的行为更差。按钮留着是诚实的兼底控制，也是无脚本时唯一能排序的路径。
  const sortForm = `<form class="inline-form" method="get" action="/admin/auth">
<input type="hidden" name="tab" value="${TAB}">
${filter === "all" ? "" : `<input type="hidden" name="status" value="${esc(filter)}">`}
<select class="sel sm" name="order" aria-label="${esc(t("adm.tokens.sortLabel"))}" title="${esc(t("adm.tokens.sortLabel"))}"><option value="desc"${order === "desc" ? " selected" : ""}>${esc(t("adm.tokens.sort.desc"))}</option><option value="asc"${order === "asc" ? " selected" : ""}>${esc(t("adm.tokens.sort.asc"))}</option></select>
<button class="btn ghost sm" type="submit">${esc(t("adm.tokens.sortApply"))}</button></form>`;

  const actions = `<a class="btn" href="${esc(href({ confirm: "token-cleanup", days: 30 }))}">${ic("trash")}<span class="hide-m">${esc(t("adm.tokens.cleanupAction"))}</span></a>`;
  const content = `${pageBar({ title: t("adm.nav.tokens"), count: listed.length, actions })}<div class="content scroll"><div class="page">
<p class="lede">${esc(t("adm.tokens.lede"))}${bound}</p>
<div class="toolbar">${seg(tabItems)}<span class="grow"></span>${sortForm}</div>
${table([[t("adm.tokens.column.client"), "22%", "", "client"], [t("adm.tokens.column.token"), "22%", "", "token"], [t("adm.tokens.column.scopes"), "22%", "", "scopes"], [t("adm.tokens.column.used"), "18%", "", "used"], [t("adm.tokens.column.status"), "10%", "", "status"], ["", "", "act"]], listed.map((grant, index) => row(ctx, grant, { index, rows: listed.length })), emptyState("ticket", t("adm.tokens.emptyTitle"), t("adm.tokens.emptyHint")), { ...sort, base: href({ status: filter === "all" ? "" : filter, order }) })}${mcards(listed.map((grant) => card(ctx, grant)))}
</div></div>`;
  return { content, detailPanel: confirm(ctx) };
}
