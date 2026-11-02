// Interface language plumbing (i18n) for the Obsidian Web surface.
//
// Scope of this module: locale identity, negotiation and message lookup. It is
// deliberately free of Node built-ins so the same translator and catalogs are
// bundled into the browser (`frontend/app/core/i18n.js`) and used server-side by
// the page renderers — one catalog, no HTML-side JSON payload, no inline script
// (the app CSP allows `script-src 'self'` only).
//
// Contract:
//   * `zh-CN` is the default and the fallback catalog. Every existing Chinese
//     string keeps byte-identical copy, so the zh render of a page is unchanged
//     unless a key is edited on purpose.
//   * A request locale is chosen as: `?lang=` → preference cookie → the first
//     supported `Accept-Language` entry → `zh-CN`.
//   * `t()` never throws for a missing key: it falls back to the default catalog
//     and finally to the key itself, which stays visible instead of blanking a
//     label. `test/i18n-catalog.test.js` pins catalog parity so that path is a
//     regression net, not a runtime mode.
import en from "./messages/en.js";
import zhCN from "./messages/zh-CN.js";

export const SUPPORTED_LOCALES = Object.freeze(["zh-CN", "en"]);
export const DEFAULT_LOCALE = "zh-CN";

/** Preference cookie owned by the locale switch route (`src/app/locale-routes.js`). */
export const LOCALE_COOKIE = "obsidian_web_locale";

/** `auto` means "no preference stored; follow the browser". */
export const LOCALE_PREFERENCE_AUTO = "auto";

const CATALOGS = Object.freeze({ "zh-CN": zhCN, en });
const HTML_LANG = Object.freeze({ "zh-CN": "zh-CN", en: "en" });

/**
 * Map an arbitrary BCP 47-ish tag onto a supported locale.
 * `zh`, `zh-Hans`, `zh-CN`, `zh-SG`, … → `zh-CN`; `en`, `en-US`, … → `en`.
 * Returns `null` for anything we do not ship a catalog for, so callers can keep
 * walking their negotiation order instead of silently showing the wrong language.
 */
export function normalizeLocaleTag(value) {
  const tag = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (!tag) return null;
  if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
  if (tag === "en" || tag.startsWith("en-")) return "en";
  return null;
}

/** Ordered supported locales from an `Accept-Language` header (q-values respected). */
export function parseAcceptLanguage(header) {
  const entries = [];
  for (const part of String(header ?? "").split(",")) {
    const [rawTag, ...params] = part.trim().split(";");
    if (!rawTag) continue;
    const locale = normalizeLocaleTag(rawTag);
    if (!locale) continue;
    let quality = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (!match) continue;
      const parsed = Number.parseFloat(match[1]);
      if (Number.isFinite(parsed)) quality = parsed;
    }
    if (quality <= 0) continue;
    if (entries.some((entry) => entry.locale === locale)) continue;
    entries.push({ locale, quality });
  }
  // Array.prototype.sort is stable, so equal q-values keep header order.
  return entries.sort((left, right) => right.quality - left.quality).map((entry) => entry.locale);
}

/**
 * Pick the locale for one render.
 *
 * Order: an explicit `?lang=` → the stored preference → `zh-CN`. `Accept-Language` is
 * honoured **only** when the reader explicitly chose "follow the browser" (`auto`),
 * never as an implicit default. Two reasons, both observed rather than stylistic:
 *   * this deployment's copy, its prototype-parity gate and several client-side
 *     selectors are Chinese-first; an implicit Accept-Language switch would render an
 *     English shell for every browser whose locale is `en`, silently changing the
 *     product face and the comparison baseline of a plane nobody asked to translate;
 *   * an implicit switch is also the surprising one: a reader who never picked a
 *     language should not get a different UI from a browser update.
 * The stored preference is a cookie, so it survives reloads and both planes share it.
 */
export function resolveLocale({ query, cookie, acceptLanguage } = {}) {
  const explicit = normalizeLocaleTag(query);
  if (explicit) return explicit;
  const stored = normalizeLocaleTag(cookie);
  if (stored) return stored;
  if (String(cookie ?? "").trim() === LOCALE_PREFERENCE_AUTO) {
    return parseAcceptLanguage(acceptLanguage)[0] || DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

/** `<html lang>` value. Same as the locale id today, kept separate for future tags. */
export function htmlLang(locale) {
  return HTML_LANG[normalizeLocaleTag(locale) || DEFAULT_LOCALE];
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.hasOwn(params, name) && params[name] !== undefined && params[name] !== null
      ? String(params[name])
      : match
  ));
}

/**
 * Build a translator out of an explicit catalog map (a locale → flat messages map).
 * Used by the Admin plane, whose catalogs are deliberately **not** bundled into the
 * Web client (`src/i18n/admin/`), and reusable for any future plane with its own copy.
 */
export function translatorFor(catalogs, locale, fallbackCatalogs = catalogs) {
  const resolved = normalizeLocaleTag(locale) || DEFAULT_LOCALE;
  const messages = catalogs[resolved] || catalogs[DEFAULT_LOCALE];
  const fallback = fallbackCatalogs[DEFAULT_LOCALE];
  const has = (key) => Object.hasOwn(messages, key) || Object.hasOwn(fallback, key);
  const t = (key, params) => {
    const template = Object.hasOwn(messages, key) ? messages[key] : fallback[key];
    if (template === undefined) return String(key);
    return interpolate(template, params);
  };
  return { locale: resolved, htmlLang: HTML_LANG[resolved], t, has };
}

/**
 * Build the translator for one render. Lookup order: the active catalog, then the
 * default catalog, then the raw key. Params are inserted verbatim — an HTML
 * context must pre-escape its values, an attribute context likewise.
 */
export function createTranslator(locale) {
  return translatorFor(CATALOGS, locale);
}

/** Message table for a locale, used by tests and tooling (not by the renderers). */
export function catalogFor(locale) {
  return CATALOGS[normalizeLocaleTag(locale) || DEFAULT_LOCALE];
}

/** All shipped catalogs keyed by locale id. */
export function catalogs() {
  return CATALOGS;
}

const COOKIE_SAFE = /^[A-Za-z0-9._-]+$/;

/** Read one cookie out of a raw `Cookie` header without a parser dependency. */
export function readCookie(header, name) {
  if (!name || !COOKIE_SAFE.test(name)) return null;
  for (const item of String(header ?? "").split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    if (item.slice(0, index).trim() !== name) continue;
    const value = item.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}
