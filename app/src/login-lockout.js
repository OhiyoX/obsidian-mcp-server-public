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

export const LOGIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCK_MAX_FAILURES = 8;

// Whole seconds a caller should wait before retrying, rounded up so a sub-second
// remainder never displays as "0 秒". Returns 0 once the window has elapsed.
export function lockRetryAfterSeconds(resetAt, now = Date.now()) {
  const remainingMs = Number(resetAt) - Number(now);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

// Chinese copy used by the admin page, the Web login page and the consent page.
// Minutes only above a minute, otherwise seconds, so short remaining windows are
// still honest instead of rounding up to "1 分钟".
export function formatLockRemaining(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (total >= 60) {
    const minutes = Math.ceil(total / 60);
    return `${minutes} 分钟`;
  }
  return `${total} 秒`;
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

export function lockoutLoginMessage(seconds) {
  return `登录尝试过多，请 ${formatLockRemaining(seconds)}后再试。`;
}
