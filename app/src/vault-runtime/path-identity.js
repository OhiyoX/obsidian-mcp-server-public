// W2FIX3 (#437 RETURN 2, item 1) — configured-path independence for the TWO durable admission files.
//
// The managed-mode sentinel exists ONLY as long as it is an independent file: if the authoritative
// record and the sentinel resolve to the SAME actual file, a record-only delete takes the sentinel
// with it and a restarted instance falls back to legacy (the seat's §2.1 counterexample). The check
// therefore has to be about the *actual target*, not the configured text:
//
//   * lexical layer (sync, always): `path.resolve` normalizes `.`/`..`/trailing separators, and the
//     comparison folds case on the platforms whose default filesystems are case-insensitive
//     (win32/darwin) so `C:\data\A.json` and `c:\data\a.json` are refused;
//   * real-target layer (async, when the fs API can `realpath`): the nearest existing ancestor of
//     each configured path is realpath'd and the non-existent tail re-appended, so a symlinked or
//     junctioned parent directory that aliases the other file is refused too.
//
// Fail-closed: a conflict throws BEFORE any read/write of either file, so no operation can overwrite
// one file with the other. This module performs no I/O of its own beyond the injected `fsApi`.

import path from "node:path";

/** Stable machine-readable conflict code (consumers/tests never match on prose). */
export const ADMISSION_PATH_CONFLICT = "VAULT_ADMISSION_ENROLLMENT_PATH_CONFLICT";

function conflict(file, enrollmentFile, detail) {
  return Object.assign(
    new Error(
      `[${ADMISSION_PATH_CONFLICT}] the admissions record (${JSON.stringify(file)}) and the managed-mode sentinel ` +
        `(${JSON.stringify(enrollmentFile)}) must be two DIFFERENT files (${detail}); refusing to run with an unenforceable ` +
        "managed-mode sentinel (contract §2.2/item 1)",
    ),
    { code: ADMISSION_PATH_CONFLICT },
  );
}

function isCaseInsensitive(platform) {
  return platform === "win32" || platform === "darwin";
}

function fold(value, platform) {
  const resolved = path.resolve(value);
  return isCaseInsensitive(platform) ? resolved.toLowerCase() : resolved;
}

/**
 * Lexical comparison of two configured paths as "the same file on this platform". Handles `.`/`..`
 * and trailing separators (`path.resolve`) plus platform case folding. Sync, no I/O.
 */
export function sameConfiguredPath(left, right, platform = process.platform) {
  return fold(left, platform) === fold(right, platform);
}

/**
 * Sync pre-validation for a store/composition-root constructor: refuse an exactly (or lexically)
 * colliding configuration before anything is created. Returns nothing; throws on conflict.
 */
export function assertDistinctAdmissionPaths({ file, enrollmentFile, platform = process.platform } = {}) {
  if (typeof file !== "string" || typeof enrollmentFile !== "string") return;
  if (sameConfiguredPath(file, enrollmentFile, platform)) {
    throw conflict(file, enrollmentFile, "they resolve to the same normalized path");
  }
}

/**
 * Resolve the *actual* target of a (possibly not-yet-existing) path: realpath the nearest existing
 * ancestor, then re-append the part that did not exist. Only ENOENT/ENOTDIR are tolerated as "not
 * there yet"; any other fs error propagates to the caller (fail closed).
 */
async function resolveExistingAnchor(fsApi, target) {
  let anchor = path.resolve(target);
  const remainder = [];
  for (;;) {
    try {
      const real = await fsApi.realpath(anchor);
      return remainder.length === 0 ? real : path.join(real, ...remainder);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(anchor);
      if (parent === anchor) return remainder.length === 0 ? anchor : path.join(anchor, ...remainder);
      remainder.unshift(path.basename(anchor));
      anchor = parent;
    }
  }
}

/**
 * Async real-target pre-validation, called before any read or write. When the injected fs API cannot
 * `realpath` (a minimal test double), the lexical check has already run and this is a no-op.
 */
export async function assertDistinctAdmissionPathsReal({ file, enrollmentFile, fsApi, platform = process.platform } = {}) {
  if (typeof file !== "string" || typeof enrollmentFile !== "string") return;
  assertDistinctAdmissionPaths({ file, enrollmentFile, platform });
  if (fsApi === null || typeof fsApi !== "object" || typeof fsApi.realpath !== "function") return;
  const [realFile, realEnrollment] = await Promise.all([
    resolveExistingAnchor(fsApi, file),
    resolveExistingAnchor(fsApi, enrollmentFile),
  ]);
  if (fold(realFile, platform) === fold(realEnrollment, platform)) {
    throw conflict(file, enrollmentFile, `both resolve to the same actual target ${JSON.stringify(realFile)}`);
  }
}
