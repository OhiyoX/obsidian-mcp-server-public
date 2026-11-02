// A7 — Per-vault data path layout (pure foundation).
//
// Contract: "DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置"
//   §5.1 primary compatibility  (legacy data paths stay exactly as they are)
//   §5.2 secondary data layout  (DATA_PATH/vaults/<dataKey>/...)
//   §22.2                       (primary persisted data is never migrated)
//   §26 A7                      (NEW vault-runtime/paths.js + layout tests)
//   §43-5                       (a new Vault-dependent module must not import the global
//                                VAULT/HISTORY_PATH/TRASH_PATH/RETRIEVAL_INDEX_PATH constants)
//
// This module is a *pure layout calculator*:
//   - every input is an explicit parameter (dataRoot / dataKey / primary legacy values);
//   - no environment reads, no `config.js` import, no module-level mutable state;
//   - no filesystem access and no side effect: it names paths, it never creates, moves or
//     migrates anything (directory creation and migration belong to A2 and to B1..B6).
//
// Reason for the split: every consumer (registry, fs service, index, retrieval, transfer,
// plan/journal, Git) must agree byte-for-byte on the same per-vault paths, and the primary
// runtime must keep the current legacy paths until an explicit, separately reviewed
// migration exists (§22.2).

import path from "node:path";

/** Keys of the primary (legacy) mapping, contract §5.1. */
export const PRIMARY_PATH_KEYS = Object.freeze([
  "history",
  "trash",
  "retrievalIndex",
  "transfersUploads",
  "mutationJournal",
  "mutationIdempotency",
]);

/** Keys of the secondary layout, contract §5.2. */
export const SECONDARY_PATH_KEYS = Object.freeze([
  "root",
  "history",
  "trash",
  "retrievalIndex",
  "transfersUploads",
  "mutationJournal",
  "mutationIdempotency",
]);

/** `<dataRoot>/vaults/<dataKey>` — the per-vault protected data root (§5.2). */
const SECONDARY_VAULTS_DIR = "vaults";

// §3.3: dataKey is the full sha256 hex digest of the vault id. Enforcing the exact shape
// here is fail-closed defense-in-depth for SEC-MV01 root containment: a key can never
// contribute a separator, a `.`/`..` segment, a drive letter or a NUL byte. A future key
// format change is a contract change, not a silent relaxation of this guard.
const DATA_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * True when `value` is a canonical vault dataKey (64 lowercase hex characters, §3.3).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isVaultDataKey(value) {
  return typeof value === "string" && DATA_KEY_PATTERN.test(value);
}

function fail(message) {
  throw new Error(`vault-runtime/paths: ${message}`);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertDataKey(value) {
  if (!isVaultDataKey(value)) {
    fail("dataKey must be a 64-character lowercase sha256 hex digest");
  }
  return value;
}

/** Absolute dataRoot only: a relative root would silently depend on the process cwd. */
function assertDataRoot(value) {
  if (typeof value !== "string" || value.length === 0) fail("dataRoot must be a non-empty absolute path");
  if (!path.isAbsolute(value)) fail(`dataRoot must be absolute, received ${JSON.stringify(value)}`);
  if (value.includes("\0")) fail("dataRoot must not contain a NUL byte");
  const segments = value.split(/[\\/]+/);
  if (segments.includes("..")) fail("dataRoot must not contain a '..' segment");
  return value;
}

/** Primary legacy values are passed through untouched, but must be usable paths. */
function assertLegacyPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty path string (pass the existing legacy value)`);
  }
  if (value.includes("\0")) fail(`${label} must not contain a NUL byte`);
  return value;
}

function freezeOrdered(entries) {
  const out = {};
  for (const [key, value] of entries) out[key] = value;
  return Object.freeze(out);
}

/**
 * Secondary (per-vault) data layout, contract §5.2:
 *
 * ```text
 * <dataRoot>/vaults/<dataKey>/
 *   history/
 *   trash/
 *   index/retrieval-index.json
 *   transfers/uploads/
 *   mutation-journal/
 *   mutation-idempotency/
 * ```
 *
 * @param {{ dataRoot: string, dataKey: string }} input
 * @returns {Readonly<{ root: string, history: string, trash: string, retrievalIndex: string,
 *   transfersUploads: string, mutationJournal: string, mutationIdempotency: string }>}
 */
export function secondaryVaultDataPaths(input) {
  const { dataRoot, dataKey } = assertPlainObject(input, "secondaryVaultDataPaths input");
  assertDataRoot(dataRoot);
  assertDataKey(dataKey);
  const root = path.join(dataRoot, SECONDARY_VAULTS_DIR, dataKey);
  return freezeOrdered([
    ["root", root],
    ["history", path.join(root, "history")],
    ["trash", path.join(root, "trash")],
    ["retrievalIndex", path.join(root, "index", "retrieval-index.json")],
    ["transfersUploads", path.join(root, "transfers", "uploads")],
    ["mutationJournal", path.join(root, "mutation-journal")],
    ["mutationIdempotency", path.join(root, "mutation-idempotency")],
  ]);
}

/**
 * Primary (legacy) data paths, contract §5.1 / §22.2. The caller passes the *current*
 * values (today: HISTORY_PATH, TRASH_PATH, RETRIEVAL_INDEX_PATH, DATA_PATH/transfers/uploads,
 * DATA_PATH/mutation-journal, DATA_PATH/mutation-idempotency) and gets them back unchanged —
 * this function never re-derives, normalizes or relocates primary state.
 *
 * @param {{ history: string, trash: string, retrievalIndex: string, transfersUploads: string,
 *   mutationJournal: string, mutationIdempotency: string }} input
 * @returns {Readonly<{ history: string, trash: string, retrievalIndex: string,
 *   transfersUploads: string, mutationJournal: string, mutationIdempotency: string }>}
 */
export function primaryVaultDataPaths(input) {
  const legacy = assertPlainObject(input, "primaryVaultDataPaths input");
  const entries = PRIMARY_PATH_KEYS.map((key) => [key, assertLegacyPath(legacy[key], key)]);
  return freezeOrdered(entries);
}

/**
 * Dispatcher: `primary: true` returns the untouched legacy mapping, otherwise the
 * secondary layout. `primary` has no default — a silent fallback would be a
 * confused-deputy risk (SEC-MV06: no fallback onto primary state).
 *
 * @param {{ primary: boolean, dataRoot?: string, dataKey?: string } & Record<string, unknown>} input
 */
export function vaultDataPaths(input) {
  const { primary } = assertPlainObject(input, "vaultDataPaths input");
  if (typeof primary !== "boolean") fail("vaultDataPaths input.primary must be a boolean");
  return primary ? primaryVaultDataPaths(input) : secondaryVaultDataPaths(input);
}

/**
 * Directories that must exist (recursive creation) before this runtime is first enabled
 * (§22.3 for secondary, idempotent for primary). The retrieval index *file* is not included; only its
 * parent directory. Order is stable and parent-first, so consumers may create them in order.
 *
 * @param {{ root?: string, history: string, trash: string, retrievalIndex: string,
 *   transfersUploads: string, mutationJournal: string, mutationIdempotency: string }} paths
 * @returns {string[]}
 */
export function requiredDirectories(paths) {
  const layout = assertPlainObject(paths, "requiredDirectories paths");
  const candidates = [];
  if (layout.root !== undefined) candidates.push(assertLegacyPath(layout.root, "root"));
  for (const key of PRIMARY_PATH_KEYS) {
    const value = assertLegacyPath(layout[key], key);
    candidates.push(key === "retrievalIndex" ? path.dirname(value) : value);
  }
  return [...new Set(candidates)];
}
