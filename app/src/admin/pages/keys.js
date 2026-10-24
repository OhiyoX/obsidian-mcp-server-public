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
//   * the planned "轮换（重新生成）" menu item (#285/设想) is not rendered as a dead button; the
//     planned markers the prototype shows inside the drawer (到期时间 / 绑定 Agent) are kept;
//   * the one-time Key plaintext banner is rendered by the shell (`pages/shell.js`), not here;
//   * the ⋯ menu cannot draw the prototype's `<hr>` separator.
//
// The environment Key (`configured-env`) is read-only in both the row and the drawer: it is never
// editable through the Admin plane, and its secret never passes through this module.
import { pageBar, searchBox, table, mcards, emptyState, moreMenu, drawer, confirmPage, kv, banner } from "../ui.js";
import { esc, fmtDate, fmtFull, fut, relTitle } from "../presentation/format.js";
import { ic } from "../assets/icons.js";
import { renderDefaultVaultPicker } from "../default-vault-picker.js";

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
    ? '<span class="kind">环境变量</span><span class="muted">由部署 .env 提供</span>'
    : `<span class="mono">${esc(key.prefix ? `${key.prefix}…` : "—")}</span>${model.idc(key.id)}`;
  return `<a class="cell-link block" href="${esc(tabHref({ id: key.id }))}"><div class="nm"><b${named ? "" : ' style="font-style:italic;font-weight:400;color:var(--tx2)"'}>${esc(model.keyName(key))}</b><span class="sub2">${sub}</span></div></a>`;
}

function menu(ctx, key) {
  return moreMenu([
    { href: tabHref({ id: key.id }), label: "编辑权限与 Vault", icon: "edit" },
    { href: tabHref({ id: key.id, confirm: "delete" }), label: "删除 Key…", icon: "trash", danger: true },
  ]);
}

function row(ctx, key, selectedId) {
  const { model } = ctx;
  const env = isEnvKey(key);
  const lastCell = key.lastUsedAt
    ? `${relTitle(key.lastUsedAt)}${key.lastUserAgent ? ` <span class="muted ell" title="${esc(key.lastUserAgent)}">${esc(key.lastUserAgent)}</span>` : ""}`
    : `<span class="muted">从未调用</span>`;
  return `<tr${selectedId === key.id ? ' class="cur"' : ""}>
    <td>${nameCell(model, key)}</td>
    <td><div class="tags">${model.scopeTags(key.allowedScopes)}${model.vaultTags(key.allowedVaults)}</div></td>
    <td class="cellt">${lastCell}</td>
    <td class="cellt mono muted">${esc(key.lastSource || "—")}</td>
    <td class="cellt muted">${env ? "随部署" : esc(fmtDate(key.createdAt))}</td>
    <td class="act">${env
      ? `<span class="ibtn lock-cell" title="环境配置 Key 只读：在受保护的 .env 中轮换">${ic("lock")}</span>`
      : menu(ctx, key)}</td></tr>`;
}

