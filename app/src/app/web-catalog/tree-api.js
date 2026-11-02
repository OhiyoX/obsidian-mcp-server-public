// v2 Tree/Locate API contract (Phase 2A-2): pure parsing + HTTP status mapping.
//
// Contract: the frozen Phase 2A decisions. The route layer does auth/allowlist
// BEFORE any catalog access; this module never touches auth.
import { WebCatalogPathError, assertCatalogPath } from "./catalog-path.js";
import { WebCatalogAnchorError, WebCatalogCursorError } from "./cursor.js";

export const TREE_LIMIT_DEFAULT = 100;
export const TREE_LIMIT_MIN = 1;
export const TREE_LIMIT_MAX = 500;
const SORT_DIRECTIONS = { name: ["asc", "desc"], modified: ["asc", "desc"] };
// A flat page returns note-only rows with no directory level. It exposes the two
// orderings that are derivable from globally meaningful stored columns (`modified`,
// `path`); a global `name` order would need a catalog-level name-rank projection
// (the stored `name_rank` is dense *per parent*), so `sort=name` is rejected here
// rather than served in a subtly wrong order. `score` is never a server tree/flat
// sort: it only exists in the client-side flat projection over the search payload.
const FLAT_SORT_DIRECTIONS = { modified: ["asc", "desc"], path: ["asc", "desc"] };

export class WebCatalogHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "WebCatalogHttpError";
    this.status = status;
    this.code = code;
  }
}

// Public limit contract: default 100, 1..500, decimal integers only; anything else
// is a 400 (the route never silently clamps).
export function parseTreeLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return TREE_LIMIT_DEFAULT;
  const value = String(raw);
  if (!/^\d+$/.test(value)) throw new WebCatalogHttpError(400, "invalid-limit", "limit must be a decimal integer");
  const limit = Number(value);
  if (limit < TREE_LIMIT_MIN || limit > TREE_LIMIT_MAX) {
    throw new WebCatalogHttpError(400, "invalid-limit", "limit out of range");
  }
  return limit;
}

export function parseTreeQuery(query = {}) {
  // `flat=1` selects the flat page. Absent/empty stays the tree page; any other
  // present value is rejected instead of silently degrading to a tree request.
  const rawFlat = query.flat;
  if (rawFlat !== undefined && rawFlat !== null && rawFlat !== "" && String(rawFlat) !== "1") {
    throw new WebCatalogHttpError(400, "invalid-flat", "flat must be 1 when present");
  }
  if (String(rawFlat) === "1") return parseFlatTreeQuery(query);

  const rawParent = query.parent;
  const parent =
    rawParent === undefined || rawParent === null || rawParent === ""
      ? ""
      : assertCatalogPath(String(rawParent), { allowRoot: true });

  const sort = query.sort === undefined || query.sort === "" ? "name" : String(query.sort);
  const direction = query.direction === undefined || query.direction === "" ? "asc" : String(query.direction);
  if (!SORT_DIRECTIONS[sort]?.includes(direction)) {
    throw new WebCatalogHttpError(400, "invalid-sort", "unsupported sort/direction");
  }

  const limit = parseTreeLimit(query.limit);
  const rawCursor = query.cursor;
  const cursor = rawCursor === undefined || rawCursor === null || rawCursor === "" ? null : String(rawCursor);
  const rawAnchor = query.anchorPath;
  const anchorPath =
    rawAnchor === undefined || rawAnchor === null || rawAnchor === "" ? null : assertCatalogPath(String(rawAnchor));

  return { parent, sort, direction, limit, cursor, anchorPath };
}

