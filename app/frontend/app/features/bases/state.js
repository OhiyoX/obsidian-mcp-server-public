// Pure Base surface state helpers. No DOM, no network, no imports: this module
// must stay import-safe in Node without a DOM global (contract §10, WB-04).
//
// The HTTP DTO is frozen by TODO §8; this file only normalizes it into the
// surface state machine. It never assigns `innerHTML` and treats every string in
// the DTO as untrusted.

import { buildBaseSearch } from "./query-state.js";

export const BASE_LIMIT_DEFAULT = 100;
export const BASE_LIMIT_MIN = 1;
export const BASE_LIMIT_MAX = 500;
export const BASE_ENDPOINT = "/api/web/v1/base";

export function createBaseState() {
  return {
    documentKind: null,
    vaultId: null,
    path: null,
    route: null,
    revision: null,
    views: [],
    view: null,
    viewType: null,
    // User overrides carried in the document URL (`?sort=&filter=&q=`). They always
    // win over the view's own declaration and survive a catalog-stale restart.
    sort: [],
    filter: [],
    q: "",
    columns: [],
    rows: [],
    // Frozen cut-4 grouping partition (`groups: [{key, keyType, count, rowPaths}]`),
    // exactly as the transport sends it; `null` when the view declares no groupBy
    // (the kanban layout fails closed on `null`, it never invents columns).
    groups: null,
    totalMatched: 0,
    truncated: false,
    nextCursor: null,
    supportedSubset: true,
    capabilities: null,
    catalog: null,
    catalogStale: false,
    loading: false,
    error: null,
  };
}

export function resetBaseState(state) {
  Object.assign(state, createBaseState());
  return state;
}

// Opaque, order-independent request URL. Only the documented query parameters are
// emitted; there is no public pageNumber/offset parameter (contract §4.3).
// `sort`, `filter` and `q` are the desktop-parity overrides (D-PARITY-PLAN): they
// are JSON/plain parameters consumed by the canonical Base query service.
export function buildBaseRequestUrl({ path, view = null, limit = BASE_LIMIT_DEFAULT, cursor = null, sort = [], filter = [], q = "" } = {}) {
  const params = new URLSearchParams();
  params.set("path", String(path ?? ""));
  if (view !== null && view !== undefined && view !== "") params.set("view", String(view));
  params.set("limit", String(limit));
  if (cursor !== null && cursor !== undefined && cursor !== "") params.set("cursor", String(cursor));
  const search = buildBaseSearch({ sort, filter, q });
  if (search) {
    for (const [key, value] of new URLSearchParams(search)) params.set(key, value);
  }
  return `${BASE_ENDPOINT}?${params.toString()}`;
}

function normalizeFormula(formula) {
  if (!formula || typeof formula !== "object") return null;
  const text = (value) => (typeof value === "string" ? value : null);
  return { name: text(formula.name), expression: text(formula.expression), displayName: text(formula.displayName) };
}

function normalizeColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns
    .filter((column) => column && typeof column === "object")
    .map((column) => ({
      key: typeof column.key === "string" ? column.key : String(column.key ?? ""),
      label: typeof column.label === "string" ? column.label : null,
      kind: typeof column.kind === "string" ? column.kind : null,
      formula: normalizeFormula(column.formula),
    }));
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && typeof row === "object");
}

// The grouped DTO stays as the transport sent it: the kanban layout (an on-demand
// asset, kanban-runtime.js `normalizeKanbanGroups`) owns the null-vs-[] distinction,
// because `null` (no grouping declared) and `[]` (a legal empty partition) are the two
// states it must tell apart. Nothing else reads `state.groups`.

// Apply a successful page response. `append` implements bounded load-more without
// ever mixing a different snapshot: the caller must only append when the cursor
// identity in state matches the request it made.
export function applyBasePage(state, dto, { append = false } = {}) {
  if (!dto || typeof dto !== "object") return state;
  if (typeof dto.path === "string" && dto.path) state.path = dto.path;
  if (dto.vaultId !== undefined) state.vaultId = dto.vaultId;
  if (typeof dto.route === "string" && dto.route) state.route = dto.route;
  state.revision = dto.revision ?? null;
  state.views = Array.isArray(dto.views)
    ? dto.views.filter((view) => view && typeof view === "object").map((view) => ({
        name: typeof view.name === "string" ? view.name : String(view.name ?? ""),
        type: typeof view.type === "string" ? view.type : null,
      }))
    : [];
  if (dto.view && typeof dto.view === "object") {
    if (typeof dto.view.name === "string") state.view = dto.view.name;
    state.viewType = typeof dto.view.type === "string" ? dto.view.type : null;
  }
  state.columns = normalizeColumns(dto.columns);
  const rows = normalizeRows(dto.rows);
  state.rows = append ? state.rows.concat(rows) : rows;
  state.groups = dto.groups === undefined ? null : dto.groups;
  state.totalMatched = Number.isFinite(dto.totalMatched) ? dto.totalMatched : state.rows.length;
  state.truncated = Boolean(dto.truncated);
  state.nextCursor = dto.nextCursor === undefined ? null : dto.nextCursor;
  state.supportedSubset = dto.supportedSubset !== false;
  state.capabilities = dto.capabilities && typeof dto.capabilities === "object" ? dto.capabilities : null;
  state.catalog = dto.catalog && typeof dto.catalog === "object" ? dto.catalog : null;
  state.catalogStale = Boolean(dto.catalog && dto.catalog.stale);
  state.loading = false;
  state.error = null;
  return state;
}

export function applyBaseError(state, error) {
  state.loading = false;
  state.error = error ?? { status: 0, code: "unknown", message: "数据库请求失败。" };
  return state;
}

export function toPublicState(state) {
  return {
    documentKind: state.documentKind,
    path: state.path,
    view: state.view,
    sort: state.sort,
    filter: state.filter,
    q: state.q,
    columns: state.columns,
    rows: state.rows,
    nextCursor: state.nextCursor,
    loading: state.loading,
    error: state.error,
    catalogStale: state.catalogStale,
  };
}
