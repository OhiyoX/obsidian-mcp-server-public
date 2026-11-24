// API Key — greenfield SSR port of the prototype page.
//   markup : docs/admin-ui-proto/src/5-render.js  renderKeys()                (208–228)
//   states : docs/admin-ui-proto/src/6-app.js     drawerHtml() "new-key"      (224–226)
//                                                 drawerHtml() "key"          (243–247)
//                                                 menuItems()  "key"          (135)
//   rules  : docs/admin-ui-proto/README.md 「API Key」功能对照表 + docs/admin/README.md
//
// No script (CSP `default-src 'none'`, D0 HOLD). Deliberate deviations, all in the lane CHECKPOINT:
//   * no "复制 Key ID" menu item and no copy button (script-only; the id is selectable text and the
//     drawer shows it in full);
//   * the planned "轮换（重新生成）" menu item (#285/设想) is not rendered as a dead button, and the
//     planned 绑定 Agent row is gone: #285 shipped it as a display-purpose label, so the drawer
//     now carries that label's own POST form; the planned 到期时间 marker is kept;
//   * the one-time Key plaintext banner is rendered by the shell (`pages/shell.js`), not here;
//   * the ⋯ menu cannot draw the prototype's `<hr>` separator.
//
// The environment Key (`configured-env`) is read-only in both the row and the drawer: it is never
// editable through the Admin plane, and its secret never passes through this module.
import { pageBar, searchBox, table, mcards, emptyState, moreMenu, drawer, confirmPage, kv, banner } from "../ui.js";
import { renderSubjectAuthzSection } from "../subject-authz.js";
import { readSort, sortRows } from "../table-sort.js";
import { esc, fmtDate, fmtFull, relTitle } from "../presentation/format.js";
import { ic } from "../assets/icons.js";
import { renderDefaultVaultPicker } from "../default-vault-picker.js";
import { t } from "../../i18n/context.js";
import { keyExpiryState } from "../../api-key-expiry.js";
import { displayAgentHint } from "../../agent-identity.js";

const TAB = "keys";

/** `#/keys[/<keyId>]` + modals, kept as query state (`?tab=keys&id=…`). */
function tabHref({ id = null, confirm = null, q = null } = {}) {
  const parts = [`tab=${TAB}`];
  if (q) parts.push(`q=${encodeURIComponent(q)}`);
  if (id) parts.push(`id=${encodeURIComponent(id)}`);
  if (confirm) parts.push(`confirm=${encodeURIComponent(confirm)}`);
  return `/admin/auth?${parts.join("&")}`;
}

/** The synthetic deployment Key is marked `immutable` by `catalog.js`; nothing else is. */
function isEnvKey(key) {
  return key?.immutable === true || key?.id === "configured-env";
}

function nameCell(model, key) {
  const named = Boolean(String(key.label || "").trim());
  const sub = isEnvKey(key)
    ? `<span class="kind">${esc(t("adm.keys.envKind"))}</span><span class="muted">${esc(t("adm.keys.envSource"))}</span>`
    : `<span class="mono">${esc(key.prefix ? `${key.prefix}…` : "—")}</span>${model.idc(key.id)}`;
  return `<a class="cell-link block" href="${esc(tabHref({ id: key.id }))}"><div class="nm"><b${named ? "" : ' style="font-style:italic;font-weight:400;color:var(--tx2)"'}>${esc(model.keyName(key))}</b><span class="sub2">${sub}</span></div></a>`;
}

function menu(ctx, key) {
  return moreMenu([
    { href: tabHref({ id: key.id }), label: t("adm.keys.menu.edit"), icon: "edit" },
    { href: tabHref({ id: key.id, confirm: "delete" }), label: t("adm.keys.menu.delete"), icon: "trash", danger: true },
  ]);
}

