// B5 — per-Vault transfer runtime: upload isolation, handle binding, zero part I/O on mismatch.
//
// Contract: Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置
//   §13.4 upload sessions (metadata carries vaultId; a mismatched caller is rejected before any part
//         read/write; legacy metadata without vaultId is primary-only)
//   §22.4 legacy plans/uploads (never guess a secondary Vault)
//   §27  B5 transfer runtime, §33 test matrix, §36.2 cross-call upload security
//   §37  state isolation (A's upload state must be invisible from B)
//   §42  SEC-MV05 (no implicit cross-call vault) / SEC-MV06 (no fallback onto primary state)
//   §43-5/§43-8 (no global path constant in a Vault-dependent module; upload state carries vaultId)
//   §44-7 old-red: "upload metadata 未绑定 vaultId" must be green on this head
//
// The tests drive real instances built from real A7 paths and assert on observable effects (files in
// each Vault's uploads root, uploaded bytes, error codes) and on a recording wrapper over
// `node:fs/promises` for the "zero part I/O" claim — never on private internals. The recording wrapper
// is proven non-vacuous by a positive control in the same test.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { vaultDataKey } from "../src/vault-runtime/descriptor.js";
import { vaultDataPaths } from "../src/vault-runtime/paths.js";
import { createVaultRuntime } from "../src/vault-runtime/runtime.js";
import {
  UPLOAD_NOT_FOUND,
  VAULT_CONTEXT_MISMATCH,
  assertTransferVaultPath,
  createTransferRuntime,
} from "../src/vault-runtime/transfer-runtime.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_MODULE = new URL("../src/vault-runtime/transfer-runtime.js", import.meta.url);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mv-b5-transfer-"));
const DEPS = Object.freeze({ requireRequestAuthor: () => ({ agent: "mv-b5", model: "test" }) });
const LIMITS = Object.freeze({ maxTransferBytes: 1_000_000, chunkBytes: 1024, ttlMs: 60_000 });
const PROTECTED_ROOTS = new Set([".git", ".obsidian"]);

after(() => fs.rm(scratch, { recursive: true, force: true }));

function runtimeDeps(overrides = {}) {
  return { limits: LIMITS, protectedRoots: PROTECTED_ROOTS, ...overrides };
}

/** B1 runtime for a secondary Vault: A7 `DATA_PATH/vaults/<dataKey>/...` layout, own Vault root. */
async function secondaryVaultRuntime(id) {
  const name = id.replace(/[^a-z0-9-]/gi, "_");
  const root = path.join(scratch, name, "vault");
  const dataRoot = path.join(scratch, name, "data");
  await fs.mkdir(root, { recursive: true });
  return createVaultRuntime({
    descriptor: { id, name: id, root, primary: false },
    paths: vaultDataPaths({ primary: false, dataRoot, dataKey: vaultDataKey(id) }),
    deps: DEPS,
  });
}

/** B1 runtime for the primary Vault: legacy (A7 primary) pass-through layout. */
async function primaryVaultRuntime() {
  const root = path.join(scratch, "primary", "vault");
  const dataRoot = path.join(scratch, "primary", "data");
  await fs.mkdir(root, { recursive: true });
  return createVaultRuntime({
    descriptor: { id: "vault", name: "vault", root, primary: true },
    paths: vaultDataPaths({
      primary: true,
      history: path.join(dataRoot, "history"),
      trash: path.join(dataRoot, "trash"),
      retrievalIndex: path.join(dataRoot, "index", "retrieval-index.json"),
      transfersUploads: path.join(dataRoot, "transfers", "uploads"),
      mutationJournal: path.join(dataRoot, "mutation-journal"),
      mutationIdempotency: path.join(dataRoot, "mutation-idempotency"),
    }),
    deps: DEPS,
  });
}

function transferRuntime(vaultRuntime, deps = runtimeDeps()) {
  return createTransferRuntime({ vaultRuntime, deps });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to reject");
}

