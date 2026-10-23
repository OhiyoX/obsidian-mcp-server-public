// Focused tests for the selective ZIP reader core (issue #254).
//
// Scope: happy paths (STORE/DEFLATE, nested, empty, CRLF, CJK, emoji, maxBytes
// boundaries), general purpose bit 3 samples, the UTF-8 truncation matrix,
// binary classification, the no-whole-unzip structural proof, resource
// retention bounds, and CRC/SHA evidence.
//
// A2 owns `test/helpers/zip-fixture-builder.js`; until that lands this file
// keeps a small deterministic ZIP writer of its own (fixed bytes, no clock, no
// randomness) so structural cases (bit 3, corrupted central CRCs, undecodable
// payloads) can be expressed exactly.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { unzipSync, zipSync } from "fflate";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-archive-reader-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";

const {
  inspectZipBuffer,
  locateZipEntry,
  parseZipCentralDirectory,
  readZipEntryFromBuffer,
  readZipEntryFile,
} = await import("../src/archive/zip.js");
const { inspectZipBuffer: inspectZipBufferFromTransfer, inspectZipFile } = await import("../src/file-transfer.js");
const { MAX_INLINE_TRANSFER_BYTES } = await import("../src/config.js");

after(() => fs.rm(root, { recursive: true, force: true }));

const utf8 = (value) => Buffer.from(value, "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const crc32Hex = (value) => (crc32(value) >>> 0).toString(16).padStart(8, "0");

// Largest code-point-aligned prefix of `text` within `maxBytes` UTF-8 bytes.
function expectedPrefix(text, maxBytes) {
  let bytes = 0;
  let prefix = "";
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint);
    if (bytes + size > maxBytes) break;
    bytes += size;
    prefix += codePoint;
  }
  return prefix;
}

function buildZipArchive(specs) {
  const body = [];
  const records = [];
  let offset = 0;
  for (const spec of specs) {
    const name = utf8(spec.path);
    const content = Buffer.isBuffer(spec.data) ? spec.data : utf8(spec.data ?? "");
    const method = spec.method ?? 8;
    const payload = spec.payload ?? (method === 8 ? Buffer.from(deflateRawSync(content)) : content);
    const crc = (spec.crc ?? crc32(content)) >>> 0;
    const flags = (spec.flags ?? 0) | (spec.bit3 ? 0x0008 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(spec.bit3 ? 0 : crc, 14);
    local.writeUInt32LE(spec.bit3 ? 0 : payload.length, 18);
    local.writeUInt32LE(spec.bit3 ? 0 : content.length, 22);
    local.writeUInt16LE(name.length, 26);
    body.push(local, name, payload);
    if (spec.bit3) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(payload.length, 8);
      descriptor.writeUInt32LE(content.length, 12);
      body.push(descriptor);
    }
    records.push({
      name,
      method,
      flags,
      crc,
      compressedSize: payload.length,
      uncompressedSize: content.length,
      localHeaderOffset: offset,
      externalAttributes: spec.externalAttributes ?? 0,
    });
    offset += local.length + name.length + payload.length + (spec.bit3 ? 16 : 0);
  }
  const centralOffset = offset;
  const central = [];
  let centralSize = 0;
  for (const record of records) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(record.flags, 8);
    header.writeUInt16LE(record.method, 10);
    header.writeUInt32LE(record.crc, 16);
    header.writeUInt32LE(record.compressedSize, 20);
    header.writeUInt32LE(record.uncompressedSize, 24);
    header.writeUInt16LE(record.name.length, 28);
    header.writeUInt32LE(record.externalAttributes, 38);
    header.writeUInt32LE(record.localHeaderOffset, 42);
    central.push(header, record.name);
    centralSize += header.length + record.name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...body, ...central, eocd]);
}

function withExpectedEntry(entryPath, content) {
  return {
    entry: entryPath,
    path: entryPath,
    size: content.length,
    encoding: "text",
    truncated: false,
    returnedBytes: content.length,
    sha256: sha256(content),
    crc32: crc32Hex(content),
  };
}

