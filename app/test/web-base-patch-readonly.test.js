// A4b / BRIEF-FIX-DOS 阻段2: a read-only deployment (`OBSIDIAN_READ_ONLY=true`) must
// refuse `PATCH /api/web/v1/base` as the designed **403** surface (WRITE-SURFACE-DESIGN
// §3.1 `assertWritable()  (只读模式 403)`), not as a 500 with a stack trace in the log.
// `READ_ONLY` is read at module import time, so this lives in its own test file/process
// (same shape as `web-folder-readonly.test.js`).
//
// The negative control is *not* an injected variant: the pre-existing `POST
// /api/web/v1/note` route runs the identical `assertWritable()` and has no read-only
// branch in its catch, so in this same process it still answers 500 → the 403 below can
// only come from the `.base` route's own mapping.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-base-patch-ro-"));
const vault = path.join(root, "vault");
await fs.mkdir(path.join(vault, "Boards"), { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = path.join(root, "data");
process.env.HISTORY_PATH = path.join(root, "data", "history");
process.env.WEB_CATALOG_ENABLED = "true";
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
process.env.GIT_ENABLED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.OBSIDIAN_READ_ONLY = "true";
delete process.env.WEB_VAULTS_ROOT;

const { createWebAppRouter } = await import("../src/app/routes.js");

const BASE_TEXT = ["# read-only fixture", "views:", "  - type: table", "    name: Only", "    limit: 10", ""].join("\n");
const baseFile = path.join(vault, "Boards", "ReadOnly.base");
const sha256 = (text) => `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;

const user = {
  id: "user-ro",
  username: "writer",
  displayName: "Writer",
  updatedAt: "v1",
  allowedScopes: ["obsidian.read", "obsidian.write"],
  allowedVaults: ["default"],
};
const audits = [];
const provider = {
  authenticateOAuthUser: async (username, password) => password === "password" && username === "writer" ? user : null,
  oauthUserSessionRecord: async (id) => id === user.id ? user : null,
  recordAudit: (entry) => audits.push(entry),
};

test.after(async () => {
  delete process.env.OBSIDIAN_READ_ONLY;
  await fs.rm(root, { recursive: true, force: true });
});

test("read-only: PATCH /api/web/v1/base ⇒ 403 (not 500), no bytes written, no .tmp, no audit", async () => {
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false }));
  const server = await new Promise((resolve) => {
    const instance = http.createServer(app).listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fs.writeFile(baseFile, BASE_TEXT, "utf8");
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "writer", password: "password" }),
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const appHtml = await (await fetch(`${base}/app`, { headers: { Cookie: cookie } })).text();
    const csrf = appHtml.match(/name="csrf-token" content="([^"]+)"/)[1];
    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf };

    // Reading stays allowed in read-only mode (the refusal is about writes only).
    const read = await fetch(`${base}/api/web/v1/base/raw?path=Boards/ReadOnly.base`, { headers: { Cookie: cookie } });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).content, BASE_TEXT);

    const response = await fetch(`${base}/api/web/v1/base`, {
      method: "PATCH",
      headers: { ...headers, "If-Match": `"${sha256(BASE_TEXT)}"` },
      body: JSON.stringify({ path: "Boards/ReadOnly.base", mutations: [{ op: "set-view-option", view: "Only", key: "limit", value: 25 }] }),
    });
    assert.equal(response.status, 403, "read-only is a 403 surface, never a 500");
    assert.deepEqual(await response.json(), { error: "Server is read-only" });
    assert.equal(await fs.readFile(baseFile, "utf8"), BASE_TEXT, "a read-only refusal must not touch the document");
    assert.deepEqual((await fs.readdir(path.join(vault, "Boards"))).filter((name) => name.includes(".tmp")), []);
    assert.deepEqual(audits.filter((entry) => entry.action === "web.base.patch"), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("negative control: the pre-existing note route in the same read-only process is still a 500", async () => {
  const app = express();
  app.use(createWebAppRouter({ provider, secureCookie: false }));
  const server = await new Promise((resolve) => {
    const instance = http.createServer(app).listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "writer", password: "password" }),
    });
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const appHtml = await (await fetch(`${base}/app`, { headers: { Cookie: cookie } })).text();
    const csrf = appHtml.match(/name="csrf-token" content="([^"]+)"/)[1];

    const response = await fetch(`${base}/api/web/v1/note`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ path: "Boards/Note.md", content: "# x\n" }),
    });
    // Same `assertWritable()` refusal, no read-only branch in that route's catch: the
    // shared classifier turns it into a 500. So the base route's 403 is produced by its
    // own mapping (a missing mapping would land here too).
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Request failed" });
    assert.equal(await fs.stat(path.join(vault, "Boards", "Note.md")).then(() => true, () => false), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
