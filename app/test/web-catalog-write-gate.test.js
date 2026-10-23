// Phase 2B write-path gate: a 5k-child hot directory plus an unrelated 5k directory.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > 性能与容量门禁 > Write-path 硬门禁. Proves the ordering recompute is bounded to
// the affected parent(s) with instrumentation (which parents were recomputed and how
// many ordering rows were written), not machine speed.
import assert from "node:assert/strict";
import test from "node:test";
import { ensureCatalogDirectories } from "../src/app/web-catalog/indexer.js";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";

const pad = (value) => String(value).padStart(5, "0");

function build(store, dir, count, prefix) {
  for (let index = 0; index < count; index += 1) {
    const notePath = `${dir}/${prefix}-${pad(index)}.md`;
    ensureCatalogDirectories(store, notePath);
    store.upsertNote({ path: notePath, modifiedMs: index });
  }
}

test("5k write-path gate: reorders stay bounded to the affected parent(s)", () => {
  const store = openWebCatalogStore();
  store.batch(() => {
    build(store, "Hot", 5000, "h");
    build(store, "Other", 5000, "o");
  });
  const HOT = "Hot";
  const OTHER = "Other";

  // content/tag/property-only: no ordering recompute at all.
  store.resetRankRecomputes();
  store.upsertNote({ path: `${HOT}/h-02500.md`, content: "updated", tags: ["t"], properties: { a: 1 } });
  assert.deepEqual(store.rankRecomputes(), [], "content/tag/property save must not reorder siblings");

  // modified-only: no name-rank recompute.
  store.resetRankRecomputes();
  store.upsertNote({ path: `${HOT}/h-02500.md`, modifiedMs: 999_999 });
  assert.deepEqual(store.rankRecomputes(), [], "modified-only save must not recompute name ranks");

  // new child: exactly one recompute of the affected parent.
  store.resetRankRecomputes();
  store.upsertNote({ path: `${HOT}/new.md` });
  assert.deepEqual(store.rankRecomputes(), [HOT], "a new child recomputes its parent once");

  // rename within one parent, in one batch: one recompute.
  store.resetRankRecomputes();
  store.batch(() => {
    store.removePath(`${HOT}/new.md`);
    store.upsertNote({ path: `${HOT}/renamed.md` });
  });
  assert.deepEqual(store.rankRecomputes(), [HOT], "a same-parent rename recomputes once");

  // move: only the old and the new parent.
  store.resetRankRecomputes();
  store.batch(() => {
    store.removePath(`${HOT}/renamed.md`);
    ensureCatalogDirectories(store, `${OTHER}/moved.md`);
    store.upsertNote({ path: `${OTHER}/moved.md` });
  });
  assert.deepEqual(
    store.rankRecomputes().sort(),
    [HOT, OTHER].sort(),
    "a move recomputes only the old + new parent",
  );

  // same-parent batch with several mutations: one recompute.
  store.resetRankRecomputes();
  store.batch(() => {
    store.upsertNote({ path: `${HOT}/b1.md` });
    store.upsertNote({ path: `${HOT}/b2.md` });
    store.upsertNote({ path: `${HOT}/b3.md` });
  });
  assert.deepEqual(store.rankRecomputes(), [HOT], "a same-parent batch recomputes once");

  // an unrelated parent is never recomputed.
  store.resetRankRecomputes();
  store.upsertNote({ path: `${HOT}/unrelated-check.md` });
  assert.deepEqual(store.rankRecomputes(), [HOT], "an unrelated parent must not be recomputed");

  // a content save in a 5k parent writes exactly one ordering row.
  const before = store.rankWrites();
  store.upsertNote({ path: `${HOT}/h-00001.md`, content: "one more" });
  assert.equal(store.rankWrites() - before, 1, "a content save in a 5k parent writes one row");
  store.close();
});
