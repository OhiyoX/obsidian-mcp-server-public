// `src/git.js` — compatibility facade for the per-vault Git runtime (contract §16, §43-5 facade
// allowlist).
//
// Wave B / B4 moved every piece of Git state into `git-runtime/*`: one `GitRuntime` instance owns
// the pending batches, the debounce/max-delay/sweep timers, the serialized operation queue,
// `lastSweep` and the push history (§16, §44 item 8). This module keeps the *exact* pre-migration
// public surface — same export names, arity and observable behavior, frozen by
// `docs/multi-vault/W0-D-git-characterization.md` §1–§10 — bound to the one primary instance built
// here from A5's store plus the deployment's `GIT_*` baseline (§15.4/§38.1).
//
// It is the §43-5 allowlisted facade: the only core module that may read the global `VAULT` /
// `DATA_PATH` to build a runtime. Callers (`tools/git.js`, `tools/files.js`, `batch-journal.js`,
// `vault.js`) are unchanged, and `vault.js` keeps injecting `trackGitMutation` into the primary
// LocalFs write path (§16.4). No production file watcher, no ambient worker state: the runtime is
// built once, here, and the primary sweep interval is armed at import exactly like the
// pre-migration `startSweepTimer()` call.
//
// Wave D / D-git (2026) keeps every export above byte-for-byte in name, arity and behavior and adds
// the per-Vault surface §16 asks for, additively:
//
//   * `buildGitRuntime()` — the one factory, used for the primary here and for a secondary through
//     `configureGitRuntimes()` (`primary:false`, its own root, the *same* A5 store);
//   * `git*For(runtime, …)` — the frozen `git_status`/`git_diff`/`git_log` assembly and the
//     commit/pull/push calls, parameterized by the GitRuntime they run against. The zero-arity
//     exports below delegate with the primary instance, so the §21 MV-I07 legacy surface (and the
//     arity ratchet in `git-migration-isolation.test.js`) is untouched;
//   * `trackGitMutation(paths)` resolves the *current request's* GitRuntime through
//     `src/git-runtimes.js` (§16.4: a completed write goes to the current VaultRuntime's Git), which
//     reaches the primary when no Vault was selected and refuses to fall back to the primary for a
//     secondary selection.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DATA_PATH,
  GIT_AUTHOR_EMAIL,
  GIT_AUTHOR_NAME,
  GIT_AUTO_COMMIT,
  GIT_AUTO_COMMIT_SWEEP,
  GIT_AUTO_PUSH,
  GIT_BRANCH,
  GIT_COMMIT_DEBOUNCE_SECONDS,
  GIT_COMMIT_MAX_DELAY_SECONDS,
  GIT_ENABLED,
  GIT_REMOTE,
  GIT_SWEEP_INTERVAL_SECONDS,
  VAULT,
  VAULT_DISCOVERY_ENABLED,
  VAULT_ADMISSIONS_PATH,
  VAULT_ADMISSION_ENROLLMENT_PATH,
} from "./config.js";
import { DEFAULT_VAULT_ID } from "./oauth/primitives.js";
import { requireRequestAuthor } from "./request-context.js";
import { createGitConfigStore } from "./git-config/store.js";
import { resolveEffectiveGitConfig } from "./git-config/schema.js";
import { createGitConfigProvider } from "./git-runtime/config-source.js";
import { createGitRuntime } from "./git-runtime/runtime.js";
import { bindPushHistory } from "./git-push-observability.js";
import {
  GIT_RUNTIME_INVALID,
  GIT_RUNTIME_REFUSED,
  configureGitRuntimes,
  resolveGitRuntime,
} from "./git-runtimes.js";
import { bootstrapPrimaryAuthorization } from "./vault-runtime/primary-bootstrap.js";
import { primaryAuthorizationToken, primaryAuthorized, registerPrimaryReleaseCallback, registerPrimaryAllowCallback } from "./vault-runtime/primary-authorization.js";

const execFileAsync = promisify(execFile);

