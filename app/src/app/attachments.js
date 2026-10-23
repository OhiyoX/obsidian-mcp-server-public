import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  assertCanonicalInsideRoot,
  exists,
  isAcceptedObsidianFile,
  normalizeVaultInput,
} from "../vault.js";
import { VAULT } from "../config.js";

const INLINE_TYPES = new Map([
  [".avif", "image/avif"], [".bmp", "image/bmp"], [".gif", "image/gif"],
  [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".png", "image/png"],
  [".svg", "image/svg+xml"], [".webp", "image/webp"],
  [".flac", "audio/flac"], [".m4a", "audio/mp4"], [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"], [".ogg", "audio/ogg"], [".wav", "audio/wav"],
  [".m4v", "video/x-m4v"], [".mov", "video/quicktime"], [".mp4", "video/mp4"],
  [".ogv", "video/ogg"], [".webm", "video/webm"], [".pdf", "application/pdf"],
]);

function cleanTarget(value) {
  let target = String(value || "").trim();
  try { target = decodeURIComponent(target); } catch {}
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  target = target.split("#", 1)[0].split("?", 1)[0].trim();
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) throw new Error("Invalid local attachment target");
  const normalized = normalizeVaultInput(target);
  if (!normalized || normalized.startsWith("../") || normalized.split("/").some((part) => part.startsWith("."))) throw new Error("Protected attachment path");
  if (path.posix.extname(normalized).toLowerCase() === ".md" || !isAcceptedObsidianFile(normalized)) throw new Error("Unsupported attachment type");
  return normalized;
}

function commonDepth(left, right) {
  const a = path.posix.dirname(left).split("/");
  const b = path.posix.dirname(right).split("/");
  let depth = 0;
  while (depth < a.length && depth < b.length && a[depth].toLocaleLowerCase() === b[depth].toLocaleLowerCase()) depth += 1;
  return depth;
}

const rootPath = (root, value) => path.resolve(root, ...normalizeVaultInput(value).split("/"));
const toRootPath = (root, absolute) => path.relative(root, absolute).split(path.sep).join("/");

async function matchingFiles(root, wanted, maxEntries = 10_000) {
  const matches = [];
  let visited = 0;
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (visited >= maxEntries || entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      visited += 1;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.toLocaleLowerCase() === wanted) matches.push({ path: toRootPath(root, absolute), absolute });
    }
  }
  await visit(root);
  return matches;
}

export async function resolveWebAttachment(targetValue, sourceNote = "", vaultRoot = VAULT) {
  const target = cleanTarget(targetValue);
  const sourcePath = normalizeVaultInput(sourceNote || "");
  const sourceDirectory = sourcePath ? path.posix.dirname(sourcePath) : "";
  const direct = [];
  if (sourceDirectory && sourceDirectory !== ".") direct.push(path.posix.normalize(path.posix.join(sourceDirectory, target)));
  direct.push(path.posix.normalize(target));
  for (const candidate of [...new Set(direct)]) {
    if (candidate.startsWith("../") || candidate.split("/").some((part) => part.startsWith("."))) continue;
    const absolute = rootPath(vaultRoot, candidate);
    if (!(await exists(absolute))) continue;
    await assertCanonicalInsideRoot(vaultRoot, absolute);
    const stat = await fs.stat(absolute);
    if (stat.isFile()) return { path: toRootPath(vaultRoot, absolute), absolute, stat, contentType: INLINE_TYPES.get(path.extname(absolute).toLowerCase()) || "application/octet-stream" };
  }

  const wanted = path.posix.basename(target).toLocaleLowerCase();
  const matches = (await matchingFiles(vaultRoot, wanted)).filter((entry) => isAcceptedObsidianFile(entry.path) && path.posix.extname(entry.path).toLowerCase() !== ".md");
  const selected = matches.sort((left, right) => commonDepth(right.path, sourcePath) - commonDepth(left.path, sourcePath) || left.path.length - right.path.length || left.path.localeCompare(right.path))[0];
  if (!selected) throw Object.assign(new Error("Attachment not found"), { code: "ENOENT" });
  const absolute = selected.absolute;
  await assertCanonicalInsideRoot(vaultRoot, absolute);
  return { path: selected.path, absolute, stat: await fs.stat(absolute), contentType: INLINE_TYPES.get(path.extname(absolute).toLowerCase()) || "application/octet-stream" };
}

