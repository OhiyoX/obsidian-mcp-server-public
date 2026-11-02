// Issue #229 Wave A / A3 — characterization tests (must stay green on old main
// AND after the auto-fallback change).
//
// These tests freeze only the behaviours the #229 hotfix promises NOT to
// change: implicit AND, OR groups, negatives, hard filters, quoted phrases,
// exact-result shape/score/reasons/snippets, explicit semantic=false, the
// semantic=true missing-text error, regex compatibility, and CJK/identifier
// exact semantics.
//
// Hard boundary: this file must never assert a NEW field (semanticMode,
// fallbackUsed, diagnostics) and must never assert what omitted `semantic`
// means (strict zero or fallback). Both sides of those assertions go red on
// one of the two heads. Future-behaviour assertions live in the Wave B
// acceptance package under the task scratch directory, not here.
//
// Contract references: S229-01 … S229-09 in
// _Workspace/40-Projects/obsidian_mcp_server/MCP/DEVELOPMENT - Issue 229
// search_notes exact-first 自动回退与诊断.md

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Environment must be configured before importing config-dependent modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-search-229-characterization-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(data, { recursive: true });

const [
  { parseObsidianQuery },
  { evaluateObsidianQuery },
  { hybridSearch },
  { registerSearchTools },
  { drainRetrievalIndex },
  corpus,
] = await Promise.all([
  import("../src/search/obsidian-query.js"),
  import("../src/search/evaluator.js"),
  import("../src/search/hybrid-search.js"),
  import("../src/tools/search.js"),
  import("../src/retrieval.js"),
  import("./fixtures/search-229-corpus.mjs"),
]);

await corpus.writeFixtureVault(vault, corpus.allFixtureNotes());

const chineseRecords = corpus.recordsFor(corpus.chineseFixture());
const multiRecords = corpus.recordsFor(corpus.multiTermFixture());
const mixedRecords = corpus.recordsFor(corpus.mixedFixture());

