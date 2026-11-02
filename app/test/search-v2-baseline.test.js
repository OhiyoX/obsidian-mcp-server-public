import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeObservations, loadCorpus, projectRecords, writeCorpusVault } from "./fixtures/search-v2-harness.mjs";

// Search v2 Phase 0 — characterization baseline.
//
// This test freezes the CURRENT behaviour of the production tokenizer
// (src/retrieval.js), Obsidian query evaluator (src/search/evaluator.js),
// query parser (src/search/obsidian-query.js), and hybrid fusion
// (src/search/hybrid-search.js). It does not change ranking or online weights;
// if it fails after an intentional algorithm change, regenerate
// fixtures/search-v2-golden.json with `node scripts/search-v2-baseline.mjs --write`
// and review the diff as a deliberate ranking change.
//
// Environment must be configured before importing config/retrieval modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-search-v2-baseline-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(await fs.readFile(path.join(fixtureDirectory, "fixtures", "search-v2-golden.json"), "utf8"));
const corpus = await loadCorpus();
await writeCorpusVault(vault, corpus);

const { recall, syncRetrievalIndex, tokenize } = await import("../src/retrieval.js");
const { parseObsidianQuery } = await import("../src/search/obsidian-query.js");
const { evaluateObsidianQuery } = await import("../src/search/evaluator.js");
const { hybridSearch } = await import("../src/search/hybrid-search.js");

await syncRetrievalIndex({ force: true });
const records = projectRecords(corpus);
const observations = await computeObservations({ tokenize, recall, parseObsidianQuery, evaluateObsidianQuery, hybridSearch, records });

function hybridCase(name) {
  return observations.hybrid.find((item) => item.name === name);
}

function lexicalCase(query) {
  return observations.lexical.find((item) => item.query === query);
}

test("tokenizer characterization matches the frozen golden baseline", () => {
  assert.deepEqual(observations.tokenizer, golden.tokenizer);
});

test("tokenizer keeps CJK n-grams but splits snake_case and does not split camelCase", () => {
  assert.deepEqual(tokenize("OpenWrt 网络故障"), ["openwrt", "网络故障", "网", "络", "故", "障", "网络", "络故", "故障"]);
  assert.deepEqual(tokenize("restore_from_trash"), ["restore", "from", "trash"]);
  assert.deepEqual(tokenize("planRestoreVersion"), ["planrestoreversion"]);
  assert.deepEqual(tokenize("app/src/search.js"), ["app", "src", "search", "js"]);
});

test("lexical recall ranking matches the frozen golden baseline", () => {
  assert.deepEqual(observations.lexical, golden.lexical);
});

test("lexical recall ranks Chinese, mixed, and identifier queries deterministically", () => {
  assert.equal(lexicalCase("网络故障").results[0].path, "Notes/Network Troubleshooting.md");
  assert.equal(lexicalCase("OpenWrt").results[0].path, "Notes/Network Troubleshooting.md");
  assert.equal(lexicalCase("restore_from_trash").results[0].path, "Notes/Search Design.md");
  assert.equal(lexicalCase("dfba2c1").results[0].path, "Notes/Release Notes.md");
  assert.equal(lexicalCase("中文内容").results[0].path, "Notes/中文说明.md");
  for (const entry of observations.lexical) {
    assert.equal(entry.semanticUsed, false, `lexical-only query ${entry.query} must not use semantic`);
    assert.equal(entry.semanticError, null);
    assert.ok(entry.results.length > 0, `query ${entry.query} should match at least one note`);
  }
});

test("hybrid fusion, exact scoring, snippets, and hard filters match the frozen golden baseline", () => {
  assert.deepEqual(observations.hybrid, golden.hybrid);
});