test("CRC32 evidence: known vector and central-directory verification", async () => {
  const content = utf8("123456789");
  assert.equal(crc32Hex(content), "cbf43926", "known CRC32 vector for '123456789'");

  const flate = Buffer.from(zipSync({ "vector.txt": [new Uint8Array(content), { level: 0 }] }));
  const handcrafted = buildZipArchive([{ path: "vector.txt", data: content, method: 0 }]);
  for (const archive of [flate, handcrafted]) {
    const result = await readZipEntryFromBuffer(archive, "vector.txt", { maxBytes: 4096 });
    assert.equal(result.entry, "vector.txt");
    assert.equal(result.path, "vector.txt");
    assert.equal(result.content, "123456789");
    assert.equal(result.size, content.length);
    assert.equal(result.compressedSize, content.length);
    assert.equal(result.encoding, "text");
    assert.equal(result.truncated, false);
    assert.equal(result.returnedBytes, content.length);
    assert.equal(result.sha256, sha256(content));
    assert.equal(result.crc32, "cbf43926");
  }

  const corrupted = buildZipArchive([{ path: "vector.txt", data: content, method: 0, crc: (crc32(content) ^ 0x1) >>> 0 }]);
  await assert.rejects(() => readZipEntryFromBuffer(corrupted, "vector.txt", { maxBytes: 4096 }), /^Error: ZIP entry CRC mismatch$/);
});

test("reads STORE and DEFLATE text entries, including nested paths", async () => {
  const markdown = "# 标题\r\n\r\nhello 世界 🎉\r\n";
  const nested = "nested/path/to/file.md";
  const store = Buffer.from(zipSync({ [nested]: [new Uint8Array(utf8(markdown)), { level: 0 }] }));
  const deflated = Buffer.from(zipSync({ [nested]: new Uint8Array(utf8(markdown)) }));
  assert.equal(parseZipCentralDirectory(store).entries[0].method, 0, "fixture must be STORE");
  assert.equal(parseZipCentralDirectory(deflated).entries[0].method, 8, "fixture must be DEFLATE");

  for (const archive of [store, deflated]) {
    const result = await readZipEntryFromBuffer(archive, nested, { maxBytes: 65536 });
    assert.deepEqual(Object.keys(result).sort(), ["compressedSize", "content", "crc32", "encoding", "entry", "path", "returnedBytes", "sha256", "size", "truncated"]);
    const { content, compressedSize, ...metadata } = result;
    assert.deepEqual(metadata, withExpectedEntry(nested, utf8(markdown)));
    assert.equal(content, markdown);
    assert.equal(result.returnedBytes, Buffer.byteLength(markdown));
    assert.equal(result.truncated, false);
    assert.equal(compressedSize > 0, true);
  }
});

test("empty text entries stay text with empty content", async () => {
  const flate = Buffer.from(zipSync({ "empty.md": new Uint8Array(0) }));
  const handcrafted = buildZipArchive([{ path: "empty.md", data: Buffer.alloc(0), method: 0 }]);
  for (const archive of [flate, handcrafted]) {
    const result = await readZipEntryFromBuffer(archive, "empty.md", { maxBytes: 16 });
    assert.equal(result.encoding, "text");
    assert.equal(result.content, "");
    assert.equal(result.returnedBytes, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.size, 0);
    assert.equal(result.crc32, "00000000");
    assert.equal(result.sha256, sha256(Buffer.alloc(0)));
  }
});

test("maxBytes is required and bounded, and never silently clamped", async () => {
  const archive = buildZipArchive([{ path: "a.txt", data: "abcdefghij", method: 0 }]);
  for (const maxBytes of [undefined, 0, -1, 1.5, "64", Number.NaN, MAX_INLINE_TRANSFER_BYTES + 1, Infinity]) {
    await assert.rejects(() => readZipEntryFromBuffer(archive, "a.txt", { maxBytes }), new RegExp(`^Error: maxBytes must be an integer between 1 and ${MAX_INLINE_TRANSFER_BYTES}$`));
  }
  await assert.rejects(() => readZipEntryFromBuffer(archive, "a.txt", {}), /maxBytes must be an integer/);
  await assert.rejects(() => readZipEntryFile("bundle.zip", "a.txt", { maxBytes: 0 }), /maxBytes must be an integer/);
});

