import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * LP-13: process-local serialization for all Web writeWebNote paths (primary + secondary).
 *
 * These tests prove same-process concurrent create / same-base CAS behavior.
 * They do NOT claim cross-process compare-and-swap: MCP tools, another Node process,
 * Syncthing, Git, or Obsidian desktop are not coordinated by this lock.
 */

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-vault-concurrency-"));
const vaultsRoot = path.join(root, "vaults");
const primary = path.join(vaultsRoot, "main");
await fs.mkdir(path.join(primary, ".obsidian"), { recursive: true });
await fs.mkdir(path.join(vaultsRoot, "research", ".obsidian"), { recursive: true });
await fs.writeFile(path.join(primary, "Home.md"), "# Home\n", "utf8");
process.env.VAULT_PATH = primary;
process.env.DATA_PATH = path.join(root, "data");
process.env.WEB_VAULTS_ROOT = vaultsRoot;
process.env.WEB_DEFAULT_VAULT = "main";
process.env.OBSIDIAN_READ_ONLY = "false";

const registry = await import(`../src/app/vault-registry.js?test=${Date.now()}`);
const { withRequestContext } = await import("../src/request-context.js");
const { __resetWebCatalogRuntimesForTests } = await import("../src/app/web-catalog/runtime.js");
after(() => {
  // #428: the catalog is `<DATA_PATH>/web-catalog` now, i.e. inside this test's temp root. Close
  // every store before removing it (Windows keeps a live SQLite handle busy).
  __resetWebCatalogRuntimesForTests();
  return fs.rm(root, { recursive: true, force: true });
});

const authored = (callback) => withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, callback);

test("LP-13: concurrent same-base secondary writes allow exactly one success", async () => {
  const vault = await registry.resolveWebVault("research");
  const created = await registry.writeWebNote(vault, "Race.md", "# base\n");
  assert.equal(created.created, true);
  const baseRevision = created.revision;

  const results = await Promise.allSettled([
    registry.writeWebNote(vault, "Race.md", "# writer-a\n", baseRevision),
    registry.writeWebNote(vault, "Race.md", "# writer-b\n", baseRevision),
  ]);

  const fulfilled = results.filter((item) => item.status === "fulfilled");
  const rejected = results.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Revision conflict/);

  const onDisk = await fs.readFile(path.join(vault.root, "Race.md"), "utf8");
  assert.match(onDisk, /^# writer-[ab]\n$/);
  assert.equal((await registry.readWebNote(vault, "Race.md")).revision, fulfilled[0].value.revision);
});

test("LP-13: concurrent secondary creates allow exactly one success", async () => {
  const vault = await registry.resolveWebVault("research");
  const results = await Promise.allSettled([
    registry.writeWebNote(vault, "CreateRace.md", "# create-a\n"),
    registry.writeWebNote(vault, "CreateRace.md", "# create-b\n"),
  ]);

  const fulfilled = results.filter((item) => item.status === "fulfilled");
  const rejected = results.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Existing notes require a revision|Revision conflict/);

  const onDisk = await fs.readFile(path.join(vault.root, "CreateRace.md"), "utf8");
  assert.match(onDisk, /^# create-[ab]\n$/);
  assert.equal(fulfilled[0].value.created, true);
});

test("LP-13: concurrent primary creates allow exactly one success (Web lock)", async () => {
  const vault = await registry.resolveWebVault("main");
  assert.equal(vault.primary, true);

  const results = await Promise.allSettled([
    authored(() => registry.writeWebNote(vault, "PrimaryCreateRace.md", "# primary-a\n")),
    authored(() => registry.writeWebNote(vault, "PrimaryCreateRace.md", "# primary-b\n")),
  ]);

  const fulfilled = results.filter((item) => item.status === "fulfilled");
  const rejected = results.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Existing notes require a revision|Revision conflict/);

  const onDisk = await fs.readFile(path.join(vault.root, "PrimaryCreateRace.md"), "utf8");
  assert.match(onDisk, /^# primary-[ab]\n$/);
  assert.equal(fulfilled[0].value.created, true);
});

test("LP-13: concurrent primary same-base CAS allows exactly one success", async () => {
  const vault = await registry.resolveWebVault("main");
  const created = await authored(() => registry.writeWebNote(vault, "PrimaryRace.md", "# base\n"));
  const baseRevision = created.revision;

  const results = await Promise.allSettled([
    authored(() => registry.writeWebNote(vault, "PrimaryRace.md", "# writer-a\n", baseRevision)),
    authored(() => registry.writeWebNote(vault, "PrimaryRace.md", "# writer-b\n", baseRevision)),
  ]);

  const fulfilled = results.filter((item) => item.status === "fulfilled");
  const rejected = results.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1, rejected.map((item) => item.reason?.message).join("; "));
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Revision conflict/);
});

test("LP-13: canonical lock keys collapse Windows case and symlink aliases", async () => {
  const vault = await registry.resolveWebVault("research");
  const direct = await registry.webNoteWriteLockKeyForTests(vault.root, "Alias.md");
  const resolvedRoot = await fs.realpath(vault.root);
  const viaRealpath = await registry.webNoteWriteLockKeyForTests(resolvedRoot, "Alias.md");
  assert.equal(direct, viaRealpath);

  if (process.platform === "win32") {
    const mixedCase = await registry.webNoteWriteLockKeyForTests(vault.root, "alias.MD");
    assert.equal(direct, mixedCase);
  }

  const linkDir = path.join(root, "research-link");
  try {
    await fs.symlink(vault.root, linkDir, process.platform === "win32" ? "junction" : "dir");
    const viaLink = await registry.webNoteWriteLockKeyForTests(linkDir, "Alias.md");
    assert.equal(direct, viaLink);
  } catch (error) {
    // Symlink/junction may be unavailable in some CI sandboxes; realpath equality above still holds.
    if (!/EPERM|EACCES|unsupported/i.test(String(error?.message || error))) throw error;
  }
});

test("LP-13 documents process-local only (no cross-process or MCP CAS guarantee)", () => {
  // Intentionally no multi-process / MCP writer here: the registry lock is in-memory.
  // External writers remain outside this guarantee; recovery relies on history/backups.
  assert.equal(typeof registry.writeWebNote, "function");
});
