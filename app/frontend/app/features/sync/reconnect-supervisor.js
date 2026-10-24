// Reconnect supervisor for the Web app (Phase B: reconnect state + session probe).
//
// Self-contained and wiring-free on purpose: it never touches the global
// environment. The host page owns the listeners and forwards browser events
// through the documented `reportOnline` / `reportOffline` / `reportVisible`
// hooks, because the architecture check keeps global side effects out of
// feature modules. `createReconnectSupervisor` only reasons about probes and
// timers, while `createReconnectHint` renders a light, non-blocking status hint.
//
// The supervisor decides four phases from a same-origin session probe:
//   200 / 403 -> online          (session valid; 403 is an authorization issue)
//   401       -> session-expired (emit once, never auto-navigate or reload)
//   other/0   -> offline         (network failure, timeout, 5xx, proxy error)
//
// It never retries a confirmed `401`; only an explicit `probeNow()` (for
// example from `reportVisible`) can recover a session-expired state.

const PHASE = Object.freeze({
  ONLINE: "online",
  OFFLINE: "offline",
  RECONNECTING: "reconnecting",
  SESSION_EXPIRED: "session-expired",
});

const SESSION_PROBE_PATH = "/api/web/v1/session";

const DEFAULT_TIMERS = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (id) => clearTimeout(id),
};

function toNonNegativeNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeProbeStatus(result) {
  if (typeof result === "number" && Number.isFinite(result)) return result;
  if (result && typeof result === "object" && typeof result.status === "number" && Number.isFinite(result.status)) {
    return result.status;
  }
  return 0;
}

function createDefaultProbe({ fetchImpl, timers, probeTimeoutMs }) {
  return async function probeWebSession() {
    const fetchFn = typeof fetchImpl === "function"
      ? fetchImpl
      : typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null;
    if (!fetchFn) return { status: 0 };
    let timeoutId = null;
    try {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      if (controller) timeoutId = timers.setTimeout(() => controller.abort(), probeTimeoutMs);
      const response = await fetchFn(SESSION_PROBE_PATH, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal: controller ? controller.signal : undefined,
      });
      return { status: response.status };
    } catch {
      // Network error, abort/timeout or a proxy that never answered: the
      // service is unavailable, which is not an authentication failure.
      return { status: 0 };
    } finally {
      if (timeoutId !== null) timers.clearTimeout(timeoutId);
    }
  };
}

