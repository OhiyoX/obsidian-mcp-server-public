// Bilingual render contract for the Web documents (login / workspace / Publish).
//
// Two things are pinned here:
//   * the default (`zh-CN`) render still carries the exact copy the pre-i18n
//     literals had — i18n must not silently reword the Chinese UI;
//   * the `en` render is not a half-translation: the shell chrome, the settings
//     dialog and the login copy all come from the English catalog, and the document
//     language attribute follows the chosen locale (that is what the browser
//     translator reads back, so a mismatch would desync the client).
import test from "node:test";
import assert from "node:assert/strict";
import { appPage, loginPage, publishPage } from "../src/app/pages.js";
import { catalogFor } from "../src/i18n/index.js";
import { lockoutLoginError, lockoutLoginMessage, formatLockRemaining } from "../src/login-lockout.js";

const session = { username: "owner", displayName: "Owner", csrf: "csrf-token" };
const zh = catalogFor("zh-CN");
const en = catalogFor("en");

test("the login page renders in the requested language and keeps its default", () => {
  const zhPage = loginPage("", {}, "/app/");
  assert.match(zhPage, /<html lang="zh-CN"/);
  assert.match(zhPage, new RegExp(`<title>${zh["login.title"]}</title>`));
  assert.match(zhPage, /<p>使用 Obsidian 账户登录。/);
  assert.match(zhPage, /<button type="submit">登录<\/button>/);

  const enPage = loginPage("", {}, "/app/", "en");
  assert.match(enPage, /<html lang="en"/);
  assert.match(enPage, /<title>Sign in · Obsidian Web<\/title>/);
  assert.match(enPage, /<button type="submit">Sign in<\/button>/);
  assert.doesNotMatch(enPage, /[\u4e00-\u9fff]/, "the English login page must not leak Chinese copy");
});

test("login errors are looked up per request instead of being pre-rendered", () => {
  assert.match(loginPage("login.error.invalidCredentials", {}, "/app/", "en"), /Incorrect username, password or account permissions\./);
  assert.match(loginPage("login.error.noVault", {}, "/app/", "en"), /This account has no Vault assigned yet\./);
  assert.match(loginPage("login.error.invalidCredentials"), /用户名、密码或账户权限不正确。/);
  const locked = loginPage(lockoutLoginError(90, "en"), {}, "/app/", "en");
  assert.match(locked, /Too many sign-in attempts\. Try again in 2 min\./);
  const lockedZh = loginPage(lockoutLoginError(90), {}, "/app/");
  assert.match(lockedZh, /登录尝试过多，请 2 分钟后再试。/);
});

test("lockout copy keeps its historic Chinese strings as the default", () => {
  assert.equal(formatLockRemaining(900), "15 分钟");
  assert.equal(formatLockRemaining(59), "59 秒");
  assert.equal(lockoutLoginMessage(900), "登录尝试过多，请 15 分钟后再试。");
  assert.equal(formatLockRemaining(900, "en"), "15 min");
  assert.equal(formatLockRemaining(59, "en"), "59 s");
  assert.equal(lockoutLoginMessage(900, "en"), "Too many sign-in attempts. Try again in 15 min.");
});

test("the workspace shell is fully translated and announces its locale", () => {
  const enPage = appPage(session, {}, null, null, null, { locale: "en" });
  assert.match(enPage, /<html lang="en"[^>]*data-ui-locale="en"/);
  for (const key of ["shell.ribbon.toggleFiles", "shell.topbar.noNote", "search.placeholder", "context.outline", "settings.title", "explorer.sort.nameAsc"]) {
    assert.ok(enPage.includes(en[key]), `missing English copy for ${key}`);
    assert.ok(!enPage.includes(zh[key]), `the English shell still carries the Chinese copy of ${key}`);
  }
  // The language switch lists every choice in its own language, so those two labels
  // are the only intended Chinese text on an English page.
  assert.match(enPage, /<option value="zh-CN" selected>简体中文<\/option>/);
  assert.match(enPage, /<option value="zh-CN" selected>简体中文<\/option>/);
  assert.match(enPage, /<option value="en">English<\/option>/);
  const stripped = enPage.replace(/<option value="zh-CN"(?: selected)?>简体中文<\/option>/g, "");
  assert.doesNotMatch(stripped, /[\u4e00-\u9fff]/, "an untranslated label escaped into the English shell");
});

test("the default workspace shell keeps its historic Chinese copy", () => {
  const page = appPage(session, { colorMode: "dark", themeId: "Things" });
  assert.match(page, /<html lang="zh-CN"[^>]*data-ui-locale="zh-CN"/);
  assert.match(page, /title="显示或隐藏文件列表"/);
  assert.match(page, /placeholder="搜索笔记…"/);
  assert.match(page, /<span id="live-status-label" class="live-status-label">连接中<\/span>/);
  assert.match(page, /<h1>欢迎回来，Owner<\/h1>/);
  assert.match(page, /title="退出 owner"/);
  assert.match(page, /<span class="setting-label">语言<\/span>/);
  assert.match(page, /<option value="zh-CN" selected>简体中文<\/option>/);
});

test("the stored preference selects its own option in the language switch", () => {
  const stored = appPage(session, {}, null, null, null, { locale: "en", preference: "zh-CN" });
  assert.match(stored, /<option value="zh-CN" selected>简体中文<\/option>/);
  assert.match(stored, /<option value="en">English<\/option>/);
  // `?lang=en` while the stored preference is zh-CN renders English but does not
  // rewrite the stored choice.
  assert.match(stored, /<html lang="en"/);
});

test("the Publish page follows the locale for its chrome", () => {
  const zhPage = publishPage({ title: "Note", content: "", publishedAt: "2026-10-24T00:00:00.000Z" });
  assert.match(zhPage, /<html lang="zh-CN"/);
  assert.match(zhPage, /公开只读文档 · 2026-10-24T00:00:00\.000Z/);
  assert.match(zhPage, /<span data-publish-theme-label>深色模式<\/span>/);

  const enPage = publishPage({ title: "Note", content: "", publishedAt: "2026-10-24T00:00:00.000Z", locale: "en" });
  assert.match(enPage, /<html lang="en"/);
  assert.match(enPage, /Public read-only document · 2026-10-24T00:00:00\.000Z/);
  assert.match(enPage, /title="Switch to dark mode"/);
  assert.doesNotMatch(enPage, /[\u4e00-\u9fff]/);
});

test("a published title is escaped, not interpolated as markup", () => {
  const page = publishPage({ title: "<img src=x onerror=alert(1)>", content: "", publishedAt: "", locale: "en" });
  assert.ok(!page.includes("<img src=x"), "the title must be escaped");
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
