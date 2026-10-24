// Admin shell — server-rendered from the prototype's own markup vocabulary
// (`docs/admin-ui-proto/src/6-app.js`: sidebar / pageBar / mnav). Class names, icon names and
// group order come from the prototype; the data (counts, attention dots, release label) comes from
// the real service snapshot.
//
// No-JS notes (D0 = HOLD, CSP has no `script-src`):
//   * the prototype's theme toggle, keyboard-shortcut panel and toast are script-driven. The theme
//     toggle is a POST form here (it is a server state: the cookie), the shortcut button opens the
//     panel through the same `?` handler the client module already registers (`admin-feature-keys`),
//     so the sidebar keeps the prototype's three footer controls, and results are rendered as
//     `.result` lines.
import { PROTO_CSS } from "./assets/proto-css.js";
import { ADMIN_SSR_CSS } from "./assets/ssr-css.js";
import { ICON_SPRITE, ic } from "./assets/icons.js";
import { esc } from "./presentation/format.js";

const WEB_HREF = "/app/";

/** Prototype `NAV`: [id, label, icon, hotkey] with `null` group separators. The first entry of the
 *  prototype's list is 概览 — there is NO group heading above it (the first `.sec-h` is 身份与凭据),
 *  and 概览/审计 carry no count (the prototype's count map has no entry for either). Both facts are
 *  markup, not decoration: an extra leading `.sec-h` pushed the whole column down by one 44px item. */
export const NAV = Object.freeze([
  Object.freeze({ id: "overview", label: "概览", icon: "home", hotkey: "o", group: "home" }),
  Object.freeze({ group: "身份与凭据" }),
  Object.freeze({ id: "accounts", label: "OAuth 账户", icon: "user", hotkey: "a", group: "identity", countKey: "accounts" }),
  Object.freeze({ id: "keys", label: "API Key", icon: "key", hotkey: "k", group: "identity", countKey: "keys" }),
  Object.freeze({ id: "clients", label: "OAuth 客户端", icon: "app", hotkey: "c", group: "identity", countKey: "clients", attentionKey: "clients" }),
  Object.freeze({ id: "tokens", label: "OAuth Token", icon: "ticket", hotkey: "t", group: "identity", countKey: "tokens" }),
  Object.freeze({ group: "内容与安全" }),
  Object.freeze({ id: "publishes", label: "发布文档", icon: "globe", hotkey: "p", group: "content", countKey: "publishes" }),
  Object.freeze({ id: "audit", label: "审计", icon: "list", hotkey: "u", group: "content", attentionKey: "audit" }),
  Object.freeze({ id: "access-policy", label: "定时授权", icon: "cal", hotkey: "z", group: "content", countKey: "authz" }),
  Object.freeze({ group: "系统" }),
  Object.freeze({ id: "vault-git", label: "Vault 与 Git", icon: "db", hotkey: "v", group: "system", countKey: "vaults" }),
]);

const MOBILE_PRIMARY = Object.freeze(["overview", "tokens", "audit", "access-policy"]);

function hrefFor(item, { accessPolicyBase, vaultGitBase }) {
  if (item.id === "access-policy") return accessPolicyBase || "/admin/auth";
  if (item.id === "vault-git") return vaultGitBase || "/admin/auth";
  return `/admin/auth?tab=${item.id}`;
}

/**
 * A page whose service was not injected is not offered at all. Both navs read this: the sidebar
 * already dropped the item, but the mobile `更多` sheet used to keep a link that fell back to
 * `/admin/auth` — a dead affordance for a route that is not registered (both route modules return
 * `null` without their service and document the tab as "absent").
 */
function navAvailable(item, bases) {
  if (item.id === "access-policy") return Boolean(bases.accessPolicyBase);
  if (item.id === "vault-git") return Boolean(bases.vaultGitBase);
  return true;
}

