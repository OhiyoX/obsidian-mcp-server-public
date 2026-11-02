// Write-surface amplification budget for the `.base` increment
// (WRITE-SURFACE-DESIGN.md §4.4 "单请求 `mutations` 上限 512 条 / 256 KB",
// §5.3 "`mutations` 条数 | 512 / 请求 | 防放大攻击").
//
// Why this is its own module: `patchBaseDocument` costs O(document bytes × mutations)
// — the block locator walks the document once per mutation — so an unbounded array
// turns one authenticated PATCH into minutes of *synchronous* event-loop CPU (a 2 MB
// body still admits ≈35 000 mutations; measured 70 s for 5 000 mutations on a 421 KB
// document). The budget is a property of the *write face*, not of the mutation face,
// so it lives here and is enforced by the two entry points of that face:
//
//   `base-patch-route.js`   before the domain function is entered (early, so the
//                           Vault lookup, the lock, the read and the YAML parse never
//                           happen for an over-limit increment);
//   `vault-registry.js`     `writeWebBasePatch`'s own first statements, in front of
//                           the lock / the document read / the YAML parse, so any
//                           non-HTTP caller is bounded by the same number.
//
// A non-array `mutations` is deliberately *not* refused here: a malformed increment
// stays `invalid-schema` (400) from the mutation face, and answering 413 "too large"
// for "not an array" would misstate the problem. A value that cannot even be
// serialized (pathological nesting) fails closed as over budget instead of escaping
// as a 500.
export const MAX_PATCH_MUTATIONS = 512;
export const MAX_PATCH_MUTATION_BYTES = 256 * 1024;

/**
 * Refuse an over-budget increment.
 * @param {unknown} mutations the request increment (`mutations` array of A4a ops)
 * @throws {Error} `code = "BASE_MUTATIONS_TOO_LARGE"` (413 at the route), carrying
 *   `count`, `bytes` (null when unmeasurable) and `limits`
 */
export function assertMutationBudget(mutations) {
  if (!Array.isArray(mutations)) return;
  const count = mutations.length;
  let bytes;
  try {
    // The design's limit is on the increment itself, so the serialized array is the
    // measured surface (not the request body, which also carries path/precondition).
    bytes = Buffer.byteLength(JSON.stringify(mutations) ?? "", "utf8");
  } catch {
    bytes = Number.POSITIVE_INFINITY;
  }
  if (count <= MAX_PATCH_MUTATIONS && bytes <= MAX_PATCH_MUTATION_BYTES) return;
  const error = new Error(
    `Too many mutations: ${count} of at most ${MAX_PATCH_MUTATIONS} entries and ${bytes} of at most ${MAX_PATCH_MUTATION_BYTES} bytes`,
  );
  error.name = "BasePatchBudgetError";
  error.code = "BASE_MUTATIONS_TOO_LARGE";
  error.count = count;
  error.bytes = Number.isFinite(bytes) ? bytes : null;
  error.limits = { count: MAX_PATCH_MUTATIONS, bytes: MAX_PATCH_MUTATION_BYTES };
  throw error;
}
