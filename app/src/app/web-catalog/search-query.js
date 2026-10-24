// Candidate SQL for Web v2 search (Phase 3A-1). Pure query builder: no HTTP, no
// file reads, no cursor codec.
//
// Candidate *source* and *rank* are separate decisions:
//
//   source fts       one trigram MATCH expression over `notes_fts`
//   source residual  `nodes` path_key stream (index `nodes_kind_path_key`)
//
//   rank bm25        only when the MATCH expression itself contains a text seed
//                    (`text:`/`content:`). Uses FTS5's native `ORDER BY rank` top-K
//                    path, so no SQLite sorter ever materializes the match set.
//   rank path        every structural/other query: `score == 0`, frozen path_key
//                    order. No bm25 is computed at all.
//
// Every mode is exactly continuable: the cursor is a keyset on the stream's own
// order, so there is no window and no cap that could hide a candidate.
//
// `INDEXED BY sqlite_autoindex_nodes_1` pins nodes to its primary-key lookup. Without
// it the planner may satisfy the path ordering by driving from `nodes` (walking
// `nodes_kind_path_key` over the whole catalog) and probing the FTS index per row, which
// is O(total notes): measured on the target platform, a 5k-match `path:` query did not
// return within 120s at 50k notes. The FTS match must drive the join.
//
// bm25 order is explicit and deterministic: `(score_q, path_key)`. FTS5 only
// guarantees relevance order for `ORDER BY rank`; the relative order of rows with an
// identical ORDER BY key is undefined, so an implicit tie-break (e.g. rowid) cannot
// be part of a paging protocol. The explicit tie-break costs a sorter, and that
// sorter is bounded by the LIMIT — measured on a 300k-row match set: `LIMIT 51`
// grows RSS by 0 MB while materialising the same result set grows it by 143 MB, i.e.
// SQLite keeps only the top-N rows. The sorter's input is the FTS match set, never
// the `nodes` table.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3A 契约前置决策（冻结，2026-10-04）
export const SEARCH_CANDIDATE_MODES = { FTS: "fts", RESIDUAL: "residual" };
export const SEARCH_RANK_MODES = { BM25: "bm25", PATH: "path" };

// bm25 is a float and is reproducible within one catalog generation, so the cursor
// can carry it exactly; the integer projection is only for display/rounding.
export const SEARCH_SCORE_SCALE = 1_000_000;

export const SEARCH_CANDIDATE_DEFAULT_PAGE = 50;
// Internal defensive bound. The public HTTP contract (Phase 3A-2) is 1..200.
export const SEARCH_CANDIDATE_MAX_PAGE = 1000;

const SCORE_EXPR = `CAST(bm25(notes_fts) * ${SEARCH_SCORE_SCALE} AS INTEGER)`;

const BM25_SELECT = `SELECT n.path AS path, n.name AS name, n.kind AS kind, n.modified_ms AS modified_ms,
       ${SCORE_EXPR} AS score_q, n.path_key AS path_key
FROM notes_fts JOIN nodes n INDEXED BY sqlite_autoindex_nodes_1 ON n.path = notes_fts.path
WHERE notes_fts MATCH ? AND n.kind = 'note'`;
const BM25_ORDER = "ORDER BY score_q ASC, n.path_key ASC";

const PATH_SELECT = `SELECT n.path AS path, n.name AS name, n.kind AS kind, n.modified_ms AS modified_ms,
       0 AS score_q, n.path_key AS path_key
FROM notes_fts JOIN nodes n INDEXED BY sqlite_autoindex_nodes_1 ON n.path = notes_fts.path
WHERE notes_fts MATCH ? AND n.kind = 'note'`;

const RESIDUAL_STREAM = `SELECT path AS path, name AS name, kind AS kind, modified_ms AS modified_ms,
       0 AS score_q, path_key AS path_key
FROM nodes WHERE kind = 'note'`;

function toPageSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1) return SEARCH_CANDIDATE_DEFAULT_PAGE;
  return Math.min(size, SEARCH_CANDIDATE_MAX_PAGE);
}

