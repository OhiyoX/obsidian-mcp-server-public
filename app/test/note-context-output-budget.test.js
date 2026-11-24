import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// O4: opt-in byte budget for the whole serialized `structuredContent` of
// get_note_context. The fixture below is deliberately big: a long path,
// multi-language text, huge frontmatter/tags and 4 backlinks.

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-note-context-budget-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

const TARGET = "Archive/Deep/Nested/Projects/多语言笔记/Word-Bank/目标笔记-Budget-Target-With-A-Deliberately-Long-Name.md";
const TARGET_DIR = path.posix.dirname(TARGET);
const BUDGET_BYTES = 8192;
const MULTILINGUAL = [
  "多语言正文：这是一段用来消耗字节的中文段落，包含目标笔记的说明与背景。",
  "日本語の段落です。バジェットの動作を確認するために長めに書いています。",
  "نص عربي طويل لاختبار حساب البايتات بترميز UTF-8.",
  "Русский текст для проверки байтового бюджета.",
  "Ελληνικό κείμενο για τη δοκιμή του προϋπολογισμού.",
  "Emoji 🎯🧭📚 and plain ASCII filler text for the byte budget.",
].join("\n\n");

async function write(relative, content) {
  const abs = path.join(vault, relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

const LONG_TAGS = Array.from({ length: 30 }, (_, index) => `标签-${index}-multilingual-tag-value-with-length`);
const LONG_FIELDS = Array.from({ length: 26 }, (_, index) => `custom-frontmatter-field-${index}-with-a-long-name`);
const frontmatter = [
  "---",
  "title: 目标笔记 — Multilingual target with a deliberately long title 多语言标题",
  "type: project",
  `tags: [${LONG_TAGS.join(", ")}]`,
  ...LONG_FIELDS.map((field, index) => `${field}: value-${index}-多语言`),
  "---",
].join("\n");
const headings = Array.from({ length: 30 }, (_, index) => `## 章节 Heading ${index} with a deliberately long heading title 多语言`);
await write(TARGET, `${frontmatter}\n# 目标笔记\n\n${MULTILINGUAL}\n\n${headings.join("\n\n")}\n`);

for (let index = 1; index <= 4; index += 1) {
  await write(
    `${TARGET_DIR}/Backlinks/区域-${index}/回链-Backlink-${index}-With-A-Long-Name.md`,
    `---\ntitle: 回链 ${index}\ntags: [${LONG_TAGS.slice(0, 16).join(", ")}]\n---\n\nReference: [[${TARGET.replace(/\.md$/, "")}]]\n\n${MULTILINGUAL}\n`,
  );
}

// A small deterministic note: its full output is frozen below to prove that a
// request without `maxOutputBytes` is unchanged.
await write("Notes/Golden.md", "---\ntitle: Golden\ntype: note\ntags: [golden]\n---\n# Golden\n\nGolden body.\n");

const { buildNoteContext } = await import("../src/context-service.js");
const { registerContextTools } = await import("../src/tools/context.js");
const { createMemoryGuidanceRegistrar } = await import("../src/memory-guidance.js");
const { syncRetrievalIndex } = await import("../src/retrieval.js");

await syncRetrievalIndex({ force: true, embeddings: false });

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function bytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

async function withContextClient(callback) {
  const server = new McpServer({ name: "note-context-budget-test", version: "1" });
  registerContextTools(createMemoryGuidanceRegistrar(server));
  const client = new Client({ name: "note-context-budget-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function frozenShape(result) {
  return JSON.stringify(result, null, 2)
    .replace(/sha256:[0-9a-f]{64}/g, "sha256:HASH")
    .replace(/"modified": "[^"]*"/g, '"modified": "ISO"')
    .replace(/"size": \d+/g, '"size": SIZE');
}

test("an 8 KB byte budget trims text then items and never emits a dangling reference", async () => {
  const full = await buildNoteContext({ path: TARGET });
  assert.ok(bytes(full) > BUDGET_BYTES, `fixture must exceed the budget (${bytes(full)} bytes)`);
  assert.equal(full.items.filter((item) => item.kind === "backlink").length, 4);

  const budgeted = await buildNoteContext({ path: TARGET, maxOutputBytes: BUDGET_BYTES });
  const size = bytes(budgeted);
  assert.ok(size <= BUDGET_BYTES, `budgeted payload ${size} > ${BUDGET_BYTES}`);

  for (const field of ["status", "path", "revision", "sources", "warnings", "truncated", "budget"]) {
    assert.ok(Object.hasOwn(budgeted, field), `missing ${field}`);
  }
  assert.equal(budgeted.path, TARGET);
  assert.equal(budgeted.revision, full.revision);
  assert.equal(budgeted.status, "partial");
  assert.equal(budgeted.truncated, true);
  assert.ok(budgeted.warnings.some((warning) => warning.code === "output_budget_truncated"));
  assert.equal(budgeted.budget.maxOutputBytes, BUDGET_BYTES);
  assert.equal(budgeted.budget.maxChars, full.budget.maxChars);
  assert.equal(budgeted.budget.maxItems, full.budget.maxItems);

  // Optional text goes first: excerpts are dropped before any item disappears.
  assert.equal(budgeted.items[0].kind, "target", "the target item survives");
  assert.equal(budgeted.items.some((item) => Object.hasOwn(item, "excerpt")), false, "excerpts are trimmed before items");

  // Reference invariant: every item has a source and every source resolves to
  // an emitted item, so a truncated answer cites only what it returned.
  assert.equal(budgeted.sources.length, budgeted.items.length);
  const itemIds = new Set(budgeted.items.map((item) => item.id));
  const itemPaths = new Set(budgeted.items.map((item) => item.path));
  for (const source of budgeted.sources) {
    assert.ok(itemIds.has(source.id), `source ${source.id} has no item`);
    assert.ok(itemPaths.has(source.path), `source ${source.path} has no item`);
  }
  for (const item of budgeted.items) {
    assert.ok(budgeted.sources.some((source) => source.id === item.id), `item ${item.id} has no source`);
    assert.equal(typeof item.path, "string");
    assert.ok(item.path.length > 0);
  }

  // A tighter budget drops whole items last, and still never dangles.
  const tight = await buildNoteContext({ path: TARGET, maxOutputBytes: 3000 });
  assert.ok(bytes(tight) <= 3000, `tight payload ${bytes(tight)} > 3000`);
  assert.ok(tight.items.length < full.items.length, "items are dropped after optional text");
  assert.ok(tight.items.length >= 1, "the target item always survives");
  assert.equal(tight.items[0].kind, "target");
  assert.equal(tight.truncated, true);
  assert.equal(tight.budget.usedItems, tight.items.length);
  assert.deepEqual(tight.sources.map((source) => source.id), tight.items.map((item) => item.id));
});

test("an impossible byte budget returns a structured budget error", async () => {
  await assert.rejects(
    () => buildNoteContext({ path: TARGET, maxOutputBytes: 256 }),
    (error) => error.code === "output_budget_too_small" && /maxOutputBytes/.test(error.message),
  );
  await withContextClient(async (client) => {
    const result = await client.callTool({ name: "get_note_context", arguments: { path: TARGET, maxOutputBytes: 256 } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "output_budget_too_small");
    assert.match(result.structuredContent.message, /maxOutputBytes/);
  });
});

// Frozen output of buildNoteContext({ path: "Notes/Golden", includeBacklinks: false,
// includeRelated: false }) before O4. mtime/size/revision are normalized above.
const GOLDEN = `{
  "status": "ok",
  "path": "Notes/Golden.md",
  "resolvedPath": "Notes/Golden.md",
  "revision": "sha256:HASH",
  "items": [
    {
      "id": "target:Notes/Golden.md",
      "kind": "target",
      "path": "Notes/Golden.md",
      "revision": "sha256:HASH",
      "revisionSource": "bounded_note_read",
      "trust": "untrusted_reference",
      "reason": "target",
      "score": null,
      "metadata": {
        "title": "Golden",
        "type": "note",
        "tags": [
          "golden"
        ],
        "headings": [
          "Golden"
        ],
        "frontmatterFields": [
          "title",
          "type",
          "tags"
        ],
        "size": SIZE,
        "modified": "ISO"
      }
    }
  ],
  "sources": [
    {
      "id": "target:Notes/Golden.md",
      "kind": "target",
      "path": "Notes/Golden.md",
      "revision": "sha256:HASH",
      "revisionSource": "bounded_note_read",
      "trust": "untrusted_reference",
      "reason": "target",
      "score": null
    }
  ],
  "warnings": [],
  "truncated": false,
  "budget": {
    "maxChars": 12000,
    "usedChars": 35,
    "maxItems": 20,
    "usedItems": 1,
    "counting": "vault-text-codepoints"
  },
  "index": null,
  "policy": {
    "source": "server",
    "version": "1.0.0"
  }
}`;

test("a request without maxOutputBytes is byte-identical to the frozen output", async () => {
  const result = await buildNoteContext({ path: "Notes/Golden", includeBacklinks: false, includeRelated: false });
  assert.equal(frozenShape(result), GOLDEN);
  assert.equal(Object.hasOwn(result.budget, "maxOutputBytes"), false);
  assert.equal(Object.hasOwn(result, "maxOutputBytes"), false);

  await withContextClient(async (client) => {
    const plain = await client.callTool({ name: "get_note_context", arguments: { path: "Notes/Golden", includeBacklinks: false } });
    assert.equal(plain.isError, undefined);
    assert.equal(Object.hasOwn(plain.structuredContent.budget, "maxOutputBytes"), false);
  });
});
