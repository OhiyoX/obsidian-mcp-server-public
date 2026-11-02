// Explorer + search-control wiring, extracted from core/app.js to keep it within
// the architecture line budget. Pure wiring: it only constructs the controllers and
// returns them; all behavior lives in the feature modules.
import { createExplorerController } from "../features/explorer/controller.js";
import { defaultAssetUrl } from "../features/context/outgoing.js";
import { initializeSearchControls } from "../features/search/controller.js";

// Desktop parity for attachment rows: the Explorer only emits the item, and this
// wiring opens it through the same authenticated asset route the Reader and the
// outgoing-links panel already use (`defaultAssetUrl`). No new route or API is
// introduced; a caller may inject `openFile`/`getAssetUrl`.
function openAssetInNewTab(url) {
  globalThis.window?.open?.(url, "_blank", "noopener,noreferrer");
}

export function initializeExplorerWiring({
  state,
  host,
  searchHost,
  statusHost,
  filesStatusHost,
  showView,
  api,
  toast,
  escapeHtml,
  openNote,
  createNote,
  searchInput,
  searchClear,
  searchCase,
  semanticSearch,
  publishesButton,
  revealButton,
  // Optional Base open seam (B4 supplies it from core/app.js). Backward compatible:
  // omitting it leaves Base opens as a no-op in this slice.
  onOpenBase,
  // Optional attachment open seam; defaults to the shared authenticated asset route.
  openFile,
  getAssetUrl = defaultAssetUrl,
}) {
  const explorer = createExplorerController({
    state,
    host,
    searchHost,
    statusHost,
    filesStatusHost,
    showView,
    api,
    toast,
    escapeHtml,
    openNote: (path) => openNote(path),
    createNote: (folderPath, name) => createNote(folderPath, name),
    openBase: (payload) => onOpenBase?.(payload),
    openFile: (item) => {
      if (typeof openFile === "function") return openFile(item);
      return openAssetInNewTab(getAssetUrl(item.path, "", state.vaultId ?? null));
    },
  });
  const loadNotes = explorer.load;
  const searchControls = initializeSearchControls({
    state,
    input: searchInput,
    clearButton: searchClear,
    caseButton: searchCase,
    semanticButton: semanticSearch,
    publishesButton,
    revealButton,
    loadNotes,
    revealCurrent: () => explorer.revealCurrent(),
    // The Publishes shortcut (#421) owns its own panel switch: the explorer only reacts
    // to a *new* query identity, which a repeated shortcut click does not produce.
    showSearchView: () => showView?.("search"),
  });
  return { explorer, loadNotes, searchControls };
}
