// W2FIX2 (#437 RETURN items 1+2) — the admission store's managed mode and load lifecycle.
//
// Negative controls for the response-seat's two real counterexamples:
//   * item 1 — "initialize only alpha → switch off → delete the record → restart ⇒ legacy, everything
//     served": the independent managed-mode enrollment sentinel must keep the instance refusing and
//     must preserve the trusted identity binding across the record loss.
//   * item 2 — "two concurrent loads read the old ENOENT; the first initializes; the late second
//     ENOENT resets the state ⇒ a second initialize accepts a replacement identity": the load must be
//     single-flight + cached, every read/write must share one serialized chain, and ENOENT must never
//     clear a known binding.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ADMISSION_APPROVED,
  ADMISSION_IDENTITY_CONFLICT,
  ADMISSIONS_INVALID_OPERATION,
  createAdmissionStore,
} from "../src/vault-runtime/admission-store.js";
import { defaultEnrollmentFile } from "../src/vault-runtime/enrollment-sentinel.js";
import { computeIdentityDigest } from "../src/vault-runtime/identity.js";

const ACTOR = "admin:test-session";
const quiet = { info() {}, warn() {}, log() {} };

function fakeIdentity(seed) {
  return {
    identityVersion: 1,
    digest: computeIdentityDigest({ canonicalRoot: `/fake/${seed}`, volumeId: String(1000 + seed), fileId: String(2000 + seed) }),
    canonicalRoot: `/fake/${seed}`,
    volumeId: String(1000 + seed),
    fileId: String(2000 + seed),
  };
}

const approved = (id, seed) => ({ id, root: `/fake/${seed}`, identity: fakeIdentity(seed), primary: false, writable: true });

async function withWorld(task) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2-lifecycle-"));
  const file = path.join(base, "data", "vault-admissions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    return await task({
      base,
      file,
      enrollmentFile: defaultEnrollmentFile(file),
      makeStore: (options = {}) => createAdmissionStore({ file, logger: quiet, ...options }),
    });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

test("ITEM 1: the sentinel records managed mode + the binding and survives a record-only delete", async () => {
  await withWorld(async ({ file, enrollmentFile, makeStore }) => {
    const store = makeStore();
    await store.load();
    assert.equal(store.isManaged(), false, "a never-managed store has no sentinel");
    await store.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });

    const sentinel = JSON.parse(await fs.readFile(enrollmentFile, "utf8"));
    assert.equal(sentinel.managed, true);
    assert.equal(sentinel.bindings.alpha.identity.digest, fakeIdentity(1).digest, "the trusted binding is enrolled");
    assert.equal(sentinel.bindings.alpha.generation, 1);

    // State loss: only the record disappears (the seat's repro step).
    await fs.rm(file, { force: true });
    const restarted = makeStore();
    const loaded = await restarted.load();
    assert.equal(loaded.exists, false);
    assert.equal(loaded.managed, true, "the surviving sentinel still proves the instance is managed");
    assert.equal(restarted.isInitialized(), false, "the record is gone: nothing is initialized/approved");
    assert.equal(restarted.bindingFor("alpha").digest, fakeIdentity(1).digest, "the trusted binding is recoverable for checks");
    await assert.rejects(fs.stat(file), "loading a missing record must not recreate it");
  });
});

test("ITEM 1: recovery never re-binds a replaced directory, even though the record is gone", async () => {
  await withWorld(async ({ file, makeStore }) => {
    const store = makeStore();
    await store.load();
    await store.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });
    await fs.rm(file, { force: true });

    const restarted = makeStore();
    await restarted.load();
    // The directory was replaced: same id, new identity. Re-confirming the directory is NOT recovery.
    await assert.rejects(
      restarted.initialize({ source: "recovery", configDigest: "cfg", approved: [approved("alpha", 9)], actor: ACTOR }),
      (error) => error.code === ADMISSION_IDENTITY_CONFLICT,
    );
    await assert.rejects(fs.stat(file), "a refused recovery writes nothing at all");
  });
});

