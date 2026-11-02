// Browser-side translator (Web 中英双语).
//
// The locale decision is made once, on the server, and published on the document
// element (`<html lang>`); this module only looks it up. That keeps one catalog
// (`src/i18n/messages/`) authoritative for both renderers — a client string can
// never be in a different language than the markup it is written into.
//
// Resolution is lazy on purpose: feature modules call `t()` from render paths, and
// the bundle must not depend on an initialization order between `core/app.js` and
// the features it imports. `initI18n()` exists for tests and for a future runtime
// language switch that does not reload the page.
import { DEFAULT_LOCALE, createTranslator, normalizeLocaleTag } from "../../../src/i18n/index.js";

function detectLocale(root) {
  const element = root?.documentElement || root;
  return normalizeLocaleTag(element?.getAttribute?.("lang") || element?.lang) || DEFAULT_LOCALE;
}

let translator = null;

/** (Re)build the translator from `<html lang>`; returns the active handle. */
export function initI18n(root = globalThis.document) {
  translator = createTranslator(detectLocale(root));
  return translator;
}

function active() {
  return translator || initI18n();
}

/** Translate one key. Params are inserted verbatim (escape before HTML contexts). */
export function t(key, params) {
  return active().t(key, params);
}

/** Active locale id (`zh-CN` / `en`). */
export function currentLocale() {
  return active().locale;
}

/** Reset for tests: the next `t()` re-reads the document element. */
export function resetI18n() {
  translator = null;
}
