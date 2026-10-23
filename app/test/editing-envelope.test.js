// U54: pins the same-run normalized judgement that replaced LP-12's absolute wall-clock budgets,
// and the U54-FIX measurement preconditions that closed the false greens the U54 seat found.
//
// `RECORDED_CONTROL` / `RECORDED_LARGE` are the raw readings of CI run 37921947633 (the first run
// on the U54 branch, wsl-obsidian-ci): both documents were measured by the same protocol in the
// same page, in the same run that passed the gate 213/213 in 342.2 s. `TX_TYPING` /
// `TX_SELECTION` are the recorded large-document readings of the run that made the old budgets
// indefensible (37914910852, tx-obsidian-ci).
//
// Two record corrections (U54-FIX, seat CONCERNS):
//   * the tx test's control value is CONSTRUCTED. The tx artifacts hold the large-document
//     samples only, so the "same machine" control is `samples(10)` -- a stand-in chosen to be
//     ~10x the wsl control, not a measured tx reading. The test proves the judgement tolerates a
//     uniformly slower machine; it is not evidence that tx was measured both ways.
//   * wsl and tx were read from an EQUIVALENT TREE AT DIFFERENT SHAs: `1c7a657e` for the wsl
//     reference run `37907247393` and `8ab945ee` for the tx run `37914910852` have identical git
//     trees (`git diff 1c7a657e 8ab945ee --stat` is empty); the branch runs `f9c3c66b` / `db2b9385`
//     add this slice on top of that tree. It is not the same SHA.
//
// The counterexample cases are the point of the whole change: they show what the judgement still
// catches, which is what an "it is load-sensitive, allow-list it" whitewash would have thrown
// away. The false-green pair is the U54-FIX part: every wrong reading below is judged by BOTH the
// frozen pre-fix judgement (which accepted it) and the fixed one (which must reject it).
import assert from "node:assert/strict";
import test from "node:test";

import {
  EDITING_ENVELOPE,
  evaluateEditingEnvelope,
  evaluateMeasurementPreconditions,
  percentile,
} from "../scripts/web-regression/editing-envelope.mjs";
import {
  PREFIX_EDITING_ENVELOPE,
  evaluatePrefixEnvelope,
  prefixPercentile,
} from "../scripts/web-regression/editing-envelope-prefix.mjs";

const samples = (value, count = 30) => Array.from({ length: count }, () => value);
const round1 = (values) => values.map((value) => Math.round(value * 10) / 10);

// Recorded CI readings, rounded to 0.1 ms (the numbers the harness prints and the artifact keeps).
// `tableFences` / `codeFenceLines` / `editApplied` are the structural fields the pre-fix harness did
// not record: the recorded `lines` (51 / 10011) fix the fixture text, so its fence counts follow
// (4 / 8 and 834 / 1668 fence lines), and 30 dispatches that produced the recorded 60 mutation
// records on both documents are the post-condition `editApplied` now measures directly.
const RECORDED_CONTROL = {
  lines: 51,
  tableFences: 4,
  codeFenceLines: 8,
  renderedLines: 24,
  widgets: 3,
  mutations: 60,
  editApplied: true,
  loadMs: 8.4,
  typing: round1([2.9, 1, 1.4, 1.9, 1.4, 1.5, 1.3, 1.9, 1.1, 1.3, 1.2, 0.9, 1, 0.9, 1.1, 1, 1.6, 1, 1.1, 0.9, 1, 1.4, 1.1, 0.9, 0.9, 1.9, 1, 0.9, 1.2, 1.5]),
  selection: round1([0.7, 0.2, 0.4, 0.2, 0.5, 0.2, 0.4, 0.3, 0.4, 0.1, 0.3, 0.2, 0.2, 0.2, 0.3, 0.1, 0.6, 0.1, 0.3, 0.2, 0.3, 0.3, 0.5, 0.1, 0.5, 0.3, 0.3, 0.1, 0.5, 0.1]),
};
const RECORDED_LARGE = {
  lines: 10011,
  tableFences: 834,
  codeFenceLines: 1668,
  renderedLines: 50,
  widgets: 5,
  mutations: 60,
  editApplied: true,
  loadMs: 33.5,
  typing: round1([6.2, 3.8, 3.7, 3.6, 3.2, 3.1, 4, 3.9, 3.7, 4, 3.9, 3.9, 3.8, 4.9, 4, 5.5, 4.6, 3.7, 3.5, 3.5, 3.3, 3.5, 3.8, 3.4, 3.9, 3.6, 3.7, 3, 3.2, 3.4]),
  selection: round1([0.7, 0.4, 0.7, 0.3, 0.4, 0.3, 0.5, 0.3, 0.6, 0.3, 0.7, 0.4, 0.5, 0.3, 0.5, 0.6, 0.6, 0.5, 0.5, 0.4, 0.5, 0.3, 0.5, 0.3, 0.8, 0.4, 0.5, 0.3, 0.5, 0.2]),
};
// Recorded tx readings (run 37914910852, attempt 2: the attempt that failed `typingP95 < 50`).
const TX_TYPING = [93.9, 42.6, 14.2, 15.5, 25.3, 30.2, 16.2, 11, 9.3, 20.4, 18.3, 63.3, 22.5, 11.4, 14, 20.1, 14.2, 11.3, 9.9, 13, 23.5, 40.4, 44.1, 23.4, 10.4, 10.3, 12.3, 14.4, 10.6, 10];
const TX_SELECTION = [7.8, 4.7, 13.1, 1.6, 4, 1.8, 1.5, 1.1, 1.5, 10.6, 2.6, 3.9, 18.2, 1.1, 2.1, 1.4, 4, 1, 1.3, 2.5, 2.5, 4.6, 6.6, 1.6, 3.1, 1.3, 2.1, 0.9, 1.3, 0.8];

