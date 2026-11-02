// W2FIX2 (#437 RETURN items 3/5) — the composed-commit helpers of the reconciliation service.
//
// Split out of `reconciliation.js` (line budget) as one cohesive unit: "turn a prepared candidate +
// a prepared runtime plan into the ONE committed servable set". Pure functions: no I/O, no state.

import { toServingRefusal } from "./serving-gate.js";

/**
 * Overlay per-Vault runtime-prepare failures on a prepared candidate (item 5): the failing Vault
 * becomes a NON-admitted `error` decision (its identity binding and descriptor stay, so it is still
 * described and its error is projected), and every healthy Vault stays admitted. The round then
 * persists/commits the healthy set instead of being aborted by one broken constructor.
 */
export function isolatePrepareFailures(prepared, failures) {
  if (!Array.isArray(failures) || failures.length === 0) return prepared;
  const admissions = { ...prepared.snapshot.admissions };
  for (const failure of failures) {
    const previous = admissions[failure.id] ?? {};
    admissions[failure.id] = Object.freeze({
      admitted: false,
      admission: previous.admission ?? null,
      status: "error",
      reason: "runtime-prepare-failed",
      code: failure.error?.code ?? null,
      identityVersion: previous.identityVersion ?? null,
      identityDigest: previous.identityDigest ?? null,
    });
  }
  return Object.freeze({ ...prepared, snapshot: Object.freeze({ ...prepared.snapshot, admissions: Object.freeze(admissions) }) });
}

/**
 * W2FIX5 (#437 W2FIX4 item A / R1) — the ONE composed publish, expressed as a SINGLE pointer switch.
 *
 * The ruling's counterexample read the registry, the runtime map and the serving gate at the injectable
 * synchronous `runtimeMap.commit` seam and could pair a NEW descriptor with an OLD runtime: the three
 * faces were three independent pointers, so no assignment ORDER could be safe. Since W2FIX5 they are
 * one value — the composed commit record — and this function performs exactly ONE switch:
 *
 *   ① validate everything first: `stageCommit` has already refused every failable shape, and
 *      `runtimeMap.commit(plan)` validates the plan generation BEFORE it switches (a throw there leaves
 *      all three faces on the previous commit — there is nothing to undo any more);
 *   ② the bound plan carries the staged snapshot, the explicit allow-set and the commit ordinal, so the
 *      map's single record assignment publishes registry + runtimes + serving together;
 *   ③ the observer's `after` seam and the serving re-baseline run AFTER the switch. A fault there can
 *      only report a degraded commit: one face is never rolled back, because that would be the very
 *      mixed fact this repair removes.
 *
 * Returns `{ published, applied }`, where `published` is the committed registry snapshot.
 */
export function publishComposed({ registry, runtimeMap, plan, staged, composed, commitObserver }) {
  let applied = null;
  let adopted = false;
  try {
    commitObserver?.(composed, "before");
    if (runtimeMap !== null && plan !== null) {
      applied = runtimeMap.commit(bindComposedPlan(plan, staged, composed, registry));
    } else {
      registry.applyStaged(staged);
    }
    adopted = true;
    if (typeof registry.setServedIds === "function") registry.setServedIds(composed.serving.allowed, composed.serving.refusals);
    commitObserver?.(composed, "after");
  } catch (error) {
    // A throw BEFORE the switch published nothing (all three faces are still on the previous commit,
    // so there is nothing to undo); the unadopted candidates are reclaimed. A throw AFTER it must NOT
    // reclaim or roll back anything — the record is already committed and the caller reports a
    // degraded commit.
    if (!adopted && runtimeMap !== null && plan !== null && typeof runtimeMap.discard === "function") runtimeMap.discard(plan);
    throw error;
  }
  return { published: registry.snapshot(), applied };
}

/**
 * Bind the pre-validated composed payload to the plan: the runtime map's `commit(plan)` is the ONE
 * switch, so the payload travels ON the plan (the injectable seam always receives the plan object).
 */
function bindComposedPlan(plan, staged, composed, registry) {
  const commits = (typeof registry.commits === "function" ? registry.commits() : 0) + 1;
  return Object.freeze({
    ...plan,
    composed: Object.freeze({
      snapshot: staged.snapshot,
      revision: staged.snapshot.revision,
      serving: Object.freeze({ allowed: composed.serving.allowed, refusals: composed.serving.refusals }),
      commits,
    }),
  });
}

/**
 * The explicit committed allow-set + refusal map for @step ④ (item 3):
 *
 *   allowed  = admitted Vaults of the committed snapshot ∩ the runtime ids the committed map holds.
 *   refusals = the committed non-admitted decisions, plus `runtime-not-prepared` for an admitted
 *              Vault whose runtime the committed map does not hold.
 *
 * `presentIds` is the runtime map's id list AFTER the swap (`plan.presentIds`), or `null` when this
 * process runs without a runtime map. An id that is not in `allowed` is refused by default, so a
 * deleted/unknown/not-prepared Vault can never be served by clearing the previous decisions.
 */
export function composedServingSets(snapshot, presentIds = null) {
  const allowed = [];
  const refusals = new Map();
  for (const [id, decision] of Object.entries(snapshot.admissions ?? {})) {
    if (decision?.admitted === true) allowed.push(id);
    else {
      refusals.set(id, toServingRefusal({
        admitted: false,
        admission: decision?.admission ?? null,
        status: decision?.status ?? "unavailable",
        reason: decision?.reason ?? "not-admitted",
        code: decision?.code ?? null,
      }));
    }
  }
  if (presentIds === null) return { allowed, refusals };
  const present = new Set(presentIds);
  for (const id of allowed) {
    if (!present.has(id)) refusals.set(id, toServingRefusal({ admitted: false, status: "error", reason: "runtime-not-prepared", code: null }));
  }
  return { allowed: allowed.filter((id) => present.has(id)), refusals };
}
