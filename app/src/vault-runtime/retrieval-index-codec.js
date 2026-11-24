// M2 — v2 vector shard codec and manifest validation (plan 02 Task 1).
//
// One note's vectors live in one immutable `objects/<sha256>.f32` file. The
// payload is IEEE-754 float32 little-endian behind a fixed header, so the loader
// can hand the bytes to `Float32Array` instead of parsing 400 MiB of decimal JSON
// into a two-byte V8 string (the M0 finding).
//
// Everything here is pure: no fs, no paths, no embedding calls. Bounds are checked
// before allocation, and a bad header, digest, length or non-finite value is an
// error — never an empty index.
import { createHash } from "node:crypto";

import { hasValidEmbedding } from "./retrieval-index-delta.js";

export const SHARD_MAGIC = "OBV2";
export const SHARD_VERSION = 1;
export const SHARD_HEADER_BYTES = 20;
export const MAX_DIMENSION = 16384;
export const MAX_VECTORS_PER_SHARD = 65536;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function fail(detail) {
  throw new Error(`vault-runtime/retrieval-index-codec: ${detail}`);
}

function assertVector(value, dimension, where) {
  if (!(Array.isArray(value) || ArrayBuffer.isView(value))) fail(`${where} must be a numeric array`);
  if (value.length !== dimension) fail(`${where} has dimension ${value.length}, expected ${dimension}`);
  for (let index = 0; index < value.length; index += 1) {
    const component = value[index];
    if (typeof component !== "number" || !Number.isFinite(component)) fail(`${where}[${index}] is not a finite number`);
    // A finite double can still overflow float32 (for example 1e300); writing it would
    // publish a shard that decode always rejects.
    if (!Number.isFinite(Math.fround(component))) fail(`${where}[${index}] does not fit float32 (${component})`);
  }
}

/**
 * Encodes every embedded chunk of one note into one shard. Chunk order defines
 * the vector order; `vectorIndexByChunkId` is the only mapping a manifest needs.
 * A note whose chunks are all unembedded yields a zero-vector shard (`count: 0`)
 * so the caller can store "no vectors" without inventing data.
 */
export function encodeVectorShard(note, modelIdentity) {
  if (typeof modelIdentity !== "string" || modelIdentity === "") fail("modelIdentity must be a non-empty string");
  if (note === null || typeof note !== "object" || Array.isArray(note)) fail("note must be an object");
  if (!Array.isArray(note.chunks)) fail("note.chunks must be an array");
  const vectors = [];
  const vectorIndexByChunkId = new Map();
  let dimension = null;
  for (const chunk of note.chunks) {
    if (chunk === null || typeof chunk !== "object") fail("each chunk must be an object");
    if (typeof chunk.id !== "string" || chunk.id === "") fail("each chunk must carry a non-empty string id");
    if (!hasValidEmbedding(chunk)) continue;
    const length = chunk.embedding.length;
    if (dimension === null) {
      if (!Number.isInteger(length) || length <= 0 || length > MAX_DIMENSION) fail(`chunk ${JSON.stringify(chunk.id)} has an unsupported dimension ${length}`);
      dimension = length;
    }
    assertVector(chunk.embedding, dimension, `chunk ${JSON.stringify(chunk.id)} embedding`);
    if (vectors.length >= MAX_VECTORS_PER_SHARD) fail(`a shard may hold at most ${MAX_VECTORS_PER_SHARD} vectors`);
    vectorIndexByChunkId.set(chunk.id, vectors.length);
    vectors.push(chunk.embedding);
  }
  const resolvedDimension = dimension ?? 0;
  const count = vectors.length;
  const payloadBytes = resolvedDimension * count * 4;
  const header = Buffer.alloc(SHARD_HEADER_BYTES);
  header.write(SHARD_MAGIC, 0, "latin1");
  header.writeUInt8(SHARD_VERSION, 4);
  header.writeUInt32LE(resolvedDimension, 8);
  header.writeUInt32LE(count, 12);
  header.writeUInt32LE(payloadBytes, 16);
  const payload = Buffer.alloc(payloadBytes);
  let offset = 0;
  for (const vector of vectors) {
    for (let index = 0; index < resolvedDimension; index += 1) {
      payload.writeFloatLE(vector[index], offset);
      offset += 4;
    }
  }
  const bytes = Buffer.concat([header, payload]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, vectorIndexByChunkId, dimension: resolvedDimension, count };
}

