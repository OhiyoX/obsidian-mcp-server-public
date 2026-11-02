// Left sidebar panel chrome (U4): the desktop-style tab bar plus each panel's own head.
//
// Two panels really exist in this build (the file tree and the v2 search), and both are
// driven by real data, so the tab bar holds exactly those two and nothing is rendered
// for capabilities the app does not have (bookmarks / graph / tag panels).
//
// The tab bar owns *visibility only*: both panels stay mounted, so switching tabs never
// drops the tree's DOM state or the search's results. `showView` is idempotent and is
// also called by the explorer/search controller when the data itself decides which panel
// belongs in front (a new query, a cleared query, "locate current file").
//
// The collapse control is the existing `#files-toggle` behaviour: on a narrow viewport
// it opens/closes the drawer (through the one `<=720px` drawer policy, U29 / #371), on desktop
// it hides the sidebar. It has to stay outside the sidebar itself (`.sidebar-hidden` hides the
// sidebar), which is why the ribbon keeps carrying it; the pane header's ✕ (`#panel-close`,
// U29) and the panel's own action delegate to the very same function.
//
// #420: the docked visibility is a remembered preference, in the same family as the right rail's
// (`obsidian-web.context-open`, `features/context/pane-layout.js`): the key is
// `obsidian-web.explorer-open`, the stored value is exactly `String(open)`, an absent or unreadable
// value means open, and the write happens only above the breakpoint — a temporary phone drawer
// never rewrites the desktop choice. `setOpen` is the one writer of all three mirrors
// (`.sidebar-hidden` on the shell, `.active` on the ribbon toggle, the preference), so no second
// path can drift from it.
import { DRAWER_POLICY_EVENT, DRAWER_QUERY, closeDrawers, isDrawerMode, isDrawerOpen, setDrawerOpen } from "../context/drawer-exclusion.js";

export const SIDEBAR_TAB_ATTR = "data-sidebar-tab";
export const SIDEBAR_PANEL_ATTR = "data-sidebar-panel";
export const SIDEBAR_VIEWS = ["files", "search"];

// The persisted-preference contract, deliberately identical in shape to the right rail's scalar:
// only the exact string "false" means collapsed. Access is guarded because a blocked or absent
// `localStorage` (private mode, a bare Node process) must never break boot or the toggle.
const explorerOpenPreferenceKey = "obsidian-web.explorer-open";

function readExplorerOpenPreference() {
  try { return globalThis.localStorage?.getItem(explorerOpenPreferenceKey) !== "false"; } catch { return true; }
}

function writeExplorerOpenPreference(open) {
  try { globalThis.localStorage?.setItem(explorerOpenPreferenceKey, String(open)); } catch { /* best effort */ }
}

