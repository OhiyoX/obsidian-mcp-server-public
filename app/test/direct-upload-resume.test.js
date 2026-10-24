// Issue #470 Wave B — resumable direct upload: `PATCH /uploads/:uploadId` + `Upload-Offset`.
//
// Contract: `DEVELOPMENT - Issue 470 大文件 HTTP 直传与可恢复上传` §2.2 (option A) / §3 / §5 and the
// Wave B brief. The protocol is the one frozen there:
//   * the client sends one contiguous chunk per PATCH and claims `Upload-Offset`;
//   * the server's `uploadedBytes` is the only authority; a mismatch answers 409 (or 416 for an
//     overrun) with the authoritative offset in BOTH the `Upload-Offset` header and the body;
//   * the chunk that reaches `totalBytes` publishes through the same publish step as the whole-body
//     PUT, INCLUDING the publish-time re-hash of the staged file (#688);
//   * success answers 200 + the new `Upload-Offset` (204 is deliberately not used).
//
// Everything here runs against the real `server.js` on an ephemeral port with an isolated DATA_PATH /
// VAULT_PATH, so the auth middleware, the shared admission gates and the on-disk handle are the
// production ones. Only the two gate-specific tests spawn their own child with short limits.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  API_KEY,
  callTool,
  freePort,
  initialize,
  serverEnv,
  seedVault,
  startServer,
  stopChild,
} from "./helpers/server-spawn-fixtures.js";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const CHUNK = 256 * 1024;
const PAYLOAD = Buffer.alloc(1024 * 1024);
for (let index = 0; index < PAYLOAD.length; index += 1) PAYLOAD[index] = (index * 29 + 13) % 256;
const CHUNKS = [0, 1, 2, 3].map((index) => PAYLOAD.subarray(index * CHUNK, (index + 1) * CHUNK));

const children = [];
let root;
let main;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot({ root: bootRoot, extra = {} } = {}) {
  const port = await freePort();
  const server = await startServer(serverEnv({
    port,
    root: bootRoot,
    extra: {
      WEB_CATALOG_DIR: path.join(bootRoot, "web-catalog"),
      DIRECT_UPLOAD_RATE_PER_MINUTE: "600",
      DIRECT_UPLOAD_MIN_FREE_BYTES: "0",
      ...extra,
    },
  }));
  children.push(server.child);
  const init = await initialize(server.base, { key: API_KEY });
  assert.equal(init.status, 200);
  return { server, base: server.base, session: init.session, root: bootRoot };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-resume-"));
  await seedVault(root);
  main = await boot({ root });
});

after(async () => {
  await Promise.all(children.map((child) => stopChild(child)));
  await fs.rm(root, { recursive: true, force: true });
});

async function startUpload(ctx, { target = `attachments/${randomUUID()}.bin`, payload = PAYLOAD } = {}) {
  const response = await callTool(ctx.base, { key: API_KEY }, ctx.session, "start_direct_upload", {
    path: target, totalBytes: payload.length, sha256: sha256(payload), overwrite: false,
  });
  const structured = response.payload?.result?.structuredContent ?? {};
  assert.ok(structured.uploadId, `the control plane failed: ${JSON.stringify(response.payload)}`);
  return { structured, target };
}

function patchRequest({ base, relativePath, offset, contentLength, key = API_KEY }) {
  const url = new URL(`${base}${relativePath}`);
  return http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "PATCH",
    headers: {
      "X-API-Key": key,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(contentLength),
      "Upload-Offset": String(offset),
    },
  });
}

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

/** One chunk through the raw client: fetch would not let us assert on the response headers as simply. */
async function patchChunk(ctx, relativePath, offset, body) {
  const req = patchRequest({ base: ctx.base, relativePath, offset, contentLength: body.length });
  const settled = collect(req);
  req.end(body);
  return settled;
}

async function apiKeyStatus(ctx, uploadId) {
  const response = await callTool(ctx.base, { key: API_KEY }, ctx.session, "file_upload_status", { uploadId });
  return response.payload?.result?.structuredContent ?? {};
}

