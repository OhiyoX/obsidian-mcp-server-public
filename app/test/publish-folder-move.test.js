// A record follows the file it names (Task 7).
//
// A server-side rename moves the record, so the published address keeps working; a delete
// leaves the record dead for ever. A rename the service never saw (a Git checkout, another
// tool) must orphan the record and never revive it, even if the old path comes back. The
// registry is a consequence of the file operation: when it fails, the rename or delete still
// succeeds and the failure is one log line.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-folder-move-"));
const vaultRoot = path.join(root, "vault");
const data = path.join(root, "data");
const writeNote = async (relPath, body) => {
  await fs.mkdir(path.dirname(path.join(vaultRoot, relPath)), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, relPath), body, "utf8");
};
await writeNote("Dir/a.md", "# A\n");
await writeNote("Dir/n.md", "---\npublish: true\n---\n# Directory note body\n");
await writeNote("Gone/b.md", "# B\n");
await writeNote("Note.md", "---\npublish: true\n---\n# Note\n");
await writeNote("Doomed.md", "---\npublish: true\n---\n# Doomed\n");
await writeNote("Git/g.md", "# G\n");
await writeNote("Keyed/k.md", "# K\n");
await writeNote("Clean/c.md", "# C\n");
await writeNote("Elsewhere.md", "---\npublish: true\n---\n# Elsewhere body\n");

process.env.VAULT_PATH = vaultRoot;
process.env.DATA_PATH = data;
delete process.env.WEB_VAULTS_ROOT;
delete process.env.OBSIDIAN_READ_ONLY;

const [{ renameWebEntry, deleteWebEntry }, { PublishService }, { resolveWebVault }, { withRequestContext }, { createWebAppRouter }] = await Promise.all([
  import("../src/app/web-rename-delete.js"),
  import("../src/publish/service.js"),
  import("../src/app/vault-registry.js"),
  import("../src/request-context.js"),
  import("../src/app/routes.js"),
]);

// The plan engine attributes every write to the MCP author, and the Web routes supply it.
const asWebRequest = (callback) => withRequestContext({ author: { agent: "obsidian-web", model: "human:test" } }, callback);

