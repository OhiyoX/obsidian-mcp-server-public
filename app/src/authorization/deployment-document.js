// Task 1 — the deployment's durable document with derived subjects.
//
// Contract: design §6.8 and §7 step 1. `store.js` owns the file, the CAS and the durable
// write; this module adds the one composition the runtime reads. The file owns
// `constraints` and `timeConstraintsEnabled`. `subjects` are derived from live credential
// state on every read and never written back, so a credential created after the cutover
// works at once and no credential route has to write this file.
//
// A missing or broken file is seeded once, through `repair`, which saves the broken
// original bytes first. A seed that throws — or one the schema refuses — rejects `ready`
// instead of publishing a partial document (design §11 C5). Without a seed the store stays
// broken, and the runtime then denies with `authorization_state_unavailable`.
//
// A derivation that throws is a broken state, never a throw out of `snapshot()`: a caller
// such as `runtime.snapshot()` has no decision to fail closed on. The failure is cached
// against the committed document, so a legacy import that holds does not re-run on every
// request; a new committed document (an Admin write) retries it.
//
// The write path is guarded here, not in every writer: `snapshot()` composes the derived
// half, so a candidate built from it would persist rows this file does not own. `replace`
// strips every candidate back to the committed rows, so an ordinary writer — a constraint
// admin — cannot write a derived subject back (design §6.8). Two paths go around it on
// purpose: the seed writes its own imported rows, and `repair` runs only on a store that is
// not ready, where there are no committed rows to strip back to.

import { AUTHORIZATION_CODES } from "./schema.js";
import { createAuthorizationStore } from "./store.js";

const { STATE_UNAVAILABLE } = AUTHORIZATION_CODES;

/**
 * `createDeploymentDocument({file, io, seed, deriveSubjects, sourceRevision}) -> {ready, store}`
 *
 * `store` is the shape `createAuthorizationRuntime` accepts: `ready`, `snapshot()`,
 * `replace()`, `repair()`, `drain()`, plus `sourceRevision()` for the provenance a shadow
 * row records. Its `snapshot()` answers a loading or broken store unchanged and otherwise
 * composes `{...stored, subjects: deriveSubjects(stored.subjects)}` on every call. Its
 * `replace()` accepts a candidate built from either snapshot and writes the committed
 * `subjects`, never a derived one.
 */
export function createDeploymentDocument({ file, io, seed = null, deriveSubjects, sourceRevision = null } = {}) {
  if (seed !== null && typeof seed !== "function") throw new TypeError("the deployment document seed must be a function or null");
  if (typeof deriveSubjects !== "function") throw new TypeError("the deployment document needs a subject derivation");
  if (sourceRevision !== null && typeof sourceRevision !== "function") throw new TypeError("the source revision must be a function or null");
  const store = createAuthorizationStore({ file, io });
  // The committed document whose derivation failed. Object identity is the cache key: the
  // store freezes a new document on every commit, and keeps the same one otherwise.
  let failedFor = null;

  const ready = Promise.resolve(store.ready).then(async () => {
    if (seed === null || store.snapshot().status === "ready") return;
    const repaired = await store.repair(await seed());
    if (!repaired.ok) {
      throw Object.assign(new Error(`the authorization seed was refused: ${repaired.code}`), { code: repaired.code });
    }
  });

  function snapshot() {
    const stored = store.snapshot();
    if (stored.status !== "ready") return stored;
    if (stored.document === failedFor) return Object.freeze({ status: "broken", code: STATE_UNAVAILABLE });
    let subjects;
    try {
      subjects = Object.freeze(deriveSubjects(stored.document.subjects));
    } catch {
      failedFor = stored.document;
      return Object.freeze({ status: "broken", code: STATE_UNAVAILABLE });
    }
    failedFor = null;
    return Object.freeze({
      status: "ready",
      revision: stored.revision,
      document: Object.freeze({ ...stored.document, subjects }),
    });
  }

  // §6.8: the file owns `subjects` as they were committed; the derivation owns what a
  // reader sees. A candidate that carries the composed half is written with the committed
  // rows instead, and no writer can change them, so a derivation that answers `{}` cannot
  // erase a ceiling and a merge-shaped derivation cannot widen one.
  function replace(expectedRevision, candidate) {
    const stored = store.snapshot();
    const isDocument = Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate);
    if (stored.status !== "ready" || !isDocument) return store.replace(expectedRevision, candidate);
    return store.replace(expectedRevision, { ...candidate, subjects: stored.document.subjects });
  }

  return Object.freeze({
    ready,
    store: Object.freeze({
      ready,
      snapshot,
      replace,
      repair: store.repair,
      drain: store.drain,
      sourceRevision: () => (sourceRevision === null ? null : sourceRevision()),
    }),
  });
}
