// Deterministic ZIP fixture builder for the issue #254 archive security matrix (lane A2).
//
// Why it exists: the three existing archive paths (inspect/create/extract) and the new
// selective reader need byte-level controllable lesion samples (CRC mismatch, local vs
// central disagreement, bit-3 placeholders, ZIP64 markers, encryption bits, duplicate or
// traversal names, symlink attributes, out-of-range compressed ranges, unsupported
// methods). Real bomb corpora or large binaries must never be committed, so every fixture
// is assembled here from fixed bytes only.
//
// Determinism: no randomness, no wall-clock time, no external file reads. The DOS
// timestamp fields are written from a fixed constant, so two calls with the same input
// produce byte-identical archives (asserted in test/archive-entry-security.test.js).
//
// Provenance of the legal baseline: fflate's `zipSync` is the reference writer. Each
// entry payload comes from a single-entry `zipSync` archive (level 6 -> DEFLATE, level 0
// -> STORE), and the container written below is byte-identical to `zipSync` output once
// fflate's wall-clock DOS timestamps are replaced by the fixed constant (asserted in the
// test file). The container is still assembled by this module because `zipSync` cannot
// express the lesion cases at all: duplicate stored names, bit-3 placeholders, oversized
// or truncated declarations, ZIP64 markers and per-entry flag overrides.
//
// Offline helpers (centralDirectoryRange / entryOffsets / patchBytes) exist so tests can
// address header fields byte-exactly instead of pattern-matching the whole buffer.

import { zipSync } from "fflate";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const VERSION = 20;
const FLAG_DATA_DESCRIPTOR = 0x08;
const LOCAL_FIXED = 30;
const CENTRAL_FIXED = 46;
const EOCD_FIXED = 22;
const DESCRIPTOR_FIXED = 16;
const EOCD_SEARCH_LIMIT = 65_557;
// 1980-01-01 00:00:00 in DOS format: the standard reproducible-build timestamp.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** Local CRC-32 (poly 0xedb88320). Deliberately not the production helper: the fixture side must not validate itself with the code under test. */
export function crc32Of(data) {
  const bytes = toBuffer(data);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function toBuffer(value, label = "value") {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Array.isArray(value)) return Buffer.from(value.map((byte) => { if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new RangeError(`zip-fixture-builder: ${label} byte values must be integers 0..255`); return byte; }));
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`zip-fixture-builder: ${label} must be a Buffer, Uint8Array, byte array or string`);
}

function toInteger(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`zip-fixture-builder: ${label} must be a uint32`);
  return value;
}

// Payload bytes exactly as the reference writer emits them, read back out of a
// single-entry fflate archive (headers are not reused, only the data region).
function payloadFor(name, data, method) {
  const reference = Buffer.from(zipSync({ [name]: new Uint8Array(data) }, { level: method === 0 ? 0 : 6 }));
  const declaredMethod = reference.readUInt16LE(8);
  if (declaredMethod !== method) throw new Error(`zip-fixture-builder: fflate emitted method ${declaredMethod}, expected ${method}`);
  const compressedSize = reference.readUInt32LE(18);
  const start = LOCAL_FIXED + reference.readUInt16LE(26) + reference.readUInt16LE(28);
  return reference.subarray(start, start + compressedSize);
}

function normalizeEntry(input, index) {
  if (!input || typeof input.name !== "string") throw new TypeError(`zipFixture entry ${index} requires a string name`);
  const method = input.method ?? 0;
  if (method !== 0 && method !== 8) throw new RangeError(`zipFixture entry ${index}: method must be 0 (STORE) or 8 (DEFLATE)`);
  const isDirectory = Boolean(input.isDirectory);
  const name = isDirectory && !input.name.endsWith("/") ? `${input.name}/` : input.name;
  const data = isDirectory ? Buffer.alloc(0) : toBuffer(input.data ?? Buffer.alloc(0), `entry ${index} data`);
  const truthCrc = crc32Of(data);
  return {
    name,
    data,
    method,
    flags: toInteger(input.flags, `entry ${index} flags`, 0),
    // `crc32` overrides the CRC declared in the central directory; the local header keeps
    // the true value unless localOverrides says otherwise.
    crc32: toInteger(input.crc32, `entry ${index} crc32`, truthCrc),
    externalAttributes: toInteger(input.externalAttributes, `entry ${index} externalAttributes`, 0),
    centralOverrides: input.centralOverrides ?? {},
    localOverrides: input.localOverrides ?? {},
    truthCrc,
  };
}

