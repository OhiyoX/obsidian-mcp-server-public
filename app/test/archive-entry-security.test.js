// Issue #254 / lane A2 — negative characterization for the ZIP parse and selective-read paths.
//
// Two layers are covered:
//   1. the parse layer (`inspectZipBuffer` in src/file-transfer.js), which is GREEN at this
//      base: every structural lesion must be rejected with its existing message;
//   2. the selective reader layer (`src/archive/zip.js`, lane A1), which does not exist at
//      this base. Those assertions are gated behind an explicit PENDING diagnostic and a
//      proof that the gate is only entered while the module file is really absent — never a
//      silent pass. When A1 merges, this file must go skip -> pass without edits.
//
// Every fixture is built by test/helpers/zip-fixture-builder.js from fixed bytes (no corpus,
// no large binary, no randomness, no wall clock). Each rejection case carries a positive
// control built from the exact same entries with only the lesion removed; the byte-level
// proof section additionally shows the central-directory-only parser is blind to the
// reader-level lesions, so these fixtures add real coverage instead of restating layer 1.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inflateSync, zipSync } from "fflate";

// The archive-size boundary is exercised without ever allocating ~100 MB (A2 BRIEF §3.1).
// The limit is injected before the production modules are imported, exactly like the
// VAULT_PATH/DATA_PATH injection in test/file-transfer.test.js; the same comparison branch
// is exercised, only the constant is small.
process.env.MAX_ARCHIVE_BYTES = "4096";
process.env.GIT_ENABLED = "false";

const {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_INLINE_TRANSFER_BYTES,
} = await import("../src/config.js");
const { inspectZipBuffer } = await import("../src/file-transfer.js");
const {
  centralDirectoryRange,
  crc32Of,
  entryOffsets,
  patchBytes,
  zipFixture,
} = await import("./helpers/zip-fixture-builder.js");

const READER_URL = new URL("../src/archive/zip.js", import.meta.url);
const READER_PATH = fileURLToPath(READER_URL);
const PENDING = "PENDING: src/archive/zip.js does not exist at this base (lane A1) — reader assertions activate after A1 merges";

let reader = null;
try {
  reader = await import(READER_URL.href);
} catch (error) {
  // Only a genuinely absent module may be treated as PENDING; a broken A1 module must fail.
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw new Error(`A2: src/archive/zip.js exists but failed to import: ${error.message}`);
}

const TEXT = "note body\n";
const LONG_TEXT = "deflate payload ".repeat(200);
const DOS_TIMESTAMP = [0x00, 0x00, 0x21, 0x00]; // 1980-01-01 00:00:00, the builder's fixed constant
const LOCAL = { flags: 6, method: 8, crc32: 14, compressedSize: 18, uncompressedSize: 22, name: 30 };
const CENTRAL = { flags: 8, method: 10, crc32: 16, compressedSize: 20, uncompressedSize: 24, name: 46 };
const SIGNATURES = { local: 0x04034b50, central: 0x02014b50 };

const file = (name, data = TEXT, extra = {}) => ({ name, data, ...extra });
const sha256Of = (value) => createHash("sha256").update(value).digest("hex");
const bytes32 = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const bytes16 = (value) => [value & 0xff, (value >>> 8) & 0xff];
const localEdit = (buffer, name, field, bytes) => ({ offset: entryOffsets(buffer, name).localHeaderOffset + LOCAL[field], bytes });
const centralEdit = (buffer, name, field, bytes) => ({ offset: entryOffsets(buffer, name).centralHeaderOffset + CENTRAL[field], bytes });
const payloadRange = (buffer, name) => {
  const { localHeaderOffset, centralHeaderOffset } = entryOffsets(buffer, name);
  return {
    start: localHeaderOffset + 30 + buffer.readUInt16LE(localHeaderOffset + 26) + buffer.readUInt16LE(localHeaderOffset + 28),
    size: buffer.readUInt32LE(centralHeaderOffset + CENTRAL.compressedSize),
  };
};
const pathExists = async (target) => fs.stat(target).then(() => true, () => false);

