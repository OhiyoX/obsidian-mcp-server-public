// #429 — the document tab strip's batch-close menu (Close / Others / Left / Right / All).
//
// The menu is one positional popup, bound to the tab a user operated on: the right-click
// (`contextmenu`), the keyboard `Shift+F10`/`ContextMenu` key and the touch long press all
// arrive here through `features/tabs/view.js` with the *operated tab's path*, so no action can
// drift onto the active tab or a numeric index.
//
// It deliberately reuses the two #407 primitives instead of growing a second interaction
// machine:
//   * `ui/popup-menu.js` owns `hidden`, the outside-pointer dismissal, Escape, Arrow/Home/End
//     over the enabled items, the focus matrix and the one-open-menu-per-scope rule;
//   * `ui/popup-position.js` owns the viewport-aware placement, so the strip's
//     `overflow-x: auto` can never clip the menu.
//
// Two consequences of being positional rather than a disclosure button:
//   * the controller is created per open with the operated tab as its anchor, because
//     `ui/popup-menu.js` pairs one controller with one trigger for the focus return and the
//     "the pointer is still inside" test — a context menu's anchor changes with every open;
//   * `attachTrigger: false`: the anchor is a `role="tab"` button, which is not a disclosure
//     trigger, so the primitive must not bind its `click` and must not write `aria-expanded`
//     on it (ARIA forbids `aria-expanded` on `tab`). The menu's own `role="menu"` plus the
//     focus it takes is what announces it;
//   * `restoreFocusTarget: "origin"`: closing hands the focus back to whatever owned it when the
//     menu opened. A keyboard open (Shift+F10 / ContextMenu) captured the operated tab, so focus
//     returns there; a mouse right-click never took the editor's focus way, so it gets it back
//     (`Close Right` on a background tab must not steal the editor focus — #429).
//
// A re-render of the strip (a history navigation, an SSE-driven list change, another close) replaces
// every row, so the element a menu was opened against — and, for a keyboard open, the focus owner the
// close must give the focus back to — is detached afterwards. `sync()` is the reaction to that: it
// re-points the open menu at the live row (and re-places it there), or closes it when the operated tab
// is gone, in which case the focus goes to a live tab rather than to a detached node (a focused
// detached node silently leaves `document.activeElement` on `body`).
//
// The menu never decides product semantics: `planFor(action, path)` is the model's planner, so
// an item is enabled exactly while its plan would really remove a tab, and a disabled item can
// never be reported as a successful close.
import { tabTitle } from "./model.js";
import { createPopupMenuController } from "../../ui/popup-menu.js";
import { applyPopupLayout, computePopupLayout } from "../../ui/popup-position.js";

/** Ordered exactly like the product contract: Close, Close Others, Left, Right, Close All. */
export const TAB_CLOSE_MENU_ITEMS = Object.freeze([
  { action: "close", label: "关闭" },
  { action: "close-others", label: "关闭其他" },
  { action: "close-left", label: "关闭左侧标签页" },
  { action: "close-right", label: "关闭右侧标签页" },
  { action: "close-all", label: "关闭全部" },
]);

const SCOPE = "document-tabs";
const MENU_WIDTH = 232;

function boxOf(element) {
  if (typeof element?.getBoundingClientRect !== "function") return { left: 0, right: 0, top: 0, bottom: 0 };
  const box = element.getBoundingClientRect();
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
}