test("maxBytes boundaries around the content length", async () => {
  const content = "abcdefghij";
  for (const method of [0, 8]) {
    const archive = buildZipArchive([{ path: "a.txt", data: content, method }]);
    const above = await readZipEntryFromBuffer(archive, "a.txt", { maxBytes: content.length + 1 });
    const exact = await readZipEntryFromBuffer(archive, "a.txt", { maxBytes: content.length });
    const below = await readZipEntryFromBuffer(archive, "a.txt", { maxBytes: content.length - 1 });
    assert.equal(above.content, content);
    assert.equal(exact.content, content);
    assert.equal(below.content, content.slice(0, -1));
    assert.deepEqual([above.truncated, exact.truncated, below.truncated], [false, false, true]);
    assert.deepEqual([above.returnedBytes, exact.returnedBytes, below.returnedBytes], [content.length, content.length, content.length - 1]);
  }
});

test("UTF-8 truncation never splits a code point and never emits U+FFFD", async () => {
  const samples = ["aé", "a好", "a🎉", "é好🎉az", "🎉🎉🎉", "aé好🎉\r\nz"];
  for (const method of [0, 8]) {
    const specs = samples.map((text, index) => ({ path: `sample-${index}.txt`, data: text, method }));
    const archive = buildZipArchive(specs);
    for (const [index, text] of samples.entries()) {
      const entry = `sample-${index}.txt`;
      const entryBytes = Buffer.byteLength(text);
      for (let maxBytes = 1; maxBytes <= entryBytes + 2; maxBytes += 1) {
        const result = await readZipEntryFromBuffer(archive, entry, { maxBytes });
        const expected = expectedPrefix(text, maxBytes);
        const context = `method=${method} text=${JSON.stringify(text)} maxBytes=${maxBytes}`;
        assert.equal(result.content, expected, context);
        assert.equal(result.returnedBytes, Buffer.byteLength(expected), context);
        assert.equal(result.returnedBytes <= maxBytes, true, context);
        assert.equal(result.content.includes("\uFFFD"), false, `replacement character in ${context}`);
        assert.equal(result.truncated, entryBytes > result.returnedBytes, context);
        assert.equal(result.size, entryBytes, context);
        assert.equal(result.sha256, sha256(utf8(text)), "sha256 must describe the complete entry");
        assert.equal(result.crc32, crc32Hex(utf8(text)), "crc32 must describe the complete entry");
      }
    }
  }
});

test("binary entries return metadata only, never content or base64", async () => {
  const payloads = {
    "png.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    "nul.txt": Buffer.from("valid utf-8\0with nul", "utf8"),
    "invalid.bin": Buffer.from([0xff, 0xfe, 0xfd, 0x61, 0x62]),
    "truncated.bin": Buffer.from([0x61, 0xe4, 0xb8]),
  };
  for (const method of [0, 8]) {
    const archive = buildZipArchive(Object.entries(payloads).map(([entry, data]) => ({ path: entry, data, method })));
    for (const [entry, payload] of Object.entries(payloads)) {
      const result = await readZipEntryFromBuffer(archive, entry, { maxBytes: 4096 });
      assert.equal(result.encoding, "binary", entry);
      assert.equal("content" in result, false, `${entry} must omit content`);
      assert.equal(result.returnedBytes, 0, entry);
      assert.equal(result.truncated, false, entry);
      assert.equal(result.size, payload.length, entry);
      assert.equal(result.sha256, sha256(payload), entry);
      assert.equal(result.crc32, crc32Hex(payload), entry);
      assert.equal(JSON.stringify(result).includes("base64"), false, entry);
    }
  }
});

