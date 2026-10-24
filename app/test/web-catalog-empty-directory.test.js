// U6: a directory that recursively holds no catalog document must still be indexed
// as an explicit `directory` node, so it appears in the Explorer tree.
//
// RED→GREEN evidence: before U6 the reconcile only derived directories from a
// file's ancestor chain (ensureCatalogDirectories), so `Empty/` was absent and
// `store.locate("Empty")` was null. The source below mirrors the production
// runtime wiring (runtime.js): listDocuments + listDirectories.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVaultCatalogSource, ensureCatalogDirectories } from "../src/app/web-catalog/indexer.js";
import { readBaseInRoot, readNoteInRoot } from "../src/app/web-catalog/note-reader.js";
import { createWebCatalogReconciler } from "../src/app/web-catalog/reconcile.js";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import {
  listCatalogDirectoriesUnder,
  listCatalogInventoryUnder,
  toRootRelative,
} from "../src/app/web-catalog/vault-source.js";

function productionSource(root) {
  return createVaultCatalogSource({
    vaultRoot: root,
    listDocuments: (options) => listCatalogInventoryUnder(root, options),
    listDirectories: (options) => listCatalogDirectoriesUnder(root, options),
    stat: (absolute) => fs.stat(absolute),
    readNote: (absolute, options) => readNoteInRoot(root, absolute, options),
    readBase: (absolute) => readBaseInRoot(root, absolute),
    toVaultPath: (absolute) => toRootRelative(root, absolute),
  });
}

