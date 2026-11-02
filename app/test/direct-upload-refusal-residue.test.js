// Issue #725 — an admission refusal leaves no handle and no 0-byte `.part` behind.
//
// What was wrong: the handle of a direct upload is created by the CONTROL plane
// (`start_direct_upload`), which writes `<uploadId>.json` plus an empty `.part`. When the data
// plane then refused the `PUT` (rate `429`, in-flight `429`, staging disk `507`) the handle stayed
// on the staging disk with zero bytes until the 24 h TTL sweep collected it. One empty shell per
// refusal: the release seat's probe read 15 unowned `.part` files instead of 14 and had to clean up
// with `cancel_file_upload`, and every refusal inflated the staging directory's file count (plus the
// TTL sweep's `scanned`/`removed` bookkeeping — NOT `/healthz`'s `orphanParts`, which skips a
// `.part` that still has its `.json`, i.e. exactly these shells).
//
// What is asserted here, against the real `server.js` on an ephemeral port with an isolated
// DATA_PATH/VAULT_PATH:
//   1. rate gate: six PUTs against a two-per-minute budget → two `201`, four `429`, and the file
//      count in `data/transfers/uploads` is IDENTICAL before and after every refusal;
//   2. in-flight gate: a refused PUT reclaims its own fresh handle, while the handle another
//      request is actively streaming into keeps its bytes and its metadata;
//   3. staging-disk gate: a `507` leaves nothing either;
//   4. the guard matrix of the reclaimer itself (written handle, claimed part, busy writer lock).
// The negative control lives outside the suite: reverting the reclamation makes (1) fail with a
// growing file count (see `scratch/fix-725/NOTES.md`).

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { discardUnwrittenUpload } from "../src/direct-upload-limits.js";
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ctxs = [];
const roots = [];

async function boot(name, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `direct-upload-${name}-`));
  roots.push(root);
  await seedVault(root);
  const port = await freePort();
  const server = await startServer(serverEnv({
    port,
    root,
    extra: {
      WEB_CATALOG_DIR: path.join(root, "web-catalog"),
      DIRECT_UPLOAD_MIN_FREE_BYTES: "0",
      DIRECT_UPLOAD_IDLE_TIMEOUT_MS: "60000",
      DIRECT_UPLOAD_MAX_DURATION_MS: "240000",
      ...extra,
    },
  }));
  ctxs.push(server.child);
  const session = (await initialize(server.base, { key: API_KEY })).session;
  return { base: server.base, server, session, root };
}