const vault = await resolveWebVault("default");
const runtime = { id: vault.id, paths: { trash: path.join(data, "trash") } };
const service = new PublishService({ file: path.join(data, "publish", "state.json") });
const provider = { authenticateOAuthUser: async () => null, oauthUserSessionRecord: async () => null, recordAudit() {} };
const app = express().use(createWebAppRouter({ provider, secureCookie: false, publishService: service }));
const server = await new Promise((resolve) => {
  const listening = http.createServer(app).listen(0, "127.0.0.1", () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;
const index = (id) => fetch(`${base}/publish/d/${id}`);

// The plan engine schedules a background index refresh under `data/`, so the teardown retries.
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

test("renaming a published folder keeps the address of the folder and of a marked note inside it", async () => {
  const before = await service.publish(vault.id, "Dir", { kind: "folder" });
  const marked = await service.publish(vault.id, "Dir/n.md");
  await asWebRequest(() => renameWebEntry(vault, runtime, { path: "Dir", to: "Dir2", mutationId: "web-rename:test", publishService: service }));
  const after = await service.resolve(before.id);
  assert.ok(after, "the same id still resolves");
  assert.equal(after.record.path, "Dir2");
  assert.equal((await index(before.id)).status, 200, "the index answers at the moved record");
  const note = await service.resolve(marked.id);
  assert.ok(note, "the marked note under the renamed folder keeps its own id");
  assert.equal(note.record.path, "Dir2/n.md");
  const page = await fetch(`${base}/publish/${marked.id}`);
  assert.equal(page.status, 200, "the note's own address still answers");
  assert.match(await page.text(), /Directory note body/);
});

test("a folder rename leaves a similarly named sibling alone", async () => {
  // `Dir2` is the folder test 1 renamed. A naive `startsWith("Dir")` prefix, without the
  // separator, would move it; the prefix rule must stop at a path boundary.
  await writeNote("Dir2/x.md", "---\npublish: true\n---\n# X body\n");
  const siblingFolder = await service.publish(vault.id, "Dir2", { kind: "folder" });
  const siblingNote = await service.publish(vault.id, "Dir2/x.md");
  await writeNote("Dir/y.md", "# Y\n");
  await service.publish(vault.id, "Dir", { kind: "folder" });
  await asWebRequest(() => renameWebEntry(vault, runtime, { path: "Dir", to: "Dir9", mutationId: "web-rename:sibling", publishService: service }));
  const folder = await service.resolve(siblingFolder.id);
  assert.ok(folder, "a rename of Dir does not touch the Dir2 record");
  assert.equal(folder.record.path, "Dir2");
  assert.equal((await index(siblingFolder.id)).status, 200);
  const note = await service.resolve(siblingNote.id);
  assert.ok(note, "the record under Dir2 keeps its own id");
  assert.equal(note.record.path, "Dir2/x.md");
});

test("a folder rename moves no record outside the folder", async () => {
  const folder = await service.publish(vault.id, "Clean", { kind: "folder" });
  const elsewhere = await service.publish(vault.id, "Elsewhere.md");
  await asWebRequest(() => renameWebEntry(vault, runtime, { path: "Clean", to: "Clean2", mutationId: "web-rename:clean", publishService: service }));
  const movedFolder = await service.resolve(folder.id);
  assert.ok(movedFolder, "the folder record moved");
  assert.equal(movedFolder.record.path, "Clean2");
  const untouched = await service.resolve(elsewhere.id);
  assert.ok(untouched, "the unrelated record keeps its address");
  assert.equal(untouched.record.path, "Elsewhere.md");
});

test("a deleted published folder orphans its record and its index answers 404", async () => {
  const record = await service.publish(vault.id, "Gone", { kind: "folder" });
  assert.equal((await index(record.id)).status, 200);
  await asWebRequest(() => deleteWebEntry(vault, runtime, { path: "Gone", confirm: true, publishService: service }));
  assert.equal(await service.resolve(record.id), null);
  const [stored] = (await service.list({ includeInactive: true })).filter((row) => row.id === record.id);
  assert.equal(stored.lifecycle, "orphaned", "the record's own lifecycle answers, not the walker");
  assert.equal((await index(record.id)).status, 404, "a deleted folder's index answers 404");
});

test("renaming a published note moves its record", async () => {
  const before = await service.publish(vault.id, "Note.md");
  assert.equal(before.created, true);
  await asWebRequest(() => renameWebEntry(vault, runtime, { path: "Note.md", to: "Note2.md", mutationId: "web-rename:note", publishService: service }));
  const after = await service.resolve(before.id);
  assert.ok(after, "the same id still resolves");
  assert.equal(after.record.path, "Note2.md");
});

test("deleting a published note retires its record", async () => {
  const record = await service.publish(vault.id, "Doomed.md");
  await asWebRequest(() => deleteWebEntry(vault, runtime, { path: "Doomed.md", confirm: true, publishService: service }));
  assert.equal(await service.resolve(record.id), null, "the old address answers 404");
  const rows = await service.list({ includeInactive: true });
  assert.equal(rows.some((row) => row.id === record.id), false, "no stale record survives the delete");
});

test("a rename outside the service orphans the record for ever", async () => {
  const record = await service.publish(vault.id, "Git", { kind: "folder" });
  await fs.rename(path.join(vaultRoot, "Git"), path.join(vaultRoot, "Git2"));
  assert.equal(await service.resolve(record.id), null);
  await fs.rename(path.join(vaultRoot, "Git2"), path.join(vaultRoot, "Git"));
  assert.equal(await service.resolve(record.id), null, "re-creating the old path does not revive the record");
});

test("a record update that fails never fails the user's rename or delete", async () => {
  const broken = {
    moveRecord: async () => { throw new Error("registry down"); },
    revoke: async () => { throw new Error("registry down"); },
  };
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await asWebRequest(() => renameWebEntry(vault, runtime, { path: "Keyed", to: "Keyed2", mutationId: "web-rename:broken", publishService: broken }));
    await asWebRequest(() => deleteWebEntry(vault, runtime, { path: "Keyed2/k.md", confirm: true, publishService: broken }));
  } finally {
    console.error = original;
  }
  assert.equal((await fs.stat(path.join(vaultRoot, "Keyed2"))).isDirectory(), true, "the folder rename landed");
  await assert.rejects(fs.stat(path.join(vaultRoot, "Keyed2", "k.md")), { code: "ENOENT" }, "the note delete landed");
  assert.equal(logged.length, 2);
  assert.match(logged[0], /Publish record update failed \(Keyed -> Keyed2\)/);
});

test("a dead record under a renamed folder keeps its dead row", async () => {
  await writeNote("Anc/dead.md", "---\npublish: true\n---\n# Dead\n");
  const dead = await service.publish(vault.id, "Anc/dead.md");
  // The note leaves the folder outside the service, so its record is orphaned, not revived.
  await fs.rename(path.join(vaultRoot, "Anc", "dead.md"), path.join(vaultRoot, "Anc", "now-here.md"));
  assert.equal(await service.resolve(dead.id), null);
  await service.publish(vault.id, "Anc", { kind: "folder" });
  await asWebRequest(() => renameWebEntry(vault, runtime, { path: "Anc", to: "Anc2", mutationId: "web-rename:dead", publishService: service }));
  const row = (await service.list({ includeInactive: true })).find((item) => item.id === dead.id);
  assert.ok(row, "the dead row survives the move, so Admin can still clean it up");
  assert.equal(row.path, "Anc2/dead.md");
  assert.equal(row.lifecycle, "orphaned");
  assert.equal(await service.resolve(dead.id), null, "a moved dead row never revives");
});

test("a dead record already at the destination is dropped, so one key holds one record", async () => {
  await writeNote("Dest.md", "---\npublish: true\n---\n# Dest\n");
  const stale = await service.publish(vault.id, "Dest.md");
  await fs.rename(path.join(vaultRoot, "Dest.md"), path.join(vaultRoot, "Dest-away.md"));
  assert.equal(await service.resolve(stale.id), null);
  await writeNote("Src.md", "---\npublish: true\n---\n# Src\n");
  const live = await service.publish(vault.id, "Src.md");
  await asWebRequest(() => renameWebEntry(vault, runtime, { path: "Src.md", to: "Dest.md", mutationId: "web-rename:dest", publishService: service }));
  const rows = (await service.list({ includeInactive: true })).filter((item) => item.path === "Dest.md");
  assert.deepEqual(rows.map((item) => item.id), [live.id], "the stale row made room for the moved one");
  assert.equal(rows[0].lifecycle, "active");
  assert.equal(await service.resolve(stale.id), null);
});
