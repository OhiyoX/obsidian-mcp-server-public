// Issue #470 Wave B — the resumable direct-upload writer (`PATCH /uploads/:id`) and THE single copy of
// the publish step that both direct writers use.
//
// Why this file exists: `vault-runtime/transfer-runtime.js` is held under a deliberate local line cap
// (500; see `test/transfer-runtime.test.js` and DEVELOPMENT_STANDARDS §7). Wave B adds a state machine
// of its own (offset continuity, idempotent retries, resumable `failed-retryable`, one shared publish),
// so it lives here instead of growing the runtime past that cap. The runtime injects its per-Vault
// handle helpers; this module reads no `process.env`, imports no config and keeps no module state.
//
// The publish block below was MOVED VERBATIM out of `receiveDirectUpload` (Wave A), and BOTH the
// whole-body PUT and the chunked PATCH call it. That is the point: the publish-time re-hash of the
// staged file (#688) exists exactly once, so it cannot be fixed in one writer and forgotten in the
// other. The order — destination guard → read `.part` → re-hash → `localFs.atomicWriteFile` → receipt
// → metadata → drop `.part` — is unchanged, and `receiveDirectUpload` now simply returns its result.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Build the Wave B writer for one Vault runtime.
 *
 * Every helper is injected by `transfer-runtime.js`, which owns the durable handle format, the Vault
 * binding, the writer lock and the injected tunables. Nothing here is ambient: the same factory could
 * be used by a second runtime without sharing state.
 *
 * @param {object} deps
 * @param {object|null} deps.writerLock `{ acquire(key) -> release|null }` (one writer per handle)
 * @param {(uploadId: string) => {metadata: string, part: string}} deps.uploadPaths
 * @param {(uploadId: string, declared: string|undefined) => Promise<{paths: object, metadata: object}>} deps.readDirectUpload
 * @param {(paths: object, metadata: object, reason: string, terminal?: boolean) => Promise<void>} deps.markFailed
 * @param {(target: string, value: object) => Promise<void>} deps.writeJsonAtomic
 * @param {(vaultPath: string) => string} deps.transferPath
 * @param {object} deps.localFs root-bound Vault fs service (`atomicWriteFile`)
 * @param {(resolved: string) => Promise<boolean>} deps.exists
 * @param {() => void} deps.assertWritable
 * @param {(value: unknown) => string|undefined} deps.declaredVaultOf
 * @param {(code: string, detail: string) => never} deps.fail
 * @param {(value: unknown) => string} deps.describe
 * @param {(buffer: Buffer) => string} deps.sha256
 * @param {number} deps.ttlMs
 * @param {string} deps.mode the single-PUT handle mode (`transfer-runtime.js` owns the value)
 * @param {Record<string, string>} deps.codes stable error codes owned by `transfer-runtime.js`
 */
