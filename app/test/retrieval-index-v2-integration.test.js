// M2/M3 — v2 index through the public retrieval surface (plan 02 Task 4).
//
// The runtime must look unchanged from outside: same recall payloads, same status
// fields, same semantic tri-state, same refusal to work without a migration.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRetrievalRuntime } from "../src/vault-runtime/retrieval-runtime.js";

const SEMANTIC = Object.freeze({ enabled: true, provider: "probe", baseUrl: null, model: "probe:model:2", timeoutMs: 1000, identity: "probe:model:2" });

function record(notePath, revision, content, title) {
  return {
    path: notePath,
    basename: path.basename(notePath),
    revision,
    content,
    frontmatter: { title },
    tags: [],
    aliases: [],
    stat: { mtimeMs: 1, created: "2026-11-22T00:00:00.000Z", modified: "2026-11-22T00:00:00.000Z" },
  };
}

function runtimeFor(indexPath, records, { embeddings = true } = {}) {
  return createRetrievalRuntime({
    vaultRuntime: { id: "vault-v2", paths: { retrievalIndex: indexPath } },
    embeddingProvider: embeddings ? {
      semanticConfiguration: () => SEMANTIC,
      embedTexts: async (texts) => (Array.isArray(texts) ? texts : [texts]).map((text) => (text.includes("部署") ? [1, 0] : [0, 1])),
    } : null,
    deps: { getVaultIndex: async () => ({ records, stats: { files: records.length } }) },
  });
}

async function tempIndex(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-v2-int-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, indexPath: path.join(root, "index", "retrieval-index.json") };
}

test("a v2 generation serves recall, status and snapshot with the legacy payload shape", async (t) => {
  const { indexPath } = await tempIndex(t);
  const records = [
    record("deploy.md", "r1", "# 部署\n\n服务器 部署 流程 与 回滚\n", "部署手册"),
    record("memory.md", "r1", "# 内存\n\n索引 内存 占用\n", "内存笔记"),
  ];
  const runtime = runtimeFor(indexPath, records);
  await runtime.syncRetrievalIndex({ embeddings: true });

  const status = await runtime.retrievalIndexStatus();
  assert.equal(status.available, true);
  assert.equal(status.version, 2);
  assert.equal(status.notes, 2);
  assert.equal(status.chunks, 2);
  assert.equal(status.embeddedChunks, 2, "Float32Array vectors count as embedded");
  assert.equal(status.embeddingModel, "probe:model:2");

  const recalled = await runtime.recall("部署 回滚");
  assert.equal(recalled.results.length > 0, true);
  assert.equal(recalled.semanticUsed, true);
  assert.equal(recalled.results[0].path, "deploy.md");
  assert.equal(typeof recalled.results[0].score, "number");

  // The snapshot path reads the committed state without touching disk.
  const snapshot = await runtime.recallFromSnapshot("部署 回滚");
  assert.equal(snapshot.results[0].path, "deploy.md");
  assert.deepEqual(snapshot.results.map((hit) => hit.path), recalled.results.map((hit) => hit.path));
  assert.notEqual(runtime.retrievalIndexStatusSnapshot(), null);
});

test("typed vectors rank identically to plain number arrays", async (t) => {
  const { indexPath } = await tempIndex(t);
  const records = [record("A.md", "r1", "# A\n\nalpha deployment\n", "A")];
  const runtime = runtimeFor(indexPath, records);
  await runtime.syncRetrievalIndex({ embeddings: true });
  const typed = await runtime.recall("alpha deployment", { semantic: true });
  // Re-run the same math against plain arrays to prove the adapter is value-identical.
  const { rankRecall } = await import("../src/vault-runtime/retrieval-rank.js");
  const state = await import("../src/vault-runtime/retrieval-index-store.js")
    .then(({ openIndexStore }) => openIndexStore({ legacyIndexPath: indexPath }).load());
  const arrays = {
    ...state,
    notes: Object.fromEntries(Object.entries(state.notes).map(([key, note]) => [key, { ...note, chunks: note.chunks.map((chunk) => ({ ...chunk, embedding: chunk.embedding === undefined ? undefined : Array.from(chunk.embedding) })) }])),
  };
  const plain = await rankRecall(arrays, "alpha deployment", {}, { semanticConfiguration: () => SEMANTIC, embedTexts: async (texts) => (Array.isArray(texts) ? texts : [texts]).map((text) => (text.includes("部署") ? [1, 0] : [0, 1])) });
  assert.equal(plain.results.length, typed.results.length);
  for (let index = 0; index < plain.results.length; index += 1) {
    assert.equal(plain.results[index].path, typed.results[index].path);
    assert.equal(Math.abs(plain.results[index].score - typed.results[index].score) < 1e-6, true);
  }
});

