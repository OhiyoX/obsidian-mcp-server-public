// Selective ZIP parsing and single-entry reading (issue #254).
//
// This module owns the one ZIP central-directory parser shared by the archive
// tools. `inspectZipBuffer` moved here from `file-transfer.js` (which now
// re-exports it, byte for byte) so inspection and selective reading cannot
// drift apart. `createZipArchive`/`extractZipArchive` keep using fflate; the
// read path below never calls a whole-archive unzip and only decodes the
// requested entry, streaming it in bounded chunks.
import { createHash } from "node:crypto";
import path from "node:path";
import { createInflateRaw } from "node:zlib";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_INLINE_TRANSFER_BYTES,
} from "../config.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const LOCAL_FILE_HEADER_BYTES = 30;
const CENTRAL_FILE_HEADER_BYTES = 46;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const READ_CHUNK_BYTES = 64 * 1024;
// Kept identical to `PROTECTED_ROOTS` in `file-transfer.js`: transfer paths and
// archive entries reject the same protected Vault internals.
const PROTECTED_VAULT_ROOTS = new Set([".git", ".obsidian"]);
const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

// Incremental CRC32 over the full entry. `digest()` returns 8 lowercase hex digits.
function createCrc32() {
  let state = 0xffffffff;
  return {
    update(chunk) {
      for (let index = 0; index < chunk.length; index += 1) state = (CRC32_TABLE[(state ^ chunk[index]) & 0xff] ^ (state >>> 8)) >>> 0;
      return this;
    },
    digest() {
      return ((state ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
    },
  };
}

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("Invalid ZIP: end-of-central-directory record not found");
}

export function safeArchiveEntry(name) {
  const raw = String(name).replaceAll("\\", "/");
  if (!raw || raw.includes("\0") || /[\r\n]/.test(raw) || raw.startsWith("/") || /^[a-z]:/i.test(raw)) throw new Error(`Unsafe archive entry: ${JSON.stringify(name)}`);
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) throw new Error(`Archive path traversal denied: ${JSON.stringify(name)}`);
  const first = normalized.split("/")[0].toLowerCase();
  if (PROTECTED_VAULT_ROOTS.has(first)) throw new Error(`Archive entry targets protected Vault internals: ${name}`);
  return normalized;
}

// Private central-directory parse: keeps the per-entry metadata selective
// reading needs (local header offset, method, CRC) that the public manifest
// deliberately does not expose.
export function parseZipCentralDirectory(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error(`Archive exceeds MAX_ARCHIVE_BYTES (${MAX_ARCHIVE_BYTES})`);
  const eocdOffset = findEocd(buffer);
  const count = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (count > MAX_ARCHIVE_ENTRIES) throw new Error(`Archive contains ${count} entries; limit is ${MAX_ARCHIVE_ENTRIES}`);
  if (centralOffset + centralSize > eocdOffset) throw new Error("Invalid ZIP central directory bounds");
  const entries = [];
  const seen = new Set();
  let offset = centralOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + CENTRAL_FILE_HEADER_BYTES > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_FILE_SIGNATURE) throw new Error("Invalid ZIP central directory entry");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + CENTRAL_FILE_HEADER_BYTES + fileNameLength + extraLength + commentLength;
    if (end > buffer.length) throw new Error("Invalid ZIP entry bounds");
    if ((flags & FLAG_ENCRYPTED) !== 0) throw new Error("Encrypted ZIP entries are not supported");
    const name = buffer.subarray(offset + CENTRAL_FILE_HEADER_BYTES, offset + CENTRAL_FILE_HEADER_BYTES + fileNameLength).toString("utf8");
    const directory = name.endsWith("/");
    const safePath = safeArchiveEntry(name);
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (unixType === 0xa000) throw new Error(`Symbolic links are not allowed in archives: ${name}`);
    if (!directory) {
      if (seen.has(safePath)) throw new Error(`Duplicate archive entry: ${safePath}`);
      seen.add(safePath);
      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error(`Archive expands beyond MAX_ARCHIVE_UNCOMPRESSED_BYTES (${MAX_ARCHIVE_UNCOMPRESSED_BYTES})`);
    }
    entries.push({ path: safePath, directory, flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset, externalAttributes });
    offset = end;
  }
  return {
    entries,
    entryCount: entries.length,
    fileCount: entries.filter((entry) => !entry.directory).length,
    compressedBytes: buffer.length,
    uncompressedBytes: totalUncompressedBytes,
    centralOffset,
    centralSize,
    eocdOffset,
  };
}

