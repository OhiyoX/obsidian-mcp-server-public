import { recall, semanticConfiguration } from "../retrieval.js";
import { evaluateObsidianQuery } from "./evaluator.js";
import { lexicalFieldStats, rankLexicalCandidates } from "./field-ranker.js";
import { DEFAULT_FUSION_CONFIG, fuseRankedResults, rankedIdentity } from "./fusion.js";

function resultFor(record, exact, semantic) {
  return {
    path: record.path,
    ...(record.vaultId === undefined ? {} : { vaultId: record.vaultId }),
    matchCount: exact?.matchCount || 0,
    tags: record.tags,
    aliases: record.aliases,
    snippets: exact?.snippets?.length ? exact.snippets : semantic?.chunks?.map((chunk) => chunk.text).filter(Boolean) || [],
    stat: record.stat,
    revision: record.revision,
    score: exact ? 1 : semantic?.score || 0,
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
// the fusion boundary's literal query, so structural filters, negatives,
// properties, and quoted phrases stay mandatory. A
// recall failure degrades to the exact results instead of throwing.
//
// Wave D / D-search: `recallImpl` is the *selected Vault's* recall (the search
// runtime's method) so a per-Vault `search_notes` can never read another Vault's
// retrieval index. It defaults to the legacy primary facade export, which keeps
// every existing caller unchanged. `semanticConfiguration()` is process-level
// (one shared embedding provider, contract §12) and stays the facade import.
async function augmentWithRetrieval(exactByPath, records, parsed, options, recallImpl) {
  const config = { ...DEFAULT_FUSION_CONFIG, ...options.fusion };
  let recalled;
  let hybridUsed = true;
  try {
    recalled = await recallImpl(parsed.semanticText, { semantic: true, limit: config.candidateCap, chunksPerNote: 2, snippetLength: 400 });
  } catch (error) {
    recalled = { results: [], semanticUsed: false, semanticError: error.message || String(error) };
    hybridUsed = false;
  }
  const identity = (item) => rankedIdentity(item, options.vaultId);
  const recordByPath = new Map(records.map((record) => [identity(record), record]));
  const candidates = recalled.results.flatMap((candidate) => {
    const record = recordByPath.get(identity(candidate));
    return record ? [exactByPath.get(identity(record)) || resultFor(record, null, candidate)] : [];
  });
  const exact = [...exactByPath.values()];
  const fused = fuseRankedResults({
    exact,
    lexical: recalled.semanticUsed ? exact : [...exact, ...candidates],
    semantic: {
      ...recalled,
      results: recalled.semanticUsed ? candidates : [],
      enabled: recalled.semanticUsed || semanticConfiguration().enabled,
    },
    constraints: { records, parsed, options, vaultId: options.vaultId },
    config,
  });
  return { ...fused, hybridUsed };
}

export async function hybridSearch(records, parsed, options = {}, recallImpl = recall) {
  if (options.vaultId !== undefined) records = records.filter((record) => record.vaultId === undefined || record.vaultId === options.vaultId);
  const identity = (item) => rankedIdentity(item, options.vaultId);
  const exactByPath = new Map();
  for (const record of records) {
    const exact = evaluateObsidianQuery(record, parsed, options);
    if (exact.matched) exactByPath.set(identity(record), resultFor(record, exact));
  }
  const candidates = records.filter((record) => exactByPath.has(identity(record)));
  const vaults = [...new Set(candidates.map((record) => record.vaultId ?? options.vaultId))];
  const ranked = vaults.flatMap((vaultId) => {
    const sameVault = (record) => (record.vaultId ?? options.vaultId) === vaultId;
    return rankLexicalCandidates({ ...parsed, includeFrontmatter: options.includeFrontmatter }, candidates.filter(sameVault), lexicalFieldStats(records.filter(sameVault)))
      .map((item) => ({ ...item, vaultId }));
  });
  for (const item of ranked) {
    const result = exactByPath.get(identity(item));
    result.score = 1 + item.score / (1 + item.score);
    result.reasons.push(...item.reasons);
    if (item.topSnippetRef && options.maxMatchesPerNote !== 0) {
      result.snippets = [...new Set([item.topSnippetRef.text, ...result.snippets])].slice(0, options.maxMatchesPerNote || 10);
    }
  }
  // Preserve the ranker's path tie order for callers that retain result order.
  const ordered = ranked.map((item) => [identity(item), exactByPath.get(identity(item))]);
  exactByPath.clear();
  for (const [path, result] of ordered) exactByPath.set(path, result);
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