async function readerGate(t) {
  if (reader) return reader;
  assert.equal(await pathExists(READER_PATH), false, "PENDING requires src/archive/zip.js to be genuinely absent");
  t.diagnostic(PENDING);
  return null;
}

function verifyRead(result, expectedText) {
  assert.equal(result.encoding, "text");
  assert.equal(result.content, expectedText);
  assert.equal(result.size, Buffer.byteLength(expectedText));
  assert.equal(result.returnedBytes, Buffer.byteLength(expectedText));
  assert.equal(result.truncated, false);
  assert.equal(result.sha256, sha256Of(Buffer.from(expectedText)));
  assert.equal(result.crc32, crc32Of(Buffer.from(expectedText)).toString(16).padStart(8, "0"));
  assert.equal(result.entry, result.path);
}

// ---------------------------------------------------------------------------
// Fixture integrity: determinism, provenance, locators, CRC vector.
// ---------------------------------------------------------------------------

test("the archive-size boundary constant is the injected small value, not a silent default", () => {
  assert.equal(MAX_ARCHIVE_BYTES, 4096);
});

test("fixtures are byte-deterministic and the builder uses no randomness or wall clock", async () => {
  const entries = [file("note.md"), file("nested/deep.md", LONG_TEXT, { method: 8 }), { name: "docs", data: "", isDirectory: true }];
  const first = zipFixture(entries);
  const second = zipFixture(entries);
  assert.ok(first.equals(second) && sha256Of(first) === sha256Of(second), "same input must produce identical bytes");
  const bit3 = [{ name: "n.md", data: TEXT, flags: 0x08, localOverrides: { crc32: 0, compressedSize: 0, uncompressedSize: 0 } }];
  assert.ok(zipFixture(bit3).equals(zipFixture(bit3)), "lesion fixtures must be deterministic too");
  const source = await fs.readFile(new URL("./helpers/zip-fixture-builder.js", import.meta.url), "utf8");
  for (const pattern of ["Math" + ".random", "Date" + ".now", "new " + "Date"]) assert.ok(!source.includes(pattern), `builder source must not use ${pattern}`);
});

test("the legal baseline is byte-identical to fflate zipSync output once DOS timestamps are pinned", () => {
  const entries = [file("note.md"), file("nested/deep.md", LONG_TEXT), { name: "docs/", data: "" }];
  const reference = Buffer.from(zipSync(Object.fromEntries(entries.map((entry) => [entry.name, new Uint8Array(Buffer.from(entry.data))])), { level: 6 }));
  const edits = entries.flatMap((entry) => {
    const { localHeaderOffset, centralHeaderOffset } = entryOffsets(reference, entry.name);
    return [{ offset: localHeaderOffset + 10, bytes: DOS_TIMESTAMP }, { offset: centralHeaderOffset + 12, bytes: DOS_TIMESTAMP }];
  });
  assert.deepEqual(zipFixture(entries.map((entry) => ({ ...entry, method: 8 }))), patchBytes(reference, edits));
});

test("crc32Of matches the published vector and fflate's own CRC declaration", () => {
  assert.equal(crc32Of("123456789"), 0xcbf43926);
  const reference = Buffer.from(zipSync({ "note.md": new Uint8Array(Buffer.from(TEXT)) }));
  assert.equal(crc32Of(Buffer.from(TEXT)), reference.readUInt32LE(14));
});

test("centralDirectoryRange/entryOffsets address the container and patchBytes never mutates its input", () => {
  const buffer = zipFixture([file("note.md"), file("second.md", "second body\n")]);
  const range = centralDirectoryRange(buffer);
  assert.equal(range.count, 2);
  assert.equal(range.offset + range.size, buffer.length - 22);
  const offsets = entryOffsets(buffer, "second.md");
  assert.equal(buffer.readUInt32LE(offsets.localHeaderOffset), SIGNATURES.local);
  assert.equal(buffer.readUInt32LE(offsets.centralHeaderOffset), SIGNATURES.central);
  assert.equal(buffer.subarray(offsets.localHeaderOffset + 30, offsets.localHeaderOffset + 39).toString(), "second.md");
  assert.equal(buffer.readUInt32LE(offsets.centralHeaderOffset + 42), offsets.localHeaderOffset);
  assert.equal(entryOffsets(buffer, "absent.md"), null);
  const before = Buffer.from(buffer);
  const patched = patchBytes(buffer, [{ offset: offsets.centralHeaderOffset + 16, bytes: [1, 2, 3, 4] }, { offset: offsets.localHeaderOffset + 14, bytes: [5, 6] }]);
  assert.deepEqual(buffer, before, "patchBytes must not mutate the source buffer");
  assert.deepEqual(patched.subarray(offsets.centralHeaderOffset + 16, offsets.centralHeaderOffset + 20), Buffer.from([1, 2, 3, 4]));
  assert.throws(() => patchBytes(buffer, [{ offset: buffer.length - 1, bytes: [1, 2] }]), /out of bounds/);
});

