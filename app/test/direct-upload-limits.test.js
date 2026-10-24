// Issue #470 follow-up — task A: `/uploads/` admission control.
//
// Contract: `scratch/briefs/rate-limit-470-BRIEF.md` §1 and §4. The state machine is unit-tested
// with an injected clock/stub `statfs`; the HTTP half runs against the real `server.js` on an
// ephemeral port with an isolated DATA_PATH/VAULT_PATH, because the three gates must sit in the
// real middleware/router order (and before the first body byte) to be worth anything.
//
// Env is deliberately not the production default: the suite needs to reach the limit quickly and
// to exercise the global cap with three credentials. Every assertion names the configured value.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";

import { checkDiskHeadroom, createDirectUploadLimiter } from "../src/direct-upload-limits.js";
import {
  API_KEY,
  callTool,
  createManagedApiKey,
  freePort,
  initialize,
  seedVault,
  serverEnv,
  startServer,
  stopChild,
} from "./helpers/server-spawn-fixtures.js";

const PAYLOAD = Buffer.alloc(64, 7);
const HANG_BYTES = 65_536;
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RATE_PER_MINUTE = 12;
const MAX_PER_CREDENTIAL = 2;
const MAX_GLOBAL = 3;

let root;
let server;
let base;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-limits-"));
  await seedVault(root);
  const port = await freePort();
  server = await startServer(serverEnv({
    port,
    root,
    extra: {
      WEB_CATALOG_DIR: path.join(root, "web-catalog"),
      DIRECT_UPLOAD_RATE_PER_MINUTE: String(RATE_PER_MINUTE),
      DIRECT_UPLOAD_MAX_CONCURRENT_PER_CREDENTIAL: String(MAX_PER_CREDENTIAL),
      DIRECT_UPLOAD_MAX_CONCURRENT_GLOBAL: String(MAX_GLOBAL),
      // The disk gate has its own isolated instance below; this one must not depend on host free space.
      DIRECT_UPLOAD_MIN_FREE_BYTES: "0",
    },
  }));
  base = server.base;
});

after(async () => {
  await stopChild(server?.child);
  await fs.rm(root, { recursive: true, force: true });
});

function auditEvents(output = server.output.join("")) {
  return output.split(/\r?\n/)
    .filter((line) => line.startsWith("[direct-upload] "))
    .map((line) => JSON.parse(line.slice("[direct-upload] ".length)));
}

async function credential({ session = true } = {}) {
  const created = await createManagedApiKey(base, {
    scopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
    vault: "default",
    label: `limits ${randomUUID().slice(0, 8)}`,
  });
  const auth = { key: created.key };
  if (session) auth.session = (await initialize(base, { key: created.key })).session;
  return auth;
}

async function startUpload(auth, { target = `attachments/${randomUUID()}.bin`, payload = PAYLOAD } = {}) {
  const response = await callTool(base, auth, auth.session, "start_direct_upload", {
    path: target, totalBytes: payload.length, sha256: sha256(payload), overwrite: false,
  });
  const structured = response.payload?.result?.structuredContent ?? {};
  assert.ok(structured.uploadId, `control plane failed: ${JSON.stringify(response.payload)}`);
  return { structured, target };
}

function put(relativePath, body, auth) {
  return fetch(`${base}${relativePath}`, {
    method: "PUT",
    headers: { "X-API-Key": auth.key, "Content-Type": "application/octet-stream" },
    body,
  });
}

async function publish(auth, options = {}) {
  const { structured, target } = await startUpload(auth, options);
  const response = await put(structured.relativePath, options.payload ?? PAYLOAD, auth);
  return { response, body: await response.json(), structured, target };
}

/**
 * A PUT that sends a partial body and then stalls: the server has passed admission and is inside
 * the stream, so the in-flight counter is genuinely held until the socket dies.
 */