const measurement = (overrides = {}) => ({
  ...RECORDED_LARGE,
  measurement: "synchronous transaction duration, excludes next-paint and hardware IME",
  ...overrides,
});
// The control document is the same 4-chunk text the harness measures: 51 lines, entirely inside
// the viewport, so it normalizes machine speed without normalizing the defect under test.
const control = (overrides = {}) => ({
  ...RECORDED_CONTROL,
  measurement: "synchronous transaction duration, excludes next-paint and hardware IME",
  ...overrides,
});

const failed = (verdicts) => verdicts.filter((verdict) => !verdict.ok).map((verdict) => verdict.name);
const verdictFor = (verdicts, fragment) =>
  verdicts.find((verdict) => verdict.name.includes(fragment));

test("percentile uses nearest-rank, drops non-numbers and fails closed on an empty sample", () => {
  // Reproduces the recorded wsl summary line: `typingP95: 5.5` for this exact sample.
  assert.equal(percentile([...RECORDED_LARGE.typing], 0.95), 5.5);
  assert.equal(percentile(samples(7, 4), 0.5), 7);
  assert.equal(Number.isNaN(percentile([], 0.95)), true);
  assert.equal(Number.isNaN(percentile(undefined, 0.5)), true);
  assert.equal(Number.isNaN(percentile(["nope"], 0.5)), true);
  // U54-FIX: `Number(null)` is 0, so the pre-fix function summarized a `[null]` sample as a real
  // 0 ms measurement. The fixed one has no reading at all, and the preconditions reject the sample.
  assert.equal(prefixPercentile([null, null], 0.5), 0);
  assert.equal(Number.isNaN(percentile([null, null], 0.5)), true);
});

// U54-FIX: the frozen reference must really be the pre-fix judgement, otherwise the "head red"
// half of every pair below is meaningless.
test("the pre-fix reference still judges the recorded run with the six pre-fix criteria", () => {
  const verdicts = evaluatePrefixEnvelope({ control: control(), large: measurement() });
  assert.equal(verdicts.length, 6);
  assert.deepEqual(verdicts.map((verdict) => verdict.ok), [true, true, true, true, true, true]);
  assert.ok(Object.keys(PREFIX_EDITING_ENVELOPE).includes("renderedLineCap"));
  assert.equal(Object.keys(EDITING_ENVELOPE).includes("controlLines"), true);
});

test("the recorded wsl reading passes every precondition and criterion", () => {
  const verdicts = evaluateEditingEnvelope({ control: control(), large: measurement() });
  assert.deepEqual(failed(verdicts), []);
  // The recorded run's own verdict lines, re-derived here: same repaint count on both documents,
  // 3.4x typing ratio against a 20x allowance.
  assert.match(verdictFor(verdicts, "typing latency").detail, /typing median 3\.7ms on the 10k document vs 1\.1ms/);
  assert.match(verdictFor(verdicts, "repaint work").detail, /60 editor mutation record\(s\) over 30 keystrokes vs 60/);
});