function transferPaths(ctx, uploadId) {
  const uploads = path.join(ctx.root, "data", "transfers", "uploads");
  return { metadata: path.join(uploads, `${uploadId}.json`), part: path.join(uploads, `${uploadId}.part`) };
}

async function readMetadata(ctx, uploadId) {
  return JSON.parse(await fs.readFile(transferPaths(ctx, uploadId).metadata, "utf8"));
}

async function partSize(ctx, uploadId) {
  return fs.stat(transferPaths(ctx, uploadId).part).then((stat) => stat.size, () => null);
}

async function waitForMetadata(ctx, uploadId, predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let metadata = null;
  while (Date.now() < deadline) {
    metadata = await readMetadata(ctx, uploadId).catch(() => null);
    if (metadata && predicate(metadata)) return metadata;
    await sleep(50);
  }
  throw new Error(`timed out waiting for handle state; last=${JSON.stringify(metadata)}`);
}

async function vaultFile(target) {
  return fs.readFile(path.join(root, "vault", ...target.split("/"))).catch(() => null);
}

// ---------------------------------------------------------------------------------------------
// 1. Basic resume: 1 MiB in four contiguous 256 KiB PATCHes.
// ---------------------------------------------------------------------------------------------
test("resume: four contiguous PATCHes reach 200/COMPLETE, the offsets advance and the bytes match", async () => {
  const { structured, target } = await startUpload(main);

  for (let index = 0; index < CHUNKS.length; index += 1) {
    const offset = index * CHUNK;
    const response = await patchChunk(main, structured.relativePath, offset, CHUNKS[index]);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers["upload-offset"], String(offset + CHUNK), "the server answers the authoritative offset");
    assert.equal(response.body.uploadId, structured.uploadId);
    assert.equal(response.body.uploadedBytes, offset + CHUNK);
    assert.equal(response.body.nextOffset, offset + CHUNK);
    assert.equal(response.body.totalBytes, PAYLOAD.length);
    if (index < CHUNKS.length - 1) {
      assert.equal(response.body.complete, false);
      assert.equal(response.body.status, "uploading");
      const status = await apiKeyStatus(main, structured.uploadId);
      assert.equal(status.uploadedBytes, offset + CHUNK, "file_upload_status exposes the resumable offset");
      assert.equal(status.nextOffset, offset + CHUNK);
    } else {
      assert.equal(response.body.complete, true);
      assert.equal(response.body.status, "COMPLETE");
      assert.equal(response.body.size, PAYLOAD.length);
      assert.equal(response.body.sha256, sha256(PAYLOAD));
      assert.match(response.body.receiptId, /^[0-9a-f-]{36}$/);
      assert.equal(response.body.path, target);
    }
  }

  const published = await vaultFile(target);
  assert.ok(published && published.equals(PAYLOAD), "the published file must be byte-identical to the source");
  console.log(`DIRECT_UPLOAD_RESUME_CHUNKS=${CHUNKS.length} SIZE=${PAYLOAD.length} SHA=${sha256(PAYLOAD)}`);
});