export function createTabsCloseMenu({
  documentRef = globalThis.document,
  // The model's planner: `planFor(action, operatedPath)` -> the bulk plan (or nothing).
  planFor = () => ({ kind: "invalid" }),
  onAction = () => {},
  // Viewport source for `ui/popup-position.js`; injected so a headless host can measure.
  getViewport = () => ({ width: Number(globalThis.innerWidth) || 0, height: Number(globalThis.innerHeight) || 0 }),
} = {}) {
  const host = documentRef?.body ?? null;
  if (!host || typeof documentRef?.createElement !== "function") return null;

  const popup = documentRef.createElement("div");
  popup.className = "tabs-close-menu";
  popup.setAttribute("role", "menu");
  popup.setAttribute("aria-label", "标签页操作");
  popup.hidden = true;

  const items = new Map();
  for (const { action, label } of TAB_CLOSE_MENU_ITEMS) {
    const item = documentRef.createElement("button");
    item.className = "tabs-close-menu-item";
    item.setAttribute("type", "button");
    item.setAttribute("role", "menuitem");
    item.setAttribute("data-tab-action", action);
    item.textContent = label;
    popup.append(item);
    items.set(action, item);
  }
  host.append(popup);

  let controller = null;
  let operatedPath = null;
  // The element the open menu is paired with. Kept in step with the live DOM by `sync()`, because
  // the strip rebuilds its rows on every model change (see the header).
  let anchorElement = null;

  function anchorFor(path) {
    const rows = documentRef.querySelectorAll?.("#document-tabs .document-tab") ?? [];
    for (const row of rows) {
      if (row.getAttribute("data-tab-path") === path) return row.querySelector(".document-tab-main") ?? row;
    }
    return null;
  }

  /** A live element a close can hand the focus to: the shown document's tab, else the first one. */
  function liveTabAnchor() {
    const mains = [...(documentRef.querySelectorAll?.("#document-tabs .document-tab-main") ?? [])];
    return mains.find((main) => main.getAttribute("aria-selected") === "true") ?? mains[0] ?? null;
  }

  /** Enabled exactly while the action would really remove a tab (the model decides). */
  function paint(path) {
    for (const [action, item] of items) {
      const plan = planFor(action, path);
      const enabled = plan?.kind === "commit";
      item.disabled = !enabled;
      item.setAttribute("aria-disabled", String(!enabled));
    }
    popup.setAttribute("aria-label", `${tabTitle(path)}：标签页操作`);
    popup.setAttribute("data-tab-menu-target", path);
  }

  function place(anchor) {
    const box = anchor ?? { left: 0, right: 0, top: 0, bottom: 0 };
    applyPopupLayout(popup, computePopupLayout({
      trigger: box,
      viewport: getViewport(),
      maxWidth: MENU_WIDTH,
      minWidth: MENU_WIDTH,
      maxHeight: 320,
      minHeight: 120,
      preferredHeight: 32 * TAB_CLOSE_MENU_ITEMS.length + 12,
      align: "start",
    }));
  }

  function close(options = {}) {
    if (controller) controller.close(options);
  }

  function onMenuClick(event) {
    const item = event.target?.closest?.("[data-tab-action]") ?? null;
    if (!item || item.disabled === true) return;
    const action = item.getAttribute("data-tab-action");
    const path = operatedPath;
    // The primitive closes the popup and restores the focus the menu opened with before the
    // action runs — the operated tab for a keyboard open, the editor for a right-click, so a
    // background-only batch never steals the editor's focus and the strip's own focus policy
    // sees a real element rather than a hidden menu item.
    close();
    if (path !== null) onAction(action, path);
  }
  popup.addEventListener("click", onMenuClick);

  return {
    isOpen: () => Boolean(controller?.isOpen?.()),
    target: () => operatedPath,
    itemFor: (action) => items.get(action) ?? null,
    /**
     * Open the menu for the tab a user operated on. `anchor` is the pointer point (right-click /
     * long press) or the tab box (keyboard); `origin` is the focus owner the caller captured
     * before the gesture moved it, so the close can give that focus back.
     */
    open(path, { anchor = null, viaKeyboard = false, origin = undefined } = {}) {
      // A tab that no longer exists (or an unknown action plan) gets no menu at all, so the
      // menu can never offer a stale target.
      if (planFor("close", path)?.kind !== "commit") return false;
      if (controller?.isOpen() && operatedPath === path) return true;
      close({ returnFocus: false });
      const element = anchorFor(path);
      if (!element) return false;
      paint(path);
      place(anchor ?? boxOf(element));
      operatedPath = path;
      anchorElement = element;
      controller = createPopupMenuController({
        trigger: element,
        popup,
        scope: SCOPE,
        attachTrigger: false,
        restoreFocus: true,
        restoreFocusTarget: "origin",
        dismissOnViewportChange: true,
        documentRef,
        onClose: () => {
          const instance = controller;
          controller = null;
          operatedPath = null;
          instance?.destroy?.();
        },
      });
      return controller.open({ viaKeyboard, origin });
    },
    /**
     * Keep an open menu honest when the tab list changed under it (SSE, another close, a history
     * navigation): the strip re-rendered, so the row the menu was opened against is a fresh node.
     * Follow the live row — the popup is positional, so its anchor and its placement move with it —
     * and let the primitive's focus return find a node that is still in the document. A menu whose
     * operated tab is gone has nothing left to act on, so it closes and hands the focus to a live tab.
     */
    sync() {
      if (!controller?.isOpen()) return;
      const element = anchorFor(operatedPath);
      if (element && planFor("close", operatedPath)?.kind === "commit") {
        if (element !== anchorElement) {
          anchorElement = element;
          controller.retarget({ trigger: element });
          place(boxOf(element));
        }
        paint(operatedPath);
        return;
      }
      // Closing, not re-anchoring: the recorded focus origin belongs to the replaced strip by now,
      // so point the controller at a live tab before the close (see `liveTabAnchor`). A strip with
      // no live row left (the operated tab was the last one) therefore hands the primitive no
      // usable trigger at all: the close must not focus a detached row, and its focus lands on the
      // documented terminal instead (the document body — see the focus chain in `ui/popup-menu.js`).
      const live = liveTabAnchor();
      if (live) controller.retarget({ trigger: live });
      close();
    },
    close,
    destroy() {
      close({ returnFocus: false });
      operatedPath = null;
      anchorElement = null;
      popup.removeEventListener?.("click", onMenuClick);
      popup.remove?.();
    },
  };
}
