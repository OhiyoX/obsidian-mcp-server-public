/**
 * Cohesive live-event teardown controller. Keeps the SSE module within the
 * architecture line budget while making shutdown cleanup idempotent and truthful:
 * admission is fenced synchronously, active streams end, and watcher close
 * failures are collected and rethrown instead of being swallowed.
 */
export function createLiveEventTeardown({ pending, subscribers, watchers, watcherRefs, broker, closeWatcher }) {
  let shuttingDown = false;
  let teardownPromise = null;

  function teardown() {
    if (teardownPromise) return teardownPromise;
    shuttingDown = true;
    teardownPromise = (async () => {
      const failures = [];
      for (const record of pending.values()) clearTimeout(record.timer);
      pending.clear();
      for (const subscriber of [...subscribers]) {
        try { broker.close(subscriber, { end: true }); } catch (error) { failures.push(error); }
      }
      for (const id of [...watchers.keys()]) {
        try { await closeWatcher(id, { rethrow: true }); } catch (error) { failures.push(error); }
      }
      watcherRefs.clear();
      if (failures.length) {
        const error = new Error(`Live event teardown failed (${failures.length} cleanup failure(s))`);
        error.failures = failures;
        throw error;
      }
    })();
    return teardownPromise;
  }

  return {
    teardown,
    isShuttingDown: () => shuttingDown,
    reset() {
      shuttingDown = false;
      teardownPromise = null;
    },
  };
}
