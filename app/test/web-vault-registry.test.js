import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-vaults-"));
const vaultsRoot = path.join(root, "vaults");
const primary = path.join(vaultsRoot, "main");
await fs.mkdir(path.join(primary, ".obsidian"), { recursive: true });
await fs.mkdir(path.join(vaultsRoot, "research", ".obsidian"), { recursive: true });
await fs.writeFile(path.join(primary, "Home.md"), "---\ntags: [home]\n---\n# Home\n", "utf8");
process.env.VAULT_PATH = primary;
process.env.WEB_VAULTS_ROOT = vaultsRoot;
process.env.WEB_DEFAULT_VAULT = "main";
process.env.OBSIDIAN_READ_ONLY = "false";
// #428: the mutating Vault-registry calls open the per-Vault Web Catalog. Keep it inside this
// test's temporary root instead of the process-wide default (`DATA_PATH/web-catalog`), which is
// unwritable on CI.
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");

const registry = await import(`../src/app/vault-registry.js?test=${Date.now()}`);
const { __resetWebCatalogRuntimesForTests } = await import("../src/app/web-catalog/runtime.js");
after(() => {
  // Closing every catalog runtime releases the sqlite handles before the temp dir is removed
  // (Windows keeps `-shm`/`-wal` busy while a connection is still open).
  __resetWebCatalogRuntimesForTests();
  return fs.rm(root, { recursive: true, force: true });
});

test("resolveWebVault fails closed for an explicit unknown Vault id", async () => {
  const fallback = await registry.resolveWebVault();
  assert.equal(fallback.id, "main");

  await assert.rejects(
    () => registry.resolveWebVault("missing-vault"),
    (error) => error?.code === "ENOENT" && /Vault not found/.test(error.message),
  );
});

test("Web Vault registry discovers, creates and isolates Vault roots", async () => {
  const inventory = await registry.listWebVaults();
  assert.deepEqual(inventory.vaults.map((item) => item.id), ["main", "research"]);
  assert.equal(inventory.canCreate, true);
  const main = await registry.resolveWebVault("main");
  const notes = await registry.listWebNotes(main, "Home");
  assert.equal(notes.notes[0].path, "Home.md");

  const metadata = await registry.statWebNote(main, "Home");
  assert.equal(metadata.path, "Home.md");
  assert.equal("content" in metadata, false);
  assert.equal("absolute" in metadata, false);

  // Empty-query explorer loads must stay metadata-only: malformed frontmatter
  // should not force the tree path through front matter/YAML parsing.
  await fs.writeFile(path.join(primary, "Broken.md"), "---\n[broken\n---\n# Still visible in tree\n", "utf8");
  const tree = await registry.listWebNotes(main, "");
  assert.ok(tree.notes.some((item) => item.path === "Broken.md"));
  assert.deepEqual(tree.notes.find((item) => item.path === "Home.md")?.tags, []);

  const created = await registry.createWebVault("Projects");
  assert.equal(created.id, "Projects");
  const written = await registry.writeWebNote(created, "Roadmap.md", "# Roadmap\n");
  assert.equal(written.created, true);
  assert.match((await registry.readWebNote(created, "Roadmap.md")).content, /Roadmap/);
  await assert.rejects(() => registry.resolveWebVaultPath(created, "../main/Home.md"), /Invalid Vault path|traversal/i);
});


test("Web search isolates malformed frontmatter to the affected note", async () => {
  const main = await registry.resolveWebVault("main");
  await fs.writeFile(
    path.join(primary, "Malformed-search.md"),
    "---\n[broken\n---\n# malformed-token survives\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(primary, "Healthy-search.md"),
    "# healthy-token survives\n",
    "utf8",
  );

  const healthy = await registry.listWebNotes(main, "healthy-token");
  assert.ok(healthy.notes.some((item) => item.path === "Healthy-search.md"));

  const malformed = await registry.listWebNotes(main, "malformed-token");
  assert.ok(malformed.notes.some((item) => item.path === "Malformed-search.md"));
});


test("Web internal-link resolution reuses canonical relative, basename and alias semantics", async () => {
  const main = await registry.resolveWebVault("main");
  await fs.mkdir(path.join(primary, "Projects"), { recursive: true });
  await fs.mkdir(path.join(primary, "Archive"), { recursive: true });
  await fs.writeFile(path.join(primary, "Projects", "Source.md"), "# Source\n", "utf8");
  await fs.writeFile(path.join(primary, "Projects", "Target.md"), "---\naliases: [Alias Target]\n---\n# Project Target\n", "utf8");
  await fs.writeFile(path.join(primary, "Archive", "Target.md"), "# Archive Target\n", "utf8");

  const nearest = await registry.resolveWebNoteLink(main, "Projects/Source.md", "Target");
  assert.equal(nearest.path, "Projects/Target.md");
  assert.equal(nearest.status, "resolved");
  assert.deepEqual(nearest.candidates, ["Projects/Target.md"]);

  const alias = await registry.resolveWebNoteLink(main, "Projects/Source.md", "Alias Target");
  assert.equal(alias.status, "resolved");
  assert.equal(alias.path, "Projects/Target.md");

  const relative = await registry.resolveWebNoteLink(main, "Projects/Source.md", "../Home.md");
  assert.equal(relative.status, "resolved");
  assert.equal(relative.path, "Home.md");

  const sameNote = await registry.resolveWebNoteLink(main, "Projects/Source.md", "");
  assert.equal(sameNote.status, "resolved");
  assert.equal(sameNote.path, "Projects/Source.md");
});
