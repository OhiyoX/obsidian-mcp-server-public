// U14 document tab strip — DOM view.
//
// Renders the model's tabs into the SSR container `#document-tabs` (pages.js) with the
// exact class/attribute contract frozen by the U14 BRIEF:
//
//   <div class="document-tab is-active" role="presentation" data-tab-path="...">
//     <button class="document-tab-main" role="tab" aria-selected="true" tabindex="0"
//             data-tab-path="..." data-tab-index="0" title="<full path>">
//       <span class="document-tab-title">note name</span>
//     </button>
//     <button class="document-tab-close" aria-label="关闭 name" data-tab-close="0" tabindex="-1">x</button>
//   </div>
//
// The wrapper exists because a close control must not be nested inside the tab button;
// every element is built through the DOM API (no innerHTML) so a vault path can never
// become markup. Rendering is stateless: the controller re-renders the whole strip after
// every model change, and focus inside the strip survives a re-render.
//
// Keyboard contract (#408, audit Cut C) — roving tabindex, activation on navigation:
// - ArrowLeft/ArrowRight/Home/End ask the controller to activate the tab they land on and,
//   once that activation commits, put DOM focus on it, so the active document, the single
//   `aria-selected=true` tab and `document.activeElement` are one and the same tab. A
//   refused activation (dirty-document guard / failed open) sends focus back to the tab the
//   document still shows instead of stranding it on a tab that was never opened.
// - `Delete` closes the tab that contains the focused element, but only while focus is
//   inside this tablist, so it never shadows the editor's own Delete.
// - A re-render restores focus by tab path (identity + control), never by numeric index, so
//   closing a neighbour cannot drag focus onto a different tab. Focus that lives outside
//   the strip (editor / reading pane) is never taken over; closing the active tab is the one
//   close that moves focus, and it lands on the tab the close handed over to.
//
// Batch-close entry points (#429) — every one of them reports the *operated* tab's path, never
// the active tab or a numeric index:
// - `contextmenu` (mouse / trackpad right-click) on a tab opens the menu for that tab;
// - `Shift+F10` / the `ContextMenu` key does the same for the focused tab, so the menu is
//   keyboard-reachable without a pointer;
// - a held touch/pen press (long press) does the same on touch-only devices, where there is no
//   right button at all. Only this view knows about the pointer (`pointerdown`/`pointermove`)
//   and about suppressing the click a long press would otherwise turn into a second action — a tab
//   switch on the main button, a close on the row's `x`;
//   the menu itself, its dismissal and its focus policy belong to `./menu.js`.
import { tabTitle } from "./model.js";
// U38 (#571): the sprite URL (and its published content hash) comes from the one resolver.
import { spriteIcon } from "../../ui/icons.js";
// A held press opens the menu with the same gesture length the platform uses for its own
// long press, and any movement past the slop means the user was scrolling the tab strip.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;


