// Document actions chrome: the topbar `⋮` menu (copy link / Publish).
//
// U35 (#407): the open/close state machine moved into the shared `ui/popup-menu.js`
// primitive. The controller is now the only writer of `menu.hidden` and
// `toggle[aria-expanded]`, it owns the `⋮` click, the outside pointer dismissal and Escape
// (handing focus back to the `⋮` per the menu focus matrix), and it shares the `"topbar"`
// interaction scope with the reading-view menu, so the two can never be open at once.
// This module keeps only the document-action wiring: picking a real action closes the menu.
//
// `closeMenu` stays in the returned API because features/navigation/keyboard-shortcuts.js
// closes the shell's transient menus on Escape from anywhere in the page. On the primitive's
// own Escape path the menu is already closed and closing a closed popup is a no-op, so that
// second call can never take back the focus the primitive just restored.
import { createPopupMenuController } from "../../ui/popup-menu.js";

export function initializeDocumentActions({ toggle, menu, documentRef = globalThis.document } = {}) {
  const controller = createPopupMenuController({
    trigger: toggle,
    popup: menu,
    scope: "topbar",
    restoreFocus: true,
    documentRef,
  });

  // Desktop closes the `⋮` menu as soon as one of its document actions is picked.
  const onMenuClick = (event) => {
    if (event.target.closest("button")) controller.close();
  };
  menu.addEventListener("click", onMenuClick);

  return {
    closeMenu: () => controller.close({ returnFocus: false }),
    isOpen: () => controller.isOpen(),
    destroy() {
      menu.removeEventListener?.("click", onMenuClick);
      controller.destroy();
    },
  };
}
