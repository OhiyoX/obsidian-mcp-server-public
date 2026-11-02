// Admin-plane catalogs.
//
// Kept out of `src/i18n/index.js` on purpose: the Web client bundles that module,
// and the Admin surface is server-rendered copy only. Merging the Web messages in
// here means one `t()` in the Admin plane can also resolve shared copy (the lockout
// wait fragment, the release footer), so there is still a single lookup chain.
import { DEFAULT_LOCALE, normalizeLocaleTag, translatorFor } from "./index.js";
import en from "./admin/en.js";
import zhCN from "./admin/zh-CN.js";
import webEn from "./messages/en.js";
import webZhCN from "./messages/zh-CN.js";

const CATALOGS = Object.freeze({
  "zh-CN": Object.freeze({ ...webZhCN, ...zhCN }),
  en: Object.freeze({ ...webEn, ...en }),
});

/** Translator over the Admin + shared copy. `zh-CN` is the default and the fallback. */
export function createAdminTranslator(locale) {
  return translatorFor(CATALOGS, locale);
}

/** Admin-only message table for one locale (tests: key parity between locales). */
export function adminCatalogFor(locale) {
  const resolved = normalizeLocaleTag(locale) || DEFAULT_LOCALE;
  return resolved === "zh-CN" ? zhCN : en;
}

/** Both Admin message tables keyed by locale id. */
export function adminCatalogs() {
  return Object.freeze({ "zh-CN": zhCN, en });
}

export { CATALOGS as adminTranslatorCatalogs };
