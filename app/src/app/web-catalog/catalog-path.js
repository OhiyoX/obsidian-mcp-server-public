// Canonical Web Catalog path boundary.
//
// Contract: the Store only accepts canonical vault-relative logical paths.
// Anything else fails closed — it is never silently normalized into a valid path
// (which used to let absolute/traversal/backslash input reach the catalog).
export class WebCatalogPathError extends Error {
  constructor(message) {
    super(message);
    this.name = "WebCatalogPathError";
    this.code = "WEB_CATALOG_PATH_INVALID";
  }
}

const DRIVE_LETTER = /^[A-Za-z]:/;

// `allowRoot` is only for a parent/query identity (e.g. listChildren("")); it is
// never valid as a note/directory path.
export function assertCatalogPath(value, { allowRoot = false } = {}) {
  if (typeof value !== "string") throw new WebCatalogPathError("path must be a string");
  if (value === "") {
    if (allowRoot) return "";
    throw new WebCatalogPathError("path must not be empty");
  }
  if (value.includes("\0")) throw new WebCatalogPathError("path must not contain NUL");
  if (value.startsWith("/")) throw new WebCatalogPathError("path must be vault-relative");
  if (value.endsWith("/")) throw new WebCatalogPathError("path must not end with a separator");
  if (value.includes("\\")) throw new WebCatalogPathError("path must use '/' separators");
  if (value.includes("//")) throw new WebCatalogPathError("path must not contain empty segments");
  if (DRIVE_LETTER.test(value)) throw new WebCatalogPathError("path must be vault-relative");
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") {
      throw new WebCatalogPathError("path must not contain traversal segments");
    }
  }
  return value;
}

// Path helpers shared with the store. Callers must have validated the path first
// (assertCatalogPath); these do not re-check and are not a validation boundary.
export function normalizeRelative(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function parentPathOf(rel) {
  const index = rel.lastIndexOf("/");
  return index < 0 ? "" : rel.slice(0, index);
}

export function basenameOf(rel) {
  const index = rel.lastIndexOf("/");
  return index < 0 ? rel : rel.slice(index + 1);
}

export function titleOf(rel) {
  return basenameOf(rel).replace(/\.(?:md|base)$/i, "");
}

// Attachment badge source: lowercase suffix without the leading dot. A name with
// no suffix (`LICENSE`) or a dotfile (`.gitignore`, excluded by the walk anyway)
// yields an empty string, which the client renders as "no badge".
export function extensionOf(rel) {
  const name = basenameOf(rel);
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return "";
  return name.slice(index + 1).toLowerCase();
}

export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}