// The deployment's `GIT_*` baseline (contract §15.4 / W0-D §1). A primary vault with no persisted
// record resolves to exactly these values, so the upgrade changes nothing until an Admin record
// exists; a secondary vault with no record is default-disabled by A5's inheritance matrix.
const GIT_ENV_DEFAULTS = Object.freeze({
  enabled: GIT_ENABLED,
  autoCommit: GIT_AUTO_COMMIT,
  autoPush: GIT_AUTO_PUSH,
  autoCommitSweep: GIT_AUTO_COMMIT_SWEEP,
  debounceSeconds: GIT_COMMIT_DEBOUNCE_SECONDS,
  maxDelaySeconds: GIT_COMMIT_MAX_DELAY_SECONDS,
  sweepIntervalSeconds: GIT_SWEEP_INTERVAL_SECONDS,
  remote: GIT_REMOTE,
  branch: GIT_BRANCH,
});

// Protected primary config file: `DATA_PATH/git-vaults.json` (contract §15). The store never
// derives another path, and E (Admin) is the only writer.
const gitConfigStore = createGitConfigStore({ dataRoot: DATA_PATH });

/**
 * The `configProvider()` of a **secondary** Vault (§15.4): the same inheritance matrix as B4's
 * `createGitConfigProvider`, but a store that has already settled is read straight from its snapshot.
 *
 * Why: `createGitConfigProvider` answers the §15.4 "no record → default-disabled" baseline until its
 * own readiness flag flips, and that flag flips one microtask *after* `store.ready` settles. Every
 * secondary is materialized lazily by its first request — long after the durable load — so with B4's
 * provider alone the first read of a freshly built secondary runtime would act on that stale
 * default-disabled answer while the persisted record says "enabled". Only that window is special:
 * before the load settles this delegates to B4's provider unchanged (which fails closed for a broken
 * store, §15.3/§38.3), and the A5 inheritance matrix stays single-sourced in `resolveEffectiveGitConfig`.
 */
function secondaryGitConfigProvider(vaultId) {
  const beforeLoad = createGitConfigProvider({ vaultId, primary: false, store: gitConfigStore, envDefaults: GIT_ENV_DEFAULTS });
  return function gitConfigProvider() {
    const snapshot = gitConfigStore.snapshot();
    if (snapshot.status !== "ready") return beforeLoad();
    return resolveEffectiveGitConfig({ vaultId, primary: false, record: snapshot.vaults[vaultId] ?? null, envDefaults: GIT_ENV_DEFAULTS });
  };
}

/**
 * Builds one GitRuntime. Identity/author values come from the deployment environment through these
 * factory options (the runtime itself never reads the environment), the command root is bound to the
 * Vault's own root for every command it runs (§16.1), and the effective config comes from the
 * *shared* A5 store (§15.4) so an Admin write and a runtime read can never disagree (§16.3).
 *
 * Wave D / D-git: the primary instance is built here at import exactly as before; a secondary
 * instance is built on demand through `createSecondaryRuntime` (same store, `primary:false`, its own
 * root) and handed to `src/git-runtimes.js`, which caches it per B1 VaultRuntime instance.
 */
function buildGitRuntime({ vaultId, root, primary, guard }) {
  return createGitRuntime({
    vaultId,
    root,
    guard,
    // F3: primary runtime must check process-shared primary authorization
    authorization: primary ? { allowed: primaryAuthorized, token: primaryAuthorizationToken } : undefined,
    configProvider: primary
      ? createGitConfigProvider({ vaultId, primary: true, store: gitConfigStore, envDefaults: GIT_ENV_DEFAULTS })
      : secondaryGitConfigProvider(vaultId),
    execFile: execFileAsync,
    authorEmail: GIT_AUTHOR_EMAIL,
    sweepAuthor: { agent: GIT_AUTHOR_NAME, model: "auto-sweep" },
    // W0-D §7: git must never block on an interactive credential prompt. The child environment is
    // injected here, not read inside `git-runtime/*`.
    execEnv: () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" }),
    logger: console,
  });
}

