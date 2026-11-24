// M3 — a process that dies mid-publication must not corrupt the generation (plan 02 Task 5).
//
// The store publishes object -> manifest -> pointer. A `kill -9` between those steps
// leaves orphan staging files at worst; the previous pointer must still load.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openIndexStore } from "../src/vault-runtime/retrieval-index-store.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stateOf(entries) {
  const notes = {};
  for (const [notePath, revision, vector] of entries) {
    notes[notePath] = {
      path: notePath,
      revision,
      stat: { mtimeMs: 1 },
      metadata: { title: notePath },
      chunks: [{ id: `${notePath}#0`, ordinal: 0, heading: "", text: "t", hash: `h-${revision}`, embedding: Float32Array.from(vector) }],
    };
  }
  return { version: 2, updatedAt: "2026-11-22T00:00:00.000Z", embeddingModel: "probe:model:2", notes };
}

function crashAfter(step) {
  const script = `
    import { openIndexStore } from ${JSON.stringify(path.join(APP_ROOT, "src/vault-runtime/retrieval-index-store.js"))};
    const store = openIndexStore({
      legacyIndexPath: process.env.INDEX_PATH,
      io: { before: (name) => { if (name === ${JSON.stringify(step)}) process.exit(9); } },
    });
    const state = {
      version: 2, updatedAt: "2026-11-22T01:00:00.000Z", embeddingModel: "probe:model:2",
      notes: { "B.md": { path: "B.md", revision: "r1", stat: null, metadata: null, chunks: [{ id: "B.md#0", ordinal: 0, heading: "", text: "t", hash: "h", embedding: new Float32Array([0, 1]) }] } },
    };
    await store.commit(state, ["B.md"]);
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, INDEX_PATH: process.env.INDEX_PATH }, encoding: "utf8" });
}

test("a hard exit before the pointer is published keeps the previous generation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-store-crash-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyIndexPath = path.join(root, "index", "retrieval-index.json");
  const store = openIndexStore({ legacyIndexPath });
  const published = await store.commit(stateOf([["A.md", "r1", [1, 0]]]), ["A.md"]);
  process.env.INDEX_PATH = legacyIndexPath;
  t.after(() => { delete process.env.INDEX_PATH; });

  for (const step of ["object:write", "manifest:write", "pointer:write"]) {
    const child = crashAfter(step);
    assert.equal(child.status, 9, `the child must die at ${step}: ${child.stderr}`);
    const loaded = await store.load();
    assert.equal(loaded.generation, published.generation, `a crash at ${step} must leave the old generation`);
    assert.deepEqual([...loaded.notes["A.md"].chunks[0].embedding], [1, 0]);
    await assert.rejects(fs.stat(legacyIndexPath), { code: "ENOENT" });
  }
});

test("the first generation never appears half-published", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-store-crash-first-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyIndexPath = path.join(root, "index", "retrieval-index.json");
  process.env.INDEX_PATH = legacyIndexPath;
  t.after(() => { delete process.env.INDEX_PATH; });
  const child = crashAfter("manifest:write");
  assert.equal(child.status, 9);
  assert.equal(await openIndexStore({ legacyIndexPath }).load(), null, "no pointer means no generation");
  const report = await openIndexStore({ legacyIndexPath }).prune({ minAgeMs: 0 });
  assert.equal(report.objectsRemoved, 1, "the orphan object is collectable");
});
