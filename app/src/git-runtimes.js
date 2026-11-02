// Wave D / D-git — process wiring + per-Vault cache for the per-Vault GitRuntime.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §29  Wave D git lane — one *real* per-Vault GitRuntime before the git toolset can be called
//        per-Vault; no lane may invent a second Vault selector;
//   §15.4 inheritance (a primary with no record equals the deployment baseline, a secondary with no
//        record is default-disabled), §16.1 command root, §16.2 repo-presence state machine,
//        §16.3 config reload / timer reconcile, §16.4 `trackGitMutation` goes to the *current*
//        VaultRuntime's Git;
//   §3.4  capabilities are runtime facts (fail closed, never guessed);
//   §21  MV-I02 cross-Vault independence · MV-I04 timers capture the runtime · MV-I07 primary
//        compatibility · §43-5 facade allowlist · §43-6 no Git state in a module global;
//   §42  SEC-MV06 no fallback on a broken secondary · SEC-MV07 no global state bleed;
//   §47  RETURN list — a selected Vault is never served by the primary Vault.
//
// Position in the chain:
//
//   vault-scope registrar -> request context { vaultId, vaultRuntime } -> this resolver -> GitRuntime
//
// This module owns exactly three things, and nothing else:
//
//   1. `gitRuntimeFor(vaultRuntime)` — the per-Vault cache. The **primary** B1 VaultRuntime
//      (`primary === true`, id equal to the facade's primary GitRuntime) always answers with the one
//      instance `src/git.js` built at import: its pending batches, serialized operation queue,
//      `lastSweep` and push history are bound to it (§16, §44 item 8), so a second primary would
//      split #255/#265 observability. A **secondary** gets its own instance through the factory the
//      facade injected (`-C <that Vault's own root>`, §16.1) reading its own A5 record through the
//      *shared* store (§15.4). The cache is a WeakMap keyed by the B1 runtime *instance*, so a
//      runtime released by D0's map can never be served again and no id-keyed inventory is kept
//      (§43-7; the same shape `src/search-runtimes.js` records for the search lane).
//   2. `resolveGitRuntime()` — the handler-side resolver. It reads the *selected* Vault from the
//      request context and never guesses: a selection with no materialized runtime is refused
//      structurally (`vault_git_unavailable`), never served by the primary repository (SEC-MV06 /
//      §47). A call with **no** Vault selection at all — direct in-process registration such as
//      `registerGitTools(server)`, the batch-journal recovery path, or a Web/Admin caller — keeps
//      the legacy primary semantics of §21 MV-I07.
//   3. `refusalForError()` / `releaseGitRuntime()` — the MCP-shaped structured refusal for this
//      module's own codes and for every `git_runtime_*` code the A6 runtime raises (a disabled,
//      config-invalid or repository-missing Vault answers with a machine-readable code instead of
//      prose, §16.2), plus the explicit release used by ops and tests.
//
// No GitRuntime *state* lives here (§43-6): pending batches, the debounce/max-delay/sweep timers,
// the queue, `lastSweep` and the push history all belong to the instances. The two module-level
// bindings — the wiring `src/git.js` injects once (its factory plus the A5 store it already owns)
// and the WeakMap — hold references only, the same shape the W0-A inventory records for
// `src/search-runtimes.js`.

import path from "node:path";
import { requestContext } from "./request-context.js";
import { isHandleCurrent, leaseOfHandle } from "./vault-runtime/runtime-lease.js";

/** A Vault was selected but this process has no GitRuntime for it (never the primary one). */
export const GIT_RUNTIME_REFUSED = "vault_git_unavailable";
/** The resolver received a malformed VaultRuntime; refuse instead of guessing a repository. */
export const GIT_RUNTIME_INVALID = "vault_git_runtime_invalid";
/** `src/git.js` has not injected the process wiring yet (composition error; fail closed). */
export const GIT_RUNTIME_UNCONFIGURED = "vault_git_runtime_unconfigured";

const SECONDARY_GIT_RUNTIMES = new WeakMap();
// W2FIX5 R3: the raw instance behind a per-generation primary facade, for the composition-root drain.
const GIT_FACADE_TARGET = Symbol("gitFacadeTarget");
// Operations that start Git work or arm timers; observability/lifecycle reads pass through ungated.
const GATED_GIT_METHODS = new Set(["start", "reloadConfig", "trackMutation", "flushNow", "sweepNow", "manualCommit", "manualPull", "manualPush", "runGit", "normalizePath", "assertRepository", "probe"]);
let wiring = null;

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