export function attachmentHeaders(attachment) {
  const filename = path.basename(attachment.absolute).replace(/[\r\n"]/g, "_");
  return {
    "Content-Type": attachment.contentType,
    "Content-Disposition": `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  };
}

// --- Web asset upload (U30 contract A2/A3) -------------------------------------------
//
// Write-side whitelist, deliberately narrower than `INLINE_TYPES`: `.svg` is excluded
// because the read route serves it as `image/svg+xml`, and `nosniff` cannot stop a direct
// navigation to a same-origin SVG from executing embedded script against the session
// (stored XSS). `.avif`/`.bmp` and the audio/video entries stay read-only for the same
// reason: each needs its own content-sniffing and display decision.
export const WEB_ASSET_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const MAX_ASSET_NAME_ATTEMPTS = 1000;
const MAX_ASSET_STEM_LENGTH = 120;
// Contract A2 rule 3: the characters Obsidian itself cannot carry in an attachment name,
// plus C0/C1 control characters.
const ASSET_RESERVED = /[\\/:*?"<>|[\]^]|[\u0000-\u001f\u007f]/g;

const assetError = (status, message) => Object.assign(new Error(message), { status });
const invalidAssetName = () => assetError(400, "Invalid file name");
const invalidAssetPath = () => assetError(400, "Invalid Vault path");
const unsupportedAssetType = () => assetError(415, "Unsupported image type");

/**
 * True for anything that must not be treated as a Vault-relative path: absolute paths
 * (POSIX, Windows drive, UNC), NUL bytes, `..` traversal and dot-prefixed segments
 * (`.obsidian/`, `.trash/`, `.git/`). Checked on the *raw* value because
 * `normalizeVaultInput` silently strips leading slashes.
 */
function isUnsafeVaultPath(raw) {
  const value = String(raw ?? "");
  if (!value.trim() || value.includes("\0")) return true;
  if (/^[/\\]/.test(value) || /^[a-zA-Z]:[/\\]/.test(value)) return true;
  const normalized = normalizeVaultInput(value);
  if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return true;
  return normalized.split("/").some((part) => part.startsWith("."));
}

/**
 * Magic-number sniffing for the write whitelist. Returns the detected MIME or `null`.
 * A file name is only accepted when its extension *and* its bytes agree (contract A2),
 * so a text file renamed to `.png` is rejected instead of being stored as a lie.
 */
export function sniffImageType(body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? []);
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const header = bytes.subarray(0, 6).toString("latin1");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/**
 * Contract A2 "文件名清洗（定论，服务端权威）". Returns `{ stem, extension, contentType }`.
 * Throws 400 for an unusable name and 415 for an extension outside the whitelist.
 */
export function cleanAssetName(value) {
  const raw = String(value ?? "");
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw invalidAssetName();
  }
  if (!decoded || decoded.includes("\0") || decoded.includes("/") || decoded.includes("\\") || decoded.includes("..") || decoded.startsWith(".")) throw invalidAssetName();
  const extension = path.posix.extname(decoded).toLowerCase();
  if (!WEB_ASSET_TYPES.has(extension)) throw unsupportedAssetType();
  const stem = decoded
    .slice(0, decoded.length - extension.length)
    .normalize("NFC")
    .replace(ASSET_RESERVED, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, MAX_ASSET_STEM_LENGTH)
    .replace(/[\s.]+$/g, "");
  return {
    stem: !stem || /^-+$/.test(stem) ? "image" : stem,
    extension,
    contentType: WEB_ASSET_TYPES.get(extension),
  };
}

/**
 * Resolves the optional `?from=` context note. It never changes the destination
 * directory: it is used for the returned `url` (so the read route can take its direct
 * `dirname(from)/target` branch instead of the bounded whole-Vault scan) and for audit.
 * A missing note is a 404 rather than a silent fallback to the Vault root.
 */
async function resolveAssetSource(vault, from) {
  const requested = String(from ?? "").trim();
  if (!requested) return null;
  if (isUnsafeVaultPath(requested)) throw invalidAssetPath();
  const normalized = normalizeVaultInput(requested);
  if (path.posix.extname(normalized).toLowerCase() !== ".md") throw invalidAssetPath();
  const absolute = path.resolve(vault.root, ...normalized.split("/"));
  await assertCanonicalInsideRoot(vault.root, absolute, { allowMissing: true });
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) throw Object.assign(new Error("Attachment source note not found"), { code: "ENOENT" });
  return normalized;
}

/**
 * Writes a validated image into the Vault's attachment folder.
 *
 * Contract A3 safety chain: Vault comes from `currentVault(req)` only (never the body),
 * the caller has already run `assertWritable()`, and every filesystem step is confined to
 * `vault.root` through `assertCanonicalInsideRoot` (the root-parameterized equivalent of
 * `ensureVaultParent`'s two passes around the mkdir), so a symlinked `attachments/` cannot
 * escape the Vault. Existing files are never overwritten: the write uses exclusive (`wx`)
 * creation and falls back to `-1`, `-2`, ... before giving up with 409.
 */
export async function writeWebAsset(vault, { fileName, body, from = "", folder = "attachments", maxAttempts = MAX_ASSET_NAME_ATTEMPTS } = {}) {
  if (!vault || typeof vault.root !== "string" || !vault.root) throw invalidAssetPath();
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? []);
  const { stem, extension, contentType } = cleanAssetName(fileName);
  if (sniffImageType(bytes) !== contentType) throw unsupportedAssetType();
  if (isUnsafeVaultPath(folder)) throw invalidAssetPath();
  const directory = normalizeVaultInput(folder);
  const source = await resolveAssetSource(vault, from);

  const absoluteDirectory = path.resolve(vault.root, ...directory.split("/"));
  await assertCanonicalInsideRoot(vault.root, absoluteDirectory, { allowMissing: true });
  await fs.mkdir(absoluteDirectory, { recursive: true });
  await assertCanonicalInsideRoot(vault.root, absoluteDirectory);

  let absolute = null;
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    const name = `${stem}${attempt ? `-${attempt}` : ""}${extension}`;
    const candidate = path.join(absoluteDirectory, name);
    await assertCanonicalInsideRoot(vault.root, candidate, { allowMissing: true });
    try {
      await fs.writeFile(candidate, bytes, { flag: "wx" });
      absolute = candidate;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (!absolute) throw assetError(409, "Attachment name conflict");

  return {
    vaultId: vault.id,
    path: path.relative(vault.root, absolute).split(path.sep).join("/"),
    revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.length,
    contentType,
    from: source,
  };
}
