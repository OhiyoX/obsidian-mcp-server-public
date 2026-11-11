// One readiness gate for every scene that spawns its own app server.
//
// The scenes each grew their own copy of this loop, and every copy had the same two defects:
//
//   * the budget was 15 s (150 × 100 ms) — this tree's fixture server needs ~18 s on a slow box, so
//     the loop ran out on a healthy server;
//   * running out was silent — the next request failed with `ECONNREFUSED` from a login helper,
//     which points at the wrong component (2026-11-05: that is how `web-regression.mjs` died).
//
// `admin-layout.mjs` already did it right (it asserts `ready`), so this module is that shape for
// everyone: a generous budget, and a failure that names the server, the elapsed time and whatever
// the child wrote to stderr.

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_MS = 100;
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Resolve when `${base}/healthz` answers ok; throw otherwise.
 *
 * `child` (optional) is the spawned server: a process that exits while we wait fails immediately
 * instead of burning the whole budget. `serverErrors` is the array the caller already collects
 * stderr into, so the thrown message carries the reason.
 */
export async function waitForHealthz({ base, child = null, serverErrors = [], timeoutMs = DEFAULT_TIMEOUT_MS, label = 'test server' } = {}) {
  const started = Date.now();
  const stderr = () => String(serverErrors.join('')).slice(0, 2000) || '(empty)';
  const deadline = started + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      // A server that accepts the socket and never answers must not stall the gate: undici waits
      // 300 s for headers by default, so each probe carries its own short timeout.
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (response.ok) return Date.now() - started;
      // A non-ok answer still opens a socket; cancel it so a long wait does not accumulate them.
      await response.body?.cancel();
    } catch { /* not listening yet, or this probe timed out */ }
    // A child killed by a signal has `signalCode` and a null `exitCode`; both mean "gone".
    if (child && (child.exitCode !== null || child.signalCode)) {
      throw new Error(`${label} exited (code ${child.exitCode ?? child.signalCode}) after ${Date.now() - started} ms; stderr: ${stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${label} never answered /healthz within about ${timeoutMs} ms (exitCode ${child ? child.exitCode : 'n/a'}); stderr: ${stderr()}`);
}
