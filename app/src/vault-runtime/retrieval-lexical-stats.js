// M4 — generation-scoped BM25 statistics (plan 03 Task 1).
//
// Measured on production-sized data (2026-11-22, NAS container, 17,680 chunks):
// tokenizing every chunk costs ~2.4 s and the previous `bm25Scores` scan another
// ~1.6 s per query. These statistics are built once per committed generation, so
// a query only pays the scoring pass.
//
// The numbers are identical to the old implementation: the same unique query
// tokens are visited in the same order, and each document's score accumulates in
// the same order, so no ranking or tie order changes.
import { tokenize as defaultTokenizer } from "./retrieval-rank.js";

function fail(detail) {
  throw new Error(`vault-runtime/retrieval-lexical-stats: ${detail}`);
}

/**
 * `documents` are the exact strings the old `bm25Scores` tokenized, in chunk
 * order (`title heading text`). `postings` maps a token to a flat
 * `[docIndex, frequency, ...]` Int32Array in ascending document order.
 */
export function prepareLexicalStats(documents, { tokenize = defaultTokenizer } = {}) {
  if (!Array.isArray(documents)) fail("documents must be an array of strings");
  if (typeof tokenize !== "function") fail("tokenize must be a function");
  const docLengths = new Uint32Array(documents.length);
  const buckets = new Map();
  let total = 0;
  for (let document = 0; document < documents.length; document += 1) {
    const tokens = tokenize(documents[document]);
    docLengths[document] = tokens.length;
    total += tokens.length;
    if (tokens.length === 0) continue;
    const local = new Map();
    for (const token of tokens) local.set(token, (local.get(token) || 0) + 1);
    for (const [token, frequency] of local) {
      let bucket = buckets.get(token);
      if (bucket === undefined) buckets.set(token, (bucket = []));
      bucket.push(document, frequency);
    }
  }
  const postings = new Map();
  let approxBytes = docLengths.byteLength;
  for (const [token, bucket] of buckets) {
    const flat = Int32Array.from(bucket);
    postings.set(token, flat);
    // Key string (two bytes per code unit), a Map entry and the posting array.
    approxBytes += flat.byteLength + token.length * 2 + 64;
  }
  return Object.freeze({
    docLengths,
    avgLength: documents.length > 0 ? total / documents.length : 0,
    postings,
    documentCount: documents.length,
    approxBytes,
  });
}

/** BM25 scores for one query, in document order (`k1 = 1.2`, `b = 0.75`, as before). */
export function scoreBM25(prepared, queryTokens) {
  if (prepared === null || typeof prepared !== "object" || !(prepared.postings instanceof Map)) fail("prepared statistics are required");
  if (!Array.isArray(queryTokens)) fail("queryTokens must be an array");
  const scores = new Float64Array(prepared.documentCount);
  const seen = new Set();
  const averageLength = Math.max(1, prepared.avgLength);
  for (const token of queryTokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const postings = prepared.postings.get(token);
    if (postings === undefined) continue;
    const documentFrequency = postings.length / 2;
    const idf = Math.log(1 + (prepared.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    for (let offset = 0; offset < postings.length; offset += 2) {
      const document = postings[offset];
      const frequency = postings[offset + 1];
      const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * prepared.docLengths[document] / averageLength);
      scores[document] += idf * (frequency * 2.2) / denominator;
    }
  }
  return scores;
}
