import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Issue #666 — source provenance and index freshness.
//
// Part 1 pins the pure DTO: `freshness: "current"` may be claimed only when the
// evidence proves it. Part 2 pins the three adapters that emit it — the same DTO
// on `search_notes` hits, `recall` / `find_related` hits and `get_note_context`
// items — with the default ranking untouched.

const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-source-provenance-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

const { buildSourceProvenance } = await import("../src/search/source-provenance.js");

// ---------------------------------------------------------------------------
// Part 1 — the pure DTO
// ---------------------------------------------------------------------------

const VAULT_A = "vault-a";
const VAULT_B = "vault-b";
const NOTE = "Notes/Alpha.md";
const REVISION_A = `sha256:${"a".repeat(64)}`;
const REVISION_B = `sha256:${"b".repeat(64)}`;
const MODIFIED = "2026-11-01T10:00:00.000Z";
const LATER = "2026-11-02T10:00:00.000Z";
const DTO_FIELDS = ["vaultId", "path", "revision", "modifiedAt", "indexGeneration", "freshness", "reason"];

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

test("the DTO is the frozen field set and nothing else", () => {
  const bare = buildSourceProvenance({ vaultId: VAULT_A, path: NOTE });
  assert.deepEqual(Object.keys(bare), ["vaultId", "path", "freshness", "reason"]);
  assert.equal(bare.vaultId, VAULT_A);
  assert.equal(bare.path, NOTE);
  for (const field of Object.keys(bare)) assert.ok(DTO_FIELDS.includes(field), `unknown field ${field}`);

  const full = buildSourceProvenance({
    vaultId: VAULT_A,
    path: NOTE,
    sourceRevision: REVISION_A,
    sourceModifiedAt: MODIFIED,
    indexGeneration: 4,
    indexedRevision: REVISION_A,
    indexedModifiedAt: MODIFIED,
  });
  assert.deepEqual(Object.keys(full), ["vaultId", "path", "revision", "modifiedAt", "indexGeneration", "freshness"]);
  assert.equal(full.freshness, "current");
  assert.equal(full.revision, REVISION_A);
  assert.equal(full.modifiedAt, MODIFIED);
  assert.equal(full.indexGeneration, 4);
});

test("current needs a source revision, an index revision, their agreement and a current generation", () => {
  const proof = { vaultId: VAULT_A, path: NOTE, sourceRevision: REVISION_A, indexedRevision: REVISION_A, indexGeneration: 4 };
  assert.equal(buildSourceProvenance(proof).freshness, "current");
  assert.equal(buildSourceProvenance({ ...proof, sourceModifiedAt: MODIFIED }).freshness, "current");
});

test("a missing revision on either side is never current", () => {
  const noIndexCopy = buildSourceProvenance({ vaultId: VAULT_A, path: NOTE, sourceRevision: REVISION_A, indexGeneration: 4 });
  assert.equal(noIndexCopy.freshness, "lagging");
  assert.equal(noIndexCopy.reason, "not_indexed");
  assert.equal("revision" in noIndexCopy, false);

  const noSourceObservation = buildSourceProvenance({ vaultId: VAULT_A, path: NOTE, indexedRevision: REVISION_A, indexGeneration: 4 });
  assert.equal(noSourceObservation.freshness, "unknown");
  assert.equal(noSourceObservation.reason, "source_not_verified");

  const nothing = buildSourceProvenance({ vaultId: VAULT_A, path: NOTE });
  assert.equal(nothing.freshness, "unknown");
  assert.equal(nothing.reason, "index_evidence_unavailable");
});

test("a lagging index generation is lagging, never current", () => {
  for (const indexGeneration of [undefined, null]) {
    const dto = buildSourceProvenance({ vaultId: VAULT_A, path: NOTE, sourceRevision: REVISION_A, indexedRevision: REVISION_A, indexGeneration });
    assert.equal(dto.freshness, "lagging");
    assert.equal(dto.reason, "index_generation_stale");
    assert.equal("indexGeneration" in dto, false);
  }
});

test("source and index disagreeing on the bytes is lagging and echoes only the index revision", () => {
  const dto = buildSourceProvenance({ vaultId: VAULT_A, path: NOTE, sourceRevision: REVISION_A, indexedRevision: REVISION_B, indexGeneration: 4 });
  assert.equal(dto.freshness, "lagging");
  assert.equal(dto.reason, "index_content_stale");
  assert.equal(dto.revision, REVISION_B);
  assert.equal(JSON.stringify(dto).includes(REVISION_A), false, "the source-side value is evidence, not an output");
});