test("a slower machine passes once the control document is measured on the same machine", () => {
  // CORRECTED RECORD: the control below is CONSTRUCTED, not measured on tx. The tx artifacts hold
  // the large-document samples only. `samples(10)` stands in for "a machine ~10x slower than wsl
  // on BOTH documents", so this test proves the judgement tolerates a uniformly slower machine; it
  // does not prove tx was measured both ways. The wsl/tx numeric comparison is an equivalent tree
  // at two different SHAs (`1c7a657e` for the wsl reference run, `8ab945ee` for the tx run; the
  // trees are identical, `git diff 1c7a657e 8ab945ee --stat` is empty).
  const verdicts = evaluateEditingEnvelope({
    control: control({ typing: samples(10), selection: samples(3), mutations: 60 }),
    large: measurement({ typing: TX_TYPING, selection: TX_SELECTION, mutations: 300, widgets: 10 }),
  });
  assert.deepEqual(failed(verdicts), []);
});

test("count invariants do not move with a uniformly slower machine", () => {
  const fast = evaluateEditingEnvelope({ control: control(), large: measurement() });
  const slow = evaluateEditingEnvelope({
    control: control({ typing: samples(24), selection: samples(9) }),
    large: measurement({ typing: samples(24), selection: samples(9) }),
  });
  assert.deepEqual(failed(fast), []);
  assert.deepEqual(failed(slow), []);
});

test("a keystroke that costs O(document) is caught", () => {
  // 250 ms against the control's 1.1 ms median = the same document-proportional cost that a
  // 10k-line doc used to produce before the cached callout scan, but judged without the machine.
  const verdicts = evaluateEditingEnvelope({
    control: control(),
    large: measurement({ typing: samples(250) }),
  });
  assert.deepEqual(failed(verdicts), ["typing latency does not scale with document size"]);
  assert.match(verdictFor(verdicts, "typing latency").detail, /typing median 250\.0ms/);
  // The hang cap is deliberately far above it: this is a scaling defect, not a freeze.
  assert.equal(verdictFor(verdicts, "hang detector").ok, true);
});

test("rendering the whole document instead of the viewport is caught", () => {
  const verdicts = evaluateEditingEnvelope({
    control: control(),
    large: measurement({ renderedLines: 10011 }),
  });
  assert.deepEqual(failed(verdicts), ["the editor renders a viewport, not the document"]);
});

test("eager materialization of every fenced block is caught", () => {
  const verdicts = evaluateEditingEnvelope({
    control: control(),
    large: measurement({ widgets: 1668 }),
  });
  assert.deepEqual(failed(verdicts), ["a 10k-line Live document materializes no eager block widgets"]);
});

test("a per-keystroke repaint proportional to the document is caught", () => {
  const verdicts = evaluateEditingEnvelope({
    control: control(),
    large: measurement({ mutations: 3000 }),
  });
  assert.deepEqual(failed(verdicts), ["per-keystroke repaint work does not scale with document size"]);
});

test("a frozen editor is caught by the hang detector alone", () => {
  const verdicts = evaluateEditingEnvelope({
    control: control(),
    large: measurement({ typing: [...samples(2, 28), 5000, 5000] }),
  });
  assert.deepEqual(failed(verdicts), ["typing stays far below a user-visible hang (hang detector, not a budget)"]);
});

test("a selection path that walks the document is caught", () => {
  const verdicts = evaluateEditingEnvelope({
    control: control(),
    large: measurement({ selection: samples(200) }),
  });
  assert.deepEqual(failed(verdicts), ["selection latency does not scale with document size"]);
});

