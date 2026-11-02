// Shared constants, error type and pure helpers for the per-vault GitRuntime
// (Wave A / A6, contract §16/§38.2).
//
// Nothing here holds mutable state, reads the process environment, imports
// `config.js`, or touches the request context: it is the leaf module of
// `git-runtime/`.

export const GIT_RUNTIME_STATES = Object.freeze({
  DISABLED: "disabled",
  READY: "ready",
  REPOSITORY_MISSING: "repository-missing",
  CONFIG_INVALID: "config-invalid",
  PUSH_FAILING: "push-failing",
});

export const GIT_RUNTIME_CODES = Object.freeze({
  DISABLED: "git_runtime_disabled",
  CONFIG_INVALID: "git_runtime_config_invalid",
  REPOSITORY_MISSING: "git_runtime_repository_missing",
  AUTHOR_REQUIRED: "git_runtime_author_required",
  INVALID_PATH: "git_runtime_invalid_path",
  INVALID_REF: "git_runtime_invalid_ref",
  NO_PATHS: "git_runtime_no_paths",
  COMMAND_FAILED: "git_runtime_command_failed",
  // W2FIX3 item 5: the Vault authorization this runtime was built for is no longer current; a
  // timer-triggered or captured reference must refuse NEW work instead of committing.
  LEASE_REVOKED: "git_runtime_lease_revoked",
});

export class GitRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "GitRuntimeError";
    this.code = code;
    this.details = options.details;
  }
}

// W0-D §3/§6 frozen strings: the MCP batch message and the distinct sweep message.
// #436: the sweep message must stay neutral about the *source* of the content. A sweep commits the
// whole working tree and may fold pending MCP writes into its own commit (`consumePending`), so
// calling it "non-MCP" was a false description. Only the wording changed: the sweep's scope and its
// interaction with pending batches (including in-flight writes) are untouched.
export const MCP_COMMIT_MESSAGE = "chore(obsidian): save MCP changes";
export const SWEEP_MESSAGE = "chore(obsidian): sweep vault working-tree changes";
// W0-D §2: expired-deadline floor, granted once per oldest pending start.
export const PENDING_TIMER_FLOOR_MS = 25;

// Contract §15.2 hard bounds, re-applied on top of A5's schema so a hand-built
// config object cannot schedule below the frozen floors (W0-D §1).
export const GIT_RUNTIME_FLOORS = Object.freeze({
  debounceSeconds: 5,
  maxDelaySeconds: 1,
  sweepIntervalSeconds: 30,
});

// Mirrors `config.js:48-55` defaults without importing it (W0-D §1).
export const GIT_RUNTIME_DEFAULTS = Object.freeze({
  debounceSeconds: 180,
  maxDelaySeconds: 900,
  sweepIntervalSeconds: 900,
  remote: "origin",
  branch: "",
  authorEmail: "obsidian-mcp@local",
  sweepAgent: "Obsidian MCP",
  sweepModel: "auto-sweep",
});

const REF_PATTERN = /^[A-Za-z0-9._/@:-]+$/;
const AUTHOR_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

export function isValidAuthorEmail(value) {
  return typeof value === "string" && AUTHOR_EMAIL_PATTERN.test(value);
}

export function toMillis(value) {
  const millis = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis)) throw new TypeError("clock must return a valid instant");
  return millis;
}

function createRealScheduler() {
  return {
    setTimeout(fn, ms) {
      const handle = setTimeout(fn, ms);
      handle?.unref?.();
      return handle;
    },
    clearTimeout(handle) {
      if (handle) clearTimeout(handle);
    },
    setInterval(fn, ms) {
      const handle = setInterval(fn, ms);
      handle?.unref?.();
      return handle;
    },
    clearInterval(handle) {
      if (handle) clearInterval(handle);
    },
  };
}

// `clock` is a function returning an instant or an object exposing `now()`; a
// clock that also exposes the four scheduler methods doubles as the scheduler,
// which is what makes a fully fake clock/scheduler possible in tests.
export function resolveClock(clock) {
  if (clock === undefined || clock === null) return { now: () => Date.now(), scheduler: null };
  if (typeof clock === "function") return { now: () => toMillis(clock()), scheduler: null };
  if (typeof clock.now !== "function") throw new TypeError("clock must be a function or expose now()");
  return { now: () => toMillis(clock.now()), scheduler: clock };
}

export function resolveScheduler(scheduler, fallback) {
  const candidate = scheduler ?? fallback;
  if (candidate === null || candidate === undefined) return createRealScheduler();
  for (const name of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"]) {
    if (typeof candidate[name] !== "function") throw new TypeError(`scheduler.${name} must be a function`);
  }
  return candidate;
}

export function floorSeconds(value, floor, fallback) {
  const number = Number(value);
  return Math.max(floor, Number.isFinite(number) ? Math.trunc(number) : fallback);
}

// Mirrors `git.js:103-107` (W0-D §7): a leading dash or a character outside the
// allowed set is rejected before any git command runs.
export function validateRemoteOrBranch(value, label) {
  if (!value) return value;
  if (value.startsWith("-") || !REF_PATTERN.test(value)) {
    throw new GitRuntimeError(GIT_RUNTIME_CODES.INVALID_REF, `Invalid Git ${label}`);
  }
  return value;
}

export function tryRef(value, label) {
  try {
    return validateRemoteOrBranch(value, label) || null;
  } catch {
    return null;
  }
}

export function normalizeAuthor(author) {
  const agent = author?.agent;
  const model = author?.model;
  for (const [label, value] of [["agent", agent], ["model", model]]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new GitRuntimeError(GIT_RUNTIME_CODES.AUTHOR_REQUIRED, `Git mutation author ${label} is required`);
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new GitRuntimeError(GIT_RUNTIME_CODES.AUTHOR_REQUIRED, `Git mutation author ${label} must be control-character free`);
    }
  }
  return Object.freeze({ agent, model });
}
