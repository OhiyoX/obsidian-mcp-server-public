// Per-vault Git runtime — pure factory skeleton for the MCP multi-Vault track,
// Wave A / A6.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
// §13 (per-call exclusivity), §16 (per-vault GitRuntime: command root, repo
// presence, config reload, trackGitMutation), §21 MV-I04 (timers capture the
// runtime), §26 A6, §38.2 (runtime isolation), §44 item 8 (no process-global
// state); behavior parity authority: `docs/multi-vault/W0-D-git-characterization.md`
// §1-§10 (frozen current semantics of `app/src/git.js` /
// `app/src/git-push-observability.js`).
//
// Design rules enforced across `git-runtime/*`:
//  - **No ambient state.** pending batches (`pending.js`), the three timers, the
//    operation queue, `lastSweep`, and push `lastOutcome`/`consecutiveFailures`
//    all belong to one instance; there is no module-level mutable binding.
//  - **No ambient environment.** `config.js` is never imported and the process
//    environment is never read: config comes from `configProvider()` (A5
//    `resolveEffectiveGitConfig`, composed by the caller), Git from the injected
//    `execFile`, time from the injected clock/scheduler, and the child
//    environment (including `GIT_TERMINAL_PROMPT=0`) from the optional
//    `execEnv` provider — caller injection, not an ambient read.
//  - **No request ALS.** Timer callbacks and every internal call close over the
//    instance; `request-context.js` is never imported (MV-I04).
//  - Only the *stateless* push helpers (`classifyPushFailure`,
//    `scrubCredentials`, `formatPushFailureLog`) are imported from
//    `git-push-observability.js`; its module singletons are never used.

import {
  GIT_RUNTIME_CODES as CODES,
  GIT_RUNTIME_DEFAULTS as DEFAULTS,
  GIT_RUNTIME_FLOORS as FLOORS,
  GIT_RUNTIME_STATES as STATES,
  GitRuntimeError,
  MCP_COMMIT_MESSAGE,
  SWEEP_MESSAGE,
  floorSeconds,
  isValidAuthorEmail,
  normalizeAuthor,
  resolveClock,
  resolveScheduler,
} from "./support.js";
import { createGitAuthorization } from "./authorization.js";
import { GitPendingBatches } from "./pending.js";
import { GitOperations } from "./operations.js";
import { GitTimerController } from "./timers.js";
import { createPushHistory, scrubCredentials } from "../git-push-observability.js";

export {
  GIT_RUNTIME_CODES,
  GIT_RUNTIME_DEFAULTS,
  GIT_RUNTIME_FLOORS,
  GIT_RUNTIME_STATES,
  GitRuntimeError,
  MCP_COMMIT_MESSAGE,
  PENDING_TIMER_FLOOR_MS,
  SWEEP_MESSAGE,
} from "./support.js";

/** W2FIX4 item B: the structured refusal a stale (superseded-generation) timer callback returns. */
const LEASE_BLOCKED = Object.freeze({ committed: false, reason: "git_runtime_lease_revoked", paths: [] });

class GitRuntime {
  #authorization;
  #vaultId;
  #root;
  #configProvider;
  #logger;
  #now;
  #sched;
  #sweepAuthor;
  #pending;
  #ops;
  #timers = null;
  #operationQueue = Promise.resolve();
  #lastSweep = null;
  #push = null;
  #repoState = null;
  #config = null;
  #configError = null;
  #started = false;
  // Resolver lease; process authorization additionally gates import/start and generation tokens.
  leaseGuard = null;

