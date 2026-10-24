// Base/document store extensions for the Web Catalog.
//
// Extracted from sqlite-store.js: the BASE node write path (nodes row only, never
// note projections/FTS), the catalog-level Base projection fault state, and the
// lossless document-record read used by the Web Base route (B3).
import { assertCatalogPath, basenameOf, parentPathOf, titleOf } from "./catalog-path.js";
import { BASE, FILE, NOTE, isFileKind, pathKeyOf } from "./ordering.js";
import { FRONTMATTER_CODEC_VERSION, decodeFrontmatter } from "./value-codec.js";

export function createBaseStore({
  db,
  withTransaction,
  insertNode,
  selectNodeKind,
  updateModifiedOrder,
  markParentDirty,
  publishMutation,
  onRankWrite = () => {},
  noteProjections,
  now = () => Date.now(),
}) {
  const insertMeta = db.prepare(
    "INSERT INTO catalog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  // Catalog-level fail-closed state: any note whose frontmatter cannot be encoded
  // is recorded here so a Base route can 503 instead of silently dropping a field.
  const faults = (() => {
    const row = db.prepare("SELECT value FROM catalog_meta WHERE key = 'baseProjectionFaults'").get();
    try {
      const parsed = JSON.parse(row?.value ?? "{}");
      return parsed && typeof parsed === "object" ? new Map(Object.entries(parsed)) : new Map();
    } catch {
      return new Map();
    }
  })();
  const persistFaults = () => {
    insertMeta.run("baseProjectionFaults", JSON.stringify(Object.fromEntries([...faults].sort())));
  };
  const recordFault = (path, message) => {
    if (faults.get(path) === message) return;
    faults.set(path, message);
    persistFaults();
  };
  const clearFault = (path) => {
    if (faults.delete(path)) persistFaults();
  };

  const upsertBase = (input = {}) =>
    withTransaction(() => {
      const rel = assertCatalogPath(input.path);
      const existing = selectNodeKind.get(rel);
      const name = input.name ?? basenameOf(rel);
      insertNode.run(
        rel,
        pathKeyOf(rel),
        parentPathOf(rel),
        name,
        titleOf(rel),
        BASE,
        1,
        input.size ?? null,
        input.modifiedMs ?? null,
        input.createdMs ?? null,
        input.revision ?? null,
        input.metadataRevision ?? null,
        now(),
      );
      // A path that flips from note to base must not keep stale note projections.
      if (existing && existing.kind === NOTE) noteProjections.remove(rel, existing.fts_rowid);
      clearFault(rel);
      if (!existing || existing.kind !== BASE) {
        markParentDirty(parentPathOf(rel));
      } else {
        const missing = input.modifiedMs === null || input.modifiedMs === undefined;
        updateModifiedOrder.run(missing ? 1 : 0, missing ? 0 : input.modifiedMs, missing ? 0 : -input.modifiedMs, rel);
        onRankWrite();
      }
      publishMutation();
      return rel;
    });

  // Reconcile reuse covers every file kind: a note, base and attachment all carry a
  // `metadata_revision` identity, so an unchanged attachment is not re-upserted on
  // every scan.
  const listDocumentMetadata = ({ kinds = [NOTE, BASE, FILE] } = {}) => {
    const selected = kinds.filter((kind) => isFileKind(kind));
    if (selected.length === 0) return [];
    const placeholders = selected.map(() => "?").join(", ");
    return db
      .prepare(
        `SELECT path, kind, size, modified_ms, revision, metadata_revision FROM nodes WHERE kind IN (${placeholders}) ORDER BY path`,
      )
      .all(...selected);
  };

  const selectRecordNode = db.prepare(
    "SELECT path, basename, size, modified_ms, created_ms, revision FROM nodes WHERE path = ?",
  );
  const selectFrontmatter = db.prepare(
    "SELECT codec_version, encoded_value FROM note_frontmatter_state WHERE path = ?",
  );
  const selectTags = db.prepare("SELECT tag FROM note_tags WHERE path = ? ORDER BY tag");
  const selectLinks = db.prepare("SELECT target FROM note_links WHERE path = ? ORDER BY target");
  const toIso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

  function readOne(path) {
    const row = selectRecordNode.get(path);
    if (!row) return null;
    const stored = selectFrontmatter.get(path);
    // A malformed stored payload fails closed (decode throws) rather than returning
    // a silently truncated frontmatter tree.
    const frontmatter = stored ? decodeFrontmatter(stored.encoded_value) : {};
    return {
      path: row.path,
      name: basenameOf(row.path),
      basename: row.basename,
      frontmatter,
      tags: selectTags.all(path).map((entry) => entry.tag),
      links: selectLinks.all(path).map((entry) => entry.target),
      size: row.size,
      created: toIso(row.created_ms),
      modified: toIso(row.modified_ms),
      revision: row.revision,
    };
  }

  return {
    upsertBase,
    recordFault,
    clearFault,
    listDocumentMetadata,
    // Batch Base-query record read: path/basename/full frontmatter tree/tags/link
    // targets/stat size+created+modified ISO/revision.
    readDocumentRecords: (paths = []) => paths.map((path) => readOne(String(path))).filter(Boolean),
    readDocumentRecord: (path) => readOne(String(path)),
    baseProjectionStatus: () => ({
      complete: faults.size === 0,
      codecVersion: FRONTMATTER_CODEC_VERSION,
      faults: [...faults].map(([path, message]) => ({ path, message })),
    }),
  };
}
