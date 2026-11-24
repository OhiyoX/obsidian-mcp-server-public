// Issue #276 (D2) — Chinese write / restore discoverability under deferred tool discovery.
//
// An agent that searches for its tools in Chinese ("保存笔记", "恢复版本") found no write or
// restore tool in the served descriptors, so it wrote nothing or gave up. This test freezes the
// retrieval signal the write and restore descriptors MUST carry, in both served profiles.
//
// This is a DETERMINISTIC PROXY for a Host's client-side lexical tool search, exactly like
// `recovery-discoverability.test.js`: it captures the real descriptors for a real identity from
// `resolveDiscoveryView` + `compactToolView` (the two functions the discovery runtime calls per
// request) and ranks them with BM25 (k1 = 1.2, b = 0.75, the parameters of `src/retrieval.js`).
//
// What it does NOT prove, and cannot:
//   * that any specific Host or model selects the right tool;
//   * that a Host's own tokenizer keeps CJK at all. A Host that tokenizes ASCII words only can
//     never match a Chinese description, no matter what the server serves, so that case is
//     modelled as BLOCKED (see the "latin-only host" test) with a Latin fallback path, never green.
//
// Scope filtering is modelled with `resolveDiscoveryView` (the per-request policy function). The
// transport-level gate — a hidden name answers unknown-tool, and a call needs `obsidian.write` —
// is proven in `discovery-runtime.test.js` and is not re-proven here.

