// Web Base record source (Wave B / B3).
//
// Supplies the frozen A3 `loadRecords({ vault, basePath })` dependency from the
// per-Vault Web Catalog instead of a request-time Vault scan (contract §6.1,
// WB-05). The Catalog already holds the full frontmatter value tree, tags,
// outbound link targets and stat/revision projections (A2), so a Base page only
// re-reads the target `.base` itself (A3 reader) and never recursive-readdirs the
// Vault or reads Markdown files.
//
// Mapping to the A1 record contract (base-query.js), which is NOT changed:
//   catalog { path, basename, frontmatter, tags, links: string[], size, created, modified }
//   A1      { path, basename, frontmatter, tags, links: [{ target }], stat: { size, created, modified } }
//
// Not-ready / incomplete is reported through the frozen return shape so the A3
// route maps it to 503 (`catalog-not-ready` / `catalog-incomplete`) and never
// serves a half-old/half-new snapshot:
//   { records: [], catalog: null, complete: false }  -> route 503 catalog-not-ready
//   { records, catalog: {...}, complete: false }     -> route 503 catalog-incomplete
import { getWebCatalogRuntime } from "./web-catalog/runtime.js";
import { NOTE_KIND } from "./web-catalog/store.js";

// A `.base` is a typed node, never a query record: the MCP vault-index only
// indexes Markdown notes, so the Web record source must match that membership.
const BASE_QUERY_KINDS = [NOTE_KIND];

function notReady() {
  return { records: [], catalog: null, complete: false };
}

// Pure shape adapter, exported so the wiring test can assert the mapping without
// standing up a catalog.
export function toBaseQueryRecords(documentRecords = []) {
  return documentRecords.map((record) => ({
    path: record.path,
    basename: record.basename,
    frontmatter: record.frontmatter ?? {},
    tags: Array.isArray(record.tags) ? record.tags : [],
    links: Array.isArray(record.links) ? record.links.map((target) => ({ target })) : [],
    stat: {
      size: record.size ?? null,
      created: record.created ?? null,
      modified: record.modified ?? null,
    },
  }));
}

export function loadRecords({ vault }) {
  let runtime;
  try {
    // Snapshot access only: a Base read must never kick off a full reconcile.
    runtime = getWebCatalogRuntime(vault, { startReconcile: false });
  } catch {
    return notReady();
  }
  if (!runtime) return notReady();

  const store = runtime.store;
  // Never-built is not an authoritative empty Vault (mirrors tree/search).
  if (!store.metaGet("lastReconciledAt")) return notReady();
  const catalogId = store.catalogId();
  if (typeof catalogId !== "string" || catalogId === "") return notReady();

  const metadata = store.listDocumentMetadata({ kinds: BASE_QUERY_KINDS });
  const records = toBaseQueryRecords(store.readDocumentRecords(metadata.map((row) => row.path)));

  return {
    records,
    catalog: {
      catalogId,
      generation: store.generation(),
      stale: store.isStale() || !runtime.status().covered,
    },
    // An incomplete projection must fail closed, not silently drop a field.
    complete: store.baseProjectionStatus().complete,
  };
}
