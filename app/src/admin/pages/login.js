// Login and out-of-band pages — the prototype's `.login` box (`5-render.js renderLogin`) rendered as
// a plain POST form. No script (D0 HOLD), so the prototype's show/hide password button is not
// rendered: a dead toggle would be a fake affordance. Everything else — markup, copy, layout — is
// the prototype's.
import { deployedVersion } from "../../release-version.js";
import { esc } from "../presentation/format.js";
import { ic } from "../assets/icons.js";
import { renderDocument } from "../layout.js";

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
  return `<h1><svg class="logo" style="width:28px;height:28px" aria-hidden="true"><use href="#logo"/></svg>Obsidian MCP 授权管理</h1>`;
}

function foot() {
  return `<div class="foot"><span>部署版本 <span class="mono">${esc(version())}</span></span><a href="${WEB_HREF}">进入 Obsidian Web ${ic("ext", "xs")}</a></div>`;
}

export function renderLoginPage({ theme = "dark" } = {}) {
  const inner = `${heading()}
<div class="fld"><label for="pw">管理密码</label><div class="pw"><input class="inp" id="pw" name="password" type="password" autocomplete="current-password" required style="height:40px" autofocus></div></div>
<button class="btn primary" type="submit">登录</button>
<p class="help" style="margin:0">这里使用独立的管理密码，<b class="tx2" style="font-weight:600">不接受</b> OAuth 账户密码、API Key 或 Token。</p>
${foot()}`;
  return renderDocument({ title: "Obsidian MCP · 授权管理", theme, bodyHtml: box(inner) });
}

export function renderLoginLocked({ retryAfterSeconds = 0, formatLockRemaining, theme = "dark" } = {}) {
  const remaining = typeof formatLockRemaining === "function" ? formatLockRemaining(retryAfterSeconds) : `${Math.ceil(retryAfterSeconds / 60)} 分钟`;
  const inner = `${heading()}
<div class="fld"><label for="pw">管理密码</label><div class="pw"><input class="inp" id="pw" name="password" type="password" disabled style="height:40px"></div>
<span class="lock-note">连续失败次数过多，已临时锁定，请 ${esc(remaining)}后再试。</span></div>
<button class="btn primary" type="submit" disabled>登录</button>
${foot()}`;
  return renderDocument({ title: "尝试过多 · Obsidian MCP", theme, bodyHtml: box(inner) });
}

export function renderLoginFailure({ theme = "dark" } = {}) {
  const inner = `${heading()}
<div class="fld"><label for="pw">管理密码</label><div class="pw"><input class="inp" id="pw" name="password" type="password" autocomplete="current-password" required style="height:40px" autofocus></div>
<span class="lock-note">密码不正确。</span></div>
<button class="btn primary" type="submit">登录</button>
${foot()}`;
  return renderDocument({ title: "登录失败 · Obsidian MCP", theme, bodyHtml: box(inner) });
}

export function renderCsrfRejected({ theme = "dark" } = {}) {
  return renderDocument({
    title: "请求被拒绝 · Obsidian MCP",
    theme,
    bodyHtml: `<div class="login"><div class="box">${heading()}<p class="help" style="margin:0">CSRF 校验失败：本次请求未被接受，未发生任何写入。请返回管理页面重新操作。</p><a class="btn primary" href="/admin/auth">返回授权管理</a></div></div>`,
  });
}

export function renderError({ title = "出错了", heading: head = "出错了", message = "", theme = "dark", backHref = "/admin/auth", backLabel = "返回授权管理" } = {}) {
  return renderDocument({
    title: `${title} · Obsidian MCP`,
    theme,
    bodyHtml: `<div class="login"><div class="box">${heading()}<h2 style="margin:0;font-size:16px">${esc(head)}</h2><p class="help" style="margin:0">${esc(message)}</p><a class="btn primary" href="${esc(backHref)}">${esc(backLabel)}</a></div></div>`,
  });
}
