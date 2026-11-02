// Issue #470 Wave A — single-PUT handle mode on the per-Vault transfer runtime.
//
// Contract: `DEVELOPMENT - Issue 470 大文件 HTTP 直传与可恢复上传` §2.2 (data plane), §2.3 (auth
// order), §3 (errors/recovery), §5 (mandatory matrix) + A0 decisions D4/D5/D6.
//
// These are runtime-level assertions on observable effects (files in the Vault, staged `.part`,
// durable metadata status, stable error codes). No resume is claimed, so every failure is asserted to
// leave the Vault untouched instead of "resumable".

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";

import { vaultDataKey } from "../src/vault-runtime/descriptor.js";
import { vaultDataPaths } from "../src/vault-runtime/paths.js";
import { createVaultRuntime } from "../src/vault-runtime/runtime.js";
import {
  DIRECT_UPLOAD_MODE,
  UPLOAD_DESTINATION_EXISTS,
  UPLOAD_EXPIRED,
  UPLOAD_FAILED,
  UPLOAD_IN_PROGRESS,
  UPLOAD_INTEGRITY_MISMATCH,
  UPLOAD_MODE_CONFLICT,
  UPLOAD_TOO_LARGE,
  VAULT_CONTEXT_MISMATCH,
  createTransferRuntime,
} from "../src/vault-runtime/transfer-runtime.js";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-runtime-"));
const DEPS = Object.freeze({ requireRequestAuthor: () => ({ agent: "direct-upload-test", model: "test" }) });
const LIMITS = Object.freeze({ maxTransferBytes: 4 * 1024 * 1024, chunkBytes: 1024, ttlMs: 60_000 });
const PROTECTED_ROOTS = new Set([".git", ".obsidian"]);

after(() => fs.rm(scratch, { recursive: true, force: true }));

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function vaultRuntime(id, { primary = false } = {}) {
  const name = id.replace(/[^a-z0-9-]/gi, "_");
  const root = path.join(scratch, name, "vault");
  const dataRoot = path.join(scratch, name, "data");
  await fs.mkdir(root, { recursive: true });
  const paths = primary
    ? vaultDataPaths({
      primary: true,
      history: path.join(dataRoot, "history"),
      trash: path.join(dataRoot, "trash"),
      retrievalIndex: path.join(dataRoot, "index", "retrieval-index.json"),
      transfersUploads: path.join(dataRoot, "transfers", "uploads"),
      mutationJournal: path.join(dataRoot, "mutation-journal"),
      mutationIdempotency: path.join(dataRoot, "mutation-idempotency"),
    })
    : vaultDataPaths({ primary: false, dataRoot, dataKey: vaultDataKey(id) });
  return createVaultRuntime({ descriptor: { id, name: id, root, primary }, paths, deps: DEPS });
}

function locks() {
  const held = new Set();
  return {
    acquire(key) {
      if (held.has(key)) return null;
      held.add(key);
      return () => held.delete(key);
    },
  };
}

function runtimeFor(vault, overrides = {}) {
  return createTransferRuntime({
    vaultRuntime: vault,
    deps: { limits: LIMITS, protectedRoots: PROTECTED_ROOTS, directUploadMaxBytes: 2 * 1024 * 1024, ...overrides },
  });
}

async function readStaged(uploadId, vault) {
  const root = vault.paths.transfersUploads;
  const metadata = JSON.parse(await fs.readFile(path.join(root, `${uploadId}.json`), "utf8"));
  return { metadata, root };
}

function body(buffer, { chunk = 8192 } = {}) {
  const pieces = [];
  for (let offset = 0; offset < buffer.length; offset += chunk) pieces.push(buffer.subarray(offset, offset + chunk));
  return Readable.from(pieces.length ? pieces : [Buffer.alloc(0)]);
}

async function started(vault, { path: target = "attachments/upload.bin", payload, overwrite = false } = {}) {
  const runtime = runtimeFor(vault);
  const handle = await runtime.startDirectUpload({ vaultPath: target, totalBytes: payload.length, expectedSha256: sha256(payload), overwrite }, vault.id);
  return { runtime, handle };
}

async function waitFor(predicate, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the staged part to receive bytes");
}