async function readdirOrEmpty(directory) {
  try {
    return (await fs.readdir(directory)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Hand-stage an upload the pre-B5 code could have written: metadata (optionally with `vaultId`) plus a
 * part file, in `runtime.uploadsRoot`. Models the legacy shared-root phase (§22.4) and a root restored
 * by an operator — cases where a root can hold a handle declared for a different Vault id.
 */
async function stageUpload(runtime, { vaultId, bytes = Buffer.from("abcd") } = {}) {
  await fs.mkdir(runtime.uploadsRoot, { recursive: true });
  const uploadId = randomUUID();
  const metadata = {
    uploadId,
    vaultPath: "Notes/staged.bin",
    totalBytes: bytes.length,
    uploadedBytes: 0,
    overwrite: false,
    acceptedOnly: false,
    status: "uploading",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + LIMITS.ttlMs).toISOString(),
  };
  if (vaultId !== undefined) metadata.vaultId = vaultId;
  await fs.writeFile(path.join(runtime.uploadsRoot, `${uploadId}.json`), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const part = path.join(runtime.uploadsRoot, `${uploadId}.part`);
  await fs.writeFile(part, bytes);
  return { uploadId, metadata, part, bytes };
}

/** Record every `node:fs/promises` call the module under test makes inside `callback`. */
async function withRecordedFileIo(callback) {
  const calls = [];
  const methods = ["appendFile", "mkdir", "readFile", "rename", "rm", "writeFile"];
  const originals = new Map();
  for (const name of methods) {
    originals.set(name, fs[name]);
    fs[name] = async (target, ...rest) => {
      calls.push({ method: name, target: String(target) });
      return originals.get(name).call(fs, target, ...rest);
    };
  }
  try {
    return { calls, value: await callback(calls) };
  } finally {
    for (const [name, original] of originals) fs[name] = original;
  }
}

function partCalls(calls) {
  return calls.filter((call) => call.target.endsWith(".part"));
}

/** Blank comment and string bodies while keeping line structure (the W0-A / B3 scanner shape). */
function blankCommentsAndStrings(source) {
  const text = String(source);
  let out = "";
  let index = 0;
  let state = "code";
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { state = "line"; out += "  "; index += 2; continue; }
      if (char === "/" && next === "*") { state = "block"; out += "  "; index += 2; continue; }
      if (char === "'" || char === '"' || char === "`") { state = char; out += char; index += 1; continue; }
      out += char; index += 1; continue;
    }
    if (state === "line") { out += char === "\n" ? char : " "; if (char === "\n") state = "code"; index += 1; continue; }
    if (state === "block") { out += char === "\n" ? char : " "; if (char === "*" && next === "/") { state = "code"; index += 2; continue; } index += 1; continue; }
    if (char === "\\") { out += "  "; index += 2; continue; }
    if (char === state) { state = "code"; out += char; index += 1; continue; }
    out += char === "\n" ? char : " ";
    index += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// §37 / §36.2 — A/B isolation
// ---------------------------------------------------------------------------

test("an upload created in Vault A is invisible and inaccessible from Vault B (§37, §36.2)", async () => {
  const vaultA = await secondaryVaultRuntime("vault-a");
  const vaultB = await secondaryVaultRuntime("vault-b");
  const runtimeA = transferRuntime(vaultA);
  const runtimeB = transferRuntime(vaultB);
  assert.notEqual(runtimeA.uploadsRoot, runtimeB.uploadsRoot);

  const payload = Buffer.from("vault-a payload");
  const started = await runtimeA.startFileUpload({ vaultPath: "Notes/a.bin", totalBytes: payload.length }, "vault-a");

  // The staged handle lives in A's uploads root only — never in B's, and never in a shared root.
  assert.deepEqual(await readdirOrEmpty(runtimeA.uploadsRoot), [`${started.uploadId}.json`, `${started.uploadId}.part`].sort());
  assert.deepEqual(await readdirOrEmpty(runtimeB.uploadsRoot), []);

  const foreignStatus = await rejection(runtimeB.fileUploadStatus(started.uploadId, "vault-b"));
  assert.equal(foreignStatus.code, UPLOAD_NOT_FOUND, "B must fail closed instead of reading A's uploads root");
  const foreignChunk = await rejection(runtimeB.appendFileUpload({ uploadId: started.uploadId, offset: 0, base64: payload.toString("base64") }, "vault-b"));
  assert.equal(foreignChunk.code, UPLOAD_NOT_FOUND);
  const foreignCancel = await rejection(runtimeB.cancelFileUpload(started.uploadId, "vault-b"));
  assert.equal(foreignCancel.code, UPLOAD_NOT_FOUND);
  assert.deepEqual(await readdirOrEmpty(runtimeB.uploadsRoot), [], "B must not create upload state while rejecting");

  // A still completes normally, and the payload lands in A's Vault root — not B's.
  await runtimeA.appendFileUpload({ uploadId: started.uploadId, offset: 0, base64: payload.toString("base64"), finalize: true }, "vault-a");
  assert.deepEqual(await fs.readFile(path.join(vaultA.root, "Notes", "a.bin")), payload);
  assert.equal(await fs.stat(path.join(vaultB.root, "Notes", "a.bin")).then(() => true, () => false), false);
  assert.deepEqual(await readdirOrEmpty(runtimeA.uploadsRoot), [`${started.uploadId}.json`], "only the released part file is removed after a completed upload");
});

test("the durable handle and the public results carry the handle's Vault (§13.4)", async () => {
  const runtimeA = transferRuntime(await secondaryVaultRuntime("vault-a"));
  const payload = Buffer.from("bound");
  const started = await runtimeA.startFileUpload({ vaultPath: "Notes/bound.bin", totalBytes: payload.length }, "vault-a");

  assert.equal(started.vaultId, "vault-a", "start_file_upload must output vaultId");
  const onDisk = JSON.parse(await fs.readFile(path.join(runtimeA.uploadsRoot, `${started.uploadId}.json`), "utf8"));
  assert.equal(onDisk.vaultId, "vault-a", "upload metadata must persist vaultId");

  const status = await runtimeA.fileUploadStatus(started.uploadId, "vault-a");
  assert.equal(status.vaultId, "vault-a");
  assert.equal(status.status, "uploading");
  assert.equal(status.path, "Notes/bound.bin");

  // An unscoped call (no Vault declared in the request, today's single-Vault default) binds the handle
  // to the runtime it actually writes through.
  const unscoped = await runtimeA.startFileUpload({ vaultPath: "Notes/unscoped.bin", totalBytes: 1 });
  assert.equal(unscoped.vaultId, "vault-a");
});

// ---------------------------------------------------------------------------
// §13.4 — mismatch is rejected before any part-file I/O
// ---------------------------------------------------------------------------

test("a handle bound to another Vault claim is rejected before any part I/O (§13.4, SEC-MV05)", async () => {
  const runtime = transferRuntime(await secondaryVaultRuntime("vault-b"));
  const staged = await stageUpload(runtime, { vaultId: "vault-a" });
  const before = await fs.readFile(staged.part);

  // Negative: every consumer entry point refuses on the Vault mismatch …
  const { calls } = await withRecordedFileIo(async () => {
    const status = await rejection(runtime.fileUploadStatus(staged.uploadId, "vault-b"));
    assert.equal(status.code, VAULT_CONTEXT_MISMATCH);
    assert.equal(status.message.startsWith(`[${VAULT_CONTEXT_MISMATCH}] `), true, "structured code must also be visible in the message prefix");
    assert.equal(status.message.includes("vault-a"), false, "the rejection must not disclose a foreign Vault id (§42 SEC-MV03)");
    const chunk = await rejection(runtime.appendFileUpload({ uploadId: staged.uploadId, offset: 0, base64: "YWJjZA==" }, "vault-b"));
    assert.equal(chunk.code, VAULT_CONTEXT_MISMATCH);
    const cancel = await rejection(runtime.cancelFileUpload(staged.uploadId, "vault-b"));
    assert.equal(cancel.code, VAULT_CONTEXT_MISMATCH);
  });

  assert.deepEqual(partCalls(calls), [], "a mismatch must not read, append or delete the part file");
  assert.equal((calls.find((call) => call.method === "readFile") || {}).target?.endsWith(".json"), true, "the metadata read is allowed (binding is decided from it)");
  assert.deepEqual(await fs.readFile(staged.part), before, "the staged bytes are untouched");
  assert.equal((await fs.readdir(runtime.uploadsRoot)).includes(`${staged.uploadId}.json`), true, "the refused cancel did not delete the handle");

  // Positive control: with the binding satisfied the very same instrument records part I/O, so the
  // empty list above is a real observation and not a broken wrapper.
  const control = await withRecordedFileIo(() => runtime.appendFileUpload({ uploadId: staged.uploadId, offset: 0, base64: "YWJjZA==" }, "vault-a"));
  assert.equal(control.value.uploadedBytes, 4);
  assert.ok(partCalls(control.calls).length >= 1, "the recording wrapper must observe real part I/O when the Vault matches");

  // The declared-Vault check only applies to a *declared* Vault: an unscoped legacy call is allowed to
  // consume the handle from the root it can see (§22.4 / no request Vault today). Wave C materializes
  // "omitted = default/primary" in the registrar, at which point this case becomes a mismatch too.
  assert.equal((await runtime.fileUploadStatus(staged.uploadId)).vaultId, "vault-a");
});

test("legacy metadata without vaultId is consumable by the primary Vault only (§22.4)", async () => {
  const primary = transferRuntime(await primaryVaultRuntime());
  const secondary = transferRuntime(await secondaryVaultRuntime("vault-b"));

  const legacyPrimary = await stageUpload(primary, {});
  assert.equal(legacyPrimary.metadata.vaultId, undefined, "fixture: pre-B5 metadata carries no vaultId");
  assert.equal((await primary.fileUploadStatus(legacyPrimary.uploadId)).status, "uploading");
  assert.equal((await primary.fileUploadStatus(legacyPrimary.uploadId, "vault-b")).status, "uploading", "the primary Vault may consume its own legacy handles");

  // A secondary runtime must never guess that a legacy handle belongs to it.
  const legacySecondary = await stageUpload(secondary, {});
  const refused = await rejection(secondary.fileUploadStatus(legacySecondary.uploadId, "vault-b"));
  assert.equal(refused.code, VAULT_CONTEXT_MISMATCH);
  const refusedUnscoped = await rejection(secondary.fileUploadStatus(legacySecondary.uploadId));
  assert.equal(refusedUnscoped.code, VAULT_CONTEXT_MISMATCH, "no fallback onto primary state either (SEC-MV06)");
});

// ---------------------------------------------------------------------------
// §13.4 / §21 — the moved state machine keeps its pre-B5 limits and diagnostics
// ---------------------------------------------------------------------------

test("limits, offset, checksum, expiry and idempotent replay behave exactly as before B5", async () => {
  const vaultRuntime = await secondaryVaultRuntime("vault-c");
  const runtime = transferRuntime(vaultRuntime, runtimeDeps({ limits: { maxTransferBytes: 8, chunkBytes: 4, ttlMs: 60_000 } }));

  const tooBig = await rejection(runtime.startFileUpload({ vaultPath: "Notes/x.bin", totalBytes: 9 }, "vault-c"));
  assert.equal(tooBig.message, "totalBytes must be between 0 and 8");
  const protectedPath = await rejection(runtime.startFileUpload({ vaultPath: ".obsidian/app.json", totalBytes: 1 }, "vault-c"));
  assert.equal(protectedPath.message, "File transfer cannot access protected Vault internals");
  const noPath = await rejection(runtime.startFileUpload({ vaultPath: "  ", totalBytes: 1 }, "vault-c"));
  assert.equal(noPath.message, "A file path is required");
  const badDigest = await rejection(runtime.startFileUpload({ vaultPath: "Notes/x.bin", totalBytes: 4, expectedSha256: "nope" }, "vault-c"));
  assert.equal(badDigest.message, "expectedSha256 must be a 64-character hexadecimal SHA-256 digest");

  const started = await runtime.startFileUpload({ vaultPath: "Notes/limits.bin", totalBytes: 8 }, "vault-c");
  assert.equal(started.recommendedChunkBytes, 4);
  const oversized = await rejection(runtime.appendFileUpload({ uploadId: started.uploadId, offset: 0, base64: Buffer.alloc(5, 1).toString("base64") }, "vault-c"));
  assert.equal(oversized.message, "Chunk exceeds TRANSFER_CHUNK_BYTES (4)");
  const wrongOffset = await rejection(runtime.appendFileUpload({ uploadId: started.uploadId, offset: 3, base64: "AAAA" }, "vault-c"));
  assert.equal(wrongOffset.message, "Chunk offset mismatch: expected 0, received 3");
  const notCanonical = await rejection(runtime.appendFileUpload({ uploadId: started.uploadId, offset: 0, base64: "!!!!" }, "vault-c"));
  assert.equal(notCanonical.message, "Chunk is not valid canonical base64");

  const shortLived = transferRuntime(await secondaryVaultRuntime("vault-c2"), runtimeDeps({ limits: { maxTransferBytes: 64, chunkBytes: 8, ttlMs: 1 } }));
  const expiredUpload = await shortLived.startFileUpload({ vaultPath: "Notes/expired.bin", totalBytes: 2 }, "vault-c2");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const expired = await rejection(shortLived.fileUploadStatus(expiredUpload.uploadId, "vault-c2"));
  assert.equal(expired.message, "Upload expired; start a new upload");
  assert.deepEqual(await readdirOrEmpty(shortLived.uploadsRoot), [], "the expired handle is cleaned up");

  // Complete + idempotent replay, per Vault.
  const payload = Buffer.from([1, 2, 3, 4]);
  const fresh = await runtime.startFileUpload({ vaultPath: "Notes/replay.bin", totalBytes: 4 }, "vault-c");
  const first = await runtime.appendFileUpload({ uploadId: fresh.uploadId, offset: 0, base64: payload.toString("base64"), finalize: true }, "vault-c");
  assert.equal(first.complete, true);
  const replay = await runtime.appendFileUpload({ uploadId: fresh.uploadId, offset: 0, base64: payload.toString("base64"), finalize: true }, "vault-c");
  assert.equal(replay.idempotentReplay, true);
  assert.equal((await runtime.fileUploadStatus(fresh.uploadId, "vault-c")).status, "complete");
  const otherVault = transferRuntime(await secondaryVaultRuntime("vault-d"));
  const crossVault = await rejection(otherVault.appendFileUpload({ uploadId: fresh.uploadId, offset: 0, base64: payload.toString("base64"), finalize: true }, "vault-d"));
  assert.equal(crossVault.code, UPLOAD_NOT_FOUND);
});

test("a cancelled upload is gone and reports UPLOAD_NOT_FOUND afterwards", async () => {
  const runtime = transferRuntime(await secondaryVaultRuntime("vault-e"));
  const started = await runtime.startFileUpload({ vaultPath: "Notes/cancel.bin", totalBytes: 4 }, "vault-e");
  assert.deepEqual(await runtime.cancelFileUpload(started.uploadId, "vault-e"), { uploadId: started.uploadId, cancelled: true });
  assert.deepEqual(await readdirOrEmpty(runtime.uploadsRoot), []);
  const gone = await rejection(runtime.fileUploadStatus(started.uploadId, "vault-e"));
  assert.equal(gone.code, UPLOAD_NOT_FOUND);
});

// ---------------------------------------------------------------------------
// Factory contract (fail closed) + shared path guard
// ---------------------------------------------------------------------------

test("the factory fails closed on incomplete wiring instead of guessing a root or a limit", async () => {
  const vaultRuntime = await secondaryVaultRuntime("vault-f");
  for (const deps of [undefined, {}, { limits: { maxTransferBytes: 1, chunkBytes: 1 } }, { limits: { maxTransferBytes: 0, chunkBytes: 1, ttlMs: 1 } }, runtimeDeps({ protectedRoots: [".git"] })]) {
    const error = await rejection(Promise.resolve().then(() => createTransferRuntime({ vaultRuntime, deps })));
    assert.equal(error.code, "TRANSFER_RUNTIME_INVALID", `deps ${JSON.stringify(deps)} must be rejected`);
  }
  const noRoots = await rejection(Promise.resolve().then(() => createTransferRuntime({ vaultRuntime: { id: "x", primary: false, localFs: {} }, deps: runtimeDeps() })));
  assert.equal(noRoots.code, "TRANSFER_RUNTIME_INVALID");
  const badRuntime = await rejection(Promise.resolve().then(() => createTransferRuntime({ vaultRuntime: { id: "", primary: false, paths: {}, localFs: {} }, deps: runtimeDeps() })));
  assert.equal(badRuntime.code, "TRANSFER_RUNTIME_INVALID");
  const guard = await rejection(Promise.resolve().then(() => assertTransferVaultPath("Notes/x.bin", {})));
  assert.equal(guard.code, "TRANSFER_RUNTIME_INVALID");
});

test("the shared transfer path guard keeps its pre-B5 prose and resolves inside the given Vault", async () => {
  const vaultRuntime = await secondaryVaultRuntime("vault-g");
  const context = { localFs: vaultRuntime.localFs, protectedRoots: PROTECTED_ROOTS };
  assert.throws(() => assertTransferVaultPath("", context), /A file path is required/);
  assert.throws(() => assertTransferVaultPath(".git/config", context), /protected Vault internals/);
  assert.throws(() => assertTransferVaultPath("../outside.bin", context), /traversal|inside the Vault root/i);
  assert.equal(assertTransferVaultPath("Notes/ok.bin", context), path.join(vaultRuntime.root, "Notes", "ok.bin"));
});

test("the runtime instance exposes exactly the frozen B5 seam and holds no module-level state", async () => {
  const runtime = transferRuntime(await secondaryVaultRuntime("vault-h"));
  assert.deepEqual(Object.keys(runtime), [
    "vaultId", "uploadsRoot", "primary", "limits",
    "startFileUpload", "appendFileUpload", "fileUploadStatus", "cancelFileUpload",
  ]);
  assert.equal(runtime.vaultId, "vault-h");
  assert.equal(runtime.primary, false);
  assert.deepEqual(runtime.limits, LIMITS);

  const source = await fs.readFile(RUNTIME_MODULE, "utf8");
  const lines = source.split("\n").length;
  assert.ok(lines > 100 && lines <= 500, `module must stay inside the line gate, saw ${lines}`);
  assert.match(source, /export function createTransferRuntime\(/, "positive control: the factory must stay exported");
  assert.match(source, /export const VAULT_CONTEXT_MISMATCH = "VAULT_CONTEXT_MISMATCH";/, "positive control: the stable code must stay exported");

  // Comments may *name* the globals this module must not use, so scan the blanked code (line
  // structure preserved) exactly like the W0-A / B3 scanners do.
  const code = blankCommentsAndStrings(source);
  assert.equal(code.split("\n").length, lines, "the purity scanner must preserve line structure");
  assert.equal(code.includes("process.env"), false, "a Vault-dependent module must not read the environment");
  const specifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]);
  for (const specifier of specifiers) {
    assert.ok(!/(^|\/)config\.js$/.test(specifier), `the facade injects tunables; the runtime must not import config.js (got ${specifier})`);
    assert.notEqual(specifier, "node:process");
  }
  for (const constant of ["DATA_PATH", "VAULT", "HISTORY_PATH", "TRASH_PATH", "RETRIEVAL_INDEX_PATH", "UPLOADS_PATH"]) {
    assert.equal(new RegExp(`\\b${constant}\\b`).test(code), false, `${constant} must not be referenced by the per-Vault runtime (§43-5)`);
  }
  const moduleScope = code.split("\n").filter((line) => /^(?:export\s+)?(?:let|var)\s/.test(line)
    || /^(?:export\s+)?const\s+\w+\s*=\s*(?:new\s+(?:Map|Set|WeakMap|WeakSet|Array)\b|\[|\{)/.test(line));
  assert.deepEqual(moduleScope, [], `no module-level mutable state (§43-7, SEC-MV07): ${moduleScope.join(" | ")}`);

  // Scanner self-proof: the same assertions do fire on a fixture that violates them.
  const fixture = ['import { DATA_PATH } from "../config.js";', "let cache = new Map();", "const x = process.env.DATA_PATH;", ""].join("\n");
  const fixtureCode = blankCommentsAndStrings(fixture);
  assert.equal(fixtureCode.split("\n").length, 4, "the scanner must preserve line structure");
  assert.equal(fixtureCode.includes("process.env"), true);
  assert.equal(/\bDATA_PATH\b/.test(fixtureCode), true);
  assert.equal(/^(?:let|var)\s/m.test(fixtureCode), true);
  assert.equal(/from\s*["'][^"']*config\.js["']/.test(fixture), true);
});
