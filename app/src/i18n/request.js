// Per-request locale resolution for the Node/Express side.
//
// The browser-side translator reads the same decision back from `<html lang>`
// (and `data-ui-locale` on the workspace shell), so the two renderers cannot
// drift: the page renderer chooses once, the client only looks it up.
import { LOCALE_COOKIE, LOCALE_PREFERENCE_AUTO, normalizeLocaleTag, readCookie, resolveLocale } from "./index.js";

/**
 * `{ locale, preference }` for one request.
 *
 * `preference` is what the reader stored (`"auto"` / a supported id / `null` when
 * nothing is stored) and drives the settings select; `locale` is the resolved
 * catalog the page renders in. `?lang=` overrides the render but never rewrites
 * the stored preference, so a shared deep link cannot change someone's setting.
 */
export function localeInfo(req) {
  const raw = readCookie(req?.headers?.cookie, LOCALE_COOKIE);
  const normalized = normalizeLocaleTag(raw);
  const preference = normalized || (raw === LOCALE_PREFERENCE_AUTO ? LOCALE_PREFERENCE_AUTO : null);
  // A repeated query parameter arrives as an array; the first value is the one a
  // browser form would have submitted, and `[String(array)]` would match nothing.
  const requested = Array.isArray(req?.query?.lang) ? req.query.lang[0] : req?.query?.lang;
  const locale = resolveLocale({
    query: requested,
    cookie: raw,
    acceptLanguage: req?.headers?.["accept-language"],
  });
  return { locale, preference };
}

/** `Vary` for the HTML surfaces: the negotiated language is part of the response. */
export function attachLocale(req, res, next) {
  if (typeof res?.vary === "function") res.vary("Accept-Language");
  req.localeInfo = localeInfo(req);
  next();
}