import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerObsidianCapabilities } from "../src/capabilities.js";
import { compactToolView } from "../src/compact-tools.js";
import { resolveDiscoveryView } from "../src/discovery-runtime.js";
import { tokenize } from "../src/retrieval.js";
import { MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";

const ALL_SCOPES = ["obsidian.read", "obsidian.write", "obsidian.files"];
const READ_ONLY_SCOPES = ["obsidian.read"];

// Host search tokenizers. "cjk-bigram" is the tokenizer this repository ships (CJK unigram +
// bigram), i.e. what a CJK-aware Host search looks like. "latin-only" drops every CJK character,
// which is what a Host word tokenizer does to a Chinese query and a Chinese description.
const HOSTS = {
  "cjk-bigram": (value) => tokenize(value),
  "latin-only": (value) => String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [],
};

// Frozen intents. `expect` lists the native tools that may legitimately answer the query: the
// search must surface ONE of them in its top 5. Chinese and English are both frozen so the fix
// can never trade one for the other.
const WRITE_QUERIES = [
  ["保存笔记", ["write_note"]],
  ["新建一篇笔记", ["write_note"]],
  ["把这段内容写入笔记", ["write_note"]],
  ["在笔记末尾追加内容", ["append_to_note"]],
  ["修改笔记里某一节的文字", ["patch_note"]],
  ["create a new note", ["write_note"]],
  ["save this content to a note", ["write_note", "append_to_note"]],
  ["append text at the end of a note", ["append_to_note"]],
];

const RESTORE_QUERIES = [
  ["恢复版本", ["restore_version"]],
  ["恢复旧版本的内容", ["restore_version", "plan_restore_version"]],
  ["版本历史", ["list_versions"]],
  ["从回收站恢复", ["restore_from_trash", "plan_restore_from_trash"]],
  ["恢复到上一个版本", ["restore_version", "plan_restore_version"]],
  ["回滚刚才那次写入", ["restore_version", "plan_restore_version", "list_versions"]],
  ["撤销上一次写入", ["restore_version", "plan_restore_version", "list_versions"]],
  ["恢复误删的笔记", ["restore_from_trash", "plan_restore_from_trash"]],
  ["删除方案", ["plan_delete_note"]],
  ["应用方案", ["apply_note_plan"]],
  ["restore a note to a previous version", ["restore_version", "plan_restore_version"]],
  ["roll back my last write", ["restore_version", "plan_restore_version", "list_versions"]],
];

// Every tool that needs `obsidian.write`, derived from the Scope truth instead of a hand list.
const WRITE_SCOPED_TOOLS = Object.entries(MCP_TOOL_SCOPE_REQUIREMENTS)
  .filter(([, scopes]) => scopes.includes("obsidian.write"))
  .map(([name]) => name);

const describeRank = (rows) => rows.map((row) => `${row.name}(${row.score.toFixed(3)})`).join(", ") || "<no match>";

let nativeCache = null;
async function nativeDescriptors() {
  if (nativeCache) return nativeCache;
  const server = new McpServer({ name: "cjk-tool-discovery-test", version: "1" });
  registerObsidianCapabilities(server);
  const client = new Client({ name: "cjk-tool-discovery-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    nativeCache = (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
  return nativeCache;
}

// The served descriptors for one identity, in the shape the discovery runtime emits: every
// descriptor carries the native tool names it can execute (`natives`).
async function servedDescriptors(profile, scopes) {
  const native = await nativeDescriptors();
  const view = resolveDiscoveryView({ authInfo: { scopes } });
  const shape = (tool, natives) => ({ name: tool.name, title: tool.title || "", description: tool.description || "", natives });
  if (profile === "compact") {
    const compact = compactToolView(native, view.toolNames);
    return compact.tools.map((tool) => shape(tool, [...compact.routing.get(tool.name)]));
  }
  const visible = new Set(view.toolNames);
  return native.filter((tool) => visible.has(tool.name)).map((tool) => shape(tool, [tool.name]));
}

// BM25 with the parameters of `src/retrieval.js` bm25Scores (k1 = 1.2, b = 0.75), applied to
// descriptors instead of note chunks, with the Host's tokenizer deciding what a term is.
function bm25Rank(descriptors, query, hostTokenizer) {
  const documents = descriptors.map((descriptor) => hostTokenizer(`${descriptor.name} ${descriptor.title} ${descriptor.description}`));
  const queryTokens = hostTokenizer(query);
  const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, documents.length);
  const scores = new Array(descriptors.length).fill(0);
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
  return descriptors
    .map((descriptor, index) => ({ name: descriptor.name, natives: descriptor.natives, score: scores[index] }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);
}

function assertSurfaced(descriptors, queries, host = "cjk-bigram") {
  const tokenizeForHost = HOSTS[host];
  for (const [query, expected] of queries) {
    const top5 = bm25Rank(descriptors, query, tokenizeForHost).slice(0, 5);
    assert.ok(
      top5.some((row) => row.natives.some((name) => expected.includes(name))),
      `${host}: query ${JSON.stringify(query)} ranked none of [${expected.join(", ")}] in its top 5: ${describeRank(top5)}`,
    );
  }
}

for (const profile of ["full", "compact"]) {
  test(`${profile}: Chinese write intents surface a write tool`, async () => {
    assertSurfaced(await servedDescriptors(profile, ALL_SCOPES), WRITE_QUERIES);
  });

  test(`${profile}: Chinese restore, rollback and plan intents surface their tool`, async () => {
    assertSurfaced(await servedDescriptors(profile, ALL_SCOPES), RESTORE_QUERIES);
  });
}

test("full: English write and restore intents keep surfacing their tool", async () => {
  assertSurfaced(await servedDescriptors("full", ALL_SCOPES), [...WRITE_QUERIES, ...RESTORE_QUERIES]);
});

test("compact: English write and restore intents keep surfacing their group", async () => {
  assertSurfaced(await servedDescriptors("compact", ALL_SCOPES), [...WRITE_QUERIES, ...RESTORE_QUERIES]);
});

test("a read-only identity is served no write tool, so no write query can surface one", async () => {
  for (const profile of ["full", "compact"]) {
    const descriptors = await servedDescriptors(profile, READ_ONLY_SCOPES);
    const reachable = new Set(descriptors.flatMap((descriptor) => descriptor.natives));
    assert.ok(WRITE_SCOPED_TOOLS.length > 0, "the Scope truth must name write tools");
    for (const name of WRITE_SCOPED_TOOLS) {
      assert.ok(!reachable.has(name), `${profile}: read-only identity is served ${name}`);
    }
    const tokenizeForHost = HOSTS["cjk-bigram"];
    for (const [query] of [...WRITE_QUERIES, ...RESTORE_QUERIES]) {
      const ranked = bm25Rank(descriptors, query, tokenizeForHost);
      const leaked = ranked.filter((row) => row.natives.some((name) => WRITE_SCOPED_TOOLS.includes(name)));
      assert.deepEqual(leaked, [], `${profile}: query ${JSON.stringify(query)} surfaced a write tool to a read-only identity`);
    }
  }
});

// `CJK_DISCOVERY_TABLE=1 node --test test/mcp-cjk-tool-discovery.test.js` prints the frozen
// query × descriptor table this test measures, for a before/after comparison in review.
if (process.env.CJK_DISCOVERY_TABLE === "1") {
  test("table: frozen query × served descriptor top 3", async () => {
    for (const profile of ["full", "compact"]) {
      const descriptors = await servedDescriptors(profile, ALL_SCOPES);
      for (const [query] of [...WRITE_QUERIES, ...RESTORE_QUERIES]) {
        console.log(`${profile}\t${query}\t${describeRank(bm25Rank(descriptors, query, HOSTS["cjk-bigram"]).slice(0, 3))}`);
      }
    }
  });
}

test("a Host tokenizer that drops CJK stays BLOCKED, and the Latin fallback still resolves", async () => {
  // Honest limit, frozen: a server cannot make a Chinese word exist for a Host whose tokenizer
  // removes every CJK character. The Chinese query resolves to nothing there; do not report green.
  for (const profile of ["full", "compact"]) {
    const descriptors = await servedDescriptors(profile, ALL_SCOPES);
    const blocked = bm25Rank(descriptors, "保存笔记", HOSTS["latin-only"]);
    assert.deepEqual(blocked, [], `${profile}: latin-only host unexpectedly matched a Chinese query`);

    // Fallback path: the native tool name and the group name are ASCII, so the same agent can
    // still reach the same tool by typing the name it sees in the compact/group listing.
    for (const [query] of [["恢复版本"], ["版本历史"], ["从回收站恢复"]]) {
      assert.deepEqual(
        bm25Rank(descriptors, query[0], HOSTS["latin-only"]),
        [],
        `${profile}: latin-only host unexpectedly matched ${query[0]}`,
      );
    }
    const fallbacks = [
      [profile === "compact" ? "obsidian_edit" : "write_note", "write_note"],
      [profile === "compact" ? "obsidian_restore" : "restore_version", "restore_version"],
      [profile === "compact" ? "obsidian_history" : "list_versions", "list_versions"],
    ];
    for (const [query, expected] of fallbacks) {
      const fallback = bm25Rank(descriptors, query, HOSTS["latin-only"]);
      assert.ok(
        fallback.slice(0, 5).some((row) => row.natives.includes(expected)),
        `${profile}: the Latin fallback ${JSON.stringify(query)} did not surface ${expected}: ${describeRank(fallback.slice(0, 5))}`,
      );
    }
  }
});