/** Structured refusal carrying the Vault the caller itself asked for (never inventory facts). */
function refuse(vaultId, detail) {
  throw Object.assign(new Error(`[${GIT_RUNTIME_REFUSED}] ${detail}`), { code: GIT_RUNTIME_REFUSED, vaultId });
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return `${typeof value} ${String(value)}`;
}

/**
 * One-shot process wiring, called by the §43-5 facade (`src/git.js`) at import: the facade is the
 * only module allowed to read the global Vault root and the `GIT_*` baseline, and it already owns
 * the one A5 store every Git reader must share (§15.3/§16.3, E's Admin writes that same store).
 *
 *   primaryGitRuntime()            — the process's one primary GitRuntime instance
 *   createSecondaryRuntime({vaultId, root}) — builds a *secondary* instance (its own root, its own
 *                                    record, `primary:false`); the returned instance is validated
 *                                    before it is published
 *   onStoreReady()                 — optional; resolves when the durable A5 load has settled, so a
 *                                    runtime materialized earlier reconciles its persisted record
 *   logger                         — optional `{error}` sink for background start/reconcile failures
 */
export function configureGitRuntimes(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail(GIT_RUNTIME_INVALID, `configureGitRuntimes expects an options object, got ${describe(input)}`);
  }
  const { primaryGitRuntime, createSecondaryRuntime, onStoreReady, logger } = input;
  if (typeof primaryGitRuntime !== "function") {
    fail(GIT_RUNTIME_INVALID, `configureGitRuntimes requires primaryGitRuntime(), got ${describe(primaryGitRuntime)}`);
  }
  if (typeof createSecondaryRuntime !== "function") {
    fail(GIT_RUNTIME_INVALID, `configureGitRuntimes requires createSecondaryRuntime(), got ${describe(createSecondaryRuntime)}`);
  }
  if (onStoreReady !== undefined && onStoreReady !== null && typeof onStoreReady !== "function") {
    fail(GIT_RUNTIME_INVALID, `onStoreReady must be a function when provided, got ${describe(onStoreReady)}`);
  }
  wiring = Object.freeze({
    primaryGitRuntime,
    createSecondaryRuntime,
    onStoreReady: onStoreReady ?? null,
    logger: logger ?? null,
  });
  return wiring;
}

function requireWiring() {
  if (wiring === null) {
    fail(GIT_RUNTIME_UNCONFIGURED, "src/git.js must call configureGitRuntimes() before any per-Vault Git resolution");
  }
  return wiring;
}

/**
 * W2FIX5 (#437 W2FIX4 item B / R3) — a fixed-generation consuming FACADE over the process-shared
 * primary GitRuntime. `createLeasedRuntime` cannot be reused here because `GitRuntime` is a class: its
 * operations live on the prototype, not in own enumerable properties. Every gated operation re-checks
 * the lease of the handle this facade was minted for, so a captured pre-revoke facade can never
 * inherit a later re-approval. Observability (`status`/`state`/`config`/`pushHistory`) stays readable
 * so a caller can still describe a revoked runtime.
 */
function leasedGitFacade(target, isCurrent) {
  const assertCurrent = () => {
    if (isCurrent() === true) return;
    const error = new Error(
      `[${GIT_RUNTIME_REFUSED}] the primary Git runtime handle for ${JSON.stringify(target.vaultId)} is no longer current; re-resolve the Vault (contract §5)`,
    );
    error.name = "GitRuntimeError";
    error.code = "git_runtime_lease_revoked";
    error.status = 503;
    error.httpStatus = 503;
    error.vaultId = target.vaultId;
    throw error;
  };
  const facade = {};
  const seen = new Set();
  for (let proto = target; proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor" || seen.has(key)) continue;
      seen.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (descriptor === undefined) continue;
      if (typeof descriptor.value === "function") {
        const method = descriptor.value;
        facade[key] = GATED_GIT_METHODS.has(key)
          ? function leasedGitCall(...args) {
              assertCurrent();
              return method.apply(target, args);
            }
          : function passthroughGitCall(...args) { return method.apply(target, args); };
      } else if (typeof descriptor.get === "function") {
        Object.defineProperty(facade, key, { get: () => descriptor.get.call(target), enumerable: true, configurable: true });
      }
    }
  }
  Object.defineProperty(facade, GIT_FACADE_TARGET, { value: target, enumerable: false });
  return Object.freeze(facade);
}