test("a recursively empty directory is indexed and visible in the tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-empty-dir-"));
  const store = openWebCatalogStore();
  try {
    await fs.mkdir(path.join(root, "Empty"), { recursive: true });
    await fs.mkdir(path.join(root, "EmptyNested", "Inner"), { recursive: true });
    await fs.mkdir(path.join(root, "Full"), { recursive: true });
    await fs.writeFile(path.join(root, "Full", "Note.md"), "# full\n");
    await fs.writeFile(path.join(root, "Root.md"), "# root\n");

    const reconciler = createWebCatalogReconciler({ store, source: productionSource(root) });
    const result = await reconciler.reconcile();
    assert.equal(store.isStale(), false);

    assert.equal(store.locate("Empty")?.kind, "directory", "an empty directory is a real node");
    assert.equal(store.locate("EmptyNested")?.kind, "directory", "a nested empty directory is a real node");
    assert.equal(store.locate("EmptyNested/Inner")?.kind, "directory", "the deepest empty directory is a real node");
    assert.equal(store.locate("Full")?.kind, "directory", "a non-empty directory keeps its node");
    assert.equal(store.locate("Full/Note.md")?.kind, "note");

    // Root ordering is unchanged: folders first (pinned collator), then the note.
    const rootPage = store.listChildren("", { limit: 100, sort: "name", direction: "asc" });
    assert.deepEqual(rootPage.items.map((item) => item.path), ["Empty", "EmptyNested", "Full", "Root.md"]);

    // The empty directory answers a children page as an empty (not missing) level.
    const emptyPage = store.listChildren("Empty", { limit: 100, sort: "name", direction: "asc" });
    assert.deepEqual(emptyPage.items, []);

    // Node counts: 4 directories + 1 note. Files are unchanged by the U6 addition.
    assert.equal(store.countNodes("directory"), 4);
    assert.equal(store.countNodes("note"), 2);
    assert.equal(result.files, 0, "no attachment/file entries in this fixture");
    assert.equal(result.directories, 4, "all four directories are published as explicit nodes");

    // Idempotent: a second scan neither duplicates nor reorders.
    const second = await reconciler.reconcile();
    assert.equal(second.directories, 4);
    assert.equal(store.countNodes("directory"), 4);
    assert.equal(store.countNodes("note"), 2);
    assert.deepEqual(
      store.listChildren("", { limit: 100, sort: "name", direction: "asc" }).items.map((item) => item.path),
      ["Empty", "EmptyNested", "Full", "Root.md"],
    );
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a source without the directory hook keeps the legacy ancestor-only behaviour", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-empty-legacy-"));
  const store = openWebCatalogStore();
  try {
    await fs.mkdir(path.join(root, "Empty"), { recursive: true });
    await fs.mkdir(path.join(root, "Full"), { recursive: true });
    await fs.writeFile(path.join(root, "Full", "Note.md"), "# full\n");
    const source = createVaultCatalogSource({
      vaultRoot: root,
      listDocuments: (options) => listCatalogInventoryUnder(root, options),
      stat: (absolute) => fs.stat(absolute),
      readNote: (absolute, options) => readNoteInRoot(root, absolute, options),
      readBase: (absolute) => readBaseInRoot(root, absolute),
      toVaultPath: (absolute) => toRootRelative(root, absolute),
    });
    assert.equal(typeof source.listDirectories, "undefined");
    await createWebCatalogReconciler({ store, source }).reconcile();
    assert.equal(store.locate("Empty"), null, "without the hook an empty folder stays invisible (legacy)");
    assert.equal(store.locate("Full")?.kind, "directory");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Issue #532: a folder deleted from disk outside the catalog write path (Obsidian
// desktop "move to .trash", MCP manage_folders delete, a shell rm) leaked its
// `directory` row forever. The row survives every reconcile because removals were
// computed from file-kind rows only, and an empty folder has no document removal
// that could prune it as a side effect.
test("a folder deleted from disk is pruned by the next reconcile (no phantom node)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-ghost-dir-"));
  const store = openWebCatalogStore();
  try {
    await fs.mkdir(path.join(root, "未命名"), { recursive: true });
    await fs.mkdir(path.join(root, "Keep", "Inner"), { recursive: true });
    await fs.writeFile(path.join(root, "Keep", "Inner", "Note.md"), "# keep\n");

    const reconciler = createWebCatalogReconciler({ store, source: productionSource(root) });
    await reconciler.reconcile();
    assert.equal(store.locate("未命名")?.kind, "directory", "the empty folder is indexed while it exists");

    // Obsidian-desktop delete: the folder is moved out of the Vault (to .trash).
    await fs.rm(path.join(root, "未命名"), { recursive: true });
    const second = await reconciler.reconcile();
    assert.equal(store.isStale(), false);
    assert.equal(store.locate("未命名"), null, "a folder gone from disk must not survive a full reconcile");
    assert.ok(second.removed >= 1, "the phantom row counts as a removal");

    // The Explorer root no longer lists it; the surviving tree is untouched.
    const rootPage = store.listChildren("", { limit: 100, sort: "name", direction: "asc" });
    assert.deepEqual(rootPage.items.map((item) => item.path), ["Keep"]);
    assert.equal(store.countNodes("directory"), 2, "Keep and Keep/Inner remain");

    // Idempotent: a third scan is clean and does not re-remove.
    const third = await reconciler.reconcile();
    assert.equal(third.removed, 0);
    assert.equal(store.locate("未命名"), null);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a deleted chain of nested empty folders is pruned as a subtree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-ghost-chain-"));
  const store = openWebCatalogStore();
  try {
    await fs.mkdir(path.join(root, "Chain", "Inner", "Deep"), { recursive: true });
    const reconciler = createWebCatalogReconciler({ store, source: productionSource(root) });
    await reconciler.reconcile();
    assert.equal(store.locate("Chain/Inner/Deep")?.kind, "directory");
    assert.equal(store.countNodes("directory"), 3);

    await fs.rm(path.join(root, "Chain"), { recursive: true });
    await reconciler.reconcile();
    assert.equal(store.locate("Chain"), null);
    assert.equal(store.locate("Chain/Inner"), null);
    assert.equal(store.locate("Chain/Inner/Deep"), null);
    assert.equal(store.countNodes("directory"), 0);
    assert.deepEqual(store.listChildren("", { limit: 100, sort: "name", direction: "asc" }).items, []);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a folder replaced by a same-named file flips in place instead of being reaped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-ghost-flip-"));
  const store = openWebCatalogStore();
  try {
    await fs.mkdir(path.join(root, "Swap"), { recursive: true });
    const reconciler = createWebCatalogReconciler({ store, source: productionSource(root) });
    await reconciler.reconcile();
    assert.equal(store.locate("Swap")?.kind, "directory");

    // Directory -> file: the stale-directory diff must not delete the row that the
    // same scan's attachment upsert just rewrote.
    await fs.rmdir(path.join(root, "Swap"));
    await fs.writeFile(path.join(root, "Swap"), "now a file\n");
    await reconciler.reconcile();
    assert.equal(store.locate("Swap")?.kind, "file", "the same-named file replaces the directory node");

    // File -> directory: the file-kind removal pass plus the directory
    // re-materialization must converge on a directory node.
    await fs.rm(path.join(root, "Swap"));
    await fs.mkdir(path.join(root, "Swap"));
    await reconciler.reconcile();
    assert.equal(store.locate("Swap")?.kind, "directory");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a source without the directory hook never reaps directory rows (legacy boundary)", async () => {
  // In legacy mode the scan has no directory inventory, so it cannot tell an empty
  // folder that still exists from one that was deleted: removals must stay file-only.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-ghost-legacy-"));
  const store = openWebCatalogStore();
  try {
    await fs.mkdir(path.join(root, "Legacy"), { recursive: true });
    const source = createVaultCatalogSource({
      vaultRoot: root,
      listDocuments: (options) => listCatalogInventoryUnder(root, options),
      stat: (absolute) => fs.stat(absolute),
      readNote: (absolute, options) => readNoteInRoot(root, absolute, options),
      readBase: (absolute) => readBaseInRoot(root, absolute),
      toVaultPath: (absolute) => toRootRelative(root, absolute),
    });
    ensureCatalogDirectories(store, "Legacy/Note.md");
    assert.equal(store.locate("Legacy")?.kind, "directory");
    await createWebCatalogReconciler({ store, source }).reconcile();
    assert.equal(store.locate("Legacy")?.kind, "directory", "no inventory means no directory reaping");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
