// Combined host wiring for the two note-context link sections (sidebar Phase 2 + 3).
//
// The application shell drives one object with the same three calls it already used
// for the outgoing section (`setDocument` / `clear` / `refresh`), so both sections
// stay in lockstep across document switches, Base <-> note round trips and remote
// refreshes without adding a second call site to `core/app.js`.
//
// It also owns the per-section header chrome that desktop shows next to the title:
// the `⋮` menu with only the actions this app really implements (collapse/expand the
// section, refresh it) and the row count. Nothing desktop-only (show in page, sort,
// search) is rendered. U35 (#407) drives those `⋮` menus with the shared `ui/popup-menu.js`
// primitive: attaching still registers no document/window listener of its own, while an
// *open* menu owns its document-level dismiss + keyboard pair through the primitive — which
// is what keeps the rail's `"context-sidebar"` scope independent of the topbar's.
import { attachOutgoingLinks } from "./attach-outgoing.js";
import { attachIncomingLinks } from "./attach-incoming.js";
import { attachUnlinkedMentions } from "./attach-unlinked.js";
import { attachTagsPanel } from "./attach-tags.js";
import { createPopupMenuController } from "../../ui/popup-menu.js";
import { createContextRailSplitter } from "./rail-splitter.js";
import { createContextViewSwitcher } from "./view-switcher.js";

const COLLAPSE_LABEL = "折叠";
const EXPAND_LABEL = "展开";
const SHOW_UNLINKED_LABEL = "显示未链接提及";
const HIDE_UNLINKED_LABEL = "隐藏未链接提及";
// U7 preference: whether the outgoing panel renders its unlinked-mentions section.
// Desktop shows it by default, so only an explicit "false" hides it.
export const UNLINKED_VISIBLE_KEY = "obsidian-web.context-unlinked";

// The shell passes no storage for the rail preferences, so fall back to the browser's
// own store (desktop remembers the last right-rail view). Access can throw in hardened
// browsers, hence the guard; an absent store only costs the remembered view.
function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function sectionHeader(documentRef, name) {
  const host = documentRef?.querySelector?.(`[data-context-section="${name}"]`);
  return host ?? null;
}

function countHostOf(header) {
  return header?.querySelector?.(".context-section-count") ?? null;
}

// U7: each view panel renders its own head row; that head (not the shared tab row) owns
// the panel's real actions, and the section header keeps the U2 title + count.
function panelHead(documentRef, name) {
  return documentRef?.querySelector?.(`[data-context-panel="${name}"]`) ?? null;
}

