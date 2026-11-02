// Wave D / D-files — per-request VaultRuntime binding for the files / history / trash / notes
// toolset. Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//   §10.1 transitional compatibility facade — "in an MCP request read the current VaultRuntime;
//         startup / internal code accepts the primary runtime explicitly";
//   §3.4  a capability is a *runtime fact* and an unwired Vault fails closed instead of guessing;
//   §21  MV-I02 (cross-Vault independence) / MV-I03 (no context bleed) / MV-I07 (primary compat);
//   §43-5 only the allowlisted `src/vault.js` facade imports the global root constants;
//   §47  RETURN list — a selected Vault is never served by the primary runtime.
//
// Why this module exists instead of making `src/vault.js` context-aware: the facade is a frozen
// identity + arity ratchet (`test/vault-runtime-factory-core.test.js`: `facade.resolveVaultPath
// === primaryRuntime.localFs.resolveVaultPath`, every legacy export keeps `fn.length`), so the
// routing must live at the *call sites*. This module is the one drop-in import surface those
// call sites use instead of the facade: it re-exports the exact same names, with every root-bound
// primitive resolved against the current request's VaultRuntime and every root-free helper passed
// straight through.
//
// Resolution rule (`currentVaultRuntime`):
//   * no request context — startup, Web/Admin routes, background recovery, direct unit calls, and
//     the whole pre-Wave-D call surface — keeps the exact legacy primary behaviour (§10.1);
//   * a context whose selection is absent (C's registrar always injects `vaultId`, so this is the
//     "internal caller" shape) keeps the legacy primary behaviour;
//   * a context that selected a Vault **with** a materialized runtime uses that instance
//     (SEC-MV06: never the primary one);
//   * a context that selected a Vault **without** a materialized runtime is refused structurally
//     (§3.4/§47) — the handler sees `code: "vault_unavailable"`, never the primary Vault.
//
// This module reads no `config.js` constant and holds no module-level mutable state (§43-5,
// SEC-MV07); the only root it can reach is the injected `src/vault.js` primary runtime, which is
// itself the allowlisted facade.

import { requestContext } from "../request-context.js";
import { primaryRuntime } from "../vault.js";

/** Stable machine-readable refusal code (same vocabulary the registrar's deny payload uses). */
export const VAULT_UNAVAILABLE = "vault_unavailable";

function vaultUnavailable(vaultId) {
  return Object.assign(
    new Error(`[${VAULT_UNAVAILABLE}] no materialized VaultRuntime for ${JSON.stringify(vaultId)}; refusing to serve it with the primary Vault (contract §47)`),
    { code: VAULT_UNAVAILABLE, vaultId },
  );
}

/**
 * The VaultRuntime that owns the current call.
 * @returns {object} a VaultRuntime (`{id, root, primary, paths, localFs, capabilities}`)
 * @throws {Error & {code: "vault_unavailable"}} when the request selected a Vault that has no
 *   materialized runtime (fail closed; never the primary instance).
 */
export function currentVaultRuntime() {
  const context = requestContext();
  const vaultId = context?.vaultId;
  if (typeof vaultId !== "string" || vaultId === "") return primaryRuntime;
  const runtime = context.vaultRuntime;
  if (runtime !== null && typeof runtime === "object" && runtime.localFs) return runtime;
  throw vaultUnavailable(vaultId);
}

/** The root-bound filesystem service of the current call's Vault. */
export function currentLocalFs() {
  return currentVaultRuntime().localFs;
}

// ---------------------------------------------------------------------------
// Root-free helpers — identical to the facade (no per-Vault state involved).
// ---------------------------------------------------------------------------
export {
  assertCanonicalInsideRoot,
  assertWritable,
  decodeLinkTarget,
  exists,
  ensureParent,
  fileExtension,
  hasExtension,
  hasNumericExtension,
  isAcceptedObsidianFile,
  isTextFile,
  normalizeVaultInput,
  stripMarkdownExtension,
} from "../vault.js";

// ---------------------------------------------------------------------------
// Root-bound primitives — resolved per request. Arity is not ratcheted here (only the facade is),
// so thin spreads keep the call sites unchanged; every default argument is applied by the
// instance method, exactly as before.
// ---------------------------------------------------------------------------
const bind = (name) => (...args) => currentLocalFs()[name](...args);

export const assertInsideVault = bind("assertInsideVault");
export const assertCanonicalInsideVault = bind("assertCanonicalInsideVault");
export const openCanonicalVaultFile = bind("openCanonicalVaultFile");
export const assertNotVaultRoot = bind("assertNotVaultRoot");
export const resolveVaultPath = bind("resolveVaultPath");
export const resolveCanvasPath = bind("resolveCanvasPath");
export const toVaultPath = bind("toVaultPath");
export const normalizeNotePath = bind("normalizeNotePath");
export const resolveTrashPath = bind("resolveTrashPath");
export const toTrashPath = bind("toTrashPath");
export const ensureVaultParent = bind("ensureVaultParent");
export const fileRevision = bind("fileRevision");
export const assertRevision = bind("assertRevision");
export const withMutationLock = bind("withMutationLock");
export const atomicWriteFile = bind("atomicWriteFile");
export const createVersionSnapshot = bind("createVersionSnapshot");
export const listFileVersions = bind("listFileVersions");
export const readFileVersion = bind("readFileVersion");
export const restoreFileVersion = bind("restoreFileVersion");
export const readLimitedText = bind("readLimitedText");
export const walk = bind("walk");
export const allMarkdownFiles = bind("allMarkdownFiles");
export const backupBeforeDelete = bind("backupBeforeDelete");
export const listTrashEntries = bind("listTrashEntries");
export const readTrashEntry = bind("readTrashEntry");
export const restoreTrashEntry = bind("restoreTrashEntry");
export const deleteTrashEntry = bind("deleteTrashEntry");
export const deleteFileVersion = bind("deleteFileVersion");
export const getVaultHealth = bind("getVaultHealth");
