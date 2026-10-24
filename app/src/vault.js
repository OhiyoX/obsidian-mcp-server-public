// `src/vault.js` — transitional compatibility facade (contract §10.1 "Transitional
// compatibility facade", §43-5 facade allowlist, §5.1 primary compatibility).
//
// The implementation moved to `vault-runtime/local-fs.js` (root-bound service) and is
// instantiated once, here, for the legacy primary Vault from `config.js` values (contract
// §5.1: primary keeps today's history / trash / data paths). Every export below keeps its
// exact previous name, signature and behavior, so callers (`tools/**`, `obsidian.js`,
// `batch-write.js`, Web routes) are unchanged — that is this lane's acceptance criterion.
//
// This module is the §43-5 allowlisted facade: it is the only core module that may import
// the global VAULT / DATA_PATH / TRASH_PATH / HISTORY_PATH / RETRIEVAL_INDEX_PATH to build a
// runtime. It must not be called by a background task without an explicit runtime
// (contract §10.1); lane B1 wires no background consumer.

import path from "node:path";
import { DATA_PATH, HISTORY_PATH, READ_ONLY, RETRIEVAL_INDEX_PATH, TRASH_PATH, VAULT } from "./config.js";
import { trackGitMutation } from "./git.js";
import { requireRequestAuthor } from "./request-context.js";
import { DEFAULT_VAULT_ID } from "./oauth/primitives.js";
import { vaultDataPaths } from "./vault-runtime/paths.js";
import { createVaultRuntime } from "./vault-runtime/runtime.js";

// Root-free helpers stay facade exports; they have no per-runtime state.
export {
  assertCanonicalInsideRoot,
  assertWritable,
  decodeLinkTarget,
  ensureParent,
  exists,
  fileExtension,
  hasExtension,
  hasNumericExtension,
  isAcceptedObsidianFile,
  isTextFile,
  normalizeVaultInput,
  stripMarkdownExtension,
} from "./vault-runtime/local-fs.js";

// Primary Vault ID. Byte-identical derivation to the auth plane's `DEFAULT_VAULT_ID`
// (`oauth/primitives.js`), so Wave C's `allowedVaults` gate compares the same string;
// `test/vault-runtime-factory-core.test.js` ratchets the two against drift.
// #659: this was a verbatim copy of the auth plane's `DEFAULT_VAULT_ID` (same two branches); the
// copy is now the import, so a future edit to the rule has exactly one home. Behaviour is identical.
const PRIMARY_VAULT_ID = DEFAULT_VAULT_ID;

const primaryPaths = vaultDataPaths({
  primary: true,
  history: HISTORY_PATH,
  trash: TRASH_PATH,
  retrievalIndex: RETRIEVAL_INDEX_PATH,
  transfersUploads: path.join(DATA_PATH, "transfers", "uploads"),
  mutationJournal: path.join(DATA_PATH, "mutation-journal"),
  mutationIdempotency: path.join(DATA_PATH, "mutation-idempotency"),
});

// The one primary runtime for this process. Capabilities stay fail-closed here: nothing
// consumes them yet, and lanes B2..B4/B6 flip them when they actually wire the service
// (contract §3.4 "capability wiring lands in Wave B/C").
export const primaryRuntime = createVaultRuntime({
  descriptor: { id: PRIMARY_VAULT_ID, name: PRIMARY_VAULT_ID, root: VAULT, primary: true, writable: !READ_ONLY },
  paths: primaryPaths,
  dataRoot: DATA_PATH,
  deps: { requireRequestAuthor, trackGitMutation },
});

// Every root-bound export delegates to that instance. Binding the closure (rather than
// wrapping) keeps the exact function identity and arity of the pre-facade exports.
const localFs = primaryRuntime.localFs;

export const assertInsideVault = localFs.assertInsideVault;
export const assertCanonicalInsideVault = localFs.assertCanonicalInsideVault;
export const openCanonicalVaultFile = localFs.openCanonicalVaultFile;
export const assertNotVaultRoot = localFs.assertNotVaultRoot;
export const resolveVaultPath = localFs.resolveVaultPath;
export const resolveCanvasPath = localFs.resolveCanvasPath;
export const toVaultPath = localFs.toVaultPath;
export const normalizeNotePath = localFs.normalizeNotePath;
export const resolveTrashPath = localFs.resolveTrashPath;
export const toTrashPath = localFs.toTrashPath;
export const ensureVaultParent = localFs.ensureVaultParent;
export const fileRevision = localFs.fileRevision;
export const assertRevision = localFs.assertRevision;
export const withMutationLock = localFs.withMutationLock;
export const atomicWriteFile = localFs.atomicWriteFile;
export const createVersionSnapshot = localFs.createVersionSnapshot;
export const listFileVersions = localFs.listFileVersions;
export const readFileVersion = localFs.readFileVersion;
export const restoreFileVersion = localFs.restoreFileVersion;
export const readLimitedText = localFs.readLimitedText;
export const walk = localFs.walk;
export const allMarkdownFiles = localFs.allMarkdownFiles;
export const backupBeforeDelete = localFs.backupBeforeDelete;
export const listTrashEntries = localFs.listTrashEntries;
export const readTrashEntry = localFs.readTrashEntry;
export const restoreTrashEntry = localFs.restoreTrashEntry;
export const deleteTrashEntry = localFs.deleteTrashEntry;
export const deleteFileVersion = localFs.deleteFileVersion;
export const getVaultHealth = localFs.getVaultHealth;