test("a single PUT publishes 123 KB byte-identically and leaves a completion receipt", async () => {
  const vault = await vaultRuntime("vault-a", { primary: true });
  const payload = Buffer.alloc(123_154);
  for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + 7) % 256;
  const { runtime, handle } = await started(vault, { payload });

  assert.equal(handle.mode, DIRECT_UPLOAD_MODE);
  assert.equal(handle.uploadedBytes, 0, "a fresh handle is empty");
  assert.equal(handle.maxBytes, 2 * 1024 * 1024);

  const startedAt = Date.now();
  const outcome = await runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id);
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome.duplicate, false);
  assert.equal(outcome.status, "COMPLETE");
  assert.match(outcome.receiptId, /^[0-9a-f-]{36}$/);
  assert.equal(outcome.result.size, payload.length);
  assert.equal(outcome.result.sha256, sha256(payload));
  const published = await fs.readFile(path.join(vault.root, "attachments", "upload.bin"));
  assert.ok(published.equals(payload), "Vault bytes must be identical to the uploaded bytes");
  const { metadata, root } = await readStaged(handle.uploadId, vault);
  assert.equal(metadata.status, "complete");
  assert.equal(metadata.receiptId, outcome.receiptId);
  assert.equal(metadata.mode, DIRECT_UPLOAD_MODE);
  await assert.rejects(fs.stat(path.join(root, `${handle.uploadId}.part`)), /ENOENT/, "the staged part is removed after publish");
  assert.ok(elapsed < 5000, `123 KB must publish in well under 5 s, took ${elapsed} ms`);
});

test("0 B and 1 B uploads work (empty-file SHA-256 included)", async () => {
  const vault = await vaultRuntime("vault-zero");
  for (const payload of [Buffer.alloc(0), Buffer.from([0x41])]) {
    const { runtime, handle } = await started(vault, { path: `attachments/${payload.length}.bin`, payload });
    const outcome = await runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id);
    assert.equal(outcome.result.size, payload.length);
    assert.equal(outcome.result.sha256, sha256(payload));
    assert.ok((await fs.readFile(path.join(vault.root, "attachments", `${payload.length}.bin`))).equals(payload));
  }
});

test("a SHA-256 mismatch publishes nothing and is marked failed-terminal", async () => {
  const vault = await vaultRuntime("vault-sha");
  const payload = Buffer.from("the bytes that actually arrive");
  const runtime = runtimeFor(vault);
  const handle = await runtime.startDirectUpload({ vaultPath: "attachments/sha.bin", totalBytes: payload.length, expectedSha256: "0".repeat(64) }, vault.id);
  await assert.rejects(
    runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id),
    (error) => error.code === UPLOAD_INTEGRITY_MISMATCH,
  );
  await assert.rejects(fs.stat(path.join(vault.root, "attachments", "sha.bin")), /ENOENT/, "no file may be published");
  const { metadata } = await readStaged(handle.uploadId, vault);
  assert.equal(metadata.status, "failed-terminal");
  assert.equal(metadata.failedReason, "sha256-mismatch");
});

test("Content-Length must equal the declared totalBytes", async () => {
  const vault = await vaultRuntime("vault-length");
  const payload = Buffer.alloc(64, 7);
  const { runtime, handle } = await started(vault, { payload });
  await assert.rejects(
    runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length - 1 }, vault.id),
    (error) => error.code === UPLOAD_INTEGRITY_MISMATCH,
  );
  await assert.rejects(fs.stat(path.join(vault.root, "attachments", "upload.bin")), /ENOENT/);
});

test("a repeated PUT of a complete handle answers with the same receipt and never rewrites the file", async () => {
  const vault = await vaultRuntime("vault-dup");
  const payload = Buffer.from("idempotent completion");
  const { runtime, handle } = await started(vault, { payload });
  const first = await runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id);
  const target = path.join(vault.root, "attachments", "upload.bin");
  const before = await fs.stat(target);
  const second = await runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id);
  const afterStat = await fs.stat(target);
  assert.equal(second.duplicate, true);
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(afterStat.mtimeMs, before.mtimeMs, "the Vault file must not be rewritten");
  assert.ok((await fs.readFile(target)).equals(payload));
});

test("the chunk writer refuses a single-PUT handle and the HTTP writer refuses a chunk handle (D6)", async () => {
  const vault = await vaultRuntime("vault-mode");
  const payload = Buffer.from("mode isolation");
  const { runtime, handle } = await started(vault, { payload });
  await assert.rejects(
    runtime.appendFileUpload({ uploadId: handle.uploadId, offset: 0, base64: payload.toString("base64"), finalize: true }, vault.id),
    (error) => error.code === UPLOAD_MODE_CONFLICT && /direct HTTP upload/.test(error.message),
  );

  const legacy = await runtime.startFileUpload({ vaultPath: "attachments/legacy.bin", totalBytes: payload.length, expectedSha256: sha256(payload) }, vault.id);
  assert.equal(legacy.mode, undefined, "the legacy start must not gain a mode field");
  await assert.rejects(
    runtime.receiveDirectUpload({ uploadId: legacy.uploadId, stream: body(payload), contentLength: payload.length }, vault.id),
    (error) => error.code === UPLOAD_MODE_CONFLICT,
  );
});

