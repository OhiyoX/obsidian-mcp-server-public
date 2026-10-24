// A5 store + `GIT_*` baseline → the synchronous `configProvider()` a GitRuntime takes
// (Wave B / B4, contract §15.4 / §16.3 / §38.1).
//
// Why a separate module: the inheritance matrix (persisted record wins; primary with no record
// equals the deployment's `GIT_*` baseline; a secondary with no record is default-disabled) is
// then testable without a facade, a global `VAULT`, or the process environment. This file takes
// everything by injection and reads no ambient state (it stays inside the `git-runtime/*` no-ambient
// rules asserted by `app/test/git-runtime-factory.test.js`).
//
// The durable store load is asynchronous while `configProvider()` must be synchronous. Until the
// load settles the baseline is the only answer available, and it is also the correct one: the
// no-record matrix for the primary *is* the env baseline, and a secondary is default-disabled.
// `src/git.js` calls `reloadConfig()` once the load settles so a persisted record (or a broken
// store) takes effect and the timers reconcile (§16.3).
//
// Fail-closed: once the load has settled, a store that is not `ready` raises
// `git_runtime_config_invalid` instead of silently pretending the vault has no record (§15.3,
// §38.3, SEC-MV06).

import { resolveEffectiveGitConfig } from "../git-config/schema.js";
import { GIT_RUNTIME_CODES, GitRuntimeError } from "./support.js";

export function createGitConfigProvider({ vaultId, primary, store, envDefaults }) {
  if (!store || typeof store.snapshot !== "function") {
    throw new TypeError("createGitConfigProvider requires a GitConfig store");
  }
  const state = { loaded: false };
  Promise.resolve(store.ready).then(
    () => { state.loaded = true; },
    () => { state.loaded = true; },
  );
  return function gitConfigProvider() {
    if (!state.loaded) return resolveEffectiveGitConfig({ vaultId, primary, record: null, envDefaults });
    const snapshot = store.snapshot();
    if (snapshot.status !== "ready") {
      throw new GitRuntimeError(GIT_RUNTIME_CODES.CONFIG_INVALID, "git config store is not readable");
    }
    return resolveEffectiveGitConfig({ vaultId, primary, record: snapshot.vaults[vaultId] ?? null, envDefaults });
  };
}
