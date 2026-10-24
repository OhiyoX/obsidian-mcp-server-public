// Admin UI v2 W3: Option B SSR right detail panel (?id= / ?create=1).
// Not a JS #drawer — close = link without id. D0 HOLD.

import { escapeHtml, escapeAttr } from "./presentation/forms.js";
import { icon, futBadge } from "./icons.js";

/** Wrap panel chrome: head + body. closeHref clears selection. */
export function renderDetailPanel({ title, tagsHtml = "", bodyHtml, closeHref, widthClass = "drawer-w" }) {
  const close = closeHref
    ? `<a class="ibtn panel-close" href="${escapeAttr(closeHref)}" title="关闭" aria-label="关闭">${icon("x")}</a>`
    : "";
  return `<aside class="detail-panel ${widthClass}" aria-label="详情"><div class="panel-head"><div class="panel-title"><h2>${escapeHtml(title)}</h2>${tagsHtml}</div>${close}</div><div class="panel-body scroll">${bodyHtml}</div></aside>`;
}

export function panelKv(rows) {
  return `<div class="kv">${rows.map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div>${v}</div>`).join("")}</div>`;
}

export function panelSection(title, inner, { className = "" } = {}) {
  const h = title ? `<h3>${escapeHtml(title)}</h3>` : "";
  return `<section class="dsec ${className}">${h}${inner}</section>`;
}

export function amberBanner(html) {
  return `<div class="banner amber">${icon("alert")}<div>${html}</div></div>`;
}

export function infoBanner(html) {
  return `<div class="banner">${icon("info")}<div>${html}</div></div>`;
}

export function dangerZone(items) {
  const rows = items.map((it) => `<div class="dz"><div class="t"><b>${escapeHtml(it.title)}</b>${it.desc ? `<span class="help">${escapeHtml(it.desc)}</span>` : ""}</div>${it.actionHtml}</div>`).join("");
  return `<div class="danger-zone">${rows}</div>`;
}

export function futBox(innerHtml) {
  return `<div class="futonly futbox">${innerHtml}</div>`;
}

export function closeTabHref(tab, extra = {}) {
  const params = new URLSearchParams({ tab, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null && v !== "")) });
  params.delete("id");
  params.delete("create");
  params.delete("mode");
  return `/admin/auth?${params.toString()}`;
}

export function openTabHref(tab, id, extra = {}) {
  const params = new URLSearchParams({ tab, id: String(id), ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null && v !== "")) });
  return `/admin/auth?${params.toString()}`;
}
