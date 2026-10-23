// B5 — per-Vault transfer runtime: resumable upload sessions bound to one Vault.
//
// Contract: "DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置"
//   §13.4 upload sessions (metadata carries vaultId; start outputs vaultId; status/chunk/cancel must
//         match the selected Vault and reject *before* any part-file read/write; legacy metadata
//         without vaultId is primary-only)
//   §22.4 legacy plans/uploads (never guess a secondary Vault)
//   §21  MV-I05 handle binding, MV-I06 auth before I/O, MV-I07 primary compatibility
//   §27  B5 transfer runtime, §33/§36.2/§37 test matrix, §42 SEC-MV05/SEC-MV06, §43-8
//   §5.1/§5.2 A7 paths (`transfersUploads`), §6 request context (vaultId + vaultRuntime)
//
// The resumable-upload state machine used to live in `src/file-transfer.js` against ONE
// process-global root (`DATA_PATH/transfers/uploads`) with no Vault identity on the durable handle
// (W0-C §upload: metadata = uploadId/vaultPath/…, no vaultId). Here it becomes a factory: an
// instance is bound to one `VaultRuntime` (B1 seam) and only ever touches
//
//   <vaultRuntime.paths.transfersUploads>/<uploadId>.json   metadata (now carrying `vaultId`)
//   <vaultRuntime.paths.transfersUploads>/<uploadId>.part   payload
//
// so Vault A's handle is invisible from Vault B (§36.2, §37 state isolation).
//
// Constraints honoured on purpose:
//   * no ambient Vault: the root comes from the injected `vaultRuntime.paths`, never from the global
//     `DATA_PATH` / `VAULT` constants, and this module never reads `process.env` (§43-5, §5.3);
//   * no ambient caller either: the caller's declared Vault is an *explicit parameter*, so a handle
//     can never be used to reverse-engineer another Vault (SEC-MV05) and a background caller cannot
//     inherit "whatever request is current" (§5.3, MV-I04);
//   * no module-level mutable state: instances are stateless (all upload state is on disk), so the
//     §43-5 facade may build one per request runtime without caching (§43-7);
//   * tunables (`deps.limits`) and the protected-root policy are injected by the facade, which is the
//     module allowed to read `config.js`; root-free guard helpers come from the B1 `local-fs.js`.
//
// Binding rules — all evaluated BEFORE any part-file read/write (contract §13.4):
//   1. the caller's declared Vault must equal `metadata.vaultId`, else `VAULT_CONTEXT_MISMATCH`;
//   2. legacy metadata written before this lane has no `vaultId`: only the primary Vault may consume
//      it (§22.4) — a secondary instance rejects it instead of guessing;
//   3. an unknown handle fails closed with `UPLOAD_NOT_FOUND` and never falls back to reading another
//      Vault's directory. A handle owned by a *different registered* Vault therefore reads as
//      `UPLOAD_NOT_FOUND` from that Vault (its root does not contain it), which is the same
//      fail-closed outcome §36.2 asks for.
//
// `UPLOAD_NOT_FOUND`/`VAULT_CONTEXT_MISMATCH` messages never echo a foreign Vault id or a filesystem
// path (§42 SEC-MV03 metadata minimization); pre-existing error prose is unchanged.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertWritable, exists, isAcceptedObsidianFile, normalizeVaultInput } from "./local-fs.js";

// Stable error codes; consumers/tests never match on prose.
export const UPLOAD_NOT_FOUND = "UPLOAD_NOT_FOUND";
export const VAULT_CONTEXT_MISMATCH = "VAULT_CONTEXT_MISMATCH";
export const TRANSFER_RUNTIME_INVALID = "TRANSFER_RUNTIME_INVALID";

const TRANSFER_ID = /^[0-9a-f-]{36}$/i;
const LIMIT_KEYS = Object.freeze(["maxTransferBytes", "chunkBytes", "ttlMs"]);
const LOCAL_FS_METHODS = Object.freeze([
  "assertCanonicalInsideVault",
  "atomicWriteFile",
  "resolveVaultPath",
  "toVaultPath",
]);

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === undefined) return "undefined";
  return `${typeof value} ${String(value)}`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Vault-relative transfer path guard, shared by the upload sessions here and by the primary-bound
 * archive/inline helpers of `src/file-transfer.js` (§10.1 compatibility facade). `context.localFs` is
 * the *Vault's* root-bound service, so one guard protects a secondary Vault without re-deriving a
 * root; `context.protectedRoots` is the frozen policy list the facade already declares.
 *
 * Error prose is identical to the pre-B5 body of `file-transfer.js:assertTransferVaultPath`.
 */
