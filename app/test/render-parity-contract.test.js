import assert from "node:assert/strict";
import test from "node:test";

import {
  GEOMETRY_TOLERANCE_FIELDS,
  MAX_GEOMETRY_TOLERANCE_PX,
  comparableNumber,
  diffFieldMaps,
  validateSnapshotContract,
} from "../scripts/render-parity-contract.mjs";

test("1/8 strict comparison is symmetric over the union of fields", () => {
  const forward = diffFieldMaps(
    { "metrics.boxWidth": 10 },
    { "metrics.boxWidth": 10, "metrics.boxHeight": 20 },
    { kind: "paragraph", comparison: "reader-liveIdle", tolerancePx: 1 },
  );
  assert.equal(forward.length, 1);
  assert.equal(forward[0].field, "metrics.boxHeight");
  assert.equal(forward[0].leftPresent, false);
  assert.equal(forward[0].rightPresent, true);
  assert.equal(forward[0].reason, "missing-field");

  const reverse = diffFieldMaps(
    { "metrics.boxWidth": 10, "metrics.boxHeight": 20 },
    { "metrics.boxWidth": 10 },
    { kind: "paragraph", comparison: "liveIdle-reader", tolerancePx: 1 },
  );
  assert.equal(reverse.length, 1);
  assert.equal(reverse[0].field, "metrics.boxHeight");
  assert.equal(reverse[0].leftPresent, true);
  assert.equal(reverse[0].rightPresent, false);
  assert.equal(reverse[0].reason, "missing-field");
});

test("2/8 missing, null and zero remain distinct", () => {
  const missingVsZero = diffFieldMaps({}, { "metrics.paddingTopPx": 0 }, { tolerancePx: 1 });
  assert.equal(missingVsZero.length, 1);
  assert.equal(missingVsZero[0].reason, "missing-field");

  const nullVsZero = diffFieldMaps(
    { "metrics.paddingTopPx": null },
    { "metrics.paddingTopPx": 0 },
    { tolerancePx: 1 },
  );
  assert.equal(nullVsZero.length, 1);
  assert.equal(nullVsZero[0].reason, "value-mismatch");

  assert.deepEqual(
    diffFieldMaps(
      { "metrics.paddingTopPx": null },
      { "metrics.paddingTopPx": null },
      { tolerancePx: 1 },
    ),
    [],
  );
});

test("3/8 only explicit geometry metrics may consume a bounded <=1px tolerance", () => {
  assert.equal(MAX_GEOMETRY_TOLERANCE_PX, 1);
  assert.equal(GEOMETRY_TOLERANCE_FIELDS.has("metrics.boxWidth"), true);
  assert.equal(GEOMETRY_TOLERANCE_FIELDS.has("style.paddingLeft"), false);
  assert.equal(GEOMETRY_TOLERANCE_FIELDS.has("metrics.paddingTopPx"), false);
  assert.equal(GEOMETRY_TOLERANCE_FIELDS.has("metrics.fontSizePx"), false);
  assert.equal(GEOMETRY_TOLERANCE_FIELDS.has("metrics.lineHeightPx"), false);

  assert.deepEqual(
    diffFieldMaps(
      { "metrics.boxWidth": 10 },
      { "metrics.boxWidth": 10.75 },
      { tolerancePx: 1 },
    ),
    [],
  );

  for (const [field, left, right] of [
    ["style.paddingLeft", "10px", "10.25px"],
    ["style.fontSize", "16px", "16.25px"],
    ["style.lineHeight", "20px", "20.25px"],
    ["style.borderLeftWidth", "1px", "1.25px"],
    ["metrics.paddingTopPx", 10, 10.25],
    ["metrics.fontSizePx", 16, 16.25],
    ["metrics.lineHeightPx", 20, 20.25],
  ]) {
    const diffs = diffFieldMaps({ [field]: left }, { [field]: right }, { tolerancePx: 1 });
    assert.equal(diffs.length, 1, field);
    assert.equal(diffs[0].reason, "numeric-delta", field);
    assert.equal(diffs[0].delta, 0.25, field);
  }
});