test("exact scoring uses 1 + min(matchCount, 20) / 20 and preserves quoted phrases", () => {
  const chinese = hybridCase("exact-chinese-text");
  assert.equal(chinese.hybridUsed, false);
  assert.equal(chinese.semanticUsed, false);
  assert.equal(chinese.results[0].path, "Notes/Network Troubleshooting.md");
  assert.equal(chinese.results[0].matchCount, 3);
  assert.equal(chinese.results[0].score, 1 + Math.min(3, 20) / 20);
  assert.deepEqual(chinese.results[0].reasons, ["exact", "query:网络故障"]);
  assert.ok(chinese.results[0].snippets[0].includes("网络故障"));

  const phrase = hybridCase("exact-quoted-phrase");
  assert.deepEqual(phrase.results.map((item) => item.path), ["Notes/Search Design.md", "Archive/Old Search.md"]);
  assert.ok(phrase.results[0].snippets[0].includes("exact phrase"));
});

test("semantic candidate path cannot bypass hard filters or negatives", () => {
  const tagFiltered = hybridCase("hard-filter-tag");
  assert.equal(tagFiltered.hybridUsed, true);
  assert.equal(tagFiltered.semanticUsed, false);
  assert.equal(tagFiltered.semanticError, "Embedding provider is not configured; lexical hybrid ranking was used");
  // Every result satisfies tag:project/search.
  assert.deepEqual(tagFiltered.results.map((item) => item.path), ["Notes/Search Design.md", "Archive/Old Search.md"]);

  const violation = hybridCase("hard-filter-violation");
  assert.equal(violation.results.length, 0, "a semantic candidate must not revive a record that fails a hard filter");

  const negated = hybridCase("negation");
  assert.deepEqual(negated.results.map((item) => item.path), ["Notes/Search Design.md"]);
  assert.ok(negated.results.every((item) => item.path !== "Archive/Old Search.md"));

  const pathFiltered = hybridCase("path-filter");
  assert.deepEqual(pathFiltered.results.map((item) => item.path), ["Archive/Old Search.md"]);
});

test("evaluator hard filters, properties, and section scoping match the frozen golden baseline", () => {
  assert.deepEqual(observations.evaluator, golden.evaluator);
});

test("frontmatter visibility and section scoping behave as frozen", () => {
  const searchDesign = records.find((record) => record.path === "Notes/Search Design.md");
  assert.equal(evaluateObsidianQuery(searchDesign, parseObsidianQuery("查询设计"), {}).matched, true);
  assert.equal(evaluateObsidianQuery(searchDesign, parseObsidianQuery("查询设计"), { includeFrontmatter: false }).matched, false);
  assert.equal(evaluateObsidianQuery(searchDesign, parseObsidianQuery('section:"The restore_from_trash helper"'), {}).matched, true);
  assert.equal(evaluateObsidianQuery(searchDesign, parseObsidianQuery('section:"API Paths"'), {}).matched, false);
  assert.equal(evaluateObsidianQuery(searchDesign, parseObsidianQuery("[missing]"), {}).matched, false);
});

// Known limits: these assertions document behaviour that Search v2 must
// address, without changing the current ranking.
test("known limit: recall does not index aliases while search_notes exact does", () => {
  const aliasRecall = lexicalCase("查询设计");
  assert.equal(aliasRecall.results[0].path, "Notes/Network Troubleshooting.md");
  assert.ok(!aliasRecall.results.some((item) => item.path === "Notes/Search Design.md"), "current recall ignores the 查询设计 alias");

  const aliasExact = hybridCase("alias-exact");
  assert.deepEqual(aliasExact.results.map((item) => item.path), ["Notes/Search Design.md"]);
});

test("known limits: identifier and version tokenization lose the whole token", () => {
  assert.deepEqual(tokenize("restore_from_trash"), ["restore", "from", "trash"]);
  assert.ok(!tokenize("restore_from_trash").includes("restore_from_trash"));
  assert.deepEqual(tokenize("planRestoreVersion"), ["planrestoreversion"]);
  assert.ok(!tokenize("planRestoreVersion").includes("plan"));
  assert.deepEqual(tokenize("v1.2.3"), ["v1", "2", "3"]);
});
