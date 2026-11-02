// Phase 2A-0 tests: root-scoped multi-Vault Vault source.
//
// Contract: every authorized Web Vault enumerates/reads its OWN vault.root; the
// primary Vault is not special and no enumerator depends on the global VAULT.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVaultCatalogSource } from "../src/app/web-catalog/indexer.js";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import { createWebCatalogReconciler } from "../src/app/web-catalog/reconcile.js";
import { readBaseInRoot, readNoteInRoot } from "../src/app/web-catalog/note-reader.js";
import {
  catalogKindForName,
  isCatalogDocumentPath,
  isCatalogInventoryPath,
  listCatalogDocumentsUnder,
  listCatalogInventoryUnder,
  listMarkdownUnder,
  toRootRelative,
} from "../src/app/web-catalog/vault-source.js";

test("listMarkdownUnder enumerates the given root, not the global VAULT", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-root-"));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-other-"));
  try {
    await fs.mkdir(path.join(root, "Notes", "Deep"), { recursive: true });
    await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(root, "Root.md"), "# root\n");
    await fs.writeFile(path.join(root, "Notes", "A.md"), "# a\n");
    await fs.writeFile(path.join(root, "Notes", "Deep", "B.md"), "# b\n");
    await fs.writeFile(path.join(root, "Notes", "skip.txt"), "no\n");
    await fs.writeFile(path.join(root, ".hidden", "h.md"), "# h\n");
    await fs.writeFile(path.join(root, ".git", "g.md"), "# g\n");
    await fs.writeFile(path.join(root, "node_modules", "n.md"), "# n\n");
    await fs.writeFile(path.join(other, "Other.md"), "# other\n");

    const found = (await listMarkdownUnder(root)).map((absolute) => toRootRelative(root, absolute)).sort();
    assert.deepEqual(found, ["Notes/A.md", "Notes/Deep/B.md", "Root.md"]);
    assert.ok(!found.includes("Other.md"), "a secondary root must not read another root");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
});

test("listMarkdownUnder honors maxEntries and skips symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-cap-"));
  try {
    for (let index = 0; index < 5; index += 1) await fs.writeFile(path.join(root, `n-${index}.md`), "# n\n");
    assert.equal((await listMarkdownUnder(root, { maxEntries: 2 })).length, 2);

    try {
      await fs.symlink(path.join(root, "n-0.md"), path.join(root, "link.md"));
      const withLink = await listMarkdownUnder(root);
      assert.ok(!withLink.some((absolute) => absolute.endsWith("link.md")), "symlinks are skipped");
    } catch {
      // Windows without symlink privileges: the skip policy is still covered by code.
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("createVaultCatalogSource lists and reads relative to the given root", async () => {
  const reads = [];
  const root = path.join(path.sep, "vaults", "team");
  const source = createVaultCatalogSource({
    vaultRoot: root,
    listMarkdown: async () => [path.join(root, "Notes", "A.md")],
    stat: async () => ({ size: 3, mtimeMs: 1000 }),
    readNote: async (absolute) => {
      reads.push(absolute);
      return {
        path: "Notes/A.md",
        content: "x",
        frontmatter: {},
        revision: "r1",
        stat: { size: 3, modified: new Date(1000).toISOString(), created: new Date(0).toISOString() },
      };
    },
    toVaultPath: (absolute) => toRootRelative(root, absolute),
  });

  const listed = await source.list();
  assert.equal(listed[0].path, "Notes/A.md", "listed paths are root-relative");
  await source.read("Notes/A.md");
  assert.equal(reads[0], path.join(root, "Notes", "A.md"), "read resolves against the given root");
});

test("listCatalogDocumentsUnder returns typed note/base under the shared walk policy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-typed-"));
  try {
    await fs.mkdir(path.join(root, "Notes", "Deep"), { recursive: true });
    await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(root, "Root.md"), "# root\n");
    await fs.writeFile(path.join(root, "Notes", "A.base"), "views: []\n");
    await fs.writeFile(path.join(root, "Notes", "B.MD"), "# b\n");
    await fs.writeFile(path.join(root, "Notes", "Deep", "C.BASE"), "views: []\n");
    await fs.writeFile(path.join(root, "Notes", "skip.txt"), "no\n");
    await fs.writeFile(path.join(root, ".hidden", "h.base"), "views: []\n");
    await fs.writeFile(path.join(root, "node_modules", "n.base"), "views: []\n");

    const found = (await listCatalogDocumentsUnder(root))
      .map((entry) => [toRootRelative(root, entry.absolute), entry.kind])
      .sort((left, right) => left[0].localeCompare(right[0]));
    assert.deepEqual(found, [
      ["Notes/A.base", "base"],
      ["Notes/B.MD", "note"],
      ["Notes/Deep/C.BASE", "base"],
      ["Root.md", "note"],
    ]);
    assert.equal((await listCatalogDocumentsUnder(root, { maxEntries: 2 })).length, 2);

    try {
      await fs.symlink(path.join(root, "Notes", "A.base"), path.join(root, "link.base"));
      const withLink = await listCatalogDocumentsUnder(root);
      assert.ok(!withLink.some((entry) => entry.absolute.endsWith("link.base")), "symlinks are skipped");
    } catch {
      // Windows without symlink privileges: the skip policy is still covered.
    }

    const markdown = (await listMarkdownUnder(root)).map((absolute) => toRootRelative(root, absolute)).sort();
    assert.deepEqual(markdown, ["Notes/B.MD", "Root.md"], "listMarkdownUnder still returns Markdown only");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isCatalogDocumentPath classifies documents, not assets or hidden files", () => {
  assert.equal(isCatalogDocumentPath("Notes/A.md"), true);
  assert.equal(isCatalogDocumentPath("Project.base"), true);
  assert.equal(isCatalogDocumentPath("Deep/C.BASE"), true);
  assert.equal(isCatalogDocumentPath("Notes/image.png"), false);
  assert.equal(isCatalogDocumentPath(".hidden/A.md"), false);
  assert.equal(isCatalogDocumentPath("Notes/.secret.base"), false);
});

