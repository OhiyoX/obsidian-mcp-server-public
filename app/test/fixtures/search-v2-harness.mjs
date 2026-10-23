import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

// Lexical recall queries: exercise the current tokenizer/BM25 path in
// src/retrieval.js. `recall` only scores title + heading + chunk text with
// BM25 and adds metadata (title/description/tags/entities) afterwards.
export const LEXICAL_QUERIES = [
  "网络故障",
  "restore_from_trash",
  "OpenWrt",
  "planRestoreVersion",
  "dfba2c1",
  "查询设计",
  "中文内容",
];

// Hybrid cases: exercise parseObsidianQuery + evaluator + hybridSearch fusion,
// including the exact-score formula, snippet selection, semantic degradation,
// and hard-filter/negation invariants.
export const HYBRID_CASES = [
  { name: "exact-chinese-text", query: "网络故障", options: {} },
  { name: "exact-quoted-phrase", query: '"exact phrase"', options: {} },
  { name: "identifier", query: "restore_from_trash", options: {} },
  { name: "alias-exact", query: "查询设计", options: {} },
  { name: "path-filter", query: "path:Archive exact phrase", options: {} },
  { name: "negation", query: "exact phrase -file:Old", options: {} },
  { name: "hard-filter-tag", query: "tag:project/search restore_from_trash", options: { semantic: true } },
  { name: "hard-filter-violation", query: "tag:missing restore_from_trash", options: { semantic: true } },
  { name: "pathfilter-hard", query: "path:Notes restore_from_trash", options: {} },
];

// Per-record evaluator probes: document hard-filter, negation, frontmatter
// visibility, section scoping, and property operators.
export const EVALUATOR_CASES = [
  { name: "negated-archived", path: "Notes/Search Design.md", query: "-tag:status/archived", options: {} },
  { name: "frontmatter-hidden-text", path: "Notes/Search Design.md", query: "查询设计", options: { includeFrontmatter: false } },
  { name: "frontmatter-visible-text", path: "Notes/Search Design.md", query: "查询设计", options: {} },
  { name: "property-exists", path: "Notes/Search Design.md", query: "[title]", options: {} },
  { name: "property-missing", path: "Notes/Search Design.md", query: "[missing]", options: {} },
  { name: "section-scope", path: "Notes/Search Design.md", query: 'section:"The restore_from_trash helper"', options: {} },
  { name: "section-sibling-negative", path: "Notes/Search Design.md", query: 'section:"API Paths"', options: {} },
  { name: "nested-tag-parent", path: "Notes/Search Design.md", query: "tag:project", options: {} },
  { name: "whole-word", path: "Notes/Search Design.md", query: "restore", options: { wholeWord: true } },
];

export function round(value, digits = 3) {
  return Number(Number(value).toFixed(digits));
}

export async function loadCorpus() {
  return JSON.parse(await fs.readFile(path.join(fixtureDirectory, "search-v2-corpus.json"), "utf8"));
}

export function projectRecords(corpus) {
  return corpus.notes.map((note, index) => ({
    path: note.path,
    name: path.posix.basename(note.path),
    basename: path.posix.basename(note.path, ".md"),
    tags: note.tags,
    aliases: note.aliases,
    frontmatter: note.frontmatter,
    raw: note.raw,
    content: note.content,
    stat: { size: note.raw.length, modified: "2026-01-01T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" },
    revision: `sha256:fixture-${index}`,
  }));
}

export async function writeCorpusVault(vault, corpus) {
  await fs.mkdir(vault, { recursive: true });
  for (const note of corpus.notes) {
    const absolute = path.join(vault, ...note.path.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, note.raw, "utf8");
  }
}

// Deterministic observation projection shared by the test and the baseline
// script so the golden fixture can be regenerated without diverging.
export async function computeObservations({ tokenize, recall, parseObsidianQuery, evaluateObsidianQuery, hybridSearch, records }) {
  const tokenizer = {
    mixedCjkLatin: tokenize("OpenWrt 网络故障"),
    snakeIdentifier: tokenize("restore_from_trash"),
    camelIdentifier: tokenize("planRestoreVersion"),
    filePath: tokenize("app/src/search.js"),
    version: tokenize("v1.2.3"),
    commitHash: tokenize("dfba2c1"),
    chinesePhrase: tokenize("查询设计"),
  };

  const lexical = [];
  for (const query of LEXICAL_QUERIES) {
    const result = await recall(query, { semantic: false, limit: 5, chunksPerNote: 1, snippetLength: 120 });
    lexical.push({
      query,
      semanticUsed: result.semanticUsed,
      semanticError: result.semanticError,
      results: result.results.map((item) => ({
        path: item.path,
        score: round(item.score),
        reasons: item.reasons,
        chunk: item.chunks[0]?.text ?? null,
      })),
    });
  }

  const hybrid = [];
  for (const testCase of HYBRID_CASES) {
    const search = await hybridSearch(records, parseObsidianQuery(testCase.query), testCase.options);
    hybrid.push({
      name: testCase.name,
      query: testCase.query,
      semanticRequested: Boolean(testCase.options.semantic),
      semanticUsed: search.semanticUsed,
      semanticError: search.semanticError,
      hybridUsed: search.hybridUsed,
      results: search.results.map((item) => ({
        path: item.path,
        score: item.score,
        matchCount: item.matchCount,
        reasons: item.reasons,
        snippets: item.snippets,
      })),
    });
  }

  const byPath = new Map(records.map((record) => [record.path, record]));
  const evaluator = [];
  for (const testCase of EVALUATOR_CASES) {
    const record = byPath.get(testCase.path);
    const outcome = evaluateObsidianQuery(record, parseObsidianQuery(testCase.query), testCase.options);
    evaluator.push({
      name: testCase.name,
      path: testCase.path,
      query: testCase.query,
      matched: outcome.matched,
      matchCount: outcome.matchCount,
    });
  }

  return { tokenizer, lexical, hybrid, evaluator };
}