test("an interrupted body publishes nothing, keeps the part, and the handle cannot be revived", async () => {
  const vault = await vaultRuntime("vault-abort");
  const payload = Buffer.alloc(50_000, 3);
  const { runtime, handle } = await started(vault, { payload });
  const interrupted = new Readable({
    read() {
      this.push(payload.subarray(0, 1024));
      this.destroy(Object.assign(new Error("client went away"), { code: "ECONNRESET" }));
    },
  });
  await assert.rejects(runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: interrupted, contentLength: payload.length }, vault.id));
  await assert.rejects(fs.stat(path.join(vault.root, "attachments", "upload.bin")), /ENOENT/, "an interrupted body never publishes");
  const { metadata } = await readStaged(handle.uploadId, vault);
  assert.equal(metadata.status, "failed-retryable");
  assert.equal(metadata.failedReason, "interrupted");
  // No resume in Wave A: the same handle is not silently reusable, and a new start is the answer.
  await assert.rejects(
    runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id),
    (error) => error.code === UPLOAD_FAILED,
  );
});

test("metadata/part inconsistency after a crash is detected instead of trusted", async () => {
  const vault = await vaultRuntime("vault-crash");
  const payload = Buffer.alloc(4096, 9);
  const { runtime, handle } = await started(vault, { payload });
  // Simulate a crash: bytes reached the part, metadata still says zero.
  await fs.appendFile(path.join(vault.paths.transfersUploads, `${handle.uploadId}.part`), payload.subarray(0, 100));
  await assert.rejects(
    runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id),
    (error) => error.code === UPLOAD_FAILED && /inconsistent staged bytes/.test(error.message),
  );
  await assert.rejects(fs.stat(path.join(vault.root, "attachments", "upload.bin")), /ENOENT/);
  const { metadata } = await readStaged(handle.uploadId, vault);
  assert.equal(metadata.failedReason, "inconsistent-part");
});

test("an expired handle is refused with UPLOAD_EXPIRED", async () => {
  const vault = await vaultRuntime("vault-expired");
  const payload = Buffer.from("too late");
  const runtime = createTransferRuntime({
    vaultRuntime: vault,
    deps: { limits: Object.freeze({ ...LIMITS, ttlMs: 60_000 }), protectedRoots: PROTECTED_ROOTS, directUploadMaxBytes: 1024 * 1024 },
  });
  const handle = await runtime.startDirectUpload({ vaultPath: "attachments/late.bin", totalBytes: payload.length, expectedSha256: sha256(payload) }, vault.id);
  const metadataPath = path.join(vault.paths.transfersUploads, `${handle.uploadId}.json`);
  const stale = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  stale.expiresAt = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(metadataPath, `${JSON.stringify(stale)}\n`, "utf8");
  await assert.rejects(
    runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id),
    (error) => error.code === UPLOAD_EXPIRED,
  );
  await assert.rejects(fs.stat(path.join(vault.root, "attachments", "late.bin")), /ENOENT/);
});

test("a handle is only writable through its own Vault runtime", async () => {
  const vaultA = await vaultRuntime("vault-a2");
  const vaultB = await vaultRuntime("vault-b2");
  const payload = Buffer.from("cross vault");
  const { handle } = await started(vaultA, { payload });
  const other = runtimeFor(vaultB);
  await assert.rejects(
    other.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vaultB.id),
    (error) => error.code === "UPLOAD_NOT_FOUND" || error.code === VAULT_CONTEXT_MISMATCH,
  );
  await assert.rejects(
    other.peekDirectUpload(handle.uploadId),
    (error) => error.code === "UPLOAD_NOT_FOUND",
    "the other Vault's uploads root cannot even see the handle",
  );
});

test("a destination that appears after the handle was created is not overwritten", async () => {
  const vault = await vaultRuntime("vault-overwrite");
  const original = Buffer.from("original content");
  const payload = Buffer.from("replacement content");
  const { runtime, handle } = await started(vault, { payload });
  // The destination is created between start and PUT (the TOCTOU window contract §2.3.4 names).
  await fs.mkdir(path.join(vault.root, "attachments"), { recursive: true });
  await fs.writeFile(path.join(vault.root, "attachments", "upload.bin"), original);
  await assert.rejects(
    runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id),
    (error) => error.code === UPLOAD_DESTINATION_EXISTS,
  );
  assert.ok((await fs.readFile(path.join(vault.root, "attachments", "upload.bin"))).equals(original));
});

