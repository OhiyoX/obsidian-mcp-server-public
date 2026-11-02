// Search planner (Phase 3A-1). Pure: no SQL, no I/O, no file reads.
//
// Maps `parseObsidianQuery()` output to a candidate plan:
//
//   mode  "fts"       every OR branch has at least one bounded seed -> one trigram
//                     MATCH expression; bm25 rank is well defined for the whole
//                     candidate stream.
//   mode  "residual"  some branch has no bounded seed (only `line:`/`section:`/
//                     regex, or a text needle shorter than a trigram) -> the caller
//                     streams `nodes` in the frozen path_key order with score_q == 0.
//
// A "bounded seed" is a clause a trigram-indexed column can turn into a *superset*
// of v1's matches, so the second pass can still decide exactly. Short needles are
// never an error: they simply stop being seeds (reviewer supersede, 2026-10-04).
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3A 契约前置决策（冻结，2026-10-04）
import crypto from "node:crypto";
import { SEARCH_CANDIDATE_MODES, SEARCH_RANK_MODES } from "./search-query.js";

// The trigram tokenizer cannot answer a query shorter than one trigram.
export const MIN_TRIGRAM_LENGTH = 3;

const TEXT_TYPES = new Set(["text", "content"]);
const PATH_TYPES = new Set(["path", "file"]);

// FTS5 phrase quoting: the only special character inside a double-quoted phrase is
// the quote itself (doubled). Column filters, `*`, `^`, `-`, `(`, `)` and `:` are
// inert once quoted.
export function ftsPhrase(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function needlesFor(clause) {
  return (clause.values || [clause.value]).map((value) => String(value));
}

function allSeedable(needles) {
  return needles.length > 0 && needles.every((needle) => needle.length >= MIN_TRIGRAM_LENGTH);
}

// Returns the seed expressions that must ALL hold for this clause, or null when the
// clause cannot be a bounded seed (negated, short, or line/section/regex).
// `textual` marks a seed that came from `text:`/`content:` — only those may rank by
// bm25 (a structural query must not inherit a relevance order).
function seedExpressions(clause) {
  if (clause.negated) return null;
  if (TEXT_TYPES.has(clause.type)) {
    // `text:` matches v1's `record.raw`, `content:` matches the body — both live in
    // the `raw` column, which is a superset for either.
    const needles = needlesFor(clause);
    return allSeedable(needles)
      ? needles.map((needle) => ({ expr: `raw : ${ftsPhrase(needle)}`, textual: true }))
      : null;
  }
  if (PATH_TYPES.has(clause.type)) {
    // `file:` matches basename/name, which are substrings of the path.
    const needles = needlesFor(clause);
    return allSeedable(needles)
      ? needles.map((needle) => ({ expr: `path : ${ftsPhrase(needle)}`, textual: false }))
      : null;
  }
  if (clause.type === "tag") {
    const needles = needlesFor(clause).map((value) => value.replace(/^#/, "").replace(/\/$/, ""));
    return allSeedable(needles)
      ? needles.map((needle) => ({ expr: `tags : ${ftsPhrase(needle)}`, textual: false }))
      : null;
  }
  if (clause.type === "property") {
    // The key must exist in the note's frontmatter text; the value (if any) stays a
    // residual condition. `[key]` and `[key:value]` seed identically.
    const key = String(clause.key ?? "");
    return key.length >= MIN_TRIGRAM_LENGTH ? [{ expr: `raw : ${ftsPhrase(key)}`, textual: false }] : null;
  }
  return null;
}

function clauseIdentity(clause) {
  return [
    clause.type,
    clause.key ?? null,
    clause.value ?? null,
    clause.values ?? null,
    clause.negated === true,
  ];
}

// Stable identity of "which search" a cursor belongs to. Two queries that share a
// MATCH expression but differ in residual semantics (e.g. `foo` vs `content:foo`)
// must not share cursors, so the clause structure is part of the hash.
//
// `published` is a hard filter applied by the caller (it is not a clause), yet it
// changes the result set, so it is part of the identity: a page of `published:true`
// must never be continued as `published:false`. The key is omitted when absent so
// unfiltered cursors keep their identity.
export function searchQueryHash(parsed, { caseSensitive = false, semantic = false, published = null } = {}) {
  const canonical = JSON.stringify({
    source: String(parsed?.source ?? ""),
    caseSensitive: caseSensitive === true,
    semantic: semantic === true,
    ...(published === true || published === false ? { published } : {}),
    groups: (parsed?.groups || []).map((group) => group.map(clauseIdentity)),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function planSearchCandidates(parsed, options = {}) {
  const caseSensitive = options.caseSensitive === true;
  const semantic = options.semantic === true;
  const published = options.published === true ? true : options.published === false ? false : null;
  const groups = (parsed?.groups || []).map((group) =>
    // flatMap, not map: one clause can contribute several seed expressions, and a
    // group only counts as seeded when at least one of its clauses is a seed.
    group.flatMap((clause) => seedExpressions(clause) ?? []),
  );
  // Every OR branch needs a bounded seed. One unseeded branch switches the whole
  // query to the residual stream: that keeps the result set complete (no silent
  // miss) and keeps a single, unmixed rank (score_q == 0 everywhere).
  const seeded = groups.length > 0 && groups.every((seeds) => seeds.length > 0);
  const textual = seeded && groups.some((seeds) => seeds.some((seed) => seed.textual));
  return {
    candidateMode: seeded ? SEARCH_CANDIDATE_MODES.FTS : SEARCH_CANDIDATE_MODES.RESIDUAL,
    // Relevance ranking requires both a text seed and a MATCH to rank against, so a
    // pure structural query stays in frozen path_key order.
    rankMode: textual ? SEARCH_RANK_MODES.BM25 : SEARCH_RANK_MODES.PATH,
    match: seeded ? groups.map((seeds) => `(${seeds.map((seed) => seed.expr).join(" AND ")})`).join(" OR ") : null,
    queryHash: searchQueryHash(parsed, { caseSensitive, semantic, published }),
    caseSensitive,
    semantic,
    published,
  };
}