export function assertTransferVaultPath(vaultPath, context = {}) {
  const localFs = context.localFs;
  if (localFs === null || typeof localFs !== "object" || typeof localFs.resolveVaultPath !== "function") {
    fail(TRANSFER_RUNTIME_INVALID, `assertTransferVaultPath requires context.localFs.resolveVaultPath (the Vault's root-bound service), got ${describe(localFs)}`);
  }
  const protectedRoots = context.protectedRoots;
  if (!(protectedRoots instanceof Set)) {
    fail(TRANSFER_RUNTIME_INVALID, `assertTransferVaultPath requires context.protectedRoots to be a Set, got ${describe(protectedRoots)}`);
  }
  const normalized = normalizeVaultInput(vaultPath);
  const first = normalized.split("/")[0]?.toLowerCase();
  if (!normalized) throw new Error("A file path is required");
  if (protectedRoots.has(first)) throw new Error("File transfer cannot access protected Vault internals");
  return localFs.resolveVaultPath(normalized);
}

/** `null`/`undefined` = the caller declared no Vault (legacy/unscoped call). Anything else must be a usable id. */
function declaredVaultOf(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value === "") {
    fail(VAULT_CONTEXT_MISMATCH, `the selected Vault is not a usable vaultId, got ${describe(value)}`);
  }
  return value;
}

/** Binding rule 1/2 (§13.4, §22.4); called with the parsed metadata only, never with part-file state. */
function assertVaultBinding(metadata, declared, primary) {
  const bound = typeof metadata?.vaultId === "string" && metadata.vaultId !== "" ? metadata.vaultId : null;
  if (bound === null) {
    if (!primary) {
      fail(VAULT_CONTEXT_MISMATCH, "legacy upload metadata without vaultId may only be consumed by the primary Vault (contract §22.4)");
    }
    return;
  }
  if (declared !== undefined && declared !== bound) {
    fail(VAULT_CONTEXT_MISMATCH, `upload ${metadata.uploadId} is not bound to the selected Vault (contract §13.4); restart the upload against the Vault you are writing to`);
  }
}

function resolveLimits(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(TRANSFER_RUNTIME_INVALID, `deps.limits must be an object, got ${describe(value)}`);
  }
  const invalid = LIMIT_KEYS.filter((key) => !Number.isInteger(value[key]) || value[key] <= 0);
  if (invalid.length > 0) {
    fail(TRANSFER_RUNTIME_INVALID, `deps.limits must declare every key as a positive integer (${LIMIT_KEYS.join(", ")}); invalid: ${invalid.join(", ")}`);
  }
  return Object.freeze({ maxTransferBytes: value.maxTransferBytes, chunkBytes: value.chunkBytes, ttlMs: value.ttlMs });
}

function resolveVaultRuntime(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(TRANSFER_RUNTIME_INVALID, `vaultRuntime must be a B1 createVaultRuntime result, got ${describe(value)}`);
  }
  if (typeof value.id !== "string" || value.id === "") {
    fail(TRANSFER_RUNTIME_INVALID, `vaultRuntime.id must be a non-empty string, got ${describe(value.id)}`);
  }
  if (typeof value.primary !== "boolean") {
    fail(TRANSFER_RUNTIME_INVALID, `vaultRuntime.primary must be a boolean, got ${describe(value.primary)}`);
  }
  const uploadsRoot = value.paths?.transfersUploads;
  if (typeof uploadsRoot !== "string" || uploadsRoot === "") {
    fail(TRANSFER_RUNTIME_INVALID, "vaultRuntime.paths.transfersUploads must be the A7 per-Vault uploads root (contract §5.1/§5.2)");
  }
  const localFs = value.localFs;
  if (localFs === null || typeof localFs !== "object") {
    fail(TRANSFER_RUNTIME_INVALID, `vaultRuntime.localFs must be the B1 root-bound service, got ${describe(localFs)}`);
  }
  const missing = LOCAL_FS_METHODS.filter((name) => typeof localFs[name] !== "function");
  if (missing.length > 0) {
    fail(TRANSFER_RUNTIME_INVALID, `vaultRuntime.localFs is missing ${missing.join(", ")}`);
  }
  return { vaultId: value.id, primary: value.primary, uploadsRoot, localFs };
}

