// Issue #251, item 2 — recovery-tool discoverability regression.
//
// A live-call incident showed that the recovery tools existed but could not be
// found by client-side lexical tool search: six-plus BM25 searches for
// rollback/undo wording returned only unrelated tools. This test locks the
// retrieval signal those tools carry.
//
// It is a DETERMINISTIC PROXY for a client's lexical tool search: it captures
// the real `tools/list` descriptors from a real McpServer + InMemoryTransport,
// then ranks them with the repository's own tokenizer and the same BM25
// parameters as app/src/retrieval.js bm25Scores (k1 = 1.2, b = 0.75). It is NOT
// a real host or model evaluation, and passing here does not prove that any
// specific agent will select the right tool.

import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerObsidianCapabilities } from "../src/capabilities.js";
import { tokenize } from "../src/retrieval.js";

// Tools that can take part in recovering from a mistaken write or deletion.
const RECOVERY_TOOLS = [
  "list_versions",
  "restore_version",
  "get_note_version",
  "plan_restore_version",
  "compare_note_versions",
  "restore_from_trash",
  "list_trash",
];

// Natural-language recovery intents, English and Chinese.
const RECOVERY_QUERIES = [
  "rollback my last write",
  "undo the write I just made",
  "recover a note I accidentally overwrote",
  "restore a note to a previous version",
  "刚才那次写错了，回滚",
  "误写 回滚",
  "恢复到之前的版本",
];

// Vocabulary contract for the eight recovery-adjacent descriptions.
const WIDE_RECOVERY_VOCABULARY = /rollback|roll back|undo|revert|recover|restore|accidental|mistaken/i;
const STRONG_RECOVERY_VOCABULARY = /rollback|roll back|undo|revert|recover|accidental|mistaken/i;

// createMemoryGuidanceRegistrar appends a fixed shared-memory hint to read/write
// tools. Strip it so the length budget is measured on the authored description
// this repository controls, not on the injected guidance text.
function authoredDescription(description) {
  return String(description || "").replace(/ For (durable project state|shared project memory),.*$/, "");
}

async function captureRuntimeTools() {
  const server = new McpServer({ name: "recovery-discoverability-test", version: "1" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "recovery-discoverability-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

// Copy of app/src/retrieval.js bm25Scores scoring math (k1 = 1.2, b = 0.75),
// applied to tool descriptors instead of note chunks.
function bm25Rank(tools, query) {
  const documents = tools.map((tool) => tokenize(`${tool.name} ${tool.title || ""} ${tool.description || ""}`));
  const queryTokens = tokenize(query);
  const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, documents.length);
  const scores = new Array(tools.length).fill(0);
  for (const token of [...new Set(queryTokens)]) {
    const documentFrequency = documents.filter((tokens) => tokens.includes(token)).length;
    if (!documentFrequency) continue;
    const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
    documents.forEach((tokens, index) => {
      const frequency = tokens.filter((item) => item === token).length;
      if (!frequency) return;
      const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * tokens.length / Math.max(1, averageLength));
      scores[index] += (idf * (frequency * 2.2)) / denominator;
    });
  }
  return tools
    .map((tool, index) => ({ name: tool.name, score: scores[index] }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
}

test("every recovery tool is exposed with accurate, bounded recovery vocabulary", async () => {
  const tools = await captureRuntimeTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let strongVocabularyTools = 0;

  for (const name of RECOVERY_TOOLS) {
    const tool = byName.get(name);
    assert.ok(tool, `recovery tool ${name} is missing from tools/list`);
    assert.equal(typeof tool.description, "string", `${name} has no description`);
    const description = authoredDescription(tool.description);
    assert.ok(description.length <= 240, `${name} authored description is ${description.length} chars (limit ~240)`);
    assert.match(description, WIDE_RECOVERY_VOCABULARY, `${name} description lacks recovery vocabulary`);
    if (STRONG_RECOVERY_VOCABULARY.test(description)) strongVocabularyTools += 1;
  }

  assert.ok(
    strongVocabularyTools >= 6,
    `only ${strongVocabularyTools} recovery tools contain explicit rollback/undo/revert/recover/accidental/mistaken wording`,
  );
});

test("version-recovery descriptions carry the Chinese rollback and mistaken-write terms", async () => {
  const tools = await captureRuntimeTools();
  const authored = new Map(tools.map((tool) => [tool.name, authoredDescription(tool.description)]));

  for (const name of ["restore_version", "list_versions", "get_note_version"]) {
    assert.ok(authored.get(name).includes("回滚"), `${name} description must contain 回滚`);
  }
  for (const name of ["restore_version", "list_versions"]) {
    assert.ok(authored.get(name).includes("误写"), `${name} description must contain 误写`);
  }
  for (const name of ["restore_from_trash", "list_trash"]) {
    assert.match(authored.get(name), /deleted by mistake|accidental deletion|误删/, `${name} description must carry accidental-deletion wording`);
  }
});

test("each natural-language recovery query ranks a recovery tool in the top 5", async () => {
  const tools = await captureRuntimeTools();
  for (const query of RECOVERY_QUERIES) {
    const top5 = bm25Rank(tools, query).slice(0, 5);
    const ranked = top5.map((row) => `${row.name}(${row.score.toFixed(3)})`).join(", ") || "<no matches>";
    assert.ok(
      top5.some((row) => RECOVERY_TOOLS.includes(row.name)),
      `query ${JSON.stringify(query)} ranked no recovery tool in its top 5: ${ranked}`,
    );
  }
});