test("the direct ceiling and the destination guard are enforced before any I/O", async () => {
  const vault = await vaultRuntime("vault-limits");
  const runtime = runtimeFor(vault);
  await assert.rejects(
    runtime.startDirectUpload({ vaultPath: "attachments/big.bin", totalBytes: 3 * 1024 * 1024, expectedSha256: "a".repeat(64) }, vault.id),
    (error) => error.code === UPLOAD_TOO_LARGE,
  );
  await assert.rejects(
    runtime.startDirectUpload({ vaultPath: "attachments/nosha.bin", totalBytes: 4, expectedSha256: "not-a-digest" }, vault.id),
    /expectedSha256 must be the 64-character hexadecimal/,
  );
  await fs.mkdir(path.join(vault.root, "attachments"), { recursive: true });
  await fs.writeFile(path.join(vault.root, "attachments", "there.bin"), "x");
  await assert.rejects(
    runtime.startDirectUpload({ vaultPath: "attachments/there.bin", totalBytes: 1, expectedSha256: sha256(Buffer.from("y")) }, vault.id),
    /Destination exists/,
  );
});

test("a second concurrent writer is refused by the injected writer lock before it stages anything (D6)", async () => {
  const vault = await vaultRuntime("vault-lock");
  const payload = Buffer.alloc(20_000, 5);
  const runtime = runtimeFor(vault, { writerLock: locks() });
  const handle = await runtime.startDirectUpload({ vaultPath: "attachments/locked.bin", totalBytes: payload.length, expectedSha256: sha256(payload) }, vault.id);
  let releaseRead;
  const firstRead = new Promise((resolve) => { releaseRead = resolve; });
  let pulled = false;
  const slow = new Readable({
    read() {
      if (pulled) return; // the pipeline now waits for the rest of the body
      pulled = true;
      releaseRead();
    },
  });
  const first = runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: slow, contentLength: payload.length }, vault.id);
  await firstRead; // the first writer holds the lock because it is already streaming
  await assert.rejects(
    runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id),
    (error) => error.code === UPLOAD_IN_PROGRESS,
  );
  slow.push(payload);
  slow.push(null);
  const outcome = await first;
  assert.equal(outcome.status, "COMPLETE");
});

test("a second writer arriving after the part already has bytes is refused and cannot truncate it", async () => {
  // Reviewer probe §D: the old lock order only covered the "part is still 0 bytes" instant. A real
  // client (curl/browser) is ~300 KB into the body when the second PUT lands.
  const vault = await vaultRuntime("vault-inflight", { primary: true });
  const payload = Buffer.alloc(1_048_576);
  for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 17 + 3) % 256;
  const runtime = runtimeFor(vault, { writerLock: locks() });
  const handle = await runtime.startDirectUpload({ vaultPath: "attachments/inflight.bin", totalBytes: payload.length, expectedSha256: sha256(payload) }, vault.id);
  const partPath = path.join(vault.paths.transfersUploads, `${handle.uploadId}.part`);
  const metadataPath = path.join(vault.paths.transfersUploads, `${handle.uploadId}.json`);
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const firstChunk = 64 * 1024;
  const slow = Readable.from((async function* () {
    yield payload.subarray(0, firstChunk);
    await gate; // hold the first writer mid-flight while the second one arrives
    yield payload.subarray(firstChunk);
  })());
  const first = runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: slow, contentLength: payload.length }, vault.id);
  await waitFor(async () => (await fs.stat(partPath)).size >= firstChunk);
  const stagedBefore = (await fs.stat(partPath)).size;

  const refused = await runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id).then(() => null, (error) => error);
  assert.equal(refused?.code, UPLOAD_IN_PROGRESS, "the in-flight handle must answer UPLOAD_IN_PROGRESS, not UPLOAD_FAILED after eating the staged bytes");
  assert.doesNotMatch(String(refused?.message), /inconsistent staged bytes/, "a live writer's part must never be classified as debris");
  assert.equal((await fs.stat(partPath)).size, stagedBefore, "the refused writer must not truncate the in-flight part");
  const whileInFlight = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  assert.equal(whileInFlight.status, "uploading", "the refused writer must not mark the first writer's handle failed");

  releaseGate();
  const outcome = await first;
  assert.equal(outcome.status, "COMPLETE");
  const published = await fs.readFile(path.join(vault.root, "attachments", "inflight.bin"));
  assert.ok(published.equals(payload), "the winning writer publishes exactly the source bytes");
  assert.equal(sha256(published), sha256(payload));
  assert.equal(outcome.result.sha256, sha256(published), "the response digest is the digest of the published bytes");
  assert.equal(outcome.result.revision, `sha256:${sha256(published)}`);
});

