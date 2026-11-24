// M4 — vector norms and cosine parity (plan 03 Task 2).
import assert from "node:assert/strict";
import test from "node:test";

import { cosineWithNorms, vectorNorm } from "../src/vault-runtime/retrieval-vector-math.js";

function legacyCosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : null;
}

const random = (() => {
  let seed = 42;
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
})();

test("cosine with precomputed norms is bit-identical to the inline form", () => {
  for (const dimension of [1, 3, 16, 768]) {
    const left = Float32Array.from({ length: dimension }, () => random());
    const right = Float32Array.from({ length: dimension }, () => random());
    const expected = legacyCosine(left, right);
    const actual = cosineWithNorms(left, right, vectorNorm(left), vectorNorm(right));
    assert.equal(actual, expected, `dimension ${dimension}`);
    const cached = cosineWithNorms(left, right, vectorNorm(left), vectorNorm(right));
    assert.equal(cached, actual);
  }
});

test("plain number arrays and typed arrays give the same value", () => {
  const left = [0.25, -0.5, 0.75];
  const right = [1, 0, -1];
  assert.equal(cosineWithNorms(left, right), legacyCosine(left, right));
  assert.equal(cosineWithNorms(Float32Array.from(left), Float32Array.from(right)), legacyCosine(Float32Array.from(left), Float32Array.from(right)));
});

test("zero, empty and mismatched vectors answer null, as before", () => {
  assert.equal(legacyCosine([0, 0], [1, 1]), null);
  assert.equal(cosineWithNorms([0, 0], [1, 1]), null);
  assert.equal(vectorNorm([0, 0]), 0);
  assert.equal(vectorNorm([]), null);
  assert.equal(vectorNorm(null), null);
  assert.equal(cosineWithNorms([], []), null);
  assert.equal(cosineWithNorms([1, 2], [1, 2, 3]), null);
  assert.equal(cosineWithNorms(undefined, [1]), null);
});

test("non-finite components are refused instead of poisoning a score", () => {
  assert.equal(vectorNorm([1, Number.NaN]), null);
  assert.equal(vectorNorm([1, Infinity]), null);
  assert.equal(cosineWithNorms([1, 2], [1, Number.NaN]), null);
});

test("a supplied norm is respected and defaults are computed", () => {
  const left = [3, 4];
  const right = [4, 3];
  assert.equal(cosineWithNorms(left, right, 25, 25), (12 + 12) / 25);
  assert.equal(cosineWithNorms(left, right), legacyCosine(left, right));
});