// ---------------------------------------------------------------------------------------------
// 2. Offset conflicts: a gap is 409 with the authoritative offset, a retry at that offset works.
// ---------------------------------------------------------------------------------------------
test("offset: a gap answers 409 with the authoritative Upload-Offset, and the retry at it completes", async () => {
  const { structured, target } = await startUpload(main);

  const first = await patchChunk(main, structured.relativePath, 0, CHUNKS[0]);
  assert.equal(first.status, 200);

  const skipped = await patchChunk(main, structured.relativePath, 2 * CHUNK, CHUNKS[2]);
  assert.equal(skipped.status, 409, skipped.text);
  assert.equal(skipped.body.code, "UPLOAD_OFFSET_CONFLICT");
  assert.equal(skipped.headers["upload-offset"], String(CHUNK), "the response header carries the AUTHORITATIVE offset");
  assert.equal(skipped.body.uploadedBytes, CHUNK);
  assert.equal(skipped.body.nextOffset, CHUNK);

  const retried = await patchChunk(main, structured.relativePath, CHUNK, CHUNKS[1]);
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.body.uploadedBytes, 2 * CHUNK);

  const third = await patchChunk(main, structured.relativePath, 2 * CHUNK, CHUNKS[2]);
  assert.equal(third.status, 200);

  // An overrun is its own answer (416) and still carries the authoritative offset.
  const overrun = await patchChunk(main, structured.relativePath, 3 * CHUNK, Buffer.alloc(CHUNK + 16, 0x5a));
  assert.equal(overrun.status, 416, overrun.text);
  assert.equal(overrun.body.code, "UPLOAD_RANGE_EXCEEDED");
  assert.equal(overrun.headers["upload-offset"], String(3 * CHUNK));
  assert.equal(overrun.body.uploadedBytes, 3 * CHUNK);

  const last = await patchChunk(main, structured.relativePath, 3 * CHUNK, CHUNKS[3]);
  assert.equal(last.status, 200, last.text);
  assert.equal(last.body.status, "COMPLETE");
  assert.ok((await vaultFile(target)).equals(PAYLOAD));
});

test("offset: a missing or invalid Upload-Offset is 400 and never touches the handle", async () => {
  const { structured } = await startUpload(main);
  const url = new URL(`${main.base}${structured.relativePath}`);
  for (const headers of [
    { "Content-Length": String(CHUNK) },
    { "Content-Length": String(CHUNK), "Upload-Offset": "abc" },
    { "Content-Length": String(CHUNK), "Upload-Offset": "-1" },
  ]) {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/octet-stream", ...headers },
      body: CHUNKS[0],
    });
    assert.equal(response.status, 400, JSON.stringify(headers));
    assert.equal((await response.json()).code, "offset_required");
  }
  assert.equal(await partSize(main, structured.uploadId), 0, "a refused offset never stages a byte");
  assert.equal((await readMetadata(main, structured.uploadId)).status, "uploading");
});

// ---------------------------------------------------------------------------------------------
// 3. Interruption: kill the client mid-chunk, then resume from the acknowledged offset.
// ---------------------------------------------------------------------------------------------
test("interruption: a killed client leaves a resumable handle, and the upload finishes from uploadedBytes", async () => {
  const { structured, target } = await startUpload(main);

  const first = await patchChunk(main, structured.relativePath, 0, CHUNKS[0]);
  assert.equal(first.status, 200);

  // Send part of chunk #1 and destroy the socket, exactly like a Ctrl-C'd curl.
  const req = patchRequest({ base: main.base, relativePath: structured.relativePath, offset: CHUNK, contentLength: CHUNK });
  req.on("error", () => {});
  req.write(CHUNKS[1].subarray(0, 64 * 1024));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await partSize(main, structured.uploadId)) > CHUNK) break;
    await sleep(10);
  }
  req.destroy();

  const failed = await waitForMetadata(main, structured.uploadId, (metadata) => metadata.status === "failed-retryable");
  assert.equal(failed.uploadedBytes, CHUNK, "only the acknowledged prefix counts as progress");

  // The public status tool is what a client uses to find the resume point.
  const status = await apiKeyStatus(main, structured.uploadId);
  assert.equal(status.status, "failed-retryable");
  assert.equal(status.uploadedBytes, CHUNK);
  assert.equal(status.nextOffset, CHUNK);
  assert.ok((await partSize(main, structured.uploadId)) >= CHUNK, "the acknowledged prefix is kept on disk");

  // Resume at the authoritative offset: the same chunk, then the rest.
  const resumed = await patchChunk(main, structured.relativePath, CHUNK, CHUNKS[1]);
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.body.uploadedBytes, 2 * CHUNK);
  for (const index of [2, 3]) {
    const response = await patchChunk(main, structured.relativePath, index * CHUNK, CHUNKS[index]);
    assert.equal(response.status, 200, response.text);
  }

  assert.ok((await vaultFile(target)).equals(PAYLOAD), "the resumed upload publishes the original bytes");
  console.log(`DIRECT_UPLOAD_RESUME_AFTER_KILL_OFFSET=${CHUNK}`);
});

