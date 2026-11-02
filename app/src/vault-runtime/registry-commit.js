// W2FIX3 (#437 RETURN 2, item 3) — the PURE staging half of the registry's publish.
//
// Split out of `registry.js` (line budget) as one cohesive unit: "validate a prepared candidate into
// a frozen staged record WITHOUT swapping anything". `registry.js` keeps the single synchronous
// assignment (`applyStaged`); the composed commit in the reconciliation service binds this record, the
// runtime plan and the explicit allow-set to ONE authoritative revision.
//
// Every failable check (round deadline, revision override shape, monotonic revision) lives here, so
// nothing can fail at the commit point itself.

/**
 * `buildStagedCommit({ candidate, options, current, codes, describeValue, fail })`
 * Returns `{ snapshot, previous, serving, deferServing }` (frozen) or throws a structured error.
 */
export function buildStagedCommit({ candidate, options = {}, current, codes, describeValue, fail }) {
  if (candidate === null || typeof candidate !== "object" || candidate.snapshot === undefined || candidate.snapshot === null) {
    fail(codes.config, "commit expects a candidate returned by prepare()");
  }
  const now = typeof candidate.now === "function" ? candidate.now : Date.now;
  if (candidate.deadlineAt !== null && candidate.deadlineAt !== undefined && now() > candidate.deadlineAt) {
    fail(codes.timeout, `refusing to publish a discovery round that finished after its logical deadline (${candidate.deadlineAt}): a late result must never enter the visible set (contract §4.1)`);
  }
  if (options.revision !== undefined && (!Number.isInteger(options.revision) || options.revision < 0)) {
    fail(codes.config, `commit revision override must be a non-negative integer, got ${describeValue(options.revision)}`);
  }
  if (options.serving !== undefined && options.serving !== null && !Array.isArray(options.serving.allowed)) {
    fail(codes.config, "commit serving override must expose an `allowed` array (the explicit, committed allow-set)");
  }
  const snapshot = Object.freeze({ ...candidate.snapshot, revision: options.revision === undefined ? candidate.snapshot.revision : options.revision });
  if (snapshot.revision < current.revision) {
    fail(codes.config, `refusing to publish revision ${snapshot.revision}: it is BEHIND the committed revision ${current.revision} (an inventory snapshot never moves backwards)`);
  }
  return Object.freeze({ snapshot, previous: current, serving: options.serving ?? null, deferServing: options.deferServing === true });
}
