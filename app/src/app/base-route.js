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
//     evaluateSnapshot({ raw, viewName, records, limit, sortOverride, filterExtra, textQuery, groupOverride })
//       // The four optional frozen overrides (`sort` / `filter` / `q` / `group`) are
//       // passed straight through to the canonical A1 service; an absent override
//       // never changes MCP behavior.
//   })
//
// The frozen query-parameter contract (path/view/limit/cursor + sort/filter/q/group)
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
import { buildPropertyCatalog } from "../base-property-catalog.js";
import { BASE_FILTER_CONJUNCTIONS, BASE_FILTER_OPERATORS } from "../base-query.js";
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

function normalizeViewSort(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.key !== "string" || !item.key) continue;
    out.push({ key: item.key, dir: item.dir === "desc" ? "desc" : "asc" });
  }
  return out;
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

// ── U12: the two declared filter layers, as a read-only menu projection ─────
//
// `filters: { base, view }` is ADDITIVE (the desktop filter menu's `所有视图` /
// `当前视图` sections). Each layer is `null` when that layer declares no `filters:`,
// otherwise `{ conjunction, count, conditions: [{property, operator, value,
// expression}] }` where `count` is the number of LEAF conditions (the desktop
// `.flair` number) and a leaf that is not a plain `reference <op> literal`
// comparison carries its raw `expression` with the triple left null. The key is
// always present so a client never has to tell "absent" from "not supported",
// and every value is re-normalized here: the route never forwards a shape it has
// not bounded itself (§9).
function normalizeFilterCondition(condition) {
  if (!condition || typeof condition !== "object") return null;
  const text = (value) => (typeof value === "string" ? value : null);
  const scalar = (value) => (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null
  );
  return {
    property: text(condition.property),
    operator: BASE_FILTER_OPERATORS.includes(condition.operator) ? condition.operator : null,
    value: scalar(condition.value),
    expression: text(condition.expression),
  };
}

function normalizeFilterLayer(layer) {
  if (!layer || typeof layer !== "object") return null;
  const conditions = Array.isArray(layer.conditions)
    ? layer.conditions.map(normalizeFilterCondition).filter(Boolean)
    : [];
  return {
    conjunction: BASE_FILTER_CONJUNCTIONS.includes(layer.conjunction) ? layer.conjunction : null,
    count: Number.isSafeInteger(layer.count) && layer.count >= 0 ? layer.count : conditions.length,
    conditions,
  };
}

function normalizeFilterSummary(summary) {
  return {
    base: normalizeFilterLayer(summary?.base),
    view: normalizeFilterLayer(summary?.view),
  };
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

// ADDITIVE (lane desktop-re/bases-grouping): the selected view's DECLARED `groupBy`
// in the same `{ property, direction }` shape the `.base` file uses, so the
// `分组依据` menu can open on the document's own rule instead of a blank page.
// The effective rule the reader sees is `?group=` (when present) over this one.
function normalizeViewGroupBy(groupBy) {
  if (!groupBy || typeof groupBy !== "object") return null;
  if (typeof groupBy.property !== "string" || groupBy.property === "") return null;
  return { property: groupBy.property, direction: groupBy.direction === "DESC" ? "DESC" : "ASC" };
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
    groupOverride: options.group ?? undefined,
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
    group: options.groupIdentity,
  };
  if (decoded) assertBaseCursorMatches(decoded, cursorIdentity);

  // The selected view's declared semantic limit is a hard ceiling on the rows a
  // Web page may expose; the transport `limit` is only a window. `totalMatched`
  // stays the true match count, while `effectiveTotal` is what pagination can
  // reach. `truncated` and `nextCursor` share the same predicate.
  const viewLimit = Number.isSafeInteger(result.viewLimit) && result.viewLimit > 0 ? result.viewLimit : null;
  const rows = Array.isArray(result.rows) ? result.rows : [];
  // The property catalog (see the `propertyCatalog` field below) is scoped to the records
  // that survived the view filter, which is what the desktop menu reflects. `result.rows`
  // carries the matched prefix; map it back onto the loaded records so the frontmatter the
  // catalog reads is the same tree the query evaluated.
  const matchedPaths = new Set(rows.map((row) => row?.path).filter((path) => typeof path === "string"));
  const matchedRecords = matchedPaths.size > 0
    ? (loaded.records || []).filter((record) => matchedPaths.has(record?.path))
    : [];
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
    // ADDITIVE (lane desktop-re/panel-sort): the selected view's DECLARED sort, in the
    // frozen override shape (`[{ key, dir }]`). The sort menu seeds its rows from it
    // (`loadSort()` reads the view config on the desktop, asar app.js@2527053) and the
    // URL override still wins whenever the client sends one. A caller that ignores the
    // field keeps today's behavior byte for byte, and the evaluated row order is
    // unchanged (the server already applies the view's own `sort:`).
    viewSort: normalizeViewSort(result.viewSort),
    // ADDITIVE (lane desktop-re/bases-grouping): the selected view's DECLARED grouping
    // rule (`null` when it declares none). The menu seeds its single row from it; the
    // `?group=` override still wins whenever the client sends one. A caller that ignores
    // the field keeps today's behavior byte for byte.
    viewGroupBy: normalizeViewGroupBy(result.viewGroupBy),
    columns: normalizeColumns(result.columns),
    // ADDITIVE (lane desktop-re/panel-properties): the desktop Properties menu lists the
    // whole property catalog — the checked rows are exactly this view's `order`, the
    // unchecked ones are the Base's declared properties, the built-in `file.*` names and
    // the frontmatter keys the MATCHED records really hold.
    //
    // SCOPE (coordinator, verified against the owner's own vault): the catalog is built
    // from the rows that survived the view filter, NOT from every record in the Base's
    // directory. Evidence: `_Workspace/40-Projects` holds 59 distinct frontmatter keys
    // across 367 notes, but the 25 notes the `开发 dev` view matches carry 17 — and the
    // owner's desktop screenshot lists exactly the non-checked subset of those 12
    // (archived…source_commit) plus the built-ins. Sampling the whole directory gave 74
    // rows, visibly more than the desktop shows.
    // Caveat (recorded, not hidden): `result.rows` is the bounded prefix the adapter was
    // asked for (`offset + limit`), so on a Base whose matched set exceeds that prefix the
    // catalog covers the prefix only.
    // Contract: docs/bases/BASES-COMPATIBILITY-MATRIX.md.
    propertyCatalog: buildPropertyCatalog({
      base: { path: base.path, raw: base.raw },
      columns: Array.isArray(result.columns) ? result.columns : [],
      records: matchedRecords,
    }),
    rows: pageRows.map(normalizeRow),
    ...(Array.isArray(result.groups) ? { groups: result.groups.map(normalizeGroup) } : {}),
    totalMatched,
    truncated: hasMore,
    nextCursor,
    supportedSubset: true,
    // Grouping is EXECUTED (刀4) and a view's `groupBy` is writable through
    // `PATCH /api/web/v1/base` (`set-view-option`), so this is a real capability, not a
    // conservative placeholder: `分组` appears exactly when the server can partition.
    // `aggregation` stays false until a summaries surface exists.
    capabilities: { editable: false, grouping: true, aggregation: false },
    filters: normalizeFilterSummary(result.filters),
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
