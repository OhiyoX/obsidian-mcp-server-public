// B1 — root-bound filesystem service tests (contract §10, §10.2, §21 MV-I01/MV-I02,
// §42 SEC-MV01; brief §2.1 + §2.4).
//
// These tests drive `vault-runtime/local-fs.js` directly (no global config root): every case
// builds its own scratch vault + data root so a failure can never touch the real Vault.
// The two negative controls of the per-runtime lock / containment oracles live here as
// deliberately broken companions (brief §2.4 item ② and the prefix-vs-includes control).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalFs } from "../src/vault-runtime/local-fs.js";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function scratch() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-b1-localfs-"));
  const root = path.join(base, "vault");
  const data = path.join(base, "data");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(data, "history"), { recursive: true });
  await fs.mkdir(path.join(data, "trash"), { recursive: true });
  return { base, root, data };
}

function makeFs({ root, data, deps } = {}) {
  return createLocalFs({
    root,
    dataPaths: { history: path.join(data, "history"), trash: path.join(data, "trash") },
    dataRoot: data,
    deps: { requireRequestAuthor: () => {}, trackGitMutation: () => {}, ...deps },
  });
}

async function leftovers(directory) {
  return (await fs.readdir(directory)).filter((name) => name.includes("obsidian-mcp"));
}

// ---------------------------------------------------------------------------
// §10 canonical containment (SEC-MV01)
// ---------------------------------------------------------------------------

test("#218: Windows drive and UNC inputs fail closed instead of becoming vault-relative", async () => {
  const { root, data } = await scratch();
  const localFs = makeFs({ root, data });
  // Each of these used to become a vault-relative path (`D:/...`) and materialize a `D:`
  // directory inside the vault, which Windows clients can never pull (issue #218).
  for (const input of ["C:\\work\\scratch", "C:/work/scratch", "D:notes/scratch", "D:", "\\\\server\\share\\notes"]) {
    assert.throws(() => localFs.resolveVaultPath(input), /Windows absolute and UNC paths are not accepted/, `must reject ${input}`);
  }
  // The pinned leading-slash semantics stay untouched by this fix.
  assert.equal(localFs.toVaultPath(localFs.resolveVaultPath("/etc/passwd")), "etc/passwd");
  // A colon that is not a drive prefix remains an ordinary character (Linux allows it).
  assert.equal(localFs.toVaultPath(localFs.resolveVaultPath("notes/log:2026.md")), "notes/log:2026.md");
});

test("containment matrix: lexical escapes, absolute inputs and foreign roots", async () => {
  const { root, data } = await scratch();
  const localFs = makeFs({ root, data });

  assert.throws(() => localFs.resolveVaultPath("../outside.md"), /Path traversal denied/);
  assert.throws(() => localFs.resolveVaultPath("notes/../../outside.md"), /Path traversal denied/);
  assert.throws(() => localFs.assertInsideVault(path.join(root, "..", "outside.md")), /Path traversal denied/);
  assert.throws(() => localFs.resolveTrashPath("../outside.bak"), /Trash path traversal denied/);
  // Sibling directories sharing the root as a *string prefix* must not pass a naive
  // prefix/`includes` check (found by the temp-break of brief §2.4 ①).
  const sibling = `${root}-evil`;
  assert.throws(() => localFs.assertInsideVault(path.join(sibling, "note.md")), /Path traversal denied/);
  await assert.rejects(() => localFs.assertCanonicalInsideVault(path.join(sibling, "note.md")), /Path traversal denied/);
  assert.throws(() => localFs.assertInsideVault(`${root}x/note.md`), /Path traversal denied/);
  // A leading slash is stripped by `normalizeVaultInput` (today's semantics) and therefore
  // stays *inside* the root instead of escaping it — pinned so a future change is visible.
  const absolute = localFs.resolveVaultPath("/etc/passwd");
  assert.ok(absolute.startsWith(root), `${absolute} must stay under ${root}`);
  assert.equal(localFs.toVaultPath(absolute), "etc/passwd");
  // NUL bytes are dropped before normalization, never passed to the filesystem.
  assert.equal(localFs.resolveVaultPath("notes/login\0out.md"), path.join(root, "notes", "loginout.md"));
});

