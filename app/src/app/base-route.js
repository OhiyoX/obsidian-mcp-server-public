// Registers the read-only Web Base API: GET /api/web/v1/base.
//
// Contract TODO §4.2/§8/§9. This router registers ONLY a GET handler, so an
// unmatched method falls through to the normal Express 404 (WB-02). The write face
// is a separate route: `PATCH /api/web/v1/base` + the raw view
// `GET /api/web/v1/base/raw` live in `base-patch-route.js` (A4b) so this frozen
// query DTO keeps one representation and one cache policy.
//
// ── B3 wiring contract (frozen by A3) ────────────────────────────────────────
//   registerBaseRoute(router, {
//     requireApi,                 // Express middleware; unauthenticated -> 401
//     currentVault(req),          // -> { id, root }; throws "Vault access denied" -> 403
//     readBase(vault, relPath),   // default base-reader.readBaseInRoot
//     loadRecords({ vault, basePath })
//       // -> { records, catalog: { catalogId, generation, stale }, complete }
//       // complete === false means the Base projection is incomplete and MUST be 503.
//     evaluateSnapshot({ raw, viewName, records, limit })
//       // -> { views, view: { name, type }, columns, rows, totalMatched, truncated,
//       //      supportedSubset, viewLimit }
//       // A1's queryBaseSnapshot must also return `views` (every declared view);
//       // when omitted, only the selected view is exposed.
//       // Wave C bounded-prefix pagination: the route passes the transport prefix
//       // (`offset + pageLimit`) and expects the adapter to have clamped the fetch to
//       // `min(viewLimit, prefix)`; `viewLimit` is the selected view's declared
//       // semantic limit (null = none). The route slices [offset, offset + pageLimit)
//       // and caps the page at `viewLimit`, so the transport window never overrides
//       // the Base view's own limit.
//     parseBaseError(error)       // optional; -> { status, code } | null for BaseQueryError-style errors
//     evaluateSnapshot({ raw, viewName, records, limit, sortOverride, filterExtra, textQuery })
//       // The three optional frozen overrides (`sort` / `filter` / `q`) are passed
//       // straight through to the canonical A1 service; an absent override never
//       // changes MCP behavior.
//   })
//
// The frozen query-parameter contract (path/view/limit/cursor + sort/filter/q)
// lives in base-params.js; this file owns HTTP status mapping and page slicing.
//
// The production createWebAppRouter applies the `/api/web/v1` securityHeaders
// (no-store/CSP/frame/nosniff/referrer); this route also sets Cache-Control:
// no-store itself so a directly-mounted handler stays no-store by construction.
import { encodeDocumentRoute } from "../publish/service.js";
import {
  BASE_ORDER_CONTRACT_VERSION,
  BaseCursorError,
  assertBaseCursorMatches,
  decodeBaseCursor,
  encodeBaseCursor,
} from "./base-cursor.js";
import { BaseReaderError, readBaseInRoot } from "./base-reader.js";
// Re-exported for existing importers/tests; the implementation now lives in
// base-params.js so the route stays focused on status mapping and slicing.
export { BASE_LIMIT_DEFAULT, BASE_LIMIT_MAX, BASE_LIMIT_MIN, BaseHttpError, parseBaseLimit, parseBaseQuery } from "./base-params.js";
import { BaseHttpError, parseBaseQuery } from "./base-params.js";

function summarizeView(view) {
  return {
    name: typeof view?.name === "string" ? view.name : null,
    type: typeof view?.type === "string" ? view.type : null,
  };
}

function summarizeViews(views, selected) {
  const list = Array.isArray(views) && views.length > 0 ? views : selected ? [selected] : [];
  return list.map(summarizeView);
}

function normalizeFormulaColumn(value) {
  if (!value || typeof value !== "object") return null;
  return {
    name: typeof value.name === "string" ? value.name : null,
    expression: typeof value.expression === "string" ? value.expression : null,
    displayName: typeof value.displayName === "string" ? value.displayName : null,
  };
}

function normalizeColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns.map((column) => ({
    key: column?.key ?? null,
    label: column?.label ?? column?.key ?? null,
    kind: column?.kind ?? null,
    // Only a formula column gains the key: the pre-existing DTO shape (and its
    // HTTP contract test) stays byte-identical for every other column.
    ...(column?.kind === "formula" ? { formula: normalizeFormulaColumn(column.formula) } : {}),
  }));
}

function normalizeRow(row) {
  return { path: row?.path ?? null, values: row?.values ?? null };
}

// TRANSPORT passthrough of an A1 field the route used to drop: `groups` is the
// frozen cut-4 partition DTO (`base-query.js` buildGroupingDto) and carries no
// semantics of its own -- the route re-projects it, exactly like `columns` and
// `rows`, so the kanban layout can render one column per group. The key stays
// ABSENT when the view declares neither `groupBy` nor `summaries`, which is what
// keeps every pre-cut-4 document's DTO byte-identical.
function normalizeGroup(group) {
  return {
    key: group?.key ?? null,
    keyType: typeof group?.keyType === "string" ? group.keyType : null,
    count: Number.isSafeInteger(group?.count) ? group.count : 0,
    rowPaths: Array.isArray(group?.rowPaths) ? group.rowPaths.filter((path) => typeof path === "string") : [],
  };
}

async function resolveBasePage(deps, vault, options) {
  const readBase = deps.readBase || readBaseInRoot;
  const base = await readBase(vault, options.path);
  const decoded = decodeBaseCursor(options.cursor);
  const offset = decoded ? decoded.offset : 0;

  const loaded = await deps.loadRecords({ vault, basePath: base.path });
  const catalog = loaded?.catalog;
  if (!catalog || typeof catalog.catalogId !== "string" || catalog.catalogId === "") {
    throw new BaseHttpError(503, "catalog-not-ready", "Base catalog is not ready");
  }
  // An incomplete projection must never be served as a half-old/half-new result.
  if (loaded.complete === false) {
    throw new BaseHttpError(503, "catalog-incomplete", "Base catalog projection is incomplete");
  }

  // Pagination uses the frozen A1 queryBaseSnapshot signature: the adapter asks
  // for a bounded prefix (`min(viewLimit, offset + pageSize)`), never the full
  // result set, and this route slices the requested window.
  const result = await deps.evaluateSnapshot({
    raw: base.raw,
    viewName: options.view,
    records: loaded.records || [],
    limit: offset + options.limit,
    sortOverride: options.sort ?? undefined,
    filterExtra: options.filter ?? undefined,
    textQuery: options.textQuery ?? undefined,
  });
  if (result?.supportedSubset !== true) {
    throw new BaseHttpError(422, "unsupported", "Base view uses unsupported configuration");
  }

  const view = summarizeView(result.view);
  // Any change to the selected view or to the frozen query overrides makes the
  // cursor stale (409): a page must never stitch two different result orders.
  const cursorIdentity = {
    catalogId: catalog.catalogId,
    generation: catalog.generation,
    path: base.path,
    revision: base.revision,
    view: view.name,
    orderContract: BASE_ORDER_CONTRACT_VERSION,
    sort: options.sortIdentity,
    filter: options.filterIdentity,
    q: options.queryIdentity,
  };
  if (decoded) assertBaseCursorMatches(decoded, cursorIdentity);

  // The selected view's declared semantic limit is a hard ceiling on the rows a
  // Web page may expose; the transport `limit` is only a window. `totalMatched`
  // stays the true match count, while `effectiveTotal` is what pagination can
  // reach. `truncated` and `nextCursor` share the same predicate.
  const viewLimit = Number.isSafeInteger(result.viewLimit) && result.viewLimit > 0 ? result.viewLimit : null;
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const pageEnd = viewLimit ? Math.min(offset + options.limit, viewLimit) : offset + options.limit;
  const pageRows = rows.slice(offset, pageEnd);
  const totalMatched = Number.isSafeInteger(result.totalMatched) ? result.totalMatched : pageRows.length;
  const effectiveTotal = viewLimit ? Math.min(totalMatched, viewLimit) : totalMatched;
  const hasMore = offset + pageRows.length < effectiveTotal;
  const nextCursor = hasMore
    ? encodeBaseCursor({
        ...cursorIdentity,
        offset: offset + pageRows.length,
      })
    : null;

  return {
    vaultId: vault.id,
    path: base.path,
    route: `/app/base/${encodeDocumentRoute(vault.id, base.path)}`,
    revision: base.revision,
    views: summarizeViews(result.views, view),
    view,
    columns: normalizeColumns(result.columns),
    rows: pageRows.map(normalizeRow),
    ...(Array.isArray(result.groups) ? { groups: result.groups.map(normalizeGroup) } : {}),
    totalMatched,
    truncated: hasMore,
    nextCursor,
    supportedSubset: true,
    capabilities: { editable: false, grouping: false, aggregation: false },
    catalog: {
      catalogId: catalog.catalogId,
      generation: catalog.generation,
      stale: catalog.stale === true,
    },
  };
}

