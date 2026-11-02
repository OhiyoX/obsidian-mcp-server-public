import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-index-atomicity-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(vault, { recursive: true });
const changedPath = path.join(vault, "A-Atomic.md");
const failingPath = path.join(vault, "Z-Atomic-Fail.md");
const beforeBody = "# Atomic\n\nbefore refresh\n";
const afterBody = "# Atomic\n\nafter refresh\n";
await fs.writeFile(changedPath, beforeBody, "utf8");
await fs.writeFile(failingPath, "# Fail later\n", "utf8");

const { getCachedVaultIndex, getVaultIndex } = await import("../src/vault-index.js");

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("a failed Vault index refresh preserves the last successful cached snapshot", async () => {
  const baseline = await getVaultIndex({ force: true });
  assert.equal(baseline.records.find((record) => record.path === "A-Atomic.md")?.raw, beforeBody);
  const baselineRefresh = getCachedVaultIndex()?.stats.lastRefresh;

  await fs.writeFile(changedPath, afterBody, "utf8");
  const originalOpen = fs.open;
  const boom = new Error("late index read failure");
  let injected = false;
  let closed = false;
  fs.open = async (candidate, ...rest) => {
    const handle = await originalOpen.call(fs, candidate, ...rest);
    if (String(candidate) === failingPath) {
      const realClose = handle.close.bind(handle);
      handle.read = async () => {
        injected = true;
        throw boom;
      };
      handle.close = async (...args) => {
        closed = true;
        return realClose(...args);
      };
    }
    return handle;
  };

  let cachedAfterFailure;
  try {
    await assert.rejects(() => getVaultIndex({ force: true }), /late index read failure/);
    assert.equal(injected, true, "fault injection must hit the active FileHandle.read path");
    assert.equal(closed, true, "failed index reads must close their FileHandle");
    cachedAfterFailure = getCachedVaultIndex();
  } finally {
    fs.open = originalOpen;
  }

  assert.ok(cachedAfterFailure, "the previous successful snapshot should remain available");
  assert.equal(
    cachedAfterFailure.records.find((record) => record.path === "A-Atomic.md")?.raw,
    beforeBody,
    "a failed refresh must not publish records parsed before the later failure",
  );
  assert.equal(cachedAfterFailure.stats.lastRefresh, baselineRefresh);
});
