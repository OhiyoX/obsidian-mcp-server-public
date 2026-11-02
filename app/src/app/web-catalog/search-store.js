// Store-side FTS-backed reads: the search candidate queries (Phase 3A-1) and the
// public accessor for the indexed note text. Split out of sqlite-store.js to keep
// that module inside the architecture line budget; it owns only prepared statements
// + parameter binding, never cursor semantics (see search-candidates.js).
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3A 契约前置决策（冻结，2026-10-04）
import {
  SEARCH_CANDIDATE_DEFAULT_PAGE,
  SEARCH_CANDIDATE_MODES,
  SEARCH_CANDIDATE_SHAPES,
  SEARCH_RANK_MODES,
  buildWebCatalogSearchQuery,
} from "./search-query.js";

function shapeKey({ candidateMode, rankMode, keyset }) {
  return `${candidateMode}:${rankMode}:${keyset ? 1 : 0}`;
}

function assertShape(candidateMode, rankMode) {
  const sources = [SEARCH_CANDIDATE_MODES.FTS, SEARCH_CANDIDATE_MODES.RESIDUAL];
  const ranks = [SEARCH_RANK_MODES.BM25, SEARCH_RANK_MODES.PATH];
  if (!sources.includes(candidateMode) || !ranks.includes(rankMode)) {
    throw new Error(`unknown search candidate shape: ${candidateMode}/${rankMode}`);
  }
  // bm25 needs a MATCH expression to rank against, so it can only come from FTS.
  if (rankMode === SEARCH_RANK_MODES.BM25 && candidateMode !== SEARCH_CANDIDATE_MODES.FTS) {
    throw new Error("bm25 rank requires the fts candidate source");
  }
}

export function createWebCatalogSearchStore({ db }) {
  // Prepared once per store: the 50k build was statement-compilation bound when
  // statements were prepared per call (Phase 2B scale gate).
  const statements = new Map(
    SEARCH_CANDIDATE_SHAPES.map((shape) => [
      shapeKey(shape),
      db.prepare(buildWebCatalogSearchQuery({ ...shape, size: SEARCH_CANDIDATE_DEFAULT_PAGE }).sql),
    ]),
  );

  // Param order comes from the builder; only the FTS MATCH placeholder is filled in
  // here, so the SQL and its binding stay in one place. The publish filter only
  // changes parameter *values*, never the statement text, so the six prepared shapes
  // stay six and a prepared statement is never rebuilt per request.
  function bind({ candidateMode, rankMode, match, keyset, limit, publish = null }) {
    assertShape(candidateMode, rankMode);
    if (candidateMode === SEARCH_CANDIDATE_MODES.FTS && typeof match !== "string") {
      throw new Error("fts candidate mode requires a match expression");
    }
    const built = buildWebCatalogSearchQuery({ candidateMode, rankMode, keyset, size: limit, publish });
    const params = built.params.map((value, index) =>
      (candidateMode === SEARCH_CANDIDATE_MODES.FTS && index === 0 ? match : value),
    );
    return { built, params, key: shapeKey({ candidateMode, rankMode, keyset }) };
  }

  // Production read API for the indexed note text. The indexer copies the full file
  // text (body + frontmatter) into `notes_fts.raw`; consumers that need note text come
  // through here instead of the test-only raw handle. Read-only, one indexed lookup by
  // path, and it never touches the Vault filesystem. A path without an FTS row (a Base
  // or attachment node, an unknown path) resolves to null so callers fail closed.
  const selectIndexedNoteText = db.prepare(
    "SELECT notes_fts.raw AS raw FROM notes_fts JOIN nodes ON nodes.fts_rowid = notes_fts.rowid WHERE nodes.path = ?",
  );
  const readIndexedNoteText = (pathValue) => {
    const row = selectIndexedNoteText.get(String(pathValue));
    return typeof row?.raw === "string" ? row.raw : null;
  };

  return {
    // One keyset page of the candidate stream. `items` may contain one row more
    // than `size`; that extra row is what tells the caller a next cursor exists.
    listSearchCandidates({ candidateMode, rankMode, match = null, keyset = null, limit, publish = null } = {}) {
      const { built, params, key } = bind({ candidateMode, rankMode, match, keyset, limit, publish });
      return { items: statements.get(key).all(...params), size: built.size };
    },
    // Same query, EXPLAINed — used by the complexity gate.
    planSearchCandidates({ candidateMode, rankMode, match = null, keyset = null, limit, publish = null } = {}) {
      const { built, params } = bind({ candidateMode, rankMode, match, keyset, limit, publish });
      return db.prepare(`EXPLAIN QUERY PLAN ${built.sql}`).all(...params);
    },
    // Production accessor for the indexed note text (see the comment above).
    readIndexedNoteText,
  };
}