test("general purpose bit 3 entries read from central-directory truth", async () => {
  const content = "data descriptor payload 🎉\r\n";
  const archive = buildZipArchive([
    { path: "descriptor-store.txt", data: content, method: 0, bit3: true },
    { path: "descriptor-deflate.txt", data: content, method: 8, bit3: true },
  ]);
  const parsed = parseZipCentralDirectory(archive);
  for (const entryPath of ["descriptor-store.txt", "descriptor-deflate.txt"]) {
    const record = parsed.entries.find((candidate) => candidate.path === entryPath);
    assert.equal((record.flags & 0x0008) !== 0, true, `${entryPath} must carry bit 3 in the central directory`);
    // Precondition: the local header really holds placeholder sizes/CRC.
    const local = archive.subarray(record.localHeaderOffset, record.localHeaderOffset + 30);
    assert.equal(local.readUInt16LE(6) & 0x0008, 0x0008);
    assert.deepEqual([local.readUInt32LE(14), local.readUInt32LE(18), local.readUInt32LE(22)], [0, 0, 0]);
    const result = await readZipEntryFromBuffer(archive, entryPath, { maxBytes: 4096 });
    assert.equal(result.content, content);
    assert.equal(result.size, Buffer.byteLength(content));
    assert.equal(result.crc32, crc32Hex(utf8(content)));
    assert.equal(result.sha256, sha256(utf8(content)));
  }
});

test("locates exactly one entry with normalization and rejects unsafe targets", async () => {
  const content = "target";
  const archive = buildZipArchive([
    { path: "docs/note.md", data: content, method: 8 },
    { path: "folder/", data: Buffer.alloc(0), method: 0 },
  ]);
  const located = locateZipEntry(archive, "docs\\note.md");
  assert.equal(located.path, "docs/note.md");
  assert.equal(located.dataEnd, located.dataStart + located.compressedSize);
  assert.equal(archive.readUInt32LE(located.dataStart - 30 - "docs/note.md".length), 0x04034b50);
  assert.throws(() => locateZipEntry(archive, "note.md"), /^Error: Archive entry not found: "note.md"$/);
  assert.throws(() => locateZipEntry(archive, "docs/NOTE.md"), /^Error: Archive entry not found: "docs\/NOTE\.md"$/);
  assert.throws(() => locateZipEntry(archive, "folder/"), /^Error: Archive entry is a directory: "folder\/"$/);
  assert.throws(() => locateZipEntry(archive, "../escape.md"), /Archive path traversal denied/);
  assert.throws(() => locateZipEntry(archive, "/abs.md"), /Unsafe archive entry/);
  assert.throws(() => locateZipEntry(archive, "C:/drive.md"), /Unsafe archive entry/);
  assert.throws(() => locateZipEntry(archive, ".git/config"), /protected Vault internals/);
  assert.throws(() => locateZipEntry(archive, ".obsidian/app.json"), /protected Vault internals/);
  assert.equal((await readZipEntryFromBuffer(archive, "docs/note.md", { maxBytes: 64 })).content, content);
});

test("unsupported compression methods fail loudly instead of falling back", async () => {
  const content = "bzip2 payload";
  const archive = buildZipArchive([{ path: "archive.bz2", data: content, method: 12, payload: Buffer.from("not really bzip2") }]);
  await assert.rejects(() => readZipEntryFromBuffer(archive, "archive.bz2", { maxBytes: 64 }), /^Error: Unsupported ZIP compression method: 12$/);
});

