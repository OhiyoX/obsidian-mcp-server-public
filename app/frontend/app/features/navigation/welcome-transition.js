// Issue #410 (audit Cut D): the stateful in-app welcome transition.
//
// Closing the last document tab used to navigate to the slash-less app root — a full page load —
// while closing a tab that still had a neighbour went through the ordinary in-app
// `openNote()` flow. One user gesture therefore had two semantics: two dirty-guard paths,
// two render paths, a fresh bootstrap for the last close, and every session-only UI state
// (Explorer expansion, search pane, ...) thrown away with the page.
//
// This module is the missing transition. It reuses the app's single document pipeline and
// mirrors what a committed note open does, in the same order:
//
//   1. the shared unsaved-changes guard (features/session/unsaved-guard.js) — the same
//      implementation `openNote()` uses; a declined dialog aborts before anything changes;
//   2. every in-flight read of the disappearing document is aborted;
//   3. the session drops the document identity (`closeDocument()`), and the single status
//      projection writes `state.path = null` + the chrome from those flags;
//   4. the note/document-kind chrome leaves the note (`exitToNote()` → `documentKind = null`);
//   5. the outline and context panes are cleared (they describe a note), the header
//      breadcrumb returns to its empty label and the reading surface renders the welcome
//      markup again through the existing view-mode controller (no full reload);
//   6. history is replaced with the document-less `/app/` entry, so Back cannot return to
//      the document the user just closed.
//
// `core/app.js` owns the document pipeline and injects it here; the tab strip only calls
// `enterWelcome()` and drops the tab once it reports the transition committed.
import { confirmDiscardChanges, dirtyDiscardMessage } from "../session/unsaved-guard.js";

/**
 * The welcome workspace address, i.e. the SSR `/app/` page without a document deep link. The
 * trailing slash is the installed app's resolved `scope` (#471): a slash-less `/app` entry would
 * leave the scope, so a reload or Forward onto it could stop being handled by the installed app.
 */
export const WELCOME_ROUTE = "/app/";

export function createWelcomeTransition({
  state,
  session,
  viewMode = null,
  pathBreadcrumb = null,
  clearDocumentContext = () => {},
  syncStatus = () => {},
  isVaultSwitching = () => false,
  abortInFlight = () => {},
  getNavigation = () => ({}),
  confirm = undefined,
  confirmMessage = dirtyDiscardMessage("关闭该笔记吗？"),
} = {}) {
  /** @returns {boolean} whether the welcome workspace is now the committed document state. */
  function enterWelcome() {
    if (isVaultSwitching()) return false;
    // One guard, shared with `openNote()`: Cancel leaves document, strip and address untouched.
    if (!confirmDiscardChanges({ session, message: confirmMessage, confirm })) return false;
    abortInFlight();
    session.closeDocument();
    // The session is the single writer of the document identity; the presenter projects it.
    syncStatus(session.statusFlags());
    const { documentNavigation, baseNavigation } = getNavigation() ?? {};
    baseNavigation?.exitToNote?.();
    clearDocumentContext();
    pathBreadcrumb?.render?.(null);
    // Re-renders the reading surface from the already-loaded shell: the welcome markup comes
    // back and a Live/RAW editor is hidden, because there is no document left to edit. The
    // welcome workspace is always painted in the reading surface — a stale `mode-live` class on
    // `.document` would CSS-hide it (`mode-live .preview { display: none }`) — while the
    // remembered mode is session-only UI state: it stays in `state.mode` and `openNote()`
    // re-applies it to the next document, exactly like switching tabs does today.
    const rememberedMode = state.mode;
    viewMode?.setMode?.("preview");
    state.mode = rememberedMode;
    documentNavigation?.commitWelcome?.({ vaultId: state.vaultId, route: WELCOME_ROUTE });
    return true;
  }

  return { enterWelcome };
}
