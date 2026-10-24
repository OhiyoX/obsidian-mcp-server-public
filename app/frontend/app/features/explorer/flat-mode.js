// Explorer flat-view mode slice (Phase 2) — the browse mode, the flat sort
// preference, the flat list itself and the two flat controls.
//
// Extracted from `controller.js` so that file stays inside the architecture line
// budget and so this slice stays cohesive: it owns everything whose authority is the
// flat view, and nothing else. The injected callbacks are the shared Explorer state it
// must not duplicate (`search` state, the current note path, the Tree controller).
//
// Data-source rule (frozen contract): with an ACTIVE QUERY the flat list is a
// client-side projection of the already-loaded search rows, ordered by the frozen
// `sortFlatNotes` model. With NO QUERY the flat list is the server's flat keyset page
// (`flat=1`), so paging and the cursor stay consistent with the server order.
import { createFlatListController } from "./flat-controller.js";
import {
  coerceFlatSort,
  effectiveFlatSort,
  readExplorerMode,
  readFlatSort,
  writeExplorerMode,
  writeFlatSort,
} from "./flat-preference.js";
import { initializeExplorerFlatControls } from "./flat-control.js";
import { renderFlatList, toFlatRecords } from "./flat-view.js";
import { sortFlatNotes } from "./sort-model.js";

export function createFlatMode({
  api,
  storage,
  host,
  tree,
  search,
  getPath,
  openNote,
  isCurrentNotePath,
  isQueryActive,
  loadMoreSearch,
  onRender = () => {},
  onStatus = () => {},
}) {
  let mode = readExplorerMode(storage);
  let preference = readFlatSort(storage);
  let controls = null;

  const list = createFlatListController({
    api: (url, options) => api(url, options),
    onChange: () => onRender(),
    onError: (error) => onStatus(error),
  });

  // The spec the *current source* can actually honour. The stored preference keeps the
  // user's choice; narrowing here is what makes a query-only key (`name`, `score`)
  // harmless once the query is gone instead of silently ordering by nothing.
  function spec() {
    return effectiveFlatSort(preference, { query: isQueryActive() });
  }

  // The files panel head carries the mode: CSS shows exactly one sort trigger per mode,
  // and the flat control re-derives which options the current source supports.
  function syncChrome() {
    const head = host?.parentElement?.querySelector?.(".panel-head") ?? null;
    head?.setAttribute("data-explorer-mode", mode);
    controls?.sync();
  }

  function render({ revealCurrent = false } = {}) {
    const scrollTop = host.scrollTop;
    const common = {
      host,
      isCurrent: (path) => isCurrentNotePath(path, getPath()),
      onNote: (path) => openNote(path),
      revealCurrent,
    };
    if (isQueryActive()) {
      renderFlatList({
        ...common,
        records: sortFlatNotes(toFlatRecords(search.items), spec(), { query: true }),
        loading: search.loading,
        hasMore: Boolean(search.nextCursor),
        onLoadMore: () => loadMoreSearch(),
      });
    } else {
      renderFlatList({
        ...common,
        records: toFlatRecords(list.state.items),
        loading: list.state.loading,
        error: list.state.error,
        hasMore: Boolean(list.state.nextCursor),
        onLoadMore: () => list.loadMore(),
        onRetry: () => list.retry(),
      });
    }
    if (!revealCurrent) host.scrollTop = scrollTop;
  }

  function load() {
    return list.load(spec());
  }

  // Switching the browse mode never touches the query or the search stream: with a
  // query active the flat list is rendered from the rows already in memory, and the
  // Tree's lazy expansion set is left exactly as it was for the switch back.
  async function setMode(next) {
    const value = next === "flat" ? "flat" : "tree";
    if (value === mode) return;
    mode = value;
    writeExplorerMode(storage, mode);
    syncChrome();
    if (mode === "flat") {
      // `load()` renders through onChange; a query does not need the server page.
      if (isQueryActive()) onRender();
      else await load();
      return;
    }
    // A boot straight into flat mode has no Tree root yet; materialize it so the
    // switch back lands on real rows instead of the initial loading placeholder.
    if (tree.isSortCurrent("")) onRender();
    else await tree.loadRoot();
  }

  // The flat sort is a local preference: with a query active it re-orders the loaded
  // rows with the frozen model; with no query it re-issues the flat page under the new
  // server order, so paging and the cursor stay consistent.
  function setSort(next) {
    preference = coerceFlatSort(next);
    writeFlatSort(storage, preference);
    controls?.sync();
    if (!isQueryActive() && mode === "flat") {
      list.load(spec());
      return;
    }
    onRender();
  }

  // Reveal in flat mode: a flat page has no anchor API, so walk the keyset stream until
  // the current note is present (bounded inside the list controller).
  async function reveal(path) {
    if (!path) return;
    list.invalidate();
    await load();
    await list.ensureVisible(path);
  }

  async function ensure(path) {
    if (!path) return;
    if (list.state.spec === null) await load();
    await list.ensureVisible(path);
  }

  controls = initializeExplorerFlatControls({
    getMode: () => mode,
    onMode: (next) => setMode(next),
    getFlatSort: () => spec(),
    onFlatSort: (next) => setSort(next),
    isQueryActive,
  });
  syncChrome();

  return {
    list,
    mode: () => mode,
    spec,
    render,
    load,
    setMode,
    setSort,
    reveal,
    ensure,
    syncChrome,
    storedSort: () => ({ ...preference }),
  };
}
