// Root-scoped secure note reader for the Web Catalog.
//
// obsidian.readNote() is bound to the primary VAULT: readLimitedText(),
// fileRevision() and toVaultPath() all use the global root, so a secondary Web
// Vault (a sibling under WEB_VAULTS_ROOT) cannot use it. This is the equivalent
// reader parameterized by `root`, preserving the canonical/symlink boundary, the
// MAX_READ_BYTES limit, the sha256 revision and malformed-frontmatter degradation
// -- never a bare fs.readFile.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { parseFrontmatter } from "../../frontmatter.js";
import { MAX_READ_BYTES } from "../../config.js";
import { assertCanonicalInsideRoot } from "../../vault.js";
import { toRootRelative } from "./vault-source.js";

async function openCanonicalFileInRoot(root, absPath) {
  const canonicalPath = await assertCanonicalInsideRoot(root, absPath);
  const handle = await fs.open(canonicalPath, "r");
  try {
    // Same dev/ino TOCTOU guard as openCanonicalVaultFile, scoped to this root.
    const opened = await handle.stat({ bigint: true });
    const current = await fs.stat(await assertCanonicalInsideRoot(root, canonicalPath), { bigint: true });
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("Vault path changed during secure open");
    }
    return { handle, canonicalPath };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readBoundedBytes(handle) {
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
  if (total > MAX_READ_BYTES) throw new Error(`File exceeds MAX_READ_BYTES (${total} > ${MAX_READ_BYTES})`);
  return Buffer.concat(chunks, total);
}

export async function readNoteInRoot(root, absPath, options = {}) {
  const { handle, canonicalPath } = await openCanonicalFileInRoot(root, absPath);
  let bytes;
  try {
    bytes = await readBoundedBytes(handle);
  } finally {
    await handle.close();
  }

  const stat = await fs.stat(canonicalPath);
  const raw = bytes.toString("utf8");
  let parsed;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    // Index/search callers may degrade one malformed YAML header to plain
    // Markdown; read/stat/revision failures still propagate.
    if (!options.tolerateMalformedFrontmatter) throw error;
    parsed = { data: {}, content: raw };
  }

  return {
    path: toRootRelative(root, canonicalPath),
    raw,
    content: parsed.content,
    frontmatter: parsed.data,
    revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    stat: { size: stat.size, created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString() },
  };
}

// Root-scoped Base inventory read: canonical containment + bounded bytes + sha256
// revision, but NO Markdown/YAML parsing (a .base never enters the note reader).
export async function readBaseInRoot(root, absPath) {
  const { handle, canonicalPath } = await openCanonicalFileInRoot(root, absPath);
  let bytes;
  try {
    bytes = await readBoundedBytes(handle);
  } finally {
    await handle.close();
  }
  const stat = await fs.stat(canonicalPath);
  return {
    path: toRootRelative(root, canonicalPath),
    revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    stat: { size: stat.size, created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString() },
  };
}
