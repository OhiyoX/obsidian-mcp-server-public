// M4/M5 — light deterministic memory-behaviour contract (plan 03 Task 3).
//
// The production-sized numbers live in `scratch/retrieval-memory/`; this test keeps
// the invariants that make them hold: a burst of concurrent semantic recalls while
// one note changes stays consistent, publishes once, and leaves no staging files.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRetrievalRuntime } from "../src/vault-runtime/retrieval-runtime.js";
import { openIndexStore } from "../src/vault-runtime/retrieval-index-store.js";

const SEMANTIC = Object.freeze({ enabled: true, provider: "probe", baseUrl: null, model: "probe:model:2", timeoutMs: 1000, identity: "probe:model:2" });

function vectorFor(text) {
  const digest = createHash("sha256").update(text).digest();
  return [digest.readUInt32LE(0) / 2 ** 32, 1];
}

function record(notePath, revision, content) {
  return {
    path: notePath,
    basename: path.basename(notePath),
    revision,
    content,
    frontmatter: { title: notePath },
    tags: [],
    aliases: [],
    stat: { mtimeMs: 1, created: "2026-11-22T00:00:00.000Z", modified: "2026-11-22T00:00:00.000Z" },
  };
}

test("three concurrent recalls during a note update stay consistent and publish once", { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-regression-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const records = Array.from({ length: 12 }, (_unused, index) => record(`note-${index}.md`, "r1", `# note ${index}\n\nmemory budget line ${index}\n`));
  let embedCalls = 0;
  const runtime = createRetrievalRuntime({
    vaultRuntime: { id: "vault-regression", paths: { retrievalIndex: indexPath } },
    embeddingProvider: {
      semanticConfiguration: () => SEMANTIC,
      embedTexts: async (texts) => {
        embedCalls += 1;
        return (Array.isArray(texts) ? texts : [texts]).map((text) => vectorFor(String(text)));
      },
    },
    deps: { getVaultIndex: async () => ({ records, stats: { files: records.length } }) },
  });

  await runtime.syncRetrievalIndex({ embeddings: true });
  const store = openIndexStore({ legacyIndexPath: indexPath });
  const firstGeneration = (await store.load()).generation;

  // One note changes while three semantic recalls run.
  records[3] = record("note-3.md", "r2", "# note 3\n\nmemory budget line three changed\n");
  const recalls = [1, 2, 3].map((round) => runtime.recall(`memory budget ${round}`, { semantic: true, limit: 5 }));
  const update = runtime.syncRetrievalIndex({ embeddings: true });
  const settled = await Promise.all([...recalls, update]);

  for (const result of settled.slice(0, 3)) {
    assert.equal(result.results.length > 0, true, "each concurrent recall answers from a committed generation");
    assert.equal(result.unavailable, undefined);
  }
  assert.equal(settled[3].updated, 1, "the concurrent update writes exactly one note");
  await runtime.drainRetrievalIndex();

  const loaded = await store.load();
  assert.notEqual(loaded.generation, firstGeneration, "the update published a new generation");
  assert.equal(loaded.notes["note-3.md"].revision, "r2");
  assert.equal(Object.keys(loaded.notes).length, 12, "no note is lost while recalls read");
  assert.equal(embedCalls >= 13, true, "the changed note asked for its embeddings");

  // A read after the write sees the same committed data (no half-published state).
  const after = await runtime.recall("memory budget line three changed", { semantic: true, limit: 3 });
  assert.equal(after.results[0].path, "note-3.md");

  const storeRoot = path.join(path.dirname(indexPath), "retrieval-index-v2");
  for (const directory of [storeRoot, path.join(storeRoot, "objects"), path.join(storeRoot, "manifests")]) {
    const entries = await fs.readdir(directory).catch(() => []);
    assert.deepEqual(entries.filter((entry) => entry.endsWith(".tmp")), [], `no staging files remain in ${directory}`);
  }
});

