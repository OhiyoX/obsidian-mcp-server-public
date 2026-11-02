// Shared login lockout window and remaining-time formatting.
//
// Three entry points throttle repeated password failures with the same window
// (admin password login, Web OAuth-account login, and the OAuth consent page).
// They used to hardcode "15 分钟" and drop `Retry-After` entirely, so a locked
// out operator could not tell when retrying would work again. Keep the window
// definition and the display math here so the three surfaces cannot drift.
//
// Window policy is intentionally unchanged: the window starts at the first
// failure of a run, and reaching LOGIN_LOCK_MAX_FAILURES blocks until it ends.
// See the project note for the open question about lock-triggered windows.
//
// i18n: the copy is looked up in the shared catalog. `locale` defaults to
// `zh-CN`, which is byte-identical to the historic strings, so admin/consent
// callers that pass no locale keep their current output.
import { DEFAULT_LOCALE, createTranslator } from "./i18n/index.js";

export const LOGIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCK_MAX_FAILURES = 8;

// Whole seconds a caller should wait before retrying, rounded up so a sub-second
// remainder never displays as "0 秒". Returns 0 once the window has elapsed.
export function lockRetryAfterSeconds(resetAt, now = Date.now()) {
  const remainingMs = Number(resetAt) - Number(now);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

// Localized wait fragment: minutes only above a minute, otherwise seconds, so
// short remaining windows are still honest instead of rounding up to one minute.
export function formatLockRemaining(seconds, locale = DEFAULT_LOCALE) {
  const { t } = createTranslator(locale);
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (total >= 60) return t("login.error.waitMinutes", { minutes: Math.ceil(total / 60) });
  return t("login.error.waitSeconds", { seconds: total });
}

// RFC 9110 Retry-After in seconds. Only set for an active lockout.
export function setRetryAfter(res, seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (total > 0 && typeof res?.set === "function") res.set("Retry-After", String(total));
  return total;
}

// One-line helpers so the Web login route and the consent page stay inside the
// module line budget while sharing identical copy.
export function lockoutRetryAfter(res, error) {
  return setRetryAfter(res, error?.retryAfterSeconds);
}

export function lockoutLoginMessage(seconds, locale = DEFAULT_LOCALE) {
  const { t } = createTranslator(locale);
  return t("login.error.tooManyAttempts", { wait: formatLockRemaining(seconds, locale) });
}

/** Same copy as `{ key, params }`, for renderers that translate the key in the
 *  page language themselves (the Web login page): the wait fragment must be
 *  localized in the same language as the sentence that contains it. */
export function lockoutLoginError(seconds, locale = DEFAULT_LOCALE) {
  return { key: "login.error.tooManyAttempts", params: { wait: formatLockRemaining(seconds, locale) } };
}
