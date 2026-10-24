// Issue #284 Wave A1 — Explorer hover-prefetch intent policy (pure module).
//
// Scope is deliberately narrow (contract §7): the 150 ms hover intent timer, the
// `(hover: hover)` capability check, the parent -> timer map, the pointerenter /
// pointerleave handlers, the preference read, and `dispose()`. The renderer binds
// the events and calls these handlers; this module never touches the DOM, never
// fetches, and never reads or writes the lazy model.
//
// The controller is a duck-typed dependency (`{ prefetch, cancelPrefetch }`, the
// frozen API of contract §6); Wave B1 implements the controller side. Everything
// ambient — clock, storage, matchMedia — is injectable so the policy is testable
// with a fake clock and no `sleep`.
//
// Intent semantics:
// - the window starts on the first `pointerenter` and is never restarted while the
//   pointer stays on the same parent (repeat enter must not extend or re-issue);
// - a parent is issued at most once per continuous hover; `pointerleave` after the
//   issue clears that state so a later hover may issue again;
// - `pointerleave` before the timer fires cancels silently (no `prefetch` call) and
//   never calls `cancelPrefetch`, because nothing was issued;
// - `pointerleave` after the issue calls `cancelPrefetch(parent)` exactly once; the
//   controller then decides whether the request is still owned by the prefetch
//   (owner-safe cancel, §5 P284-I04);
// - non-string parents are ignored, `hover: none` devices and `off` preference are
//   fail-closed no-ops (P284-I10);
// - `dispose()` clears every pending timer and permanently stops this instance;
//   after dispose the module never calls `prefetch` or `cancelPrefetch` again —
//   `controller.dispose()` owns cancellation (contract §0.6).

export const EXPLORER_PREFETCH_STORAGE_KEY = "obsidian.web.explorer.prefetch.v1";
export const EXPLORER_PREFETCH_MODES = Object.freeze(["hover", "off"]);
export const DEFAULT_EXPLORER_PREFETCH_MODE = "hover";
// First-slice UX/resource parameter frozen by contract §0.3, not a protocol constant.
export const PREFETCH_INTENT_DELAY_MS = 150;
export const HOVER_MEDIA_QUERY = "(hover: hover)";

export function isExplorerPrefetchMode(value) {
  return typeof value === "string" && EXPLORER_PREFETCH_MODES.includes(value);
}

// The stored value is a bare mode string. Absent, unknown, or malformed values
// fall back to the opt-out default `hover`; there is no "disabled by garbage"
// state that could silently turn prefetch off.
export function parseExplorerPrefetch(raw) {
  return isExplorerPrefetchMode(raw) ? raw : DEFAULT_EXPLORER_PREFETCH_MODE;
}

// Accessing `localStorage` itself can throw (blocked storage), so the lookup is
// guarded separately from getItem.
export function resolveExplorerPrefetchStorage(scope = globalThis) {
  try {
    return scope?.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readExplorerPrefetchPreference(storage = resolveExplorerPrefetchStorage()) {
  if (!storage || typeof storage.getItem !== "function") return DEFAULT_EXPLORER_PREFETCH_MODE;
  try {
    return parseExplorerPrefetch(storage.getItem(EXPLORER_PREFETCH_STORAGE_KEY));
  } catch {
    return DEFAULT_EXPLORER_PREFETCH_MODE;
  }
}

// `matchMedia` is absent in tests/servers and can throw for exotic scopes; a
// missing or unreadable capability query means "not hover-capable" (fail closed).
export function resolveHoverCapability(scope = globalThis, query = HOVER_MEDIA_QUERY) {
  try {
    const matchMedia = scope?.matchMedia;
    if (typeof matchMedia !== "function") return false;
    return Boolean(matchMedia.call(scope, query)?.matches);
  } catch {
    return false;
  }
}

function detectHoverCapability(hoverCapable, matchMedia) {
  if (typeof hoverCapable === "boolean") return hoverCapable;
  if (typeof matchMedia === "function") {
    try {
      return Boolean(matchMedia(HOVER_MEDIA_QUERY)?.matches);
    } catch {
      return false;
    }
  }
  return resolveHoverCapability();
}

function normalizeDelay(delayMs) {
  return Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : PREFETCH_INTENT_DELAY_MS;
}

function isControllerLike(controller) {
  return Boolean(controller)
    && typeof controller.prefetch === "function"
    && typeof controller.cancelPrefetch === "function";
}

export function createExplorerPrefetchIntent({
  controller,
  mode,
  storage,
  delayMs = PREFETCH_INTENT_DELAY_MS,
  hoverCapable,
  matchMedia,
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = (id) => clearTimeout(id),
} = {}) {
  if (!isControllerLike(controller)) {
    throw new Error("createExplorerPrefetchIntent requires a controller with prefetch() and cancelPrefetch()");
  }

  // `mode` wins when supplied (explicit caller/test override); otherwise the
  // browser-global preference is read once. A preference change is applied by
  // rebuilding the instance, which is the renderer's call.
  const resolvedMode = isExplorerPrefetchMode(mode)
    ? mode
    : readExplorerPrefetchPreference(storage);
  const enabled = resolvedMode === "hover" && detectHoverCapability(hoverCapable, matchMedia);
  const delay = normalizeDelay(delayMs);

  const timers = new Map(); // parent -> injected timer id
  const issued = new Set(); // parents issued during the current continuous hover
  let disposed = false;

  // Only string parents exist in this tree; anything else is a caller bug and is
  // excluded rather than turned into an accidental shared key.
  function parentKey(parent) {
    return typeof parent === "string" ? parent : null;
  }

  function pointerenter(parent) {
    if (disposed || !enabled) return;
    const key = parentKey(parent);
    if (key === null) return;
    // Repeat enter on the same parent neither restarts the window nor issues twice.
    if (timers.has(key) || issued.has(key)) return;
    const timer = schedule(() => {
      timers.delete(key);
      if (disposed) return;
      issued.add(key);
      controller.prefetch(key);
    }, delay);
    timers.set(key, timer);
  }

  function pointerleave(parent) {
    if (disposed) return;
    const key = parentKey(parent);
    if (key === null) return;
    if (timers.has(key)) {
      // Left inside the intent window: no request was ever issued.
      unschedule(timers.get(key));
      timers.delete(key);
      return;
    }
    if (issued.has(key)) {
      issued.delete(key);
      controller.cancelPrefetch(key);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const timer of timers.values()) unschedule(timer);
    timers.clear();
    issued.clear();
  }

  return { pointerenter, pointerleave, dispose };
}
