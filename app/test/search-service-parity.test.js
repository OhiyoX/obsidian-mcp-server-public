import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-service-parity-"));
process.env.VAULT_PATH = path.join(root, "vault");
process.env.DATA_PATH = path.join(root, "data");
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
await fs.mkdir(process.env.VAULT_PATH);
const { getWebCatalogRuntime, __resetWebCatalogRuntimesForTests } = await import("../src/app/web-catalog/runtime.js");
const { resolveSearchPage } = await import("../src/app/web-catalog/search-api.js");
const { hybridSearch } = await import("../src/search/hybrid-search.js");
const { parseObsidianQuery } = await import("../src/search/obsidian-query.js");

test.after(async () => {
  __resetWebCatalogRuntimesForTests();
  await fs.rm(root, { recursive: true, force: true });
});

async function searchService(input) {
  const module = await import("../src/search/search-service.js").catch(() => ({}));
  assert.equal(typeof module.createSearchService, "function", "the shared service must exist");
  return module.createSearchService(input);
}

function record(notePath, raw, vaultId) {
  return { path: notePath, name: path.posix.basename(notePath), basename: path.posix.basename(notePath, ".md"), raw, content: raw, vaultId, tags: [], aliases: [], frontmatter: {}, revision: `revision-${vaultId}`, stat: { modified: "2026-01-01T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" } };
}

test("MCP shared service preserves lexical scores, ordering, parsing and opt-in evidence", async () => {
  const records = [record("A.md", "ai other words", "one"), record("Z.md", "ai ai ai ai ai", "one")];
  let calls = 0;
  const service = await searchService({ vaultRuntime: { id: "one" }, index: { vaultId: "one", getVaultIndex: async () => ({ records, stats: { freshness: "clean", snapshotGeneration: 7 } }) }, retrieval: { vaultId: "one", recall: () => { calls++; throw new Error("must not recall"); } } });
  const options = { semantic: false, rank: "bm25f" };
  const expected = await hybridSearch(records, parseObsidianQuery("ai"), options);
  const actual = await service.search("ai", options);
  assert.deepEqual(actual.results, expected.results);
  assert.equal(actual.results[0].path, "Z.md");
  assert.equal(actual.parsed.source, "ai");
  assert.equal(calls, 0);
  const evidenced = await service.search("ai", { ...options, includeProvenance: true });
  assert.equal(evidenced.results[0].provenance.vaultId, "one");
  assert.equal(evidenced.results[0].provenance.revision, "revision-one");
});

test("service construction adds no scan, watcher, warmup or recall", async () => {
  const fail = () => assert.fail("construction must do no work");
  const service = await searchService({ vaultRuntime: { id: "one" }, index: { vaultId: "one", getVaultIndex: fail }, retrieval: { vaultId: "one", recall: fail, scheduleRetrievalRefresh: fail } });
  assert.equal(typeof service.search, "function");
  assert.equal(typeof service.recall, "function");
});

test("service keeps index-not-ready errors and deterministic retrieval fallback", async () => {
  const error = new Error("index not ready");
  const cold = await searchService({ vaultRuntime: { id: "one" }, index: { vaultId: "one", getVaultIndex: async () => { throw error; } }, retrieval: { vaultId: "one" } });
  await assert.rejects(cold.search("ai", { semantic: false }), (caught) => caught === error);
  const records = [record("A.md", "ai", "one")];
  const recall = async () => { throw new Error("embedding unavailable"); };
  const service = await searchService({ vaultRuntime: { id: "one" }, index: { vaultId: "one", getVaultIndex: async () => ({ records }) }, retrieval: { vaultId: "one", recall } });
  const expected = await hybridSearch(records, parseObsidianQuery("ai"), { semantic: true }, recall);
  const actual = await service.search("ai", { semantic: true });
  assert.deepEqual(actual.results, expected.results);
  assert.equal(actual.semanticError, expected.semanticError);
});

