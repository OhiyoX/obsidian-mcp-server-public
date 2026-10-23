// Phase 2B scale/complexity gate: 1k / 10k / 50k synthetic catalogs.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > 性能与容量门禁. The gate proves COMPLEXITY with instrumented query plans and
// counts, not machine speed (a fast machine must not hide an O(N) path). The
// target-platform Linux/NAS benchmark remains a separate operational gate.
import assert from "node:assert/strict";
import test from "node:test";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import { ensureCatalogDirectories } from "../src/app/web-catalog/indexer.js";

const pad = (value, width) => String(value).padStart(width, "0");

// 50k shape: a single hot directory + a deep, wide tree.
function buildCatalog(store, { total, hot }) {
  const rest = total - hot;
  store.batch(() => {
    for (let index = 0; index < hot; index += 1) {
      const notePath = `Hot/h-${pad(index, 5)}.md`;
      ensureCatalogDirectories(store, notePath);
      store.upsertNote({ path: notePath, modifiedMs: index });
    }
    for (let index = 0; index < rest; index += 1) {
      const dir = Math.floor(index / 90);
      const sub = Math.floor((index % 90) / 9);
      const notePath = `Deep/D${pad(dir, 3)}/S${sub}/note-${pad(index, 5)}.md`;
      ensureCatalogDirectories(store, notePath);
      store.upsertNote({ path: notePath, modifiedMs: index });
    }
  });
}

const SCALES = [
  { name: "1k", total: 1000, hot: 200 },
  { name: "10k", total: 10000, hot: 1000 },
  { name: "50k", total: 50000, hot: 5000 },
];

for (const { name, total, hot } of SCALES) {
  test(`${name} catalog: every legal path is reachable and pages stay index-bounded`, () => {
    const store = openWebCatalogStore();
    buildCatalog(store, { total, hot });
    assert.equal(store.countNodes("note"), total, `${name}: all notes indexed`);

    // A root page is bounded and never materializes the vault.
    const root = store.listChildren("", { limit: 100, sort: "name", direction: "asc" });
    assert.deepEqual(root.items.map((item) => item.path), ["Deep", "Hot"]);
    assert.equal(root.nextCursor, null);

    // Any legal path is reachable: no 300/10k silent truncation.
    const lastHot = `Hot/h-${pad(hot - 1, 5)}.md`;
    assert.equal(store.locate(lastHot)?.path, lastHot, `${name}: last hot note reachable`);
    const rest = total - hot;
    const lastIndex = rest - 1;
    const lastDeep = `Deep/D${pad(Math.floor(lastIndex / 90), 3)}/S${Math.floor((lastIndex % 90) / 9)}/note-${pad(lastIndex, 5)}.md`;
    assert.equal(store.locate(lastDeep)?.path, lastDeep, `${name}: deepest last note reachable`);

    // The hot directory is page-bounded and index-served for every ordering.
    const page = store.listChildren("Hot", { limit: 100, sort: "name", direction: "asc" });
    assert.equal(page.items.length, 100, `${name}: one page is page-size bounded`);
    assert.ok(page.nextCursor);
    for (const [sort, direction, index] of [
      ["name", "asc", "nodes_parent_name_asc"],
      ["name", "desc", "nodes_parent_name_desc"],
      ["modified", "asc", "nodes_parent_modified_asc"],
      ["modified", "desc", "nodes_parent_modified_desc"],
    ]) {
      const detail = store
        .planListChildren("Hot", { sort, direction, limit: 100 })
        .map((row) => row.detail)
        .join("\n");
      assert.match(detail, new RegExp(`USING INDEX ${index}`), `${name} ${sort}/${direction}\n${detail}`);
      assert.doesNotMatch(detail, /TEMP B-TREE/, `${name} ${sort}/${direction} must not sort a temp b-tree`);
      assert.doesNotMatch(detail, /\bSCAN nodes\b/, `${name} ${sort}/${direction} must not scan the table`);
    }

    // The last item of the hot directory is reachable with an anchor page.
    const anchored = store.listChildren("Hot", { anchorPath: lastHot, limit: 10, sort: "name", direction: "asc" });
    assert.equal(anchored.items[0].path, lastHot, `${name}: anchor reaches the last hot note`);

    // Deep levels page with the same bound (work scales with page size, not vault size).
    const deep = store.listChildren("Deep", { limit: 100, sort: "name", direction: "asc" });
    assert.ok(deep.items.length >= 1 && deep.items.length <= 100, `${name}: deep level is page-bounded`);
    store.close();
  });
}
