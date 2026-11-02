// Shared popup/menu interaction primitive (issue #407, audit Cut B).
//
// The shell grew five separate copies of the same open/close machinery — the document `⋮`
// menu, the reading-view menu, the two note-context section `⋮` menus and the Tags sort
// menu — and each copy owned its own `hidden`/`aria-expanded` writes, its own outside
// dismiss and its own Escape path. The state machines drifted apart: two topbar menus could
// be open at the same time, none of them had arrow-key navigation, and the focus policy was
// whatever the last author happened to write.
//
// This module is the single owner of that contract. A controller pairs exactly one trigger
// with one popup and is the **only** writer of `popup.hidden` and `trigger[aria-expanded]`;
// a consumer only reacts to its own menu items (and calls `close()` when one is picked).
//
// Ownership rules:
//   * the controller owns the trigger's `click` listener — a consumer must not bind one,
//     and must not write `aria-expanded` / `hidden` itself;
//   * a `pointerdown` outside the trigger and the popup closes it, and the browser's own
//     focus handling for the click target is left alone;
//   * Escape closes it (capture phase, so the shell-wide Escape owner in
//     `features/navigation/keyboard-shortcuts.js` cannot close it first and swallow the
//     focus return) and hands focus back per the matrix below;
//   * inside the popup, ArrowUp/ArrowDown cycle through the enabled items, Home/End jump to
//     the first/last one.
//
// Two consumers are *positional* rather than disclosure menus: `features/tabs/menu.js` opens a
// context menu on a tab the user right-clicked, long-pressed or reached with Shift+F10. Such a
// consumer passes `attachTrigger: false` (the anchor is a `role="tab"` button — not a
// disclosure trigger, so the controller must not own its `click` and must not write
// `aria-expanded` on it; the anchor keeps changing, which is why that consumer creates one
// controller per open) and `dismissOnViewportChange: true` (a scroll or a resize moves the
// anchor away from a popup placed in viewport coordinates, so the menu leaves with it).
//
// Focus matrix (what `restoreFocus` and the opening modality decide):
//
//   opened by | closed by        | resulting focus
//   ----------|------------------|--------------------------------------------------
//   pointer   | Escape           | the trigger when `restoreFocus`, otherwise unchanged
//   pointer   | trigger again    | the trigger (it was just clicked)
//   pointer   | outside click    | the click target, never the trigger
//   pointer   | picking an item  | the trigger when `restoreFocus`, otherwise unchanged
//   keyboard  | Escape           | the trigger, always (the menu owned the focus)
//   keyboard  | picking an item  | the trigger when `restoreFocus`, otherwise unchanged
//
// `restoreFocusTarget: "origin"` keeps that matrix but moves the focus back to the element that
// owned it when the popup opened instead of to the trigger. A context menu opened by a pointer
// needs that: right-clicking a tab must not take the editor's focus away (the triggers-with-
// "trigger" default is the disclosure menus' rule, where the trigger *is* the natural landing
// spot). A keyboard open captures the trigger itself as the origin, so nothing changes there.
//
// A re-render can detach that origin (or a positional menu's anchor) while the popup is open —
// the tab strip rebuilds every row on each model change, and a history navigation rebuilds it
// under an open context menu. Connectivity alone is not enough to hand the focus back to it
// afterwards: a node the shell swapped away stays connected while its ancestors are `[hidden]` and
// it has no layout at all (a Base surface covering the note is exactly that case), and `focus()`
// on such a node is a silent no-op that leaves `document.activeElement` on `body`. The focus
// return therefore only accepts a candidate it can *really* focus (`canTakeFocus`), falls back to
// the trigger when it cannot, and names the document body as its terminal when not even the
// trigger can take the focus; `retarget()` is how a consumer that re-renders its own anchor
// element keeps that fallback pointing at the live node.
//
// Scope: an arbitrary string label. At most one popup per scope is open — opening a second
// one closes the first passively (no focus movement) — while different scopes never interact.
// The topbar uses "topbar" (the document `⋮` and the reading-view menu are mutually
// exclusive), the note-context rail uses "context-sidebar", and the Explorer keeps its own
// inline implementation for now (follow-up `#407-explorer`).
//
// Menu items are `button` elements carrying `role="menuitem"`, `menuitemradio` or
// `menuitemcheckbox`; disabled ones are skipped by the keyboard navigation.

const DEFAULT_SCOPE = "global";
const ITEM_ROLES = new Set(["menuitem", "menuitemradio", "menuitemcheckbox"]);

// scope -> Set<controller>. Module-level on purpose: scope is a property of the shell, not
// of one consumer, and the registry is emptied again by `destroy()`.
const scopeRegistry = new Map();

