// Explorer flat-view preferences — two independent, versioned browser payloads.
//
// `obsidian-web.explorer-mode.v1` holds the panel mode (`tree` | `flat`);
// `obsidian-web.explorer-flat-sort.v1` holds the flat list's `{key,direction}`.
// Both are separate keys from the Phase 1 Tree preference
// (`obsidian-web.explorer-sort.v1`, frozen v1 schema) so neither can overwrite the
// other, and both are read synchronously before the first Explorer render.
//
// Parsing is strict and fails closed to the documented default (invalid JSON, a
// non-object/array/null payload, an unknown field, a wrong `version`, an unknown
// key/direction). A storage read exception (private mode / blocked storage) also
// fails closed. The payloads contain no note path, account, vault, or query.
//
// Capability narrowing: the flat preference may hold any of `EXPLORER_FLAT_SORT_KEYS`
// (`name`/`modified`/`path`/`score`), but the *effective* spec is narrowed by the
// data source — `effectiveFlatSort()` falls back to the default when the requested
// key cannot be honoured by the current source (a query-less flat page is ordered by
// the server, which can only serve the globally meaningful columns `modified`/`path`).
import { resolveExplorerSortStorage } from "./sort-preference.js";

// The storage accessor is shared with the Tree preference (`resolveExplorerSortStorage`);
// both payloads live in the same `localStorage` scope but under different keys.
export const EXPLORER_MODE_STORAGE_KEY = "obsidian-web.explorer-mode.v1";
export const EXPLORER_MODE_VERSION = 1;
export const EXPLORER_MODES = Object.freeze(["tree", "flat"]);
export const DEFAULT_EXPLORER_MODE = "tree";

export const EXPLORER_FLAT_SORT_STORAGE_KEY = "obsidian-web.explorer-flat-sort.v1";
export const EXPLORER_FLAT_SORT_VERSION = 1;
export const EXPLORER_FLAT_SORT_DIRECTIONS = Object.freeze(["asc", "desc"]);
export const EXPLORER_FLAT_SORT_KEYS = Object.freeze(["name", "modified", "path", "score"]);
// Keys a query-less flat page can actually be ordered by. The server flat page only
// uses columns that are meaningful across the whole Vault; `name` would need a
// global name-rank projection and `score` does not exist without a query.
export const EXPLORER_FLAT_SERVER_KEYS = Object.freeze(["modified", "path"]);
export const DEFAULT_EXPLORER_FLAT_SORT = Object.freeze({ key: "modified", direction: "desc" });

const MODE_PAYLOAD_FIELDS = Object.freeze(["version", "mode"]);
const FLAT_SORT_PAYLOAD_FIELDS = Object.freeze(["version", "key", "direction"]);

function defaultFlatSort() {
  return { key: DEFAULT_EXPLORER_FLAT_SORT.key, direction: DEFAULT_EXPLORER_FLAT_SORT.direction };
}

export function isExplorerMode(value) {
  return typeof value === "string" && EXPLORER_MODES.includes(value);
}

export function isFlatSortKey(value) {
  return typeof value === "string" && EXPLORER_FLAT_SORT_KEYS.includes(value);
}

export function isFlatSortDirection(value) {
  return typeof value === "string" && EXPLORER_FLAT_SORT_DIRECTIONS.includes(value);
}

export function coerceFlatSort(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)
    && isFlatSortKey(value.key) && isFlatSortDirection(value.direction)) {
    return { key: value.key, direction: value.direction };
  }
  return defaultFlatSort();
}

// `true` only when the current data source can honour the key: with an active query
// the flat list is a client-side projection of the search payload (`name`/`score`
// both exist); with no query the server flat page owns the order and only
// `EXPLORER_FLAT_SERVER_KEYS` are meaningful there.
export function isFlatSortKeyAvailable(key, { query = false } = {}) {
  if (!isFlatSortKey(key)) return false;
  if (query === true) return true;
  return EXPLORER_FLAT_SERVER_KEYS.includes(key);
}

export function effectiveFlatSort(value, { query = false } = {}) {
  const spec = coerceFlatSort(value);
  if (!isFlatSortKeyAvailable(spec.key, { query })) return defaultFlatSort();
  return spec;
}

// --- mode preference -------------------------------------------------------

export function parseExplorerMode(raw) {
  if (typeof raw !== "string") return DEFAULT_EXPLORER_MODE;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_EXPLORER_MODE;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return DEFAULT_EXPLORER_MODE;
  const fields = Object.keys(value);
  if (fields.length !== MODE_PAYLOAD_FIELDS.length) return DEFAULT_EXPLORER_MODE;
  for (const field of MODE_PAYLOAD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return DEFAULT_EXPLORER_MODE;
  }
  if (value.version !== EXPLORER_MODE_VERSION) return DEFAULT_EXPLORER_MODE;
  return isExplorerMode(value.mode) ? value.mode : DEFAULT_EXPLORER_MODE;
}

export function readExplorerMode(storage) {
  if (!storage || typeof storage.getItem !== "function") return DEFAULT_EXPLORER_MODE;
  try {
    return parseExplorerMode(storage.getItem(EXPLORER_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_EXPLORER_MODE;
  }
}

export function writeExplorerMode(storage, mode) {
  const value = isExplorerMode(mode) ? mode : DEFAULT_EXPLORER_MODE;
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(EXPLORER_MODE_STORAGE_KEY, JSON.stringify({
      version: EXPLORER_MODE_VERSION,
      mode: value,
    }));
    return true;
  } catch {
    return false;
  }
}

// --- flat sort preference --------------------------------------------------

export function parseFlatSort(raw) {
  if (typeof raw !== "string") return defaultFlatSort();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return defaultFlatSort();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return defaultFlatSort();
  const fields = Object.keys(value);
  if (fields.length !== FLAT_SORT_PAYLOAD_FIELDS.length) return defaultFlatSort();
  for (const field of FLAT_SORT_PAYLOAD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return defaultFlatSort();
  }
  if (value.version !== EXPLORER_FLAT_SORT_VERSION) return defaultFlatSort();
  if (!isFlatSortKey(value.key)) return defaultFlatSort();
  if (!isFlatSortDirection(value.direction)) return defaultFlatSort();
  return { key: value.key, direction: value.direction };
}

export function readFlatSort(storage) {
  if (!storage || typeof storage.getItem !== "function") return defaultFlatSort();
  try {
    return parseFlatSort(storage.getItem(EXPLORER_FLAT_SORT_STORAGE_KEY));
  } catch {
    return defaultFlatSort();
  }
}

export function writeFlatSort(storage, sort) {
  const spec = coerceFlatSort(sort);
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(EXPLORER_FLAT_SORT_STORAGE_KEY, JSON.stringify({
      version: EXPLORER_FLAT_SORT_VERSION,
      key: spec.key,
      direction: spec.direction,
    }));
    return true;
  } catch {
    return false;
  }
}