function itemHtml(item, activeTab, counts, attention, bases) {
  const avail = navAvailable(item, bases);
  if (!avail) return "";
  const on = activeTab === item.id;
  const count = item.countKey ? counts[item.countKey] : null;
  // The prototype always writes the count slot (`<span class="cnt">${cnt ?? ""}</span>`, 6-app.js
  // `sidebar()`), even for the items that have no count: 概览 and 审计 keep an empty `.cnt`. That is
  // a shape fact — the row's box is identical across items — so it is reproduced rather than
  // dropped when the value is unknown.
  const cnt = `<span class="cnt">${count == null ? "" : esc(String(count))}</span>`;
  const dotKind = item.attentionKey ? attention[item.attentionKey] : null;
  const dot = dotKind
    ? `<span class="dot ${dotKind === "danger" ? "danger" : "amber"}" title="${esc(attention[`${item.attentionKey}Title`] || "")}"></span>`
    : "";
  return `<a class="ni${on ? " on" : ""}" href="${esc(hrefFor(item, bases))}"${on ? ' aria-current="page"' : ""}${item.hotkey ? ` data-hotkey="${esc(item.hotkey)}"` : ""}>${ic(item.icon)}<span class="lbl">${esc(item.label)}</span>${dot}${cnt}</a>`;
}

/** Sidebar (`.side`): brand, grouped nav with counts/attention, footer actions. */
export function renderSidebar({ activeTab, counts = {}, attention = {}, accessPolicyBase = null, vaultGitBase = null, theme = "dark", csrf = "", version = null, navOpen = false, navCloseHref = null }) {
  const bases = { accessPolicyBase, vaultGitBase };
  const nav = NAV.map((item) => {
    if (item.group !== undefined && !item.id) return `<div class="sec-h">${esc(item.group)}</div>`;
    return itemHtml(item, activeTab, counts, attention, bases);
  }).join("");
  const themeNext = theme === "dark" ? "light" : "dark";
  const themeTitle = theme === "dark" ? "切换到浅色主题" : "切换到深色主题";
  const foot = `<div class="side-foot">
  <a class="ni" href="${WEB_HREF}" title="进入 Obsidian Web" style="flex:1">${ic("ext")}<span class="lbl">进入 Obsidian Web</span></a>
  <form class="inline-form" method="post" action="/admin/auth/theme"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="theme" value="${esc(themeNext)}"><button class="ibtn" type="submit" title="${esc(themeTitle)}" aria-label="${esc(themeTitle)}">${ic(theme === "dark" ? "sun" : "moon")}</button></form>
  <button class="ibtn kbd-button" type="button" title="快捷键 (?) /?/" aria-label="键盘快捷键">${ic("kbd")}</button>
  <form class="inline-form" method="post" action="/admin/auth/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ibtn" type="submit" title="退出登录" aria-label="退出登录">${ic("out")}</button></form>
</div>`;
  const side = `<aside class="side${navOpen ? " nav-open" : ""}" id="admin-nav"${navOpen ? ' role="dialog" aria-label="主导航"' : ""}><div class="bar brand"><a class="ibtn nav-close" href="${esc(navCloseHref || "/admin/auth")}" data-nav-close aria-label="关闭菜单">${ic("x")}</a><svg class="logo" aria-hidden="true"><use href="#logo"/></svg><b>Obsidian MCP</b><span>授权管理</span></div><nav class="side-body scroll" aria-label="授权管理">${nav}</nav>${foot}</aside>`;
  return { side, foot };
}

