// M4 — prepared BM25 statistics must score exactly like the old per-query scan.
//
// The old `bm25Scores` tokenized every document, then for each unique query token
// scanned all documents twice (df and tf). The prepared form must produce the same
// numbers bit-for-bit, in the same document order, for every query shape.
import assert from "node:assert/strict";
import test from "node:test";

import { prepareLexicalStats, scoreBM25 } from "../src/vault-runtime/retrieval-lexical-stats.js";
import { tokenize } from "../src/vault-runtime/retrieval-rank.js";

// Verbatim copy of the previous implementation, kept as the oracle.
function legacyBm25Scores(documents, queryTokens) {
  const tokens = documents.map((document) => tokenize(document));
  const averageLength = tokens.reduce((sum, list) => sum + list.length, 0) / Math.max(1, tokens.length);
  const scores = new Array(tokens.length).fill(0);
  for (const token of [...new Set(queryTokens)]) {
    const documentFrequency = tokens.filter((list) => list.includes(token)).length;
    if (!documentFrequency) continue;
    const idf = Math.log(1 + (tokens.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
    tokens.forEach((list, index) => {
      const frequency = list.filter((item) => item === token).length;
      if (!frequency) return;
      const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * list.length / Math.max(1, averageLength));
      scores[index] += idf * (frequency * 2.2) / denominator;
    });
  }
  return scores;
}

const DOCUMENTS = [
  "部署 手册 部署 流程 与 回滚 rollback deploy",
  "内存 占用 索引 memory index 索引",
  "deploy rollback deploy deploy checklist",
  "中文 检索 测试 中文",
  "",
  "single",
];

test("prepared statistics match the legacy scan for 120 queries", () => {
  const prepared = prepareLexicalStats(DOCUMENTS);
  const queries = [];
  for (const document of DOCUMENTS) queries.push(document);
  for (const token of ["部署", "rollback", "memory", "index", "中文", "single", "absent-token", "deploy rollback", "索引 内存", ""]) queries.push(token);
  // Deterministic expansion to 120+ queries.
  for (let round = 0; round < 22; round += 1) {
    for (const token of ["部署 rollback", "内存 memory index", "中文 测试", "checklist deploy", "single single single"]) {
      queries.push(`${token} ${round % 3 === 0 ? "deploy" : `absent-${round}`}`);
    }
  }
  assert.equal(queries.length >= 120, true);
  for (const query of queries) {
    const expected = legacyBm25Scores(DOCUMENTS, tokenize(query));
    const actual = scoreBM25(prepared, tokenize(query));
    assert.equal(actual.length, expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      assert.equal(Math.abs(actual[index] - expected[index]) <= 1e-12, true, `query ${JSON.stringify(query)} doc ${index}: ${actual[index]} vs ${expected[index]}`);
    }
  }
});

test("document length, average length and document count agree with the oracle", () => {
  const prepared = prepareLexicalStats(DOCUMENTS);
  const expectedLengths = DOCUMENTS.map((document) => tokenize(document).length);
  assert.deepEqual([...prepared.docLengths], expectedLengths);
  assert.equal(prepared.documentCount, DOCUMENTS.length);
  assert.equal(prepared.avgLength, expectedLengths.reduce((sum, value) => sum + value, 0) / DOCUMENTS.length);
  assert.equal(prepared.approxBytes > 0, true);
});

test("the input documents are not modified and repeated tokens count once per document", () => {
  const documents = ["deploy deploy deploy", "deploy"];
  const snapshot = [...documents];
  const prepared = prepareLexicalStats(documents);
  assert.deepEqual(documents, snapshot);
  const postings = prepared.postings.get("deploy");
  assert.deepEqual([...postings], [0, 3, 1, 1], "one posting row per document with its frequency");
});

test("an empty query and an unknown token score zero everywhere", () => {
  const prepared = prepareLexicalStats(DOCUMENTS);
  assert.deepEqual([...scoreBM25(prepared, [])], DOCUMENTS.map(() => 0));
  assert.deepEqual([...scoreBM25(prepared, tokenize("zzz-not-present"))], DOCUMENTS.map(() => 0));
});

test("a custom tokenizer is accepted so the module stays testable in isolation", () => {
  const prepared = prepareLexicalStats(["a b", "b c"], { tokenize: (text) => text.split(" ") });
  assert.deepEqual([...prepared.docLengths], [2, 2]);
  const scores = scoreBM25(prepared, ["b"]);
  assert.equal(scores[0] > 0 && scores[0] === scores[1], true);
});

test("malformed inputs fail closed", () => {
  assert.throws(() => prepareLexicalStats("nope"), /documents must be an array/u);
  assert.throws(() => prepareLexicalStats([], { tokenize: 5 }), /tokenize must be a function/u);
  assert.throws(() => scoreBM25({}, ["a"]), /prepared statistics are required/u);
  assert.throws(() => scoreBM25(prepareLexicalStats(["a"]), "a"), /queryTokens must be an array/u);
});
