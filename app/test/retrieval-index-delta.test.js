// M1 — `computeRetrievalDelta` contract (plan 01 Task 2).
//
// The delta decision is the only thing that lets a no-change refresh skip the
// whole clone/stringify/write cycle, so it must answer exactly, never mutate the
// committed state, and never turn a real change into a no-op.
import assert from "node:assert/strict";
import test from "node:test";

import { computeRetrievalDelta, hasValidEmbedding } from "../src/vault-runtime/retrieval-index-delta.js";

const SEMANTIC_ON = Object.freeze({ enabled: true, identity: "openai:qwen3-embedding-4b-q6:1024" });
const SEMANTIC_OFF = Object.freeze({ enabled: false, identity: null });

function stateOf(entries, embeddingModel = SEMANTIC_ON.identity) {
  const notes = {};
  for (const [notePath, revision, chunkCount] of entries) {
    notes[notePath] = {
      path: notePath,
      revision,
      stat: { mtimeMs: 1 },
      metadata: { title: notePath },
      chunks: Array.from({ length: chunkCount }, (_unused, index) => ({ id: `${notePath}#${index}`, hash: `h${index}`, heading: "", text: "t", embedding: [0.5, 0.5] })),
    };
  }
  return { version: 1, updatedAt: "2026-11-22T00:00:00.000Z", embeddingModel, notes };
}

const recordsOf = (entries) => entries.map(([notePath, revision]) => ({ path: notePath, revision, content: "irrelevant here" }));

test("empty Vault and empty index is a no-op", () => {
  const delta = computeRetrievalDelta({ current: stateOf([]), records: [], semantic: SEMANTIC_ON });
  assert.deepEqual(delta, { changed: false, changedPaths: [], removedPaths: [], modelChanged: false, missingEmbeddings: false });
});

test("unchanged paths and revisions are a no-op even with embeddings requested", () => {
  const entries = [["A.md", "r1", 2], ["中文/B.md", "r2", 0]];
  const delta = computeRetrievalDelta({ current: stateOf(entries), records: recordsOf(entries), embeddings: true, semantic: SEMANTIC_ON });
  assert.equal(delta.changed, false);
  assert.deepEqual(delta.changedPaths, []);
  assert.deepEqual(delta.removedPaths, []);
});

test("added, modified and removed notes are reported in provider order", () => {
  const current = stateOf([["keep.md", "r1", 1], ["edit.md", "r1", 1], ["gone.md", "r1", 1]]);
  const records = recordsOf([["new.md", "r1"], ["keep.md", "r1"], ["edit.md", "r2"]]);
  const delta = computeRetrievalDelta({ current, records, semantic: SEMANTIC_ON });
  assert.equal(delta.changed, true);
  assert.deepEqual(delta.changedPaths, ["new.md", "edit.md"]);
  assert.deepEqual(delta.removedPaths, ["gone.md"]);
});

test("force is a change even when every byte matches", () => {
  const entries = [["A.md", "r1", 1]];
  const delta = computeRetrievalDelta({ current: stateOf(entries), records: recordsOf(entries), force: true, semantic: SEMANTIC_ON });
  assert.equal(delta.changed, true);
  assert.deepEqual(delta.changedPaths, ["A.md"]);
});

test("a new embedding model identity invalidates the whole index", () => {
  const entries = [["A.md", "r1", 1], ["B.md", "r1", 1]];
  const delta = computeRetrievalDelta({ current: stateOf(entries), records: recordsOf(entries), semantic: { enabled: true, identity: "other:model:768" } });
  assert.equal(delta.changed, true);
  assert.equal(delta.modelChanged, true);
  assert.deepEqual(delta.changedPaths, ["A.md", "B.md"]);
});

test("a disabled provider never counts as a model change and never demands embeddings", () => {
  const entries = [["A.md", "r1", 1]];
  const current = stateOf(entries, null);
  current.notes["A.md"].chunks[0].embedding = undefined;
  const delta = computeRetrievalDelta({ current, records: recordsOf(entries), embeddings: true, semantic: SEMANTIC_OFF });
  assert.equal(delta.changed, false);
  assert.equal(delta.modelChanged, false);
  assert.equal(delta.missingEmbeddings, false);
});

test("chunks without a vector force a re-embed only when embeddings are requested", () => {
  const entries = [["A.md", "r1", 2]];
  const current = stateOf(entries);
  current.notes["A.md"].chunks[1].embedding = undefined;
  const withEmbeddings = computeRetrievalDelta({ current, records: recordsOf(entries), embeddings: true, semantic: SEMANTIC_ON });
  assert.equal(withEmbeddings.changed, true);
  assert.equal(withEmbeddings.missingEmbeddings, true);
  assert.deepEqual(withEmbeddings.changedPaths, ["A.md"]);
  const lexicalOnly = computeRetrievalDelta({ current, records: recordsOf(entries), embeddings: false, semantic: SEMANTIC_ON });
  assert.equal(lexicalOnly.changed, false);
});

test("an empty chunk list is not a missing embedding", () => {
  const entries = [["empty.md", "r1", 0]];
  const delta = computeRetrievalDelta({ current: stateOf(entries), records: recordsOf(entries), embeddings: true, semantic: SEMANTIC_ON });
  assert.equal(delta.changed, false);
  assert.equal(delta.missingEmbeddings, false);
});

test("Float32Array vectors count as embedded", () => {
  assert.equal(hasValidEmbedding({ embedding: new Float32Array([1, 2]) }), true);
  assert.equal(hasValidEmbedding({ embedding: [] }), false);
  assert.equal(hasValidEmbedding({ embedding: new Float32Array(0) }), false);
  assert.equal(hasValidEmbedding({ embedding: "nope" }), false);
  assert.equal(hasValidEmbedding({}), false);
  const current = stateOf([["A.md", "r1", 1]]);
  current.notes["A.md"].chunks[0].embedding = new Float32Array([1, 0]);
  const delta = computeRetrievalDelta({ current, records: recordsOf([["A.md", "r1"]]), embeddings: true, semantic: SEMANTIC_ON });
  assert.equal(delta.changed, false);
});

test("the committed state is not mutated", () => {
  const current = stateOf([["A.md", "r1", 1]]);
  const snapshot = JSON.stringify(current);
  computeRetrievalDelta({ current, records: recordsOf([["A.md", "r2"], ["B.md", "r1"]]), force: true, embeddings: true, semantic: SEMANTIC_ON });
  assert.equal(JSON.stringify(current), snapshot);
});

test("duplicate record paths are rejected instead of silently collapsing", () => {
  const current = stateOf([]);
  assert.throws(() => computeRetrievalDelta({ current, records: [{ path: "A.md", revision: "r1" }, { path: "A.md", revision: "r2" }], semantic: SEMANTIC_ON }), /duplicate record path/u);
});

test("malformed inputs are rejected", () => {
  assert.throws(() => computeRetrievalDelta({ current: null, records: [] }), /current must be a retrieval state object/u);
  assert.throws(() => computeRetrievalDelta({ current: stateOf([]), records: null }), /records must be an array/u);
  assert.throws(() => computeRetrievalDelta({ current: { notes: null }, records: [] }), /current\.notes must be an object map/u);
  assert.throws(() => computeRetrievalDelta({ current: stateOf([]), records: [{}] }), /non-empty string path/u);
  assert.throws(() => computeRetrievalDelta({ current: stateOf([]), records: [{ path: "" }] }), /non-empty string path/u);
});
