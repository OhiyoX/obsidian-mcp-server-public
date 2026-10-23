// Admin plane router — the whole authenticated surface of `/admin/auth`.
//
// Fresh implementation (the previous Admin UI is treated as never having existed): session, CSRF,
// login lockout, tab dispatch and every credential write live here, and every rendering decision is
// delegated to `pages/*`. Service calls are the ones the backend already exposes; this file adds no
// new authority, no new endpoint class and no new credential store.
//
// Boundaries that must not drift:
//   * Admin session/CSRF stays its own scheme — never an API Key, OAuth or Web session;
//   * the Admin plane is never gated by the policies or Git config it manages;
//   * danger actions are POST + CSRF + server-side validation; a confirm page is only a GET form;
//   * a broken store still renders the repair surface.
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AUTH_ADMIN_SESSION_TTL_SECONDS } from "../server-config.js";
import { LOGIN_LOCK_MAX_FAILURES, LOGIN_LOCK_WINDOW_MS, formatLockRemaining, lockRetryAfterSeconds, setRetryAfter } from "../login-lockout.js";
import { buildCatalog } from "./catalog.js";
import { decideGrantRevocation } from "./grants.js";
import { clean, listField, parseCookies, source } from "./http.js";
import { renderAuthTab, renderCsrfRejected, renderError, renderLoginFailure, renderLoginLocked, renderLoginPage } from "./pages/index.js";
import { renderAuthShell } from "./pages/shell.js";
import { renderDocument } from "./layout.js";
import { registerAuthorizationTransferRoutes } from "./auth-center-transfer-routes.js";
import { registerAccessPolicyRoutes } from "./routes/access-policy.js";
import { registerVaultGitRoutes } from "./routes/vault-git.js";
import { registerDefaultVaultRoutes } from "./routes/default-vault.js";

export const COOKIE_NAME = "obsidian_mcp_admin";
export const TABS = Object.freeze(["overview", "accounts", "keys", "clients", "tokens", "publishes", "audit"]);

const TITLE = "Obsidian MCP · 授权管理";