export function createDocumentTabsView({
  host = null,
  documentRef = globalThis.document,
  onSelect = () => {},
  onClose = () => {},
  onMenu = () => {},
  // Injectable timers so the held-press path is testable without waiting 500 ms of real time.
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (handle) => globalThis.clearTimeout(handle),
  longPressMs = LONG_PRESS_MS,
} = {}) {
  if (!host || typeof host.replaceChildren !== "function") return null;

  let tabs = [];
  let activeIndex = -1;
  // Keyboard navigation intent: the path the next committing render must focus. It is kept
  // until the activation settles, so a rejected open can put focus back where it was.
  let pendingFocusPath = null;
  // The in-flight held press (touch/pen) and the tab whose click a fired long press must
  // swallow. Both are view-local gesture state, never tab state.
  let press = null;
  let swallowClickPath = null;
  // The focus owner *before* the gesture that opens a menu. Chromium may move the focus to the
  // tab as part of the press itself (a right-click focuses the element it lands on, and a touch
  // press can too), so the element the menu must give the focus back to is captured at the
  // gesture start — never read again once the menu is open, which is when it is already too
  // late. `menu.js` hands it to the popup primitive as the close's focus origin.
  let pressOrigin = null;

  function rowFor(path) {
    for (const row of host.querySelectorAll(".document-tab")) {
      if (row.getAttribute("data-tab-path") === path) return row;
    }
    return null;
  }

  function entryFor(path, role) {
    const row = rowFor(path);
    if (!row) return null;
    return row.querySelector(role === "close" ? ".document-tab-close" : ".document-tab-main");
  }

  function activeMain() {
    const path = activeIndex >= 0 ? tabs[activeIndex]?.path ?? null : null;
    return path === null ? null : entryFor(path, "main");
  }

  // The focus owner inside the strip, as tab path + control, so a re-render restores the
  // same tab instead of whatever tab now sits at the old numeric index.
  function captureFocus() {
    const active = documentRef?.activeElement ?? null;
    if (!active || typeof active.closest !== "function") return null;
    const row = active.closest(".document-tab");
    if (!row || row.closest("#document-tabs") !== host) return null;
    const path = row.getAttribute("data-tab-path");
    if (!path) return null;
    return { path, role: active.closest(".document-tab-close") ? "close" : "main" };
  }

  function build(tab, index, active) {
    const wrapper = documentRef.createElement("div");
    wrapper.className = active ? "document-tab is-active" : "document-tab";
    wrapper.setAttribute("role", "presentation");
    wrapper.setAttribute("data-tab-path", tab.path);

    const main = documentRef.createElement("button");
    main.className = "document-tab-main";
    main.setAttribute("type", "button");
    main.setAttribute("role", "tab");
    main.setAttribute("aria-selected", String(active));
    main.setAttribute("tabindex", active ? "0" : "-1");
    main.setAttribute("data-tab-path", tab.path);
    main.setAttribute("data-tab-index", String(index));
    main.setAttribute("title", tab.path);

    const title = documentRef.createElement("span");
    title.className = "document-tab-title";
    title.textContent = tabTitle(tab.path);
    main.append(title);
    wrapper.append(main);

    const close = documentRef.createElement("button");
    close.className = "document-tab-close";
    close.setAttribute("type", "button");
    close.setAttribute("aria-label", `关闭 ${tabTitle(tab.path)}`);
    close.setAttribute("data-tab-close", String(index));
    close.setAttribute("tabindex", "-1");
    const icon = spriteIcon(documentRef, "x");
    if (icon) close.append(icon);
    wrapper.append(close);

    return wrapper;
  }

  function render(nextTabs = [], nextActiveIndex = -1) {
    const previousActivePath = activeIndex >= 0 ? tabs[activeIndex]?.path ?? null : null;
    const previousPositions = new Map(tabs.map((tab, index) => [tab.path, index]));
    const keep = captureFocus();
    tabs = nextTabs;
    activeIndex = nextActiveIndex;
    host.replaceChildren(...tabs.map((tab, index) => build(tab, index, index === activeIndex)));

    // 1. A keyboard navigation that has just committed: focus follows the activated tab.
    if (pendingFocusPath !== null && activeIndex >= 0 && tabs[activeIndex]?.path === pendingFocusPath) {
      const committed = pendingFocusPath;
      pendingFocusPath = null;
      (entryFor(committed, "main") ?? activeMain())?.focus?.();
      return;
    }
    // 2. Focus outside the strip (editor / reading pane) is never taken over.
    if (!keep) return;
    // 3. Still the same tab: keep the identical focus owner.
    const surviving = entryFor(keep.path, keep.role) ?? entryFor(keep.path, "main");
    if (surviving) {
      surviving.focus?.();
      return;
    }
    // 4. The focused tab is gone: closing the active tab hands focus to its successor; a
    //    removed background tab hands it to the tab that took its place.
    if (keep.path === previousActivePath) {
      activeMain()?.focus?.();
      return;
    }
    const fallback = tabs[Math.min(previousPositions.get(keep.path) ?? 0, tabs.length - 1)];
    if (fallback) entryFor(fallback.path, "main")?.focus?.();
  }

  // Roving focus across the tab list (ARIA tabs keyboard contract), activation on navigation.
  // Activation itself is the ordinary open flow, so Enter/Space need no special handling.
  function step(index, delta, last) {
    if (!tabs.length) return;
    const next = last !== undefined ? last : (index + delta + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (!tab) return;
    pendingFocusPath = tab.path;
    Promise.resolve(onSelect(tab.path)).then((committed) => {
      if (pendingFocusPath !== tab.path) return; // superseded by a later render / navigation
      pendingFocusPath = null;
      // A rejected activation leaves the committed document alone, so focus must not follow
      // the tab that was never opened.
      if (!committed) activeMain()?.focus?.();
    });
  }

  function onClick(event) {
    const target = event.target;
    const row = rowForNode(target);
    if (!row) return;
    const path = row.getAttribute("data-tab-path");
    // The click a held press turns into must not also act: the menu already opened for that tab
    // with the same gesture. That holds for the row's close control as much as for its main button
    // (a held press on `x` used to open the menu *and* close the tab), and it is one-shot, so the
    // next real click still acts.
    if (swallowClickPath !== null) {
      const swallowed = swallowClickPath;
      swallowClickPath = null;
      if (swallowed === path) {
        event.preventDefault?.();
        return;
      }
    }
    const close = target?.closest?.("[data-tab-close]");
    if (close) {
      onClose(Number(close.getAttribute("data-tab-close")));
      return;
    }
    if (!target?.closest?.(".document-tab-main")) return;
    onSelect(path);
  }

  // --- batch-close entry points (#429) --------------------------------------

  // The anchor of a pointer-opened menu is the pointer itself, so the menu appears where the
  // user pressed (and flips up near the bottom edge through ui/popup-position.js).
  function pointAnchor(event, row) {
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
    }
    return boxAnchor(row);
  }

  function boxAnchor(row) {
    if (typeof row?.getBoundingClientRect !== "function") return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    const box = row.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
  }

  function rowForNode(node) {
    const row = node?.closest?.(".document-tab") ?? null;
    if (!row || row.closest?.("#document-tabs") !== host) return null;
    return row;
  }

  function cancelPress() {
    if (!press) return;
    clearTimer(press.handle);
    press = null;
  }

  function onContextMenu(event) {
    const row = rowForNode(event.target);
    // The editor's own context menu is never intercepted.
    if (!row) return;
    event.preventDefault?.();
    cancelPress();
    const origin = pressOrigin;
    pressOrigin = null;
    onMenu(row.getAttribute("data-tab-path"), { anchor: pointAnchor(event, row), viaKeyboard: false, origin });
  }

  function onPointerDown(event) {
    const row = rowForNode(event.target);
    if (!row) return;
    // Before the press can move the focus onto the tab: see `pressOrigin`.
    pressOrigin = documentRef?.activeElement ?? null;
    // A new press on the strip is a new gesture: a swallow the browser never turned into a click
    // (a platform whose long press emits `contextmenu` and no trailing click) must not be waiting
    // for *this* gesture's click.
    swallowClickPath = null;
    // Desktop pointers have a real right button and use `contextmenu`; only a touch or pen
    // press needs the held-press gesture (a touch-only device has no right-click at all).
    if (event?.pointerType === "mouse") return;
    if (event?.button !== undefined && event.button !== 0) return;
    cancelPress();
    const path = row.getAttribute("data-tab-path");
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    const handle = setTimer(() => {
      press = null;
      swallowClickPath = path;
      const origin = pressOrigin;
      pressOrigin = null;
      onMenu(path, { anchor: boxAnchor(row), viaKeyboard: false, fromLongPress: true, origin });
    }, longPressMs);
    press = { path, handle, x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
  }

  function onPointerMove(event) {
    if (!press) return;
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Math.abs(x - press.x) > LONG_PRESS_SLOP || Math.abs(y - press.y) > LONG_PRESS_SLOP) cancelPress();
  }

  function onKeyDown(event) {
    const target = event.target;
    const row = target?.closest?.(".document-tab");
    if (!row || row.closest?.("#document-tabs") !== host) return;
    // The menu is reachable from the keyboard: Shift+F10 and the dedicated ContextMenu key
    // behave exactly like a right click on the focused tab.
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault?.();
      const origin = documentRef?.activeElement ?? null;
      onMenu(row.getAttribute("data-tab-path"), { anchor: boxAnchor(row), viaKeyboard: true, origin });
      return;
    }
    // Keyboard close path: `Delete` belongs to the strip only while focus is inside the
    // tablist, so a Delete in the editor keeps its editor meaning.
    if (event.key === "Delete") {
      const path = row.getAttribute("data-tab-path");
      const index = tabs.findIndex((tab) => tab.path === path);
      if (index < 0) return;
      event.preventDefault();
      onClose(index);
      return;
    }
    const main = target.closest?.(".document-tab-main");
    if (!main) return;
    const index = Number(main.getAttribute("data-tab-index"));
    if (event.key === "ArrowLeft") step(index, -1);
    else if (event.key === "ArrowRight") step(index, 1);
    else if (event.key === "Home") step(index, 0, 0);
    else if (event.key === "End") step(index, 0, tabs.length - 1);
    else return;
    event.preventDefault();
  }

  host.addEventListener("click", onClick);
  host.addEventListener("keydown", onKeyDown);
  host.addEventListener("contextmenu", onContextMenu);
  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", cancelPress);
  host.addEventListener("pointercancel", cancelPress);

  return {
    render,
    destroy() {
      cancelPress();
      swallowClickPath = null;
      pressOrigin = null;
      host.removeEventListener("click", onClick);
      host.removeEventListener("keydown", onKeyDown);
      host.removeEventListener("contextmenu", onContextMenu);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", cancelPress);
      host.removeEventListener("pointercancel", cancelPress);
    },
  };
}
