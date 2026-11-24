import { buildSearchRegex, matchesFrontmatterFilters, searchSnippets } from "../obsidian.js";
import { hybridSearch, semanticModeFor } from "./hybrid-search.js";
import { parseObsidianQuery } from "./obsidian-query.js";
import { buildSourceProvenance } from "./source-provenance.js";
import { evaluateObsidianQuery } from "./evaluator.js";
import { hardConstraintQuery } from "./fusion.js";

export { buildSourceProvenance };

// Own no storage or lifecycle: adapters supply the selected Vault's existing index/retrieval.
export function createSearchService({ vaultRuntime, index, retrieval }) {
  const vaultId = vaultRuntime?.id;
  if (typeof vaultId !== "string" || !vaultId) throw new TypeError("Search service requires a Vault id");
  for (const source of [index, retrieval]) {
    if (source?.vaultId !== undefined && source.vaultId !== vaultId) throw new TypeError("Search service source belongs to another Vault");
  }
  const inVault = (record) => record.vaultId === undefined || record.vaultId === vaultId;

  async function recall(query, options = {}) {
    const { snapshotOnly = false, ...rest } = options;
    const result = await (snapshotOnly ? retrieval.recallFromSnapshot(query, rest) : retrieval.recall(query, rest));
    return result.results ? { ...result, results: result.results.filter(inVault) } : result;
  }

  async function search(query, options = {}) {
    const rank = options.rank ?? "bm25f";
    if (!["bm25f", "existing-web"].includes(rank)) throw new TypeError(`Unknown search rank: ${rank}`);
    const parsed = options.parsed ?? (options.useRegex ? null : parseObsidianQuery(query || ""));
    // Web owns its catalog order/score and bounded hydration; never rerank its stream.
    if (rank === "existing-web") {
      const hardQuery = options.semanticCandidate ? hardConstraintQuery(parsed) : null;
      const results = (options.records || []).filter(inVault).flatMap((record) => {
        if (hardQuery && !evaluateObsidianQuery(record, hardQuery, { ...options, semanticCandidate: false }).matched) return [];
        const evaluation = evaluateObsidianQuery(record, parsed, options);
        if (!evaluation.matched) return [];
        const hit = { path: record.path, evaluation };
        if (options.includeProvenance) hit.provenance = buildSourceProvenance({ vaultId, path: record.path, sourceRevision: record.revision, indexedRevision: record.revision, sourceModifiedAt: record.stat?.modified, indexGeneration: options.indexGeneration });
        return [hit];
      });
      return { parsed, results };
    }
    const wantedTags = (options.tags || []).map((tag) => tag.replace(/^#/, "").toLowerCase());
    const regex = query ? buildSearchRegex(query, options) : null;
    const pathMatcher = options.pathRegex ? new RegExp(options.pathRegex, options.caseSensitive ? "" : "i") : null;
    const fileMatcher = options.fileRegex ? new RegExp(options.fileRegex, options.caseSensitive ? "" : "i") : null;
    const snapshot = await index.getVaultIndex({ pathPrefix: options.pathPrefix });
    const candidates = [];
    for (const note of snapshot.records) {
      if (!inVault(note)) continue;
      if (pathMatcher && !pathMatcher.test(note.path)) continue;
      if (fileMatcher && !fileMatcher.test(note.name)) continue;
      if (options.modifiedAfter && note.stat.modified < new Date(options.modifiedAfter).toISOString()) continue;
      if (options.modifiedBefore && note.stat.modified > new Date(options.modifiedBefore).toISOString()) continue;
      if (options.createdAfter && note.stat.created < new Date(options.createdAfter).toISOString()) continue;
      if (options.createdBefore && note.stat.created > new Date(options.createdBefore).toISOString()) continue;
      if (wantedTags.length) {
        const matched = wantedTags.filter((tag) => note.tags.includes(tag));
        if (options.matchAllTags ? matched.length !== wantedTags.length : matched.length === 0) continue;
      }
      if (options.frontmatter && !matchesFrontmatterFilters(note.frontmatter, options.frontmatter)) continue;
      candidates.push(note);
    }
    let result;
    if (options.useRegex) {
      const results = candidates.flatMap((note) => {
        const snippets = regex ? searchSnippets(options.includeFrontmatter ? note.raw : note.content, regex, options.contextLength, options.maxMatchesPerNote) : [];
        if (regex && !snippets.length) return [];
        return [{ path: note.path, matchCount: snippets.length, tags: note.tags, aliases: note.aliases, snippets, stat: note.stat, revision: note.revision }];
      });
      result = { results, semanticUsed: false, semanticError: null, hybridUsed: false, semanticMode: semanticModeFor(options), fallbackUsed: false, exactMatched: 0 };
    } else {
      result = await hybridSearch(candidates, parsed, options, recall);
    }
    if (options.includeProvenance) {
      const indexGeneration = snapshot.stats?.freshness === "clean" ? snapshot.stats.snapshotGeneration : undefined;
      result.results = result.results.map((hit) => ({
        ...hit,
        provenance: buildSourceProvenance({ vaultId, path: hit.path, sourceRevision: hit.revision, sourceModifiedAt: hit.stat?.modified, indexGeneration, indexedRevision: hit.revision }),
      }));
    }
    return { ...result, parsed, candidates, index: snapshot };
  }

  return Object.freeze({ search, recall });
}
