// Records carry a `kind` (`document` / `folder`) and the state file is version 3
// (folder publish, task 2). A v2 file loads as documents; a folder record must
// survive a save and a reload, because later tasks add folder records.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migratePublishState, PUBLISH_RECORD_KINDS, STATE_VERSION_TARGET } from "../src/publish/lifecycle.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-kind-"));
const vault = path.join(root, "vault");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
delete process.env.WEB_VAULTS_ROOT;

const { PublishService, STATE_VERSION } = await import("../src/publish/service.js");

test.after(async () => fs.rm(root, { recursive: true, force: true }));

test("the two state-version owners agree", () => {
  assert.equal(STATE_VERSION, STATE_VERSION_TARGET, "service.js must write the version that lifecycle.js targets");
});

test("a v2 record loads as a document and keeps its kind across a save", () => {
  const state = { version: 2, records: [{ id: "a", vaultId: "v", path: "n.md", lifecycle: "active", createdAt: "t", updatedAt: "t" }] };
  const migrated = migratePublishState(state);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.records[0].kind, "document");
});

test("a v3 folder record survives migration", () => {
  const state = { version: 3, records: [{ id: "b", kind: "folder", vaultId: "v", path: "Dir", lifecycle: "active", createdAt: "t", updatedAt: "t" }] };
  const migrated = migratePublishState(state);
  assert.equal(migrated.records[0].kind, PUBLISH_RECORD_KINDS.FOLDER);
});

test("a folder record keeps its kind through a save and a reload", async () => {
  await fs.mkdir(path.join(vault, "Dir"), { recursive: true });
  await fs.writeFile(path.join(vault, "Dir", "Note.md"), "# Note\n", "utf8");
  const file = path.join(root, "data", "publish", "state.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const folderId = "F".repeat(43);
  await fs.writeFile(file, JSON.stringify({
    version: 3,
    records: [{
      id: folderId,
      kind: "folder",
      vaultId: "default",
      path: "Dir",
      lifecycle: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }));

  const service = new PublishService({ file });
  await service.ready;
  const published = await service.publish("default", "Dir/Note.md");
  assert.equal(published.kind, PUBLISH_RECORD_KINDS.DOCUMENT, "a published note is a document record");

  const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(onDisk.version, 3, "the save writes version 3");
  assert.equal(onDisk.records.find((record) => record.id === folderId).kind, "folder", "the save keeps the folder kind");

  const reloaded = new PublishService({ file });
  await reloaded.ready;
  const listed = await reloaded.list({ includeInactive: true });
  assert.equal(listed.find((record) => record.id === folderId).kind, PUBLISH_RECORD_KINDS.FOLDER, "the reload keeps the folder kind");
});