function writeLocalHeader(entry, payload) {
  const nameBytes = Buffer.from(entry.name, "utf8");
  const header = Buffer.alloc(LOCAL_FIXED + nameBytes.length);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(toInteger(entry.localOverrides.crc32, "local crc32", entry.truthCrc), 14);
  header.writeUInt32LE(toInteger(entry.localOverrides.compressedSize, "local compressedSize", payload.length), 18);
  header.writeUInt32LE(toInteger(entry.localOverrides.uncompressedSize, "local uncompressedSize", entry.data.length), 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  nameBytes.copy(header, LOCAL_FIXED);
  return { header, nameBytes };
}

function writeDataDescriptor(entry, payload) {
  const descriptor = Buffer.alloc(DESCRIPTOR_FIXED);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(entry.truthCrc, 4);
  descriptor.writeUInt32LE(payload.length, 8);
  descriptor.writeUInt32LE(entry.data.length, 12);
  return descriptor;
}

function writeCentralHeader(entry, nameBytes, payload, localHeaderOffset) {
  const header = Buffer.alloc(CENTRAL_FIXED + nameBytes.length);
  header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(VERSION, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(toInteger(entry.centralOverrides.crc32, "central crc32", entry.crc32), 16);
  header.writeUInt32LE(toInteger(entry.centralOverrides.compressedSize, "central compressedSize", payload.length), 20);
  header.writeUInt32LE(toInteger(entry.centralOverrides.uncompressedSize, "central uncompressedSize", entry.data.length), 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(entry.externalAttributes, 38);
  header.writeUInt32LE(localHeaderOffset, 42);
  nameBytes.copy(header, CENTRAL_FIXED);
  return header;
}

function writeEocd(count, centralSize, centralOffset, comment) {
  const eocd = Buffer.alloc(EOCD_FIXED + comment.length);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, EOCD_FIXED);
  return eocd;
}

/**
 * Build a deterministic ZIP archive.
 *
 * entries: [{ name, data, method?, flags?, crc32?, centralOverrides?, localOverrides?,
 *             externalAttributes?, isDirectory? }]
 *   - name           written verbatim (traversal/absolute/backslash/duplicate samples are allowed)
 *   - method         0 (default) or 8
 *   - flags          default 0; bit 3 (0x08) appends a real 16-byte data descriptor
 *   - crc32          overrides the CRC *declared in the central directory*
 *   - centralOverrides { crc32?, compressedSize?, uncompressedSize? } declared central values
 *   - localOverrides   { crc32?, compressedSize?, uncompressedSize? } declared local values (0 placeholders allowed)
 *   - isDirectory    forces a directory entry (trailing "/" is added when missing, data is empty)
 * options: { zip64?, eocdOverrides?: { count?, centralSize?, centralOffset? }, comment? }
 */
export function zipFixture(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError("zipFixture requires a non-empty entries array");
  const specs = entries.map(normalizeEntry);
  const localChunks = [];
  const records = [];
  let offset = 0;
  for (const spec of specs) {
    const payload = payloadFor(spec.name, spec.data, spec.method);
    const { header, nameBytes } = writeLocalHeader(spec, payload);
    localChunks.push(header, payload);
    let length = header.length + payload.length;
    if ((spec.flags & FLAG_DATA_DESCRIPTOR) !== 0) {
      const descriptor = writeDataDescriptor(spec, payload);
      localChunks.push(descriptor);
      length += descriptor.length;
    }
    records.push({ spec, nameBytes, payload, localHeaderOffset: offset });
    offset += length;
  }
  const centralOffset = offset;
  const centralChunks = [];
  let centralSize = 0;
  for (const record of records) {
    const header = writeCentralHeader(record.spec, record.nameBytes, record.payload, record.localHeaderOffset);
    centralChunks.push(header);
    centralSize += header.length;
  }
  const overrides = options.eocdOverrides ?? {};
  const zip64 = options.zip64 === true;
  const eocd = writeEocd(
    toInteger(overrides.count, "eocd count", zip64 ? 0xffff : records.length),
    toInteger(overrides.centralSize, "eocd centralSize", zip64 ? 0xffffffff : centralSize),
    toInteger(overrides.centralOffset, "eocd centralOffset", zip64 ? 0xffffffff : centralOffset),
    options.comment === undefined ? Buffer.alloc(0) : Buffer.from(String(options.comment), "utf8"),
  );
  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

function findEocdOffset(buffer) {
  const minimum = Math.max(0, buffer.length - EOCD_SEARCH_LIMIT);
  for (let offset = buffer.length - EOCD_FIXED; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("zip-fixture-builder: end-of-central-directory record not found");
}

/** { offset, size, count } of the central directory as declared by the EOCD. Throws when the EOCD is unreadable. */
export function centralDirectoryRange(buffer) {
  const bytes = toBuffer(buffer, "buffer");
  const eocd = findEocdOffset(bytes);
  return { offset: bytes.readUInt32LE(eocd + 16), size: bytes.readUInt32LE(eocd + 12), count: bytes.readUInt16LE(eocd + 10) };
}

/** { localHeaderOffset, centralHeaderOffset } for the first central entry whose stored name equals `name`, or null when absent. */
export function entryOffsets(buffer, name) {
  const bytes = toBuffer(buffer, "buffer");
  let { offset, count } = centralDirectoryRange(bytes);
  for (let index = 0; index < count; index += 1) {
    if (offset + CENTRAL_FIXED > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return null;
    const nameLength = bytes.readUInt16LE(offset + 28);
    const entryName = bytes.subarray(offset + CENTRAL_FIXED, offset + CENTRAL_FIXED + nameLength).toString("utf8");
    if (entryName === name) return { localHeaderOffset: bytes.readUInt32LE(offset + 42), centralHeaderOffset: offset };
    offset += CENTRAL_FIXED + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return null;
}

/** Apply [{ offset, bytes }] field edits and return a new buffer; the input buffer is never mutated. */
export function patchBytes(buffer, edits) {
  const copy = Buffer.from(toBuffer(buffer, "buffer"));
  for (const edit of edits ?? []) {
    const bytes = toBuffer(edit?.bytes, "edit bytes");
    if (!Number.isInteger(edit?.offset) || edit.offset < 0 || edit.offset + bytes.length > copy.length) {
      throw new RangeError(`zip-fixture-builder: patch at offset ${edit?.offset} is out of bounds`);
    }
    bytes.copy(copy, edit.offset);
  }
  return copy;
}
