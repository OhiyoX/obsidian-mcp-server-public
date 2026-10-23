// B5 — `src/file-transfer.js` compatibility facade: request-context Vault selection, primary parity
// and the §13.4 binding applied through the public (MCP handler) entry points.
//
// Contract: Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置
//   §6  request context (vaultId + vaultRuntime are injected by the registrar)
//   §13.4 upload sessions bound to a Vault, §22.4 legacy metadata is primary-only
//   §27 B5, §36.2 cross-call upload security, §43-5 facade allowlist, §43-8 upload state carries vaultId
//
// These tests drive the *exported* functions (what `tools/files.js` calls) with the environment a
// request has: a request context carrying `vaultId` and, once Wave C wires the registrar, the resolved
// `vaultRuntime`. The pre-B5 primary path (no Vault declared) must stay byte-for-byte behaviorally
// identical, which `test/file-transfer.test.js` and `test/multi-vault-handle-binding.test.js` cover.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mv-b5-transfer-facade-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.GIT_ENABLED = "false";

const transfer = await import("../src/file-transfer.js");
const { primaryRuntime } = await import("../src/vault.js");
const { withRequestContext } = await import("../src/request-context.js");
const { vaultDataKey } = await import("../src/vault-runtime/descriptor.js");
const { vaultDataPaths } = await import("../src/vault-runtime/paths.js");
const { createVaultRuntime } = await import("../src/vault-runtime/runtime.js");
const { UPLOAD_NOT_FOUND, VAULT_CONTEXT_MISMATCH } = await import("../src/vault-runtime/transfer-runtime.js");

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FACADE_SOURCE = new URL("../src/file-transfer.js", import.meta.url);
const AUTHOR = { agent: "mv-b5-facade", model: "test" };
const LEGACY_UPLOADS_ROOT = path.join(data, "transfers", "uploads");

after(() => fs.rm(root, { recursive: true, force: true }));

const scoped = (vaultId, callback, vaultRuntime) => withRequestContext({ author: AUTHOR, vaultId, vaultRuntime }, callback);
const unscoped = (callback) => withRequestContext({ author: AUTHOR }, callback);

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to reject");
}

async function secondaryVaultRuntime(id) {
  const vaultRoot = path.join(root, id, "vault");
  const dataRoot = path.join(root, id, "data");
  await fs.mkdir(vaultRoot, { recursive: true });
  return createVaultRuntime({
    descriptor: { id, name: id, root: vaultRoot, primary: false },
    paths: vaultDataPaths({ primary: false, dataRoot, dataKey: vaultDataKey(id) }),
    deps: { requireRequestAuthor: () => AUTHOR },
  });
}

/** Metadata staged the way the pre-B5 code wrote it: no `vaultId` at all (§22.4). */
async function stageLegacyHandle(uploadsRoot, bytes = Buffer.from("z")) {
  await fs.mkdir(uploadsRoot, { recursive: true });
  const uploadId = randomUUID();
  await fs.writeFile(path.join(uploadsRoot, `${uploadId}.json`), `${JSON.stringify({
    uploadId,
    vaultPath: "Notes/legacy.bin",
    totalBytes: bytes.length,
    uploadedBytes: 0,
    overwrite: false,
    acceptedOnly: false,
    status: "uploading",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, null, 2)}\n`, "utf8");
  const part = path.join(uploadsRoot, `${uploadId}.part`);
  await fs.writeFile(part, bytes);
  return { uploadId, part, bytes };
}

// ---------------------------------------------------------------------------
// Public surface + ownership (frozen snapshot)
// ---------------------------------------------------------------------------

