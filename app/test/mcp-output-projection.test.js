// O3 — opt-in bounded search result views.
//
// The plan fixes one interface: `view?: "full" | "standard" | "brief"` on
// `search_notes`, `recall` and `find_related`, default `"full"`, and one pure
// function `projectSearchResult(action, result, view)` that the three tools call
// at their output adapter. Nothing else may change: no scoring, no paging, no
// filtering, no second search tool.
//
// What each view must keep, per hit:
//   full     — today's payload, byte for byte (frozen literal below)
//   standard — the envelope plus every per-hit field except the excerpt text
//   brief    — the envelope (without `diagnostics`) plus, per hit, only the
//              locator (path, and vaultId when the payload carries one) and the
//              revision when the payload has one
// Every view keeps the truncation / continuation state and the semantic
// degradation status, because a caller that cannot see those cannot tell a
// complete answer from a degraded one.
//
// Run:
//   cd app
//   node --test --test-concurrency=1 test/mcp-output-projection.test.js

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// Pure module: imports nothing, so it is safe to load before the Vault fixture.
import { projectSearchResult } from "../src/output-projection.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-output-projection-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
await fs.mkdir(data, { recursive: true });
await fs.writeFile(path.join(vault, "Notes", "Alpha.md"), "---\ntags: [alpha]\n---\n# Alpha\n\nalpha keyword body\n\nalpha again\n", "utf8");
await fs.writeFile(path.join(vault, "Notes", "Beta.md"), "# Beta\n\nalpha keyword in beta\n", "utf8");

const [
  { registerSearchTools },
  { registerIntelligenceTools },
  { syncRetrievalIndex, drainRetrievalIndex },
  { refusalForError },
] = await Promise.all([
  import("../src/tools/search.js"),
  import("../src/tools/intelligence.js"),
  import("../src/retrieval.js"),
  import("../src/search-runtimes.js"),
]);