// The one primary GitRuntime for this process; its command root is `VAULT` for every command (§16.1).
// F3: provide a guard that always returns true for process-owned primary (no lease)
const primaryRuntime = buildGitRuntime({ vaultId: DEFAULT_VAULT_ID, root: VAULT, primary: true, guard: () => true });

// Wave D / D-git: inject this facade's already-built collaborators into the per-Vault resolver once,
// here — this module is the §43-5 allowlisted place that may read the global Vault root and the
// `GIT_*` baseline. The resolver owns the request-scoped selection and the per-Vault cache; it never
// builds a second primary, and a secondary always reads its own record from this same store.
configureGitRuntimes({
  primaryGitRuntime: () => primaryRuntime,
  // W2FIX3 item 5: a secondary runtime receives the lease guard of the consumer handle it was built
  // for, so a timer-triggered or captured callback cannot commit after the handle is revoked.
  createSecondaryRuntime: ({ vaultId, root, guard }) => buildGitRuntime({ vaultId, root, primary: false, guard }),
  // §16.3: the durable A5 load is asynchronous, so an instance materialized before it settled
  // reconciles its persisted record (or a broken store) as soon as the load resolves.
  onStoreReady: () => gitConfigStore.ready,
  logger: console,
});

// `git_status`/`pushObservability()` keep addressing the primary runtime's push history (#255).
bindPushHistory(primaryRuntime.pushHistory);

// F3: managed mode defers start() until explicitly allowed; legacy mode starts immediately.
// The bootstrap result determines whether this is a managed or legacy primary.
const bootstrap = await bootstrapPrimaryAuthorization({
  automaticDiscovery: VAULT_DISCOVERY_ENABLED,
  file: VAULT_ADMISSIONS_PATH,
  enrollmentFile: VAULT_ADMISSION_ENROLLMENT_PATH
});

if (!bootstrap.managed) {
  // Legacy: arm the primary sweep interval at import, like the pre-migration startSweepTimer()
  primaryRuntime.start().catch((error) => console.error("Git sweep timer failed:", error.message));
}
// Managed mode: start() will be called explicitly after vault initialization (by startVaultRuntimeInventory or similar)

// F3: register callbacks to stop/start primary runtime timers when authorization changes
registerPrimaryReleaseCallback(() => {
  primaryRuntime.stop();
});
registerPrimaryAllowCallback(() => {
  primaryRuntime.start().catch((error) => console.error("Git sweep timer restart failed:", error.message));
});

// The store load is asynchronous; until it settles the env baseline is the effective config. Once
// it settles, reconcile so a persisted record — or a broken store — takes effect (§16.3, §38.3).
gitConfigStore.ready
  .then(() => primaryRuntime.reloadConfig())
  .catch((error) => console.error("Git config reconcile failed:", error.message));

function assertGitRuntime(runtime) {
  if (runtime === null || typeof runtime !== "object" || typeof runtime.vaultId !== "string" || typeof runtime.runGit !== "function") {
    throw new TypeError("git.js: expected a GitRuntime instance from src/git-runtimes.js");
  }
  return runtime;
}

/**
 * The `config:null` fallback of `gitConfigurationFor()`. The primary keeps the frozen `GIT_*`
 * baseline (W0-D §1); a secondary falls back to the §15.4 *default-disabled* shape — suggested
 * timing/remote/branch stay displayable, every toggle stays false — so the deployment's primary
 * baseline never leaks into another Vault's report (SEC-MV03).
 */
function fallbackGitConfig(runtime) {
  return runtime === primaryRuntime
    ? GIT_ENV_DEFAULTS
    : { ...GIT_ENV_DEFAULTS, enabled: false, autoCommit: false, autoPush: false, autoCommitSweep: false };
}

/**
 * Frozen `git_status`/`log`/`config` shape (W0-D §1–§6) for one GitRuntime; no runtime internals leak
 * out. Per-Vault since Wave D / D-git: the pending paths/authors, `lastSweep` and push observability
 * all come from that instance (§16, §44 item 8).
 */
