// Phase 3A-1 search planner contract.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3A 契约前置决策（冻结，2026-10-04）
import assert from "node:assert/strict";
import test from "node:test";
import { parseObsidianQuery } from "../src/search/obsidian-query.js";
import { SEARCH_CANDIDATE_MODES, SEARCH_RANK_MODES } from "../src/app/web-catalog/search-query.js";
import { MIN_TRIGRAM_LENGTH, ftsPhrase, planSearchCandidates, searchQueryHash } from "../src/app/web-catalog/search-planner.js";

const plan = (query, options) => planSearchCandidates(parseObsidianQuery(query), options);

test("a bounded seed is built from every indexed column family", () => {
  assert.equal(plan("foo").candidateMode, SEARCH_CANDIDATE_MODES.FTS);
  assert.equal(plan("foo").match, '(raw : "foo")');
  assert.equal(plan("content:foo").match, '(raw : "foo")');
  assert.equal(plan("path:Notes").match, '(path : "Notes")');
  assert.equal(plan("file:Alpha").match, '(path : "Alpha")');
  assert.equal(plan("tag:projects").match, '(tags : "projects")');
  assert.equal(plan("tag:#projects/").match, '(tags : "projects")');
  // `[key]` and `[key:value]` seed on the key; the value stays a residual condition.
  assert.equal(plan("[status]").match, '(raw : "status")');
  assert.equal(plan("[status:done]").match, '(raw : "status")');
});

test("rank mode is independent of the candidate source", () => {
  // Only a text seed may rank by bm25.
  assert.equal(plan("foo").rankMode, SEARCH_RANK_MODES.BM25);
  assert.equal(plan("content:foo").rankMode, SEARCH_RANK_MODES.BM25);
  assert.equal(plan("foo tag:projects").rankMode, SEARCH_RANK_MODES.BM25);
  assert.equal(plan("foo OR bar").rankMode, SEARCH_RANK_MODES.BM25);
  // A structural query still uses the FTS candidate source, but keeps the frozen
  // path_key order: it must not inherit a relevance rank.
  for (const query of ["path:Notes", "file:Alpha", "tag:projects", "[status]", "[status:done]", "path:Notes OR tag:projects"]) {
    const planned = plan(query);
    assert.equal(planned.candidateMode, SEARCH_CANDIDATE_MODES.FTS, `${query} is FTS-seeded`);
    assert.equal(planned.rankMode, SEARCH_RANK_MODES.PATH, `${query} must rank by path`);
  }
  // A short text needle is not a seed, so it cannot bring bm25 either.
  assert.equal(plan("tag:projects oo").candidateMode, SEARCH_CANDIDATE_MODES.FTS);
  assert.equal(plan("tag:projects oo").rankMode, SEARCH_RANK_MODES.PATH);
});

test("a grouped field value seeds every needle (v1 requires all of them)", () => {
  assert.equal(plan("tag:(alpha beta)").match, '(tags : "alpha" AND tags : "beta")');
  assert.equal(plan("content:(alpha beta)").match, '(raw : "alpha" AND raw : "beta")');
});

test("OR branches become an OR of ANDed seeds", () => {
  const planned = plan("foo OR bar");
  assert.equal(planned.candidateMode, SEARCH_CANDIDATE_MODES.FTS);
  assert.equal(planned.match, '(raw : "foo") OR (raw : "bar")');
});

test("short needles and unseedable clauses fall back to the residual stream", () => {
  for (const query of ["oo", "ab", "笔记", "line:foo", "section:body", "-foo", "foo OR line:bar", "tag:(a beta)"]) {
    const planned = plan(query);
    assert.equal(planned.candidateMode, SEARCH_CANDIDATE_MODES.RESIDUAL, `${query} must be residual`);
    assert.equal(planned.rankMode, SEARCH_RANK_MODES.PATH, `${query} must rank by path`);
    assert.equal(planned.match, null, `${query} must not carry a MATCH expression`);
  }
  assert.equal(MIN_TRIGRAM_LENGTH, 3);
  // Exactly one unseeded OR branch is enough to make the whole query residual: a
  // single rank must apply to the whole candidate stream.
  assert.equal(plan("foo OR oo").candidateMode, SEARCH_CANDIDATE_MODES.RESIDUAL);
  assert.equal(plan("foo OR oo").rankMode, SEARCH_RANK_MODES.PATH);
});

test("an unseedable clause next to a seed keeps the seed and stays indexed", () => {
  // Reviewer supersede: a short/`line:`/`section:` clause in the same AND group does
  // not demote the query as long as the group still has one bounded seed.
  assert.equal(plan("foo line:bar").candidateMode, SEARCH_CANDIDATE_MODES.FTS);
  assert.equal(plan("foo line:bar").match, '(raw : "foo")');
  assert.equal(plan("oo line:bar").candidateMode, SEARCH_CANDIDATE_MODES.RESIDUAL);
});

test("an empty query has no seed and therefore streams the residual order", () => {
  const planned = plan("");
  assert.equal(planned.candidateMode, SEARCH_CANDIDATE_MODES.RESIDUAL);
  assert.equal(planned.rankMode, SEARCH_RANK_MODES.PATH);
  assert.equal(planned.match, null);
});

test("FTS phrases are quoted so operators and punctuation stay inert", () => {
  assert.equal(ftsPhrase("foo"), '"foo"');
  assert.equal(ftsPhrase('a"b'), '"a""b"');
  assert.equal(ftsPhrase("tag:x*^-(a)"), '"tag:x*^-(a)"');
});

test("query identity separates queries that would share a MATCH expression", () => {
  const base = plan("foo").queryHash;
  assert.equal(plan("foo").queryHash, base);
  assert.notEqual(plan("content:foo").queryHash, base);
  assert.notEqual(plan("foo", { caseSensitive: true }).queryHash, base);
  assert.notEqual(plan("foo", { semantic: true }).queryHash, base);
  assert.notEqual(plan("foo OR bar").queryHash, base);
  assert.equal(plan("foo").queryHash.length, 32);
  // The publish filter is a hard filter, not a clause, so it is part of the cursor
  // identity: a page of `published:true` can never be continued as `false`. Passing
  // null keeps the previous identity, so unfiltered cursors survive this change.
  assert.equal(plan("foo", { published: null }).queryHash, base);
  assert.notEqual(plan("foo", { published: true }).queryHash, base);
  assert.notEqual(plan("foo", { published: false }).queryHash, base);
  assert.notEqual(plan("foo", { published: true }).queryHash, plan("foo", { published: false }).queryHash);
  assert.equal(plan("foo", { published: true }).published, true);
  // The hash is derived from the parsed structure, not from the raw source text.
  assert.equal(searchQueryHash(parseObsidianQuery("  foo  ")), base);
});