// Public manifest: same shape, same values and same rejections as the
// `inspectZipBuffer` that used to live in `file-transfer.js`.
export function inspectZipBuffer(buffer) {
  const parsed = parseZipCentralDirectory(buffer);
  return {
    format: "zip",
    entries: parsed.entries.map((entry) => ({ path: entry.path, directory: entry.directory, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize })),
    entryCount: parsed.entryCount,
    fileCount: parsed.fileCount,
    compressedBytes: parsed.compressedBytes,
    uncompressedBytes: parsed.uncompressedBytes,
  };
}

// Locates exactly one regular-file entry and validates its local header against
// the central directory. No basename or case-insensitive fallback.
export function locateZipEntry(buffer, entry) {
  const archive = toBuffer(buffer);
  const target = safeArchiveEntry(entry);
  const parsed = parseZipCentralDirectory(archive);
  const found = parsed.entries.find((candidate) => candidate.path === target);
  if (!found) throw new Error(`Archive entry not found: "${entry}"`);
  if (found.directory) throw new Error(`Archive entry is a directory: "${entry}"`);
  const { flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset } = found;
  if (localHeaderOffset + LOCAL_FILE_HEADER_BYTES > archive.length) throw new Error("Invalid ZIP local header bounds");
  if (archive.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) throw new Error("Invalid ZIP local header signature");
  const localFlags = archive.readUInt16LE(localHeaderOffset + 6);
  const localMethod = archive.readUInt16LE(localHeaderOffset + 8);
  const localCrc32 = archive.readUInt32LE(localHeaderOffset + 14);
  const localCompressedSize = archive.readUInt32LE(localHeaderOffset + 18);
  const localUncompressedSize = archive.readUInt32LE(localHeaderOffset + 22);
  const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
  const localNameStart = localHeaderOffset + LOCAL_FILE_HEADER_BYTES;
  const localNameEnd = localNameStart + localNameLength;
  const dataStart = localNameEnd + localExtraLength;
  if (localNameEnd > archive.length || dataStart > archive.length) throw new Error("Invalid ZIP local header bounds");
  if ((localFlags & FLAG_ENCRYPTED) !== 0 || (flags & FLAG_ENCRYPTED) !== 0) throw new Error("Encrypted ZIP entries are not supported");
  let localName;
  try {
    localName = safeArchiveEntry(archive.subarray(localNameStart, localNameEnd).toString("utf8"));
  } catch {
    throw new Error("ZIP local header filename mismatch");
  }
  if (localName !== found.path) throw new Error("ZIP local header filename mismatch");
  if (localMethod !== method) throw new Error("ZIP local header method mismatch");
  // General purpose bit 3 means the local sizes/CRC may be placeholders; the
  // central directory stays authoritative (and the descriptor is never scanned).
  if ((localFlags & FLAG_DATA_DESCRIPTOR) === 0 && (flags & FLAG_DATA_DESCRIPTOR) === 0) {
    if (localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) throw new Error("ZIP local header size mismatch");
    if (localCrc32 !== crc32) throw new Error("ZIP local header CRC mismatch");
  }
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > parsed.centralOffset || dataEnd > archive.length) throw new Error("ZIP entry compressed data is out of bounds");
  return { path: found.path, method, flags, crc32, compressedSize, uncompressedSize, dataStart, dataEnd };
}

function assertReadBudget(maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_INLINE_TRANSFER_BYTES) throw new Error(`maxBytes must be an integer between 1 and ${MAX_INLINE_TRANSFER_BYTES}`);
}

// Returns the prefix end that keeps every retained byte inside a complete UTF-8
// code point (never emits U+FFFD for a truncated entry).
function completeCodePointEnd(buffer) {
  const length = buffer.length;
  let index = length;
  let continuations = 0;
  while (index > 0 && continuations < 3 && (buffer[index - 1] & 0xc0) === 0x80) {
    index -= 1;
    continuations += 1;
  }
  if (index === 0) return length;
  const lead = buffer[index - 1];
  const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  return length - (index - 1) >= expected ? length : index - 1;
}

// Streams one raw DEFLATE payload through the JS-facing inflater with
// backpressure, so the compressed input is never queued in full.
function inflateEntry(compressed, onChunk) {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      reject(error);
    };
    inflater.on("error", () => fail(new Error("ZIP entry inflate failed")));
    inflater.on("data", (chunk) => {
      if (settled) return;
      try {
        onChunk(chunk);
      } catch (error) {
        fail(error);
      }
    });
    inflater.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    (async () => {
      for (let offset = 0; offset < compressed.length; offset += READ_CHUNK_BYTES) {
        if (settled) return;
        const part = compressed.subarray(offset, Math.min(offset + READ_CHUNK_BYTES, compressed.length));
        if (!inflater.write(part)) await new Promise((resume) => { inflater.once("drain", resume); inflater.once("close", resume); });
      }
      if (!settled) inflater.end();
    })().catch(() => fail(new Error("ZIP entry inflate failed")));
  });
}

