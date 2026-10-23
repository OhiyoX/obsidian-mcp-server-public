// `src/file-transfer.js` — Vault file transfer, §10.1 compatibility facade for the upload sessions.
//
// Wave B / B5 moved the resumable-upload state machine into
// `vault-runtime/transfer-runtime.js` (one instance per Vault; contract §13.4 "Upload sessions",
// §27 B5, §43-8). This module keeps every legacy export with its exact name/arity/behavior and adds
// three things:
//
//   1. runtime selection — the Vault of the *current* MCP request (`requestContext().vaultId` /
//      `.vaultRuntime`, contract §6) picks the upload runtime. With no declared Vault (today's
//      single-Vault default, and the case before Wave C wires the registrar) the primary runtime is
//      used, i.e. the legacy `DATA_PATH/transfers/uploads` root and the legacy behavior;
//   2. a primary parity ratchet — the primary uploads root must stay the legacy
//      `path.join(DATA_PATH, "transfers", "uploads")` literal (contract §5.1/§22.2); `vault.js` owns
//      the A7 primary mapping and this facade refuses to boot if the two ever drift;
//   3. one shared transfer-path guard — the archive / inline helpers below resolve through the very
//      same guard (`assertTransferVaultPath`) the upload sessions use, now against the *request's*
//      VaultRuntime (Wave D / D-files, contract §10.1): no Vault selection keeps the legacy primary
//      behavior, and a selected Vault without a materialized runtime fails closed (§3.4/§47) instead
//      of silently reading primary storage. The upload-session layer keeps its documented
//      transitional claim semantics (Wave B / B5).
//
// `inspectZipBuffer` now lives in `./archive/zip.js` (issue #254) so that
// inspection and selective reading share one parser; re-exported here with an
// unchanged public shape.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import {
  DATA_PATH,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_INLINE_TRANSFER_BYTES,
  MAX_TRANSFER_BYTES,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_TTL_MS,
} from "./config.js";
import { requestContext } from "./request-context.js";
import { assertWritable, exists, isAcceptedObsidianFile, primaryRuntime } from "./vault.js";
// Wave D / D-files: the root-bound primitives used by the archive + inline-read helpers resolve
// against the request's VaultRuntime (contract §10.1) instead of the primary facade.
import {
  assertCanonicalInsideVault,
  atomicWriteFile,
  currentLocalFs,
  fileRevision,
  resolveVaultPath,
  toVaultPath,
} from "./vault-runtime/request-vault.js";
import { assertTransferVaultPath, createTransferRuntime } from "./vault-runtime/transfer-runtime.js";
import { inspectZipBuffer, safeArchiveEntry } from "./archive/zip.js";

export { inspectZipBuffer };

// §5.1/§22.2: the primary Vault's transfer root is the legacy literal below; `vault.js` derives the
// same value for the A7 primary mapping (`primaryRuntime.paths.transfersUploads`). The parity check
// after the runtime wiring fails closed, because a silent move would orphan every staged upload.
const LEGACY_UPLOADS_PATH = path.join(DATA_PATH, "transfers", "uploads");
const PROTECTED_ROOTS = new Set([".git", ".obsidian"]);

