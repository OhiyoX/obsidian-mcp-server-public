// The process-wide prompt registry, set once by the composition root.
//
// Tool modules must see the live revision, so they read it from here instead of
// importing a per-call instance. Until `server.js` sets one (unit tests, tools run
// standalone), the bundled pack answers, which is exactly the pre-registry text.

import { bundledPromptRegistry } from "./bundled.js";
import { currentPromptSnapshot } from "./request-snapshot.js";

let active = null;

export function setLivePromptRegistry(registry) {
  if (registry !== null && typeof registry?.snapshot !== "function") throw new TypeError("a registry needs snapshot()");
  active = registry;
}

/** The snapshot every call must use; one call, one snapshot. */
export function livePromptSnapshot() {
  // A request that already pinned a revision keeps it; a publish mid-request cannot
  // make one call quote two versions.
  return currentPromptSnapshot() ?? (active ?? bundledPromptRegistry()).snapshot();
}

/** Read-only health view: counts and digests, never the prompt text. */
export function livePromptStatus() {
  if (active === null) {
    const bundled = bundledPromptRegistry().snapshot();
    return Object.freeze({
      status: "bundled",
      revision: 0,
      baseDigest: bundled.baseDigest,
      bundledBaseDigest: bundled.baseDigest,
      effectiveDigest: bundled.effectiveDigest,
      overrideCount: 0,
      drift: false,
    });
  }
  return active.status();
}

/** Test hook: drop the live registry so a suite does not leak into the next one. */
export function resetLivePromptRegistry() {
  active = null;
}
