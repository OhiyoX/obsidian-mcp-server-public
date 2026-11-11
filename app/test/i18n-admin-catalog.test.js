// Admin-plane i18n contract.
//
// The Admin surface is a prototype replica whose Chinese face is pinned by the parity
// gate, so i18n must be *additive*: `zh-CN` renders exactly what it rendered before,
// and `en` is a second catalog with the same key set. Three invariants:
//   1. `src/i18n/admin/zh-CN.js` and `en.js` carry the same keys (no half translation);
//   2. every `adm.` key literal referenced under `src/admin/**` exists in both catalogs
//      (a renamed key cannot survive on the fallback alone);
//   3. the request scope isolates locales (two overlapping "requests" do not leak).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { adminCatalogFor, adminCatalogs, createAdminTranslator } from "../src/i18n/admin.js";
import { adminHtmlLang, adminLocale, runWithAdminLocale, t } from "../src/i18n/context.js";
import { renderLoginPage } from "../src/admin/pages/login.js";
import { renderSidebar, renderMnav } from "../src/admin/layout.js";
import { actionLabel, credentialKindLabel, auditResultLabel } from "../src/admin/presentation/labels.js";
import { SCOPES, TOKEN_ST, MODE, DAYS, KIND_LABEL, statusOfToken, CAP_GROUP_LABEL } from "../src/admin/presentation/vocab.js";

const zhAdmin = adminCatalogFor("zh-CN");
const enAdmin = adminCatalogFor("en");
const ADMIN_ROOT = fileURLToPath(new URL("../src/admin/", import.meta.url));

test("the Admin catalogs cover exactly the same keys", () => {
  const zhKeys = Object.keys(zhAdmin).sort();
  const enKeys = Object.keys(enAdmin).sort();
  assert.deepEqual(enKeys.filter((key) => !zhKeys.includes(key)), [], "en has Admin keys zh-CN does not");
  assert.deepEqual(zhKeys.filter((key) => !enKeys.includes(key)), [], "zh-CN has Admin keys en does not");
  assert.deepEqual(Object.keys(adminCatalogs()).sort(), ["en", "zh-CN"]);
  for (const [key, value] of Object.entries(zhAdmin)) {
    assert.ok(value.trim().length > 0, `${key} is empty in zh-CN`);
    assert.ok(enAdmin[key].trim().length > 0, `${key} is empty in en`);
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(enAdmin[key]), placeholders(value), `${key}: placeholder mismatch`);
  }
});

function adminSources(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const absolute = path.join(directory, name);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      if (name === "assets") continue; // browser modules have their own copy path
      files.push(...adminSources(absolute));
    } else if (name.endsWith(".js")) {
      files.push(absolute);
    }
  }
  return files;
}