test("the facade keeps every pre-B5 export with its exact name and arity", () => {
  const surface = {};
  for (const [name, value] of Object.entries(transfer).sort(([a], [b]) => a.localeCompare(b))) {
    assert.equal(typeof value, "function", `${name} must stay a function`);
    surface[name] = value.length;
  }
  assert.deepEqual(surface, {
    appendFileUpload: 1,
    cancelFileUpload: 1,
    createZipArchive: 1,
    extractZipArchive: 1,
    fileUploadStatus: 1,
    inspectZipBuffer: 1,
    inspectZipFile: 1,
    openVaultZipArchiveForRead: 1,
    pullFile: 1,
    startFileUpload: 1,
  });
});

test("the facade keeps the legacy literal as a primary parity ratchet and no longer owns the state machine", async () => {
  const source = await fs.readFile(FACADE_SOURCE, "utf8");
  assert.ok(source.includes('path.join(DATA_PATH, "transfers", "uploads")'),
    "the legacy primary uploads literal must stay (vault-runtime-paths.test.js §8 and the §5.1/§5.2 seam)");
  assert.ok(source.includes("TRANSFER_PRIMARY_PATH_DRIFT"), "the primary parity guard must stay in place");
  assert.equal(source.includes("const UPLOADS_PATH"), false, "the global uploads root constant moved to the runtime module");
  assert.equal(source.includes("fs.appendFile("), false, "the upload session writer lives in vault-runtime/transfer-runtime.js");
  assert.equal(source.includes("uploadPaths("), false, "the uploadId → file mapping lives in vault-runtime/transfer-runtime.js");
  assert.ok(source.includes("vault-runtime/transfer-runtime.js"), "the facade must delegate to the per-Vault runtime");
});

// ---------------------------------------------------------------------------
// §6 — the request context selects the runtime
// ---------------------------------------------------------------------------

test("the legacy primary root is used when the request declares no Vault (pre-B5 behavior)", async () => {
  assert.equal(primaryRuntime.paths.transfersUploads, LEGACY_UPLOADS_ROOT);
  const started = await unscoped(() => transfer.startFileUpload({ vaultPath: "Notes/primary.bin", totalBytes: 4 }));
  assert.equal(started.vaultId, primaryRuntime.id, "an unscoped call binds to the runtime it writes through");
  assert.deepEqual(await fs.readdir(LEGACY_UPLOADS_ROOT), [`${started.uploadId}.json`, `${started.uploadId}.part`].sort());
  const status = await unscoped(() => transfer.fileUploadStatus(started.uploadId));
  assert.equal(status.vaultId, primaryRuntime.id);
  assert.equal(status.status, "uploading");
  assert.deepEqual(await unscoped(() => transfer.cancelFileUpload(started.uploadId)), { uploadId: started.uploadId, cancelled: true });
});

test("a requested Vault runtime routes the whole upload session into that Vault (§6, §37)", async () => {
  const vaultA = await secondaryVaultRuntime("vault-a");
  const vaultB = await secondaryVaultRuntime("vault-b");
  const payload = Buffer.from("facade routed");

  const started = await scoped("vault-a", () => transfer.startFileUpload({ vaultPath: "Notes/routed.bin", totalBytes: payload.length }), vaultA);
  assert.equal(started.vaultId, "vault-a");
  assert.deepEqual(await fs.readdir(vaultA.paths.transfersUploads), [`${started.uploadId}.json`, `${started.uploadId}.part`].sort());
  assert.equal(await fs.stat(path.join(vaultB.paths.transfersUploads, `${started.uploadId}.json`)).then(() => true, () => false), false);

  // Vault B cannot see (or reach) Vault A's handle, even with its own runtime injected.
  const foreign = await rejection(scoped("vault-b", () => transfer.fileUploadStatus(started.uploadId), vaultB));
  assert.equal(foreign.code, UPLOAD_NOT_FOUND);
  const foreignChunk = await rejection(scoped("vault-b", () => transfer.appendFileUpload({ uploadId: started.uploadId, offset: 0, base64: payload.toString("base64"), finalize: true }), vaultB));
  assert.equal(foreignChunk.code, UPLOAD_NOT_FOUND);

  // …while Vault A completes the very same handle into its own Vault root.
  const completed = await scoped("vault-a", () => transfer.appendFileUpload({ uploadId: started.uploadId, offset: 0, base64: payload.toString("base64"), finalize: true }), vaultA);
  assert.equal(completed.complete, true);
  assert.deepEqual(await fs.readFile(path.join(vaultA.root, "Notes", "routed.bin")), payload);
  assert.equal(await fs.stat(path.join(vaultB.root, "Notes", "routed.bin")).then(() => true, () => false), false);
});

