// The eager half of the kanban layout: the gate only.
//
// kanban is the 4th desktop Base view (RECON §1.1) and the one layout whose
// implementation ships as an ON-DEMAND asset (`src/app/assets/kanban.js`, built from
// kanban-runtime.js). This module holds what the always-loaded bundle still needs: the
// URL the shell published and the (empty) wrapper the renderer mounts synchronously.
// Same shape as the Mermaid gate (features/reader/mermaid-lazy.js) and the canvas asset
// precedent (RECON §6 刀2).
//
// There is deliberately NO import cache here. The ES module map already keys modules by
// URL, dedups loads that are still in flight, and hands back one instance, so three
// renders of the same view are one request without any eager-side bookkeeping
// (`evidence/probe-import-dedup.mjs`: sequential AND concurrent imports of one URL =>
// 1 request / 1 resource entry / same exports; a different `?v=` => a different module).
// A hand-written `Map` of pending promises was measuring ~50 gzip of the first-screen
// budget to re-implement that guarantee (BRIEF-LAZY-2 §1).
//
// It is the layout's whole first-screen cost — deliberately kept to these few lines,
// because the ratchet is on this bundle. The board, its CSS, the `columnWidth` slider
// domain and the empty/error lines all live in the lazy asset.
const CHUNK_ATTR = "data-kanban-src";
// The selector is kept as a literal (not `script[${CHUNK_ATTR}]`) so the minified bundle
// carries one string instead of a template build: keep it in sync with CHUNK_ATTR.
export const KANBAN_LOAD_ERROR_TEXT = "This Kanban view could not be loaded.";

/** The versioned chunk URL the shell published; "" when the shell predates this slice. */
export function kanbanChunkUrl(doc) {
  return doc?.querySelector?.("script[data-kanban-src]")?.getAttribute(CHUNK_ATTR) || "";
}

/** The lazy runtime module for `url` (or the shell's): one request per URL per page. */
export function loadKanbanRuntime({ doc, url } = {}) {
  const href = url || kanbanChunkUrl(doc);
  return href ? import(href) : Promise.resolve(null);
}

/**
 * Returns the `{ wrap, headRow }` shape the eager layouts return, plus `done` (the
 * promise the renderer awaits). Failure is fail-closed: an explicit `[data-kanban-error]`
 * line, never a silent table fallback (BRIEF §1 / pin ③).
 *
 * The error line has to stay here rather than in the asset: both paths that reach it
 * (`chunk-unavailable`, `chunk-failed`) mean the asset is NOT loaded, so there is no
 * module left to render the message (BRIEF-LAZY-2 §3).
 *
 * `request` is passed through to the asset untouched (the view builds the exact object
 * `buildKanbanBoard` wants), so the seven property names that cross the dynamic-import
 * boundary are written once at the call site and once in the runtime, not three times.
 */
export function buildKanbanLazily({ doc, url, ...request }) {
  const wrap = doc.createElement("div");
  wrap.className = "base-kanban-wrap";
  const done = loadKanbanRuntime({ doc, url })
    .then((runtime) => {
      if (!runtime || typeof runtime.buildKanbanBoard !== "function") return fail("chunk-unavailable");
      runtime.injectKanbanStyles(doc);
      const built = runtime.buildKanbanBoard({ doc, ...request });
      wrap.replaceChildren(built.node);
      return wrap;
    })
    .catch(() => fail("chunk-failed"));

  function fail(reason) {
    const error = doc.createElement("div");
    error.className = "base-kanban-error";
    error.setAttribute("role", "alert");
    error.setAttribute("data-kanban-error", reason);
    error.textContent = KANBAN_LOAD_ERROR_TEXT;
    wrap.replaceChildren(error);
    return wrap;
  }

  return { wrap, headRow: null, done };
}
