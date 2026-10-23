// Deterministic timers for the Web feedback tests.
//
// Extracted verbatim from `web-toast-live-region.test.js` (#411) so the #422
// double-announcement file can use the same recorder: the auto-remove windows are
// asserted as numbers and fired by hand, so no test leaves a real timer behind.
export function installTimerRecorder() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let sequence = 0;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay, ...args) => {
    sequence += 1;
    timers.set(sequence, { callback: () => callback(...args), delay: Number(delay) || 0 });
    return sequence;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  return {
    delays: () => [...timers.values()].map((entry) => entry.delay),
    pending: () => timers.size,
    // Fire every pending timer, oldest first, ignoring anything re-armed meanwhile.
    runAll() {
      for (const [id, entry] of [...timers]) {
        timers.delete(id);
        entry.callback();
      }
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}
