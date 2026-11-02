// Issue #470 Wave A — HTTP data plane end-to-end against the real `server.js`.
//
// Contract: `DEVELOPMENT - Issue 470 大文件 HTTP 直传与可恢复上传` §2.1/§2.2/§2.3/§3 and the A0
// decisions D1–D8. The child process is the real server on an ephemeral port with an isolated
// `DATA_PATH` / `VAULT_PATH`, so the assertions cover wiring the runtime tests cannot see: auth
// middleware reuse, scope/时间窗 gate, Vault resolution, audit logging and the exact HTTP status map.
//
// Everything here is driven the way a client would: one MCP call for the control plane, then a raw
// `PUT` whose body is the file itself — no base64 ever crosses the tool surface.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  API_KEY,
  callTool,
  createManagedApiKey,
  freePort,
  initialize,
  mcp,
  seedVault,
  serverEnv,
  startServer,
  stopChild,
} from "./helpers/server-spawn-fixtures.js";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const PAYLOAD = Buffer.alloc(123_154);
for (let index = 0; index < PAYLOAD.length; index += 1) PAYLOAD[index] = (index * 37 + 11) % 256;

let root;
let server;
let base;
let session;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "direct-upload-http-"));
  await seedVault(root);
  const port = await freePort();
  // Wave A predates the admission-control gates (issue #470 follow-up): this suite issues ~13 PUTs
  // from one credential, so it raises the per-minute rate only. The gates themselves have their own
  // suite (`direct-upload-limits.test.js`); the concurrency default (2) is untouched because every
  // request here is awaited sequentially.
  server = await startServer(serverEnv({ port, root, extra: { WEB_CATALOG_DIR: path.join(root, "web-catalog"), DIRECT_UPLOAD_RATE_PER_MINUTE: "600" } }));
  base = server.base;
  const init = await initialize(base, { key: API_KEY });
  assert.equal(init.status, 200);
  session = init.session;
});

after(async () => {
  await stopChild(server?.child);
  await fs.rm(root, { recursive: true, force: true });
});

async function startUpload({ target = `attachments/${randomUUID()}.bin`, payload = PAYLOAD, sha = sha256(payload), totalBytes = payload.length, overwrite = false } = {}) {
  const response = await callTool(base, { key: API_KEY }, session, "start_direct_upload", {
    path: target, totalBytes, sha256: sha, overwrite,
  });
  const result = response.payload?.result ?? {};
  return { response, result, structured: result.structuredContent, target };
}

function put(relativePath, body, { headers = {}, key = API_KEY, bearer } = {}) {
  const auth = bearer ? { Authorization: `Bearer ${bearer}` } : { "X-API-Key": key };
  return fetch(`${base}${relativePath}`, {
    method: "PUT",
    headers: { ...auth, ...headers },
    body,
  });
}

async function apiKeyStatus(relativePath, body, key) {
  const response = await put(relativePath, body, { key });
  return { status: response.status, body: await response.json() };
}

function vaultFile(target) {
  return fs.readFile(path.join(root, "vault", ...target.split("/")));
}

test("the control plane answers metadata only and the PUT publishes the bytes (123 KB, < 5 s)", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { response, result, structured } = await startUpload({ target });
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.ok(!result.isError, JSON.stringify(result));

  assert.match(structured.uploadId, /^[0-9a-f-]{36}$/);
  assert.equal(structured.method, "PUT");
  assert.equal(structured.mode, "single-put");
  assert.equal(structured.sha256Required, true);
  assert.equal(structured.relativePath, `/uploads/${structured.uploadId}`);
  assert.equal(structured.path, target);
  assert.equal(structured.totalBytes, PAYLOAD.length);
  assert.equal(structured.sha256, sha256(PAYLOAD));
  assert.equal(structured.maxBytes, 50 * 1024 * 1024);
  assert.ok(!Number.isNaN(Date.parse(structured.expiresAt)));
  // D7: no absolute URL is ever derived from Host / X-Forwarded-Host.
  assert.equal(structured.uploadUrl, undefined);
  assert.ok(!JSON.stringify(result).includes("base64"), "the control plane must not carry content");

  const startedAt = Date.now();
  const published = await put(structured.relativePath, PAYLOAD, { headers: { "Content-Type": "application/octet-stream" } });
  const elapsed = Date.now() - startedAt;
  const body = await published.json();
  assert.equal(published.status, 201, JSON.stringify(body));
  assert.equal(body.uploadId, structured.uploadId);
  assert.equal(body.size, PAYLOAD.length);
  assert.equal(body.sha256, sha256(PAYLOAD));
  assert.equal(body.status, "COMPLETE");
  assert.match(body.receiptId, /^[0-9a-f-]{36}$/);
  assert.ok(elapsed < 5000, `123 KB must finish in under 5 s, took ${elapsed} ms`);
  assert.ok((await vaultFile(target)).equals(PAYLOAD), "the Vault file must be byte-identical to what the client sent");
  console.log(`DIRECT_UPLOAD_123KB_MS=${elapsed}`);
});

