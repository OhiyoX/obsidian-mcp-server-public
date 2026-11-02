// Each runtime map owns one closure. Public tokens/facts never expose membership or lease entries.
export function createRuntimePlans() {
  const states = new WeakMap();
  const facts = entry => ({ descriptor: entry.descriptor, id: entry.runtime.id });
  return Object.freeze({
    stage({ next, previous: current, released, createdIds, reusedIds, failed }) {
      const previous = Object.freeze({});
      states.set(previous, { next, previous: current, released, createdIds, reusedIds, failed, committed: null, discarded: false });
      return Object.freeze({ previous,
        next: new Map([...next].map(([id, entry]) => [id, facts(entry)])),
        createdIds: Object.freeze(createdIds), reusedIds: Object.freeze(reusedIds),
        released: Object.freeze(released.map(entry => Object.freeze(facts(entry)))),
        failed: Object.freeze(failed), presentIds: Object.freeze([...next.keys()]),
      });
    },
    get: plan => plan?.previous && states.get(plan.previous),
  });
}
