// Explorer sort preference — pure global browser preference.
//
// The preference is one exact-shape JSON payload under a fixed, global
// localStorage key (`obsidian-web.explorer-sort.v1`). It is read synchronously
// before the first Tree render and written only when a real user changes the
// sort. Parsing is strict: invalid JSON, a non-object/array/null payload, an
// unknown field, a wrong `version` type, or an unknown key/direction fails
// closed to the default `{ key: "name", direction: "asc" }`. A storage read
// exception (private mode / blocked storage) also fails closed and never blocks
// application boot. A storage write exception is reported to the caller so the
// current session can still apply the user's choice.
//
// The payload contains no note path, account, vault, or query. There is no
// `storage` event cross-tab sync in this slice.

export const EXPLORER_SORT_STORAGE_KEY = "obsidian-web.explorer-sort.v1";
export const EXPLORER_SORT_VERSION = 1;
export const EXPLORER_SORT_KEYS = Object.freeze(["name", "modified"]);
export const EXPLORER_SORT_DIRECTIONS = Object.freeze(["asc", "desc"]);
export const DEFAULT_EXPLORER_SORT = Object.freeze({ key: "name", direction: "asc" });

const PAYLOAD_FIELDS = Object.freeze(["version", "key", "direction"]);

function defaultSort() {
  return { key: DEFAULT_EXPLORER_SORT.key, direction: DEFAULT_EXPLORER_SORT.direction };
}

export function isExplorerSortKey(value) {
  return typeof value === "string" && EXPLORER_SORT_KEYS.includes(value);
}

export function isExplorerSortDirection(value) {
  return typeof value === "string" && EXPLORER_SORT_DIRECTIONS.includes(value);
}

// Coerces an in-memory candidate (e.g. a control event) to a valid spec the same
// way the persisted-payload parser does. Always returns a fresh object.
export function coerceExplorerSort(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)
    && isExplorerSortKey(value.key) && isExplorerSortDirection(value.direction)) {
    return { key: value.key, direction: value.direction };
  }
  return defaultSort();
}

export function parseExplorerSort(raw) {
  if (typeof raw !== "string") return defaultSort();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return defaultSort();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return defaultSort();
  const fields = Object.keys(value);
  if (fields.length !== PAYLOAD_FIELDS.length) return defaultSort();
  for (const field of PAYLOAD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return defaultSort();
  }
  // `version` must be the exact number 1 — no string coercion.
  if (value.version !== EXPLORER_SORT_VERSION) return defaultSort();
  if (!isExplorerSortKey(value.key)) return defaultSort();
  if (!isExplorerSortDirection(value.direction)) return defaultSort();
  return { key: value.key, direction: value.direction };
}

// Accessing `localStorage` itself can throw (e.g. blocked third-party storage),
// so the lookup is guarded separately from getItem/setItem.
export function resolveExplorerSortStorage(scope = globalThis) {
  try {
    return scope?.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readExplorerSort(storage) {
  if (!storage || typeof storage.getItem !== "function") return defaultSort();
  try {
    return parseExplorerSort(storage.getItem(EXPLORER_SORT_STORAGE_KEY));
  } catch {
    return defaultSort();
  }
}

export function writeExplorerSort(storage, sort) {
  const spec = coerceExplorerSort(sort);
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(EXPLORER_SORT_STORAGE_KEY, JSON.stringify({
      version: EXPLORER_SORT_VERSION,
      key: spec.key,
      direction: spec.direction,
    }));
    return true;
  } catch {
    return false;
  }
}
