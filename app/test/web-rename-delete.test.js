import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-rename-delete-"));
const vaultRoot = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vaultRoot, "Projects/deep"), { recursive: true });
await fs.writeFile(path.join(vaultRoot, "Projects/deep/Note.md"), "# hi\n", "utf8");
await fs.writeFile(path.join(vaultRoot, "Top.md"), "# top\n", "utf8");
process.env.VAULT_PATH = vaultRoot;
process.env.DATA_PATH = data;

const { deleteWebEntry, deleteWebFile, deleteWebFolder, entryKind, planFolderLinks, renameWebEntry, renameWebFolder, renameWebNote, WebEntryError } = await import("../src/app/web-rename-delete.js");
const { resolveWebVault } = await import("../src/app/vault-registry.js");
const { withRequestContext } = await import("../src/request-context.js");

// The plan engine attributes every write to the MCP author, and the Web routes supply it
// (`obsidian-web`). A Vault is not named here, so the plan engine serves the primary Vault.
const asWebRequest = (callback) => withRequestContext({ author: { agent: "obsidian-web", model: "human:test" } }, callback);

const vault = { id: "vault", root: vaultRoot, primary: true };
const runtime = { id: "vault", paths: { trash: path.join(data, "trash") } };

// The plan engine schedules a background index refresh under `data/`, so the teardown retries.
test.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));

test("folder delete moves the whole tree into the Vault Trash and keeps its bytes", async () => {
  const result = await deleteWebFolder(vault, runtime, { path: "Projects" });
  assert.equal(result.kind, "folder");
  assert.equal(result.deleted, "Projects");
  assert.equal(result.files, 1);
  await assert.rejects(fs.stat(path.join(vaultRoot, "Projects")), { code: "ENOENT" });
  const trashed = path.join(runtime.paths.trash, result.trash, "Projects/deep/Note.md");
  assert.equal(await fs.readFile(trashed, "utf8"), "# hi\n");
  assert.match(result.trash, /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}$/);
});

test("folder delete refuses the vault root, a traversal path and a missing folder", async () => {
  await assert.rejects(deleteWebFolder(vault, runtime, { path: "" }), { status: 400 });
  await assert.rejects(deleteWebFolder(vault, runtime, { path: "../data" }), { status: 400 });
  await assert.rejects(deleteWebFolder(vault, runtime, { path: "Nope" }), { status: 404 });
  assert.equal((await fs.stat(vaultRoot)).isDirectory(), true);
});

test("folder delete refuses more than 500 files before it writes anything", async () => {
  const big = path.join(vaultRoot, "Big");
  await fs.mkdir(big, { recursive: true });
  for (let index = 0; index < 501; index += 1) await fs.writeFile(path.join(big, `n${index}.md`), "", "utf8");
  const trashedBefore = await fs.readdir(runtime.paths.trash).catch(() => []);
  await assert.rejects(deleteWebFolder(vault, runtime, { path: "Big" }), { status: 413, code: "FOLDER_TOO_LARGE" });
  assert.equal((await fs.stat(big)).isDirectory(), true);
  assert.deepEqual(await fs.readdir(runtime.paths.trash).catch(() => []), trashedBefore);
});

test("a nested folder delete keeps its parent and moves the whole tree into the Trash", async () => {
  await fs.mkdir(path.join(vaultRoot, "Nested/inner/deeper"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Nested/inner/deeper/Note.md"), "# nested\n", "utf8");
  const result = await deleteWebFolder(vault, runtime, { path: "Nested/inner" });
  assert.equal(result.deleted, "Nested/inner");
  assert.equal(result.files, 1);
  await assert.rejects(fs.stat(path.join(vaultRoot, "Nested/inner")), { code: "ENOENT" });
  assert.equal((await fs.stat(path.join(vaultRoot, "Nested"))).isDirectory(), true);
  const trashed = path.join(runtime.paths.trash, result.trash, "Nested/inner/deeper/Note.md");
  assert.equal(await fs.readFile(trashed, "utf8"), "# nested\n");
});

test("a folder delete whose Trash move fails answers 500 and leaves no stamp directory", async () => {
  const folder = path.join(vaultRoot, "Stuck");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "Note.md"), "# stuck\n", "utf8");
  // A regular file where the Trash root should be: the stamp directory can never be created.
  const blocker = path.join(data, "blocker");
  await fs.writeFile(blocker, "", "utf8");
  const brokenRuntime = { id: "vault", paths: { trash: path.join(blocker, "trash") } };
  const dataBefore = await fs.readdir(data);
  await assert.rejects(deleteWebFolder(vault, brokenRuntime, { path: "Stuck" }), { status: 500, code: "TRASH_MOVE_FAILED" });
  assert.equal(await fs.readFile(path.join(folder, "Note.md"), "utf8"), "# stuck\n");
  assert.deepEqual(await fs.readdir(data), dataBefore);
});

