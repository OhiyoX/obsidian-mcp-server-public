// Issue #254 / lane B+C — `read_archive_entry` tool-layer end-to-end coverage.
//
// This file drives the *public* tool: the real in-process MCP `tools/list` descriptor
// and real `tools/call` invocations against a temporary Vault, so it covers what the
// reader-level and security-level suites cannot: registration/registry parity, the wire
// input/output schema, annotations, scope, and the zero-write invariant of the tool.
//
// Fixtures are generated deterministically by test/helpers/zip-fixture-builder.js
// (fixed bytes, fixed entry order, no randomness, no wall clock).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Environment must be configured before importing config/vault/retrieval modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-archive-entry-tool-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(data, { recursive: true });

const { MAX_INLINE_TRANSFER_BYTES, TOOL_NAMES } = await import("../src/config.js");
const { registerObsidianCapabilities } = await import("../src/capabilities.js");
const { MCP_TOOL_SCOPE_REQUIREMENTS, requiredScopesForTools } = await import("../src/scopes.js");
const { registerFileTools } = await import("../src/tools/files.js");
const { readZipEntryFromBuffer } = await import("../src/archive/zip.js");
const { crc32Of, zipFixture } = await import("./helpers/zip-fixture-builder.js");

const TOOL = "read_archive_entry";
const ARCHIVE_PATH = "Archive/Bundle.zip";
const REQUIRED_KEYS = [
  "archivePath", "entry", "path", "size", "compressedSize", "encoding",
  "truncated", "returnedBytes", "sha256", "crc32", "archiveSha256", "archiveRevision",
];
const FAILED_READER_MESSAGE = `maxBytes must be an integer between 1 and ${MAX_INLINE_TRANSFER_BYTES}`;

const STORE_TEXT = "alpha store body\n";
const DEFLATE_TEXT = "deflate payload ".repeat(64);
const MULTIBYTE_TEXT = "中文内容🙂末尾";
const NESTED_TEXT = "nested entry\n";
const BINARY_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);

const archive = zipFixture([
  { name: "Note.md", data: Buffer.from(STORE_TEXT, "utf8"), method: 0 },
  { name: "Long.txt", data: Buffer.from(DEFLATE_TEXT, "utf8"), method: 8 },
  { name: "CJK.txt", data: Buffer.from(MULTIBYTE_TEXT, "utf8"), method: 0 },
  { name: "Binary.bin", data: BINARY_BYTES, method: 0 },
  { name: "Folder", isDirectory: true },
  { name: "Nested/Deep/Note.md", data: Buffer.from(NESTED_TEXT, "utf8"), method: 8 },
]);

await fs.mkdir(path.join(vault, "Archive"), { recursive: true });
await fs.writeFile(path.join(vault, ARCHIVE_PATH), archive);
await fs.writeFile(path.join(vault, "Archive", "NotZip.txt"), "plain text, not an archive\n");
await fs.mkdir(path.join(vault, ".git"), { recursive: true });
await fs.writeFile(path.join(vault, ".git", "Internal.zip"), archive);

