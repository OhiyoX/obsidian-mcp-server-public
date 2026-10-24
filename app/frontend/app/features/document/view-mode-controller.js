// Reading-view (阅读视图 / 源码模式 / 实时预览) menu controller.
//
// U35 (#407): the menu state machine moved into the shared `ui/popup-menu.js` primitive,
// which is the only writer of `menu.hidden` and `toggle[aria-expanded]` and owns the toggle
// click, the outside pointer dismissal, Escape and the Arrow/Home/End navigation. Every
// reading-view control shares the `"topbar"` interaction scope with the document `⋮` menu,
// so opening one closes the other.
//
// `restoreFocus: false` is the reading-view contract: picking a mode moves the focus where
// the mode needs it (the editor for live/raw, wherever the pointer left it for the reader),
// never back to the toggle. The primitive keeps that promise for every close path, including
// Escape, which is why the shell-wide Escape owner only has to call the idempotent
// `closeMenu` below.
import { createPopupMenuController } from "../../ui/popup-menu.js";
// U38 (#571): the sprite URL (with its published content hash) comes from the one resolver.
import { iconHref } from "../../ui/icons.js";

export function initializeViewModeController({
  state,
  documentHost,
  editorHost,
  preview,
  editor,
  renderPreview,
  renderWelcome,
  refreshOutline,
}) {
  const controls = [...document.querySelectorAll(".view-mode")];
  const toggles = [...document.querySelectorAll(".view-mode-toggle")];

  // A control without its toggle or menu (older fixture markup) simply gets no controller,
  // which is the same no-op the previous inline implementation had.
  const menus = controls
    .map((control) => ({
      toggle: control.querySelector(".view-mode-toggle"),
      menu: control.querySelector(".view-mode-menu"),
    }))
    .filter((entry) => entry.toggle && entry.menu)
    .map((entry) => createPopupMenuController({
      trigger: entry.toggle,
      popup: entry.menu,
      scope: "topbar",
      restoreFocus: false,
    }));

  function closeMenu() {
    for (const menu of menus) menu.close({ returnFocus: false });
  }

  function setMode(mode) {
    state.mode = mode;
    documentHost.classList.toggle("mode-live", mode === "live");
    documentHost.classList.toggle("mode-raw", mode === "raw");
    documentHost.classList.toggle("mode-preview", mode === "preview");
    const useEditor = (mode === "raw" || mode === "live") && Boolean(state.path);
    // Community themes commonly key Live Preview rules off this exact
    // Obsidian host class. Keep it tied to the visible mode, not permanently on.
    editorHost.classList.toggle("is-live-preview", mode === "live");
    editorHost.hidden = !useEditor;
    preview.hidden = useEditor;

    const icons = { preview: "book-open", raw: "code", live: "pen" };
    for (const toggle of toggles) toggle.querySelector("use")?.setAttribute("href", iconHref(document, icons[mode] || "book-open"));
    document.querySelectorAll(".view-mode-item").forEach((item) => {
      const active = item.dataset.mode === mode;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-checked", String(active));
    });

    editor.setMode(mode === "raw" ? "raw" : "live");
    if (mode === "live") editor.leavePropertiesCaret();
    if (mode === "preview") renderPreview();
    else if (!state.path) renderWelcome();
    else refreshOutline();
    if (mode === "live" || mode === "raw") editor.focus();
    closeMenu();
  }

  document.querySelectorAll(".view-mode-item").forEach((item) => {
    item.onclick = () => setMode(item.dataset.mode);
  });

  return {
    closeMenu,
    setMode,
    isOpen: () => menus.some((menu) => menu.isOpen()),
    destroy() {
      for (const menu of menus) menu.destroy();
    },
  };
}
