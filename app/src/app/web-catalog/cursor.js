// Opaque keyset cursors for Web Catalog pagination.
//
// A cursor is not an offset: it binds the catalog identity, parent, sort,
// direction, catalog generation and the full keyset, so it stays stable across
// inserts and is rejected the moment the query or catalog snapshot moves on.
//
// v4: adds `catalogId`, so a cursor from another Vault can never be accepted even
// if its generation number happens to match.
export const WEB_CATALOG_CURSOR_VERSION = 4;

const MAX_CURSOR_LENGTH = 4096;
const MAX_KEYSET_LENGTH = 8;

export class WebCatalogCursorError extends Error {
  // `WEB_CATALOG_CURSOR_INVALID` = malformed/shape/query mismatch (client bug).
  // `WEB_CATALOG_CURSOR_STALE` = the catalog moved on; recoverable by refreshing
  // the current parent/window (the HTTP layer maps it to 409, not 500).
  constructor(message, code = "WEB_CATALOG_CURSOR_INVALID") {
    super(message);
    this.name = "WebCatalogCursorError";
    this.code = code;
  }
}

// anchorPath query identity. `WEB_CATALOG_ANCHOR_INVALID` is a request-shape error
// (cursor + anchor together); `WEB_CATALOG_ANCHOR_MISSING` means the anchor is not a
// direct child of the requested parent (the HTTP layer maps clean -> 404, stale -> 409).
export class WebCatalogAnchorError extends Error {
  constructor(message, code = "WEB_CATALOG_ANCHOR_MISSING") {
    super(message);
    this.name = "WebCatalogAnchorError";
    this.code = code;
  }
}

export function encodeWebCatalogCursor(payload) {
  const body = JSON.stringify({ v: WEB_CATALOG_CURSOR_VERSION, ...payload });
  return Buffer.from(body, "utf8").toString("base64url");
}

export function decodeWebCatalogCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  // Budget first: an oversized or non-canonical string never reaches JSON.parse.
  if (typeof cursor !== "string") throw new WebCatalogCursorError("cursor must be a string");
  if (cursor.length > MAX_CURSOR_LENGTH) throw new WebCatalogCursorError("cursor is too long");
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new WebCatalogCursorError("cursor is not base64url");

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new WebCatalogCursorError("cursor is not decodable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebCatalogCursorError("cursor shape is invalid");
  }
  if (parsed.v !== WEB_CATALOG_CURSOR_VERSION) throw new WebCatalogCursorError("cursor version mismatch");
  // `flat` is an optional identity flag: a flat page cursor carries `flat: true` and
  // must never be accepted by a tree (children) page with the same parent/sort, and
  // a tree cursor must never be accepted by a flat page. Anything else is malformed.
  if (parsed.flat !== undefined && parsed.flat !== true) {
    throw new WebCatalogCursorError("cursor flat flag is invalid");
  }
  if (
    typeof parsed.parent !== "string" ||
    typeof parsed.sort !== "string" ||
    typeof parsed.direction !== "string"
  ) {
    throw new WebCatalogCursorError("cursor target is invalid");
  }
  if (typeof parsed.catalogId !== "string" || parsed.catalogId.length === 0) {
    throw new WebCatalogCursorError("cursor catalog identity is invalid");
  }
  if (!Number.isSafeInteger(parsed.g) || parsed.g < 0) {
    throw new WebCatalogCursorError("cursor generation is invalid");
  }
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0 || parsed.keys.length > MAX_KEYSET_LENGTH) {
    throw new WebCatalogCursorError("cursor keyset is invalid");
  }
  for (const key of parsed.keys) {
    const valid = typeof key === "string" || (typeof key === "number" && Number.isFinite(key));
    if (!valid) throw new WebCatalogCursorError("cursor key is invalid");
  }
  return parsed;
}