export function createReconnectSupervisor(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timers = options.timers || DEFAULT_TIMERS;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const baseDelayMs = toNonNegativeNumber(options.baseDelayMs, 1_000);
  const maxDelayMs = Math.max(baseDelayMs, toNonNegativeNumber(options.maxDelayMs, 30_000));
  const watchdogMs = toNonNegativeNumber(options.watchdogMs, 60_000);
  const probeTimeoutMs = toNonNegativeNumber(options.probeTimeoutMs, 8_000);
  const probe = typeof options.probe === "function"
    ? options.probe
    : createDefaultProbe({ fetchImpl: options.fetch, timers, probeTimeoutMs });

  let phase = PHASE.RECONNECTING;
  let since = now();
  let attempts = 0;
  let lastProbeAt = null;
  let started = false;
  let stopped = false;
  let browserOffline = false;
  let probeInFlight = null;
  let backoffTimer = null;
  let watchdogTimer = null;
  const listeners = new Set();

  function snapshot() {
    return { phase, since, attempts, lastProbeAt };
  }

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break probe handling.
      }
    }
  }

  function setPhase(next) {
    if (phase === next) return false;
    const previousPhase = phase;
    phase = next;
    since = now();
    emit({ type: "state", phase: next, previousPhase, state: snapshot() });
    return true;
  }

  function clearBackoff() {
    if (backoffTimer !== null) {
      timers.clearTimeout(backoffTimer);
      backoffTimer = null;
    }
  }

  function clearWatchdog() {
    if (watchdogTimer !== null) {
      timers.clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function backoffDelay() {
    const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempts - 1));
    // Jitter keeps concurrent tabs from retrying in lockstep. The randomized
    // delay stays in (50%, 100%] of the capped delay, so the cap is honored.
    return Math.max(1, Math.round(capped * (0.5 + random() * 0.5)));
  }

  function scheduleBackoff() {
    clearBackoff();
    if (stopped || browserOffline) return;
    backoffTimer = timers.setTimeout(() => {
      backoffTimer = null;
      probeNow();
    }, backoffDelay());
  }

  function scheduleWatchdog() {
    clearWatchdog();
    if (stopped) return;
    watchdogTimer = timers.setTimeout(() => {
      watchdogTimer = null;
      if (stopped || phase !== PHASE.ONLINE) return;
      probeNow();
    }, watchdogMs);
  }

  function applyProbeStatus(status) {
    lastProbeAt = now();

    if (status === 401) {
      clearBackoff();
      clearWatchdog();
      const changed = setPhase(PHASE.SESSION_EXPIRED);
      if (changed) emit({ type: "session-expired", state: snapshot() });
      return;
    }

    if (status === 200 || status === 403) {
      attempts = 0;
      clearBackoff();
      const changed = setPhase(PHASE.ONLINE);
      scheduleWatchdog();
      if (changed) emit({ type: "recovered", state: snapshot() });
      return;
    }

    attempts += 1;
    clearWatchdog();
    setPhase(PHASE.OFFLINE);
    scheduleBackoff();
  }

  function probeNow() {
    if (stopped) return Promise.resolve({ status: null, state: snapshot() });
    if (probeInFlight) return probeInFlight;
    clearBackoff();
    probeInFlight = (async () => {
      let status = 0;
      try {
        status = normalizeProbeStatus(await probe());
      } catch {
        status = 0;
      }
      probeInFlight = null;
      if (stopped) return { status, state: snapshot() };
      applyProbeStatus(status);
      return { status, state: snapshot() };
    })();
    return probeInFlight;
  }

  function start() {
    if (stopped || started) return;
    started = true;
    if (!browserOffline) probeNow();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearBackoff();
    clearWatchdog();
    probeInFlight = null;
    listeners.clear();
  }

  function reportOnline() {
    if (stopped) return;
    browserOffline = false;
    if (phase === PHASE.SESSION_EXPIRED) return;
    attempts = 0;
    if (phase !== PHASE.ONLINE) setPhase(PHASE.RECONNECTING);
    probeNow();
  }

  function reportOffline() {
    browserOffline = true;
    clearBackoff();
    clearWatchdog();
    if (stopped) return;
    if (phase !== PHASE.SESSION_EXPIRED) setPhase(PHASE.OFFLINE);
  }

  function reportVisible() {
    if (stopped || browserOffline) return;
    probeNow();
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("subscribe requires a listener function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    start,
    stop,
    getState: snapshot,
    subscribe,
    reportOnline,
    reportOffline,
    reportVisible,
    probeNow,
  };
}

// Reuses the existing live-status / toast tokens; no new stylesheet entries are
// introduced by this slice, so offline and session-expired intentionally share
// the neutral dot token until a dedicated one lands in the Web stylesheet.
const HINT_LABELS = Object.freeze({
  reconnecting: "正在恢复连接…",
  offline: "网络已断开，正在自动恢复",
  "session-expired": "登录已失效，请重新登录",
});

const HINT_DOT_STATES = Object.freeze({
  online: "live",
  reconnecting: "reconnecting",
  offline: "paused",
  "session-expired": "paused",
});

export function createReconnectHint({
  host,
  supervisor,
  document: doc = globalThis.document,
  labels = HINT_LABELS,
} = {}) {
  if (!host || typeof host.appendChild !== "function") {
    throw new TypeError("createReconnectHint requires a host element");
  }
  if (!doc || typeof doc.createElement !== "function") {
    throw new TypeError("createReconnectHint requires a document-like object");
  }

  const element = doc.createElement("div");
  element.className = "reconnect-hint";
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.hidden = true;

  const dot = doc.createElement("span");
  dot.className = "live-status";
  dot.setAttribute("aria-hidden", "true");

  const label = doc.createElement("span");
  label.className = "live-status-label";

  element.appendChild(dot);
  element.appendChild(label);
  host.appendChild(element);

  function update(state) {
    const phase = state && typeof state.phase === "string" ? state.phase : PHASE.ONLINE;
    const text = labels[phase] || "";
    element.setAttribute("data-phase", phase);
    dot.setAttribute("data-state", HINT_DOT_STATES[phase] || "paused");
    label.textContent = text;
    const hidden = phase === PHASE.ONLINE || text === "";
    element.hidden = hidden;
    if (hidden) element.setAttribute("aria-hidden", "true");
    else element.removeAttribute("aria-hidden");
  }

  let unsubscribe = null;
  if (supervisor && typeof supervisor.subscribe === "function") {
    unsubscribe = supervisor.subscribe((event) => update(event && event.state));
    if (typeof supervisor.getState === "function") update(supervisor.getState());
  }

  function destroy() {
    if (typeof unsubscribe === "function") {
      unsubscribe();
      unsubscribe = null;
    }
    if (element.parentNode && typeof element.parentNode.removeChild === "function") {
      element.parentNode.removeChild(element);
    }
  }

  return { element, update, destroy };
}
