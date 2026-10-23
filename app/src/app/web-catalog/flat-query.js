// Flat (directory-free) note listing for the Web Catalog store.
//
// Contract (Explorer Phase 2 — flat view; frozen by the coordinator):
//   GET /api/web/v2/tree?flat=1&sort=<key>&direction=<dir>&limit=<n>&cursor=<c>
// returns one keyset page of NOTE-ONLY rows in the same envelope as a tree page
// (`{ parent, items, nextCursor, catalog }`) and the same cursor error family.
//
// Deliberate boundaries:
//   - it never returns a directory/base/attachment row (`kind = 'note'` only);
//   - it reads ordering metadata columns from `nodes` only — no FTS join, no note
//     text read, so an empty-query listing stays metadata-only;
//   - it owns no HTTP/auth concern (see tree-api.js / tree-route.js);
//   - `path` is the only ordering whose direction is a real descending index scan,
//     so the keyset operator is derived from the ordering directions, never
//     assumed to be `>`.
import { decodeWebCatalogCursor, encodeWebCatalogCursor, WebCatalogCursorError } from "./cursor.js";
import { FLAT_ORDERINGS, NOTE } from "./ordering.js";

// Deterministic page-size handling for 0 / negative / NaN / over-cap input. This is
// an internal defensive bound; the HTTP contract validates limit separately.
function toPageSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return 100;
  return Math.max(1, Math.min(500, Math.floor(size)));
}

// Pure SQL/params builder for one flat page. Throws WebCatalogCursorError for an
// unknown/mismatched cursor (the caller maps it to 400/409).
export function buildWebCatalogFlatQuery({
  catalogId,
  generation,
  limit = 100,
  cursor = null,
  sort = "name",
  direction = "asc",
}) {
  const ordering = FLAT_ORDERINGS[sort]?.[direction];
  if (!ordering) throw new Error(`unsupported flat sort/direction: ${sort} ${direction}`);
  const columns = ordering.map(([column]) => column);
  const directions = new Set(ordering.map(([, entryDirection]) => entryDirection));
  if (directions.size !== 1) throw new Error("a flat keyset must have one uniform direction");

  const decoded = decodeWebCatalogCursor(cursor);
  if (decoded) {
    // A tree cursor can share every other field (including parent "") with a flat
    // cursor; the explicit flag is the only identity that separates the two pages.
    if (decoded.flat !== true) throw new WebCatalogCursorError("cursor does not belong to a flat page");
    if (decoded.sort !== sort || decoded.direction !== direction) {
      throw new WebCatalogCursorError("cursor does not belong to this query");
    }
    if (decoded.catalogId !== catalogId) {
      throw new WebCatalogCursorError("cursor belongs to another catalog", "WEB_CATALOG_CURSOR_STALE");
    }
    if (decoded.g !== generation) {
      throw new WebCatalogCursorError("cursor catalog generation is stale", "WEB_CATALOG_CURSOR_STALE");
    }
    if (decoded.keys.length !== columns.length) {
      throw new WebCatalogCursorError("cursor keyset shape mismatch");
    }
  }

  const params = [NOTE];
  let where = "kind = ?";
  if (decoded) {
    const operator = [...directions][0] === "desc" ? "<" : ">";
    where += ` AND (${columns.join(", ")}) ${operator} (${columns.map(() => "?").join(", ")})`;
    params.push(...decoded.keys);
  }

  const size = toPageSize(limit);
  const keySelect = columns.map((column, index) => `${column} AS k${index}`).join(", ");
  const orderBy = ordering.map(([column, entryDirection]) => `${column} ${entryDirection === "desc" ? "DESC" : "ASC"}`).join(", ");
  const sql = `SELECT path, name, basename, modified_ms, ${keySelect} FROM nodes
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ?`;
  return { sql, params: [...params, size + 1], size, columns };
}

// Store-bound listing: executes the page and encodes the next cursor. `catalogId`
// is the store's string identity; `generation`/`isStale` are the store's live
// readers, so a cursor can never be accepted across a catalog snapshot.
export function createWebCatalogFlatStore({ db, catalogId, generation, isStale }) {
  const build = (options = {}) =>
    buildWebCatalogFlatQuery({ catalogId, generation: generation(), ...options });

  const listFlatNotes = (options = {}) => {
    const { sql, params, size, columns } = build(options);
    const rows = db.prepare(sql).all(...params);
    const hasMore = rows.length > size;
    const page = rows.slice(0, size);
    const items = page.map((row) => ({
      kind: NOTE,
      path: row.path,
      name: row.name,
      title: row.basename,
      modified: row.modified_ms === null ? null : new Date(row.modified_ms).toISOString(),
    }));
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeWebCatalogCursor({
            flat: true,
            parent: "",
            sort: options.sort ?? "name",
            direction: options.direction ?? "asc",
            catalogId,
            g: generation(),
            keys: columns.map((column, index) => last[`k${index}`]),
          })
        : null;
    return {
      parent: "",
      items,
      nextCursor,
      catalog: { generation: generation(), stale: isStale() },
    };
  };

  // EXPLAIN QUERY PLAN for the exact flat query — lets tests prove the `path`
  // ordering is index-served and that no full text projection is touched.
  const planListFlatNotes = (options = {}) => {
    const { sql, params } = build(options);
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  };

  return { listFlatNotes, planListFlatNotes };
}