test("an mtime that went backwards is lagging", () => {
  const dto = buildSourceProvenance({
    vaultId: VAULT_A,
    path: NOTE,
    sourceRevision: REVISION_A,
    indexedRevision: REVISION_A,
    indexGeneration: 4,
    sourceModifiedAt: MODIFIED,
    indexedModifiedAt: LATER,
  });
  assert.equal(dto.freshness, "lagging");
  assert.equal(dto.reason, "source_mtime_regressed");
});

test("a date is emitted only when observed; today's date never stands in for one", () => {
  const today = new Date().toISOString().slice(0, 10);
  const cases = [
    { vaultId: VAULT_A, path: NOTE },
    { vaultId: VAULT_A, path: NOTE, indexedRevision: REVISION_A, indexGeneration: 4 },
    { vaultId: VAULT_A, path: NOTE, sourceRevision: REVISION_A, indexedRevision: REVISION_B, indexGeneration: 4 },
  ];
  for (const input of cases) {
    const dto = buildSourceProvenance(input);
    assert.equal("modifiedAt" in dto, false, `fabricated a date for ${JSON.stringify(input)}`);
    assert.equal(JSON.stringify(dto).includes(today), false);
    assert.equal("ageDays" in dto, false);
    assert.equal("stale" in dto, false);
  }
});

test("an untrusted clock is unknown, not current", () => {
  const dto = buildSourceProvenance({
    vaultId: VAULT_A,
    path: NOTE,
    sourceRevision: REVISION_A,
    indexedRevision: REVISION_A,
    indexGeneration: 4,
    sourceModifiedAt: "not-a-date",
  });
  assert.equal(dto.freshness, "unknown");
  assert.equal(dto.reason, "source_modified_at_invalid");
  assert.equal("modifiedAt" in dto, false);
});

test("the same path in two Vaults never shares provenance", () => {
  const a = buildSourceProvenance({
    vaultId: VAULT_A, path: NOTE, sourceRevision: REVISION_A, indexedRevision: REVISION_A, indexGeneration: 4, sourceModifiedAt: MODIFIED,
  });
  const b = buildSourceProvenance({
    vaultId: VAULT_B, path: NOTE, sourceRevision: REVISION_B, indexedRevision: REVISION_B, indexGeneration: 9, sourceModifiedAt: LATER,
  });
  assert.equal(a.vaultId, VAULT_A);
  assert.equal(b.vaultId, VAULT_B);
  assert.equal(a.revision, REVISION_A);
  assert.equal(b.revision, REVISION_B);
  assert.notDeepEqual(a, b);
  assert.equal(JSON.stringify(a).includes(REVISION_B), false);
  assert.equal(JSON.stringify(a).includes(LATER), false);

  // A sentinel carried over from the other Vault can never become proof.
  const mixed = buildSourceProvenance({ vaultId: VAULT_A, path: NOTE, sourceRevision: REVISION_B, indexedRevision: REVISION_A, indexGeneration: 4 });
  assert.notEqual(mixed.freshness, "current");
  assert.equal(JSON.stringify(mixed).includes(REVISION_B), false);

  // A path that belongs to another Vault's root is refused at the boundary.
  for (const foreign of ["/vault-b/Notes/Alpha.md", "../vault-b/Notes/Alpha.md", "Notes\\Alpha.md", "Notes//Alpha.md"]) {
    assert.throws(() => buildSourceProvenance({ vaultId: VAULT_A, path: foreign }), TypeError, foreign);
  }
});

test("malformed evidence is refused at the boundary", () => {
  const valid = { vaultId: VAULT_A, path: NOTE };
  for (const vaultId of [undefined, null, "", 7, {}]) {
    assert.throws(() => buildSourceProvenance({ ...valid, vaultId }), TypeError, String(vaultId));
  }
  for (const notePath of [undefined, null, "", " "]) {
    assert.throws(() => buildSourceProvenance({ ...valid, path: notePath }), TypeError, String(notePath));
  }
  for (const indexGeneration of [-1, 1.5, "4", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => buildSourceProvenance({ ...valid, indexGeneration }), TypeError, String(indexGeneration));
  }
  for (const key of ["sourceRevision", "indexedRevision"]) {
    for (const value of ["", 7, {}]) {
      assert.throws(() => buildSourceProvenance({ ...valid, [key]: value }), TypeError, `${key}=${String(value)}`);
    }
  }
});

