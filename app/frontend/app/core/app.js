import { initializeExplorerWiring } from "./explorer-wiring.js";
import { initializeSidebarPanels } from "../features/explorer/sidebar-panels.js";
import { createNoteInFolder } from "../features/explorer/create-note.js";
import { createOutline } from "../features/context/outline.js";
import { attachNoteContext } from "../features/context/attach-note-context.js";
import { initializeTheme } from "../features/theme/theme.js";
import { createLiveUpdates } from "../features/sync/live-events.js";
import { attachReconnect } from "../features/sync/attach-reconnect.js";
import { createDocumentSession } from "../features/session/index.js";
import { createSessionStatusPresenter } from "../features/session/status-presenter.js";
import { initializeResizablePanes } from "../ui/pane.js";
import { enhanceSelects } from "../ui/select.js";
import { initializeSearchHelp } from "../features/search/help-popover.js";
import { isLiveSurface } from "../features/document/surface-mode.js";
import { createWordCountBadge } from "../features/document/word-count-badge.js"; // #430: counts session.liveText
import { createApiClient } from "./http-api.js";
import { escapeHtml, toast } from "../ui/feedback.js";
import { initializeContextPane } from "../features/context/pane-layout.js";
import { bindDocumentNavigation } from "../features/navigation/bind-navigation.js";
import { createBaseNavigation } from "../features/navigation/base-navigation.js";
import { createVaultEventsController } from "../features/sync/vault-events-controller.js";
import { initializeVaultController } from "../features/vault/controller.js";
import { initializeViewModeController } from "../features/document/view-mode-controller.js";
import { observeRenderedTableRelayout } from "../features/document/table-layout.js";
import { createConflictBar } from "../features/session/conflict-bar.js";
import { createPublishController } from "../features/publish/controller.js";
import { initializeDocumentActions } from "../features/navigation/document-actions.js";
import { initializeHeaderBreadcrumb } from "../features/navigation/header-breadcrumb.js";
import { initializeKeyboardShortcuts } from "../features/navigation/keyboard-shortcuts.js";
import { createDocumentTabs } from "../features/tabs/index.js";
import { createDocumentTabRow } from "../features/explorer/document-tab-row.js";
// Issue #410 (audit Cut D): the last-tab close is an in-app welcome transition, not a reload.
import { createWelcomeTransition } from "../features/navigation/welcome-transition.js";
import { confirmDiscardChanges, dirtyDiscardMessage } from "../features/session/unsaved-guard.js";
// Issue #414 (C): editor/reader bundles load on demand; deferred-editor.js buffers until the surface asks.
import { createDeferredEditor } from "../features/editor/deferred-editor.js";
import { renderMarkdownOrDefer } from "../features/reader/deferred-reader.js";
import { initializeSettingsDialog } from "../features/settings/dialog.js";
const state = {
  path: null,
  revision: null,
  remoteRevision: null,
  dirty: false,
  mode: "preview",
  query: "",
  semantic: false,
  caseSensitive: false,
  expanded: new Set(),
  searchCollapsed: new Set(),
  vaultId: null,
  deleted: false,
  conflict: null,
  documentKind: null,
};
const $ = (selector) => document.querySelector(selector);
const list = $("#note-list");
const editorHost = $("#editor"), preview = $("#preview"), save = $("#save"), status = $("#status"), pathLabel = $("#current-path");
const shell = $(".shell");
const documentHost = $(".document");
const liveStatus = $("#live-status");
const liveStatusLabel = $("#live-status-label");
const copyNoteLinks = [...document.querySelectorAll("[data-document-link]")], publishToggles = [...document.querySelectorAll("[data-publish-toggle]")], documentActionsToggle = $("#document-actions-toggle");
const searchInput = $("#search"), searchClear = $("#search-clear"), searchCase = $("#search-case"), semanticSearch = $("#semantic-search");
const csrf = document.querySelector('meta[name="csrf-token"]').content;
const initialNotePath = document.querySelector('meta[name="initial-note-path"]')?.content || null;
const clientInstanceId = `web:${crypto.randomUUID()}`;
const session = createDocumentSession({
  createMutationId: () => `${clientInstanceId}:${crypto.randomUUID()}`,
});

