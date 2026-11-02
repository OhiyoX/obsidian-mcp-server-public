// W2FIX3 (#437 RETURN 2, item 5) — the composition-root DRAIN seam of the D0 runtime map.
//
// The map retires a displaced/revoked Vault by draining it, but it must not import the Git/search
// subsystems itself (it stays a pure, parameterized map). `server.js` therefore injects this ONE
// `drainFor` hook; keeping it in its own module is what lets `server.js` stay at its frozen size
// while still closing the background window (Git sweep / retrieval timers) BEFORE a revoke returns.
//
// Both releases are keyed by the consumer HANDLE (the leased facade the map hands out), which is
// exactly the key `gitRuntimeFor` / `searchRuntimeFor` cache on, so a captured pre-revoke handle's
// cached runtime is the one stopped here.

import { releaseGitRuntime } from "../git-runtimes.js";
import { releaseSearchRuntime } from "../search-runtimes.js";

/** Stop the cached Git runtime and search runtime (timers/queues) of one retired Vault handle. */
export function releaseVaultRuntimeCaches(handle) {
  releaseGitRuntime(handle);
  releaseSearchRuntime(handle);
}
