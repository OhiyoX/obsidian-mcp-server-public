// Interface-language preference route (Web 中英双语).
//
// `GET /app/language?lang=auto|zh-CN|en` stores the choice in a cookie and sends
// the reader back where they came from. It is deliberately a plain GET with no
// script and no CSRF token:
//   * the state it changes is a display preference, not an authorization or a
//     stored record, and it only ever affects the caller's own browser;
//   * the settings dialog is usable without JavaScript (D0/CSP discipline), and a
//     form POST would drag the page-level CSRF/session machinery into an anonymous
//     page the login screen also uses;
//   * `next` never comes from the request alone — it is validated to a same-origin
//     app/login/publish path, otherwise the Referer path, otherwise `/app/`.
import { LOCALE_COOKIE, LOCALE_PREFERENCE_AUTO, SUPPORTED_LOCALES, normalizeLocaleTag } from "../i18n/index.js";

const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_NEXT = "/app/";
const ORIGIN = "https://locale.invalid";

// Surfaces that render localized copy. Both planes share one preference cookie: an
// operator who reads the Admin pages in English should not meet a Chinese Web shell
// on the very next click.
const ALLOWED_PREFIXES = ["/app", "/auth/login", "/publish/", "/admin/auth"];

/** Same-origin path restricted to surfaces that render localized copy. */
export function safeLocaleNext(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate || /[\\\r\n\0]/.test(candidate)) return null;
  try {
    const parsed = new URL(candidate, ORIGIN);
    if (parsed.origin !== ORIGIN) return null;
    const allowed = ALLOWED_PREFIXES.some((prefix) => (prefix.endsWith("/") ? parsed.pathname.startsWith(prefix) : parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`)));
    if (!allowed) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/** Path of the referring page on this origin, if it is one we may return to. */
function refererNext(req) {
  const header = req?.get?.("referer") || req?.headers?.referer;
  if (!header) return null;
  try {
    const parsed = new URL(header);
    const host = req?.get?.("host");
    if (host && parsed.host !== host) return null;
    return safeLocaleNext(`${parsed.pathname}${parsed.search}`);
  } catch {
    return null;
  }
}

export function registerLocaleRoutes(router, { secureCookie = true, path = "/app/language", defaultNext = DEFAULT_NEXT } = {}) {
  router.get(path, (req, res) => {
    const requested = String(req.query?.lang ?? "").trim();
    const locale = normalizeLocaleTag(requested);
    if (locale && SUPPORTED_LOCALES.includes(locale)) {
      res.cookie(LOCALE_COOKIE, locale, { httpOnly: true, secure: secureCookie, sameSite: "lax", maxAge: COOKIE_MAX_AGE_MS, path: "/" });
    } else if (requested === LOCALE_PREFERENCE_AUTO) {
      // "Follow the browser" is the absence of a stored preference.
      res.clearCookie(LOCALE_COOKIE, { path: "/" });
    }
    const next = safeLocaleNext(req.query?.next) || refererNext(req) || defaultNext;
    // 303: the browser re-issues the GET for the target page, so the rebuilt page
    // renders in the newly stored language instead of replaying a cached body.
    res.redirect(303, next);
  });
}
