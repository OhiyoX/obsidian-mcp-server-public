// The Explorer's rename / safe-delete context menu (web rename+delete, task 6).
//
// One positional popup over the rows the Explorer already renders. It reuses the two #407
// primitives instead of growing a second interaction machine: `ui/popup-menu.js` owns `hidden`,
// the outside press, Escape, Arrow/Home/End over the enabled items, the focus matrix and the
// one-open-menu-per-scope rule; `ui/popup-position.js` owns the viewport-aware placement (the
// sidebar is `overflow: hidden`, so a popup laid out inside it would be clipped).
//
// A right click, the `ContextMenu` key and `Shift+F10` all report the row the user operated on,
// never an index: the target is read from the row's own data attributes (a folder wrapper
// carries `data-folder-path`, a note / attachment / Base name button carries `data-path` and,
// except for a plain note, `data-kind`). `F2` is the mnemonic entry to the same rename callback.
//
// Text comes from the catalog only (`src/i18n/messages/`), through the shell translator.
import { t } from "../../core/i18n.js";
import { createPopupMenuController } from "../../ui/popup-menu.js";
import { applyPopupLayout, computePopupLayout } from "../../ui/popup-position.js";

// Real markup: a folder is `div.tree-folder-row`; a note, an attachment and a Base are
// `button.note` (`.note-file` / `.note-base`), each with `data-path` and, except a plain note,
// `data-kind`.
export const ROW_SELECTOR = ".tree-folder-row, button.note";

const SCOPE = "explorer";
const MENU_WIDTH = 180;
// `folderOnly` items are hidden for every other row: a note has its own Publish button in the
// document bar, and only a directory has a folder address to publish (Task 8).
const MENU_ITEMS = [
  { action: "rename", labelKey: "explorer.menu.rename" },
  { action: "delete", labelKey: "explorer.menu.delete" },
  { action: "publishFolder", labelKey: "explorer.menu.publishFolder", folderOnly: true },
  { action: "unpublishFolder", labelKey: "explorer.menu.unpublishFolder", folderOnly: true },
];
const EMPTY_BOX = { left: 0, right: 0, top: 0, bottom: 0 };

function boxOf(node) {
  if (!node || typeof node.getBoundingClientRect !== "function") return null;
  const box = node.getBoundingClientRect();
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
}

// A pointer anchor is the right-click point; a keyboard open passes the row instead.
function anchorBox(anchor) {
  if (Number.isFinite(anchor?.clientX) && Number.isFinite(anchor?.clientY)) {
    return { left: anchor.clientX, right: anchor.clientX, top: anchor.clientY, bottom: anchor.clientY };
  }
  return boxOf(anchor);
}

/**
 * The rename / delete target of one Explorer row, or `null` for anything else (the sidebar
 * chrome, the inline draft, a row without its data attribute).
 *
 * @returns {{ kind: "folder" | "note" | "file" | "base", path: string } | null}
 */
export function targetFromRow(row) {
  if (!row || row.nodeType !== 1) return null;
  if (row.classList?.contains("tree-folder-row")) {
    const path = row.dataset?.folderPath;
    return path ? { kind: "folder", path } : null;
  }
  const nameButton = row.dataset?.path ? row : row.querySelector?.("[data-path]") ?? null;
  const path = nameButton?.dataset?.path;
  if (!path) return null;
  return { kind: nameButton.dataset.kind ?? "note", path };
}

/**
 * Create the one Explorer menu.
 *
 * @param {Object} options
 * @param {HTMLElement} options.host Container that owns the rows; the delegated `contextmenu`
 *   and `keydown` listeners live here.
 * @param {Document} [options.documentRef]
 * @param {Object} [options.windowRef] Viewport source for the placement.
 * @param {Function} [options.onRename] Called with the target (`{ kind, path }`).
 * @param {Function} [options.onDelete] Called with the target.
 * @param {Function} [options.onPublishFolder] Called with a folder target.
 * @param {Function} [options.onUnpublishFolder] Called with a folder target.
 * @returns {{openFor: Function, close: Function, itemFor: Function, target: Function, destroy: Function}}
 */
