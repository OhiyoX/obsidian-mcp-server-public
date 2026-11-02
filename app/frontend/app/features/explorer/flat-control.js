// Explorer flat-view controls — the browse-mode menu and the flat sort menu.
//
// Both are the same desktop-shaped control the Tree sort uses: one toolbar icon
// button that opens a `role="menu"` of `role="menuitemradio"` options, with the
// checked option carrying `aria-checked="true"`. They are separate from
// `sort-control.js` on purpose: the Tree control is frozen with the Phase 1 Tree
// schema (`name`/`modified`), while the flat list has its own key set and a
// query-only capability subset, so sharing one instance would have to mutate the
// Tree contract.
//
// Options whose `data-requires-query="true"` are only meaningful while a query is
// active (the flat list is then a client-side projection of the search payload). With
// no query the server owns the order and can only serve the globally meaningful
// columns, so those options render disabled with an explicit reason instead of
// silently doing nothing.
import { applyPopupLayout, computePopupLayout } from "../../ui/popup-position.js";

function preventFocusSteal(element) {
  element.addEventListener("mousedown", (event) => event.preventDefault());
}

function createOptionMenu({
  scope,
  win,
  triggerSelector,
  menuSelector,
  optionAttribute,
  onPick,
  readCurrent,
  labelFor,
  fallbackLabel,
}) {
  const root = scope?.querySelector?.(triggerSelector);
  const menu = scope?.querySelector?.(menuSelector);
  if (!root || !menu) return null;
  const options = [...menu.querySelectorAll(`[${optionAttribute}]`)];
  if (options.length === 0) return null;

  let open = false;
  // Only a keyboard-opened menu moves focus; a mouse interaction must leave focus
  // alone so an active inline-create draft keeps it (same rule as the Tree control).
  let keyboardOpened = false;

  function enabledOptions() {
    return options.filter((button) => button.disabled !== true);
  }

  function sync() {
    const current = readCurrent?.() ?? { value: null, query: false };
    for (const button of options) {
      const value = button.getAttribute(optionAttribute);
      button.setAttribute("aria-checked", String(value === current.value));
      const requiresQuery = button.dataset.requiresQuery === "true";
      const available = !requiresQuery || current.query === true;
      button.disabled = !available;
      button.title = available ? "" : "空查询时暂不支持该排序";
    }
    const chosen = options.find((button) => button.getAttribute(optionAttribute) === current.value);
    const label = labelFor?.(chosen) || fallbackLabel;
    root.setAttribute("aria-label", label);
    root.title = label;
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
    if (keyboard) {
      const checked = options.find((button) => button.getAttribute("aria-checked") === "true" && !button.disabled);
      (checked ?? enabledOptions()[0])?.focus?.();
    }
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
      if (button.disabled) return;
      closeMenu();
      onPick?.(button.getAttribute(optionAttribute), button);
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
    const available = enabledOptions();
    if (available.length === 0) return;
    const index = available.indexOf(scope.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    (index < 0 ? available[0] : available[(index + step + available.length) % available.length])?.focus?.();
  });
  scope.addEventListener("pointerdown", (event) => {
    if (!open || menu.contains(event.target) || root.contains(event.target)) return;
    closeMenu();
  }, true);
  win.addEventListener("resize", () => { if (open) position(); }, { passive: true });
  win.addEventListener("scroll", () => { if (open) position(); }, { passive: true, capture: true });

  sync();
  return { root, menu, sync, isOpen: () => open, close: closeMenu };
}

function parsePair(value) {
  const [key, direction] = String(value ?? "").split(":");
  return key && direction ? { key, direction } : null;
}

export function initializeExplorerFlatControls({
  getMode,
  onMode,
  getFlatSort,
  onFlatSort,
  isQueryActive,
  scope = globalThis.document,
  win = globalThis.window,
} = {}) {
  const mode = createOptionMenu({
    scope,
    win,
    triggerSelector: "#explorer-mode-toggle",
    menuSelector: "#explorer-mode-menu",
    optionAttribute: "data-explorer-mode",
    onPick: (value) => onMode?.(value),
    readCurrent: () => ({ value: getMode?.() ?? "tree", query: false }),
    labelFor: (button) => {
      const label = button?.querySelector?.(".explorer-sort-option-label")?.textContent?.trim();
      return label ? `浏览模式：${label}` : null;
    },
    fallbackLabel: "浏览模式",
  });

  const sort = createOptionMenu({
    scope,
    win,
    triggerSelector: "#explorer-flat-sort-toggle",
    menuSelector: "#explorer-flat-sort-menu",
    optionAttribute: "data-flat-sort",
    onPick: (value) => {
      const spec = parsePair(value);
      if (spec) onFlatSort?.(spec);
    },
    readCurrent: () => {
      const spec = getFlatSort?.() ?? { key: "", direction: "" };
      return { value: `${spec.key}:${spec.direction}`, query: isQueryActive?.() === true };
    },
    labelFor: (button) => {
      const label = button?.querySelector?.(".explorer-sort-option-label")?.textContent?.trim();
      return label ? `排序：${label}` : null;
    },
    fallbackLabel: "排序",
  });

  return {
    mode,
    sort,
    sync() {
      mode?.sync();
      sort?.sync();
    },
  };
}
