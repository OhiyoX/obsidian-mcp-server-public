// Issue #694 — `delete_file`: the explicit attachment-deletion face.
//
// Contract: `DESIGN - Issue 694 附件删除入口（delete_file）契约草案` (ratified 2026-10-31, all five
// decisions per recommendation). The properties that matter, and why each is asserted from the
// outside (files on disk + the tool's own wire answer, never a handler self-report):
//   1. an attachment is deleted through the same recoverable plan + durable Trash backup `delete_note`
//      uses — so the backup must be BYTE-identical, including bytes that are not valid UTF-8 (the
//      reason the plan layer used to be Markdown-only);
//   2. `.md` is refused (`delete_note` is the note face) and nothing is touched;
//   3. any non-`.md` extension is deletable (#727 option 1, so the delete face is as wide as the
//      upload face), protected Vault internals are refused, and every refusal happens BEFORE I/O;
//   4. no hard-delete switch exists, and a CAS mismatch leaves both the Vault and Trash untouched;
//   5. the restore round-trip is byte-identical (the contract's decision 4).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Environment is assigned before the src modules are imported (config.js resolves at load).
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-delete-file-694-"));
const VAULT = path.join(ROOT, "vault");
const DATA = path.join(ROOT, "data");
const TRASH = path.join(DATA, "trash");
await fs.mkdir(VAULT, { recursive: true });
process.env.VAULT_PATH = VAULT;
process.env.DATA_PATH = DATA;
process.env.GIT_ENABLED = "false";
process.env.VERSION_HISTORY_ENABLED = "true";

const { registerFileTools } = await import("../src/tools/files.js");
const { registerLinkTools } = await import("../src/tools/links.js");
const { withRequestContext } = await import("../src/request-context.js");
const { vaultDataKey } = await import("../src/vault-runtime/descriptor.js");
const { vaultDataPaths } = await import("../src/vault-runtime/paths.js");
const { createVaultRuntime } = await import("../src/vault-runtime/runtime.js");

const AUTHOR = Object.freeze({ agent: "delete-file-694", model: "test" });
const authored = (callback) => withRequestContext({ author: AUTHOR }, callback);

/** The real handlers, captured from the real registrars — no HTTP layer, no mock of the tool face. */
function captureTools() {
  const tools = new Map();
  const server = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
  registerFileTools(server);
  registerLinkTools(server);
  return tools;
}
const TOOLS = captureTools();
const call = (name, args) => authored(() => TOOLS.get(name).handler(args));

const sha256 = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
const vaultFile = (...parts) => path.join(VAULT, ...parts);

async function writeAttachment(relative, bytes) {
  const abs = vaultFile(...relative.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

async function trashFiles() {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(abs);
      else out.push(abs);
    }
  }
  await visit(TRASH);
  return out.sort();
}

async function exists(abs) {
  return fs.access(abs).then(() => true, () => false);
}

test("#694: a binary attachment is deleted through the plan, and its Trash backup is byte-identical", async () => {
  // Deliberately includes bytes that are not valid UTF-8: the old plan layer read every target as a
  // note, which is exactly what made this impossible.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x41, 0x80, 0x81]);
  const abs = await writeAttachment("attachments/raw.png", bytes);
  const trashBefore = await trashFiles();

  const result = await call("delete_file", { path: "attachments/raw.png" });

  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.deleted, "attachments/raw.png");
  assert.equal(result.structuredContent.previousSizeInBytes, bytes.length);
  assert.equal(result.structuredContent.revision, sha256(bytes), "the revision is the content that was deleted");
  assert.match(result.structuredContent.backupPath, /attachments\/raw\.png$/, "the Trash backup keeps the original relative path");
  assert.equal(await exists(abs), false, "the attachment is gone from the Vault");

  const backupAbs = path.join(TRASH, ...result.structuredContent.backupPath.split("/"));
  assert.deepEqual(await fs.readFile(backupAbs), bytes, "the Trash copy is byte-identical, non-UTF-8 bytes included");
  assert.deepEqual(await trashFiles(), [...trashBefore, backupAbs].sort(), "exactly one new Trash file");
});

