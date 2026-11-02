#!/usr/bin/env node
// Search v2 Phase 0 baseline characterization.
//
// Read-only against production source: this script imports the current
// tokenizer / evaluator / hybrid-search modules, builds a temporary Vault from
// app/test/fixtures/search-v2-corpus.json, and projects deterministic
// observations. It never edits src/ and never changes online weights.
//
// Usage:
//   node scripts/search-v2-baseline.mjs           # print observations, diff vs golden
//   node scripts/search-v2-baseline.mjs --write    # regenerate search-v2-golden.json
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeObservations, loadCorpus, projectRecords, writeCorpusVault } from "../test/fixtures/search-v2-harness.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const goldenPath = path.join(scriptDirectory, "..", "test", "fixtures", "search-v2-golden.json");
const write = process.argv.includes("--write");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-v2-baseline-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

const corpus = await loadCorpus();
await writeCorpusVault(vault, corpus);

const { recall, syncRetrievalIndex, tokenize } = await import("../src/retrieval.js");
const { parseObsidianQuery } = await import("../src/search/obsidian-query.js");
const { evaluateObsidianQuery } = await import("../src/search/evaluator.js");
const { hybridSearch } = await import("../src/search/hybrid-search.js");

await syncRetrievalIndex({ force: true });
const observations = await computeObservations({
  tokenize,
  recall,
  parseObsidianQuery,
  evaluateObsidianQuery,
  hybridSearch,
  records: projectRecords(corpus),
});

const serialized = `${JSON.stringify(observations, null, 2)}\n`;
if (write) {
  await fs.writeFile(goldenPath, serialized, "utf8");
  console.log(`Wrote baseline: ${goldenPath}`);
} else {
  const existing = await fs.readFile(goldenPath, "utf8").catch(() => null);
  if (existing === serialized) {
    console.log("Baseline matches search-v2-golden.json");
  } else {
    console.log("Baseline drift detected (run with --write to regenerate):");
    console.log(serialized);
    process.exitCode = 1;
  }
}