test("containment matrix: symlink escaping the vault is rejected at I/O time", async (t) => {
  const { base, root, data } = await scratch();
  const localFs = makeFs({ root, data });
  const outside = path.join(base, "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.md"), "secret");

  const directoryLink = path.join(root, "escape-dir");
  let linkedDirectory = false;
  try { await fs.symlink(outside, directoryLink, "junction"); linkedDirectory = true; } catch { /* host refuses symlinks */ }
  const fileLink = path.join(root, "escape-file.md");
  let linkedFile = false;
  try { await fs.symlink(path.join(outside, "secret.md"), fileLink, "file"); linkedFile = true; } catch { /* needs privileges on Windows */ }
  if (!linkedDirectory && !linkedFile) {
    t.skip("host cannot create directory junctions or symlinks; canonical-containment symlink case skipped");
    return;
  }

  if (linkedDirectory) {
    const throughLink = path.join(directoryLink, "secret.md");
    await assert.rejects(() => localFs.assertCanonicalInsideVault(directoryLink), /Symbolic link escapes the vault/);
    await assert.rejects(() => localFs.assertCanonicalInsideVault(throughLink), /Symbolic link escapes the vault/);
    await assert.rejects(() => localFs.atomicWriteFile(path.join(directoryLink, "new.md"), "x"), /Symbolic link escapes the vault/);
    await assert.rejects(() => fs.readFile(path.join(outside, "new.md")), /ENOENT/, "the rejected write must not touch the outside target");
  }
  if (linkedFile) {
    await assert.rejects(() => localFs.assertCanonicalInsideVault(fileLink), /Symbolic link escapes the vault/);
    await assert.rejects(() => localFs.fileRevision(fileLink), /Symbolic link escapes the vault/);
  }
  // Missing targets inside the root stay allowed with allowMissing (the write path needs it).
  assert.equal(await localFs.assertCanonicalInsideVault(path.join(root, "new", "note.md"), { allowMissing: true }).then((p) => p.startsWith(root)), true);
});

test("negative control (brief §2.4 ①): a raw prefix check would accept escapes the real rule rejects", () => {
  const root = "/vault";
  const raw = "/vault/../etc/passwd"; // unresolved, exactly what a prefix check would see
  const sibling = "/vault-evil/x.md"; // shares the root as a string prefix
  const broken = (candidate) => candidate.startsWith(root); // the deliberate defect
  const correct = (candidate) => {
    const relative = path.relative(root, path.resolve(candidate));
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  assert.equal(broken(raw), true, "control precondition: the prefix check accepts the traversal");
  assert.equal(broken(sibling), true, "control precondition: it also accepts a sibling directory");
  assert.equal(correct(raw), false, "the production rule (resolve, then relative) rejects the traversal");
  assert.equal(correct(sibling), false, "and it rejects the sibling too");
  assert.equal(correct("/vault/notes/a.md"), true, "while still accepting a legitimate in-root path");
});

// ---------------------------------------------------------------------------
// §10 revision + atomic write
// ---------------------------------------------------------------------------

test("revision is a stable sha256 of the bytes and assertRevision reports the mismatch", async () => {
  const { root, data } = await scratch();
  const localFs = makeFs({ root, data });
  const abs = localFs.resolveVaultPath("notes/a.md");
  await localFs.atomicWriteFile(abs, "one");
  const first = await localFs.fileRevision(abs);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await localFs.fileRevision(abs), first, "same bytes must hash identically");
  assert.equal(await localFs.assertRevision(abs, first), undefined);
  await localFs.atomicWriteFile(abs, "two");
  const second = await localFs.fileRevision(abs);
  assert.notEqual(second, first);
  await assert.rejects(() => localFs.assertRevision(abs, first), /Revision conflict: expected sha256:[0-9a-f]{64}, current sha256:/);
});

test("atomic write keeps the temp+rename order, snapshots the previous revision and tracks Git once", async () => {
  const { root, data } = await scratch();
  const tracked = [];
  const localFs = makeFs({ root, data, deps: { trackGitMutation: (rel) => tracked.push(rel) } });
  const abs = localFs.resolveVaultPath("notes/a.md");

  const created = await localFs.atomicWriteFile(abs, "v1");
  assert.equal(created.preWriteVersionId, null, "a new file has no pre-write snapshot");
  assert.equal(await fs.readFile(abs, "utf8"), "v1");
  assert.deepEqual(await leftovers(path.dirname(abs)), [], "no temp file may survive a successful write");
  assert.equal(created.stat.size, 2);

  const overwritten = await localFs.atomicWriteFile(abs, "v2");
  assert.match(overwritten.preWriteVersionId, /^notes\/a\.md\/.*\.bak$/, "overwrite snapshots the OLD revision first");
  assert.equal(await fs.readFile(abs, "utf8"), "v2");
  assert.equal(await fs.readFile(path.join(data, "history", overwritten.preWriteVersionId), "utf8"), "v1");
  assert.deepEqual(tracked, ["notes/a.md", "notes/a.md"], "one Git track per accepted write (§16.4 seam)");

  // skipHistory keeps the write path but creates no further snapshot.
  const skipped = await localFs.atomicWriteFile(abs, "v3", { skipHistory: true });
  assert.equal(skipped.preWriteVersionId, null);
  assert.equal((await fs.readdir(path.join(data, "history", "notes", "a.md"))).length, 1);
});