/** Mobile bottom nav (`.mnav`): four primary slots + a `更多` sheet with the rest. */
export function renderMnav({ activeTab, counts = {}, attention = {}, accessPolicyBase = null, vaultGitBase = null }) {
  const bases = { accessPolicyBase, vaultGitBase };
  const primary = NAV.filter((item) => item.id && MOBILE_PRIMARY.includes(item.id) && navAvailable(item, bases));
  const rest = NAV.filter((item) => item.id && !MOBILE_PRIMARY.includes(item.id) && navAvailable(item, bases));
  const inRest = rest.some((item) => item.id === activeTab);
  const links = primary.map((item) => {
    const on = activeTab === item.id || (item.id === "overview" && activeTab === "overview");
    return `<a href="${esc(hrefFor(item, bases))}"${on ? ' class="on" aria-current="page"' : ""}>${ic(item.icon)}${esc(item.id === "access-policy" ? "定时" : item.id === "tokens" ? "Token" : item.label)}</a>`;
  }).join("");
  const moreLinks = rest.map((item) => `<a class="ni${activeTab === item.id ? " on" : ""}" href="${esc(hrefFor(item, bases))}">${ic(item.icon)}<span class="lbl">${esc(item.label)}</span>${item.countKey && counts[item.countKey] != null ? `<span class="cnt">${esc(String(counts[item.countKey]))}</span>` : ""}</a>`).join("");
  return `<nav class="mnav" aria-label="移动导航">${links}<details class="mmore"><summary>${ic("menu")}更多</summary><div class="menu">${moreLinks}</div></details></nav>`;
}

/** Full document (head + prototype stylesheet + icon sprite + optional same-origin enhancement script). */
export function renderDocument({ title, theme = "dark", bodyHtml, scripts = [], bodyClass = "" }) {
  const themeAttr = theme === "light" ? "light" : "dark";
  const themeColor = themeAttr === "light" ? "#ffffff" : "#101318";
  // Only same-origin, external scripts: the CSP is `script-src 'self'` with no inline and no eval,
  // and the markup stays fully usable when the script never loads.
  const scriptTags = scripts.map((src) => `<script type="module" src="${esc(src)}"></script>`).join("");
  return `<!doctype html><html lang="zh-CN" data-theme="${themeAttr}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="${themeColor}"><title>${esc(title)}</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>${PROTO_CSS}${ADMIN_SSR_CSS}</style></head><body${bodyClass ? ` class="${esc(bodyClass)}"` : ""}>${ICON_SPRITE}${bodyHtml}${scriptTags}</body></html>`;
}

/**
 * The narrow-screen menu control (Q10 — a user-decided DESIGN ADDITION, 2026-10-18).
 *
 * Without script it is a real link to the server's own open state (`?nav=1`), which renders the
 * sidebar as an overlay with a scrim and a close link back to the current URL; with the script it
 * opens the same overlay in place. It is `.mobile-only`, i.e. `display:none` above the plane's own
 * 720px breakpoint, so the wide layout carries no extra control and the 1440 shape comparison does
 * not see it (hidden-by-style nodes take no part on either side).
 */
function navToggle({ open, href }) {
  return `<a class="ibtn mobile-only nav-toggle" href="${esc(href)}" data-nav-toggle aria-label="菜单" aria-controls="admin-nav" aria-expanded="${open ? "true" : "false"}">${ic("menu")}</a>`;
}

/** Authenticated app frame: sidebar + main + mobile nav (+ optional detail drawer). */
export function renderAppShell({ activeTab, content, notices = "", theme = "dark", counts = {}, attention = {}, accessPolicyBase = null, vaultGitBase = null, csrf = "", version = null, drawerHtml = "", nav = null }) {
  const navOpen = Boolean(nav?.open);
  const navHref = nav?.href || null;
  const navCloseHref = nav?.closeHref || null;
  const { side } = renderSidebar({
    activeTab, counts, attention, accessPolicyBase, vaultGitBase, theme, csrf, version,
    navCloseHref, navOpen,
  });
  const mnav = renderMnav({ activeTab, counts, attention, accessPolicyBase, vaultGitBase });
  // `data-tab` lets the enhancement script know which page it is on (prototype `S.route`); the nav
  // links carry `data-hotkey` for the `g <key>` jumps. Both are inert without the script.
  const scrim = navOpen ? '<div class="scrim on" id="mscrim" data-nav-scrim></div>' : "";
  const toggle = navHref ? navToggle({ open: navOpen, href: navOpen ? navCloseHref : navHref }) : "";
  return `<div class="app" data-tab="${esc(activeTab)}">${scrim}${side}<main class="main">${toggle}${notices}${content}</main></div>${mnav}${drawerHtml}`;
}