function registerController(scope, controller) {
  const key = String(scope ?? DEFAULT_SCOPE);
  let members = scopeRegistry.get(key);
  if (!members) {
    members = new Set();
    scopeRegistry.set(key, members);
  }
  members.add(controller);
  return key;
}

function unregisterController(key, controller) {
  const members = scopeRegistry.get(key);
  if (!members) return;
  members.delete(controller);
  if (members.size === 0) scopeRegistry.delete(key);
}

// Closing a sibling popup is passive: the user asked for a different menu, not for a focus
// jump, so the sibling closes without moving focus.
function closeSiblingsInScope(key, self) {
  for (const sibling of scopeRegistry.get(key) ?? []) {
    if (sibling !== self && sibling.isOpen()) sibling.close({ returnFocus: false });
  }
}

// `Element.contains` is not implemented by every host (the Node DOM harness used by the
// tests has none), so the portable ancestor-or-self walk is the only form used here.
function isInsideOrSelf(host, node) {
  for (let current = node; current; current = current.parentNode) {
    if (current === host) return true;
  }
  return false;
}

// Best-effort connectivity of an element: the platform's own flag where the host implements it,
// otherwise the document's roots (the minimal DOM harness some tests use has no `isConnected`).
// `undefined`/`null` is never connected, so a focus return can fall through to its fallback.
function isConnected(element, documentRef) {
  if (!element) return false;
  if (typeof element.isConnected === "boolean") return element.isConnected;
  for (const root of [documentRef?.documentElement, documentRef?.head, documentRef?.body]) {
    if (root && isInsideOrSelf(root, element)) return true;
  }
  return false;
}

// A `[hidden]` ancestor (or the element itself) is not focusable, and neither is an `inert` or a
// disabled one. `ui/select.js` needs the same distinction for the same reason: the shell hides
// the surface it swapped away instead of unmounting it, so a node can stay connected and still be
// out of reach ("the Base host is hidden, not unmounted, when the user navigates back to a note").
function isHidden(node) {
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeType === 9) continue; // `document.hidden` means "background tab", not "unfocusable"
    if (current.hidden === true) return true;
    if (typeof current.getAttribute === "function" && current.getAttribute("hidden") !== null) return true;
    if (current.inert === true) return true;
    if (typeof current.getAttribute === "function" && current.getAttribute("inert") !== null) return true;
  }
  return false;
}

/**
 * Whether a focus return may land on this element. Connectivity is only the first test: a
 * candidate the user cannot use must fall through to the fallback instead of swallowing the
 * focus (a silent no-op `focus()` call leaves `document.activeElement` on `body`).
 *
 * Layout is the platform's own answer to "can this be focused and seen" and is asked only where
 * the host really lays out — the minimal DOM harness has no `getClientRects`/`getComputedStyle`,
 * where the structural checks above are the portable half of the rule.
 */
function canTakeFocus(element, documentRef) {
  if (!isConnected(element, documentRef)) return false;
  if (typeof element.focus !== "function") return false;
  if (element.disabled === true) return false;
  if (isHidden(element)) return false;
  const rects = typeof element.getClientRects === "function" ? element.getClientRects() : null;
  if (rects && rects.length === 0) return false;
  const style = documentRef?.defaultView?.getComputedStyle?.(element) ?? null;
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  return true;
}

function enabledMenuItems(popup) {
  const items = [...(popup?.querySelectorAll?.("button") ?? [])];
  return items.filter((item) => {
    if (!ITEM_ROLES.has(item.getAttribute?.("role"))) return false;
    return item.disabled !== true && item.getAttribute("aria-disabled") !== "true";
  });
}

// A keyboard activation synthesizes `click` with `detail === 0` (Enter/Space on a button).
// A pointer click carries a positive count, and a synthetic event without `detail` is
// treated as a pointer click: never moving focus is the safer default of the two.
function isKeyboardActivation(event) {
  return Number.isFinite(event?.detail) && event.detail === 0;
}

