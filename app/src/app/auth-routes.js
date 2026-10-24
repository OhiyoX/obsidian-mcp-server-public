// Auth / login / logout Web routes.
//
// Extracted verbatim from `routes.js` (AuthZ Wave C) because that file is bound
// by the architecture line budget and the temporal-access wiring must not
// delete tests, error handling or security checks to fit. This module owns the
// anonymous login chrome plus the session-creating login and the logout route;
// middleware ordering and responses are unchanged (`router.use("/auth", ...)`
// urlencoded parsing stays in `routes.js` before this registration runs).
import { randomBytes } from "node:crypto";
import { lockoutLoginMessage, lockoutRetryAfter } from "../login-lockout.js";
import { VAULT } from "../config.js";
import { loginPage } from "./pages.js";
import { readWebAppearance, readWebThemeCss, resolveWebThemeAsset } from "./themes.js";
import { defaultWebVaultId, listWebVaults } from "./vault-registry.js";
import { WEB_SESSION_COOKIE, WEB_SESSION_TTL_MS } from "./web-session-store.js";

const token = (bytes = 32) => randomBytes(bytes).toString("base64url");

// The internal app root, with its trailing slash. The installed app's manifest resolves
// `scope` to `/app/`, so every internal navigation target and post-login return must carry the
// slash or it would leave the installed app's scope (#471).
const APP_ROOT = "/app/";

export function safeNext(value) {
  const candidate = String(value || APP_ROOT);
  if (/[\\\r\n\0]/.test(candidate)) return APP_ROOT;
  try {
    const parsed = new URL(candidate, "https://local.invalid");
    if (parsed.origin !== "https://local.invalid" || (parsed.pathname !== "/app" && !parsed.pathname.startsWith("/app/"))) return APP_ROOT;
    // Keep the accept-set above unchanged (slash-less `/app` and every `/app/…` deep link still
    // pass); only the exact app root is normalised to the slash form. `search` is preserved as
    // before, so note/Base deep links keep their query.
    return `${parsed.pathname === "/app" ? APP_ROOT : parsed.pathname}${parsed.search}`;
  } catch {
    return APP_ROOT;
  }
}

export async function loginAppearance() {
  try {
    const inventory = await listWebVaults();
    const primary = inventory.vaults.find((item) => item.primary) || inventory.vaults[0];
    const root = primary?.root || VAULT;
    return await readWebAppearance(root);
  } catch {
    return { themeId: null, colorMode: "system", baseFontSize: 16 };
  }
}

async function loginVaultRoot() {
  try {
    const inventory = await listWebVaults();
    const primary = inventory.vaults.find((item) => item.primary) || inventory.vaults[0];
    return primary?.root || VAULT;
  } catch {
    return VAULT;
  }
}

export function registerAuthRoutes(router, { provider, store, requirePage, currentSession, secureCookie, source }) {
  router.get("/auth/login", async (req, res) => {
    const next = safeNext(req.query.next);
    if (await currentSession(req)) return res.redirect(303, next);
    res.send(loginPage("", await loginAppearance(), next));
  });
  router.post("/auth/login", async (req, res) => {
    const next = safeNext(req.body?.next);
    try {
      const user = await provider.authenticateOAuthUser(req.body?.username, req.body?.password, { source: source(req), userAgent: String(req.headers["user-agent"] || "").slice(0, 240) });
      if (!user || !user.allowedScopes.includes("obsidian.read")) return res.status(403).send(loginPage("用户名、密码或账户权限不正确。", await loginAppearance(), next));
      if (!user.allowedVaults?.length) return res.status(403).send(loginPage("此账户尚未分配 Vault。", await loginAppearance(), next));
      const id = token();
      const now = store.now();
      const created = await store.createSession(id, { userId: user.id, userUpdatedAt: user.updatedAt, csrf: token(), vaultId: user.allowedVaults[0] || defaultWebVaultId(), createdAt: now, expiresAt: now + WEB_SESSION_TTL_MS, lastSeenAt: now });
      if (!created.ok) return res.status(503).send(loginPage("登录暂时不可用，请稍后重试。", await loginAppearance(), next));
      res.cookie(WEB_SESSION_COOKIE, id, { httpOnly: true, secure: secureCookie, sameSite: "lax", maxAge: WEB_SESSION_TTL_MS, path: "/" });
      res.redirect(303, next);
    } catch (error) {
      if (/Too many/.test(error.message)) return res.status(429).send(loginPage(lockoutLoginMessage(lockoutRetryAfter(res, error)), await loginAppearance(), next));
      console.error("Obsidian Web login error:", error);
      return res.status(500).send(loginPage("登录暂时不可用，请稍后重试。", await loginAppearance(), next));
    }
  });

  // Public login chrome: only the default vault's configured theme (no arbitrary browsing).
  router.get("/auth/theme.css", async (req, res, next) => {
    try {
      const root = await loginVaultRoot();
      const appearance = await readWebAppearance(root);
      const requested = String(req.query.name || "").trim();
      const themeId = appearance.themeId || "";
      if (!themeId || (requested && requested !== themeId)) return res.sendStatus(404);
      const { theme, css } = await readWebThemeCss(themeId, root, { assetBase: "/auth/theme-asset" });
      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader("X-Obsidian-Theme", encodeURIComponent(theme.id));
      res.type("text/css").send(css);
    } catch (error) {
      if (error?.code === "ENOENT") return res.sendStatus(404);
      next(error);
    }
  });

  router.get("/auth/theme-asset", async (req, res, next) => {
    try {
      const root = await loginVaultRoot();
      const appearance = await readWebAppearance(root);
      const themeId = appearance.themeId || "";
      if (!themeId || String(req.query.name || "").trim() !== themeId) return res.sendStatus(404);
      const asset = await resolveWebThemeAsset(themeId, req.query.path, root);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.sendFile(asset.absolute);
    } catch (error) {
      if (error?.code === "ENOENT") return res.sendStatus(404);
      next(error);
    }
  });

  router.post("/auth/logout", requirePage, async (req, res) => {
    if (req.body?.csrf !== req.webSession.csrf) return res.status(403).send("CSRF validation failed");
    const revoked = await store.revoke(req.webSession.id);
    if (!revoked.ok) return res.status(503).send(loginPage("注销暂时不可用，请稍后重试。", { colorMode: "system" }));
    res.clearCookie(WEB_SESSION_COOKIE, { path: "/" });
    res.redirect(303, "/auth/login");
  });
}
