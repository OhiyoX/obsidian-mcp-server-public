import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { zipSync } from "fflate";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-transfer-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";

const {
  appendFileUpload,
  createZipArchive,
  extractZipArchive,
  fileUploadStatus,
  inspectZipBuffer,
  inspectZipFile,
  pullFile,
  startFileUpload,
} = await import("../src/file-transfer.js");
const { withRequestContext } = await import("../src/request-context.js");

const authored = (callback) => withRequestContext({ author: { agent: "test-agent", model: "test-model" } }, callback);
after(() => fs.rm(root, { recursive: true, force: true }));

test("chunked upload resumes by byte offset and atomically publishes an attachment", async () => {
  const payload = Buffer.from("important project attachment\n", "utf8");
  const started = await authored(() => startFileUpload({ vaultPath: "Projects/demo/attachment.bin", totalBytes: payload.length }));
  const first = payload.subarray(0, 8);
  const second = payload.subarray(8);
  const partial = await authored(() => appendFileUpload({ uploadId: started.uploadId, offset: 0, base64: first.toString("base64") }));
  assert.equal(partial.nextOffset, first.length);
  const completed = await authored(() => appendFileUpload({ uploadId: started.uploadId, offset: first.length, base64: second.toString("base64"), finalize: true }));
  assert.equal(completed.complete, true);
  assert.equal((await fileUploadStatus(started.uploadId)).status, "complete");
  const replay = await authored(() => appendFileUpload({ uploadId: started.uploadId, offset: first.length, base64: second.toString("base64"), finalize: true }));
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(await fs.readFile(path.join(vault, "Projects", "demo", "attachment.bin")), payload);
  const { transfer } = await pullFile("Projects/demo/attachment.bin");
  assert.equal(Buffer.from(transfer.content, "base64").toString("utf8"), payload.toString("utf8"));
});

test("ZIP creation, inspection, dry-run and safe extraction stay inside the Vault", async () => {
  await fs.mkdir(path.join(vault, "Projects", "source"), { recursive: true });
  await fs.writeFile(path.join(vault, "Projects", "source", "a.txt"), "alpha");
  await fs.writeFile(path.join(vault, "Projects", "source", "b.txt"), "beta");
  const created = await authored(() => createZipArchive({ sourcePaths: ["Projects/source"], destination: "Projects/bundle.zip" }));
  assert.equal(created.fileCount, 2);
  const inspected = await inspectZipFile("Projects/bundle.zip");
  assert.deepEqual(inspected.entries.filter((entry) => !entry.directory).map((entry) => entry.path).sort(), ["Projects/source/a.txt", "Projects/source/b.txt"]);
  const preview = await authored(() => extractZipArchive({ archivePath: "Projects/bundle.zip", destinationDirectory: "Restored", dryRun: true }));
  assert.equal(preview.dryRun, true);
  assert.equal(await fs.stat(path.join(vault, "Restored")).then(() => true, () => false), false);
  const extracted = await authored(() => extractZipArchive({ archivePath: "Projects/bundle.zip", destinationDirectory: "Restored", dryRun: false }));
  assert.equal(extracted.extracted, 2);
  assert.equal(await fs.readFile(path.join(vault, "Restored", "Projects", "source", "a.txt"), "utf8"), "alpha");
});

test("ZIP extraction cannot be redirected to an outside archive after canonical validation", async (t) => {
  if (process.platform === "win32") return t.skip("symlink TOCTOU simulation requires Developer Mode on Windows");
  const safeArchive = path.join(vault, "SafeArchive.zip");
  const aliasArchive = path.join(vault, "ArchiveAlias.zip");
  const outsideArchive = path.join(root, "outside-archive.zip");
  const destination = path.join(vault, "RaceExtract");
  await fs.writeFile(safeArchive, Buffer.from(zipSync({ "safe.txt": new Uint8Array(Buffer.from("safe archive bytes")) })));
  await fs.writeFile(outsideArchive, Buffer.from(zipSync({ "outside-secret.txt": new Uint8Array(Buffer.from("OUTSIDE_ARCHIVE_SECRET")) })));
  await fs.symlink(safeArchive, aliasArchive, "file");

  const originalRealpath = fs.realpath;
  let swapped = false;
  fs.realpath = async (candidate, ...rest) => {
    const resolved = await originalRealpath.call(fs, candidate, ...rest);
    if (!swapped && String(candidate) === aliasArchive) {
      swapped = true;
      await fs.unlink(aliasArchive);
      await fs.symlink(outsideArchive, aliasArchive, "file");
    }
    return resolved;
  };

  try {
    await authored(() => extractZipArchive({
      archivePath: "ArchiveAlias.zip",
      destinationDirectory: "RaceExtract",
      dryRun: false,
    }));
    assert.equal(swapped, true, "fixture must swap the archive symlink after canonical validation");
    const outsideRestored = await fs.readFile(path.join(destination, "outside-secret.txt"), "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    assert.equal(outsideRestored, null, "outside archive bytes must never be materialized inside the Vault");
    assert.equal(await fs.readFile(path.join(destination, "safe.txt"), "utf8"), "safe archive bytes");
  } finally {
    fs.realpath = originalRealpath;
    await fs.rm(aliasArchive, { force: true });
    await fs.rm(destination, { recursive: true, force: true });
  }
});

test("ZIP inspection rejects traversal entries before decompression", () => {
  const malicious = Buffer.from(zipSync({ "../escape.txt": new Uint8Array(Buffer.from("nope")) }));
  assert.throws(() => inspectZipBuffer(malicious), /traversal|Unsafe archive entry/);
});
