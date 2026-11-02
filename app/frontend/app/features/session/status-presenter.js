// Renders the Markdown document-session status into the app chrome.
//
// Extracted from core/app.js so the entry stays a thin bootstrap/wiring module
// within the architecture line budget. It owns only chrome updates; all save
// and conflict semantics stay in the document session.
//
// Base documents (documentKind === "base") deliberately skip the Markdown
// session projection: while a Base surface is open the note session still holds
// the previous note identity, and letting it write state.path/state.revision
// would corrupt navigation, Publish gating and status honesty (WB-04, WB-12).
//
// Issue #430: this presenter is also the single write point of the body-pane word-count
// badge. Every documented lifecycle (committed open, local edit, save, external refresh,
// welcome, Base, vault switch) already funnels through `syncStatusFromSession`, so the badge
// follows the committed session identity and the live session text without a second owner
// and without any extra polling. `wordCountBadge` is optional so headless callers/tests keep
// working unchanged.
export function createSessionStatusPresenter({
  state,
  session,
  save,
  status,
  conflictBar,
  isVaultSwitching = () => false,
  wordCountBadge = null,
}) {
  return function syncStatusFromSession(flags) {
    const next = flags && flags.touchCurrent !== false && "dirty" in flags && "path" in flags
      ? flags
      : session.statusFlags();
    if (state.documentKind === "base") {
      save.disabled = true;
      status.textContent = "";
      conflictBar.render(null);
      wordCountBadge?.hide();
      return;
    }
    state.path = next.path;
    state.revision = next.baseRevision;
    state.remoteRevision = next.remoteRevision;
    state.dirty = next.dirty;
    state.deleted = next.deleted;
    state.conflict = next.conflict;
    save.disabled = isVaultSwitching() || next.writesSuspended || !next.dirty || !next.path || Boolean(next.conflict);
    if (next.conflict) {
      status.textContent = next.conflict.message || "与磁盘版本冲突，请重新载入或放弃冲突后再保存";
    } else if (next.deleted) {
      status.textContent = "磁盘上的笔记已删除";
    } else if (next.dirty) {
      status.textContent = next.remoteRevision ? "磁盘上有新版本" : "尚未保存";
    } else {
      status.textContent = "";
    }
    conflictBar.render(next.conflict);
    // The badge counts the live session text (unsaved edits included) under the committed
    // identity, so Live / RAW / Reader all read one source and a stale callback can never
    // paint another document's numbers.
    wordCountBadge?.update({
      vaultId: next.vaultId ?? session.vaultId ?? null,
      path: next.path ?? null,
      epoch: next.epoch ?? session.epoch ?? null,
      text: session.liveText,
    });
  };
}
