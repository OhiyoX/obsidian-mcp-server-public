// Scale gate for GET /api/web/v1/tags (sidebar Tags panel).
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > 性能与容量门禁, and the H3 brief's "50k synthetic catalog / index-only" rule.
// Like the existing web-catalog scale gate this proves COMPLEXITY with instrumented
// query plans and counts, and records the measured elapsed time without inventing an
// SLA. `resolveTags` is the exact function the route calls, so the measured path is
// the production path minus auth.
import assert from "node:assert/strict";
import test from "node:test";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import { ensureCatalogDirectories } from "../src/app/web-catalog/indexer.js";
import { resolveTags } from "../src/app/tags-api.js";

const NOTE_TOTAL = 50_000;
const TAG_TOTAL = 2_000;
const TAG_LIMIT = 500;
const pad = (value, width) => String(value).padStart(width, "0");

// Deterministic tags per note: `t0000`..`t1999` plus a nested `group/g####/leaf` tag
// so the aggregate really exercises `/` hierarchy text as well.
const tagName = (index) => `t${pad(index % TAG_TOTAL, 4)}`;
const nestedTag = (index) => `group/g${pad(index % 500, 4)}/leaf`;

function buildCatalog(store) {
  store.batch(() => {
    for (let index = 0; index < NOTE_TOTAL; index += 1) {
      const dir = Math.floor(index / 1000);
      const notePath = `D${pad(dir, 3)}/note-${pad(index, 5)}.md`;
      ensureCatalogDirectories(store, notePath);
      store.upsertNote({ path: notePath, modifiedMs: index, tags: [tagName(index), tagName(index + 1), nestedTag(index)] });
    }
  });
}

test("50k catalog: GET /api/web/v1/tags is an index-only aggregate with a bounded page", async () => {
  const store = openWebCatalogStore();
  buildCatalog(store);
  store.setReconciledAt(new Date().toISOString());
  assert.equal(store.countNodes("note"), NOTE_TOTAL, "all notes indexed");

  // The grouping is served by the covering tag/path index: no table scan can hide
  // behind a fast machine.
  for (const [sort, direction] of [["count", "desc"], ["count", "asc"], ["name", "asc"], ["name", "desc"]]) {
    const detail = store.planListTags({ sort, direction, limit: TAG_LIMIT }).map((row) => row.detail).join("\n");
    assert.match(detail, /USING COVERING INDEX note_tags_tag_path/, `${sort}/${direction}\n${detail}`);
    assert.doesNotMatch(detail, /\bSCAN note_tags\b(?! USING COVERING)/, `${sort}/${direction} must not scan the table\n${detail}`);
    assert.doesNotMatch(detail, /\bSCAN nodes\b/, `${sort}/${direction} must not touch nodes\n${detail}`);
  }

  const vault = { id: "scale-vault", root: "ignored" };
  const runtime = { store };
  const started = performance.now();
  const payload = await resolveTags({
    vault,
    query: { sort: "count", direction: "desc", limit: String(TAG_LIMIT) },
    getRuntime: () => runtime,
  });
  const elapsedMs = performance.now() - started;

  assert.equal(payload.vaultId, vault.id);
  assert.equal(payload.tags.length, TAG_LIMIT, "the page is exactly limit-bounded");
  assert.equal(payload.total, TAG_TOTAL + 500, "total counts every distinct tag before the limit");
  assert.equal(payload.truncated, true);
  // Descending by count, and the tag ASC tie-break is deterministic.
  const pairs = payload.tags.map((item) => [item.count, item.tag]);
  const sorted = [...pairs].sort((left, right) => right[0] - left[0] || (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0));
  assert.deepEqual(pairs, sorted);

  // A name-ordered page is fully served too (and still index-only).
  const byName = await resolveTags({
    vault,
    query: { sort: "name", direction: "asc", limit: String(TAG_LIMIT) },
    getRuntime: () => runtime,
  });
  const names = byName.tags.map((item) => item.tag);
  assert.equal(names.length, TAG_LIMIT);
  assert.equal(byName.total, payload.total);
  assert.deepEqual(names, [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  assert.equal(new Set(names).size, TAG_LIMIT, "a page never repeats a tag");

  // Measured evidence for the handoff (not an SLA): 50k notes / 2500 distinct tags.
  console.log(`web-tags scale gate: notes=${NOTE_TOTAL} distinct=${payload.total} limit=${TAG_LIMIT} elapsedMs=${elapsedMs.toFixed(1)}`);
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0);
  store.close();
});
