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
    // The selected view's DECLARED sort, as the server projects it (`viewSort`). The sort
    // menu opens on this list (`loadSort()` = the view config, asar app.js@2527053) and only
    // `sort` above is written back into the URL; an older server sends none and the menu then
    // simply has no rows to seed from.
    viewSort: [],
    // The selected view's DECLARED grouping rule (`viewGroupBy`), in the `.base`
    // spelling (`{property, direction}`). The `分组依据` menu shows it when the reader has
    // no `?group=` override; `null` = the view groups nothing (also what an older server
    // sends).
    viewGroupBy: null,
    // The reader's own grouping rule (`?group=`), which WINS over `viewGroupBy` and is the
    // only grouping this surface writes — rewriting `views[].groupBy` is a PATCH operation
    // this surface does not perform (panel-group.js records why).
    group: null,
    filter: [],
    q: "",
    columns: [],
    // ADDITIVE (lane desktop-re/panel-properties): the desktop Properties menu's full row
    // set — every property the Base can address, `checked` = it is in the view's `order`.
    // `[]` means an older/absent DTO: the properties panel then falls back to the declared
    // columns instead of inventing rows.
    propertyCatalog: [],
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
    // U12: the read-only condition summary of the Base-file-level and selected-view
    // `filters:` (`{ base, view }`, each `null` when that layer declares none).
    // `null` here means an older/absent DTO: the filter menu then degrades to the
    // URL-override count only instead of inventing a `所有视图` section.
    filters: null,
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
export function buildBaseRequestUrl({ path, view = null, limit = BASE_LIMIT_DEFAULT, cursor = null, sort = [], filter = [], q = "", group = null } = {}) {
  const params = new URLSearchParams();
  params.set("path", String(path ?? ""));
  if (view !== null && view !== undefined && view !== "") params.set("view", String(view));
  params.set("limit", String(limit));
  if (cursor !== null && cursor !== undefined && cursor !== "") params.set("cursor", String(cursor));
  const search = buildBaseSearch({ sort, filter, q, group });
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

// The catalog is a read projection: keep only the five fields the menu renders, so a
// malformed entry cannot smuggle a foreign node or an inline style into a row.
function normalizePropertyCatalog(catalog) {
  if (!Array.isArray(catalog)) return [];
  return catalog
    .filter((entry) => entry && typeof entry === "object" && typeof entry.key === "string" && entry.key)
    .map((entry) => ({
      key: entry.key,
      label: typeof entry.label === "string" && entry.label ? entry.label : entry.key,
      kind: typeof entry.kind === "string" ? entry.kind : null,
      checked: entry.checked === true,
      source: typeof entry.source === "string" ? entry.source : null,
    }));
}

// The grouped DTO stays as the transport sent it: the kanban layout (an on-demand
// asset, kanban-runtime.js `normalizeKanbanGroups`) owns the null-vs-[] distinction,
// because `null` (no grouping declared) and `[]` (a legal empty partition) are the two
// states it must tell apart. The grouping menu and the table's group headings read it
// through `effectiveGroupBy` instead of re-deriving a rule.

// `{ property, direction }` or null — the declared rule in `.base` spelling.
function normalizeGroupDeclaration(raw) {
  if (!raw || typeof raw !== "object") return null;
  const property = typeof raw.property === "string" ? raw.property : "";
  if (!property) return null;
  return { property, direction: raw.direction === "DESC" ? "DESC" : "ASC" };
}

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
  // The declaration is part of every page response (it belongs to the view, not the window),
  // so a load-more refresh keeps it current; an older DTO without the field clears it rather
  // than leaving a stale declaration from the previous view.
  state.viewSort = Array.isArray(dto.viewSort)
    ? dto.viewSort.filter((entry) => entry && typeof entry.key === "string" && entry.key)
      .map((entry) => ({ key: entry.key, dir: entry.dir === "desc" ? "desc" : "asc" }))
    : [];
  // The DECLARED grouping rule is part of the view, so it rides every page response; a
  // DTO without the field (older server) clears it instead of leaving a stale rule.
  state.viewGroupBy = normalizeGroupDeclaration(dto.viewGroupBy);
  if (dto.propertyCatalog !== undefined) state.propertyCatalog = normalizePropertyCatalog(dto.propertyCatalog);
  const rows = normalizeRows(dto.rows);
  state.rows = append ? state.rows.concat(rows) : rows;
  state.groups = dto.groups === undefined ? null : dto.groups;
  state.totalMatched = Number.isFinite(dto.totalMatched) ? dto.totalMatched : state.rows.length;
  state.truncated = Boolean(dto.truncated);
  state.nextCursor = dto.nextCursor === undefined ? null : dto.nextCursor;
  state.supportedSubset = dto.supportedSubset !== false;
  state.capabilities = dto.capabilities && typeof dto.capabilities === "object" ? dto.capabilities : null;
  // U12: the filter summary is a read-only projection and stays as the transport
  // sent it (like `groups`), because the filter menu is the only consumer and it
  // owns the null-vs-empty distinction and every guard on a malformed layer. A
  // partial (load-more) page never clears it.
  if (dto.filters !== undefined) state.filters = dto.filters && typeof dto.filters === "object" ? dto.filters : null;
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