test("the answer is deterministic and reads no clock", async () => {
  const input = { vaultId: VAULT_A, path: NOTE, sourceRevision: REVISION_A, indexedRevision: REVISION_A, indexGeneration: 4, sourceModifiedAt: MODIFIED };
  assert.deepEqual(buildSourceProvenance(input), buildSourceProvenance(input));
  const source = (await fs.readFile(new URL("../src/search/source-provenance.js", import.meta.url), "utf8"))
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/Date\.now\s*\(|new Date\(\s*\)/.test(source), false, "provenance must not read the clock");
  assert.equal(/ageDays|\bstale\b/.test(source), false, "no recency field and no invented staleness policy");
});

test("the DTO stays small: it rides on every search result", () => {
  const dto = buildSourceProvenance({
    vaultId: "primary", path: "Archive/Deep/Notes/Alpha-Target-Note.md", sourceRevision: REVISION_A, indexedRevision: REVISION_A, indexGeneration: 12, sourceModifiedAt: MODIFIED,
  });
  const size = bytes(dto);
  assert.ok(size <= 320, `per-result provenance is ${size} bytes`);
  const tenResults = Array.from({ length: 10 }, (_, index) => buildSourceProvenance({
    vaultId: "primary",
    path: `Archive/Deep/Notes/Alpha-Target-Note-${index}.md`,
    sourceRevision: REVISION_A,
    indexedRevision: REVISION_A,
    indexGeneration: 12,
    sourceModifiedAt: MODIFIED,
  }));
  assert.ok(bytes(tenResults) <= 3200, `10 results cost ${bytes(tenResults)} bytes`);
});

// ---------------------------------------------------------------------------
// Part 2 — the three adapters
// ---------------------------------------------------------------------------