async function hangingPut(auth, payload) {
  const { structured, target } = await startUpload(auth, { payload });
  const url = new URL(`${base}${structured.relativePath}`);
  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "PUT",
    headers: {
      "X-API-Key": auth.key,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(payload.length),
    },
  });
  const settled = new Promise((resolve) => {
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", (error) => resolve({ status: 0, error: error.code || error.message }));
  });
  req.write(payload.subarray(0, 1024));
  // Admission and the streaming writer are both asynchronous on the server side. The `.part` file
  // appearing with bytes proves the request passed admission and holds its in-flight slot, which is
  // the precondition for the 429 probes; polling it consumes no rate budget.
  const partPath = path.join(root, "data", "transfers", "uploads", `${structured.uploadId}.part`);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const stat = await fs.stat(partPath).catch(() => null);
    if (stat && stat.size > 0) return { req, settled, structured, target };
    await sleep(10);
  }
  throw new Error("the hanging PUT never reached the staging writer");
}

// ---------------------------------------------------------------------------------------------
// Unit: the limiter state machine (injected clock, no HTTP)
// ---------------------------------------------------------------------------------------------

test("limiter: the budget bursts, the next request is limited with an exact integer Retry-After, and the bucket refills", () => {
  let now = 0;
  const limiter = createDirectUploadLimiter({ ratePerMinute: 6, now: () => now });
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    assert.equal(limiter.rateLimit("credential-a").allowed, true, `burst request ${attempt} must pass`);
  }
  const seventh = limiter.rateLimit("credential-a");
  assert.equal(seventh.allowed, false);
  assert.equal(seventh.retryAfterSeconds, 10, "one token refills after 60/6 s");

  // Another credential is untouched by the first one's exhaustion.
  assert.equal(limiter.rateLimit("credential-b").allowed, true);

  now += 9_500;
  assert.equal(limiter.rateLimit("credential-a").allowed, false, "9.5 s is still short of one token");
  now += 1_000;
  assert.equal(limiter.rateLimit("credential-a").allowed, true, "the refilled token is usable");
});

test("limiter: per-credential and global in-flight caps, and release is idempotent", () => {
  const limiter = createDirectUploadLimiter({ maxConcurrentPerCredential: 2, maxConcurrentGlobal: 3 });
  const first = limiter.acquire("a");
  const second = limiter.acquire("a");
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);

  const third = limiter.acquire("a");
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "credential");

  assert.equal(limiter.acquire("b").allowed, true, "another credential still fits the global cap");
  const global = limiter.acquire("c");
  assert.equal(global.allowed, false);
  assert.equal(global.reason, "global");

  first.release();
  first.release(); // idempotent: a double release must not corrupt the counter
  assert.equal(limiter.snapshot().inflightTotal, 2);
  assert.equal(limiter.acquire("c").allowed, true);
});

test("disk gate: a measured shortage refuses, an unreadable filesystem fails open as unknown, 0 disables", async () => {
  const shortage = await checkDiskHeadroom({ dir: "/staging", minFreeBytes: 100, statfs: async () => ({ bavail: 1, bsize: 50 }) });
  assert.deepEqual(shortage, { ok: false, checked: true, unknown: false, freeBytes: 50 });
  const enough = await checkDiskHeadroom({ dir: "/staging", minFreeBytes: 100, statfs: async () => ({ bavail: 3, bsize: 50 }) });
  assert.deepEqual(enough, { ok: true, checked: true, unknown: false, freeBytes: 150 });
  const unreadable = await checkDiskHeadroom({ dir: "/staging", minFreeBytes: 100, statfs: async () => { throw Object.assign(new Error("ENOSYS"), { code: "ENOSYS" }); } });
  assert.deepEqual(unreadable, { ok: true, checked: true, unknown: true, freeBytes: null });
  const disabled = await checkDiskHeadroom({ dir: "/staging", minFreeBytes: 0, statfs: async () => { throw new Error("must not be called"); } });
  assert.deepEqual(disabled, { ok: true, checked: false, unknown: false, freeBytes: null });
});

