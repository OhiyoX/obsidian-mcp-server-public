// Same-run normalized judgement for the LP-12 editing envelope (U54).
//
// LP-12 used to assert absolute wall-clock budgets on one 10k-line document:
// `initialLoadMs < 500`, `typingP95 < 50`, `selectionP95 < 16`. Those budgets followed the
// runner rather than the product. The same commit, on the same commit SHA, read:
//
//   wsl (6 cores, run 37907247393 job 113743566556): typing p95 5.5 ms, selection p95 0.7 ms
//   tx  (2 vCPU shared, run 37914910852 job attempt 1): typing p95 48.8 ms (barely green)
//   tx  (the same job, attempt 2):                     typing p95 63.3 ms (red)
//
// ... so a correct tree went red or green depending on where GitHub scheduled the job -- and a
// 420 s harness deadline on tx turned the red into "missing results.json" for the whole run.
// (The wsl and tx readings above are an equivalent tree at two different SHAs: `1c7a657e`
// (wsl, run 37907247393) and `8ab945ee` (tx, run 37914910852) have identical git trees --
// `git diff 1c7a657e 8ab945ee --stat` is empty -- while the branch runs `f9c3c66b` / `db2b9385`
// add this slice on top of the same tree.)
//
// The product property behind that budget is: editing a 10k-line document stays bounded by the
// viewport, not by the document. This module judges that property with:
//
//   1. Measurement preconditions. The judgement only means something if the two readings are the
//      documents and samples it claims to judge, so line counts, fence counts, sample shape,
//      "the keystrokes really landed" and "the viewport really rendered something" are all
//      checked fail-closed before any ratio is consulted. (U54-FIX: without these, a browser run
//      that loaded the 51-line control into the "large" slot, a single-sample run, a sample
//      containing `null`, or zero lines with zero rendered rows all came back green.)
//   2. Count invariants (`renderedLines`, `widgets`, `mutations`): a slow machine produces the
//      same counts, only later. These are the primary discrimination.
//   3. A same-run relative budget for the two transaction latencies: the identical protocol runs
//      on a 51-line control document in the same page and the same run, which removes the
//      FIRST-ORDER effect of machine speed. It does not make the judgement load-independent:
//      time-varying load on a shared runner can still move the two halves of a same-run ratio by
//      different amounts, so this is a same-run normalization, not a load-free measurement.
//      An O(document) keystroke shows up as ~200x (10011 lines vs 51); the allowance is 20x.
//      Floors keep scheduler noise from failing a fast machine.
//   4. Catastrophe caps that only catch a user-visible hang. They are explicitly NOT
//      performance budgets; they are hang detectors, and they are not a substitute for the
//      removed budgets.
//
// `evaluateEditingEnvelope` is pure, so `app/test/editing-envelope.test.js` pins the recorded CI
// readings, the preconditions and the counterexamples (an O(document) keystroke, a
// whole-document render, eager widget materialization, a per-keystroke full repaint, a full hang,
// and the false greens listed above) without a browser. `editor-race.mjs` additionally drives the
// same judgement with real-Chromium negative controls.
//
// The readings this envelope was calibrated on are the first branch run 37921947633
// (wsl-obsidian-ci, gate 213/213 in 342.2 s): control 51 lines -> renderedLines 24, widgets 3,
// mutations 60, typing median 1.1 ms, selection median 0.3 ms; large 10011 lines -> renderedLines
// 50, widgets 5, mutations 60, typing median 3.7 ms (p95 5.5 ms), selection median 0.5 ms. The
// second branch run (37924031351, nas-obsidian-ci) read the same counts within one row.

