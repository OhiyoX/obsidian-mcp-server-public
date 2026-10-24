import { initializeIncarnation } from "../src/vault-runtime/incarnation.js";
// W2 (#437) — Vault identity, contract §3 / §3.1.
//
// Acceptance evidence this file must produce (contract §3 "必须证明"):
//   ① restart stability: the same directory yields the same identity across a fresh process;
//   ② replacement discrimination: delete + recreate the same path ⇒ a different identity;
//   ③ Windows AND Linux: the same assertions run on both platforms (this machine: see the
//      `platform` diagnostic; the W2 handoff records the Windows and Linux (WSL) runs).
// Plus the fail-closed rule: an identity that cannot be confirmed stays unresolved — never a
// fallback to "the paths are equal".

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IDENTITY_INVALID,
  IDENTITY_UNRESOLVED,
  IDENTITY_VERSION,
  assertVaultIdentity,
  computeIdentityDigest,
  describeIdentity,
  encodeIdentityTuple,
  isVaultIdentity,
  normalizeCanonicalRoot,
  resolveVaultIdentity,
  sameVaultIdentity,
} from "../src/vault-runtime/identity.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_URL = new URL("../src/vault-runtime/identity.js", import.meta.url).href;

async function withTempDir(task) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w2-identity-"));
  try {
    return await task(base);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

const rejectsCode = (code) => (error) => error.code === code;

test(`platform: ${process.platform} (${process.arch}) — identity evidence is per-platform`, (t) => {
  t.diagnostic(`identity evidence on ${process.platform}/${process.arch}, node ${process.version}`);
  assert.ok(["win32", "linux", "darwin"].includes(process.platform));
});

test("① restart stability: a fresh resolve of the same directory yields the same identity", async () => {
  await withTempDir(async (base) => {
    const root = path.join(base, "vault");
    await fs.mkdir(root);
    await initializeIncarnation(root);
    const first = await resolveVaultIdentity({ root });
    const second = await resolveVaultIdentity({ root });
    assert.equal(first.identityVersion, IDENTITY_VERSION);
    assert.equal(first.digest, second.digest, "same directory ⇒ same identity (no lastSeenAt/generation influence)");
    assert.ok(sameVaultIdentity(first, second));
    assert.ok(isVaultIdentity(first));
    assert.equal(first.digest, computeIdentityDigest(first), "the digest must be recomputable from the stored tuple");
    assert.equal(first.canonicalRoot, normalizeCanonicalRoot(await fs.realpath(root), process.platform));
    assert.ok(/^(0|[1-9][0-9]*)$/.test(first.volumeId), "volume id is a decimal string (no JS precision loss)");
    assert.ok(/^(0|[1-9][0-9]*)$/.test(first.fileId));
    assert.ok(describeIdentity(first).startsWith(`v${IDENTITY_VERSION}:`));
  });
});

test("① cross-process (real restart): two separate node processes agree on the identity", async () => {
  await withTempDir(async (base) => {
    const root = path.join(base, "vault");
    await fs.mkdir(root);
    await initializeIncarnation(root);
    const code = `import(${JSON.stringify(MODULE_URL)}).then(async (m) => { console.log(JSON.stringify(await m.resolveVaultIdentity({ root: process.argv[1] }))); });`;
    const run = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code, root], { cwd: APP_ROOT, encoding: "utf8" }).trim().split("\n").pop());
    const first = run();
    const second = run();
    const inProcess = await resolveVaultIdentity({ root });
    assert.equal(first.digest, second.digest, "identity must be stable across process restarts");
    assert.equal(first.digest, inProcess.digest, "the in-process resolver agrees with the subprocess");
    assert.deepEqual(first, inProcess);
  });
});

test("② replacement discrimination: delete + recreate the same path ⇒ a different identity", async () => {
  // Controlled different-inode proof is retained alongside the real ext4 same-tuple negative control.
  await withTempDir(async (base) => {
    const root = path.join(base, "vault");
    await fs.mkdir(root);
    await initializeIncarnation(root);
    const real = await fs.realpath(root);
    const realStat = await fs.stat(root, { bigint: true });

    const fsApiBefore = { ...fs,
      realpath: async () => real,
      stat: async () => ({ dev: realStat.dev, ino: 100n, isDirectory: () => true }),
    };
    const fsApiAfter = { ...fs,
      realpath: async () => real,
      stat: async () => ({ dev: realStat.dev, ino: 200n, isDirectory: () => true }),
    };

    const before = await resolveVaultIdentity({ root, fsApi: fsApiBefore });
    const after = await resolveVaultIdentity({ root, fsApi: fsApiAfter });
    assert.equal(after.canonicalRoot, before.canonicalRoot, "the path is the same …");
    assert.notEqual(after.digest, before.digest, "… but a replaced directory must be discriminated by volume+file id");
    assert.equal(sameVaultIdentity(before, after), false);
  });
});