after(async () => {
  // Drain the retrieval lifecycle before removing the scratch root so a
  // background refresh cannot race cleanup.
  await drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

function matchedPaths(records, query, options = {}) {
  return records
    .filter((record) => evaluateObsidianQuery(record, parseObsidianQuery(query), options).matched)
    .map((record) => record.path);
}

async function hybrid(records, query, options = {}) {
  return hybridSearch(records, parseObsidianQuery(query), options);
}

async function withSearchClient(callback) {
  const server = new McpServer({ name: "search-229-characterization", version: "1" });
  registerSearchTools(server);
  const client = new Client({ name: "search-229-characterization-client", version: "1" });
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

function callSearch(client, args) {
  return client.callTool({ name: "search_notes", arguments: args });
}

// S229-01 — implicit AND: whitespace is AND, not OR.
test("S229-01 implicit AND requires co-occurrence and exact zero stays zero", async () => {
  assert.deepEqual(matchedPaths(multiRecords, "alpha beta"), ["Notes/C.md"]);
  assert.deepEqual(matchedPaths(multiRecords, "alpha only"), ["Notes/A.md"]);

  // Exact evaluator and the explicit-semantic:false execution are the only
  // paths frozen here; omitted semantic is intentionally not asserted.
  const zero = await hybrid(multiRecords, "alpha gamma", { semantic: false });
  assert.deepEqual(zero.results, []);
  assert.equal(zero.hybridUsed, false);
  assert.equal(zero.semanticUsed, false);
});

// S229-02 — uppercase OR selects the first passing alternative group.
test("S229-02 uppercase OR keeps first-passing-group alternative semantics", async () => {
  const either = await hybrid(multiRecords, "alpha OR gamma", { semantic: false });
  assert.deepEqual([...either.results.map((item) => item.path)].sort(), ["Notes/A.md", "Notes/C.md"]);

  const secondGroup = await hybrid(multiRecords, "gamma OR beta", { semantic: false });
  assert.deepEqual([...secondGroup.results.map((item) => item.path)].sort(), ["Notes/B.md", "Notes/C.md"]);
});

// S229-03 — semantic candidates must still satisfy negative clauses.
test("S229-03 negative clauses are not bypassed by a semantic candidate", async () => {
  const negated = await hybrid(multiRecords, "alpha -beta", { semantic: false });
  assert.deepEqual(negated.results.map((item) => item.path), ["Notes/A.md"]);

  const c = multiRecords.find((record) => record.path === "Notes/C.md");
  assert.equal(evaluateObsidianQuery(c, parseObsidianQuery("tag:x related-concept"), { semanticCandidate: true }).matched, true);
  assert.equal(evaluateObsidianQuery(c, parseObsidianQuery("tag:missing related-concept"), { semanticCandidate: true }).matched, false);
  assert.equal(evaluateObsidianQuery(c, parseObsidianQuery("related-concept -beta"), { semanticCandidate: true }).matched, false);
});

// S229-04 — path/file/tag/property hard filters must be really enforced.
test("S229-04 path, file, tag, and property filters stay mandatory", async () => {
  assert.deepEqual(matchedPaths(multiRecords, "tag:x"), ["Notes/A.md", "Notes/C.md"]);
  assert.deepEqual(matchedPaths(multiRecords, "path:Notes/A"), ["Notes/A.md"]);
  assert.deepEqual(matchedPaths(multiRecords, "file:A"), ["Notes/A.md"]);
  assert.deepEqual(matchedPaths(multiRecords, "tag:missing alpha"), []);

  const c = multiRecords.find((record) => record.path === "Notes/C.md");
  assert.equal(evaluateObsidianQuery(c, parseObsidianQuery("[status:active]")).matched, true);
  assert.equal(evaluateObsidianQuery(c, parseObsidianQuery("[missing]")).matched, false);
});

// S229-05 — quoted text keeps contiguous phrase semantics, not implicit AND.
test("S229-05 quoted phrases stay contiguous", async () => {
  const phrase = await hybrid(multiRecords, '"alpha beta"', { semantic: false });
  assert.deepEqual(phrase.results.map((item) => item.path), ["Notes/C.md"]);

  const reversed = await hybrid(multiRecords, '"beta alpha"', { semantic: false });
  assert.deepEqual(reversed.results, []);

  const single = await hybrid(multiRecords, '"alpha only"', { semantic: false });
  assert.deepEqual(single.results.map((item) => item.path), ["Notes/A.md"]);
});

// Exact result shape: score formula, reasons prefix, snippet structure.
test("hybridSearch exact results keep their public shape and score formula", async () => {
  const result = await hybrid(chineseRecords, "禁止自动合并", { semantic: false });
  assert.equal(result.hybridUsed, false);
  assert.equal(result.semanticUsed, false);
  assert.equal(result.semanticError, null);
  assert.equal(result.results.length, 1);

  const [hit] = result.results;
  assert.deepEqual(
    Object.keys(hit).sort(),
    ["aliases", "matchCount", "path", "reasons", "revision", "score", "snippets", "stat", "tags"].sort(),
  );
  assert.equal(hit.path, "Notes/合并策略.md");
  assert.equal(hit.matchCount, 1);
  assert.equal(hit.score, 1 + Math.min(1, 20) / 20);
  assert.deepEqual(hit.reasons, ["exact", "query:禁止自动合并"]);
  assert.ok(Array.isArray(hit.snippets) && hit.snippets.length >= 1);
  assert.ok(hit.snippets[0].includes("禁止自动合并"));
  assert.equal(hit.stat.modified, "2026-10-04T00:00:00.000Z");
  assert.equal(typeof hit.revision, "string");
  assert.deepEqual(hit.tags, ["policy/merge"]);
});

// S229-06 style: explicit semantic=false is a pure exact path.
test("explicit semantic=false is a pure exact path with no hybrid or embedding", async () => {
  const result = await hybrid(multiRecords, "alpha gamma", { semantic: false });
  assert.deepEqual(result.results, []);
  assert.equal(result.hybridUsed, false);
  assert.equal(result.semanticUsed, false);
  assert.equal(result.semanticError, null);
});

// Explicit semantic=true without any positive text keeps the frozen error and
// the exact results computed before the short-circuit.
test("semantic=true without positive text keeps the exact error and exact results", async () => {
  const result = await hybrid(multiRecords, "tag:x", { semantic: true });
  assert.equal(result.semanticError, "Semantic search requires a positive text term");
  assert.equal(result.hybridUsed, false);
  assert.equal(result.semanticUsed, false);
  assert.deepEqual(result.results.map((item) => item.path), ["Notes/A.md", "Notes/C.md"]);
});

// S229-08 — regex and semantic=true stay incompatible (real tool boundary).
test("tool: semantic=true plus useRegex=true is rejected with the frozen message", async () => {
  await withSearchClient(async (client) => {
    const rejected = await callSearch(client, { query: "alpha", useRegex: true, semantic: true });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.content[0].text, "Error: Semantic search cannot be combined with regex mode");

    const regexOnly = await callSearch(client, { query: "alpha", useRegex: true, semantic: false });
    assert.equal(regexOnly.isError, undefined);
    assert.deepEqual(
      regexOnly.structuredContent.results.map((item) => item.path).sort(),
      ["Notes/A.md", "Notes/C.md"],
    );
  });
});

// §9 Chinese exact semantics: exact substring stays exact; the variant is a
// strict zero on the explicit off path.
test("CJK exact matching is preserved and the variant is a strict zero with semantic=false", async () => {
  const exact = await hybrid(chineseRecords, "禁止自动合并", { semantic: false });
  assert.deepEqual(exact.results.map((item) => item.path), ["Notes/合并策略.md"]);

  const variant = await hybrid(chineseRecords, "不自动合并", { semantic: false });
  assert.deepEqual(variant.results, []);

  await withSearchClient(async (client) => {
    const toolExact = await callSearch(client, { query: "禁止自动合并", semantic: false });
    assert.equal(toolExact.isError, undefined);
    assert.deepEqual(toolExact.structuredContent.results.map((item) => item.path), ["Notes/合并策略.md"]);
    assert.equal(toolExact.structuredContent.hybridUsed, false);
    assert.equal(toolExact.structuredContent.semanticUsed, false);

    const toolVariant = await callSearch(client, { query: "不自动合并", semantic: false });
    assert.deepEqual(toolVariant.structuredContent.results, []);
  });
});

// Mixed Chinese + identifier fixture: exact semantics for identifiers.
test("mixed Chinese/identifier fixture matches whole identifiers exactly", () => {
  assert.deepEqual(matchedPaths(mixedRecords, "热路由缓存"), ["Ops/热路由缓存.md"]);
  assert.deepEqual(matchedPaths(mixedRecords, "planRestoreVersion"), ["Ops/热路由缓存.md"]);
  assert.deepEqual(matchedPaths(mixedRecords, "v1.2.3"), ["Ops/热路由缓存.md"]);
  assert.deepEqual(matchedPaths(mixedRecords, "restore_from_trash"), ["Ops/版本回滚.md"]);
  assert.deepEqual(matchedPaths(mixedRecords, "dfba2c1"), ["Ops/版本回滚.md"]);
  assert.deepEqual(matchedPaths(mixedRecords, "app/src/search.js"), ["Ops/热路由缓存.md"]);
});
