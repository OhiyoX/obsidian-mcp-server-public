// U14 right-rail show/hide toggle (`#sidebar-toggle`, pages.js).
//
// U18 moved it out of the rail into the layout layer; U29 (#371) put that layer in the topbar,
// where the toggle is the actions' rightmost control (the document tab row below it only exists
// while the strip has a tab). The rail's visibility is owned by `pane-layout.js` (it reconciles the
// pane close `#context-drawer-close`, the active rail tab, the narrow drawer and the persisted
// preference) — this module only mirrors that one state onto the toggle: `aria-pressed` plus a
// tooltip that says what the next click does. It never keeps a second copy of the state.
//
// Because the toggle sits outside the rail it stays reachable while the rail is hidden:
// it is the one layout-layer open *and* close path (#398 removed the ⋮ menu item that used to
// duplicate it).
export function attachSidebarToggle({ toggle = null, isOpen = () => true, setOpen = () => {} } = {}) {
  if (!toggle || typeof toggle.addEventListener !== "function") return null;

  function paint(open) {
    const label = open ? "隐藏右侧栏" : "显示右侧栏";
    toggle.setAttribute("aria-pressed", String(Boolean(open)));
    toggle.setAttribute("title", label);
    toggle.setAttribute("aria-label", label);
  }

  function onClick() {
    setOpen(!isOpen());
  }

  toggle.addEventListener("click", onClick);
  paint(isOpen());

  return {
    paint,
    destroy() {
      toggle.removeEventListener("click", onClick);
    },
  };
}
