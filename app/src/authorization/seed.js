// Task 2 — the one-way seed from the live legacy state (design §7 step 2).
//
// Two halves, neither of which writes on its own. `buildSeedDocument` imports the frozen
// legacy state once and returns the validated document at revision 1. `seedFile` decides
// *whether* there is anything to install, by reading the file. The store performs the write,
// through the one durable CAS path it already owns (`deployment-document`'s seed hook calls
// `store.repair(await seed())`), so a seed and an Admin edit can never become two writers.
//
// A seed never overwrites: an existing file is `{seeded: false}`, and a document the store
// cannot read fails the boot instead of being replaced (§11 C5). Nothing here is a legacy
// fallback: a HOLD from the importer and a read error other than `ENOENT` propagate unchanged,
// so the boot stops with the code that names the reason.
//
// Every refusal also names the *input* it is about, because the boot line tells an operator
// which file to repair. It carries a file's role and never its content.

import { importLegacyAuthorization } from "./legacy-import.js";
import { LEGACY_POLICY_IMPORT_CODES } from "./legacy-policy-import.js";

// The input a refusal points at. Roles, not paths: the boot line is log output.
export const SEED_INPUTS = Object.freeze({
  POLICY_DOCUMENT: "the legacy policy document (access-policy.json)",
  LEGACY_STATE: "the legacy credential state (oauth provider store)",
  DOCUMENT: "the authorization document (authorization.json)",
});

/**
 * `buildSeedDocument({providerSnapshot, policyDocument, timeConstraintsEnabled, primaryVaultId, environmentKey})`
 * -> the imported, validated document with `revision: 1`.
 *
 * The importer keeps its own defaults, so an omitted field is the recorded legacy default and a
 * missing verified provider snapshot is its coded refusal — never an empty document.
 */
export function buildSeedDocument(input = {}) {
  try {
    return importLegacyAuthorization(input).document;
  } catch (error) {
    // A window conversion is the one refusal that reads the legacy policy document; every other
    // refusal reads the frozen credential state.
    if (error !== null && typeof error === "object" && error.input === undefined) {
      error.input = error.code === LEGACY_POLICY_IMPORT_CODES.MIGRATION_HOLD ? SEED_INPUTS.POLICY_DOCUMENT : SEED_INPUTS.LEGACY_STATE;
    }
    throw error;
  }
}

/**
 * `seedRefusalLine(error)` -> the one boot line. It names the failing input and the code, and
 * nothing else: never the message, never the document's content. An uncoded throw reports its
 * error name in the code's place.
 */
export function seedRefusalLine(error) {
  const code = typeof error?.code === "string" ? error.code : `unknown: ${error?.name ?? "Error"}`;
  return `[authorization] refusing to start: the authorization document was not seeded (${code}); repair ${error?.input ?? SEED_INPUTS.DOCUMENT}`;
}

/**
 * `seedFile({file, io, build}) -> {seeded, document}`
 *
 * `seeded: true` plus the document to install when no file exists yet; `seeded: false` with
 * `document: null` when one does. `build` runs only in the first case, so a HOLD cannot stop a
 * boot that already has a document, and a seeded boot never imports the legacy state again.
 */
export async function seedFile({ file, io, build } = {}) {
  // A bad argument here would otherwise refuse the seed and stop the boot with no hint why.
  if (typeof file !== "string" || file.length === 0) throw new TypeError("seedFile needs the document file path");
  try {
    await io.readFile(file);
    return { seeded: false, document: null };
  } catch (error) {
    // Only an absent file is a seed. An unreadable one is a broken state: refuse, and let the
    // caller stop the boot rather than guess that a document is not there.
    if (error?.code !== "ENOENT") throw error;
  }
  return { seeded: true, document: build() };
}