test("the structured log and MCP surface carry paths, sizes and digests — never content or credentials", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  const published = await put(structured.relativePath, PAYLOAD);
  assert.equal(published.status, 201);
  await published.json();

  const log = server.output.join("");
  const lines = log.split(/\r?\n/).filter((line) => line.startsWith("[direct-upload] "));
  assert.ok(lines.length >= 2, `expected start + put audit lines, saw ${lines.length}`);
  const events = lines.map((line) => JSON.parse(line.slice("[direct-upload] ".length)));
  const put_event = events.filter((event) => event.operation === "put").at(-1);
  assert.equal(put_event.decision, "allow");
  assert.equal(put_event.bytes, PAYLOAD.length);
  assert.equal(put_event.digest, sha256(PAYLOAD));
  assert.equal(put_event.uploadId, structured.uploadId.slice(0, 8), "audit keeps a truncated id only");
  assert.equal(typeof put_event.durationMs, "number");
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [
      "bytes", "code", "credentialId", "decision", "digest", "durationMs", "event", "operation", "requestId", "status", "uploadId", "vaultId",
    ].sort());
  }
  // D8: no base64/binary body, no bearer, no absolute URL, no cookie in the log stream.
  assert.ok(!log.includes(PAYLOAD.toString("base64").slice(0, 64)), "the log must not contain the file body or its base64");
  assert.ok(!/authorization/i.test(log), "the log must not echo the Authorization header");
  assert.ok(!log.includes(API_KEY), "the log must not echo the credential");
  assert.ok(!log.includes(`http://127.0.0.1:${server.base.split(":").at(-1)}/uploads/`), "the log must not echo an absolute upload URL");
});

test("a SHA-256 mismatch answers 400 and leaves no file in the Vault", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target, sha: "0".repeat(64) });
  const published = await put(structured.relativePath, PAYLOAD);
  assert.equal(published.status, 400);
  const body = await published.json();
  assert.equal(body.code, "UPLOAD_INTEGRITY_MISMATCH");
  await assert.rejects(vaultFile(target), /ENOENT/);
});

test("a body shorter than totalBytes answers 400 and publishes nothing", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  const published = await put(structured.relativePath, PAYLOAD.subarray(0, PAYLOAD.length - 9));
  assert.equal(published.status, 400);
  assert.equal((await published.json()).code, "length_mismatch");
  await assert.rejects(vaultFile(target), /ENOENT/);
});

test("a body longer than totalBytes answers 413 and publishes nothing", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  const published = await put(structured.relativePath, Buffer.concat([PAYLOAD, Buffer.from("extra")]));
  assert.equal(published.status, 413);
  assert.equal((await published.json()).code, "length_mismatch");
  await assert.rejects(vaultFile(target), /ENOENT/);
});

test("a chunked body without Content-Length answers 400", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  const chunked = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(PAYLOAD.subarray(0, 1024)));
      controller.close();
    },
  });
  const published = await fetch(`${base}${structured.relativePath}`, {
    method: "PUT",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/octet-stream" },
    body: chunked,
    duplex: "half",
  });
  assert.equal(published.status, 400);
  assert.equal((await published.json()).code, "length_required");
});

test("multipart and JSON envelopes are refused with 400", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  for (const contentType of ["multipart/form-data; boundary=x", "application/json"]) {
    const published = await put(structured.relativePath, Buffer.from("{}"), { headers: { "Content-Type": contentType } });
    assert.equal(published.status, 400, contentType);
    assert.equal((await published.json()).code, "unsupported_media_type");
  }
});

test("an unknown handle answers 404 and a repeated PUT answers 409 with the same receipt", async () => {
  const missing = await put(`/uploads/${randomUUID()}`, PAYLOAD);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "upload_not_found");

  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  const first = await put(structured.relativePath, PAYLOAD);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const before = await fs.stat(path.join(root, "vault", ...target.split("/")));
  const second = await put(structured.relativePath, PAYLOAD);
  assert.equal(second.status, 409);
  const secondBody = await second.json();
  assert.equal(secondBody.code, "upload_complete");
  assert.equal(secondBody.receiptId, firstBody.receiptId);
  const afterStat = await fs.stat(path.join(root, "vault", ...target.split("/")));
  assert.equal(afterStat.mtimeMs, before.mtimeMs, "a duplicate PUT must not rewrite the Vault file");
});

