// P4 / Task 23 — the credential's frozen ceiling and its committed epoch.
//
// Contract: design §5.2 and §7. An OAuth token carries the `grantCeiling` it was
// consented with, and an actor must state the epoch the permission state commits.
// Both facts live in the imported state, which only the composition root holds, so
// the adapters cannot read them and must not invent them: `null` reads as "does not
// tighten" (a narrow token would then look like its wider account) and `0` reads as a
// stale credential as soon as a state commits an epoch above zero.
//
// One module slot, read at call time, last install wins (the same shape as
// `installGitShadow`). Nothing here decides anything, and an unreadable source states
// nothing instead of guessing.

import { subjectsFromAuthInfo } from "../access-policy/subjects.js";

let factsSource = () => null;

/** Install the credential-facts source (P4). Never used for a decision. */
export function installCredentialFacts(source) {
  factsSource = typeof source === "function" ? source : () => null;
}

/** The installed facts for one verified credential, or `null` when none are stated. */
export function credentialFactsFor(authInfo) {
  if (authInfo === null || typeof authInfo !== "object") return null;
  try {
    const facts = factsSource(authInfo);
    return facts !== null && typeof facts === "object" ? facts : null;
  } catch (error) {
    // A broken source states nothing, and the adapter then falls back to the legacy
    // defaults. Say so once, because that fallback widens a narrow credential.
    console.warn("credential facts unavailable:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * `credentialFacts({authInfo, envelopes}) -> {grantCeiling, epochs}`
 *
 * `envelopes` is the import's credential envelope map, keyed by the token record id the
 * verifier states (`authInfo.tokenId`).
 *
 * The epoch is the one the credential was issued with (`authorization.subjectEpochs`), never
 * the epoch the state commits now (design §7 and §10 step 7): reading the live epoch would
 * re-validate a credential the state has already revoked, and a single stale field would
 * refuse a valid one. A credential with no envelope, or no entry for the subject, states the
 * legacy default 0 — which is what the import records for every subject today.
 *
 * shortcut: a managed API key's frozen `authorizationEpoch` arrives with the migration, so a
 * key still states 0 here; upgrade when the migration writes that field.
 */
export function credentialFacts({ authInfo, envelopes = null } = {}) {
  const tokenId = typeof authInfo?.tokenId === "string" ? authInfo.tokenId : "";
  const envelope = tokenId.length > 0 && envelopes !== null && typeof envelopes === "object" && Object.hasOwn(envelopes, tokenId)
    ? envelopes[tokenId]
    : null;
  const ceiling = envelope?.authorization?.grantCeiling;
  const frozen = envelope?.authorization?.subjectEpochs;
  const epochs = {};
  for (const subjectId of subjectsFromAuthInfo(authInfo)) {
    const value = frozen !== null && typeof frozen === "object" && Object.hasOwn(frozen, subjectId) ? frozen[subjectId] : null;
    epochs[subjectId] = Number.isInteger(value) && value >= 0 ? value : 0;
  }
  return { grantCeiling: Array.isArray(ceiling) ? ceiling : null, epochs };
}
