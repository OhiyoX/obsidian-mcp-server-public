// Review 6.4 (audit-sink REVIEW §6.4) — "an expired handle that could not be deleted must still
// leave a trace", plus R1 (`receiptId` in the discovery contract).
//
// The defect this file pins: the sweep used to unlink `<uploadId>.json` FIRST and `<uploadId>.part`
// SECOND. When the second unlink failed, the metadata (the only attributable handle state) was gone,
// NO audit line was written even though `failures` moved, and the leftover `.part` stopped being
// counted as an orphan because the sweep-time snapshot still listed the metadata. The order is now
// `.part` first, the metadata is KEPT when the bytes cannot go (so the next start retries the handle),
// and every "touched it but could not finish" outcome writes its own audit line:
//
//   sweep_part_removal_failed     — the bytes are still there, the handle is retryable
//   sweep_metadata_removal_failed — only the metadata is left
//
// `upload_expired` keeps meaning "removed"; the failure codes are never reused for it.
//
// Instance isolation: every test gets its own DATA_PATH under `S64_ROOT` when that variable is set
// (the review lane points it at `scratch/s64-r1/roots`), otherwise in the OS temp dir, plus an
// ephemeral port — same pattern as `direct-upload-audit-file.test.js`.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { sweepExpiredUploads } from "../src/direct-upload-housekeeping.js";
import {
  API_KEY,
  callTool,
  freePort,
  initialize,
  listTools,
  serverEnv,
  seedVault,
  startServer,
  stopChild,
} from "./helpers/server-spawn-fixtures.js";

const children = [];
const roots = [];
const ROOT_BASE = process.env.S64_ROOT || os.tmpdir();

