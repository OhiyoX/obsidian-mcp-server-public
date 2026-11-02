// Login and out-of-band pages — the prototype's `.login` box (`5-render.js renderLogin`) rendered as
// a plain POST form. No script (D0 HOLD), so the prototype's show/hide password button is not
// rendered: a dead toggle would be a fake affordance. Everything else — markup, copy, layout — is
// the prototype's.
import { deployedVersion } from "../../release-version.js";
import { esc } from "../presentation/format.js";
import { ic } from "../assets/icons.js";
import { renderDocument } from "../layout.js";
import { t } from "../../i18n/context.js";

const WEB_HREF = "/app/";

function version() {
  try {
    return deployedVersion()?.version || "—";
  } catch {
    return "—";
  }
}

function box(inner) {
  return `<div class="login"><form class="box" method="post" action="/admin/auth/login">${inner}</form></div>`;
}

function heading() {
  return `<h1><svg class="logo" style="width:28px;height:28px" aria-hidden="true"><use href="#logo"/></svg>${esc(t("adm.login.heading"))}</h1>`;
}

function foot() {
  return `<div class="foot"><span>${esc(t("adm.foot.deployVersion"))} <span class="mono">${esc(version())}</span></span><a href="${WEB_HREF}">${esc(t("adm.side.web"))} ${ic("ext", "xs")}</a></div>`;
}

const PASSWORD_FIELD = (disabled) => `<div class="fld"><label for="pw">${esc(t("adm.login.password"))}</label><div class="pw"><input class="inp" id="pw" name="password" type="password"${disabled ? "" : ' autocomplete="current-password" required'} style="height:40px"${disabled ? "" : " autofocus"}></div>`;

export function renderLoginPage({ theme = "dark" } = {}) {
  // The emphasis on "不接受" stays its own element (the prototype's `<b class="tx2">`), so the
  // sentence is three catalog fragments rather than one value carrying markup.
  const inner = `${heading()}
${PASSWORD_FIELD(false)}</div>
<button class="btn primary" type="submit">${esc(t("adm.login.submit"))}</button>
<p class="help" style="margin:0">${esc(t("adm.login.help.before"))}<b class="tx2" style="font-weight:600">${esc(t("adm.login.help.reject"))}</b>${esc(t("adm.login.help.after"))}</p>
${foot()}`;
  return renderDocument({ title: t("adm.login.title"), theme, bodyHtml: box(inner) });
}

export function renderLoginLocked({ retryAfterSeconds = 0, formatLockRemaining, theme = "dark" } = {}) {
  const remaining = typeof formatLockRemaining === "function" ? formatLockRemaining(retryAfterSeconds) : t("login.error.waitMinutes", { minutes: Math.ceil(retryAfterSeconds / 60) });
  const inner = `${heading()}
${PASSWORD_FIELD(true)}
<span class="lock-note">${esc(t("adm.login.locked", { wait: remaining }))}</span></div>
<button class="btn primary" type="submit" disabled>${esc(t("adm.login.submit"))}</button>
${foot()}`;
  return renderDocument({ title: t("adm.login.lockedTitle"), theme, bodyHtml: box(inner) });
}

export function renderLoginFailure({ theme = "dark" } = {}) {
  const inner = `${heading()}
${PASSWORD_FIELD(false)}
<span class="lock-note">${esc(t("adm.login.wrongPassword"))}</span></div>
<button class="btn primary" type="submit">${esc(t("adm.login.submit"))}</button>
${foot()}`;
  return renderDocument({ title: t("adm.login.failedTitle"), theme, bodyHtml: box(inner) });
}

export function renderCsrfRejected({ theme = "dark" } = {}) {
  return renderDocument({
    title: t("adm.csrf.title"),
    theme,
    bodyHtml: `<div class="login"><div class="box">${heading()}<p class="help" style="margin:0">${esc(t("adm.csrf.message"))}</p><a class="btn primary" href="/admin/auth">${esc(t("adm.back.admin"))}</a></div></div>`,
  });
}

export function renderError({ title = t("adm.error.title"), heading: head = t("adm.error.title"), message = "", theme = "dark", backHref = "/admin/auth", backLabel = t("adm.back.admin") } = {}) {
  return renderDocument({
    title: `${title} · Obsidian MCP`,
    theme,
    bodyHtml: `<div class="login"><div class="box">${heading()}<h2 style="margin:0;font-size:16px">${esc(head)}</h2><p class="help" style="margin:0">${esc(message)}</p><a class="btn primary" href="${esc(backHref)}">${esc(backLabel)}</a></div></div>`,
  });
}
