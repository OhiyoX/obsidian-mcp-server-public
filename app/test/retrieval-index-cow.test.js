// M3 — per-note copy-on-write inside one published generation (plan 02 Task 5).
//
// A one-note change must not clone the whole state, must write exactly one new
// object, and must leave every other note's shard byte-identical.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHash } from "node:crypto";

import { createRetrievalRuntime } from "../src/vault-runtime/retrieval-runtime.js";

// Distinct vectors per text, so identical shards can only mean a bug.
function vectorFor(text) {
  const digest = createHash("sha256").update(text).digest();
  return [digest.readUInt32LE(0) / 2 ** 32, 1];
}

const SEMANTIC = Object.freeze({ enabled: true, identity: "probe:model:2" });

function record(notePath, revision, content) {
  return {
    path: notePath,
    basename: path.basename(notePath),
    revision,
    content,
    frontmatter: {},
    tags: [],
    aliases: [],
    stat: { mtimeMs: 1, created: "2026-11-22T00:00:00.000Z", modified: "2026-11-22T00:00:00.000Z" },
  };
}

function harness({ indexPath, records }) {
  const calls = { embed: 0 };
  const runtime = createRetrievalRuntime({
    vaultRuntime: { id: "vault-cow", paths: { retrievalIndex: indexPath } },
    embeddingProvider: {
      semanticConfiguration: () => SEMANTIC,
      embedTexts: async (texts) => {
        calls.embed += texts.length;
        return texts.map((text) => vectorFor(text));
      },
    },
    deps: { getVaultIndex: async () => ({ records, stats: { files: records.length } }) },
  });
  return { runtime, calls };
}

async function objectsOf(indexPath) {
  const directory = path.join(path.dirname(indexPath), "retrieval-index-v2", "objects");
  const names = await fs.readdir(directory).catch(() => []);
  return names.sort();
}

test("a 100-note index clones nothing and writes one object for one changed note", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-cow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const records = Array.from({ length: 100 }, (_unused, index) => record(`note-${index}.md`, "r1", `# note ${index}\n\nbody ${index}\n`));
  const { runtime, calls } = harness({ indexPath, records });
  await runtime.syncRetrievalIndex({ embeddings: true });
  assert.equal(calls.embed, 100);
  const before = await objectsOf(indexPath);
  assert.equal(before.length, 100);

  records[42] = record("note-42.md", "r2", "# note 42\n\nbody forty-two changed\n");
  const originalClone = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = (...args) => {
    clones += 1;
    return originalClone(...args);
  };
  let result;
  try {
    result = await runtime.syncRetrievalIndex({ embeddings: true });
  } finally {
    globalThis.structuredClone = originalClone;
  }
  assert.equal(clones, 0, "a one-note change must not clone the whole state");
  assert.equal(result.updated, 1);
  assert.equal(result.reused, 99);
  const after = await objectsOf(indexPath);
  assert.equal(after.length, 101, "exactly one new shard is written");
  assert.deepEqual(after.filter((name) => !before.includes(name)).length, 1);
});

test("a model change rewrites every note exactly once", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-cow-model-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const records = [record("A.md", "r1", "# A\n\nalpha\n"), record("B.md", "r1", "# B\n\nbeta\n")];
  let identity = "probe:model:2";
  const runtime = createRetrievalRuntime({
    vaultRuntime: { id: "vault-cow-model", paths: { retrievalIndex: indexPath } },
    embeddingProvider: {
      semanticConfiguration: () => ({ enabled: true, identity }),
      embedTexts: async (texts) => texts.map((text) => vectorFor(text)),
    },
    deps: { getVaultIndex: async () => ({ records, stats: { files: records.length } }) },
  });
  await runtime.syncRetrievalIndex({ embeddings: true });
  const before = await objectsOf(indexPath);
  identity = "probe:model:3";
  const result = await runtime.syncRetrievalIndex({ embeddings: true });
  assert.equal(result.reused, 2);
  assert.equal(result.embeddedChunks, 2, "both notes are embedded again under the new model");
  // The stub model returns the same vectors for the same text, so content-addressed
  // objects collapse; what must change is the published model identity.
  const { openIndexStore } = await import("../src/vault-runtime/retrieval-index-store.js");
  const { readFile } = await import("node:fs/promises");
  const pointer = JSON.parse(await readFile(openIndexStore({ legacyIndexPath: indexPath }).currentPath, "utf8"));
  const manifest = JSON.parse(await readFile(path.join(path.dirname(indexPath), "retrieval-index-v2", "manifests", `${pointer.active}.json`), "utf8"));
  assert.equal(manifest.modelIdentity, "probe:model:3");
  const after = await objectsOf(indexPath);
  assert.equal(after.length, before.length);
});

test("a deletion removes the note and keeps other shards untouched", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-cow-delete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "index", "retrieval-index.json");
  const records = [record("A.md", "r1", "# A\n\nalpha\n"), record("B.md", "r1", "# B\n\nbeta\n")];
  const { runtime } = harness({ indexPath, records });
  await runtime.syncRetrievalIndex({ embeddings: true });
  const before = await objectsOf(indexPath);
  records.pop();
  const result = await runtime.syncRetrievalIndex({ embeddings: true });
  assert.equal(result.removed, 1);
  const after = await objectsOf(indexPath);
  assert.deepEqual(after, before, "the removed note's object stays until prune()");
  const status = await runtime.retrievalIndexStatus();
  assert.equal(status.notes, 1);
  assert.equal(status.chunks, 1);
});
