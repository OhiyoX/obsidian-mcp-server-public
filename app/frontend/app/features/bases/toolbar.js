// Base tool row + action row (desktop parity).
//
// Left:  [view glyph] [view selector] [sort direction indicator] [N 个结果]
// Right: 排序 · 筛选 · 属性 · 搜索 · 新建 — all real controls, never dummies.
//
// The view selector is a real `<select data-select>`; the wiring layer enhances it
// with app/ui/select.js after every mount, so it never keeps the native look.
// Interactive state that must survive a re-render (open panel, search text and
// caret, pending new-note name) lives in this closure and in panels.js, never in
// the DOM.

import {
  BASE_ACTION_ITEMS,
  actionIsActive,
  describeSortIndicator,
} from "./actions.js";
import { el, spriteIcon } from "./dom.js";
import { panelBackdrop } from "./panel-chrome.js";
import { createPanelPositioner } from "./panel-position.js";
import { createVisualViewportObserver } from "./mobile-viewport.js";
import { createBasePanels } from "./panels.js";

export {
  BASE_ACTION_FILTER_TEXT,
  BASE_ACTION_ITEMS,
  BASE_ACTION_NEW_TEXT,
  BASE_ACTION_PROPERTIES_TEXT,
  BASE_ACTION_SEARCH_TEXT,
  BASE_ACTION_SORT_TEXT,
  BASE_SORT_INDICATOR_DEFAULT_ICON,
  actionIsActive,
  describeSortIndicator,
  folderOfPath,
} from "./actions.js";
export { BASE_FILTER_OP_LABELS } from "./panels.js";

// The action row doubles as the mobile overflow menu (issue #337 Cut 2), so the
// hamburger can point at it. One Base surface is mounted at a time, so the id is
// stable rather than generated.
const ACTION_MENU_ID = "base-action-menu";
const OVERFLOW_LABEL = "更多操作";
// One options object for both window listeners: a scroll inside the shell is delivered in
// the capture phase, and neither listener may delay the scroll it reacts to.
const VIEWPORT_LISTENER_OPTIONS = { passive: true, capture: true };

