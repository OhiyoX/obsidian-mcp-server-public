// Issue #470 Wave B review §F5 — a 409/416 answer must carry the offset that is authoritative AT THE
// MOMENT of the refusal, not the copy the route read before the body was streamed.
//
// The recorded defect: the route reads `metadata.uploadedBytes` (→ 0), then a different writer commits
// a chunk, then the runtime takes the writer lock, re-reads the handle (→ one chunk) and refuses the
// caller's `Upload-Offset: 0` with `409 UPLOAD_OFFSET_CONFLICT`. The runtime knew the fresh value; the
// old `catch` threw it away and answered with its pre-stream copy, so a client that retried at the
// advertised offset would hit the same conflict again.
//
// A socket race cannot be forced reliably, so the interleave is constructed with the seams the router
// already exposes for tests (`resolveRuntime`, `statfs`) and everything above the express handler —
// router, real `createTransferRuntime`, real handle/metadata files — is the production code path. The
// second test pins the other half: the writer itself has to disclose the value it read under the lock.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const CHUNK = 256 * 1024;
const PAYLOAD = Buffer.alloc(2 * CHUNK);
for (let index = 0; index < PAYLOAD.length; index += 1) PAYLOAD[index] = (index * 29 + 13) % 256;
const CHUNKS = [0, 1].map((index) => PAYLOAD.subarray(index * CHUNK, (index + 1) * CHUNK));

/** Raw client so the response HEADER can be asserted, not just the JSON body. */
function collect(req) {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error("the PATCH never answered within 20 s")), 20_000);
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        clearTimeout(guard);
        let body = null;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, body });
      });
    });
    req.on("error", (error) => { clearTimeout(guard); reject(error); });
  });
}

/** The minimal per-Vault runtime the transfer layer needs; publishes are out of scope here. */
function fakeVaultRuntime(localRoot, uploads) {
  return {
    id: "default",
    primary: true,
    paths: { transfersUploads: uploads },
    localFs: {
      resolveVaultPath: (value) => path.join(localRoot, "vault", value),
      toVaultPath: (value) => value,
      atomicWriteFile: async () => { throw new Error("this test never publishes"); },
      assertCanonicalInsideVault: async () => {},
    },
  };
}

function handleFor(uploadId, uploadedBytes) {
  return {
    uploadId,
    vaultId: "default",
    vaultPath: `attachments/${uploadId}.bin`,
    totalBytes: 2 * CHUNK,
    uploadedBytes,
    expectedSha256: sha256(PAYLOAD),
    overwrite: false,
    mode: "single-put",
    status: "uploading",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}

test("offset: a 409 answers the offset the writer saw UNDER THE LOCK, not the stale pre-stream copy", async () => {
  const { default: express } = await import("express");
  const { createDirectUploadRouter, DIRECT_UPLOAD_SCOPES } = await import("../src/direct-upload.js");

  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-f5-"));
  const uploads = path.join(localRoot, "uploads");
  await fs.mkdir(uploads, { recursive: true });
  const uploadId = randomUUID();
  const staged = CHUNKS[0]; // what the "other writer" commits
  const offered = Buffer.alloc(CHUNK, 0x41); // a DIFFERENT body, so the overlap is no idempotent retry
  const metadataPath = path.join(uploads, `${uploadId}.json`);
  const partPath = path.join(uploads, `${uploadId}.part`);
  const handle = handleFor(uploadId, 0);
  await fs.writeFile(partPath, Buffer.alloc(0));
  await fs.writeFile(metadataPath, `${JSON.stringify(handle, null, 2)}\n`);

  const vaultRuntime = fakeVaultRuntime(localRoot, uploads);
  let advanced = false;
  const statfs = async () => {
    // The concurrent writer's committed append, landing between the route's check and the runtime's
    // re-read under the writer lock.
    if (!advanced) {
      advanced = true;
      await fs.writeFile(partPath, staged);
      await fs.writeFile(metadataPath, `${JSON.stringify({ ...handle, uploadedBytes: staged.length }, null, 2)}\n`);
    }
    return { bavail: 10_000, bsize: 4096 };
  };

  const app = express();
  app.use(createDirectUploadRouter({
    auth: (req, _res, next) => {
      req.auth = { type: "test", keyId: "f5", scopes: [...DIRECT_UPLOAD_SCOPES], allowedVaults: ["default"] };
      next();
    },
    resolveRuntime: (vaultId) => (vaultId === "default" ? vaultRuntime : null),
    statfs,
    minFreeBytes: 1, // > 0, otherwise the disk probe (and therefore the interleave) is skipped
  }));
  const listener = await new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const req = http.request({
      hostname: "127.0.0.1",
      port: listener.address().port,
      path: `/uploads/${uploadId}`,
      method: "PATCH",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(offered.length),
        "Upload-Offset": "0", // the claim the route accepted moments before the other writer moved
      },
    });
    const settled = collect(req);
    req.end(offered);
    const response = await settled;

    assert.equal(response.status, 409, response.text);
    assert.equal(response.body.code, "UPLOAD_OFFSET_CONFLICT");
    assert.equal(response.headers["upload-offset"], String(staged.length), "the header must answer the offset the writer saw under the lock, never the pre-stream 0");
    assert.equal(response.body.uploadedBytes, staged.length);
    assert.equal(response.body.nextOffset, staged.length);
    assert.equal(response.body.offsetMayBeStale, undefined, "an exact under-lock value needs no staleness marker");
    assert.match(response.body.message, new RegExp(`authoritative ${staged.length}`));
    // Proof the pre-stream copy really was the stale one: the route saw 0, the handle is one chunk on.
    assert.equal(JSON.parse(await fs.readFile(metadataPath, "utf8")).uploadedBytes, staged.length);
    assert.equal((await fs.stat(partPath)).size, staged.length);
    const event = lines
      .filter((line) => line.startsWith("[direct-upload] "))
      .map((line) => JSON.parse(line.slice("[direct-upload] ".length)))
      .find((item) => item.operation === "patch" && item.decision === "deny");
    assert.equal(event?.code, "UPLOAD_OFFSET_CONFLICT");
    assert.equal(event?.status, 409);
    console.log(`DIRECT_UPLOAD_F5_PRE_STREAM_OFFSET=0 UNDER_LOCK_OFFSET=${response.headers["upload-offset"]}`);
  } finally {
    console.log = originalLog;
    listener.closeAllConnections?.();
    await new Promise((resolve) => listener.close(resolve));
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});

