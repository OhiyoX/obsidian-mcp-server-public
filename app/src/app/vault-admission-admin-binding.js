// Public process seams over the existing controller, extracted for the registry line budget.
// This object owns no state, inventory or authorization decision.
export function createVaultAdmissionAdminBinding(controller) {
  // `initialize` is the operation that turns enforcement ON, so requiring `enforced()` for it made the
  // documented enable path unreachable on a fresh deployment (no record, discovery off ⇒ not enforced
  // yet). Bootstrap is scoped to `initialize` while the store is un-initialised; approve/revoke keep
  // requiring an enforced controller.
  const bootstrapping = (method) => method === "initialize" && controller !== null && controller.status?.().initialized !== true;
  const decide = (method, ...args) => controller === null || (!controller.enforced() && !bootstrapping(method))
    ? Promise.reject(new Error("Vault admission is not enabled")) : controller[method](...args);
  return Object.freeze({
    status: () => controller === null
      ? Object.freeze({ enabled: false, initialized: false, revision: null, inFlight: false, vaults: Object.freeze({}) })
      : controller.status(),
    reconcile: (trigger = "manual", options = {}) => controller === null
      ? Promise.resolve(null) : controller.reconcile(trigger, options),
    initialize: (options = {}) => decide("initialize", options),
    approve: (id, options = {}) => decide("approve", id, options),
    revoke: (id, options = {}) => decide("revoke", id, options),
    entries: () => controller?.store.entries() ?? {},
  });
}
