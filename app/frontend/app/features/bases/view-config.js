// Per-(vault, base, view) presentation preferences: column widths and which
// columns are shown. Purely client-side (desktop Bases keeps these locally too).
//
// Storage is injected so this module never touches a global in Node tests, and
// every read/write is guarded: a missing, disabled or full localStorage must
// never break rendering.

export const BASE_VIEW_CONFIG_PREFIX = "obsidian-web.base-view-config:v1";
export const DEFAULT_COLUMN_WIDTH = 150;
export const FIRST_COLUMN_WIDTH = 220;
export const MIN_COLUMN_WIDTH = 80;
export const MAX_COLUMN_WIDTH = 640;

export function baseViewConfigKey({ vaultId = null, path = null, view = null } = {}) {
  return [
    BASE_VIEW_CONFIG_PREFIX,
    String(vaultId ?? ""),
    String(path ?? ""),
    String(view ?? ""),
  ].join(":");
}

function emptyConfig() {
  return { widths: {}, hidden: [] };
}

export function clampColumnWidth(width) {
  const value = Number(width);
  if (!Number.isFinite(value)) return null;
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(value)));
}

export function defaultColumnWidth(index = 0) {
  return index === 0 ? FIRST_COLUMN_WIDTH : DEFAULT_COLUMN_WIDTH;
}

// The raw stored blob for one key. Every caller tolerates a missing / hostile / full
// store, so a broken preference can never break rendering.
function readRaw(storage, key) {
  if (!storage || typeof storage.getItem !== "function" || !key) return {};
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

// Merge one slice of the blob, keeping every other slice intact: the view's private
// display options and its column widths share one key and must not clobber each other.
function writeRaw(storage, key, patch) {
  if (!storage || typeof storage.setItem !== "function" || !key) return false;
  try {
    storage.setItem(key, JSON.stringify({ ...readRaw(storage, key), ...patch }));
    return true;
  } catch {
    return false;
  }
}

export function readViewConfig(storage, key) {
  const parsed = readRaw(storage, key);
  const config = emptyConfig();
  if (parsed.widths && typeof parsed.widths === "object") {
    for (const [columnKey, width] of Object.entries(parsed.widths)) {
      const clamped = clampColumnWidth(width);
      if (typeof columnKey === "string" && columnKey && clamped !== null) config.widths[columnKey] = clamped;
    }
  }
  if (Array.isArray(parsed.hidden)) {
    config.hidden = parsed.hidden.filter((value) => typeof value === "string" && value !== "");
  }
  return config;
}

export function writeViewConfig(storage, key, config) {
  return writeRaw(storage, key, {
    widths: config && typeof config.widths === "object" && config.widths ? config.widths : {},
    hidden: Array.isArray(config?.hidden) ? config.hidden : [],
  });
}

// Read/write side of the desktop view's private display options (`markers`, `separator`,
// `cardSize`, `image`, `imageFit`, `imageAspectRatio`): the same key as the column
// widths, kept opaque here because each view type validates its own keys
// (view-options.js resolveViewOptions). Read side is what this slice renders; nothing
// writes these keys back into the `.base` file (RECON §5 item 4).
export function readViewOptions(storage, key) {
  const options = readRaw(storage, key).options;
  return options && typeof options === "object" && !Array.isArray(options) ? options : {};
}

export function writeViewOptions(storage, key, options) {
  const next = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  return writeRaw(storage, key, { options: next });
}

export function withColumnWidth(config, columnKey, width) {
  const clamped = clampColumnWidth(width);
  if (!columnKey || clamped === null) return config;
  return { ...config, widths: { ...config.widths, [columnKey]: clamped } };
}

// Resolution order: persisted override -> declaration order default.
export function resolveColumnWidths(columns, config) {
  const widths = {};
  (columns ?? []).forEach((column, index) => {
    const override = config?.widths?.[column.key];
    widths[column.key] = clampColumnWidth(override) ?? defaultColumnWidth(index);
  });
  return widths;
}

// The hidden set is authoritative. It can never become "everything" through
// `toggleColumnVisibility` (that path refuses to hide the last visible column),
// so an empty result is only reachable through the explicit `hideAllColumns`
// action below: the desktop Properties popover's "全部隐藏" really does clear the
// visible columns, and that state has to survive a re-render to be undoable from
// the same popover.
export function visibleColumns(columns, config) {
  const list = Array.isArray(columns) ? columns : [];
  const hidden = new Set(Array.isArray(config?.hidden) ? config.hidden : []);
  return list.filter((column) => !hidden.has(column.key));
}

// "全部隐藏": the explicit bulk action, never the per-column checkbox path. Keys
// of columns that are no longer declared are preserved so a later view can
// re-hide them consistently.
export function hideAllColumns(config, columns) {
  const hidden = new Set(Array.isArray(config?.hidden) ? config.hidden : []);
  for (const column of Array.isArray(columns) ? columns : []) {
    if (column && typeof column.key === "string" && column.key) hidden.add(column.key);
  }
  return { ...config, hidden: [...hidden] };
}

// Hiding the last visible column through this path is a no-op instead of an empty
// table; the explicit "全部隐藏" action is a separate function on purpose.
export function toggleColumnVisibility(config, columnKey, columns) {
  if (!columnKey) return config;
  const hidden = new Set(Array.isArray(config?.hidden) ? config.hidden : []);
  const list = Array.isArray(columns) ? columns : [];
  if (hidden.has(columnKey)) {
    hidden.delete(columnKey);
  } else {
    const remaining = list.filter((column) => column.key !== columnKey && !hidden.has(column.key));
    if (remaining.length === 0) return config;
    hidden.add(columnKey);
  }
  return { ...config, hidden: [...hidden] };
}
