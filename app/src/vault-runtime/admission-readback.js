// W2FIX3 (#437 RETURN 2, item 2) — the read-back trust rule of the admission store.
//
// Split out of `admission-store.js` (line budget) as one cohesive unit: "may a freshly read record
// replace the trusted in-memory state?". It is about a read-back only — the durable FLOOR checks
// (sentinel revision/generation) live in `admission-document.js`.
//
// A read-back must never move the trusted state backwards:
//   * an older revision (the seat's restored-old-record repro) must not revert a newer refusal;
//   * at the SAME revision the content must be identical (a divergence is a partially applied or
//     foreign write, not a valid replacement).
// Returns `null` when the read-back is trusted, or a structured refusal error.

export const ADMISSIONS_RELOAD_REFUSED = "VAULT_ADMISSIONS_RELOAD_REFUSED";

export function trustedReadbackRefusal(candidate, trusted) {
  if (candidate.revision < trusted.revision) {
    return Object.assign(new Error(
      `refusing to read back revision ${candidate.revision}: the trusted in-memory state is already at revision ${trusted.revision} ` +
        "(an older record must never revert a newer refusal, contract §2.2/item 2)",
    ), { code: ADMISSIONS_RELOAD_REFUSED });
  }
  if (candidate.revision === trusted.revision && JSON.stringify(candidate) !== JSON.stringify(trusted)) {
    return Object.assign(new Error(
      `refusing the read-back of revision ${candidate.revision}: its content differs from the trusted state committed at the same revision ` +
        "(a same-revision divergence is not a valid replacement, contract §2.2)",
    ), { code: ADMISSIONS_RELOAD_REFUSED });
  }
  return null;
}
