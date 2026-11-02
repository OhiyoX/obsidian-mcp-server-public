// SortSpec — the lazy Tree request identity (lazy Tree sorting adaptation).
//
// The strict global browser preference in `sort-preference.js` decides the
// `{key,direction}` choice. This module wraps that choice into the versioned,
// immutable request identity that every lazy Tree request captures and that every
// response, error, `finally`, 503 retry and locate/anchor continuation must
// re-validate before it may write state.
//
// It introduces no backend field: `sortSpecQuery()` only renames the frozen
// children-API parameters `sort`/`direction`.
import { coerceExplorerSort, EXPLORER_SORT_VERSION } from "./sort-preference.js";

export const EXPLORER_SORT_SPEC_VERSION = EXPLORER_SORT_VERSION;

// Always a fresh, frozen, strictly normalized `{version,key,direction}`.
export function normalizeSortSpec(value) {
  const choice = coerceExplorerSort(value);
  return Object.freeze({
    version: EXPLORER_SORT_SPEC_VERSION,
    key: choice.key,
    direction: choice.direction,
  });
}

export function sortSpecEquals(left, right) {
  return Boolean(left) && Boolean(right)
    && left.version === right.version
    && left.key === right.key
    && left.direction === right.direction;
}

// Existing children-API parameters only; no new backend field, no auth/channel
// semantics.
export function sortSpecQuery(spec) {
  const normalized = normalizeSortSpec(spec);
  return { sort: normalized.key, direction: normalized.direction };
}
