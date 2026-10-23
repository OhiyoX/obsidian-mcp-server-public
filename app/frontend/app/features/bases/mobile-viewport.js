// Visual-viewport observation for the mobile Base chrome (issue #337 Cut 2).
//
// A fixed, full-width overlay has to fit the *visual* viewport, not the layout
// viewport: when the soft keyboard opens (or the page is pinch-zoomed) the visual
// viewport shrinks and iOS pans it, while `100vh`/`100dvh` keep the old size — an
// overlay sized from those would sit under the keyboard. This module publishes the
// live band as two CSS custom properties on a target element and the `<=480px`
// stylesheet consumes them:
//
//   --base-visual-viewport-height     `.base-panel` max/min height, backdrop height
//   --base-visual-viewport-offset-top `.base-panel` top (the iOS keyboard pan)
//
// It is a pure observer: no state, no persistence, no network, no layout writes
// beyond those two custom properties. Without `window.visualViewport` it degrades
// to the layout viewport (`innerHeight`), which is exactly the previous `100dvh`
// behaviour, so the panel still opens — it just cannot follow a keyboard panel.
//
// No HTML sinks: everything goes through setProperty (surface contract WB-10).

export const BASE_VISUAL_VIEWPORT_HEIGHT = "--base-visual-viewport-height";
export const BASE_VISUAL_VIEWPORT_OFFSET_TOP = "--base-visual-viewport-offset-top";

// Anything below this is not a usable band (a hidden or not-yet-laid-out page).
const MIN_VIEWPORT_HEIGHT_PX = 1;

// The band a fixed overlay must fit in, in viewport coordinates: `[offsetTop,
// offsetTop + height]`. Returns `null` when there is nothing trustworthy to measure.
export function readVisualViewport(win) {
  if (!win || typeof win !== "object") return null;
  const viewport = win.visualViewport ?? null;
  const reportedHeight = viewport && Number.isFinite(viewport.height) ? viewport.height : Number(win.innerHeight);
  if (!Number.isFinite(reportedHeight) || reportedHeight < MIN_VIEWPORT_HEIGHT_PX) return null;
  const fromVisualViewport = Boolean(viewport) && Number.isFinite(viewport.height);
  const reportedOffset = viewport && Number.isFinite(viewport.offsetTop) ? viewport.offsetTop : 0;
  return {
    height: reportedHeight,
    offsetTop: Number.isFinite(reportedOffset) && reportedOffset > 0 ? reportedOffset : 0,
    // The label names where the value really came from: a `visualViewport` without a
    // usable height is not the source, the layout viewport is.
    source: fromVisualViewport ? "visualViewport" : "innerHeight",
  };
}

export function applyVisualViewport(element, metrics) {
  if (!metrics || typeof element?.style?.setProperty !== "function") return false;
  element.style.setProperty(BASE_VISUAL_VIEWPORT_HEIGHT, `${Math.round(metrics.height)}px`);
  element.style.setProperty(BASE_VISUAL_VIEWPORT_OFFSET_TOP, `${Math.round(metrics.offsetTop)}px`);
  return true;
}

// Observes `win` and republishes on every visual-viewport resize/scroll (and on a
// layout-viewport resize, which is both the fallback signal and the rotation that
// flips the `<=480px` stylesheet). `resolveTarget` is re-read on every update
// because the Base toolbar rebuilds its subtree on each render.
//
// `sync({ force: true })` re-applies the current metrics to the current target —
// the toolbar calls it right after a render, when the previous target is gone.
export function createVisualViewportObserver({ win = null, resolveTarget = () => null, onChange = null } = {}) {
  const viewport = win?.visualViewport ?? null;
  const source = viewport ?? win ?? null;
  let attached = false;
  let lastKey = null;

  const metricsKey = (metrics) => `${Math.round(metrics.height)}:${Math.round(metrics.offsetTop)}`;

  function sync({ force = false } = {}) {
    const metrics = readVisualViewport(win);
    if (!metrics) return null;
    const key = metricsKey(metrics);
    if (!force && key === lastKey) return metrics;
    lastKey = key;
    const target = typeof resolveTarget === "function" ? resolveTarget() : null;
    applyVisualViewport(target, metrics);
    onChange?.(metrics, target);
    return metrics;
  }

  // A listener may be called with a non-event (tests call `sync()` directly), so the
  // destructured argument only ever contributes `force` when it is really a flag.
  function onViewportEvent() {
    sync();
  }

  function attach() {
    if (attached || typeof source?.addEventListener !== "function") return false;
    attached = true;
    source.addEventListener("resize", onViewportEvent);
    source.addEventListener("scroll", onViewportEvent);
    return true;
  }

  function destroy() {
    if (!attached) return;
    attached = false;
    source?.removeEventListener?.("resize", onViewportEvent);
    source?.removeEventListener?.("scroll", onViewportEvent);
    lastKey = null;
  }

  return { sync, attach, destroy, isAttached: () => attached, source: () => source };
}
