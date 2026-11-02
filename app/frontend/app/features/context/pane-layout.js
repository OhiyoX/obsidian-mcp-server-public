// Open/close state for the note-context rail (right sidebar).
//
// Desktop keeps the rail open across reloads and collapses it from the layout-layer toggle
// `#sidebar-toggle` (U29: the topbar's rightmost action, so it works while the rail is hidden);
// a narrow viewport turns the rail into a drawer instead, closed by the same toggle, by the
// shared `.scrim`, or by the pane-level `#context-drawer-close` (the symmetric counterpart of
// the left pane's ✕). This module owns that single state so every entry point performs the same
// real collapse and the same remembered preference — the drawer close is a client of this state,
// never a second owner of it.
//
// The drawer itself belongs to the shared `<=720px` policy (`drawer-exclusion.js`): opening the
// files drawer hands this one back, so this module reconciles its state whenever the policy
// closes the rail from the outside.
import { onRailCollapseRequest } from "./view-switcher.js";
import { attachSidebarToggle } from "./sidebar-toggle.js";
import { DRAWER_POLICY_EVENT, DRAWER_QUERY, closeDrawers, isDrawerOpen, setDrawerOpen } from "./drawer-exclusion.js";

const contextPreferenceKey = "obsidian-web.context-open";

export function initializeContextPane({ shell, scrim, sidebarToggle = null, doc = globalThis.document }) {
  let desktopOpen = localStorage.getItem(contextPreferenceKey) !== "false";
  let open = false;
  const media = matchMedia(DRAWER_QUERY);
  const isNarrow = () => media.matches;
  // U18/U29: the layout-layer toggle mirrors the state below (never owns it). Resolved from
  // the shell markup so `core/app.js` stays a thin seam that passes only the shell and scrim.
  const toggleView = attachSidebarToggle({
    toggle: sidebarToggle ?? doc?.querySelector?.("#sidebar-toggle") ?? null,
    isOpen: () => open,
    setOpen: (value) => setOpen(value),
  });
  const drawerClose = doc?.querySelector?.("#context-drawer-close") ?? null;

  function setOpen(next) {
    open = Boolean(next);
    if (isNarrow()) {
      shell.classList.remove("context-hidden");
      // The one `<=720px` policy puts this drawer in/out of the shell and closes the other pane.
      setDrawerOpen(shell, "right", open);
    } else {
      shell.classList.remove("context-open");
      shell.classList.toggle("context-hidden", !open);
      desktopOpen = open;
      localStorage.setItem(contextPreferenceKey, String(open));
    }
    toggleView?.paint(open);
  }

  function applyLayout() {
    // Entering drawer mode starts from "both drawers closed" (the desktop preference is only
    // remembered, never translated into an open drawer).
    if (isNarrow()) closeDrawers(shell);
    setOpen(isNarrow() ? false : desktopOpen);
  }

  // The shared policy closed this drawer because the other side opened: follow the real DOM so
  // the toggle's `aria-pressed`/title never claim an open rail that is not on screen.
  const onPolicyChange = () => {
    if (open && isNarrow() && !isDrawerOpen(shell, "right")) setOpen(false);
  };

  if (drawerClose) drawerClose.onclick = () => setOpen(false);
  scrim.onclick = () => {
    closeDrawers(shell);
    if (isNarrow()) setOpen(false);
  };
  // U7: the view switcher publishes "the active tab was clicked" instead of owning the
  // collapse, so the rail has one collapse implementation and one preference.
  const offCollapseRequest = onRailCollapseRequest(() => setOpen(false));
  shell.addEventListener?.(DRAWER_POLICY_EVENT, onPolicyChange);
  media.addEventListener("change", applyLayout);
  applyLayout();

  return {
    isNarrow,
    isOpen: () => open,
    setOpen,
    destroy() {
      offCollapseRequest();
      toggleView?.destroy();
      shell.removeEventListener?.(DRAWER_POLICY_EVENT, onPolicyChange);
      media.removeEventListener("change", applyLayout);
    },
  };
}