test("service isolates identical paths, revisions and scores by Vault", async () => {
  const a = record("Same.md", "ai", "a");
  const b = record("Same.md", "ai ai ai", "b");
  for (const [vaultId, own] of [["a", a], ["b", b]]) {
    const service = await searchService({ vaultRuntime: { id: vaultId }, index: { vaultId, getVaultIndex: async () => ({ records: [a, b] }) }, retrieval: { vaultId } });
    const result = await service.search("ai", { semantic: false });
    const expected = await hybridSearch([own], parseObsidianQuery("ai"), { semantic: false });
    assert.deepEqual(result.results, expected.results);
    assert.equal(result.results[0].revision, `revision-${vaultId}`);
  }
  await assert.rejects(searchService({ vaultRuntime: { id: "a" }, index: { vaultId: "b" }, retrieval: { vaultId: "a" } }), /Vault/);
});

test("Context uses the shared evidence DTO and snapshot-only recall", async () => {
  const source = await fs.readFile(new URL("../src/context-service.js", import.meta.url), "utf8");
  assert.ok(source.includes('from "./search/search-service.js"'), "Context evidence must use the service's DTO");
  assert.ok(source.includes("runtime.searchService.recall"), "Context recall must use the service");
  let calls = 0;
  const payload = { results: [{ path: "Same.md", score: 0.5, revision: "own", vaultId: "one" }], truncated: true, semanticUsed: false };
  const service = await searchService({ vaultRuntime: { id: "one" }, index: { vaultId: "one" }, retrieval: { vaultId: "one", recall: () => assert.fail("must not warm retrieval"), recallFromSnapshot: (query, options) => { calls++; assert.equal(query, "related"); assert.deepEqual(options, { semantic: false }); return payload; } } });
  assert.deepEqual(await service.recall("related", { semantic: false, snapshotOnly: true }), payload);
  assert.equal(calls, 1);
});

let sequence = 0;
async function fixture(raw) {
  const vault = { id: `fixture-${++sequence}`, root: path.join(root, `vault-${sequence}`) };
  await fs.mkdir(vault.root);
  await fs.writeFile(path.join(vault.root, "A.md"), raw);
  const runtime = getWebCatalogRuntime(vault);
  runtime.setCoverage(true, "test");
  await runtime.drain();
  const recall = async () => ({ results: [{ path: "A.md", score: 0.9, chunks: [{ text: raw }] }], semanticUsed: true, semanticError: null });
  const record = { path: "A.md", name: "A.md", basename: "A", raw, content: raw, tags: [], aliases: [], frontmatter: {}, revision: "test", stat: { modified: "2026-01-01", created: "2026-01-01" } };
  return {
    web: (q) => resolveSearchPage({ vault, query: { q, semantic: "true" }, getRuntime: getWebCatalogRuntime, recall }),
    mcp: (q) => hybridSearch([record], parseObsidianQuery(q), { semantic: true }, recall),
  };
}

test("Web rejects a semantic candidate without the quoted phrase, as MCP does", async () => {
  const { web, mcp } = await fixture("unrelated content without the requested literal");
  assert.deepEqual((await mcp('"exact phrase"')).results.map((item) => item.path), []);
  assert.deepEqual((await web('"exact phrase"')).items.map((item) => item.path), []);
});

test("Web and MCP still accept a semantic candidate containing the quoted phrase", async () => {
  const { web, mcp } = await fixture("contains exact phrase here");
  assert.deepEqual((await web('"exact phrase"')).items.map((item) => item.path), ["A.md"]);
  assert.deepEqual((await mcp('"exact phrase"')).results.map((item) => item.path), ["A.md"]);
});

test("Web and MCP still relax ordinary positive text for semantic candidates", async () => {
  const { web, mcp } = await fixture("unrelated literal");
  assert.deepEqual((await web("related concept")).items.map((item) => item.path), ["A.md"]);
  assert.deepEqual((await mcp("related concept")).results.map((item) => item.path), ["A.md"]);
});

test("Web semantic candidates still enforce path, file, tag, property and negation filters", async () => {
  const { web, mcp } = await fixture("forbidden content");
  for (const q of ["path:Other related", "file:Other related", "tag:missing related", "[missing] related", "related -forbidden"]) {
    assert.deepEqual((await web(q)).items.map((item) => item.path), [], q);
    assert.deepEqual((await mcp(q)).results.map((item) => item.path), [], q);
  }
});

