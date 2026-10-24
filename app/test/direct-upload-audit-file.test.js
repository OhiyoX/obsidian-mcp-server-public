// Issue #470 acceptance gap (A + B) — audit persistence and the startup expired-handle sweep,
// end-to-end against the real `server.js`.
//
// Why a spawned server and not a unit test: the gap the acceptance seat found was in the WIRING.
// The audit line existed, the handle state machine existed, and neither reached a durable file on
// the deployment's disk. Only the real process can prove that `PUT /uploads/:id` writes
// `DATA_PATH/audit/YYYY-MM-DD.jsonl`, that `/healthz` exposes the sink's failure counter, and that
// the startup hook (and only the startup hook) removes expired handles.
//
// Instance isolation: every test gets its own temp DATA_PATH/VAULT_PATH and an ephemeral port, so no
// assertion depends on another test's rate bucket, audit directory or leftover handles.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

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

const DAY_MS = 86_400_000;
const children = [];
const roots = [];

after(async () => {
  await Promise.all(children.map((child) => stopChild(child)));
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Same UTC day key the sink uses for its file name. */
const auditDayKey = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

async function freshRoot(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `direct-upload-audit-${name}-`));
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
  return { server, base: server.base, session: init.session };
}

async function startUpload(base, session, payload, target = `attachments/${randomUUID()}.bin`) {
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const response = await callTool(base, { key: API_KEY }, session, "start_direct_upload", {
    path: target, totalBytes: payload.length, sha256,
  });
  const structured = response.payload?.result?.structuredContent;
  assert.ok(structured?.uploadId, `start_direct_upload failed: ${JSON.stringify(response.payload)}`);
  return { ...structured, sha256 };
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

/** Read (and therefore assert the shape of) today's audit file. */
async function auditLines(root) {
  const file = path.join(root, "data", "audit", `${auditDayKey()}.jsonl`);
  const text = await fs.readFile(file, "utf8");
  assert.equal(text.endsWith("\n"), true, "the audit file must end with a newline");
  const lines = text.trimEnd().split("\n").map((line) => JSON.parse(line));
  return { file, text, lines };
}

async function exists(file) {
  return fs.stat(file).then(() => true, () => false);
}

test("PUT allow + 429 limited + 404 deny all land in data/audit/<today>.jsonl and equal their stdout lines", async () => {
  const root = await freshRoot("persist");
  // Budget = 2 uploads. The rate gate runs BEFORE the handle lookup, so the 404 must come first:
  // after the budget is spent every request is answered 429 and the deny line would never exist.
  const { server, base, session } = await boot(root, { DIRECT_UPLOAD_RATE_PER_MINUTE: "2" });
  const payload = Buffer.alloc(1024, 9);

  const ghost = randomUUID();
  const ghostResponse = await put(base, `/uploads/${ghost}`, Buffer.alloc(16, 1));
  assert.equal(ghostResponse.status, 404);
  assert.equal((await ghostResponse.json()).code, "upload_not_found");

  const allowed = await startUpload(base, session, payload);
  const allowedResponse = await put(base, `/uploads/${allowed.uploadId}`, payload);
  assert.equal(allowedResponse.status, 201);

  const limited = await startUpload(base, session, payload);
  const limitedResponse = await put(base, `/uploads/${limited.uploadId}`, payload);
  assert.equal(limitedResponse.status, 429);
  const retryAfter = Number(limitedResponse.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0, `Retry-After must be an integer number of seconds, got ${limitedResponse.headers.get("retry-after")}`);

  const { text, lines } = await auditLines(root);
  const allow = lines.find((line) => line.decision === "allow" && line.operation === "put");
  const limitedLine = lines.find((line) => line.decision === "limited");
  const deny = lines.find((line) => line.decision === "deny" && line.code === "upload_not_found");
  for (const [label, line] of Object.entries({ allow, limited: limitedLine, deny })) {
    assert.ok(line, `${label} audit line missing from ${text}`);
  }

  // Fields identical to the pre-existing audit shape (`operation`/`decision`/`status`/`code`), plus
  // the data-plane detail that used to exist only on unreachable stdout.
  assert.equal(allow.operation, "put");
  assert.equal(allow.status, 201);
  assert.equal(allow.code, "complete");
  assert.equal(allow.uploadId, allowed.uploadId.slice(0, 8));
  assert.equal(allow.vaultId, allowed.vaultId);
  assert.equal(allow.bytes, payload.length);
  assert.equal(allow.digest, allowed.sha256);
  assert.equal(typeof allow.durationMs, "number");
  assert.equal(typeof allow.requestId, "string");

  assert.equal(limitedLine.operation, "put");
  assert.equal(limitedLine.status, 429);
  assert.equal(limitedLine.code, "rate_limited");
  assert.equal(limitedLine.limit, "rate");
  assert.equal(limitedLine.retryAfterSeconds, retryAfter);
  assert.equal(limitedLine.uploadId, limited.uploadId.slice(0, 8));

  assert.equal(deny.operation, "put");
  assert.equal(deny.status, 404);
  assert.equal(deny.uploadId, ghost.slice(0, 8));
  assert.equal(deny.bytes, null);

  // "One audit line, two destinations, same fields": the file line must be the stdout object itself.
  const stdoutLines = server.output.join("").split("\n")
    .filter((line) => line.startsWith("[direct-upload] "))
    .map((line) => JSON.parse(line.slice("[direct-upload] ".length)));
  for (const line of [allow, limitedLine, deny]) {
    const twin = stdoutLines.find((candidate) => candidate.requestId === line.requestId);
    assert.ok(twin, `no stdout line for requestId ${line.requestId}`);
    assert.deepEqual(twin, line);
  }
});

test("startup prunes audit day files outside AUDIT_RETENTION_DAYS and leaves the window untouched", async () => {
  const root = await freshRoot("retention");
  const auditDir = path.join(root, "data", "audit");
  await fs.mkdir(auditDir, { recursive: true });
  // Offsets 0 and 12 are inside a 14-day window; 15 and 2020 are outside it. Deliberately not the
  // exact cutoff: the boundary itself is pinned deterministically by the sink's unit test.
  const inside = { [auditDayKey()]: "today", [auditDayKey(Date.now() - 12 * DAY_MS)]: "inside" };
  const outside = { [auditDayKey(Date.now() - 15 * DAY_MS)]: "outside", "2020-01-01": "ancient" };
  for (const [day, marker] of Object.entries({ ...inside, ...outside })) {
    await fs.writeFile(path.join(auditDir, `${day}.jsonl`), `{"marker":"${marker}"}\n`);
  }
  await fs.writeFile(path.join(auditDir, "notes.md"), "operator note\n");

  const { base } = await boot(root, { AUDIT_RETENTION_DAYS: "14" });

  for (const [day, marker] of Object.entries(inside)) {
    const file = path.join(auditDir, `${day}.jsonl`);
    assert.equal(await exists(file), true, `${day} is inside the window and must survive`);
    assert.equal(await fs.readFile(file, "utf8"), `{"marker":"${marker}"}\n`);
  }
  for (const day of Object.keys(outside)) {
    assert.equal(await exists(path.join(auditDir, `${day}.jsonl`)), false, `${day} is outside the window and must be pruned`);
  }
  assert.equal(await fs.readFile(path.join(auditDir, "notes.md"), "utf8"), "operator note\n");

  const snapshot = await health(base);
  assert.equal(snapshot.audit.enabled, true);
  assert.equal(snapshot.audit.retentionDays, 14);
  assert.equal(snapshot.audit.retentionFailures, 0);
  assert.equal(snapshot.audit.removedFiles, 2);
});

test("an unwritable audit directory is counted on /healthz and never fails the request", async () => {
  const root = await freshRoot("blocked");
  // Cross-platform injection: occupy the sink's directory path with a regular file, so creating the
  // directory fails on every OS (POSIX permission bits are meaningless on Windows).
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "audit"), "not a directory\n");

  const { server, base, session } = await boot(root, {});
  const before = await health(base);
  assert.equal(before.audit.enabled, true);
  assert.ok(before.audit.sinkFailures >= 1, "startup must already have counted the un-creatable directory");

  const payload = Buffer.alloc(512, 3);
  const handle = await startUpload(base, session, payload);
  const response = await put(base, `/uploads/${handle.uploadId}`, payload);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, "COMPLETE");

  const afterPut = await health(base);
  // Two audit lines belong to this pair of calls: the control-plane `start` and the data-plane `put`.
  assert.equal(afterPut.audit.sinkFailures, before.audit.sinkFailures + 2);
  assert.equal(afterPut.audit.written, 0);
  assert.match(afterPut.audit.lastError, /^(append|startup): /);

  // The process stayed healthy and nothing surfaced as an unhandled rejection.
  assert.equal(server.child.exitCode, null);
  assert.equal((await health(base)).ok, true);
  assert.doesNotMatch(server.output.join(""), /UnhandledPromiseRejection/);
});

