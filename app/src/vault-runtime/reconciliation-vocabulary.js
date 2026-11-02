// W2 (#437) — the reconciliation vocabulary (contract §1/§2.1): the four frozen trigger classes and
// the four runtime-projection states. Split out of `reconciliation.js` (line budget) so the helper
// modules can share the constants without a circular import; `reconciliation.js` re-exports them.

/** The four frozen trigger classes (contract §1). Only startup/manual are driven in W2. */
export const RECONCILIATION_TRIGGERS = Object.freeze(["startup", "manual", "watcher", "periodic"]);
export const RECONCILIATION_TRIGGER_STARTUP = "startup";
export const RECONCILIATION_TRIGGER_MANUAL = "manual";
export const RECONCILIATION_TRIGGER_WATCHER = "watcher";
export const RECONCILIATION_TRIGGER_PERIODIC = "periodic";

/** Runtime-projection states (contract §2.1). NOT persisted as an admission decision. */
export const RUNTIME_UNAVAILABLE = "unavailable";
export const RUNTIME_INITIALIZING = "initializing";
export const RUNTIME_READY = "ready";
export const RUNTIME_ERROR = "error";
