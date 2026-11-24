// M1 — pure delta decision for a retrieval index refresh.
//
// Contract: "DESIGN - 检索内存优化与二进制索引 v2" §数据流/增量同步语义; plan
// "2026-11-22-retrieval-memory-01-noop-and-baseline" Task 2.
//
// `syncIndexUnlocked` used to `structuredClone` the whole state, rebuild it and
// `JSON.stringify` it on every refresh, even when no note had changed (a recall
// schedules a refresh every 10 s). This module answers one question — does this
// refresh need to touch the index at all — with no cloning, no IO and no mutation
// of `current`. The runtime keeps the old update path for a real change; M2/M3
// replace that path with per-note binary shards.

/**
 * A chunk has an embedding when it carries a non-empty numeric vector. The v2
 * index stores `Float32Array`; the legacy JSON index stores `number[]`, so both
 * count here and no caller has to test `Array.isArray` (spec: status parity).
 */
export function hasValidEmbedding(chunk) {
  const embedding = chunk?.embedding;
  if (embedding === null || embedding === undefined) return false;
  if (Array.isArray(embedding) || ArrayBuffer.isView(embedding)) return embedding.length > 0;
  return false;
}

function fail(detail) {
  throw new Error(`vault-runtime/retrieval-index-delta: ${detail}`);
}

function notesOf(current) {
  const notes = current?.notes;
  if (notes === null || typeof notes !== "object" || Array.isArray(notes)) fail(`current.notes must be an object map, got ${notes === null ? "null" : typeof notes}`);
  return notes;
}

/**
 * `current` is the committed retrieval state (read-only here). `records` are this
 * Vault's index records in provider order. `semantic` is the live
 * `semanticConfiguration()`; only `enabled` and `identity` are read.
 *
 * `changedPaths` keeps `records` order; `removedPaths` lists committed notes the
 * provider no longer returns. `changed` is true when any note must be (re)written,
 * when the embedding model identity moved under an enabled provider, or when
 * `force` asks for an explicit rebuild. A missing embedding counts only when the
 * caller wants embeddings from an enabled provider — otherwise the lexical path
 * legitimately keeps chunks without vectors.
 */
export function computeRetrievalDelta({ current, records, force = false, embeddings = false, semantic = null } = {}) {
  if (current === null || typeof current !== "object" || Array.isArray(current)) fail("current must be a retrieval state object");
  if (!Array.isArray(records)) fail("records must be an array of Vault index records");
  const notes = notesOf(current);
  const semanticEnabled = semantic?.enabled === true;
  const semanticIdentity = semanticEnabled ? semantic.identity ?? null : null;
  // A disabled provider must not invalidate stored vectors: they stay usable the
  // moment the provider is enabled again (legacy behaviour kept the file as is).
  const modelChanged = semanticEnabled && (current.embeddingModel ?? null) !== semanticIdentity;

  const seen = new Set();
  const changedPaths = [];
  let missingEmbeddings = false;
  for (const record of records) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) fail("each record must be an object");
    if (typeof record.path !== "string" || record.path === "") fail("each record must carry a non-empty string path");
    if (seen.has(record.path)) fail(`duplicate record path ${JSON.stringify(record.path)}`);
    seen.add(record.path);
    const existing = notes[record.path];
    if (force) {
      changedPaths.push(record.path);
      continue;
    }
    if (existing === undefined || existing === null || existing.revision !== record.revision) {
      changedPaths.push(record.path);
      continue;
    }
    if (embeddings && semanticEnabled) {
      const chunks = Array.isArray(existing.chunks) ? existing.chunks : [];
      if (chunks.some((chunk) => !hasValidEmbedding(chunk))) {
        missingEmbeddings = true;
        changedPaths.push(record.path);
      }
    }
  }
  // A new model identity invalidates every stored vector, so every note is rewritten.
  if (modelChanged && !force) changedPaths.splice(0, changedPaths.length, ...records.map((record) => record.path));
  const removedPaths = Object.keys(notes).filter((notePath) => !seen.has(notePath));
  const changed = force === true || modelChanged || removedPaths.length > 0 || changedPaths.length > 0;
  return { changed, changedPaths, removedPaths, modelChanged, missingEmbeddings };
}