test("4/8 px parsing is exact and non-numeric values never inherit geometry tolerance", () => {
  assert.equal(comparableNumber("10px"), 10);
  assert.equal(comparableNumber("-.5px"), -0.5);
  assert.equal(comparableNumber(4.25), 4.25);
  assert.equal(comparableNumber("10"), null);
  assert.equal(comparableNumber(null), null);
  assert.equal(comparableNumber(Number.NaN), null);

  const diffs = diffFieldMaps(
    { "style.display": "block", "style.color": "rgb(1, 2, 3)" },
    { "style.display": "inline", "style.color": "rgb(1, 2, 3)" },
  );
  assert.deepEqual(diffs.map((item) => [item.field, item.reason]), [
    ["style.display", "value-mismatch"],
  ]);
});

test("5/8 top-level null and array field maps fail closed", () => {
  assert.throws(() => diffFieldMaps(null, {}), /leftFields must be a non-array object/);
  assert.throws(() => diffFieldMaps({}, null), /rightFields must be a non-array object/);
  assert.throws(() => diffFieldMaps([], {}), /leftFields must be a non-array object/);
  assert.throws(() => diffFieldMaps({}, []), /rightFields must be a non-array object/);
  assert.throws(() => diffFieldMaps({}, {}, []), /options must be a non-array object/);
});

test("6/8 NaN and infinities fail closed even when both sides match", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const diffs = diffFieldMaps(
      { "metrics.boxWidth": value },
      { "metrics.boxWidth": value },
      { tolerancePx: 1 },
    );
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].reason, "non-finite-sample");
  }

  assert.deepEqual(validateSnapshotContract({
    found: true,
    metrics: { a: Number.NaN, b: Number.POSITIVE_INFINITY },
  }, {
    requiredMetrics: ["a", "b"],
  }), [
    { section: "metrics", field: "a", reason: "non-finite-sample" },
    { section: "metrics", field: "b", reason: "non-finite-sample" },
  ]);
});

test("7/8 snapshot validation preserves missing/null semantics and nullable exceptions", () => {
  const problems = validateSnapshotContract({
    found: true,
    style: {
      fontSize: null,
      lineHeight: "",
    },
    metrics: {
      boxWidth: null,
      boxHeight: 10,
      lineHeightPx: null,
    },
  }, {
    requiredStyleProps: ["fontSize", "lineHeight", "fontWeight"],
    requiredMetrics: ["boxWidth", "boxHeight", "glyphWidth", "lineHeightPx"],
    nullableMetrics: ["lineHeightPx"],
  });

  assert.deepEqual(problems, [
    { section: "style", field: "fontSize", reason: "null-sample" },
    { section: "style", field: "lineHeight", reason: "empty-sample" },
    { section: "style", field: "fontWeight", reason: "missing-field" },
    { section: "metrics", field: "boxWidth", reason: "null-sample" },
    { section: "metrics", field: "glyphWidth", reason: "missing-field" },
  ]);
});

test("8/8 top-level shapes are explicit; empty schema is structural-only and tolerance above 1px is rejected", () => {
  assert.deepEqual(validateSnapshotContract(null), [
    { section: "snapshot", field: null, reason: "missing-snapshot" },
  ]);
  assert.deepEqual(validateSnapshotContract([]), [
    { section: "snapshot", field: null, reason: "invalid-snapshot-shape" },
  ]);
  assert.deepEqual(validateSnapshotContract({ found: false }), [
    { section: "snapshot", field: null, reason: "not-found" },
  ]);
  // Optional/empty schema means only top-level shape was checked. It is not
  // evidence that a browser probe sampled all required style/metric fields.
  assert.deepEqual(validateSnapshotContract({ found: true }, null), []);
  assert.deepEqual(validateSnapshotContract({ found: true }, {}), []);
  assert.deepEqual(validateSnapshotContract({ found: true }, []), [
    { section: "schema", field: null, reason: "invalid-schema-shape" },
  ]);

  assert.throws(() => diffFieldMaps({}, {}, { tolerancePx: -1 }), /between 0 and 1 CSS px/);
  assert.throws(() => diffFieldMaps({}, {}, { tolerancePx: Number.NaN }), /between 0 and 1 CSS px/);
  assert.throws(() => diffFieldMaps({}, {}, { tolerancePx: 1.0001 }), /between 0 and 1 CSS px/);
  assert.throws(() => diffFieldMaps({}, {}, { tolerancePx: 1000 }), /between 0 and 1 CSS px/);
});
