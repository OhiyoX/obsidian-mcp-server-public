// M2 — v2 shard codec and manifest validation (plan 02 Task 1).
//
// The codec is the trust boundary between a file on disk and the ranking math, so
// these tests attack it: wrong magic, wrong version, truncated payload, extra
// bytes, mismatched digest, non-finite components, ragged dimensions and unsafe
// note paths must all fail closed. No embedding provider is ever involved.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DIMENSION,
  SHARD_HEADER_BYTES,
  decodeVectorShard,
  encodeVectorShard,
  validateManifest,
} from "../src/vault-runtime/retrieval-index-codec.js";

const MODEL = "openai:qwen3-embedding-4b-q6:1024";

function noteOf(chunks, notePath = "A.md") {
  return { path: notePath, revision: "r1", chunks };
}

function chunkOf(id, embedding, { heading = "", text = "t" } = {}) {
  return { id, hash: `hash-${id}`, heading, text, embedding };
}

function manifestOf(notes, overrides = {}) {
  return { format: "v2", modelIdentity: MODEL, updatedAt: "2026-11-22T00:00:00.000Z", notes, ...overrides };
}

test("roundtrip keeps float32 precision for 1024 and 768 dimensions", () => {
  for (const dimension of [1024, 768]) {
    const embedding = Float32Array.from({ length: dimension }, (_unused, index) => Math.fround((index % 17) / 17));
    const encoded = encodeVectorShard(noteOf([chunkOf("A.md#0", embedding)]), MODEL);
    assert.equal(encoded.dimension, dimension);
    assert.equal(encoded.count, 1);
    assert.equal(encoded.sha256, encoded.sha256.toLowerCase());
    const decoded = decodeVectorShard(encoded.bytes, { sha256: encoded.sha256, dimension, count: 1 });
    assert.equal(decoded.dimension, dimension);
    assert.equal(decoded.count, 1);
    for (let index = 0; index < dimension; index += 1) {
      assert.equal(decoded.vectors[0][index], Math.fround(embedding[index]));
    }
  }
});

test("plain number arrays encode to the same bytes as Float32Array", () => {
  const numbers = [0.1, 0.2, 0.3];
  const typed = Float32Array.from(numbers);
  const fromNumbers = encodeVectorShard(noteOf([chunkOf("A.md#0", numbers)]), MODEL);
  const fromTyped = encodeVectorShard(noteOf([chunkOf("A.md#0", typed)]), MODEL);
  assert.equal(fromNumbers.sha256, fromTyped.sha256);
});

test("chunks without vectors stay out of the shard and keep their own indexes", () => {
  const encoded = encodeVectorShard(noteOf([
    chunkOf("A.md#0", undefined),
    chunkOf("A.md#1", [1, 0]),
    chunkOf("A.md#2", [0, 1]),
  ]), MODEL);
  assert.equal(encoded.count, 2);
  assert.deepEqual([...encoded.vectorIndexByChunkId.keys()], ["A.md#1", "A.md#2"]);
  assert.equal(encoded.vectorIndexByChunkId.get("A.md#2"), 1);
});

test("a note with no vectors produces a zero-vector shard", () => {
  const encoded = encodeVectorShard(noteOf([chunkOf("A.md#0", undefined)]), MODEL);
  assert.equal(encoded.count, 0);
  assert.equal(encoded.dimension, 0);
  const decoded = decodeVectorShard(encoded.bytes, { sha256: encoded.sha256 });
  assert.deepEqual(decoded.vectors, []);
});

test("CJK note paths and headings survive encode and manifest validation", () => {
  const encoded = encodeVectorShard(noteOf([chunkOf("中文/笔记.md#0", [0.5, 0.25], { heading: "标题", text: "正文" })], "中文/笔记.md"), MODEL);
  const manifest = validateManifest(manifestOf([{
    path: "中文/笔记.md",
    revision: "sha256:abc",
    stat: { mtimeMs: 1 },
    metadata: { title: "笔记" },
    dimension: 2,
    vectorObject: encoded.sha256,
    chunks: [{ id: "中文/笔记.md#0", heading: "标题", text: "正文", hash: "h", vectorIndex: 0 }],
  }]));
  assert.equal(manifest.notes[0].path, "中文/笔记.md");
  assert.equal(manifest.notes[0].chunks[0].vectorIndex, 0);
  assert.equal(manifest.modelIdentity, MODEL);
});

test("bad magic, version, reserved bytes and payload length are rejected", () => {
  const { bytes } = encodeVectorShard(noteOf([chunkOf("A.md#0", [1, 2])]), MODEL);
  const badMagic = Buffer.from(bytes);
  badMagic.write("XXXX", 0, "latin1");
  assert.throws(() => decodeVectorShard(badMagic), /bad magic/u);

  const badVersion = Buffer.from(bytes);
  badVersion.writeUInt8(9, 4);
  assert.throws(() => decodeVectorShard(badVersion), /unsupported shard version/u);

  const badReserved = Buffer.from(bytes);
  badReserved.writeUInt8(1, 6);
  assert.throws(() => decodeVectorShard(badReserved), /reserved header bytes/u);

  assert.throws(() => decodeVectorShard(bytes.subarray(0, bytes.length - 4)), /payload length|holds/u);
  assert.throws(() => decodeVectorShard(Buffer.concat([bytes, Buffer.alloc(4)])), /payload length|holds/u);
  assert.throws(() => decodeVectorShard(bytes.subarray(0, 8)), /shorter than/u);
});

