// W2 (#437) — admission persistence, contract §2.2 / §2.3 / §3.1.
//
// Acceptance evidence: initialization / state loss / replacement-then-restart approval refusal /
// corrupt-file fail-closed (bytes preserved) / capacity / single-writer atomicity.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ADMISSIONS_CORRUPT,
  ADMISSIONS_CAPACITY_EXCEEDED,
  ADMISSIONS_INVALID_OPERATION,
  ADMISSIONS_VERSION,
  ADMISSIONS_WRITE_FAILED,
  ADMISSION_APPROVED,
  ADMISSION_IDENTITY_CONFLICT,
  ADMISSION_PENDING,
  MAX_ADMISSION_ENTRIES,
  emptyAdmissionState,
  serializeRegistrySnapshot,
  validateAdmissionState,
  createAdmissionStore,
} from "../src/vault-runtime/admission-store.js";
import { computeIdentityDigest } from "../src/vault-runtime/identity.js";

const ACTOR = "admin:test-session";

/** A syntactically valid identity record for an id that never touches the filesystem. */
function fakeIdentity(seed) {
  return {
    identityVersion: 1,
    digest: computeIdentityDigest({ canonicalRoot: `/fake/${seed}`, volumeId: String(1000 + seed), fileId: String(2000 + seed) }),
    canonicalRoot: `/fake/${seed}`,
    volumeId: String(1000 + seed),
    fileId: String(2000 + seed),
  };
}

