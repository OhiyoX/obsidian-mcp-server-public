// Root-scoped safe Base reader for the Web Base read API (A3 HTTP contract).
//
// Contract TODO §7: mirrors web-catalog/note-reader.js security semantics without
// reusing its Markdown parsing:
//   - canonical path containment via assertCanonicalInsideRoot;
//   - final AND intermediate symlinks are rejected (the Web Catalog skips
//     symlinks, so a directly-opened symlink must fail closed rather than read an
//     alias the Explorer would never show);
//   - bounded read with the shared MAX_READ_BYTES budget;
//   - sha256(bytes) revision and stat;
//   - UTF-8 text only.
//
// This module deliberately performs NO YAML parsing and NO schema validation.
// base-route.js applies its injected parse/evaluate dependencies; keeping the
// reader dumb avoids a second Base semantic implementation (WB-01).
//
// Errors are BaseReaderError with a `code` the route maps to HTTP:
//   BASE_PATH_INVALID -> 404   BASE_NOT_FOUND -> 404   BASE_NOT_A_FILE -> 404
//   BASE_ESCAPE       -> 404   BASE_TOO_LARGE -> 413   (unknown IO -> 500)
//
// Canvas (.canvas document, G11) reads through the SAME implementation:
// `readTextFileInRoot` is the one root-scoped safe read, parameterised by the
// extension/label/code prefix, and `readBaseInRoot` is its `.base` binding. A
// second reader would be a second place for the containment/symlink rules to
// drift, so the canvas route composes this function instead of re-implementing
// it (RECON §4 刀2 ①).
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_READ_BYTES } from "../config.js";
import { assertCanonicalInsideRoot } from "../vault.js";
import { toRootRelative } from "./web-catalog/vault-source.js";

const DRIVE_LETTER = /^[A-Za-z]:/;

// One code per failure mode, namespaced by the reader (BASE_* today, CANVAS_*
// for the .canvas binding) so a route can map a failure to a status without
// guessing which document kind produced it.
function readerCodes(codePrefix) {
  return {
    pathInvalid: `${codePrefix}_PATH_INVALID`,
    notFound: `${codePrefix}_NOT_FOUND`,
    notAFile: `${codePrefix}_NOT_A_FILE`,
    escape: `${codePrefix}_ESCAPE`,
    tooLarge: `${codePrefix}_TOO_LARGE`,
  };
}

export class BaseReaderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BaseReaderError";
    this.code = code;
  }
}

function invalid(message, code) {
  return new BaseReaderError(message, code);
}

function mapFsError(error, fallbackCode, codes, label) {
  if (error instanceof BaseReaderError) return error;
  if (error?.code === "ENOENT") return new BaseReaderError(`${label} file not found`, codes.notFound);
  if (error?.code === "EISDIR") return new BaseReaderError(`${label} path is not a file`, codes.notAFile);
  const message = String(error?.message || "");
  if (/Symbolic link escapes|Path traversal denied/i.test(message)) {
    return new BaseReaderError(`${label} path is not accessible`, codes.escape);
  }
  if (fallbackCode) return new BaseReaderError(`${label} path is not accessible`, fallbackCode);
  return error;
}

// Rejects absolute paths, traversal segments and a non-matching extension before
// any filesystem access, so the route can answer 404 without leaking existence.
function assertLogicalPath(relPath, { extension, codes, label }) {
  if (typeof relPath !== "string" || relPath === "") throw invalid(`${label} path is required`, codes.pathInvalid);
  if (relPath.includes("\0")) throw invalid(`${label} path is invalid`, codes.pathInvalid);
  if (relPath.startsWith("/") || DRIVE_LETTER.test(relPath)) throw invalid(`${label} path must be vault-relative`, codes.pathInvalid);
  if (relPath.includes("\\")) throw invalid(`${label} path must use '/' separators`, codes.pathInvalid);
  if (relPath.endsWith("/") || relPath.includes("//")) throw invalid(`${label} path is invalid`, codes.pathInvalid);
  for (const segment of relPath.split("/")) {
    if (segment === "." || segment === "..") throw invalid(`${label} path must not contain traversal segments`, codes.pathInvalid);
  }
  if (!relPath.toLowerCase().endsWith(extension)) throw invalid(`Only ${extension} files are supported`, codes.pathInvalid);
  return relPath;
}

