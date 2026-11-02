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
import { renderSubjectAuthzSection } from "../subject-authz.js";
import { readSort, sortRows } from "../table-sort.js";
import { t } from "../../i18n/context.js";

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
    { href: tabHref({ id: account.id }), label: t("adm.accounts.menu.edit"), icon: "edit" },
    { href: tabHref({ id: account.id, mode: "pw" }), label: t("adm.accounts.menu.resetPassword"), icon: "lock" },
    disabled
      ? {
        action: "/admin/auth/oauth/user/toggle",
        label: t("adm.accounts.enableAccount"),
        icon: "play",
        csrf: ctx.csrf,
        fields: { id: account.id, disabled: "false" },
      }
      : { href: tabHref({ id: account.id, confirm: "disable" }), label: t("adm.accounts.menu.disable"), icon: "pause" },
    { href: tabHref({ id: account.id, confirm: "delete" }), label: t("adm.accounts.menu.delete"), icon: "trash", danger: true },
  ]);
}

function row(ctx, account, selectedId) {
  const { model } = ctx;
  const disabled = isDisabled(account);
  const linked = model.linkedClients(account.id);
  const rowCls = [disabled ? "dim" : "", selectedId === account.id ? "cur" : ""].filter(Boolean).join(" ");
  const linkedCell = linked.length
    ? linked.map((client) => `<a href="${esc(`/admin/auth?tab=clients&id=${encodeURIComponent(client.clientId)}`)}">${esc(model.clientName(client))}</a>`).join(esc(t("adm.ui.listSeparator")))
    : `<span class="muted">—</span>`;
  const loginCell = account.lastLoginAt
    ? `${relTitle(account.lastLoginAt)} <span class="muted mono">${esc(account.lastSource || "—")}</span>`
    : `<span class="muted">${esc(t("adm.accounts.neverLoggedIn"))}</span>`;
  return `<tr${rowCls ? ` class="${rowCls}"` : ""}>
    <td>${nameCell(model, account)}</td>
    <td>${disabled ? st(esc(t("adm.accounts.status.disabled")), "off") : st(esc(t("adm.accounts.status.enabled")), "ok")}</td>
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
    <a class="cell-link block" href="${esc(tabHref({ id: account.id }))}"><div class="nm"><b>${esc(model.acctName(account))}</b><span class="sub2">${esc(account.username || "")}${disabled ? esc(t("adm.accounts.cardDisabledSuffix")) : ""}</span></div></a>
    <div class="tags">${model.scopeTags(account.allowedScopes)}${model.vaultTags(account.allowedVaults)}</div>
    <div class="meta"><span>${account.lastLoginAt ? esc(t("adm.accounts.loggedIn", { time: relTitle(account.lastLoginAt) })) : esc(t("adm.accounts.neverLoggedIn"))}</span><span>${esc(t("adm.accounts.clientCount", { count: linked.length }))}</span></div>
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
    : `<p class="help">${esc(t("adm.accounts.vaultInventoryMissing"))}</p>`;
  return { scopes: ctx.model.scopeOptions(scopes), vaults: vaultBlock };
}

function createDrawer(ctx) {
  const { scopes, vaults } = pickers(ctx, { scopes: ["obsidian.read"], vaults: (ctx.vaults || []).filter((v) => v.primary).map((v) => v.id) });
  return drawer({
    title: t("adm.accounts.newTitle"),
    closeHref: tabHref(),
    bodyHtml: `<form id="new-account" method="post" action="/admin/auth/oauth/user/create">
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <div class="dsec"><div class="grid2">
      <div class="fld"><label>${esc(t("adm.accounts.field.username"))} <small>username</small></label><input class="inp" name="username" placeholder="${esc(t("adm.accounts.field.usernamePlaceholder"))}" required><span class="help">${esc(t("adm.accounts.field.usernameHelp"))}</span></div>
      <div class="fld"><label>${esc(t("adm.accounts.field.displayName"))} <span class="muted">${esc(t("adm.accounts.optional"))}</span></label><input class="inp" name="displayName" placeholder="${esc(t("adm.accounts.field.displayNamePlaceholder"))}"></div>
    </div>
    <div class="fld" style="margin-top:12px"><label>${esc(t("adm.accounts.field.password"))}</label><input class="inp" type="password" name="password" autocomplete="new-password" placeholder="${esc(t("adm.accounts.field.passwordPlaceholder"))}"><span class="help">${esc(t("adm.accounts.field.passwordHelp"))}</span></div></div>
    <div class="dsec"><h3>${esc(t("adm.accounts.capabilities"))}</h3><div class="grid2" style="gap:0">${scopes}</div></div>
    <div class="dsec"><h3>${esc(t("adm.accounts.allowedVaults"))}</h3>${vaults}</div>
  </form>`,
    footHtml: `<span class="help"></span><a class="btn ghost" href="${esc(tabHref())}">${esc(t("adm.ui.cancel"))}</a><button class="btn primary" type="submit" form="new-account">${esc(t("adm.accounts.create"))}</button>`,
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
    ? linked.map((client) => `<a href="${esc(`/admin/auth?tab=clients&id=${encodeURIComponent(client.clientId)}`)}">${esc(model.clientName(client))}</a>`).join(esc(t("adm.ui.listSeparator")))
    : `<span class="muted">${esc(t("adm.accounts.none"))}</span>`;
  const body = `
  <div class="dsec">${kv([
    [t("adm.accounts.kv.username"), esc(account.username || "—"), 'class="mono"'],
    [t("adm.accounts.kv.displayName"), account.displayName ? esc(account.displayName) : `<span class="muted">${esc(t("adm.accounts.notSet"))}</span>`],
    [t("adm.accounts.kv.id"), model.idc(account.id, account.id)],
    [t("adm.accounts.kv.created"), esc(fmtFull(account.createdAt))],
    [t("adm.accounts.kv.lastLogin"), account.lastLoginAt ? `${esc(fmtFull(account.lastLoginAt))} <span class="muted mono">· ${esc(account.lastSource || "—")}</span>` : `<span class="muted">${esc(t("adm.accounts.neverLoggedIn"))}</span>`],
    [t("adm.accounts.kv.linkedClients"), linkedCell],
  ])}</div>
  ${renderSubjectAuthzSection(ctx, { subject: `oauth-user:${account.id}`, tab: "accounts", subjectId: account.id })}
  <form class="dsec" method="post" action="/admin/auth/oauth/user/scopes">
    <h3>${esc(t("adm.accounts.permissionsTitle"))}</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="id" value="${esc(account.id)}">
    ${pick.scopes}
    <div style="height:8px"></div>
    ${pick.vaults}
    <div class="banner amber" style="margin:12px 0 0">${ic("alert")}<div>${t("adm.accounts.revokeBanner", { total: counts.total, access: counts.access, refresh: counts.refresh, clients: counts.clients || linked.length })}</div></div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" type="submit">${esc(t("adm.accounts.savePermissions"))}</button></div>
  </form>
  <form class="dsec" method="post" action="/admin/auth/oauth/user/password">
    <h3>${esc(t("adm.accounts.resetPasswordTitle"))}</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="id" value="${esc(account.id)}">
    <div style="display:flex;gap:8px"><input class="inp grow" type="password" name="password" autocomplete="new-password" placeholder="${esc(t("adm.accounts.newPasswordPlaceholder"))}"${mode === "pw" ? " autofocus" : ""}><button class="btn" type="submit">${esc(t("adm.accounts.reset"))}</button></div>
    <span class="help">${esc(t("adm.accounts.resetPasswordHelp"))}</span>
  </form>
  <div class="dsec"><h3>${esc(t("adm.accounts.dangerTitle"))}</h3><div class="danger-zone">
    <div class="dz"><div class="t"><b>${disabled ? esc(t("adm.accounts.enableAccount")) : esc(t("adm.accounts.disableAccount"))}</b>${disabled ? esc(t("adm.accounts.enableDesc")) : esc(t("adm.accounts.disableDesc"))}</div>
      ${disabled
        ? postForm({ action: "/admin/auth/oauth/user/toggle", csrf: ctx.csrf, fields: { id: account.id, disabled: "false" }, label: t("adm.accounts.enable") })
        : `<a class="btn danger-o" href="${esc(tabHref({ id: account.id, confirm: "disable" }))}">${esc(t("adm.accounts.disableAction"))}</a>`}</div>
    <div class="dz"><div class="t"><b>${esc(t("adm.accounts.deleteAccount"))}</b>${esc(t("adm.accounts.deleteAccountDesc"))}</div><a class="btn danger-o" href="${esc(tabHref({ id: account.id, confirm: "delete" }))}">${esc(t("adm.accounts.deleteAction"))}</a></div>
  </div></div>
  <div class="dsec"><a href="${esc(`/admin/auth?tab=audit&q=${encodeURIComponent(model.acctName(account))}`)}" class="btn ghost sm">${ic("list")}${esc(t("adm.accounts.viewAudit"))}</a></div>`;
  return drawer({
    title: model.acctName(account),
    subtitle: disabled ? t("adm.accounts.status.disabled") : "",
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
  const filtered = q
    ? accounts.filter((account) => `${account.username || ""} ${account.displayName || ""}`.toLowerCase().includes(q))
    : accounts;
  // Sorting is server state (`table-sort.js`): the header link carries it, this page decides on it.
  const sort = readSort(query, ["account", "status", "capabilities", "clients", "lastLogin", "created"], "account");
  const list = sortRows(filtered, sort, {
    account: (account) => model.acctName(account),
    status: (account) => (account.disabled ? t("adm.accounts.status.disabled") : t("adm.accounts.status.enabled")),
    capabilities: (account) => (Array.isArray(account.allowedScopes) ? account.allowedScopes.length : 0),
    clients: (account) => model.linkedClients(account.id).length,
    lastLogin: (account) => account.lastLoginAt ?? null,
    created: (account) => account.createdAt ?? null,
  });
  const target = accounts.find((account) => String(account.id) === selectedId) || null;

  const tableHtml = table(
    [[t("adm.accounts.column.account"), "24%", "", "account"], [t("adm.accounts.column.status"), "10%", "", "status"], [t("adm.accounts.column.capabilities"), "24%", "", "capabilities"], [t("adm.accounts.column.clients"), "16%", "", "clients"], [t("adm.accounts.column.lastLogin"), "14%", "", "lastLogin"], [t("adm.accounts.column.created"), "10%", "", "created"], ["", "", "act"]],
    list.map((account) => row(ctx, account, selectedId)),
    emptyState(
      "user",
      q ? t("adm.accounts.emptyNoMatch") : t("adm.accounts.emptyNone"),
      q ? t("adm.accounts.emptyNoMatchHint") : t("adm.accounts.emptyNoneHint"),
      q ? "" : createCta(t("adm.accounts.new")),
    ),
    { ...sort, base: tabHref({ q: query.q }) },
  );

  const actions = createCta(t("adm.accounts.new"));
  const staleConfirm = confirm && !target
    ? `<div class="result err" role="status">${ic("alert")}<div>${esc(t("adm.accounts.staleConfirm"))}</div></div>`
    : "";
  const content = `${pageBar({ title: t("adm.nav.accounts"), count: accounts.length, actions })}<div class="content scroll"><div class="page">
  <p class="lede">${esc(t("adm.accounts.lede"))}</p>
  <div class="toolbar">${searchBox({ placeholder: t("adm.accounts.searchPlaceholder"), value: query.q, hidden: { tab: TAB } })}</div>
  ${staleConfirm}${tableHtml}${mcards(list.map((account) => card(ctx, account)))}
  </div></div>`;

  let detailPanel = "";
  if (confirm === "delete" && target) {
    detailPanel = confirmPage({
      title: t("adm.accounts.deleteConfirmTitle", { name: model.acctName(target) }),
      bodyHtml: esc(t("adm.accounts.deleteConfirmBody")),
      typed: target.username,
      ok: t("adm.accounts.deleteConfirmOk"),
      backHref: tabHref({ id: target.id }),
      action: "/admin/auth/oauth/user/delete",
      csrf: ctx.csrf,
      fields: { id: target.id },
    });
  } else if (confirm === "disable" && target) {
    detailPanel = confirmPage({
      title: t("adm.accounts.disableConfirmTitle", { name: model.acctName(target) }),
      bodyHtml: t("adm.accounts.disableConfirmBody", { clients: model.linkedClients(target.id).length }),
      ok: t("adm.accounts.disableConfirmOk"),
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
        title: t("adm.accounts.missingTitle"),
        closeHref: tabHref({ q: query.q }),
        bodyHtml: `<div class="dsec">${emptyState("user", t("adm.accounts.missingBody"), "")}</div>`,
      });
  }
  return { content, detailPanel };
}