export function createDirectUploadResumeWriter({
  writerLock = null,
  uploadPaths,
  readDirectUpload,
  markFailed,
  writeJsonAtomic,
  transferPath,
  localFs,
  exists,
  assertWritable,
  declaredVaultOf,
  fail,
  describe,
  sha256,
  ttlMs,
  mode,
  codes,
}) {
  const {
    UPLOAD_DESTINATION_EXISTS,
    UPLOAD_FAILED,
    UPLOAD_IN_PROGRESS,
    UPLOAD_INTEGRITY_MISMATCH,
    UPLOAD_MODE_CONFLICT,
    UPLOAD_OFFSET_CONFLICT,
    UPLOAD_RANGE_EXCEEDED,
  } = codes;

  // Shared publish step for BOTH direct writers (`PUT` in Wave A, `PATCH` in Wave B). Moved out of
  // `receiveDirectUpload` verbatim: destination guard → publish-time re-hash → atomic write → receipt
  // → metadata → drop `.part`. The re-hash is load-bearing (#688): the bytes that are published and
  // receipted are the ones READ BACK from `.part`, never a stream digest.
  async function publishDirectUpload(paths, metadata, uploadId) {
    const destination = transferPath(metadata.vaultPath);
    if ((await exists(destination)) && !metadata.overwrite) { await markFailed(paths, metadata, "destination-exists", true); fail(UPLOAD_DESTINATION_EXISTS, "Destination now exists. Start a new upload with overwrite=true to replace it."); }
    // One buffered read: the shared atomic publish primitive takes a buffer (ceiling = maxBytes).
    // Re-hash it: the published and receipted bytes are THIS buffer, never the stream's digest.
    const data = await fs.readFile(paths.part);
    const dataSha256 = sha256(data);
    if (data.length !== metadata.totalBytes || dataSha256 !== metadata.expectedSha256) {
      await markFailed(paths, metadata, "publish-digest-mismatch", true);
      fail(UPLOAD_INTEGRITY_MISMATCH, `staged bytes changed before publish (expected ${metadata.expectedSha256}, staged ${dataSha256}, ${data.length} of ${metadata.totalBytes} bytes); nothing was published`);
    }
    const written = await localFs.atomicWriteFile(destination, data);
    const receiptId = randomUUID();
    const result = { uploadId, path: metadata.vaultPath, complete: true, size: data.length, sha256: dataSha256, revision: written.revision };
    Object.assign(metadata, { status: "complete", completedAt: new Date().toISOString(), uploadedBytes: data.length, receiptId, result });
    delete metadata.writerToken;
    await writeJsonAtomic(paths.metadata, metadata);
    await fs.rm(paths.part, { force: true });
    return { duplicate: false, result, receiptId, status: "COMPLETE", uploadedBytes: data.length, totalBytes: metadata.totalBytes };
  }

  // Issue #470 Wave B — append ONE contiguous chunk to a single-PUT handle (`PATCH`), and publish when
  // the last byte arrives through the SAME `publishDirectUpload` the `PUT` path uses.
  //
  // Rules (interface frozen in the Wave B brief):
  //   * `offset` must equal the acknowledged `uploadedBytes`; only acknowledged bytes count. Bytes a
  //     dead writer left past that point are dropped before anything is appended, so a crash or a
  //     mid-chunk kill can never turn into unverified progress.
  //   * a retried chunk at an EARLIER offset is idempotent only when the staged range has the SAME
  //     bytes (compared by streaming SHA-256 on both sides); any gap or different body is a conflict.
  //   * single writer inside this process (`deps.writerLock`); a second concurrent chunk is refused
  //     with UPLOAD_IN_PROGRESS, exactly like the whole-body writer.
  //   * `failed-retryable` is a resumable state: the next chunk may continue from `uploadedBytes`.
  //     `failed-terminal` never is.
  async function appendDirectUpload({ uploadId, stream, contentLength, offset }, declaredVaultId) {
    const declared = declaredVaultOf(declaredVaultId);
    assertWritable();
    const paths = uploadPaths(uploadId); // validates the id; touches nothing on disk
    const release = writerLock ? writerLock.acquire(paths.metadata) : null;
    if (writerLock && !release) fail(UPLOAD_IN_PROGRESS, `upload ${uploadId} already has an active writer`);
    try {
      const { metadata } = await readDirectUpload(uploadId, declared);
      if (metadata.mode !== mode) fail(UPLOAD_MODE_CONFLICT, `upload ${uploadId} was created for base64 chunks; use upload_file_chunk`);
      if (metadata.status === "complete") {
        // The client may simply have lost the response of the chunk that completed the upload: the
        // same receipt is answered and nothing is rewritten (same rule as a repeated PUT).
        return { duplicate: true, result: metadata.result, receiptId: metadata.receiptId ?? null, uploadedBytes: metadata.uploadedBytes, totalBytes: metadata.totalBytes, status: "COMPLETE" };
      }
      if (metadata.status !== "uploading" && metadata.status !== "failed-retryable") fail(UPLOAD_FAILED, `upload ${uploadId} is ${metadata.status}; start a new direct upload`);
      if (!Number.isInteger(offset) || offset < 0) fail(UPLOAD_OFFSET_CONFLICT, `Upload-Offset must be a non-negative integer, received ${describe(offset)}`);
      if (!Number.isInteger(contentLength) || contentLength < 0) fail(UPLOAD_INTEGRITY_MISMATCH, `Content-Length must be a non-negative integer, received ${describe(contentLength)}`);
      const staged = await fs.stat(paths.part).then((value) => value.size, () => 0);
      const acknowledged = Number.isInteger(metadata.uploadedBytes) ? metadata.uploadedBytes : 0;
      // F5 (Wave B review §F5): every offset-bearing failure carries the authoritative offset THIS
      // writer read under the writer lock. The HTTP layer keeps its own copy read BEFORE the body was
      // streamed, so in the narrow "another writer advanced between the route's check and the lock"
      // interleave that copy is already stale; the route prefers this exact value over its pre-stream
      // one instead of answering 409/416 with an offset it can no longer stand behind.
      const failAtOffset = (code, detail) => {
        try {
          fail(code, detail);
        } catch (error) {
          if (error !== null && typeof error === "object" && error.authoritativeOffset === undefined) error.authoritativeOffset = acknowledged;
          throw error;
        }
      };
      if (staged !== acknowledged) {
        // The part cannot be SHORTER than the acknowledged length (every append is followed by its
        // metadata write): that state is not resumable evidence, it is damage.
        if (staged < acknowledged) {
          await markFailed(paths, metadata, "part-short", true);
          fail(UPLOAD_FAILED, `upload ${uploadId} lost staged bytes (${staged} of ${acknowledged}); start a new direct upload`);
        }
        // Only an acknowledged prefix is progress. Drop the tail a dead/aborted writer left behind and
        // keep the fact in the handle (the same honesty the PUT path applies to debris).
        metadata.discardedStagedBytes = (metadata.discardedStagedBytes || 0) + (staged - acknowledged);
        await fs.truncate(paths.part, acknowledged);
        await writeJsonAtomic(paths.metadata, metadata);
      }
      if (offset !== acknowledged) {
        if (offset < acknowledged && contentLength > 0 && offset + contentLength <= acknowledged) {
          if (await stagedRangeMatches(paths.part, offset, contentLength, stream)) {
            return { duplicate: true, idempotentReplay: true, uploadedBytes: acknowledged, totalBytes: metadata.totalBytes, status: "uploading" };
          }
        }
        failAtOffset(UPLOAD_OFFSET_CONFLICT, `Upload-Offset ${offset} does not match the authoritative ${acknowledged}`);
      }
      if (contentLength === 0) {
        // A zero-byte PATCH is only a finalize request. It publishes when every byte is acknowledged
        // (the crash window between the last metadata write and the publish), and is a no-op else.
        if (acknowledged === metadata.totalBytes) return await publishDirectUpload(paths, metadata, uploadId);
        return { duplicate: false, uploadedBytes: acknowledged, totalBytes: metadata.totalBytes, status: "uploading" };
      }
      if (acknowledged + contentLength > metadata.totalBytes) failAtOffset(UPLOAD_RANGE_EXCEEDED, `chunk of ${contentLength} bytes at offset ${acknowledged} would exceed the declared ${metadata.totalBytes} bytes`);
      // Claim the part before the first byte: the lock is the liveness proof, the token the trace of
      // a dead writer (identical to the whole-body writer).
      Object.assign(metadata, { writerToken: randomUUID(), writerStartedAt: new Date().toISOString() });
      await writeJsonAtomic(paths.metadata, metadata);
      let received = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > contentLength) { callback(fail(UPLOAD_RANGE_EXCEEDED, `chunk exceeds its Content-Length ${contentLength}`)); return; }
          callback(null, chunk);
        },
      });
      const sink = createWriteStream(paths.part, { flags: "a", mode: 0o600 });
      try { await pipeline(stream, counter, sink); }
      catch (error) {
        // Unacknowledged tail: drop it so `uploadedBytes` stays the single source of truth. The
        // handle stays resumable (`failed-retryable`) and the already-acknowledged bytes survive.
        await fs.truncate(paths.part, acknowledged).catch(() => {});
        delete metadata.writerToken;
        await markFailed(paths, metadata, "interrupted").catch(() => {});
        // F5: a failure in the middle of the body (e.g. the counter's own UPLOAD_RANGE_EXCEEDED) is
        // still answered with the offset this lock holder saw, never with the route's pre-stream copy.
        // `isExtensible` because this error comes from a stream, not from our own `fail()`: annotating a
        // frozen error must never replace the real failure with a TypeError.
        if (error !== null && typeof error === "object" && error.authoritativeOffset === undefined && Object.isExtensible(error)) error.authoritativeOffset = acknowledged;
        throw error;
      }
      if (received !== contentLength) {
        await fs.truncate(paths.part, acknowledged).catch(() => {});
        delete metadata.writerToken;
        await markFailed(paths, metadata, "size-mismatch").catch(() => {});
        fail(UPLOAD_INTEGRITY_MISMATCH, `received ${received} of ${contentLength} bytes`);
      }
      metadata.uploadedBytes = acknowledged + received;
      metadata.expiresAt = new Date(Date.now() + ttlMs).toISOString();
      metadata.status = "uploading";
      delete metadata.failedReason;
      delete metadata.writerToken;
      await writeJsonAtomic(paths.metadata, metadata);
      if (metadata.uploadedBytes < metadata.totalBytes) {
        return { duplicate: false, uploadedBytes: metadata.uploadedBytes, totalBytes: metadata.totalBytes, status: "uploading" };
      }
      return await publishDirectUpload(paths, metadata, uploadId);
    } finally {
      release?.();
    }
  }

  /**
   * `true` when the already-staged range `[offset, offset+length)` is byte-identical to the body.
   * Both sides are hashed as streams (no chunk is buffered), and the body is always fully drained so
   * the caller can answer 409 without leaving an unread request behind.
   */
  async function stagedRangeMatches(partPath, offset, length, stream) {
    const fileHash = createHash("sha256");
    const bodyHash = createHash("sha256");
    // A Writable sink (not a Transform): a Transform used as pipeline's last stage has nobody reading
    // its readable side, so a multi-MB body would stall on backpressure instead of being drained.
    const digestSink = (hash) => new Writable({ write(chunk, _encoding, callback) { hash.update(chunk); callback(); } });
    const bodyDigest = pipeline(stream, digestSink(bodyHash))
      .then(() => bodyHash.digest("hex"))
      .catch(() => null);
    try {
      await pipeline(
        createReadStream(partPath, { start: offset, end: offset + length - 1 }),
        digestSink(fileHash),
      );
    } catch {
      await bodyDigest;
      return false;
    }
    const stagedSha256 = fileHash.digest("hex");
    const bodySha256 = await bodyDigest;
    return bodySha256 !== null && bodySha256 === stagedSha256;
  }

  return Object.freeze({ appendDirectUpload, publishDirectUpload });
}
