// SSR page primitives — the markup shapes the prototype builds in `5-render.js` (pageBar, search,
// table, mcards, emptyState, banner, drawer, modal, kv). Server-rendered equivalents of the
// prototype's scripted widgets live here: `<details>` row menus, POST forms as switches, `?id=`
// drawers and `?confirm=` modals, with the same class names so PROTO_CSS styles them unchanged.
import { esc, fut } from "./presentation/format.js";
import { ic } from "./assets/icons.js";

/** Prototype `pageBar`: 52px bar, `<h1>` + count, right-hand actions. The prototype's crumb is
 *  written as `<a class="crumbp">定时授权</a><span class="muted">›</span><span>新建策略</span>` — the
 *  separator and the title are their own elements, not one text run. */
export function pageBar({ title, count = null, crumb = null, actions = "" }) {
  const crumbHtml = crumb
    ? `<a class="crumbp" href="${esc(crumb.href)}">${esc(crumb.label)}</a><span class="muted">›</span><span>${esc(title)}</span>`
    : esc(title);
  const cnt = count === null || count === undefined ? "" : `<span class="cnt">${esc(String(count))}</span>`;
  return `<header class="bar"><h1>${crumbHtml}${cnt}</h1><span class="grow"></span>${actions}</header>`;
}

/**
 * GET search box — the prototype's own control, made submittable without script.
 *
 * The prototype renders `<label class="search">` + icon + input + `<kbd>/</kbd>` (`5-render.js:
 * searchBox`). The plane needs a real GET form (type a word, press Enter, the server renders the
 * filtered list) and the prototype has no pointer way to submit at all, so the SAME `<kbd>/</kbd>`
 * hint is carried by a real `button.kbd-hint[type=submit]`: the button is style-transparent (the
 * kbd renders exactly where the prototype draws it) and the shape gate treats it as transparent, so
 * the visible control is the prototype's hint. Without the button a touch operator could not filter
 * at all, and with it the filter works with scripting disabled as well.
 */
export function searchBox({ placeholder, value = "", name = "q", hidden = {}, label = "搜索", action = "/admin/auth", hint = true, formId = "" }) {
  const hiddenInputs = Object.entries(hidden).map(([key, item]) => `<input type="hidden" name="${esc(key)}" value="${esc(item)}">`).join("");
  const input = `<input name="${esc(name)}" placeholder="${esc(placeholder)}" value="${esc(value)}" aria-label="${esc(label)}"${formId ? ` form="${esc(formId)}"` : ""}>`;
  const hintButton = `<button class="kbd-hint" type="submit" title="搜索" aria-label="搜索"><kbd>/</kbd></button>`;
  const children = `${hiddenInputs}${ic("search")}${input}${hint ? hintButton : ""}`;
  // `formId` is for the case a filter has to live INSIDE another form (the policy editor's POST form
  // wraps its panels): HTML forbids nested forms, so the input is associated with a GET form that
  // sits outside instead — which is also how it stays usable with scripting disabled
  // (`searchForm()` below renders that companion form).
  return formId ? `<label class="search">${children}</label>` : `<form class="search" method="get" action="${esc(action)}">${children}</form>`;
}

/**
 * The companion GET form for a `searchBox({ formId })` — the panel's filter input belongs to it via
 * `form=` instead of being nested inside the page's POST form. Hidden fields carry the route state
 * (which policy is open), and the form holds exactly ONE visible field, so pressing Enter in the
 * filter submits it (implicit submission works with one blocking field, not with two).
 */
export function searchForm({ id, action, hidden = {} }) {
  const hiddenInputs = Object.entries(hidden).map(([key, item]) => `<input type="hidden" name="${esc(key)}" value="${esc(item)}">`).join("");
  return `<form class="inline-form" id="${esc(id)}" method="get" action="${esc(action)}">${hiddenInputs}</form>`;
}