test("recovery: a dead writer's unacknowledged tail is dropped, never counted as progress", async () => {
  const { structured, target } = await startUpload(main);
  const first = await patchChunk(main, structured.relativePath, 0, CHUNKS[0]);
  assert.equal(first.status, 200);

  // Simulate a SIGKILL between `append` and the metadata write: the part grew, the handle did not.
  await fs.appendFile(transferPaths(main, structured.uploadId).part, Buffer.alloc(4096, 0x7f));
  assert.equal((await readMetadata(main, structured.uploadId)).uploadedBytes, CHUNK);

  for (const index of [1, 2, 3]) {
    const response = await patchChunk(main, structured.relativePath, index * CHUNK, CHUNKS[index]);
    assert.equal(response.status, 200, response.text);
  }
  const metadata = await readMetadata(main, structured.uploadId);
  assert.equal(metadata.status, "complete");
  assert.equal(metadata.discardedStagedBytes, 4096, "the dropped tail is recorded, not silently trusted");
  assert.ok((await vaultFile(target)).equals(PAYLOAD), "the leftover tail never reaches the Vault");
});

// ---------------------------------------------------------------------------------------------
// 4. Idempotent retries: the same chunk twice is accepted, a different body at the same offset is not.
// ---------------------------------------------------------------------------------------------
test("idempotency: a byte-identical retry is a no-op, a diverging retry is 409, a retry after COMPLETE re-answers the receipt", async () => {
  const { structured, target } = await startUpload(main);
  for (const index of [0, 1]) {
    const response = await patchChunk(main, structured.relativePath, index * CHUNK, CHUNKS[index]);
    assert.equal(response.status, 200, response.text);
  }
  const staged = await partSize(main, structured.uploadId);

  // A lost response: the client repeats chunk #0 at offset 0 with the same bytes.
  const duplicate = await patchChunk(main, structured.relativePath, 0, CHUNKS[0]);
  assert.equal(duplicate.status, 200, duplicate.text);
  assert.equal(duplicate.body.idempotentReplay, true);
  assert.equal(duplicate.body.uploadedBytes, 2 * CHUNK, "the offset does not move and nothing is appended");
  assert.equal(await partSize(main, structured.uploadId), staged, "the part file is byte-for-byte unchanged");

  // A different body at an already-staged offset is a conflict, not an overwrite.
  const diverging = await patchChunk(main, structured.relativePath, 0, Buffer.alloc(CHUNK, 0x11));
  assert.equal(diverging.status, 409, diverging.text);
  assert.equal(diverging.body.code, "UPLOAD_OFFSET_CONFLICT");
  assert.equal(diverging.headers["upload-offset"], String(2 * CHUNK));

  for (const index of [2, 3]) {
    const response = await patchChunk(main, structured.relativePath, index * CHUNK, CHUNKS[index]);
    assert.equal(response.status, 200, response.text);
  }
  const published = await vaultFile(target);
  assert.ok(published.equals(PAYLOAD));

  // The response of the completing chunk was lost: the same chunk again answers the same receipt.
  const before = await fs.stat(path.join(root, "vault", ...target.split("/")));
  const complete = await patchChunk(main, structured.relativePath, 3 * CHUNK, CHUNKS[3]);
  assert.equal(complete.status, 200, complete.text);
  assert.equal(complete.body.status, "COMPLETE");
  assert.equal(complete.body.idempotentReplay, true);
  assert.equal(complete.body.receiptId, (await readMetadata(main, structured.uploadId)).receiptId);
  const afterStat = await fs.stat(path.join(root, "vault", ...target.split("/")));
  assert.equal(afterStat.mtimeMs, before.mtimeMs, "a repeated final chunk never rewrites the Vault file");
});

