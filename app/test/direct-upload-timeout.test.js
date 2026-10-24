// Issue #470 follow-up — task B: `/uploads/` time bounds (idle + total duration).
//
// Contract: `scratch/briefs/upload-timeout-BRIEF.md` §1. Wave A bound one body (50 MiB) and one
// writer per handle, task A bound how many PUTs and how much disk; nothing bounded TIME, so a slow
// enough client could hold one of the 8 global in-flight slots forever and every other caller got
// 429 until the edge nginx gave up at ~300 s.
//
// Two properties matter and they pull in opposite directions:
//   1. a stalled/over-long body must be aborted, must not publish, must mark the handle
//      `failed-retryable`, and must release its slot immediately;
//   2. a healthy body — and above all the long-lived `POST`/`GET /mcp` SSE transport — must be
//      untouched. Test 3 is the reverse assertion: the same instance, with a ~1.5 s timeout, keeps
//      a real MCP session and its standalone SSE stream alive well past that timeout.
//
// Two real `server.js` processes are spawned because the two bounds must be exercised in isolation
// (a single instance cannot have a 1.5 s idle bound and still tolerate a deliberately slow sender).
// Everything is driven as a client would: raw `http.request` for the partial/slow bodies (fetch
// cannot express "send 1 KiB and then stall"), one MCP call for the control plane, one `PUT` per file.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, pipeline } from "node:stream";
import test, { after, before } from "node:test";

import { createUploadStreamGuard, DIRECT_UPLOAD_TIMEOUT_CODES } from "../src/direct-upload-limits.js";
import {
  API_KEY,
  callTool,
  freePort,
  initialize,
  seedVault,
  serverEnv,
  startServer,
  stopChild,
} from "./helpers/server-spawn-fixtures.js";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const IDLE_TIMEOUT_MS = 1_500;
const MAX_DURATION_MS = 1_500;
// The long bound on the idle instance and the long idle bound on the duration instance, so each
// suite exercises exactly one timeout.
const LONG_MS = 60_000;
const STALL_BYTES = 65_536;
const TRICKLE_CHUNK_BYTES = 1_024;
const TRICKLE_INTERVAL_MS = 400;
const MIB = 1024 * 1024;

let idleRoot;
let durationRoot;
let idleServer;
let durationServer;

before(async () => {
  idleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-idle-"));
  await seedVault(idleRoot);
  idleServer = await startServer(serverEnv({
    port: await freePort(),
    root: idleRoot,
    extra: {
      WEB_CATALOG_DIR: path.join(idleRoot, "web-catalog"),
      DIRECT_UPLOAD_RATE_PER_MINUTE: "600",
      DIRECT_UPLOAD_MAX_CONCURRENT_PER_CREDENTIAL: "2",
      DIRECT_UPLOAD_MAX_CONCURRENT_GLOBAL: "8",
      DIRECT_UPLOAD_MIN_FREE_BYTES: "0",
      DIRECT_UPLOAD_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
      DIRECT_UPLOAD_MAX_DURATION_MS: String(LONG_MS),
    },
  }));

  durationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-duration-"));
  await seedVault(durationRoot);
  durationServer = await startServer(serverEnv({
    port: await freePort(),
    root: durationRoot,
    extra: {
      WEB_CATALOG_DIR: path.join(durationRoot, "web-catalog"),
      DIRECT_UPLOAD_RATE_PER_MINUTE: "600",
      DIRECT_UPLOAD_MIN_FREE_BYTES: "0",
      DIRECT_UPLOAD_IDLE_TIMEOUT_MS: String(LONG_MS),
      DIRECT_UPLOAD_MAX_DURATION_MS: String(MAX_DURATION_MS),
    },
  }));
});

