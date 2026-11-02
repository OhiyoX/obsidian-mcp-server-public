import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Environment must be configured before importing config/vault modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-context-bounds-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
// Deliberately small so an unrelated oversized note (and the test target) can
// exceed MAX_READ_BYTES without writing multi-megabyte fixtures.
process.env.MAX_READ_BYTES = "64kb";

async function write(relative, content) {
  const abs = path.join(vault, relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

await write("Small.md", "# Small\n\nsmall body\n");
await write("Heavy.md", `# Heavy\n\n${"h".repeat(100 * 1024)}\n`);
await write("Big.md", `# Big\n\n${"b".repeat(100 * 1024)}\n`);

const { buildNoteContext, TARGET_READ_CEILING_BYTES } = await import("../src/context-service.js");
const { getCachedVaultIndex, getVaultIndex } = await import("../src/vault-index.js");
const { readFileWithinCap } = await import("../src/bounded-read.js");

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function measureHandleReadBytes(predicate, callback) {
  const originalOpen = fs.open;
  let bytes = 0;
  fs.open = async function patchedOpen(target, ...rest) {
    const handle = await originalOpen.call(this, target, ...rest);
    if (predicate(target)) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await originalRead(...args);
        bytes += result.bytesRead;
        return result;
      };
    }
    return handle;
  };
  try {
    return { value: await callback(), bytes };
  } finally {
    fs.open = originalOpen;
  }
}

test("a cold snapshot is reported as index_unavailable and never warms the index", async () => {
  assert.equal(getCachedVaultIndex(), null);
  const result = await buildNoteContext({ path: "Small" });
  assert.equal(result.status, "partial");
  assert.equal(result.revision.startsWith("sha256:"), true);
  assert.equal(result.budget.usedItems, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "target");
  assert.ok(result.warnings.some((warning) => warning.code === "index_unavailable"));
  // No cold vault-wide build happened: the snapshot is still absent.
  assert.equal(getCachedVaultIndex(), null);
});

test("an oversized target is read only through the hard byte cap", async () => {
  const bigAbs = path.join(vault, "Big.md");
  const { value, bytes } = await measureHandleReadBytes((target) => target === bigAbs, () => buildNoteContext({ path: "Big" }));
  assert.ok(bytes > 0, "the bounded reader should read the target");
  assert.ok(bytes <= TARGET_READ_CEILING_BYTES + 1, `read ${bytes} bytes for ceiling ${TARGET_READ_CEILING_BYTES}`);
  assert.equal(value.status, "partial");
  assert.equal(value.revision, null);
  assert.ok(value.warnings.some((warning) => warning.code === "target_note_too_large"));
  assert.ok(value.warnings.some((warning) => warning.code === "revision_unavailable"));
  assert.equal(JSON.stringify(value).includes("b".repeat(2000)), false);
});

test("a stale small stat cannot bypass the ceiling when the file grew", async () => {
  const bigAbs = path.join(vault, "Big.md");
  const fakeStat = { isFile: () => true, size: 10, mtime: new Date("2020-01-01T00:00:00.000Z") };
  const { value, bytes } = await measureHandleReadBytes(
    (target) => target === bigAbs,
    () => buildNoteContext({ path: "Big" }, { stat: async () => fakeStat }),
  );
  assert.ok(bytes <= TARGET_READ_CEILING_BYTES + 1);
  assert.equal(value.status, "partial");
  assert.ok(value.warnings.some((warning) => warning.code === "target_note_too_large"));
});

test("readFileWithinCap returns the exact body only when it fits", async () => {
  const small = await readFileWithinCap(path.join(vault, "Small.md"), TARGET_READ_CEILING_BYTES);
  assert.equal(small.tooLarge, false);
  assert.equal(small.changed, false);
  assert.equal(small.data.toString("utf8"), "# Small\n\nsmall body\n");
  assert.equal(small.stat.size, small.bytesRead);
  const big = await readFileWithinCap(path.join(vault, "Big.md"), TARGET_READ_CEILING_BYTES);
  assert.equal(big.tooLarge, true);
  assert.equal(big.changed, false);
  assert.equal(big.bytesRead, TARGET_READ_CEILING_BYTES + 1);
});

test("a target that mutates during the bounded read is partial and claims no revision", async () => {
  const targetAbs = path.join(vault, "Small.md");
  const originalBody = await fs.readFile(targetAbs, "utf8");
  const realSize = Buffer.byteLength(originalBody);
  const suffix = "\nchanged\n";
  const originalOpen = fs.open;
  let mutatedDuringRead = false;
  fs.open = async function patchedOpen(target, ...rest) {
    const handle = await originalOpen.call(this, target, ...rest);
    if (String(target) === targetAbs) {
      const realRead = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await realRead(...args);
        if (!mutatedDuringRead && result.bytesRead > 0) {
          mutatedDuringRead = true;
          await fs.appendFile(targetAbs, suffix, "utf8");
        }
        return result;
      };
    }
    return handle;
  };
  try {
    const result = await buildNoteContext({ path: "Small", includeBacklinks: false });
    assert.equal(mutatedDuringRead, true, "the fixture must mutate the target after content reading begins");
    assert.equal(result.status, "partial");
    assert.equal(result.revision, null);
    assert.equal(result.items[0].revision, null);
    assert.equal(result.items[0].revisionSource, null);
    assert.ok(result.warnings.some((warning) => warning.code === "target_changed_during_read"));
    // Metadata comes from the post-read handle snapshot, not the earlier path stat.
    assert.equal(result.items[0].metadata.size, realSize + Buffer.byteLength(suffix));
  } finally {
    fs.open = originalOpen;
    await fs.writeFile(targetAbs, originalBody, "utf8");
  }
});

test("a note over MAX_READ_BYTES does not abort the index or the bounded target read", async () => {
  const index = await getVaultIndex();
  assert.ok(index.records.some((record) => record.path === "Small.md"));
  assert.equal(index.records.some((record) => record.path === "Heavy.md"), false);
  assert.ok(index.stats.skipped >= 2, `expected oversized notes to be skipped, saw ${index.stats.skipped}`);
  assert.ok(getCachedVaultIndex(), "the index snapshot should now be warm");

  const result = await buildNoteContext({ path: "Small" });
  assert.equal(result.status, "ok");
  assert.match(result.revision, /^sha256:[0-9a-f]{64}$/);
});

test("a cold retrieval state yields a truthful partial related result without loading the retrieval JSON", async () => {
  // The Vault link index is warm from the previous test, but retrieval state
  // has never been loaded in this file. A related request must not cold-read
  // the retrieval index; it reports the snapshot as unavailable instead.
  const originalReadFile = fs.readFile;
  const reads = [];
  fs.readFile = async (target, ...rest) => { reads.push(String(target)); return originalReadFile.call(fs, target, ...rest); };
  try {
    const result = await buildNoteContext({ path: "Small", includeRelated: true, semantic: false, maxItems: 5 });
    assert.equal(result.status, "partial");
    assert.equal(result.index.available, false);
    assert.equal(result.index.semanticUsed, false);
    assert.equal(result.index.lexicalFallback, false);
    assert.equal(typeof result.index.semanticError, "string");
    assert.ok(result.warnings.some((warning) => warning.code === "related_unavailable"));
    assert.equal(reads.some((target) => String(target).includes("retrieval-index")), false);
  } finally {
    fs.readFile = originalReadFile;
  }
});
