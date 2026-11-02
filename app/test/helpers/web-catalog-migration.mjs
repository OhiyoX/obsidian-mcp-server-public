/**
 * #428 migration-scenario helpers (test-only).
 *
 * The retired default was `process.cwd()/data/web-catalog`. A migration acceptance test therefore has
 * to run a child process with a *dedicated* cwd and put the poison pre-#428 index exactly where that
 * cwd resolves it — otherwise the test proves only that two invented paths differ.
 *
 * This module owns three cohesive pieces so the test file stays inside the line budget:
 *   - `poisonLegacyCatalog` / `snapshotLegacy`: build a valid pre-#428 index for a vault id that also
 *     contains a note the Vault does not have, then snapshot bytes/mtime/dir entries;
 *   - `collectStoreBytesBeforeReconcile` / `legacyMarkerHits`: the byte-level "did this store read or
 *     copy the old index?" probe. The bytes MUST be read by the caller after the child announced its
 *     opened store and BEFORE it sends the first `reconcile` command (the child only reconciles when
 *     asked), and the record is stamped so a later read cannot be passed off as this evidence;
 *   - `migrationAcceptance`: ONE predicate used by both the positive case and its negative control,
 *     so the control cannot quietly restate a weaker criterion. It is a pure function over the
 *     evidence it is handed: it reads no store bytes itself.
 *
 * Every acceptance check is behavioural. `locationIsDataPathDefault` alone is never sufficient: the
 * negative control below reaches red with the retired marker *present in the opened store* and the
 * retired file *written to*, which is what "read back or copy the old index" actually looks like.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { catalogRecordFromRead, ensureCatalogDirectories } from "../../src/app/web-catalog/indexer.js";
import { openWebCatalogStore } from "../../src/app/web-catalog/store.js";

export const LEGACY_POISON_NOTE = "Notes/Poison.md";

export function listDir(dir) {
  return fs.readdirSync(dir).sort();
}

export function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Bytes of the retired index that must never show up in the store under test. */
export function legacyMarkerHits(file, { poisonNote, poisonToken }) {
  const bytes = fs.readFileSync(file);
  return [poisonNote, poisonToken].filter((marker) => bytes.includes(Buffer.from(marker)));
}

/** Stamp identifying byte evidence that was collected before the first reconcile command. */
export const STORE_BYTES_EVIDENCE_POINT = "before-first-reconcile";

/**
 * Read the byte-level "did the opened store already hold the retired index?" evidence.
 *
 * MUST be called after the child announced `ready` (its store is open) and BEFORE the parent sends
 * the first `reconcile` command: the child reconciles only when that command arrives, so bytes read
 * here are provably pre-reconcile. `migrationAcceptance` refuses any record that is not stamped by
 * this function, so a read taken at acceptance time (post-reconcile) cannot satisfy the check.
 */
export function collectStoreBytesBeforeReconcile({ ready, poisonNote, poisonToken }) {
  const file = ready.location.file;
  return {
    collectedAt: STORE_BYTES_EVIDENCE_POINT,
    file,
    hits: legacyMarkerHits(file, { poisonNote, poisonToken }),
  };
}

/**
 * Write a valid pre-#428 catalog at `<legacyDir>/<vaultId>.sqlite` for the SAME vault id the child
 * will use, containing `note` — a note the Vault does not have. Reading it back is observable.
 */
export function poisonLegacyCatalog({ legacyDir, vaultId, note, token }) {
  fs.mkdirSync(legacyDir, { recursive: true });
  const file = path.join(legacyDir, `${vaultId}.sqlite`);
  const store = openWebCatalogStore({ file });
  const poison = {
    path: note,
    content: `# poison\n\n${token}\n`,
    frontmatter: {},
    revision: "rev-poison",
    stat: { size: 20, modified: new Date(0).toISOString(), created: new Date(0).toISOString() },
  };
  ensureCatalogDirectories(store, poison.path);
  store.upsertNote({ ...catalogRecordFromRead(poison), metadataRevision: "sig-poison" });
  store.close();
  return file;
}

export function snapshotLegacy(file) {
  return { file, sha256: sha256(file), mtimeMs: fs.statSync(file).mtimeMs, entries: listDir(path.dirname(file)) };
}

function samePaths(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

/**
 * The migration criterion, a pure function over collected evidence. `expected` carries the resolved
 * paths and the Vault's note list; `storeBytesBeforeReconcile` is the stamped record produced by
 * `collectStoreBytesBeforeReconcile` BEFORE the first reconcile command was sent. Returns
 * `{ ok, checks, storeBytesBeforeReconcile }`.
 */
export function migrationAcceptance({ ready, preReconcile, reconciled, legacy, expected, storeBytesBeforeReconcile }) {
  if (
    !storeBytesBeforeReconcile ||
    storeBytesBeforeReconcile.collectedAt !== STORE_BYTES_EVIDENCE_POINT ||
    storeBytesBeforeReconcile.file !== ready.location.file ||
    !Array.isArray(storeBytesBeforeReconcile.hits)
  ) {
    throw new TypeError(
      `migrationAcceptance needs byte evidence stamped "${STORE_BYTES_EVIDENCE_POINT}" for ${ready.location.file} ` +
        `(collected after ready and before the first reconcile command), got ${JSON.stringify(storeBytesBeforeReconcile)}`,
    );
  }
  const checks = {
    // 1. configured location: the DATA_PATH default, derived from a DATA_PATH that is not the retired tree
    locationIsDataPathDefault:
      ready.location.source === "DATA_PATH" &&
      ready.location.dir === expected.dataPathDir &&
      ready.location.file === expected.newFile,
    // 2. the inherited pointer at the retired directory was cleared explicitly, not merely absent
    inheritedDirExplicitlyCleared:
      ready.env.webCatalogDirInherited === expected.legacyDir && ready.env.webCatalogDir === null,
    // 3. BEFORE the first reconcile the opened store carries nothing from the retired index
    noLegacyMarkerInStoreBeforeReconcile:
      storeBytesBeforeReconcile.hits.length === 0 &&
      preReconcile.own.located === false &&
      preReconcile.other.located === false &&
      preReconcile.other.fts === 0 &&
      !preReconcile.tree.notes.includes(expected.poisonNote),
    // 4. after the first reconcile: rebuilt from the Vault alone, poison still invisible
    rebuiltFromVault:
      reconciled.own.located === true &&
      reconciled.own.fts >= 1 &&
      reconciled.other.located === false &&
      reconciled.other.fts === 0 &&
      samePaths(reconciled.tree.notes, expected.vaultNotes),
    // 5. the retired file is untouched, byte for byte, entry for entry
    legacyBytesUnchanged: sha256(legacy.file) === legacy.sha256,
    legacyMtimeUnchanged: fs.statSync(legacy.file).mtimeMs === legacy.mtimeMs,
    legacyEntriesUnchanged:
      JSON.stringify(listDir(path.dirname(legacy.file))) === JSON.stringify(legacy.entries),
  };
  return { checks, storeBytesBeforeReconcile, ok: Object.values(checks).every(Boolean) };
}