// ---------------------------------------------------------------------------
// Parse layer (GREEN at this base): every case pairs a positive control with a lesion.
// ---------------------------------------------------------------------------

const PARSE_CASES = [
  { id: "invalid EOCD signature", edit: (base) => [{ offset: centralDirectoryRange(base).offset + centralDirectoryRange(base).size, bytes: [0, 0, 0, 0] }], rejects: /end-of-central-directory/ },
  { id: "removed EOCD (buffer tail truncated)", patient: (base) => base.subarray(0, base.length - 22), rejects: /end-of-central-directory/ },
  { id: "central directory bounds beyond EOCD", options: { eocdOverrides: { centralSize: 0x7fffffff } }, rejects: /central directory bounds/ },
  { id: "entry count above MAX_ARCHIVE_ENTRIES", options: { eocdOverrides: { count: MAX_ARCHIVE_ENTRIES + 1 } }, rejects: /limit is/ },
  { id: "declared uncompressed total above the limit", entries: [file("note.md", TEXT, { centralOverrides: { uncompressedSize: MAX_ARCHIVE_UNCOMPRESSED_BYTES + 1 } })], control: [file("note.md")], rejects: /MAX_ARCHIVE_UNCOMPRESSED_BYTES/ },
  { id: "archive larger than MAX_ARCHIVE_BYTES", patient: () => zipFixture([file("big.bin", Buffer.alloc(MAX_ARCHIVE_BYTES + 1024))]), rejects: /MAX_ARCHIVE_BYTES/ },
  { id: "ZIP64 marker", options: { zip64: true }, rejects: /ZIP64/ },
  { id: "encrypted entry flag", entries: [file("note.md", TEXT, { flags: 0x1 })], control: [file("note.md")], rejects: /Encrypted ZIP entries/ },
  { id: "path traversal", entries: [file("../escape.md")], control: [file("note.md")], rejects: /traversal denied/ },
  { id: "absolute path", entries: [file("/etc/passwd")], control: [file("note.md")], rejects: /Unsafe archive entry/ },
  { id: "drive-letter path", entries: [file("C:/Windows/win.ini")], control: [file("note.md")], rejects: /Unsafe archive entry/ },
  { id: "backslash-normalized duplicate", entries: [file("a/b.md"), file("a\\b.md")], control: [file("a/b.md")], rejects: /Duplicate archive entry/ },
  { id: "protected .git root", entries: [file(".git/config")], control: [file("note.md")], rejects: /protected Vault internals/ },
  { id: "protected .obsidian root", entries: [file(".obsidian/app.json")], control: [file("note.md")], rejects: /protected Vault internals/ },
  { id: "symlink external attributes", entries: [file("link.md", TEXT, { externalAttributes: 0xa1ff0000 })], control: [file("link.md")], rejects: /Symbolic links are not allowed/ },
];

for (const parseCase of PARSE_CASES) {
  test(`parse layer: ${parseCase.id}`, () => {
    const entries = parseCase.entries ?? [file("note.md")];
    const control = zipFixture(parseCase.control ?? entries);
    assert.doesNotThrow(() => inspectZipBuffer(control), "the positive control must be accepted");
    const patient = parseCase.patient ? parseCase.patient(control) : parseCase.edit ? patchBytes(control, parseCase.edit(control)) : zipFixture(entries, parseCase.options);
    assert.throws(() => inspectZipBuffer(patient), parseCase.rejects);
  });
}

