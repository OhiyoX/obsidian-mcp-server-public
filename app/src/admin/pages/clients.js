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
    if (origin === client.registeredOrigin) labels.push("注册");
    if (origin === client.lastRequestedOrigin && origin !== client.lastAuthorizedOrigin && origin !== client.lastConnectionOrigin) labels.push("请求");
    if (origin === client.lastAuthorizedOrigin) labels.push("授权");
    if (origin === client.lastConnectionOrigin) labels.push("调用");
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
      return `<div><span class="tag amber" title="记录仍为 pending 且尚未落盘，不可完成">转移期限已过 → ${esc(target)}</span></div>`;
    }
    return `<div><span class="tag amber" title="已撤销原账户授权，等待目标账户在客户端重新同意">转移中 → ${esc(target)}</span></div>`;
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
    { href: tabHref({ id: client.clientId }), label: "查看详情", icon: "eye" },
    { href: tabHref({ id: client.clientId, mode: "transfer" }), label: "转移授权账户…", icon: "swap" },
  ];
  if (pending.length) {
    items.push({
      href: tabHref({ id: client.clientId, confirm: `cancel-transfer:${pending[0].id}` }),
      label: "取消待完成的转移",
      icon: "x",
    });
  }
  // The prototype disables 撤销全部授权 when no account is linked; a menu cannot render a
  // disabled entry, so the item is omitted instead of leading to a no-op confirm.
  if (linked.length) items.push({ href: tabHref({ id: client.clientId, confirm: "revoke" }), label: "撤销全部授权…", icon: "ban", danger: true });
  items.push({ href: tabHref({ id: client.clientId, confirm: "delete" }), label: "删除客户端…", icon: "trash", danger: true });
  return moreMenu(items);
}

function row(ctx, client, selectedId) {
  const { model } = ctx;
  const linked = model.linkedAccounts(client.clientId);
  const linkedCell = linked.length
    ? linked.map((account) => `<a href="${esc(accountHref(account.id))}">${esc(model.acctName(account))}</a>`).join("、")
    : `<span class="muted">无有效授权</span>`;
  const domains = domainsOf(client);
  const domainCell = domains.length
    ? domains.map((domain) => `<span title="来源：${esc(domain.labels.join("、") || "未记录")}">${esc(domain.host)}</span>`).join("")
    : `<span class="muted">—</span>`;
  const lastCell = client.lastUsedAt
    ? `${relTitle(client.lastUsedAt)} <span class="muted mono">${esc(client.lastSource || "—")}</span>`
    : `<span class="muted">从未调用</span>`;
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
  const sub = linked.map((account) => model.acctName(account)).join("、") || "无有效授权";
  const pending = pendingFor(ctx, client.clientId);
  return `<div class="mc"><div class="b">
    <a class="cell-link block" href="${esc(tabHref({ id: client.clientId }))}"><div class="nm"><b>${esc(model.clientName(client))}</b><span class="sub2">${esc(sub)}</span></div></a>
    ${pending.length ? `<span><span class="tag amber">转移中 → ${esc(transferAccountLabel(ctx.snapshot, pending[0].targetUserId))}</span></span>` : ""}
    <div class="meta"><span>${client.lastUsedAt ? `调用 ${relTitle(client.lastUsedAt)}` : "从未调用"}</span></div>
  </div>${menu(ctx, client)}</div>`;
}