test("an authenticated caller without a credential id falls back to the peer address and the audit says so", async () => {
  const { createDirectUploadRouter, DIRECT_UPLOAD_SCOPES } = await import("../src/direct-upload.js");
  const keys = [];
  const limiter = {
    rateLimit(key) { keys.push(key); return { allowed: false, retryAfterSeconds: 3 }; },
    acquire() { throw new Error("a rate-limited request must never claim a concurrency slot"); },
  };
  const app = express();
  app.use(createDirectUploadRouter({
    auth: (req, _res, next) => {
      // Deliberately no keyId/clientId/userId: the router has nothing but the socket to key on.
      req.auth = { type: "test", scopes: [...DIRECT_UPLOAD_SCOPES], allowedVaults: ["default"] };
      next();
    },
    limiter,
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
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/uploads/${randomUUID()}`, { method: "PUT", headers: { "Content-Length": "0" } });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "3");
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^ip:127\.0\.0\.1$/, "the fallback key is the peer address, never a shared bucket");
    const event = lines.map((line) => JSON.parse(line.slice("[direct-upload] ".length))).find((item) => item.decision === "limited");
    assert.ok(event, "the limited request must be audited");
    assert.equal(event.credentialSource, "ip");
    assert.equal(event.credentialId, null);
    assert.equal(event.limit, "rate");
    assert.equal(event.retryAfterSeconds, 3);
  } finally {
    console.log = originalLog;
    listener.closeAllConnections?.();
    await new Promise((resolve) => listener.close(resolve));
  }
});

// ---------------------------------------------------------------------------------------------
// HTTP: rate + concurrency against the real server
// ---------------------------------------------------------------------------------------------

test(`rate: ${RATE_PER_MINUTE + 1}th PUT answers 429 with Retry-After, another credential is untouched, and the bucket refills`, async () => {
  const auth = { key: API_KEY, session: (await initialize(base, { key: API_KEY })).session };
  for (let attempt = 1; attempt <= RATE_PER_MINUTE; attempt += 1) {
    const { response, body } = await publish(auth);
    assert.equal(response.status, 201, `request ${attempt}/${RATE_PER_MINUTE} must publish: ${JSON.stringify(body)}`);
  }

  const { structured } = await startUpload(auth);
  const limited = await put(structured.relativePath, PAYLOAD, auth);
  const limitedBody = await limited.json();
  assert.equal(limited.status, 429);
  assert.equal(limitedBody.code, "rate_limited");
  const retryAfter = Number(limited.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After must be a positive integer second, got ${limited.headers.get("retry-after")}`);
  assert.equal(limitedBody.retryAfterSeconds, retryAfter);

  const limitedEvent = auditEvents().filter((event) => event.decision === "limited").at(-1);
  assert.equal(limitedEvent.limit, "rate");
  assert.equal(limitedEvent.status, 429);
  assert.equal(limitedEvent.code, "rate_limited");
  assert.equal(limitedEvent.retryAfterSeconds, retryAfter);
  assert.ok(limitedEvent.credentialId, "the audit keeps the credential id but no token");
  assert.equal("credentialSource" in limitedEvent, false);

  // A second credential has its own bucket and publishes immediately.
  const other = await credential();
  const { response: otherResponse } = await publish(other);
  assert.equal(otherResponse.status, 201, "a different credential must not inherit the exhausted bucket");

  // Wait out the Retry-After (plus a hair) and the same credential publishes again.
  await sleep(retryAfter * 1000 + 400);
  const { response: recovered, body: recoveredBody } = await publish(auth);
  assert.equal(recovered.status, 201, JSON.stringify(recoveredBody));
});

test("concurrency: the per-credential and global caps answer 429, and an aborted client releases its slot", async () => {
  const c = await credential();
  const d = await credential();
  const e = await credential();
  const hangPayload = Buffer.alloc(HANG_BYTES, 3);

  const hangs = [];
  try {
    hangs.push(await hangingPut(c, hangPayload));
    hangs.push(await hangingPut(c, hangPayload));
    // Both C slots are in flight; the third request (even for an unknown handle) is limited before lookup.
    const credentialLimited = await put(`/uploads/${randomUUID()}`, Buffer.alloc(0), c);
    assert.equal(credentialLimited.status, 429);
    assert.equal((await credentialLimited.json()).code, "rate_limited");

    hangs.push(await hangingPut(d, hangPayload));
    const globalLimited = await put(`/uploads/${randomUUID()}`, Buffer.alloc(0), e);
    assert.equal(globalLimited.status, 429, "the global cap of 3 must refuse the fourth in-flight PUT");
    assert.equal((await globalLimited.json()).code, "rate_limited");

    const events = auditEvents().filter((event) => event.decision === "limited");
    const concurrency = events.filter((event) => event.limit === "concurrency");
    assert.ok(concurrency.length >= 2, "both refusals must be audited as concurrency limits");
    assert.ok(concurrency.every((event) => event.code === "concurrency_limited" && Number.isInteger(event.retryAfterSeconds)));
  } finally {
    for (const hang of hangs) hang.req.destroy();
  }

  // The destroyed clients must release their slots; retry briefly because teardown is asynchronous.
  // A still-held slot answers 429 (not a different error), so 429 is the only status worth retrying.
  let recovered = null;
  for (let attempt = 0; attempt < 40 && !recovered; attempt += 1) {
    const { response, body, target } = await publish(e);
    if (response.status === 201) {
      recovered = { target };
      assert.ok(body.sha256);
      break;
    }
    assert.equal(response.status, 429, `a leaked slot answers 429; got ${response.status}: ${JSON.stringify(body)}`);
    await sleep(100);
  }
  assert.ok(recovered, "an aborted PUT must release its in-flight slot");
  assert.ok((await fs.readFile(path.join(root, "vault", ...recovered.target.split("/")))).equals(PAYLOAD));
});

// ---------------------------------------------------------------------------------------------
// HTTP: staging-disk gate (own instance: the threshold must be both failing and recovering)
// ---------------------------------------------------------------------------------------------

test("disk: a measured shortage answers 507 before the body, and clearing the threshold publishes", async () => {
  const diskRoot = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-disk-"));
  await seedVault(diskRoot);
  const port = await freePort();
  const env = serverEnv({
    port,
    root: diskRoot,
    extra: {
      WEB_CATALOG_DIR: path.join(diskRoot, "web-catalog"),
      DIRECT_UPLOAD_RATE_PER_MINUTE: "600",
      // Larger than any real staging disk, so the gate cannot pass by luck.
      DIRECT_UPLOAD_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER),
    },
  });
  let current = await startServer(env);
  try {
    const session = (await initialize(current.base, { key: API_KEY })).session;
    const auth = { key: API_KEY, session };
    const target = `attachments/${randomUUID()}.bin`;
    const started = await callTool(current.base, auth, session, "start_direct_upload", {
      path: target, totalBytes: PAYLOAD.length, sha256: sha256(PAYLOAD), overwrite: false,
    });
    const structured = started.payload?.result?.structuredContent ?? {};
    assert.ok(structured.uploadId, JSON.stringify(started.payload));

    const blocked = await fetch(`${current.base}${structured.relativePath}`, {
      method: "PUT", headers: { "X-API-Key": API_KEY, "Content-Type": "application/octet-stream" }, body: PAYLOAD,
    });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 507);
    assert.equal(blockedBody.code, "insufficient_storage");
    const blockedEvent = auditEvents(current.output.join("")).filter((event) => event.code === "insufficient_storage").at(-1);
    assert.ok(blockedEvent, "the 507 must be audited");
    assert.equal(blockedEvent.freeBytesUnknown, undefined, "a measured shortage must not claim unknown headroom");
    assert.equal(typeof blockedEvent.freeBytes, "number");
    await assert.rejects(fs.readFile(path.join(diskRoot, "vault", ...target.split("/"))), /ENOENT/);

    await stopChild(current.child);
    current = await startServer({ ...env, DIRECT_UPLOAD_MIN_FREE_BYTES: "0" });

    const published = await fetch(`${current.base}${structured.relativePath}`, {
      method: "PUT", headers: { "X-API-Key": API_KEY, "Content-Type": "application/octet-stream" }, body: PAYLOAD,
    });
    const publishedBody = await published.json();
    assert.equal(published.status, 201, JSON.stringify(publishedBody));
    assert.ok((await fs.readFile(path.join(diskRoot, "vault", ...target.split("/")))).equals(PAYLOAD));
  } finally {
    await stopChild(current.child);
    await fs.rm(diskRoot, { recursive: true, force: true });
  }
});