test("a failed write leaves no half-written file and no temp file behind", async () => {
  const { root, data } = await scratch();
  const localFs = makeFs({ root, data });
  const abs = localFs.resolveVaultPath("notes/broken.md");
  await assert.rejects(() => localFs.atomicWriteFile(abs, { not: "writable data" }));
  await assert.rejects(() => fs.stat(abs), /ENOENT/);
  assert.deepEqual(await leftovers(path.dirname(abs)), []);
  // ifMatch on a missing file fails before any temp file is created.
  await assert.rejects(() => localFs.atomicWriteFile(abs, "x", { ifMatch: "sha256:" + "0".repeat(64) }), /Revision conflict: expected sha256:0+, but the file does not exist/);
  assert.deepEqual(await leftovers(path.dirname(abs)), []);
});

// ---------------------------------------------------------------------------
// §10 history / trash round-trips
// ---------------------------------------------------------------------------

test("history round-trip: list, read, restore and delete versions", async () => {
  const { root, data } = await scratch();
  const localFs = makeFs({ root, data });
  const abs = localFs.resolveVaultPath("notes/history.md");
  await localFs.atomicWriteFile(abs, "v1");
  await localFs.atomicWriteFile(abs, "v2");

  const versions = await localFs.listFileVersions("notes/history.md");
  assert.equal(versions.length, 1);
  assert.equal(versions[0].path, "notes/history.md");
  const read = await localFs.readFileVersion(versions[0].versionId);
  assert.equal(read.content, "v1");
  assert.equal(read.path, "notes/history.md");

  const restored = await localFs.restoreFileVersion(versions[0].versionId, { overwrite: true });
  assert.equal(restored.restoredPath, "notes/history.md");
  assert.equal(await fs.readFile(abs, "utf8"), "v1");
  assert.equal(restored.revision, await localFs.fileRevision(abs));

  // The restore used the same atomic-write order, so it snapshotted the pre-restore bytes.
  const afterRestore = await localFs.listFileVersions("notes/history.md");
  assert.equal(afterRestore.length, 2);
  assert.equal((await localFs.readFileVersion(afterRestore[0].versionId)).content, "v2");
  for (const version of afterRestore) await localFs.deleteFileVersion(version.versionId);
  assert.deepEqual(await localFs.listFileVersions("notes/history.md"), []);
  await assert.rejects(() => localFs.readFileVersion(versions[0].versionId), /ENOENT/);
});

test("trash round-trip: backup, list, read, restore and delete", async () => {
  const { root, data } = await scratch();
  const localFs = makeFs({ root, data });
  const abs = localFs.resolveVaultPath("notes/trash.md");
  await localFs.atomicWriteFile(abs, "payload");

  const backupPath = await localFs.backupBeforeDelete(abs);
  assert.ok(backupPath.startsWith(path.join(data, "trash")), backupPath);
  const listed = await localFs.listTrashEntries();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].originalPath, "notes/trash.md");
  const read = await localFs.readTrashEntry(listed[0].backupPath);
  assert.equal(read.content, "payload");
  assert.match(read.revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(read.originalPath, "notes/trash.md");

  await fs.rm(abs);
  const restored = await localFs.restoreTrashEntry(listed[0].backupPath, { removeBackup: true });
  assert.equal(restored.restoredPath, "notes/trash.md");
  assert.equal(restored.backupRemoved, true);
  assert.equal(await fs.readFile(abs, "utf8"), "payload");
  assert.deepEqual(await localFs.listTrashEntries(), []);
  assert.equal(await fs.stat(path.join(data, "trash", listed[0].backupPath)).then(() => true, () => false), false);

  await localFs.backupBeforeDelete(abs);
  const again = await localFs.listTrashEntries();
  assert.deepEqual(await localFs.deleteTrashEntry(again[0].backupPath), { deletedBackup: again[0].backupPath });
  assert.deepEqual(await localFs.listTrashEntries(), []);
  await assert.rejects(() => localFs.readTrashEntry(again[0].backupPath), /ENOENT/);
});

// ---------------------------------------------------------------------------
// §10.2 per-runtime mutation lock (MV-I01 / MV-I02) + the module-global control
// ---------------------------------------------------------------------------