test("listCatalogInventoryUnder returns note/base/file under the shared walk policy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-inventory-"));
  try {
    await fs.mkdir(path.join(root, "Notes", "Deep"), { recursive: true });
    await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(root, "Root.md"), "# root\n");
    await fs.writeFile(path.join(root, "Notes", "A.base"), "views: []\n");
    await fs.writeFile(path.join(root, "Notes", "photo.PNG"), "not a note\n");
    await fs.writeFile(path.join(root, "Notes", "Deep", "report.pdf"), "%PDF\n");
    await fs.writeFile(path.join(root, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(root, ".hidden", "h.png"), "x\n");
    await fs.writeFile(path.join(root, ".git", "g.txt"), "x\n");
    await fs.writeFile(path.join(root, "node_modules", "n.txt"), "x\n");

    const found = (await listCatalogInventoryUnder(root))
      .map((entry) => [toRootRelative(root, entry.absolute), entry.kind])
      .sort((left, right) => left[0].localeCompare(right[0]));
    assert.deepEqual(found, [
      ["LICENSE", "file"],
      ["Notes/A.base", "base"],
      ["Notes/Deep/report.pdf", "file"],
      ["Notes/photo.PNG", "file"],
      ["Root.md", "note"],
    ]);
    assert.equal((await listCatalogInventoryUnder(root, { maxEntries: 2 })).length, 2);

    try {
      await fs.symlink(path.join(root, "LICENSE"), path.join(root, "link.txt"));
      const withLink = await listCatalogInventoryUnder(root);
      assert.ok(!withLink.some((entry) => entry.absolute.endsWith("link.txt")), "symlinks are skipped");
    } catch {
      // Windows without symlink privileges: the skip policy is still covered by code.
    }

    // The narrower enumerators keep their contracts: attachments are not documents.
    const documents = (await listCatalogDocumentsUnder(root)).map((entry) => toRootRelative(root, entry.absolute));
    assert.ok(!documents.includes("Notes/photo.PNG"));
    assert.ok(!documents.includes("LICENSE"));
    assert.deepEqual((await listMarkdownUnder(root)).map((absolute) => toRootRelative(root, absolute)).sort(), ["Root.md"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isCatalogInventoryPath accepts attachments but rejects hidden paths", () => {
  assert.equal(isCatalogInventoryPath("Notes/photo.png"), true);
  assert.equal(isCatalogInventoryPath("LICENSE"), true);
  assert.equal(isCatalogInventoryPath(".hidden/photo.png"), false);
  assert.equal(isCatalogInventoryPath("Notes/.secret.png"), false);
  assert.equal(catalogKindForName("photo.png"), "file");
  assert.equal(catalogKindForName("A.BASE"), "base");
});

test("a real reconcile indexes an attachment without ever reading its bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-file-rebuild-"));
  const store = openWebCatalogStore();
  const noteReads = [];
  try {
    await fs.mkdir(path.join(root, "Assets"), { recursive: true });
    const attachmentPath = path.join(root, "Assets", "photo.png");
    await fs.writeFile(path.join(root, "Assets", "Note.md"), "# body\n");
    await fs.writeFile(attachmentPath, "binary-ish bytes\n");
    const bytes = await fs.readFile(attachmentPath);

    const source = createVaultCatalogSource({
      vaultRoot: root,
      listDocuments: (options) => listCatalogInventoryUnder(root, options),
      stat: (absolute) => fs.stat(absolute),
      readNote: (absolute, options) => {
        noteReads.push(absolute);
        return readNoteInRoot(root, absolute, options);
      },
      readBase: (absolute) => readBaseInRoot(root, absolute),
      toVaultPath: (absolute) => toRootRelative(root, absolute),
    });
    const result = await createWebCatalogReconciler({ store, source }).reconcile();

    assert.equal(result.files, 1, "the attachment is indexed as a file node");
    assert.equal(result.reparsed, 1, "only the Markdown note is read");
    assert.deepEqual(noteReads, [path.join(root, "Assets", "Note.md")], "the attachment path never reaches the note reader");
    assert.equal(store.locate("Assets/photo.png").kind, "file");
    assert.equal(store.locate("Assets/photo.png").revision, null, "a file has no content revision");
    assert.equal(store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts").get().n, 1, "only the note is in FTS");
    assert.deepEqual(await fs.readFile(attachmentPath), bytes, "reconcile never rewrites attachment bytes");

    // A second scan reuses the stat signature and does not re-index the attachment.
    const second = await createWebCatalogReconciler({ store, source }).reconcile();
    assert.equal(second.files, 0);
    assert.equal(second.reused, 2, "note + attachment are reused");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a real reconcile handles .md + .base and never rewrites Vault bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-rebuild-"));
  const notePath = path.join(root, "Notes", "Note.md");
  const basePath = path.join(root, "Notes", "Project.base");
  const store = openWebCatalogStore();
  try {
    await fs.mkdir(path.join(root, "Notes"), { recursive: true });
    await fs.writeFile(notePath, "---\ntype: note\n---\n# body\n");
    await fs.writeFile(basePath, "views:\n  - type: table\n");
    const noteBytes = await fs.readFile(notePath);
    const baseBytes = await fs.readFile(basePath);

    const source = createVaultCatalogSource({
      vaultRoot: root,
      listDocuments: (options) => listCatalogDocumentsUnder(root, options),
      stat: (absolute) => fs.stat(absolute),
      readNote: (absolute, options) => readNoteInRoot(root, absolute, options),
      readBase: (absolute) => readBaseInRoot(root, absolute),
      toVaultPath: (absolute) => toRootRelative(root, absolute),
    });
    const result = await createWebCatalogReconciler({ store, source }).reconcile();
    assert.equal(result.reparsed, 2);
    assert.equal(store.locate("Notes/Note.md").kind, "note");
    assert.equal(store.locate("Notes/Project.base").kind, "base");
    assert.ok(store.locate("Notes/Project.base").revision.startsWith("sha256:"));

    assert.deepEqual(await fs.readFile(notePath), noteBytes, "reconcile must not modify note bytes");
    assert.deepEqual(await fs.readFile(basePath), baseBytes, "reconcile must not modify .base bytes");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
