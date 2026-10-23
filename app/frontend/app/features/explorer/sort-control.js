// Explorer sort control — the sidebar toolbar trigger plus its option menu.
//
// Desktop Obsidian keeps sorting in the file-explorer toolbar as one icon button that
// opens a menu (filename / edit time), instead of spending a whole row on separate key
// and direction buttons; this control mirrors that. It owns presentation only: the
// stored preference lives in `sort-preference.js` and the request identity/fence in
// `sort-spec.js` + `lazy-controller.js`.
//
// `mousedown` is prevented on the trigger and on every option so a mouse click cannot
// blur an active inline-create input; the controller still owns the decision to defer a
// structural reorder.

import { coerceExplorerSort } from "./sort-preference.js";
import { applyPopupLayout, computePopupLayout } from "../../ui/popup-position.js";

function preventFocusSteal(element) {
  element.addEventListener("mousedown", (event) => event.preventDefault());
}

export function initializeExplorerSortControl({ getSort, onSort, scope = globalThis.document, win = globalThis.window } = {}) {
  const root = scope?.querySelector?.("#explorer-sort-toggle");
  const menu = scope?.querySelector?.("#explorer-sort-menu");
  if (!root || !menu) return null;
  const options = [...menu.querySelectorAll("[data-sort-key][data-sort-direction]")];
  if (options.length === 0) return null;

  let current = coerceExplorerSort(getSort?.());
  let open = false;
  // Only a keyboard-opened menu moves focus (to the checked option, back to the trigger
  // on close): a mouse interaction must leave focus alone so an active inline-create
  // draft keeps it, exactly like the previous button row.
  let keyboardOpened = false;

  const optionFor = (spec) => options.find((button) => button.dataset.sortKey === spec.key && button.dataset.sortDirection === spec.direction) ?? null;
  const labelOf = (button) => button?.querySelector?.(".explorer-sort-option-label")?.textContent?.trim() || "排序";

  function sync(spec) {
    current = coerceExplorerSort(spec);
    for (const button of options) {
      button.setAttribute("aria-checked", String(button.dataset.sortKey === current.key && button.dataset.sortDirection === current.direction));
    }
    // The toolbar keeps a single icon; the current choice is its accessible name and
    // tooltip, exactly like the desktop file explorer.
    const label = labelOf(optionFor(current));
    root.setAttribute("aria-label", `排序：${label}`);
    root.title = `排序：${label}`;
  }

  function position() {
    const width = Math.round(menu.getBoundingClientRect().width);
    applyPopupLayout(menu, computePopupLayout({
      trigger: root.getBoundingClientRect(),
      viewport: { width: win.innerWidth, height: win.innerHeight },
      minWidth: width,
      maxWidth: width,
      maxHeight: 320,
      minHeight: 96,
      preferredHeight: 240,
    }));
  }

  function openMenu({ keyboard = false } = {}) {
    if (open) return;
    open = true;
    keyboardOpened = keyboard;
    menu.hidden = false;
    root.setAttribute("aria-expanded", "true");
    position();
    if (keyboard) optionFor(current)?.focus?.();
  }

  function closeMenu() {
    if (!open) return;
    open = false;
    menu.hidden = true;
    root.setAttribute("aria-expanded", "false");
    if (keyboardOpened) root.focus?.();
    keyboardOpened = false;
  }

  for (const button of options) {
    preventFocusSteal(button);
    button.addEventListener("click", () => {
      closeMenu();
      onSort?.({ key: button.dataset.sortKey, direction: button.dataset.sortDirection });
    });
  }
  preventFocusSteal(root);
  root.addEventListener("click", () => {
    if (open) closeMenu();
    else openMenu();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu({ keyboard: true });
    } else if (event.key === "Escape") {
      closeMenu();
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = options.indexOf(scope.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    (index < 0 ? options[0] : options[(index + step + options.length) % options.length])?.focus?.();
  });
  scope.addEventListener("pointerdown", (event) => {
    if (!open || menu.contains(event.target) || root.contains(event.target)) return;
    closeMenu();
  }, true);
  win.addEventListener("resize", () => { if (open) position(); }, { passive: true });
  win.addEventListener("scroll", () => { if (open) position(); }, { passive: true, capture: true });

  sync(current);
  return { root, menu, sync, isOpen: () => open, close: closeMenu, getDirection: () => current.direction };
}
