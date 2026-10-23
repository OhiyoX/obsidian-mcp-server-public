// W2FIX3 (#437 RETURN-2, items 1+2) — sentinel path independence and trusted read-back.
//
// Independent negative controls for the second seat ruling:
//   * item 1 — "configure the record and the enrollment sentinel onto the SAME actual file ⇒ a
//     record-only delete takes the sentinel with it and a restarted instance falls back to legacy":
//     the store/composition root must refuse a colliding configuration (normalized path, platform
//     case folding, real parent alias) BEFORE any read or write.
//   * item 2 — "restore an older legal record and reload ⇒ revision 4→2, pending→approved,
//     generation 2→1, then the old approval is served again": a read-back may never move the trusted
//     revision/generation backwards, may never be below the durable sentinel floor, and a stale
//     record must be refused without touching either file.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ADMISSION_IDENTITY_CONFLICT,
  ADMISSIONS_RECOVERY_REQUIRED,
  ADMISSIONS_RELOAD_REFUSED,
  ADMISSION_PATH_CONFLICT,
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

async function withBase(task) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2fix3-adm-"));
  try {
    return await task(base);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function linkDirectory(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// item 1 — enforced sentinel independence
// ---------------------------------------------------------------------------

test("ITEM 1: the same configured path for record and sentinel is refused at construction", async () => {
  await withBase(async (base) => {
    const file = path.join(base, "data", "vault-admissions.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    assert.throws(
      () => createAdmissionStore({ file, enrollmentFile: file, logger: quiet }),
      (error) => error.code === ADMISSION_PATH_CONFLICT,
      "an identical configured path must fail closed before anything is read or written",
    );
    // Lexical aliasing (`..`, `.`, trailing separator) is refused too.
    const aliased = path.join(base, "data", "sub", "..", "vault-admissions.json");
    assert.throws(
      () => createAdmissionStore({ file, enrollmentFile: `${aliased}${path.sep}`, logger: quiet }),
      (error) => error.code === ADMISSION_PATH_CONFLICT,
    );
    assert.equal(await fs.readdir(path.dirname(file)).then((entries) => entries.length), 0, "no file was created by the refused construction");
  });
});

test("ITEM 1: a real parent-directory alias for the two paths is refused before the first read/write", async (t) => {
  await withBase(async (base) => {
    const data = path.join(base, "data");
    await fs.mkdir(data, { recursive: true });
    const alias = path.join(base, "data-alias");
    if (!(await linkDirectory(data, alias))) {
      t.skip("this platform/user cannot create a directory alias");
      return;
    }
    const file = path.join(data, "vault-admissions.json");
    const enrollmentFile = path.join(alias, "vault-admissions.json");
    // The lexical check passes (different strings); the store is created, but the FIRST read/write
    // must prove they are the same actual target and fail closed without creating either file.
    const store = createAdmissionStore({ file, enrollmentFile, logger: quiet });
    await assert.rejects(store.load(), (error) => error.code === ADMISSION_PATH_CONFLICT);
    assert.equal(await fs.readdir(data).then((entries) => entries.length), 0, "neither file was created");
  });
});

test("ITEM 1: a corrupt/unreadable sentinel keeps refusing (never a legacy downgrade)", async () => {
  await withBase(async (base) => {
    const file = path.join(base, "data", "vault-admissions.json");
    const enrollmentFile = defaultEnrollmentFile(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(enrollmentFile, "{ not json", "utf8");
    const store = createAdmissionStore({ file, enrollmentFile, logger: quiet });
    await assert.rejects(store.load(), (error) => error.code === "VAULT_ADMISSIONS_CORRUPT");
    assert.equal(store.isManaged(), false, "a corrupt sentinel is never read as 'never managed'");
    assert.equal(await fs.readFile(enrollmentFile, "utf8"), "{ not json", "the corrupt bytes are left for an operator");
  });
});

test("ITEM 1: after a record loss the surviving sentinel still refuses a replaced ID", async () => {
  await withBase(async (base) => {
    const file = path.join(base, "data", "vault-admissions.json");
    const enrollmentFile = defaultEnrollmentFile(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const first = createAdmissionStore({ file, enrollmentFile, logger: quiet });
    await first.load();
    await first.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });
    await fs.rm(file, { force: true });

    const second = createAdmissionStore({ file, enrollmentFile, logger: quiet });
    const loaded = await second.load();
    assert.equal(loaded.managed, true, "the sentinel proves managed mode without the record");
    await assert.rejects(
      second.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 2)], actor: ACTOR }),
      (error) => error.code === ADMISSION_IDENTITY_CONFLICT,
    );
    await assert.rejects(fs.stat(file), "the refused replacement must not create a record");
  });
});

