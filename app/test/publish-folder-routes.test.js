// The three public Publish routes (folder publish, task 5).
//
// `/publish/:id` serves one document record; `/publish/d/:id` serves the index of a folder
// record and `/publish/d/:id/n/:token` serves one visible note of it. The point of this file
// is the negative half: a private note, a foreign token, a traversing token, a malformed id
// and a sibling of a `publish: true` note each answer 404 and never a 500 or an empty page.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-folder-routes-"));
const vaultPath = path.join(root, "vault");
process.env.VAULT_PATH = vaultPath;
process.env.DATA_PATH = path.join(root, "data");
delete process.env.WEB_VAULTS_ROOT;

const writeNote = async (relPath, body) => {
  await fs.mkdir(path.dirname(path.join(vaultPath, relPath)), { recursive: true });
  await fs.writeFile(path.join(vaultPath, relPath), body, "utf8");
};

await writeNote("Dir/a.md", "---\ntitle: 我的笔记\n---\n# A body\n");
await writeNote("Dir/b.md", "---\npublish: false\n---\n# B private body\n");
await writeNote("Dir/_drafts/c.md", "# C draft body\n");
await writeNote("Dir2/a.md", "# Another folder body\n");
// A `publish: true` note in a folder that is NOT published: it stands alone.
await writeNote("Free/only.md", "---\npublish: true\n---\n# Only body\n");
await writeNote("Free/other.md", "# Sibling secret body\n");
await writeNote("secret.md", "---\npublish: true\n---\n# Secret body\n");

const [{ createWebAppRouter }, { PublishService }, { folderToken }] = await Promise.all([
  import("../src/app/routes.js"),
  import("../src/publish/service.js"),
  import("../src/publish/folder-listing.js"),
]);
const { capabilityForBoundary } = await import("../src/authorization/catalog.js");
const { catalogFor } = await import("../src/i18n/index.js");

const provider = {
  authenticateOAuthUser: async () => null,
  oauthUserSessionRecord: async () => null,
  recordAudit() {},
};

const vaultId = "default";
const service = new PublishService({ file: path.join(root, "data", "publish", "state.json") });
const folder = await service.publish(vaultId, "Dir", { kind: "folder" });
const otherFolder = await service.publish(vaultId, "Dir2", { kind: "folder" });
const documentRecord = await service.publish(vaultId, "Free/only.md");
const { id } = folder;
const otherId = otherFolder.id;
const tokenOf = (vaultPathname) => folderToken(id, vaultPathname);

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

test("the index lists visible notes only, and keeps its public headers", async () => {
  const res = await get(`/publish/d/${id}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /我的笔记/, "a visible note is listed by its title");
  assert.match(body, new RegExp(`/publish/d/${id}/n/${tokenOf("Dir/a.md")}`), "the link is the note's token, never its path");
  assert.doesNotMatch(body, /b\.md/, "a private note is never listed");
  assert.doesNotMatch(body, /B private body/, "a private note's title never reaches the index");
  assert.doesNotMatch(body, /draft body|Dir\/a\.md/, "no body and no Vault path is listed");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.match(res.headers.get("content-security-policy"), /media-src 'none'/);
});

// I2: the folder routes pass the boundary key that the catalog names. With an authorization
// runtime injected, a drifted literal would yield no publication request and a 404.
test("the folder index is served with an authorization runtime injected", async () => {
  const decided = [];
  const app = express().use(createWebAppRouter({
    provider,
    secureCookie: false,
    publishService: service,
    authorization: { authorize: (request) => { decided.push(request); return { allowed: true }; } },
  }));
  const ownServer = await listen(app);
  const ownBase = `http://127.0.0.1:${ownServer.address().port}`;
  try {
    const index = await fetch(`${ownBase}/publish/d/${id}`);
    assert.equal(index.status, 200, "the folder index is served, not 404");
    assert.match(await index.text(), /我的笔记/);
    assert.equal(decided.at(-1)?.capability, "publish_folder_read", "the index names its catalog boundary");
    const note = await fetch(`${ownBase}/publish/d/${id}/n/${tokenOf("Dir/a.md")}`);
    assert.equal(note.status, 200, "the note route is served too");
    assert.equal(decided.at(-1)?.capability, "publish_folder_read", "the note route names the same operation");
  } finally {
    await new Promise((resolve) => ownServer.close(resolve));
  }
});

test("a note route serves its body and refuses a private note with 404", async () => {
  const note = await get(`/publish/d/${id}/n/${tokenOf("Dir/a.md")}`);
  assert.equal(note.status, 200);
  assert.match(await note.text(), /A body/);
  assert.equal(note.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal((await get(`/publish/d/${id}/n/${tokenOf("Dir/b.md")}`)).status, 404, "a publish: false note has no token");
  assert.equal((await get(`/publish/d/${id}/n/${tokenOf("Dir/_drafts/c.md")}`)).status, 404, "a draft subtree does not inherit");
});

test("a malformed or unknown id is 404, and %2e%2e never reaches a file", async () => {
  assert.equal((await get("/publish/d/short")).status, 404);
  assert.equal((await get(`/publish/d/${otherId}/n/${tokenOf("Dir/a.md")}`)).status, 404, "a token of one record never selects a note of another");
  assert.equal((await get(`/publish/d/${id}/n/..%2F..%2Fsecret.md`)).status, 404);
  assert.equal((await get(`/publish/d/${id}/n/secret.md`)).status, 404, "a path is not a token");
  assert.equal((await get(`/publish/${id}`)).status, 404, "a folder record has no document page");
});

test("a note deleted while the folder is published does not 500 the index", async () => {
  const token = tokenOf("Dir/a.md");
  await fs.rm(path.join(vaultPath, "Dir", "a.md"));
  const index = await get(`/publish/d/${id}`);
  assert.equal(index.status, 200);
  assert.doesNotMatch(await index.text(), /我的笔记/);
  assert.equal((await get(`/publish/d/${id}/n/${token}`)).status, 404);
});

test("a publish:true note in an unpublished folder loads, and no sibling is reachable", async () => {
  const page = await get(`/publish/${documentRecord.id}`);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Only body/);
  assert.doesNotMatch(body, /other/, "a sibling is never named, linked or listed");
  assert.equal((await get(`/publish/d/${documentRecord.id}`)).status, 404, "a document record is not a folder index");
});

test("every new route has a catalog row", () => {
  assert.equal(capabilityForBoundary("GET /publish/d/:id"), "publish_folder_read");
  assert.equal(capabilityForBoundary("GET /publish/d/:id/n/:token"), "publish_folder_read");
  assert.equal(capabilityForBoundary("GET /publish/:id"), "publish_document_read", "the document route is unchanged");
});

test("an error on a publish path renders the login error page, not a bare failure", async () => {
  const broken = express();
  broken.use(createWebAppRouter({
    provider,
    secureCookie: false,
    publishService: { resolve: async () => { throw new Error("the folder read failed"); } },
  }));
  const failing = await listen(broken);
  try {
    const res = await fetch(`http://127.0.0.1:${failing.address().port}/publish/d/${"A".repeat(43)}`);
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.match(body, /<!doctype html>/, "a handled error is a page, not an empty body");
    assert.match(body, new RegExp(catalogFor("zh-CN")["login.error.badRequest"].replace(/。$/, "")), "the page carries the login error text");
  } finally {
    await new Promise((resolve) => failing.close(resolve));
  }
});
