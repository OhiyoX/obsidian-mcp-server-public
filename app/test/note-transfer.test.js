import assert from "node:assert/strict";
import test from "node:test";
import { buildNoteFileTransfer, noteFileTransferResult } from "../src/note-transfer.js";

const raw = Buffer.from("---\r\ntitle: 完整笔记\r\n---\r\n# 标题\r\n\r\n正文\r\n", "utf8");
const metadata = {
  path: "40-Projects/测试 Note.md",
  stat: { size: raw.length, created: "2026-08-30T00:00:00.000Z", modified: "2026-08-30T00:01:00.000Z" },
};

test("complete note transfer preserves exact bytes and provides a checksum", () => {
  const transfer = buildNoteFileTransfer(raw, metadata, "base64");
  assert.equal(transfer.complete, true);
  assert.equal(transfer.byteLength, raw.length);
  assert.equal(transfer.suggestedFilename, "测试 Note.md");
  assert.deepEqual(Buffer.from(transfer.content, "base64"), raw);
  assert.match(transfer.sha256, /^[a-f0-9]{64}$/);
  assert.equal(transfer.revision, `sha256:${transfer.sha256}`);
});

test("complete note transfer emits an MCP embedded Markdown resource", () => {
  const transfer = buildNoteFileTransfer(raw, metadata, "text");
  const result = noteFileTransferResult(transfer);
  assert.equal(result.content[0].type, "resource");
  assert.equal(result.content[0].resource.uri, "obsidian://vault/40-Projects/%E6%B5%8B%E8%AF%95%20Note.md");
  assert.equal(result.content[0].resource.text, raw.toString("utf8"));
  assert.equal(result.structuredContent.content, raw.toString("utf8"));
});
