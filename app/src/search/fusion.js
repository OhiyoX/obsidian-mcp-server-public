import { evaluateObsidianQuery } from "./evaluator.js";

// S1 frozen-qrels grid: no improvement with embeddings disabled. Keep fusion
// opt-in; tied parameters use equal weights, literature k=60, and the smaller cap.
export const DEFAULT_FUSION_CONFIG = Object.freeze({ enabled: false, k: 60, lexicalWeight: 1, semanticWeight: 1, candidateCap: 50 });
export const DISABLED_SEMANTIC_ERROR = "Embedding provider is not configured; lexical hybrid ranking was used";
export const rankedIdentity = (item, vaultId = "") => JSON.stringify([item.vaultId ?? vaultId, item.path]);

// Retain the parser's OR groups and the evaluator's literal/structural semantics.
// Only unquoted positive text can be relaxed for a semantic candidate.
export function hardConstraintQuery(parsed) {
  const groups = parsed.groups.map((group) => group.filter((clause) => clause.negated
    || !["text", "content", "line", "section"].includes(clause.type) || clause.raw.includes('"')));
  return { ...parsed, groups, clauses: groups.flat() };
}

export function fuseRankedResults({ exact = [], lexical = [], semantic = {}, constraints, config = {} }) {
  const settings = { ...DEFAULT_FUSION_CONFIG, ...config };
  const { k, lexicalWeight, semanticWeight, candidateCap } = settings;
  if (!Number.isFinite(k) || k < 0 || !Number.isSafeInteger(candidateCap) || candidateCap < 1
    || !Number.isFinite(lexicalWeight) || lexicalWeight <= 0 || !Number.isFinite(semanticWeight) || semanticWeight <= 0) {
    throw new Error("Invalid fusion config");
  }
  const semanticError = semantic.semanticError || (semantic.enabled === false ? DISABLED_SEMANTIC_ERROR : null);
  const facts = {
    semanticUsed: semantic.semanticUsed === true && !semanticError,
    fallbackUsed: Boolean(semanticError),
    semanticError,
  };
  const vaultId = constraints.vaultId ?? "";
  const identity = (item) => rankedIdentity(item, vaultId);
  const records = new Map(constraints.records.map((record) => [identity(record), record]));
  const hardQuery = hardConstraintQuery(constraints.parsed);
  const pool = new Map();
  const add = (items, channel, weight) => {
    const seen = new Set();
    for (const [index, item] of items.slice(0, candidateCap).entries()) {
      const key = identity(item);
      if (seen.has(key)) continue;
      seen.add(key);
      if (constraints.vaultId !== undefined && (item.vaultId ?? vaultId) !== vaultId) continue;
      const record = records.get(key);
      if (!record || !evaluateObsidianQuery(record, hardQuery, { ...constraints.options, semanticCandidate: false }).matched) continue;
      let entry = pool.get(key);
      if (!entry) {
        if (pool.size >= candidateCap) continue;
        entry = { item, key, exact: false, fusionScore: 0, reasons: [...(item.reasons || [])] };
        pool.set(key, entry);
      }
      if (channel === "exact") entry.exact = true;
      // Exact is a protected tier, not a duplicate vote for the lexical route.
      if (channel !== "exact") entry.fusionScore += weight / (k + index + 1);
      entry.reasons.push(`rrf:${channel}:${index + 1}`);
    }
  };
  add(exact, "exact", 0);
  add(lexical, "lexical", lexicalWeight);
  if (facts.semanticUsed) add(semantic.results || [], "semantic", semanticWeight);
  let entries = [...pool.values()];
  if (settings.enabled) entries.sort((a, b) => Number(b.exact) - Number(a.exact)
    || b.fusionScore - a.fusionScore || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    ...facts,
    results: entries.map((entry) => settings.enabled ? {
      ...entry.item,
      score: Number(entry.exact) + entry.fusionScore / (1 + entry.fusionScore),
      fusionScore: entry.fusionScore,
      reasons: entry.reasons,
    } : {
      ...entry.item,
      score: entry.exact ? Math.max(1, entry.item.score || 0) : Math.min(1 - Number.EPSILON, entry.item.score || 0),
    }),
  };
}
