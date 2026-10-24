// W2FIX3 (#437 RETURN 2, item 6) — the bounded self-retry scheduler of the reconciliation service.
//
// The seat measured 19 rounds / 250 ms at the previous default (`retryDelayMs = 0` + a pending-rerun
// flag): a persistent construction/activation failure re-scanned and re-wrote the authoritative record
// in a hot loop with no watcher and no periodic trigger. This module owns exactly the rate limit:
//
//   * at most ONE scheduled retry exists; a new trigger while it is pending does not stack;
//   * consecutive degradations back off geometrically from the configured base up to a cap;
//   * a clean round resets the backoff to the base;
//   * `stop()` cancels the pending retry (shutdown / tests).
//
// It performs no I/O and holds no ambient state; timing comes from the injected scheduler.

/** Extract the timer seam from an optional injected scheduler. */
export function resolveRetryTimers(scheduler) {
  if (scheduler === null || scheduler === undefined) {
    return { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle), unref: (handle) => handle?.unref?.() };
  }
  if (typeof scheduler.setTimeout !== "function" || typeof scheduler.clearTimeout !== "function") {
    throw Object.assign(new Error("[VAULT_RECONCILIATION_CONFIG_INVALID] scheduler must expose setTimeout/clearTimeout when provided"), {
      code: "VAULT_RECONCILIATION_CONFIG_INVALID",
    });
  }
  return scheduler;
}

export function createRetryScheduler({ baseDelayMs, minDelayMs, maxDelayMs, timers, onFire }) {
  let timer = null;
  let delay = baseDelayMs;
  let stopped = false;

  return Object.freeze({
    /** Schedule the single pending retry. Returns false when one is already scheduled or stopped. */
    schedule() {
      if (stopped || timer !== null) return false;
      const wait = delay;
      delay = Math.min(maxDelayMs, Math.max(minDelayMs, delay * 2));
      timer = timers.setTimeout(() => {
        timer = null;
        if (stopped) return undefined;
        return onFire();
      }, wait);
      timers.unref?.(timer);
      return true;
    },
    /** A clean round resets the backoff so the next degradation starts from the configured base. */
    reset() {
      delay = baseDelayMs;
    },
    /**
     * Drop a stale pending retry WITHOUT stopping the scheduler: a clean round that was triggered
     * explicitly supersedes the retry a previous degraded round armed.
     */
    cancel() {
      delay = baseDelayMs;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
    },
    pending: () => timer !== null,
  });
}