test("ITEM 1: same-identity recovery is allowed and only ever raises the generation", async () => {
  await withWorld(async ({ file, makeStore }) => {
    const first = makeStore();
    await first.load();
    await first.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });
    await fs.rm(file, { force: true });

    const restarted = makeStore();
    await restarted.load();
    await restarted.initialize({ source: "recovery", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });
    assert.equal(restarted.isInitialized(), true);
    assert.equal(restarted.entryFor("alpha").admission, ADMISSION_APPROVED);
    assert.equal(restarted.entryFor("alpha").identity.digest, fakeIdentity(1).digest, "the original binding is re-used, never re-derived");
    assert.equal(restarted.entryFor("alpha").generation, 2, "recovery bumps, never lowers, the generation floor");
  });
});

test("ITEM 2: two concurrent load()s are ONE single-flight read and cannot clobber a later initialize", async () => {
  await withWorld(async ({ file, makeStore }) => {
    let reads = 0;
    let releaseRead;
    const holdRead = new Promise((resolve) => { releaseRead = resolve; });
    const started = { resolve: null, promise: null };
    started.promise = new Promise((resolve) => { started.resolve = resolve; });
    const fsApi = {
      ...fs,
      readFile: async (target, ...rest) => {
        if (target === file) {
          reads += 1;
          started.resolve();
          await holdRead;
        }
        return fs.readFile(target, ...rest);
      },
    };
    const store = createAdmissionStore({ file, fsApi, logger: quiet });

    const first = store.load();
    const second = store.load();
    assert.equal(first, second, "the second load shares the in-flight promise (single-flight)");
    await started.promise;
    assert.equal(reads, 1, "only ONE read was issued for two concurrent loads");

    releaseRead();
    const loaded = await first;
    assert.deepEqual(loaded.exists, false);
    assert.equal(reads, 1);

    // The seat's repro: initialize lands, then a "late" second load would reset the state to null.
    await store.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });
    const revisionAfterInit = store.revision();
    const again = await store.load();
    assert.equal(reads, 1, "a completed load is cached; no late re-read can publish stale state");
    assert.equal(again.exists, true, "the cached result reflects the committed state");
    assert.equal(store.revision(), revisionAfterInit, "the revision did not go backwards");
    assert.equal(store.entryFor("alpha").identity.digest, fakeIdentity(1).digest, "the binding is intact");

    // A second initialize is refused (migration already done) — the seat's "replacement identity" path.
    await assert.rejects(
      store.initialize({ source: "again", configDigest: "cfg", approved: [approved("alpha", 9)], actor: ACTOR }),
      (error) => error.code === ADMISSIONS_INVALID_OPERATION,
    );
    assert.equal(store.entryFor("alpha").identity.digest, fakeIdentity(1).digest);
  });
});

test("ITEM 2: reload() is serialized with mutations and an ENOENT never clears a known binding", async () => {
  await withWorld(async ({ file, makeStore }) => {
    const store = makeStore();
    await store.load();
    await store.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });

    // A normal reload re-reads the same revision.
    const reloaded = await store.reload();
    assert.equal(reloaded.exists, true);
    assert.equal(store.entryFor("alpha").admission, ADMISSION_APPROVED);

    // Record loss while the process is running: the known binding must survive the reload.
    await fs.rm(file, { force: true });
    const missing = await store.reload();
    assert.equal(missing.exists, false);
    assert.equal(missing.kept, true, "ENOENT kept the known state instead of clearing it");
    assert.equal(store.isInitialized(), true);
    assert.equal(store.entryFor("alpha").identity.digest, fakeIdentity(1).digest);

    // The retained state is still usable: a revoke commits a NEW document from it.
    await store.revoke("alpha", { actor: ACTOR });
    assert.equal(store.entryFor("alpha").admission, "pending");
    assert.equal(store.revision(), 2, "the known state was not lost");
    assert.equal((await store.load()).exists, true, "the revoke recreated the record from the retained state");
  });
});

test("ITEM 2: load crossed with a revoke stays serialized (no interleaved read/apply)", async () => {
  await withWorld(async ({ makeStore }) => {
    const store = makeStore();
    await store.load();
    await store.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });
    // A reload and a mutation issued together must not interleave: the reload cannot observe a
    // half-applied document, and the revoke cannot be lost.
    const [reloaded] = await Promise.all([store.reload(), store.revoke("alpha", { actor: ACTOR })]);
    assert.equal(reloaded.exists, true);
    assert.equal(store.entryFor("alpha").admission, "pending");
    assert.equal(store.revision(), 2);
    const onDisk = JSON.parse(await fs.readFile(store.file, "utf8"));
    assert.equal(onDisk.revision, 2, "disk and trusted state agree (no rollback)");
  });
});