const server = new McpServer({ name: "archive-entry-tool-test", version: "1" });
registerObsidianCapabilities(server);
const client = new Client({ name: "archive-entry-tool-client", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

after(async () => {
  await client.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function listTool(name) {
  const tools = (await client.listTools()).tools;
  const matches = tools.filter((tool) => tool.name === name);
  assert.equal(matches.length, 1, `${name} must appear exactly once in tools/list`);
  return matches[0];
}

async function callTool(args) {
  const result = await client.callTool({ name: TOOL, arguments: args });
  const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
  return { ...result, text };
}

async function read(args) {
  const result = await callTool(args);
  assert.equal(result.isError, undefined, `expected a successful call, got: ${result.text}`);
  return result.structuredContent;
}

async function readError(args) {
  const result = await callTool(args);
  assert.equal(result.isError, true, `expected an error result for ${JSON.stringify(args)}`);
  return result.text;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// `crc32Of` returns the unsigned integer; the tool publishes 8 lowercase hex digits.
const crcHex = (value) => crc32Of(value).toString(16).padStart(8, "0");

// ---------------------------------------------------------------------------
// 1. Registry / wire descriptor
// ---------------------------------------------------------------------------

test("read_archive_entry is registered in place and exposed with the frozen wire contract", async () => {
  const index = TOOL_NAMES.indexOf(TOOL);
  assert.ok(index > 0, `${TOOL} must be registered in TOOL_NAMES`);
  assert.equal(TOOL_NAMES.filter((name) => name === TOOL).length, 1, `${TOOL} must appear once in TOOL_NAMES`);
  assert.equal(TOOL_NAMES[index - 1], "inspect_archive", `${TOOL} must follow inspect_archive`);
  assert.equal(TOOL_NAMES[index + 1], "extract_archive", `${TOOL} must precede extract_archive`);

  const registrationOrder = [];
  registerFileTools({ registerTool(name) { registrationOrder.push(name); } });
  const registeredAt = registrationOrder.indexOf(TOOL);
  assert.ok(registeredAt > 0, `tools/files.js must register ${TOOL}`);
  assert.deepEqual(
    registrationOrder.slice(registeredAt - 1, registeredAt + 2),
    ["inspect_archive", TOOL, "extract_archive"],
  );

  const tool = await listTool(TOOL);
  assert.equal(tool.title, "Read Vault ZIP Entry");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });

  assert.deepEqual(tool.inputSchema.required, ["archivePath", "entry"]);
  assert.equal(tool.inputSchema.properties.archivePath.type, "string");
  assert.equal(tool.inputSchema.properties.entry.type, "string");
  assert.deepEqual(tool.inputSchema.properties.maxBytes, {
    default: 65536,
    type: "integer",
    minimum: 1,
    maximum: MAX_INLINE_TRANSFER_BYTES,
  });

  assert.deepEqual(tool.outputSchema.required.slice().sort(), REQUIRED_KEYS.slice().sort());
  assert.deepEqual(
    Object.keys(tool.outputSchema.properties).sort(),
    [...REQUIRED_KEYS, "content"].sort(),
    "only `content` may be optional",
  );
  assert.equal(tool.outputSchema.required.includes("content"), false);
  assert.equal(tool.outputSchema.properties.size.type, "number");
  assert.equal(tool.outputSchema.properties.compressedSize.type, "number");
  assert.equal(tool.outputSchema.properties.returnedBytes.type, "number");
  assert.equal(tool.outputSchema.properties.truncated.type, "boolean");
  assert.deepEqual(tool.outputSchema.properties.encoding.enum, ["text", "binary"]);
});

test("read_archive_entry requires read + files scopes and never obsidian.write", () => {
  assert.deepEqual(MCP_TOOL_SCOPE_REQUIREMENTS[TOOL], ["obsidian.read", "obsidian.files"]);
  assert.deepEqual(requiredScopesForTools([TOOL]), ["obsidian.read", "obsidian.files"]);
  assert.equal(requiredScopesForTools([TOOL]).includes("obsidian.write"), false);
});

// ---------------------------------------------------------------------------
// 2. Handler behaviour (real tools/call over the real archive in a temp Vault)
// ---------------------------------------------------------------------------

test("STORE and DEFLATE text entries return exact content, integrity and metadata", async () => {
  const stored = await read({ archivePath: ARCHIVE_PATH, entry: "Note.md" });
  assert.deepEqual(Object.keys(stored).sort(), [...REQUIRED_KEYS, "content"].sort());
  assert.equal(stored.archivePath, ARCHIVE_PATH);
  assert.equal(stored.entry, "Note.md");
  assert.equal(stored.path, "Note.md");
  assert.equal(stored.encoding, "text");
  assert.equal(stored.content, STORE_TEXT);
  assert.equal(stored.size, Buffer.byteLength(STORE_TEXT, "utf8"));
  assert.equal(stored.compressedSize, stored.size, "a STORE entry keeps its byte length");
  assert.equal(stored.truncated, false);
  assert.equal(stored.returnedBytes, stored.size);
  assert.equal(stored.sha256, sha256(Buffer.from(STORE_TEXT, "utf8")));
  assert.equal(stored.crc32, crcHex(Buffer.from(STORE_TEXT, "utf8")));
  assert.equal(stored.archiveSha256, sha256(archive));
  assert.equal(stored.archiveRevision, `sha256:${sha256(archive)}`);

  const deflated = await read({ archivePath: ARCHIVE_PATH, entry: "Long.txt" });
  assert.equal(deflated.encoding, "text");
  assert.equal(deflated.content, DEFLATE_TEXT);
  assert.equal(deflated.size, Buffer.byteLength(DEFLATE_TEXT, "utf8"));
  assert.ok(deflated.compressedSize > 0 && deflated.compressedSize < deflated.size, "DEFLATE must compress this body");
  assert.equal(deflated.sha256, sha256(Buffer.from(DEFLATE_TEXT, "utf8")), "sha256 covers the full entry");
  assert.equal(deflated.crc32, crcHex(Buffer.from(DEFLATE_TEXT, "utf8")));
  assert.equal(deflated.truncated, false);
  assert.equal(deflated.returnedBytes, deflated.size);

  const nested = await read({ archivePath: ARCHIVE_PATH, entry: "Nested/Deep/Note.md" });
  assert.equal(nested.entry, "Nested/Deep/Note.md");
  assert.equal(nested.content, NESTED_TEXT);
  assert.equal(nested.encoding, "text");
});

test("truncation keeps whole code points and never emits U+FFFD at any maxBytes boundary", async () => {
  const truncated = await read({ archivePath: ARCHIVE_PATH, entry: "Long.txt", maxBytes: 7 });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.returnedBytes, 7);
  assert.equal(truncated.content, DEFLATE_TEXT.slice(0, 7));
  assert.equal(truncated.sha256, sha256(Buffer.from(DEFLATE_TEXT, "utf8")), "sha256 still covers the full entry");
  assert.equal(truncated.size, Buffer.byteLength(DEFLATE_TEXT, "utf8"));

  const multibyteBytes = Buffer.from(MULTIBYTE_TEXT, "utf8");
  for (let maxBytes = 1; maxBytes <= multibyteBytes.length + 1; maxBytes += 1) {
    const entry = await read({ archivePath: ARCHIVE_PATH, entry: "CJK.txt", maxBytes });
    const label = `maxBytes=${maxBytes}`;
    assert.equal(entry.encoding, "text", label);
    assert.equal(entry.content.includes("\uFFFD"), false, `${label}: content must not contain U+FFFD`);
    assert.ok(entry.returnedBytes <= maxBytes, `${label}: returnedBytes ${entry.returnedBytes} > maxBytes`);
    assert.equal(entry.content, MULTIBYTE_TEXT.slice(0, entry.content.length), `${label}: content must be a code-point prefix`);
    assert.equal(
      entry.truncated,
      entry.size > entry.returnedBytes,
      `${label}: truncated must be exactly size > returnedBytes`,
    );
    assert.equal(entry.sha256, sha256(multibyteBytes), `${label}: sha256 covers the full entry`);
  }
});

test("binary entries return metadata only: no content, returnedBytes=0, truncated=false", async () => {
  const entry = await read({ archivePath: ARCHIVE_PATH, entry: "Binary.bin" });
  assert.equal("content" in entry, false, "binary entries must omit content entirely (no base64, no placeholder)");
  assert.equal(entry.encoding, "binary");
  assert.equal(entry.returnedBytes, 0);
  assert.equal(entry.truncated, false, "binary omission is not a maxBytes truncation");
  assert.equal(entry.size, BINARY_BYTES.length);
  assert.equal(entry.sha256, sha256(BINARY_BYTES));
  assert.equal(entry.crc32, crcHex(BINARY_BYTES));

  const bounded = await read({ archivePath: ARCHIVE_PATH, entry: "Binary.bin", maxBytes: 1 });
  assert.equal("content" in bounded, false);
  assert.equal(bounded.returnedBytes, 0);
  assert.equal(bounded.truncated, false);
});

test("entry selection and archive guards surface explicit errors", async () => {
  assert.match(await readError({ archivePath: ARCHIVE_PATH, entry: "Missing.md" }), /Archive entry not found: "Missing\.md"/u);
  assert.match(await readError({ archivePath: ARCHIVE_PATH, entry: "Nested/deep/note.md" }), /Archive entry not found/u);
  assert.match(await readError({ archivePath: ARCHIVE_PATH, entry: "Folder/" }), /Archive entry is a directory: "Folder\/"/u);
  assert.match(await readError({ archivePath: ARCHIVE_PATH, entry: "../escape.txt" }), /Archive path traversal denied/u);
  assert.match(await readError({ archivePath: "Archive/NotZip.txt", entry: "Note.md" }), /Only \.zip archives are supported/u);
  assert.match(await readError({ archivePath: "../outside.zip", entry: "Note.md" }), /Path traversal denied/u);
  assert.match(await readError({ archivePath: ".git/Internal.zip", entry: "Note.md" }), /protected Vault internals/u);
  assert.match(await readError({ archivePath: "Archive/Absent.zip", entry: "Note.md" }), /ENOENT/u);
});

test("maxBytes is bounded by the schema and by the reader (no silent clamping)", async () => {
  for (const maxBytes of [0, -1, 1.5, MAX_INLINE_TRANSFER_BYTES + 1]) {
    const message = await readError({ archivePath: ARCHIVE_PATH, entry: "Note.md", maxBytes });
    assert.match(message, /-32602/u, `maxBytes=${maxBytes} must fail input validation`);
    assert.match(message, /maxBytes/u, `maxBytes=${maxBytes} must name the offending field`);
  }
  for (const maxBytes of [0, -1, 1.5, MAX_INLINE_TRANSFER_BYTES + 1]) {
    await assert.rejects(
      () => readZipEntryFromBuffer(archive, "Note.md", { maxBytes }),
      (error) => error.message === FAILED_READER_MESSAGE,
      `reader must reject maxBytes=${maxBytes} with its own message`,
    );
  }
  const atLimit = await read({ archivePath: ARCHIVE_PATH, entry: "Note.md", maxBytes: MAX_INLINE_TRANSFER_BYTES });
  assert.equal(atLimit.truncated, false, "the hard maximum itself is a legal request");
});

// ---------------------------------------------------------------------------
// 3. Zero-write invariant
// ---------------------------------------------------------------------------

async function snapshotTree(directory) {
  const entries = [];
  async function visit(abs, relative) {
    let stat;
    try {
      stat = await fs.lstat(abs);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    entries.push(`${relative}|${stat.isDirectory() ? "dir" : "file"}|${stat.size}|${Math.round(stat.mtimeMs)}`);
    if (!stat.isDirectory()) return;
    const children = await fs.readdir(abs, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      await visit(path.join(abs, child.name), `${relative}/${child.name}`);
    }
  }
  await visit(directory, ".");
  return entries.sort();
}

test("reading entries writes nothing to the Vault, DATA_PATH, history, transfers or git", async () => {
  const before = { vault: await snapshotTree(vault), data: await snapshotTree(data) };

  await read({ archivePath: ARCHIVE_PATH, entry: "Note.md" });
  await read({ archivePath: ARCHIVE_PATH, entry: "Long.txt", maxBytes: 9 });
  await read({ archivePath: ARCHIVE_PATH, entry: "CJK.txt", maxBytes: 3 });
  await read({ archivePath: ARCHIVE_PATH, entry: "Binary.bin" });
  await readError({ archivePath: ARCHIVE_PATH, entry: "Missing.md" });
  await readError({ archivePath: "Archive/NotZip.txt", entry: "Note.md" });

  const after_ = { vault: await snapshotTree(vault), data: await snapshotTree(data) };
  assert.deepEqual(after_.vault, before.vault, "the Vault tree changed during a read-only tool call");
  assert.deepEqual(after_.data, before.data, "DATA_PATH changed during a read-only tool call");

  await assert.rejects(() => fs.stat(path.join(data, "transfers")), { code: "ENOENT" });
  await assert.rejects(() => fs.stat(path.join(data, "history")), { code: "ENOENT" });
  await assert.rejects(() => fs.stat(path.join(vault, ".git", "HEAD")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(vault, ARCHIVE_PATH)), archive, "the archive itself must be untouched");
});