async function withStore(task) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2-admissions-"));
  const file = path.join(base, "data", "vault-admissions.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    return await task({ base, file, makeStore: (options = {}) => createAdmissionStore({ file, logger: { info() {} }, ...options }) });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

const approved = (id, seed) => ({ id, root: `/fake/${seed}`, identity: fakeIdentity(seed), primary: false, writable: true });

test("a missing file is not corruption: it loads as uninitialized and approves nothing", async () => {
  await withStore(async ({ makeStore }) => {
    const store = makeStore();
    const loaded = await store.load();
    assert.equal(loaded.exists, false);
    assert.equal(store.isInitialized(), false);
    assert.equal(store.snapshot(), null);
    assert.deepEqual(store.entries(), {});
    await assert.rejects(store.commit({ entries: {} }), (error) => error.code === ADMISSIONS_INVALID_OPERATION);
    assert.equal((await fs.stat(path.dirname(store.file)).catch(() => null))?.isDirectory(), true);
    await assert.rejects(fs.stat(store.file), "loading a missing file must not create it");
  });
});

test("explicit initialize creates the migration marker + approved entries in ONE atomic document", async () => {
  await withStore(async ({ file, makeStore }) => {
    const store = makeStore();
    await store.load();
    await store.initialize({ source: "admin-confirmed-list", configDigest: "cfg-1", approved: [approved("alpha", 1)], actor: ACTOR });
    assert.equal(store.isInitialized(), true);
    assert.equal(store.revision(), 1);

    const document = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(document.version, ADMISSIONS_VERSION);
    assert.deepEqual(document.migration, { done: true, doneAt: document.migration.doneAt, source: "admin-confirmed-list", configDigest: "cfg-1" });
    assert.ok(Number.isFinite(Date.parse(document.migration.doneAt)));
    assert.equal(document.entries.alpha.admission, ADMISSION_APPROVED);
    assert.equal(document.entries.alpha.approvedBy, ACTOR, "approvedBy is the trusted operator identity");
    assert.equal(document.entries.alpha.generation, 1);
    assert.equal(document.entries.alpha.identityConflict, false);
    assert.equal(document.registry.revision, document.revision, "registry and revision share one commit point");
    assert.equal(document.registry.vaults.alpha.identity.digest, document.entries.alpha.identity.digest);

    // A second initialization is refused — 重启/开关反复切换/配置增加都不得再次自动迁移 (contract §2.3).
    await assert.rejects(store.initialize({ source: "again", configDigest: "cfg-2", approved: [approved("beta", 2)], actor: ACTOR }), (error) => error.code === ADMISSIONS_INVALID_OPERATION);
    // …and a reload (restart) still refuses it.
    const restarted = makeStore();
    await restarted.load();
    assert.equal(restarted.isInitialized(), true);
    await assert.rejects(restarted.initialize({ source: "again", configDigest: "cfg-2", approved: [], actor: ACTOR }), (error) => error.code === ADMISSIONS_INVALID_OPERATION);
    assert.equal(restarted.entryFor("beta"), undefined);
  });
});

test("the migration marker is independent of whether entries are empty", async () => {
  await withStore(async ({ makeStore }) => {
    const store = makeStore();
    await store.load();
    await store.initialize({ source: "empty-confirmed-list", configDigest: "cfg", approved: [], actor: ACTOR });
    assert.equal(store.isInitialized(), true, "an explicitly confirmed EMPTY list is still an initialization");
    const reloaded = makeStore();
    await reloaded.load();
    assert.equal(reloaded.isInitialized(), true);
    assert.deepEqual(reloaded.entries(), {});
    // The primary is not implicitly approved by this path either.
    assert.equal(reloaded.entryFor("vault"), undefined);
  });
});

test("a corrupt/unreadable file is fail-closed and preserved byte-for-byte", async () => {
  await withStore(async ({ file, makeStore }) => {
    const corrupt = '{ "version": 1, "revision": 3, "migration": ';
    await fs.writeFile(file, corrupt, "utf8");
    const store = makeStore();
    await assert.rejects(store.load(), (error) => error.code === ADMISSIONS_CORRUPT);
    assert.equal(await fs.readFile(file, "utf8"), corrupt, "the corrupt file must be left untouched for an operator");
    assert.equal(store.isInitialized(), false);
    assert.equal(store.snapshot(), null);
    // A mutation after a failed load must not silently overwrite the file with a fresh document.
    await assert.rejects(store.initialize({ source: "s", configDigest: "c", approved: [], actor: ACTOR }), (error) => error.code === ADMISSIONS_INVALID_OPERATION);
    assert.equal(await fs.readFile(file, "utf8"), corrupt);

    // An unreadable file (EACCES / EISDIR) is not "not initialized" either.
    const directory = path.join(path.dirname(file), "as-a-directory.json");
    await fs.mkdir(directory);
    const unreadable = createAdmissionStore({ file: directory, logger: { info() {} } });
    await assert.rejects(unreadable.load(), (error) => error.code === "VAULT_ADMISSIONS_READ_FAILED");

    // Unknown future schema versions must not be guessed.
    await fs.writeFile(file, JSON.stringify({ ...emptyAdmissionState(), version: 99 }), "utf8");
    await assert.rejects(makeStore().load(), (error) => error.code === ADMISSIONS_CORRUPT);
  });
});

test("load-time cross-validation refuses a half-applied or inconsistent document", async () => {
  await withStore(async ({ file, makeStore }) => {
    const good = {
      version: 1,
      revision: 2,
      migration: { done: true, doneAt: new Date(0).toISOString(), source: "s", configDigest: "c" },
      entries: { alpha: { identity: fakeIdentity(1), admission: ADMISSION_APPROVED, firstSeenAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(), approvedAt: new Date(0).toISOString(), approvedBy: ACTOR, generation: 1, note: null, identityConflict: false } },
      registry: { revision: 2, vaults: { alpha: { id: "alpha", root: "/fake/1", canonicalRoot: "/fake/1", primary: false, writable: true, identity: fakeIdentity(1) } }, skipped: [] },
    };
    assert.equal(validateAdmissionState(good), good);

    const cases = [
      ["registry revision drift", { ...good, registry: { ...good.registry, revision: 1 } }],
      ["registry vault without an entry", { ...good, entries: {}, registry: { ...good.registry, vaults: { alpha: good.registry.vaults.alpha } } }],
      ["approved entry with a different identity than its registry record", { ...good, registry: { revision: 2, vaults: { alpha: { ...good.registry.vaults.alpha, identity: fakeIdentity(9) } }, skipped: [] } }],
      ["approved entry without an operator identity", { ...good, entries: { alpha: { ...good.entries.alpha, approvedBy: "" } } }],
      ["approved entry without an identity binding", { ...good, entries: { alpha: { ...good.entries.alpha, identity: null } } }],
      ["pending entry that kept approval metadata", { ...good, entries: { alpha: { ...good.entries.alpha, admission: ADMISSION_PENDING } } }],
      ["unknown document field", { ...good, extra: true }],
      ["unknown entry field", { ...good, entries: { alpha: { ...good.entries.alpha, surprise: 1 } } }],
      ["migration.done without a source", { ...good, migration: { done: true, doneAt: new Date(0).toISOString(), source: "", configDigest: "c" } }],
      ["invalid vault id key", { ...good, entries: { "../escape": good.entries.alpha } }],
      ["non-integer generation", { ...good, entries: { alpha: { ...good.entries.alpha, generation: 0 } } }],
    ];
    for (const [label, document] of cases) {
      await fs.writeFile(file, JSON.stringify(document), "utf8");
      await assert.rejects(makeStore().load(), (error) => error.code === ADMISSIONS_CORRUPT, label);
    }
  });
});

test("a write failure is explicit and leaves no partial document behind", async () => {
  await withStore(async ({ file, makeStore }) => {
    const store = makeStore();
    await store.load();
    await store.initialize({ source: "s", configDigest: "c", approved: [approved("alpha", 1)], actor: ACTOR });
    const before = await fs.readFile(file, "utf8");

    const failing = createAdmissionStore({
      file,
      logger: { info() {} },
      // Fail ONLY the record rename (the managed-mode sentinel is a separate file and must survive);
      // the record write failure is still explicit and leaves no partial document.
      fsApi: {
        ...fs,
        rename: async (from, to) => { if (to === file) throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); return fs.rename(from, to); },
      },
    });
    await failing.load();
    await assert.rejects(failing.revoke("alpha", { actor: ACTOR }), (error) => error.code === ADMISSIONS_WRITE_FAILED);
    assert.equal(await fs.readFile(file, "utf8"), before, "the previous committed document survives a failed write");
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")), [], "no temp file may be left behind");
  });
});

