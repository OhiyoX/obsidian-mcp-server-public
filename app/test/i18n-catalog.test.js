// i18n catalog contract: both shipped locales must be complete and in sync.
//
// The translator falls back and then returns the key, so a missing translation is
// never a crash — which is exactly why it needs a gate: nothing else would report
// it. This test owns three invariants:
//   1. `zh-CN` and `en` carry exactly the same keys;
//   2. every key the code asks for exists in both catalogs (scanned from source,
//      so a renamed key cannot survive on the strength of the fallback);
//   3. no user-visible Han literal is left in the converted page renderer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  catalogFor,
  catalogs,
  createTranslator,
  htmlLang,
  normalizeLocaleTag,
  parseAcceptLanguage,
  readCookie,
  resolveLocale,
} from "../src/i18n/index.js";

const zh = catalogFor("zh-CN");
const en = catalogFor("en");

test("both locales ship the same key set", () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys.filter((key) => !zhKeys.includes(key)), [], "en has keys zh-CN does not");
  assert.deepEqual(zhKeys.filter((key) => !enKeys.includes(key)), [], "zh-CN has keys en does not");
  assert.deepEqual(Object.keys(catalogs()).sort(), [...SUPPORTED_LOCALES].sort());
});

test("no message is empty or placeholder-inconsistent between locales", () => {
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, "string", `${key} must be a string`);
    assert.ok(value.trim().length > 0, `${key} is empty in zh-CN`);
    assert.ok(en[key].trim().length > 0, `${key} is empty in en`);
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(en[key]), placeholders(value), `${key}: placeholder mismatch between locales`);
  }
});

// Source files that render copy through the catalog. `src/app/pages.js` is the
// converted surface; the switch route and the lockout copy sit beside it.
const SOURCES = [
  "src/app/pages.js",
  "src/app/locale-routes.js",
  "src/login-lockout.js",
  "frontend/app/features/publish/theme-toggle.js",
  "frontend/app/core/i18n.js",
];