// Desktop's Outgoing links head carries a 📖 switch for the unlinked-mentions section.
// This is a real show/hide of that section (header + list + the U3 height handle) with a
// remembered preference, and it never touches the link list itself. Element-scoped and a
// no-op when the markup (or an explicit `visible` override) is absent.
export function wireUnlinkedToggle({
  button = null,
  header = null,
  list = null,
  splitter = null,
  storage = null,
  visible = null,
} = {}) {
  let shown = visible ?? readUnlinkedPreference(storage);

  function apply(next) {
    shown = Boolean(next);
    if (header) header.hidden = !shown;
    if (list) list.hidden = !shown;
    // The splitter only makes sense while both sections exist; suspending it also
    // releases the first list so it takes the panel's whole height.
    splitter?.setSuspended?.(!shown);
    if (button) {
      const label = shown ? HIDE_UNLINKED_LABEL : SHOW_UNLINKED_LABEL;
      button.setAttribute("aria-pressed", shown ? "true" : "false");
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  }

  function persist() {
    try {
      storage?.setItem?.(UNLINKED_VISIBLE_KEY, shown ? "true" : "false");
    } catch {
      // A blocked/absent storage only costs the remembered choice.
    }
  }

  if (!button || !header || !list) return { isVisible: () => true, setVisible: () => {}, destroy: () => {} };

  const onClick = () => {
    apply(!shown);
    persist();
  };
  button.addEventListener("click", onClick);
  apply(shown);

  return {
    isVisible: () => shown,
    setVisible: (next, { remember = true } = {}) => {
      apply(next);
      if (remember) persist();
    },
    destroy() {
      button.removeEventListener?.("click", onClick);
    },
  };
}

function readUnlinkedPreference(storage) {
  try {
    return storage?.getItem?.(UNLINKED_VISIBLE_KEY) !== "false";
  } catch {
    return true;
  }
}

// Element-scoped chrome for one section header. Returns a no-op when the markup is
// absent, so the panels keep working on a page without the header.
//
// U35 (#407): the `⋮` state machine comes from the shared primitive, which is the only
// writer of `menu.hidden` / `toggle[aria-expanded]` and owns the toggle click, the outside
// pointer dismissal, Escape (handing focus back to the `⋮`) and Arrow/Home/End navigation.
// Both link panels use the `"context-sidebar"` scope, so they exclude each other while
// staying independent of the topbar menus.
export function wireContextSection({ header, listHost = null, onRefresh = () => {}, documentRef = globalThis.document } = {}) {
  const toggle = header?.querySelector?.(".context-section-menu-toggle") ?? null;
  const menu = header?.querySelector?.(".context-section-menu") ?? null;
  const collapseItem = menu?.querySelector?.('[data-context-action="collapse"]') ?? null;
  const refreshItem = menu?.querySelector?.('[data-context-action="refresh"]') ?? null;
  let collapsed = false;

  if (!toggle || !menu) return { isCollapsed: () => false, setCollapsed: () => {}, destroy: () => {} };

  const popup = createPopupMenuController({
    trigger: toggle,
    popup: menu,
    scope: "context-sidebar",
    restoreFocus: true,
    documentRef,
  });

  function setCollapsed(value) {
    collapsed = Boolean(value);
    if (listHost) listHost.hidden = collapsed;
    if (collapseItem) collapseItem.textContent = collapsed ? EXPAND_LABEL : COLLAPSE_LABEL;
  }

  const onCollapse = () => { setCollapsed(!collapsed); popup.close(); };
  const onRefreshClick = () => { popup.close(); onRefresh(); };

  collapseItem?.addEventListener("click", onCollapse);
  refreshItem?.addEventListener("click", onRefreshClick);
  setCollapsed(false);

  return {
    isCollapsed: () => collapsed,
    setCollapsed,
    isOpen: () => popup.isOpen(),
    destroy() {
      collapseItem?.removeEventListener?.("click", onCollapse);
      refreshItem?.removeEventListener?.("click", onRefreshClick);
      popup.destroy();
    },
  };
}

export function attachNoteContext({
  outgoingHost,
  incomingHost,
  openNote,
  vaultId = null,
  getVaultId,
  fetchImpl = globalThis.fetch,
  openAsset,
  getAssetUrl,
  documentRef = globalThis.document,
  storage = null,
  windowRef = null,
  loadTags = true,
} = {}) {
  const sharedStorage = storage ?? browserStorage();
  // U2 titles/counts stay in the section headers; U7 moves each section's ⋮ into its
  // panel's own head so the head travels with the view.
  const outgoingHead = panelHead(documentRef, "outgoing");
  const incomingHead = panelHead(documentRef, "incoming");
  const outgoingSection = sectionHeader(documentRef, "outgoing");
  const incomingSection = sectionHeader(documentRef, "incoming");
  const unlinkedHeader = sectionHeader(documentRef, "unlinked");
  const outgoing = attachOutgoingLinks({
    host: outgoingHost,
    openNote,
    vaultId,
    getVaultId,
    fetchImpl,
    openAsset,
    getAssetUrl,
    countHost: countHostOf(outgoingSection),
  });
  const incoming = attachIncomingLinks({
    host: incomingHost,
    openNote,
    vaultId,
    getVaultId,
    fetchImpl,
    countHost: countHostOf(incomingSection),
  });
  const unlinked = attachUnlinkedMentions({
    host: documentRef?.querySelector?.("#unlinked-list") ?? null,
    openNote,
    vaultId,
    getVaultId,
    fetchImpl,
    countHost: countHostOf(unlinkedHeader),
  });
  const sections = [
    wireContextSection({ header: outgoingHead, listHost: outgoingHost, onRefresh: () => outgoing.refresh(), documentRef }),
    wireContextSection({ header: incomingHead, listHost: incomingHost, onRefresh: () => incoming.refresh(), documentRef }),
  ];
  // Repository-level Tags panel: never cleared by a note/Base switch, only loaded
  // once at attach time (the shell already resolved its markup).
  const tags = attachTagsPanel({ documentRef, fetchImpl, storage, load: loadTags });
  // Single-view rail: exactly one of outline/outgoing/incoming/tags is visible.
  // The U3 height splitter lives inside the outgoing view; re-sync it whenever that
  // view becomes visible (the panel has no height while hidden, so the stored split
  // can only be applied once it is laid out).
  const railSplitter = createContextRailSplitter({
    documentRef,
    storage: sharedStorage,
    windowRef: windowRef ?? globalThis,
  });
  // Wired after the splitter so the persisted 📖 choice can suspend/resume the U3 handle.
  const unlinkedToggle = wireUnlinkedToggle({
    button: documentRef?.querySelector?.("#unlinked-toggle") ?? null,
    header: unlinkedHeader,
    list: documentRef?.querySelector?.("#unlinked-list") ?? null,
    splitter: railSplitter,
    storage: sharedStorage,
  });
  const view = createContextViewSwitcher({ documentRef, storage: sharedStorage, onChange: () => { railSplitter.sync(); } });

  function setDocument(options = {}) {
    return Promise.all([outgoing.setDocument(options), incoming.setDocument(options), unlinked.setDocument(options)]);
  }

  function clear() {
    outgoing.clear();
    incoming.clear();
    unlinked.clear();
  }

  function refresh() {
    return Promise.all([outgoing.refresh(), incoming.refresh(), unlinked.refresh(), tags.refresh()]);
  }

  function destroy() {
    for (const section of sections) section.destroy();
    outgoing.destroy();
    incoming.destroy();
    unlinked.destroy();
    tags.destroy();
    unlinkedToggle.destroy();
    railSplitter.destroy();
    view.destroy();
  }

  return { setDocument, clear, refresh, destroy, tags, view, splitter: railSplitter, unlinkedToggle };
}