test("a 100-entry archive decodes only the requested entry", async () => {
  const target = "file-057.md";
  const targetContent = utf8(`target entry only ${"x".repeat(64)}\n`);
  const specs = [];
  for (let index = 0; index < 100; index += 1) {
    const entryPath = `file-${String(index).padStart(3, "0")}.md`;
    if (entryPath === target) {
      specs.push({ path: entryPath, data: targetContent, method: 8 });
      continue;
    }
    // Every non-target entry is undecodable: its central CRC is wrong, and one
    // of them carries a payload that cannot inflate at all. Reading any of them
    // would throw, so a successful targeted read proves decode count == 0.
    specs.push({ path: entryPath, data: utf8(`other entry ${index}`), method: 8, crc: (crc32(utf8(`other entry ${index}`)) ^ 0xdeadbeef) >>> 0 });
  }
  specs.push({ path: "garbage.md", data: utf8("never decoded"), method: 8, payload: Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44]), crc: 0x12345678 });
  const archive = buildZipArchive(specs);
  assert.equal(parseZipCentralDirectory(archive).entryCount, 101, "the archive really contains 101 entries");

  const result = await readZipEntryFromBuffer(archive, target, { maxBytes: 4096 });
  assert.equal(result.content, targetContent.toString("utf8"));
  assert.equal(result.sha256, sha256(targetContent));
  assert.equal(result.crc32, crc32Hex(targetContent));

  // Falsifiability: reading any other entry fails loudly, and so does a
  // whole-archive unzip of the very same buffer (fflate decodes every entry).
  assert.throws(() => unzipSync(new Uint8Array(archive)), /invalid|unexpected|corrupt|invalid block type|unexpected EOF/i);
  await assert.rejects(() => readZipEntryFromBuffer(archive, "file-000.md", { maxBytes: 4096 }), /^Error: ZIP entry CRC mismatch$/);
  await assert.rejects(() => readZipEntryFromBuffer(archive, "garbage.md", { maxBytes: 4096 }), /^Error: ZIP entry inflate failed$/);
});

test("a large entry is streamed, not materialized: retention stays within maxBytes", async () => {
  const large = Buffer.alloc(4 * 1024 * 1024, 0x61);
  const archive = buildZipArchive([{ path: "large.txt", data: large, method: 8 }]);
  const allocationSizes = [];
  const concatTotals = [];
  const originalAlloc = Buffer.alloc;
  const originalAllocUnsafe = Buffer.allocUnsafe;
  const originalConcat = Buffer.concat;
  Buffer.alloc = (size, ...rest) => {
    if (typeof size === "number") allocationSizes.push(size);
    return originalAlloc.call(Buffer, size, ...rest);
  };
  Buffer.allocUnsafe = (size) => {
    if (typeof size === "number") allocationSizes.push(size);
    return originalAllocUnsafe.call(Buffer, size);
  };
  Buffer.concat = (list, totalLength) => {
    concatTotals.push(totalLength ?? list.reduce((sum, item) => sum + item.length, 0));
    return originalConcat.call(Buffer, list, totalLength);
  };
  let result;
  try {
    result = await readZipEntryFromBuffer(archive, "large.txt", { maxBytes: 64 });
  } finally {
    Buffer.alloc = originalAlloc;
    Buffer.allocUnsafe = originalAllocUnsafe;
    Buffer.concat = originalConcat;
  }
  assert.equal(result.size, large.length);
  assert.equal(result.truncated, true);
  assert.equal(result.returnedBytes, 64);
  assert.equal(result.content, "a".repeat(64));
  assert.equal(result.sha256, sha256(large), "sha256 covers the full 4 MiB entry");
  assert.equal(result.crc32, crc32Hex(large), "crc32 covers the full 4 MiB entry");
  assert.deepEqual(concatTotals, [64], "retained prefix materialized exactly maxBytes");
  const largestAllocation = Math.max(...allocationSizes);
  assert.equal(
    largestAllocation < large.length / 4,
    true,
    `no allocation near the entry size (largest=${largestAllocation}, entry=${large.length})`,
  );
});

test("inspectZipBuffer keeps its public manifest shape and the re-export identity", async () => {
  const archive = buildZipArchive([
    { path: "docs/note.md", data: "note", method: 8 },
    { path: "folder/", data: Buffer.alloc(0), method: 0 },
  ]);
  const manifest = inspectZipBuffer(archive);
  assert.deepEqual(manifest, {
    format: "zip",
    entries: [
      { path: "docs/note.md", directory: false, compressedSize: deflateRawSync(utf8("note")).length, uncompressedSize: 4 },
      { path: "folder/", directory: true, compressedSize: 0, uncompressedSize: 0 },
    ],
    entryCount: 2,
    fileCount: 1,
    compressedBytes: archive.length,
    uncompressedBytes: 4,
  });
  for (const entry of manifest.entries) {
    assert.deepEqual(Object.keys(entry), ["path", "directory", "compressedSize", "uncompressedSize"], "public manifest must not leak private parse metadata");
  }
  assert.equal(inspectZipBufferFromTransfer, inspectZipBuffer, "file-transfer.js must re-export the same function");
  assert.deepEqual(inspectZipBufferFromTransfer(archive), manifest);
});