/** The expiry cell, said once so the table, the card and the drawer cannot disagree. */
function expiryCell(key) {
  // The deployment's own key is never created through the form and never expires.
  const state = isEnvKey(key) ? { kind: "never", days: null } : keyExpiryState(key.expiresAt);
  if (state.kind === "never") return esc(t("adm.keys.expiresNever"));
  if (state.kind === "expired") return `<span class="st danger">${esc(t("adm.keys.expiresExpired"))}</span>`;
  if (state.kind === "today") return esc(t("adm.keys.expiresToday"));
  return esc(t("adm.keys.expiresDays", { days: state.days }));
}

/** The operator's display purpose, or the User-Agent hint when no label is bound (#285). */
function agentLabelOf(key) {
  const label = String(key?.agentLabel || "").trim();
  if (label) return label;
  // A key that was never used has no User-Agent to infer from: show nothing rather than a guess.
  return key?.lastUserAgent ? displayAgentHint(key.lastUserAgent) : null;
}

function row(ctx, key, selectedId) {
  const { model } = ctx;
  const env = isEnvKey(key);
  const lastCell = key.lastUsedAt
    ? `${relTitle(key.lastUsedAt)}${key.lastUserAgent ? ` <span class="muted ell" title="${esc(key.lastUserAgent)}">${esc(key.lastUserAgent)}</span>` : ""}`
    : `<span class="muted">${esc(t("adm.keys.neverUsed"))}</span>`;
  return `<tr${selectedId === key.id ? ' class="cur"' : ""}>
    <td>${nameCell(model, key)}</td>
    <td><div class="tags">${model.scopeTags(key.allowedScopes)}${model.vaultTags(key.allowedVaults)}</div></td>
    <td class="cellt">${lastCell}${key.agentLabel ? `<div class="muted ell">${esc(key.agentLabel)}</div>` : ""}</td>
    <td class="cellt mono muted">${esc(key.lastSource || "—")}</td>
    <td class="cellt muted">${env ? esc(t("adm.keys.withDeployment")) : esc(fmtDate(key.createdAt))}</td>
    <td class="cellt">${expiryCell(key)}</td>
    <td class="act">${env
      ? `<span class="ibtn lock-cell" title="${esc(t("adm.keys.envLockTitle"))}">${ic("lock")}</span>`
      : menu(ctx, key)}</td></tr>`;
}

function card(ctx, key) {
  const { model } = ctx;
  const env = isEnvKey(key);
  return `<div class="mc"><div class="b">
    <a class="cell-link block" href="${esc(tabHref({ id: key.id }))}"><div class="nm"><b>${esc(model.keyName(key))}</b><span class="sub2">${env ? esc(t("adm.keys.envReadOnlyBadge")) : `${esc(key.prefix ? `${key.prefix}…` : "—")}`}</span></div></a>
    <div class="tags">${model.scopeTags(key.allowedScopes)}${model.vaultTags(key.allowedVaults)}</div>
    <div class="meta"><span>${key.lastUsedAt ? esc(t("adm.keys.usedAt", { time: model.rel(key.lastUsedAt) })) : esc(t("adm.keys.neverUsed"))}</span><span>${esc(t("adm.keys.column.expires"))}: ${expiryCell(key)}</span></div>
  </div>${env ? "" : menu(ctx, key)}</div>`;
}

/**
 * The page-bar create affordance — same contract as `accounts.js`: the prototype's CTA is a
 * `<button data-act="new-key">` (`5-render.js` 219), and a list page's `?id=` anchors are its
 * *detail* entries, so the `?id=new` state is reached through a GET form instead of an anchor
 * (see `proto-parity/gate.mjs`).
 */
function createCta(label) {
  return `<form class="inline-form" method="get" action="/admin/auth"><input type="hidden" name="tab" value="${TAB}"><input type="hidden" name="id" value="new"><button class="btn primary" type="submit">${ic("plus")}<span class="hide-m">${label}</span></button></form>`;
}

