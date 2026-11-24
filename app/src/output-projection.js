// O3 — opt-in bounded views for search-shaped payloads.
//
// One pure function at the output adapter: `search_notes`, `recall` and
// `find_related` call `projectSearchResult` with their own payload, and nothing
// upstream moves — scoring, paging, filtering and the default answer are the
// caller's business. `full` is the default and returns the payload untouched.
//
// Whitelist only: a view names the fields it KEEPS, so a field added to a search
// payload later stays invisible to `standard`/`brief` until it is listed here.
//
// Kept by every view, at the envelope: the paging/continuation state
// (`truncated`, `nextCursor`, the totals) and the semantic-degradation state
// (`semanticUsed`, `semanticError`, `hybridUsed`, `semanticMode`, `fallbackUsed`,
// `unavailable`/`available`/`reason`). A caller that cannot see those cannot tell
// a complete answer from a truncated or degraded one.
//   standard — everything except the excerpt text (snippets / chunk text).
//   brief    — additionally drops `diagnostics` (explanation text) and reduces
//              every hit to its locator, so the note can be re-read but the
//              answer itself costs almost nothing.

export const SEARCH_VIEWS = Object.freeze(["full", "standard", "brief"]);

const ENVELOPE = Object.freeze([
  "query", "path", "results", "totalScanned", "totalMatched", "totalCandidates", "truncated", "nextCursor",
  "semanticRequested", "semanticMode", "semanticUsed", "semanticError", "hybridUsed", "fallbackUsed",
  "unavailable", "available", "reason", "index", "vaultId", "diagnostics",
]);

const LOCATOR = Object.freeze(["path", "vaultId", "revision"]);
const HIT_FIELDS = Object.freeze({
  search_notes: Object.freeze(["path", "vaultId", "revision", "matchCount", "tags", "aliases", "stat", "score", "reasons"]),
  recall: Object.freeze(["path", "vaultId", "revision", "metadata", "score", "reasons", "chunks"]),
  find_related: Object.freeze(["path", "vaultId", "revision", "metadata", "score", "reasons", "chunks", "directlyLinked"]),
});
// A chunk keeps its identity and scores; only its `text` is an excerpt.
const CHUNK_FIELDS = Object.freeze(["id", "heading", "score", "reasons"]);

function pick(source, fields) {
  const out = {};
  for (const field of fields) if (source?.[field] !== undefined) out[field] = source[field];
  return out;
}

/**
 * Project one search-shaped payload onto a bounded view.
 *
 * `view: "full"` (also the default and an omitted argument) returns `result`
 * itself. An unknown view or an unknown action throws `RangeError`: a typo must
 * never quietly cost the caller the full payload or a silently empty answer.
 * A payload with no `results` array is not a search answer (an MCP error or a
 * permission refusal arrives in that shape), so it is handed back untouched.
 */
export function projectSearchResult(action, result, view = "full") {
  if (!SEARCH_VIEWS.includes(view)) throw new RangeError(`unknown view: ${view} (expected one of ${SEARCH_VIEWS.join(", ")})`);
  if (view === "full" || !Array.isArray(result?.results)) return result;
  const fields = HIT_FIELDS[action];
  if (!fields) throw new RangeError(`unknown search action: ${action}`);
  const hitFields = view === "brief" ? LOCATOR : fields;
  const projected = {};
  for (const key of ENVELOPE) {
    if (!(key in result)) continue;
    if (view === "brief" && key === "diagnostics") continue;
    if (key !== "results") { projected[key] = result[key]; continue; }
    projected.results = result.results.map((hit) => {
      const kept = pick(hit, hitFields);
      if (Array.isArray(kept.chunks)) kept.chunks = kept.chunks.map((chunk) => pick(chunk, CHUNK_FIELDS));
      return kept;
    });
  }
  return projected;
}