await syncRetrievalIndex({ force: true });
after(async () => {
  await drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Frozen `search_notes` payload: the input and today's exact output, both
// written out by hand. Two literals cannot drift together, so a change to the
// default answer has to fail here.
// ---------------------------------------------------------------------------

const STAT = { size: 100, modified: "2026-01-02T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" };

function searchPayload() {
  return {
    results: [
      { path: "Notes/Alpha.md", matchCount: 2, tags: ["alpha"], aliases: ["Alpha"], snippets: ["alpha keyword body", "alpha again"], stat: { ...STAT }, revision: "sha256:a", score: 1.1, reasons: ["exact", "query:alpha"] },
      { path: "Notes/Beta.md", matchCount: 1, tags: [], aliases: [], snippets: ["alpha keyword in beta"], stat: { ...STAT }, revision: "sha256:b", score: 1.05, reasons: ["exact"] },
      { path: "Notes/Gamma.md", matchCount: 1, tags: ["gamma"], aliases: [], snippets: ["alpha, gamma"], stat: { ...STAT }, revision: "sha256:c", score: 1, reasons: ["exact"] },
    ],
    totalScanned: 4,
    totalMatched: 3,
    truncated: true,
    semanticRequested: true,
    semanticUsed: false,
    semanticError: "Embedding provider is not configured; lexical hybrid ranking was used",
    hybridUsed: false,
    semanticMode: "auto",
    fallbackUsed: false,
    index: { notes: 4, version: 3 },
    diagnostics: { candidateRecords: 4, exactMatched: 3, groupCount: 1, implicitAnd: true, truncated: false, groups: [{ groupIndex: 0, matchedRecords: 3, clauses: [{ raw: "alpha", type: "text", negated: false, matchedRecords: 3 }] }] },
  };
}

// Today's answer, frozen. `view: "full"` must return exactly this.
const SEARCH_FULL = {
  results: [
    { path: "Notes/Alpha.md", matchCount: 2, tags: ["alpha"], aliases: ["Alpha"], snippets: ["alpha keyword body", "alpha again"], stat: { size: 100, modified: "2026-01-02T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" }, revision: "sha256:a", score: 1.1, reasons: ["exact", "query:alpha"] },
    { path: "Notes/Beta.md", matchCount: 1, tags: [], aliases: [], snippets: ["alpha keyword in beta"], stat: { size: 100, modified: "2026-01-02T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" }, revision: "sha256:b", score: 1.05, reasons: ["exact"] },
    { path: "Notes/Gamma.md", matchCount: 1, tags: ["gamma"], aliases: [], snippets: ["alpha, gamma"], stat: { size: 100, modified: "2026-01-02T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z" }, revision: "sha256:c", score: 1, reasons: ["exact"] },
  ],
  totalScanned: 4,
  totalMatched: 3,
  truncated: true,
  semanticRequested: true,
  semanticUsed: false,
  semanticError: "Embedding provider is not configured; lexical hybrid ranking was used",
  hybridUsed: false,
  semanticMode: "auto",
  fallbackUsed: false,
  index: { notes: 4, version: 3 },
  diagnostics: { candidateRecords: 4, exactMatched: 3, groupCount: 1, implicitAnd: true, truncated: false, groups: [{ groupIndex: 0, matchedRecords: 3, clauses: [{ raw: "alpha", type: "text", negated: false, matchedRecords: 3 }] }] },
};

const ENVELOPE_SCALARS = {
  totalScanned: 4,
  totalMatched: 3,
  truncated: true,
  semanticRequested: true,
  semanticUsed: false,
  semanticError: "Embedding provider is not configured; lexical hybrid ranking was used",
  hybridUsed: false,
  semanticMode: "auto",
  fallbackUsed: false,
  index: { notes: 4, version: 3 },
};

const paths = (results) => results.map((hit) => hit.path);

// ---------------------------------------------------------------------------
// The three views.
// ---------------------------------------------------------------------------

test("views keep ordering and hit count; full is today's payload exactly", () => {
  const full = projectSearchResult("search_notes", searchPayload(), "full");
  const standard = projectSearchResult("search_notes", searchPayload(), "standard");
  const brief = projectSearchResult("search_notes", searchPayload(), "brief");
  for (const view of [standard, brief]) {
    assert.deepEqual(paths(view.results), paths(SEARCH_FULL.results));
    assert.equal(view.results.length, SEARCH_FULL.results.length);
  }
  assert.deepEqual(full, SEARCH_FULL);
  // No `view` argument at all is the documented default and must not differ.
  assert.deepEqual(projectSearchResult("search_notes", searchPayload()), SEARCH_FULL);
  assert.equal(JSON.stringify(full), JSON.stringify(SEARCH_FULL));
});

test("standard drops excerpt text and keeps every other per-hit field", () => {
  const standard = projectSearchResult("search_notes", searchPayload(), "standard");
  assert.deepEqual(standard, {
    ...ENVELOPE_SCALARS,
    results: [
      { path: "Notes/Alpha.md", matchCount: 2, tags: ["alpha"], aliases: ["Alpha"], stat: STAT, revision: "sha256:a", score: 1.1, reasons: ["exact", "query:alpha"] },
      { path: "Notes/Beta.md", matchCount: 1, tags: [], aliases: [], stat: STAT, revision: "sha256:b", score: 1.05, reasons: ["exact"] },
      { path: "Notes/Gamma.md", matchCount: 1, tags: ["gamma"], aliases: [], stat: STAT, revision: "sha256:c", score: 1, reasons: ["exact"] },
    ],
    diagnostics: SEARCH_FULL.diagnostics,
  });
});

test("brief keeps locator, revision, truncation and degradation state only", () => {
  const brief = projectSearchResult("search_notes", searchPayload(), "brief");
  assert.deepEqual(brief, {
    ...ENVELOPE_SCALARS,
    results: [
      { path: "Notes/Alpha.md", revision: "sha256:a" },
      { path: "Notes/Beta.md", revision: "sha256:b" },
      { path: "Notes/Gamma.md", revision: "sha256:c" },
    ],
  });
  for (const hit of brief.results) {
    assert.equal("snippets" in hit, false);
    assert.equal("stat" in hit, false);
  }
  assert.equal("diagnostics" in brief, false);
});

test("brief carries the vault id the payload supplies, at both levels", () => {
  const payload = { ...searchPayload(), vaultId: "vault-a", results: [{ path: "Notes/Alpha.md", revision: "sha256:a", vaultId: "vault-a", snippets: ["excerpt"] }] };
  assert.deepEqual(projectSearchResult("recall", payload, "brief").results, [{ path: "Notes/Alpha.md", revision: "sha256:a", vaultId: "vault-a" }]);
  assert.equal(projectSearchResult("recall", payload, "brief").vaultId, "vault-a");
});

test("a hit without a revision simply has no revision key", () => {
  const payload = { ...searchPayload(), results: [{ path: "Notes/Alpha.md", snippets: ["excerpt"] }] };
  assert.deepEqual(projectSearchResult("search_notes", payload, "brief").results, [{ path: "Notes/Alpha.md" }]);
});

test("empty results keep the envelope in all three views", () => {
  const empty = { results: [], totalScanned: 2, totalMatched: 0, truncated: false, semanticRequested: false, semanticUsed: false, semanticError: null, hybridUsed: false, semanticMode: "off", fallbackUsed: false, index: { notes: 2, version: 1 } };
  for (const view of ["full", "standard", "brief"]) {
    const projected = projectSearchResult("search_notes", { ...empty }, view);
    assert.deepEqual(projected, empty, view);
  }
});

test("a permission refusal is never projected", () => {
  const refusal = refusalForError(Object.assign(new Error("no runtime"), { code: "vault_retrieval_unavailable", vaultId: "vault-b" }));
  for (const view of ["full", "standard", "brief"]) {
    const projected = projectSearchResult("search_notes", refusal, view);
    assert.equal(projected, refusal, view);
    assert.equal(projected.isError, true);
    assert.deepEqual(projected.structuredContent, { code: "vault_retrieval_unavailable", vaultId: "vault-b" });
  }
});

test("a regex query keeps its hits and loses only the excerpts", () => {
  const regexPayload = {
    results: [{ path: "Notes/Alpha.md", matchCount: 2, tags: ["alpha"], aliases: [], snippets: ["alpha keyword body", "alpha again"], stat: { ...STAT }, revision: "sha256:a" }],
    totalScanned: 2,
    totalMatched: 1,
    truncated: false,
    semanticRequested: false,
    semanticUsed: false,
    semanticError: null,
    hybridUsed: false,
    semanticMode: "auto",
    fallbackUsed: false,
    index: { notes: 2, version: 1 },
  };
  assert.deepEqual(projectSearchResult("search_notes", regexPayload, "brief").results, [{ path: "Notes/Alpha.md", revision: "sha256:a" }]);
  const standard = projectSearchResult("search_notes", regexPayload, "standard");
  assert.deepEqual(standard.results, [{ path: "Notes/Alpha.md", matchCount: 2, tags: ["alpha"], aliases: [], stat: STAT, revision: "sha256:a" }]);
  assert.equal(standard.totalMatched, 1);
});

test("recall keeps chunk identity and drops chunk text", () => {
  const payload = {
    query: "alpha keyword",
    results: [
      { path: "Notes/Alpha.md", metadata: { title: "Alpha" }, score: 0.9, reasons: ["lexical:0.900"], chunks: [{ id: "chunk-1", heading: "Alpha", text: "alpha keyword body", score: 0.9, reasons: ["lexical:0.900"] }] },
    ],
    totalCandidates: 2,
    semanticUsed: false,
    semanticError: null,
    index: { notes: 2, version: 1 },
  };
  const standard = projectSearchResult("recall", payload, "standard");
  assert.deepEqual(standard.results, [{ path: "Notes/Alpha.md", metadata: { title: "Alpha" }, score: 0.9, reasons: ["lexical:0.900"], chunks: [{ id: "chunk-1", heading: "Alpha", score: 0.9, reasons: ["lexical:0.900"] }] }]);
  assert.deepEqual(projectSearchResult("recall", payload, "brief").results, [{ path: "Notes/Alpha.md" }]);
});

test("a semantic-unavailable recall keeps its degradation status in brief", () => {
  const payload = { query: "alpha", results: [], totalCandidates: 0, semanticUsed: false, semanticError: null, unavailable: true, available: false, reason: "retrieval-disabled", index: { available: false, notes: 0, version: 0 } };
  assert.deepEqual(projectSearchResult("recall", payload, "brief"), payload);
  assert.equal(projectSearchResult("recall", payload, "standard").reason, "retrieval-disabled");
});

test("find_related brief keeps the locator and its degradation status", () => {
  const payload = {
    path: "Notes/Alpha.md",
    results: [{ path: "Notes/Beta.md", metadata: { title: "Beta" }, score: 0.7, reasons: ["lexical:0.700"], chunks: [{ id: "c", heading: "Beta", text: "alpha keyword in beta", score: 0.7, reasons: [] }], directlyLinked: true }],
    semanticUsed: false,
    semanticError: "Embedding provider is not configured",
  };
  assert.deepEqual(projectSearchResult("find_related", payload, "brief"), { path: "Notes/Alpha.md", semanticUsed: false, semanticError: "Embedding provider is not configured", results: [{ path: "Notes/Beta.md" }] });
  assert.equal(projectSearchResult("find_related", payload, "standard").results[0].directlyLinked, true);
});

test("an unknown view is rejected, never treated as full", () => {
  for (const view of ["tiny", "FULL", "", null, 0]) {
    assert.throws(() => projectSearchResult("search_notes", searchPayload(), view), /unknown view/, String(view));
  }
});

// ---------------------------------------------------------------------------
// The tools: default output unchanged on the wire, `view` actually plumbed.
// ---------------------------------------------------------------------------

async function withTools(callback) {
  const server = new McpServer({ name: "mcp-output-projection", version: "1" });
  registerSearchTools(server);
  registerIntelligenceTools(server);
  const client = new Client({ name: "mcp-output-projection-client", version: "1" });
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

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return result;
}

// The live `index` block carries per-call timings, so an inter-call comparison
// drops it; every other field must be identical.
function withoutIndex(payload) {
  const copy = structuredClone(payload);
  delete copy.index;
  return copy;
}

test("search_notes: omitted view is byte-identical to view full, brief keeps the locator", async () => {
  await withTools(async (client) => {
    const omitted = await call(client, "search_notes", { query: "alpha keyword", semantic: false });
    const full = await call(client, "search_notes", { query: "alpha keyword", semantic: false, view: "full" });
    assert.equal(omitted.isError, undefined, JSON.stringify(omitted.content));
    // The default is the plain pretty-JSON answer of O2, field for field.
    assert.equal(omitted.content[0].text, JSON.stringify(omitted.structuredContent, null, 2));
    assert.deepEqual(withoutIndex(omitted.structuredContent), withoutIndex(full.structuredContent));
    assert.ok(omitted.structuredContent.results.every((hit) => Array.isArray(hit.snippets)));

    const brief = await call(client, "search_notes", { query: "alpha keyword", semantic: false, view: "brief" });
    assert.equal(brief.isError, undefined, JSON.stringify(brief.content));
    assert.deepEqual(paths(brief.structuredContent.results), paths(full.structuredContent.results));
    assert.equal(brief.structuredContent.results.length, full.structuredContent.results.length);
    assert.equal(brief.structuredContent.totalMatched, full.structuredContent.totalMatched);
    assert.equal(brief.structuredContent.truncated, full.structuredContent.truncated);
    for (const hit of brief.structuredContent.results) {
      assert.deepEqual(Object.keys(hit).filter((key) => key !== "vaultId"), ["path", "revision"]);
    }
    assert.ok(brief.content[0].text.length < full.content[0].text.length);
  });
});

test("recall and find_related accept the view option", async () => {
  await withTools(async (client) => {
    const tools = (await client.listTools()).tools;
    for (const name of ["search_notes", "recall", "find_related"]) {
      const view = tools.find((tool) => tool.name === name).inputSchema.properties.view;
      assert.deepEqual(view.enum, ["full", "standard", "brief"], name);
    }
    const recallFull = await call(client, "recall", { query: "alpha keyword", semantic: false });
    const recallBrief = await call(client, "recall", { query: "alpha keyword", semantic: false, view: "brief" });
    assert.equal(recallFull.isError, undefined, JSON.stringify(recallFull.content));
    assert.equal(recallBrief.isError, undefined, JSON.stringify(recallBrief.content));
    assert.deepEqual(paths(recallBrief.structuredContent.results), paths(recallFull.structuredContent.results));
    assert.ok(recallBrief.structuredContent.results.every((hit) => hit.chunks === undefined));

    const relatedFull = await call(client, "find_related", { path: "Notes/Alpha.md", semantic: false });
    const relatedBrief = await call(client, "find_related", { path: "Notes/Alpha.md", semantic: false, view: "brief" });
    assert.equal(relatedFull.isError, undefined, JSON.stringify(relatedFull.content));
    assert.equal(relatedBrief.isError, undefined, JSON.stringify(relatedBrief.content));
    assert.deepEqual(paths(relatedBrief.structuredContent.results), paths(relatedFull.structuredContent.results));
    assert.ok(relatedBrief.structuredContent.results.every((hit) => hit.chunks === undefined));
  });
});

test("an unknown view is refused by the tool, not answered as full", async () => {
  await withTools(async (client) => {
    for (const name of ["search_notes", "recall", "find_related"]) {
      const args = name === "search_notes" ? { query: "alpha", semantic: false, view: "tiny" } : name === "recall" ? { query: "alpha", semantic: false, view: "tiny" } : { path: "Notes/Alpha.md", view: "tiny" };
      const result = await call(client, name, args);
      assert.equal(result.isError, true, name);
    }
  });
});
