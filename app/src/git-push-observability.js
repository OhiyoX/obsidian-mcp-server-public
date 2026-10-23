/**
 * Push-outcome observability for the Git integration (issue #255).
 *
 * `GIT_AUTO_PUSH=true` used to fail silently: the commit landed, the push did not, and
 * neither the container log nor `git_status` said anything. This module keeps the last
 * outcome in memory so `git_status` can report it, classifies the failure, and renders a
 * credential-free summary because git echoes the remote URL (which may embed a token) in
 * its error output.
 *
 * Wave B / B4: the process-global `lastOutcome` / `consecutiveFailures` singleton is gone
 * (contract §16, §44 item 8). The state now lives in a per-instance history created by
 * `createPushHistory()` and owned by exactly one `GitRuntime`, so a push in vault A can never
 * move vault B's `git_status` or its failure count. The three stateless helpers below are
 * unchanged (#255 contract). `pushObservability()` / `resetPushObservability()` /
 * `recordPushOutcome()` remain as a compatibility bridge onto whichever history the process
 * bound with `bindPushHistory()` (`src/git.js` binds the primary runtime); unbound they answer
 * the empty snapshot, so an un-migrated caller never sees another vault's outcome.
 */

const MAX_SUMMARY_CHARS = 400;

function clip(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > MAX_SUMMARY_CHARS ? `${value.slice(0, MAX_SUMMARY_CHARS)}…` : value;
}

/** Strip anything credential-shaped: URL userinfo, Authorization headers, common tokens. */
export function scrubCredentials(value) {
  return clip(
    String(value ?? "")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
      .replace(/(authorization:\s*)\S+(\s+\S+)?/gi, "$1***")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g, "***")
      .replace(/\b(pass(?:word)?|token|secret)=[^\s&"']+/gi, "$1=***"),
  );
}

/**
 * Bucket a failing `git push` so an operator can tell the classes apart without shelling
 * into the container: unreachable remote, missing/rejected credentials, a remote that
 * refuses the update because it is ahead, or a branch whose upstream was never set.
 */
export function classifyPushFailure({ exitCode = null, stderr = "", stdout = "" } = {}) {
  const text = `${stderr}\n${stdout}`;
  if (/non-fast-forward|fetch first|\(fetch first\)/i.test(text)) return "non-fast-forward";
  if (/no upstream branch|has no upstream/i.test(text)) return "no-upstream";
  if (/permission denied|could not read username|could not read password|authentication failed|terminal prompts disabled|invalid username or password|401 unauthorized|403 forbidden/i.test(text)) return "auth";
  if (/could not resolve host|no route to host|network is unreachable|connection refused|connection timed out|operation timed out|unable to access|does not appear to be a git repository|repository not found/i.test(text)) return "unreachable";
  if (/\[rejected\]|pre-receive hook declined|hook declined|protected branch/i.test(text)) return "rejected";
  return exitCode === 0 ? "none" : "unknown";
}

/**
 * One push history. Every `GitRuntime` owns its own (contract §16): `record()` stamps the
 * runtime's clock, `snapshot()` is the `git_status` shape, `reset()` is the test hook.
 */
export function createPushHistory({ now = () => Date.now() } = {}) {
  const state = { lastOutcome: null, consecutiveFailures: 0 };
  return Object.freeze({
    record(outcome) {
      const entry = { at: new Date(now()).toISOString(), ...outcome };
      state.consecutiveFailures = entry.pushed ? 0 : state.consecutiveFailures + 1;
      entry.consecutiveFailures = state.consecutiveFailures;
      state.lastOutcome = entry;
      return entry;
    },
    snapshot() {
      return {
        lastOutcome: state.lastOutcome ? { ...state.lastOutcome } : null,
        consecutiveFailures: state.consecutiveFailures,
      };
    },
    failures() {
      return state.consecutiveFailures;
    },
    reset() {
      state.lastOutcome = null;
      state.consecutiveFailures = 0;
    },
  });
}

const EMPTY_SNAPSHOT = Object.freeze({ lastOutcome: null, consecutiveFailures: 0 });
// Compatibility pointer only: it references the owning runtime's history and holds no push
// state of its own. Production state is per `GitRuntime` (contract §16).
let boundHistory = null;

/** Point the legacy names at one runtime history; returns an unbind function. */
export function bindPushHistory(history) {
  boundHistory = history;
  return () => {
    if (boundHistory === history) boundHistory = null;
  };
}

/** `git_status`/legacy snapshot: the bound runtime's history, or the empty snapshot. */
export function pushObservability() {
  return boundHistory ? boundHistory.snapshot() : EMPTY_SNAPSHOT;
}

/** Legacy recorder. Production records through the runtime's own history; returns `null` unbound. */
export function recordPushOutcome(outcome) {
  return boundHistory ? boundHistory.record(outcome) : null;
}

/** Test hook: forget the recorded outcome so cases are independent. */
export function resetPushObservability() {
  boundHistory?.reset();
}

export function formatPushFailureLog(outcome) {
  const branch = outcome.branch ? ` branch=${outcome.branch}` : "";
  const exit = outcome.exitCode === null || outcome.exitCode === undefined ? "n/a" : outcome.exitCode;
  return `Git push failed [${outcome.failureClass}] remote=${outcome.remote}${branch} exit=${exit} consecutive=${outcome.consecutiveFailures}: ${outcome.summary}`;
}