/**
 * `createTransferRuntime({ vaultRuntime, deps })` → frozen, stateless per-Vault upload instance.
 *
 *   vaultRuntime        B1 `createVaultRuntime` result. Uses `.id`, `.primary`,
 *                       `.paths.transfersUploads` (A7) and `.localFs` — nothing else identifies the
 *                       Vault, and no global path constant is ever consulted.
 *   deps.limits         REQUIRED `{ maxTransferBytes, chunkBytes, ttlMs }` (positive integers). The
 *                       facade injects the `config.js` values; there is no silent default, so a
 *                       per-Vault limit cannot drift from the process default unnoticed.
 *   deps.protectedRoots REQUIRED `Set<string>` — Vault-internal roots a transfer may never touch.
 *
 * Every session method takes the caller's declared Vault as an explicit trailing argument
 * (`undefined` = unscoped legacy call). See the binding rules at the top of this file.
 */
export function createTransferRuntime({ vaultRuntime, deps = {} } = {}) {
  const vault = resolveVaultRuntime(vaultRuntime);
  const limits = resolveLimits(deps?.limits);
  const protectedRoots = deps?.protectedRoots;
  if (!(protectedRoots instanceof Set)) {
    fail(TRANSFER_RUNTIME_INVALID, `deps.protectedRoots must be a Set, got ${describe(protectedRoots)}`);
  }
  const vaultId = vault.vaultId;
  const uploadsRoot = vault.uploadsRoot;
  const localFs = vault.localFs;
  const primary = vault.primary;

  function uploadPaths(uploadId) {
    if (!TRANSFER_ID.test(uploadId)) throw new Error("Invalid uploadId");
    return {
      metadata: path.join(uploadsRoot, `${uploadId}.json`),
      part: path.join(uploadsRoot, `${uploadId}.part`),
    };
  }

  function transferPath(vaultPath) {
    return assertTransferVaultPath(vaultPath, { localFs, protectedRoots });
  }

  async function writeJsonAtomic(target, value) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, target);
  }

  async function readUpload(uploadId, declared) {
    const paths = uploadPaths(uploadId);
    let source;
    try {
      source = await fs.readFile(paths.metadata, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") fail(UPLOAD_NOT_FOUND, `Unknown uploadId ${uploadId}; it may have been cancelled or expired`);
      throw error;
    }
    const metadata = JSON.parse(source);
    // §13.4: the Vault check runs before the expiry cleanup, so a mismatched caller can never cause
    // a part-file unlink (or read) in a Vault it did not select.
    assertVaultBinding(metadata, declared, primary);
    if (Date.parse(metadata.expiresAt) <= Date.now()) {
      await Promise.allSettled([fs.rm(paths.metadata, { force: true }), fs.rm(paths.part, { force: true })]);
      throw new Error("Upload expired; start a new upload");
    }
    return { paths, metadata };
  }

  async function removeUpload(paths) {
    await Promise.allSettled([fs.rm(paths.metadata, { force: true }), fs.rm(paths.part, { force: true })]);
  }

  async function startFileUpload(input = {}, declaredVaultId) {
    const declared = declaredVaultOf(declaredVaultId);
    const { vaultPath, totalBytes, expectedSha256, overwrite = false, acceptedOnly = false } = input;
    assertWritable();
    if (totalBytes < 0 || totalBytes > limits.maxTransferBytes) throw new Error(`totalBytes must be between 0 and ${limits.maxTransferBytes}`);
    const destination = transferPath(vaultPath);
    if (acceptedOnly && !isAcceptedObsidianFile(destination)) throw new Error("The destination extension is not an Obsidian-supported attachment type");
    if ((await exists(destination)) && !overwrite) throw new Error("Destination exists. Set overwrite=true to replace it.");
    if (expectedSha256 && !/^[0-9a-f]{64}$/i.test(expectedSha256)) throw new Error("expectedSha256 must be a 64-character hexadecimal SHA-256 digest");
    await fs.mkdir(uploadsRoot, { recursive: true });
    const uploadId = randomUUID();
    const paths = uploadPaths(uploadId);
    const metadata = {
      uploadId,
      // The durable handle binds to the Vault the caller selected; an unscoped legacy call binds to
      // the runtime it actually writes through (today: the primary Vault). §13.4.
      vaultId: declared ?? vaultId,
      vaultPath: localFs.toVaultPath(destination),
      totalBytes,
      uploadedBytes: 0,
      expectedSha256: expectedSha256?.toLowerCase(),
      overwrite,
      acceptedOnly,
      status: "uploading",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + limits.ttlMs).toISOString(),
    };
    await fs.writeFile(paths.part, Buffer.alloc(0), { mode: 0o600 });
    await writeJsonAtomic(paths.metadata, metadata);
    return { ...metadata, recommendedChunkBytes: limits.chunkBytes };
  }

  async function appendFileUpload(input = {}, declaredVaultId) {
    const declared = declaredVaultOf(declaredVaultId);
    const { uploadId, offset, base64, finalize = false } = input;
    assertWritable();
    const { paths, metadata } = await readUpload(uploadId, declared);
    const chunk = Buffer.from(base64 || "", "base64");
    const canonicalBase64 = chunk.toString("base64").replace(/=+$/, "");
    if (canonicalBase64 !== String(base64 || "").replace(/\s/g, "").replace(/=+$/, "")) throw new Error("Chunk is not valid canonical base64");
    if (metadata.status === "complete") {
      if (finalize && offset === metadata.lastChunkOffset && chunk.length === metadata.lastChunkBytes && sha256(chunk) === metadata.lastChunkSha256) return { ...metadata.result, idempotentReplay: true };
      throw new Error("Upload is already complete; use file_upload_status to retrieve the result");
    }
    if (offset !== metadata.uploadedBytes) throw new Error(`Chunk offset mismatch: expected ${metadata.uploadedBytes}, received ${offset}`);
    if (chunk.length > limits.chunkBytes) throw new Error(`Chunk exceeds TRANSFER_CHUNK_BYTES (${limits.chunkBytes})`);
    if (metadata.uploadedBytes + chunk.length > metadata.totalBytes) throw new Error("Chunk exceeds declared totalBytes");
    await fs.appendFile(paths.part, chunk);
    metadata.uploadedBytes += chunk.length;
    metadata.expiresAt = new Date(Date.now() + limits.ttlMs).toISOString();
    await writeJsonAtomic(paths.metadata, metadata);
    if (!finalize) return { uploadId, uploadedBytes: metadata.uploadedBytes, totalBytes: metadata.totalBytes, complete: false, nextOffset: metadata.uploadedBytes };
    if (metadata.uploadedBytes !== metadata.totalBytes) throw new Error(`Cannot finalize: uploaded ${metadata.uploadedBytes} of ${metadata.totalBytes} bytes`);
    const data = await fs.readFile(paths.part);
    const actualSha256 = sha256(data);
    if (metadata.expectedSha256 && actualSha256 !== metadata.expectedSha256) throw new Error(`SHA-256 mismatch: expected ${metadata.expectedSha256}, received ${actualSha256}`);
    const destination = transferPath(metadata.vaultPath);
    if ((await exists(destination)) && !metadata.overwrite) throw new Error("Destination now exists. Start a new upload with overwrite=true to replace it.");
    const written = await localFs.atomicWriteFile(destination, data);
    const result = { uploadId, path: metadata.vaultPath, complete: true, size: data.length, sha256: actualSha256, revision: written.revision };
    metadata.status = "complete";
    metadata.completedAt = new Date().toISOString();
    metadata.lastChunkOffset = offset;
    metadata.lastChunkBytes = chunk.length;
    metadata.lastChunkSha256 = sha256(chunk);
    metadata.result = result;
    await writeJsonAtomic(paths.metadata, metadata);
    await fs.rm(paths.part, { force: true });
    return result;
  }

  async function fileUploadStatus(uploadId, declaredVaultId) {
    const declared = declaredVaultOf(declaredVaultId);
    const { metadata } = await readUpload(uploadId, declared);
    return {
      uploadId,
      // Additive (contract §13.4): the handle's own binding, so a caller can repeat the same vaultId.
      vaultId: metadata.vaultId ?? null,
      path: metadata.vaultPath,
      status: metadata.status || "uploading",
      uploadedBytes: metadata.uploadedBytes,
      totalBytes: metadata.totalBytes,
      nextOffset: metadata.uploadedBytes,
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt,
      completedAt: metadata.completedAt || null,
      result: metadata.result || null,
    };
  }

  async function cancelFileUpload(uploadId, declaredVaultId) {
    const declared = declaredVaultOf(declaredVaultId);
    assertWritable();
    const { paths, metadata } = await readUpload(uploadId, declared);
    if (metadata.status === "complete") return { uploadId, cancelled: false, complete: true, result: metadata.result };
    await removeUpload(paths);
    return { uploadId, cancelled: true };
  }

  return Object.freeze({
    vaultId,
    uploadsRoot,
    primary,
    limits,
    startFileUpload,
    appendFileUpload,
    fileUploadStatus,
    cancelFileUpload,
  });
}
