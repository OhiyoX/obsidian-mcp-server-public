// Issue #698 — the direct-upload rate token is charged per UPLOAD, not per request.
//
// `DIRECT_UPLOAD_RATE_PER_MINUTE` (default 6) used to be spent by every request that reached
// `admit()`: the whole-body `PUT` and *every* `PATCH` chunk of the same handle. With the default
// 8 MiB chunk size a full-size 50 MiB file needs seven `PATCH`es, so the seventh was refused with
// `429` for doing exactly the right thing. The admission contract is now "one upload, one token":
// the first request that carries the handle pays, the continuation chunks of the SAME
// (credential, uploadId) pair do not. The four abuse gates (per-credential in-flight, global
// in-flight, staging-disk headroom, idle/total-duration) stay per request and are re-proved here
// for `PATCH`, because a waiver must not leak into them.
//
// Everything runs against the real `server.js` on an ephemeral port with an isolated
// DATA_PATH/VAULT_PATH. Each gate gets its own instance so no test depends on another's bucket or
// on ambient `.env` values.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { createDirectUploadLimiter } from "../src/direct-upload-limits.js";
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

const MIB = 1024 * 1024;
const RATE_PER_MINUTE = 6;
const CHUNK_BYTES = 8 * MIB;
// The documented whole-file ceiling and chunk size: 50 MiB in seven <= 8 MiB chunks.
const FULL_PAYLOAD = Buffer.concat(Array.from({ length: 50 }, () => {
  const block = Buffer.alloc(MIB);
  for (let index = 0; index < block.length; index += 1) block[index] = (index * 29 + 13) % 256;
  return block;
}));
const FULL_CHUNKS = [];
for (let offset = 0; offset < FULL_PAYLOAD.length; offset += CHUNK_BYTES) {
  FULL_CHUNKS.push(FULL_PAYLOAD.subarray(offset, Math.min(offset + CHUNK_BYTES, FULL_PAYLOAD.length)));
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SMALL = Buffer.alloc(64, 7);

const ctxs = [];
const dirs = [];
let root;

async function boot({ root: bootRoot, extra = {} } = {}) {
  const port = await freePort();
  const server = await startServer(serverEnv({
    port,
    root: bootRoot,
    extra: {
      WEB_CATALOG_DIR: path.join(bootRoot, "web-catalog"),
      DIRECT_UPLOAD_MIN_FREE_BYTES: "0",
      DIRECT_UPLOAD_IDLE_TIMEOUT_MS: "60000",
      DIRECT_UPLOAD_MAX_DURATION_MS: "240000",
      ...extra,
    },
  }));
  ctxs.push(server.child);
  const init = await initialize(server.base, { key: API_KEY });
  assert.equal(init.status, 200);
  return { server, base: server.base, session: init.session, root: bootRoot };
}

async function freshContext(name, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `direct-upload-${name}-`));
  dirs.push(dir);
  await seedVault(dir);
  return boot({ root: dir, extra });
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-rate-bucket-"));
  await seedVault(root);
});

after(async () => {
  await Promise.all(ctxs.map((child) => stopChild(child)));
  await fs.rm(root, { recursive: true, force: true });
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

function auditEvents(ctx) {
  return ctx.server.output.join("").split(/\r?\n/)
    .filter((line) => line.startsWith("[direct-upload] "))
    .map((line) => JSON.parse(line.slice("[direct-upload] ".length)));
}

async function startUpload(ctx, { target = `attachments/${randomUUID()}.bin`, payload = SMALL } = {}) {
  const response = await callTool(ctx.base, { key: API_KEY }, ctx.session, "start_direct_upload", {
    path: target, totalBytes: payload.length, sha256: sha256(payload), overwrite: false,
  });
  const structured = response.payload?.result?.structuredContent ?? {};
  assert.ok(structured.uploadId, `the control plane failed: ${JSON.stringify(response.payload)}`);
  return { structured, target };
}

function patchRequest(ctx, { relativePath, offset, contentLength }) {
  const url = new URL(`${ctx.base}${relativePath}`);
  return http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "PATCH",
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(contentLength),
      "Upload-Offset": String(offset),
    },
  });
}

function collect(req, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`the PATCH never answered within ${timeoutMs} ms`)), timeoutMs);
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        clearTimeout(guard);
        let body = null;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, body, elapsedMs: null });
      });
    });
    req.on("error", (error) => { clearTimeout(guard); reject(error); });
  });
}

