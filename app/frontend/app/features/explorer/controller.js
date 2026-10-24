import { createLazyTreeController } from "./lazy-controller.js";
import { createExplorerPrefetchIntent } from "./prefetch.js";
import { createExplorerTouchPrefetchIntent } from "./prefetch-touch.js";
import { bindFolderTouchIntent } from "./prefetch-touch-bind.js";
import { ancestorChain, treeRenderSignature } from "./lazy-model.js";
import { createExplorerCreateEntries, hasActiveDraft, setDraftSettledHandler, settleActiveDraft } from "./create-draft.js";
import { renderLazyExplorer } from "./tree.js";
import { createSettledReveal } from "./reveal-visibility.js";
import { isSameNotePath, normalizePath } from "./path-identity.js";
import { normalizeSortSpec, sortSpecEquals } from "./sort-spec.js";
import { initializeExplorerSortControl } from "./sort-control.js";
import { readExplorerSort, resolveExplorerSortStorage, writeExplorerSort } from "./sort-preference.js";
import { createFlatMode } from "./flat-mode.js";
import {
  applySearchPage,
  beginSearch,
  beginSearchMore,
  createSearchState,
  endSearch,
  isSearchActive,
  resetSearch,
  searchErrorStatus,
  searchIdentity,
  searchPageUrl,
  searchStatus,
} from "../search/search-state.js";
import { renderSearchResults, syncSearchChrome } from "../search/search-view.js";

