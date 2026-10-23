// SQLite-backed Web Catalog store (pure layer, no HTTP / no frontend / no MCP).
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// Tree ordering contract: docs/web-explorer-sort-model.md (#178) — folders always
// first; `name` uses the pinned zh-Hans collator; path tie-break is always ASC;
// `modified` keeps folders at name ASC and always sorts missing/invalid dates
// last. Phase 1A: schema, transactional upsert/remove + generation publication,
// listChildren(parent, cursor, limit, sort), locate(path), generation/stale.
// Wave A / A2: BASE nodes, the typed frontmatter + link projections (note-* and
// base-store modules) and the Base projection fault status.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeWebCatalogCursor } from "./cursor.js";
import { buildWebCatalogChildrenQuery } from "./children-query.js";
import { createWebCatalogFlatStore } from "./flat-query.js";
import { createWebCatalogSearchStore } from "./search-store.js";
import { createNoteProjections } from "./note-projections.js";
import { createBaseStore } from "./base-store.js";
import { createTagQueries } from "./tag-queries.js";
import { createRankRecompute } from "./rank-recompute.js";
import {
  assertCatalogPath,
  basenameOf,
  escapeLike,
  extensionOf,
  parentPathOf,
  titleOf,
} from "./catalog-path.js";
import { DIRECTORY, FILE, NOTE, currentSortContract, pathKeyOf } from "./ordering.js";
import { migrateWebCatalog } from "./schema.js";

const UPSERT_NODE = `
INSERT INTO nodes (
  path, path_key, parent_path, name, basename, kind, kind_rank, size,
  modified_ms, created_ms, revision, metadata_revision, indexed_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  path_key = excluded.path_key,
  parent_path = excluded.parent_path,
  name = excluded.name,
  basename = excluded.basename,
  kind = excluded.kind,
  kind_rank = excluded.kind_rank,
  size = excluded.size,
  modified_ms = excluded.modified_ms,
  created_ms = excluded.created_ms,
  revision = excluded.revision,
  metadata_revision = excluded.metadata_revision,
  indexed_at_ms = excluded.indexed_at_ms
`;