after(async () => {
  await Promise.all(ctxs.map((child) => stopChild(child)));
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

function uploadsRoot(ctx) {
  return path.join(ctx.root, "data", "transfers", "uploads");
}

/** `{ json, part, names }` snapshot of the staging directory — the number #725 is about. */
async function handleCounts(ctx) {
  const names = await fs.readdir(uploadsRoot(ctx)).catch(() => []);
  const json = names.filter((name) => name.endsWith(".json")).length;
  const part = names.filter((name) => name.endsWith(".part")).length;
  return { json, part, names: names.sort() };
}

function auditEvents(ctx) {
  return ctx.server.output.join("").split(/\r?\n/)
    .filter((line) => line.startsWith("[direct-upload] "))
    .map((line) => JSON.parse(line.slice("[direct-upload] ".length)));
}

async function startUpload(ctx, { payload, target = `attachments/${randomUUID()}.bin` } = {}) {
  const response = await callTool(ctx.base, { key: API_KEY }, ctx.session, "start_direct_upload", {
    path: target, totalBytes: payload.length, sha256: sha256(payload), overwrite: false,
  });
  const structured = response.payload?.result?.structuredContent ?? {};
  assert.ok(structured.uploadId, `the control plane failed: ${JSON.stringify(response.payload)}`);
  return structured;
}

async function put(ctx, relativePath, payload) {
  const response = await fetch(`${ctx.base}${relativePath}`, {
    method: "PUT",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/octet-stream", "Content-Length": String(payload.length) },
    body: payload,
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/**
 * A PUT that sends part of its body and then stalls: the server has passed admission and is inside
 * the stream, so the in-flight slot is genuinely held and the handle's `.part` really has bytes.
 */
async function hangingPut(ctx, payload) {
  const structured = await startUpload(ctx, { payload });
  const url = new URL(`${ctx.base}${structured.relativePath}`);
  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "PUT",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/octet-stream", "Content-Length": String(payload.length) },
  });
  const settled = new Promise((resolve) => {
    req.on("response", (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", () => resolve(0));
  });
  req.write(payload.subarray(0, 1024));
  const partPath = path.join(uploadsRoot(ctx), `${structured.uploadId}.part`);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const stat = await fs.stat(partPath).catch(() => null);
    if (stat && stat.size > 0) return { req, settled, structured, partPath };
    await sleep(10);
  }
  throw new Error("the hanging PUT never reached the staging writer");
}

// ---------------------------------------------------------------------------------------------
// 1. Rate gate — the defect issue #725 was opened for
// ---------------------------------------------------------------------------------------------

test("rate: four refusals against a two-per-minute budget add no metadata and no .part", async () => {
  const ctx = await boot("no-residue-rate", { DIRECT_UPLOAD_RATE_PER_MINUTE: "2" });
  const payload = Buffer.alloc(64, 9);
  const readings = [];
  let published = 0;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    // Baseline taken BEFORE the control plane creates the handle: the assertion #725 asks for is
    // "the refused PUT did not change this number", not "the handle still exists".
    const baseline = await handleCounts(ctx);
    const structured = await startUpload(ctx, { payload });
    const afterStart = await handleCounts(ctx);
    assert.deepEqual(
      { json: afterStart.json, part: afterStart.part },
      { json: baseline.json + 1, part: baseline.part + 1 },
      "precondition: the control plane writes the metadata and the 0-byte .part before the PUT",
    );
    const { status, headers, body } = await put(ctx, structured.relativePath, payload);
    const afterCounts = await handleCounts(ctx);

    if (status === 201) {
      published += 1;
      readings.push({ attempt, status, json: afterCounts.json, part: afterCounts.part });
      continue;
    }

    assert.equal(status, 429, `attempt ${attempt} must be refused: ${JSON.stringify(body)}`);
    assert.equal(body.code, "rate_limited");
    assert.ok(Number.isInteger(body.retryAfterSeconds) && body.retryAfterSeconds >= 1, `Retry-After must be an integer second, got ${JSON.stringify(body)}`);
    assert.equal(Number(headers.get("retry-after")), body.retryAfterSeconds);
    // The refusal names what it reclaimed, so a client knows to start a new handle.
    assert.equal(body.handleDiscarded, true, `the refused handle must be reclaimed: ${JSON.stringify(body)}`);
    assert.equal(body.restartRequired, true);
    // The measurement §725 asks for: the staging directory is byte-for-byte the same list.
    assert.deepEqual(afterCounts, baseline, `attempt ${attempt}: a refused PUT changed the staging directory`);
    readings.push({ attempt, status, retryAfterSeconds: body.retryAfterSeconds, baseline: { json: baseline.json, part: baseline.part }, after: { json: afterCounts.json, part: afterCounts.part } });
  }

  assert.equal(published, 2, `the two-token burst must publish exactly two uploads: ${JSON.stringify(readings)}`);
  console.log(`#725 rate readings: ${JSON.stringify(readings)}`);

  // The audit line keeps its #470 shape and gains only the additive `handleDiscarded`.
  const limited = auditEvents(ctx).filter((event) => event.decision === "limited");
  assert.equal(limited.length, 4, `every refusal must be audited: ${JSON.stringify(limited)}`);
  for (const event of limited) {
    assert.equal(event.operation, "put");
    assert.equal(event.status, 429);
    assert.equal(event.limit, "rate");
    assert.equal(event.code, "rate_limited");
    assert.ok(Number.isInteger(event.retryAfterSeconds) && event.retryAfterSeconds >= 1);
    assert.match(event.uploadId, /^[0-9a-f]{8}$/);
    assert.equal(event.handleDiscarded, true);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. In-flight gate — reclaims its own handle, never the one being streamed
// ---------------------------------------------------------------------------------------------

test("concurrency: a refused PUT reclaims its own handle and leaves a part in use alone", async () => {
  const ctx = await boot("no-residue-concurrency", {
    DIRECT_UPLOAD_MAX_CONCURRENT_PER_CREDENTIAL: "1",
    DIRECT_UPLOAD_RATE_PER_MINUTE: "10",
  });
  const payload = Buffer.alloc(64 * 1024, 3);
  const hang = await hangingPut(ctx, payload);
  try {
    // (a) a fresh handle refused by the cap: nothing may be left behind.
    const baseline = await handleCounts(ctx);
    const fresh = await startUpload(ctx, { payload });
    const refused = await put(ctx, fresh.relativePath, payload);
    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.equal(refused.body.handleDiscarded, true);
    assert.deepEqual(await handleCounts(ctx), baseline, "the concurrency refusal left a handle behind");

    // (b) the handle that is being streamed RIGHT NOW: same refusal, but its bytes and metadata
    // must survive — `uploadedBytes` is still 0 while the body flows, so the guard is the writer
    // lock plus the non-empty `.part`, not the metadata counter.
    const beforeBusy = await handleCounts(ctx);
    const busy = await put(ctx, hang.structured.relativePath, payload);
    assert.equal(busy.status, 429, JSON.stringify(busy.body));
    assert.equal(busy.body.handleDiscarded, undefined, "a handle with a live writer must not be reclaimed");
    assert.deepEqual(await handleCounts(ctx), beforeBusy, "the in-use handle's files changed");
    const staged = await fs.stat(hang.partPath);
    assert.ok(staged.size > 0, `the in-use .part must keep its bytes, saw ${staged.size}`);
    const metadata = JSON.parse(await fs.readFile(path.join(uploadsRoot(ctx), `${hang.structured.uploadId}.json`), "utf8"));
    assert.equal(metadata.status, "uploading");
    assert.ok(metadata.writerToken, "the live writer keeps its token as evidence");

    const limited = auditEvents(ctx).filter((event) => event.decision === "limited");
    assert.equal(limited.length, 2);
    assert.ok(limited.every((event) => event.limit === "concurrency" && event.code === "concurrency_limited"));
    assert.deepEqual(limited.map((event) => event.handleDiscarded === true), [true, false]);
  } finally {
    hang.req.destroy();
    await hang.settled;
  }
});

// ---------------------------------------------------------------------------------------------
// 3. Staging-disk gate — a 507 is admission too
// ---------------------------------------------------------------------------------------------

test("disk: a 507 refusal leaves no metadata and no .part", async () => {
  const ctx = await boot("no-residue-disk", { DIRECT_UPLOAD_MIN_FREE_BYTES: String(2 ** 50) });
  const payload = Buffer.alloc(64, 5);
  const baseline = await handleCounts(ctx);
  const structured = await startUpload(ctx, { payload });
  const { status, body } = await put(ctx, structured.relativePath, payload);
  assert.equal(status, 507, JSON.stringify(body));
  assert.equal(body.code, "insufficient_storage");
  assert.equal(body.handleDiscarded, true);
  assert.equal(body.restartRequired, true);
  const afterCounts = await handleCounts(ctx);
  assert.deepEqual(afterCounts, baseline, "the disk refusal left a handle behind");
  assert.ok(!afterCounts.names.some((name) => name.startsWith(structured.uploadId)));

  const deny = auditEvents(ctx).filter((event) => event.decision === "deny" && event.code === "insufficient_storage");
  assert.equal(deny.length, 1);
  assert.equal(deny[0].handleDiscarded, true);
});

// ---------------------------------------------------------------------------------------------
// 4. The reclaimer's guard matrix (unit, no server)
// ---------------------------------------------------------------------------------------------

test("discardUnwrittenUpload: only an unwritten, unclaimed, unlocked single-put handle is removed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-discard-"));
  try {
    async function handle(name, metadata, partBytes = 0) {
      const dir = path.join(root, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "u.json"), `${JSON.stringify(metadata)}\n`, "utf8");
      await fs.writeFile(path.join(dir, "u.part"), Buffer.alloc(partBytes, 1));
      let lockFree = true;
      return {
        dir,
        call: () => discardUnwrittenUpload({
          uploadsRoot: dir,
          uploadId: "u",
          mode: "single-put",
          acquire: () => {
            if (!lockFree) return null;
            lockFree = false;
            return () => { lockFree = true; };
          },
          readMetadata: async () => metadata,
        }),
        files: async () => (await fs.readdir(dir)).sort(),
        setLockFree: (value) => { lockFree = value; },
      };
    }
    const unwritten = { mode: "single-put", status: "uploading", uploadedBytes: 0 };

    const plain = await handle("plain", unwritten);
    assert.deepEqual(await plain.call(), { discarded: true, reason: "unwritten" });
    assert.deepEqual(await plain.files(), [], "the .part goes before the metadata");

    const claimed = await handle("claimed", { ...unwritten, writerToken: randomUUID() }, 4);
    assert.deepEqual(await claimed.call(), { discarded: false, reason: "writer_claimed" });
    assert.deepEqual(await claimed.files(), ["u.json", "u.part"]);

    const torn = await handle("torn", unwritten, 4);
    assert.deepEqual(await torn.call(), { discarded: false, reason: "part_not_empty" });
    assert.deepEqual(await torn.files(), ["u.json", "u.part"]);

    const written = await handle("written", { ...unwritten, uploadedBytes: 8 }, 8);
    assert.deepEqual(await written.call(), { discarded: false, reason: "bytes" });

    const complete = await handle("complete", { ...unwritten, status: "complete" });
    assert.deepEqual(await complete.call(), { discarded: false, reason: "status" });

    const otherMode = await handle("other-mode", { ...unwritten, mode: "chunk" });
    assert.deepEqual(await otherMode.call(), { discarded: false, reason: "mode" });

    const busy = await handle("busy", unwritten);
    busy.setLockFree(false);
    assert.deepEqual(await busy.call(), { discarded: false, reason: "writer_active" });
    assert.deepEqual(await busy.files(), ["u.json", "u.part"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
