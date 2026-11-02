import assert from "node:assert/strict";
import test from "node:test";

import {
  LOGIN_LOCK_MAX_FAILURES,
  LOGIN_LOCK_WINDOW_MS,
  formatLockRemaining,
  lockRetryAfterSeconds,
  setRetryAfter,
} from "../src/login-lockout.js";

// The remaining-time math is the part that must be deterministic, so it is
// asserted against an explicit clock instead of the wall clock.
test("lockout remaining time is computed from the reset timestamp", () => {
  const now = Date.UTC(2026, 9, 4, 0, 0, 0);
  const resetAt = now + LOGIN_LOCK_WINDOW_MS;

  assert.equal(LOGIN_LOCK_MAX_FAILURES, 8);
  assert.equal(LOGIN_LOCK_WINDOW_MS, 900000);
  assert.equal(lockRetryAfterSeconds(resetAt, now), 900);

  // A partially elapsed window must shrink instead of staying at 15 minutes.
  assert.equal(lockRetryAfterSeconds(resetAt, now + 60000), 840);
  assert.equal(lockRetryAfterSeconds(resetAt, now + 899500), 1);
  assert.equal(lockRetryAfterSeconds(resetAt, resetAt), 0);
  assert.equal(lockRetryAfterSeconds(resetAt, resetAt + 5000), 0);
  assert.equal(lockRetryAfterSeconds(undefined, now), 0);
});

test("lockout copy reports minutes and seconds honestly", () => {
  assert.equal(formatLockRemaining(900), "15 分钟");
  assert.equal(formatLockRemaining(840), "14 分钟");
  assert.equal(formatLockRemaining(59), "59 秒");
  assert.equal(formatLockRemaining(0), "0 秒");
});

test("Retry-After is only emitted for an active lockout", () => {
  const headers = new Map();
  const res = { set: (name, value) => headers.set(name, value) };
  assert.equal(setRetryAfter(res, 840), 840);
  assert.equal(headers.get("Retry-After"), "840");
  headers.clear();
  assert.equal(setRetryAfter(res, 0), 0);
  assert.equal(headers.has("Retry-After"), false);
});
