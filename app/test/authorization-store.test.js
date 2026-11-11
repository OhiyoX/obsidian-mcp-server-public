// P1 / Task 4 — committed authorization store with CAS and failure atomicity.
//
// Contract: design §9. One single-writer file, one serial queue, validate ->
// clone -> CAS(expectedRevision) -> same-directory temp write + sync -> rename ->
// publish the committed projection. A failed write publishes neither the
// candidate nor a success, so the old memory and the old file stay consistent.
// A missing or broken file is a `broken` snapshot: the store never writes an
// empty document and never falls back to a default. `repair` is the only way out
// and it saves the original bytes with their SHA-256 first.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename as fsRename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAuthorizationStore } from "../src/authorization/store.js";
import { AUTHORIZATION_CATALOG_VERSION } from "../src/authorization/catalog.js";
import { AUTHORIZATION_CODES, serializeAuthorizationDocument } from "../src/authorization/schema.js";

const { INVALID_DOCUMENT, STATE_UNAVAILABLE } = AUTHORIZATION_CODES;
const WRITE_FAILED = "authorization_store_io_error";
const STALE_REVISION = "stale_authorization_revision";
const REVISION_MISMATCH = "authorization_revision_mismatch";
const REPAIR_NOT_REQUIRED = "authorization_repair_not_required";

// The real io seam. The store must accept an injected copy of this shape so a
// test can make rename or sync fail.
const nodeIo = {
  mkdir: (target, options) => mkdir(target, options),
  readFile: (target) => readFile(target),
  open: (target, flags, mode) => open(target, flags, mode),
  rename: (from, to) => fsRename(from, to),
  unlink: (target) => unlink(target),
  chmod: (target, mode) => chmod(target, mode),
};

const DATA_ROOT = process.env.DATA_PATH;

function documentAt(revision, overrides = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: AUTHORIZATION_CATALOG_VERSION,
    revision,
    timeConstraintsEnabled: false,
    subjects: {
      "oauth-user:u1": {
        credentialEpoch: 0,
        grants: [{ target: { kind: "vault", vaultId: "vault" }, capabilities: ["get_note"] }],
      },
    },
    constraints: [],
    ...overrides,
  };
}