async function assertNoSymlinkSegments(root, relPath, codes, label) {
  let probe = root;
  for (const segment of relPath.split("/")) {
    probe = path.join(probe, segment);
    let stat;
    try {
      stat = await fs.lstat(probe);
    } catch (error) {
      throw mapFsError(error, null, codes, label);
    }
    if (stat.isSymbolicLink()) throw new BaseReaderError(`${label} path must not use symbolic links`, codes.escape);
  }
}

/**
 * The one root-scoped safe read, shared by every document kind that must be read
 * as text inside the Vault root. Options select the document kind:
 *   extension   the only suffix the logical-path gate accepts (e.g. ".base")
 *   label       the human label used in error messages (e.g. "Base")
 *   codePrefix  the error-code namespace (BASE_* / CANVAS_*)
 */
export async function readTextFileInRoot(vault, relPath, options = {}) {
  const extension = typeof options.extension === "string" && options.extension ? options.extension : ".base";
  const label = typeof options.label === "string" && options.label ? options.label : "Base";
  const codes = readerCodes(typeof options.codePrefix === "string" && options.codePrefix ? options.codePrefix : "BASE");
  if (!vault || typeof vault.root !== "string" || vault.root === "") throw invalid("Vault root is required", codes.pathInvalid);
  assertLogicalPath(relPath, { extension, codes, label });
  const root = path.resolve(vault.root);
  const absolute = path.resolve(root, ...relPath.split("/"));
  const relativeCheck = path.relative(root, absolute);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    throw invalid(`${label} path escapes the vault`, codes.escape);
  }

  // Canonical containment runs first so an escaping symlink is rejected before any
  // external stat/read; the lstat walk then rejects within-vault aliases too.
  let canonicalPath;
  try {
    canonicalPath = await assertCanonicalInsideRoot(root, absolute);
  } catch (error) {
    throw mapFsError(error, codes.escape, codes, label);
  }
  await assertNoSymlinkSegments(root, relPath, codes, label);

  let stat;
  try {
    stat = await fs.stat(canonicalPath);
  } catch (error) {
    throw mapFsError(error, null, codes, label);
  }
  if (!stat.isFile()) throw invalid(`${label} path is not a file`, codes.notAFile);

  const handle = await fs.open(canonicalPath, "r");
  let bytes;
  try {
    // Same dev/ino TOCTOU guard as the note reader, scoped to this root.
    const opened = await handle.stat({ bigint: true });
    const current = await fs.stat(await assertCanonicalInsideRoot(root, canonicalPath), { bigint: true });
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new BaseReaderError(`${label} file changed during secure open`, codes.notFound);
    }
    const limit = MAX_READ_BYTES + 1;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit));
    const chunks = [];
    let total = 0;
    while (total < limit) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - total), total);
      if (!bytesRead) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }
    if (total > MAX_READ_BYTES) throw new BaseReaderError(`${label} file exceeds the read limit`, codes.tooLarge);
    bytes = Buffer.concat(chunks, total);
  } finally {
    await handle.close().catch(() => {});
  }

  const finalStat = await fs.stat(canonicalPath);
  return {
    path: toRootRelative(root, canonicalPath),
    raw: bytes.toString("utf8"),
    revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    stat: {
      size: finalStat.size,
      created: finalStat.birthtime.toISOString(),
      modified: finalStat.mtime.toISOString(),
    },
  };
}

/** The `.base` binding of the shared reader. */
export function readBaseInRoot(vault, relPath) {
  return readTextFileInRoot(vault, relPath, { extension: ".base", label: "Base", codePrefix: "BASE" });
}