test("#694: the restore round-trip is byte-identical (delete_file → restore_from_trash)", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  await writeAttachment("attachments/roundtrip.png", bytes);
  const deleted = await call("delete_file", { path: "attachments/roundtrip.png" });
  assert.equal(await exists(vaultFile("attachments", "roundtrip.png")), false);

  const restored = await call("restore_from_trash", { backupPath: deleted.structuredContent.backupPath });
  assert.equal(restored.isError, undefined, JSON.stringify(restored));
  assert.equal(restored.structuredContent.restoredPath, "attachments/roundtrip.png");
  assert.deepEqual(await fs.readFile(vaultFile("attachments", "roundtrip.png")), bytes);
});

test("#694: a Markdown note is refused with FILE_IS_NOTE and left untouched", async () => {
  const abs = await writeAttachment("notes/keep-me.md", "# keep\n");
  const trashBefore = await trashFiles();
  const result = await call("delete_file", { path: "notes/keep-me.md" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "FILE_IS_NOTE");
  assert.match(result.structuredContent.message, /delete_note/, "the refusal points at the note face");
  assert.equal(await fs.readFile(abs, "utf8"), "# keep\n");
  assert.deepEqual(await trashFiles(), trashBefore, "a refusal performs no Trash write");
});

test("#727: any non-Markdown extension is deletable (uploads accept arbitrary extensions)", async () => {
  // #727 option 1: the delete face must be at least as wide as the upload face. `start_file_upload`
  // defaults to `acceptedOnly: false`, so `.bin`/`.zip` land in the Vault legitimately; before this
  // they were reachable only by shelling into the host — the exact audit hole #694 set out to close.
  const cases = [
    { relative: "attachments/weird.bin", bytes: Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]) },
    { relative: "archives/bundle.zip", bytes: Buffer.from("PK\u0003\u0004not-really-a-zip") },
    { relative: "logs/run.log", bytes: Buffer.from("line\n") },
    { relative: "attachments/no-extension", bytes: Buffer.from("bare") },
  ];
  for (const { relative, bytes } of cases) {
    const abs = await writeAttachment(relative, bytes);
    const before = await fs.readFile(abs);
    const result = await call("delete_file", { path: relative });
    assert.equal(result.isError ?? false, false, `${relative} must be deletable`);
    assert.equal(result.structuredContent.deleted, relative);
    assert.equal(await exists(abs), false, `${relative} must be gone from the Vault`);
    // Byte-identical Trash copy, then a byte-identical restore: the round-trip is the property that
    // makes widening the type guard safe.
    const backups = await trashFiles();
    const backup = backups.find((entry) => entry.endsWith(path.basename(relative)));
    assert.ok(backup, `${relative} must have a Trash backup`);
    assert.deepEqual(await fs.readFile(backup), before, `${relative} Trash bytes must match`);
  }
});

test("#694: both protected roots are refused before any I/O", async () => {
  const trashBefore = await trashFiles();

  for (const relative of [".git/config", ".obsidian/app.json", ".obsidian"]) {
    const protectedPath = await call("delete_file", { path: relative });
    assert.equal(protectedPath.isError, true, `${relative} must be refused`);
    assert.equal(protectedPath.structuredContent.code, "FILE_PROTECTED_PATH", `${relative} refusal code`);
  }
  assert.deepEqual(await trashFiles(), trashBefore, "no refusal creates a Trash entry");
});

test("#694: a missing file answers FILE_NOT_FOUND and writes nothing", async () => {
  const trashBefore = await trashFiles();
  const result = await call("delete_file", { path: "attachments/never-existed.png" });
  assert.equal(result.structuredContent.code, "FILE_NOT_FOUND");
  assert.deepEqual(await trashFiles(), trashBefore);
});