test("an expired handle answers 410 and never publishes", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  const metadataPath = path.join(root, "data", "transfers", "uploads", `${structured.uploadId}.json`);
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  metadata.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const published = await put(structured.relativePath, PAYLOAD);
  assert.equal(published.status, 410);
  assert.equal((await published.json()).code, "UPLOAD_EXPIRED");
  await assert.rejects(vaultFile(target), /ENOENT/);
});

test("a credential without obsidian.write/obsidian.files is refused with 403", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  const readOnly = await createManagedApiKey(base);
  const published = await put(structured.relativePath, PAYLOAD, { key: readOnly.key });
  assert.equal(published.status, 403);
  assert.equal((await published.json()).code, "insufficient_scope");
  await assert.rejects(vaultFile(target), /ENOENT/);
});

test("a credential scoped to another Vault cannot see the handle (404, no existence leak)", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  // A key holding every scope but allowed only on Vault `vault` — while the handle lives in the
  // primary Vault (`default`). The lookup must never probe (or report) the other Vault's storage.
  const other = await createManagedApiKey(base, { scopes: ["obsidian.read", "obsidian.write", "obsidian.files"], vault: "vault" });
  const status = await apiKeyStatus(structured.relativePath, PAYLOAD, other.key);
  assert.equal(status.status, 404, JSON.stringify(status.body));
  assert.equal(status.body.code, "upload_not_found", "a handle from another Vault reads as unknown");
  await assert.rejects(vaultFile(target), /ENOENT/);
  const anonymous = await put(structured.relativePath, PAYLOAD, { key: `obmcp_000000000000_${randomUUID()}` });
  assert.equal(anonymous.status, 401, "an invalid key never reaches the handle");
  await assert.rejects(vaultFile(target), /ENOENT/);
});

test("no credential answers 401 and POST answers 405", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  const anonymous = await fetch(`${base}${structured.relativePath}`, { method: "PUT", body: PAYLOAD });
  assert.equal(anonymous.status, 401);
  const wrongMethod = await fetch(`${base}${structured.relativePath}`, { method: "POST", headers: { "X-API-Key": API_KEY }, body: "{}" });
  assert.equal(wrongMethod.status, 405);
  // Wave B adds the resumable PATCH writer, so the advertised method set grew by exactly that one.
  assert.equal(wrongMethod.headers.get("allow"), "PUT, PATCH");
});

test("the MCP chunk writer refuses a single-PUT handle (D6)", async () => {
  const target = `attachments/${randomUUID()}.bin`;
  const { structured } = await startUpload({ target });
  const chunked = await callTool(base, { key: API_KEY }, session, "upload_file_chunk", {
    uploadId: structured.uploadId, offset: 0, base64: PAYLOAD.subarray(0, 16).toString("base64"), finalize: true,
  });
  const text = chunked.payload?.result?.content?.[0]?.text ?? "";
  assert.equal(chunked.payload?.result?.isError, true, text);
  assert.match(text, /direct HTTP upload/);
  assert.match(text, /\/uploads\//);
  await assert.rejects(vaultFile(target), /ENOENT/);
});

test("the control plane refuses totalBytes above the direct ceiling and a missing sha256", async () => {
  const tooLarge = await callTool(base, { key: API_KEY }, session, "start_direct_upload", {
    path: "attachments/huge.bin", totalBytes: 60 * 1024 * 1024, sha256: "a".repeat(64),
  });
  assert.equal(tooLarge.payload?.result?.isError, true);
  assert.match(tooLarge.payload?.result?.content?.[0]?.text ?? "", /UPLOAD_TOO_LARGE/);

  const noSha = await callTool(base, { key: API_KEY }, session, "start_direct_upload", {
    path: "attachments/nosha.bin", totalBytes: 4,
  });
  assert.equal(noSha.payload?.result?.isError, true);
});

test("the control plane stays behind the legacy tool contract (start_file_upload unchanged)", async () => {
  const legacy = await callTool(base, { key: API_KEY }, session, "start_file_upload", {
    path: `attachments/${randomUUID()}.bin`, totalBytes: 4, sha256: sha256(Buffer.from("abcd")),
  });
  const structured = legacy.payload?.result?.structuredContent ?? {};
  assert.equal(structured.mode, undefined, "the legacy start must not report a mode");
  assert.equal(structured.method, undefined, "the legacy start must not grow an HTTP surface");
  assert.match(structured.uploadId, /^[0-9a-f-]{36}$/);
});
