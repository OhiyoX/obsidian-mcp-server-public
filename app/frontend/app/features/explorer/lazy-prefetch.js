// Speculative hover-prefetch bookkeeping for the lazy Explorer controller
// (issue #284 contract §5 I05/I11, §6 stats). Owned by the B1 lane.
//
// Pure data plane: no fetch, no DOM, no model access — the controller stays the only
// writer of the single children cache (I01). It owns exactly two bounded sets:
//
// - the in-flight speculative owners, i.e. the concurrency budget (I05). The caller
//   drops over-budget intents; nothing is ever queued;
// - parents whose current-spec page came from a hover and was never consumed by a
//   formal intent (I11). This is a provenance marker, *not* a second children cache:
//   it holds no page, cursor, generation or item.
//
// `hold`/`release` stamp `token.slotHeld`, so a slot is given back exactly once: I08
// promotion releases it immediately and the later settle must not double-release.

// First-slice resource parameter frozen by contract §0.3, not a protocol constant.
export const PREFETCH_CONCURRENCY_LIMIT = 2;

export function createPrefetchBookkeeping({ limit = PREFETCH_CONCURRENCY_LIMIT } = {}) {
  const counters = { issued: 0, hit: 0, cancelled: 0, failed: 0, dropped: 0, promoted: 0, evicted: 0 };
  const inFlight = new Set();
  const pages = new Set();

  return {
    hasBudget: () => inFlight.size < limit,
    hold(token) {
      token.slotHeld = true;
      inFlight.add(token);
      counters.issued += 1;
    },
    release(token) {
      if (!token.slotHeld) return false;
      token.slotHeld = false;
      inFlight.delete(token);
      return true;
    },
    notePage: (parent) => pages.add(parent),
    clearPage: (parent) => pages.delete(parent),
    hasPage: (parent) => pages.has(parent),
    // A formal intent reaches a hover page: it becomes ordinary cache, counted as hit.
    consume(parent) {
      if (!pages.delete(parent)) return false;
      counters.hit += 1;
      return true;
    },
    countCancelled() {
      counters.cancelled += 1;
    },
    countFailed() {
      counters.failed += 1;
    },
    countDropped() {
      counters.dropped += 1;
    },
    countPromoted() {
      counters.promoted += 1;
    },
    countEvicted() {
      counters.evicted += 1;
    },
    clear() {
      pages.clear();
      inFlight.clear();
    },
    stats: () => ({ ...counters }),
  };
}