let openAbort = null, vaultEventsController = null, documentNavigation = null;
const vaultLifecycle = { switching: false };
/** Fallback when editor getRenderContext is not yet available; prefer editor context when present. */
let readerAssetRevisions = {};

const api = createApiClient({ csrfToken: csrf, onUnauthorized: () => { location.href = "/auth/login"; } });
const sidebar = initializeSidebarPanels({ shell, api, onNewNoteDraft: () => explorer.beginNewNote(), onNewFolder: () => explorer.beginNewFolder(), onCollapseAll: () => explorer.collapseAll(), onClose: () => explorer.cancelDraft() });
const conflictBar = createConflictBar({
  status,
  session,
  toast,
  onReload: () => reloadFromDisk({ force: false }),
});
const publishController = createPublishController({ api, state, copyButtons: copyNoteLinks, publishButtons: publishToggles, actionsToggle: documentActionsToggle, toast });
const documentActions = initializeDocumentActions({ control: $(".document-actions"), toggle: documentActionsToggle, menu: $("#document-actions-menu") });
const wordCountBadge = createWordCountBadge({ host: documentHost });
/** Only sync from a complete session status snapshot — never partial rejection objects. */
const syncStatusFromSession = createSessionStatusPresenter({
  state, session, save, status, conflictBar, isVaultSwitching: () => vaultLifecycle.switching, wordCountBadge,
});

const welcomeHtml = preview.innerHTML;

const readerVisible = () => state.mode === "preview" && !preview.hidden;

const sourceHeadings = () => (typeof markdownEditor.getHeadings === "function" ? markdownEditor.getHeadings() || [] : []);

function refreshOutlineFromSource() {
  context.setDocument({ path: state.path, documentKind: state.documentKind });
  if (!state.path) {
    outline.clear();
    return;
  }
  outline.setHeadings(sourceHeadings());
}

function readerRenderOptions() {
  const ctx = typeof markdownEditor.getRenderContext === "function"
    ? markdownEditor.getRenderContext()
    : null;
  if (ctx?.assetRevisions && typeof ctx.assetRevisions === "object") {
    readerAssetRevisions = { ...ctx.assetRevisions };
  }
  return {
    sourcePath: ctx?.sourcePath ?? state.path,
    vaultId: ctx?.vaultId ?? state.vaultId,
    assetRevisions: ctx?.assetRevisions || readerAssetRevisions,
    documentContext: ctx?.documentContext,
  };
}

function renderWelcome() {
  if (state.path) return false;
  preview.innerHTML = welcomeHtml;
  preview.hidden = false;
  editorHost.hidden = true;
  return true;
}

function renderPreview() {
  if (!state.path) {
    renderWelcome();
    outline.clear(); context.clear();
    return;
  }
  const source = markdownEditor.getValue();
  const html = renderMarkdownOrDefer(source, readerRenderOptions(), () => { if (readerVisible()) renderPreview(); });
  preview.innerHTML = `<div class="markdown-preview-view markdown-rendered markdown-preview-sizer markdown-preview-section is-readable-line-width">${html}</div>`;
  preview.hidden = false;
  window.layoutObsidianTables?.(preview);
  window.attachCopyCodeButtons?.(preview);
  editorHost.hidden = true;
  refreshOutlineFromSource();
  outline.bindPreviewNodes(preview);
}

// Keep an already-rendered Reader responsive to window/pane resize.
observeRenderedTableRelayout(() => preview, readerVisible);

let outlineRefreshTimer;
const markdownEditor = createDeferredEditor(editorHost, () => {
  const flags = session.noteLocalEdit(markdownEditor.getValue());
  syncStatusFromSession(flags);
  clearTimeout(outlineRefreshTimer);
  outlineRefreshTimer = setTimeout(refreshOutlineFromSource, 120);
}, () => { refreshOutlineFromSource(); if (readerVisible()) renderPreview(); });

