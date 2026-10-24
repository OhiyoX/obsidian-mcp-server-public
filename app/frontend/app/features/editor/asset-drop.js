// U30 contract A4: pure, DOM-free helpers for the editor's image drop.
//
// The server is authoritative for cleaning and validation (`attachments.js`); this module
// mirrors the naming rules only to label the progress rows and to reject a non-image before a
// request is made. It deliberately has no DOM or CodeMirror dependency so the naming matrix,
// the whitelist and the drop-position fallback can be tested without a browser.

// Write whitelist, identical to the server's `WEB_ASSET_TYPES` (`.svg` excluded there because
// the read route serves it inline).
export const WEB_ASSET_EXTENSIONS = Object.freeze([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
export const WEB_ASSET_MIME = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});
const ALLOWED = new Set(WEB_ASSET_EXTENSIONS);
const MAX_STEM_LENGTH = 120;
const RESERVED = /[\\/:*?"<>|[\]#^]|[\u0000-\u001f\u007f]/g;

/** Lower-cased extension including the dot, or `""`. A leading dot is not an extension. */
export function assetExtension(name) {
  const value = String(name ?? "");
  const index = value.lastIndexOf(".");
  return index <= 0 ? "" : value.slice(index).toLowerCase();
}

export function isAllowedAssetName(name) {
  return ALLOWED.has(assetExtension(name));
}

export function expectedAssetMime(name) {
  return WEB_ASSET_MIME[assetExtension(name)] || "";
}

/**
 * Client mirror of the server's cleaning rules (contract A2 rules 1-4). Returns
 * `{ stem, extension, name }`, or `null` when the name can never be accepted (percent-encoding
 * failure, traversal, absolute path, NUL, dot-prefixed segment, or an extension outside the
 * whitelist). Never used as the authority for what gets written.
 */
export function cleanAssetName(rawName) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rawName ?? ""));
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0") || decoded.includes("/") || decoded.includes("\\") || decoded.includes("..") || decoded.startsWith(".")) return null;
  const extension = assetExtension(decoded);
  if (!ALLOWED.has(extension)) return null;
  const stem = decoded
    .slice(0, decoded.length - extension.length)
    .normalize("NFC")
    .replace(RESERVED, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, MAX_STEM_LENGTH)
    .replace(/[\s.]+$/g, "");
  const safeStem = !stem || /^-+$/.test(stem) ? "image" : stem;
  return { stem: safeStem, extension, name: `${safeStem}${extension}` };
}

/**
 * The inserted Markdown for an uploaded asset: a Vault-relative wikilink embed
 * (`![[attachments/name.png]]`). Vault-relative is the only form that guarantees the read
 * route takes its direct branch instead of the bounded whole-Vault basename scan.
 * `|` is replaced once so the embed cannot be read as an alias.
 */
export function assetEmbedText(vaultPath) {
  return `![[${String(vaultPath ?? "").replace(/\|/g, "-")}]]`;
}

/**
 * Drop position resolution (contract A4): the coordinate hit, or the current selection head
 * when the point is out of range or inside a non-editable (atomic) decoration block.
 */
export function resolveDropPosition({ pos, head, docLength, atomic = false } = {}) {
  const length = Number.isFinite(Number(docLength)) ? Number(docLength) : 0;
  const fallback = Math.max(0, Math.min(Number.isFinite(Number(head)) ? Number(head) : 0, length));
  if (atomic) return fallback;
  const candidate = Number(pos);
  if (pos == null || !Number.isFinite(candidate) || candidate < 0 || candidate > length) return fallback;
  return candidate;
}

/** True only for a drag that carries files; anything else stays CodeMirror's business. */
export function shouldHandleAssetDrop(types) {
  if (!types) return false;
  return Array.from(types).some((type) => String(type).toLowerCase() === "files");
}

/** Bubbling-safe drag depth for child elements (`dragenter`/`dragleave` pairs). */
export function createDragDepthCounter() {
  let depth = 0;
  return {
    enter() {
      depth += 1;
      return depth;
    },
    leave() {
      depth = Math.max(0, depth - 1);
      return depth;
    },
    reset() {
      depth = 0;
    },
    get active() {
      return depth > 0;
    },
  };
}

/** `x-file-name` header value: percent-encoded UTF-8, exactly as the route expects it. */
export function assetFileNameHeader(name) {
  return encodeURIComponent(String(name ?? ""));
}