/**
 * Create the controller for one trigger → popup pair.
 *
 * @param {Object} options
 * @param {HTMLElement} options.trigger Trigger button; it must already carry
 *   `aria-haspopup` and `aria-expanded` (the controller keeps `aria-expanded` in sync).
 *   With `attachTrigger: false` it is only the anchor: the focus-return target, the element a
 *   pointer must be inside to *keep* the popup open, and no `aria-expanded` writer target.
 * @param {HTMLElement} options.popup Popup panel (`role="menu"`); it starts closed and the
 *   controller is its only `hidden` writer.
 * @param {string} [options.scope="global"] Interaction scope; one open popup per scope.
 * @param {boolean} [options.attachTrigger=true] Whether the controller owns the trigger's
 *   `click` and keeps `aria-expanded` in sync. A positional menu (right-click / long press)
 *   passes `false` and calls `open()`/`close()` itself.
 * @param {boolean} [options.dismissOnViewportChange=false] Close on a document `scroll`
 *   (capture, so a nested scroller counts) or a window `resize` — for a popup that is positioned
 *   from a viewport coordinate and would otherwise stay behind while its anchor moves.
 * @param {boolean} [options.restoreFocus=true] Whether a close that the popup itself
 *   caused (Escape, picking an item, the trigger being clicked again) returns focus to the
 *   trigger.
 * @param {"trigger"|"origin"} [options.restoreFocusTarget="trigger"] Where that focus goes:
 *   the trigger itself, or the element that owned the focus when the popup opened (see the
 *   matrix above — a pointer-opened context menu gives the editor its focus back).
 * @param {Function} [options.onOpen] Called after the popup became visible.
 * @param {Function} [options.onClose] Called after the popup was hidden.
 * @param {Document} [options.documentRef=globalThis.document] Document that owns the
 *   outside-dismiss and keyboard listeners (injectable for headless tests).
 * @param {Object} [options.windowRef=null] Window that owns the `resize` listener for
 *   `dismissOnViewportChange`; defaults to `documentRef.defaultView` (a `resize` is dispatched
 *   at the window, never at the document) and falls back to `globalThis`.
 * @returns {{open: Function, close: Function, toggle: Function, retarget: Function, isOpen: Function, destroy: Function}}
 *   `open({ viaKeyboard })`, `close({ returnFocus })`, `toggle(...)`, `retarget({ trigger })`,
 *   `isOpen()`, `destroy()`.
 *   With `restoreFocusTarget: "origin"` the open also accepts `open({ origin })`: the element a
 *   close must focus, for a caller that captured it before a gesture moved the focus itself (a
 *   right-click focuses the element it lands on).
 *
 * @example
 * const documentActions = createPopupMenuController({
 *   trigger: document.querySelector("#document-actions-toggle"),
 *   popup: document.querySelector("#document-actions-menu"),
 *   scope: "topbar",
 *   restoreFocus: true,
 * });
 * // later, on teardown
 * documentActions.destroy();
 */
