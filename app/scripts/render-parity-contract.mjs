// Strict, pure comparison primitives for Reader/Live render-parity contracts.
//
// This module is deliberately independent from the browser harness so contract
// semantics can be unit-tested without Chromium. The existing harness can adopt
// these helpers in a follow-up owned by the render-parity branch.
//
// Key rules:
// - compare the union of fields (never left-to-right only);
// - missing is distinct from present null and numeric zero;
// - semantic style/typography/spacing fields are exact;
// - only an explicit set of geometry metrics may use a bounded <=1 CSS px tolerance;
// - non-finite numeric samples fail closed even when both sides are identical;
// - snapshot shape validation reports missing/null/non-finite samples explicitly.

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const MAX_GEOMETRY_TOLERANCE_PX = 1;

export const GEOMETRY_TOLERANCE_FIELDS = new Set([
  "metrics.boxWidth",
  "metrics.boxHeight",
  "metrics.glyphWidth",
  "metrics.glyphHeight",
  "metrics.glyphTopFromBoxTop",
  "metrics.flowBlockHeight",
]);

export function comparableNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))px$/.exec(value);
  return match ? Number(match[1]) : null;
}

function assertFieldMap(value, label) {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be a non-array object`);
  }
  return value;
}

export function diffFieldMaps(leftFields, rightFields, options = {}) {
  const left = assertFieldMap(leftFields, "leftFields");
  const right = assertFieldMap(rightFields, "rightFields");
  if (!isRecord(options)) throw new TypeError("options must be a non-array object");

  const {
    kind = "",
    comparison = "",
    tolerancePx = 0,
  } = options;
  if (!Number.isFinite(tolerancePx) || tolerancePx < 0 || tolerancePx > MAX_GEOMETRY_TOLERANCE_PX) {
    throw new TypeError(`tolerancePx must be a finite number between 0 and ${MAX_GEOMETRY_TOLERANCE_PX} CSS px`);
  }

  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const diffs = [];

  for (const field of fields) {
    const leftPresent = hasOwn(left, field);
    const rightPresent = hasOwn(right, field);
    const leftValue = leftPresent ? left[field] : null;
    const rightValue = rightPresent ? right[field] : null;

    if (!leftPresent || !rightPresent) {
      diffs.push({
        kind,
        comparison,
        field,
        left: leftValue,
        right: rightValue,
        leftPresent,
        rightPresent,
        delta: null,
        reason: "missing-field",
      });
      continue;
    }

    const leftNonFinite = typeof leftValue === "number" && !Number.isFinite(leftValue);
    const rightNonFinite = typeof rightValue === "number" && !Number.isFinite(rightValue);
    if (leftNonFinite || rightNonFinite) {
      diffs.push({
        kind,
        comparison,
        field,
        left: leftValue,
        right: rightValue,
        leftPresent: true,
        rightPresent: true,
        delta: null,
        reason: "non-finite-sample",
      });
      continue;
    }

    if (Object.is(leftValue, rightValue)) continue;

    const leftNumber = comparableNumber(leftValue);
    const rightNumber = comparableNumber(rightValue);
    if (leftNumber !== null && rightNumber !== null) {
      const delta = Math.abs(leftNumber - rightNumber);
      const fieldTolerance = GEOMETRY_TOLERANCE_FIELDS.has(field) ? tolerancePx : 0;
      if (delta > fieldTolerance) {
        diffs.push({
          kind,
          comparison,
          field,
          left: leftValue,
          right: rightValue,
          leftPresent: true,
          rightPresent: true,
          delta,
          reason: "numeric-delta",
        });
      }
      continue;
    }

    diffs.push({
      kind,
      comparison,
      field,
      left: leftValue,
      right: rightValue,
      leftPresent: true,
      rightPresent: true,
      delta: null,
      reason: "value-mismatch",
    });
  }

  return diffs;
}

function requiredFieldProblems(sectionName, values, requiredFields, nullableFields) {
  const problems = [];
  const section = isRecord(values) ? values : {};
  const nullable = new Set(Array.isArray(nullableFields) ? nullableFields : []);

  for (const field of Array.isArray(requiredFields) ? requiredFields : []) {
    if (!hasOwn(section, field)) {
      problems.push({ section: sectionName, field, reason: "missing-field" });
      continue;
    }
    const value = section[field];
    if (value == null && !nullable.has(field)) {
      problems.push({ section: sectionName, field, reason: "null-sample" });
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      problems.push({ section: sectionName, field, reason: "non-finite-sample" });
      continue;
    }
    if (sectionName === "style" && value === "" && !nullable.has(field)) {
      problems.push({ section: sectionName, field, reason: "empty-sample" });
    }
  }

  return problems;
}

export function validateSnapshotContract(snapshot, schema = {}) {
  if (snapshot == null) {
    return [{ section: "snapshot", field: null, reason: "missing-snapshot" }];
  }
  if (!isRecord(snapshot)) {
    return [{ section: "snapshot", field: null, reason: "invalid-snapshot-shape" }];
  }
  if (schema == null) schema = {};
  if (!isRecord(schema)) {
    return [{ section: "schema", field: null, reason: "invalid-schema-shape" }];
  }
  if (snapshot.found !== true) {
    return [{ section: "snapshot", field: null, reason: "not-found" }];
  }

  return [
    ...requiredFieldProblems(
      "style",
      snapshot.style,
      schema.requiredStyleProps,
      schema.nullableStyleProps,
    ),
    ...requiredFieldProblems(
      "metrics",
      snapshot.metrics,
      schema.requiredMetrics,
      schema.nullableMetrics,
    ),
  ];
}
