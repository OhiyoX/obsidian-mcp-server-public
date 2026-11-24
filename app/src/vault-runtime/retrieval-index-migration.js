// M2 — one-way, zero-embedding migration from the legacy JSON index to v2.
//
// The legacy file is read once, in the caller's (offline) process, and never
// written. A published v2 generation always wins: migration refuses to overwrite
// it, so an operator cannot silently roll new data back to a stale v1 copy.
// No embedding provider is involved — this only re-encodes vectors that exist.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export const RETRIEVAL_INDEX_MIGRATION_REQUIRED = "retrieval_index_migration_required";
const DEFAULT_LIMIT_BYTES = 1024 * 1024 * 1024;
const singleFlight = new Map();

function fail(detail) {
  throw new Error(`vault-runtime/retrieval-index-migration: ${detail}`);
}

function vectorOf(chunk, dimension) {
  const embedding = chunk.embedding;
  if (embedding === undefined || embedding === null) return { embedding: undefined, dimension };
  if (!(Array.isArray(embedding) || ArrayBuffer.isView(embedding))) fail(`chunk ${JSON.stringify(chunk.id)} has a non-array embedding`);
  if (embedding.length === 0) return { embedding: undefined, dimension };
  if (dimension !== null && embedding.length !== dimension) fail(`chunk ${JSON.stringify(chunk.id)} has dimension ${embedding.length}, expected ${dimension}`);
  return { embedding: Float32Array.from(embedding), dimension: embedding.length };
}

/**
 * Converts `legacyIndexPath` into `store` and verifies the roundtrip.
 *
 * Returns `{ status, convertedNotes, convertedVectors, formatVersion, sourceDigest }`
 * where status is `migrated`, `already-migrated` or `no-legacy`. `limitBytes`
 * refuses an unexpectedly large file before it is parsed into memory.
 */
export async function migrateLegacyIndex({ legacyIndexPath, store, limitBytes = DEFAULT_LIMIT_BYTES } = {}) {
  if (typeof legacyIndexPath !== "string" || legacyIndexPath === "") fail("legacyIndexPath is required");
  if (store === null || typeof store !== "object" || typeof store.load !== "function" || typeof store.commit !== "function") fail("store must be an openIndexStore() instance");
  if (!Number.isInteger(limitBytes) || limitBytes <= 0) fail("limitBytes must be a positive integer");

  const key = legacyIndexPath;
  const running = singleFlight.get(key);
  if (running !== undefined) return running;
  const task = (async () => {
    const existing = await store.load();
    if (existing !== null) return { status: "already-migrated", convertedNotes: 0, convertedVectors: 0, formatVersion: 2, sourceDigest: existing.generation ?? null };
    const stat = await fs.stat(legacyIndexPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) return { status: "no-legacy", convertedNotes: 0, convertedVectors: 0, formatVersion: 2, sourceDigest: null };
    if (stat.size > limitBytes) fail(`legacy index is ${stat.size} bytes, above the ${limitBytes}-byte migration limit; convert an offline copy instead`);
    const bytes = await fs.readFile(legacyIndexPath);
    const sourceDigest = createHash("sha256").update(bytes).digest("hex");
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      fail(`legacy index is not valid JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || parsed.version !== 1) fail(`legacy index version must be 1, got ${JSON.stringify(parsed?.version)}`);
    if (parsed.notes === null || typeof parsed.notes !== "object" || Array.isArray(parsed.notes)) fail("legacy index notes must be an object map");
    const notes = {};
    let dimension = null;
    let convertedVectors = 0;
    for (const [notePath, note] of Object.entries(parsed.notes)) {
      if (note === null || typeof note !== "object") fail(`legacy note ${JSON.stringify(notePath)} is not an object`);
      if (!Array.isArray(note.chunks)) fail(`legacy note ${JSON.stringify(notePath)} has no chunks array`);
      const chunks = note.chunks.map((chunk, ordinal) => {
        if (chunk === null || typeof chunk !== "object") fail(`legacy note ${JSON.stringify(notePath)} chunk ${ordinal} is not an object`);
        if (typeof chunk.id !== "string" || chunk.id === "") fail(`legacy note ${JSON.stringify(notePath)} chunk ${ordinal} has no id`);
        const converted = vectorOf(chunk, dimension);
        if (converted.dimension !== null) dimension = converted.dimension;
        if (converted.embedding !== undefined) convertedVectors += 1;
        return {
          id: chunk.id,
          ordinal: Number.isInteger(chunk.ordinal) ? chunk.ordinal : ordinal,
          heading: typeof chunk.heading === "string" ? chunk.heading : "",
          text: typeof chunk.text === "string" ? chunk.text : "",
          hash: typeof chunk.hash === "string" && chunk.hash !== "" ? chunk.hash : `legacy-${ordinal}`,
          embedding: converted.embedding,
        };
      });
      notes[notePath] = {
        path: notePath,
        revision: typeof note.revision === "string" && note.revision !== "" ? note.revision : sourceDigest,
        stat: note.stat ?? null,
        metadata: note.metadata ?? null,
        chunks,
      };
    }
    const state = { version: 2, updatedAt: parsed.updatedAt ?? null, embeddingModel: parsed.embeddingModel ?? null, notes };
    const report = await store.commit(state, Object.keys(notes));
    const verified = await store.load();
    if (verified === null) fail("the store did not publish the migrated generation");
    if (Object.keys(verified.notes).length !== Object.keys(notes).length) fail("migrated note count does not match the legacy index");
    for (const [notePath, note] of Object.entries(notes)) {
      const loaded = verified.notes[notePath];
      if (loaded === undefined) fail(`migrated generation lost note ${JSON.stringify(notePath)}`);
      if (loaded.chunks.length !== note.chunks.length) fail(`migrated note ${JSON.stringify(notePath)} has ${loaded.chunks.length} chunks, expected ${note.chunks.length}`);
      for (let index = 0; index < note.chunks.length; index += 1) {
        const expected = note.chunks[index].embedding;
        const actual = loaded.chunks[index].embedding;
        if ((expected === undefined) !== (actual === undefined)) fail(`migrated chunk ${JSON.stringify(note.chunks[index].id)} changed its embedding presence`);
        if (expected !== undefined) {
          for (let component = 0; component < expected.length; component += 1) {
            if (actual[component] !== Math.fround(expected[component])) fail(`migrated chunk ${JSON.stringify(note.chunks[index].id)} lost float precision at ${component}`);
          }
        }
      }
    }
    return {
      status: "migrated",
      convertedNotes: Object.keys(notes).length,
      convertedVectors,
      formatVersion: 2,
      sourceDigest,
      generation: report.generation,
      objectBytes: report.objectBytes,
    };
  })();
  singleFlight.set(key, task);
  try {
    return await task;
  } finally {
    singleFlight.delete(key);
  }
}

/**
 * Convenience check for a runtime that starts with no v2 generation: a non-empty
 * legacy file means "migration required", never "empty index".
 */
export async function legacyIndexState(legacyIndexPath) {
  const stat = await fs.stat(legacyIndexPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (stat === null) return { present: false, bytes: 0 };
  return { present: true, bytes: stat.size };
}