/**
 * The prototype's `.switch`, as a control that works without script.
 *
 * The prototype paints the switch with a scripted `<button class="switch">` (`5-render.js`); the
 * plane may not script a control into existence (CSP `script-src 'self'`, and any action must
 * already work), so the same `.switch` box is a `<label>` wrapping the REAL checkbox that carries
 * the field: a click toggles the submitted value itself (`ssr-css.js` positions the input over the
 * box and `:has()` paints the on state). Hidden `offValue` first, checkbox second — the service
 * reads the last value, so an unchecked box still posts `false`, never a missing field.
 */
export function switchControl({ on, name, value = "true", offValue = "false", title, label = "" }) {
  const hidden = `<input type="hidden" name="${esc(name)}" value="${esc(offValue)}">`;
  const box = `<input type="checkbox" name="${esc(name)}" value="${esc(value)}"${on ? " checked" : ""} aria-label="${esc(title || label || name)}">`;
  return `<label class="switch${on ? " on" : ""}"${title ? ` title="${esc(title)}"` : ""}>${hidden}${box}${label ? `<span class="help">${esc(label)}</span>` : ""}</label>`;
}

/**
 * Row menu. `items` entries:
 *   { href, label, icon, danger } | { action, label, icon, danger, csrf, fields }
 *   { separator: true } | { label, icon, disabled: true, planned: true }
 * Rendered as `<details class="mn">` — no script, so the menu is opened by the browser itself.
 */
