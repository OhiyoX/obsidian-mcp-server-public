// OAuth 客户端 — greenfield SSR port of the prototype page.
//   markup : docs/admin-ui-proto/src/5-render.js  renderClients()             (228–250)
//   states : docs/admin-ui-proto/src/6-app.js     drawerHtml() "client"       (248–256)
//                                                 drawerHtml() "transfer"     (254)
//                                                 menuItems()  "client"       (136)
//                                                 revokeClient()              (166)
//   rules  : docs/admin-ui-proto/README.md 「OAuth 客户端」功能对照表 + docs/admin/README.md
//
// No script (CSP `default-src 'none'`, D0 HOLD). Deliberate deviations, all in the lane CHECKPOINT:
//   * the callback rows carry no copy button (superseded by the SSR rule that no affordance needing
//     script is rendered; the URI is selectable text with the full value in `title`);
//   * begin-transfer is a two-step no-JS flow: the drawer form is a GET form that submits
//     `?confirm=transfer&sourceUserId=…&targetUserId=…` and the confirm page POSTs the real route;
//   * the ⋯ menu cannot draw the prototype's `<hr>` separator.
//
// Transfer state is read from `ctx.transfers` (the real `authorizationTransferSnapshot`, #364), not
// from a field on the client. A `pending` record whose `expiresAt` has passed without a persisted
// expiry is reported as exactly that (auth-center-transfer-view §11.5) and never as a live pending;
// a cancel never claims to restore the source account's revoked credentials.
import { pageBar, searchBox, table, mcards, emptyState, moreMenu, drawer, confirmPage, kv, banner } from "../ui.js";
import { esc, fmtFull, fut, relTitle } from "../presentation/format.js";
import { ic } from "../assets/icons.js";
import { isUnpersistedExpiry, pendingTransfersFor, transferAccountLabel } from "../auth-center-transfer-view.js";
import { renderDefaultVaultPicker } from "../default-vault-picker.js";
import { renderSubjectAuthzSection } from "../subject-authz.js";
import { readSort, sortRows } from "../table-sort.js";
import { t } from "../../i18n/context.js";

const TAB = "clients";

/** `#/clients[/<clientId>]` + modals, kept as query state (`?tab=clients&id=…`). */
function tabHref({ id = null, confirm = null, mode = null, q = null } = {}) {
  const parts = [`tab=${TAB}`];
  if (q) parts.push(`q=${encodeURIComponent(q)}`);
  if (id) parts.push(`id=${encodeURIComponent(id)}`);
  if (confirm) parts.push(`confirm=${encodeURIComponent(confirm)}`);
  if (mode) parts.push(`mode=${encodeURIComponent(mode)}`);
  return `/admin/auth?${parts.join("&")}`;
}

const accountHref = (id) => `/admin/auth?tab=accounts&id=${encodeURIComponent(id)}`;

function isDisabled(account) {
  return Boolean(account?.disabledAt || account?.disabled === true || account?.enabled === false);
}

function hostOf(origin) {
  try {
    return new URL(origin).host || String(origin);
  } catch {
    return String(origin || "");
  }
}

/**
 * Connection domains, with the source of each host taken from the fields the provider actually
 * writes (`registeredOrigin` / `lastRequestedOrigin` / `lastAuthorizedOrigin` / `lastConnectionOrigin`
 * — `oauth-provider.js authorizationSnapshot`). A host no role field explains is kept, and labelled
 * as unrecorded rather than guessed from the redirect URI.
 */
function domainsOf(client) {
  const origins = Array.isArray(client.connectionOrigins) ? [...client.connectionOrigins] : [];
  for (const extra of [client.registeredOrigin, client.lastRequestedOrigin, client.lastAuthorizedOrigin, client.lastConnectionOrigin]) {
    if (extra && !origins.includes(extra)) origins.push(extra);
  }
  return origins.map((origin) => {
    const labels = [];
    if (origin === client.registeredOrigin) labels.push(t("adm.clients.domain.registered"));
    if (origin === client.lastRequestedOrigin && origin !== client.lastAuthorizedOrigin && origin !== client.lastConnectionOrigin) labels.push(t("adm.clients.domain.requested"));
    if (origin === client.lastAuthorizedOrigin) labels.push(t("adm.clients.domain.authorized"));
    if (origin === client.lastConnectionOrigin) labels.push(t("adm.clients.domain.called"));
    return { origin, host: hostOf(origin), labels };
  });
}