  constructor(options = {}) {
    const { vaultId, root, configProvider, execFile, clock, scheduler, logger, execEnv, maxBuffer, guard } = options;
    if (guard !== undefined && guard !== null && typeof guard !== "function") throw new TypeError("guard must be a function () => boolean when provided");
    if (typeof vaultId !== "string" || vaultId.length === 0) throw new TypeError("createGitRuntime requires vaultId");
    if (typeof root !== "string" || root.length === 0) throw new TypeError("createGitRuntime requires root");
    if (typeof configProvider !== "function") throw new TypeError("createGitRuntime requires configProvider()");
    if (typeof execFile !== "function") throw new TypeError("createGitRuntime requires execFile()");
    const resolved = resolveClock(clock);
    const authorEmail = options.authorEmail ?? DEFAULTS.authorEmail;
    if (!isValidAuthorEmail(authorEmail)) throw new TypeError("authorEmail must be a plain email address");
    this.#authorization = createGitAuthorization(options.authorization);
    this.#vaultId = vaultId;
    this.#root = root;
    this.#configProvider = configProvider;
    this.#logger = logger ?? null;
    this.#now = resolved.now;
    this.#sched = resolveScheduler(scheduler, resolved.scheduler);
    const resolvedEnv = typeof execEnv === "function" ? () => ({ ...execEnv() }) : execEnv ? { ...execEnv } : null;
    this.#sweepAuthor = normalizeAuthor({
      agent: options.sweepAuthor?.agent ?? DEFAULTS.sweepAgent,
      model: options.sweepAuthor?.model ?? DEFAULTS.sweepModel,
    });
    this.#pending = new GitPendingBatches(this.#root);
    this.leaseGuard = guard ?? null;
    this.#ops = new GitOperations({
      root: this.#root,
      exec: execFile,
      execEnv: resolvedEnv,
      maxBuffer: Number.isInteger(maxBuffer) && maxBuffer > 0 ? maxBuffer : 4 * 1024 * 1024,
      authorEmail,
      pending: this.#pending,
      history: { recordPushOutcome: (outcome) => this.#push.record(outcome) },
      logger: { log: (level, message) => this.#log(level, message) },
      enabledConfig: () => this.#requireEnabled(),
      currentConfig: () => this.#config,
      probe: () => this.probe(),
      idleCleanup: () => this.#resetPendingIfIdle(),
      // A failed (or no-op) commit must restore scheduling as well as pending data (W0-D §2/§3).
      recoverPending: () => this.#armCommitTimers(),
    });
    // One push history per instance (contract §16 / §44 item 8) and one timer
    // controller per instance (MV-I04): timer callbacks close over this runtime,
    // never an ambient vault or a request context.
    this.#push = createPushHistory({ now: this.#now });
    this.#timers = new GitTimerController({
      now: this.#now,
      scheduler: this.#sched,
      token: () => this.#authorization.token(this.leaseGuard),
      // W2FIX4 item B: a callback armed under a superseded guard is refused like a revoked lease.
      flush: (token) => (token === this.#authorization.token(this.leaseGuard) ? this.flushNow() : Promise.resolve(LEASE_BLOCKED)),
      sweep: (token) => (token === this.#authorization.token(this.leaseGuard) ? this.sweepNow() : Promise.resolve(LEASE_BLOCKED)),
      report: (prefix, error) => this.#logFailure(prefix, error),
    });
    this.#loadConfig();
  }

  get vaultId() {
    return this.#vaultId;
  }

  /** W2FIX4 item B: cheap "has the timer controller started?" probe for the shared primary resume. */
  get started() {
    return this.#started;
  }
  get root() {
    return this.#root;
  }

  /** The effective config the runtime is currently acting on (floored), or null. */
  config() {
    return this.#config;
  }

  /** The instance's push history — one per runtime, never process-global (§16, §44-8). */
  get pushHistory() {
    return this.#push;
  }

  /** Contract §16.2 state machine; fail-closed before the first successful probe. */
  state() {
    if (this.#configError) return STATES.CONFIG_INVALID;
    if (!this.#config?.enabled) return STATES.DISABLED;
    if (this.#repoState !== "ready") return STATES.REPOSITORY_MISSING;
    if (this.#push.failures() > 0) return STATES.PUSH_FAILING;
    return STATES.READY;
  }

  pushObservability() {
    return this.#push.snapshot();
  }

  status() {
    return {
      vaultId: this.#vaultId,
      root: this.#root,
      state: this.state(),
      started: this.#started,
      repository: this.#repoState ?? "unprobed",
      config: this.#config ? { ...this.#config } : null,
      configError: this.#configError ? { name: this.#configError.name, message: this.#configError.message } : null,
      pending: {
        paths: this.#pending.paths(),
        authors: this.#pending.authors(),
        pendingSince: this.#pending.since,
      },
      timers: this.#timers.snapshot(),
      lastSweep: this.#lastSweep ? { ...this.#lastSweep } : null,
      push: this.pushObservability(),
    };
  }

  /** W2FIX3 item 5: "is this runtime still allowed to do NEW work?" (re-checked on every operation). */
  #isBlocked() {
    return !this.#authorization.allowed(this.leaseGuard);
  }

  #block() {
    this.#started = false;
    if (this.#timers !== null) this.#timers.clearAll();
    return new GitRuntimeError(CODES.LEASE_REVOKED, `The Vault authorization for ${this.#vaultId} is no longer current; refusing new Git work`);
  }

  /**
   * Records one completed write. Silent no-op when this vault's Git is disabled
   * or autoCommit is off (W0-D §1: no pending state, no author requirement).
   */
  trackMutation({ paths, author } = {}) {
    if (this.#isBlocked()) return { tracked: false, reason: CODES.LEASE_REVOKED };
    if (this.#configError) return { tracked: false, reason: STATES.CONFIG_INVALID };
    if (!this.#config?.enabled || !this.#config.autoCommit) return { tracked: false, reason: "disabled" };
    const identity = normalizeAuthor(author);
    this.#pending.track(identity, paths);
    // The deadline always measures the *oldest* start, so later writes never extend it.
    if (this.#pending.since === null) this.#pending.since = this.#iso(this.#now());
    this.#armCommitTimers();
    return { tracked: true, pendingPaths: this.#pending.paths() };
  }

  /**
   * Commits every pending MCP batch now (also the debounce/max-delay target).
   * Throws synchronously when the vault's Git is disabled or its config invalid,
   * matching git.js `requireEnabled()`.
   */
  flushNow() {
    if (this.#isBlocked()) { this.#block(); return Promise.resolve({ committed: false, reason: CODES.LEASE_REVOKED, paths: [] }); }
    const config = this.#requireEnabled();
    this.#timers.clearCommit();
    this.#timers.clearMaxDelay();
    const batches = this.#pending.batches();
    if (batches.length === 0) {
      this.#pending.since = null;
      return Promise.resolve({ committed: false, reason: "No pending MCP changes", paths: [] });
    }
    const startedAt = this.#pending.since;
    this.#pending.since = null;
    this.#pending.clear();
    return this.#enqueue(async () => {
      const commits = [];
      let completed = 0;
      try {
        for (const batch of batches) {
          commits.push(await this.#ops.commitUnlocked({
            paths: batch.paths,
            author: batch.author,
            message: MCP_COMMIT_MESSAGE,
            push: config.autoPush,
          }));
          completed += 1;
        }
        return commits.length === 1 ? commits[0] : { committed: true, commits };
      } catch (error) {
        // A failed flush restores its un-committed batches and re-arms scheduling.
        this.#pending.restore(batches.slice(completed), startedAt);
        this.#armCommitTimers();
        throw error;
      }
    });
  }

  /** Whole-tree sweep (W0-D §6): distinct author/message, consumes pending batches. */
  sweepNow() {
    if (this.#isBlocked()) { this.#block(); return Promise.resolve({ committed: false, reason: CODES.LEASE_REVOKED, paths: [] }); }
    const config = this.#requireEnabled();
    if (!config.autoCommit || !config.autoCommitSweep) {
      return Promise.resolve({ committed: false, reason: "Automatic tree sweep is disabled", paths: [] });
    }
    return this.#enqueue(async () => {
      const result = await this.#ops.commitUnlocked({
        includeAll: true,
        consumePending: true,
        author: this.#sweepAuthor,
        message: SWEEP_MESSAGE,
        push: config.autoPush,
      });
      this.#lastSweep = {
        at: this.#iso(this.#now()),
        committed: result.committed === true,
        hash: result.hash || null,
        reason: result.reason || null,
        pushed: result.pushed ?? null,
      };
      if (result.committed) {
        // #436: name the *executor* (the sweep), not the content's origin. The commit may contain
        // pending MCP writes that this sweep folded in (`consumePending`), so "not made through MCP"
        // was a false description of the committed content.
        this.#log("warn", `Git sweep committed ${String(result.hash).slice(0, 7)} (working-tree commit by auto-sweep; may include pending MCP writes)`);
      }
      return result;
    });
  }

  manualCommit(options = {}) {
    if (this.#isBlocked()) throw this.#block();
    this.#requireEnabled();
    return this.#enqueue(() => this.#ops.commitUnlocked({ ...options, consumePending: true }));
  }

  manualPull(options = {}) {
    if (this.#isBlocked()) throw this.#block();
    this.#requireEnabled();
    return this.#enqueue(() => this.#ops.pullUnlocked(options));
  }

  manualPush(options = {}) {
    if (this.#isBlocked()) throw this.#block();
    this.#requireEnabled();
    return this.#enqueue(() => this.#ops.pushUnlocked(options));
  }

  /**
   * Arms the timers, then probes repo presence (never the filesystem).
   * `sweepIntervalSeconds` is the pre-migration `startSweepTimer(intervalSeconds)`
   * override used by the tests; without it the effective config decides, so a later
   * `reloadConfig()` is free to replace the interval (contract §16.3).
   */
  async start({ sweepIntervalSeconds } = {}) {
    this.#started = true;
    this.#loadConfig();
    // W2FIX3 item 5: a revoked handle never arms timers or probes for new work.
    if (this.#isBlocked()) { this.#block(); return this.status(); }
    // Reconcile before awaiting the probe so the sweep interval is armed
    // synchronously, exactly like the pre-migration `startSweepTimer()`; a
    // `stop()` during the probe still wins because reconcile re-reads `#started`.
    this.#reconcileTimers(sweepIntervalSeconds);
    await this.probe();
    return this.status();
  }

  /** Clears every timer; pending data and push history are preserved. */
  stop() {
    this.#started = false;
    this.#reconcileTimers();
    return this.status();
  }

  /** Contract §16.3: re-read config, reconcile timers, re-probe presence. */
  async reloadConfig() {
    this.#loadConfig();
    if (this.#isBlocked()) { this.#block(); return this.status(); }
    this.#reconcileTimers();
    if (this.#config?.enabled) await this.probe();
    else this.#repoState = null;
    return this.status();
  }

  /**
   * W0-D §8, in the pre-migration order: `requireEnabled()` first, then the frozen
   * "not a working tree" refusal. The compatibility facade's read paths use this.
   */
  async assertRepository() {
    this.#requireEnabled();
    if ((await this.probe()) !== "ready") {
      throw new GitRuntimeError(CODES.REPOSITORY_MISSING, "The mounted vault is not a Git working tree");
    }
  }

  /**
   * Read-only command access bound to this runtime's root (`-C`, `safe.directory`,
   * `core.quotepath=false`) and this vault's enablement; the facade assembles the
   * frozen `git_status`/`git_diff`/`git_log` shapes from it.
   */
  runGit(args, options) {
    return this.#ops.runGit(args, options);
  }

  /**
   * W0-D §3 path containment bound to this runtime's root. `git_diff` validates its
   * `-- <path>` through the same rule the write paths use, so read and write can never
   * disagree about what is inside the vault (contract SEC-MV01).
   */
  normalizePath(userPath) {
    return this.#pending.normalize(userPath);
  }

  /** Repo presence is probed only through the injected exec. */
  async probe() {
    if (this.#configError || !this.#config?.enabled) {
      this.#repoState = null;
      return this.#repoState;
    }
    try {
      const result = await this.#ops.runGit(["rev-parse", "--is-inside-work-tree"]);
      this.#repoState = result.stdout === "true" ? "ready" : "repository-missing";
    } catch (error) {
      // A missing root makes git exit non-zero: "no repository", not a crash.
      this.#repoState = error?.code === CODES.DISABLED ? null : "repository-missing";
    }
    return this.#repoState;
  }

  // ---------------------------------------------------------------- config --

  #loadConfig() {
    try {
      const raw = this.#configProvider();
      if (!raw || typeof raw !== "object" || typeof raw.enabled !== "boolean") {
        throw new GitRuntimeError(CODES.CONFIG_INVALID, "configProvider must return an effective Git config object");
      }
      this.#config = Object.freeze({
        vaultId: this.#vaultId,
        enabled: raw.enabled === true,
        autoCommit: raw.autoCommit === true,
        autoPush: raw.autoPush === true,
        autoCommitSweep: raw.autoCommitSweep === true,
        debounceSeconds: floorSeconds(raw.debounceSeconds, FLOORS.debounceSeconds, DEFAULTS.debounceSeconds),
        maxDelaySeconds: floorSeconds(raw.maxDelaySeconds, FLOORS.maxDelaySeconds, DEFAULTS.maxDelaySeconds),
        sweepIntervalSeconds: floorSeconds(raw.sweepIntervalSeconds, FLOORS.sweepIntervalSeconds, DEFAULTS.sweepIntervalSeconds),
        remote: typeof raw.remote === "string" && raw.remote.length > 0 ? raw.remote : DEFAULTS.remote,
        branch: typeof raw.branch === "string" ? raw.branch : DEFAULTS.branch,
        source: typeof raw.source === "string" ? raw.source : null,
      });
      this.#configError = null;
    } catch (error) {
      // A broken config is fail-closed: never "enabled", never pending work, no timers.
      this.#config = null;
      this.#configError = error instanceof Error ? error : new Error(String(error));
      this.#started = false;
      this.#reconcileTimers();
      this.#pending.clear();
      this.#pending.since = null;
    }
  }

  #requireEnabled() {
    if (this.#configError) {
      throw new GitRuntimeError(CODES.CONFIG_INVALID, "Git configuration for this vault is invalid");
    }
    if (!this.#config?.enabled) {
      throw new GitRuntimeError(CODES.DISABLED, "Git integration is disabled for this vault");
    }
    return this.#config;
  }

  // ---------------------------------------------------------------- timers --

  // The timer controller owns the debounce/max-delay/sweep handles and the frozen
  // W0-D §2 cadence; this method is the §16.3 reconcile entry point (at most one
  // sweep interval, disable clears, an interval change replaces the old timer).
  #reconcileTimers(sweepIntervalSeconds) {
    const config = this.#config;
    const { idle } = this.#timers.reconcile({
      config,
      started: this.#started,
      since: this.#pending.since,
      pendingSize: this.#pending.size,
      sweepIntervalSeconds: sweepIntervalSeconds ?? config?.sweepIntervalSeconds,
    });
    if (idle) this.#pending.since = null;
  }

  #armCommitTimers() {
    this.#timers.arm({
      config: this.#config,
      since: this.#pending.since,
      pendingSize: this.#pending.size,
    });
  }

  #resetPendingIfIdle() {
    // Only a truly empty pending set may drop the timers and the oldest start.
    if (this.#pending.size > 0) return;
    this.#timers.clearCommit();
    this.#timers.clearMaxDelay();
    this.#pending.since = null;
    // A later batch is a new identity and earns its own single imminent retry.
    this.#timers.forgetImminent();
  }

  #enqueue(operation) {
    // Queueing is not starting: the same generation must still be authorized at execution.
    const staged = this.#authorization.stage(operation, () => this.leaseGuard, () => this.#block());
    const result = this.#operationQueue.then(staged, staged);
    this.#operationQueue = result.then(() => {}, () => {});
    return result;
  }

  // ---------------------------------------------------------------- logger --

  #iso(ms) {
    return new Date(ms).toISOString();
  }

  #log(level, message) {
    const write = this.#logger?.[level];
    if (typeof write === "function") write.call(this.#logger, message);
  }

  // Credential-shaped text never reaches a log line (A6 item 6; stricter than
  // git.js, which logs the raw message for non-push failures).
  #logFailure(prefix, error) {
    this.#log("error", `${prefix}: ${scrubCredentials(error?.message ?? error)}`);
  }
}

export function createGitRuntime(options = {}) {
  return new GitRuntime(options);
}