export function gitConfigurationFor(runtime) {
  assertGitRuntime(runtime);
  const status = runtime.status();
  const config = status.config ?? fallbackGitConfig(runtime);
  return {
    enabled: config.enabled === true,
    autoCommit: config.autoCommit === true,
    autoPush: config.autoPush === true,
    debounceSeconds: config.debounceSeconds,
    maxDelaySeconds: config.maxDelaySeconds,
    autoCommitSweep: config.autoCommitSweep === true,
    sweepIntervalSeconds: config.sweepIntervalSeconds,
    lastSweep: status.lastSweep,
    pendingSince: status.pending.pendingSince,
    remote: config.remote,
    branch: config.branch || null,
    pendingPaths: status.pending.paths,
    pendingAuthors: status.pending.authors,
    push: runtime.pushObservability(),
  };
}

/** The primary Vault's `gitConfiguration()` (§21 MV-I07). */
export function gitConfiguration() {
  return gitConfigurationFor(primaryRuntime);
}

/**
 * The GitRuntime that owns the current call: the request's VaultRuntime through
 * `src/git-runtimes.js`, or the primary instance when no Vault was selected (§21 MV-I07). A
 * selection without a materialized runtime is refused there; the discipline here is only "never
 * throw from `trackGitMutation`", whose callers run *after* the bytes were already written.
 */
function currentGitRuntimeOrNull() {
  try {
    return resolveGitRuntime();
  } catch (error) {
    if (error?.code === GIT_RUNTIME_REFUSED || error?.code === GIT_RUNTIME_INVALID) return null;
    throw error;
  }
}

/**
 * Records a completed write on the primary runtime (contract §16.4: the mutation goes to the
 * *current* VaultRuntime's Git, never a module singleton).
 *
 * W0-D §1: the `GIT_ENABLED`/`GIT_AUTO_COMMIT` gate returns before `requireRequestAuthor()`, so a
 * disabled (or config-invalid) vault is a silent no-op even outside a request context.
 */
export function trackGitMutation(paths) {
  const runtime = currentGitRuntimeOrNull();
  // A write must never fail because *reporting* it to Git was impossible: a selection without a
  // materialized runtime is refused on the Git tool surface (§47), where the caller asked for Git,
  // and skipped here. Disabled / autoCommit-off stays the silent no-op frozen by W0-D §1.
  if (runtime === null) return;
  const config = runtime.config();
  if (!config?.enabled || !config.autoCommit) return;
  runtime.trackMutation({ paths, author: requireRequestAuthor() });
}

/** Contract §16.3: re-read the store, reconcile timers, re-probe presence. */
export function reloadGitConfig() {
  return primaryRuntime.reloadConfig();
}

/** Frozen `git_status` shape (W0-D §1–§6) of one GitRuntime; `-C` is that runtime's own root. */
export async function gitStatusFor(runtime) {
  assertGitRuntime(runtime);
  await runtime.assertRepository();
  const result = await runtime.runGit(["status", "--branch", "--porcelain=v1"]);
  const lines = result.stdout ? result.stdout.split("\n") : [];
  const branch = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : null;
  return {
    branch,
    clean: lines.length === 0,
    changes: lines.map((line) => ({ index: line[0], worktree: line[1], path: line.slice(3) })),
    pendingAutoCommitPaths: runtime.status().pending.paths,
    configuration: gitConfigurationFor(runtime),
  };
}

/** Frozen `git_diff` shape of one GitRuntime; the path rule is that runtime's own root (§16.1). */
export async function gitDiffFor(runtime, options = {}) {
  assertGitRuntime(runtime);
  await runtime.assertRepository();
  const args = ["diff", "--no-ext-diff", "--no-color"];
  if (options.staged) args.push("--cached");
  if (options.path) args.push("--", runtime.normalizePath(options.path));
  const output = (await runtime.runGit(args)).stdout;
  const limit = options.maxChars || 100_000;
  return { staged: Boolean(options.staged), path: options.path || null, diff: output.slice(0, limit), truncated: output.length > limit };
}

