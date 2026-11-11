// The folder walker: what a published folder lists, its opaque per-item tokens, and the
// caps that refuse a folder before the registry writes (folder publish, task 4).
//
// The visibility table itself is pinned by test/publish-visibility.test.js; this file pins
// that the walk applies it, that a token is derived from the record id plus the path, and
// that both caps answer with the codes Task 3 declared.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-listing-"));
const vaultPath = path.join(root, "vault");
process.env.VAULT_PATH = vaultPath;
process.env.DATA_PATH = path.join(root, "data");
delete process.env.WEB_VAULTS_ROOT;

const writeNote = async (relPath, body) => {
  await fs.mkdir(path.dirname(path.join(vaultPath, relPath)), { recursive: true });
  await fs.writeFile(path.join(vaultPath, relPath), body, "utf8");
};

await writeNote("Dir/a.md", "# A\n");
await writeNote("Dir/b.md", "---\npublish: false\n---\n# B\n");
await writeNote("Dir/c.md", "---\npublish: true\n---\n# C\n");
await writeNote("Dir/_drafts/d.md", "# D\n");
await writeNote("Dir/_drafts/e.md", "---\npublish: true\n---\n# E\n");
await writeNote("Dir/我的 笔记#1.md", "---\ntitle: 我的笔记\n---\n# Mixed\n");
// A public note outside the folder: only a parsed path could ever reach it.
await writeNote("secret.md", "---\npublish: true\n---\n# Secret\n");
for (let index = 0; index < 501; index += 1) {
  await writeNote(`Dir2/n${String(index).padStart(3, "0")}.md`, "# n\n");
}
await writeNote(`Deep/${Array.from({ length: 9 }, (_, i) => `d${i + 1}`).join("/")}/x.md`, "# deep\n");
await writeNote(`Shallow/${Array.from({ length: 8 }, (_, i) => `d${i + 1}`).join("/")}/x.md`, "# shallow\n");
// 500 public notes, then one public note 9 levels down: both caps would fire.
for (let index = 0; index < 500; index += 1) {
  await writeNote(`Capped/a${String(index).padStart(3, "0")}.md`, "# a\n");
}
await writeNote(`Capped/z/${Array.from({ length: 9 }, (_, i) => `d${i + 1}`).join("/")}/x.md`, "# deep\n");
// A directory nobody can read, next to a note everybody can.
await writeNote("Guarded/open.md", "# open\n");
await writeNote("Guarded/locked/hidden.md", "# hidden\n");
await fs.chmod(path.join(vaultPath, "Guarded", "locked"), 0o000);
// A deep asset tree: no note is that deep, so nothing here may refuse the publish.
await writeNote("Assets/index.md", "# assets\n");
await writeNote(`Assets/${Array.from({ length: 12 }, (_, i) => `d${i + 1}`).join("/")}/pic.png`, "png\n");
// The scanned budget: 2.500 private notes between two visible ones. The late visible note
// sits past the budget, so a listed index proves the walk stopped instead of reading all.
await writeNote("Bulk/aaa-first.md", "# first\n");
for (let index = 0; index < 2500; index += 1) {
  await writeNote(`Bulk/b${String(index).padStart(4, "0")}.md`, "---\npublish: false\n---\n# b\n");
}
await writeNote("Bulk/zzz-last.md", "# last\n");

const { assertWithinCaps, DEFAULT_FOLDER_LIMITS, folderToken, listVisibleNotes, resolveToken } = await import("../src/publish/folder-listing.js");
const { resolveCanonicalVault } = await import("../src/app/vault-registry.js");
const { PublishService } = await import("../src/publish/service.js");

const vault = await resolveCanonicalVault("default");
const vaultId = "default";
const id = "F".repeat(43);
const limits = { maxNotes: 500, maxDepth: 8 };
const stateFile = path.join(root, "data", "publish", "state.json");
const service = new PublishService({ file: stateFile });
const list = (overrides = {}) => listVisibleNotes({ vault, folderPath: "Dir", folderId: id, limits, ...overrides });
const resolve = (token, overrides = {}) => resolveToken({ vault, folderPath: "Dir", folderId: id, token, limits, ...overrides });