test("a declared Vault that differs from the handle's binding is rejected before any part write (§13.4, §36.2)", async () => {
  // No injected runtime => the transitional single-storage phase: both claims resolve to the primary
  // runtime, which is exactly the legacy shared-root case §13.4 protects against.
  const started = await scoped("vault-a", () => transfer.startFileUpload({ vaultPath: "Notes/binding.bin", totalBytes: 4 }));
  const part = path.join(LEGACY_UPLOADS_ROOT, `${started.uploadId}.part`);
  const before = await fs.readFile(part);

  for (const call of [
    () => transfer.fileUploadStatus(started.uploadId),
    () => transfer.appendFileUpload({ uploadId: started.uploadId, offset: 0, base64: "YWJjZA==" }),
    () => transfer.cancelFileUpload(started.uploadId),
  ]) {
    const error = await rejection(scoped("vault-b", call));
    assert.equal(error.code, VAULT_CONTEXT_MISMATCH, "the selected Vault must match the handle's vaultId");
  }
  assert.deepEqual(await fs.readFile(part), before, "a mismatched call must not touch the staged bytes");
  assert.equal((await fs.readdir(LEGACY_UPLOADS_ROOT)).includes(`${started.uploadId}.json`), true, "a mismatched cancel must not delete the handle");

  // The same handle is served to the Vault it is bound to, and to an unscoped legacy call.
  const bound = await scoped("vault-a", () => transfer.fileUploadStatus(started.uploadId));
  assert.equal(bound.vaultId, "vault-a");
  assert.equal((await unscoped(() => transfer.fileUploadStatus(started.uploadId))).status, "uploading");
  await scoped("vault-a", () => transfer.cancelFileUpload(started.uploadId));
});

test("legacy metadata without vaultId stays consumable by the primary root (§22.4)", async () => {
  const legacy = await stageLegacyHandle(LEGACY_UPLOADS_ROOT, Buffer.from("legacy"));
  const status = await unscoped(() => transfer.fileUploadStatus(legacy.uploadId));
  assert.equal(status.status, "uploading");
  assert.equal(status.vaultId, null, "a legacy handle honestly reports no vaultId");
  assert.equal(status.path, "Notes/legacy.bin");
  const declared = await scoped("vault-unknown", () => transfer.fileUploadStatus(legacy.uploadId));
  assert.equal(declared.status, "uploading", "the primary Vault consumes its own legacy handles; Wave C's gate rejects unknown Vaults before I/O");
  assert.deepEqual(await unscoped(() => transfer.cancelFileUpload(legacy.uploadId)), { uploadId: legacy.uploadId, cancelled: true });
});

test("the primary-bound archive and inline helpers still resolve inside the primary Vault", async () => {
  await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
  await fs.writeFile(path.join(vault, "Notes", "inline.bin"), "inline payload");
  const pulled = await transfer.pullFile("Notes/inline.bin");
  assert.equal(Buffer.from(pulled.transfer.content, "base64").toString("utf8"), "inline payload");
  const traversal = await rejection(transfer.pullFile("../outside.bin"));
  assert.match(traversal.message, /Path traversal denied/);
  const attempt = await rejection(unscoped(() => transfer.startFileUpload({ vaultPath: ".git/config", totalBytes: 1 })));
  assert.equal(attempt.message, "File transfer cannot access protected Vault internals");
});