after(async () => {
  await Promise.all(children.map((child) => stopChild(child)));
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

const auditDayKey = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

async function freshRoot(name) {
  await fs.mkdir(ROOT_BASE, { recursive: true });
  const root = await fs.mkdtemp(path.join(ROOT_BASE, `sweep-trace-${name}-`));
  roots.push(root);
  await seedVault(root);
  return root;
}

async function boot(root, extra = {}) {
  const port = await freePort();
  const server = await startServer(serverEnv({
    port,
    root,
    extra: {
      WEB_CATALOG_DIR: path.join(root, "web-catalog"),
      DIRECT_UPLOAD_MIN_FREE_BYTES: "0",
      ...extra,
    },
  }));
  children.push(server.child);
  const init = await initialize(server.base, { key: API_KEY });
  assert.equal(init.status, 200);
  return { server, base: server.base, session: init.session, output: server.output };
}

async function startUpload(ctx, payload, target = `attachments/${randomUUID()}.bin`) {
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const response = await callTool(ctx.base, { key: API_KEY }, ctx.session, "start_direct_upload", {
    path: target, totalBytes: payload.length, sha256,
  });
  const structured = response.payload?.result?.structuredContent;
  assert.ok(structured?.uploadId, `start_direct_upload failed: ${JSON.stringify(response.payload)}`);
  return { ...structured, sha256, target };
}

function put(base, relativePath, body) {
  return fetch(`${base}${relativePath}`, {
    method: "PUT",
    headers: { "X-API-Key": API_KEY },
    body,
  });
}

async function health(base) {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  return response.json();
}

/** Today's audit file must exist and parse; the sweep asserts on what reached it. */
async function auditLines(root) {
  const file = path.join(root, "data", "audit", `${auditDayKey()}.jsonl`);
  const text = await fs.readFile(file, "utf8");
  assert.equal(text.endsWith("\n"), true, "the audit file must end with a newline");
  return text.trimEnd().split("\n").map((line) => JSON.parse(line));
}

const stdoutAuditLines = (output) => output.join("").split("\n")
  .filter((line) => line.startsWith("[direct-upload] "))
  .map((line) => JSON.parse(line.slice("[direct-upload] ".length)));

async function exists(file) {
  return fs.stat(file).then(() => true, () => false);
}

async function typeOf(file) {
  return fs.stat(file).then((stat) => (stat.isDirectory() ? "directory" : "file"), () => "missing");
}

// ---------------------------------------------------------------------------------------------
// 1. The brief's main case: the `.part` cannot be deleted (a directory sits where it should be — the
//    cross-platform construction the review itself used, EISDIR on POSIX / EPERM on Windows).
// ---------------------------------------------------------------------------------------------
test("sweep: a .part that cannot be deleted KEEPS the metadata, writes sweep_part_removal_failed and is retried next start", async () => {
  const root = await freshRoot("part-blocked");
  // TTL of 1 ms: the handle is expired the moment it is created, so the NEXT process start sweeps it.
  const first = await boot(root, { DIRECT_UPLOAD_TTL_MS: "1" });
  const handle = await startUpload(first, Buffer.alloc(256, 5));

  const uploadsRoot = path.join(root, "data", "transfers", "uploads");
  const metadataPath = path.join(uploadsRoot, `${handle.uploadId}.json`);
  const partPath = path.join(uploadsRoot, `${handle.uploadId}.part`);
  assert.equal(await typeOf(metadataPath), "file");
  assert.equal(await typeOf(partPath), "file");

  await stopChild(first.server.child);

  // Occupy the `.part` path with a directory: `fs.rm(x, { force: true })` without `recursive` fails on
  // both platforms, which is exactly the "bytes cannot go" branch, with no permission-bit portability.
  await fs.rm(partPath);
  await fs.mkdir(partPath);

  const second = await boot(root, {});
  assert.equal(await exists(metadataPath), true, "the metadata must be KEPT so the next start can retry the handle");
  assert.equal(await typeOf(partPath), "directory", "the undeletable .part is still there");

  const lines = await auditLines(root);
  const sweepLines = lines.filter((line) => line.operation === "expired-sweep");
  assert.equal(sweepLines.length, 1, `exactly one sweep line expected, got ${JSON.stringify(sweepLines)}`);
  const line = sweepLines[0];
  assert.equal(line.code, "sweep_part_removal_failed", "a failed deletion must not be reported as upload_expired");
  assert.equal(line.decision, "expired-sweep");
  assert.equal(line.event, "direct-upload");
  assert.equal(line.status, null);
  assert.equal(line.uploadId, handle.uploadId, "the line must carry the FULL uploadId");
  assert.equal(line.vaultId, handle.vaultId);
  assert.equal(line.expiresAt, handle.expiresAt);
  // `bytes` is best effort and only for a real file: a directory is not this upload's byte count.
  assert.equal(line.bytes, null);
  assert.equal(lines.some((candidate) => candidate.code === "upload_expired"), false, "nothing was removed");

  // One line, two destinations — same object, as for every other audit line.
  const twin = stdoutAuditLines(second.output).find((candidate) => candidate.code === "sweep_part_removal_failed");
  assert.ok(twin, `no stdout line for the failed sweep in ${second.output.join("")}`);
  assert.deepEqual(twin, line);

  const snapshot = await health(second.base);
  const sweep = snapshot.audit.expiredUploadSweep;
  // Backward compatible: the five pre-existing counters keep their meaning...
  assert.equal(sweep.scanned, 1);
  assert.equal(sweep.removed, 0);
  assert.equal(sweep.kept, 0);
  assert.equal(sweep.orphanParts, 0, "the metadata is still there, so the leftover .part is attributable, not an orphan");
  assert.equal(sweep.failures, 1);
  // ...and the new split says WHICH unlink failed.
  assert.equal(sweep.partRemovalFailures, 1);
  assert.equal(sweep.metadataRemovalFailures, 0);
  assert.equal(typeof sweep.at, "string");

  // A later start retries the same handle instead of forgetting it: same failure, same trace, metadata
  // still on disk. (This is what keeping the metadata buys.)
  await stopChild(second.server.child);
  const third = await boot(root, {});
  assert.equal(await exists(metadataPath), true, "the retry must still keep the metadata");
  const retried = (await auditLines(root)).filter((candidate) => candidate.operation === "expired-sweep");
  assert.equal(retried.length, 2, "each process start must leave its own attempt in the audit file");
  assert.deepEqual(retried.map((candidate) => candidate.code), ["sweep_part_removal_failed", "sweep_part_removal_failed"]);
  assert.equal(retried[1].uploadId, handle.uploadId);
  const thirdSweep = (await health(third.base)).audit.expiredUploadSweep;
  assert.equal(thirdSweep.partRemovalFailures, 1);
  assert.equal(thirdSweep.failures, 1);
});

// ---------------------------------------------------------------------------------------------
// 2. The metadata cannot be deleted after the bytes are gone. Injected `fs.rm` failure (the brief's
//    "or inject an fs failure"): a POSIX read-only file is still unlinkable in a writable directory,
//    so a permission bit alone would not reproduce this branch portably.
// ---------------------------------------------------------------------------------------------
test("sweep: a metadata deletion that fails after the bytes are gone writes sweep_metadata_removal_failed", async () => {
  const root = await freshRoot("metadata-blocked");
  const uploadsRoot = path.join(root, "data", "transfers", "uploads");
  await fs.mkdir(uploadsRoot, { recursive: true });

  const uploadId = randomUUID();
  const expiresAt = new Date(Date.now() - 60_000).toISOString();
  const metadataPath = path.join(uploadsRoot, `${uploadId}.json`);
  const partPath = path.join(uploadsRoot, `${uploadId}.part`);
  await fs.writeFile(metadataPath, JSON.stringify({ uploadId, vaultId: "vault", status: "uploading", uploadedBytes: 12, totalBytes: 64, expiresAt }));
  await fs.writeFile(partPath, "twelve bytes");

  const emitted = [];
  const injected = {
    ...fs,
    rm: async (target, options) => {
      if (target === metadataPath) {
        const error = new Error(`EPERM: injected failure for ${target}`);
        error.code = "EPERM";
        throw error;
      }
      return fs.rm(target, options);
    },
  };

  const report = await sweepExpiredUploads({
    uploadsRoots: [uploadsRoot],
    now: Date.parse(expiresAt) + 1,
    fsPromises: injected,
    emit: (line) => emitted.push(line),
  });

  assert.equal(report.scanned, 1);
  assert.equal(report.removed.length, 0);
  assert.equal(report.failures, 1);
  assert.equal(report.metadataRemovalFailures, 1);
  assert.equal(report.partRemovalFailures, 0, "the .part went first and succeeded");

  assert.equal(emitted.length, 1, `exactly one audit line expected, got ${JSON.stringify(emitted)}`);
  const line = emitted[0];
  assert.equal(line.code, "sweep_metadata_removal_failed");
  assert.equal(line.operation, "expired-sweep");
  assert.equal(line.decision, "expired-sweep");
  assert.equal(line.uploadId, uploadId, "the line must carry the FULL uploadId");
  assert.equal(line.vaultId, "vault");
  assert.equal(line.expiresAt, expiresAt);
  assert.equal(line.bytes, 12);
  assert.equal(line.status, null);

  // On disk: the bytes are gone (that is why this row is not retryable), the metadata is what failed.
  assert.equal(await exists(partPath), false);
  assert.equal(await exists(metadataPath), true, "the injected failure must not be answered by deleting anyway");
});

// ---------------------------------------------------------------------------------------------
// 3. R1 — `receiptId` is part of the discovery contract, and the value the tool answers matches the
//    completing response (#704's behaviour, unchanged; this is the schema half of it).
// ---------------------------------------------------------------------------------------------
test("contract: tools/list advertises file_upload_status.receiptId as nullable, and the tool answers it", async () => {
  const root = await freshRoot("receipt");
  const ctx = await boot(root, {});

  const listed = await listTools(ctx.base, { key: API_KEY }, ctx.session);
  assert.equal(listed.status, 200);
  const tool = (listed.payload?.result?.tools || []).find((candidate) => candidate.name === "file_upload_status");
  assert.ok(tool, "file_upload_status must be discoverable");
  const properties = tool.outputSchema?.properties || {};
  assert.ok("receiptId" in properties, `receiptId missing from the discovery outputSchema: ${JSON.stringify(tool.outputSchema)}`);
  // Nullable union, not a bare string: `null` is the honest answer before a publish wrote a receipt.
  // (zod emits `type: ["string", "null"]`; anyOf/oneOf is accepted in case the dialect changes.)
  const declared = properties.receiptId;
  const variants = declared.type !== undefined
    ? [declared]
    : (declared.anyOf || declared.oneOf || []);
  assert.deepEqual(
    variants.flatMap((variant) => [].concat(variant.type)).sort(),
    ["null", "string"],
    `receiptId must be a string|null union, got ${JSON.stringify(declared)}`,
  );

  const payload = Buffer.alloc(1024, 7);
  const handle = await startUpload(ctx, payload);
  const initial = await callTool(ctx.base, { key: API_KEY }, ctx.session, "file_upload_status", { uploadId: handle.uploadId });
  assert.equal(initial.status, 200);
  assert.equal(initial.payload?.result?.structuredContent?.receiptId, null, "no publish behind the handle yet");

  const published = await put(ctx.base, handle.relativePath, payload);
  assert.equal(published.status, 201);
  const completion = await published.json();
  assert.match(completion.receiptId, /^[0-9a-f-]{36}$/);

  const complete = await callTool(ctx.base, { key: API_KEY }, ctx.session, "file_upload_status", { uploadId: handle.uploadId });
  const structured = complete.payload?.result?.structuredContent;
  assert.equal(structured.receiptId, completion.receiptId, "status must answer the receipt the completing request answered");
  console.log(`SWEEP_TRACE_RECEIPT=${structured.receiptId} PUT_RECEIPT=${completion.receiptId}`);
});
