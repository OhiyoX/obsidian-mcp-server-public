// A folder record passes the lifecycle planners (folder publish, task 3).
//
// The point of this file is the second half of the requirement: a directory must never
// become `invalid`. The whole service runs against a real temporary Vault, so these are
// the production probes (`probeRecordTarget`, `normalizePublishTarget`) on real `stat`s.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-folder-"));
const vault = path.join(tmp, "vault");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(tmp, "data");
delete process.env.WEB_VAULTS_ROOT;

await fs.mkdir(path.join(vault, "Dir", "sub"), { recursive: true });
await fs.mkdir(path.join(vault, "Dir", "_drafts"), { recursive: true });
await fs.writeFile(path.join(vault, "Dir", "a.md"), "# A\n", "utf8");
await fs.writeFile(path.join(vault, "Dir", "sub", "b.md"), "# B\n", "utf8");
await fs.writeFile(path.join(vault, "Dir", "_drafts", "c.md"), "# C\n", "utf8");

const { PublishService } = await import("../src/publish/service.js");

const vaultId = "default";
const service = new PublishService({ file: path.join(tmp, "publish", "state.json") });

test.after(() => fs.rm(tmp, { recursive: true, force: true }));

let id = null;

test("publishing a directory creates a folder record that stays active", async () => {
  const published = await service.publish(vaultId, "Dir", { kind: "folder" });
  assert.equal(published.kind, "folder");
  assert.equal(published.path, "Dir", "a folder path keeps no .md suffix");
  assert.match(published.id, /^[A-Za-z0-9_-]{43}$/);
  id = published.id;

  const again = await service.resolve(id);
  assert.equal(again.record.lifecycle, "active", "a directory is never invalid");

  const status = await service.status(vaultId, "Dir");
  assert.equal(status.record.kind, "folder", "status reports the folder record for a directory path");
  assert.equal(status.note.path, "Dir");
});

test("a missing published directory becomes orphaned and never revives", async () => {
  await fs.rm(path.join(vault, "Dir"), { recursive: true });
  assert.equal(await service.resolve(id), null);
  await fs.mkdir(path.join(vault, "Dir"));
  assert.equal(await service.resolve(id), null, "an orphaned record is dead for ever");
});

test("publishing the same directory twice keeps one record", async () => {
  const [a, b] = await Promise.all([
    service.publish(vaultId, "Dir", { kind: "folder" }),
    service.publish(vaultId, "Dir", { kind: "folder" }),
  ]);
  assert.equal(a.kind, "folder");
  assert.equal(a.id, b.id);
  id = a.id;
});

test("unpublishing a folder deletes the record and the address 404s", async () => {
  const revoked = await service.revoke(vaultId, "Dir");
  assert.equal(revoked.revoked, true, "revoke finds the folder record by its directory path");
  assert.equal(await service.resolve(id), null);
  const records = await service.list({ vaultIds: [vaultId], includeInactive: true });
  assert.equal(records.filter((record) => record.path === "Dir").length, 0, "no tombstone is written");
});

test("a document record whose file became a directory is still invalid", async () => {
  await fs.writeFile(path.join(vault, "Dir", "note.md"), "# Note\n", "utf8");
  const published = await service.publish(vaultId, "Dir/note.md");
  assert.equal(published.kind, "document");
  await fs.rm(path.join(vault, "Dir", "note.md"));
  await fs.mkdir(path.join(vault, "Dir", "note.md"));
  assert.equal(await service.resolve(published.id), null, "a directory never serves a document record");
  const listed = await service.list({ vaultIds: [vaultId], includeInactive: true });
  assert.equal(listed.find((record) => record.id === published.id).lifecycle, "invalid");
});