function transferBanner(ctx, transfer) {
  const from = transferAccountLabel(ctx.snapshot, transfer.sourceUserId);
  const to = transferAccountLabel(ctx.snapshot, transfer.targetUserId);
  const cancel = `<form class="inline-form" method="post" action="/admin/auth/oauth/client/transfer/cancel"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="transferId" value="${esc(transfer.id)}"><button class="btn sm" type="submit">取消转移</button></form>`;
  const head = isUnpersistedExpiry(transfer, ctx.now)
    ? `<b>授权转移期限已过</b>：记录仍为 pending 且尚未落盘，不可完成；已于 ${relTitle(transfer.createdAt)} 撤销 <b>${esc(from)}</b> 的授权，等待 <b>${esc(to)}</b> 在客户端中重新登录并同意。`
    : `<b>授权转移待完成</b>：已于 ${relTitle(transfer.createdAt)} 撤销 <b>${esc(from)}</b> 的授权，等待 <b>${esc(to)}</b> 在客户端中重新登录并同意。`;
  return banner(`${head}<div style="margin-top:8px">${cancel}</div><div class="help">取消只停止自动完成，不会恢复源账户已被撤销的旧凭证。</div>`, { tone: "amber", icon: "swap" });
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
    ? `${sources.length > 1 ? '<option value="">请选择源账户</option>' : ""}${sources.map((account) => `<option value="${esc(account.id)}">${esc(model.acctName(account))}（${esc(account.username || "")}）</option>`).join("")}`
    : "<option value=\"\">无有效授权</option>";
  const targetOptions = `${targets.length ? '<option value="">选择目标账户…</option>' : '<option value="">无可选目标账户</option>'}${targets.map((account) => `<option value="${esc(account.id)}">${esc(model.acctName(account))}（${esc(account.username || "")}）</option>`).join("")}${accounts.filter(isDisabled).map((account) => `<option disabled>${esc(model.acctName(account))} · 已停用</option>`).join("")}`;
  const hint = pending.length
    ? `<span class="help">已有一项转移待完成</span>`
    : !linked.length
      ? `<span class="help">该客户端当前没有有效授权，无法发起转移。</span>`
      : !targets.length
        ? `<span class="help">无可选目标账户：需要存在、未停用、且当前未授权该客户端的 OAuth 账户。</span>`
        : "";
  return `<form class="dsec" method="get" action="/admin/auth">
    <h3>转移授权账户</h3>
    <input type="hidden" name="tab" value="${TAB}">
    <input type="hidden" name="id" value="${esc(client.clientId)}">
    <input type="hidden" name="confirm" value="transfer">
    <p class="help" style="margin:0 0 8px">把此客户端的当前授权从一个账户换到另一个账户：撤销原账户的 Token，目标账户在客户端中重新同意后生效。不更改回调地址与密钥。</p>
    <div class="grid2">
      <div class="fld"><label>从</label><select class="sel" name="sourceUserId"${blocked || !sources.length ? " disabled" : ""}>${sourceOptions}</select></div>
      <div class="fld"><label>转到</label><select class="sel" name="targetUserId"${blocked || !targets.length ? " disabled" : ""}${query.mode === "transfer" && !blocked ? " autofocus" : ""}>${targetOptions}</select></div>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
      <button class="btn" type="submit"${blocked || !targets.length ? " disabled" : ""}>${ic("swap")}开始转移…</button>${hint}
    </div>
    <div class="futonly futbox" style="margin-top:12px"><label class="chk" style="margin:-6px -8px"><input type="checkbox" disabled><span>由管理员直接为目标账户签发等价授权，无需其重新同意 ${fut("#364 待决")}</span></label></div>
  </form>`;
}