test("#694: a stale ifMatch answers a revision conflict and touches neither Vault nor Trash", async () => {
  const bytes = Buffer.from("cas-target");
  const abs = await writeAttachment("attachments/cas.pdf", bytes);
  const trashBefore = await trashFiles();
  const result = await call("delete_file", { path: "attachments/cas.pdf", ifMatch: sha256(Buffer.from("something else")) });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.message, /Revision conflict/);
  assert.deepEqual(await fs.readFile(abs), bytes);
  assert.deepEqual(await trashFiles(), trashBefore);
});

test("#694: the matching ifMatch deletes, and delete_note keeps working unchanged", async () => {
  const bytes = Buffer.from("cas-ok");
  await writeAttachment("attachments/cas-ok.pdf", bytes);
  const deleted = await call("delete_file", { path: "attachments/cas-ok.pdf", ifMatch: sha256(bytes) });
  assert.equal(deleted.isError, undefined, JSON.stringify(deleted));
  assert.equal(await exists(vaultFile("attachments", "cas-ok.pdf")), false);

  // Regression: the Markdown face is untouched by this cut.
  await writeAttachment("notes/still-deletable.md", "# bye\n");
  const note = await call("delete_note", { path: "notes/still-deletable.md" });
  assert.equal(note.isError, undefined, JSON.stringify(note));
  assert.equal(note.structuredContent.deleted, "notes/still-deletable.md");
  assert.equal(await exists(vaultFile("notes", "still-deletable.md")), false);
});

test("#694: a secondary delete never touches the primary Vault's file or Trash (dual Vault)", async () => {
  const secondaryRoot = path.join(ROOT, "secondary", "vault");
  await fs.mkdir(secondaryRoot, { recursive: true });
  const secondary = createVaultRuntime({
    descriptor: { id: "secondary", name: "secondary", root: secondaryRoot, primary: false },
    // Per-Vault data lives under this process's DATA_PATH (`DATA/vaults/<dataKey>/…`); anything else
    // is refused by the journal/idempotency store, which is itself a useful guard to keep intact.
    paths: vaultDataPaths({ primary: false, dataRoot: DATA, dataKey: vaultDataKey("secondary") }),
    deps: { requireRequestAuthor: () => AUTHOR },
  });
  const inVault = (vaultId, vaultRuntime, task) => withRequestContext({ author: AUTHOR, vaultId, vaultRuntime }, task);

  // Same relative path in BOTH Vaults, different bytes: a routing mistake cannot hide behind a name.
  const primaryBytes = Buffer.from("primary copy");
  const secondaryBytes = Buffer.from("secondary copy");
  await writeAttachment("attachments/same-name.pdf", primaryBytes);
  const secondaryAbs = path.join(secondaryRoot, "attachments", "same-name.pdf");
  await fs.mkdir(path.dirname(secondaryAbs), { recursive: true });
  await fs.writeFile(secondaryAbs, secondaryBytes);
  const primaryTrashBefore = await trashFiles();

  const deleted = await inVault("secondary", secondary, () => TOOLS.get("delete_file").handler({ path: "attachments/same-name.pdf" }));
  assert.equal(deleted.isError, undefined, JSON.stringify(deleted));
  assert.equal(deleted.structuredContent.revision, sha256(secondaryBytes), "the revision is the SECONDARY content");

  assert.equal(await exists(secondaryAbs), false, "the secondary copy is gone");
  assert.deepEqual(await fs.readFile(vaultFile("attachments", "same-name.pdf")), primaryBytes, "the primary copy is untouched, byte for byte");
  assert.deepEqual(await trashFiles(), primaryTrashBefore, "the primary Vault's Trash is untouched");
  assert.equal(await exists(path.join(vaultFile("attachments", "same-name.pdf"))), true);
});

test("#694: the tool face is registered once with the contract's schema and hints", () => {
  const { config } = TOOLS.get("delete_file");
  assert.equal(config.title, "Delete Obsidian Attachment");
  assert.equal(config.annotations.destructiveHint, true);
  assert.deepEqual(Object.keys(config.inputSchema).sort(), ["ifMatch", "path"], "no `backup` switch exists (decision 5)");
  assert.match(config.description, /no hard-delete option/i);
});
