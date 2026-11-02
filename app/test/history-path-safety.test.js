import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-history-path-safety-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
const history = path.join(data, "history");
const outside = path.join(root, "outside");

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(history, { recursive: true });
await fs.mkdir(outside, { recursive: true });

process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = history;
process.env.VERSION_HISTORY_ENABLED = "true";
process.env.GIT_ENABLED = "false";

const { atomicWriteBatch } = await import("../src/batch-write.js");
const { recoverPendingBatches } = await import("../src/batch-journal.js");
const { atomicWriteFile, fileRevision, restoreFileVersion } = await import("../src/vault.js");
const { withRequestContext } = await import("../src/request-context.js");

const authored = (callback) =>
  withRequestContext({ author: { agent: "history-path-test", model: "test" } }, callback);

async function linkDirectory(target, link) {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("direct version snapshot rejects a History intermediate symlink escape before writing", async () => {
  const target = path.join(vault, "escape-direct.md");
  const outsideDirectory = path.join(outside, "direct");
  const historyDirectory = path.join(history, "escape-direct.md");

  await fs.writeFile(target, "before-direct\n", "utf-8");
  await fs.mkdir(outsideDirectory, { recursive: true });
  await linkDirectory(outsideDirectory, historyDirectory);
  const beforeRevision = await fileRevision(target);

  await assert.rejects(
    authored(() => atomicWriteFile(target, "after-direct\n", { encoding: "utf-8", ifMatch: beforeRevision })),
    /Symbolic link escapes/i,
  );

  assert.equal(await fs.readFile(target, "utf-8"), "before-direct\n");
  assert.deepEqual(await fs.readdir(outsideDirectory), []);
});

test("version restore cannot be redirected outside History after canonical validation", async (t) => {
  if (process.platform === "win32") return t.skip("symlink TOCTOU simulation requires Developer Mode on Windows");
  const versionDirectory = path.join(history, "restore-race.md");
  const safeVersion = path.join(versionDirectory, "safe.bak");
  const versionLink = path.join(versionDirectory, "selected.bak");
  const outsideVersion = path.join(outside, "outside-version.bak");
  const destination = path.join(vault, "restore-race.md");
  const safeBody = "safe history version\n";
  const outsideBody = "OUTSIDE_HISTORY_SECRET\n";

  await fs.mkdir(versionDirectory, { recursive: true });
  await fs.writeFile(safeVersion, safeBody, "utf8");
  await fs.writeFile(outsideVersion, outsideBody, "utf8");
  await fs.symlink(safeVersion, versionLink, "file");

  const originalRealpath = fs.realpath;
  let swapped = false;
  fs.realpath = async (candidate, ...rest) => {
    const resolved = await originalRealpath.call(fs, candidate, ...rest);
    if (!swapped && String(candidate) === versionLink) {
      swapped = true;
      await fs.unlink(versionLink);
      await fs.symlink(outsideVersion, versionLink, "file");
    }
    return resolved;
  };

  try {
    await authored(() => restoreFileVersion("restore-race.md/selected.bak", {
      destination: "restore-race.md",
      overwrite: true,
    }));
    assert.equal(swapped, true, "fixture must swap the History symlink after canonical validation");
    assert.equal(await fs.readFile(destination, "utf8"), safeBody,
      "restore must read the canonical in-History file that was validated, not a later symlink target");
    assert.notEqual(await fs.readFile(destination, "utf8"), outsideBody);
  } finally {
    fs.realpath = originalRealpath;
    await fs.rm(versionLink, { force: true });
    await fs.rm(destination, { force: true });
  }
});

test("committed journal recovery retains the journal and never writes History through an escape", async () => {
  const target = path.join(vault, "escape-recovery.md");
  const journalRoot = path.join(data, "mutation-journal");
  const outsideDirectory = path.join(outside, "recovery");
  const historyDirectory = path.join(history, "escape-recovery.md");

  await fs.writeFile(target, "before-recovery\n", "utf-8");
  const beforeRevision = await fileRevision(target);
  const script = `
    import { withRequestContext } from './src/request-context.js';
    import { atomicWriteBatch } from './src/batch-write.js';
    import path from 'node:path';
    const target = path.join(process.env.VAULT_PATH, 'escape-recovery.md');
    await withRequestContext({ author: { agent: 'history-path-test', model: 'test' } }, () =>
      atomicWriteBatch(
        [{ absPath: target, data: 'after-recovery\\n', ifMatch: ${JSON.stringify(beforeRevision)} }],
        { afterCommit: () => process.exit(97) },
      ));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      VAULT_PATH: vault,
      DATA_PATH: data,
      HISTORY_PATH: history,
      VERSION_HISTORY_ENABLED: "true",
      GIT_ENABLED: "false",
    },
    encoding: "utf-8",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });

  assert.notEqual(child.error?.code, "ETIMEDOUT", child.error?.message || "child must not time out");
  assert.equal(child.signal, null, `unexpected child signal: ${child.signal}`);
  assert.equal(child.status, 97, child.stderr);
  assert.equal(await fs.readFile(target, "utf-8"), "after-recovery\n");

  const [journalName] = await fs.readdir(journalRoot);
  assert.ok(journalName);
  const manifest = JSON.parse(await fs.readFile(path.join(journalRoot, journalName, "manifest.json"), "utf-8"));
  assert.equal(manifest.state, "committed");

  await fs.mkdir(outsideDirectory, { recursive: true });
  await linkDirectory(outsideDirectory, historyDirectory);

  await assert.rejects(recoverPendingBatches(), /Symbolic link escapes/i);
  assert.equal(await fs.readFile(target, "utf-8"), "after-recovery\n");
  assert.deepEqual(await fs.readdir(outsideDirectory), []);
  assert.deepEqual(await fs.readdir(journalRoot), [journalName]);

  await fs.unlink(historyDirectory);
  await recoverPendingBatches();

  assert.deepEqual(await fs.readdir(journalRoot), []);
  assert.equal(await fs.readFile(target, "utf-8"), "after-recovery\n");
  const historyNames = await fs.readdir(historyDirectory);
  const snapshots = historyNames.filter((name) => name.endsWith(".bak"));
  assert.equal(snapshots.length, 1);
  assert.equal(await fs.readFile(path.join(historyDirectory, snapshots[0]), "utf-8"), "before-recovery\n");

  // Recovery is idempotent after repair: a second pass is a no-op and must not
  // recreate the journal or duplicate the already-finalized History snapshot.
  await recoverPendingBatches();
  assert.deepEqual(await fs.readdir(journalRoot), []);
  const afterSecondRecover = (await fs.readdir(historyDirectory)).filter((name) => name.endsWith(".bak"));
  assert.deepEqual(afterSecondRecover, snapshots);
  assert.equal(await fs.readFile(path.join(historyDirectory, snapshots[0]), "utf-8"), "before-recovery\n");
});

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