export function openWebCatalogStore({ file = ":memory:", now = () => Date.now() } = {}) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  let catalogId;
  try {
    db.exec("PRAGMA foreign_keys = ON");
    if (file !== ":memory:") {
      try {
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
      } catch {
        // Memory / read-only filesystems may reject WAL; the store still works.
      }
    }
    catalogId = migrateWebCatalog(db, { sortContract: currentSortContract() }).catalogId;
  } catch (error) {
    // A failed migration must not leak an open handle (Windows keeps the file
    // locked) nor leave a half-opened store behind.
    try {
      db.close();
    } catch {
      // Surface the original failure.
    }
    throw error;
  }

  const metaGet = (key) => {
    const row = db.prepare("SELECT value FROM catalog_meta WHERE key = ?").get(key);
    return row ? row.value : null;
  };
  const metaSet = (key, value) =>
    db
      .prepare(
        "INSERT INTO catalog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, String(value));

  const generation = () => {
    const value = Number(metaGet("catalogGeneration"));
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Web Catalog generation metadata is invalid");
    }
    return value;
  };
  const bumpGenerationInTransaction = () => {
    const current = generation();
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Web Catalog generation overflow");
    }
    const next = current + 1;
    metaSet("catalogGeneration", next);
    return next;
  };
  const bumpGeneration = () => withTransaction(bumpGenerationInTransaction);
  const isStale = () => metaGet("stale") === "1";
  const setStale = (value) => metaSet("stale", value ? "1" : "0");

  // Ordering columns are derived from children, so a mutation only dirties the
  // parent it touched; rank-recompute flushes once per dirty parent per transaction.
  const ranks = createRankRecompute({ db });
  const markParentDirty = ranks.markDirty;

  // Single-writer transaction helper. Nested calls participate in the outer
  // transaction instead of opening a second BEGIN (SQLite has no nested BEGIN).
  // Ranks and the generation bump commit together with the writes.
  let transactionDepth = 0;
  const withTransaction = (work) => {
    if (transactionDepth > 0) return work();
    db.exec("BEGIN IMMEDIATE");
    transactionDepth = 1;
    try {
      const result = work();
      ranks.flush();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Surface the original failure.
      }
      // A rolled-back transaction must not leave dirty parents (or a half-open
      // batch) behind, or the next transaction would recompute an unrelated
      // parent's ranks.
      ranks.clear();
      batchDepth = 0;
      batchDirty = false;
      throw error;
    } finally {
      transactionDepth = 0;
    }
  };

  let batchDepth = 0;
  let batchDirty = false;
  const publishMutation = () => {
    if (batchDepth > 0) {
      batchDirty = true;
      return null;
    }
    return bumpGenerationInTransaction();
  };

  const insertNode = db.prepare(UPSERT_NODE);
  const selectNodeKind = db.prepare("SELECT kind, fts_rowid FROM nodes WHERE path = ?");
  const updateModifiedOrder = db.prepare(
    "UPDATE nodes SET modified_valid = ?, modified_asc = ?, modified_desc = ? WHERE path = ?",
  );
  const updateFtsRowid = db.prepare("UPDATE nodes SET fts_rowid = ? WHERE path = ?");
  const deleteNode = db.prepare("DELETE FROM nodes WHERE path = ?");

  const noteProjections = createNoteProjections({ db });
  const baseStore = createBaseStore({
    db,
    withTransaction,
    insertNode,
    selectNodeKind,
    updateModifiedOrder,
    markParentDirty,
    publishMutation,
    onRankWrite: () => ranks.rankWritesIncrement(),
    noteProjections,
    now,
  });

  const hasChildren = (rel) =>
    db.prepare("SELECT 1 AS x FROM nodes WHERE parent_path = ? LIMIT 1").get(rel) !== undefined;

  // Directory semantics for Phase 1B: directories are note ancestors, never a
  // standalone inventory. Removing the last descendant must prune the now-orphan
  // ancestor chain, otherwise a clean catalog keeps ghost directories forever.
  const hasAnyChild = db.prepare("SELECT 1 AS x FROM nodes WHERE parent_path = ? LIMIT 1");
  const deleteDirectoryNode = db.prepare("DELETE FROM nodes WHERE path = ? AND kind = 'directory'");
  // U6 made directories explicit inventory nodes, so the reconcile's removal side
  // must be able to diff the scanned directory listing against every stored row.
  // listDocumentMetadata stays file-kind-only; this is its directory counterpart.
  const selectDirectoryPaths = db.prepare("SELECT path FROM nodes WHERE kind = ? ORDER BY path");
  const listDirectoryPaths = () => selectDirectoryPaths.all(DIRECTORY).map((row) => row.path);
  function pruneEmptyAncestors(start) {
    let current = start;
    while (current) {
      if (hasAnyChild.get(current) !== undefined) break;
      deleteDirectoryNode.run(current);
      current = parentPathOf(current);
    }
  }

  const upsertDirectory = ({ path: relPath, name, modifiedMs = null, createdMs = null } = {}) =>
    withTransaction(() => {
      const rel = assertCatalogPath(relPath);
      const existing = selectNodeKind.get(rel);
      insertNode.run(
        rel,
        pathKeyOf(rel),
        parentPathOf(rel),
        name ?? basenameOf(rel),
        name ?? basenameOf(rel),
        DIRECTORY,
        0,
        null,
        modifiedMs,
        createdMs,
        null,
        null,
        now(),
      );
      // A new sibling (or a kind flip) can shift every dense name rank in the
      // parent; an in-place re-upsert of an existing directory cannot.
      if (!existing || existing.kind !== DIRECTORY) markParentDirty(parentPathOf(rel));
      publishMutation();
      return rel;
    });

  const upsertNote = ({
    path: relPath,
    name,
    size = null,
    modifiedMs = null,
    createdMs = null,
    revision = null,
    metadataRevision = null,
    tags = [],
    aliases = [],
    properties = {},
    frontmatterState = null,
    frontmatterFault = null,
    links = [],
    content = "",
    // Full file text (body + frontmatter) for the FTS projection.
    raw = null,
  } = {}) =>
    withTransaction(() => {
      const rel = assertCatalogPath(relPath);
      const existing = selectNodeKind.get(rel);
      const base = name ?? basenameOf(rel);
      insertNode.run(
        rel,
        pathKeyOf(rel),
        parentPathOf(rel),
        base,
        // Note sort name is the display title (no `.md`), matching the Explorer
        // model's `title || basename(path)`.
        titleOf(rel),
        NOTE,
        1,
        size,
        modifiedMs,
        createdMs,
        revision,
        metadataRevision,
        now(),
      );
      const ftsRowid = noteProjections.write(rel, {
        tags,
        aliases,
        properties,
        frontmatterState,
        links,
        title: titleOf(rel),
        raw: raw ?? content,
        previousFtsRowid: existing?.fts_rowid,
      });
      updateFtsRowid.run(ftsRowid, rel);
      if (frontmatterFault) baseStore.recordFault(rel, frontmatterFault);
      else baseStore.clearFault(rel);
      if (!existing || existing.kind !== NOTE) {
        // Inserting a new sibling can shift every dense name rank in the parent,
        // so the parent is recomputed once at the end of the transaction.
        markParentDirty(parentPathOf(rel));
      } else {
        // Same path => same name => name ranks are unchanged. Only this row's
        // modified ordering can move, so a content/tag/mtime save stays O(1).
        const missing = modifiedMs === null || modifiedMs === undefined;
        updateModifiedOrder.run(missing ? 1 : 0, missing ? 0 : modifiedMs, missing ? 0 : -modifiedMs, rel);
        ranks.rankWritesIncrement();
      }
      publishMutation();
      return rel;
    });

  const upsertBase = baseStore.upsertBase;

  // Attachment write path: a nodes row only. No FTS, no tags/aliases/properties,
  // no frontmatter or link projection, no revision hash — the catalog must never
  // need an attachment's bytes. A path that flips from note to file drops the stale
  // note projections (and a recorded Base fault) so search and Base queries stay
  // correct after a rename/replace.
  const upsertFile = (input = {}) =>
    withTransaction(() => {
      const rel = assertCatalogPath(input.path);
      const existing = selectNodeKind.get(rel);
      const name = input.name ?? basenameOf(rel);
      insertNode.run(
        rel,
        pathKeyOf(rel),
        parentPathOf(rel),
        name,
        // An attachment has no frontmatter title to strip: its sort/display key is
        // the full file name, extension included.
        basenameOf(rel),
        FILE,
        1,
        input.size ?? null,
        input.modifiedMs ?? null,
        input.createdMs ?? null,
        null,
        input.metadataRevision ?? null,
        now(),
      );
      if (existing && existing.kind === NOTE) noteProjections.remove(rel, existing.fts_rowid);
      baseStore.clearFault(rel);
      if (!existing || existing.kind !== FILE) {
        markParentDirty(parentPathOf(rel));
      } else {
        const missing = input.modifiedMs === null || input.modifiedMs === undefined;
        updateModifiedOrder.run(missing ? 1 : 0, missing ? 0 : input.modifiedMs, missing ? 0 : -input.modifiedMs, rel);
        ranks.rankWritesIncrement();
      }
      publishMutation();
      return rel;
    });

  const removePath = (value) =>
    withTransaction(() => {
      const rel = assertCatalogPath(value);
      const rows = db
        .prepare("SELECT path, fts_rowid FROM nodes WHERE path = ? OR path LIKE ? ESCAPE '\\'")
        .all(rel, `${escapeLike(rel)}/%`);
      for (const row of rows) {
        noteProjections.remove(row.path, row.fts_rowid);
        baseStore.clearFault(row.path);
        deleteNode.run(row.path);
      }
      if (rows.length > 0) {
        markParentDirty(parentPathOf(rel));
        pruneEmptyAncestors(parentPathOf(rel));
        publishMutation();
      }
      return rows.length;
    });

  // Groups several mutations into one transaction, one generation bump and one
  // rank recompute per parent. Read as: "publish this whole change as a single
  // catalog generation".
  const batch = (work) => {
    if (batchDepth > 0) return work();
    return withTransaction(() => {
      batchDepth = 1;
      batchDirty = false;
      try {
        const result = work();
        if (batchDirty) bumpGenerationInTransaction();
        return result;
      } finally {
        batchDepth = 0;
        batchDirty = false;
      }
    });
  };

  const locate = (value) => {
    const rel = assertCatalogPath(value);
    const row = db.prepare("SELECT path, parent_path, name, basename, kind, revision, modified_ms FROM nodes WHERE path = ?").get(rel);
    if (!row) return null;
    const ancestors = [];
    let current = row.parent_path;
    while (current) {
      ancestors.unshift(current);
      current = parentPathOf(current);
    }
    return { ...row, ancestors };
  };

  const buildChildrenQuery = (value, options = {}) =>
    buildWebCatalogChildrenQuery({ db, catalogId, generation: generation(), parent: value, ...options });

  const listChildren = (value, options = {}) => {
    const rel = assertCatalogPath(value, { allowRoot: true });
    const { sql, params, size, columns } = buildChildrenQuery(rel, options);
    const rows = db.prepare(sql).all(...params);

    const hasMore = rows.length > size;
    const page = rows.slice(0, size);
    const items = page.map((row) => {
      if (row.kind === DIRECTORY) {
        return { kind: DIRECTORY, path: row.path, name: row.name, hasChildren: hasChildren(row.path) };
      }
      const item = {
        kind: row.kind,
        path: row.path,
        name: row.name,
        title: row.basename,
        modified: row.modified_ms === null ? null : new Date(row.modified_ms).toISOString(),
        size: row.size,
      };
      // Only an attachment entry needs the badge source; a note/base badges by kind.
      if (row.kind === FILE) item.extension = extensionOf(row.name);
      return item;
    });
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeWebCatalogCursor({
            parent: rel,
            sort: options.sort ?? "name",
            direction: options.direction ?? "asc",
            catalogId,
            g: generation(),
            keys: columns.map((column, index) => last[`k${index}`]),
          })
        : null;
    return {
      parent: rel,
      items,
      nextCursor,
      catalog: { generation: generation(), stale: isStale() },
    };
  };

  // EXPLAIN QUERY PLAN for the exact children query — lets tests assert the
  // ordering is served by an index rather than a full scan + temp b-tree.
  const planListChildren = (value, options = {}) => {
    const { sql, params } = buildChildrenQuery(value, options);
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  };

  const { listTags, planListTags } = createTagQueries(db);

  const countNodes = (kind) =>
    kind
      ? db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind = ?").get(kind).n
      : db.prepare("SELECT COUNT(*) AS n FROM nodes").get().n;

  const searchStore = createWebCatalogSearchStore({ db });
  // Flat (directory-free) note listing: one keyset page over `nodes` metadata only.
  const flatStore = createWebCatalogFlatStore({ db, catalogId, generation, isStale });

  return {
    backend: "sqlite",
    catalogId: () => catalogId,
    metaGet,
    generation,
    bumpGeneration,
    isStale,
    setStale,
    setReconciledAt: (value) => metaSet("lastReconciledAt", value),
    batch,
    upsertDirectory,
    listDirectoryPaths,
    upsertNote,
    upsertBase,
    upsertFile,
    removePath,
    locate,
    listChildren,
    planListChildren,
    listFlatNotes: flatStore.listFlatNotes,
    planListFlatNotes: flatStore.planListFlatNotes,
    listTags,
    planListTags,
    listDocumentMetadata: baseStore.listDocumentMetadata,
    readDocumentRecords: baseStore.readDocumentRecords,
    readDocumentRecord: baseStore.readDocumentRecord,
    baseProjectionStatus: baseStore.baseProjectionStatus,
    listSearchCandidates: searchStore.listSearchCandidates,
    planSearchCandidates: searchStore.planSearchCandidates,
    // Public read of the indexed note text (`notes_fts.raw`); see search-store.js.
    readIndexedNoteText: searchStore.readIndexedNoteText,
    countNodes,
    rankWrites: ranks.rankWrites,
    rankRecomputes: ranks.recomputes,
    resetRankRecomputes: ranks.resetLog,
    // Explicit test-only hook: the raw handle is not part of the production API.
    testDb: () => db,
    close: () => db.close(),
  };
}
