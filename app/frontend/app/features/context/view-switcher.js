// Sidebar view switcher for the note-context rail (U1; rail top layout U7).
//
// Desktop keeps outline / outgoing links / backlinks / tags in one right rail and shows
// exactly one of them at a time, selected from the icon row at the top of the rail (U18/U29:
// that row is panel switching plus the pane-level close; the rail's show/hide control sits in
// the layout layer, the topbar's actions). This module owns that selection: it flips `hidden` on the view
// panels, mirrors `aria-selected` on the icon buttons and remembers the last view (desktop
// behaviour) in the same storage the other Web preferences use. Every view panel owns its
// own head row, so switching the view moves that head with it (U7) — no panel control
// lives in the shared tab row.
//
// Desktop also collapses the rail when the tab of the *already selected* view is clicked.
// The real collapse (desktop hide / narrow drawer / remembered preference) belongs to
// `pane-layout.js`, so this module only publishes that request through
// {@link onRailCollapseRequest}, which the pane controller subscribes to.
//
// It is element-scoped: no document/window listener, no `innerHTML`, and a no-op when
// the shell markup is absent (fixtures without the rail keep working).
const VIEW_KEY = "obsidian-web.context-view";
export const CONTEXT_VIEWS = ["outline", "outgoing", "incoming", "tags"];
export const DEFAULT_CONTEXT_VIEW = "outline";

// Module-scoped on purpose: the shell builds `attachNoteContext` (which creates the
// switcher) before `initializeContextPane` (which owns the collapse), so the subscriber
// list is resolved at click time instead of at construction time.
const collapseRequests = new Set();

export function onRailCollapseRequest(handler) {
  if (typeof handler !== "function") return () => {};
  collapseRequests.add(handler);
  return () => collapseRequests.delete(handler);
}

export function requestRailCollapse() {
  for (const handler of [...collapseRequests]) handler();
}

export function normalizeContextView(value) {
  return CONTEXT_VIEWS.includes(value) ? value : DEFAULT_CONTEXT_VIEW;
}

export function createContextViewSwitcher({
  documentRef = globalThis.document,
  storage = null,
  initial = null,
  onChange = () => {},
} = {}) {
  const root = documentRef?.querySelector?.("#context-sidebar") ?? null;
  const buttons = [...(root?.querySelectorAll?.("[data-context-view]") ?? [])];
  const panels = [...(root?.querySelectorAll?.("[data-context-view-panel]") ?? [])];

  if (!root || !buttons.length || !panels.length) {
    return { isWired: false, getView: () => null, setView: () => {}, destroy: () => {} };
  }

  const listeners = [];
  let active = DEFAULT_CONTEXT_VIEW;

  function readStored() {
    try {
      return storage?.getItem?.(VIEW_KEY) ?? null;
    } catch {
      return null;
    }
  }

  function persist(view) {
    try {
      storage?.setItem?.(VIEW_KEY, view);
    } catch {
      // A blocked/absent storage only costs the remembered view.
    }
  }

  function setView(view, { remember = true } = {}) {
    active = normalizeContextView(view);
    for (const button of buttons) {
      const selected = button.getAttribute("data-context-view") === active;
      button.setAttribute("aria-selected", String(selected));
      button.classList.toggle("is-active", selected);
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.getAttribute("data-context-view-panel") !== active;
    if (remember) persist(active);
    onChange(active);
  }

  for (const button of buttons) {
    const onClick = () => {
      const view = normalizeContextView(button.getAttribute("data-context-view"));
      // Clicking the tab of the view already on screen collapses the rail instead of
      // re-selecting it (desktop behaviour); the layout toggle `#sidebar-toggle` performs
      // the same collapse.
      if (view === active) {
        requestRailCollapse();
        return;
      }
      setView(view);
    };
    button.addEventListener("click", onClick);
    listeners.push([button, onClick]);
  }
  setView(initial ?? normalizeContextView(readStored()), { remember: false });

  return {
    isWired: true,
    getView: () => active,
    setView,
    destroy() {
      for (const [element, handler] of listeners) element.removeEventListener?.("click", handler);
    },
  };
}