test("Web and MCP service use one hard-constraint rule, not a second phrase rule", async () => {
  const web = await fs.readFile(new URL("../src/app/web-catalog/search-api.js", import.meta.url), "utf8");
  const service = await fs.readFile(new URL("../src/search/search-service.js", import.meta.url), "utf8");
  assert.ok(web.includes('from "../../search/search-service.js"'));
  assert.ok(!web.includes("evaluateObsidianQuery"), "Web must delegate query decisions");
  assert.match(service, /import \{ hardConstraintQuery \} from "\.\/fusion\.js"/);
  assert.match(service, /hardConstraintQuery\(parsed\)/);
});

test("existing-web strategy preserves input order, evidence and ordinary semantic relaxation", async () => {
  const records = [record("A.md", "ai other words", "one"), record("Z.md", "ai ai ai ai ai", "one")];
  const service = await searchService({ vaultRuntime: { id: "one" } });
  const results = await service.search("ai", { rank: "existing-web", records, includeProvenance: true });
  assert.deepEqual(results.results.map((item) => item.path), ["A.md", "Z.md"]);
  assert.equal(results.results[0].provenance.vaultId, "one");
  assert.equal(results.results[0].provenance.revision, "revision-one");
  assert.deepEqual((await service.search('"missing phrase"', { rank: "existing-web", records, semanticCandidate: true })).results, []);
  assert.equal((await service.search("related concept", { rank: "existing-web", records, semanticCandidate: true })).results.length, 2);
});

test("Web and MCP keep their own stable page boundaries for ai", async () => {
  const vault = { id: `pages-${++sequence}`, root: path.join(root, `pages-${sequence}`) };
  await fs.mkdir(vault.root);
  const records = [record("A.md", "ai other words", vault.id), record("Z.md", "ai ai ai ai ai", vault.id)];
  for (const item of records) await fs.writeFile(path.join(vault.root, item.path), item.raw);
  const runtime = getWebCatalogRuntime(vault);
  runtime.setCoverage(true, "test");
  await runtime.drain();
  const query = { q: "ai", semantic: "false", limit: "1" };
  const first = await resolveSearchPage({ vault, query, getRuntime: getWebCatalogRuntime });
  const repeated = await resolveSearchPage({ vault, query, getRuntime: getWebCatalogRuntime });
  assert.deepEqual(first, repeated);
  assert.equal(first.items[0].path, "A.md");
  assert.equal(first.items[0].score, 0);
  const next = await resolveSearchPage({ vault, query: { ...query, cursor: first.nextCursor }, getRuntime: getWebCatalogRuntime });
  assert.equal(next.items[0].path, "Z.md");
  const service = await searchService({ vaultRuntime: vault, index: { vaultId: vault.id, getVaultIndex: async () => ({ records }) } });
  const a = await service.search("ai", { rank: "bm25f", semantic: false });
  const b = await service.search("ai", { rank: "bm25f", semantic: false });
  assert.deepEqual(a.results.slice(0, 1), b.results.slice(0, 1));
  assert.deepEqual(a.results.slice(1, 2), b.results.slice(1, 2));
  assert.equal(a.results[0].path, "Z.md");
  assert.ok(a.results[0].score > 1 && a.results[0].score < 2);
  const published = await resolveSearchPage({ vault, query: { ...query, q: "published:true ai" }, getRuntime: getWebCatalogRuntime, publishService: { list: async () => [{ path: "Z.md" }] } });
  assert.deepEqual(published.items.map((item) => item.path), ["Z.md"], "Web still owns the published filter");
  await fs.rm(path.join(vault.root, "A.md"));
  const partial = await resolveSearchPage({ vault, query, getRuntime: getWebCatalogRuntime });
  assert.deepEqual(partial.items.map((item) => item.path), ["Z.md"]);
  assert.equal(partial.search.skipped, 1, "an unreadable candidate must not suppress the remaining page");
});

test("Web index-not-ready never starts reconciliation through the shared service", async () => {
  const vault = { id: "cold", root: process.env.VAULT_PATH };
  await assert.rejects(resolveSearchPage({ vault, query: { q: "ai" }, getRuntime: (_vault, options) => {
    assert.deepEqual(options, { startReconcile: false });
    return { store: { metaGet: () => null } };
  } }), (error) => error.status === 503 && error.code === "catalog-not-ready");
});
