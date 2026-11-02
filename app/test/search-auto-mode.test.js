import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Issue #229 Wave A / A1 — module-level contract for the semantic tri-state and
// the exact-first auto fallback in src/search/hybrid-search.js. The MCP tool
// wiring (the `semantic` input schema) is Wave B and is intentionally not
// exercised here.
//
// `state` in src/retrieval.js is a process-global that is set on first
// cold-load and never reset. Tests are therefore ordered so the no-retrieval
// evidence runs before anything loads or builds the retrieval index.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-search-auto-mode-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

const RETRIEVAL_INDEX_PATH = process.env.RETRIEVAL_INDEX_PATH;

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(data, { recursive: true });

const [
  { hybridSearch },
  { parseObsidianQuery },
  { drainRetrievalIndex, retrievalIndexStatusSnapshot, syncRetrievalIndex },
  { getVaultIndex },
] = await Promise.all([
  import("../src/search/hybrid-search.js"),
  import("../src/search/obsidian-query.js"),
  import("../src/retrieval.js"),
  import("../src/vault-index.js"),
]);

after(async () => {
  // The retrieval index owns a background queue and a debounced refresh timer;
  // drain it before removing the scratch root so cleanup cannot race a write.
  await drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeNote(relativePath, content) {
  const absolute = path.join(vault, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

// Synthetic vault (never real user content): exact hits, a CJK variant fixture,
// and multi-term notes for fallback and hard-filter checks.
await writeNote("Notes/ExactOne.md", "# Exact One\n\nautoevidencetoken first\n");
await writeNote("Archive/ExactTwo.md", "# Exact Two\n\nautoevidencetoken second\n");
await writeNote("Notes/Merging.md", "# 合并授权\n\n禁止自动合并 PR，必须先获得用户确认。\n");
await writeNote("Notes/AlphaOnly.md", "# Alpha Only\n\nalpha only\n");
await writeNote("Notes/BetaOnly.md", "# Beta Only\n\nbeta only\n");
await writeNote("Notes/AlphaBeta.md", "---\ntags: [project/search]\n---\n# Alpha Beta\n\nalpha beta\n");

// In-memory records for module-level cases that must not depend on the vault
// retrieval index (e.g. the retrieval-unavailable degradation test).
function record(notePath, content, tags = []) {
  return {
    path: notePath,
    name: path.posix.basename(notePath),
    basename: path.posix.basename(notePath, ".md"),
    tags,
    aliases: [],
    frontmatter: {},
    raw: content,
    content,
    stat: { size: content.length, modified: "2026-01-01T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" },
    revision: "sha256:auto-mode-fixture",
  };
}

async function indexFileExists() {
  try {
    await fs.access(RETRIEVAL_INDEX_PATH);
    return true;
  } catch {
    return false;
  }
}

test("evidence A: auto exact-positive never touches retrieval", async () => {
  // First retrieval-sensitive assertion in the process: the module has never
  // cold-loaded and the index JSON has never been written.
  assert.equal(retrievalIndexStatusSnapshot(), null);
  assert.equal(await indexFileExists(), false);

  const index = await getVaultIndex({ force: true });
  const result = await hybridSearch(index.records, parseObsidianQuery("autoevidencetoken"), {});

  assert.equal(result.semanticMode, "auto");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.exactMatched, 2);
  assert.equal(result.hybridUsed, false);
  assert.equal(result.semanticUsed, false);
  assert.equal(result.semanticError, null);
  assert.deepEqual(result.results.map((item) => item.path).sort(), ["Archive/ExactTwo.md", "Notes/ExactOne.md"]);

  // No recall => no cold-load (snapshot stays null) and no index write. A
  // background refresh can only be enqueued by recall, which augments nothing
  // here; this single snapshot+file pair covers no-recall / no-cold-load /
  // no-refresh for the exact-positive auto path.
  assert.equal(retrievalIndexStatusSnapshot(), null);
  assert.equal(await indexFileExists(), false);
});

test("auto with zero exact and no positive text does not fall back or fake a semantic request", async () => {
  const index = await getVaultIndex({ force: true });
  for (const query of ["tag:missing", "path:no-such-dir"]) {
    const result = await hybridSearch(index.records, parseObsidianQuery(query), {});
    assert.equal(result.semanticMode, "auto", query);
    assert.equal(result.fallbackUsed, false, query);
    assert.equal(result.exactMatched, 0, query);
    assert.equal(result.hybridUsed, false, query);
    assert.equal(result.semanticUsed, false, query);
    assert.equal(result.semanticError, null, `${query} must not pretend semantic was requested`);
    assert.deepEqual(result.results, [], query);
  }
  assert.equal(retrievalIndexStatusSnapshot(), null);
  assert.equal(await indexFileExists(), false);
});

test("retrieval-unavailable degradation: no crash, truthful fields, exact results kept", async () => {
  // This is the first retrieval-touching test. The retrieval index does not
  // exist yet, so `recall` cold-loads an empty state. `recall` snapshots that
  // state before any background refresh can publish an index, so the immediate
  // result is deterministic.
  assert.equal(retrievalIndexStatusSnapshot(), null);

  // auto + exact=0 + positive text: the fallback path is entered and the
  // embedding-disabled lexical degradation is reported, without crashing.
  const auto = await hybridSearch([record("Notes/AlphaOnly.md", "# Alpha Only\n\nalpha only")], parseObsidianQuery("zzunavailablesemanticzz"), {});
  assert.equal(auto.semanticMode, "auto");
  assert.equal(auto.fallbackUsed, true);
  assert.equal(auto.exactMatched, 0);
  assert.equal(auto.hybridUsed, true);
  assert.equal(auto.semanticUsed, false);
  assert.match(auto.semanticError || "", /Embedding provider is not configured; lexical hybrid ranking was used/);
  assert.deepEqual(auto.results, []);

  // semantic=true + exact>0: forced hybrid runs, but a recall with no matching
  // candidates must not drop the exact result.
  const on = await hybridSearch([record("Special.md", "# Special\n\nzzexactonlytoken")], parseObsidianQuery("zzexactonlytoken"), { semantic: true });
  assert.equal(on.semanticMode, "on");
  assert.equal(on.fallbackUsed, false);
  assert.equal(on.exactMatched, 1);
  assert.equal(on.hybridUsed, true);
  assert.equal(on.semanticUsed, false);
  assert.ok(on.semanticError, "a degraded hybrid must report the degradation, not hide it");
  assert.deepEqual(on.results.map((item) => item.path), ["Special.md"]);
});

test("setup: build a working retrieval index for the fallback-success cases", async () => {
  await drainRetrievalIndex();
  const status = await syncRetrievalIndex({ force: true });
  assert.ok(status.notes >= 5, `expected the synthetic vault to be indexed, got ${status.notes}`);
  assert.ok(retrievalIndexStatusSnapshot(), "retrieval must be loaded for the following fallback tests");
});

test("semantic tri-state return fields are explicit for off/on/auto", async () => {
  const index = await getVaultIndex({ force: true });
  const parsed = parseObsidianQuery("autoevidencetoken");

  const off = await hybridSearch(index.records, parsed, { semantic: false });
  assert.equal(off.semanticMode, "off");
  assert.equal(off.fallbackUsed, false);
  assert.equal(off.exactMatched, 2);
  assert.equal(off.hybridUsed, false);
  assert.equal(off.semanticUsed, false);
  assert.equal(off.semanticError, null);

  const auto = await hybridSearch(index.records, parsed, {});
  assert.equal(auto.semanticMode, "auto");
  assert.equal(auto.fallbackUsed, false);
  assert.equal(auto.exactMatched, 2);
  assert.equal(auto.hybridUsed, false);
  assert.equal(auto.semanticUsed, false);
  assert.equal(auto.semanticError, null);

  const on = await hybridSearch(index.records, parsed, { semantic: true });
  assert.equal(on.semanticMode, "on");
  assert.equal(on.fallbackUsed, false);
  assert.equal(on.exactMatched, 2);
  assert.equal(on.hybridUsed, true);
  assert.equal(on.semanticUsed, false);
  assert.match(on.semanticError || "", /Embedding provider is not configured; lexical hybrid ranking was used/);

  // Omitted / null / other values are all auto — the only tri-state truth source.
  for (const semantic of [undefined, null, "yes"]) {
    const result = await hybridSearch(index.records, parsed, { semantic });
    assert.equal(result.semanticMode, "auto", String(semantic));
    assert.equal(result.fallbackUsed, false, String(semantic));
  }
});

test("auto exact-positive results are identical to semantic=off", async () => {
  const index = await getVaultIndex({ force: true });
  const parsed = parseObsidianQuery("alpha");
  const off = await hybridSearch(index.records, parsed, { semantic: false });
  const auto = await hybridSearch(index.records, parsed, {});
  assert.ok(off.results.length >= 2, `expected multiple exact alpha hits, got ${off.results.length}`);
  // Paths, order, score, reasons, snippets, stat and revision must all match.
  assert.deepEqual(auto.results, off.results);
  assert.equal(auto.exactMatched, off.exactMatched);
});

test("semantic=true without positive text keeps the frozen error text", async () => {
  const index = await getVaultIndex({ force: true });
  const structural = await hybridSearch(index.records, parseObsidianQuery("tag:missing"), { semantic: true });
  assert.equal(structural.semanticMode, "on");
  assert.equal(structural.fallbackUsed, false);
  assert.equal(structural.exactMatched, 0);
  assert.equal(structural.hybridUsed, false);
  assert.equal(structural.semanticUsed, false);
  assert.equal(structural.semanticError, "Semantic search requires a positive text term");
  assert.deepEqual(structural.results, []);
});

test("auto fallback reaches lexical retrieval for CJK and multi-term queries", async () => {
  const index = await getVaultIndex({ force: true });

  const cjk = await hybridSearch(index.records, parseObsidianQuery("不自动合并"), {});
  assert.equal(cjk.semanticMode, "auto");
  assert.equal(cjk.exactMatched, 0);
  assert.equal(cjk.fallbackUsed, true);
  assert.equal(cjk.hybridUsed, true);
  assert.equal(cjk.semanticUsed, false);
  assert.match(cjk.semanticError || "", /Embedding provider is not configured; lexical hybrid ranking was used/);
  assert.ok(cjk.results.some((item) => item.path === "Notes/Merging.md"), "CJK variant must be recalled lexically");

  const multi = await hybridSearch(index.records, parseObsidianQuery("alpha gamma"), {});
  assert.equal(multi.exactMatched, 0);
  assert.equal(multi.fallbackUsed, true);
  assert.ok(multi.results.length > 0, "a zero-exact multi-term query must be able to fall back");
  assert.ok(multi.results.every((item) => item.reasons.every((reason) => !reason.startsWith("query:"))), "retrieval candidates must not carry exact clause reasons");
});

test("auto fallback candidate revalidation keeps hard filters mandatory", async () => {
  const index = await getVaultIndex({ force: true });

  const tagged = await hybridSearch(index.records, parseObsidianQuery("tag:project/search alpha gamma"), {});
  assert.equal(tagged.exactMatched, 0);
  assert.equal(tagged.fallbackUsed, true);
  assert.deepEqual(tagged.results.map((item) => item.path), ["Notes/AlphaBeta.md"]);
  assert.ok(tagged.results.every((item) => item.tags.includes("project/search")));

  const missingTag = await hybridSearch(index.records, parseObsidianQuery("tag:missing alpha gamma"), {});
  assert.equal(missingTag.exactMatched, 0);
  assert.equal(missingTag.fallbackUsed, true);
  assert.deepEqual(missingTag.results, [], "fallback must not resurrect a record that fails a hard filter");
});