/** One contiguous chunk through the raw client, so the response headers stay assertable. */
async function patchChunk(ctx, relativePath, offset, body) {
  const req = patchRequest(ctx, { relativePath, offset, contentLength: body.length });
  const settled = collect(req);
  req.end(body);
  const startedAt = Date.now();
  const result = await settled;
  return { ...result, elapsedMs: Date.now() - startedAt };
}

async function put(ctx, relativePath, body) {
  const response = await fetch(`${ctx.base}${relativePath}`, {
    method: "PUT",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/octet-stream" },
    body,
  });
  return { response, body: await response.json() };
}

async function publishSmall(ctx) {
  const { structured, target } = await startUpload(ctx);
  const result = await put(ctx, structured.relativePath, SMALL);
  return { ...result, structured, target };
}

function uploadPaths(ctx, uploadId) {
  const uploads = path.join(ctx.root, "data", "transfers", "uploads");
  return { metadata: path.join(uploads, `${uploadId}.json`), part: path.join(uploads, `${uploadId}.part`) };
}

async function partSize(ctx, uploadId) {
  return fs.stat(uploadPaths(ctx, uploadId).part).then((stat) => stat.size, () => null);
}

async function readMetadata(ctx, uploadId) {
  return JSON.parse(await fs.readFile(uploadPaths(ctx, uploadId).metadata, "utf8"));
}

async function vaultDigest(ctx, target) {
  const file = path.join(ctx.root, "vault", ...target.split("/"));
  const data = await fs.readFile(file).catch(() => null);
  return data ? { size: data.length, sha256: sha256(data) } : null;
}

// ---------------------------------------------------------------------------------------------
// 1. REGRESSION (#698): a full-size file in default-size chunks never meets the rate gate.
//    On the pre-fix head this is red: the seventh PATCH answers 429 rate_limited.
// ---------------------------------------------------------------------------------------------
test("rate: a 50 MiB file in seven 8 MiB PATCHes completes with zero 429 (one token per upload)", async () => {
  const ctx = await freshContext("rate-full", {
    DIRECT_UPLOAD_RATE_PER_MINUTE: String(RATE_PER_MINUTE),
    DIRECT_UPLOAD_PATCH_MAX_BYTES: String(CHUNK_BYTES),
  });
  const { structured, target } = await startUpload(ctx, { payload: FULL_PAYLOAD });
  const readings = [];
  let completed = null;

  for (const [index, chunk] of FULL_CHUNKS.entries()) {
    const offset = index * CHUNK_BYTES;
    const response = await patchChunk(ctx, structured.relativePath, offset, chunk);
    readings.push({ chunk: index + 1, offset, status: response.status, code: response.body?.code ?? null, retryAfter: response.headers["retry-after"] ?? null });
    assert.equal(response.status, 200, `chunk ${index + 1}/${FULL_CHUNKS.length} must be accepted, got ${response.status}: ${response.text}`);
    assert.equal(response.body.uploadedBytes, offset + chunk.length);
    if (index === FULL_CHUNKS.length - 1) completed = response.body;
  }

  const limited = auditEvents(ctx).filter((event) => event.decision === "limited");
  console.log(`DIRECT_UPLOAD_RATE_BUCKET_50MIB=${JSON.stringify({
    chunks: FULL_CHUNKS.length,
    chunkBytes: CHUNK_BYTES,
    statuses: readings.map((reading) => reading.status),
    limitedEvents: limited.length,
  })}`);

  assert.deepEqual(readings.map((reading) => reading.status), FULL_CHUNKS.map(() => 200), `no chunk may be rate limited: ${JSON.stringify(readings)}`);
  assert.equal(limited.length, 0, `a compliant upload must not be limited once: ${JSON.stringify(limited)}`);
  assert.equal(completed?.complete, true);
  assert.equal(completed?.status, "COMPLETE");
  assert.equal(completed?.size, FULL_PAYLOAD.length);
  assert.equal(completed?.sha256, sha256(FULL_PAYLOAD));
  assert.deepEqual(await vaultDigest(ctx, target), { size: FULL_PAYLOAD.length, sha256: sha256(FULL_PAYLOAD) });

  // The audit proves WHY it was not limited: exactly one charged patch line, the rest waived.
  const patchLines = auditEvents(ctx).filter((event) => event.operation === "patch" && event.uploadId === structured.uploadId.slice(0, 8) && event.decision === "allow");
  assert.equal(patchLines.length, FULL_CHUNKS.length);
  assert.equal(patchLines.filter((event) => event.rateWaived !== true).length, 1, `only the first chunk may be charged: ${JSON.stringify(patchLines)}`);
  assert.equal(patchLines.filter((event) => event.rateWaived === true).length, FULL_CHUNKS.length - 1);
});