// Phase 2B lazy Explorer + lazy Tree sorting adaptation.
//
// The Tree is authoritative from the server per parent under the current SortSpec:
// switching the sort re-issues lazy children requests. Search is independently v2-backed;
// its server order is authoritative and Explorer sort must never re-order search rows.
//
// U4: the left sidebar shows one panel at a time (files / search) and each panel owns
// its own list host, so both views are rendered from the same model and switching tabs
// never has to refetch or rebuild the other one. `showView` only reports which panel a
// user-driven change should bring to the front; the chrome owns the tab state itself.
export function createExplorerController({ state, host, searchHost, statusHost, filesStatusHost, api, toast, escapeHtml, openNote, createNote, openBase, openFile, showView }) {
  const sortStorage = resolveExplorerSortStorage();
  // Strict global preference, read synchronously before the first Tree render.
  let requestedSort = normalizeSortSpec(readExplorerSort(sortStorage));
  let pendingSort = null;

  const tree = createLazyTreeController({
    api: (url, options) => api(url, options),
    initialSort: requestedSort,
    onChange: () => render(),
    onRevealSettled: createSettledReveal({
      host, render, getCurrentPath: () => state.path, isFlatMode: () => flat.mode() === "flat",
      isQueryActive: () => isQueryActive(),
    }),
    onError: (error) => {
      // Non-retryable catalog failures surface a status; a first-reconcile race is
      // retried inside the controller (bounded backoff) and then recovered by the
      // server's catalog-ready resync.
      if (error?.status === 503) setStatus("目录索引尚未就绪，请稍候…", "warning", "", "files");
      else if (error?.status) setStatus("目录加载失败，请重试", "error", "", "files");
    },
  });
  // Issue #284 B2: one hover-intent instance per controller, built from the frozen A1
  // factory and handed the B1 `prefetch` / `cancelPrefetch` API. The renderer only
  // emits pointer events; every timer, capability and network rule stays in A1/B1.
  const prefetchIntent = createExplorerPrefetchIntent({ controller: tree });
  // Issue #337 Cut 1: the touch policy is a second instance of the same frozen seam — same
  // `tree.prefetch` / `tree.cancelPrefetch` API, its own capability gate (hover:none or
  // coarse pointer), its own 100 ms window. It is delegated once on the list host because
  // the renderer rebuilds every row on each paint (see `prefetch-touch-bind.js`).
  const touchIntent = createExplorerTouchPrefetchIntent({ controller: tree });
  bindFolderTouchIntent({ host, intent: touchIntent });
  const search = createSearchState();

  // Flat view (Phase 2) owns its own mode/sort preferences, list controller, paging
  // and rendering; this controller keeps only the shared state it must not duplicate.
  const flat = createFlatMode({
    api,
    storage: sortStorage,
    host,
    tree,
    search,
    getPath: () => state.path,
    openNote,
    isCurrentNotePath: isSameNotePath,
    isQueryActive: () => isSearchActive(search),
    loadMoreSearch: () => loadMoreSearch(),
    onRender: () => render(),
    onStatus: (error) => {
      if (error?.status === 503) setStatus("目录索引尚未就绪，请稍候…", "warning", "", "files");
      else if (error?.status) setStatus("目录加载失败，请重试", "error", "", "files");
    },
  });

  function setStatus(text, kind = "", title = "", target = "search") {
    const element = target === "files" ? filesStatusHost : statusHost;
    if (!element) return;
    element.textContent = text;
    element.title = title;
    element.classList.toggle("warning", kind === "warning");
    element.classList.toggle("error", kind === "error");
  }

  // Errors belong to the panel they came from; the clear path clears both.
  function clearStatus() {
    setStatus("", "", "", "search");
    setStatus("", "", "", "files");
  }

  const isQueryActive = () => isSearchActive(search);

  // Client-visible tree structure: expanded folders + each loaded level's kind/path/title,
  // plus loading and cursor state (the load-more sentinel depends on them).
  let lastTreeSignature = null;

  function ensureTreeExpanded(folderPath) {
    const rel = normalizePath(folderPath);
    tree.model.expanded.add(rel);
    return tree.ensureLoaded(rel);
  }

  function ensureAncestors(path) {
    for (const ancestor of ancestorChain(path)) tree.model.expanded.add(ancestor);
  }

  function hasChild(parent, path) {
    const rel = normalizePath(parent);
    const target = normalizePath(path);
    const items = tree.model.childrenByParent.get(rel);
    return Array.isArray(items) && items.some((item) => normalizePath(item.path) === target);
  }

  // Patch only the load-more chrome of already-loaded parents (disabled + label).
  // Their node structure is unchanged, so the DOM is reused; this is what keeps the
  // sentinel disabled while a load-more is in flight (no double click / supersede).
  function syncLoadMoreChrome() {
    for (const button of host.querySelectorAll(".tree-load-more[data-parent-path]")) {
      const parent = button.dataset.parentPath ?? "";
      const loading = tree.model.loadingParents.has(parent);
      button.disabled = loading;
      button.textContent = loading ? "正在加载…" : "加载更多";
    }
  }

  // Search rows preserve the authoritative v2 server order. Explorer sort remains a
  // Tree preference only while a query is active; it must not re-rank search results.
  function renderSearch() {
    if (!searchHost) return;
    const scrollTop = searchHost.scrollTop;
    renderSearchResults({
      host: searchHost,
      state: search,
      isCurrent: (path) => isSameNotePath(path, state.path),
      onNote: (path) => openNote(path),
      onLoadMore: () => loadMoreSearch(),
      onToggleGroup: (path) => toggleSearchGroup(path),
    });
    searchHost.scrollTop = scrollTop;
  }

  // Group collapse is a local view preference over already-fetched excerpts: it never
  // re-issues the search, and a new query identity drops it.
  function toggleSearchGroup(path) {
    if (!(search.collapsedGroups instanceof Set)) search.collapsedGroups = new Set();
    if (search.collapsedGroups.has(path)) search.collapsedGroups.delete(path);
    else search.collapsedGroups.add(path);
    renderSearch();
  }

  function renderTree({ revealCurrent = false } = {}) {
    const scrollTop = host.scrollTop;
    // Reuse the existing DOM when the tree's structure/metadata are unchanged (a
    // background refresh of the same path set must not rebuild nodes or drop
    // per-node markers/selection). `modified` is excluded: it is not rendered and
    // ordering is server-side.
    const signature = treeRenderSignature(tree.model);
    if (!revealCurrent && signature === lastTreeSignature) {
      // Nothing in this branch touches the list's scroll, so it must not write scrollTop:
      // re-assigning it would cancel an in-flight smooth reveal scroll that the concurrent
      // root load (or an SSE invalidation) resolves after `render({ revealCurrent: true })`.
      syncCurrent();
      syncLoadMoreChrome();
      return;
    }
    lastTreeSignature = signature;
    renderLazyExplorer({
      host,
      model: tree.model,
      currentPath: state.path,
      escapeHtml,
      onToggle: (folderPath) => tree.toggle(folderPath),
      onLoadMore: (parent) => tree.loadMore(parent),
      onRetry: (parent) => tree.retry(parent),
      onEnsureExpanded: (folderPath) => ensureTreeExpanded(folderPath),
      onCreateNote: createNote,
      onNote: openNote,
      // Optional Base open seam: the renderer emits intent only; B4 owns the
      // actual navigation. Absent a handler this is a no-op.
      onOpenBase: (payload) => openBase?.(payload),
      // Optional attachment open seam: the renderer emits the tree item; the
      // wiring owns the authenticated asset URL (never a second route here).
      onOpenFile: (item) => openFile?.(item),
      // Hover intent seam (issue #284): one A1 instance per controller, reused across renders.
      hoverIntent: prefetchIntent,
      revealCurrent,
    });
    if (!revealCurrent) host.scrollTop = scrollTop;
  }

  // Both panels keep their own list in sync with the model; only visibility is switched.
  function render({ revealCurrent = false } = {}) {
    renderSearch();
    if (flat.mode() === "flat") {
      // Issue #335: the flat list owns the same files-panel host, so the Tree's
      // model-only DOM reuse cache is void the moment flat paints.
      lastTreeSignature = null;
      flat.render({ revealCurrent });
    } else renderTree({ revealCurrent });
    flat.syncChrome();
  }

  // Apply a new Tree spec: re-materialize the root + expanded chains under it and
  // restore the current note's focus if it was materialized before the switch.
  async function applySort(spec) {
    const restorePath = state.path && tree.isParentMaterialized(state.path) ? state.path : null;
    await tree.setSort(spec);
    if (restorePath && !isQueryActive()) {
      await tree.locate(restorePath);
      render({ revealCurrent: true });
      return;
    }
    render();
  }

  function settlePendingSort() {
    if (!pendingSort) return;
    const spec = pendingSort;
    pendingSort = null;
    applySort(spec).catch(() => {});
  }
  setDraftSettledHandler(() => queueMicrotask(settlePendingSort));

  async function setSort(next) {
    const spec = normalizeSortSpec(next);
    if (sortSpecEquals(spec, requestedSort)) return;
    requestedSort = spec;
    // A persistence failure must not revert the current UI choice.
    writeExplorerSort(sortStorage, spec);
    sortControl?.sync(spec);
    if (isQueryActive()) {
      // Persist/adopt the Tree preference without touching the active search stream.
      // Search order remains server-authoritative under the Phase 3A-3 contract.
      tree.adoptSort(spec);
      render();
      return;
    }
    if (hasActiveDraft()) {
      // The control + preference advance; the applied Tree stays frozen until the
      // existing inline-create lifecycle settles. Last requested spec wins.
      pendingSort = spec;
      return;
    }
    await applySort(spec);
  }

  const sortControl = initializeExplorerSortControl({ getSort: () => requestedSort, onSort: setSort });

  function syncCurrent() {
    for (const element of [host, searchHost]) {
      if (!element) continue;
      element.querySelectorAll('.note.active, .note[aria-current="page"]').forEach((button) => {
        button.classList.remove("active");
        button.removeAttribute("aria-current");
      });
      if (!state.path) continue;
      // Base and attachment rows are never a note identity: an extension-less
      // attachment such as `Photo` must not be selected by the `.md`-stripping
      // note comparison when `Photo.md` is open (exact kind + exact path).
      const target = [...element.querySelectorAll(".note[data-path]")]
        .find((button) => button.dataset.kind === "base" || button.dataset.kind === "file"
          ? normalizePath(button.dataset.path) === normalizePath(state.path)
          : isSameNotePath(button.dataset.path, state.path));
      if (!target) continue;
      target.classList.add("active");
      target.setAttribute("aria-current", "page");
    }
    return Boolean(state.path);
  }

  // One v2 search page. A stale response (superseded by a newer query or page) is
  // dropped by the version check and can never append into the newer state.
  async function fetchSearchPage(version, cursor, { revealCurrent = false } = {}) {
    try {
      const data = await api(searchPageUrl(search, cursor));
      if (!applySearchPage(search, version, data)) return;
      const status = searchStatus(search, { stale: data?.catalog?.stale === true });
      setStatus(status.text, status.kind, status.title);
      render({ revealCurrent });
    } catch (error) {
      if (!endSearch(search, version)) return;
      const code = error?.data?.error || error?.code;
      if (error?.status === 409 && code === "cursor-stale") {
        // Only this search restarts from page 1; the Explorer tree is untouched.
        const retry = beginSearch(search, {
          query: search.query,
          caseSensitive: search.caseSensitive,
          semantic: search.semantic,
        });
        await fetchSearchPage(retry, null, { revealCurrent });
        return;
      }
      const status = searchErrorStatus(error);
      setStatus(status.text, status.kind, status.title);
      if (error?.status !== 401 && !statusHost) toast(status.text, true);
      render({ revealCurrent });
    }
  }

  async function runSearch(query, { revealCurrent = false } = {}) {
    // A new search replaces the list the draft was opened in; the draft is abandoned
    // (never committed) before the search rows paint.
    settleActiveDraft();
    const previousIdentity = searchIdentity(search);
    const version = beginSearch(search, {
      query,
      caseSensitive: state.caseSensitive,
      semantic: state.semantic,
    });
    state.query = query;
    state.searchCollapsed.clear();
    // A *new* search identity brings the search panel to the front; re-running the same
    // query (a file event) must not yank a reader who switched back to the file panel.
    if (previousIdentity !== searchIdentity(search)) showView?.("search");
    await fetchSearchPage(version, null, { revealCurrent });
  }

  // Continuation of the current query: the opaque cursor is passed back verbatim.
  async function loadMoreSearch() {
    if (!search.nextCursor || search.loading) return;
    const cursor = search.nextCursor;
    const version = beginSearchMore(search);
    syncSearchChrome({ host: searchHost, state: search });
    await fetchSearchPage(version, cursor, {});
  }

  // load("") drives the lazy tree / flat list; a non-empty query drives the separate search view.
  async function load(query = "", options = {}) {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) {
      // C3 (desktop semantics): clearing the query ends the search but does NOT return to
      // the file panel -- the reader stays on the search panel, which shows its own empty
      // state ("输入关键词开始搜索"). Only #reveal-active pulls the reader back to files
      // (see revealCurrent below); the file panel's list is still re-materialized behind it.
      resetSearch(search);
      state.query = "";
      clearStatus();
      if (flat.mode() === "flat") {
        // The flat list was a query projection a moment ago; reload the server page so
        // "query cleared" cannot leave search rows behind in the files panel.
        await flat.load();
        render(options);
        return;
      }
      await tree.loadRoot();
      render(options);
      return;
    }
    await runSearch(normalizedQuery, options);
  }

  async function revealCurrent() {
    if (!state.path) return;
    state.semantic = false;
    resetSearch(search);
    state.query = "";
    state.searchCollapsed.clear();
    clearStatus();
    showView?.("files");
    if (flat.mode() === "flat") {
      await flat.reveal(state.path);
      render({ revealCurrent: true });
      return;
    }
    await tree.locate(state.path);
    render({ revealCurrent: true });
  }

  // Make the current note present in the DOM without scrolling: reveal its ancestor
  // chain with a layer-by-layer anchor locate (never a full-tree load). In flat mode
  // the equivalent is bounded keyset paging.
  async function ensureVisible(path) {
    if (!path) return;
    if (flat.mode() === "flat") {
      await flat.ensure(path);
      render();
      return;
    }
    await tree.locate(path);
    render();
  }

  // U6: collapse every expanded folder. Session-scoped (never persisted) and a
  // no-op when nothing is expanded. It only clears the tree's expansion set: the
  // loaded levels stay cached, and #reveal-active can re-expand the current note's
  // ancestor chain afterwards, so the two actions do not conflict.
  function collapseAll() {
    if (tree.model.expanded.size === 0) return false;
    tree.model.expanded.clear();
    lastTreeSignature = null;
    render();
    return true;
  }

  // U6 / #427: the create entries share the one inline draft lifecycle
  // (`create-draft.js`): a click only opens a draft, these two seams are the only writers,
  // and no POST leaves the client before an explicit commit.
  const createEntries = createExplorerCreateEntries({
    host,
    createNote: (name) => createNote("", name),
    createFolder: (name) => createFolderAtRoot(name),
  });

  function folderErrorMessage(error) {
    if (error?.status === 409) return "已存在同名文件夹，请换一个名称";
    if (error?.status === 403) return "当前 Vault 为只读，无法新建文件夹";
    if (error?.status === 400) return "文件夹名称无效";
    if (error?.status === 401) return "登录已过期，正在返回登录页";
    return "新建文件夹失败，请重试";
  }

  // Commit one root folder. The server is the authority (path validation + 409);
  // on success the root is refetched, the new folder is expanded and scrolled to.
  async function createFolderAtRoot(rawName) {
    const rel = String(rawName || "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (!rel) {
      toast("请输入文件夹名称", true);
      return false;
    }
    try {
      const data = await api("/api/web/v1/folder", {
        method: "POST",
        body: JSON.stringify({ path: rel }),
      });
      const folderPath = data?.path || rel;
      // A folder create is a file-panel action: leave search and show the tree.
      const wasSearching = isQueryActive();
      resetSearch(search);
      state.query = "";
      state.searchCollapsed.clear();
      clearStatus();
      if (wasSearching) showView?.("files");
      await tree.loadRoot();
      await ensureTreeExpanded(folderPath);
      render();
      for (const row of host.querySelectorAll(".tree-folder-row[data-folder-path]")) {
        if (row.dataset.folderPath === folderPath) {
          row.scrollIntoView({ block: "center", inline: "nearest" });
          break;
        }
      }
      return true;
    } catch (error) {
      toast(folderErrorMessage(error), true);
      return false;
    }
  }

  return {
    load,
    loadMoreSearch,
    render,
    revealCurrent,
    syncCurrent,
    hasChild,
    ensureAncestors,
    ensureTreeExpanded,
    ensureVisible,
    isQueryActive,
    setSort,
    setMode: (next) => {
      // A browse-mode switch is a scope change: an uncommitted draft belongs to the view
      // it was opened in and is cancelled, never committed behind the new view.
      settleActiveDraft();
      return flat.setMode(next);
    },
    setFlatSort: (next) => flat.setSort(next),
    collapseAll,
    beginNewNote: createEntries.beginNewNote,
    beginNewFolder: createEntries.beginNewFolder,
    cancelDraft: createEntries.cancelDraft,
    hasActiveDraft,
    getSort: () => ({ ...requestedSort }),
    getMode: () => flat.mode(),
    getFlatSort: () => flat.spec(),
    getStoredFlatSort: () => flat.storedSort(),
    treeController: () => tree,
    flatController: () => flat.list,
    model: tree.model,
  };
}