test("offset: every offset-bearing writer failure carries the authoritative offset it read under the lock", async () => {
  const { Readable } = await import("node:stream");
  const { createTransferRuntime } = await import("../src/vault-runtime/transfer-runtime.js");

  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-f5-runtime-"));
  const uploads = path.join(localRoot, "uploads");
  await fs.mkdir(uploads, { recursive: true });
  const runtime = createTransferRuntime({
    vaultRuntime: fakeVaultRuntime(localRoot, uploads),
    deps: { limits: { maxTransferBytes: 8 * 1024 * 1024, chunkBytes: CHUNK, ttlMs: 600_000 }, protectedRoots: new Set(), directUploadMaxBytes: 8 * 1024 * 1024 },
  });

  const uploadId = randomUUID();
  const write = async (uploadedBytes, part) => {
    await fs.writeFile(path.join(uploads, `${uploadId}.part`), part);
    await fs.writeFile(path.join(uploads, `${uploadId}.json`), `${JSON.stringify(handleFor(uploadId, uploadedBytes), null, 2)}\n`);
  };

  try {
    // (a) another writer already committed one chunk; this writer's claim is behind it.
    await write(CHUNK, CHUNKS[0]);
    const conflict = await runtime.appendDirectUpload({
      uploadId,
      stream: Readable.from([Buffer.alloc(CHUNK, 0x41)]),
      contentLength: CHUNK,
      offset: 0,
    }, undefined).then(() => null, (error) => error);
    assert.equal(conflict?.code, "UPLOAD_OFFSET_CONFLICT");
    assert.equal(conflict.authoritativeOffset, CHUNK, "the writer must disclose the offset it read under the lock");

    // (b) a body that overruns its own Content-Length is answered with the same exact offset.
    await write(0, Buffer.alloc(0));
    const overrun = await runtime.appendDirectUpload({
      uploadId,
      stream: Readable.from([Buffer.alloc(2 * CHUNK, 0x42)]),
      contentLength: CHUNK, // lies: twice that arrives
      offset: 0,
    }, undefined).then(() => null, (error) => error);
    assert.equal(overrun?.code, "UPLOAD_RANGE_EXCEEDED");
    assert.equal(overrun.authoritativeOffset, 0, "a mid-body overrun discloses the acknowledged prefix, not the route's copy");
    assert.equal((await fs.stat(path.join(uploads, `${uploadId}.part`))).size, 0, "the overrun tail was truncated as before");
    console.log(`DIRECT_UPLOAD_F5_WRITER_OFFSETS=${conflict.authoritativeOffset},${overrun.authoritativeOffset}`);
  } finally {
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});