test("startup sweep removes an expired handle with its .part and keeps a bare .part", async () => {
  const root = await freshRoot("sweep");
  // TTL of 1 ms: the handle is expired the moment it is created, so the NEXT process start must
  // sweep it. Nothing writes the `.part` first beyond `start_direct_upload`'s empty staging file.
  const first = await boot(root, { DIRECT_UPLOAD_TTL_MS: "1" });
  const handle = await startUpload(first.base, first.session, Buffer.alloc(256, 5));

  const uploadsRoot = path.join(root, "data", "transfers", "uploads");
  const metadataPath = path.join(uploadsRoot, `${handle.uploadId}.json`);
  const partPath = path.join(uploadsRoot, `${handle.uploadId}.part`);
  assert.equal(await exists(metadataPath), true);
  assert.equal(await exists(partPath), true);

  // The pre-durable residue the brief calls out: a `.part` with no metadata. It is not attributable
  // to any handle, so it must survive the sweep exactly as it is.
  const barePart = path.join(uploadsRoot, `${randomUUID()}.part`);
  await fs.writeFile(barePart, "pre-durable residue\n");

  await stopChild(first.server.child);

  const second = await boot(root, {});

  assert.equal(await exists(metadataPath), false, "expired handle metadata must be removed");
  assert.equal(await exists(partPath), false, "the expired handle's .part must be removed with it");
  assert.equal(await exists(barePart), true, "a bare .part must never be deleted");
  assert.equal(await fs.readFile(barePart, "utf8"), "pre-durable residue\n");

  const { lines } = await auditLines(root);
  const sweep = lines.filter((line) => line.decision === "expired-sweep");
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0].operation, "expired-sweep");
  assert.equal(sweep[0].code, "upload_expired");
  assert.equal(sweep[0].status, null);
  // The sweep line keeps the FULL id: after the metadata is gone it is the only trace of the handle.
  assert.equal(sweep[0].uploadId, handle.uploadId);
  assert.equal(sweep[0].vaultId, handle.vaultId);
  assert.equal(sweep[0].bytes, 0);
  assert.equal(typeof sweep[0].expiresAt, "string");

  const snapshot = await health(second.base);
  assert.equal(snapshot.audit.expiredUploadSweep.removed, 1);
  assert.equal(snapshot.audit.expiredUploadSweep.orphanParts, 1);
  assert.equal(snapshot.audit.expiredUploadSweep.failures, 0);
  assert.equal(snapshot.audit.expiredUploadSweep.scanned, 1);
});
