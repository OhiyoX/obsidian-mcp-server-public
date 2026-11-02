// FROZEN PRE-FIX REFERENCE of the LP-12 judgement (U54-FIX). NOT used by the gate.
//
// This is the judgement as it stood at candidate head `db2b9385` (blob
// 61dd0734f0484958529b31039fe1d2b597a1962a), i.e. before the U54-FIX measurement
// preconditions. It is kept, and imported, for one reason: the false greens the U54 seat found
// have to be shown as a RUNNABLE pair -- "the old judgement accepted this reading (red), the
// fixed judgement rejects it (green)" -- instead of a claim in a document.
//
//   * `app/scripts/web-regression/editor-race.mjs` calls it on the REAL browser readings of its
//     negative controls and writes both verdict sets into `performance.json`.
//   * `app/test/editing-envelope.test.js` calls it on the recorded readings and the false-green
//     shapes.
//
// The logic below is the pre-fix logic verbatim (only the exported names carry a `prefix` prefix
// to keep the two judgements distinguishable in a test file). Do not "fix" it: its whole value is
// being the behaviour that let these readings through.
//
// Known pre-fix gaps, all fixed in `editing-envelope.mjs` and all pinned by the tests above:
//   * `prefixPercentile` coerces with `Number()`, so `null` reads as 0 and a `[null]` sample
//     summarizes as a 0 ms measurement instead of a missing one;
//   * nothing checks that the measured documents are the 51 / 10011-line fixtures, so the
//     51-line control loaded into the "large" slot is judged as the 10k document;
//   * nothing checks the sample count, so one sample summarizes as a full 30-transaction run;
//   * nothing checks that the keystrokes landed or that anything rendered, so a zero-line,
//     zero-render reading scores green.

export const PREFIX_EDITING_ENVELOPE = {
  // CodeMirror paints the viewport plus a margin, so a 1000px editor holds well under 200
  // `.cm-line` nodes. The cap is 4x that; rendering the 10011-line document is 25x above it.
  renderedLineCap: 400,
  // The measured document holds 834 table fences + 834 code fences. A viewport materializes
  // the widgets it can see (order of 10); 128 is 13x that and still 13x below the document's
  // fence count, so "materialize every block" cannot pass.
  widgetCap: 128,
  // 30 keystrokes of a viewport-bounded repaint stay in the low hundreds of mutation records;
  // a repaint proportional to the document is 10^3-10^4. The floor allows >13 mutated nodes
  // per keystroke before the control document's own count is even consulted.
  mutationGrowth: 4,
  mutationFloor: 400,
  // Typing: the median of 30 real transactions on the 10k document against the same median on
  // the 51-line control, measured in the same page. wsl reads ~3.3-3.7 ms median (5.5 ms p95) on
  // the 10k document, so the 12 ms floor already passes on a healthy runner, and the 20x ratio
  // covers a slower machine without ever reaching the ~200x an O(document) keystroke produces.
  typingGrowth: 20,
  typingFloorMs: 12,
  // Selection-only transactions read ~0.4 ms on wsl and ~2 ms on tx; the floor is the realistic
  // bound and the ratio still catches a selection path that walks the document.
  selectionGrowth: 20,
  selectionFloorMs: 8,
  // Hang detector, not a budget: 1000 ms is far above every reading on record (5.5 ms wsl,
  // 63.3 ms tx) and far below "the editor is frozen".
  typingCatastropheMs: 1000,
};

/** Nearest-rank percentile of a sample array; NaN when the sample is empty or non-numeric. */
export function prefixPercentile(values, fraction) {
  const sorted = [...(Array.isArray(values) ? values : [])]
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

const ms = (value) => (Number.isFinite(value) ? `${Number(value).toFixed(1)}ms` : "no reading");

/** The allowance for a metric measured on the control document in the same run. */
function sameRunBound(controlValue, growth, floorMs) {
  return Number.isFinite(controlValue) ? Math.max(floorMs, controlValue * growth) : Number.NaN;
}

function verdict(name, ok, detail) {
  return { name, ok, detail };
}

/**
 * Judge one measurement run: `control` (the small document) and `large` (the 10k-line document),
 * both produced by the same protocol in the same Chromium page.
 *
 * Each measurement is
 *   { lines, renderedLines, widgets, mutations, loadMs, typing: number[], selection: number[] }.
 * Returns one `{ name, ok, detail }` per criterion, in report order.
 */
export function evaluatePrefixEnvelope({ control, large, envelope = PREFIX_EDITING_ENVELOPE }) {
  const controlTypingP50 = prefixPercentile(control?.typing, 0.5);
  const controlSelectionP50 = prefixPercentile(control?.selection, 0.5);
  const largeTypingP50 = prefixPercentile(large?.typing, 0.5);
  const largeTypingP95 = prefixPercentile(large?.typing, 0.95);
  const largeSelectionP50 = prefixPercentile(large?.selection, 0.5);
  const typingBound = sameRunBound(controlTypingP50, envelope.typingGrowth, envelope.typingFloorMs);
  const selectionBound = sameRunBound(controlSelectionP50, envelope.selectionGrowth, envelope.selectionFloorMs);
  const mutationBound = sameRunBound(control?.mutations, envelope.mutationGrowth, envelope.mutationFloor);

  return [
    verdict(
      "the editor renders a viewport, not the document",
      Number.isFinite(large?.renderedLines) && large.renderedLines <= envelope.renderedLineCap,
      `rendered ${large?.renderedLines} .cm-line node(s) for a ${large?.lines}-line document (cap ${envelope.renderedLineCap})`,
    ),
    verdict(
      "a 10k-line Live document materializes no eager block widgets",
      Number.isFinite(large?.widgets) && large.widgets <= envelope.widgetCap,
      `materialized ${large?.widgets} table/code widget(s) (cap ${envelope.widgetCap}; the document holds 834 table fences + 834 code fences)`,
    ),
    verdict(
      "per-keystroke repaint work does not scale with document size",
      Number.isFinite(large?.mutations) &&
        Number.isFinite(mutationBound) &&
        large.mutations <= mutationBound,
      `${large?.mutations} editor mutation record(s) over 30 keystrokes vs ${control?.mutations} on the control document (allowance max(${envelope.mutationFloor}, ${envelope.mutationGrowth}x control) = ${Number.isFinite(mutationBound) ? mutationBound : "n/a"})`,
    ),
    verdict(
      "typing latency does not scale with document size",
      Number.isFinite(largeTypingP50) && Number.isFinite(typingBound) && largeTypingP50 <= typingBound,
      `typing median ${ms(largeTypingP50)} on the 10k document vs ${ms(controlTypingP50)} on the control document (allowance max(${envelope.typingFloorMs}ms, ${envelope.typingGrowth}x control) = ${ms(typingBound)})`,
    ),
    verdict(
      "selection latency does not scale with document size",
      Number.isFinite(largeSelectionP50) &&
        Number.isFinite(selectionBound) &&
        largeSelectionP50 <= selectionBound,
      `selection median ${ms(largeSelectionP50)} on the 10k document vs ${ms(controlSelectionP50)} on the control document (allowance max(${envelope.selectionFloorMs}ms, ${envelope.selectionGrowth}x control) = ${ms(selectionBound)})`,
    ),
    verdict(
      "typing stays far below a user-visible hang (hang detector, not a budget)",
      Number.isFinite(largeTypingP95) && largeTypingP95 <= envelope.typingCatastropheMs,
      `typing p95 ${ms(largeTypingP95)} on the 10k document (hang cap ${envelope.typingCatastropheMs}ms; every reading on record is <= 63.3ms)`,
    ),
  ];
}
