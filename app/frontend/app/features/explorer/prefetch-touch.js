// Issue #337 Cut 1 — Explorer touch-prefetch intent policy (pure module).
//
// Parallel to `prefetch.js` (the frozen hover policy of issue #284) and deliberately
// separate from it: the hover path is not touched, and a hover-capable desktop can never
// enter this policy (capability gate below). This module owns the whole touch gesture
// state machine — the 100 ms intent window, the 10 px slop, the 250 ms post-release grace,
// the per-pointer bookkeeping, the cumulative rate limit and `dispose()` — and it never
// touches the DOM, never fetches and never reads the lazy model. The renderer binds real
// pointer events and calls these handlers; the controller stays the only request owner
// (I337-E01: touch intent only ever calls the existing `prefetch` / `cancelPrefetch`).
//
// Intent semantics (contract: `scratch/web-bases/U20/DESIGN-RESPONSE.md` §Cut 1 + the
// issues #337 explorer contract; frozen constants below are UX/resource parameters, not
// protocol constants):
//
// - `pointerdown` on a folder row *arms* a window; only when the primary touch/pen pointer
//   is still down after `TOUCH_PREFETCH_INTENT_DELAY_MS` and has moved at most
//   `TOUCH_PREFETCH_SLOP_PX` does the speculative `prefetch(parent)` leave (D337-02/K1);
// - a pointer that never reaches the window — released inside it (`pointerup`), cancelled
//   (`pointercancel`), left (`pointerleave`) or moved past the slop — issues nothing, so a
//   fast tap still pays exactly the one formal request its click owns, and a scroll gesture
//   pays none (K2/K3/K5);
// - after the window, `pointerup` starts `TOUCH_PREFETCH_COMMIT_GRACE_MS`: a tap promotes
//   the speculative owner through the normal click path (no cancel, the controller
//   transfers ownership, I08) and only an unredeemed release calls `cancelPrefetch`,
//   which the controller honours only while that owner is still speculative (I04/I337-E04);
// - the budget is not owned here: over-budget intents are dropped by the controller's
//   speculative bookkeeping exactly as for hover (`PREFETCH_CONCURRENCY_LIMIT`, K4);
// - every active gesture is keyed by its own `pointerId`, so a second finger can arm a
//   second row while the first is still held; mouse pointers, secondary pointers, non-string
//   parents and (fail-closed) anything without a touch/pen `pointerType` are ignored;
// - `mode === "off"` disables this policy together with hover (D337-04) and the preference
//   schema is unchanged — the same storage key is read through the frozen hover module;
// - after `dispose()` no timer survives and no handler ever calls the controller again.
import {
  isExplorerPrefetchMode,
  readExplorerPrefetchPreference,
} from "./prefetch.js";

// Cut 1 §2/§3 (U20) froze the 100 ms intent window; the #337 explorer contract froze the
// slop and the commit grace. Keep them here as the single definition (I337-E03).
export const TOUCH_PREFETCH_INTENT_DELAY_MS = 100;
export const TOUCH_PREFETCH_SLOP_PX = 10;
export const TOUCH_PREFETCH_COMMIT_GRACE_MS = 250;
// U20 §Q2 "Cost Controls": a metered-connection ceiling in addition to the concurrency
// budget — at most `MAX` speculative touch issues per `WINDOW`, then a `COOLDOWN` in which
// only the formal click path works. Session-scoped, never persisted.
export const TOUCH_PREFETCH_RATE_LIMIT_MAX = 20;
export const TOUCH_PREFETCH_RATE_LIMIT_WINDOW_MS = 60_000;
export const TOUCH_PREFETCH_RATE_LIMIT_COOLDOWN_MS = 120_000;
export const COARSE_POINTER_MEDIA_QUERY = "(pointer: coarse)";
export const NO_HOVER_MEDIA_QUERY = "(hover: none)";
// U20 §Cut 1: Pointer Events only — the legacy touch compatibility event family must never
export const TOUCH_PREFETCH_POINTER_TYPES = Object.freeze(["touch", "pen"]);

// One capability question ("is this a touch-first device?") answered once, matching the
// U20 §Cut 1 detection: `(hover: none)` OR `(pointer: coarse)`. A missing or throwing
// `matchMedia` means "not touch-capable" (fail closed, same posture as the hover policy).
export function resolveTouchCapability(scope = globalThis) {
  try {
    const matchMedia = scope?.matchMedia;
    if (typeof matchMedia !== "function") return false;
    const coarse = Boolean(matchMedia.call(scope, COARSE_POINTER_MEDIA_QUERY)?.matches);
    const noHover = Boolean(matchMedia.call(scope, NO_HOVER_MEDIA_QUERY)?.matches);
    return coarse || noHover;
  } catch {
    return false;
  }
}