function pendingFor(ctx, clientId) {
  return pendingTransfersFor(clientId, ctx.transfers);
}

/** The list cell's amber addendum — live pending and unpersisted expiry are different states. */
function pendingCell(ctx, clientId) {
  return pendingFor(ctx, clientId).map((transfer) => {
    const target = transferAccountLabel(ctx.snapshot, transfer.targetUserId);
    if (isUnpersistedExpiry(transfer, ctx.now)) {
      return `<div><span class="tag amber" title="${esc(t("adm.clients.transfer.expiredTitle"))}">${esc(t("adm.clients.transfer.expired", { target }))}</span></div>`;
    }
    return `<div><span class="tag amber" title="${esc(t("adm.clients.transfer.pendingTitle"))}">${esc(t("adm.clients.transfer.pending", { target }))}</span></div>`;
  }).join("");
}

function nameCell(model, client) {
  const named = Boolean(String(client.clientName || "").trim());
  return `<a class="cell-link block" href="${esc(tabHref({ id: client.clientId }))}"><div class="nm"><b${named ? "" : ' style="font-style:italic;font-weight:400;color:var(--tx2)"'}>${esc(model.clientName(client))}</b><span class="sub2">${model.idc(client.clientId)}</span></div></a>`;
}

function menu(ctx, client) {
  const pending = pendingFor(ctx, client.clientId);
  const linked = ctx.model.linkedAccounts(client.clientId);
  const items = [
    { href: tabHref({ id: client.clientId }), label: t("adm.clients.menu.view"), icon: "eye" },
    { href: tabHref({ id: client.clientId, mode: "transfer" }), label: t("adm.clients.menu.transfer"), icon: "swap" },
  ];
  if (pending.length) {
    items.push({
      href: tabHref({ id: client.clientId, confirm: `cancel-transfer:${pending[0].id}` }),
      label: t("adm.clients.menu.cancelTransfer"),
      icon: "x",
    });
  }
  // The prototype disables 撤销全部授权 when no account is linked; a menu cannot render a
  // disabled entry, so the item is omitted instead of leading to a no-op confirm.
  if (linked.length) items.push({ href: tabHref({ id: client.clientId, confirm: "revoke" }), label: t("adm.clients.menu.revokeAll"), icon: "ban", danger: true });
  items.push({ href: tabHref({ id: client.clientId, confirm: "delete" }), label: t("adm.clients.menu.delete"), icon: "trash", danger: true });
  return moreMenu(items);
}

function row(ctx, client, selectedId) {
  const { model } = ctx;
  const linked = model.linkedAccounts(client.clientId);
  const linkedCell = linked.length
    ? linked.map((account) => `<a href="${esc(accountHref(account.id))}">${esc(model.acctName(account))}</a>`).join(esc(t("adm.ui.listSeparator")))
    : `<span class="muted">${esc(t("adm.clients.noGrants"))}</span>`;
  const domains = domainsOf(client);
  const domainCell = domains.length
    ? domains.map((domain) => `<span title="${esc(t("adm.clients.domainSource", { labels: domain.labels.join(t("adm.ui.listSeparator")) || t("adm.clients.unrecorded") }))}">${esc(domain.host)}</span>`).join("")
    : `<span class="muted">—</span>`;
  const lastCell = client.lastUsedAt
    ? `${relTitle(client.lastUsedAt)} <span class="muted mono">${esc(client.lastSource || "—")}</span>`
    : `<span class="muted">${esc(t("adm.clients.neverUsed"))}</span>`;
  const uris = Array.isArray(client.redirectUris) ? client.redirectUris : [];
  const redirectCell = uris.length
    ? `<span title="${esc(uris.join("\n"))}">${esc(String(uris[0]).replace(/^https?:\/\//, ""))}</span>${uris.length > 1 ? ` <span class="tag">+${uris.length - 1}</span>` : ""}`
    : `<span class="muted">—</span>`;
  return `<tr${selectedId === client.clientId ? ' class="cur"' : ""}>
    <td>${nameCell(model, client)}</td>
    <td class="cellt">${linkedCell}${pendingCell(ctx, client.clientId)}</td>
    <td class="cellt">${domainCell}</td>
    <td class="cellt">${lastCell}</td>
    <td class="cellt mono muted">${redirectCell}</td>
    <td class="act">${menu(ctx, client)}</td></tr>`;
}