// The panel head's 新建笔记 entry reports the click only; the Explorer controller owns
// the draft (issue #427). The pane's open/close contract stays here, so closing the
// sidebar/drawer is the one place that must tell the controller to cancel a draft.
export function initializeSidebarPanels({
  root = globalThis.document,
  shell,
  filesToggle,
  closeButton,
  newNoteButton,
  onNewNoteDraft,
  newFolderButton,
  onNewFolder,
  collapseAllButton,
  onCollapseAll,
  onClose,
  api,
  matchMedia: matchMediaFn = globalThis.matchMedia,
} = {}) {
  const tabs = [...(root?.querySelectorAll?.(`[${SIDEBAR_TAB_ATTR}]`) ?? [])];
  const panels = [...(root?.querySelectorAll?.(`[${SIDEBAR_PANEL_ATTR}]`) ?? [])];
  // The chrome elements are resolved here so core wiring never has to name them.
  const $ = (selector) => root?.querySelector?.(selector) ?? null;
  const toggleButton = filesToggle ?? $("#files-toggle");
  const closePanelButton = closeButton ?? $("#panel-close");
  const createNoteButton = newNoteButton ?? $("#new-note");
  // U6: the file panel head's two real additions. Both are resolved here so core
  // wiring never names them (matching the U4 new-note/panel-close seam).
  const createFolderButton = newFolderButton ?? $("#new-folder");
  const collapseButton = collapseAllButton ?? $("#collapse-all");
  let view = tabs[0]?.dataset?.sidebarTab || SIDEBAR_VIEWS[0];
  // #420: the remembered docked preference plus its in-memory mirror. Above the breakpoint `open`
  // is the authoritative mirror of `.sidebar-hidden` (this module is its only writer); in drawer
  // mode the toggle reads the real class instead, because the note-open path still closes the
  // mobile drawer directly (`core/app.js`).
  let desktopOpen = readExplorerOpenPreference();
  let open = false;
  const media = typeof matchMediaFn === "function" ? matchMediaFn(DRAWER_QUERY) : null;
  const isNarrow = () => isDrawerMode(matchMediaFn);

  function showView(next) {
    if (!SIDEBAR_VIEWS.includes(next)) return view;
    view = next;
    for (const tab of tabs) {
      const selected = tab.dataset.sidebarTab === next;
      tab.setAttribute("aria-selected", String(selected));
      tab.classList.toggle("is-active", selected);
    }
    for (const panel of panels) panel.hidden = panel.dataset.sidebarPanel !== next;
    return view;
  }

  // The single writer of the pane's open state. The drawer half lives in the one `<=720px` policy,
  // which also hands the note-context drawer back when this one opens (U29) — and which never
  // receives a preference write (a phone drawer is not a desktop choice).
  function setOpen(next) {
    const wasOpen = open;
    open = Boolean(next);
    if (isNarrow()) {
      shell?.classList.remove("sidebar-hidden");
      setDrawerOpen(shell, "left", open);
    } else {
      shell?.classList.remove("sidebar-open");
      shell?.classList.toggle("sidebar-hidden", !open);
      desktopOpen = open;
      writeExplorerOpenPreference(open);
    }
    toggleButton?.classList.toggle("active", open);
    // A hidden pane cannot host a draft: the controller cancels the open one so an
    // uncommitted name is never committed behind a closed sidebar / drawer. Only a real
    // open -> closed transition is a close, so booting into a collapsed pane (or a phone
    // drawer that starts closed) is not reported as one.
    if (wasOpen && !open) onClose?.();
  }

  // Shared by the ribbon toggle, the pane-level ✕ and a click on the already-active tab
  // (desktop Obsidian collapses the sidebar that way). The drawer half reads the real class the
  // pre-#420 toggle read, because the note-open path still closes the mobile drawer directly
  // (`core/app.js`); the docked half uses the mirror `setOpen` keeps in sync with `.sidebar-hidden`.
  function toggle() {
    setOpen(isNarrow() ? !isDrawerOpen(shell, "left") : !open);
  }

  // Entering drawer mode starts from "both drawers closed" (the desktop preference is only
  // remembered, never translated into an open drawer); leaving it restores that preference.
  function applyLayout() {
    if (isNarrow()) closeDrawers(shell);
    setOpen(isNarrow() ? false : desktopOpen);
  }

  // The shared policy closed this drawer because the other side opened: follow the real DOM so
  // `.active`/`open` never claim a drawer that is not on screen.
  const onPolicyChange = () => {
    if (open && isNarrow() && !isDrawerOpen(shell, "left")) setOpen(false);
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const next = tab.dataset.sidebarTab;
      if (next === view) {
        toggle();
        return;
      }
      showView(next);
      // Desktop prepares the panel it just opened; the file panel keeps its tree.
      if (next === "search") root.querySelector?.("#search")?.focus?.();
    });
  }
  toggleButton?.addEventListener("click", toggle);
  closePanelButton?.addEventListener("click", toggle);

  // Issue #427: the panel-head 新建笔记 entry only opens a local draft. The controller
  // owns the inline row, so this click never writes to the Vault by itself.
  function beginRootNoteDraft() {
    if (createNoteButton?.disabled) return;
    onNewNoteDraft?.();
  }
  createNoteButton?.addEventListener("click", () => { beginRootNoteDraft(); });

  // U6: the folder draft is opened by the explorer controller (it owns the tree);
  // the chrome only reports the click. Collapse-all is pure client state and is
  // always available, including on a read-only Vault.
  createFolderButton?.addEventListener("click", () => {
    if (createFolderButton.disabled) return;
    onNewFolder?.();
  });
  collapseButton?.addEventListener("click", () => { onCollapseAll?.(); });

  // A read-only deployment (or a session without write scope) cannot create notes or
  // folders; the vault inventory is the real source of that flag, so the actions are
  // disabled from it rather than from a guess. Discovery is best effort and never
  // blocks the UI.
  async function syncWritability() {
    if (!api || (!createNoteButton && !createFolderButton)) return;
    try {
      const inventory = await api("/api/web/v1/vaults");
      const current = (inventory?.vaults ?? []).find((vault) => vault.id === inventory?.current);
      if (current?.writable === false) {
        if (createNoteButton) {
          createNoteButton.disabled = true;
          createNoteButton.title = "当前 Vault 为只读，无法新建笔记";
        }
        if (createFolderButton) {
          createFolderButton.disabled = true;
          createFolderButton.title = "当前 Vault 为只读，无法新建文件夹";
        }
      }
    } catch {
      // The create path still reports a real failure if the write is rejected.
    }
  }

  shell?.addEventListener?.(DRAWER_POLICY_EVENT, onPolicyChange);
  media?.addEventListener?.("change", applyLayout);

  showView(view);
  applyLayout();
  syncWritability();

  return {
    showView,
    toggle,
    currentView: () => view,
    destroy() {
      shell?.removeEventListener?.(DRAWER_POLICY_EVENT, onPolicyChange);
      media?.removeEventListener?.("change", applyLayout);
    },
  };
}