function detectTouchCapability(touchCapable, coarsePointer, noHover, matchMedia) {
  if (typeof touchCapable === "boolean") return touchCapable;
  if (typeof coarsePointer === "boolean" || typeof noHover === "boolean") {
    return coarsePointer === true || noHover === true;
  }
  if (typeof matchMedia === "function") {
    try {
      return Boolean(matchMedia(COARSE_POINTER_MEDIA_QUERY)?.matches)
        || Boolean(matchMedia(NO_HOVER_MEDIA_QUERY)?.matches);
    } catch {
      return false;
    }
  }
  return resolveTouchCapability();
}

function normalizeMs(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isControllerLike(controller) {
  return Boolean(controller)
    && typeof controller.prefetch === "function"
    && typeof controller.cancelPrefetch === "function";
}

// A gesture only exists for a primary touch/pen pointer on a real string parent. A bare
// `Event` (no `pointerType`) is not a Pointer Event, so it is ignored instead of guessed.
export function pointerIdOf(event) {
  const id = event?.pointerId;
  return typeof id === "number" || typeof id === "string" ? id : null;
}

export function isTouchPrefetchPointer(event) {
  if (event?.isPrimary === false) return false;
  return TOUCH_PREFETCH_POINTER_TYPES.includes(event?.pointerType);
}

// I337-E03: exactly one slop definition, Euclidean. A coordinate-less event (not a real
// pointer move) cannot prove travel, so it never cancels on its own.
export function exceedsTouchSlop(entry, event, slopPx = TOUCH_PREFETCH_SLOP_PX) {
  const x = event?.clientX;
  const y = event?.clientY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.hypot(x - entry.x, y - entry.y) > slopPx;
}

export function createExplorerTouchPrefetchIntent({
  controller,
  mode,
  storage,
  delayMs = TOUCH_PREFETCH_INTENT_DELAY_MS,
  slopPx = TOUCH_PREFETCH_SLOP_PX,
  graceMs = TOUCH_PREFETCH_COMMIT_GRACE_MS,
  touchCapable,
  coarsePointer,
  noHover,
  matchMedia,
  rateLimitMax = TOUCH_PREFETCH_RATE_LIMIT_MAX,
  rateLimitWindowMs = TOUCH_PREFETCH_RATE_LIMIT_WINDOW_MS,
  rateLimitCooldownMs = TOUCH_PREFETCH_RATE_LIMIT_COOLDOWN_MS,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = (id) => clearTimeout(id),
  debug,
} = {}) {
  if (!isControllerLike(controller)) {
    throw new Error("createExplorerTouchPrefetchIntent requires a controller with prefetch() and cancelPrefetch()");
  }

  // `mode` wins when supplied; otherwise the browser-global preference read by the frozen
  // hover module is reused, because #337 keeps one preference for speculative prefetch.
  const resolvedMode = isExplorerPrefetchMode(mode) ? mode : readExplorerPrefetchPreference(storage);
  const enabled = resolvedMode !== "off"
    && detectTouchCapability(touchCapable, coarsePointer, noHover, matchMedia);
  const delay = normalizeMs(delayMs, TOUCH_PREFETCH_INTENT_DELAY_MS);
  const slop = normalizeMs(slopPx, TOUCH_PREFETCH_SLOP_PX);
  const grace = normalizeMs(graceMs, TOUCH_PREFETCH_COMMIT_GRACE_MS);

  const pointers = new Map(); // pointerId -> { parent, x, y, phase, timer }
  const issued = []; // issue timestamps for the current rate-limit window
  let blockedUntil = 0;
  let disposed = false;

  const log = (payload) => {
    if (typeof debug !== "function") return;
    try {
      debug(payload);
    } catch {
      // Telemetry must never break the gesture path.
    }
  };

  function clearTimer(entry) {
    if (entry.timer === null) return;
    unschedule(entry.timer);
    entry.timer = null;
  }

  // Session-scoped ceiling (U20 §Q2): returns true when this issue must not happen. When the
  // window is exhausted the policy enters a cooldown and then resets, so a metered user is
  // never permanently without prefetch — only the explicit click keeps working throughout.
  function rateLimited(at) {
    if (at < blockedUntil) return true;
    if (blockedUntil !== 0) {
      blockedUntil = 0;
      issued.length = 0;
    }
    while (issued.length && at - issued[0] >= rateLimitWindowMs) issued.shift();
    if (issued.length < rateLimitMax) return false;
    blockedUntil = at + rateLimitCooldownMs;
    issued.length = 0;
    log({ event: "rate-limit-triggered", max: rateLimitMax, windowMs: rateLimitWindowMs, cooldownMs: rateLimitCooldownMs });
    return true;
  }

  function issue(pointerId) {
    const entry = pointers.get(pointerId);
    if (!entry || entry.phase !== "armed") return;
    clearTimer(entry);
    if (rateLimited(now())) {
      pointers.delete(pointerId);
      log({ event: "rate-limited", parent: entry.parent });
      return;
    }
    entry.phase = "issued";
    issued.push(now());
    log({ event: "prefetch-issued", parent: entry.parent, delayMs: delay });
    controller.prefetch(entry.parent);
  }

  function expireGrace(pointerId) {
    const entry = pointers.get(pointerId);
    if (!entry || entry.phase !== "grace") return;
    clearTimer(entry);
    pointers.delete(pointerId);
    log({ event: "grace-expired", parent: entry.parent, graceMs: grace });
    // Owner-safe: a tap that already promoted this parent is a no-op here (I04/I337-E04).
    controller.cancelPrefetch(entry.parent);
  }

  // The single cancel path for a gesture that is still "live" in the sense that the user has
  // not released it: nothing was issued => no request, nothing to cancel.
  function cancel(pointerId, reason) {
    const entry = pointers.get(pointerId);
    if (!entry) return;
    const wasIssued = entry.phase !== "armed";
    clearTimer(entry);
    pointers.delete(pointerId);
    log({ event: `cancel:${reason}`, parent: entry.parent, issued: wasIssued });
    if (wasIssued) controller.cancelPrefetch(entry.parent);
  }

  function trackable(parent, event) {
    if (disposed || !enabled) return null;
    if (typeof parent !== "string" || parent === "") return null;
    if (!isTouchPrefetchPointer(event)) return null;
    const pointerId = pointerIdOf(event);
    return pointerId === null ? null : { pointerId, parent };
  }

  function pointerdown(parent, event) {
    const start = trackable(parent, event);
    if (!start) return;
    // One gesture per pointerId: a repeat pointerdown neither restarts the window nor arms
    // a second one, and a later `pointerup` cannot leak into another gesture.
    if (pointers.has(start.pointerId)) return;
    const entry = {
      parent: start.parent,
      x: Number.isFinite(event?.clientX) ? event.clientX : 0,
      y: Number.isFinite(event?.clientY) ? event.clientY : 0,
      // The gesture's own row is the identity that `pointerleave` is compared against; a
      // retargeted event from another row must not end this gesture.
      phase: "armed",
      timer: null,
    };
    pointers.set(start.pointerId, entry);
    entry.timer = schedule(() => issue(start.pointerId), delay);
  }

  function pointermove(parent, event) {
    if (disposed) return;
    const pointerId = pointerIdOf(event);
    if (pointerId === null) return;
    const entry = pointers.get(pointerId);
    if (!entry) return;
    // While the pointer is down, travel past the slop is a scroll intent. After the release
    // the gesture is already spent: only the commit grace decides (I337-E04).
    if (entry.phase === "grace") return;
    if (exceedsTouchSlop(entry, event, slop)) cancel(pointerId, "move");
  }

  function pointerup(parent, event) {
    if (disposed) return;
    const pointerId = pointerIdOf(event);
    if (pointerId === null) return;
    const entry = pointers.get(pointerId);
    if (!entry) return;
    if (entry.phase === "armed") {
      // Released inside the intent window: nothing was issued, nothing is cancelled. The
      // click (if this is a tap) owns the formal request.
      clearTimer(entry);
      pointers.delete(pointerId);
      log({ event: "released-inside-window", parent: entry.parent, delayMs: delay });
      return;
    }
    if (entry.phase !== "issued") return; // a repeated pointerup must not add a second timer
    entry.phase = "grace";
    entry.timer = schedule(() => expireGrace(pointerId), grace);
  }

  function pointercancel(parent, event) {
    if (disposed) return;
    const pointerId = pointerIdOf(event);
    if (pointerId === null) return;
    cancel(pointerId, "pointercancel");
  }

  function pointerleave(parent, event) {
    if (disposed) return;
    const pointerId = pointerIdOf(event);
    if (pointerId === null) return;
    const entry = pointers.get(pointerId);
    if (!entry) return;
    if (typeof parent === "string" && parent !== entry.parent) return;
    // A touch pointer is released before the browser reports it as leaving the row
    // (`pointerup` -> `pointerout`/`pointerleave` -> `click`), so a leave that arrives during
    // the commit grace is the tail of a completed tap, not an abandonment: the click still
    // owns the promotion and cancelling here would abort a request that is about to be
    // promoted and force a duplicate (I08). Only a leave while the finger is still down is a
    // real cancel.
    if (entry.phase === "grace") return;
    cancel(pointerId, "pointerleave");
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of pointers.values()) clearTimer(entry);
    pointers.clear();
    // `controller.dispose()` owns the request side; this instance only stops arming.
  }

  return {
    pointerdown,
    pointermove,
    pointerup,
    pointercancel,
    pointerleave,
    dispose,
    enabled: () => enabled,
  };
}