test("digest and dimension expectations are enforced", () => {
  const { bytes, sha256 } = encodeVectorShard(noteOf([chunkOf("A.md#0", [1, 2])]), MODEL);
  assert.throws(() => decodeVectorShard(bytes, { sha256: "0".repeat(64) }), /does not match the manifest/u);
  assert.throws(() => decodeVectorShard(bytes, { dimension: 3 }), /does not match the manifest 3/u);
  assert.throws(() => decodeVectorShard(bytes, { count: 2 }), /does not match the manifest 2/u);
  assert.equal(decodeVectorShard(bytes, { sha256 }).sha256, sha256);
});

test("non-finite and ragged vectors are rejected at encode time", () => {
  assert.throws(() => encodeVectorShard(noteOf([chunkOf("A.md#0", [1, Number.NaN])]), MODEL), /not a finite number/u);
  assert.throws(() => encodeVectorShard(noteOf([chunkOf("A.md#0", [1, Infinity])]), MODEL), /not a finite number/u);
  assert.throws(() => encodeVectorShard(noteOf([chunkOf("A.md#0", [1, 2]), chunkOf("A.md#1", [1, 2, 3])]), MODEL), /dimension 3, expected 2/u);
  assert.throws(() => encodeVectorShard(noteOf([chunkOf("A.md#0", new Float32Array(MAX_DIMENSION + 1))]), MODEL), /unsupported dimension/u);
  assert.throws(() => encodeVectorShard(noteOf([chunkOf("", [1])]), MODEL), /non-empty string id/u);
  assert.throws(() => encodeVectorShard(noteOf([chunkOf("A.md#0", [1])]), ""), /modelIdentity/u);
  assert.throws(() => encodeVectorShard({ path: "A.md" }, MODEL), /chunks must be an array/u);
});

test("a corrupted payload with a matching header cannot produce a finite vector", () => {
  const { bytes } = encodeVectorShard(noteOf([chunkOf("A.md#0", [1, 2])]), MODEL);
  const corrupted = Buffer.from(bytes);
  corrupted.writeUInt32LE(0x7fc00000, SHARD_HEADER_BYTES); // NaN
  assert.throws(() => decodeVectorShard(corrupted), /not finite/u);
});

test("manifest validation rejects unsafe paths and inconsistent vector indexes", () => {
  const base = {
    path: "A.md",
    revision: "r1",
    stat: null,
    metadata: null,
    dimension: 2,
    vectorObject: "a".repeat(64),
    chunks: [{ id: "A.md#0", heading: "", text: "t", hash: "h", vectorIndex: 0 }],
  };
  for (const unsafe of ["/absolute.md", "../escape.md", "a//b.md", "C:\\win.md", "a\\b.md", "", "nul\0.md"]) {
    assert.throws(() => validateManifest(manifestOf([{ ...base, path: unsafe }])), /note path/u, unsafe);
  }
  assert.throws(() => validateManifest(manifestOf([base, base])), /duplicate note path/u);
  assert.throws(() => validateManifest(manifestOf([{ ...base, chunks: [{ ...base.chunks[0], vectorIndex: -1 }] }])), /non-negative integer/u);
  assert.throws(() => validateManifest(manifestOf([{ ...base, chunks: [{ ...base.chunks[0], vectorIndex: 1 }] }])), /vectorIndex 0 is missing/u);
  assert.throws(() => validateManifest(manifestOf([{ ...base, vectorObject: "XYZ" }])), /lowercase sha256/u);
  assert.throws(() => validateManifest(manifestOf([{ ...base, vectorObject: null }])), /no vectorObject/u);
  assert.throws(() => validateManifest(manifestOf([{ ...base, chunks: [{ ...base.chunks[0], vectorIndex: null }] }])), /without a vectorObject|but no vectorObject|has a vectorObject/u);
  assert.throws(() => validateManifest(manifestOf([base], { format: "v1" })), /format must be "v2"/u);
  assert.throws(() => validateManifest(null), /manifest must be an object/u);
});

test("a manifest can describe a note without vectors", () => {
  const manifest = validateManifest(manifestOf([{
    path: "plain.md",
    revision: "r1",
    stat: { mtimeMs: 2 },
    metadata: { title: "plain" },
    dimension: 0,
    vectorObject: null,
    chunks: [{ id: "plain.md#0", heading: "", text: "text", hash: "h", vectorIndex: null }],
  }]));
  assert.equal(manifest.notes[0].chunks[0].vectorIndex, null);
  assert.equal(manifest.notes[0].vectorObject, null);
});

test("validation never mutates the input manifest", () => {
  const input = manifestOf([{
    path: "A.md",
    revision: "r1",
    stat: null,
    metadata: null,
    dimension: 2,
    vectorObject: "b".repeat(64),
    chunks: [{ id: "A.md#0", heading: "", text: "t", hash: "h", vectorIndex: 0 }],
  }]);
  const snapshot = JSON.stringify(input);
  validateManifest(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test("a finite value that overflows float32 is refused at encode time", () => {
  assert.throws(() => encodeVectorShard(noteOf([chunkOf("A.md#0", [1e300, 1])]), MODEL), /does not fit float32/u);
  assert.throws(() => encodeVectorShard(noteOf([chunkOf("A.md#0", [-3.5e38, 1])]), MODEL), /does not fit float32/u);
  const ok = encodeVectorShard(noteOf([chunkOf("A.md#0", [3e38, 1])]), MODEL);
  assert.equal(ok.count, 1);
  assert.equal(decodeVectorShard(ok.bytes).count, 1);
});