/**
 * Decodes a shard and verifies every byte it claims. `expected` may pin
 * `sha256`, `dimension` and `count`; the store derives those from the manifest,
 * so a swapped or truncated object cannot pass as valid.
 */
export function decodeVectorShard(bytes, expected = {}) {
  if (!Buffer.isBuffer(bytes)) fail("shard bytes must be a Buffer");
  if (bytes.length < SHARD_HEADER_BYTES) fail(`shard is ${bytes.length} bytes, shorter than the ${SHARD_HEADER_BYTES}-byte header`);
  if (bytes.toString("latin1", 0, 4) !== SHARD_MAGIC) fail(`bad magic ${JSON.stringify(bytes.toString("latin1", 0, 4))}`);
  const version = bytes.readUInt8(4);
  if (version !== SHARD_VERSION) fail(`unsupported shard version ${version}`);
  if (bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) fail("reserved header bytes must be zero");
  const dimension = bytes.readUInt32LE(8);
  const count = bytes.readUInt32LE(12);
  const payloadBytes = bytes.readUInt32LE(16);
  if (dimension > MAX_DIMENSION) fail(`dimension ${dimension} exceeds the ${MAX_DIMENSION} limit`);
  if (count > MAX_VECTORS_PER_SHARD) fail(`count ${count} exceeds the ${MAX_VECTORS_PER_SHARD} limit`);
  if (payloadBytes !== dimension * count * 4) fail(`payload length ${payloadBytes} does not match ${count} vectors of ${dimension} float32 components`);
  if (bytes.length !== SHARD_HEADER_BYTES + payloadBytes) fail(`shard holds ${bytes.length} bytes, expected ${SHARD_HEADER_BYTES + payloadBytes}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expected.sha256 !== undefined && expected.sha256 !== sha256) fail(`shard digest ${sha256} does not match the manifest ${expected.sha256}`);
  if (expected.dimension !== undefined && expected.dimension !== dimension) fail(`shard dimension ${dimension} does not match the manifest ${expected.dimension}`);
  if (expected.count !== undefined && expected.count !== count) fail(`shard count ${count} does not match the manifest ${expected.count}`);
  const vectors = [];
  for (let index = 0; index < count; index += 1) {
    const vector = new Float32Array(dimension);
    for (let component = 0; component < dimension; component += 1) {
      const value = bytes.readFloatLE(SHARD_HEADER_BYTES + (index * dimension + component) * 4);
      if (!Number.isFinite(value)) fail(`vector ${index} component ${component} is not finite`);
      vector[component] = value;
    }
    vectors.push(vector);
  }
  return { vectors, dimension, count, sha256 };
}

/** A manifest path is a Vault-relative POSIX path; anything else fails closed. */
export function assertSafeNotePath(value) {
  if (typeof value !== "string" || value === "") fail("note path must be a non-empty string");
  if (value.includes("\0")) fail("note path must not contain NUL");
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) fail(`note path ${JSON.stringify(value)} must be Vault-relative`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) fail(`note path ${JSON.stringify(value)} must not contain empty, "." or ".." segments`);
  if (value.includes("\\")) fail(`note path ${JSON.stringify(value)} must use "/" separators`);
  return value;
}

function assertDigest(value, where) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(`${where} must be a lowercase sha256 hex digest`);
  return value;
}

/**
 * Validates a manifest and returns a normalized copy: format, model identity,
 * `updatedAt`, and notes carrying their chunks with an explicit
 * `vectorIndex | null`. Duplicate paths or chunk ids, non-contiguous vector
 * indexes and unsafe paths are rejected.
 */
export function validateManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) fail("manifest must be an object");
  if (manifest.format !== "v2") fail(`manifest format must be "v2", got ${JSON.stringify(manifest.format)}`);
  if (manifest.modelIdentity !== null && (typeof manifest.modelIdentity !== "string" || manifest.modelIdentity === "")) fail("manifest modelIdentity must be null or a non-empty string");
  if (manifest.updatedAt !== null && typeof manifest.updatedAt !== "string") fail("manifest updatedAt must be null or a string");
  if (!Array.isArray(manifest.notes)) fail("manifest notes must be an array");
  const seenPaths = new Set();
  const notes = manifest.notes.map((note) => {
    if (note === null || typeof note !== "object" || Array.isArray(note)) fail("each manifest note must be an object");
    const notePath = assertSafeNotePath(note.path);
    if (seenPaths.has(notePath)) fail(`duplicate note path ${JSON.stringify(notePath)}`);
    seenPaths.add(notePath);
    if (typeof note.revision !== "string" || note.revision === "") fail(`note ${JSON.stringify(notePath)} must carry a revision`);
    if (note.stat !== null && (typeof note.stat !== "object" || Array.isArray(note.stat))) fail(`note ${JSON.stringify(notePath)} stat must be an object or null`);
    if (note.metadata !== null && (typeof note.metadata !== "object" || Array.isArray(note.metadata))) fail(`note ${JSON.stringify(notePath)} metadata must be an object or null`);
    if (!Number.isInteger(note.dimension) || note.dimension < 0 || note.dimension > MAX_DIMENSION) fail(`note ${JSON.stringify(notePath)} dimension must be an integer in 0..${MAX_DIMENSION}`);
    const vectorObject = note.vectorObject === null || note.vectorObject === undefined ? null : assertDigest(note.vectorObject, `note ${JSON.stringify(notePath)} vectorObject`);
    if (!Array.isArray(note.chunks)) fail(`note ${JSON.stringify(notePath)} chunks must be an array`);
    const seenChunkIds = new Set();
    const seenVectorIndexes = new Set();
    const chunks = note.chunks.map((chunk, ordinal) => {
      if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)) fail(`note ${JSON.stringify(notePath)} has a non-object chunk`);
      if (typeof chunk.id !== "string" || chunk.id === "") fail(`note ${JSON.stringify(notePath)} has a chunk without an id`);
      if (seenChunkIds.has(chunk.id)) fail(`note ${JSON.stringify(notePath)} has duplicate chunk id ${JSON.stringify(chunk.id)}`);
      seenChunkIds.add(chunk.id);
      if (typeof chunk.heading !== "string") fail(`chunk ${JSON.stringify(chunk.id)} heading must be a string`);
      if (typeof chunk.text !== "string") fail(`chunk ${JSON.stringify(chunk.id)} text must be a string`);
      if (typeof chunk.hash !== "string" || chunk.hash === "") fail(`chunk ${JSON.stringify(chunk.id)} hash must be a non-empty string`);
      const vectorIndex = chunk.vectorIndex === null || chunk.vectorIndex === undefined ? null : chunk.vectorIndex;
      if (vectorIndex !== null) {
        if (!Number.isInteger(vectorIndex) || vectorIndex < 0) fail(`chunk ${JSON.stringify(chunk.id)} vectorIndex must be a non-negative integer or null`);
        if (seenVectorIndexes.has(vectorIndex)) fail(`chunk ${JSON.stringify(chunk.id)} reuses vectorIndex ${vectorIndex}`);
        seenVectorIndexes.add(vectorIndex);
      }
      return { id: chunk.id, ordinal, heading: chunk.heading, text: chunk.text, hash: chunk.hash, vectorIndex };
    });
    // Vector indexes must be exactly 0..n-1: the shard is decoded by position.
    const embedded = chunks.filter((chunk) => chunk.vectorIndex !== null).length;
    for (let index = 0; index < embedded; index += 1) {
      if (!seenVectorIndexes.has(index)) fail(`note ${JSON.stringify(notePath)} vectorIndex ${index} is missing`);
    }
    if (embedded > 0 && vectorObject === null) fail(`note ${JSON.stringify(notePath)} has ${embedded} embedded chunks but no vectorObject`);
    if (embedded === 0 && vectorObject !== null) fail(`note ${JSON.stringify(notePath)} has a vectorObject but no embedded chunk`);
    return { path: notePath, revision: note.revision, stat: note.stat ?? null, metadata: note.metadata ?? null, dimension: note.dimension, vectorObject, chunks };
  });
  return { format: "v2", modelIdentity: manifest.modelIdentity ?? null, updatedAt: manifest.updatedAt ?? null, notes };
}