function card(ctx, key) {
  const { model } = ctx;
  const env = isEnvKey(key);
  return `<div class="mc"><div class="b">
    <a class="cell-link block" href="${esc(tabHref({ id: key.id }))}"><div class="nm"><b>${esc(model.keyName(key))}</b><span class="sub2">${env ? "环境变量 · 只读" : `${esc(key.prefix ? `${key.prefix}…` : "—")}`}</span></div></a>
    <div class="tags">${model.scopeTags(key.allowedScopes)}${model.vaultTags(key.allowedVaults)}</div>
    <div class="meta"><span>${key.lastUsedAt ? `调用 ${relTitle(key.lastUsedAt)}` : "从未调用"}</span></div>
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
      : `<p class="help">服务端未提供 Vault 清单，无法勾选允许的 Vault。请先到「Vault 与 Git」页刷新清单。</p>`,
  };
}

function createDrawer(ctx) {
  const pick = pickers(ctx, { scopes: ["obsidian.read"], vaults: (ctx.vaults || []).filter((v) => v.primary).map((v) => v.id) });
  return drawer({
    title: "新建 API Key",
    closeHref: tabHref(),
    bodyHtml: `<form id="new-key" method="post" action="/admin/auth/api-key/create">
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <div class="dsec"><div class="fld"><label>备注名</label><input class="inp" name="label" placeholder="例如：桌面客户端" maxlength="120" required><span class="help">用于在列表、审计和定时授权中识别这个 Key</span></div></div>
    <div class="dsec"><h3>权限范围</h3><div class="grid2" style="gap:0">${pick.scopes}</div></div>
    <div class="dsec"><h3>允许的 Vault</h3>${pick.vaults}</div>
    <div class="dsec">${renderDefaultVaultPicker(ctx, { allowedVaults: (ctx.vaults || []).map((v) => v.id) })}</div>
    <div class="dsec futonly"><h3>到期时间 ${fut("设想")}</h3><select class="sel" disabled><option>永不过期</option></select></div>
  </form>`,
    footHtml: `<span class="help">明文只显示一次</span><a class="btn ghost" href="${esc(tabHref())}">取消</a><button class="btn primary" type="submit" form="new-key">创建 Key</button>`,
  });
}

/** Policies that mention this Key as a subject (`api-key:<id>`), with an honest link. */
function policyCell(ctx, key) {
  const policies = Array.isArray(ctx.authz?.policies) ? ctx.authz.policies : [];
  const subject = `api-key:${key.id}`;
  const hits = policies.filter((policy) => (Array.isArray(policy?.subjects) ? policy.subjects : []).includes(subject));
  if (!hits.length) return `<span class="muted">未受限制</span>`;
  const base = ctx.accessPolicyBase || "/admin/auth";
  return hits.map((policy) => `<a href="${esc(`${base}?edit=${encodeURIComponent(policy.id)}`)}">${esc(policy.label || policy.id)}</a>`).join("、");
}

function keyDrawer(ctx, key) {
  const { model, query } = ctx;
  const env = isEnvKey(key);
  const pick = pickers(ctx, { scopes: key.allowedScopes || [], vaults: key.allowedVaults || [] });
  const lastCell = key.lastUsedAt
    ? `${esc(fmtFull(key.lastUsedAt))}<div class="muted">${key.lastUserAgent ? `<span title="User-Agent">${esc(key.lastUserAgent)}</span> · ` : ""}<span class="mono">${esc(key.lastSource || "—")}</span></div>`
    : `<span class="muted">从未调用</span>`;
  const body = `
  ${env ? banner('这个 Key 来自部署环境变量 <span class="mono">API_KEY</span>，明文不在此显示，也不能在这里修改或删除。如需轮换，请修改受保护的 <span class="mono">.env</span> 后重启服务。') : ""}
  <div class="dsec">${kv([
    ["前缀", env ? "—（环境变量）" : esc(key.prefix ? `${key.prefix}…` : "—"), 'class="mono"'],
    ["Key ID", model.idc(key.id, key.id)],
    ["创建", env ? "随部署" : esc(fmtFull(key.createdAt))],
    ["最后调用", lastCell],
    ["定时授权", policyCell(ctx, key)],
    ["绑定 Agent", `<span class="muted">未设置</span> ${fut("#285")}<div class="help">审计中以此名称归因，替代 UA 推测</div>`, 'class="futonly"'],
  ])}</div>
  <form class="dsec" method="post" action="/admin/auth/api-key/scopes">
    <h3>权限范围与 Vault</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="id" value="${esc(key.id)}">
    ${env
      ? `<div class="tags">${model.scopeTags(key.allowedScopes)}${model.vaultTags(key.allowedVaults)}</div><span class="help">环境配置 Key 的权限来自部署配置，不能在管理端修改。</span>`
      : `<div class="grid2" style="gap:0">${pick.scopes}</div>
    <div style="height:8px"></div>
    ${pick.vaults}
    <div style="margin-top:12px"><button class="btn primary" type="submit">保存</button></div>`}
  </form>
  ${env ? "" : `<form class="dsec" method="post" action="/admin/auth/api-key/default-vault">
    <h3>默认 Vault</h3>
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <input type="hidden" name="id" value="${esc(key.id)}">
    ${renderDefaultVaultPicker(ctx, { current: key.defaultVaultId, allowedVaults: key.allowedVaults || [] })}
    <div style="margin-top:12px"><button class="btn primary" type="submit">保存默认 Vault</button></div>
  </form><div class="dsec"><h3>危险操作</h3><div class="danger-zone">
    <div class="dz"><div class="t"><b>删除 Key</b>使用此 Key 的程序将立即失去访问</div><a class="btn danger-o" href="${esc(tabHref({ id: key.id, confirm: "delete" }))}">删除…</a></div>
  </div></div>`}`;
  return drawer({
    title: model.keyName(key),
    subtitle: env ? "只读" : "",
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
  const list = q
    ? list0.filter((key) => `${key.label || ""} ${key.prefix || ""}`.toLowerCase().includes(q))
    : list0;
  const target = list0.find((key) => String(key.id) === selectedId) || null;

  const tableHtml = table(
    [["名称 / 前缀", "26%"], ["权限 · Vault", "26%"], ["最后调用", "20%"], ["来源", "12%"], ["创建", "10%"], ["", "", "act"]],
    list.map((key) => row(ctx, key, selectedId)),
    emptyState("key", "没有匹配的 Key", "换个关键词试试"),
  );

  const actions = createCta("新建 Key");
  const staleConfirm = confirm && !target
    ? `<div class="result err" role="status">${ic("alert")}<div>该 Key 不存在或已被删除，未执行任何操作。</div></div>`
    : "";
  const content = `${pageBar({ title: "API Key", count: list0.length, actions })}<div class="content scroll"><div class="page">
  <p class="lede">每个 Key 独立设置权限范围与可访问的 Vault。Key 明文只在创建时显示一次。</p>
  <div class="toolbar">${searchBox({ placeholder: "搜索备注或前缀", value: query.q, hidden: { tab: TAB } })}</div>
  ${staleConfirm}${tableHtml}${mcards(list.map((key) => card(ctx, key)))}
  </div></div>`;

  let detailPanel = "";
  if (confirm === "delete" && target) {
    const lastLine = target.lastUsedAt
      ? `最后调用：${esc(model.rel(target.lastUsedAt))}${target.lastUserAgent ? ` · UA ${esc(target.lastUserAgent)}` : ""}`
      : "最后调用：从未";
    detailPanel = confirmPage({
      title: `删除 Key「${model.keyName(target)}」？`,
      bodyHtml: `使用此 Key 的程序将立即无法访问（${lastLine}）。引用它的定时授权策略会变成孤立主体。`,
      typed: target.label || target.prefix || target.id,
      ok: "删除 Key",
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
        title: "Key 不存在",
        closeHref: tabHref({ q: query.q }),
        bodyHtml: `<div class="dsec">${emptyState("key", "Key 不存在或已删除", "")}</div>`,
      });
  }
  return { content, detailPanel };
}