test("fail closed: an unconfirmable identity is UNRESOLVED, never 'the paths are equal'", async () => {
  await withTempDir(async (base) => {
    const missing = path.join(base, "does-not-exist");
    await assert.rejects(resolveVaultIdentity({ root: missing }), rejectsCode(IDENTITY_UNRESOLVED));

    const file = path.join(base, "a-file");
    await fs.writeFile(file, "not a directory\n");
    await assert.rejects(resolveVaultIdentity({ root: file }), rejectsCode(IDENTITY_UNRESOLVED));

    // A filesystem that reports 0 for the device/file id cannot confirm an identity (e.g. some
    // network mounts): the Vault must stay unavailable instead of being admitted by path equality.
    const zeroIds = {
      realpath: async (value) => value,
      stat: async () => ({ dev: 0n, ino: 0n, isDirectory: () => true }),
    };
    await assert.rejects(resolveVaultIdentity({ root: base, fsApi: zeroIds }), rejectsCode(IDENTITY_UNRESOLVED));
    const noIno = {
      realpath: async (value) => value,
      stat: async () => ({ dev: 7n, ino: 0n, isDirectory: () => true }),
    };
    await assert.rejects(resolveVaultIdentity({ root: base, fsApi: noIno }), rejectsCode(IDENTITY_UNRESOLVED));

    await assert.rejects(resolveVaultIdentity({ root: "" }), rejectsCode(IDENTITY_INVALID));
    await assert.rejects(resolveVaultIdentity({ root: base, fsApi: {} }), rejectsCode(IDENTITY_INVALID));
  });
});

test("encoding is a structured tuple: no delimiter collision, big integers are decimal strings", () => {
  const left = computeIdentityDigest({ canonicalRoot: "/a", volumeId: "12", fileId: "3" });
  const right = computeIdentityDigest({ canonicalRoot: "/a1", volumeId: "2", fileId: "3" });
  assert.notEqual(left, right, "a naive concatenation would collide here");

  const huge = (2n ** 63n + 7n).toString();
  const encoded = encodeIdentityTuple({ canonicalRoot: "/v", volumeId: huge, fileId: "0" });
  assert.ok(encoded.includes(`"${huge}"`), "64-bit ids survive as decimal strings");
  assert.equal(encodeIdentityTuple({ canonicalRoot: "/v", volumeId: huge, fileId: "0" }), encoded, "encoding is deterministic");
  assert.throws(() => encodeIdentityTuple({ canonicalRoot: "/v", volumeId: 12, fileId: "0" }), rejectsCode(IDENTITY_INVALID));
  assert.throws(() => encodeIdentityTuple({ canonicalRoot: "/v", volumeId: "012", fileId: "0" }), rejectsCode(IDENTITY_INVALID));
  assert.throws(() => computeIdentityDigest({ canonicalRoot: "", volumeId: "1", fileId: "1" }), rejectsCode(IDENTITY_INVALID));
});

test("normalizeCanonicalRoot folds separators and (win32 only) case", () => {
  assert.equal(normalizeCanonicalRoot("C:\\Vaults\\Alpha\\", "win32"), "c:/vaults/alpha");
  assert.equal(normalizeCanonicalRoot("C:\\Vaults\\Alpha\\", "linux"), "C:/Vaults/Alpha");
  assert.equal(normalizeCanonicalRoot("/srv/vault/", "linux"), "/srv/vault");
  assert.equal(normalizeCanonicalRoot("/", "linux"), "/");
  assert.throws(() => normalizeCanonicalRoot("", "linux"), rejectsCode(IDENTITY_INVALID));
});

test("a tampered or malformed persisted identity record is rejected (fail closed)", async () => {
  await withTempDir(async (base) => {
    const root = path.join(base, "vault");
    await fs.mkdir(root);
    await initializeIncarnation(root);
    const identity = await resolveVaultIdentity({ root });
    assert.ok(isVaultIdentity(identity));
    assert.equal(assertVaultIdentity(identity), identity);

    assert.equal(isVaultIdentity({ ...identity, digest: `sha256:${"0".repeat(64)}` }), false, "digest must match the tuple");
    assert.equal(isVaultIdentity({ ...identity, fileId: `${identity.fileId}0` }), false, "a mutated tuple must not validate");
    assert.equal(isVaultIdentity({ ...identity, identityVersion: IDENTITY_VERSION + 1 }), false);
    assert.equal(isVaultIdentity(null), false);
    assert.equal(isVaultIdentity("sha256:abc"), false);
    assert.throws(() => assertVaultIdentity({ ...identity, volumeId: "1e3" }), rejectsCode(IDENTITY_INVALID));
    assert.equal(sameVaultIdentity(identity, { ...identity, digest: `sha256:${"0".repeat(64)}` }), false);
  });
});