after(async () => {
  await stopChild(idleServer?.child);
  await stopChild(durationServer?.child);
  await fs.rm(idleRoot, { recursive: true, force: true });
  await fs.rm(durationRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function auditEvents(server, operation = "put") {
  return server.output.join("").split(/\r?\n/)
    .filter((line) => line.startsWith("[direct-upload] "))
    .map((line) => JSON.parse(line.slice("[direct-upload] ".length)))
    .filter((event) => event.operation === operation);
}

async function authFor(server) {
  const init = await initialize(server.base, { key: API_KEY });
  assert.equal(init.status, 200);
  return { key: API_KEY, session: init.session };
}

async function startUpload(server, auth, payload, { target = `attachments/${randomUUID()}.bin` } = {}) {
  const response = await callTool(server.base, auth, auth.session, "start_direct_upload", {
    path: target, totalBytes: payload.length, sha256: sha256(payload), overwrite: false,
  });
  const structured = response.payload?.result?.structuredContent ?? {};
  assert.ok(structured.uploadId, `the control plane failed: ${JSON.stringify(response.payload)}`);
  return { structured, target };
}

function requestTo(server, auth, relativePath, contentLength) {
  const url = new URL(`${server.base}${relativePath}`);
  return http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "PUT",
    headers: {
      "X-API-Key": auth.key,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(contentLength),
    },
  });
}

function collectResponse(req) {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error("the PUT never answered within 20 s")), 20_000);
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        clearTimeout(guard);
        let body = null;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, body });
      });
    });
    req.on("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
  });
}

/** Whole body in one shot with an explicit Content-Length (fetch omits it for a 0-byte body). */
async function putAll(server, auth, relativePath, payload) {
  const req = requestTo(server, auth, relativePath, payload.length);
  const settled = collectResponse(req);
  req.end(payload);
  return settled;
}

/** Send `head` bytes and then stall: the socket stays open but no new byte arrives. */
async function putStalled(server, auth, relativePath, { totalBytes, head }) {
  const req = requestTo(server, auth, relativePath, totalBytes);
  const settled = collectResponse(req);
  req.write(head);
  const result = await settled;
  req.destroy();
  return result;
}

/** Send one small chunk every `intervalMs` so idle never fires while total duration does. */
async function putTrickle(server, auth, relativePath, { totalBytes, chunk, intervalMs = TRICKLE_INTERVAL_MS }) {
  const req = requestTo(server, auth, relativePath, totalBytes);
  const settled = collectResponse(req).catch((error) => ({ status: 0, text: String(error), body: null }));
  let sent = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    if (sent >= totalBytes || req.destroyed) return;
    const size = Math.min(chunk.length, totalBytes - sent);
    sent += size;
    req.write(chunk.subarray(0, size));
  }, intervalMs);
  // The first chunk goes out immediately; the rest keep the idle timer alive.
  req.write(chunk.subarray(0, Math.min(chunk.length, totalBytes)));
  sent += Math.min(chunk.length, totalBytes);
  try {
    const result = await settled;
    return { ...result, elapsedMs: Date.now() - started };
  } finally {
    clearInterval(timer);
    req.destroy();
  }
}

async function readMetadata(root, uploadId) {
  return JSON.parse(await fs.readFile(path.join(root, "data", "transfers", "uploads", `${uploadId}.json`), "utf8"));
}

async function stagingPart(root, uploadId) {
  return fs.stat(path.join(root, "data", "transfers", "uploads", `${uploadId}.part`)).catch(() => null);
}

/**
 * Poll a set of handles until all reach `status` (one shared deadline, so a broken build cannot
 * multiply the wait). Polling deliberately starts only after the aborts have settled: reading the
 * metadata file while the runtime renames over it makes Windows answer EPERM to the rename, and
 * `transfer-runtime.js` swallows a failed `markFailed` write — a pre-existing flake the guard has
 * nothing to do with, but one this test must not provoke.
 */
async function waitForStatuses(root, uploadIds, status, { settleMs = 1_000, timeoutMs = 10_000 } = {}) {
  await sleep(settleMs);
  const deadline = Date.now() + timeoutMs;
  let metas = [];
  for (;;) {
    metas = await Promise.all(uploadIds.map((id) =>
      readMetadata(root, id).catch((error) => ({ status: `unreadable: ${error.message}` }))));
    if (metas.every((metadata) => metadata?.status === status)) return metas;
    if (Date.now() >= deadline) return metas;
    await sleep(100);
  }
}