test("单写者: concurrent decisions serialize instead of losing an update", async () => {
  await withStore(async ({ makeStore }) => {
    const store = makeStore();
    await store.load();
    await store.initialize({ source: "s", configDigest: "c", approved: [approved("alpha", 1), approved("beta", 2)], actor: ACTOR });
    await Promise.all([store.revoke("alpha", { actor: ACTOR }), store.revoke("beta", { actor: ACTOR })]);
    assert.equal(store.entryFor("alpha").admission, ADMISSION_PENDING);
    assert.equal(store.entryFor("beta").admission, ADMISSION_PENDING);
    assert.equal(store.revision(), 3, "two serialized mutations: 1 initialize + 2 revokes");
    const document = JSON.parse(await (await import("node:fs/promises")).readFile(store.file, "utf8"));
    assert.equal(document.revision, store.revision(), "the file is the single source of truth");
  });
});

test("approval refuses an unknown id, a missing operator and a replaced directory (v1 freeze)", async () => {
  await withStore(async ({ file, makeStore }) => {
    const store = makeStore();
    await store.load();
    await store.initialize({ source: "s", configDigest: "c", approved: [], actor: ACTOR });
    // Discovery registers a pending entry (through a reconciliation commit) before approval.
    await store.commit({ entries: { alpha: { identity: fakeIdentity(1), admission: ADMISSION_PENDING, firstSeenAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(), approvedAt: null, approvedBy: null, generation: 1, note: null, identityConflict: false } }, registry: { vaults: {}, skipped: [] } });

    await assert.rejects(store.approve("ghost", { actor: ACTOR, identity: fakeIdentity(5) }), (error) => error.code === ADMISSIONS_INVALID_OPERATION);
    await assert.rejects(store.approve("alpha", { actor: "  ", identity: fakeIdentity(1) }), (error) => error.code === ADMISSIONS_INVALID_OPERATION);

    // The directory was replaced: the persisted binding must win and the id must NOT be reusable.
    const replacement = fakeIdentity(42);
    await assert.rejects(store.approve("alpha", { actor: ACTOR, identity: replacement }), (error) => error.code === ADMISSION_IDENTITY_CONFLICT && /new Vault ID/.test(error.message));
    assert.equal(store.entryFor("alpha").admission, ADMISSION_PENDING, "a refused approval changes nothing");
    assert.equal(store.entryFor("alpha").identity.digest, fakeIdentity(1).digest, "the original binding is never overwritten");

    // Restart: the refusal must be enforced by the PERSISTED binding, not by in-memory state.
    const restarted = makeStore();
    await restarted.load();
    await assert.rejects(restarted.approve("alpha", { actor: ACTOR, identity: replacement }), (error) => error.code === ADMISSION_IDENTITY_CONFLICT);

    // A legitimately observed identity can be approved, and an approval survives a restart.
    await store.approve("alpha", { actor: ACTOR, identity: fakeIdentity(1) });
    assert.equal(store.entryFor("alpha").admission, ADMISSION_APPROVED);
    assert.equal(store.entryFor("alpha").generation, 2, "an admission boundary bumps the generation");
    const afterApproval = makeStore();
    await afterApproval.load();
    assert.equal(afterApproval.entryFor("alpha").admission, ADMISSION_APPROVED);
    assert.equal(afterApproval.entryFor("alpha").approvedBy, ACTOR);

    // An id flagged as replaced stays refused even without supplying a fresh identity.
    await store.commit({
      entries: { alpha: { ...store.entryFor("alpha"), identityConflict: true } },
      registry: { vaults: {}, skipped: [] },
    });
    await assert.rejects(store.approve("alpha", { actor: ACTOR }), (error) => error.code === ADMISSION_IDENTITY_CONFLICT);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).entries.alpha.identity.digest, fakeIdentity(1).digest);
  });
});