test("every `adm.` key literal used by the Admin sources exists in both catalogs", () => {
  const missing = [];
  for (const file of adminSources(ADMIN_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/"(adm\.[A-Za-z0-9_.-]+)"/g)) {
      const key = match[1];
      if (!Object.hasOwn(zhAdmin, key)) missing.push(`${path.relative(ADMIN_ROOT, file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
  // Day names are built by index rather than written out.
  for (let day = 0; day < 7; day += 1) {
    assert.ok(Object.hasOwn(zhAdmin, `adm.day.${day}`));
    assert.ok(Object.hasOwn(enAdmin, `adm.day.${day}`));
  }
});

test("the default Admin render keeps the historic Chinese face", () => {
  assert.equal(adminLocale(), "zh-CN");
  assert.equal(adminHtmlLang(), "zh-CN");
  const page = renderLoginPage();
  assert.match(page, /<html lang="zh-CN"/);
  assert.match(page, /Obsidian MCP 授权管理/);
  assert.match(page, /<label for="pw">管理密码<\/label>/);
  assert.match(page, /<button class="btn primary" type="submit">登录<\/button>/);
  assert.match(page, /<b class="tx2" style="font-weight:600">不接受<\/b>/);
  const { side, foot } = renderSidebar({ activeTab: "overview", csrf: "c", constraintsBase: "/admin/auth/authz", vaultGitBase: "/admin/auth/vaults" });
  for (const label of ["概览", "身份与凭据", "OAuth 账户", "API Key", "内容与安全", "定时授权", "系统", "Vault 与 Git"]) {
    assert.ok(side.includes(label), `sidebar keeps ${label}`);
  }
  assert.match(side, /aria-label="授权管理"/);
  assert.match(foot, /退出登录/);
  assert.match(renderMnav({ activeTab: "overview", constraintsBase: "/admin/auth/authz", vaultGitBase: "/v" }), /移动导航[\s\S]*更多/);
  assert.equal(actionLabel("admin.login").label, "管理员登录");
  assert.equal(credentialKindLabel("api-key").label, "API Key");
  assert.equal(auditResultLabel("nope").label, "未知结果（nope）");
  assert.deepEqual(SCOPES.map((scope) => scope.name), ["读取", "写入", "文件"]);
  assert.deepEqual(TOKEN_ST.active, ["有效", "ok"]);
  assert.equal(MODE.suspend.n, "暂停");
  assert.deepEqual([...DAYS].map((_, index) => DAYS[index]), ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);
  assert.equal(KIND_LABEL["oauth-client"], "OAuth 客户端");
  assert.equal(CAP_GROUP_LABEL.surface, "访问面");
});

test("inside an English request scope the Admin surface is English", () => {
  runWithAdminLocale("en", () => {
    assert.equal(adminLocale(), "en");
    assert.equal(adminHtmlLang(), "en");
    const page = renderLoginPage();
    assert.match(page, /<html lang="en"/);
    assert.match(page, /Obsidian MCP Authorization/);
    assert.match(page, /<label for="pw">Admin password<\/label>/);
    assert.match(page, /It does not accept/);
    const { side, foot } = renderSidebar({ activeTab: "overview", csrf: "c", constraintsBase: "/admin/auth/authz", vaultGitBase: "/admin/auth/vaults" });
    for (const label of ["Overview", "Identity &amp; credentials", "OAuth accounts", "API keys", "Scheduled access", "Vaults &amp; Git"]) {
      assert.ok(side.includes(label), `sidebar shows ${label}`);
    }
    assert.match(foot, /Sign out/);
    assert.match(renderMnav({ activeTab: "overview", constraintsBase: "/admin/auth/authz", vaultGitBase: "/v" }), /Mobile navigation[\s\S]*More/);
    assert.equal(actionLabel("admin.login").label, "Admin sign-in");
    assert.equal(actionLabel("mcp.tool.search_notes").label, "MCP tool call · search_notes");
    assert.equal(credentialKindLabel("api-key").label, "API key");
    assert.equal(auditResultLabel("nope").label, "Unknown result (nope)");
    assert.deepEqual(SCOPES.map((scope) => scope.name), ["Read", "Write", "Files"]);
    assert.deepEqual(TOKEN_ST.revoked, ["Revoked", "danger"]);
    assert.equal(MODE.revoke.n, "Revoke");
    assert.deepEqual([...DAYS].map((_, index) => DAYS[index]), ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
    assert.equal(KIND_LABEL["oauth-user"], "OAuth account");
    assert.equal(CAP_GROUP_LABEL.tool, "Single tool");
    assert.match(statusOfToken("revoked"), /Revoked/);
  });
  // Leaving the scope restores the default catalog.
  assert.equal(adminLocale(), "zh-CN");
  assert.equal(actionLabel("admin.login").label, "管理员登录");
});

test("overlapping request scopes keep their own locale", async () => {
  const results = await Promise.all([
    runWithAdminLocale("en", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return t("adm.nav.overview");
    }),
    runWithAdminLocale("zh-CN", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return t("adm.nav.overview");
    }),
  ]);
  assert.deepEqual(results, ["Overview", "概览"]);
});

test("the Admin translator resolves shared Web copy as well", () => {
  const en = createAdminTranslator("en");
  assert.equal(en.t("login.error.waitMinutes", { minutes: 3 }), "3 min");
  assert.equal(en.t("adm.nav.overview"), "Overview");
  assert.equal(en.t("adm.key.that.does.not.exist"), "adm.key.that.does.not.exist");
  const zh = createAdminTranslator("zh-CN");
  assert.equal(zh.t("login.error.waitMinutes", { minutes: 3 }), "3 分钟");
});
