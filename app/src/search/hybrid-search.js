import { recall, semanticConfiguration } from "../retrieval.js";
import { evaluateObsidianQuery } from "./evaluator.js";

function resultFor(record, exact, semantic) {
  return {
    path: record.path,
    matchCount: exact?.matchCount || 0,
    tags: record.tags,
    aliases: record.aliases,
    snippets: exact?.snippets?.length ? exact.snippets : semantic?.chunks?.map((chunk) => chunk.text).filter(Boolean) || [],
    stat: record.stat,
    revision: record.revision,
    score: exact ? 1 + Math.min(exact.matchCount, 20) / 20 : semantic?.score || 0,
    reasons: exact ? ["exact", ...(exact.matchedClauses || []).map((value) => `query:${value}`)] : semantic?.reasons || [],
  };
}

// Issue #229 semantic tri-state. This is the single source of truth for the
// auto/off/on decision: callers (the MCP tool layer, tests, adapters) must not
// duplicate it. An omitted or null `semantic` is `auto`, an explicit boolean is
// the corresponding strict mode.
export function semanticModeFor(options) {
  if (options.semantic === true) return "on";
  if (options.semantic === false) return "off";
  return "auto";
}

// Shared hybrid augmentation. `semantic=true` and the `auto` zero-exact
// fallback both funnel through this single path so the recall call and the
// semanticCandidate hard-filter revalidation exist exactly once. Retrieval
// candidates are never returned directly: every candidate is re-evaluated with
// `evaluateObsidianQuery(record, parsed, { ...options, semanticCandidate:
// true })` so structural filters, negatives, and properties stay mandatory. A
// recall failure degrades to the exact results instead of throwing.
//
// Wave D / D-search: `recallImpl` is the *selected Vault's* recall (the search
// runtime's method) so a per-Vault `search_notes` can never read another Vault's
// retrieval index. It defaults to the legacy primary facade export, which keeps
// every existing caller unchanged. `semanticConfiguration()` is process-level
// (one shared embedding provider, contract §12) and stays the facade import.
async function augmentWithRetrieval(exactByPath, records, parsed, options, recallImpl) {
  let recalled;
  try {
    recalled = await recallImpl(parsed.semanticText, { semantic: true, limit: Math.max(options.limit || 50, 100), chunksPerNote: 2, snippetLength: 400 });
  } catch (error) {
    return { results: [...exactByPath.values()], semanticUsed: false, semanticError: error.message, hybridUsed: false };
  }
  const recordByPath = new Map(records.map((record) => [record.path, record]));
  for (const semantic of recalled.results) {
    const record = recordByPath.get(semantic.path);
    if (!record || exactByPath.has(record.path)) continue;
    const candidate = evaluateObsidianQuery(record, parsed, { ...options, semanticCandidate: true });
    if (candidate.matched) exactByPath.set(record.path, resultFor(record, null, semantic));
  }
  const embeddingEnabled = semanticConfiguration().enabled;
  const semanticError = recalled.semanticError || (!recalled.semanticUsed && !embeddingEnabled
    ? "Embedding provider is not configured; lexical hybrid ranking was used"
    : null);
  return {
    results: [...exactByPath.values()],
    semanticUsed: recalled.semanticUsed,
    semanticError,
    hybridUsed: true,
  };
}

export async function hybridSearch(records, parsed, options = {}, recallImpl = recall) {
  const exactByPath = new Map();
  for (const record of records) {
    const exact = evaluateObsidianQuery(record, parsed, options);
    if (exact.matched) exactByPath.set(record.path, resultFor(record, exact));
  }
  // exactMatched is the exact evaluator's own hit count, captured before any
  // retrieval augmentation, so both the auto decision and the returned field
  // describe the exact phase rather than the final fused result set.
  const exactMatched = exactByPath.size;
  const semanticMode = semanticModeFor(options);

  if (semanticMode === "off") {
    return { results: [...exactByPath.values()], semanticUsed: false, semanticError: null, hybridUsed: false, semanticMode, fallbackUsed: false, exactMatched };
  }

  if (semanticMode === "on") {
    if (!parsed.semanticText) {
      return { results: [...exactByPath.values()], semanticUsed: false, semanticError: "Semantic search requires a positive text term", hybridUsed: false, semanticMode, fallbackUsed: false, exactMatched };
    }
    return { ...(await augmentWithRetrieval(exactByPath, records, parsed, options, recallImpl)), semanticMode, fallbackUsed: false, exactMatched };
  }

  // auto: exact-first. A non-zero exact result (or a query with no positive text
  // term, including structural-only queries) returns the exact results without
  // touching retrieval at all. Only a zero-exact result with a positive text
  // term enters the retrieval augmentation path.
  if (exactMatched > 0 || !parsed.semanticText) {
    return { results: [...exactByPath.values()], semanticUsed: false, semanticError: null, hybridUsed: false, semanticMode, fallbackUsed: false, exactMatched };
  }
  return { ...(await augmentWithRetrieval(exactByPath, records, parsed, options, recallImpl)), semanticMode, fallbackUsed: true, exactMatched };
}
