// Public view counting (Admin 「访问统计」): a record counts one view per *served* public page.
//
// The counter is a field of the record (`views`, `lastViewedAt`), so it must survive a restart,
// and it must count nothing that was not served: a malformed id, another record's id, a foreign
// token, a retired record and a revoked (removed) record all answer 404 and add nothing.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-view-count-"));
const vaultPath = path.join(root, "vault");
process.env.VAULT_PATH = vaultPath;
process.env.DATA_PATH = path.join(root, "data");
delete process.env.WEB_VAULTS_ROOT;

const writeNote = async (relPath, body) => {
  await fs.mkdir(path.dirname(path.join(vaultPath, relPath)), { recursive: true });
  await fs.writeFile(path.join(vaultPath, relPath), body, "utf8");
};

await writeNote("doc.md", "# Document body\n");
await writeNote("Dir/a.md", "---\ntitle: 我的笔记\n---\n# A body\n");
await writeNote("Late.md", "# Late body\n");
await writeNote("Bye.md", "# Bye body\n");

const [{ createWebAppRouter }, { PublishService }, { folderToken }] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/publish/service.js"),
  import("../src/publish/folder-listing.js"),
]);

const provider = {
  authenticateOAuthUser: async () => null,
  oauthUserSessionRecord: async () => null,
  recordAudit() {},
};

const stateFile = path.join(root, "data", "publish", "state.json");
const service = new PublishService({ file: stateFile });
const doc = await service.publish("default", "doc.md");
const folder = await service.publish("default", "Dir", { kind: "folder" });

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve(server));
  });
}

const server = await listen(express().use(createWebAppRouter({ provider, secureCookie: false, publishService: service })));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (urlPath) => fetch(`${base}${urlPath}`);

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

// `list()` flushes the debounced write, so it is also the Admin read path under test.
async function recordsOf(target = service) {
  return target.list({ includeInactive: true });
}

function viewsOf(records, id) {
  const record = records.find((item) => item.id === id);
  assert.ok(record, `record ${id} is listed`);
  return record.views;
}

test("each served public route counts one view, and stamps lastViewedAt", async () => {
  assert.equal((await get(`/publish/${doc.id}`)).status, 200, "document page");
  assert.equal((await get(`/publish/d/${folder.id}`)).status, 200, "folder index");
  assert.equal((await get(`/publish/d/${folder.id}/n/${folderToken(folder.id, "Dir/a.md")}`)).status, 200, "folder note");

  const records = await recordsOf();
  assert.equal(viewsOf(records, doc.id), 1, "one document page = one view");
  assert.equal(viewsOf(records, folder.id), 2, "the index and one note = two views");
  const viewed = records.find((item) => item.id === doc.id);
  assert.ok(Date.parse(viewed.lastViewedAt) > 0, "lastViewedAt is a timestamp");
  assert.equal(Date.parse(records.find((item) => item.id === folder.id).lastViewedAt) > 0, true);
});

test("a page that is not served counts nothing", async () => {
  const before = await recordsOf();
  assert.equal((await get(`/publish/${"A".repeat(43)}`)).status, 404, "an unknown id");
  assert.equal((await get(`/publish/${folder.id}`)).status, 404, "a folder id on the document route");
  assert.equal((await get(`/publish/d/${doc.id}`)).status, 404, "a document id on the folder route");
  assert.equal((await get(`/publish/d/${folder.id}/n/${"B".repeat(43)}`)).status, 404, "a forged token");

  const after = await recordsOf();
  assert.equal(viewsOf(after, doc.id), viewsOf(before, doc.id), "the document count did not move");
  assert.equal(viewsOf(after, folder.id), viewsOf(before, folder.id), "the folder count did not move");
});