/**
 * Open handle count of the spawned server process: one leaked `.part` write stream per aborted
 * upload shows up here (Win32 process handle count / POSIX fd count). `null` where neither exists.
 */
function openHandleCount(pid) {
  if (!pid) return null;
  try {
    if (process.platform === "linux") return fsSync.readdirSync(`/proc/${pid}/fd`).length;
    if (process.platform === "win32") {
      const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).HandleCount`], { encoding: "utf8" });
      const count = Number(out.trim());
      return Number.isFinite(count) ? count : null;
    }
  } catch {}
  return null;
}

/**
 * Send `head` bytes, wait until they reach staging (proof the request is inside the stream), then
 * destroy the socket mid-body. Exactly what a Ctrl-C'd client does.
 */
async function abortMidBody(server, auth, root, { structured, totalBytes, head }) {
  const req = requestTo(server, auth, structured.relativePath, totalBytes);
  req.on("error", () => {});
  req.write(head);
  const partPath = path.join(root, "data", "transfers", "uploads", `${structured.uploadId}.part`);
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const stat = await fs.stat(partPath).catch(() => null);
      if (stat && stat.size > 0) return;
      await sleep(10);
    }
    throw new Error("the partial body never reached staging");
  } finally {
    req.destroy();
  }
}

/**
 * A PUT that is expected to be refused: the response is what gets asserted, so a socket the server
 * closes before it drained the body (it answers 409 and `req.resume()`s) must not reject the test.
 */
async function putExpectingRejection(server, auth, relativePath, payload) {
  const req = requestTo(server, auth, relativePath, payload.length);
  const settled = new Promise((resolve) => {
    const guard = setTimeout(() => resolve({ status: 0, text: "the PUT never answered within 10 s", body: null }), 10_000);
    req.on("error", () => {});
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("error", () => {});
      res.on("end", () => {
        clearTimeout(guard);
        let body = null;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, body });
      });
    });
  });
  req.end(payload);
  return settled;
}

async function vaultFile(root, target) {
  return fs.readFile(path.join(root, "vault", ...target.split("/"))).catch(() => null);
}

function assertTimeoutAudit(server, uploadId, code) {
  const events = auditEvents(server).filter((event) => event.uploadId === uploadId.slice(0, 8));
  const timeout = events.filter((event) => event.decision === "timeout");
  assert.equal(timeout.length, 1, `exactly one timeout audit line, saw ${JSON.stringify(events)}`);
  assert.equal(timeout[0].code, code);
  assert.equal(timeout[0].status, 408);
  assert.equal(timeout[0].operation, "put");
  assert.equal(events.some((event) => event.decision === "allow"), false, "a timed-out PUT is never an allow");
  assert.equal(events.some((event) => event.decision === "deny"), false, "a timeout is not a policy deny");
  return timeout[0];
}

// ---------------------------------------------------------------------------------------------
// Unit: the guard itself (real short timers, no HTTP)
// ---------------------------------------------------------------------------------------------

test("guard: the idle bound fires when no byte arrives, and every chunk re-arms it", async () => {
  const source = new Readable({ read() {} });
  const guard = createUploadStreamGuard({ stream: source, idleTimeoutMs: 120, maxDurationMs: 10_000 });
  try {
    const failed = new Promise((resolve) => guard.body.once("error", resolve));
    const error = await failed;
    assert.equal(error.code, DIRECT_UPLOAD_TIMEOUT_CODES.idle);
    assert.equal(guard.timedOut(), DIRECT_UPLOAD_TIMEOUT_CODES.idle);
    assert.equal(guard.firstByteAt(), null, "no byte ever arrived");
  } finally {
    guard.dispose();
    source.destroy();
    guard.body.destroy();
  }

  // Chunks keep it alive: 4 × 80 ms of traffic outlives a 120 ms bound.
  const talking = new Readable({ read() {} });
  const alive = createUploadStreamGuard({ stream: talking, idleTimeoutMs: 120, maxDurationMs: 10_000 });
  const errors = [];
  alive.body.on("error", (error) => errors.push(error));
  alive.body.resume();
  try {
    for (let index = 0; index < 4; index += 1) {
      talking.push(Buffer.alloc(16, 1));
      await sleep(80);
    }
    assert.deepEqual(errors, [], "a chunk resets the idle clock");
    assert.equal(alive.timedOut(), null);
    assert.equal(typeof alive.firstByteAt(), "number");
  } finally {
    alive.dispose();
    talking.destroy();
    alive.body.destroy();
  }
});

test("guard: the total-duration clock starts at the first byte, not at construction", async () => {
  const source = new Readable({ read() {} });
  const guard = createUploadStreamGuard({ stream: source, idleTimeoutMs: 10_000, maxDurationMs: 150 });
  const errors = [];
  guard.body.on("error", (error) => errors.push(error));
  guard.body.resume();
  try {
    // Wait almost the whole budget with an empty body: the duration clock must not be running yet.
    await sleep(110);
    assert.equal(guard.timedOut(), null, "no first byte ⇒ no duration clock");
    source.push(Buffer.alloc(8, 2));
    await sleep(90);
    assert.equal(guard.timedOut(), null, "only 90 ms have passed since the first byte");
    await sleep(140);
    assert.equal(guard.timedOut(), DIRECT_UPLOAD_TIMEOUT_CODES.duration);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, DIRECT_UPLOAD_TIMEOUT_CODES.duration);
  } finally {
    guard.dispose();
    source.destroy();
    guard.body.destroy();
  }
});

test("guard: a client that goes away mid-body is propagated as an interruption, never as a 408", async () => {
  const source = new Readable({ read() {} });
  const guard = createUploadStreamGuard({ stream: source, idleTimeoutMs: 80, maxDurationMs: 80 });
  const errors = [];
  guard.body.on("error", (error) => errors.push(error));
  guard.body.resume();
  try {
    // A body started, so this is a genuinely interrupted upload and not a request that never spoke.
    source.push(Buffer.alloc(8, 1));
    await sleep(10);
    source.destroy();
    for (let attempt = 0; attempt < 100 && errors.length === 0; attempt += 1) await sleep(10);
    assert.equal(errors.length, 1, "the inner stream must be rejected exactly once");
    assert.equal(errors[0].code, "ECONNRESET", "an interrupted body keeps the pre-guard ECONNRESET semantics");
    assert.equal(guard.timedOut(), null, "a dead socket is the existing interruption path, not a timeout");
    // Well past both bounds: the timers are gone, so nothing else fires on the dead source.
    await sleep(200);
    assert.equal(errors.length, 1);
    assert.equal(guard.timedOut(), null);
  } finally {
    guard.dispose();
    guard.dispose(); // idempotent
    guard.body.destroy();
  }
});

test("guard: a socket that died before the guard existed is still propagated (pipe() from a dead source is a no-op)", async () => {
  const source = new Readable({ read() {} });
  source.push(Buffer.alloc(8, 4));
  source.destroy();
  await sleep(20);
  assert.equal(source.destroyed, true);
  const guard = createUploadStreamGuard({ stream: source, idleTimeoutMs: 5_000, maxDurationMs: 5_000 });
  try {
    const settled = await Promise.race([
      new Promise((resolve) => pipeline(guard.body, new PassThrough(), (error) => resolve(error ?? null))),
      sleep(2_000).then(() => "timeout"),
    ]);
    assert.notEqual(settled, "timeout", "a source that died before the guard existed must not leave the body open");
    assert.equal(settled?.code, "ECONNRESET");
    assert.equal(guard.timedOut(), null, "a dead socket is never a 408");
  } finally {
    guard.dispose();
    guard.body.destroy();
  }
});

test("guard: an abort that lands before the runtime's pipeline attaches still settles it, with no uncaught error", async () => {
  const source = new Readable({ read() {} });
  const guard = createUploadStreamGuard({ stream: source, idleTimeoutMs: 0, maxDurationMs: 0 });
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error?.code ?? String(error));
  process.on("uncaughtException", onUncaught);
  try {
    source.push(Buffer.alloc(16, 3));
    source.destroy(); // the runtime is still doing its async pre-checks: nobody listens to `body` yet
    await sleep(50);
    // A stream destroyed with an error still reports it through `stream.errored`, so `pipeline`
    // rejects instead of hanging even when it attaches afterwards.
    const settled = await Promise.race([
      new Promise((resolve) => pipeline(guard.body, new PassThrough(), (error) => resolve(error ?? null))),
      sleep(2_000).then(() => "timeout"),
    ]);
    assert.notEqual(settled, "timeout", "the pipeline must settle instead of hanging on an abandoned body");
    assert.equal(settled?.code, "ECONNRESET");
    assert.deepEqual(uncaught, [], "the guard owns its inner stream's error even before the runtime attaches");
  } finally {
    process.off("uncaughtException", onUncaught);
    guard.dispose();
    guard.body.destroy();
  }
});

// ---------------------------------------------------------------------------------------------
// HTTP: idle bound (instance 1: IDLE=1.5 s, MAX=60 s)
// ---------------------------------------------------------------------------------------------

test("idle: a stalled body answers 408 upload_idle_timeout, publishes nothing, marks the handle failed-retryable and frees both slots", async () => {
  const auth = await authFor(idleServer);
  const payload = Buffer.alloc(STALL_BYTES, 5);
  const hangs = [await startUpload(idleServer, auth, payload), await startUpload(idleServer, auth, payload)];

  // Both stalls are issued before either answers: with the per-credential cap of 2 they occupy both
  // slots, so the recovery PUT at the end can only succeed if the timeout path released them.
  const results = await Promise.all(
    hangs.map(({ structured }) => putStalled(idleServer, auth, structured.relativePath, { totalBytes: payload.length, head: payload.subarray(0, 1024) })),
  );

  for (const [index, result] of results.entries()) {
    const hang = hangs[index];
    assert.equal(result.status, 408, `stall ${index}: ${result.text}`);
    assert.equal(result.body?.code, "upload_idle_timeout");
    assert.equal(result.body?.error, "upload_idle_timeout");
    assert.ok(typeof result.body?.requestId === "string");

    // Nothing published: no Vault file, and the staged `.part` is a dead writer's residue.
    assert.equal(await vaultFile(idleRoot, hang.target), null, `stall ${index} must not publish`);
    const part = await stagingPart(idleRoot, hang.structured.uploadId);
    assert.ok(part && part.size > 0 && part.size < payload.length, "the partial body stays in staging as evidence");
    assert.match(part.size.toString(), /^\d+$/);

    const metadata = await readMetadata(idleRoot, hang.structured.uploadId);
    assert.equal(metadata.status, "failed-retryable", "a timeout is retryable, not terminal");
    assert.equal(typeof metadata.failedReason, "string");

    const event = assertTimeoutAudit(idleServer, hang.structured.uploadId, "upload_idle_timeout");
    assert.equal(event.bytes, payload.length);
    assert.equal(typeof event.durationMs, "number");
    assert.equal(event.digest, sha256(payload));
  }

  // The slot release: the same credential may start and publish another upload immediately.
  const recovered = await startUpload(idleServer, auth, payload, { target: `attachments/${randomUUID()}.bin` });
  const published = await putAll(idleServer, auth, recovered.structured.relativePath, payload);
  assert.equal(published.status, 201, `a released slot must accept the next PUT: ${published.text}`);
  assert.equal(published.body?.code, undefined);
  assert.ok((await vaultFile(idleRoot, recovered.target)).equals(payload));
});

// ---------------------------------------------------------------------------------------------
// HTTP: total-duration bound (instance 2: IDLE=60 s, MAX=1.5 s)
// ---------------------------------------------------------------------------------------------
test("duration: a body that keeps arriving but outstays its budget answers 408 upload_max_duration, publishes nothing and frees the slot", async () => {
  const auth = await authFor(durationServer);
  const payload = Buffer.alloc(STALL_BYTES, 9);
  const { structured, target } = await startUpload(durationServer, auth, payload);

  const result = await putTrickle(durationServer, auth, structured.relativePath, {
    totalBytes: payload.length,
    chunk: Buffer.alloc(TRICKLE_CHUNK_BYTES, 9),
  });
  assert.equal(result.status, 408, result.text);
  assert.equal(result.body?.code, "upload_max_duration");
  assert.ok(result.elapsedMs >= MAX_DURATION_MS, `must not fire before its budget: ${result.elapsedMs} ms`);
  assert.ok(result.elapsedMs < LONG_MS, "the duration bound must be the one that fired, not the idle bound");

  assert.equal(await vaultFile(durationRoot, target), null, "an over-long body must not publish");
  const part = await stagingPart(durationRoot, structured.uploadId);
  assert.ok(part && part.size > 0 && part.size < payload.length);

  const metadata = await readMetadata(durationRoot, structured.uploadId);
  assert.equal(metadata.status, "failed-retryable");

  const event = assertTimeoutAudit(durationServer, structured.uploadId, "upload_max_duration");
  assert.equal(event.bytes, payload.length);

  // Slot released: the same credential publishes a normal upload right away.
  const recovered = await startUpload(durationServer, auth, payload, { target: `attachments/${randomUUID()}.bin` });
  const published = await putAll(durationServer, auth, recovered.structured.relativePath, payload);
  assert.equal(published.status, 201, published.text);
  assert.ok((await vaultFile(durationRoot, recovered.target)).equals(payload));
});

test("a client that disconnects mid-body keeps the interruption path: deny audit, failed-retryable handle, released writer, no leaked handle", async () => {
  const auth = await authFor(idleServer);
  const payload = Buffer.alloc(STALL_BYTES, 6);
  // 12 aborts: with the guard swallowing the source's departure this leaked one `.part` write
  // handle and one writer-lock entry per cycle, so 12 makes the delta unmistakable.
  const cycles = 12;
  const aborted = [];
  const handlesBefore = openHandleCount(idleServer.child.pid);

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const started = await startUpload(idleServer, auth, payload);
    await abortMidBody(idleServer, auth, idleRoot, { structured: started.structured, totalBytes: payload.length, head: payload.subarray(0, 4096) });
    aborted.push(started);
  }

  // Collect every reading BEFORE asserting: a broken build must still print the whole picture
  // (status, audit lines, retry answers, handle delta) instead of stopping at the first fact.
  const uploadIds = aborted.map((hang) => hang.structured.uploadId);
  const metas = await waitForStatuses(idleRoot, uploadIds, "failed-retryable");
  const putEvents = auditEvents(idleServer);
  const readings = [];
  for (const [index, hang] of aborted.entries()) {
    const uploadId = hang.structured.uploadId;
    const metadata = metas[index] ?? {};
    const part = await stagingPart(idleRoot, uploadId);
    readings.push({
      index,
      uploadId: uploadId.slice(0, 8),
      status: metadata.status ?? null,
      failedReason: metadata.failedReason ?? null,
      writerTokenStillSet: Object.hasOwn(metadata, "writerToken"),
      published: (await vaultFile(idleRoot, hang.target)) !== null,
      partBytes: part?.size ?? null,
      putAudit: putEvents.filter((event) => event.uploadId === uploadId.slice(0, 8)),
      putAuditLines: putEvents.filter((event) => event.uploadId === uploadId.slice(0, 8)).length,
    });
  }

  // Retry the SAME handle: with the leak this answered 409 UPLOAD_IN_PROGRESS ("already has an
  // active writer") at first and still eight seconds later; on the interruption path it is 409
  // UPLOAD_FAILED, i.e. the writer lock is gone.
  const retries = [];
  for (const hang of aborted) {
    const retry = await putExpectingRejection(idleServer, auth, hang.structured.relativePath, payload);
    retries.push({ status: retry.status, code: retry.body?.code ?? null, message: String(retry.body?.message ?? retry.text).slice(0, 160) });
  }

  await sleep(1_500);
  const handlesAfter = openHandleCount(idleServer.child.pid);
  const delta = handlesBefore === null || handlesAfter === null ? null : handlesAfter - handlesBefore;
  console.log(`DIRECT_UPLOAD_ABORT=${JSON.stringify({ cycles, handlesBefore, handlesAfter, delta, readings, retries })}`);

  // 1) Every aborted handle leaves `uploading` for the retryable state the runtime already has for
  //    an interrupted body (this is what base did; "nothing happened" is not an acceptable answer).
  for (const [index, reading] of readings.entries()) {
    assert.equal(reading.status, "failed-retryable", `abort ${index}: the handle must not stay uploading`);
    assert.equal(reading.failedReason, "interrupted", `abort ${index}: the existing interruption reason`);
    assert.equal(reading.published, false, `abort ${index}: an interrupted body never publishes`);
    assert.ok(reading.partBytes > 0 && reading.partBytes < payload.length, `abort ${index}: the partial body stays as evidence (${reading.partBytes} B)`);
  }

  // 2) Exactly one put audit line per abort, and it is the pre-guard interruption line
  //    (`deny`/503/ECONNRESET) — never an `allow`, never a `timeout` for a socket nobody reads.
  for (const [index, reading] of readings.entries()) {
    assert.equal(reading.putAuditLines, 1, `abort ${index}: exactly one put audit line`);
    const [event] = reading.putAudit;
    assert.equal(event.operation, "put");
    assert.equal(event.decision, "deny", `abort ${index}: an interrupted body is a deny, not a timeout and not an allow`);
    assert.equal(event.code, "ECONNRESET");
    assert.equal(event.status, 503);
    assert.equal(event.bytes, payload.length);
  }

  // 3) The writer lock is gone: retrying the same handle answers UPLOAD_FAILED (the router's
  //    failed-retryable branch), never UPLOAD_IN_PROGRESS.
  for (const [index, retry] of retries.entries()) {
    assert.equal(retry.status, 409, `abort ${index} retry: ${retry.message}`);
    assert.notEqual(retry.code, "UPLOAD_IN_PROGRESS", `abort ${index}: the writer lock must be released: ${retry.message}`);
    assert.equal(retry.code, "UPLOAD_FAILED", `abort ${index} retry must land on the interruption path: ${retry.message}`);
  }

  // 4) No resource grows with the number of aborts: 12 cycles, delta 0 modulo one transient handle
  //    (the leak showed one `.part` write stream — and its promise graph — per cycle, i.e. delta 12).
  assert.notEqual(handlesBefore, null, "this assertion needs a handle/fd counter (Win32 or Linux)");
  assert.notEqual(handlesAfter, null, "this assertion needs a handle/fd counter (Win32 or Linux)");
  assert.ok(delta <= 1, `12 aborts must not leak a handle each (delta=${delta})`);

  // 5) The admission slot is free again for the same credential (unchanged behaviour).
  const recovered = await startUpload(idleServer, auth, payload, { target: `attachments/${randomUUID()}.bin` });
  const published = await putAll(idleServer, auth, recovered.structured.relativePath, payload);
  assert.equal(published.status, 201, published.text);
  assert.ok((await vaultFile(idleRoot, recovered.target)).equals(payload));
});

test("a client that disappears before its first body byte settles the same way, with no hanging handle", async () => {
  const auth = await authFor(idleServer);
  const payload = Buffer.alloc(STALL_BYTES, 8);
  const { structured, target } = await startUpload(idleServer, auth, payload);

  const req = requestTo(idleServer, auth, structured.relativePath, payload.length);
  req.on("error", () => {});
  req.flushHeaders();
  // Short of the 1.5 s idle bound, so this is a pure interruption and not the idle timer.
  await sleep(150);
  req.destroy();

  const [metadata] = await waitForStatuses(idleRoot, [structured.uploadId], "failed-retryable");
  assert.equal(metadata?.status, "failed-retryable", `a vanished client must not strand the handle: ${JSON.stringify(metadata)}`);
  assert.equal(metadata?.failedReason, "interrupted");
  assert.equal(await vaultFile(idleRoot, target), null);

  const events = auditEvents(idleServer).filter((event) => event.uploadId === structured.uploadId.slice(0, 8));
  assert.equal(events.length, 1, `exactly one put audit line, saw ${JSON.stringify(events)}`);
  assert.equal(events[0].decision, "deny");
  assert.equal(events[0].code, "ECONNRESET");
  assert.equal(events[0].status, 503);

  const retry = await putExpectingRejection(idleServer, auth, structured.relativePath, payload);
  assert.equal(retry.status, 409, retry.text);
  assert.notEqual(retry.body?.code, "UPLOAD_IN_PROGRESS", `the writer lock must be released: ${retry.text}`);
  assert.equal(retry.body?.code, "UPLOAD_FAILED", retry.text);
});

// ---------------------------------------------------------------------------------------------
// No false positives (instance 1: the same 1.5 s idle bound)
// ---------------------------------------------------------------------------------------------

test("no false positives: 0 B, 64 B and 1 MiB still publish 201 with the same short timeouts", async () => {
  const auth = await authFor(idleServer);
  const cases = [
    { label: "0 B", payload: Buffer.alloc(0) },
    { label: "64 B", payload: Buffer.alloc(64, 3) },
    { label: "1 MiB", payload: Buffer.alloc(MIB, 4) },
  ];
  for (const { label, payload } of cases) {
    const target = `attachments/${randomUUID()}.bin`;
    const started = await startUpload(idleServer, auth, payload, { target });
    const startedAt = Date.now();
    const published = await putAll(idleServer, auth, started.structured.relativePath, payload);
    const elapsed = Date.now() - startedAt;
    assert.equal(published.status, 201, `${label}: ${published.text}`);
    assert.equal(published.body?.size, payload.length);
    assert.equal(published.body?.sha256, sha256(payload));
    assert.ok((await vaultFile(idleRoot, target)).equals(payload), `${label}: the published bytes must match`);
    console.log(`DIRECT_UPLOAD_TIMEOUT_${label.replace(/\W+/g, "_")}_MS=${elapsed}`);
  }
});

test("no false positives: an MCP session and its standalone SSE stream outlive the /uploads idle timeout", async () => {
  const auth = await authFor(idleServer);
  const sse = await new Promise((resolve, reject) => {
    const url = new URL(`${idleServer.base}/mcp`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: { "X-API-Key": auth.key, Accept: "text/event-stream", "Mcp-Session-Id": auth.session },
    });
    const state = { status: null, contentType: null, closed: false, chunks: 0 };
    req.on("response", (res) => {
      state.status = res.statusCode;
      state.contentType = res.headers["content-type"] ?? null;
      res.setEncoding("utf8");
      res.on("data", () => { state.chunks += 1; });
      res.on("end", () => { state.closed = true; });
      res.on("error", () => { state.closed = true; });
      resolve({ req, state });
    });
    req.on("error", (error) => reject(error));
    req.end();
  });

  try {
    assert.equal(sse.state.status, 200, "the standalone MCP stream must open");
    assert.match(String(sse.state.contentType), /text\/event-stream/);
    // Hold the stream for more than twice the configured upload idle timeout.
    await sleep(IDLE_TIMEOUT_MS * 2 + 500);
    assert.equal(sse.state.closed, false, "a long-lived /mcp SSE stream must not be cut by the upload timeout");

    // The session behind that stream is still usable, and no 408 was ever produced for /mcp.
    const alive = await callTool(idleServer.base, auth, auth.session, "server_info", {});
    assert.equal(alive.status, 200, alive.text);
    assert.ok(!alive.text.includes("upload_idle_timeout"));
    const log = idleServer.output.join("");
    assert.ok(!log.includes("requestTimeout"), "no global timeout knob may appear in the wiring");
    assert.ok(!/\[direct-upload\].*\/mcp/.test(log), "the timeout never touches /mcp");
  } finally {
    sse.req.destroy();
  }
});