test("a folder and a document at the same path both survive a reload", async () => {
  const sharedPath = "Same.md";
  const file = path.join(tmp, "publish", "state.json");
  await fs.mkdir(path.join(vault, sharedPath), { recursive: true });
  const folder = await service.publish(vaultId, sharedPath, { kind: "folder" });
  assert.equal(folder.path, sharedPath, "a directory may be named like a note");

  // The directory becomes a Markdown file of the same name: a second record, not a replacement.
  await fs.rm(path.join(vault, sharedPath), { recursive: true });
  await fs.writeFile(path.join(vault, sharedPath), "# Same\n", "utf8");
  const document = await service.publish(vaultId, sharedPath, { kind: "document" });
  assert.equal(document.kind, "document");
  assert.notEqual(document.id, folder.id);

  const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(
    onDisk.records.filter((record) => record.path === sharedPath).map((record) => record.kind).sort(),
    ["document", "folder"],
    "one path holds two records, told apart by kind",
  );

  // The load must keep both: the document record answers while the file is there, the folder
  // record answers after the directory is back, each by its own id.
  const reloaded = new PublishService({ file });
  await reloaded.ready;
  const documentHit = await reloaded.resolve(document.id);
  assert.equal(documentHit.record.kind, "document", "the document record survives the reload");
  assert.match(documentHit.note.content, /# Same/);

  await fs.rm(path.join(vault, sharedPath));
  await fs.mkdir(path.join(vault, sharedPath));
  const folderHit = await reloaded.resolve(folder.id);
  assert.equal(folderHit.record.kind, "folder", "the folder record survives the reload");
  assert.equal(folderHit.record.path, sharedPath);
});

test("status answers a directory whose name ends in .md, where the note reader refuses it", async () => {
  await fs.mkdir(path.join(vault, "Status.md"), { recursive: true });
  const published = await service.publish(vaultId, "Status.md", { kind: "folder" });
  const status = await service.status(vaultId, "Status.md");
  assert.equal(status.note.path, "Status.md");
  assert.equal(status.record.kind, "folder");
  assert.equal(status.record.id, published.id);
});

test("status keeps refusing an extension-less regular file", async () => {
  await fs.mkdir(path.join(vault, "Docs"), { recursive: true });
  await fs.writeFile(path.join(vault, "Docs", "a"), "text\n", "utf8");
  await assert.rejects(service.status(vaultId, "Docs/a"), (error) => error?.code === "ENOENT");
});

test("a file on the folder path is refused, and a folder cap code is declared", async () => {
  await fs.writeFile(path.join(vault, "Plain"), "not a directory\n", "utf8");
  await assert.rejects(service.publish(vaultId, "Plain", { kind: "folder" }), (error) => error.code === "publish_target_not_a_file");

  const target = await import("../src/publish/target.js");
  const lifecycle = await import("../src/publish/lifecycle.js");
  assert.equal(target.PUBLISH_FOLDER_TOO_LARGE, "publish_folder_too_large");
  assert.equal(target.PUBLISH_FOLDER_TOO_DEEP, "publish_folder_too_deep");
  assert.equal(target.PUBLISH_TARGET_KIND_FOLDER, lifecycle.PUBLISH_RECORD_KINDS.FOLDER, "the target kind matches the record kind");
  assert.equal(target.PUBLISH_TARGET_KIND_DOCUMENT, lifecycle.PUBLISH_RECORD_KINDS.DOCUMENT, "the target kind matches the record kind");
});

// I1: the caller's kind is the one revoke takes, so a folder and a document whose names
// differ only by the `.md` suffix can never retire each other.
test("revoking a folder never retires the document record at the same name plus .md", async () => {
  await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
  await fs.writeFile(path.join(vault, "Notes", "a.md"), "# A\n", "utf8");
  await fs.writeFile(path.join(vault, "Notes.md"), "# Notes\n", "utf8");
  const folder = await service.publish(vaultId, "Notes", { kind: "folder" });
  const document = await service.publish(vaultId, "Notes.md", { kind: "document" });

  const revokedFolder = await service.revoke(vaultId, "Notes", { kind: "folder" });
  assert.equal(revokedFolder.revoked, true);
  assert.equal(revokedFolder.id, folder.id, "the folder record is the one revoked");
  const kept = await service.resolve(document.id);
  assert.equal(kept.record.kind, "document", "the document record survives a folder revoke");

  // The other direction: revoke the document by kind, and the folder record stays.
  const again = await service.publish(vaultId, "Notes", { kind: "folder" });
  const revokedDocument = await service.revoke(vaultId, "Notes.md", { kind: "document" });
  assert.equal(revokedDocument.id, document.id, "the document record is the one revoked");
  const folderKept = await service.resolve(again.id);
  assert.equal(folderKept.record.kind, "folder", "the folder record survives a document revoke");
});

// I1: an omitted kind keeps the old document-then-folder fallback, so a caller that never
// read a record still finds one.
test("revoke without a kind still falls back from a document to a folder", async () => {
  // `Notes` as a document means `Notes.md`: that record must still be found without a kind.
  const published = await service.publish(vaultId, "Notes.md", { kind: "document" });
  const revoked = await service.revoke(vaultId, "Notes");
  assert.equal(revoked.id, published.id, "no kind keeps the document-first fallback");
});