test("a lexical-only index still answers recall without semantic scores", async (t) => {
  const { indexPath } = await tempIndex(t);
  const records = [record("plain.md", "r1", "# plain\n\nlexical only needle\n", "plain")];
  const runtime = runtimeFor(indexPath, records, { embeddings: false });
  await runtime.syncRetrievalIndex({ embeddings: false });
  const status = await runtime.retrievalIndexStatus();
  assert.equal(status.embeddedChunks, 0);
  const recalled = await runtime.recall("needle");
  assert.equal(recalled.results[0].path, "plain.md");
  assert.equal(recalled.semanticUsed, false);
});

test("a legacy v1 index without v2 asks for migration and is never parsed or overwritten", async (t) => {
  const { indexPath } = await tempIndex(t);
  const legacy = {
    version: 1,
    updatedAt: "2026-11-20T00:00:00.000Z",
    embeddingModel: "probe:model:2",
    notes: { "A.md": { path: "A.md", revision: "r1", stat: {}, metadata: { title: "A" }, chunks: [{ id: "A.md#0", ordinal: 0, heading: "A", text: "alpha", hash: "h", embedding: [1, 0] }] } },
  };
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(legacy), "utf8");
  const before = await fs.readFile(indexPath);

  const runtime = runtimeFor(indexPath, [record("A.md", "r1", "# A\n\nalpha\n", "A")]);
  const status = await runtime.retrievalIndexStatus();
  assert.equal(status.available, false);
  assert.equal(status.reason, "retrieval_index_migration_required");
  await assert.rejects(runtime.recall("alpha"), /retrieval_index_migration_required/u);
  const synced = await runtime.syncRetrievalIndex({ embeddings: true });
  assert.equal(synced.unavailable, true);
  assert.deepEqual(await fs.readFile(indexPath), before, "the legacy file is left byte-identical");
  await assert.rejects(runtime.recallFromSnapshot("alpha"), /retrieval_index_migration_required/u);
});

test("two Vaults with the same note path serve their own vectors", async (t) => {
  const first = await tempIndex(t);
  const second = await tempIndex(t);
  const alpha = runtimeFor(first.indexPath, [record("A.md", "r1", "# A\n\nalpha deployment\n", "A")]);
  const beta = createRetrievalRuntime({
    vaultRuntime: { id: "vault-v2-b", paths: { retrievalIndex: second.indexPath } },
    embeddingProvider: { semanticConfiguration: () => SEMANTIC, embedTexts: async () => [[0, 1]] },
    deps: { getVaultIndex: async () => ({ records: [record("A.md", "r1", "# A\n\nbeta memory\n", "A")], stats: { files: 1 } }) },
  });
  await alpha.syncRetrievalIndex({ embeddings: true });
  await beta.syncRetrievalIndex({ embeddings: true });
  const alphaRecall = await alpha.recall("deployment", { semantic: true });
  const betaRecall = await beta.recall("deployment", { semantic: true });
  assert.equal(alphaRecall.index.notes, 1);
  assert.equal(betaRecall.index.notes, 1);
  assert.notEqual(alphaRecall.index.path, betaRecall.index.path);
  assert.equal((await alpha.retrievalIndexStatus()).semantic.identity, "probe:model:2");
});