function token(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function safeEquals(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAdminRouter({
  provider,
  adminPassword,
  secureCookie = true,
  configuredApiKeyEnabled = false,
  onCredentialRevoked = async () => {},
  listVaults = async () => ({ vaults: [] }),
  publishService = null,
  publicBaseUrl = "",
  accessPolicyAdmin = null,
  vaultGitAdmin = null,
  vaultGitStore = null,
}) {
  const router = express.Router();
  const deps = { provider, configuredApiKeyEnabled, listVaults, publishService, publicBaseUrl, accessPolicyAdmin, vaultGitAdmin };
  const sessions = new Map();
  const failures = new Map();

  router.use(express.urlencoded({ extended: false, limit: "32kb" }));
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    // D0 (approved 2026-10-18): a *same-origin* enhancement script only. `connect-src 'self'` is
    // required for the fragment fetches (drawer/menu/modal/live preview); without it `connect-src`
    // falls back to `default-src 'none'` and even same-origin fetch is blocked. No inline script, no
    // eval, no third-party origin, no `http:`/`https:`/`*`.
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // The enhancement modules, served from this router so they share the admin origin. The whitelist is
  // exact (no path from the request, nothing else in the assets directory is reachable) and the
  // content is public code with no data in it — a session is not required to read it.
  const CLIENT_MODULES = new Map([
    ["admin-client.js", "admin-client.js"],
    ["admin-feature-registry.js", "admin-feature-registry.js"],
    ["admin-feature-overlays.js", "admin-feature-overlays.js"],
    ["admin-feature-keys.js", "admin-feature-keys.js"],
    ["admin-feature-lists.js", "admin-feature-lists.js"],
    ["admin-feature-select.js", "admin-feature-select.js"],
    ["admin-feature-nav.js", "admin-feature-nav.js"],
  ]);
  router.get("/assets/:file", (req, res) => {
    const name = CLIENT_MODULES.get(String(req.params.file || ""));
    if (!name) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    try {
      const body = readFileSync(fileURLToPath(new URL(`./assets/${name}`, import.meta.url)), "utf8");
      res.type("application/javascript; charset=utf-8").send(body);
    } catch (error) {
      res.status(500).type("text/plain").send(`asset unavailable: ${String(error?.message || error)}`);
    }
  });

  // ------------------------------------------------------------------ session

  let lastCatalog = null;

  function currentSession(req) {
    const id = parseCookies(req)[COOKIE_NAME];
    const session = id && sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (id) sessions.delete(id);
      return null;
    }
    session.expiresAt = Date.now() + AUTH_ADMIN_SESSION_TTL_SECONDS * 1000;
    return { id, ...session };
  }

  function stored(req) {
    return sessions.get(req.adminSession?.id) || null;
  }

  function setFlash(req, message, tone = "ok") {
    const session = stored(req);
    if (!session) return;
    session.flashMessage = message;
    session.flashTone = tone;
  }

  function requireAdmin(req, res, next) {
    const session = currentSession(req);
    if (!session) {
      res.redirect(303, "/admin/auth/login");
      return;
    }
    req.adminSession = session;
    next();
  }

  function requireCsrf(req, res, next) {
    if (safeEquals(req.body?.csrf || "", req.adminSession?.csrf || "")) {
      next();
      return;
    }
    res.status(403).send(renderCsrfRejected());
  }

  const redirectTab = (res, tab) => res.redirect(303, `/admin/auth?tab=${tab}`);

  /** The typed confirmation a danger write must carry, copied from the form and trimmed. */
  const confirmToken = (req) => String(req.body?.confirm ?? "").trim();

  /**
   * Refuse a danger write with an explicit 400 and an honest "nothing was executed" page.
   *
   * The typed confirmation is a **server** precondition — the input on the confirm page is only how
   * the operator supplies it. No confirm, a wrong confirm, an unknown target or a service that
   * reports `false` must therefore change nothing and must not claim success.
   */
  function refuse(req, res, heading, message, tab) {
    res.status(400).send(renderError({
      title: heading,
      heading,
      message,
      backHref: tab ? `/admin/auth?tab=${tab}` : "/admin/auth",
      backLabel: tab ? "返回列表" : "返回授权管理",
      theme: lastCatalog?.theme || "dark",
    }));
  }

  /** The label a danger confirm must match (the same string the page asks the operator to type). */
  function keyConfirmLabel(key) {
    return String(key?.label || key?.prefix || key?.id || "").trim();
  }

  // One catalog per authenticated GET, built **before** any route module runs: the AuthZ and
  // Vault-Git route modules render the same shell, so they must read this request's snapshot and
  // never a module-level cache from another request/session (#399 review R4).
  router.use(async (req, res, next) => {
    if (req.method !== "GET" || req.path === "/login") {
      next();
      return;
    }
    const session = currentSession(req);
    if (!session) {
      res.redirect(303, "/admin/auth/login");
      return;
    }
    req.adminSession = session;
    try {
      lastCatalog = await buildCatalog({ deps, req, query: req.query });
      req.adminCatalog = lastCatalog;
    } catch (error) {
      res.status(503).send(renderError({ title: "服务暂不可用", heading: "读取管理数据失败", message: String(error?.message || error), theme: lastCatalog?.theme || "dark" }));
      return;
    }
    next();
  });

  // AuthZ / Vault-Git stay as their own route modules (they own service validation + CAS); their
  // GET pages are slated to move onto `pages/authz.js` / `pages/vaults.js`. Until then they render
  // inside this shell through the same view interface.
  // Both route modules render the *same* sidebar, so each needs the other's base. `vaultGitBase` is
  // not known while the access-policy routes register (they are mounted first), so the two bases are
  // held here and injected late, at render time, through each module's `view` seam (#399).
  let accessPolicyBase = null;
  let vaultGitBase = null;

  accessPolicyBase = accessPolicyAdmin
    ? registerAccessPolicyRoutes(router, {
      admin: accessPolicyAdmin,
      provider,
      configuredApiKeyEnabled,
      // Same inventory sources as the tab routes: the sidebar counts are part of this page.
      listVaults,
      publishService,
      vaultGitAdmin,
      requireAdmin,
      requireCsrf,
      view: {
        renderAuthShell: (opts) => {
          // Counts come from THIS request's catalog. The module-level `lastCatalog` fallback is exactly
          // how the sidebar showed "Vault 与 Git 0" on /admin/auth/access-policy on the NAS (2026-10-21):
          // a snapshot captured while the inventory was empty kept being reused long after two Vaults
          // were admitted. A route may also pass its own counts (`authz`); those win over the catalog's.
          const fallback = opts.catalog || lastCatalog;
          return renderAuthShell({ ...opts, accessPolicyBase: accessPolicyBase ?? opts.accessPolicyBase, vaultGitBase: vaultGitBase ?? opts.vaultGitBase, theme: opts.theme || fallback?.theme || "dark", navCounts: { ...(fallback?.navCounts || {}), ...(opts.navCounts || {}) }, navAttention: { ...(fallback?.navAttention || {}), ...(opts.navAttention || {}) } });
        },
        layout: (title, body) => renderDocument({ title: title || TITLE, theme: lastCatalog?.theme || "dark", bodyHtml: body }),
      },
    })?.base ?? null
    : null;

  vaultGitBase = vaultGitAdmin
    ? registerVaultGitRoutes(router, {
      admin: vaultGitAdmin,
      provider,
      gitConfigStore: vaultGitStore,
      requireAdmin,
      requireCsrf,
      actions: accessPolicyBase ? { accessPolicyBase } : undefined,
      view: {
        renderAuthShell: (opts) => {
          // Counts come from THIS request's catalog. The module-level `lastCatalog` fallback is exactly
          // how the sidebar showed "Vault 与 Git 0" on /admin/auth/access-policy on the NAS (2026-10-21):
          // a snapshot captured while the inventory was empty kept being reused long after two Vaults
          // were admitted. A route may also pass its own counts (`authz`); those win over the catalog's.
          const fallback = opts.catalog || lastCatalog;
          return renderAuthShell({ ...opts, accessPolicyBase: accessPolicyBase ?? opts.accessPolicyBase, vaultGitBase: vaultGitBase ?? opts.vaultGitBase, theme: opts.theme || fallback?.theme || "dark", navCounts: { ...(fallback?.navCounts || {}), ...(opts.navCounts || {}) }, navAttention: { ...(fallback?.navAttention || {}), ...(opts.navAttention || {}) } });
        },
        layout: (title, body) => renderDocument({ title: title || TITLE, theme: lastCatalog?.theme || "dark", bodyHtml: body }),
      },
    })?.base ?? null
    : null;

  let lastCatalogRef = null;
  void lastCatalogRef;

  registerAuthorizationTransferRoutes(router, {
    provider,
    requireAdmin,
    requireCsrf,
    view: { layout: (title, body) => renderDocument({ title: title || TITLE, theme: lastCatalog?.theme || "dark", bodyHtml: body }) },
    setFlash: (req, message) => setFlash(req, message),
  });

  // ------------------------------------------------------------------ login

  router.get("/login", (req, res) => {
    if (currentSession(req)) {
      res.redirect(303, "/admin/auth");
      return;
    }
    res.send(renderLoginPage({ theme: "dark" }));
  });

  router.post("/login", async (req, res) => {
    const ip = source(req) || "unknown";
    const state = failures.get(ip) || { count: 0, resetAt: Date.now() + LOGIN_LOCK_WINDOW_MS };
    if (state.resetAt <= Date.now()) Object.assign(state, { count: 0, resetAt: Date.now() + LOGIN_LOCK_WINDOW_MS });
    if (state.count >= LOGIN_LOCK_MAX_FAILURES) {
      const retryAfterSeconds = lockRetryAfterSeconds(state.resetAt);
      setRetryAfter(res, retryAfterSeconds);
      res.status(429).send(renderLoginLocked({ retryAfterSeconds, formatLockRemaining }));
      return;
    }
    if (!safeEquals(req.body?.password || "", adminPassword)) {
      state.count += 1;
      failures.set(ip, state);
      await provider.ready;
      provider.recordAudit({ action: "admin.login", credentialType: "admin-session", outcome: "failure", source: ip, userAgent: clean(req.headers["user-agent"], 240) });
      res.status(403).send(renderLoginFailure());
      return;
    }
    failures.delete(ip);
    const id = token();
    sessions.set(id, { csrf: token(), expiresAt: Date.now() + AUTH_ADMIN_SESSION_TTL_SECONDS * 1000, flashKey: null, flashMessage: null, flashTone: "ok" });
    res.cookie(COOKIE_NAME, id, { httpOnly: true, secure: secureCookie, sameSite: "strict", maxAge: AUTH_ADMIN_SESSION_TTL_SECONDS * 1000, path: "/admin/auth" });
    provider.recordAudit({ action: "admin.login", credentialType: "admin-session", source: ip, userAgent: clean(req.headers["user-agent"], 240) });
    res.redirect(303, "/admin/auth");
  });

  router.post("/logout", requireAdmin, requireCsrf, (req, res) => {
    sessions.delete(req.adminSession.id);
    res.clearCookie(COOKIE_NAME, { path: "/admin/auth" });
    res.redirect(303, "/admin/auth/login");
  });

  router.post("/theme", requireAdmin, requireCsrf, (req, res) => {
    const next = String(req.body?.theme || "") === "light" ? "light" : "dark";
    res.cookie("omcp-admin.theme", next, { httpOnly: false, secure: secureCookie, sameSite: "strict", maxAge: 365 * 24 * 3600 * 1000, path: "/admin/auth" });
    // Only a same-site admin path may be used as the redirect target: a protocol-relative value such
    // as `//evil.example/x` starts with `/` and must not become a cross-origin redirect.
    const back = String(req.get("referer") || "");
    const safeBack = /^\/admin\/auth(?:[/?#][^\s]*)?$/.test(back) ? back : "/admin/auth";
    res.redirect(303, safeBack);
  });

  // ------------------------------------------------------------------ pages

  router.get("/", requireAdmin, async (req, res) => {
    const activeTab = TABS.includes(String(req.query.tab || "")) ? String(req.query.tab) : "overview";
    const catalog = req.adminCatalog;
    const session = stored(req);
    const flashKey = session?.flashKey || null;
    const flashMessage = session?.flashMessage || null;
    const flashTone = session?.flashTone || "ok";
    if (session) {
      session.flashKey = null;
      session.flashMessage = null;
      session.flashTone = "ok";
    }
    let page;
    try {
      page = renderAuthTab(activeTab, { ...catalog, req, csrf: req.adminSession.csrf, session: req.adminSession, publicBaseUrl, accessPolicyBase, vaultGitBase });
    } catch (error) {
      res.status(500).send(renderError({ title: "页面渲染失败", heading: "页面渲染失败", message: String(error?.message || error), theme: catalog?.theme }));
      return;
    }
    res.send(renderAuthShell({
      activeTab,
      accessPolicyBase,
      vaultGitBase,
      session: req.adminSession,
      request: req,
      flashKey,
      flashMessage,
      flashTone,
      content: page.content,
      detailPanel: page.detailPanel || "",
      theme: catalog.theme,
      navCounts: catalog.navCounts,
      navAttention: catalog.navAttention,
    }));
  });

  // ------------------------------------------------- credential writes (identity)
  registerDefaultVaultRoutes(router, {
    requireAdmin, requireCsrf, provider, listVaults, stored, setFlash, redirectTab, renderError,
  });

  router.post("/api-key/scopes", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const scopes = listField(req.body, "allowedScope");
      if (!scopes.length) throw new Error("至少选择一个 Scope");
      const vaults = listField(req.body, "allowedVault");
      if (!vaults.length) throw new Error("至少选择一个 Vault");
      const id = String(req.body?.id || "");
      if (id === "configured-env") {
        refuse(req, res, "未执行任何操作", "环境配置 API Key 由部署环境提供，只读：管理端不能改它的权限。", "keys");
        return;
      }
      // Existence is checked first: an unknown id must be refused without touching the service at all.
      const snapshot = await provider.authorizationSnapshot();
      if (!(snapshot.apiKeys || []).some((item) => String(item.id) === id)) {
        refuse(req, res, "未执行任何操作", "该 API Key 不存在（可能已被删除），服务端没有变更任何内容。", "keys");
        return;
      }
      const updated = await provider.updateApiKey(id, { allowedScopes: scopes, allowedVaults: vaults });
      if (!updated) {
        refuse(req, res, "未执行任何操作", "服务端没有变更该 API Key（可能已被并发删除）。", "keys");
        return;
      }
      await onCredentialRevoked(`api-key:${id}`);
      setFlash(req, "API Key 权限已更新；该 Key 的既有授权已撤销，需重新授权。");
      redirectTab(res, "keys");
    } catch (error) {
      res.status(400).send(renderError({ title: "更新失败", heading: "API Key 权限更新失败", message: String(error?.message || error) }));
    }
  });

  router.post("/api-key/delete", requireAdmin, requireCsrf, async (req, res) => {
    const id = String(req.body?.id || "");
    if (id === "configured-env") {
      refuse(req, res, "未执行任何操作", "环境配置 API Key 由部署环境提供，只读：管理端不能删除它。", "keys");
      return;
    }
    const snapshot = await provider.authorizationSnapshot();
    const key = (snapshot.apiKeys || []).find((item) => String(item.id) === id);
    if (!key) {
      refuse(req, res, "未执行任何操作", "该 API Key 不存在（可能已被删除），未执行任何操作。", "keys");
      return;
    }
    const expected = keyConfirmLabel(key);
    if (!expected || confirmToken(req) !== expected) {
      refuse(req, res, "未执行任何操作", `确认文本不匹配：请输入该 Key 的名称「${expected || "(未命名)"}」后重试。该 Key 未被删除。`, "keys");
      return;
    }
    if (!await provider.deleteApiKey(id)) {
      refuse(req, res, "未执行任何操作", "服务端没有删除该 Key（可能已被删除）。", "keys");
      return;
    }
    await onCredentialRevoked(`api-key:${id}`);
    setFlash(req, "API Key 已删除。");
    redirectTab(res, "keys");
  });

  router.post("/oauth/user/create", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const scopes = listField(req.body, "allowedScope");
      if (!scopes.length) throw new Error("至少选择一个 Scope");
      const vaults = listField(req.body, "allowedVault");
      if (!vaults.length) throw new Error("至少选择一个 Vault");
      await provider.createOAuthUser({ username: req.body?.username, password: req.body?.password, displayName: req.body?.displayName, allowedScopes: scopes, allowedVaults: vaults });
      redirectTab(res, "accounts");
    } catch (error) {
      res.status(400).send(renderError({ title: "创建失败", heading: "OAuth 账户创建失败", message: String(error?.message || error) }));
    }
  });

  router.post("/oauth/user/scopes", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const scopes = listField(req.body, "allowedScope");
      if (!scopes.length) throw new Error("至少选择一个 Scope");
      const vaults = listField(req.body, "allowedVault");
      if (!vaults.length) throw new Error("至少选择一个 Vault");
      const userId = String(req.body?.id || "");
      // 「仅新增授权，不撤销现有会话」 is only honest for a pure grant: an old token carries its own
      // allowedVaults/scopes snapshot, so an added Vault cannot leak through it. A REMOVAL (or a scope
      // change) must still revoke — otherwise the operator would believe access was taken away while
      // the live tokens keep it. (2026-10-21: adding one Vault to an account revoked all 255 of its
      // tokens; correct per design, but it deserved a warning with the count and a way to avoid it.)
      const before = (await provider.authorizationSnapshot()).oauthUsers.find((item) => item.id === userId);
      const decision = decideGrantRevocation({ beforeScopes: before?.allowedScopes || [], afterScopes: scopes, beforeVaults: before?.allowedVaults || [], afterVaults: vaults });
      const keep = decision.keep;
      const result = await provider.updateOAuthUser(userId, { allowedScopes: scopes, allowedVaults: vaults, revokeGrants: !keep });
      for (const clientId of result?.revokedClientIds || []) await onCredentialRevoked(clientId, { userId });
      const revoked = (result?.revokedClientIds || []).length;
      if (keep) setFlash(req, "账户权限已更新；本次只新增授权，现有会话保持不变（旧会话仍只拥有它签发时的那组 Vault）。");
      else if (!decision.additive) setFlash(req, `账户权限已更新；本次包含权限收紧，已撤销 ${revoked} 个客户端的授权（收紧无法通过旧会话生效）。`);
      else setFlash(req, `账户权限已更新；${revoked} 个客户端的授权已撤销，需重新授权。`);
      redirectTab(res, "accounts");
    } catch (error) {
      res.status(400).send(renderError({ title: "更新失败", heading: "账户权限更新失败", message: String(error?.message || error) }));
    }
  });

  router.post("/oauth/user/password", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const userId = String(req.body?.id || "");
      const result = await provider.updateOAuthUser(userId, { password: req.body?.password });
      for (const clientId of result?.revokedClientIds || []) await onCredentialRevoked(clientId, { userId });
      setFlash(req, `密码已重置；${(result?.revokedClientIds || []).length} 个客户端的授权已撤销，需重新授权。`);
      redirectTab(res, "accounts");
    } catch (error) {
      res.status(400).send(renderError({ title: "更新失败", heading: "密码重置失败", message: String(error?.message || error) }));
    }
  });

  router.post("/oauth/user/toggle", requireAdmin, requireCsrf, async (req, res) => {
    const userId = String(req.body?.id || "");
    const disable = req.body?.disabled === "true";
    const result = await provider.updateOAuthUser(userId, { disabled: disable });
    for (const clientId of result?.revokedClientIds || []) await onCredentialRevoked(clientId, { userId });
    setFlash(req, disable ? "账户已停用。" : "账户已启用。");
    redirectTab(res, "accounts");
  });

  router.post("/oauth/user/delete", requireAdmin, requireCsrf, async (req, res) => {
    const userId = String(req.body?.id || "");
    const snapshot = await provider.authorizationSnapshot();
    const account = (snapshot.oauthUsers || []).find((item) => String(item.id) === userId);
    if (!account) {
      refuse(req, res, "未执行任何操作", "该账户不存在（可能已被删除），未执行任何操作。", "accounts");
      return;
    }
    const expected = String(account.username || "").trim();
    if (!expected || confirmToken(req) !== expected) {
      refuse(req, res, "未执行任何操作", `确认文本不匹配：请输入该账户的用户名「${expected || "(未设置)"}」后重试。该账户未被删除。`, "accounts");
      return;
    }
    const clientIds = await provider.deleteOAuthUser(userId);
    for (const clientId of clientIds || []) await onCredentialRevoked(clientId, { userId });
    setFlash(req, "账户已删除。");
    redirectTab(res, "accounts");
  });

  router.post("/oauth/client/revoke", requireAdmin, requireCsrf, async (req, res) => {
    const clientId = String(req.body?.clientId || "");
    if (!await provider.revokeClient(clientId, false)) {
      refuse(req, res, "未执行任何操作", "该客户端不存在（可能已被删除），未执行任何操作。", "clients");
      return;
    }
    await onCredentialRevoked(clientId);
    setFlash(req, "客户端授权已撤销。");
    redirectTab(res, "clients");
  });

  router.post("/oauth/client/delete", requireAdmin, requireCsrf, async (req, res) => {
    const clientId = String(req.body?.clientId || "");
    const snapshot = await provider.authorizationSnapshot();
    const client = (snapshot.clients || []).find((item) => String(item.clientId) === clientId);
    if (!client) {
      refuse(req, res, "未执行任何操作", "该客户端不存在（可能已被删除），未执行任何操作。", "clients");
      return;
    }
    // The page asks for the client name, or the literal `delete` for an unnamed client.
    const expected = String(client.clientName || "delete").trim();
    if (confirmToken(req) !== expected) {
      refuse(req, res, "未执行任何操作", `确认文本不匹配：请输入「${expected}」后重试。该客户端未被删除。`, "clients");
      return;
    }
    if (!await provider.revokeClient(clientId, true)) {
      refuse(req, res, "未执行任何操作", "服务端没有删除该客户端（可能已被删除）。", "clients");
      return;
    }
    await onCredentialRevoked(clientId);
    setFlash(req, "客户端已删除。");
    redirectTab(res, "clients");
  });

  router.post("/oauth/token/revoke", requireAdmin, requireCsrf, async (req, res) => {
    const revoked = await provider.revokeTokenById(String(req.body?.type || ""), String(req.body?.id || ""));
    if (revoked?.clientId) await onCredentialRevoked(revoked.clientId, { userId: revoked.userId });
    setFlash(req, "Token 已撤销。");
    redirectTab(res, "tokens");
  });

  router.post("/oauth/token/cleanup", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const result = await provider.cleanupTokenRecords(req.body?.olderThanDays ?? 7);
      setFlash(req, `已清理 ${result.total} 条非活动 Token 记录（access ${result.access}，refresh ${result.refresh}）。`);
      redirectTab(res, "tokens");
    } catch (error) {
      res.status(400).send(renderError({ title: "清理失败", heading: "Token 清理失败", message: String(error?.message || error) }));
    }
  });

  router.post("/publish/revoke", requireAdmin, requireCsrf, async (req, res) => {
    const removed = publishService ? await publishService.revokeById(String(req.body?.id || "")) : null;
    if (removed) provider.recordAudit({ action: "admin.publish.revoke", credentialType: "admin-session", source: source(req), detail: `${removed.vaultId}:${removed.path}` });
    setFlash(req, removed ? "发布记录已撤销。" : "该发布记录不存在或已撤销。", removed ? "ok" : "err");
    redirectTab(res, "publishes");
  });

  router.post("/audit/clear", requireAdmin, requireCsrf, async (req, res) => {
    // The clear-entry confirm asks the operator to type 清空日志; the server re-checks it.
    if (confirmToken(req) !== "清空日志") {
      refuse(req, res, "未执行任何操作", "确认文本不匹配：请输入「清空日志」后重试。审计记录未被清空。", "audit");
      return;
    }
    await provider.clearAudit();
    setFlash(req, "审计记录已清空。");
    redirectTab(res, "audit");
  });

  return router;
}
