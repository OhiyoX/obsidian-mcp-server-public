// Search candidate paging (Phase 3A-1): opaque cursor codec + one page of the
// candidate stream. Pure orchestration over the store — no file reads here (the
// bounded second pass belongs to Phase 3A-2).
//
// The cursor binds the candidate-stream position, not a result offset, and every mode
// is exactly continuable: continuing the cursor reaches every candidate with no
// duplicates and no misses. There is no window cap.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3A 契约前置决策（冻结，2026-10-04）

// v4: keyset is the frozen integer `score_q` + `path_key` for every rank mode.
export const WEB_CATALOG_SEARCH_CURSOR_VERSION = 4;

// Public page bounds (the HTTP layer in Phase 3A-2 enforces them; frozen here).
export const SEARCH_PAGE_DEFAULT = 50;
export const SEARCH_PAGE_MAX = 200;

// Per-request candidate ceiling. A page consumes at most `limit + 1` (<= 201)
// candidates, and continuation is exact, so this ceiling is satisfied without ever
// truncating the stream.
export const MAX_CANDIDATES_PER_REQUEST = 1000;

// Per-batch ceiling for the expensive second pass (canonical: ~200).
export const SECOND_PASS_BUDGET = 200;

const MAX_SEARCH_CURSOR_LENGTH = 2048;

export class WebCatalogSearchCursorError extends Error {
  // `WEB_CATALOG_CURSOR_INVALID` = malformed/shape/query mismatch (client bug).
  // `WEB_CATALOG_CURSOR_STALE` = the catalog moved on; recoverable (HTTP 409).
  constructor(message, code = "WEB_CATALOG_CURSOR_INVALID") {
    super(message);
    this.name = "WebCatalogSearchCursorError";
    this.code = code;
  }
}

export function encodeSearchCursor({ catalogId, generation, queryHash, rankMode, scoreQ, pathKey }) {
  const body = JSON.stringify({
    v: WEB_CATALOG_SEARCH_CURSOR_VERSION,
    c: catalogId,
    g: generation,
    q: queryHash,
    r: rankMode,
    s: scoreQ,
    k: pathKey,
  });
  return Buffer.from(body, "utf8").toString("base64url");
}

// Returns the keyset, or null when no cursor was supplied. Throws
// WebCatalogSearchCursorError for anything that is not exactly this query's cursor.
export function decodeSearchCursor(cursor, { catalogId, generation, queryHash, rankMode }) {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  if (typeof cursor !== "string") throw new WebCatalogSearchCursorError("cursor must be a string");
  if (cursor.length > MAX_SEARCH_CURSOR_LENGTH) throw new WebCatalogSearchCursorError("cursor is too long");
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new WebCatalogSearchCursorError("cursor is not base64url");

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new WebCatalogSearchCursorError("cursor is not decodable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebCatalogSearchCursorError("cursor shape is invalid");
  }
  if (parsed.v !== WEB_CATALOG_SEARCH_CURSOR_VERSION) {
    throw new WebCatalogSearchCursorError("cursor version mismatch");
  }
  // Cross-Vault is rejected even when the generation happens to match.
  if (typeof parsed.c !== "string" || parsed.c.length === 0 || parsed.c !== catalogId) {
    throw new WebCatalogSearchCursorError("cursor catalog identity mismatch");
  }
  if (!Number.isSafeInteger(parsed.g) || parsed.g < 0) {
    throw new WebCatalogSearchCursorError("cursor generation is invalid");
  }
  if (parsed.g !== generation) {
    throw new WebCatalogSearchCursorError("cursor generation mismatch", "WEB_CATALOG_CURSOR_STALE");
  }
  if (typeof parsed.q !== "string" || parsed.q !== queryHash || parsed.r !== rankMode) {
    throw new WebCatalogSearchCursorError("cursor query identity mismatch");
  }
  if (typeof parsed.k !== "string" || parsed.k.length === 0) {
    throw new WebCatalogSearchCursorError("cursor key is invalid");
  }
  // The rank column is a fixed-precision integer in ORDER BY, in the keyset
  // comparison and in the cursor, so the keyset stays exact.
  if (!Number.isSafeInteger(parsed.s)) throw new WebCatalogSearchCursorError("cursor score is invalid");
  return { scoreQ: parsed.s, pathKey: parsed.k };
}

function toPageSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1) return SEARCH_PAGE_DEFAULT;
  return Math.min(size, SEARCH_PAGE_MAX);
}

// One page of the candidate stream. `items` are unverified candidates in the frozen
// rank order; `nextCursor` continues from the last returned candidate. `publish` is
// the optional hard publish constraint (see search-query.js): it selects candidates
// inside SQL, so the caller never has to page through non-matching candidates.
export function searchCandidates(store, { plan, limit, cursor = null, publish = null }) {
  const size = toPageSize(limit);
  const keyset = decodeSearchCursor(cursor, {
    catalogId: store.catalogId(),
    generation: store.generation(),
    queryHash: plan.queryHash,
    rankMode: plan.rankMode,
  });
  const page = store.listSearchCandidates({
    candidateMode: plan.candidateMode,
    rankMode: plan.rankMode,
    match: plan.match,
    keyset,
    limit: size,
    publish,
  });
  const items = page.items.slice(0, size);
  const last = items.at(-1);
  const hasMore = page.items.length > size;
  const nextCursor = hasMore && last
    ? encodeSearchCursor({
      catalogId: store.catalogId(),
      generation: store.generation(),
      queryHash: plan.queryHash,
      rankMode: plan.rankMode,
      scoreQ: last.score_q,
      pathKey: last.path_key,
    })
    : null;
  return {
    items,
    nextCursor,
    consumed: page.items.length,
    size,
    candidateMode: plan.candidateMode,
    rankMode: plan.rankMode,
    queryHash: plan.queryHash,
  };
}
