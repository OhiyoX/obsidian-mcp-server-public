// Phase 2A-0 integration: a secondary sibling Web Vault must reconcile through the
// REAL production reader (no injected fake source/reader).
//
// Regression for the review finding that source.read() used obsidian.readNote(),
// whose readLimitedText/fileRevision/toVaultPath are bound to the global primary
// VAULT. A secondary root is a sibling under WEB_VAULTS_ROOT, so it must be read
// with a root-scoped secure reader or it is rejected / mis-projected.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readNoteInRoot } from "../src/app/web-catalog/note-reader.js";
import { __resetWebCatalogRuntimesForTests, getWebCatalogRuntime } from "../src/app/web-catalog/runtime.js";

test("readNoteInRoot rejects a path outside its root", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-guard-"));
  try {
    await fs.mkdir(path.join(base, "team"), { recursive: true });
    await fs.writeFile(path.join(base, "outside.md"), "# outside\n");
    await assert.rejects(
      () => readNoteInRoot(path.join(base, "team"), path.join(base, "outside.md")),
      /traversal|inside|denied/i,
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a secondary sibling Vault reconciles through the real production reader", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-2a0-"));
  const primaryRoot = path.join(base, "primary");
  const secondaryRoot = path.join(base, "team");
  const catalogDir = path.join(base, "catalog");
  const savedEnabled = process.env.WEB_CATALOG_ENABLED;
  const savedDir = process.env.WEB_CATALOG_DIR;
  t.after(async () => {
    __resetWebCatalogRuntimesForTests();
    if (savedEnabled === undefined) delete process.env.WEB_CATALOG_ENABLED;
    else process.env.WEB_CATALOG_ENABLED = savedEnabled;
    if (savedDir === undefined) delete process.env.WEB_CATALOG_DIR;
    else process.env.WEB_CATALOG_DIR = savedDir;
    await fs.rm(base, { recursive: true, force: true });
  });
  process.env.WEB_CATALOG_ENABLED = "true";
  process.env.WEB_CATALOG_DIR = catalogDir;

  // Primary is a sibling with a poison note; the secondary must never read it.
  await fs.mkdir(path.join(primaryRoot, "Notes"), { recursive: true });
  await fs.writeFile(
    path.join(primaryRoot, "Notes", "Poison.md"),
    "---\ntags: [primary-only]\n---\n# primary poison\n",
  );
  await fs.mkdir(path.join(secondaryRoot, "Notes"), { recursive: true });
  await fs.writeFile(
    path.join(secondaryRoot, "Notes", "A.md"),
    "---\ntags: [team]\naliases: [Team A]\n---\n# team note body\n",
  );

  // Instrument every filesystem access the real reader/enumerator performs.
  const originals = { readdir: fs.readdir, open: fs.open, stat: fs.stat, realpath: fs.realpath };
  const touched = [];
  for (const method of ["readdir", "open", "stat", "realpath"]) {
    t.mock.method(fs, method, async (...args) => {
      touched.push(String(args[0]));
      return originals[method](...args);
    });
  }

  const runtime = getWebCatalogRuntime({ id: "team", root: secondaryRoot, primary: false });
  assert.ok(runtime, "a secondary sibling Vault must get a runtime");
  await runtime.drain();

  const node = runtime.store.locate("Notes/A.md");
  assert.ok(node, "the secondary note is indexed under a root-relative path");
  assert.equal(node.path, "Notes/A.md");
  assert.match(node.revision, /^sha256:[0-9a-f]{64}$/, "revision is a real content hash");

  const tags = runtime.store
    .testDb()
    .prepare("SELECT tag FROM note_tags WHERE path = 'Notes/A.md'")
    .all()
    .map((row) => row.tag);
  assert.ok(tags.includes("team"), "frontmatter tags are indexed");
  assert.ok(
    runtime.store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'team'").get().n >= 1,
    "content is searchable",
  );

  assert.equal(runtime.store.locate("Notes/Poison.md"), null, "the primary sibling is not in this catalog");
  assert.ok(touched.length > 0, "the real reader performed filesystem work");
  const leaked = touched.filter((candidate) => candidate.startsWith(primaryRoot));
  assert.deepEqual(leaked, [], `no primary-root access allowed, saw: ${leaked.join(", ")}`);
  runtime.close();
});

test("a malformed YAML note in a secondary Vault degrades to plain Markdown (default runtime)", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "web-catalog-malformed-"));
  const secondaryRoot = path.join(base, "team");
  const catalogDir = path.join(base, "catalog");
  const savedEnabled = process.env.WEB_CATALOG_ENABLED;
  const savedDir = process.env.WEB_CATALOG_DIR;
  t.after(async () => {
    __resetWebCatalogRuntimesForTests();
    if (savedEnabled === undefined) delete process.env.WEB_CATALOG_ENABLED;
    else process.env.WEB_CATALOG_ENABLED = savedEnabled;
    if (savedDir === undefined) delete process.env.WEB_CATALOG_DIR;
    else process.env.WEB_CATALOG_DIR = savedDir;
    await fs.rm(base, { recursive: true, force: true });
  });
  process.env.WEB_CATALOG_ENABLED = "true";
  process.env.WEB_CATALOG_DIR = catalogDir;

  await fs.mkdir(path.join(secondaryRoot, "Notes"), { recursive: true });
  // Unclosed flow sequence: the front matter parser throws, so the reader must degrade rather
  // than let reconcile fail (the Phase 1B malformed-frontmatter contract).
  await fs.writeFile(path.join(secondaryRoot, "Notes", "Broken.md"), "---\nfoo: [1, 2\n---\nbody #kept\n");

  const runtime = getWebCatalogRuntime({ id: "team-malformed", root: secondaryRoot, primary: false });
  assert.ok(runtime);
  await runtime.drain(); // must not reject

  const node = runtime.store.locate("Notes/Broken.md");
  assert.ok(node, "a malformed note still indexes as plain Markdown");
  assert.equal(node.path, "Notes/Broken.md");
  const tags = runtime.store
    .testDb()
    .prepare("SELECT tag FROM note_tags WHERE path = 'Notes/Broken.md'")
    .all()
    .map((row) => row.tag);
  assert.ok(tags.includes("kept"), "inline tags from the plain-Markdown body are indexed");
  assert.ok(
    runtime.store.testDb().prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'kept'").get().n >= 1,
  );
  runtime.close();
});
