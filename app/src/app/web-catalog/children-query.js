// Children page query builder for the Web Catalog store.
//
// Extracted so sqlite-store.js stays a cohesive module. Given a parent and an
// optional cursor OR anchorPath, it returns the exact SQL/params for one
// ordering-index-served page. `cursor` and `anchorPath` are mutually exclusive;
// the anchor page is anchor-inclusive (tuple >= anchor tuple) and never exposes the
// raw ordering tuple or an offset.
import { assertCatalogPath } from "./catalog-path.js";
import { decodeWebCatalogCursor, WebCatalogAnchorError, WebCatalogCursorError } from "./cursor.js";
import { ORDERINGS } from "./ordering.js";

// Deterministic page-size handling for 0 / negative / NaN / over-cap input. This is
// an internal defensive bound; the HTTP contract validates limit separately.
function toPageSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return 100;
  return Math.max(1, Math.min(500, Math.floor(size)));
}

export function buildWebCatalogChildrenQuery({
  db,
  catalogId,
  generation,
  parent,
  limit = 100,
  cursor = null,
  sort = "name",
  direction = "asc",
  anchorPath = null,
}) {
  const rel = assertCatalogPath(parent, { allowRoot: true });
  const columns = ORDERINGS[sort]?.[direction];
  if (!columns) throw new Error(`unsupported sort/direction: ${sort} ${direction}`);

  if (cursor && anchorPath !== null && anchorPath !== undefined) {
    throw new WebCatalogAnchorError("cursor and anchorPath are mutually exclusive", "WEB_CATALOG_ANCHOR_INVALID");
  }

  const decoded = decodeWebCatalogCursor(cursor);
  if (decoded) {
    // A flat page cursor can share parent/sort/direction/keyset shape with a tree
    // cursor; its explicit flag is the only identity that keeps them apart.
    if (decoded.flat === true) throw new WebCatalogCursorError("cursor does not belong to a tree page");
    if (decoded.parent !== rel || decoded.sort !== sort || decoded.direction !== direction) {
      throw new WebCatalogCursorError("cursor does not belong to this query");
    }
    // A foreign catalog may share a generation number by chance: identity must be
    // checked independently so cross-Vault cursors fail closed.
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

  // Target-aware anchor: locate the direct child, take its full ordering tuple from
  // the SAME ORDERINGS spec, and read an anchor-inclusive page. The raw tuple never
  // leaves the store (no offset/pageNumber is introduced).
  let anchorKeys = null;
  if (anchorPath !== null && anchorPath !== undefined) {
    const anchor = assertCatalogPath(anchorPath);
    const row = db.prepare(`SELECT parent_path, ${columns.join(", ")} FROM nodes WHERE path = ?`).get(anchor);
    if (!row || row.parent_path !== rel) {
      throw new WebCatalogAnchorError("anchorPath is not a direct child of this parent");
    }
    anchorKeys = columns.map((column) => row[column]);
  }

  const params = [rel];
  let where = "parent_path = ?";
  if (decoded) {
    // Every ordering column is ascending, so the keyset is a plain row-value
    // comparison — no per-column direction or NULL gap.
    where += ` AND (${columns.join(", ")}) > (${columns.map(() => "?").join(", ")})`;
    params.push(...decoded.keys);
  } else if (anchorKeys) {
    // Anchor-inclusive keyset (tuple >= anchor tuple): the anchor is the first item
    // of the page, and the normal nextCursor continues from there.
    where += ` AND (${columns.join(", ")}) >= (${columns.map(() => "?").join(", ")})`;
    params.push(...anchorKeys);
  }

  const size = toPageSize(limit);
  const keySelect = columns.map((column, index) => `${column} AS k${index}`).join(", ");
  const sql = `SELECT path, name, basename, kind, size, modified_ms, ${keySelect} FROM nodes
       WHERE ${where}
       ORDER BY ${columns.map((column) => `${column} ASC`).join(", ")}
       LIMIT ?`;
  return { sql, params: [...params, size + 1], size, columns };
}