function clientDrawer(ctx, client) {
  const { model, query } = ctx;
  const linked = model.linkedAccounts(client.clientId);
  const domains = domainsOf(client);
  const uris = Array.isArray(client.redirectUris) ? client.redirectUris : [];
  const linkedCell = linked.length
    ? linked.map((account) => `<a href="${esc(accountHref(account.id))}">${esc(model.acctName(account))}</a>`).join("、")
    : `<span class="muted">无有效授权</span>`;
  const domainCell = domains.length
    ? domains.map((domain) => `${esc(domain.host)} <span class="muted">· 来源 ${esc(domain.labels.join(" / ") || "未记录")}</span>`).join("<br>")
    : `<span class="muted">尚无</span>`;
  const callbacks = uris.length
    ? `<div class="list">${uris.map((uri) => `<div class="li"><span class="mono ell grow" title="${esc(uri)}">${esc(uri)}</span></div>`).join("")}</div>`
    : `<span class="muted">无</span>`;
  const body = `
  ${pendingFor(ctx, client.clientId).map((transfer) => transferBanner(ctx, transfer)).join("")}
  <div class="dsec">${kv([
    ["客户端 ID", model.idc(client.clientId, client.clientId)],
    ["已授权账户", linkedCell],
    ["连接域名", domainCell],
    ["注册", esc(fmtFull(client.createdAt))],
    ["最后调用", client.lastUsedAt ? `${esc(fmtFull(client.lastUsedAt))} <span class="muted mono">· ${esc(client.lastSource || "—")}</span>` : `<span class="muted">从未调用</span>`],
  ])}</div>
  <div class="dsec"><h3>回调地址 · ${uris.length}</h3>${callbacks}<span class="help">回调地址来自客户端注册；连接域名不从回调地址推测。</span></div>
  <form class="dsec" method="post" action="/admin/auth/oauth/client/default-vault">
    <h3>默认 Vault</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="clientId" value="${esc(client.clientId)}">
    ${renderDefaultVaultPicker(ctx, {
      current: client.defaultVaultId,
      allowedVaults: (ctx.snapshot?.tokens || []).filter((token) => token.clientId === client.clientId && token.status === "active").flatMap((token) => token.allowedVaults || []),
    })}
    <div style="margin-top:12px"><button class="btn primary" type="submit">保存默认 Vault</button></div>
  </form>
  ${transferForm(ctx, client)}
  <div class="dsec"><h3>危险操作</h3><div class="danger-zone">
    <div class="dz"><div class="t"><b>撤销全部授权</b>所有账户在此客户端上的 Token 立即失效，注册保留</div>${linked.length
      ? `<a class="btn danger-o" href="${esc(tabHref({ id: client.clientId, confirm: "revoke" }))}">撤销…</a>`
      : `<button class="btn danger-o" type="button" disabled>撤销…</button>`}</div>
    <div class="dz"><div class="t"><b>删除客户端</b>撤销授权并删除注册记录</div><a class="btn danger-o" href="${esc(tabHref({ id: client.clientId, confirm: "delete" }))}">删除…</a></div>
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
  const list = q
    ? clients.filter((client) => `${client.clientName || ""} ${(Array.isArray(client.redirectUris) ? client.redirectUris : []).join(" ")}`.toLowerCase().includes(q))
    : clients;
  const target = clients.find((client) => String(client.clientId) === selectedId) || null;

  const tableHtml = table(
    [["客户端", "24%"], ["已授权账户", "22%"], ["连接域名", "18%"], ["最后调用", "16%"], ["回调地址", "20%"], ["", "", "act"]],
    list.map((client) => row(ctx, client, selectedId)),
    emptyState("app", "没有匹配的客户端", "换个关键词试试"),
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
    ? `<div class="result err" role="status">${ic("alert")}<div>该客户端不存在或已删除，未执行任何操作。</div></div>`
    : cancelId && !cancelTransfer
      ? `<div class="result err" role="status">${ic("alert")}<div>该转移已不是待完成状态，无需取消；源账户的旧凭证不会恢复。</div></div>`
      : transferParams && !transferReady
        ? `<div class="result err" role="status">${ic("alert")}<div>请选择未停用且不同于源账户的目标账户，再发起转移。</div></div>`
        : "";
  const content = `${pageBar({ title: "OAuth 客户端", count: clients.length })}<div class="content scroll"><div class="page">
  <p class="lede">客户端通过动态注册（DCR）自动出现。连接域名来自实际授权与调用，不从回调地址推测。</p>
  <div class="toolbar">${searchBox({ placeholder: "搜索客户端名称或回调地址", value: query.q, hidden: { tab: TAB } })}</div>
  ${notice}${tableHtml}${mcards(list.map((client) => card(ctx, client)))}
  </div></div>`;

  let detailPanel = "";
  if (cancelTransfer && target) {
    detailPanel = confirmPage({
      title: "取消待完成的转移？",
      bodyHtml: `将停止自动完成「${esc(model.clientName(target))}」到 <b>${esc(transferAccountLabel(ctx.snapshot, cancelTransfer.targetUserId))}</b> 的授权转移。取消不会恢复源账户 <b>${esc(transferAccountLabel(ctx.snapshot, cancelTransfer.sourceUserId))}</b> 已被撤销的旧凭证，它仍需用同一客户端重新授权。`,
      ok: "取消转移",
      backHref: tabHref({ id: target.clientId }),
      action: "/admin/auth/oauth/client/transfer/cancel",
      csrf: ctx.csrf,
      fields: { transferId: cancelTransfer.id },
    });
  } else if (confirm === "revoke" && target) {
    const linked = model.linkedAccounts(target.clientId);
    detailPanel = confirmPage({
      title: `撤销「${model.clientName(target)}」的全部授权？`,
      bodyHtml: linked.length
        ? `${linked.map((account) => `<b>${esc(model.acctName(account))}</b>`).join("、")} 在此客户端上的 Token 将立即失效，需要重新授权。客户端注册保留。`
        : "<b>无有效授权</b>：该客户端当前没有可撤销的授权。",
      ok: "撤销授权",
      backHref: tabHref({ id: target.clientId }),
      action: "/admin/auth/oauth/client/revoke",
      csrf: ctx.csrf,
      fields: { clientId: target.clientId },
    });
  } else if (confirm === "delete" && target) {
    detailPanel = confirmPage({
      title: `删除客户端「${model.clientName(target)}」？`,
      bodyHtml: "将撤销其全部授权并删除注册记录；客户端下次连接时会重新注册为新客户端。",
      typed: target.clientName || "delete",
      ok: "删除客户端",
      backHref: tabHref({ id: target.clientId }),
      action: "/admin/auth/oauth/client/delete",
      csrf: ctx.csrf,
      fields: { clientId: target.clientId },
    });
  } else if (transferParams && transferReady && target) {
    detailPanel = confirmPage({
      title: "转移授权账户？",
      bodyHtml: `将立即撤销 <b>${esc(model.acctName(transferSource))}</b> 在「${esc(model.clientName(target))}」上的 Token。<b>${esc(model.acctName(transferTarget))}</b> 需在客户端中重新登录并同意后，转移才完成。`,
      ok: "开始转移",
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
        title: "客户端不存在",
        closeHref: tabHref({ q: query.q }),
        bodyHtml: `<div class="dsec">${emptyState("app", "客户端不存在或已删除", "")}</div>`,
      });
  }
  return { content, detailPanel };
}