const KEYWORD = "shared provenance keyword";
async function write(relative, content) {
  const abs = path.join(vault, relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}
async function revisionOf(relative) {
  return `sha256:${crypto.createHash("sha256").update(await fs.readFile(path.join(vault, relative))).digest("hex")}`;
}
async function modifiedAtOf(relative) {
  return (await fs.stat(path.join(vault, relative))).mtime.toISOString();
}

await write("Notes/Alpha.md", `---\ntitle: Alpha\ntags: [ctx]\n---\n# Alpha\n\n${KEYWORD} alpha\n\n[[Beta]]\n`);
await write("Notes/Beta.md", `---\ntitle: Beta\ntags: [ctx]\n---\n# Beta\n\n${KEYWORD} beta\n`);
await write("Notes/Backlink.md", `---\ntitle: Backlink\n---\n# Backlink\n\nSee [[Alpha]].\n`);

const { registerSearchTools } = await import("../src/tools/search.js");
const { registerIntelligenceTools } = await import("../src/tools/intelligence.js");
const { registerContextTools } = await import("../src/tools/context.js");
const { createMemoryGuidanceRegistrar } = await import("../src/memory-guidance.js");
const { syncRetrievalIndex } = await import("../src/retrieval.js");

await syncRetrievalIndex({ force: true, embeddings: false });

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function withTools(callback) {
  const server = new McpServer({ name: "search-source-provenance", version: "1" });
  registerSearchTools(server);
  registerIntelligenceTools(server);
  registerContextTools(createMemoryGuidanceRegistrar(server));
  const client = new Client({ name: "search-source-provenance-client", version: "1" });
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

const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent;
};

function assertDto(provenance) {
  for (const field of Object.keys(provenance)) assert.ok(DTO_FIELDS.includes(field), `unknown DTO field ${field}`);
  assert.equal(typeof provenance.vaultId, "string");
  assert.equal(typeof provenance.path, "string");
  assert.ok(["current", "lagging", "unknown"].includes(provenance.freshness));
  if (provenance.freshness !== "current") assert.equal(typeof provenance.reason, "string");
  if (provenance.freshness === "current") assert.equal("reason" in provenance, false);
}

test("search_notes hits carry the DTO, and a clean same-request index build makes them current", async () => {
  await withTools(async (client) => {
    const payload = await call(client, "search_notes", { query: `${KEYWORD} alpha`, includeProvenance: true });
    assert.ok(payload.results.length >= 1);
    // The exact pass answered: provenance adds no ranking and no silent semantic turn.
    assert.equal(payload.hybridUsed, false);
    assert.equal(payload.semanticUsed, false);
    assert.equal(payload.index.freshness, "clean");

    for (const hit of payload.results) {
      const provenance = hit.provenance;
      assertDto(provenance);
      assert.equal(provenance.path, hit.path);
      assert.equal(provenance.freshness, "current");
      assert.equal(provenance.revision, hit.revision);
      assert.equal(provenance.indexGeneration, payload.index.snapshotGeneration);
      assert.equal(provenance.revision, await revisionOf(hit.path));
      assert.equal(provenance.modifiedAt, await modifiedAtOf(hit.path));
    }
    // The bounded views stay byte-cheap: provenance is not in their whitelist.
    const brief = await call(client, "search_notes", { query: `${KEYWORD} alpha`, view: "brief" });
    assert.ok(brief.results.every((hit) => hit.provenance === undefined));
  });
});

test("get_note_context items carry the DTO; a note the cached index has not seen is lagging", async () => {
  await withTools(async (client) => {
    const built = await call(client, "search_notes", { query: `${KEYWORD} alpha`, includeProvenance: true });
    const cachedRevision = built.results.find((hit) => hit.path === NOTE).revision;

    // The source changes after the index snapshot: the same request must not claim `current`.
    await write(NOTE, `---\ntitle: Alpha\ntags: [ctx]\n---\n# Alpha\n\n${KEYWORD} alpha, edited body\n\n[[Beta]]\n`);
    const context = await call(client, "get_note_context", { path: "Notes/Alpha", includeProvenance: true });
    const target = context.items[0];
    assert.equal(target.kind, "target");
    assert.equal(target.revision, await revisionOf(NOTE));
    assert.notEqual(target.revision, cachedRevision);
    assertDto(target.provenance);
    assert.equal(target.provenance.freshness, "lagging");
    assert.equal(target.provenance.reason, "index_content_stale");
    assert.equal(target.provenance.revision, cachedRevision);
    assert.equal(target.provenance.modifiedAt, await modifiedAtOf(NOTE));

    // A backlink is index-only evidence: it never claims to have verified the file.
    const backlink = context.items.find((item) => item.kind === "backlink");
    assert.ok(backlink);
    assertDto(backlink.provenance);
    assert.equal(backlink.provenance.freshness, "unknown");
    assert.equal(backlink.provenance.reason, "source_not_verified");
  });
});

test("recall and find_related carry the same DTO, with a reason instead of a claim", async () => {
  await withTools(async (client) => {
    const recalled = await call(client, "recall", { query: KEYWORD, semantic: false, includeProvenance: true });
    assert.ok(recalled.results.length >= 1);
    for (const hit of recalled.results) {
      assertDto(hit.provenance);
      assert.equal(hit.provenance.path, hit.path);
      assert.equal(hit.provenance.freshness, "unknown");
      assert.equal(hit.provenance.reason, "index_evidence_unavailable");
      assert.equal("modifiedAt" in hit.provenance, false);
    }

    const related = await call(client, "find_related", { path: "Notes/Beta", semantic: false, includeProvenance: true });
    assert.ok(related.results.length >= 1);
    for (const hit of related.results) {
      assertDto(hit.provenance);
      assert.equal(hit.provenance.path, hit.path);
      assert.equal(hit.provenance.freshness, "unknown");
    }
  });
});

test("provenance is opt-in: the default answer carries none, and asking costs about 225 bytes a hit", async () => {
  await withTools(async (client) => {
    const plain = await call(client, "search_notes", { query: `${KEYWORD} alpha` });
    assert.equal(plain.results.every((hit) => !("provenance" in hit)), true, "a default search must not pay for evidence nobody asked for");
    const withEvidence = await call(client, "search_notes", { query: `${KEYWORD} alpha`, includeProvenance: true });
    assert.equal(withEvidence.results.every((hit) => hit.provenance?.freshness), true);
    const cost = (JSON.stringify(withEvidence)).length - (JSON.stringify(plain)).length;
    assert.ok(cost > 0, "asking must be the more expensive path");

    const plainContext = await call(client, "get_note_context", { path: "Notes/Alpha" });
    assert.equal(plainContext.items.every((item) => !("provenance" in item)), true);
    const plainRecall = await call(client, "recall", { query: KEYWORD, semantic: false });
    assert.equal(plainRecall.results.every((hit) => !("provenance" in hit)), true);
  });
});