export function moreMenu(items, { label = "更多操作" } = {}) {
  const body = items.map((item) => {
    if (item.separator) return "<hr>";
    if (item.disabled) {
      return `<button type="button" disabled>${ic(item.icon || "chev")}<span>${esc(item.label)}</span>${item.planned ? fut() : ""}</button>`;
    }
    const cls = item.danger ? ' class="dz2"' : "";
    if (item.href) return `<a${cls} href="${esc(item.href)}">${ic(item.icon || "chev")}<span>${esc(item.label)}</span></a>`;
    const fields = Object.entries(item.fields || {}).map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`).join("");
    return `<form method="post" action="${esc(item.action)}"><input type="hidden" name="csrf" value="${esc(item.csrf || "")}">${fields}<button type="submit"${item.danger ? ' class="dz2"' : ""}>${ic(item.icon || "chev")}<span>${esc(item.label)}</span></button></form>`;
  }).join("");
  return `<details class="mn"><summary aria-label="${esc(label)}" title="${esc(label)}">${ic("more")}</summary><div class="menu" role="menu">${body}</div></details>`;
}

/** Prototype `table`: `cols` = [[label, width, cellClass]]. */
export function table(cols, rows, emptyHtml) {
  if (!rows.length) return `<div class="tw hide-m">${emptyHtml}</div>`;
  return `<div class="tw hide-m"><table class="tbl"><colgroup>${cols.map((col) => `<col${col[1] ? ` style="width:${esc(col[1])}"` : ""}>`).join("")}</colgroup><thead><tr>${cols.map((col) => `<th${col[2] ? ` class="${esc(col[2])}"` : ""}>${col[0]}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

/** Prototype `mcards`: mobile card list (CSS shows it below 720px). */
export function mcards(cards) {
  return cards.length ? `<div class="mcards">${cards.join("")}</div>` : "";
}

/** Prototype `emptyState`. */
export function emptyState(icon, title, desc, action = "") {
  return `<div class="empty"><div class="ic">${ic(icon)}</div><b>${esc(title)}</b><span>${esc(desc)}</span>${action}</div>`;
}

const BANNER_ICON = { amber: "alert", danger: "alert", acc: "info", "": "info" };

/** Prototype `.banner` (tone: "" | acc | amber | danger). */
export function banner(htmlBody, { tone = "", icon = null } = {}) {
  return `<div class="banner ${tone}">${ic(icon || BANNER_ICON[tone] || "info")}<div>${htmlBody}</div></div>`;
}

/** Server result line (the prototype shows a toast; a banner is the honest SSR form). */
export function result(ok, htmlBody) {
  return `<div class="result ${ok ? "ok" : "err"}" role="status">${ic(ok ? "checkc" : "alert")}<div>${htmlBody}</div></div>`;
}

/** Prototype `.kv` key/value card. `rows` = [[key, valueHtml, valueAttrs?]]. */
export function kv(rows) {
  return `<div class="kv">${rows.map(([key, value, attrs = ""]) => `<div class="k">${esc(key)}</div><div${attrs ? ` ${attrs}` : ""}>${value}</div>`).join("")}</div>`;
}

/** Prototype `.sect` + `.sect-h`. */
export function section(title, bodyHtml, { aside = "", id = "" } = {}) {
  return `<section class="sect"${id ? ` id="${esc(id)}"` : ""}><div class="sect-h"><h2>${esc(title)}</h2>${aside}</div>${bodyHtml}</section>`;
}

/** Detail drawer (`?id=` route). Rendered next to the list, exactly like the prototype's open state.
 *  `badges` is trusted HTML for the prototype's `.tag` markers next to the title (e.g. 已停用 / 只读).
 */
export function drawer({ title, subtitle = "", meta = "", badges = "", closeHref, bodyHtml, footHtml = "", id = "drawer" }) {
  const metaHtml = meta ? ` <span class="kind" style="border:0;padding:0;color:var(--tx3)">${esc(meta)}</span>` : "";
  return `<div class="scrim on" data-scrim></div><aside class="drawer on" id="${esc(id)}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="bar"><h1>${esc(title)}${metaHtml}${subtitle ? `<span class="cnt">${esc(subtitle)}</span>` : ""}${badges}</h1><span class="grow"></span><a class="ibtn" href="${esc(closeHref)}" aria-label="关闭">${ic("x")}</a></header><div class="dbody scroll">${bodyHtml}</div>${footHtml ? `<footer class="dfoot">${footHtml}</footer>` : ""}</aside>`;
}

/** Danger confirm page (prototype `.modal` state). */
let confirmFormSeq = 0;

/** Prototype `.modal` confirm box. */
export function confirmPage({ title, bodyHtml, listItems = [], typed = null, ok = "确认", tone = "danger", backHref, action, method = "post", csrf, fields = {}, extraHtml = "", formHtml = "", footnote = "" }) {
  const list = listItems.length ? `<ul>${listItems.map((item) => `<li>${item}</li>`).join("")}</ul>` : "";
  const fieldsHtml = Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`).join("");
  // Prototype order (6-app.js confirmBox): h3 · p · ul · extra · .tc · input · .acts — the typed input
  // is a direct child of `.modal`, ABOVE the button row, and the modal has exactly those children
  // (the JS-off gate compares them element by element). The input still belongs to the POST form via
  // the `form=` attribute, so a submission without JS carries the value; the server verifies it
  // (POST + CSRF + compare) and the submit button stays enabled.
  const formId = `cf${++confirmFormSeq}`;
  const typedHtml = typed
    ? `<div class="tc">输入 <code>${esc(typed)}</code> 以确认</div><input class="inp" name="confirm" form="${formId}" autocomplete="off" aria-label="确认输入" required>`
    : "";
  return `<div class="scrim on"></div><div class="modal show" role="alertdialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${bodyHtml ? `<p>${bodyHtml}</p>` : ""}${list}${extraHtml}${typedHtml}${footnote ? `<p class="tc">${footnote}</p>` : ""}<div class="acts"><a class="btn ghost" href="${esc(backHref)}">取消</a><form id="${formId}" method="${esc(method)}" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(csrf || "")}">${fieldsHtml}${formHtml}<button class="btn ${tone === "danger" ? "danger" : "primary"}" type="submit">${esc(ok)}</button></form></div></div>`;
}

/** Form-bearing toast-less switch (prototype `.switch`, driven by a real POST). */
export function switchForm({ on, action, csrf, fields = {}, title, label = "" }) {
  const hidden = Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`).join("");
  return `<form class="inline-form" method="post" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(csrf || "")}">${hidden}<button class="switch${on ? " on" : ""}" type="submit" title="${esc(title)}" aria-label="${esc(title)}" aria-pressed="${on ? "true" : "false"}"></button>${label ? `<span class="help">${esc(label)}</span>` : ""}</form>`;
}

/** Single-button POST form (row actions). */
export function postForm({ action, csrf, fields = {}, label, cls = "btn", icon = null, title = "" }) {
  const hidden = Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`).join("");
  return `<form class="inline-form" method="post" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(csrf || "")}">${hidden}<button class="${esc(cls)}" type="submit"${title ? ` title="${esc(title)}"` : ""}>${icon ? ic(icon) : ""}${esc(label)}</button></form>`;
}

/** Segmented control (status tabs). `items` = [{ label, count, href, on }]. */
export function seg(items) {
  return `<div class="seg">${items.map((item) => `<a href="${esc(item.href)}"${item.on ? ' class="on" aria-current="page"' : ""}>${esc(item.label)}${item.count === undefined || item.count === null ? "" : `<span class="n">${esc(String(item.count))}</span>`}</a>`).join("")}</div>`;
}

/**
 * Pagination — prototype `.pager`: 共 N 条 · `.grow` · 每页 select · `.pg` with ‹ / pages / ›.
 * The prototype renders EVERY page button and keeps ‹/› present but `disabled` at the ends; a pager
 * that only renders the reachable controls (or a page window) is a different shape, so this helper
 * follows the prototype exactly. `hrefFor(target, size)` may return a page-size URL for the 每页
 * control (a GET form when JS is off); without it the control is omitted.
 */
export function pager({ total, page, pageSize, hrefFor, pageSizes = [], hrefForSize = null }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const item = (target, label, { on = false, disabled = false } = {}) => {
    if (disabled) return `<button type="button" disabled>${esc(label)}</button>`;
    if (on) return `<span class="on" aria-current="page">${esc(label)}</span>`;
    return `<a href="${esc(hrefFor(target))}">${esc(label)}</a>`;
  };
  const parts = [item(page - 1, "‹", { disabled: page <= 1 })];
  for (let current = 1; current <= pages; current += 1) parts.push(item(current, String(current), { on: current === page }));
  parts.push(item(page + 1, "›", { disabled: page >= pages }));
  const sizes = pageSizes.length && hrefForSize
    ? `<form class="inline-form" method="get" action="${esc(hrefForSize.action)}">${(hrefForSize.hidden || []).map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(String(value))}">`).join("")}<label>每页 <select class="sel sm" name="pageSize" aria-label="每页条数">${pageSizes.map((size) => `<option value="${size}"${Number(size) === Number(pageSize) ? " selected" : ""}>${size}</option>`).join("")}</select></label><button class="btn ghost sm" type="submit">应用</button></form>`
    : "";
  return `<div class="pager"><span>共 ${esc(String(total))} 条</span><span class="grow"></span>${sizes}<div class="pg">${parts.join("")}</div></div>`;
}

/** Prototype `.fld` field wrapper. */
export function field(label, controlHtml, { hint = "", required = false } = {}) {
  return `<div class="fld">${label ? `<label>${esc(label)}${required ? "" : ""}</label>` : ""}${controlHtml}${hint ? `<small class="help">${hint}</small>` : ""}</div>`;
}

/** Capability/checkbox row used by the pickers and drawer forms. */
export function checkRow({ name, value, checked, title, detail = "", multi = true, mono = null }) {
  return `<label class="chk"><input type="${multi ? "checkbox" : "radio"}" name="${esc(name)}" value="${esc(value)}"${checked ? " checked" : ""}><span><b>${esc(title)}</b>${detail ? `<span class="d">${detail}</span>` : ""}${mono ? `<span class="d mono">${esc(mono)}</span>` : ""}</span></label>`;
}

export { esc, fut, ic };
