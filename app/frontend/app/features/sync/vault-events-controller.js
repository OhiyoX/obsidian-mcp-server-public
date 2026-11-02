import { HttpApiError } from "../session/index.js";
import { createLazyExplorerEvents } from "../explorer/lazy-events.js";

export function createVaultEventsController({
  session,
  state,
  markdownEditor,
  isVaultSwitching,
  syncStatus,
  renderPreview,
  refreshOutline,
  loadNotes,
  getSearchValue,
  explorerTree,
  isQueryActive,
  status,
  toast,
  onAssetEvent,
}) {
  let refreshAbort = null;
  let notesRefreshTimer;

  function abortRefresh() {
    refreshAbort?.abort();
  }

  async function reloadCurrentNote(revision) {
    if (!session.path || isVaultSwitching()) return;
    if (session.pendingOpen) return;
    if (session.isDirty() || session.conflict) {
      if (revision && revision !== session.baseRevision) {
        syncStatus(session.markRemoteChanged(revision));
      }
      return;
    }
    if (revision && revision === session.baseRevision) return;

    abortRefresh();
    refreshAbort = new AbortController();
    const request = session.beginRefresh();
    if (!request) return;
    try {
      const headers = {};
      if (session.baseRevision) headers["If-None-Match"] = `"${session.baseRevision}"`;
      const response = await fetch(`/api/web/v1/note?path=${encodeURIComponent(session.path)}`, {
        headers,
        signal: refreshAbort.signal,
      });
      if (response.status === 304) return;
      if (response.status === 401) return location.assign("/auth/login");
      const data = await response.json().catch(() => ({ error: "刷新笔记失败" }));
      if (!response.ok) {
        throw new HttpApiError(data.error || "刷新笔记失败", {
          status: response.status,
          code: data.code,
          data,
        });
      }
      const result = session.commitRefresh(request, {
        content: data.content,
        revision: data.revision,
        path: data.path,
      }, { getLiveText: () => markdownEditor.getValue() });

      if (!result.applied) {
        if (result.touchCurrent !== false && "dirty" in result) syncStatus(result);
        else syncStatus(session.statusFlags());
        return;
      }
      markdownEditor.setSourcePath?.(result.path, session.vaultId ?? state.vaultId);
      markdownEditor.applyExternalText(result.content);
      session.setLiveText(result.content);
      if (state.mode === "preview") renderPreview();
      else refreshOutline();
      syncStatus(session.statusFlags());
    } catch (error) {
      if (error?.name === "AbortError") return;
      toast(error.message, true);
    }
  }

  function scheduleSearchRefresh(delay = 180) {
    clearTimeout(notesRefreshTimer);
    notesRefreshTimer = setTimeout(() => loadNotes(getSearchValue()), delay);
  }

  // Phase 2B: note/resync events invalidate only the affected lazy parent (and the
  // active search) instead of reloading the whole tree through loadNotes("").
  const lazyEvents = explorerTree
    ? createLazyExplorerEvents({
        controller: explorerTree,
        isQueryActive: () => Boolean(isQueryActive?.()),
        onSearchInvalidate: () => scheduleSearchRefresh(180),
      })
    : null;

  function handleEvent(event) {
    if (!event || (event.vaultId && event.vaultId !== state.vaultId)) return;
    if (event.isAssetEvent || event.type === "asset.changed") {
      onAssetEvent(event);
      return;
    }
    if (event.isResync || event.type === "vault.resync") {
      if (lazyEvents) lazyEvents.handle(event);
      else scheduleSearchRefresh(100);
      reloadCurrentNote();
      return;
    }
    if (event.isNoteEvent || String(event.type || "").startsWith("note.")) {
      if (lazyEvents) lazyEvents.handle(event);
      else scheduleSearchRefresh(180);
    }
    if (event.path !== session.path) return;
    if (session.isSelfEchoEvent(event)) return;

    if (session.isDirty() || session.conflict) {
      if (event.type === "note.deleted") {
        syncStatus(session.markDeleted(event.revision || "deleted"));
        status.textContent = "磁盘上的笔记已删除";
        return;
      }
      syncStatus(session.markRemoteChanged(event.revision || "changed"));
      status.textContent = "磁盘上有新版本";
      return;
    }
    if (event.type === "note.deleted") {
      syncStatus(session.markDeleted(event.revision || "deleted"));
      status.textContent = "磁盘上的笔记已删除";
      return;
    }
    reloadCurrentNote(event.revision);
  }

  return { abortRefresh, handleEvent, reloadCurrentNote };
}
