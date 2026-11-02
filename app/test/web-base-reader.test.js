// Root-scoped safe Base reader tests (A3 HTTP contract).
//
// The reader mirrors the Web Catalog note reader: canonical containment,
// intermediate + final symlink rejection, a bounded read and a sha256 revision.
// No YAML parsing happens here (that is the route's evaluate/parse dependency).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A small read budget keeps the oversized-base case cheap; set before the module
// (and its config.js import) is evaluated.
process.env.MAX_READ_BYTES = "2048";

const { BaseReaderError, readBaseInRoot } = await import("../src/app/base-reader.js");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-base-reader-"));
const vaultA = path.join(root, "vault-a");
const vaultB = path.join(root, "vault-b");
const outside = path.join(root, "outside");
await fs.mkdir(path.join(vaultA, "Folder"), { recursive: true });
await fs.mkdir(path.join(vaultA, "Dir.base"), { recursive: true });
await fs.mkdir(vaultB, { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.writeFile(path.join(vaultA, "Project.base"), "views:\n  - name: All\n");
await fs.writeFile(path.join(vaultA, "Folder", "Nested.base"), "views: []\n");
await fs.writeFile(path.join(vaultA, "Note.md"), "# note\n");
await fs.writeFile(path.join(vaultB, "Secret.base"), "views: []\n");
await fs.writeFile(path.join(outside, "secret.base"), "views: []\n");
await fs.writeFile(path.join(vaultA, "Big.base"), "x".repeat(4096));

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// Creates a symlink or, only on Windows where the privilege is unavailable, marks
// the test skipped with an explicit reason (junctions need no Windows privilege,
// so the intermediate directory escape still runs there).
async function symlinkOrSkip(t, target, linkPath, type) {
  const attempts = process.platform === "win32" && type === "dir" ? ["dir", "junction"] : [type];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      await fs.symlink(target, linkPath, attempt);
      return true;
    } catch (error) {
      lastError = error;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) throw error;
    }
  }
  t.skip(`symlink privilege unavailable on Windows: ${lastError?.code}`);
  return false;
}

function isReaderError(code) {
  return (error) => {
    assert.ok(error instanceof BaseReaderError, `expected BaseReaderError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    return true;
  };
}

test("reads a .base file with a stable sha256 revision and stat", async () => {
  const first = await readBaseInRoot({ id: "a", root: vaultA }, "Project.base");
  const second = await readBaseInRoot({ id: "a", root: vaultA }, "Project.base");
  assert.equal(first.path, "Project.base");
  assert.equal(first.raw, "views:\n  - name: All\n");
  assert.match(first.revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.revision, second.revision, "revision is stable across reads");
  assert.equal(
    first.revision,
    `sha256:${createHash("sha256").update(Buffer.from(first.raw, "utf8")).digest("hex")}`,
  );
  assert.equal(first.stat.size, Buffer.byteLength(first.raw));
  assert.ok(first.stat.modified, "stat.modified is present");
});

test("reads a nested .base under the vault root", async () => {
  const read = await readBaseInRoot({ id: "a", root: vaultA }, "Folder/Nested.base");
  assert.equal(read.path, "Folder/Nested.base");
});

test("non-.base paths are rejected without parsing", async () => {
  await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "Note.md"), isReaderError("BASE_PATH_INVALID"));
  await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "Note"), isReaderError("BASE_PATH_INVALID"));
});

test("a directory named .base is not a readable Base", async () => {
  await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "Dir.base"), isReaderError("BASE_NOT_A_FILE"));
});

test("a missing Base is BASE_NOT_FOUND", async () => {
  await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "Missing.base"), isReaderError("BASE_NOT_FOUND"));
});

test("a Base larger than the read budget is BASE_TOO_LARGE", async () => {
  await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "Big.base"), isReaderError("BASE_TOO_LARGE"));
});

test("traversal and absolute inputs never resolve", async () => {
  for (const bad of [
    "../vault-b/Secret.base",
    "Folder/../../vault-b/Secret.base",
    path.join(vaultA, "Project.base"),
    "/etc/passwd.base",
    "C:/tmp/x.base",
    "Folder//Nested.base",
    "Folder/./Nested.base",
  ]) {
    await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, bad), isReaderError("BASE_PATH_INVALID"), bad);
  }
});

test("a secondary vault cannot be reached through the primary vault root", async () => {
  await assert.rejects(
    () => readBaseInRoot({ id: "a", root: vaultA }, "../vault-b/Secret.base"),
    isReaderError("BASE_PATH_INVALID"),
  );
});

test("a final-name symlink that escapes the vault root is rejected", async (t) => {
  const linkPath = path.join(vaultA, "Escape.base");
  if (!(await symlinkOrSkip(t, path.join(outside, "secret.base"), linkPath, "file"))) return;
  await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "Escape.base"), isReaderError("BASE_ESCAPE"));
});

test("an intermediate directory symlink that escapes the vault root is rejected", async (t) => {
  const linkDir = path.join(vaultA, "EscapeDir");
  if (!(await symlinkOrSkip(t, outside, linkDir, "dir"))) return;
  await assert.rejects(
    () => readBaseInRoot({ id: "a", root: vaultA }, "EscapeDir/secret.base"),
    isReaderError("BASE_ESCAPE"),
  );
});

test("a within-vault symlink is still rejected (Base files must be real files)", async (t) => {
  const linkPath = path.join(vaultA, "Alias.base");
  if (!(await symlinkOrSkip(t, path.join(vaultA, "Project.base"), linkPath, "file"))) return;
  await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "Alias.base"), isReaderError("BASE_ESCAPE"));
});