export const EDITING_ENVELOPE = {
  // Fixture identity (U54-FIX). `lines` alone is not enough: a different 51-line document would
  // pass. The fixture is one repeated chunk (1 table fence + 1 code-fence block of 2 fence lines
  // + 10 other lines), so the counts follow from the repeat factor: 4 chunks -> 51 lines, and
  // 834 chunks -> 10011 lines.
  controlLines: 51,
  controlTableFences: 4,
  controlCodeFenceLines: 8,
  largeLines: 10011,
  largeTableFences: 834,
  largeCodeFenceLines: 1668,
  // The protocol dispatches exactly 30 typing and 30 selection transactions. A shorter array is a
  // partial run and must never be summarized as if it were the full protocol.
  requiredSamples: 30,
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

/**
 * Nearest-rank percentile of a sample array; NaN when no finite number is left.
 *
 * U54-FIX: entries that are not real numbers are DROPPED here, never coerced. `Number(null)` is
 * 0, so the old `.map(Number)` read a `[null]` sample as a 0 ms reading instead of a missing one.
 * Dropping alone is not enough (a 29-entry sample would still summarize), which is why the
 * measurement preconditions below reject any sample whose length or entries are wrong.
 */
export function percentile(values, fraction) {
  const sorted = [...(Array.isArray(values) ? values : [])]
    .filter((value) => typeof value === "number" && Number.isFinite(value))
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
 * Why `values` cannot be summarized as a sample, or `null` when it can.
 *
 * Every entry must be a real, finite, non-negative number of a real `number` type: `null`,
 * `undefined`, a missing key, a numeric string and a negative duration are all rejected instead
 * of being coerced into a reading.
 */
function sampleProblem(values, expected, label) {
  if (!Array.isArray(values)) return `${label} is not a sample array (${JSON.stringify(values)})`;
  if (values.length !== expected) {
    return `${label} holds ${values.length} sample(s), expected exactly ${expected}`;
  }
  const bad = values.findIndex(
    (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0,
  );
  if (bad !== -1) {
    return `${label}[${bad}] = ${JSON.stringify(values[bad])}; every sample must be a finite, non-negative number`;
  }
  return null;
}

/** Why `measurement` is not the `expected` fixture document, or `null` when it is. */
function documentProblem(measurement, expected, label) {
  if (typeof measurement?.lines !== "number" || !Number.isFinite(measurement.lines)) {
    return `${label} reported lines = ${JSON.stringify(measurement?.lines)}`;
  }
  if (measurement.lines !== expected.lines) {
    return `${label} holds ${measurement.lines} line(s), expected ${expected.lines}`;
  }
  if (measurement.tableFences !== expected.tableFences) {
    return `${label} holds ${JSON.stringify(measurement.tableFences)} table fence(s), expected ${expected.tableFences}`;
  }
  if (measurement.codeFenceLines !== expected.codeFenceLines) {
    return `${label} holds ${JSON.stringify(measurement.codeFenceLines)} code fence line(s), expected ${expected.codeFenceLines}`;
  }
  return null;
}

/** Why the measured editing did not really happen, or `null` when it did. */
function editingProblem(measurement, label) {
  if (measurement?.editApplied !== true) {
    return `${label} did not carry the 30 dispatched insertions (editApplied = ${JSON.stringify(measurement?.editApplied)})`;
  }
  if (typeof measurement?.mutations !== "number" || !Number.isFinite(measurement.mutations) || measurement.mutations <= 0) {
    return `${label} recorded ${JSON.stringify(measurement?.mutations)} DOM mutation record(s) for 30 keystrokes`;
  }
  return null;
}

/** Why the measurement never rendered a viewport, or `null` when it did. */
function renderProblem(measurement, label) {
  if (typeof measurement?.renderedLines !== "number" || !Number.isFinite(measurement.renderedLines)) {
    return `${label} reported renderedLines = ${JSON.stringify(measurement?.renderedLines)}`;
  }
  if (measurement.renderedLines < 1) return `${label} rendered ${measurement.renderedLines} .cm-line node(s)`;
  return null;
}

/**
 * The fail-closed preconditions of one measurement run, in report order. Every one of them must
 * hold before the count invariants and the same-run ratios below are meaningful.
 *
 * Each measurement is
 *   { lines, tableFences, codeFenceLines, renderedLines, widgets, mutations, editApplied,
 *     loadMs, typing: number[], selection: number[] }.
 */
export function evaluateMeasurementPreconditions({ control, large, envelope = EDITING_ENVELOPE }) {
  const controlExpected = {
    lines: envelope.controlLines,
    tableFences: envelope.controlTableFences,
    codeFenceLines: envelope.controlCodeFenceLines,
  };
  const largeExpected = {
    lines: envelope.largeLines,
    tableFences: envelope.largeTableFences,
    codeFenceLines: envelope.largeCodeFenceLines,
  };
  const controlDocument = documentProblem(control, controlExpected, "the control document");
  const largeDocument = documentProblem(large, largeExpected, "the 10k document");
  const sampleCount = (values) => (Array.isArray(values) ? values.length : `${JSON.stringify(values)} (not an array)`);
  const controlTyping = sampleProblem(control?.typing, envelope.requiredSamples, "control typing");
  const largeTyping = sampleProblem(large?.typing, envelope.requiredSamples, "large typing");
  const controlSelection = sampleProblem(control?.selection, envelope.requiredSamples, "control selection");
  const largeSelection = sampleProblem(large?.selection, envelope.requiredSamples, "large selection");
  const controlEditing = editingProblem(control, "the control document");
  const largeEditing = editingProblem(large, "the 10k document");
  const controlRender = renderProblem(control, "the control document");
  const largeRender = renderProblem(large, "the 10k document");

  return [
    verdict(
      "the control document is the 51-line fixture, not another document",
      controlDocument === null,
      controlDocument ??
        `51 lines, ${envelope.controlTableFences} table fence(s), ${envelope.controlCodeFenceLines} code fence line(s)`,
    ),
    verdict(
      `the 10k fixture really holds ${envelope.largeLines} lines with its ${envelope.largeTableFences} table and ${envelope.largeCodeFenceLines} code fences`,
      largeDocument === null,
      largeDocument ??
        `${envelope.largeLines} lines, ${envelope.largeTableFences} table fence(s), ${envelope.largeCodeFenceLines} code fence line(s)`,
    ),
    verdict(
      `both documents recorded ${envelope.requiredSamples} finite, non-negative typing samples`,
      controlTyping === null && largeTyping === null,
      [controlTyping, largeTyping].filter(Boolean).join("; ") ||
        `${sampleCount(control?.typing)} control / ${sampleCount(large?.typing)} large typing sample(s)`,
    ),
    verdict(
      `both documents recorded ${envelope.requiredSamples} finite, non-negative selection samples`,
      controlSelection === null && largeSelection === null,
      [controlSelection, largeSelection].filter(Boolean).join("; ") ||
        `${sampleCount(control?.selection)} control / ${sampleCount(large?.selection)} large selection sample(s)`,
    ),
    verdict(
      "the measured keystrokes really edited both documents",
      controlEditing === null && largeEditing === null,
      [controlEditing, largeEditing].filter(Boolean).join("; ") || "30 insertions landed on both documents",
    ),
    verdict(
      "both documents rendered a non-empty viewport",
      controlRender === null && largeRender === null,
      [controlRender, largeRender].filter(Boolean).join("; ") ||
        `${control.renderedLines} control / ${large.renderedLines} large .cm-line node(s)`,
    ),
  ];
}

/**
 * Judge one measurement run: `control` (the small document) and `large` (the 10k-line document),
 * both produced by the same protocol in the same Chromium page.
 *
 * Returns the measurement preconditions first, then one `{ name, ok, detail }` per criterion.
 */
export function evaluateEditingEnvelope({ control, large, envelope = EDITING_ENVELOPE }) {
  const controlTypingP50 = percentile(control?.typing, 0.5);
  const controlSelectionP50 = percentile(control?.selection, 0.5);
  const largeTypingP50 = percentile(large?.typing, 0.5);
  const largeTypingP95 = percentile(large?.typing, 0.95);
  const largeSelectionP50 = percentile(large?.selection, 0.5);
  const typingBound = sameRunBound(controlTypingP50, envelope.typingGrowth, envelope.typingFloorMs);
  const selectionBound = sameRunBound(controlSelectionP50, envelope.selectionGrowth, envelope.selectionFloorMs);
  const mutationBound = sameRunBound(control?.mutations, envelope.mutationGrowth, envelope.mutationFloor);

  return [
    ...evaluateMeasurementPreconditions({ control, large, envelope }),
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
