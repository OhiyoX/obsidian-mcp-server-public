// Admin UI v2 W1–W3: shared SSR bits — Chinese scopes, empty states, search kbd, row link.
// D0 external JS = HOLD.

import { escapeHtml, escapeAttr } from "./presentation/forms.js";
import { presentIdentity } from "./presentation/identity.js";
import { icon, futBadge } from "./icons.js";

export { futBadge };

const SCOPE_LABELS = Object.freeze({
  "obsidian.read": "读取",
  "obsidian.write": "写入",
  "obsidian.files": "文件",
});

const ALL_SCOPES = Object.freeze(["obsidian.read", "obsidian.write", "obsidian.files"]);

export function scopeLabel(key) {
  return SCOPE_LABELS[key] || key;
}

export function scopeTags(scopes = []) {
  const list = Array.isArray(scopes) ? scopes : [];
  if (!list.length) return `<span class="muted">—</span>`;
  if (ALL_SCOPES.every((s) => list.includes(s)) && list.length >= 3) {
    return `<div class="tags"><span class="tag">全部权限</span></div>`;
  }
  return `<div class="tags">${list.map((s) => `<span class="tag" title="${escapeAttr(s)}">${escapeHtml(scopeLabel(s))}</span>`).join("")}</div>`;
}

export function vaultTags(vaultIds = [], vaults = []) {
  const list = Array.isArray(vaultIds) ? vaultIds : [];
  if (!list.length) return `<span class="muted">—</span>`;
  const byId = new Map((vaults || []).map((v) => [String(v.id), v]));
  return `<div class="tags">${list.map((id) => {
    const v = byId.get(String(id));
    const label = v?.name || id;
    return `<span class="tag acc" title="${escapeAttr(id)}">${escapeHtml(label)}</span>`;
  }).join("")}</div>`;
}

export function identityCell(opts) {
  const idn = presentIdentity(opts);
  const nameClass = idn.isUnnamed || idn.isDeleted ? "identity-unnamed" : "";
  const subParts = [];
  if (opts.secondaryHtml) subParts.push(opts.secondaryHtml);
  else if (opts.secondary) subParts.push(`<span class="mono">${escapeHtml(opts.secondary)}</span>`);
  if (idn.shortId) subParts.push(`<span class="idc" title="${escapeAttr(idn.fullId)}">${escapeHtml(idn.shortId)}</span>`);
  const sub = subParts.length ? `<span class="sub2">${subParts.join("")}</span>` : "";
  const nameTag = nameClass
    ? `<strong class="${nameClass}">${escapeHtml(idn.displayName)}</strong>`
    : `<strong>${escapeHtml(idn.displayName)}</strong>`;
  return `<div class="nm">${nameTag}${sub}</div>`;
}

export function statusPill({ ok, okLabel = "有效", offLabel = "已停用" }) {
  if (ok) return `<span class="st ok"><span class="dot"></span>${escapeHtml(okLabel)}</span>`;
  return `<span class="st off"><span class="dot"></span>${escapeHtml(offLabel)}</span>`;
}

/** SSR row action menu — native <details>, no script. */
export function rowMenu(innerHtml) {
  return `<details class="row-menu"><summary class="ibtn" aria-label="更多操作">⋯</summary><div class="row-menu-panel">${innerHtml}</div></details>`;
}

export function pageLede(text) {
  return `<p class="page-lede">${escapeHtml(text)}</p>`;
}

export function pageHead(title, { count = null, actionsHtml = "", hideTitle = true } = {}) {
  // Under app shell the topbar already shows the page title (+ count). page-head
  // keeps CTA / extras only (S2). A sr-only h2 keeps the page name in the document
  // for a11y/tests. Pass hideTitle:false for standalone surfaces.
  const cnt = count != null && count !== "" ? ` <span class="cnt">${escapeHtml(String(count))}</span>` : "";
  const actions = actionsHtml ? `<div class="actions">${actionsHtml}</div>` : "";
  const sr = title ? `<h2 class="sr-only">${escapeHtml(title)}</h2>` : "";
  if (hideTitle) {
    if (!actionsHtml && count == null && !title) return "";
    return `<div class="page-head page-head-actions">${sr}${actions || (cnt ? `<span class="cnt">${escapeHtml(String(count))}</span>` : "")}</div>`;
  }
  return `<div class="page-head"><h2>${escapeHtml(title)}${cnt}</h2>${actions}</div>`;
}

/** GET search toolbar — magnifier + <kbd>/</kbd> visual (shortcut needs W7). */
export function searchToolbar({ action, name = "q", value = "", placeholder = "搜索", hidden = {} }) {
  const hiddens = Object.entries(hidden || {})
    .map(([k, v]) => `<input type="hidden" name="${escapeAttr(k)}" value="${escapeAttr(String(v ?? ""))}">`)
    .join("");
  return `<div class="toolbar"><form class="search" method="get" action="${escapeAttr(action)}" role="search">${hiddens}${icon("search")}<input class="field" type="search" name="${escapeAttr(name)}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" maxlength="120"><kbd>/</kbd></form></div>`;
}

/** Proto emptyState: icon + title + desc + optional CTA. */
export function emptyState({ icon: icn = "info", title, desc = "", ctaHtml = "" }) {
  return `<div class="empty"><div class="empty-ic">${icon(icn)}</div><b>${escapeHtml(title)}</b>${desc ? `<p class="muted">${escapeHtml(desc)}</p>` : ""}${ctaHtml}</div>`;
}

export function emptyTableRow(colspan, opts) {
  return `<tr class="empty-row"><td colspan="${colspan}">${emptyState(opts)}</td></tr>`;
}

/** Scope checkboxes with Chinese visible labels (value stays obsidian.*). */
export function scopeCheckboxes(selected = [], name = "allowedScope") {
  return ALL_SCOPES.map((scope) => {
    const checked = selected.includes(scope) ? "checked" : "";
    return `<label class="scope-option"><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(scope)}" ${checked}><span>${escapeHtml(scopeLabel(scope))} <small class="mono muted">${escapeHtml(scope)}</small></span></label>`;
  }).join("");
}