test.after(async () => {
  await fs.chmod(path.join(vaultPath, "Guarded", "locked"), 0o755).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

test("the index lists visible notes and hides the rest", async () => {
  const { notes, truncated } = await list();
  assert.deepEqual(notes.map((note) => note.relPath).sort(), ["_drafts/e.md", "a.md", "c.md", "我的 笔记#1.md"]);
  assert.equal(truncated, false);
  assert.equal(notes.find((note) => note.relPath === "a.md").path, "Dir/a.md", "a note keeps its Vault path");
  assert.equal(notes.find((note) => note.relPath === "我的 笔记#1.md").title, "我的笔记", "a declared title wins");
  assert.equal(notes.find((note) => note.relPath === "a.md").title, "a", "a silent note is titled by its file name");
  assert.equal(DEFAULT_FOLDER_LIMITS.maxNotes, 500);
});

test("a token round-trips and never matches another record", async () => {
  const token = folderToken(id, "Dir/a.md");
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  const entry = await resolve(token);
  assert.equal(entry.path, "Dir/a.md");
  assert.equal((await resolve(folderToken(id, "Dir/_drafts/e.md"))).path, "Dir/_drafts/e.md", "publish: true wins inside a draft subtree");
  assert.equal(await resolve(token, { folderId: "other" }), null);
});

test("a path with a space, a # and non-ASCII round-trips", async () => {
  const token = folderToken(id, "Dir/我的 笔记#1.md");
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  assert.equal((await resolve(token)).path, "Dir/我的 笔记#1.md");
});

test("a private note and a traversal attempt resolve to nothing", async () => {
  assert.equal(await resolve(folderToken(id, "Dir/b.md")), null, "publish: false hides the note and its token");
  assert.equal(await resolve(folderToken(id, "Dir/_drafts/d.md")), null, "a draft subtree does not inherit");
  assert.equal(await resolve(folderToken(id, "Dir/../secret.md")), null, "a path string is not a token");
  assert.equal(await resolve(folderToken(id, "secret.md")), null, "a note outside the folder is not listed");
  assert.equal(await resolve("../../etc/passwd"), null, "a traversal string is refused before any walk");
});

test("the caps refuse before any write", async () => {
  await service.publish(vaultId, "Dir", { kind: "folder" });
  const before = await fs.readFile(stateFile, "utf8");

  await assert.rejects(
    () => assertWithinCaps({ vault, folderPath: "Dir2", limits }),
    (error) => error.code === "publish_folder_too_large",
  );
  await assert.rejects(
    () => service.publish(vaultId, "Dir2", { kind: "folder" }),
    (error) => error.code === "publish_folder_too_large",
  );
  assert.equal(await fs.readFile(stateFile, "utf8"), before, "a refusal writes nothing");

  await assert.rejects(
    () => assertWithinCaps({ vault, folderPath: "Deep", limits }),
    (error) => error.code === "publish_folder_too_deep",
  );
  await assert.rejects(
    () => service.publish(vaultId, "Deep", { kind: "folder" }),
    (error) => error.code === "publish_folder_too_deep",
  );
  assert.equal(await fs.readFile(stateFile, "utf8"), before, "the depth refusal writes nothing too");

  await assertWithinCaps({ vault, folderPath: "Shallow", limits });
  assert.equal(await service.publish(vaultId, "Shallow", { kind: "folder" }).then((record) => record.kind), "folder");
});

test("the cap truncates a public read, refuses a publish, and stops the walk", async () => {
  const capped = await listVisibleNotes({ vault, folderPath: "Dir2", folderId: id, limits });
  assert.equal(capped.notes.length, 500, "the index lists the first 500 notes");
  assert.equal(capped.truncated, true);
  assert.equal(await resolve(folderToken(id, "Dir2/n500.md"), { folderPath: "Dir2" }), null, "a note beyond the cap has no token");

  // 500 public notes, then one public note 9 levels down: the size cap fires first, so the
  // answer is `too_large`, and the walk stops before that subtree can answer `too_deep`.
  await assert.rejects(
    () => assertWithinCaps({ vault, folderPath: "Capped", limits }),
    (error) => error.code === "publish_folder_too_large",
  );
  const stop = await listVisibleNotes({ vault, folderPath: "Capped", folderId: id, limits });
  assert.equal(stop.notes.length, 500);
  assert.equal(stop.truncated, true, "the deep subtree behind the cap never changed the answer");
});

test("a directory that cannot be read is skipped, and no public read throws", async () => {  const listed = await listVisibleNotes({ vault, folderPath: "Guarded", folderId: id, limits });
  assert.deepEqual(listed.notes.map((note) => note.relPath), ["open.md"], "the readable note is listed, the rest is not");
  assert.equal(listed.truncated, false);
  assert.equal(await resolve(folderToken(id, "Guarded/locked/hidden.md"), { folderPath: "Guarded" }), null);
  assert.equal(await resolve("A".repeat(22), { folderPath: "Guarded" }), null, "no token matches and nothing throws");
});

test("a deep asset tree with no note in it is not too deep", async () => {
  await assertWithinCaps({ vault, folderPath: "Assets", limits });
  const listed = await listVisibleNotes({ vault, folderPath: "Assets", folderId: id, limits });
  assert.deepEqual(listed.notes.map((note) => note.relPath), ["index.md"], "assets are never listed");
  assert.equal(await service.publish(vaultId, "Assets", { kind: "folder" }).then((record) => record.kind), "folder");
});

test("a listing never throws, even when the caller asks for refuse", async () => {
  const listed = await listVisibleNotes({
    vault,
    folderPath: "Dir",
    folderId: id,
    limits: { maxNotes: 1, maxDepth: 8, overflow: "refuse" },
  });
  assert.equal(listed.notes.length, 1, "the cap still truncates");
  assert.equal(listed.truncated, true);
});

// I3: the budget bounds the files READ, not only the notes listed. The walk reads the
// frontmatter of every `.md` file, so a published folder of private notes must truncate.
test("the scanned budget truncates instead of reading every private note", async () => {
  assert.equal(DEFAULT_FOLDER_LIMITS.maxScanned, 2000);
  const listed = await listVisibleNotes({ vault, folderPath: "Bulk", folderId: id });
  assert.equal(listed.truncated, true, "a folder over the budget truncates, it never throws");
  assert.deepEqual(listed.notes.map((note) => note.relPath), ["aaa-first.md"], "the visible note before the budget is listed");
  assert.equal(
    await resolveToken({ vault, folderPath: "Bulk", folderId: id, token: folderToken(id, "Bulk/zzz-last.md") }),
    null,
    "a note past the budget has no token",
  );
});

test("the scanned budget refuses a publish with publish_folder_too_large", async () => {
  await assert.rejects(
    () => assertWithinCaps({ vault, folderPath: "Bulk" }),
    (error) => error.code === "publish_folder_too_large",
  );
});