/** Frozen `git_log` shape of one GitRuntime. */
export async function gitLogFor(runtime, limit = 20) {
  assertGitRuntime(runtime);
  await runtime.assertRepository();
  const format = "%H%x1f%h%x1f%aI%x1f%an%x1f%ae%x1f%s%x1e";
  const output = (await runtime.runGit(["log", `--max-count=${limit}`, `--format=${format}`])).stdout;
  return output.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [hash, shortHash, date, author, email, subject] = entry.split("\x1f");
    return { hash, shortHash, date, author, email, subject };
  });
}

export async function getGitStatus() {
  return gitStatusFor(primaryRuntime);
}

export async function getGitDiff(options = {}) {
  return gitDiffFor(primaryRuntime, options);
}

export async function getGitLog(limit = 20) {
  return gitLogFor(primaryRuntime, limit);
}

/** Manual commit: synchronous `requireEnabled()` plus the pre-migration author fallback.
 *
 * W0-D §3/§16.4: the request-context author is resolved here, in the facade — `git-runtime/*`
 * never touches the ALS request context (MV-I04), so the runtime always receives an explicit
 * author. `flushAutoCommit`/`sweepAutoCommit` carry their own per-batch / sweep authors.
 */
export function commitGitFor(runtime, options = {}) {
  assertGitRuntime(runtime);
  const author = options.author || requireRequestAuthor();
  return runtime.manualCommit({ ...options, author, consumePending: true });
}

export function commitGit(options = {}) {
  return commitGitFor(primaryRuntime, options);
}

/** Legacy `flushAutoCommit()` was `async`, so a disabled vault rejects instead of throwing. */
export async function flushAutoCommit() {
  return primaryRuntime.flushNow();
}

/** Whole-tree sweep (#265); `lastSweep` and the distinct author/message are unchanged. */
export async function sweepAutoCommit() {
  return primaryRuntime.sweepNow();
}

/**
 * Legacy `startSweepTimer(intervalSeconds)`. The timer belongs to the primary runtime; an explicit
 * interval is used for that arming only, so a later `reloadGitConfig()` still follows the config.
 */
export function startSweepTimer(intervalSeconds = GIT_SWEEP_INTERVAL_SECONDS) {
  primaryRuntime.start({ sweepIntervalSeconds: intervalSeconds }).catch((error) => console.error("Git sweep timer failed:", error.message));
}

/** Clears the primary runtime's timers; pending batches and push history are preserved. */
export function stopSweepTimer() {
  primaryRuntime.stop();
}

export function pullGitFor(runtime, options = {}) {
  assertGitRuntime(runtime);
  return runtime.manualPull(options);
}

export function pushGitFor(runtime, options = {}) {
  assertGitRuntime(runtime);
  return runtime.manualPush(options);
}

export function pullGit(options = {}) {
  return pullGitFor(primaryRuntime, options);
}

export function pushGit(options = {}) {
  return pushGitFor(primaryRuntime, options);
}

// ------------------------------------------------------- additive accessors --
//
// Wave E / EA: the Auth Center Admin assembly (`src/admin/vault-git-assembly.js`) must show
// and persist the *same* per-vault Git configuration the runtime reconciles (§16.3). A second
// store instance would split the Admin write from the runtime read, so these two accessors
// hand out this facade's existing instances — read-only from the caller's point of view.
//
// Additive only (§43-5 facade allowlist): no new module-level state, no behavior change, and
// the pre-migration export names/arity above stay exactly as characterized by W0-D.

/** The one A5 GitConfig store instance every Git reader in this process shares. */
export function gitConfigStoreInstance() {
  return gitConfigStore;
}

/** The one primary GitRuntime instance (§16.4: mutations route to the current Vault runtime). */
export function primaryGitRuntime() {
  return primaryRuntime;
}
