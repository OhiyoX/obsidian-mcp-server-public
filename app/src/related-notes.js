// Shared note-similarity ranking.
//
// This module is the single owner of the "related notes" ranking primitive.
// It lives below `tools/` so protocol-neutral services (for example the
// context service) can reuse the exact ranking without deep-importing a tool
// module. `getVaultIndex` is only used by the standalone `relatedToPath`
// entry; callers that already hold a Vault index snapshot pass its target
// record directly through `relatedWithFallback` so no cold index build occurs.

import { recall, recallFromSnapshot } from "./retrieval.js";
import { getVaultIndex } from "./vault-index.js";

const MAX_ERROR_CHARS = 200;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|token|password|passwd|secret)\s*[:=]\s*\S{6,}/i,
  /\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{16,}\b/,
];

// Bounded, credential-redacted error text. Retrieval provider errors can carry
// endpoint/credential fragments; only a short, sanitized message is surfaced.
export function boundedErrorMessage(error) {
  const text = String(error?.message ?? error ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  let safe = text;
  for (const pattern of SECRET_PATTERNS) safe = safe.replace(pattern, "[redacted]");
  const points = [...safe];
  return points.length <= MAX_ERROR_CHARS ? safe : `${points.slice(0, MAX_ERROR_CHARS).join("")}…`;
}

function list(value) {
  return (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).map(String).map((item) => item.trim()).filter(Boolean);
}

export function relatedQueryFor(target) {
  return [target.frontmatter.title || target.basename, target.frontmatter.description || "", ...target.tags, ...list(target.frontmatter.entities), target.content.slice(0, 1400)].join("\n");
}

export function rankRelated(target, index, recalled, options = {}) {
  const direct = new Set();
  for (const link of target.links) {
    const resolution = index.resolveLink(link, target.path);
    if (resolution.path) direct.add(resolution.path);
  }
  for (const source of index.records) {
    if (source.links.some((link) => index.resolveLink(link, source.path).path === target.path)) direct.add(source.path);
  }
  return recalled.results
    .filter((item) => item.path !== target.path)
    .map((item) => ({ ...item, directlyLinked: direct.has(item.path), score: Math.min(1, item.score + (direct.has(item.path) ? 0.15 : 0)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit || 10);
}

const recallOptions = (options, semantic) => ({
  limit: Math.max(20, options.limit || 10),
  semantic,
  snippetLength: options.snippetLength || 500,
});

// Wave D / D-search: `runtime` is the *selected Vault's* search runtime (index + retrieval) from
// `src/search-runtimes.js`, so a per-Vault `find_related` / `suggest_links` ranks this Vault's
// records with this Vault's retrieval. Omitted (every pre-existing caller) it keeps the legacy
// primary facades, so no existing behaviour changes.
export async function relatedToPath(notePath, options = {}, runtime = null) {
  const index = runtime ? await runtime.index.getVaultIndex() : await getVaultIndex();
  const target = index.records.find((record) => record.path === notePath || record.path === `${notePath}.md`);
  if (!target) throw new Error(`Note not found: ${notePath}`);
  const recallFn = runtime ? runtime.retrieval.recall : recall;
  const recalled = await recallFn(relatedQueryFor(target), recallOptions(options, options.semantic));
  return { path: target.path, results: rankRelated(target, index, recalled, options), semanticUsed: recalled.semanticUsed, semanticError: recalled.semanticError };
}

// Deterministic semantic -> lexical fallback. The default recall path is the
// snapshot-only recall so a related lookup can never schedule a retrieval
// refresh or cold-load the retrieval JSON; `deps.recall` is injectable so the
// fallback contract can be exercised without a live retrieval backend.
// `lexicalFallback` is true only when semantic ranking was requested and the
// lexical retry actually produced a result. An explicit `semantic:false`
// request is a plain lexical lookup, not a fallback, so it reports
// `semanticRequested:false` and `lexicalFallback:false`. When both attempts
// fail the result carries `error` and no fallback claim is made.
export async function relatedWithFallback(target, index, options = {}, deps = {}) {
  const recallFn = deps.recall || recallFromSnapshot;
  const semanticRequested = options.semantic !== false;
  const base = { path: target.path, results: [], semanticRequested, semanticUsed: false, lexicalFallback: false, semanticError: null, error: null };
  if (semanticRequested) {
    let first = null;
    try {
      first = await recallFn(relatedQueryFor(target), recallOptions(options, true));
    } catch (error) {
      base.semanticError = boundedErrorMessage(error);
    }
    if (first?.semanticUsed) {
      return { ...base, results: rankRelated(target, index, first, options), semanticUsed: true, semanticError: base.semanticError || boundedErrorMessage(first.semanticError) };
    }
    base.semanticError = base.semanticError || boundedErrorMessage(first?.semanticError);
  }
  let lexical = null;
  try {
    lexical = await recallFn(relatedQueryFor(target), recallOptions(options, false));
  } catch (error) {
    base.semanticError = base.semanticError || boundedErrorMessage(error);
    return { ...base, error: boundedErrorMessage(error) };
  }
  return { ...base, results: rankRelated(target, index, lexical, options), semanticUsed: false, lexicalFallback: semanticRequested, semanticError: base.semanticError || boundedErrorMessage(lexical?.semanticError) };
}