// Param order is part of the store contract (statements are prepared once per store,
// so the caller binds by position):
//   fts bm25   [match, scoreQ, scoreQ, pathKey, publishPaths, publishRequired, limit] (no keyset: [match, publishPaths, publishRequired, limit])
//   fts path   [match, pathKey, publishPaths, publishRequired, limit]                (no keyset: [match, publishPaths, publishRequired, limit])
//   residual   [pathKey, publishPaths, publishRequired, limit]                       (no keyset: [publishPaths, publishRequired, limit])
//
// The publish filter is a *candidate-selection* constraint, not a post-candidate pass.
// With a per-request candidate budget, filtering after the stream would make a sparse
// `published:true` need many empty pages before anything appears. The constraint text
// is unconditional and the mode is carried by the two parameters, so a prepared
// statement never depends on the request:
//   [<paths json>, 1] -> only those paths
//   [<paths json>, 0] -> every other path
//   ["[]", 0]         -> no constraint at all (the default)
// `json_each` is a non-correlated subquery SQLite materialises once per query.
const PUBLISH_CONSTRAINT_FTS = "AND (n.path IN (SELECT value FROM json_each(?))) = ?";
const PUBLISH_CONSTRAINT_RESIDUAL = "AND (path IN (SELECT value FROM json_each(?))) = ?";

// The no-filter binding: an empty path set cannot contain any row, so `0 = 0` holds.
export const NO_PUBLISH_FILTER_PARAMS = Object.freeze(["[]", 0]);

// `paths` may be any iterable of canonical vault-relative paths.
export function publishFilterParams({ published, paths }) {
  if (published !== true && published !== false) throw new Error("publish filter requires an explicit published:true|false");
  if (!paths) throw new Error("publish filter requires a path collection");
  return [JSON.stringify([...paths].map(String)), published ? 1 : 0];
}

export function buildWebCatalogSearchQuery({ candidateMode, rankMode, keyset = null, size, publish = null }) {
  const pageSize = toPageSize(size);
  const limit = pageSize + 1; // one extra row decides whether a next cursor exists
  const publishParams = publish ? publishFilterParams(publish) : NO_PUBLISH_FILTER_PARAMS;
  if (candidateMode === SEARCH_CANDIDATE_MODES.FTS && rankMode === SEARCH_RANK_MODES.BM25) {
    if (!keyset) return { sql: `${BM25_SELECT} ${PUBLISH_CONSTRAINT_FTS} ${BM25_ORDER} LIMIT ?`, params: [null, ...publishParams, limit], size: pageSize };
    return {
      sql: `${BM25_SELECT} AND (${SCORE_EXPR} > ? OR (${SCORE_EXPR} = ? AND n.path_key > ?)) ${PUBLISH_CONSTRAINT_FTS} ${BM25_ORDER} LIMIT ?`,
      params: [null, keyset.scoreQ, keyset.scoreQ, keyset.pathKey, ...publishParams, limit],
      size: pageSize,
    };
  }
  if (candidateMode === SEARCH_CANDIDATE_MODES.FTS) {
    if (!keyset) return { sql: `${PATH_SELECT} ${PUBLISH_CONSTRAINT_FTS} ORDER BY n.path_key ASC LIMIT ?`, params: [null, ...publishParams, limit], size: pageSize };
    return {
      sql: `${PATH_SELECT} AND n.path_key > ? ${PUBLISH_CONSTRAINT_FTS} ORDER BY n.path_key ASC LIMIT ?`,
      params: [null, keyset.pathKey, ...publishParams, limit],
      size: pageSize,
    };
  }
  if (!keyset) return { sql: `${RESIDUAL_STREAM} ${PUBLISH_CONSTRAINT_RESIDUAL} ORDER BY path_key ASC LIMIT ?`, params: [...publishParams, limit], size: pageSize };
  return {
    sql: `${RESIDUAL_STREAM} AND path_key > ? ${PUBLISH_CONSTRAINT_RESIDUAL} ORDER BY path_key ASC LIMIT ?`,
    params: [keyset.pathKey, ...publishParams, limit],
    size: pageSize,
  };
}

// The six shapes the store prepares once at open.
export const SEARCH_CANDIDATE_SHAPES = [];
for (const rankMode of [SEARCH_RANK_MODES.BM25, SEARCH_RANK_MODES.PATH]) {
  for (const keyset of [null, { scoreQ: 0, pathKey: "" }]) {
    SEARCH_CANDIDATE_SHAPES.push({ candidateMode: SEARCH_CANDIDATE_MODES.FTS, rankMode, keyset });
  }
}
for (const keyset of [null, { scoreQ: 0, pathKey: "" }]) {
  SEARCH_CANDIDATE_SHAPES.push({
    candidateMode: SEARCH_CANDIDATE_MODES.RESIDUAL,
    rankMode: SEARCH_RANK_MODES.PATH,
    keyset,
  });
}