function card(ctx, client) {
  const { model } = ctx;
  const linked = model.linkedAccounts(client.clientId);
  const sub = linked.map((account) => model.acctName(account)).join(t("adm.ui.listSeparator")) || t("adm.clients.noGrants");
  const pending = pendingFor(ctx, client.clientId);
  return `<div class="mc"><div class="b">
    <a class="cell-link block" href="${esc(tabHref({ id: client.clientId }))}"><div class="nm"><b>${esc(model.clientName(client))}</b><span class="sub2">${esc(sub)}</span></div></a>
    ${pending.length ? `<span><span class="tag amber">${esc(t("adm.clients.transfer.pending", { target: transferAccountLabel(ctx.snapshot, pending[0].targetUserId) }))}</span></span>` : ""}
    <div class="meta"><span>${client.lastUsedAt ? esc(t("adm.clients.usedAt", { time: relTitle(client.lastUsedAt) })) : esc(t("adm.clients.neverUsed"))}</span></div>
  </div>${menu(ctx, client)}</div>`;
}

function transferBanner(ctx, transfer) {
  const from = transferAccountLabel(ctx.snapshot, transfer.sourceUserId);
  const to = transferAccountLabel(ctx.snapshot, transfer.targetUserId);
  const cancel = `<form class="inline-form" method="post" action="/admin/auth/oauth/client/transfer/cancel"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="transferId" value="${esc(transfer.id)}"><button class="btn sm" type="submit">${esc(t("adm.clients.transfer.cancelButton"))}</button></form>`;
  const head = isUnpersistedExpiry(transfer, ctx.now)
    ? t("adm.clients.transfer.bannerExpired", { at: relTitle(transfer.createdAt), from: esc(from), to: esc(to) })
    : t("adm.clients.transfer.bannerPending", { at: relTitle(transfer.createdAt), from: esc(from), to: esc(to) });
  return banner(`${head}<div style="margin-top:8px">${cancel}</div><div class="help">${esc(t("adm.clients.transfer.cancelHelp"))}</div>`, { tone: "amber", icon: "swap" });
}

function transferForm(ctx, client) {
  const { model, query } = ctx;
  const accounts = Array.isArray(ctx.snapshot?.oauthUsers) ? ctx.snapshot.oauthUsers : [];
  const linked = model.linkedAccounts(client.clientId);
  const pending = pendingFor(ctx, client.clientId);
  const linkedIds = new Set(linked.map((account) => account.id));
  const pendingSources = new Set(pending.map((transfer) => String(transfer.sourceUserId)));
  const sources = linked.filter((account) => !pendingSources.has(String(account.id)));
  const targets = accounts.filter((account) => !isDisabled(account) && !linkedIds.has(account.id));
  const blocked = pending.length > 0 || !linked.length;
  const sourceOptions = sources.length
    ? `${sources.length > 1 ? `<option value="">${esc(t("adm.clients.transfer.chooseSource"))}</option>` : ""}${sources.map((account) => `<option value="${esc(account.id)}">${esc(model.acctName(account))}（${esc(account.username || "")}）</option>`).join("")}`
    : `<option value="">${esc(t("adm.clients.noGrants"))}</option>`;
  const targetOptions = `${targets.length ? `<option value="">${esc(t("adm.clients.transfer.chooseTarget"))}</option>` : `<option value="">${esc(t("adm.clients.transfer.noTargets"))}</option>`}${targets.map((account) => `<option value="${esc(account.id)}">${esc(model.acctName(account))}（${esc(account.username || "")}）</option>`).join("")}${accounts.filter(isDisabled).map((account) => `<option disabled>${esc(model.acctName(account))} ${esc(t("adm.clients.disabledSuffix"))}</option>`).join("")}`;
  const hint = pending.length
    ? `<span class="help">${esc(t("adm.clients.transfer.hintPending"))}</span>`
    : !linked.length
      ? `<span class="help">${esc(t("adm.clients.transfer.hintNoGrants"))}</span>`
      : !targets.length
        ? `<span class="help">${esc(t("adm.clients.transfer.hintNoTargets"))}</span>`
        : "";
  return `<form class="dsec" method="get" action="/admin/auth">
    <h3>${esc(t("adm.clients.transfer.title"))}</h3>
    <input type="hidden" name="tab" value="${TAB}">
    <input type="hidden" name="id" value="${esc(client.clientId)}">
    <input type="hidden" name="confirm" value="transfer">
    <p class="help" style="margin:0 0 8px">${esc(t("adm.clients.transfer.description"))}</p>
    <div class="grid2">
      <div class="fld"><label>${esc(t("adm.clients.transfer.from"))}</label><select class="sel" name="sourceUserId"${blocked || !sources.length ? " disabled" : ""}>${sourceOptions}</select></div>
      <div class="fld"><label>${esc(t("adm.clients.transfer.to"))}</label><select class="sel" name="targetUserId"${blocked || !targets.length ? " disabled" : ""}${query.mode === "transfer" && !blocked ? " autofocus" : ""}>${targetOptions}</select></div>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
      <button class="btn" type="submit"${blocked || !targets.length ? " disabled" : ""}>${ic("swap")}${esc(t("adm.clients.transfer.start"))}</button>${hint}
    </div>
    <div class="futonly futbox" style="margin-top:12px"><label class="chk" style="margin:-6px -8px"><input type="checkbox" disabled><span>${esc(t("adm.clients.transfer.directGrant"))} ${fut(t("adm.clients.transfer.pendingTicket"))}</span></label></div>
  </form>`;
}