/**
 * The GitRuntime that owns one materialized B1 VaultRuntime. The primary instance is returned by
 * identity; any other Vault gets (at most) one lazily built instance, cached by runtime identity so
 * a runtime released by D0's map cannot be served again. The secondary is *validated* against the
 * requested id/root before publication (SEC-MV06: never substitute another Vault's repository).
 */
export function gitRuntimeFor(vaultRuntime) {
  const { primaryGitRuntime, createSecondaryRuntime, onStoreReady, logger } = requireWiring();
  if (vaultRuntime === null || typeof vaultRuntime !== "object" || Array.isArray(vaultRuntime)) {
    fail(GIT_RUNTIME_INVALID, `gitRuntimeFor expects a materialized VaultRuntime, got ${describe(vaultRuntime)}`);
  }
  const primary = primaryGitRuntime();
  const { id, root } = vaultRuntime;
  if (vaultRuntime.primary === true && id === primary.vaultId) {
    // W2FIX4 item B / W2FIX5 R3+R4: a LEASED primary handle binds the process-shared runtime to that
    // handle's lease and receives a fixed-generation FACADE. The binding is IDEMPOTENT for the same
    // lease — the same guard function is kept, so the timers' token does not change and a live sweep
    // interval is not falsely invalidated (R4) — and only a real generation change rebinds it (R3).
    // A RAW B1 runtime (legacy in-process callers/tests) keeps the legacy semantics: no guard, no
    // facade, and the process instance is never forgotten.
    const lease = leaseOfHandle(vaultRuntime);
    if (lease !== null) {
      if (primary.boundLease !== lease) {
        primary.boundLease = lease;
        primary.leaseGuard = () => isHandleCurrent(vaultRuntime);
      }
      if (primary.started !== true) void primary.start().catch(() => {});
      let facade = SECONDARY_GIT_RUNTIMES.get(vaultRuntime);
      if (facade === undefined) {
        facade = leasedGitFacade(primary, () => isHandleCurrent(vaultRuntime));
        SECONDARY_GIT_RUNTIMES.set(vaultRuntime, facade);
      }
      return facade;
    }
    return primary;
  }
  if (typeof id !== "string" || id === "") {
    fail(GIT_RUNTIME_INVALID, `a VaultRuntime must carry a non-empty id, got ${describe(id)}`);
  }
  if (typeof root !== "string" || root === "" || !path.isAbsolute(root)) {
    fail(GIT_RUNTIME_INVALID, `${describe(id)} must carry an absolute root, got ${describe(root)}`);
  }
  if (vaultRuntime.primary === true) {
    fail(GIT_RUNTIME_INVALID, `Vault ${describe(id)} claims primacy but is not the process's primary Vault; refusing instead of serving it with the primary repository (§47)`);
  }

  const cached = SECONDARY_GIT_RUNTIMES.get(vaultRuntime);
  if (cached !== undefined) return cached;

  const runtime = createSecondaryRuntime({ vaultId: id, root, guard: () => isHandleCurrent(vaultRuntime) });
  if (runtime === null || typeof runtime !== "object" || runtime.vaultId !== id || runtime.root !== root || runtime.primary === true) {
    fail(
      GIT_RUNTIME_INVALID,
      `the GitRuntime built for secondary ${describe(id)} must be its own non-primary instance rooted at ${describe(root)} ` +
        `(got vaultId=${describe(runtime?.vaultId)}, root=${describe(runtime?.root)}, primary=${describe(runtime?.primary)}); ` +
        "never substitute the primary repository (SEC-MV06)",
    );
  }
  SECONDARY_GIT_RUNTIMES.set(vaultRuntime, runtime);

  // §16.3: the instance is live from materialization on. `start()` arms exactly the timers its
  // effective config allows (at most one sweep interval) and probes repository presence; the A5
  // load is asynchronous, so a runtime built before it settled reconciles once the store is ready.
  const report = (prefix) => (error) => {
    try {
      logger?.error?.(`${prefix}: ${error?.message ?? error}`);
    } catch {
      /* logging is best effort and never gates the runtime */
    }
  };
  runtime.start().catch(report(`[vault-git] Git runtime start failed for ${id}`));
  if (typeof onStoreReady === "function") {
    Promise.resolve()
      .then(() => onStoreReady())
      .then(() => runtime.reloadConfig())
      .catch(report(`[vault-git] Git config reconcile failed for ${id}`));
  }
  return runtime;
}