async function workdir(label) {
  assert.equal(typeof DATA_ROOT, "string", "DATA_PATH must point at the isolated test root");
  await mkdir(DATA_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(DATA_ROOT, `${label}-`));
  return { dir, file: path.join(dir, "authorization.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function recordingIo(overrides = {}) {
  const calls = [];
  const io = {};
  for (const [name, fn] of Object.entries(nodeIo)) {
    io[name] = async (...args) => {
      calls.push({ name, args });
      return fn(...args);
    };
  }
  return { io: { ...io, ...overrides }, calls };
}

function named(calls, name) {
  return calls.filter((call) => call.name === name);
}

function ioFailure(message) {
  return async () => {
    throw Object.assign(new Error(message), { code: "EIO" });
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function seed(file, document) {
  await writeFile(file, serializeAuthorizationDocument(document), { mode: 0o600 });
}

async function readOrNull(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** The controller's rule: memory and disk agree after every mutation. */
async function assertAgreement(store, file) {
  const snapshot = store.snapshot();
  const bytes = await readOrNull(file);
  if (snapshot.status === "ready") {
    assert.notEqual(bytes, null, "a ready store must have a state file");
    assert.equal(JSON.parse(bytes.toString("utf8")).revision, snapshot.revision, "memory and disk must carry the same revision");
    return;
  }
  assert.equal(snapshot.status, "broken");
}

async function listFiles(dir) {
  return (await readdir(dir)).sort();
}

test("failed_authorization_write_publishes_neither_candidate_nor_success", async () => {
  const work = await workdir("rename-failure");
  await seed(work.file, documentAt(1));
  const seededBytes = await readOrNull(work.file);
  const store = createAuthorizationStore({ file: work.file, io: recordingIo({ rename: ioFailure("rename broke") }).io });
  try {
    await store.ready;
    const before = store.snapshot();
    assert.equal(before.status, "ready");

    const result = await store.replace(1, documentAt(2, {
      subjects: { "oauth-user:u1": { credentialEpoch: 0, grants: [] } },
    }));

    assert.equal(result.ok, false);
    assert.equal(result.revision, null);
    assert.equal(result.code, WRITE_FAILED);
    assert.deepEqual(store.snapshot(), before, "the committed projection must not move");
    assert.deepEqual(await readOrNull(work.file), seededBytes, "the old file must stay byte-identical");
    assert.deepEqual(await listFiles(work.dir), ["authorization.json"], "a failed write leaves no temp file");
    await assertAgreement(store, work.file);
    // The guarantee assumes the rename seam does not lie: the real
    // `fs.promises.rename` either renames or throws. A seam that renames and then
    // throws would leave the disk ahead of memory; that case is outside this
    // contract, because `io` is a test seam and not a second filesystem.

    // Restart reads back only the acknowledged revision.
    const restarted = createAuthorizationStore({ file: work.file, io: nodeIo });
    await restarted.ready;
    assert.equal(restarted.snapshot().status, "ready");
    assert.equal(restarted.snapshot().revision, 1);
    await restarted.drain();
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("failed_temp_sync_publishes_nothing_and_never_renames", async () => {
  const work = await workdir("sync-failure");
  const { io, calls } = recordingIo();
  let syncFailures = 0;
  io.open = async (target, flags, mode) => {
    const handle = await open(target, flags, mode);
    return {
      writeFile: (bytes) => handle.writeFile(bytes),
      sync: async () => {
        syncFailures += 1;
        await handle.close();
        throw Object.assign(new Error("sync broke"), { code: "EIO" });
      },
      close: () => handle.close(),
    };
  };
  const store = createAuthorizationStore({ file: work.file, io });
  try {
    await store.ready;
    assert.deepEqual(store.snapshot(), { status: "broken", code: STATE_UNAVAILABLE });
    const result = await store.replace(0, documentAt(1));
    assert.equal(result.ok, false);
    assert.equal(result.code, STATE_UNAVAILABLE, "a broken store has no CAS base to write against");

    // Repair is the supported path; make its durable write fail at sync.
    const repair = await store.repair(documentAt(1));
    assert.equal(repair.ok, false);
    assert.equal(repair.code, WRITE_FAILED);
    assert.equal(syncFailures, 1);
    assert.deepEqual(named(calls, "rename"), [], "sync failure must not reach rename");
    assert.deepEqual(store.snapshot(), { status: "broken", code: STATE_UNAVAILABLE });
    assert.deepEqual(await listFiles(work.dir), [], "a failed sync leaves neither temp nor state file");
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("stale_revision_is_refused_and_nothing_is_written", async () => {
  const work = await workdir("stale");
  await seed(work.file, documentAt(1));
  const { io, calls } = recordingIo();
  const store = createAuthorizationStore({ file: work.file, io });
  try {
    await store.ready;
    const first = await store.replace(1, documentAt(2));
    assert.equal(first.ok, true);
    assert.equal(first.revision, 2);
    assert.equal(first.code, null);
    assert.equal(first.durabilityUncertain, undefined, "a durable write carries no uncertainty flag");
    await assertAgreement(store, work.file);
    const committed = await readOrNull(work.file);
    const callsBefore = calls.length;

    const stale = await store.replace(1, documentAt(2));
    assert.equal(stale.ok, false);
    assert.equal(stale.code, STALE_REVISION);
    assert.equal(stale.revision, null);
    assert.deepEqual(await readOrNull(work.file), committed, "a stale write must not touch the file");
    assert.deepEqual(calls.slice(callsBefore), [], "a stale write must not open or rename anything");
    assert.equal(store.snapshot().revision, 2);
    await assertAgreement(store, work.file);
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("concurrent_writes_queue_and_exactly_one_cas_wins", async () => {
  const work = await workdir("concurrent");
  await seed(work.file, documentAt(1));
  const store = createAuthorizationStore({ file: work.file, io: nodeIo });
  try {
    await store.ready;
    const results = await Promise.all([
      store.replace(1, documentAt(2, { subjects: { "oauth-user:u1": { credentialEpoch: 0, grants: [] } } })),
      store.replace(1, documentAt(2, { subjects: { "oauth-user:u1": { credentialEpoch: 1, grants: [] } } })),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.code === STALE_REVISION).length, 1);
    assert.equal(store.snapshot().revision, 2);
    await assertAgreement(store, work.file);

    const restarted = createAuthorizationStore({ file: work.file, io: nodeIo });
    await restarted.ready;
    assert.equal(restarted.snapshot().revision, 2);
    await restarted.drain();
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("a_failed_write_does_not_poison_the_queue", async () => {
  const work = await workdir("queue-recovery");
  await seed(work.file, documentAt(1));
  const store = createAuthorizationStore({ file: work.file, io: nodeIo });
  try {
    await store.ready;
    // A candidate that fails validation runs before a healthy one.
    const invalid = await store.replace(1, { ...documentAt(2), subjects: { "alice": { credentialEpoch: 0, grants: [] } } });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, INVALID_DOCUMENT);
    const good = await store.replace(1, documentAt(2));
    assert.equal(good.ok, true);
    assert.equal(good.revision, 2);
    await assertAgreement(store, work.file);
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("missing_file_is_broken_and_is_never_seeded", async () => {
  const work = await workdir("missing");
  const { io, calls } = recordingIo();
  const store = createAuthorizationStore({ file: work.file, io });
  try {
    await store.ready;
    assert.deepEqual(store.snapshot(), { status: "broken", code: STATE_UNAVAILABLE });
    assert.equal(await readOrNull(work.file), null, "a missing file must not be created at startup");

    const result = await store.replace(0, documentAt(1));
    assert.equal(result.ok, false);
    assert.equal(result.code, STATE_UNAVAILABLE);
    assert.equal(await readOrNull(work.file), null);
    assert.deepEqual(named(calls, "rename"), []);
    assert.deepEqual(named(calls, "open"), []);
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("corrupt_file_is_broken_and_repair_saves_the_original_with_sha256", async () => {
  const work = await workdir("repair");
  const brokenBytes = Buffer.from('{"schemaVersion":1,"schemaVersion":2}\n', "utf8");
  await writeFile(work.file, brokenBytes, { mode: 0o600 });
  const { io, calls } = recordingIo();
  const store = createAuthorizationStore({ file: work.file, io });
  try {
    await store.ready;
    assert.deepEqual(store.snapshot(), { status: "broken", code: STATE_UNAVAILABLE });
    const refused = await store.replace(0, documentAt(1));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, STATE_UNAVAILABLE);

    const result = await store.repair(documentAt(3));
    assert.equal(result.ok, true);
    assert.equal(result.revision, 3);
    assert.equal(result.durabilityUncertain, undefined);
    await assertAgreement(store, work.file);
    const expectedSha = createHash("sha256").update(brokenBytes).digest("hex");
    assert.equal(result.sha256, expectedSha);
    assert.equal(typeof result.backupFile, "string");

    const backupBytes = await readFile(result.backupFile);
    assert.deepEqual(backupBytes, brokenBytes, "the original bytes survive verbatim");
    // The store asks for 0600 on the backup; this worktree is a CIFS mount, so the
    // mount decides the real bits and `stat().mode` cannot prove it here.
    const backupOpen = named(calls, "open").find((call) => call.args[0] === result.backupFile);
    assert.deepEqual(backupOpen.args.slice(1), ["w", 0o600]);
    assert.equal(calls.some((call) => call.name === "chmod" && call.args[0] === result.backupFile && call.args[1] === 0o600), true);
    assert.equal(store.snapshot().status, "ready");
    assert.equal(store.snapshot().revision, 3);

    const restarted = createAuthorizationStore({ file: work.file, io: nodeIo });
    await restarted.ready;
    assert.equal(restarted.snapshot().status, "ready");
    assert.equal(restarted.snapshot().revision, 3);
    await restarted.drain();

    // Repairing twice must not overwrite the first original with different bytes.
    await writeFile(work.file, Buffer.from("{}"), { mode: 0o600 });
    const second = createAuthorizationStore({ file: work.file, io: nodeIo });
    await second.ready;
    const secondRepair = await second.repair(documentAt(1));
    assert.equal(secondRepair.ok, true);
    assert.notEqual(secondRepair.backupFile, result.backupFile);
    assert.deepEqual(await readFile(result.backupFile), brokenBytes);
    await second.drain();
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("failed_repair_keeps_the_store_broken_and_the_original_intact", async () => {
  const work = await workdir("repair-failure");
  const brokenBytes = Buffer.from("not json\n", "utf8");
  await writeFile(work.file, brokenBytes, { mode: 0o600 });
  const store = createAuthorizationStore({ file: work.file, io: recordingIo({ rename: ioFailure("rename broke") }).io });
  try {
    await store.ready;
    const result = await store.repair(documentAt(2));
    assert.equal(result.ok, false);
    assert.equal(result.code, WRITE_FAILED);
    assert.deepEqual(store.snapshot(), { status: "broken", code: STATE_UNAVAILABLE });
    assert.deepEqual(await readFile(work.file), brokenBytes, "a failed repair does not replace the original");

    const restarted = createAuthorizationStore({ file: work.file, io: nodeIo });
    await restarted.ready;
    assert.equal(restarted.snapshot().status, "broken");
    await restarted.drain();
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("snapshot_never_shows_an_uncommitted_candidate", async () => {
  const work = await workdir("projection");
  await seed(work.file, documentAt(1));
  const gate = deferred();
  const { io } = recordingIo();
  io.rename = async (from, to) => {
    await gate.promise;
    return fsRename(from, to);
  };
  const store = createAuthorizationStore({ file: work.file, io });
  try {
    await store.ready;
    const before = store.snapshot();
    const pending = store.replace(1, documentAt(2, {
      subjects: { "oauth-user:u1": { credentialEpoch: 0, grants: [] } },
    }));
    // The write is in flight: memory still shows the committed projection.
    assert.deepEqual(store.snapshot(), before);
    assert.equal(JSON.parse(await readOrNull(work.file)).revision, 1, "the file still holds the committed revision");
    gate.resolve();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(store.snapshot().revision, 2);

    // Frozen: a consumer cannot mutate the committed projection.
    assert.equal(Object.isFrozen(store.snapshot()), true);
    assert.equal(Object.isFrozen(store.snapshot().document), true);
    assert.equal(Object.isFrozen(store.snapshot().document.subjects["oauth-user:u1"]), true);
    assert.throws(() => { store.snapshot().revision = 99; }, TypeError);
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("the_state_file_is_written_0600_and_the_revision_must_advance_by_one", async () => {
  const work = await workdir("mode");
  await seed(work.file, documentAt(1));
  const { io, calls } = recordingIo();
  const store = createAuthorizationStore({ file: work.file, io });
  try {
    await store.ready;
    // The load asks for 0600 too. This worktree is a CIFS mount, so `stat().mode`
    // cannot prove the bits; the requested mode is the observable contract.
    assert.equal(calls.some((call) => call.name === "chmod" && call.args[0] === work.file && call.args[1] === 0o600), true);

    // A healthy store is written through CAS only; repair cannot bypass it.
    const seededBytes = await readOrNull(work.file);
    const notNeeded = await store.repair(documentAt(3));
    assert.equal(notNeeded.ok, false);
    assert.equal(notNeeded.code, REPAIR_NOT_REQUIRED);
    assert.deepEqual(await readOrNull(work.file), seededBytes);

    const repeated = await store.replace(1, documentAt(1));
    assert.equal(repeated.ok, false);
    assert.equal(repeated.code, REVISION_MISMATCH);

    const skipped = await store.replace(1, documentAt(5));
    assert.equal(skipped.ok, false);
    assert.equal(skipped.code, REVISION_MISMATCH);

    const accepted = await store.replace(1, documentAt(2));
    assert.equal(accepted.ok, true);
    await assertAgreement(store, work.file);
    const tempOpen = named(calls, "open").find((call) => String(call.args[0]).includes(".tmp-"));
    assert.notEqual(tempOpen, undefined, "the write must go through a same-directory temp file");
    assert.equal(path.dirname(tempOpen.args[0]), work.dir);
    assert.deepEqual(tempOpen.args.slice(1), ["wx", 0o600]);
    assert.deepEqual(await listFiles(work.dir), ["authorization.json"]);
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("a_failed_directory_sync_adopts_the_durable_name", async () => {
  const work = await workdir("dir-sync");
  await seed(work.file, documentAt(1));
  const { io } = recordingIo();
  const openThroughSeam = io.open;
  let failDirectorySync = true;
  io.open = async (target, flags, mode) => {
    if (target === work.dir && failDirectorySync) {
      failDirectorySync = false;
      // The rename already happened; only the directory flush fails, once.
      return {
        writeFile: async () => {},
        sync: async () => { throw Object.assign(new Error("directory fsync failed"), { code: "EIO" }); },
        close: async () => {},
      };
    }
    return openThroughSeam(target, flags, mode);
  };
  const store = createAuthorizationStore({ file: work.file, io });
  try {
    await store.ready;
    const result = await store.replace(1, documentAt(2));
    // The name is in place, so the write is durable-but-unconfirmed, not failed.
    assert.equal(result.ok, true);
    assert.equal(result.revision, 2);
    assert.equal(result.durabilityUncertain, true);
    assert.equal(store.snapshot().revision, 2, "the disk is the truth, so memory adopts it");
    assert.equal(JSON.parse((await readOrNull(work.file)).toString("utf8")).revision, 2);
    await assertAgreement(store, work.file);
    // The next CAS starts from the adopted revision, so no Admin save can overwrite it.
    const next = await store.replace(2, documentAt(3));
    assert.equal(next.ok, true);
    assert.equal(next.durabilityUncertain, undefined, "the flag is set only on the uncertain path");
    await assertAgreement(store, work.file);

    const restarted = createAuthorizationStore({ file: work.file, io: nodeIo });
    await restarted.ready;
    assert.equal(restarted.snapshot().revision, 3);
    await restarted.drain();
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("drain_waits_for_queued_writes", async () => {
  const work = await workdir("drain");
  await seed(work.file, documentAt(1));
  const store = createAuthorizationStore({ file: work.file, io: nodeIo });
  try {
    await store.ready;
    const pending = [
      store.replace(1, documentAt(2)),
      store.replace(2, documentAt(3)),
      store.replace(3, documentAt(4)),
    ];
    await store.drain();
    const settled = await Promise.all(pending);
    assert.deepEqual(settled.map((result) => result.ok), [true, true, true]);
    assert.equal(store.snapshot().revision, 4);
    const restarted = createAuthorizationStore({ file: work.file, io: nodeIo });
    await restarted.ready;
    assert.equal(restarted.snapshot().revision, 4);
    await restarted.drain();
  } finally {
    await store.drain();
    await work.cleanup();
  }
});

test("a_missing_file_argument_is_refused", () => {
  assert.throws(() => createAuthorizationStore({ io: nodeIo }), TypeError);
  assert.throws(() => createAuthorizationStore({ file: "", io: nodeIo }), TypeError);
  assert.throws(() => createAuthorizationStore({ file: path.join(tmpdir(), "authorization.json") }), TypeError);
});