function usedKeys() {
  const keys = new Map();
  for (const file of SOURCES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) {
      if (!keys.has(match[1])) keys.set(match[1], file);
    }
    // Template-literal keys: `settings.language.${id}` over a known id list.
    for (const match of source.matchAll(/\bt\(\s*`([^`]+)`/g)) {
      const pattern = new RegExp(`^${match[1].replace(/\./g, "\\.").replace(/\$\{(\w+)\}/g, "([A-Za-z0-9_-]+)")}$`);
      const [, prefix, , suffix] = /^(.*)\$\{(\w+)\}(.*)$/.exec(match[1]) || [];
      assert.ok(prefix !== undefined, `unsupported template key in ${file}: ${match[1]}`);
      for (const id of SUPPORTED_LOCALES) {
        const candidate = `${prefix}${id}${suffix}`;
        assert.match(candidate, pattern);
        if (!keys.has(candidate)) keys.set(candidate, file);
      }
    }
  }
  return keys;
}

test("every key the renderers ask for exists in both catalogs", () => {
  const missing = [];
  for (const [key, file] of usedKeys()) {
    if (!Object.hasOwn(zh, key)) missing.push(`${file}: ${key}`);
  }
  assert.deepEqual(missing, []);
});

test("the converted page renderer keeps no Han literal outside the catalog", () => {
  const source = readFileSync(new URL("../src/app/pages.js", import.meta.url), "utf8");
  const hits = source.split("\n").filter((line) => /[\u4e00-\u9fff]/.test(line));
  assert.deepEqual(hits, [], "labels belong in src/i18n/messages/, not in the renderer");
});

test("interpolation keeps unknown placeholders and misses never blank a label", () => {
  const zhTranslator = createTranslator("zh-CN");
  assert.equal(zhTranslator.t("shell.logout", { user: "owner" }), "退出 owner");
  assert.equal(zhTranslator.t("shell.logout"), "退出 {user}");
  assert.equal(zhTranslator.t("shell.logout", { other: "x" }), "退出 {user}");
  assert.equal(zhTranslator.t("does.not.exist"), "does.not.exist");
});

test("an unsupported locale falls back to the default catalog", () => {
  const translator = createTranslator("de-DE");
  assert.equal(translator.locale, DEFAULT_LOCALE);
  assert.equal(translator.t("shell.save"), zh["shell.save"]);
  assert.equal(createTranslator("en").t("shell.save"), en["shell.save"]);
});

test("locale tags normalize to the shipped ids", () => {
  assert.equal(normalizeLocaleTag("zh"), "zh-CN");
  assert.equal(normalizeLocaleTag("zh-Hans-CN"), "zh-CN");
  assert.equal(normalizeLocaleTag("zh_cn"), "zh-CN");
  assert.equal(normalizeLocaleTag("en-US"), "en");
  assert.equal(normalizeLocaleTag("EN"), "en");
  assert.equal(normalizeLocaleTag("fr"), null);
  assert.equal(normalizeLocaleTag(""), null);
  assert.equal(normalizeLocaleTag(undefined), null);
  assert.equal(htmlLang("zh-Hans"), "zh-CN");
  assert.equal(htmlLang("en-US"), "en");
});

test("Accept-Language is honoured in q-value order and ignores unknown tags", () => {
  assert.deepEqual(parseAcceptLanguage("en-US,en;q=0.9,zh-CN;q=0.8"), ["en", "zh-CN"]);
  assert.deepEqual(parseAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.4"), ["zh-CN", "en"]);
  assert.deepEqual(parseAcceptLanguage("fr-FR,de;q=0.8"), []);
  assert.deepEqual(parseAcceptLanguage("fr,en;q=0.5"), ["en"]);
  assert.deepEqual(parseAcceptLanguage("en;q=0, zh;q=0.3"), ["zh-CN"]);
  assert.deepEqual(parseAcceptLanguage(""), []);
});

test("request locale order is query → cookie → default, with Accept-Language only behind an explicit auto", () => {
  assert.equal(resolveLocale({ query: "en", cookie: "zh-CN", acceptLanguage: "zh-CN" }), "en");
  assert.equal(resolveLocale({ query: "de", cookie: "en", acceptLanguage: "zh-CN" }), "en", "an unsupported query value must not defeat the stored preference");
  assert.equal(resolveLocale({ cookie: "en", acceptLanguage: "zh-CN" }), "en");
  // "Follow the browser" is the only path that reads Accept-Language, and it is an explicit choice.
  assert.equal(resolveLocale({ cookie: "auto", acceptLanguage: "en-GB" }), "en");
  assert.equal(resolveLocale({ cookie: "auto", acceptLanguage: "fr-FR" }), DEFAULT_LOCALE);
  // No preference stored ⇒ the default face, even for an English browser: this deployment's copy,
  // parity gate and client selectors are Chinese-first, so the switch has to be explicit.
  assert.equal(resolveLocale({ acceptLanguage: "en-GB,en;q=0.9" }), DEFAULT_LOCALE);
  assert.equal(resolveLocale({ acceptLanguage: "fr-FR" }), DEFAULT_LOCALE);
  assert.equal(resolveLocale({}), DEFAULT_LOCALE);
});

test("the preference cookie is read without a parser dependency", () => {
  assert.equal(readCookie(`a=1; ${LOCALE_COOKIE}=en; b=2`, LOCALE_COOKIE), "en");
  assert.equal(readCookie(`${LOCALE_COOKIE}=zh-CN`, LOCALE_COOKIE), "zh-CN");
  assert.equal(readCookie("other=en", LOCALE_COOKIE), null);
  assert.equal(readCookie(undefined, LOCALE_COOKIE), null);
  assert.equal(readCookie(`${LOCALE_COOKIE}=`, LOCALE_COOKIE), "");
});
