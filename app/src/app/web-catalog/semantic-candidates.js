// Semantic candidate join (Phase 3B-1). Pure service layer: it turns a retrieval
// snapshot (path + semantic score) into catalog-backed results.
//
// Hard rules (frozen):
//   - the number of *examined* candidates is hard-bounded by a fixed window, and the
//     join never enumerates the Vault;
//   - a candidate is only accepted when the catalog currently has that canonical
//     path as a note; absolute/traversal paths, unknown/deleted paths and non-notes
//     fail closed (skipped and counted) instead of becoming a Web item;
//   - an item's identity always comes from the catalog row, never from the retrieval
//     payload;
//   - the join records the catalog generation it ran against, so a generation move
//     can never be silently mixed with an older candidate snapshot;
//   - there is no `markdownFiles()` / `readFile` path here at all.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3B
import { WebCatalogPathError, assertCatalogPath } from "./catalog-path.js";

// Bounded candidate window: the same budget class as the lexical second pass.
export const SEMANTIC_CANDIDATE_LIMIT = 200;

export class SemanticUnavailableError extends Error {
  constructor(message = "Retrieval snapshot unavailable") {
    super(message);
    this.name = "SemanticUnavailableError";
    this.code = "WEB_SEMANTIC_UNAVAILABLE";
  }
}

// `recall` is the result of recallFromSnapshot() (or an equivalent injected shape).
// `publishFilter` is an optional hard publish constraint ({published, paths}): the
// retrieval window must not decide which Publish documents exist, so a non-matching
// note is skipped and counted instead of consuming the page.
export function joinSemanticCandidates({ store, recall, limit = SEMANTIC_CANDIDATE_LIMIT, publishFilter = null }) {
  if (!recall || recall.unavailable === true) throw new SemanticUnavailableError();
  const candidates = Array.isArray(recall.results) ? recall.results : [];
  // Two different budgets: the window bounds how many candidates may be *examined*
  // (a hard cost bound), while outputLimit only bounds the returned page.
  const requested = Number.isSafeInteger(limit) && limit > 0 ? limit : SEMANTIC_CANDIDATE_LIMIT;
  const outputLimit = Math.min(requested, SEMANTIC_CANDIDATE_LIMIT);
  const window = candidates.slice(0, SEMANTIC_CANDIDATE_LIMIT);
  const generation = store.generation();

  const byPath = new Map();
  let skippedPath = 0;
  let skippedMissing = 0;
  let skippedPublish = 0;
  let duplicates = 0;
  let examined = 0;

  // The whole window is always processed: stopping early on the number of *accepted*
  // results would both unbind the cost (all-missing input) and hide a later duplicate
  // with a better score.
  for (const candidate of window) {
    examined += 1;
    let rel;
    try {
      rel = assertCatalogPath(String(candidate?.path ?? ""));
    } catch (error) {
      // A non-canonical path from retrieval is never repaired into a catalog path.
      if (error instanceof WebCatalogPathError) {
        skippedPath += 1;
        continue;
      }
      throw error;
    }
    // Catalog is the authority: at most one primary-key lookup per candidate that
    // passed path validation, no scan.
    const node = store.locate(rel);
    if (!node || node.kind !== "note") {
      skippedMissing += 1;
      continue;
    }
    // Publish membership is a hard constraint here as well. It is checked after the
    // catalog lookup so `skippedMissing` keeps its "not a live note" meaning.
    if (publishFilter && publishFilter.paths.has(node.path) !== publishFilter.published) {
      skippedPublish += 1;
      continue;
    }
    const score = Number(candidate?.score);
    const semanticScore = Number.isFinite(score) ? score : 0;
    const existing = byPath.get(rel);
    if (existing) {
      duplicates += 1;
      if (semanticScore > existing.semanticScore) existing.semanticScore = semanticScore;
      continue;
    }
    byPath.set(rel, {
      // Identity comes from the catalog row, not from the retrieval payload.
      path: node.path,
      name: node.name,
      kind: node.kind,
      modifiedMs: node.modified_ms ?? null,
      revision: node.revision ?? null,
      semanticScore,
      reasons: Array.isArray(candidate?.reasons) ? candidate.reasons.slice(0, 4).map(String) : [],
    });
  }

  const items = [...byPath.values()]
    .sort((left, right) => right.semanticScore - left.semanticScore || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .slice(0, outputLimit);

  return {
    items,
    generation,
    // The caller must fail closed (retry or degrade explicitly) when this is true.
    generationMismatch: store.generation() !== generation,
    candidates: candidates.length,
    window: window.length,
    examined,
    duplicates,
    skippedPath,
    skippedMissing,
    skippedPublish,
    semanticUsed: recall.semanticUsed === true,
    semanticError: recall.semanticError ?? null,
  };
}
