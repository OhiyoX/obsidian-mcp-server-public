// Request-scoped translator for the Admin plane.
//
// Why request scope instead of threading a `t` through every function: the Admin
// presentation layer is a set of pure, module-level lookup tables (`labels.js`,
// `vocab.js`, `states.js`) plus page renderers that were written without a locale
// parameter, and the parity gate compares their **Chinese** output against the
// prototype. Passing a translator through ~150 call sites would be a rewrite that
// touches every contract test for no behavioural gain; `AsyncLocalStorage` gives
// each request its own translator while the module-level tables stay module-level.
//
// Contract:
//   * No context (unit tests, scripts that call a page renderer directly) ⇒ the
//     `zh-CN` catalog, i.e. the historic output, byte for byte.
//   * `runWithAdminLocale()` must wrap the whole request, not just the render call:
//     async continuations (catalog builds, service awaits) inherit the store.
//   * Values are inserted verbatim; an HTML context escapes them before composing.
import { AsyncLocalStorage } from "node:async_hooks";
import { createAdminTranslator } from "./admin.js";
import { DEFAULT_LOCALE } from "./index.js";

const storage = new AsyncLocalStorage();
let defaultTranslator = null;

function fallback() {
  defaultTranslator ??= createAdminTranslator(DEFAULT_LOCALE);
  return defaultTranslator;
}

/** Run `fn` (and every async continuation it schedules) in `locale`'s Admin catalog. */
export function runWithAdminLocale(locale, fn) {
  const translator = createAdminTranslator(locale);
  return storage.run({ translator, locale: translator.locale }, fn);
}

/** Translate one Admin key in the current request's language. */
export function t(key, params) {
  const store = storage.getStore();
  return store ? store.translator.t(key, params) : fallback().t(key, params);
}

/** The locale this request renders in. */
export function adminLocale() {
  return storage.getStore()?.locale || DEFAULT_LOCALE;
}

/** `<html lang>` for the current request. */
export function adminHtmlLang() {
  const store = storage.getStore();
  return store ? store.translator.htmlLang : fallback().htmlLang;
}