const outline = createOutline({
  host: $("#outline-list"),
  getScrollRoot: () => (readerVisible() ? preview : null),
  getEditorAnchor: () => {
    if (state.mode === "preview" || (!isLiveSurface(state.mode) && state.mode !== "raw")) return null;
    if (typeof markdownEditor.getViewportAnchor === "function") return markdownEditor.getViewportAnchor();
    return null;
  },
  onNavigate(heading) {
    if (readerVisible()) {
      outline.scrollTo(heading);
      return;
    }
    if (typeof markdownEditor.scrollToPosition === "function") {
      markdownEditor.scrollToPosition(heading.from);
      return;
    }
    if (typeof markdownEditor.scrollToHeading === "function") {
      const headings = outline.getHeadings();
      const index = headings.findIndex((item) => item.key === heading.key);
      if (index >= 0) markdownEditor.scrollToHeading(index);
    }
  },
});
const context = attachNoteContext({ outgoingHost: $("#outgoing-list"), incomingHost: $("#incoming-list"), openNote, vaultId: () => state.vaultId });

editorHost.addEventListener("scroll", () => outline.scheduleSync(), { capture: true, passive: true });

const { explorer, loadNotes, searchControls } = initializeExplorerWiring({
  state,
  host: list,
  searchHost: $("#search-list"),
  statusHost: $("#search-status"),
  filesStatusHost: $("#files-status"),
  showView: sidebar.showView,
  api,
  toast,
  escapeHtml,
  openNote,
  onOpenBase: ({ path } = {}) => baseNavigation.openBase({ path }),
  createNote: (folderPath, name) => createNote(folderPath, name),
  searchInput,
  searchClear,
  searchCase,
  semanticSearch,
  publishesButton: $("#publishes-open"),
  revealButton: $("#reveal-active"),
});

const pathBreadcrumb = initializeHeaderBreadcrumb({ host: pathLabel, explorer });

const viewMode = initializeViewModeController({
  state,
  documentHost,
  editorHost,
  preview,
  editor: markdownEditor,
  renderPreview,
  renderWelcome,
  refreshOutline: refreshOutlineFromSource,
});
// U14: the tab strip is a read-only consumer of the committed document identity and opens
// documents through the normal `openNote`; it owns no document state of its own. #410: the
// in-app welcome transition is created first, so the strip's last close is an ordinary call
// into the app's document pipeline and never a page load.
const welcomeTransition = createWelcomeTransition({ state, session, viewMode, pathBreadcrumb, syncStatus: syncStatusFromSession, clearDocumentContext: () => { outline.clear(); context.clear(); }, isVaultSwitching: () => vaultLifecycle.switching, abortInFlight: () => { openAbort?.abort(); vaultEventsController?.abortRefresh(); }, getNavigation: () => ({ documentNavigation, baseNavigation }) });
const documentTabRow = createDocumentTabRow(); // U29 (#371): mirrors the tab model onto the row
const tabs = createDocumentTabs({ openNote, getCurrentPath: () => state.path, getDocumentKind: () => state.documentKind, enterWelcome: () => welcomeTransition.enterWelcome(), onModelChange: (list) => documentTabRow.sync(list) });