test("the read path never references a whole-archive unzip", async () => {
  const source = await fs.readFile(new URL("../src/archive/zip.js", import.meta.url), "utf8");
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
  assert.equal(/unzipSync|unzip\s*\(/.test(code), false, "no whole-archive unzip in the archive module");
  assert.equal(/from "fflate"/.test(code), false, "the read path does not import fflate");
  assert.equal(/createZipArchive|extractZipArchive/.test(code), false, "the read path does not call archive creation/extraction");
  assert.equal(code.includes("archive.subarray(located.dataStart, located.dataEnd)"), true, "only the located compressed range is consumed");
});

test("protected-root guard list matches the transfer path guard list", async () => {
  const transfer = await fs.readFile(new URL("../src/file-transfer.js", import.meta.url), "utf8");
  const archive = await fs.readFile(new URL("../src/archive/zip.js", import.meta.url), "utf8");
  const declaration = (source, name) => source.match(new RegExp(`const ${name} = new Set\\(\\[(.*?)\\]\\)`))?.[1];
  assert.equal(declaration(archive, "PROTECTED_VAULT_ROOTS"), declaration(transfer, "PROTECTED_ROOTS"));
  assert.equal(declaration(archive, "PROTECTED_VAULT_ROOTS"), '".git", ".obsidian"');
});

test("readZipEntryFile reuses the Vault transfer guards and adds archive metadata", async () => {
  const content = utf8("vault entry 🎉\r\n");
  const archive = buildZipArchive([{ path: "notes/target.md", data: content, method: 8 }]);
  await fs.mkdir(path.join(vault, "Projects"), { recursive: true });
  await fs.writeFile(path.join(vault, "Projects", "bundle.zip"), archive);
  await fs.writeFile(path.join(vault, "Projects", "UPPER.ZIP"), archive);
  await fs.writeFile(path.join(vault, "Projects", "note.md"), "not an archive");

  const result = await readZipEntryFile("Projects/bundle.zip", "notes/target.md", { maxBytes: 4096 });
  assert.equal(result.archivePath, "Projects/bundle.zip");
  assert.equal(result.entry, "notes/target.md");
  assert.equal(result.path, "notes/target.md");
  assert.equal(result.content, content.toString("utf8"));
  assert.equal(result.archiveSha256, sha256(archive));
  assert.equal(result.archiveRevision, `sha256:${sha256(archive)}`);
  assert.equal(result.size, content.length);
  assert.equal(result.crc32, crc32Hex(content));

  const inspected = await inspectZipFile("Projects/bundle.zip");
  assert.equal(inspected.path, "Projects/bundle.zip");
  assert.deepEqual(inspected.entries, inspectZipBuffer(archive).entries);

  await assert.rejects(() => readZipEntryFile("Projects/note.md", "notes/target.md", { maxBytes: 16 }), /^Error: Only \.zip archives are supported$/);
  const upper = await readZipEntryFile("Projects/UPPER.ZIP", "notes/target.md", { maxBytes: 16 });
  assert.equal(upper.archivePath, "Projects/UPPER.ZIP", ".zip extension matching is case-insensitive");
  await assert.rejects(() => readZipEntryFile("Projects/missing.zip", "notes/target.md", { maxBytes: 16 }), /ENOENT|no such file/i);
  await assert.rejects(() => readZipEntryFile(".git/config.zip", "notes/target.md", { maxBytes: 16 }), /protected Vault internals/);
  await assert.rejects(() => readZipEntryFile("../outside.zip", "notes/target.md", { maxBytes: 16 }), /Path traversal denied/);
  await assert.rejects(() => readZipEntryFile("Projects/bundle.zip", "notes/missing.md", { maxBytes: 16 }), /^Error: Archive entry not found: "notes\/missing\.md"$/);
});