// ---------------------------------------------------------------------------------------------
// 2. The waiver is per handle, not per credential: a new upload still spends a token.
// ---------------------------------------------------------------------------------------------
test("rate: a seventh NEW upload on the same credential still answers 429, while a continuation is still free", async () => {
  const ctx = await freshContext("rate-new-handle", { DIRECT_UPLOAD_RATE_PER_MINUTE: String(RATE_PER_MINUTE) });

  // Six whole-body PUTs on six NEW handles exhaust the six-token burst.
  const published = [];
  for (let attempt = 1; attempt <= RATE_PER_MINUTE; attempt += 1) {
    const result = await publishSmall(ctx);
    assert.equal(result.response.status, 201, `PUT ${attempt} must publish: ${JSON.stringify(result.body)}`);
    published.push(result.structured);
  }

  // A seventh handle is a seventh upload: its FIRST write is charged, so it is limited.
  const seventh = await startUpload(ctx);
  const limited = await patchChunk(ctx, seventh.structured.relativePath, 0, SMALL);
  assert.equal(limited.status, 429, `a new upload must not inherit the waiver: ${limited.text}`);
  assert.equal(limited.body?.code, "rate_limited");
  const retryAfter = Number(limited.headers["retry-after"]);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After must be a positive integer second, got ${limited.headers["retry-after"]}`);
  assert.equal(limited.body?.retryAfterSeconds, retryAfter);
  assert.equal(limited.body?.error, "rate_limited");

  const limitedEvent = auditEvents(ctx).filter((event) => event.decision === "limited").at(-1);
  assert.equal(limitedEvent.operation, "patch", "the audit names the operation (#698 §C)");
  assert.equal(limitedEvent.uploadId, seventh.structured.uploadId.slice(0, 8), "the audit names the handle");
  assert.equal(limitedEvent.limit, "rate");
  assert.equal(limitedEvent.status, 429);
  assert.equal(limitedEvent.retryAfterSeconds, retryAfter);
  assert.ok(limitedEvent.credentialId, "the credential id is kept, the token is not");

  // ...while the SAME exhausted credential may still re-ask an already-admitted handle (continuation
  // of an upload whose token was already paid). A zero-byte PATCH at the acknowledged offset re-answers
  // the receipt; on the pre-fix head the same request is the seventh/fourteenth token and answers 429.
  const replay = await patchChunk(ctx, published[0].relativePath, SMALL.length, Buffer.alloc(0));
  assert.equal(replay.status, 200, `a continuation of a paid handle must not be charged again: ${replay.text}`);
  assert.equal(replay.body?.complete, true);
  assert.equal(replay.body?.status, "COMPLETE");
  assert.ok(auditEvents(ctx).some((event) => event.operation === "patch" && event.decision === "allow" && event.rateWaived === true && event.uploadId === published[0].uploadId.slice(0, 8)));
});

// ---------------------------------------------------------------------------------------------
// 3. Gate 1/4 — the per-credential in-flight cap still applies to every continuation PATCH.
// ---------------------------------------------------------------------------------------------
test("gates: a continuation PATCH still competes for the per-credential in-flight slot (429 concurrency)", async () => {
  const ctx = await freshContext("conc", {
    DIRECT_UPLOAD_RATE_PER_MINUTE: "600",
    DIRECT_UPLOAD_MAX_CONCURRENT_PER_CREDENTIAL: "1",
  });
  const chunk = Buffer.alloc(256 * 1024, 4);
  const payload = Buffer.concat([chunk, chunk]);
  const { structured, target } = await startUpload(ctx, { payload });

  const first = await patchChunk(ctx, structured.relativePath, 0, chunk);
  assert.equal(first.status, 200, first.text);

  // A stalled continuation holds the single per-credential slot.
  const hanging = patchRequest(ctx, { relativePath: structured.relativePath, offset: chunk.length, contentLength: chunk.length });
  const hangingSettled = collect(hanging).catch((error) => ({ status: 0, error }));
  hanging.write(chunk.subarray(0, 4096));
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await partSize(ctx, structured.uploadId)) > chunk.length) break;
    await sleep(10);
  }
  assert.ok((await partSize(ctx, structured.uploadId)) > chunk.length, "the second writer must be inside the body");

  const blocked = await patchChunk(ctx, structured.relativePath, chunk.length, chunk);
  assert.equal(blocked.status, 429, `the in-flight cap must still gate a continuation: ${blocked.text}`);
  assert.equal(blocked.body?.code, "rate_limited");
  const blockedEvent = auditEvents(ctx).filter((event) => event.decision === "limited").at(-1);
  assert.equal(blockedEvent.limit, "concurrency");
  assert.equal(blockedEvent.operation, "patch");
  assert.equal(blockedEvent.uploadId, structured.uploadId.slice(0, 8));

  hanging.destroy();
  await hangingSettled;

  // The slot and the writer lock are released: the same continuation now lands.
  let retried = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await patchChunk(ctx, structured.relativePath, chunk.length, chunk);
    if (response.status === 200) { retried = response; break; }
    assert.ok([409, 429].includes(response.status), `${response.status}: ${response.text}`);
    await sleep(100);
  }
  assert.ok(retried, "a released slot must accept the continuation again");
  assert.equal(retried.body?.complete, true, "the retried chunk completes the upload");
  assert.equal(retried.body?.sha256, sha256(payload));
  assert.deepEqual(await vaultDigest(ctx, target), { size: payload.length, sha256: sha256(payload) });
});

// ---------------------------------------------------------------------------------------------
// 4. Gate 2/4 — the staging-disk gate still applies to a continuation PATCH (507).
// ---------------------------------------------------------------------------------------------
test("gates: a continuation PATCH still answers 507 when the staging disk is short", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-disc-"));
  dirs.push(dir);
  await seedVault(dir);
  const first = await boot({
    root: dir,
    extra: { DIRECT_UPLOAD_RATE_PER_MINUTE: "600", DIRECT_UPLOAD_MIN_FREE_BYTES: "0" },
  });
  const chunk = Buffer.alloc(256 * 1024, 5);
  const payload = Buffer.concat([chunk, chunk]);
  const { structured } = await startUpload(first, { payload });
  const accepted = await patchChunk(first, structured.relativePath, 0, chunk);
  assert.equal(accepted.status, 200, accepted.text);

  // Same Vault/root, disk gate raised above any real device: the continuation must be refused.
  const port = await freePort();
  const second = await startServer(serverEnv({
    port,
    root: dir,
    extra: {
      WEB_CATALOG_DIR: path.join(dir, "web-catalog"),
      DIRECT_UPLOAD_RATE_PER_MINUTE: "600",
      DIRECT_UPLOAD_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER),
      DIRECT_UPLOAD_IDLE_TIMEOUT_MS: "60000",
    },
  }));
  ctxs.push(second.child);
  const secondSession = (await initialize(second.base, { key: API_KEY })).session;
  const secondCtx = { server: second, base: second.base, session: secondSession, root: dir };

  const blocked = await patchChunk(secondCtx, structured.relativePath, chunk.length, chunk);
  assert.equal(blocked.status, 507, `the disk gate must still gate a continuation: ${blocked.text}`);
  assert.equal(blocked.body?.code, "insufficient_storage");
  const blockedEvent = auditEvents(secondCtx).filter((event) => event.code === "insufficient_storage").at(-1);
  assert.equal(blockedEvent.operation, "patch");
  assert.equal(blockedEvent.uploadId, structured.uploadId.slice(0, 8));
  assert.equal(typeof blockedEvent.freeBytes, "number");
  assert.equal(blockedEvent.freeBytesUnknown, undefined);
  assert.equal(await partSize(secondCtx, structured.uploadId), chunk.length, "nothing was appended");
  assert.equal(await fs.readFile(path.join(dir, "vault", "note.md"), "utf8"), "# Integration note\n\nbody\n");
});

// ---------------------------------------------------------------------------------------------
// 5. Gates 3/4 + 4/4 — idle and total-duration bounds still apply per continuation PATCH (408).
// ---------------------------------------------------------------------------------------------
test("gates: a continuation PATCH still answers 408 for an idle body and for an over-long body", async () => {
  const idleMs = 1200;
  const maxMs = 2000;
  const ctx = await freshContext("time", {
    DIRECT_UPLOAD_RATE_PER_MINUTE: "600",
    DIRECT_UPLOAD_IDLE_TIMEOUT_MS: String(idleMs),
    DIRECT_UPLOAD_MAX_DURATION_MS: String(maxMs),
  });
  const chunk = Buffer.alloc(256 * 1024, 6);
  const payload = Buffer.concat([chunk, chunk]);

  // Idle: the headers and a few bytes arrive, then silence.
  const idleHandle = await startUpload(ctx, { payload });
  const idleReq = patchRequest(ctx, { relativePath: idleHandle.structured.relativePath, offset: 0, contentLength: chunk.length });
  const idleSettled = collect(idleReq, idleMs * 5);
  idleReq.write(chunk.subarray(0, 1024));
  const idle = await idleSettled;
  assert.equal(idle.status, 408, idle.text);
  assert.equal(idle.body?.code, "upload_idle_timeout");
  assert.equal((await readMetadata(ctx, idleHandle.structured.uploadId)).status, "failed-retryable");
  const idleEvent = auditEvents(ctx).filter((event) => event.code === "upload_idle_timeout").at(-1);
  assert.equal(idleEvent.operation, "patch");
  assert.equal(idleEvent.uploadId, idleHandle.structured.uploadId.slice(0, 8));
  assert.equal(idleEvent.decision, "timeout");

  // Duration: bytes keep arriving, so only the total budget can fire.
  const durationHandle = await startUpload(ctx, { payload });
  const durationReq = patchRequest(ctx, { relativePath: durationHandle.structured.relativePath, offset: 0, contentLength: chunk.length });
  const durationSettled = collect(durationReq, maxMs * 5);
  const startedAt = Date.now();
  const trickle = setInterval(() => {
    if (!durationReq.destroyed) durationReq.write(chunk.subarray(0, 512));
  }, 200);
  let duration;
  try {
    duration = await durationSettled;
  } finally {
    clearInterval(trickle);
    durationReq.destroy();
  }
  assert.equal(duration.status, 408, duration.text);
  assert.equal(duration.body?.code, "upload_max_duration");
  assert.ok(Date.now() - startedAt >= maxMs, "the duration bound must not fire before its budget");
  assert.equal((await readMetadata(ctx, durationHandle.structured.uploadId)).status, "failed-retryable");
  const durationEvent = auditEvents(ctx).filter((event) => event.code === "upload_max_duration").at(-1);
  assert.equal(durationEvent.operation, "patch");
  assert.equal(durationEvent.uploadId, durationHandle.structured.uploadId.slice(0, 8));
  assert.equal(durationEvent.decision, "timeout");
});

// ---------------------------------------------------------------------------------------------
// 6. Unit: the waiver state machine (injected clock, no HTTP).
// ---------------------------------------------------------------------------------------------
test("limiter: a recorded rate charge waives only the SAME credential and uploadId, and expires", () => {
  let now = 0;
  const limiter = createDirectUploadLimiter({ ratePerMinute: 1, now: () => now, rateChargeTtlMs: 1000 });
  assert.equal(limiter.rateChargeHeld("credential-a", "upload-1"), false, "nothing paid yet");
  assert.equal(limiter.rateLimit("credential-a").allowed, true, "the first request pays the single token");
  limiter.recordRateCharge("credential-a", "upload-1");
  assert.equal(limiter.rateChargeHeld("credential-a", "upload-1"), true);
  assert.equal(limiter.rateChargeHeld("credential-a", "upload-2"), false, "a different handle is a different upload");
  assert.equal(limiter.rateChargeHeld("credential-b", "upload-1"), false, "another credential never inherits a waiver");
  assert.equal(limiter.snapshot().paidUploads, 1);

  now += 999;
  assert.equal(limiter.rateChargeHeld("credential-a", "upload-1"), true);
  now += 1;
  assert.equal(limiter.rateChargeHeld("credential-a", "upload-1"), false, "an expired marker cannot waive forever");
});