test("same-runtime mutations stay strictly serial (MV-I01)", async () => {
  const { root, data } = await scratch();
  const localFs = makeFs({ root, data });
  const events = [];
  const gate = deferred();
  const first = localFs.withMutationLock(async () => { events.push("a1"); await gate.promise; events.push("a2"); });
  try {
    await tick();
    const second = localFs.withMutationLock(async () => { events.push("b1"); });
    await tick();
    assert.deepEqual(events, ["a1"], "the second callback must not start while the first holds the lock");
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["a1", "a2", "b1"]);
  } finally { gate.resolve(); }
});

test("two runtimes mutate in parallel (MV-I02) and keep independent file state", async () => {
  const a = await scratch();
  const b = await scratch();
  const fsA = makeFs(a);
  const fsB = makeFs(b);
  const events = [];
  const park = deferred();
  const first = fsA.withMutationLock(async () => { events.push("a1"); await park.promise; events.push("a2"); });
  try {
    await tick();
    const second = fsB.withMutationLock(async () => { events.push("b1"); });
    await tick();
    assert.ok(events.includes("b1"), `runtime B must enter while runtime A is parked (events: ${events.join(",")})`);
    park.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["a1", "b1", "a2"]);
  } finally { park.resolve(); }

  // Independent roots/paths: same relative note, different bytes, no cross-talk.
  await fsA.atomicWriteFile(fsA.resolveVaultPath("same.md"), "A");
  await fsB.atomicWriteFile(fsB.resolveVaultPath("same.md"), "B");
  assert.equal(await fs.readFile(path.join(a.root, "same.md"), "utf8"), "A");
  assert.equal(await fs.readFile(path.join(b.root, "same.md"), "utf8"), "B");
  assert.notEqual(fsA.resolveVaultPath("same.md"), fsB.resolveVaultPath("same.md"));
});

test("negative control (brief §2.4 ②): a module-global lock would serialize two runtimes", async () => {
  // Companion oracle: the same probe against a deliberately shared (module-global) tail.
  let sharedTail = Promise.resolve();
  const sharedLock = async (callback) => {
    const previous = sharedTail;
    let release;
    sharedTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await callback(); } finally { release(); }
  };
  const events = [];
  const park = deferred();
  const first = sharedLock(async () => { events.push("a1"); await park.promise; events.push("a2"); });
  try {
    await tick();
    const second = sharedLock(async () => { events.push("b1"); });
    await tick();
    assert.deepEqual(events, ["a1"], "control precondition: the shared tail blocks runtime B");
    park.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["a1", "a2", "b1"], "the real per-runtime lock produces [a1,b1,a2] instead");
  } finally { park.resolve(); }
});

// ---------------------------------------------------------------------------
// §5.3 / §10.1 write guard + instance hygiene
// ---------------------------------------------------------------------------

test("a runtime without an author provider refuses writes instead of bypassing the guard", async () => {
  const { root, data } = await scratch();
  const guarded = createLocalFs({
    root,
    dataPaths: { history: path.join(data, "history"), trash: path.join(data, "trash") },
    dataRoot: data,
  });
  await assert.rejects(() => guarded.atomicWriteFile(guarded.resolveVaultPath("a.md"), "x"), /deps\.requireRequestAuthor/);
  // Reads stay usable without the dependency.
  assert.deepEqual(await guarded.listTrashEntries(), []);
  assert.deepEqual(await guarded.listFileVersions("a.md"), []);
});

test("the instance is frozen, methods are detachable and state lives per instance", async () => {
  const a = await scratch();
  const b = await scratch();
  const fsA = makeFs(a);
  const fsB = makeFs(b);
  assert.ok(Object.isFrozen(fsA));
  assert.equal(fsA.root, path.resolve(a.root));
  assert.equal(fsA.trashRoot, path.join(path.resolve(a.data), "trash"));
  const { resolveVaultPath, atomicWriteFile, fileRevision } = fsA; // no `this` dependence
  const abs = resolveVaultPath("detached.md");
  await atomicWriteFile(abs, "detached");
  assert.match(await fileRevision(abs), /^sha256:[0-9a-f]{64}$/);
  assert.equal(fsA.resolveVaultPath("detached.md"), path.join(a.root, "detached.md"));
  assert.equal(fsB.resolveVaultPath("detached.md"), path.join(b.root, "detached.md"));
  assert.throws(() => createLocalFs({ root: "relative/root", dataPaths: { history: a.data, trash: a.data } }), /root must be absolute/);
  assert.throws(() => createLocalFs({ root: a.root }), /dataPaths must be the A7 vaultDataPaths mapping/);
});