function clientDrawer(ctx, client) {
  const { model, query } = ctx;
  const linked = model.linkedAccounts(client.clientId);
  const domains = domainsOf(client);
  const uris = Array.isArray(client.redirectUris) ? client.redirectUris : [];
  const linkedCell = linked.length
    ? linked.map((account) => `<a href="${esc(accountHref(account.id))}">${esc(model.acctName(account))}</a>`).join(esc(t("adm.ui.listSeparator")))
    : `<span class="muted">${esc(t("adm.clients.noGrants"))}</span>`;
  const domainCell = domains.length
    ? domains.map((domain) => `${esc(domain.host)} <span class="muted">· ${esc(t("adm.clients.domainSourceInline", { labels: domain.labels.join(" / ") || t("adm.clients.unrecorded") }))}</span>`).join("<br>")
    : `<span class="muted">${esc(t("adm.clients.noneYet"))}</span>`;
  const callbacks = uris.length
    ? `<div class="list">${uris.map((uri) => `<div class="li"><span class="mono ell grow" title="${esc(uri)}">${esc(uri)}</span></div>`).join("")}</div>`
    : `<span class="muted">${esc(t("adm.accounts.none"))}</span>`;
  const body = `
  ${pendingFor(ctx, client.clientId).map((transfer) => transferBanner(ctx, transfer)).join("")}
  <div class="dsec">${kv([
    [t("adm.clients.kv.id"), model.idc(client.clientId, client.clientId)],
    [t("adm.clients.kv.accounts"), linkedCell],
    [t("adm.clients.kv.domains"), domainCell],
    [t("adm.clients.kv.registered"), esc(fmtFull(client.createdAt))],
    [t("adm.clients.kv.lastUsed"), client.lastUsedAt ? `${esc(fmtFull(client.lastUsedAt))} <span class="muted mono">· ${esc(client.lastSource || "—")}</span>` : `<span class="muted">${esc(t("adm.clients.neverUsed"))}</span>`],
  ])}</div>
  ${renderSubjectAuthzSection(ctx, { subject: `oauth-client:${client.clientId}` })}
  <div class="dsec"><h3>${esc(t("adm.clients.callbacks", { count: uris.length }))}</h3>${callbacks}<span class="help">${esc(t("adm.clients.callbacksHelp"))}</span></div>
  <form class="dsec" method="post" action="/admin/auth/oauth/client/default-vault">
    <h3>${esc(t("adm.keys.defaultVault"))}</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="clientId" value="${esc(client.clientId)}">
    ${renderDefaultVaultPicker(ctx, {
      current: client.defaultVaultId,
      allowedVaults: (ctx.snapshot?.tokens || []).filter((token) => token.clientId === client.clientId && token.status === "active").flatMap((token) => token.allowedVaults || []),
    })}
    <div style="margin-top:12px"><button class="btn primary" type="submit">${esc(t("adm.keys.saveDefaultVault"))}</button></div>
  </form>
  ${transferForm(ctx, client)}
  <div class="dsec"><h3>${esc(t("adm.accounts.dangerTitle"))}</h3><div class="danger-zone">
    <div class="dz"><div class="t"><b>${esc(t("adm.clients.revokeAll"))}</b>${esc(t("adm.clients.revokeAllDesc"))}</div>${linked.length
      ? `<a class="btn danger-o" href="${esc(tabHref({ id: client.clientId, confirm: "revoke" }))}">${esc(t("adm.clients.revokeAction"))}</a>`
      : `<button class="btn danger-o" type="button" disabled>${esc(t("adm.clients.revokeAction"))}</button>`}</div>
    <div class="dz"><div class="t"><b>${esc(t("adm.clients.deleteClient"))}</b>${esc(t("adm.clients.deleteClientDesc"))}</div><a class="btn danger-o" href="${esc(tabHref({ id: client.clientId, confirm: "delete" }))}">${esc(t("adm.accounts.deleteAction"))}</a></div>
  </div></div>`;
  return drawer({
    title: model.clientName(client),
    closeHref: tabHref({ q: query.q }),
    bodyHtml: body,
  });
}