// ---------------------------------------------------------------------------
// Selective reader layer (lane A1). Every case reuses one construction: the positive
// control is the patient with only the lesion removed.
// ---------------------------------------------------------------------------

const PLACEHOLDER_LOCAL = { crc32: 0, compressedSize: 0, uncompressedSize: 0 };

const READER_CASES = [
  { id: "CRC mismatch against central declaration", entries: [file("note.md", TEXT, { flags: 0x08 })], edit: (base) => [centralEdit(base, "note.md", "crc32", bytes32(0xdeadbeef))], rejects: /CRC mismatch/, readerOnly: true },
  { id: "inflated size mismatch", entries: [file("note.md", TEXT, { flags: 0x08 })], edit: (base) => [centralEdit(base, "note.md", "uncompressedSize", bytes32(TEXT.length + 7))], rejects: /size mismatch/, readerOnly: true },
  { id: "local filename differs from central", entries: [file("alpha.md")], entry: "alpha.md", edit: (base) => [localEdit(base, "alpha.md", "name", Buffer.from("bravo.md"))], rejects: /local header filename mismatch/, readerOnly: true },
  { id: "local method differs from central", entries: [file("note.md")], edit: (base) => [localEdit(base, "note.md", "method", bytes16(8))], rejects: /local header method mismatch/, readerOnly: true },
  { id: "local size differs from central without bit 3", entries: [file("note.md")], edit: (base) => [localEdit(base, "note.md", "uncompressedSize", bytes32(TEXT.length + 1))], rejects: /local header size mismatch/, readerOnly: true },
  { id: "local CRC differs from central without bit 3", entries: [file("note.md")], edit: (base) => [localEdit(base, "note.md", "crc32", bytes32(0xdeadbeef))], rejects: /local header CRC mismatch/, readerOnly: true },
  { id: "unsupported compression method (12)", entries: [file("note.md")], edit: (base) => [localEdit(base, "note.md", "method", bytes16(12)), centralEdit(base, "note.md", "method", bytes16(12))], rejects: /Unsupported ZIP compression method/, readerOnly: true },
  {
    id: "compressed range reaching into the central directory",
    entries: [file("note.md", TEXT, { method: 8 })],
    edit: (base) => {
      const grown = bytes32(payloadRange(base, "note.md").size + 64);
      return [localEdit(base, "note.md", "compressedSize", grown), centralEdit(base, "note.md", "compressedSize", grown)];
    },
    rejects: /out of bounds/,
    readerOnly: true,
    lesion: (base, patient) => {
      const range = payloadRange(patient, "note.md");
      assert.ok(range.start + range.size > centralDirectoryRange(patient).offset, "the declared data range must reach past the central directory");
    },
  },
  {
    id: "truncated compressed stream",
    entries: [file("note.md", LONG_TEXT, { method: 8 })],
    edit: (base) => {
      const shrunk = bytes32(payloadRange(base, "note.md").size - 5);
      return [localEdit(base, "note.md", "compressedSize", shrunk), centralEdit(base, "note.md", "compressedSize", shrunk)];
    },
    rejects: /inflate failed|out of bounds/,
    readerOnly: true,
    lesion: (base, patient) => {
      const range = payloadRange(patient, "note.md");
      assert.throws(() => inflateSync(patient.subarray(range.start, range.start + range.size)), "the stored deflate stream must really be incomplete");
    },
  },
  { id: "bit 3 STORE placeholders read via central", entries: [file("note.md", TEXT, { flags: 0x08, localOverrides: PLACEHOLDER_LOCAL })], resolves: true },
  { id: "bit 3 DEFLATE placeholders read via central", entries: [file("note.md", LONG_TEXT, { method: 8, flags: 0x08, localOverrides: PLACEHOLDER_LOCAL })], resolves: true, expectText: LONG_TEXT },
  { id: "entry not found", entries: [file("note.md")], entry: "missing.md", controlEntry: "note.md", rejects: /not found/ },
  { id: "directory entry", entries: [file("docs", "", { isDirectory: true }), file("note.md")], entry: "docs/", controlEntry: "note.md", rejects: /is a directory/ },
  { id: "backslash entry name hit through normalization", entries: [{ name: "a\\b.md", data: TEXT }], entry: "a/b.md", resolves: true, expectEntry: "a/b.md" },
  { id: "backslash query name hit through normalization", entries: [file("a/b.md")], entry: "a\\b.md", resolves: true, expectEntry: "a/b.md" },
  { id: "whole buffer tail truncated (extra, beyond the brief table)", entries: [file("note.md")], patient: (base) => base.subarray(0, base.length - 22), rejects: /end-of-central-directory|not found|out of bounds/ },
];