/**
 * The GitRuntime selected by the ambient request context (§6).
 *
 *   * no context at all      -> the primary GitRuntime (no Vault was selected; legacy semantics);
 *   * a selected VaultRuntime -> that Vault's GitRuntime, materialized on first use;
 *   * a selected vaultId with no runtime -> a structured refusal; a secondary selection is *never*
 *                              served by the primary repository (SEC-MV06 / §47).
 */
export function resolveGitRuntime() {
  const { primaryGitRuntime } = requireWiring();
  const context = requestContext();
  if (context === undefined || context === null) return primaryGitRuntime();
  const { vaultRuntime, vaultId } = context;
  if (vaultRuntime !== undefined && vaultRuntime !== null) return gitRuntimeFor(vaultRuntime);
  const primary = primaryGitRuntime();
  if (vaultId === undefined || vaultId === null || vaultId === primary.vaultId) return primary;
  refuse(
    vaultId,
    `Vault ${describe(vaultId)} was selected but no Git runtime is materialized for it; Git reads and writes never fall back to another Vault's repository (SEC-MV06)`,
  );
}

/**
 * MCP-shaped structured refusal for this module's codes and for every `git_runtime_*` code the A6
 * runtime raises, or `null` for any other error so a tool handler can write
 * `return refusalForError(error, vaultId) ?? err(error)`.
 *
 * `vaultId` is the caller's own selection (never inventory facts, SEC-MV03) and is only used when
 * the error itself does not carry one.
 */
export function refusalForError(error, vaultId) {
  const code = typeof error?.code === "string" ? error.code : null;
  if (code === null) return null;
  const own = code === GIT_RUNTIME_REFUSED || code === GIT_RUNTIME_INVALID || code === GIT_RUNTIME_UNCONFIGURED;
  const runtimeCode = code.startsWith("git_runtime_") || code.startsWith("git_config_");
  if (!own && !runtimeCode) return null;
  const payload = { code };
  const selected = typeof error.vaultId === "string" ? error.vaultId : typeof vaultId === "string" ? vaultId : null;
  if (selected !== null) payload.vaultId = selected;
  // A resolver refusal answers with its code only (the registrar's deny payload shape); a runtime
  // failure keeps the message the pre-migration tool surface already returned verbatim.
  if (runtimeCode && typeof error.message === "string" && error.message !== "") payload.message = error.message;
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { ...payload },
    isError: true,
  };
}

/**
 * Release one cached instance (ops/tests): clear its timers, then forget it. The PRIMARY runtime is
 * cached under its consumer handle too (W2FIX4 item B), so a durable revoke stops the process-shared
 * primary's background sweep exactly like a secondary's; resolving it again with a CURRENT handle
 * re-binds the guard and resumes it.
 *
 * A LEASED primary handle that was never cached (never called gitRuntimeFor) is still released: the
 * lease proves it's a managed handle from the map, not a raw test/process runtime. A raw primary
 * B1 VaultRuntime (no lease, never from the map) returns false: the primary instance belongs to the
 * process, never released through this registry (contract §16.1/§43-6).
 */
export function releaseGitRuntime(vaultRuntime) {
  const runtime = SECONDARY_GIT_RUNTIMES.get(vaultRuntime);
  if (runtime !== undefined) {
    SECONDARY_GIT_RUNTIMES.delete(vaultRuntime);
    // A primary facade must be stopped through its RAW instance (the facade's own lease is now revoked).
    const target = runtime[GIT_FACADE_TARGET] ?? runtime;
    target.stop();
    return true;
  }
  // If this is a LEASED primary handle (from the map) that was never cached, stop the primary runtime.
  // A raw primary runtime (no lease) returns false because it belongs to the process.
  const lease = leaseOfHandle(vaultRuntime);
  if (lease !== null && vaultRuntime?.primary === true) {
    const { primaryGitRuntime } = requireWiring();
    if (vaultRuntime.id === primaryGitRuntime()?.vaultId) {
      primaryGitRuntime().stop();
      return true;
    }
  }
  return false;
}
