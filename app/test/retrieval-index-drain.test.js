import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Deterministic lifecycle regression for the retrieval index. The retrieval
// module owns a background operation queue plus a debounced refresh timer;
// closing an MCP client transport does not close that storage lifecycle. A
// teardown that unlinks the data root without draining can race an in-flight
// atomic write (`writeFile(tmp)` + `rename(tmp)`) and leave a partial root or
// fail with ENOTEMPTY. These tests hold the real temp write open with a
// test-local barrier and prove the drain API waits for it.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-retrieval-index-drain-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
const indexPath = path.join(data, "index", "retrieval-index.json");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = indexPath;
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(data, { recursive: true });
await fs.writeFile(path.join(vault, "Note.md"), "# Note\n\ndrain-barrier-needle\n", "utf8");

const { drainRetrievalIndex, scheduleRetrievalRefresh, syncRetrievalIndex } = await import("../src/retrieval.js");

after(async () => {
  await drainRetrievalIndex();
  await fs.rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function assertNoTempFiles() {
  const entries = await fs.readdir(path.dirname(indexPath));
  assert.deepEqual(entries.filter((entry) => entry.endsWith(".tmp")), [], "drained index must leave no partial temp file");
}

test("drainRetrievalIndex waits for an in-flight retrieval write", { timeout: 15000 }, async () => {
  await drainRetrievalIndex();

  const originalWriteFile = fs.writeFile;
  const writeEntered = deferred();
  const releaseWrite = deferred();
  let intercepted = false;
  let drainSettled = false;

  fs.writeFile = async (candidate, ...rest) => {
    if (!intercepted && String(candidate).startsWith(`${indexPath}.`) && String(candidate).endsWith(".tmp")) {
      intercepted = true;
      writeEntered.resolve();
      await releaseWrite.promise;
    }
    return originalWriteFile.call(fs, candidate, ...rest);
  };

  try {
    syncRetrievalIndex({ force: true });
    const draining = drainRetrievalIndex().then(() => {
      drainSettled = true;
    });

    const first = await Promise.race([
      writeEntered.promise.then(() => "write-entered"),
      draining.then(() => "drain-settled"),
    ]);
    assert.equal(first, "write-entered", "the retrieval write must enter before drain can settle");
    assert.equal(intercepted, true, "the barrier must intercept the real retrieval temp write");
    assert.equal(drainSettled, false, "drain must not resolve while the index write is blocked");

    releaseWrite.resolve();
    await draining;

    assert.equal(drainSettled, true);
    await assertNoTempFiles();
    const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
    assert.ok(persisted.notes["Note.md"], "the drained write must persist the note");
  } finally {
    releaseWrite.resolve();
    fs.writeFile = originalWriteFile;
    await drainRetrievalIndex();
  }
});

test("drainRetrievalIndex promotes a pending debounced refresh into a drained write", { timeout: 15000 }, async () => {
  await drainRetrievalIndex();

  const originalWriteFile = fs.writeFile;
  const writeEntered = deferred();
  const releaseWrite = deferred();
  let intercepted = false;
  let drainSettled = false;

  fs.writeFile = async (candidate, ...rest) => {
    if (!intercepted && String(candidate).startsWith(`${indexPath}.`) && String(candidate).endsWith(".tmp")) {
      intercepted = true;
      writeEntered.resolve();
      await releaseWrite.promise;
    }
    return originalWriteFile.call(fs, candidate, ...rest);
  };

  try {
    scheduleRetrievalRefresh();
    const draining = drainRetrievalIndex().then(() => {
      drainSettled = true;
    });

    const first = await Promise.race([
      writeEntered.promise.then(() => "write-entered"),
      draining.then(() => "drain-settled"),
    ]);
    assert.equal(first, "write-entered", "drain must promote the debounce timer into a real queued write");
    assert.equal(drainSettled, false, "drain must wait for the promoted write to finish");

    releaseWrite.resolve();
    await draining;

    await assertNoTempFiles();
    const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
    assert.ok(persisted.notes["Note.md"], "the promoted refresh must persist the note");
  } finally {
    releaseWrite.resolve();
    fs.writeFile = originalWriteFile;
    await drainRetrievalIndex();
  }
});
