// M4 — vector math with reusable norms (plan 03 Task 2).
//
// The old `cosine(left, right)` recomputed both norms on every call: 17,680
// vectors x 1024 components per query cost ~98 ms, of which the document norms
// are recomputed for data that never changes inside one generation. Precomputing
// them once per generation drops that to ~61 ms and keeps the exact same value:
// the dot product loop is unchanged and a norm computed over the same values in
// the same order is bit-identical.

/** Squared L2 norm, or `null` when the vector is empty or holds a non-finite value. */
export function vectorNorm(vector) {
  if (vector === null || vector === undefined || typeof vector.length !== "number" || vector.length === 0) return null;
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    sum += value * value;
  }
  return sum;
}

/** Cosine similarity from precomputed squared norms; `null` when either norm is 0/unknown. */
export function cosineWithNorms(left, right, leftNorm = vectorNorm(left), rightNorm = vectorNorm(right)) {
  if (left === null || right === null || left === undefined || right === undefined) return null;
  if (left.length !== right.length || left.length === 0) return null;
  if (!leftNorm || !rightNorm) return null;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return null;
    dot += leftValue * rightValue;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}