// ---------------------------------------------------------------------------
// item 2 — trusted read-back revision/generation
// ---------------------------------------------------------------------------

test("ITEM 2: a restored legal-but-older record is refused on reload (no revision/gen regression)", async () => {
  await withBase(async (base) => {
    const file = path.join(base, "data", "vault-admissions.json");
    const enrollmentFile = defaultEnrollmentFile(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const store = createAdmissionStore({ file, enrollmentFile, logger: quiet });
    await store.load();
    await store.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });
    const oldBytes = await fs.readFile(file, "utf8"); // revision 1 / approved / generation 1

    await store.revoke("alpha", { actor: ACTOR }); // revision 2 / pending / generation 2 (sentinel floored)
    assert.equal(store.revision(), 2);
    assert.equal(store.entryFor("alpha").generation, 2);

    // The seat's repro: restore the older legal record over the newer one, sentinel untouched.
    await fs.writeFile(file, oldBytes, "utf8");
    const reloaded = await store.reload();
    assert.equal(reloaded.refused, true, "the older record must be refused on read-back");
    assert.equal(reloaded.code, ADMISSIONS_RECOVERY_REQUIRED, "the durable sentinel floor (revision + generation) wins");
    // The trusted state, the refusal gate and the on-disk bytes are all preserved.
    assert.equal(store.revision(), 2, "the trusted revision did not move back");
    assert.equal(store.entryFor("alpha").admission, "pending", "the aged approval was not resurrected");
    assert.equal(store.entryFor("alpha").generation, 2);
    assert.equal(await fs.readFile(file, "utf8"), oldBytes, "the refused record was not overwritten");
    // A later explicit decision still works and raises the record back to the sentinel floor.
    await store.approve("alpha", { actor: ACTOR });
    assert.equal(store.entryFor("alpha").admission, "approved");
    assert.ok(store.entryFor("alpha").generation >= 3);
    assert.equal(store.revision(), 3);
  });
});

test("ITEM 2: a cross-restart record below the sentinel generation/revision floor is refused at load", async () => {
  await withBase(async (base) => {
    const file = path.join(base, "data", "vault-admissions.json");
    const enrollmentFile = defaultEnrollmentFile(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const first = createAdmissionStore({ file, enrollmentFile, logger: quiet });
    await first.load();
    await first.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });
    const oldBytes = await fs.readFile(file, "utf8");
    await first.revoke("alpha", { actor: ACTOR });
    await fs.writeFile(file, oldBytes, "utf8");

    // A fresh process (new store) must not accept the older record.
    const restarted = createAdmissionStore({ file, enrollmentFile, logger: quiet });
    await assert.rejects(restarted.load(), (error) => error.code === ADMISSIONS_RECOVERY_REQUIRED);
    assert.equal(restarted.isLoaded(), false, "a refused load leaves the store unloaded (fail closed)");
    assert.equal(await fs.readFile(file, "utf8"), oldBytes, "the file is left untouched");
  });
});

test("ITEM 2: a same-revision content divergence is refused and the trusted state survives", async () => {
  await withBase(async (base) => {
    const file = path.join(base, "data", "vault-admissions.json");
    const enrollmentFile = defaultEnrollmentFile(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const store = createAdmissionStore({ file, enrollmentFile, logger: quiet });
    await store.load();
    await store.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });

    const document = JSON.parse(await fs.readFile(file, "utf8"));
    document.entries.alpha.note = "foreign write at the same revision";
    await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");

    const reloaded = await store.reload();
    assert.equal(reloaded.refused, true);
    assert.equal(reloaded.code, ADMISSIONS_RELOAD_REFUSED);
    assert.equal(store.entryFor("alpha").note, null, "the trusted in-memory entry is unchanged");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).entries.alpha.note, "foreign write at the same revision", "the foreign bytes are left untouched");
  });
});

test("ITEM 2: a refreshed valid record at the SAME revision is accepted (no false positive)", async () => {
  await withBase(async (base) => {
    const file = path.join(base, "data", "vault-admissions.json");
    const enrollmentFile = defaultEnrollmentFile(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const store = createAdmissionStore({ file, enrollmentFile, logger: quiet });
    await store.load();
    await store.initialize({ source: "admin", configDigest: "cfg", approved: [approved("alpha", 1)], actor: ACTOR });
    const reloaded = await store.reload();
    assert.equal(reloaded.refused, undefined, "an identical read-back is trusted");
    assert.equal(store.revision(), 1);
    assert.equal(store.entryFor("alpha").admission, "approved");
  });
});