test("staged bytes with no active writer are debris: dropped, with the dead writer's token recorded", async () => {
  const vault = await vaultRuntime("vault-debris", { primary: true });
  const payload = Buffer.alloc(4096, 0x19);
  const runtime = runtimeFor(vault, { writerLock: locks() });
  const handle = await runtime.startDirectUpload({ vaultPath: "attachments/debris.bin", totalBytes: payload.length, expectedSha256: sha256(payload) }, vault.id);
  const partPath = path.join(vault.paths.transfersUploads, `${handle.uploadId}.part`);
  const metadataPath = path.join(vault.paths.transfersUploads, `${handle.uploadId}.json`);
  await fs.appendFile(partPath, payload.subarray(0, 100));
  // A writer that died mid-flight leaves its claim behind; no writer is active (the lock is free).
  const stale = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  stale.writerToken = "dead-writer-token";
  stale.writerStartedAt = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(metadataPath, `${JSON.stringify(stale)}\n`, "utf8");

  await assert.rejects(
    runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id),
    (error) => error.code === UPLOAD_FAILED && /inconsistent staged bytes/.test(error.message),
  );
  await assert.rejects(fs.stat(path.join(vault.root, "attachments", "debris.bin")), /ENOENT/, "debris is never published");
  const { metadata } = await readStaged(handle.uploadId, vault);
  assert.equal(metadata.status, "failed-retryable");
  assert.equal(metadata.failedReason, "inconsistent-part");
  assert.equal(metadata.discardedStagedBytes, 100, "the dropped byte count is recorded");
  assert.equal(metadata.discardedWriterToken, "dead-writer-token", "the dead writer's token is the proof this was debris, not a live writer");
  assert.equal(metadata.writerToken, undefined);
  assert.equal((await fs.stat(partPath)).size, 0, "the debris part is dropped, never trusted");
});

test("bytes tampered between the stream digest and the publish read are refused (B2 negative control)", async () => {
  const vault = await vaultRuntime("vault-tamper", { primary: true });
  const payload = Buffer.alloc(64 * 1024, 0x2a);
  const metadataPath = (uploadId) => path.join(vault.paths.transfersUploads, `${uploadId}.json`);
  const partPath = (uploadId) => path.join(vault.paths.transfersUploads, `${uploadId}.part`);
  let armed = false;
  let uploadId = null;
  // Test-local hook: the runtime asks the Vault's localFs to resolve the destination exactly between
  // the stream digest and the publish read, which is the TOCTOU window contract §2.3.4 names.
  const localFs = Object.freeze({
    ...vault.localFs,
    resolveVaultPath(vaultPath) {
      const resolved = vault.localFs.resolveVaultPath(vaultPath);
      if (armed && uploadId) {
        armed = false;
        writeFileSync(partPath(uploadId), Buffer.alloc(payload.length, 0x2b)); // same length, other bytes
      }
      return resolved;
    },
  });
  const runtime = createTransferRuntime({
    vaultRuntime: { ...vault, localFs },
    deps: { limits: LIMITS, protectedRoots: PROTECTED_ROOTS, directUploadMaxBytes: 2 * 1024 * 1024, writerLock: locks() },
  });
  const handle = await runtime.startDirectUpload({ vaultPath: "attachments/tamper.bin", totalBytes: payload.length, expectedSha256: sha256(payload) }, vault.id);
  uploadId = handle.uploadId;
  armed = true;

  await assert.rejects(
    runtime.receiveDirectUpload({ uploadId: handle.uploadId, stream: body(payload), contentLength: payload.length }, vault.id),
    (error) => error.code === UPLOAD_INTEGRITY_MISMATCH && /changed before publish/.test(error.message),
  );
  await assert.rejects(fs.stat(path.join(vault.root, "attachments", "tamper.bin")), /ENOENT/, "the tampered bytes must not be published");
  const metadata = JSON.parse(await fs.readFile(metadataPath(handle.uploadId), "utf8"));
  assert.equal(metadata.status, "failed-terminal");
  assert.equal(metadata.failedReason, "publish-digest-mismatch");
  assert.equal(metadata.result, undefined, "no result/receipt may be recorded for bytes that were never published");
});