function pickers(ctx, { scopes = [], vaults = [] } = {}) {
  const vaultList = Array.isArray(ctx.vaults) ? ctx.vaults : [];
  return {
    scopes: ctx.model.scopeOptions(scopes),
    vaults: vaultList.length
      ? ctx.model.vaultOptions(vaults)
      : `<p class="help">${esc(t("adm.accounts.vaultInventoryMissing"))}</p>`,
  };
}

function createDrawer(ctx) {
  const pick = pickers(ctx, { scopes: ["obsidian.read"], vaults: (ctx.vaults || []).filter((v) => v.primary).map((v) => v.id) });
  return drawer({
    title: t("adm.keys.newTitle"),
    closeHref: tabHref(),
    bodyHtml: `<form id="new-key" method="post" action="/admin/auth/api-key/create">
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <div class="dsec"><div class="fld"><label>${esc(t("adm.keys.field.label"))}</label><input class="inp" name="label" placeholder="${esc(t("adm.keys.field.labelPlaceholder"))}" maxlength="120" required><span class="help">${esc(t("adm.keys.field.labelHelp"))}</span></div></div>
    <div class="dsec"><h3>${esc(t("adm.keys.scopeSection"))}</h3><div class="grid2" style="gap:0">${pick.scopes}</div></div>
    <div class="dsec"><h3>${esc(t("adm.accounts.allowedVaults"))}</h3>${pick.vaults}</div>
    <div class="dsec">${renderDefaultVaultPicker(ctx, { allowedVaults: (ctx.vaults || []).map((v) => v.id) })}</div>
    <div class="dsec">
      <div class="grid2" style="gap:0">
        <div class="fld"><label for="new-key-expiry">${esc(t("adm.keys.expiry"))}</label><select class="sel" id="new-key-expiry" name="expiry"><option value="never">${esc(t("adm.keys.expiryNever"))}</option><option value="7">${esc(t("adm.keys.expiry7"))}</option><option value="30">${esc(t("adm.keys.expiry30"))}</option><option value="90">${esc(t("adm.keys.expiry90"))}</option></select></div>
        <div class="fld"><label for="new-key-expires-on">${esc(t("adm.keys.expiryPick"))}</label><input class="inp" id="new-key-expires-on" type="date" name="expiresOn"></div>
      </div>
      <span class="help">${esc(t("adm.keys.expiryHelp"))}</span></div>
  </form>`,
    footHtml: `<span class="help">${esc(t("adm.keys.plaintextOnce"))}</span><a class="btn ghost" href="${esc(tabHref())}">${esc(t("adm.ui.cancel"))}</a><button class="btn primary" type="submit" form="new-key">${esc(t("adm.keys.create"))}</button>`,
  });
}

/** Constraints that name this Key as a subject (`api-key:<id>`), each linked to its drawer. */
function policyCell(ctx, key) {
  const constraints = Array.isArray(ctx.constraintPage?.constraints) ? ctx.constraintPage.constraints : [];
  const subject = `api-key:${key.id}`;
  const hits = constraints.filter((constraint) => (Array.isArray(constraint?.subjects) ? constraint.subjects : []).includes(subject));
  if (!hits.length) return `<span class="muted">${esc(t("adm.keys.unrestricted"))}</span>`;
  const base = ctx.constraintBase || "/admin/auth";
  return hits.map((constraint) => `<a href="${esc(`${base}?id=${encodeURIComponent(constraint.id)}`)}">${esc(constraint.label || constraint.id)}</a>`).join(esc(t("adm.ui.listSeparator")));
}