// Flat page identity: no parent (a non-empty `parent` is the explicit conflict), no
// anchor (there is no level to anchor inside), and no directory to locate. The
// returned shape keeps the frozen tree keys and adds `flat` so `resolveTreePage` can
// pick the flat store read without re-parsing the query.
//
// The flat default sort is `modified`, not the tree default `name`: a flat page cannot
// serve a global name order (see FLAT_SORT_DIRECTIONS), so `?flat=1` with no sort must
// still be a valid request. The direction default stays the shared `asc` rule.
function parseFlatTreeQuery(query = {}) {
  const rawParent = query.parent;
  if (rawParent !== undefined && rawParent !== null && String(rawParent) !== "") {
    throw new WebCatalogHttpError(400, "flat-parent-conflict", "flat and parent are mutually exclusive");
  }

  const sort = query.sort === undefined || query.sort === "" ? "modified" : String(query.sort);
  const direction = query.direction === undefined || query.direction === "" ? "asc" : String(query.direction);
  if (!FLAT_SORT_DIRECTIONS[sort]?.includes(direction)) {
    throw new WebCatalogHttpError(400, "invalid-sort", "unsupported flat sort/direction");
  }

  const rawAnchor = query.anchorPath;
  if (rawAnchor !== undefined && rawAnchor !== null && String(rawAnchor) !== "") {
    throw new WebCatalogHttpError(400, "invalid-anchor", "anchorPath is not supported for a flat page");
  }

  return {
    parent: "",
    sort,
    direction,
    limit: parseTreeLimit(query.limit),
    cursor: query.cursor === undefined || query.cursor === null || query.cursor === "" ? null : String(query.cursor),
    anchorPath: null,
    flat: true,
  };
}

export function mapTreeStoreError(error, { stale }) {
  if (error instanceof WebCatalogHttpError) return error;
  if (error instanceof WebCatalogAnchorError) {
    if (error.code === "WEB_CATALOG_ANCHOR_INVALID") {
      return new WebCatalogHttpError(400, "invalid-anchor", "cursor and anchorPath are mutually exclusive");
    }
    return stale
      ? new WebCatalogHttpError(409, "anchor-not-indexed", "anchor is not indexed in the current snapshot")
      : new WebCatalogHttpError(404, "anchor-not-found", "anchor not found");
  }
  if (error instanceof WebCatalogCursorError) {
    return error.code === "WEB_CATALOG_CURSOR_STALE"
      ? new WebCatalogHttpError(409, "cursor-stale", "cursor is stale; refresh this parent")
      : new WebCatalogHttpError(400, "cursor-invalid", "cursor is invalid");
  }
  if (error instanceof WebCatalogPathError) return new WebCatalogHttpError(400, "invalid-path", "invalid path");
  return null;
}

// The caller has already authenticated + resolved the allowed Vault. This resolves
// the catalog and returns the page payload, or throws a WebCatalogHttpError.
export async function resolveTreePage({ vault, query, getRuntime }) {
  // Validate the query before touching the catalog (deterministic 400s, including
  // invalid parent/anchorPath -> 400 invalid-path).
  let options;
  try {
    options = parseTreeQuery(query);
  } catch (error) {
    const mapped = mapTreeStoreError(error, { stale: false });
    if (mapped) throw mapped;
    throw error;
  }

  // Snapshot access only: a tree request must never start a full reconcile, and a
  // runtime/store open failure is an availability error (503), not a 500.
  let runtime;
  try {
    runtime = getRuntime(vault, { startReconcile: false });
  } catch {
    throw new WebCatalogHttpError(503, "catalog-unavailable", "Web catalog is not available");
  }
  if (!runtime) throw new WebCatalogHttpError(503, "catalog-unavailable", "Web catalog is not available");
  if (!runtime.store.metaGet("lastReconciledAt")) {
    // Never-built is not an authoritative empty Vault.
    throw new WebCatalogHttpError(503, "catalog-not-ready", "Web catalog has not finished its first reconcile");
  }

  const stale = runtime.store.isStale() || !runtime.status().covered;
  try {
    // A flat page has no parent: it lists note-only rows across the whole Vault from
    // the same catalog snapshot, using ordering metadata columns only (no FTS/text).
    const page =
      options.flat === true
        ? runtime.store.listFlatNotes({
            limit: options.limit,
            cursor: options.cursor,
            sort: options.sort,
            direction: options.direction,
          })
        : runtime.store.listChildren(options.parent, {
            limit: options.limit,
            cursor: options.cursor,
            sort: options.sort,
            direction: options.direction,
            anchorPath: options.anchorPath,
          });
    return {
      parent: page.parent,
      items: page.items,
      nextCursor: page.nextCursor,
      catalog: { generation: page.catalog.generation, stale },
    };
  } catch (error) {
    const mapped = mapTreeStoreError(error, { stale });
    if (mapped) throw mapped;
    throw error;
  }
}
