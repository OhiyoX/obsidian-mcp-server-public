// Opaque pagination cursors for the Web Base read API (A3 HTTP contract).
//
// A Base cursor is not a public offset/pageNumber. It binds the catalogId, the
// catalog generation, the Base path, the Base revision, the selected view
// identity, the result-order contract version, the frozen query overrides
// (`sort` / `filter` / `q`, in their canonical encoded form) and the window
// offset, so a page can never mix two Base revisions, catalog generations or
// query shapes (contract TODO §4.3, §8, WB-07/WB-08; D-PARITY-PLAN cursor
// identity extension).
//
// The three override fields are optional on the wire: a cursor minted before the
// extension (or for a request without overrides) simply omits them, and the
// comparison treats absent and `undefined` as identical.
//
// Error contract:
//   - malformed / shape / version mismatch -> BaseCursorError
//     ("BASE_CURSOR_INVALID"), mapped to HTTP 400 by base-route.js;
//   - any bound identity mismatch        -> BaseCursorError
//     ("BASE_CURSOR_STALE"), mapped to HTTP 409.
export const BASE_CURSOR_VERSION = 1;
// Bumped whenever the evaluated row order contract (filters/sort/tie-break)
// changes; old cursors then fail closed as stale instead of mixing orders.
export const BASE_ORDER_CONTRACT_VERSION = 1;

const MAX_CURSOR_LENGTH = 4096;

export class BaseCursorError extends Error {
  constructor(message, code = "BASE_CURSOR_INVALID") {
    super(message);
    this.name = "BaseCursorError";
    this.code = code;
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new BaseCursorError(`cursor ${field} is invalid`);
  return value;
}

function requireNonNegativeInteger(value, field, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) throw new BaseCursorError(`cursor ${field} is invalid`);
  return value;
}

// The query-override identity fields are optional; when present they must be
// non-empty strings (the canonical encodings produced by base-params.js).
const OVERRIDE_FIELDS = ["sort", "filter", "q"];

function assignOverrides(target, fields) {
  for (const field of OVERRIDE_FIELDS) {
    if (fields[field] === undefined) continue;
    if (typeof fields[field] !== "string" || fields[field].length === 0) {
      throw new BaseCursorError(`cursor ${field} is invalid`);
    }
    target[field] = fields[field];
  }
  return target;
}

export function encodeBaseCursor(fields) {
  if (!fields || typeof fields !== "object") throw new BaseCursorError("cursor fields are required");
  const payload = {
    v: BASE_CURSOR_VERSION,
    catalogId: requireNonEmptyString(fields.catalogId, "catalogId"),
    generation: requireNonNegativeInteger(fields.generation, "generation"),
    path: requireNonEmptyString(fields.path, "path"),
    revision: requireNonEmptyString(fields.revision, "revision"),
    view: requireNonEmptyString(fields.view, "view"),
    orderContract: requireNonNegativeInteger(
      fields.orderContract ?? BASE_ORDER_CONTRACT_VERSION,
      "orderContract",
      { min: 1 },
    ),
    offset: requireNonNegativeInteger(fields.offset, "offset"),
  };
  assignOverrides(payload, fields);
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeBaseCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  if (typeof cursor !== "string") throw new BaseCursorError("cursor must be a string");
  // Budget first: an oversized or non-canonical string never reaches JSON.parse.
  if (cursor.length > MAX_CURSOR_LENGTH) throw new BaseCursorError("cursor is too long");
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new BaseCursorError("cursor is not base64url");

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new BaseCursorError("cursor is not decodable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BaseCursorError("cursor shape is invalid");
  }
  if (parsed.v !== BASE_CURSOR_VERSION) throw new BaseCursorError("cursor version mismatch");
  requireNonEmptyString(parsed.catalogId, "catalogId");
  requireNonNegativeInteger(parsed.generation, "generation");
  requireNonEmptyString(parsed.path, "path");
  requireNonEmptyString(parsed.revision, "revision");
  requireNonEmptyString(parsed.view, "view");
  requireNonNegativeInteger(parsed.orderContract, "orderContract", { min: 1 });
  requireNonNegativeInteger(parsed.offset, "offset");
  assignOverrides({}, parsed);
  return parsed;
}

// The catalog identity and the frozen query overrides must match exactly;
// otherwise the client refreshes the current Base view instead of stitching two
// snapshots together. An absent override and `undefined` compare as equal.
export function assertBaseCursorMatches(decoded, identity) {
  if (!decoded) return;
  const mismatch =
    decoded.catalogId !== identity.catalogId ||
    decoded.generation !== identity.generation ||
    decoded.path !== identity.path ||
    decoded.revision !== identity.revision ||
    decoded.view !== identity.view ||
    decoded.orderContract !== identity.orderContract ||
    (decoded.sort ?? null) !== (identity.sort ?? null) ||
    (decoded.filter ?? null) !== (identity.filter ?? null) ||
    (decoded.q ?? null) !== (identity.q ?? null);
  if (mismatch) {
    throw new BaseCursorError("cursor is stale; refresh the current Base view", "BASE_CURSOR_STALE");
  }
}