export function createExplorerContextMenu({
  host,
  documentRef = globalThis.document,
  windowRef = globalThis,
  onRename = () => {},
  onDelete = () => {},
  onPublishFolder = () => {},
  onUnpublishFolder = () => {},
} = {}) {
  if (!host || !documentRef) throw new TypeError("createExplorerContextMenu needs a host and a document");

  const popup = documentRef.createElement("div");
  popup.className = "tree-context-menu";
  popup.setAttribute("role", "menu");
  popup.setAttribute("aria-label", t("explorer.menu.label"));
  popup.hidden = true;

  const items = new Map();
  for (const { action, labelKey, folderOnly = false } of MENU_ITEMS) {
    const item = documentRef.createElement("button");
    item.className = "tree-context-menu-item";
    item.setAttribute("type", "button");
    item.setAttribute("role", "menuitem");
    item.setAttribute("data-menu-action", action);
    if (folderOnly) item.setAttribute("data-menu-folder-only", "true");
    item.textContent = t(labelKey);
    if (action === "rename") {
      const hint = documentRef.createElement("kbd");
      hint.textContent = t("explorer.menu.shortcutF2");
      item.append(hint);
    }
    popup.append(item);
    items.set(action, item);
  }
  documentRef.body.append(popup);

  let controller = null;
  let current = null;

  function rowForPath(path) {
    for (const row of host.querySelectorAll?.(ROW_SELECTOR) ?? []) {
      if (targetFromRow(row)?.path === path) return row;
    }
    return null;
  }

  function focusedRow() {
    return documentRef?.activeElement?.closest?.(ROW_SELECTOR) ?? null;
  }

  function place(anchor, element) {
    const box = anchorBox(anchor) ?? boxOf(element) ?? EMPTY_BOX;
    applyPopupLayout(popup, computePopupLayout({
      trigger: box,
      viewport: { width: Number(windowRef?.innerWidth) || 0, height: Number(windowRef?.innerHeight) || 0 },
      maxWidth: MENU_WIDTH,
      minWidth: MENU_WIDTH,
      maxHeight: 320,
      minHeight: 96,
      preferredHeight: 84,
      align: "start",
    }));
  }

  function close(options = {}) {
    if (controller) controller.close(options);
  }

  function openFor(target, { anchor = null, viaKeyboard = false, origin = undefined } = {}) {
    const row = target?.path ? rowForPath(target.path) : null;
    // A row that is no longer rendered gets no menu, so an item can never act on a stale path.
    if (!row) return false;
    close({ returnFocus: false });
    current = { kind: target.kind ?? "note", path: target.path };
    popup.setAttribute("data-menu-target", target.path);
    for (const item of items.values()) {
      item.disabled = false;
      // Only a folder row offers the two publish entries.
      item.hidden = item.getAttribute("data-menu-folder-only") === "true" && current.kind !== "folder";
    }
    place(anchor, row);
    controller = createPopupMenuController({
      trigger: row,
      popup,
      scope: SCOPE,
      attachTrigger: false,
      restoreFocus: true,
      restoreFocusTarget: "origin",
      dismissOnViewportChange: true,
      documentRef,
      windowRef,
      onClose: () => {
        const instance = controller;
        controller = null;
        current = null;
        instance?.destroy?.();
      },
    });
    return controller.open({ viaKeyboard, origin });
  }

  function onContextMenu(event) {
    const target = targetFromRow(event?.target?.closest?.(ROW_SELECTOR) ?? null);
    if (!target) return;
    event.preventDefault?.();
    openFor(target, { anchor: { clientX: event.clientX, clientY: event.clientY } });
  }

  function onKeyDown(event) {
    const key = event?.key;
    const opens = key === "ContextMenu" || (key === "F10" && event?.shiftKey);
    if (key !== "F2" && !opens) return;
    const target = targetFromRow(focusedRow());
    if (!target) return;
    event.preventDefault?.();
    if (opens) openFor(target, { viaKeyboard: true });
    else onRename(target);
  }

  function onMenuClick(event) {
    const item = event?.target?.closest?.("[data-menu-action]") ?? null;
    if (!item || item.disabled === true) return;
    const action = item.getAttribute("data-menu-action");
    const target = current;
    // The primitive closes the popup and hands the focus back to the row before the action
    // runs, so a dialog opened by the callback starts from the documented focus owner.
    close();
    if (!target) return;
    if (action === "rename") onRename(target);
    else if (action === "delete") onDelete(target);
    else if (action === "publishFolder") onPublishFolder(target);
    else onUnpublishFolder(target);
  }

  host.addEventListener("contextmenu", onContextMenu);
  host.addEventListener("keydown", onKeyDown);
  popup.addEventListener("click", onMenuClick);

  return {
    openFor,
    close,
    itemFor: (action) => items.get(action) ?? null,
    target: () => current,
    destroy() {
      close({ returnFocus: false });
      host.removeEventListener?.("contextmenu", onContextMenu);
      host.removeEventListener?.("keydown", onKeyDown);
      popup.removeEventListener?.("click", onMenuClick);
      popup.remove?.();
    },
  };
}
