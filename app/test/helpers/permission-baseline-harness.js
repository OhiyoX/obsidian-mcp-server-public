// P0 / Task 1 — the permission baseline harness.
//
// `comparePermissionRows` is the gate every later phase leans on: if it cannot report a missing
// row, a duplicate key, a flipped verdict or a moved refusal, then "the shadow shows zero
// differences" means nothing. `collectBaselineRows` drives the REAL stack at the pinned baseline
// and turns it into rows; it is filled in by Step 3.

/** Stable identity of a row: every dimension that decides an answer. */
function rowKey(row) {
  return [row.actorCase, row.surface, row.capability, row.targetCase, row.timeCase].join("|");
}

/**
 * Fields that describe the ANSWER, not the question: a change here is a permission change.
 * `status` and `targetVaultObserved` are answers too — a 403 that becomes a 200, or a resource that
 * starts reading another Vault, must not slip through because nobody compared that column.
 */
const ANSWER_FIELDS = Object.freeze(["allowed", "errorFamily", "denialPoint", "status", "targetVaultObserved"]);

/** Refusal points that must never be reached by a request that already ran a handler. */
const GATE_POINTS = new Set(["transport", "csrf", "authorization", "validation", "rate_limit", "routing"]);

/** Fields that must never move: a refusal or an allow that reached content I/O is a defect. */
const INVARIANT_FIELDS = Object.freeze(["handlerCalls", "contentIo"]);

/**
 * Points that are, by definition, reached before any handler runs. A refusal reported at one of
 * them while a handler counted means the gate is downstream of the work it is supposed to stop.
 * `operation` is the only point where the handler itself must run to produce the refusal, so every
 * other refusal point belongs here — a narrower list would miss a mislabelled row.
 */
const PRE_HANDLER_POINTS = Object.freeze(["transport", "authorization", "csrf", "validation", "rate_limit", "routing", "operation_gate"]);

/**
 * Compare the expected baseline rows with the rows a run actually produced.
 *
 * `allowed: "unknown"` is never equal to `false`: an inconclusive observation must not be filed
 * as a denial, or a broken collector would report a clean migration.
 */
export function comparePermissionRows(expected, actual) {
  const differences = [];
  const index = (rows, side) => {
    const map = new Map();
    for (const row of rows) {
      const key = rowKey(row);
      if (map.has(key)) differences.push({ kind: `${side}-duplicate`, key, expected: map.get(key), actual: row });
      map.set(key, row);
    }
    return map;
  };
  const expectedMap = index(expected, "expected");
  const actualMap = index(actual, "actual");

  for (const [key, want] of expectedMap) {
    const got = actualMap.get(key);
    if (!got) {
      differences.push({ kind: "missing", key, expected: want, actual: null });
      continue;
    }
    for (const field of ANSWER_FIELDS) {
      const unknown = want[field] === "unknown" || got[field] === "unknown";
      if (unknown) {
        if (want[field] !== got[field]) differences.push({ kind: "unknown", field, key, expected: want[field], actual: got[field] });
        else differences.push({ kind: "inconclusive", field, key, expected: want[field], actual: got[field] });
        continue;
      }
      if (want[field] !== got[field]) differences.push({ kind: "mismatch", field, key, expected: want[field], actual: got[field] });
    }
    for (const field of INVARIANT_FIELDS) {
      if (want[field] !== got[field]) differences.push({ kind: "invariant", field, key, expected: want[field], actual: got[field] });
    }
    // A refusal named as pre-handler must not have reached a handler; an `operation` refusal is
    // produced BY the handler and is expected to count one entry.
    if (got.allowed === false && got.handlerCalls > 0 && PRE_HANDLER_POINTS.includes(got.denialPoint)) {
      differences.push({ kind: "leak", field: "handlerCalls", key, expected: 0, actual: got.handlerCalls });
    }
  }

  for (const [key, got] of actualMap) {
    if (!expectedMap.has(key)) differences.push({ kind: "unexpected", key, expected: null, actual: got });
  }
  return differences;
}

/** The row key, exported so fixtures and the collector agree on identity. */
export { rowKey };