test("a burst of recalls on an unchanged index performs no index writes", { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-regression-burst-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const records = [record("a.md", "r1", "# a\n\nalpha memory\n"), record("b.md", "r1", "# b\n\nbeta memory\n")];
  const runtime = createRetrievalRuntime({
    vaultRuntime: { id: "vault-regression-burst", paths: { retrievalIndex: indexPath } },
    embeddingProvider: {
      semanticConfiguration: () => SEMANTIC,
      embedTexts: async (texts) => (Array.isArray(texts) ? texts : [texts]).map((text) => vectorFor(String(text))),
    },
    deps: { getVaultIndex: async () => ({ records, stats: { files: records.length } }) },
  });
  await runtime.syncRetrievalIndex({ embeddings: true });
  // The throttle window is 10 s; a short wait keeps the fixture fast without asserting on timing.
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  const pointer = path.join(path.dirname(indexPath), "retrieval-index-v2", "current.json");
  const before = await fs.stat(pointer);
  const original = fs.writeFile;
  let writes = 0;
  fs.writeFile = async (file, ...rest) => {
    if (String(file).includes("retrieval-index-v2")) writes += 1;
    return original.call(fs, file, ...rest);
  };
  try {
    await Promise.all(Array.from({ length: 5 }, (_unused, index) => runtime.recall(`burst memory ${index}`, { semantic: true })));
    await runtime.drainRetrievalIndex();
  } finally {
    fs.writeFile = original;
  }
  const after = await fs.stat(pointer);
  assert.equal(writes, 0, "five recalls on unchanged notes must not write the index");
  assert.equal(after.mtimeMs, before.mtimeMs, "the published pointer keeps its mtime");
});

test("two different filter sets in one generation never reuse each other's statistics", { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-regression-filters-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const notes = [
    { path: "active-needle.md", revision: "r1", content: "# a\n\nneedle active\n", status: "active", kind: "procedure" },
    { path: "archived-needle.md", revision: "r1", content: "# b\n\nneedle archived\n", status: "archived", kind: "procedure" },
    { path: "active-plain.md", revision: "r1", content: "# c\n\nneedle plain\n", status: "active", kind: "preference" },
    { path: "archived-plain.md", revision: "r1", content: "# d\n\nneedle plain\n", status: "archived", kind: "preference" },
  ];
  const records = notes.map((note) => ({
    path: note.path,
    basename: path.basename(note.path),
    revision: note.revision,
    content: note.content,
    frontmatter: { title: note.path, status: note.status, memory_kind: note.kind },
    tags: [],
    aliases: [],
    stat: { mtimeMs: 1, created: "2026-11-22T00:00:00.000Z", modified: "2026-11-22T00:00:00.000Z" },
  }));
  const makeRuntime = () => createRetrievalRuntime({
    vaultRuntime: { id: `vault-filters-${Math.random()}`, paths: { retrievalIndex: path.join(root, `${Math.random()}`, "retrieval-index.json") } },
    embeddingProvider: null,
    deps: { getVaultIndex: async () => ({ records, stats: { files: records.length } }) },
  });

  const runtime = makeRuntime();
  await runtime.syncRetrievalIndex({ embeddings: false });
  // Same generation, different filters: the second call must not reuse the first's
  // statistics (the chunk list differs, so scores would land on the wrong notes).
  const active = await runtime.recall("needle", { semantic: false, status: ["active"] });
  const archived = await runtime.recall("needle", { semantic: false, status: ["archived"] });
  assert.deepEqual(active.results.map((hit) => hit.path).sort(), ["active-needle.md", "active-plain.md"]);
  assert.deepEqual(archived.results.map((hit) => hit.path).sort(), ["archived-needle.md", "archived-plain.md"]);

  const preference = await runtime.recall("needle", { semantic: false, kinds: ["preference"] });
  assert.deepEqual(preference.results.map((hit) => hit.path).sort(), ["active-plain.md", "archived-plain.md"]);

  // A fresh runtime for the same filter set is the oracle.
  const oracle = makeRuntime();
  await oracle.syncRetrievalIndex({ embeddings: false });
  const oracleArchived = await oracle.recall("needle", { semantic: false, status: ["archived"] });
  assert.deepEqual(archived.results.map((hit) => [hit.path, hit.score]), oracleArchived.results.map((hit) => [hit.path, hit.score]));
});