function applyOpenCommit(result, { refreshOutline = true } = {}) {
  if (!result?.applied) return false;
  state.path = result.path;
  state.revision = result.revision;
  state.vaultId = result.vaultId ?? state.vaultId;
  readerAssetRevisions = {};
  markdownEditor.setSourcePath?.(result.path, result.vaultId ?? state.vaultId);
  markdownEditor.setValue(result.content, { resetHistory: true, preserveSelection: false, silent: true });
  session.setLiveText(result.content);
  if (refreshOutline) refreshOutlineFromSource();
  pathBreadcrumb.render(result.path);
  const parts = result.path.split("/");
  for (let index = 1; index < parts.length; index += 1) state.expanded.add(parts.slice(0, index).join("/"));
  // Lazy tree: load the ancestor chain so the current note actually exists in the DOM.
  explorer.ensureVisible(result.path).catch(() => {});
  syncStatusFromSession(session.statusFlags());
  explorer.syncCurrent();
  baseNavigation?.exitToNote?.();
  // U14: Base/note transitions are reconciled from the committed identity alone.
  tabs.syncFromSession(); documentTabRow.sync(tabs.getState().tabs);
  return true;
}

async function openNote(path, { historyMode = "push", fragment = "" } = {}) {
  if (vaultLifecycle.switching) return false;
  baseNavigation?.invalidate?.();
  if (!confirmDiscardChanges({ session, message: dirtyDiscardMessage("打开其他笔记吗？") })) return false;
  openAbort?.abort();
  openAbort = new AbortController();
  vaultEventsController?.abortRefresh();
  const request = session.beginOpen({ vaultId: state.vaultId, path });
  // Active identity unchanged until commit — status stays on current document.
  syncStatusFromSession(session.statusFlags());
  try {
    const data = await api(`/api/web/v1/note?path=${encodeURIComponent(path)}`, { signal: openAbort.signal });
    // Re-check after both awaits via commitOpen's loadSeq + editVersion gates.
    const result = session.commitOpen(request, {
      content: data.content,
      revision: data.revision,
      path: data.path,
      vaultId: data.vaultId ?? state.vaultId,
    });
    if (!applyOpenCommit(result, { refreshOutline: false })) {
      if (result?.reason === "local-edit") syncStatusFromSession(session.statusFlags());
      return false;
    }
    viewMode.setMode(state.mode);
    shell.classList.remove("sidebar-open");
    documentNavigation?.commit({ route: data.route, path: result.path, vaultId: result.vaultId ?? state.vaultId, documentKind: "note", fragment }, historyMode);
    await publishController.refresh();
    return true;
  } catch (error) {
    session.abandonOpen(request);
    if (error?.name === "AbortError") return false;
    syncStatusFromSession(session.statusFlags());
    toast(error.message, true);
    return false;
  }
}

async function saveNote() {
  if (vaultLifecycle.switching || session.writesSuspended) {
    toast("Vault 切换中，暂不能保存", true);
    return;
  }
  if (session.conflict) {
    status.textContent = session.conflict.message || "存在冲突，请先重新载入磁盘版本或保留本地后再试";
    toast("请先解决版本冲突", true);
    syncStatusFromSession(session.statusFlags());
    return;
  }
  try {
    status.textContent = "保存中…";
    const result = await session.enqueueSave(async (mutation) => {
      const data = await api("/api/web/v1/note", {
        method: "POST",
        body: JSON.stringify({
          path: mutation.path,
          content: mutation.submittedText,
          ifMatch: mutation.baseRevision,
          mutationId: mutation.mutationId,
        }),
      });
      return { revision: data.revision };
    }, { getLiveText: () => markdownEditor.getValue() });

    if (!result) {
      syncStatusFromSession(session.statusFlags());
      return;
    }
    if (result.touchCurrent === false) {
      // Stale identity — refresh UI from the active session only.
      syncStatusFromSession(session.statusFlags());
      return;
    }
    if (result.applied) {
      state.revision = result.revision;
      syncStatusFromSession(session.statusFlags());
      toast(result.dirty ? "已保存（仍有新的未保存修改）" : "已保存");
      await loadNotes(searchInput.value);
    }
  } catch (error) {
    const sessionResult = error?.sessionResult;
    if (sessionResult?.touchCurrent === false) {
      toast(error.message, true);
      return;
    }
    syncStatusFromSession(session.statusFlags());
    if (error?.status === 409 || error?.status === 428 || sessionResult?.hasConflict || sessionResult?.conflict) {
      status.textContent = "与磁盘版本冲突，请重新载入或复制本地内容后再处理";
      toast(error.message || "保存冲突", true);
      return;
    }
    status.textContent = error?.status ? `保存失败 (${error.status})` : "保存失败";
    toast(error.message, true);
  }
}