test("a retired record counts nothing, even while its id is still asked for", async () => {
  const late = await service.publish("default", "Late.md");
  assert.equal((await get(`/publish/${late.id}`)).status, 200, "served once");
  assert.equal(viewsOf(await recordsOf(), late.id), 1);

  await fs.rm(path.join(vaultPath, "Late.md"));
  const retired = (await recordsOf()).find((item) => item.id === late.id);
  assert.notEqual(retired.lifecycle, "active", "a deleted source retires the record");

  assert.equal((await get(`/publish/${late.id}`)).status, 404, "the retired address is gone");
  assert.equal(viewsOf(await recordsOf(), late.id), 1, "a retired record counts nothing more");
});

test("a revoked record has no address left, so it counts nothing", async () => {
  const bye = await service.publish("default", "Bye.md");
  await service.revoke("default", "Bye.md");
  assert.equal((await get(`/publish/${bye.id}`)).status, 404, "the revoked address answers 404");
  assert.equal((await recordsOf()).some((item) => item.id === bye.id), false, "the record is removed, not counted");
});

test("a count survives a restart of the service", async () => {
  await service.flush();
  const reloaded = new PublishService({ file: stateFile });
  const records = await reloaded.list({ includeInactive: true });
  assert.equal(viewsOf(records, doc.id), 1, "the document count is read back from the file");
  assert.equal(viewsOf(records, folder.id), 2, "the folder count is read back from the file");
  assert.ok(Date.parse(records.find((item) => item.id === folder.id).lastViewedAt) > 0);
});

test("the write is debounced until it is flushed", async () => {
  const file = path.join(root, "debounced-state.json");
  const local = new PublishService({ file });
  const record = await local.publish("default", "Dir/a.md");
  await local.flush();
  local.recordView(record.id);
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /lastViewedAt/, "an immediate write would be one write per view");
  await local.flush();
  assert.match(await fs.readFile(file, "utf8"), /lastViewedAt/, "the flush writes the pending count");
});

test("a failed write keeps the count, and the next flush writes it", async () => {
  // The state file's parent is a plain file, so the write cannot land: the count must stay pending
  // instead of vanishing with the failed save.
  const blocked = path.join(root, "blocked");
  await fs.writeFile(blocked, "not a directory\n");
  const local = new PublishService({ file: path.join(blocked, "state.json") });
  await assert.rejects(local.list({ includeInactive: true }), /exists and is not a directory|ENOTDIR/);
  local.data.records.push({ id: "r1", kind: "document", vaultId: "default", path: "doc.md", lifecycle: "active", createdAt: null, updatedAt: null });
  local.recordView("r1");
  await assert.rejects(local.flush(), /EEXIST|ENOTDIR|not a directory/, "the write failure is reported, not swallowed");

  await fs.rm(blocked);
  await local.flush();
  const written = JSON.parse(await fs.readFile(path.join(root, "blocked", "state.json"), "utf8"));
  assert.equal(written.records.find((item) => item.id === "r1").views, 1, "the pending count reached the file on the retry");
});

test("the counters are read back defensively from a hand-written state file", async () => {
  const file = path.join(root, "handwritten-state.json");
  const record = (id, path_, views, lastViewedAt) => ({
    id, kind: "document", vaultId: "default", path: path_, lifecycle: "active",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    ...(views === undefined ? {} : { views }), ...(lastViewedAt === undefined ? {} : { lastViewedAt }),
  });
  const written = (views) => JSON.stringify({ version: 3, records: views });
  const cases = [
    ["a string count is not a count", written([record("str", "doc.md", "7")]), { views: 0, lastViewedAt: null }],
    ["a duplicate id keeps the first entry's count", written([record("dup", "doc.md", 5), record("dup", "doc.md", 9)]), { views: 5 }],
    ["views=0 with a lastViewedAt keeps the time", written([record("zero", "doc.md", 0, "2026-11-01T00:00:00.000Z")]), { views: 0, lastViewedAt: "2026-11-01T00:00:00.000Z" }],
  ];
  for (const [name, json, expected] of cases) {
    await fs.writeFile(file, json);
    const local = new PublishService({ file });
    const [loaded] = await local.list({ includeInactive: true });
    for (const [field, value] of Object.entries(expected)) assert.equal(loaded[field], value, name);
  }
});