test("folder rename keeps a binary byte-identical and rewrites outside links only", async () => {
  await fs.mkdir(path.join(vaultRoot, "Assets/img"), { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await fs.writeFile(path.join(vaultRoot, "Assets/img/pixel.png"), png);
  await fs.writeFile(path.join(vaultRoot, "Assets/a.md"), "see [[Assets/b]] and [[Top]]\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "Assets/b.md"), "inner\n", "utf8");
  const applied = [];
  const result = await renameWebFolder(vault, runtime, {
    from: "Assets", to: "Media",
    applyLinks: async (items) => { applied.push(...items); },
  });
  assert.equal(result.kind, "folder");
  assert.deepEqual(await fs.readFile(path.join(vaultRoot, "Media/img/pixel.png")), png);
  assert.deepEqual(result.updatedLinksIn.sort(), ["Media/a.md"]);
  assert.equal(applied.length, 1);
  // The moved note is written at its new path, never at the path the rename removed.
  assert.equal(applied[0].path, "Media/a.md");
  assert.equal(applied[0].content, "see [[Media/b]] and [[Top]]\n");
});

test("folder rename refuses an existing destination and a destination inside the source", async () => {
  await fs.mkdir(path.join(vaultRoot, "A"), { recursive: true });
  await fs.mkdir(path.join(vaultRoot, "B"), { recursive: true });
  await assert.rejects(renameWebFolder(vault, runtime, { from: "A", to: "B", applyLinks: async () => {} }), { status: 409 });
  await assert.rejects(renameWebFolder(vault, runtime, { from: "A", to: "A/inner", applyLinks: async () => {} }), { status: 400 });
  assert.equal((await fs.stat(path.join(vaultRoot, "A"))).isDirectory(), true);
});

test("folder rename renames an empty folder without a plan item", async () => {
  await fs.mkdir(path.join(vaultRoot, "Empty"), { recursive: true });
  const applied = [];
  await renameWebFolder(vault, runtime, { from: "Empty", to: "StillEmpty", applyLinks: async (items) => applied.push(...items) });
  assert.equal((await fs.stat(path.join(vaultRoot, "StillEmpty"))).isDirectory(), true);
  assert.deepEqual(applied, []);
});

test("folder rename renames back when the link plan fails", async () => {
  await fs.mkdir(path.join(vaultRoot, "Roll"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Roll/x.md"), "x\n", "utf8");
  await assert.rejects(renameWebFolder(vault, runtime, {
    from: "Roll", to: "Rolled",
    applyLinks: async () => { throw new Error("link plan exploded"); },
  }), /link plan exploded/);
  assert.equal((await fs.stat(path.join(vaultRoot, "Roll"))).isDirectory(), true);
  await assert.rejects(fs.stat(path.join(vaultRoot, "Rolled")), { code: "ENOENT" });
});

test("folder rename skips a note above the 2 MiB editor limit", async () => {
  await fs.mkdir(path.join(vaultRoot, "Src"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Src/y.md"), "y\n", "utf8");
  const huge = path.join(vaultRoot, "Huge.md");
  await fs.writeFile(huge, "[[Src/y]]\n" + "x".repeat(2 * 1024 * 1024), "utf8");
  const applied = [];
  const result = await renameWebFolder(vault, runtime, { from: "Src", to: "Src2", applyLinks: async (items) => applied.push(...items) });
  assert.deepEqual(result.updatedLinksIn, []);
  assert.deepEqual(applied, []);
  assert.equal((await fs.readFile(huge, "utf8")).startsWith("[[Src/y]]\n"), true);
});

test("folder rename refuses more than 200 rewritten notes before it renames", async () => {
  await fs.mkdir(path.join(vaultRoot, "Many"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Many/z.md"), "z\n", "utf8");
  const referrers = path.join(vaultRoot, "Referrers");
  await fs.mkdir(referrers, { recursive: true });
  for (let index = 0; index < 201; index += 1) {
    await fs.writeFile(path.join(referrers, `r${index}.md`), "[[Many/z]]\n", "utf8");
  }
  await assert.rejects(renameWebFolder(vault, runtime, { from: "Many", to: "Many2", applyLinks: async () => {} }), { status: 413, code: "LINKS_TOO_MANY" });
  assert.equal((await fs.stat(path.join(vaultRoot, "Many"))).isDirectory(), true);
  await assert.rejects(fs.stat(path.join(vaultRoot, "Many2")), { code: "ENOENT" });
});

test("note rename moves the file, rewrites links and reports the changed notes", async () => {
  await fs.writeFile(path.join(vaultRoot, "From.md"), "# from\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "Referrer.md"), "link [[From]]\n", "utf8");
  const result = await asWebRequest(() => renameWebNote(vault, runtime, { from: "From.md", to: "To.md", mutationId: "m-1" }));
  assert.deepEqual(result, { kind: "note", from: "From.md", to: "To.md", updatedLinksIn: ["Referrer.md"] });
  assert.equal(await fs.readFile(path.join(vaultRoot, "Referrer.md"), "utf8"), "link [[To]]\n");
  await assert.rejects(fs.stat(path.join(vaultRoot, "From.md")), { code: "ENOENT" });
});

test("note rename without an extension keeps .md and refuses an existing target", async () => {
  await fs.writeFile(path.join(vaultRoot, "Alpha.md"), "a\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "Beta.md"), "b\n", "utf8");
  const ok = await asWebRequest(() => renameWebNote(vault, runtime, { from: "Alpha", to: "Gamma", mutationId: "m-2" }));
  assert.equal(ok.to, "Gamma.md");
  await assert.rejects(asWebRequest(() => renameWebNote(vault, runtime, { from: "Gamma", to: "Beta", mutationId: "m-3" })), { status: 409 });
});

test("file delete puts the bytes in the Vault Trash and reports the backup", async () => {
  await fs.mkdir(path.join(vaultRoot, "files"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "files/report.pdf"), Buffer.from("%PDF-1.4", "utf8"));
  const result = await asWebRequest(() => deleteWebFile(vault, runtime, { path: "files/report.pdf" }));
  assert.equal(result.kind, "attachment");
  assert.ok(result.trash.startsWith("files/report.pdf") === false, "trash names the backup, not the old path");
  await assert.rejects(fs.stat(path.join(vaultRoot, "files/report.pdf")), { code: "ENOENT" });
});

test("note delete moves the note into the Trash and keeps its bytes", async () => {
  await fs.writeFile(path.join(vaultRoot, "Gone.md"), "# gone\n", "utf8");
  const result = await asWebRequest(() => deleteWebFile(vault, runtime, { path: "Gone.md" }));
  assert.deepEqual(result, { kind: "note", deleted: "Gone.md", trash: result.trash });
  assert.equal(await fs.readFile(path.join(runtime.paths.trash, result.trash), "utf8"), "# gone\n");
  await assert.rejects(fs.stat(path.join(vaultRoot, "Gone.md")), { code: "ENOENT" });
});

test("file delete refuses a folder path, a missing path and a missing runtime", async () => {
  await assert.rejects(asWebRequest(() => deleteWebFile(vault, runtime, { path: "files" })), { status: 400, message: /folder route/ });
  await assert.rejects(asWebRequest(() => deleteWebFile(vault, runtime, { path: "files/missing.pdf" })), { status: 404 });
  await assert.rejects(asWebRequest(() => deleteWebFile(vault, null, { path: "Gone.md" })), { status: 503, code: "vault_unavailable" });
  assert.equal((await fs.stat(path.join(vaultRoot, "files"))).isDirectory(), true);
});

test("note rename compares ifMatch against the note revision and refuses a protected path", async () => {
  await fs.writeFile(path.join(vaultRoot, "Rev.md"), "# rev\n", "utf8");
  const revision = `sha256:${createHash("sha256").update("# rev\n").digest("hex")}`;
  const ok = await asWebRequest(() => renameWebNote(vault, runtime, { from: "Rev.md", to: "Rev2.md", ifMatch: revision, mutationId: "m-4" }));
  assert.equal(ok.to, "Rev2.md");
  await assert.rejects(asWebRequest(() => renameWebNote(vault, runtime, { from: "Rev2.md", to: "Rev3.md", ifMatch: "sha256:stale", mutationId: "m-5" })), { status: 409, code: "REVISION_CONFLICT" });
  await assert.rejects(asWebRequest(() => renameWebNote(vault, runtime, { from: ".obsidian/app.json", to: "app.json", mutationId: "m-6" })), { status: 400 });
  assert.equal(await fs.readFile(path.join(vaultRoot, "Rev2.md"), "utf8"), "# rev\n");
});

test("a note rename that would rewrite too many notes answers 413, not 500", async () => {
  await fs.mkdir(path.join(vaultRoot, "Links"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Links/Hub.md"), "# hub\n", "utf8");
  // The plan engine refuses a move that touches more than 25 notes.
  for (let index = 0; index < 26; index += 1) {
    await fs.writeFile(path.join(vaultRoot, `Links/N${index}.md`), `[[Links/Hub]]\n`, "utf8");
  }
  await assert.rejects(
    asWebRequest(() => renameWebNote(vault, runtime, { from: "Links/Hub.md", to: "Links/Core.md", mutationId: "m-25" })),
    { status: 413, code: "TOO_MANY_LINK_NOTES" },
  );
  assert.equal(await fs.readFile(path.join(vaultRoot, "Links/Hub.md"), "utf8"), "# hub\n", "nothing moved");
});

test("a vault above the scan bound refuses a folder rename before lifting it", async () => {
  // 51 x 99 = 5049 notes, spread so no single folder trips the 500-file cap first.
  for (let part = 0; part < 51; part += 1) {
    const dir = path.join(vaultRoot, "Bulk", `Part${part}`);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 99 }, (_, index) => fs.writeFile(path.join(dir, `N${index}.md`), "x\n")));
  }
  await fs.mkdir(path.join(vaultRoot, "Small"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Small/One.md"), "# one\n", "utf8");
  await assert.rejects(
    asWebRequest(() => renameWebFolder(vault, runtime, { from: "Small", to: "Smaller", applyLinks: async () => {} })),
    { status: 413, code: "TOO_MANY_NOTES" },
  );
  assert.equal(await fs.stat(path.join(vaultRoot, "Small")).then((info) => info.isDirectory()), true, "the folder did not move");
});

test("entryKind names a folder, a note and an attachment", async () => {
  await fs.writeFile(path.join(vaultRoot, "Kind.md"), "k\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "files/kind.bin"), "k", "utf8");
  assert.equal(await entryKind(path.join(vaultRoot, "files")), "folder");
  assert.equal(await entryKind(path.join(vaultRoot, "Kind.md")), "note");
  assert.equal(await entryKind(path.join(vaultRoot, "files/kind.bin")), "attachment");
  assert.equal(await entryKind(vaultRoot), "folder");
});

test("a rename without a caller key is refused before anything moves", async () => {
  await fs.mkdir(path.join(vaultRoot, "Keyed"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Keyed/One.md"), "# one\n", "utf8");
  await assert.rejects(asWebRequest(() => renameWebEntry(vault, runtime, { path: "Keyed", to: "Keyed2" })), { status: 400, code: "MUTATION_ID_REQUIRED" });
  assert.equal(await fs.readFile(path.join(vaultRoot, "Keyed/One.md"), "utf8"), "# one\n");
});
