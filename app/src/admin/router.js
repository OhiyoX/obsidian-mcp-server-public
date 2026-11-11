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
import { adminAuthorizationRequest } from "../authorization/adapters/admin.js";
import { createAuthorizationSeam } from "../authorization/runtime.js";
import { clean, listField, parseCookies, source } from "./http.js";
import { renderAuthTab, renderCsrfRejected, renderError, renderLoginFailure, renderLoginLocked, renderLoginPage } from "./pages/index.js";
import { auditCsv } from "./pages/audit.js";
import { renderAuthShell } from "./pages/shell.js";
import { renderDocument } from "./layout.js";
import { registerAuthorizationTransferRoutes } from "./auth-center-transfer-routes.js";
import { registerAccessPolicyRoutes } from "./routes/access-policy.js";
import { registerAuthorizationRoutes } from "./routes/authz.js";
import { registerVaultGitRoutes } from "./routes/vault-git.js";
import { registerDefaultVaultRoutes } from "./routes/default-vault.js";
import { registerLocaleRoutes } from "../app/locale-routes.js";
import { localeInfo } from "../i18n/request.js";
import { adminLocale, runWithAdminLocale, t } from "../i18n/context.js";

export const COOKIE_NAME = "obsidian_mcp_admin";
export const TABS = Object.freeze(["overview", "accounts", "keys", "clients", "tokens", "publishes", "audit"]);

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
  authorizationAdmin = null,
  vaultGitAdmin = null,
  vaultGitStore = null,
  authorization = null,
  authorizationShadow = null,
}) {
  const router = express.Router();
  const deps = { provider, configuredApiKeyEnabled, listVaults, publishService, publicBaseUrl, accessPolicyAdmin, authorizationAdmin, vaultGitAdmin, authorizationShadow };
  // The one deployment mode, read where it is decided (`server.js` builds the runtime with it) and
  // handed to the legacy policy page, whose frozen banner must state it: only `enforce` answers from
  // the per-Vault model, so the stored legacy policies still decide in the other two modes.
  const authorizationMode = typeof authorization?.summary === "function" ? authorization.summary().mode ?? null : null;
  const sessions = new Map();
  const failures = new Map();

  // The whole Admin plane renders in one language per request. The scope is opened before
  // any other middleware so every downstream renderer, service await and error page inherits
  // it; without a session the preference still comes from the cookie/Accept-Language.
  router.use((req, _res, next) => runWithAdminLocale(localeInfo(req).locale, () => next()));
  // The interface-language preference is shared with the Web plane (one cookie, one meaning).
  // The switch is a plain GET so it works without script; the Admin plane deliberately gains no
  // new control (the prototype-parity gate owns that surface), so this URL and `?lang=` are the
  // two documented entry points, and the Web settings dialog carries the visible switch.
  registerLocaleRoutes(router, { secureCookie, path: "/language", defaultNext: "/admin/auth" });

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

  // P3: every Admin control action is decided by the authorization runtime, with the console's
  // own `admin-session` proof — a console session is not a person's credential, so it carries no
  // subject. `requireAdmin`/`requireCsrf` still run first: without a session this middleware only
  // lets the request continue to them, so the existing login redirect and CSRF answers are
  // unchanged. A path that is not a catalog boundary keeps the route's own answer.
  const decide = createAuthorizationSeam({ authorization });
  router.use((req, res, next) => {
    if (authorization === null) return next();
    if (!currentSession(req)) return next();
    const request = adminAuthorizationRequest({ routeKey: `ADMIN ${String(req.method || "GET").toUpperCase()} ${String(req.path || "/")}` });
    if (request === null) return next();
    let decision;
    try {
      decision = decide.authorize(request);
    } catch {
      decision = null;
    }
    if (decision !== null && decision.allowed === true) return next();
    res.status(403).type("text/plain").send("Forbidden");
  });

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
      backLabel: tab ? t("adm.back.list") : t("adm.back.admin"),
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
      res.status(503).send(renderError({ title: t("adm.error.catalog.title"), heading: t("adm.error.catalog.heading"), message: String(error?.message || error), theme: lastCatalog?.theme || "dark" }));
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
  // The sidebar's 「定时授权」 entry leads to the constraint page (Task 7 item B), not to the frozen
  // legacy page: one entry, the page that works. The frozen page stays reachable from that page as a
  // read-only link, and `accessPolicyBase` (below) still names it for the surfaces that read it.
  let constraintsBase = null;

  accessPolicyBase = accessPolicyAdmin
    ? registerAccessPolicyRoutes(router, {
      admin: accessPolicyAdmin,
      provider,
      authorizationMode,
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
          return renderAuthShell({ ...opts, constraintsBase: constraintsBase ?? opts.constraintsBase, vaultGitBase: vaultGitBase ?? opts.vaultGitBase, theme: opts.theme || fallback?.theme || "dark", navCounts: { ...(fallback?.navCounts || {}), ...(opts.navCounts || {}) }, navAttention: { ...(fallback?.navAttention || {}), ...(opts.navAttention || {}) } });
        },
        layout: (title, body) => renderDocument({ title: title || t("adm.doc.title"), theme: lastCatalog?.theme || "dark", bodyHtml: body }),
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
          return renderAuthShell({ ...opts, constraintsBase: constraintsBase ?? opts.constraintsBase, vaultGitBase: vaultGitBase ?? opts.vaultGitBase, theme: opts.theme || fallback?.theme || "dark", navCounts: { ...(fallback?.navCounts || {}), ...(opts.navCounts || {}) }, navAttention: { ...(fallback?.navAttention || {}), ...(opts.navAttention || {}) } });
        },
        layout: (title, body) => renderDocument({ title: title || t("adm.doc.title"), theme: lastCatalog?.theme || "dark", bodyHtml: body }),
      },
    })?.base ?? null
    : null;

  let lastCatalogRef = null;
  void lastCatalogRef;

  // The per-Vault constraint writes (plan Task 5). Registered from the module rather than behind an
  // `if` on the service: the boundary inventory derives its rows from the routes that exist, so a
  // boundary that vanished whenever a service was missing would leave a hole in the manifest.
  // Without a service the five routes answer 503 `authorization_admin_unavailable`.
  constraintsBase = registerAuthorizationRoutes(router, {
    service: authorizationAdmin,
    requireAdmin,
    requireCsrf,
    authorizationMode,
    actions: {
      // A POST carries no catalog (one is built for a GET only), and a refused browser write must
      // render the page again. Building one here keeps the model in this router's hands and the route
      // module free of a second store read.
      catalog: (req) => buildCatalog({ deps, req, query: req.query }),
      // The frozen legacy page, offered from the new page as a read-only link.
      legacyPolicyBase: accessPolicyBase,
    },
    // The page renders inside the same shell the other Admin surfaces use, and the same late-injected
    // bases: 「定时授权」 is one nav entry, so a page that rendered its own sidebar would fork it.
    view: {
      renderAuthShell: (opts) => {
        const fallback = opts.catalog || lastCatalog;
        return renderAuthShell({ ...opts, constraintsBase: constraintsBase ?? opts.constraintsBase, vaultGitBase: vaultGitBase ?? opts.vaultGitBase, theme: opts.theme || fallback?.theme || "dark", navCounts: { ...(fallback?.navCounts || {}), ...(opts.navCounts || {}) }, navAttention: { ...(fallback?.navAttention || {}), ...(opts.navAttention || {}) } });
      },
    },
  })?.base ?? null;

  registerAuthorizationTransferRoutes(router, {
    provider,
    requireAdmin,
    requireCsrf,
    view: { layout: (title, body) => renderDocument({ title: title || t("adm.doc.title"), theme: lastCatalog?.theme || "dark", bodyHtml: body }) },
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
      res.status(429).send(renderLoginLocked({ retryAfterSeconds, formatLockRemaining: (seconds) => formatLockRemaining(seconds, adminLocale()) }));
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
      page = renderAuthTab(activeTab, { ...catalog, req, csrf: req.adminSession.csrf, session: req.adminSession, publicBaseUrl, accessPolicyBase, vaultGitBase, constraintBase: constraintsBase, authorizationMode });
    } catch (error) {
      res.status(500).send(renderError({ title: t("adm.router.error.renderTitle"), heading: t("adm.router.error.renderTitle"), message: String(error?.message || error), theme: catalog?.theme }));
      return;
    }
    res.send(renderAuthShell({
      activeTab,
      constraintsBase,
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
      if (!scopes.length) throw new Error(t("adm.router.error.scopeRequired"));
      const vaults = listField(req.body, "allowedVault");
      if (!vaults.length) throw new Error(t("adm.router.error.vaultRequired"));
      const id = String(req.body?.id || "");
      if (id === "configured-env") {
        refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.envReadOnlyScope"), "keys");
        return;
      }
      // Existence is checked first: an unknown id must be refused without touching the service at all.
      const snapshot = await provider.authorizationSnapshot();
      if (!(snapshot.apiKeys || []).some((item) => String(item.id) === id)) {
        refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.keyMissingScope"), "keys");
        return;
      }
      const updated = await provider.updateApiKey(id, { allowedScopes: scopes, allowedVaults: vaults });
      if (!updated) {
        refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.keyUnchanged"), "keys");
        return;
      }
      await onCredentialRevoked(`api-key:${id}`);
      setFlash(req, t("adm.router.flash.keyScopesUpdated"));
      redirectTab(res, "keys");
    } catch (error) {
      res.status(400).send(renderError({ title: t("adm.router.error.updateTitle"), heading: t("adm.router.error.keyScopesHeading"), message: String(error?.message || error) }));
    }
  });

  router.post("/api-key/delete", requireAdmin, requireCsrf, async (req, res) => {
    const id = String(req.body?.id || "");
    if (id === "configured-env") {
      refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.envReadOnlyDelete"), "keys");
      return;
    }
    const snapshot = await provider.authorizationSnapshot();
    const key = (snapshot.apiKeys || []).find((item) => String(item.id) === id);
    if (!key) {
      refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.keyMissingDelete"), "keys");
      return;
    }
    const expected = keyConfirmLabel(key);
    if (!expected || confirmToken(req) !== expected) {
      refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.keyMismatch", { name: expected || t("adm.router.unnamed") }), "keys");
      return;
    }
    if (!await provider.deleteApiKey(id)) {
      refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.keyNotRemoved"), "keys");
      return;
    }
    await onCredentialRevoked(`api-key:${id}`);
    setFlash(req, t("adm.router.flash.keyDeleted"));
    redirectTab(res, "keys");
  });

  router.post("/oauth/user/create", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const scopes = listField(req.body, "allowedScope");
      if (!scopes.length) throw new Error(t("adm.router.error.scopeRequired"));
      const vaults = listField(req.body, "allowedVault");
      if (!vaults.length) throw new Error(t("adm.router.error.vaultRequired"));
      await provider.createOAuthUser({ username: req.body?.username, password: req.body?.password, displayName: req.body?.displayName, allowedScopes: scopes, allowedVaults: vaults });
      redirectTab(res, "accounts");
    } catch (error) {
      res.status(400).send(renderError({ title: t("adm.router.error.createTitle"), heading: t("adm.router.error.accountCreateHeading"), message: String(error?.message || error) }));
    }
  });

  router.post("/oauth/user/scopes", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const scopes = listField(req.body, "allowedScope");
      if (!scopes.length) throw new Error(t("adm.router.error.scopeRequired"));
      const vaults = listField(req.body, "allowedVault");
      if (!vaults.length) throw new Error(t("adm.router.error.vaultRequired"));
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
      if (keep) setFlash(req, t("adm.router.flash.accountScopesAdditive"));
      else if (!decision.additive) setFlash(req, t("adm.router.flash.accountScopesNarrowed", { count: revoked }));
      else setFlash(req, t("adm.router.flash.accountScopesRevoked", { count: revoked }));
      redirectTab(res, "accounts");
    } catch (error) {
      res.status(400).send(renderError({ title: t("adm.router.error.updateTitle"), heading: t("adm.router.error.accountScopesHeading"), message: String(error?.message || error) }));
    }
  });

  router.post("/oauth/user/password", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const userId = String(req.body?.id || "");
      const result = await provider.updateOAuthUser(userId, { password: req.body?.password });
      for (const clientId of result?.revokedClientIds || []) await onCredentialRevoked(clientId, { userId });
      setFlash(req, t("adm.router.flash.passwordReset", { count: (result?.revokedClientIds || []).length }));
      redirectTab(res, "accounts");
    } catch (error) {
      res.status(400).send(renderError({ title: t("adm.router.error.updateTitle"), heading: t("adm.router.error.passwordHeading"), message: String(error?.message || error) }));
    }
  });

  router.post("/oauth/user/toggle", requireAdmin, requireCsrf, async (req, res) => {
    const userId = String(req.body?.id || "");
    const disable = req.body?.disabled === "true";
    const result = await provider.updateOAuthUser(userId, { disabled: disable });
    for (const clientId of result?.revokedClientIds || []) await onCredentialRevoked(clientId, { userId });
    setFlash(req, disable ? t("adm.router.flash.accountDisabled") : t("adm.router.flash.accountEnabled"));
    redirectTab(res, "accounts");
  });

  router.post("/oauth/user/delete", requireAdmin, requireCsrf, async (req, res) => {
    const userId = String(req.body?.id || "");
    const snapshot = await provider.authorizationSnapshot();
    const account = (snapshot.oauthUsers || []).find((item) => String(item.id) === userId);
    if (!account) {
      refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.accountMissing"), "accounts");
      return;
    }
    const expected = String(account.username || "").trim();
    if (!expected || confirmToken(req) !== expected) {
      refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.accountMismatch", { name: expected || t("adm.router.unset") }), "accounts");
      return;
    }
    const clientIds = await provider.deleteOAuthUser(userId);
    for (const clientId of clientIds || []) await onCredentialRevoked(clientId, { userId });
    setFlash(req, t("adm.router.flash.accountDeleted"));
    redirectTab(res, "accounts");
  });

  router.post("/oauth/client/revoke", requireAdmin, requireCsrf, async (req, res) => {
    const clientId = String(req.body?.clientId || "");
    if (!await provider.revokeClient(clientId, false)) {
      refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.clientMissing"), "clients");
      return;
    }
    await onCredentialRevoked(clientId);
    setFlash(req, t("adm.router.flash.clientRevoked"));
    redirectTab(res, "clients");
  });

  router.post("/oauth/client/delete", requireAdmin, requireCsrf, async (req, res) => {
    const clientId = String(req.body?.clientId || "");
    const snapshot = await provider.authorizationSnapshot();
    const client = (snapshot.clients || []).find((item) => String(item.clientId) === clientId);
    if (!client) {
      refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.clientMissing"), "clients");
      return;
    }
    // The page asks for the client name, or the literal `delete` for an unnamed client.
    const expected = String(client.clientName || "delete").trim();
    if (confirmToken(req) !== expected) {
      refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.clientMismatch", { name: expected }), "clients");
      return;
    }
    if (!await provider.revokeClient(clientId, true)) {
      refuse(req, res, t("adm.refuse.heading"), t("adm.router.refuse.clientNotRemoved"), "clients");
      return;
    }
    await onCredentialRevoked(clientId);
    setFlash(req, t("adm.router.flash.clientDeleted"));
    redirectTab(res, "clients");
  });

  router.post("/oauth/token/revoke", requireAdmin, requireCsrf, async (req, res) => {
    const revoked = await provider.revokeTokenById(String(req.body?.type || ""), String(req.body?.id || ""));
    if (revoked?.clientId) await onCredentialRevoked(revoked.clientId, { userId: revoked.userId });
    setFlash(req, t("adm.router.flash.tokenRevoked"));
    redirectTab(res, "tokens");
  });

  router.post("/oauth/token/cleanup", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const result = await provider.cleanupTokenRecords(req.body?.olderThanDays ?? 7);
      setFlash(req, t("adm.router.flash.tokenCleanup", { total: result.total, access: result.access, refresh: result.refresh }));
      redirectTab(res, "tokens");
    } catch (error) {
      res.status(400).send(renderError({ title: t("adm.router.error.cleanupTitle"), heading: t("adm.router.error.cleanupHeading"), message: String(error?.message || error) }));
    }
  });

  router.post("/publish/revoke", requireAdmin, requireCsrf, async (req, res) => {
    const removed = publishService ? await publishService.revokeById(String(req.body?.id || "")) : null;
    if (removed) provider.recordAudit({ action: "admin.publish.revoke", credentialType: "admin-session", source: source(req), detail: `${removed.vaultId}:${removed.path}` });
    setFlash(req, removed ? t("adm.router.flash.publishRevoked") : t("adm.router.flash.publishMissing"), removed ? "ok" : "err");
    redirectTab(res, "publishes");
  });

  // 审计 CSV 导出（原型把「导出 CSV」画成设想）。只读 GET，与页面同一套筛选参数，因此导出的就是
  // 操作员正在看的那一屏；不新增权限面：仍然只给 Admin 会话，不记审计（读不写）。
  router.get("/audit/export.csv", requireAdmin, (req, res) => {
    const { body, filename } = auditCsv(req.adminCatalog || {}, req.query || {});
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  });

  router.post("/audit/clear", requireAdmin, requireCsrf, async (req, res) => {
    // The clear-confirm token is a capability check, so both sides read the SAME catalog entry in
    // the SAME request language: the page renders it, the browser `pattern` mirrors it, and this
    // comparison re-checks it. Keeping one literal here would silently reject an English operator.
    if (confirmToken(req) !== t("adm.audit.clearToken")) {
      refuse(req, res, t("adm.refuse.heading"), t("adm.audit.clearMismatch", { token: t("adm.audit.clearToken") }), "audit");
      return;
    }
    await provider.clearAudit();
    setFlash(req, t("adm.router.flash.auditCleared"));
    redirectTab(res, "audit");
  });

  return router;
}
