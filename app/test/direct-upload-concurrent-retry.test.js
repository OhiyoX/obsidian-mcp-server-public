// Issue #725 rework — a refusal must never reclaim a handle that another ADMITTED request is about
// to write. (Regression, added after the review measured the breakage on the first version.)
//
// What was wrong: `admit()` hands out the in-flight slot before the handle is located and long
// before the runtime takes the writer lock. A sibling refusal in that window saw "no `writerToken`,
// 0-byte `.part`" and reclaimed the handle, so the admitted request was answered
// `409 UPLOAD_IN_PROGRESS` even though nobody was writing (the reclaimer held the same writer lock
// for a moment) and the recovery the docs prescribe — "retry the SAME request" — then answered
// `404 upload_not_found`. Measured on the previous head, 9 of 10 rounds of this probe shape took
// that path; the same input on the pre-#725 base was `{201, 429}` then `{201, 409 upload_complete}`.
//
// Asserted here, against the real `server.js` on an ephemeral port with an isolated
// DATA_PATH/VAULT_PATH, ten fresh handles, in-flight cap 1 and a generous rate budget:
//   1. the two concurrent PUTs of the SAME handle never answer `409 UPLOAD_IN_PROGRESS`;
//   2. that `429` never claims `handleDiscarded` (the sibling is admitted, the handle is alive), and
//      neither does its audit line;
//   3. the documented recovery answers `201` or the idempotent `409 upload_complete` — never `404`.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
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

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ROUNDS = 10;
let child = null;
let root = null;

after(async () => {
  if (child) await stopChild(child);
  if (root) await fs.rm(root, { recursive: true, force: true });
});

/**
 * `fetch()` cannot promise that two requests overlap (a fresh connection may serialise them), and
 * overlap is the whole point here: a raw `http.request` pair that is written back to back stays
 * concurrent on the wire.
 */
function rawPut(base, relativePath, payload) {
  const url = new URL(`${base}${relativePath}`);
  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "PUT",
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(payload.length),
    },
  });
  const settled = new Promise((resolve) => {
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, code: body?.code ?? null, body });
      });
    });
    req.on("error", (error) => resolve({ status: 0, code: error.code ?? String(error), body: null }));
  });
  req.end(payload);
  return settled;
}

function auditEvents(output) {
  return output.join("").split(/\r?\n/)
    .filter((line) => line.startsWith("[direct-upload] "))
    .map((line) => JSON.parse(line.slice("[direct-upload] ".length)));
}

test("concurrency: a refusal leaves a handle another admitted request is about to write, and the retry never 404s", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-concurrent-retry-"));
  await seedVault(root);
  const port = await freePort();
  const server = await startServer(serverEnv({
    port,
    root,
    extra: {
      WEB_CATALOG_DIR: path.join(root, "web-catalog"),
      DIRECT_UPLOAD_MIN_FREE_BYTES: "0",
      DIRECT_UPLOAD_RATE_PER_MINUTE: "100",
      DIRECT_UPLOAD_MAX_CONCURRENT_PER_CREDENTIAL: "1",
      DIRECT_UPLOAD_IDLE_TIMEOUT_MS: "60000",
      DIRECT_UPLOAD_MAX_DURATION_MS: "240000",
    },
  }));
  child = server.child;
  const session = (await initialize(server.base, { key: API_KEY })).session;
  const payload = Buffer.alloc(2048, 7);
  const readings = [];

  for (let round = 1; round <= ROUNDS; round += 1) {
    const response = await callTool(server.base, { key: API_KEY }, session, "start_direct_upload", {
      path: `attachments/${randomUUID()}.bin`,
      totalBytes: payload.length,
      sha256: sha256(payload),
      overwrite: false,
    });
    const started = response.payload?.result?.structuredContent ?? {};
    assert.ok(started.uploadId, `round ${round}: the control plane failed: ${JSON.stringify(response.payload)}`);

    // Two requests for the SAME handle, exactly what an edge timeout + resend (or two workers
    // sharing one handle) produces. With the cap at 1 one of them must be refused.
    const pair = await Promise.all([
      rawPut(server.base, started.relativePath, payload),
      rawPut(server.base, started.relativePath, payload),
    ]);
    const sequence = pair.map(({ status, code }) => ({ status, code }));

    // 1. Nobody else is writing, so a `409 UPLOAD_IN_PROGRESS` here can only be the reclaimer's own
    //    momentary writer lock — the defect this test exists for.
    for (const entry of sequence) {
      assert.notEqual(
        entry.code, "UPLOAD_IN_PROGRESS",
        `round ${round}: a refusal answered the admitted sibling with a phantom writer conflict (${JSON.stringify(sequence)})`,
      );
    }
    // 2. A refused request must not claim it reclaimed a handle that a sibling is admitted for.
    for (const { status, body } of pair) {
      if (status !== 429) continue;
      assert.equal(body?.handleDiscarded, undefined, `round ${round}: a refusal reclaimed a live sibling's handle: ${JSON.stringify(body)}`);
      assert.equal(body?.code, "rate_limited");
    }

    // 3. The documented recovery for `429`: wait, then send the SAME request again. Slots are
    //    released on response close, so a short poll is enough for the in-flight cap.
    let retry = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(100);
      retry = await rawPut(server.base, started.relativePath, payload);
      if (retry.status !== 429) break;
    }
    assert.notEqual(retry?.status, 404, `round ${round}: the documented retry hit a ${retry?.status} ${retry?.code} (first round: ${JSON.stringify(sequence)})`);
    assert.ok(
      retry?.status === 201 || (retry?.status === 409 && retry?.code === "upload_complete"),
      `round ${round}: the retry must publish or answer the idempotent 409, got ${retry?.status} ${retry?.code} (first round: ${JSON.stringify(sequence)})`,
    );
    readings.push({ round, sequence, retry: { status: retry.status, code: retry.code } });
  }

  console.log(`#725 rework readings: ${JSON.stringify(readings)}`);

  // The audit trail must not claim a reclamation either: the same `handleDiscarded` flag feeds it.
  const limited = auditEvents(server.output).filter((event) => event.decision === "limited");
  assert.ok(limited.length > 0, "at least one round must exercise the concurrency refusal");
  for (const event of limited) {
    assert.equal(event.limit, "concurrency");
    assert.equal(event.code, "concurrency_limited");
    assert.equal(event.handleDiscarded, undefined, `a refusal reclaimed a live sibling's handle: ${JSON.stringify(event)}`);
  }
});