// Error bodies only ever contain a stable code: never absolute paths, Vault
// names, SQLite paths, tokens or stacks (§9).
function mapBaseError(error, deps) {
  if (error instanceof BaseHttpError) return { status: error.status, code: error.code };
  if (error instanceof BaseCursorError) {
    return error.code === "BASE_CURSOR_STALE"
      ? { status: 409, code: "cursor-stale" }
      : { status: 400, code: "cursor-invalid" };
  }
  if (error instanceof BaseReaderError) {
    return error.code === "BASE_TOO_LARGE"
      ? { status: 413, code: "base-too-large" }
      : { status: 404, code: "base-not-found" };
  }
  if (typeof deps?.parseBaseError === "function") {
    const mapped = deps.parseBaseError(error);
    if (mapped && Number.isInteger(mapped.status) && typeof mapped.code === "string") return mapped;
  }
  const code = String(error?.code || "");
  if (code === "invalid-yaml" || code === "invalid-schema" || code === "unsupported") {
    return { status: 422, code };
  }
  if (code === "view-not-found") return { status: 404, code: "view-not-found" };
  if (error?.message === "Vault access denied") return { status: 403, code: "Vault access denied" };
  if (code === "ENOENT") return { status: 404, code: "base-not-found" };
  return { status: 500, code: "Request failed" };
}

function sendBaseError(res, error, deps) {
  const mapped = mapBaseError(error, deps);
  // 503 is an expected availability state; only unknown IO (500) keeps a server log.
  if (mapped.status === 500) console.error("Obsidian Web Base API error:", error);
  // A formula failure additionally carries its stable class and the declared
  // formula name (see `formulaFailure` in base-query.js): never an absolute path,
  // Vault name, SQLite path, token, stack or formula *source*. The name is a key
  // of the caller's own `.base`, whose column keys the success DTO already
  // publishes.
  const body = { error: mapped.code };
  const failure = error?.formulaFailure;
  if (failure && typeof failure.code === "string") {
    body.formula = { code: failure.code, name: typeof failure.name === "string" ? failure.name : null };
  }
  res.status(mapped.status).json(body);
}

export function registerBaseRoute(router, deps) {
  router.get("/api/web/v1/base", deps.requireApi, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      // Validate query parameters before any Vault/catalog access so an invalid
      // request never triggers IO.
      const options = parseBaseQuery(req.query || {});
      const vault = await deps.currentVault(req);
      const payload = await resolveBasePage(deps, vault, options);
      res.json(payload);
    } catch (error) {
      sendBaseError(res, error, deps);
    }
  });
}