// Reads exactly one entry: decompresses only the target's compressed range,
// verifies size/CRC against the central directory over the full content, and
// retains at most `maxBytes` bytes of text prefix.
export async function readZipEntryFromBuffer(buffer, entry, { maxBytes } = {}) {
  assertReadBudget(maxBytes);
  const archive = toBuffer(buffer);
  const located = locateZipEntry(archive, entry);
  if (located.method !== METHOD_STORE && located.method !== METHOD_DEFLATE) throw new Error(`Unsupported ZIP compression method: ${located.method}`);
  const compressed = archive.subarray(located.dataStart, located.dataEnd);
  const digest = createHash("sha256");
  const crc32 = createCrc32();
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  // Retention bound: parts hold at most `maxBytes` bytes of the target entry.
  const parts = [];
  let retainedBytes = 0;
  let actualSize = 0;
  let invalidUtf8 = false;
  let hasNul = false;
  const consume = (chunk) => {
    if (chunk.length === 0) return;
    actualSize += chunk.length;
    if (actualSize > located.uncompressedSize) throw new Error("ZIP entry size mismatch");
    if (actualSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error(`Archive expands beyond MAX_ARCHIVE_UNCOMPRESSED_BYTES (${MAX_ARCHIVE_UNCOMPRESSED_BYTES})`);
    digest.update(chunk);
    crc32.update(chunk);
    if (!invalidUtf8) {
      try {
        utf8.decode(chunk, { stream: true });
      } catch {
        invalidUtf8 = true;
      }
    }
    if (!hasNul && chunk.includes(0)) hasNul = true;
    if (retainedBytes < maxBytes) {
      const take = Math.min(maxBytes - retainedBytes, chunk.length);
      parts.push(chunk.subarray(0, take));
      retainedBytes += take;
    }
  };
  if (located.method === METHOD_STORE) {
    for (let offset = 0; offset < compressed.length; offset += READ_CHUNK_BYTES) consume(compressed.subarray(offset, Math.min(offset + READ_CHUNK_BYTES, compressed.length)));
  } else {
    await inflateEntry(compressed, consume);
  }
  if (!invalidUtf8) {
    try {
      utf8.decode();
    } catch {
      invalidUtf8 = true;
    }
  }
  if (actualSize !== located.uncompressedSize) throw new Error("ZIP entry size mismatch");
  const entryCrc32 = crc32.digest();
  if (entryCrc32 !== located.crc32.toString(16).padStart(8, "0")) throw new Error("ZIP entry CRC mismatch");
  const sha256 = digest.digest("hex");
  const result = {
    entry: located.path,
    path: located.path,
    size: actualSize,
    compressedSize: located.compressedSize,
    encoding: !invalidUtf8 && !hasNul ? "text" : "binary",
    truncated: false,
    returnedBytes: 0,
    sha256,
    crc32: entryCrc32,
  };
  if (result.encoding === "binary") return result;
  const retained = Buffer.concat(parts, retainedBytes);
  const contentBytes = retained.subarray(0, completeCodePointEnd(retained));
  return { ...result, content: contentBytes.toString("utf8"), truncated: actualSize > contentBytes.length, returnedBytes: contentBytes.length };
}

// File-level wrapper with the same guard semantics as `inspectZipFile`: Vault
// bound transfer path (including protected roots), `.zip` only, canonical
// containment, then `MAX_ARCHIVE_BYTES`. The guards live in `file-transfer.js`;
// the dynamic import keeps the module graph acyclic without duplicating them.
export async function readZipEntryFile(vaultPath, entry, { maxBytes } = {}) {
  assertReadBudget(maxBytes);
  const { openVaultZipArchiveForRead } = await import("../file-transfer.js");
  const archive = await openVaultZipArchiveForRead(vaultPath);
  const result = await readZipEntryFromBuffer(archive.buffer, entry, { maxBytes });
  const archiveSha256 = createHash("sha256").update(archive.buffer).digest("hex");
  return { ...result, archivePath: archive.vaultPath, archiveSha256, archiveRevision: `sha256:${archiveSha256}` };
}