test("the persistent capacity guard fails explicitly instead of dropping history", async () => {
  await withStore(async ({ file, makeStore }) => {
    const document = { ...emptyAdmissionState(), revision: 1, migration: { done: true, doneAt: new Date(0).toISOString(), source: "s", configDigest: "c" }, registry: { revision: 1, vaults: {}, skipped: [] } };
    const pending = (seed) => ({ identity: fakeIdentity(seed), admission: ADMISSION_PENDING, firstSeenAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(), approvedAt: null, approvedBy: null, generation: 1, note: null, identityConflict: false });
    const atBound = {};
    for (let index = 0; index < MAX_ADMISSION_ENTRIES; index += 1) atBound[`v${index}`] = pending(index + 1);
    const atBoundDocument = { ...document, entries: atBound };
    assert.equal(validateAdmissionState(atBoundDocument), atBoundDocument, "the bound itself is allowed");

    const oversized = { ...document, entries: { ...atBound, overflow: pending(MAX_ADMISSION_ENTRIES + 1) } };
    assert.throws(() => validateAdmissionState(oversized), (error) => error.code === ADMISSIONS_CAPACITY_EXCEEDED, "loading an oversized file must fail");
    await fs.writeFile(file, JSON.stringify(oversized), "utf8");
    await assert.rejects(makeStore().load(), (error) => error.code === ADMISSIONS_CAPACITY_EXCEEDED);

    // A commit that would grow the set past the bound is refused too — never a silent truncation.
    const writes = [];
    const store = makeStore({
      fsApi: {
        ...fs,
        writeFile: async (...args) => { writes.push(args[0]); return fs.writeFile(...args); },
      },
    });
    await fs.rm(file, { force: true });
    await store.load();
    await store.initialize({ source: "s", configDigest: "c", approved: [], actor: ACTOR });
    await store.commit({ entries: atBound, registry: { vaults: {}, skipped: [] } });
    await assert.rejects(store.commit({ entries: { ...atBound, overflow: pending(1) }, registry: { vaults: {}, skipped: [] } }), (error) => error.code === ADMISSIONS_CAPACITY_EXCEEDED);
    assert.equal(store.revision(), 2, "the refused write did not advance the revision");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).revision, 2);
  });
});

test("serializeRegistrySnapshot keeps only the facts needed to re-verify a decision", () => {
  const identity = fakeIdentity(1);
  const projection = serializeRegistrySnapshot({
    vaults: [{ id: "alpha", root: "/fake/1", canonicalRoot: "/fake/1", primary: false, writable: true, capabilities: { notes: { available: true } } }],
    identities: { alpha: identity },
  });
  assert.deepEqual(projection, { vaults: { alpha: { id: "alpha", root: "/fake/1", canonicalRoot: "/fake/1", primary: false, writable: true, identity } }, skipped: [] });
  assert.deepEqual(serializeRegistrySnapshot(null), { vaults: {}, skipped: [] });
});
