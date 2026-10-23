// Web Vault tag index (sidebar Tags panel): GET /api/web/v1/tags.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Obsidian Web 笔记信息侧栏.md
// (标签：当前笔记 tags、全库标签计数、点击筛选与嵌套标签).
//
//   GET /api/web/v1/tags?sort=count|name&direction=asc|desc&limit=<1..500>
//     -> { vaultId, tags: [{ tag, count }], total, truncated }
//
// Single source of truth: the Catalog's `note_tags` projection (written from the
// canonical `allTagsForNote`/`normalizeTag` in `src/obsidian.js`). This module never
// reads the Vault: the aggregation is an index-only `GROUP BY tag` over
// `note_tags_tag_path(tag, path)`, so no recursive readdir and no Markdown read can
// happen on this path.
//
// `tag` is the canonical projection text: lowercased, no leading `#`, `/` hierarchy
// preserved (e.g. `a/b/c`). Callers prefix `#` for the `tag:` search query.
//
// Read-only and fail-closed: a never-reconciled Catalog is 503 (`catalog-not-ready`)
// exactly like tree/search, never an authoritative empty tag list.
import { WebCatalogHttpError } from "./web-catalog/tree-api.js";

export const TAGS_SORT_KEYS = ["count", "name"];
export const TAGS_DIRECTIONS = ["asc", "desc"];
export const TAGS_SORT_DEFAULT = "count";
export const TAGS_DIRECTION_DEFAULT = "desc";
export const TAGS_LIMIT_DEFAULT = 500;
export const TAGS_LIMIT_MIN = 1;
export const TAGS_LIMIT_MAX = 500;

// Public limit contract: default 500, 1..500, decimal integers only; anything else
// is a 400 (the route never silently clamps), matching the Tree limit contract.
export function parseTagsLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return TAGS_LIMIT_DEFAULT;
  const value = String(raw);
  if (!/^\d+$/.test(value)) throw new WebCatalogHttpError(400, "invalid-limit", "limit must be a decimal integer");
  const limit = Number(value);
  if (limit < TAGS_LIMIT_MIN || limit > TAGS_LIMIT_MAX) {
    throw new WebCatalogHttpError(400, "invalid-limit", "limit out of range");
  }
  return limit;
}

// `sort` and `direction` are independent parameters with their own error codes:
// `sort=count&direction=bogus` must report `invalid-direction`, not `invalid-sort`.
export function parseTagsQuery(query = {}) {
  const sort = query.sort === undefined || query.sort === "" ? TAGS_SORT_DEFAULT : String(query.sort);
  if (!TAGS_SORT_KEYS.includes(sort)) {
    throw new WebCatalogHttpError(400, "invalid-sort", "unsupported sort key");
  }
  const direction = query.direction === undefined || query.direction === "" ? TAGS_DIRECTION_DEFAULT : String(query.direction);
  if (!TAGS_DIRECTIONS.includes(direction)) {
    throw new WebCatalogHttpError(400, "invalid-direction", "unsupported sort direction");
  }
  return { sort, direction, limit: parseTagsLimit(query.limit) };
}

// The caller has already authenticated + resolved the allowed Vault. A never-built
// Catalog fails closed (503) instead of answering "no tags"; an unavailable runtime
// is also availability, not a 500.
export async function resolveTags({ vault, query, getRuntime }) {
  const options = parseTagsQuery(query);
  let runtime;
  try {
    runtime = getRuntime(vault, { startReconcile: false });
  } catch {
    throw new WebCatalogHttpError(503, "catalog-unavailable", "Web catalog is not available");
  }
  if (!runtime) throw new WebCatalogHttpError(503, "catalog-unavailable", "Web catalog is not available");
  if (!runtime.store.metaGet("lastReconciledAt")) {
    throw new WebCatalogHttpError(503, "catalog-not-ready", "Web catalog has not finished its first reconcile");
  }
  const { tags, total } = runtime.store.listTags(options);
  return { vaultId: vault.id, tags, total, truncated: tags.length < total };
}