// ---------------------------------------------------------------------------------------------
// U54-FIX: the false greens. Each case is judged twice -- the frozen pre-fix judgement must ACCEPT
// it (that is the seat's finding) and the fixed judgement must REJECT it. The shapes are the ones
// the seat reproduced, and the first one is also driven end to end in real Chromium by
// `editor-race.mjs` (LP-12's negative controls), which records both verdict sets in
// `performance.json`.
// ---------------------------------------------------------------------------------------------
const FALSE_GREENS = [
  {
    // Seat finding 3: "keep this head's LP-12 assertions, only let the large document really load
    // 51 lines -- still PASS; the normal control is 10011 lines. The judgement never checked the
    // document size."
    label: "the 51-line control document loaded into the large slot",
    reading: () => measurement({ ...RECORDED_CONTROL }),
    fixed: /the 10k fixture really holds 10011 lines/,
    prefix: [],
  },
  {
    label: "a single typing/selection sample",
    reading: () => measurement({ typing: [3.7], selection: [0.5] }),
    fixed: /both documents recorded 30 finite, non-negative typing samples/,
    prefix: [],
  },
  {
    label: "a sample with a missing (`null`) entry",
    reading: () => measurement({ typing: [...samples(3.7, 29), null], selection: [...samples(0.5, 29), null] }),
    fixed: /both documents recorded 30 finite, non-negative typing samples/,
    prefix: [],
  },
  {
    label: "a partial sample (29 of 30)",
    reading: () => measurement({ typing: samples(3.7, 29), selection: samples(0.5, 29) }),
    fixed: /both documents recorded 30 finite, non-negative typing samples/,
    prefix: [],
  },
  {
    // Seat finding 4: zero lines / zero rendered rows with `[null]` samples was fully green,
    // because `percentile` coerced `null` to 0 and the caps are upper bounds only.
    label: "zero lines and zero rendered rows with `[null]` samples",
    reading: () => ({
      lines: 0,
      tableFences: 0,
      codeFenceLines: 0,
      renderedLines: 0,
      widgets: 0,
      mutations: 0,
      editApplied: true,
      loadMs: 0,
      typing: [null],
      selection: [null],
    }),
    fixed: /both documents recorded 30 finite, non-negative typing samples/,
    prefix: [],
  },
  {
    label: "keystrokes that never reached the document",
    reading: () => measurement({ editApplied: false }),
    fixed: /the measured keystrokes really edited both documents/,
    prefix: [],
  },
  {
    label: "a document that never rendered a line",
    reading: () => measurement({ renderedLines: 0 }),
    fixed: /both documents rendered a non-empty viewport/,
    prefix: [],
  },
  {
    label: "a negative latency sample",
    reading: () => measurement({ typing: [...samples(3.7, 29), -1] }),
    fixed: /both documents recorded 30 finite, non-negative typing samples/,
    prefix: [],
  },
];

for (const scenario of FALSE_GREENS) {
  test(`false green rejected by the fix and accepted by the pre-fix judgement: ${scenario.label}`, () => {
    const large = scenario.reading();
    const fixed = evaluateEditingEnvelope({ control: control(), large });
    // The pre-fix judgement (the "red" half of the pair) accepted every one of these readings.
    assert.deepEqual(failed(evaluatePrefixEnvelope({ control: control(), large })), scenario.prefix);
    // The fixed judgement rejects it, on the named precondition.
    assert.ok(
      failed(fixed).some((name) => scenario.fixed.test(name)),
      `${scenario.label}: expected a failure matching ${scenario.fixed}, got ${JSON.stringify(failed(fixed))}`,
    );
  });
}

test("a same-size document with different content cannot pass as the fixture", () => {
  // Line count alone is not enough: a different 51-line / 10011-line document must not be judged
  // as the fixture the constants were calibrated on.
  const verdicts = evaluateEditingEnvelope({
    control: control({ tableFences: 5 }),
    large: measurement({ codeFenceLines: 1667 }),
  });
  assert.ok(failed(verdicts).includes("the control document is the 51-line fixture, not another document"));
  assert.ok(failed(verdicts).some((name) => name.includes("the 10k fixture really holds 10011 lines")));
});

test("missing measurements fail closed instead of passing by omission", () => {
  const verdicts = evaluateEditingEnvelope({ control: {}, large: {} });
  assert.equal(verdicts.length, 12);
  assert.equal(failed(verdicts).length, 12);
  assert.equal(evaluateMeasurementPreconditions({}).length, 6);
});

test("every constant is documented with a rationale in the module", async () => {
  // Guard against a future edit that raises a cap to make a red go away without a reason: the
  // constants are named after what they bound, and the module carries the CI readings.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../scripts/web-regression/editing-envelope.mjs", import.meta.url), "utf8"),
  );
  for (const key of Object.keys(EDITING_ENVELOPE)) {
    assert.match(source, new RegExp(`^\\s*${key}:`, "m"), `${key} must stay declared in the envelope`);
  }
  assert.match(source, /37907247393/);
  assert.match(source, /37914910852/);
  assert.match(source, /37921947633/);
});