const MIME_TYPES = new Map([
  [".md", "text/markdown"], [".txt", "text/plain"], [".json", "application/json"], [".yaml", "application/yaml"], [".yml", "application/yaml"],
  [".pdf", "application/pdf"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"],
  [".svg", "image/svg+xml"], [".webp", "image/webp"], [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".mp4", "video/mp4"],
  [".zip", "application/zip"], [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const TRANSFER_DEPS = Object.freeze({
  limits: Object.freeze({ maxTransferBytes: MAX_TRANSFER_BYTES, chunkBytes: TRANSFER_CHUNK_BYTES, ttlMs: TRANSFER_TTL_MS }),
  protectedRoots: PROTECTED_ROOTS,
});

const primaryTransferRuntime = createTransferRuntime({ vaultRuntime: primaryRuntime, deps: TRANSFER_DEPS });

if (primaryTransferRuntime.uploadsRoot !== LEGACY_UPLOADS_PATH) {
  throw new Error("[TRANSFER_PRIMARY_PATH_DRIFT] the primary transfer root must stay the legacy DATA_PATH/transfers/uploads path (contract §5.1/§22.2)");
}

// §6 request context: Wave C's registrar injects `vaultId` (+ the resolved `vaultRuntime`) before the
// handler runs. Until then no request carries either, so every call keeps single-Vault primary
// behavior. A declared Vault *without* an injected runtime can only happen while the multi-Vault phase
// is off; it records the caller's claim on the handle (below) and keeps the primary storage, and the
// binding check still applies inside it.
function selectTransferRuntime() {
  const context = requestContext();
  const declaredVaultId = typeof context?.vaultId === "string" && context.vaultId !== "" ? context.vaultId : undefined;
  const vaultRuntime = context?.vaultRuntime;
  if (vaultRuntime === undefined || vaultRuntime === null || vaultRuntime === primaryRuntime) {
    return { declaredVaultId, runtime: primaryTransferRuntime };
  }
  // Instances are stateless (all upload state is on disk), so building one per request is safe and
  // keeps this facade free of module-level mutable state (contract §43-7, SEC-MV07).
  return { declaredVaultId, runtime: createTransferRuntime({ vaultRuntime, deps: TRANSFER_DEPS }) };
}

export async function startFileUpload(input) {
  const { runtime, declaredVaultId } = selectTransferRuntime();
  return runtime.startFileUpload(input, declaredVaultId);
}

export async function appendFileUpload(input) {
  const { runtime, declaredVaultId } = selectTransferRuntime();
  return runtime.appendFileUpload(input, declaredVaultId);
}

export async function fileUploadStatus(uploadId) {
  const { runtime, declaredVaultId } = selectTransferRuntime();
  return runtime.fileUploadStatus(uploadId, declaredVaultId);
}

export async function cancelFileUpload(uploadId) {
  const { runtime, declaredVaultId } = selectTransferRuntime();
  return runtime.cancelFileUpload(uploadId, declaredVaultId);
}

// Archive + inline-read helpers resolve inside the *request's* Vault through the same guard the
// upload sessions use: with no Vault selection they keep the pre-Wave-D primary behaviour, and a
// selected Vault without a materialized runtime fails closed instead of silently reading primary
// storage (§3.4/§47). The upload-session layer above keeps B5's documented transitional semantics.
function assertTransferPath(vaultPath) {
  return assertTransferVaultPath(vaultPath, { localFs: currentLocalFs(), protectedRoots: PROTECTED_ROOTS });
}

export async function pullFile(vaultPath, options = {}) {
  const abs = assertTransferPath(vaultPath);
  await assertCanonicalInsideVault(abs);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error("Path must identify a file");
  const maxBytes = Math.min(options.maxBytes || MAX_INLINE_TRANSFER_BYTES, MAX_TRANSFER_BYTES);
  if (stat.size > maxBytes) throw new Error(`File is ${stat.size} bytes; use get_file base64 chunks (recommended) or explicitly raise maxBytes up to ${MAX_TRANSFER_BYTES}`);
  const buffer = await fs.readFile(abs);
  const rel = toVaultPath(abs);
  const digestValue = sha256(buffer);
  return {
    transfer: {
      path: rel,
      suggestedFilename: path.posix.basename(rel),
      mimeType: MIME_TYPES.get(path.extname(rel).toLowerCase()) || "application/octet-stream",
      encoding: "base64",
      content: buffer.toString("base64"),
      byteLength: buffer.length,
      sha256: digestValue,
      revision: `sha256:${digestValue}`,
      complete: true,
      stat: { size: stat.size, modified: stat.mtime.toISOString(), created: stat.birthtime.toISOString() },
    },
  };
}

// Internal helper shared by `inspectZipFile` and the selective ZIP reader in
// `./archive/zip.js` (issue #254). Exported only so both call sites run the very
// same guard sequence; it is not part of the transfer public API.
export async function openVaultZipArchiveForRead(vaultPath) {
  const absolute = assertTransferPath(vaultPath);
  if (path.extname(absolute).toLowerCase() !== ".zip") throw new Error("Only .zip archives are supported");
  await assertCanonicalInsideVault(absolute);
  const buffer = await fs.readFile(absolute);
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error(`Archive exceeds MAX_ARCHIVE_BYTES (${MAX_ARCHIVE_BYTES})`);
  return { absolute, vaultPath: toVaultPath(absolute), buffer };
}

async function collectFiles(sourcePaths, includeHidden) {
  const files = new Map();
  async function visit(abs, archivePath) {
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (files.has(archivePath)) throw new Error(`Duplicate archive path: ${archivePath}`);
      if (files.size >= MAX_ARCHIVE_ENTRIES) throw new Error(`Archive exceeds MAX_ARCHIVE_ENTRIES (${MAX_ARCHIVE_ENTRIES})`);
      const data = await fs.readFile(abs);
      const currentBytes = [...files.values()].reduce((sum, value) => sum + value.length, 0);
      if (currentBytes + data.length > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error(`Archive input exceeds MAX_ARCHIVE_UNCOMPRESSED_BYTES (${MAX_ARCHIVE_UNCOMPRESSED_BYTES})`);
      files.set(safeArchiveEntry(archivePath), new Uint8Array(data));
      return;
    }
    if (!stat.isDirectory()) return;
    for (const dirent of await fs.readdir(abs, { withFileTypes: true })) {
      if ((!includeHidden && dirent.name.startsWith(".")) || dirent.isSymbolicLink()) continue;
      await visit(path.join(abs, dirent.name), path.posix.join(archivePath, dirent.name));
    }
  }
  for (const sourcePath of sourcePaths) {
    const abs = assertTransferPath(sourcePath);
    await assertCanonicalInsideVault(abs);
    await visit(abs, toVaultPath(abs));
  }
  return files;
}

export async function createZipArchive({ sourcePaths, destination, overwrite = false, includeHidden = false }) {
  assertWritable();
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) throw new Error("sourcePaths must contain at least one Vault file or directory");
  const destinationAbs = assertTransferPath(destination);
  if (path.extname(destinationAbs).toLowerCase() !== ".zip") throw new Error("Archive destination must end in .zip");
  if ((await exists(destinationAbs)) && !overwrite) throw new Error("Archive destination exists. Set overwrite=true to replace it.");
  const files = await collectFiles(sourcePaths, includeHidden);
  files.delete(toVaultPath(destinationAbs));
  if (files.size === 0) throw new Error("No regular files matched the archive sources");
  const archive = Buffer.from(zipSync(Object.fromEntries(files), { level: 6 }));
  const manifest = inspectZipBuffer(archive);
  const written = await atomicWriteFile(destinationAbs, archive);
  return { path: toVaultPath(destinationAbs), ...manifest, sha256: sha256(archive), revision: written.revision };
}

export async function inspectZipFile(vaultPath) {
  const archive = await openVaultZipArchiveForRead(vaultPath);
  return { path: archive.vaultPath, ...inspectZipBuffer(archive.buffer), sha256: sha256(archive.buffer), revision: await fileRevision(archive.absolute) };
}

export async function extractZipArchive({ archivePath, destinationDirectory, overwrite = false, dryRun = true }) {
  assertWritable();
  const archiveAbs = assertTransferPath(archivePath);
  const destinationAbs = destinationDirectory ? assertTransferPath(destinationDirectory) : resolveVaultPath("");
  const canonicalArchive = await assertCanonicalInsideVault(archiveAbs);
  await assertCanonicalInsideVault(destinationAbs, { allowMissing: true });
  const buffer = await fs.readFile(canonicalArchive);
  const manifest = inspectZipBuffer(buffer);
  const plans = manifest.entries.filter((entry) => !entry.directory).map((entry) => {
    const output = path.resolve(destinationAbs, ...entry.path.split("/"));
    const relative = path.relative(destinationAbs, output);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Archive path traversal denied: ${entry.path}`);
    const vaultPath = toVaultPath(output);
    assertTransferPath(vaultPath);
    return { entry: entry.path, output, vaultPath };
  });
  const collisions = [];
  for (const plan of plans) if (await exists(plan.output)) collisions.push(plan.vaultPath);
  if (collisions.length && !overwrite) throw new Error(`Extraction would overwrite ${collisions.length} file(s): ${collisions.slice(0, 10).join(", ")}`);
  if (dryRun) return { archivePath: toVaultPath(archiveAbs), destinationDirectory: toVaultPath(destinationAbs), dryRun: true, ...manifest, collisions, outputs: plans.map((plan) => plan.vaultPath) };
  const extracted = unzipSync(new Uint8Array(buffer));
  const byPath = new Map(Object.entries(extracted).map(([name, data]) => [safeArchiveEntry(name), Buffer.from(data)]));
  for (const plan of plans) {
    const data = byPath.get(plan.entry);
    if (!data) throw new Error(`ZIP decoder did not return expected entry: ${plan.entry}`);
    await atomicWriteFile(plan.output, data);
  }
  return { archivePath: toVaultPath(archiveAbs), destinationDirectory: toVaultPath(destinationAbs), dryRun: false, extracted: plans.length, outputs: plans.map((plan) => plan.vaultPath), collisions };
}