// ---------------------------------------------------------------------------------------------
// 5. Integrity: bytes tampered in `.part` before the last chunk are refused by the publish re-hash.
// ---------------------------------------------------------------------------------------------
test("integrity: a tampered .part is refused at publish time and the Vault file is not created", async () => {
  const { structured, target } = await startUpload(main);
  for (const index of [0, 1, 2]) {
    const response = await patchChunk(main, structured.relativePath, index * CHUNK, CHUNKS[index]);
    assert.equal(response.status, 200, response.text);
  }
  // Same length, different bytes: only the publish-time re-hash can catch this.
  const partPath = transferPaths(main, structured.uploadId).part;
  const staged = await fs.readFile(partPath);
  const tampered = Buffer.from(staged);
  for (let index = 0; index < 16; index += 1) tampered[index] ^= 0xff;
  await fs.writeFile(partPath, tampered);

  const last = await patchChunk(main, structured.relativePath, 3 * CHUNK, CHUNKS[3]);
  assert.equal(last.status, 400, last.text);
  assert.equal(last.body.code, "UPLOAD_INTEGRITY_MISMATCH");
  assert.equal(await vaultFile(target), null, "tampered bytes never reach the Vault");
  const metadata = await readMetadata(main, structured.uploadId);
  assert.equal(metadata.status, "failed-terminal");
  assert.equal(metadata.failedReason, "publish-digest-mismatch");
  assert.equal(metadata.result, undefined, "no receipt may exist for bytes that were never published");
});

// ---------------------------------------------------------------------------------------------
// 6. Chunk size, Content-Range and the shared admission gates.
// ---------------------------------------------------------------------------------------------
test("chunk size: a PATCH above DIRECT_UPLOAD_PATCH_MAX_BYTES answers 413 and is never appended", async () => {
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-chunk-limit-"));
  await seedVault(localRoot);
  const ctx = await boot({ root: localRoot, extra: { DIRECT_UPLOAD_PATCH_MAX_BYTES: "1024" } });
  try {
    const { structured } = await startUpload(ctx, { payload: Buffer.alloc(4096, 0x21) });
    const response = await patchChunk(ctx, structured.relativePath, 0, Buffer.alloc(2048, 0x21));
    assert.equal(response.status, 413, response.text);
    assert.equal(response.body.code, "chunk_too_large");
    assert.equal(await fs.stat(path.join(localRoot, "data", "transfers", "uploads", `${structured.uploadId}.part`)).then((stat) => stat.size), 0);
  } finally {
    await stopChild(ctx.server.child);
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});

test("protocol: Content-Range is refused instead of being half-supported", async () => {
  const { structured } = await startUpload(main);
  const response = await fetch(`${main.base}${structured.relativePath}`, {
    method: "PATCH",
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/octet-stream",
      "Upload-Offset": "0",
      "Content-Range": "bytes 0-255/1024",
    },
    body: CHUNKS[0].subarray(0, 256),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "content_range_not_supported");
});

test("timeout: a stalled PATCH answers 408, keeps the acknowledged prefix and stays resumable", async () => {
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-patch-idle-"));
  await seedVault(localRoot);
  const ctx = await boot({
    root: localRoot,
    extra: { DIRECT_UPLOAD_IDLE_TIMEOUT_MS: "300", DIRECT_UPLOAD_MAX_DURATION_MS: "30000" },
  });
  try {
    const { structured, target } = await startUpload(ctx);
    const first = await patchChunk(ctx, structured.relativePath, 0, CHUNKS[0]);
    assert.equal(first.status, 200);

    const req = patchRequest({ base: ctx.base, relativePath: structured.relativePath, offset: CHUNK, contentLength: CHUNK });
    const settled = collect(req);
    req.write(CHUNKS[1].subarray(0, 1024)); // never send more: the idle bound must fire
    const stalled = await settled;
    req.destroy();
    assert.equal(stalled.status, 408, stalled.text);
    assert.equal(stalled.body.code, "upload_idle_timeout");

    const failed = await waitForMetadata(ctx, structured.uploadId, (metadata) => metadata.status === "failed-retryable");
    assert.equal(failed.uploadedBytes, CHUNK, "a timeout never counts the unacknowledged tail");

    // The same credential may resume immediately; the ticketed handle is not burned.
    for (const index of [1, 2, 3]) {
      const response = await patchChunk(ctx, structured.relativePath, index * CHUNK, CHUNKS[index]);
      assert.equal(response.status, 200, response.text);
    }
    assert.ok((await fs.readFile(path.join(localRoot, "vault", ...target.split("/")))).equals(PAYLOAD));
  } finally {
    await stopChild(ctx.server.child);
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});

test("duration: a PATCH that keeps trickling but outstays the total budget answers 408 upload_max_duration", async () => {
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-patch-duration-"));
  await seedVault(localRoot);
  const ctx = await boot({
    root: localRoot,
    extra: { DIRECT_UPLOAD_IDLE_TIMEOUT_MS: "30000", DIRECT_UPLOAD_MAX_DURATION_MS: "500" },
  });
  try {
    const { structured } = await startUpload(ctx);
    const req = patchRequest({ base: ctx.base, relativePath: structured.relativePath, offset: 0, contentLength: CHUNK });
    const settled = collect(req);
    let sent = 0;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped || sent >= CHUNK || req.destroyed) return;
      const piece = Math.min(1024, CHUNK - sent);
      sent += piece;
      req.write(CHUNKS[0].subarray(sent - piece, sent));
    }, 50);
    // Stop writing the moment the server answers: the 408 closes the socket, and a write that lands
    // after that is an EPIPE the test would misread as a product failure.
    settled.finally(() => { stopped = true; clearInterval(timer); }).catch(() => {});
    try {
      const result = await settled;
      assert.equal(result.status, 408, result.text);
      assert.equal(result.body.code, "upload_max_duration");
    } finally {
      stopped = true;
      clearInterval(timer);
      req.destroy();
    }
    const metadata = await waitForMetadata(ctx, structured.uploadId, (value) => value.status === "failed-retryable");
    assert.equal(metadata.uploadedBytes, 0, "a duration timeout never acknowledges a partial chunk");
  } finally {
    await stopChild(ctx.server.child);
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});