export function createBaseToolbar({
  doc,
  onSelectView,
  onSort,
  onFilter,
  onQuery,
  onToggleColumn,
  onHideAllColumns,
  onNewNote,
  queryDebounceMs = 250,
} = {}) {
  // The desktop's page stack (`this.pageStack`, asar app.js@2368072): ONE panel, and the menus
  // visited inside it are its pages. Depth 1 is the root page and has no header, exactly like the
  // desktop, which builds the header only when `pageStack.length > 1` (@2371419); every deeper
  // page can be left again from the header's back button. Two menus are never painted at once.
  let panelStack = [];
  let overflowOpen = false;
  let restore = null;
  let root = null;
  let actionRow = null;
  let onRefresh = null;
  let listenersAttached = false;

  const topPanel = () => panelStack[panelStack.length - 1] ?? null;

  const panels = createBasePanels({
    doc,
    close: () => close(),
    isNested: () => panelStack.length > 1,
    onBack: () => back(),
    onSort,
    onFilter,
    onQuery,
    onToggleColumn,
    onHideAllColumns,
    onNewNote,
    queryDebounceMs,
  });

  // Publishes `--base-visual-viewport-*` on the live tool row so the `<=480px`
  // overlay follows a keyboard/pinch instead of a stale `100dvh` band. The target is
  // re-resolved on every update because each render rebuilds the row.
  const viewport = createVisualViewportObserver({
    win: doc?.defaultView ?? null,
    resolveTarget: () => actionRow,
    onChange: (_metrics, target) => revealActiveElement(target),
  });

  // The mounted panel is `position:fixed` (the desktop `.menu` box) and `panel-position.js`
  // supplies its viewport coordinates above the desktop breakpoint; below it the stylesheet's
  // own narrow-band layout takes the box back.
  const positioner = createPanelPositioner({
    win: doc?.defaultView ?? null,
    resolvePanel: () => (root && typeof root.querySelector === "function" ? root.querySelector("[data-base-panel]") : null),
    resolveColumn: () => root,
  });

  // The overlay must never leave the focused input under the keyboard: after a
  // visual-viewport change the active control inside the (now shorter) panel is
  // scrolled back into the visible band.
  function revealActiveElement(target) {
    const active = doc?.activeElement;
    if (!active || !target || typeof active.scrollIntoView !== "function") return;
    if (typeof target.contains !== "function" || !target.contains(active)) return;
    active.scrollIntoView({ block: "nearest" });
  }

  function captureFocus() {
    if (!root || !doc || typeof doc.activeElement !== "object") return;
    const active = doc.activeElement;
    if (!active || typeof active.getAttribute !== "function") return;
    const holder = typeof active.closest === "function" ? (active.closest("[data-focus]") ?? active) : active;
    const key = typeof holder?.getAttribute === "function" ? holder.getAttribute("data-focus") : null;
    if (!key) return;
    restore = { key, start: active.selectionStart ?? null, end: active.selectionEnd ?? null };
  }

  function mountFocus() {
    if (!restore || !root || typeof root.querySelector !== "function") return;
    const pending = restore;
    restore = null;
    const target = root.querySelector(`[data-focus="${pending.key}"]`);
    if (!target) return;
    target.focus?.();
    if (pending.start !== null && typeof target.setSelectionRange === "function") {
      try {
        target.setSelectionRange(pending.start, pending.end ?? pending.start);
      } catch {
        // Selection restore is cosmetic only.
      }
    }
  }

  function close() {
    panelStack = [];
    overflowOpen = false;
    onRefresh?.();
  }

  // `back()`: leave the current page for the one below it — the desktop's own `back()`
  // (`app.js@2370560`: pop the stack, then display the page underneath). A menu already in the
  // stack is walked back to instead of being pushed twice, and picking the page you are already
  // on closes the panel, which is the toggle it always was.
  function togglePanel(panelId) {
    overflowOpen = false;
    const depth = panelStack.indexOf(panelId);
    if (depth < 0) panelStack = [...panelStack, panelId];
    else panelStack = depth === panelStack.length - 1 ? [] : panelStack.slice(0, depth + 1);
    const focusKey = topPanel() ? panels.initialFocusKey(topPanel()) : null;
    restore = focusKey ? { key: focusKey, start: null, end: null } : restore;
    onRefresh?.();
  }

  function back() {
    if (!panelStack.length) return;
    panelStack = panelStack.slice(0, -1);
    const top = topPanel();
    // Focus follows the page: back to its action button when a page is left, so the
    // dismissal path never drops the keyboard user on `<body>`.
    restore = top ? { key: `action-${top}`, start: null, end: null } : restore;
    onRefresh?.();
  }

  function toggleOverflow() {
    overflowOpen = !overflowOpen;
    if (overflowOpen) panelStack = [];
    onRefresh?.();
  }

  // The hamburger of the mobile tool row: a real button (so Enter/Space work without
  // extra key handling) and a disclosure — `aria-expanded` for its state plus
  // `aria-controls` for the row it reveals. No `aria-haspopup`: it opens a disclosure,
  // not an ARIA menu, and the revealed controls are the same real buttons as before.
  // Hidden by CSS above the mobile breakpoint, so the desktop tool row is unchanged.
  function buildOverflowButton() {
    const button = el(doc, "button", "base-toolbar-overflow");
    button.type = "button";
    button.setAttribute("data-base-overflow", "");
    button.setAttribute("data-focus", "overflow");
    button.setAttribute("aria-expanded", String(overflowOpen));
    button.setAttribute("aria-controls", ACTION_MENU_ID);
    button.setAttribute("aria-label", OVERFLOW_LABEL);
    const glyph = spriteIcon(doc, "menu", "base-action-icon");
    if (glyph) button.appendChild(glyph);
    button.onclick = () => toggleOverflow();
    return button;
  }

  function buildActionRow(state, context) {
    const row = el(doc, "div", "base-action-row");
    row.setAttribute("id", ACTION_MENU_ID);
    row.setAttribute("data-base-action-row", "");
    // Both classes are inert above the mobile breakpoint; they only say which shape
    // the `<=480px` stylesheet should paint (menu vs. the overlay's inert anchor).
    if (overflowOpen) row.classList.add("is-menu-open");
    if (topPanel()) row.classList.add("is-panel-open");
    actionRow = row;
    const flags = {
      sort: state.sort ?? [],
      filter: state.filter ?? [],
      q: state.q ?? "",
      hidden: context?.config?.hidden ?? [],
    };
    for (const item of BASE_ACTION_ITEMS) {
      // The anchor is the popover's positioning context: the panel floats inside
      // it, so opening a menu never changes the tool row height and the table never
      // moves (desktop Bases popovers).
      const anchor = el(doc, "span", "base-action-anchor");
      anchor.setAttribute("data-base-anchor", item.id);
      const button = el(doc, "button", "base-action");
      button.type = "button";
      button.setAttribute("data-base-action", item.id);
      button.setAttribute("data-focus", `action-${item.id}`);
      button.setAttribute("aria-haspopup", "dialog");
      if (actionIsActive(item.id, flags)) button.classList.add("base-action-active");
      button.setAttribute("aria-expanded", String(topPanel() === item.id));
      const glyph = spriteIcon(doc, item.icon, "base-action-icon");
      if (glyph) button.appendChild(glyph);
      button.appendChild(el(doc, "span", "base-action-label", item.label));
      button.onclick = () => togglePanel(item.id);
      anchor.appendChild(button);
      if (topPanel() === item.id) {
        const panel = panels.build(item.id, state, context);
        if (panel) {
          // Mobile overlay: the backdrop is the panel's own dismissal surface (it is
          // part of the toolbar chrome, not a generic outside click) and a sibling of
          // the panel, so the panel keeps the anchor as its positioning context.
          anchor.appendChild(panelBackdrop(doc, () => close()));
          anchor.appendChild(panel);
        }
      }
      row.appendChild(anchor);
    }
    return row;
  }

  function buildViewControl(state) {
    const views = Array.isArray(state.views) ? state.views : [];
    if (!views.length) return null;
    const wrapper = el(doc, "span", "base-view-control");
    const select = doc.createElement("select");
    select.className = "base-view-select";
    select.setAttribute("data-select", "");
    select.setAttribute("data-base-view", "true");
    // Stable focus slot for the custom listbox: `ui/select.js` mirrors it onto the trigger and
    // the options so the focus survives the re-render a view commit triggers (#409 review).
    select.setAttribute("data-focus", "base-view");
    select.setAttribute("aria-label", "Base view");
    for (const view of views) {
      const option = doc.createElement("option");
      option.value = view.name;
      option.textContent = view.name;
      option.setAttribute("data-base-view-option", view.name);
      select.appendChild(option);
    }
    if (state.view !== null && state.view !== undefined) select.value = state.view;
    select.onchange = () => onSelectView?.(select.value);
    wrapper.appendChild(select);
    return wrapper;
  }

  function buildSortIndicator(state) {
    const indicator = describeSortIndicator(state.sort);
    const node = el(doc, "span", `base-sort-indicator${indicator.active ? " base-sort-active" : ""}`);
    node.setAttribute("data-base-sort-indicator", indicator.dir ?? "");
    node.setAttribute("title", indicator.active
      ? (indicator.dir === "desc" ? "当前排序：降序" : "当前排序：升序")
      : "当前排序：视图默认");
    const glyph = spriteIcon(doc, indicator.icon, "base-panel-icon");
    if (glyph) node.appendChild(glyph);
    else node.textContent = indicator.active ? (indicator.dir === "desc" ? "↓" : "↑") : "⇅";
    return node;
  }

  function render(state, context = {}) {
    captureFocus();
    const header = el(doc, "div", "base-surface-header");
    const toolbar = el(doc, "div", "base-surface-toolbar");
    // The tool row leads with the view's own glyph (desktop registers table /
    // layout-grid / list icons per view). Only symbols the shared sprite already
    // carries are used, so no asset byte is added for this.
    const glyphName = state.viewType === "list" ? "list-tree" : state.viewType === "cards" ? "gallery-vertical" : "table";
    const glyph = spriteIcon(doc, glyphName, "base-surface-toolbar-icon");
    if (glyph) toolbar.appendChild(glyph);

    const control = buildViewControl(state);
    if (control) toolbar.appendChild(control);
    toolbar.appendChild(buildSortIndicator(state));
    toolbar.appendChild(el(doc, "span", "base-surface-count", `${state.totalMatched ?? state.rows?.length ?? 0} 个结果`));
    toolbar.appendChild(buildOverflowButton());
    toolbar.appendChild(buildActionRow(state, context));
    header.appendChild(toolbar);
    return header;
  }

  // ---- Popover dismissal ---------------------------------------------------

  // "Outside" means: not the popover, not an action button (each one toggles its
  // own panel) and not the view dropdown, whose own menu opens inside the tool row
  // and would otherwise be replaced by the re-render before it can be used.
  //
  // The event path is preferred over `target.closest`: the app's own dropdown
  // replaces its menu items inside the click handler (`menu.replaceChildren()`), so
  // by the time the event reaches the document a clicked option is already detached
  // and `closest()` can no longer see the popover it belongs to. Dismissal therefore
  // runs on `mousedown` (before any handler can rewrite the tree) and falls back to
  // the frozen path for a bare `click`.
  function eventIsInsideToolbarChrome(event) {
    const path = typeof event?.composedPath === "function" ? event.composedPath() : null;
    if (Array.isArray(path) && path.length) {
      return path.some((node) => node?.nodeType === 1 && (
        (typeof node.hasAttribute === "function" && node.hasAttribute("data-base-panel"))
        || (typeof node.hasAttribute === "function" && node.hasAttribute("data-base-action"))
        // The mobile overlay backdrop dismisses the panel itself (`panelBackdrop`); the
        // generic outside-press path must not race it, or a backdrop tap would stop
        // being the observable dismissal it is asserted to be.
        || (typeof node.hasAttribute === "function" && node.hasAttribute("data-base-panel-backdrop"))
        || (typeof node.hasAttribute === "function" && node.hasAttribute("data-base-overflow"))
        || (typeof node.classList?.contains === "function" && node.classList.contains("base-view-control"))
      ));
    }
    const target = event?.target;
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest("[data-base-panel],[data-base-action],[data-base-panel-backdrop],[data-base-overflow],.base-view-control"));
  }

  function onDocumentPointerDown(event) {
    if (!topPanel()) return;
    if (eventIsInsideToolbarChrome(event)) return;
    close();
  }

  function onDocumentClick(event) {
    // A keyboard-activated button fires a click without a preceding mousedown; the
    // pointer listener above already covered every real pointer interaction.
    if (!topPanel()) return;
    if (eventIsInsideToolbarChrome(event)) return;
    close();
  }

  function onDocumentKeyDown(event) {
    if (event?.key !== "Escape") return;
    // An open custom dropdown inside the popover closes itself on Escape first
    // (ui/select.js), so the popover stays open for that keystroke.
    const open = root && typeof root.querySelector === "function"
      ? root.querySelector(".base-panel .select-control.is-open")
      : null;
    if (open) return;
    if (topPanel()) {
      close();
      return;
    }
    // The hamburger menu is keyboard-reachable (a real button), so it needs a
    // keyboard dismissal as well as the tap on its own toggle.
    if (overflowOpen) {
      overflowOpen = false;
      onRefresh?.();
    }
  }

  function onViewportChange() {
    positioner.sync();
  }

  function attachDocumentListeners() {
    if (listenersAttached || !doc || typeof doc.addEventListener !== "function") return;
    listenersAttached = true;
    doc.addEventListener("mousedown", onDocumentPointerDown);
    doc.addEventListener("click", onDocumentClick);
    doc.addEventListener("keydown", onDocumentKeyDown);
    // A resize, or a scroll anywhere in the shell, moves the anchor away from the
    // viewport coordinates the open popover was placed at.
    const win = doc.defaultView;
    if (win && typeof win.addEventListener === "function") {
      win.addEventListener("resize", onViewportChange, VIEWPORT_LISTENER_OPTIONS);
      win.addEventListener("scroll", onViewportChange, VIEWPORT_LISTENER_OPTIONS);
    }
  }

  function detachDocumentListeners() {
    if (!listenersAttached || !doc || typeof doc.removeEventListener !== "function") return;
    listenersAttached = false;
    doc.removeEventListener("mousedown", onDocumentPointerDown);
    doc.removeEventListener("click", onDocumentClick);
    doc.removeEventListener("keydown", onDocumentKeyDown);
    const win = doc.defaultView;
    if (win && typeof win.removeEventListener === "function") {
      win.removeEventListener("resize", onViewportChange, VIEWPORT_LISTENER_OPTIONS);
      win.removeEventListener("scroll", onViewportChange, VIEWPORT_LISTENER_OPTIONS);
    }
  }

  return {
    render,
    afterMount(node, refresh) {
      root = node ?? root;
      onRefresh = typeof refresh === "function" ? refresh : onRefresh;
      attachDocumentListeners();
      mountFocus();
      // Re-place the open popover against the freshly built row.
      positioner.sync();
      // Re-publish the visual-viewport band on the freshly built row (the previous
      // target is gone) and keep observing for keyboard/pinch changes.
      viewport.attach();
      viewport.sync({ force: true });
    },
    closeAll() {
      panelStack = [];
      overflowOpen = false;
    },
    getOpenPanel: () => topPanel(),
    getPanelDepth: () => panelStack.length,
    getOverflowOpen: () => overflowOpen,
    getActionRow: () => actionRow,
    destroy() {
      panels.destroy();
      detachDocumentListeners();
      viewport.destroy();
      root = null;
      actionRow = null;
      onRefresh = null;
      panelStack = [];
      overflowOpen = false;
      positioner.sync();
    },
  };
}