function keyDrawer(ctx, key) {
  const { model, query } = ctx;
  const env = isEnvKey(key);
  const pick = pickers(ctx, { scopes: key.allowedScopes || [], vaults: key.allowedVaults || [] });
  const lastCell = key.lastUsedAt
    ? `${esc(fmtFull(key.lastUsedAt))}<div class="muted">${key.lastUserAgent ? `<span title="User-Agent">${esc(key.lastUserAgent)}</span> · ` : ""}<span class="mono">${esc(key.lastSource || "—")}</span></div>`
    : `<span class="muted">${esc(t("adm.keys.neverUsed"))}</span>`;
  const body = `
  ${env ? banner(t("adm.keys.envBanner")) : ""}
  <div class="dsec">${kv([
    [t("adm.keys.kv.prefix"), env ? t("adm.keys.envPrefixValue") : esc(key.prefix ? `${key.prefix}…` : "—"), 'class="mono"'],
    [t("adm.keys.kv.id"), model.idc(key.id, key.id)],
    [t("adm.keys.kv.created"), env ? t("adm.keys.withDeployment") : esc(fmtFull(key.createdAt))],
    [t("adm.keys.kv.lastUsed"), lastCell],
    [t("adm.keys.kv.authz"), policyCell(ctx, key)],
    [t("adm.keys.column.expires"), expiryCell(key)],
    [t("adm.keys.kv.agent"), key.agentLabel
      ? esc(key.agentLabel)
      : `<span class="muted">${esc(t("adm.keys.agentInferred", { agent: agentLabelOf(key) || "—" }))}</span>`],
  ])}</div>
  ${env ? "" : `<form class="dsec" method="post" action="/admin/auth/api-key/agent">
    <h3>${esc(t("adm.keys.kv.agent"))}</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="id" value="${esc(key.id)}">
    <div class="fld"><input class="inp" name="agent" value="${esc(key.agentLabel || "")}" maxlength="40" placeholder="${esc(t("adm.keys.agentPlaceholder"))}" aria-label="${esc(t("adm.keys.kv.agent"))}"></div>
    <span class="help">${esc(t("adm.keys.agentHelp"))}</span>
    <div style="margin-top:12px"><button class="btn primary" type="submit">${esc(t("adm.keys.saveAgent"))}</button></div>
  </form>`}
  ${renderSubjectAuthzSection(ctx, { subject: `api-key:${key.id}` })}
  <form class="dsec" data-key-access-form method="post" action="/admin/auth/api-key/scopes">
    <h3>${esc(t("adm.keys.scopeVaultSection"))}</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="id" value="${esc(key.id)}">
    ${env
      ? `<div class="tags">${model.scopeTags(key.allowedScopes)}${model.vaultTags(key.allowedVaults)}</div><span class="help">${esc(t("adm.keys.envScopeHelp"))}</span>`
      : `<div class="grid2 key-access-scopes">${pick.scopes}</div>
    <fieldset class="key-access-vaults"><legend>${esc(t("adm.accounts.allowedVaults"))}</legend>${pick.vaults}</fieldset>
    <button class="btn primary" type="submit">${esc(t("adm.keys.save"))}</button>`}
  </form>
  ${env ? "" : `<form class="dsec" method="post" action="/admin/auth/api-key/default-vault">
    <h3>${esc(t("adm.keys.defaultVault"))}</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="id" value="${esc(key.id)}">
    ${renderDefaultVaultPicker(ctx, { showLabel: false, current: key.defaultVaultId, allowedVaults: key.allowedVaults || [] })}
    <div class="default-vault-actions"><button class="btn primary" type="submit">${esc(t("adm.keys.saveDefaultVault"))}</button></div>
  </form><div class="dsec"><h3>${esc(t("adm.accounts.dangerTitle"))}</h3><div class="danger-zone">
    <div class="dz"><div class="t"><b>${esc(t("adm.keys.deleteKey"))}</b>${esc(t("adm.keys.deleteKeyDesc"))}</div><a class="btn danger-o" href="${esc(tabHref({ id: key.id, confirm: "delete" }))}">${esc(t("adm.accounts.deleteAction"))}</a></div>
  </div></div>`}`;
  return drawer({
    title: model.keyName(key),
    subtitle: env ? t("adm.keys.readOnly") : "",
    closeHref: tabHref({ q: query.q }),
    bodyHtml: body,
  });
}