test("single writer: two simultaneous PATCHes of the same chunk can never append it twice", async () => {
  const { structured, target } = await startUpload(main);
  const [a, b] = await Promise.all([
    patchChunk(main, structured.relativePath, 0, CHUNKS[0]),
    patchChunk(main, structured.relativePath, 0, CHUNKS[0]),
  ]);
  for (const response of [a, b]) {
    assert.ok([200, 409].includes(response.status), response.text);
    if (response.status === 409) assert.equal(response.body.code, "UPLOAD_IN_PROGRESS");
  }
  assert.equal(await partSize(main, structured.uploadId), CHUNK, "the chunk is staged exactly once");
  assert.equal((await readMetadata(main, structured.uploadId)).uploadedBytes, CHUNK);
  for (const index of [1, 2, 3]) {
    const response = await patchChunk(main, structured.relativePath, index * CHUNK, CHUNKS[index]);
    assert.equal(response.status, 200, response.text);
  }
  assert.ok((await vaultFile(target)).equals(PAYLOAD));
});

test("admission: PATCH and PUT share one rate bucket, but a continuation of the same handle is not charged again (#698)", async () => {
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-patch-rate-"));
  await seedVault(localRoot);
  const ctx = await boot({ root: localRoot, extra: { DIRECT_UPLOAD_RATE_PER_MINUTE: "2" } });
  try {
    const second = await startUpload(ctx);

    const wholeBody = Buffer.from("whole-body");
    const firstWhole = await startUpload(ctx, { payload: wholeBody });
    const put = await fetch(`${ctx.base}${firstWhole.structured.relativePath}`, {
      method: "PUT",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/octet-stream" },
      body: wholeBody,
    });
    assert.equal(put.status, 201, "the first upload consumes a token from the shared bucket");

    const patched = await patchChunk(ctx, second.structured.relativePath, 0, CHUNKS[0]);
    assert.equal(patched.status, 200, "the second UPLOAD consumes the second token (PATCH and PUT share the bucket)");

    // #698: the next chunk of THAT SAME handle continues the same admission, so it is not charged
    // again — otherwise a compliant multi-chunk upload would be refused for being compliant.
    const continued = await patchChunk(ctx, second.structured.relativePath, CHUNK, CHUNKS[1]);
    assert.equal(continued.status, 200, continued.text);
    assert.equal((await readMetadata(ctx, second.structured.uploadId)).uploadedBytes, 2 * CHUNK, "the continuation appended");

    // A THIRD upload is a new admission and must still spend from the same exhausted bucket.
    const third = await startUpload(ctx);
    const limited = await patchChunk(ctx, third.structured.relativePath, 0, CHUNKS[0]);
    assert.equal(limited.status, 429, limited.text);
    assert.equal(limited.body.code, "rate_limited");
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    const limitedEvent = ctx.server.output.join("")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("[direct-upload] "))
      .map((line) => JSON.parse(line.slice("[direct-upload] ".length)))
      .filter((event) => event.decision === "limited")
      .at(-1);
    assert.equal(limitedEvent.operation, "patch");
    assert.equal(limitedEvent.uploadId, third.structured.uploadId.slice(0, 8));
    assert.equal(limitedEvent.limit, "rate");
  } finally {
    await stopChild(ctx.server.child);
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 7. The PUT writer keeps its own semantics on a partially staged handle.
// ---------------------------------------------------------------------------------------------
test("admission: the shared concurrency cap refuses a third in-flight PATCH from the same credential", async () => {
  const handles = [await startUpload(main), await startUpload(main), await startUpload(main)];
  const stalling = [];
  for (const handle of handles.slice(0, 2)) {
    const req = patchRequest({ base: main.base, relativePath: handle.structured.relativePath, offset: 0, contentLength: CHUNK });
    collect(req).catch(() => {});
    req.write(CHUNKS[0].subarray(0, 1)); // inside the handler, holding an in-flight slot
    stalling.push({ req, uploadId: handle.structured.uploadId });
  }
  try {
    // The slot is claimed before the first body byte; once both handles have staged a byte, both
    // slots are provably held by these two requests.
    for (const { uploadId } of stalling) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if ((await partSize(main, uploadId)) >= 1) break;
        await sleep(20);
      }
      assert.ok((await partSize(main, uploadId)) >= 1, "the stalled PATCH reached the handler");
    }
    const third = await patchChunk(main, handles[2].structured.relativePath, 0, CHUNKS[0].subarray(0, 1024));
    assert.equal(third.status, 429, third.text);
    assert.ok(Number(third.headers["retry-after"]) >= 1);
    const limited = main.server.output.join("").split(/\r?\n/)
      .filter((line) => line.startsWith("[direct-upload] "))
      .map((line) => JSON.parse(line.slice("[direct-upload] ".length)))
      .filter((event) => event.operation === "patch" && event.decision === "limited");
    assert.equal(limited.at(-1)?.limit, "concurrency");
    assert.equal(await partSize(main, handles[2].structured.uploadId), 0, "the refused PATCH never appended");
  } finally {
    for (const { req } of stalling) req.destroy();
    await sleep(300); // slots are released on socket close; keep the next test out of a 429
  }
});

test("the whole-body PUT refuses a handle that already has staged PATCH bytes and points at PATCH", async () => {
  const { structured } = await startUpload(main);
  const first = await patchChunk(main, structured.relativePath, 0, CHUNKS[0]);
  assert.equal(first.status, 200);

  const put = await fetch(`${main.base}${structured.relativePath}`, {
    method: "PUT",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/octet-stream" },
    body: PAYLOAD,
  });
  assert.equal(put.status, 409);
  const body = await put.json();
  assert.equal(body.code, "UPLOAD_MODE_CONFLICT");
  assert.match(body.message, /PATCH \/uploads\//);
  assert.equal((await readMetadata(main, structured.uploadId)).uploadedBytes, CHUNK, "the staged prefix is untouched");
});