test("reader fixtures are structurally sane and stay invisible to the central-directory-only parser", () => {
  for (const readerCase of READER_CASES) {
    const base = zipFixture(readerCase.entries);
    assert.doesNotThrow(() => inspectZipBuffer(base), `${readerCase.id}: control must be a valid archive`);
    const patient = readerCase.patient ? readerCase.patient(base) : readerCase.edit ? patchBytes(base, readerCase.edit(base)) : base;
    if (readerCase.readerOnly) {
      assert.ok(!patient.equals(base), `${readerCase.id}: lesion must change bytes`);
      assert.doesNotThrow(() => inspectZipBuffer(patient), `${readerCase.id}: parse layer must be blind to a reader-only lesion`);
    }
    readerCase.lesion?.(base, patient);
  }
});

for (const readerCase of READER_CASES) {
  test(`selective reader: ${readerCase.id}`, async (t) => {
    const base = zipFixture(readerCase.entries);
    const patient = readerCase.patient ? readerCase.patient(base) : readerCase.edit ? patchBytes(base, readerCase.edit(base)) : base;
    const zip = await readerGate(t);
    if (!zip) return;
    const maxBytes = 65536;
    if (readerCase.rejects) {
      const control = await zip.readZipEntryFromBuffer(base, readerCase.controlEntry ?? readerCase.entry ?? "note.md", { maxBytes });
      assert.ok(control.size > 0, "positive control must read through the same construction");
      await assert.rejects(zip.readZipEntryFromBuffer(patient, readerCase.entry ?? "note.md", { maxBytes }), readerCase.rejects);
      return;
    }
    const result = await zip.readZipEntryFromBuffer(patient, readerCase.entry ?? "note.md", { maxBytes: readerCase.maxBytes ?? maxBytes });
    verifyRead(result, readerCase.expectText ?? TEXT);
    if (readerCase.expectEntry) assert.equal(result.entry, readerCase.expectEntry);
  });
}

test("selective reader: maxBytes validation (no silent clamp)", async (t) => {
  const buffer = zipFixture([file("note.md")]);
  const zip = await readerGate(t);
  if (!zip) return;
  for (const value of [0, -1, 1.5, "64", MAX_INLINE_TRANSFER_BYTES + 1]) {
    await assert.rejects(zip.readZipEntryFromBuffer(buffer, "note.md", { maxBytes: value }), /maxBytes must be an integer between 1 and/);
  }
  const edge = await zip.readZipEntryFromBuffer(buffer, "note.md", { maxBytes: MAX_INLINE_TRANSFER_BYTES });
  verifyRead(edge, TEXT);
  const clipped = await zip.readZipEntryFromBuffer(buffer, "note.md", { maxBytes: 1 });
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.returnedBytes, 1);
  assert.equal(clipped.content, TEXT.slice(0, 1));
  assert.equal(clipped.size, TEXT.length);
  assert.equal(clipped.sha256, sha256Of(Buffer.from(TEXT)));
});

test("reader gate is honest: PENDING only while src/archive/zip.js is absent", async (t) => {
  if (await pathExists(READER_PATH)) {
    assert.ok(reader, "src/archive/zip.js exists but did not import");
    for (const name of ["inspectZipBuffer", "parseZipCentralDirectory", "locateZipEntry", "readZipEntryFromBuffer"]) {
      assert.equal(typeof reader[name], "function", `A1 module must export ${name}`);
    }
    t.diagnostic("src/archive/zip.js present: all reader assertions above are active");
    return;
  }
  assert.equal(reader, null);
  t.diagnostic(PENDING);
});