export function createPopupMenuController({
  trigger: initialTrigger,
  popup,
  scope = DEFAULT_SCOPE,
  restoreFocus = true,
  restoreFocusTarget = "trigger",
  attachTrigger = true,
  dismissOnViewportChange = false,
  onOpen = null,
  onClose = null,
  documentRef = globalThis.document,
  windowRef = null,
} = {}) {
  if (!initialTrigger || !popup) throw new TypeError("createPopupMenuController needs a trigger and a popup element");
  // `resize` is dispatched at the *window*, not at the document, so the viewport-change path
  // above needs the window object; `scroll` travels through the document (capture) because it is
  // dispatched at whichever element scrolled.
  const resizeTarget = windowRef ?? documentRef?.defaultView ?? globalThis;

  // The element this controller is currently paired with. `retarget()` replaces it when the
  // consumer re-renders the anchor under an open popup (a positional menu cannot avoid that).
  let trigger = initialTrigger;
  let open = false;
  let destroyed = false;
  let openedViaKeyboard = false;
  let originFocus = null;

  // Keyboard open lands on the checked item when the menu is a radio group (the reading-view
  // and Tags sort menus are), otherwise on the first enabled item.
  function focusInitialItem() {
    const items = enabledMenuItems(popup);
    const target = items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0] ?? null;
    target?.focus?.();
  }

  function open_(options = {}) {
    const { viaKeyboard = false, origin } = options;
    if (destroyed) return false;
    if (open) return true;
    closeSiblingsInScope(scopeKey, controller);
    open = true;
    openedViaKeyboard = Boolean(viaKeyboard);
    // The caller's captured origin wins when it has one (a pointer gesture knows the focus owner
    // from before the press); otherwise the focus owner of this moment is the origin.
    originFocus = restoreFocusTarget === "origin" ? origin ?? documentRef?.activeElement ?? null : null;
    popup.hidden = false;
    if (attachTrigger) trigger.setAttribute("aria-expanded", "true");
    if (viaKeyboard) focusInitialItem();
    documentRef?.addEventListener?.("pointerdown", onPointerDown, true);
    documentRef?.addEventListener?.("keydown", onKeyDown, true);
    if (dismissOnViewportChange) {
      documentRef?.addEventListener?.("scroll", onViewportChange, true);
      resizeTarget?.addEventListener?.("resize", onViewportChange);
    }
    onOpen?.();
    return true;
  }

  function close_(options = {}) {
    const { returnFocus = restoreFocus } = options;
    // Already closed: a no-op, so a redundant close (the shell's Escape owner calls our
    // consumers' `closeMenu`) can never yank focus back to the trigger.
    if (destroyed || !open) return false;
    open = false;
    popup.hidden = true;
    if (attachTrigger) trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) {
      // A repaint under an open menu detaches the element the focus came from (a positional
      // menu's anchor lives in a list its consumer re-renders), and a navigation can hide it
      // while it stays connected. Focusing a detached or hidden node would silently leave the
      // focus on `body`, so neither candidate is trusted on connectivity alone: the origin must
      // still be focusable, otherwise the trigger — kept live by `retarget()` — takes the focus.
      // When neither is usable (the strip the menu belonged to is gone), the document body is the
      // explicit terminal here instead of a `focus()` call on a node that can no longer take it.
      const originCandidate = restoreFocusTarget === "origin" ? originFocus : null;
      const target = canTakeFocus(originCandidate, documentRef) ? originCandidate
        : canTakeFocus(trigger, documentRef) ? trigger
        : documentRef?.body ?? null;
      target?.focus?.();
    }
    originFocus = null;
    documentRef?.removeEventListener?.("pointerdown", onPointerDown, true);
    documentRef?.removeEventListener?.("keydown", onKeyDown, true);
    // Only ever removed when they were installed: the primitive's own contract is that a
    // controller releases exactly the listeners it took (no stray removals either).
    if (dismissOnViewportChange) {
      documentRef?.removeEventListener?.("scroll", onViewportChange, true);
      resizeTarget?.removeEventListener?.("resize", onViewportChange);
    }
    openedViaKeyboard = false;
    onClose?.();
    return true;
  }

  function toggle(options = {}) {
    return open ? close_() : open_(options);
  }

  /**
   * Replace the element this controller treats as its anchor. A positional menu (right-click /
   * long press / Shift+F10 on a strip row) is opened against an element the consumer replaces as
   * soon as it re-renders — the strip rebuilds every row per model change — and the element
   * captured at `open()` is detached from then on. The outside-press test, the `restoreFocusTarget:
   * "trigger"` target and the focus fallback above must therefore follow the live node; only the
   * trigger is replaceable, never the popup.
   *
   * @param {Object} options
   * @param {HTMLElement} options.trigger The element that replaces the current anchor.
   */
  function retarget({ trigger: nextTrigger } = {}) {
    if (nextTrigger) trigger = nextTrigger;
    return controller;
  }

  function onTriggerClick(event) {
    if (open) close_();
    else open_({ viaKeyboard: isKeyboardActivation(event) });
  }

  function onPointerDown(event) {
    const target = event?.target ?? null;
    if (isInsideOrSelf(popup, target) || isInsideOrSelf(trigger, target)) return;
    // Passive close: the pointer's own target keeps the focus the browser gives it.
    close_({ returnFocus: false });
  }

  // A popup placed in viewport coordinates (a context menu) is out of date as soon as the page
  // scrolls or the window resizes, so it closes itself instead of floating over a moved anchor.
  function onViewportChange() {
    close_({ returnFocus: false });
  }

  function onKeyDown(event) {
    const key = event?.key;
    if (key === "Escape") {
      event.preventDefault?.();
      close_({ returnFocus: restoreFocus || openedViaKeyboard });
      return;
    }
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    const items = enabledMenuItems(popup);
    if (items.length === 0) return;
    event.preventDefault?.();
    if (key === "Home") {
      items[0].focus?.();
      return;
    }
    if (key === "End") {
      items[items.length - 1].focus?.();
      return;
    }
    const step = key === "ArrowDown" ? 1 : -1;
    const current = items.indexOf(documentRef?.activeElement);
    const next = current < 0
      ? (step > 0 ? 0 : items.length - 1)
      : (current + step + items.length) % items.length;
    items[next].focus?.();
  }

  function destroy() {
    if (destroyed) return;
    close_({ returnFocus: false });
    destroyed = true;
    if (attachTrigger) trigger.removeEventListener?.("click", onTriggerClick);
    unregisterController(scopeKey, controller);
  }

  // The controller is the only click owner of the trigger and starts closed, so an open
  // popup can never outlive a re-init of the module that created it.
  popup.hidden = true;
  if (attachTrigger) {
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener?.("click", onTriggerClick);
  }
  const controller = { open: open_, close: close_, toggle, retarget, isOpen: () => open, destroy };
  const scopeKey = registerController(scope, controller);

  return controller;
}
