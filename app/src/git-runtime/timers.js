// Per-instance commit/sweep timer controller for the per-vault GitRuntime (Wave B / B4).
//
// This is the cohesive timer slice extracted from `runtime.js` so the runtime can keep its
// read/command surface inside the line budget. It owns exactly one instance's debounce
// timer, max-delay deadline (plus its `imminent` retry bookkeeping) and the single sweep
// interval — never module-level state (contract §16, §44 item 8; MV-I04: the closures capture
// this controller, never an ambient vault or request context).
//
// Frozen cadence rules (W0-D §2, §6), unchanged from `app/src/git.js`:
//  - the max-delay deadline is measured from the oldest pending start, so re-arming can only
//    move it earlier;
//  - an already-expired deadline flushes at the 25 ms floor exactly once per oldest start, then
//    only the debounce cadence retries (anti-retry-storm);
//  - every write (re)arms the debounce timer, so it measures the quiet period since the last one;
//  - at most one sweep interval exists; disabling clears the timers, and an interval change
//    replaces the old timer instead of stacking a second (contract §16.3).
//
// Timing comes from the injected scheduler and clock; the controller never reads the process
// environment, `config.js`, or the request context.

import { PENDING_TIMER_FLOOR_MS } from "./support.js";

export class GitTimerController {
  #now;
  #sched;
  #flush;
  #sweep;
  #report;
  // W2FIX4 item B: the runtime's authorization token at ARM time. A callback whose token no longer
  // matches the runtime's current token was armed under a superseded generation (a revoke, a
  // retirement or a re-approval) and must be refused even if it is invoked directly afterwards.
  #token;
  #commitTimer = null;
  #maxDelayTimer = null;
  #sweepTimer = null;
  #maxDelayKind = null;
  #maxDelayDeadlineAt = null;
  #imminentFlushFor = null;

  // `flush`/`sweep` return the runtime's operation promises and receive the token captured when the
  // callback was armed; `report(prefix, error)` is the runtime's scrubbed logger for a timer-triggered
  // failure; `token()` is the runtime's current authorization token.
  constructor({ now, scheduler, flush, sweep, report, token }) {
    this.#now = now;
    this.#sched = scheduler;
    this.#flush = flush;
    this.#sweep = sweep;
    this.#report = report;
    this.#token = typeof token === "function" ? token : () => 0;
  }

  /** `{ commit, maxDelay, sweep }` — the runtime's timer-lifecycle observability (contract §16.2). */
  snapshot() {
    return {
      commit: this.#commitTimer !== null,
      maxDelay: this.#maxDelayTimer !== null,
      sweep: this.#sweepTimer !== null,
    };
  }

  /**
   * Contract §16.3 reconcile. At most one sweep interval; a disabled vault arms nothing; an
   * enabled sweep replaces the previous interval. Returns `{ idle: true }` when no commit is
   * pending so the runtime can drop its own oldest-start identity.
   */
  reconcile({ config, started, since, pendingSize, sweepIntervalSeconds }) {
    this.clearSweep();
    const token = this.#token();
    if (started && config?.enabled && config.autoCommit && config.autoCommitSweep) {
      this.#sweepTimer = this.#sched.setInterval(
        () => this.#runSweep(token),
        Math.max(1, Number(sweepIntervalSeconds) || 1) * 1000,
      );
    }
    if (!config?.enabled || !config.autoCommit || pendingSize === 0) {
      this.clearCommit();
      this.clearMaxDelay();
      return { idle: pendingSize === 0 };
    }
    this.arm({ config, since, pendingSize });
    return { idle: false };
  }

  /** W0-D §2 arming rules, unchanged (shared by `trackMutation` and pending recovery). */
  arm({ config, since, pendingSize }) {
    if (!config?.enabled || !config.autoCommit) return;
    if (pendingSize === 0) return;
    const token = this.#token();
    const now = this.#now();
    const sinceMs = since === null ? now : Date.parse(since);
    const deadlineAt = (Number.isNaN(sinceMs) ? now : sinceMs) + config.maxDelaySeconds * 1000;
    const remaining = deadlineAt - now;
    if (remaining > 0) {
      // Keep the exact remaining time, but replace a schedule left over for a later deadline.
      if (this.#maxDelayKind !== "deadline" || this.#maxDelayDeadlineAt === null || this.#maxDelayDeadlineAt > deadlineAt) {
        this.#scheduleMaxDelay("deadline", remaining, deadlineAt, token);
      }
    } else if (this.#imminentFlushFor !== since) {
      this.#imminentFlushFor = since;
      this.#scheduleMaxDelay("imminent", PENDING_TIMER_FLOOR_MS, deadlineAt, token);
    } else if (this.#maxDelayKind === "deadline") {
      // Already spent its one imminent retry: drop a later deadline so the debounce cadence triggers.
      this.clearMaxDelay();
    }
    this.clearCommit();
    this.#commitTimer = this.#sched.setTimeout(() => this.#runFlush(token), config.debounceSeconds * 1000);
  }

  clearCommit() {
    if (this.#commitTimer !== null) this.#sched.clearTimeout(this.#commitTimer);
    this.#commitTimer = null;
  }

  clearMaxDelay() {
    if (this.#maxDelayTimer !== null) this.#sched.clearTimeout(this.#maxDelayTimer);
    this.#maxDelayTimer = null;
    this.#maxDelayKind = null;
    this.#maxDelayDeadlineAt = null;
  }

  clearSweep() {
    if (this.#sweepTimer !== null) this.#sched.clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
  }

  clearAll() {
    this.clearCommit();
    this.clearMaxDelay();
    this.clearSweep();
  }

  /** A later batch is a new identity, so it earns its own single imminent retry opportunity. */
  forgetImminent() {
    this.#imminentFlushFor = null;
  }

  #scheduleMaxDelay(kind, delay, deadlineAt, token) {
    this.clearMaxDelay();
    this.#maxDelayTimer = this.#sched.setTimeout(() => {
      this.clearMaxDelay();
      return this.#runFlush(token);
    }, delay);
    this.#maxDelayKind = kind;
    this.#maxDelayDeadlineAt = deadlineAt;
  }

  #runFlush(token) {
    return Promise.resolve()
      .then(() => this.#flush(token))
      .catch((error) => this.#report("Git auto-commit failed", error));
  }

  #runSweep(token) {
    return Promise.resolve()
      .then(() => this.#sweep(token))
      .catch((error) => this.#report("Git sweep failed", error));
  }
}
