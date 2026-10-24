// Observable surface readiness for the render-parity collectors (issue #414, part C).
//
// #414-C deferred `reader.js` / `editor.js`: the shell paints first and the reading /
// editing surface only materializes once its bundle has landed (`window.__obsidianWebAssets`
// + `features/*/deferred-*.js`). Every collector here switches surface and then measures
// immediately, which before this module meant measuring a host that had not rendered anything
// yet: the probes reported "not found" / "no element to measure" instead of a real paint
// difference (`render-parity-phase0.mjs` failed every Reader kind on the first theme).
//
// `waitForSurfaceReady` adds an observable, BOUNDED wait in front of the measurement:
//
//   * Reader — `window.renderObsidianMarkdown` exists AND `#preview` carries rendered text
//     AND, when the caller can name them, at least one expected fixture needle is present.
//     A needle can only reach the Reader DOM once the real renderer produced it, so one hit
//     proves the render landed (not just that the shell wrapper exists).
//   * Live — the captured `window.__testEditor._view` exists, `.cm-content` has rendered text
//     and the visible `.cm-scroller` is laid out. Live Preview renders only the viewport, so a
//     needle is NOT a readiness signal there (it would make the wait depend on scroll
//     position).
//   * Both — no CodeMirror measure/redraw is pending (`view.measureScheduled === -1`): the
//     editor is mid-settle right after a mount or a theme `<link>` reload and renders a
//     restricted window while it measures.
//
// The wait never moves the view: the collectors own their scroll positions, so readiness is
// only observed, never forced. It also does not cover the pre-existing Live viewport race in
// the Phase 1-C / Phase 1-M negative controls (an unmounted-but-unmeasured height map can make
// `scrollTop = scrollHeight` land short of the document end); see the U43 HANDOFF for the
// measurements that place that defect on the pre-#414 base as well.
//
// A timeout never throws and never fails a check by itself: it logs one `READINESS {json}`
// line (the status is also returned so a caller can store it in its report) and the collector
// goes on to measure, so the original per-probe assertion still reports the missing anchor
// instead of a bare timeout. Set `RENDER_PARITY_READINESS_LOG=1` to print the status of every
// wait, not only the timed-out ones.

/** Bounded wait. The same magnitude the collectors already use for `waitForFunction`. */
export const SURFACE_READY_TIMEOUT_MS = 10000;

/** Poll interval for the in-page readiness predicate. */
export const SURFACE_READY_POLL_INTERVAL_MS = 50;

// Runs in the page. `waitForFunction` / `evaluate` serialize by source, so the selectors and
// the CodeMirror internals are inlined here on purpose: a module-scope binding would not
// exist in the page.
function surfaceReady({ surface, needles }) {
  const view = window.__testEditor?._view;
  // A pending measure/redraw means the editor is mid-settle (a theme <link> reload schedules
  // one), and CodeMirror renders a restricted window while it runs. `measureScheduled` is -1
  // when neither a frame is queued nor a measure is in flight; unknown internals must not
  // block, so only an explicit number is trusted.
  const measureIdle = !view || typeof view.measureScheduled !== "number" || view.measureScheduled === -1;
  if (surface === "reader") {
    if (typeof window.renderObsidianMarkdown !== "function") return false;
    const node = document.querySelector("#preview .markdown-preview-view") || document.querySelector("#preview");
    const text = node ? node.textContent || "" : "";
    if (!text.trim()) return false;
    if (!measureIdle) return false;
    return needles.length === 0 || needles.some((needle) => text.includes(needle));
  }
  if (!view) return false;
  const content = document.querySelector(".cm-content");
  if (!content || !(content.textContent || "").trim()) return false;
  // The visible host must be laid out (a hidden editor renders no measurable lines), but the
  // wait deliberately stops there: the collectors own their own scroll positions, so it must
  // not move the view.
  const scroller = document.querySelector(".cm-scroller");
  return Boolean(scroller) && scroller.clientHeight > 0 && measureIdle;
}

// Runs in the page: only evaluated after a timeout, for the diagnostic JSON.
function surfaceDiagnostics({ surface, needles }) {
  const selector = surface === "reader" ? "#preview .markdown-preview-view" : ".cm-content";
  const roots = [...document.querySelectorAll(selector)];
  const text = roots.map((node) => node.textContent || "").join("");
  return {
    mode: document.querySelector(".document")?.className || null,
    roots: roots.length,
    textLength: text.trim().length,
    matchedNeedles: needles.filter((needle) => text.includes(needle)),
    readerRenderer: typeof window.renderObsidianMarkdown === "function",
    editorCaptured: Boolean(window.__testEditor),
    editorView: Boolean(window.__testEditor?._view),
    measureScheduled: window.__testEditor?._view?.measureScheduled ?? null,
    scrollerHeight: document.querySelector(".cm-scroller")?.clientHeight ?? null,
  };
}

/**
 * Fixture needles that are expected to be visible on `surface`, derived from whatever the
 * caller already has: an explicit list, probe definitions (`needle` / `scrollNeedle`),
 * theme-core kinds (`kind[surface].needle`, `kind.needle`) or geometry entries
 * (`readerHeading` / `readerTarget` / `needle`). Live Preview deliberately derives none.
 */
export function surfaceNeedlesFor({ surface, probes = [], kinds = [], needles = [] }) {
  if (surface !== "reader") return [];
  const derived = [
    ...needles,
    ...probes.flatMap((probe) => [probe?.needle, probe?.scrollNeedle]),
    ...kinds.flatMap((kind) => [
      kind?.[surface]?.needle,
      kind?.readerHeading?.needle,
      kind?.readerTarget?.needle,
      kind?.needle,
    ]),
  ];
  return [...new Set(derived.filter((needle) => typeof needle === "string" && needle.length > 0))];
}

/**
 * Wait until the surface that owns `surface` ("reader" | "live") has really rendered.
 *
 * @param {import('playwright').Page} page
 * @param {{surface: string, probes?: object[], kinds?: object[], needles?: string[],
 *          label?: string, timeoutMs?: number}} options
 * @returns {Promise<{surface: string, label: string, ready: boolean, timedOut: boolean,
 *          timeoutMs: number, elapsedMs: number, expectedNeedles: number,
 *          reason?: string, observed?: object|null}>}
 */
export async function waitForSurfaceReady(page, options) {
  const {
    surface,
    probes = [],
    kinds = [],
    needles = [],
    label = surface,
    timeoutMs = SURFACE_READY_TIMEOUT_MS,
  } = options || {};
  const expected = surfaceNeedlesFor({ surface, probes, kinds, needles });
  const status = {
    surface,
    label,
    timeoutMs,
    expectedNeedles: expected.length,
    elapsedMs: null,
    ready: false,
    timedOut: false,
    observed: null,
  };
  const started = Date.now();
  try {
    await page.waitForFunction(
      surfaceReady,
      { surface, needles: expected },
      { timeout: timeoutMs, polling: SURFACE_READY_POLL_INTERVAL_MS },
    );
    status.ready = true;
  } catch (error) {
    status.timedOut = true;
    status.reason = String(error?.message || error).split("\n")[0];
  }
  if (status.timedOut || process.env.RENDER_PARITY_READINESS_LOG === "1") {
    status.observed = await page
      .evaluate(surfaceDiagnostics, { surface, needles: expected })
      .catch(() => null);
    console.log(`READINESS ${JSON.stringify(status)}`);
  }
  status.elapsedMs = Date.now() - started;
  return status;
}