async function reloadFromDisk({ force = false } = {}) {
  if (!session.path || vaultLifecycle.switching) return;
  if (!force && session.isDirty() && !confirm("重新载入将丢失未保存修改，继续吗？")) return;
  openAbort?.abort();
  openAbort = new AbortController();
  vaultEventsController?.abortRefresh();
  const request = session.beginOpen({ vaultId: session.vaultId ?? state.vaultId, path: session.path });
  try {
    const data = await api(`/api/web/v1/note?path=${encodeURIComponent(request.targetPath)}`, { signal: openAbort.signal });
    const result = session.commitOpen(request, {
      content: data.content,
      revision: data.revision,
      path: data.path,
      vaultId: data.vaultId ?? state.vaultId,
    });
    if (!result.applied) {
      // Edits made while reload was pending are protected.
      syncStatusFromSession(session.statusFlags());
      if (result.reason === "local-edit") toast("重新载入已取消：检测到新的本地修改", true);
      return;
    }
    applyOpenCommit(result);
    toast("已载入磁盘版本");
  } catch (error) {
    session.abandonOpen(request);
    if (error?.name === "AbortError") return;
    syncStatusFromSession(session.statusFlags());
    toast(error.message, true);
  }
}

function createNote(folderPath, rawName) {
  return createNoteInFolder({
    folderPath, rawName, session, toast, state, search: searchInput,
    semanticButton: semanticSearch, publishesButton: $("#publishes-open"), api,
    syncSearchChrome: searchControls.syncChrome,
    cancelPendingSearch: searchControls.cancelPending, loadNotes, openNote,
    enterLiveMode: () => viewMode.setMode("live"),
    hasChild: (parent, path) => explorer.hasChild(parent, path),
    ensureExpanded: (folderPath) => explorer.ensureTreeExpanded(folderPath),
  });
}

save.onclick = saveNote;
$("#menu").onclick = () => sidebar.toggle();

const vaultController = initializeVaultController({
  api,
  toast,
  session,
  state,
  lifecycle: vaultLifecycle,
  saveButton: save,
  vaultSelect: $("#vault-select"),
  createButton: $("#vault-create"),
  abortOpen: () => openAbort?.abort(),
  abortRefresh: () => vaultEventsController?.abortRefresh(),
  syncStatus: syncStatusFromSession,
});
initializeContextPane({
  shell,
  scrim: $(".scrim"),
});
// The settings dialog chrome + its deploy-time line are owned by the settings feature
// module; this file only hands it the document (thin-bootstrap contract: net growth 0).
initializeSettingsDialog(document);
const baseNavigation = createBaseNavigation({
  state, session, api, toast, documentHost, editorHost, preview, openNote, pathLabel,
  // The Base action row's 新建 reuses the exact same note-creation flow as the tree.
  createNote: (folderPath, name) => createNote(folderPath, name),
  controls: { save, modeToggles: [...document.querySelectorAll(".view-mode-toggle, .view-mode-item")], publishButtons: publishToggles, copyButtons: copyNoteLinks, topbarStatus: $(".topbar-status"), documentActionsChrome: $(".document-actions") },
  // Base documents have no outline; clear the note headings on entry and restore
  // them through the normal note-open flow (refreshOutlineFromSource) on failure.
  clearOutline: () => { outline.clear(); context.setDocument({ path: state.path, documentKind: "base" }); tabs.syncFromSession(); documentTabRow.sync(tabs.getState().tabs); },
  refreshOutline: () => { refreshOutlineFromSource(); tabs.syncFromSession(); documentTabRow.sync(tabs.getState().tabs); },
  commit: (data, mode) => documentNavigation?.commit(data, mode),
  abortNoteOpen: () => openAbort?.abort(), abortRefresh: () => vaultEventsController?.abortRefresh(),
  isVaultSwitching: () => vaultLifecycle.switching, syncStatus: syncStatusFromSession,
});
documentNavigation = bindDocumentNavigation({
  preview, editorHost, outline, editor: markdownEditor,
  getMode: () => state.mode, getPath: () => state.path, getDocumentKind: () => state.documentKind, getVaultId: () => state.vaultId,
  openNote,
  openBase: (options) => baseNavigation.openBase(options),
  resolveNote: (source, target) => api(`/api/web/v1/link/resolve?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`),
  searchInput, loadNotes, syncSearchChrome: searchControls.syncChrome,
});
window.addEventListener("beforeunload", (event) => {
  if (session.isDirty()) { event.preventDefault(); event.returnValue = ""; }
});
initializeKeyboardShortcuts({ session, viewMode, documentActions, saveButton: save, onSave: saveNote, onReload: reloadFromDisk, getDocumentKind: () => state.documentKind });

