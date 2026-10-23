// Base document navigation orchestration (B4 wiring).
//
// Shared upper coordination for note/base navigation: dirty protection, abort,
// document-identity switch, Base surface lifecycle and history commit. The
// Markdown loader stays in core/app.js; the Base loader/surface stays in
// features/bases. This module is the only bridge between them.
//
// References: contract §10.1–§10.2, §15.7; WB-02 (read-only), WB-04 (typed
// document), WB-09 (dirty protection), WB-10 (XSS containment via A4 view).
//
// Guarantees:
// - dirty Markdown + rejected confirmation changes nothing and sends no request;
// - on confirm the surface switches first, history is committed only after a
//   successful Base load, and a failed Base load restores the Markdown document
//   (no blank half-switch);
// - a monotonic openSeq fences late Base responses so rapid A/B or note<->base
//   interleaving can never write a stale document;
// - the Base surface never enters the note save queue and never calls
//   markdownEditor.setValue.

import { BASE_SURFACE_CSS, createBaseSurface } from "../bases/index.js";
import { enhanceSelects } from "../../ui/select.js";
import {
  DOCUMENT_KIND_BASE,
  createDocumentKindController,
  readInitialBaseTarget,
} from "../bases/document-kind.js";

export const DIRTY_BASE_CONFIRM = "当前修改尚未保存，仍要打开 Base 吗？";

// Adapt the app's JSON `api` client to the Response-like fetch contract the A4
// Base controller expects. 401 handling stays in the api client (redirect).
function createApiFetch(api) {
  return async function baseFetch(url, options = {}) {
    try {
      const data = await api(url, options);
      return { ok: true, status: 200, json: async () => data };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return {
        ok: false,
        status: Number(error?.status) || 0,
        json: async () => ({ error: error?.message || "Base request failed.", code: error?.code ?? null }),
      };
    }
  };
}

function ensureBaseHost(doc, documentHost, provided) {
  if (provided) return provided;
  let node = typeof doc.getElementById === "function" ? doc.getElementById("base-host") : null;
  if (!node) {
    node = doc.createElement("div");
    node.id = "base-host";
    node.hidden = true;
    documentHost?.appendChild(node);
  }
  return node;
}

function injectBaseStyles(doc, host) {
  const scope = host?.ownerDocument || doc;
  if (!scope || !scope.createElement) return;
  const style = scope.createElement("style");
  style.setAttribute("data-base-surface", "");
  style.textContent = BASE_SURFACE_CSS;
  (scope.head || scope.documentElement)?.appendChild(style);
}

export function createBaseNavigation({
  state,
  session,
  api,
  toast = () => {},
  confirm: confirmOption,
  documentHost,
  editorHost,
  preview,
  controls = {},
  pathLabel = null,
  commit = () => false,
  openNote = () => false,
  // Outline lifecycle: entering a Base document clears the note outline to its
  // empty state; a failed Base open restores the note outline. Kept as injected
  // callbacks so this wiring stays free of the context-pane module.
  clearOutline = null,
  refreshOutline = null,
  abortNoteOpen = () => {},
  abortRefresh = () => {},
  isVaultSwitching = () => false,
  syncStatus = () => {},
  getVaultId = () => state.vaultId,
  createNote = null,
  doc = globalThis.document,
  host: providedHost = null,
  fetchImpl = null,
  locationObject = undefined,
  historyObject = undefined,
  windowObject = undefined,
} = {}) {
  const confirmFn = confirmOption
    ?? (typeof globalThis.confirm === "function" ? globalThis.confirm.bind(globalThis) : (() => true));
  const host = ensureBaseHost(doc, documentHost, providedHost);
  injectBaseStyles(doc, host);
  let openSeq = 0;

  const kind = createDocumentKindController({
    state,
    documentHost,
    editorHost,
    preview,
    baseHost: host,
    controls,
    pathLabel,
    syncStatus,
  });

  const surface = createBaseSurface({
    host,
    fetchImpl: fetchImpl ?? createApiFetch(api),
    // The Base view selector must use the app's own dropdown component, never the
    // native one: enhance the freshly rendered subtree after every mount.
    enhance: (root) => enhanceSelects(root),
    onCreateNote: (folderPath, name) => createNote?.(folderPath, name),
    locationObject,
    historyObject,
    windowObject,
    onOpenNote: ({ path } = {}) => { if (path) void openNote(path); },
    onError: (error) => {
      if (!error || error.code === "superseded" || error.code === "aborted") return;
      toast(error.message, true);
    },
  });

  function invalidate() {
    openSeq += 1;
    return openSeq;
  }

  // Leaving the Base document for a Markdown note: the Base host is only hidden, so its
  // enhanced controls must release their document listeners instead of owning the keyboard of
  // the note that is now on screen (#409 review).
  function exitToNote() {
    surface.release();
    kind.enterNote();
  }

  async function openBase({
    path,
    route = null,
    vaultId = null,
    view = null,
    sort = null,
    filter = null,
    q = null,
    historyMode = "push",
    fragment = "",
  } = {}) {
    if (isVaultSwitching()) return false;
    if (!path) return false;
    const fromBase = state.documentKind === DOCUMENT_KIND_BASE;
    if (!fromBase && session.isDirty() && !confirmFn(DIRTY_BASE_CONFIRM)) return false;

    const seq = ++openSeq;
    abortNoteOpen();
    abortRefresh();
    // Drop any pending Markdown open so it cannot commit after the surface switch.
    session.invalidateInFlightReads();
    kind.enterBase(path);
    // The outline describes a Markdown note only; drop the stale note headings as
    // soon as the surface leaves the note (empty state text is owned by outline).
    clearOutline?.();

    const result = await surface.open({ vaultId: vaultId ?? state.vaultId ?? null, path, route, view, sort, filter, q });
    if (seq !== openSeq) return false; // superseded: never touch a newer document
    if (!result?.ok) {
      if (fromBase) {
        state.path = surface.getState().path ?? path;
        syncStatus();
      } else {
        // Restored to the previous note: re-render the outline we cleared above.
        kind.enterNote();
        refreshOutline?.();
      }
      return false;
    }

    // Confirmed discard of the previous Markdown local edits, only after Base loaded.
    if (session.isDirty()) session.setLiveText(session.baseText);
    const openedPath = surface.getState().path ?? path;
    state.path = openedPath;
    const openedVaultId = vaultId ?? state.vaultId ?? getVaultId() ?? null;
    if (openedVaultId) state.vaultId = openedVaultId;
    syncStatus();

    const resolvedRoute = route || surface.getRoute();
    if (historyMode !== "none" && resolvedRoute) {
      commit({
        route: resolvedRoute,
        path: openedPath,
        vaultId: openedVaultId,
        documentKind: DOCUMENT_KIND_BASE,
        fragment,
      }, historyMode);
    }
    return true;
  }

  function initialDeepLink() {
    return readInitialBaseTarget(doc, globalThis.location);
  }

  return {
    openBase,
    invalidate,
    exitToNote,
    initialDeepLink,
    getHost: () => host,
    getSurface: () => surface,
    destroy() {
      invalidate();
      surface.destroy();
    },
  };
}