export function renderKeysPage(ctx) {
  const { model, keys, query = {} } = ctx;
  const list0 = Array.isArray(keys) ? keys : [];
  const q = String(query.q || "").trim().toLowerCase();
  const selectedId = String(query.id || "");
  const confirm = String(query.confirm || "");
  const filtered = q
    ? list0.filter((key) => `${key.label || ""} ${key.prefix || ""}`.toLowerCase().includes(q))
    : list0;
  // Sorting is server state (see `table-sort.js`): the header link carries it, the data decides it.
  const sort = readSort(query, ["name", "scopes", "lastUsed", "created", "expires"], "name");
  const list = sortRows(filtered, sort, {
    name: (key) => model.keyName(key),
    scopes: (key) => (Array.isArray(key.allowedScopes) ? key.allowedScopes.length : 0),
    lastUsed: (key) => key.lastUsedAt ?? null,
    created: (key) => key.createdAt ?? null,
    // A key that never expires sorts last when ascending: nothing is sooner than "never".
    expires: (key) => (isEnvKey(key) ? null : key.expiresAt ?? null),
  });
  const target = list0.find((key) => String(key.id) === selectedId) || null;

  const tableHtml = table(
    [[t("adm.keys.column.name"), "24%", "", "name"], [t("adm.keys.column.scopes"), "24%", "", "scopes"], [t("adm.keys.column.lastUsed"), "18%", "", "lastUsed"], [t("adm.keys.column.source"), "10%"], [t("adm.keys.column.created"), "9%", "", "created"], [t("adm.keys.column.expires"), "9%", "", "expires"], ["", "", "act"]],
    list.map((key) => row(ctx, key, selectedId)),
    emptyState("key", t("adm.keys.emptyNoMatch"), t("adm.accounts.emptyNoMatchHint")),
    { ...sort, base: tabHref({ q: query.q }) },
  );

  const actions = createCta(t("adm.keys.new"));
  const staleConfirm = confirm && !target
    ? `<div class="result err" role="status">${ic("alert")}<div>${esc(t("adm.keys.staleConfirm"))}</div></div>`
    : "";
  const content = `${pageBar({ title: t("adm.nav.keys"), count: list0.length, actions })}<div class="content scroll"><div class="page">
  <p class="lede">${esc(t("adm.keys.lede"))}</p>
  <div class="toolbar">${searchBox({ placeholder: t("adm.keys.searchPlaceholder"), value: query.q, hidden: { tab: TAB } })}</div>
  ${staleConfirm}${tableHtml}${mcards(list.map((key) => card(ctx, key)))}
  </div></div>`;

  let detailPanel = "";
  if (confirm === "delete" && target) {
    const lastLine = target.lastUsedAt
      ? `${esc(t("adm.keys.lastUsedLine"))} ${esc(model.rel(target.lastUsedAt))}${target.lastUserAgent ? ` · UA ${esc(target.lastUserAgent)}` : ""}`
      : esc(t("adm.keys.lastUsedNever"));
    detailPanel = confirmPage({
      title: t("adm.keys.deleteConfirmTitle", { name: model.keyName(target) }),
      bodyHtml: t("adm.keys.deleteConfirmBody", { lastLine }),
      typed: target.label || target.prefix || target.id,
      ok: t("adm.keys.deleteConfirmOk"),
      backHref: tabHref({ id: target.id }),
      action: "/admin/auth/api-key/delete",
      csrf: ctx.csrf,
      fields: { id: target.id },
    });
  } else if (selectedId === "new") {
    detailPanel = createDrawer(ctx);
  } else if (selectedId) {
    detailPanel = target
      ? keyDrawer(ctx, target)
      : drawer({
        title: t("adm.keys.missingTitle"),
        closeHref: tabHref({ q: query.q }),
        bodyHtml: `<div class="dsec">${emptyState("key", t("adm.keys.missingBody"), "")}</div>`,
      });
  }
  return { content, detailPanel };
}