initializeTheme({ api, toast });
enhanceSelects();
initializeSearchHelp();
initializeResizablePanes(shell);

function handleAssetEvent(event) {
  if (!event || (event.vaultId && event.vaultId !== state.vaultId)) return;
  const refreshed = markdownEditor.refreshAssets?.(event);
  // Only re-render reading view when the editor reports a relevant asset hit.
  if (refreshed !== true) return;
  const ctx = typeof markdownEditor.getRenderContext === "function"
    ? markdownEditor.getRenderContext()
    : null;
  if (ctx?.assetRevisions && typeof ctx.assetRevisions === "object") {
    readerAssetRevisions = { ...ctx.assetRevisions };
  } else if (event.path && event.revision != null) {
    const assetPath = String(event.path).replace(/\\/g, "/");
    const revision = String(event.revision);
    readerAssetRevisions = {
      ...readerAssetRevisions,
      [assetPath]: revision,
      [`${event.vaultId ?? state.vaultId ?? ""}::${assetPath}`]: revision,
    };
  }
  if (readerVisible()) renderPreview();
}

vaultEventsController = createVaultEventsController({
  session,
  state,
  markdownEditor,
  isVaultSwitching: () => vaultLifecycle.switching,
  syncStatus: syncStatusFromSession,
  renderPreview,
  refreshOutline: refreshOutlineFromSource,
  loadNotes,
  getSearchValue: () => searchInput.value,
  explorerTree: explorer.treeController(),
  isQueryActive: () => explorer.isQueryActive(),
  status,
  toast,
  onAssetEvent: handleAssetEvent,
});
attachReconnect({ host: $("#reconnect-host") }); // U46 (#422): the reconnect hint owns the session-expired message (no duplicate toast)

vaultController.load().then(async () => {
  const initialTasks = [loadNotes()];
  if (initialNotePath) initialTasks.push(openNote(initialNotePath, { historyMode: "replace", fragment: location.hash.slice(1) }));
  await Promise.all(initialTasks);
  const initialBase = baseNavigation.initialDeepLink();
  if (initialBase) await baseNavigation.openBase({ ...initialBase, historyMode: "replace", fragment: location.hash.slice(1) });
  else if (initialNotePath && location.hash) documentNavigation.navigateFragment(location.hash);
  createLiveUpdates({
    onEvent: vaultEventsController.handleEvent,
      onStatus(value) {
        liveStatus.dataset.state = value;
        const label = ({ live: "实时", connecting: "连接中", reconnecting: "重连中", paused: "已暂停" })[value] || value;
        liveStatus.title = ({ live: "文件实时同步正常", connecting: "正在连接实时同步", reconnecting: "实时同步正在重连", paused: "实时同步已暂停" })[value] || value;
        liveStatus.setAttribute("aria-label", liveStatus.title); if (liveStatusLabel) liveStatusLabel.textContent = label;
      },
  }); }).catch((error) => toast(error.message, true));