export function renderClientsPage(ctx) {
  const { model, snapshot, query = {} } = ctx;
  const clients = Array.isArray(snapshot?.clients) ? snapshot.clients : [];
  const accounts = Array.isArray(snapshot?.oauthUsers) ? snapshot.oauthUsers : [];
  const q = String(query.q || "").trim().toLowerCase();
  const selectedId = String(query.id || "");
  const confirm = String(query.confirm || "");
  const filtered = q
    ? clients.filter((client) => `${client.clientName || ""} ${(Array.isArray(client.redirectUris) ? client.redirectUris : []).join(" ")}`.toLowerCase().includes(q))
    : clients;
  // Sorting is server state (`table-sort.js`): the header link carries it, this page decides on it.
  const sort = readSort(query, ["client", "accounts", "domains", "lastUsed", "callbacks"], "client");
  const list = sortRows(filtered, sort, {
    client: (client) => model.clientName(client),
    accounts: (client) => model.linkedAccounts(client.clientId).length,
    domains: (client) => (Array.isArray(client.connectionOrigins) ? client.connectionOrigins.length : 0),
    lastUsed: (client) => client.lastUsedAt ?? null,
    callbacks: (client) => (Array.isArray(client.redirectUris) ? client.redirectUris.length : 0),
  });
  const target = clients.find((client) => String(client.clientId) === selectedId) || null;

  const tableHtml = table(
    [[t("adm.clients.column.client"), "24%", "", "client"], [t("adm.clients.column.accounts"), "22%", "", "accounts"], [t("adm.clients.column.domains"), "18%", "", "domains"], [t("adm.clients.column.lastUsed"), "16%", "", "lastUsed"], [t("adm.clients.column.callbacks"), "20%", "", "callbacks"], ["", "", "act"]],
    list.map((client) => row(ctx, client, selectedId)),
    emptyState("app", t("adm.clients.emptyNoMatch"), t("adm.accounts.emptyNoMatchHint")),
    { ...sort, base: tabHref({ q: query.q }) },
  );

  // `confirm=cancel-transfer:<transferId>` — cancel the pending transfer of the selected client.
  const cancelId = confirm.startsWith("cancel-transfer:") ? confirm.slice("cancel-transfer:".length) : "";
  const cancelTransfer = cancelId
    ? pendingFor(ctx, selectedId).find((transfer) => String(transfer.id) === cancelId) || null
    : null;
  const transferParams = confirm === "transfer"
    ? { sourceUserId: String(query.sourceUserId || ""), targetUserId: String(query.targetUserId || "") }
    : null;
  const transferTarget = transferParams ? accounts.find((account) => String(account.id) === transferParams.targetUserId) || null : null;
  const transferSource = transferParams ? accounts.find((account) => String(account.id) === transferParams.sourceUserId) || null : null;
  const transferReady = Boolean(transferTarget && transferSource && transferSource.id !== transferTarget.id && !isDisabled(transferTarget));

  const notice = !target && confirm
    ? `<div class="result err" role="status">${ic("alert")}<div>${esc(t("adm.clients.notice.missing"))}</div></div>`
    : cancelId && !cancelTransfer
      ? `<div class="result err" role="status">${ic("alert")}<div>${esc(t("adm.clients.notice.notPending"))}</div></div>`
      : transferParams && !transferReady
        ? `<div class="result err" role="status">${ic("alert")}<div>${esc(t("adm.clients.notice.badTarget"))}</div></div>`
        : "";
  const content = `${pageBar({ title: t("adm.nav.clients"), count: clients.length })}<div class="content scroll"><div class="page">
  <p class="lede">${esc(t("adm.clients.lede"))}</p>
  <div class="toolbar">${searchBox({ placeholder: t("adm.clients.searchPlaceholder"), value: query.q, hidden: { tab: TAB } })}</div>
  ${notice}${tableHtml}${mcards(list.map((client) => card(ctx, client)))}
  </div></div>`;

  let detailPanel = "";
  if (cancelTransfer && target) {
    detailPanel = confirmPage({
      title: t("adm.clients.confirm.cancelTransferTitle"),
      bodyHtml: t("adm.clients.confirm.cancelTransferBody", { client: esc(model.clientName(target)), target: esc(transferAccountLabel(ctx.snapshot, cancelTransfer.targetUserId)), source: esc(transferAccountLabel(ctx.snapshot, cancelTransfer.sourceUserId)) }),
      ok: t("adm.clients.transfer.cancelButton"),
      backHref: tabHref({ id: target.clientId }),
      action: "/admin/auth/oauth/client/transfer/cancel",
      csrf: ctx.csrf,
      fields: { transferId: cancelTransfer.id },
    });
  } else if (confirm === "revoke" && target) {
    const linked = model.linkedAccounts(target.clientId);
    detailPanel = confirmPage({
      title: t("adm.clients.confirm.revokeTitle", { client: model.clientName(target) }),
      bodyHtml: linked.length
        ? t("adm.clients.confirm.revokeBody", { accounts: linked.map((account) => "<b>" + esc(model.acctName(account)) + "</b>").join(esc(t("adm.ui.listSeparator"))) })
        : t("adm.clients.confirm.revokeNothing"),
      ok: t("adm.clients.confirm.revokeOk"),
      backHref: tabHref({ id: target.clientId }),
      action: "/admin/auth/oauth/client/revoke",
      csrf: ctx.csrf,
      fields: { clientId: target.clientId },
    });
  } else if (confirm === "delete" && target) {
    detailPanel = confirmPage({
      title: t("adm.clients.confirm.deleteTitle", { client: model.clientName(target) }),
      bodyHtml: esc(t("adm.clients.confirm.deleteBody")),
      typed: target.clientName || "delete",
      ok: t("adm.clients.deleteClient"),
      backHref: tabHref({ id: target.clientId }),
      action: "/admin/auth/oauth/client/delete",
      csrf: ctx.csrf,
      fields: { clientId: target.clientId },
    });
  } else if (transferParams && transferReady && target) {
    detailPanel = confirmPage({
      title: t("adm.clients.confirm.transferTitle"),
      bodyHtml: t("adm.clients.confirm.transferBody", { source: esc(model.acctName(transferSource)), client: esc(model.clientName(target)), target: esc(model.acctName(transferTarget)) }),
      ok: t("adm.clients.confirm.transferOk"),
      tone: "primary",
      backHref: tabHref({ id: target.clientId, mode: "transfer" }),
      action: "/admin/auth/oauth/client/transfer",
      csrf: ctx.csrf,
      fields: { clientId: target.clientId, sourceUserId: transferSource.id, targetUserId: transferTarget.id },
    });
  } else if (selectedId) {
    detailPanel = target
      ? clientDrawer(ctx, target)
      : drawer({
        title: t("adm.clients.missingTitle"),
        closeHref: tabHref({ q: query.q }),
        bodyHtml: `<div class="dsec">${emptyState("app", t("adm.clients.missingBody"), "")}</div>`,
      });
  }
  return { content, detailPanel };
}
