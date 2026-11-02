// Custom `<select>` → ARIA listbox interaction contract (issue #409, audit §4).
//
// The enhancement used to be a visual-only shell. The trigger announced
// `aria-haspopup="listbox"`, the menu announced `role="listbox"` and every option announced
// `role="option"`, while the only keyboard it understood was "open": opening never moved the
// focus anywhere, the menu had no Arrow traversal, no Home/End and no active-item strategy at
// all. The announced listbox was therefore a lie for every keyboard user, and the native
// `<select>` — the one element that would have provided the model for free — was parked
// behind `aria-hidden` + `tabindex="-1"`. This module is now the single owner of that
// interaction. The seat ruling keeps it a **second control contract beside
// `ui/popup-menu.js`**: a listbox is not a menu and is never pushed through that primitive.
//
// API
//
//   enhanceSelects(root = document) -> { destroy() }
//
//     Enhances every `select[data-select]` under `root` that is not wrapped yet, and returns
//     one handle for that call. `destroy()` releases every listener and observer the call
//     installed and is idempotent; it never un-wraps the markup — the caller owns the subtree
//     (the Base surface re-renders and re-enhances a fresh one on every mount).
//
// Ownership rules:
//   * the native `<select>` stays the canonical value source and the only `change` emitter.
//     This module writes `select.value`, dispatches a bubbling `change` and re-renders itself
//     from `select.options`; it never reads the rendered popup back, so every existing
//     controller (`features/vault/controller.js`, `features/bases/toolbar.js`) is unchanged;
//   * the trigger owns `click` and the closed-state keys. While the listbox is open the
//     **document** owns the keys (capture phase, so the Base toolbar's Escape path and the
//     shell-wide Escape owner in `features/navigation/keyboard-shortcuts.js` cannot close an
//     outer layer for the same keystroke and swallow the focus return);
//   * the listbox owns the focus while it is open and hands it back to the trigger on
//     Escape and on selection. A pointer open never moves the focus.
//
// Focus strategy — **roving focus**, not `aria-activedescendant`:
//
//   the active option carries `tabindex="0"`, every other option `tabindex="-1"`, and the
//   active option is the DOM-focused element. Both models are valid listbox models; roving
//   was chosen because (a) the option paint in `src/app/assets/app.css` is already driven by
//   `.select-option:hover, .select-option:focus-visible, …`, while an activedescendant model
//   would need a new "active" style hook in the same stylesheet, and (b) the options are real
//   `<button>`s, so a focused option keeps the browser's own focus ring, scroll-into-view and
//   screen-reader announcement without any extra wiring.
//
// Keyboard binding:
//
//   closed trigger | ArrowDown / ArrowUp / Enter / Space | open on the selected option,
//                  |                                    | or the first enabled one
//   open           | ArrowDown / ArrowUp                | move the active option, wrapping,
//                  |                                    | skipping disabled options
//                  | Home / End                         | first / last enabled option
//                  | Enter / Space                      | commit the active option
//                  |                                    | (`value` + `change` + close)
//                  | Escape                             | close, focus the trigger, consume
//                  |                                    | the key (innermost layer owns it)
//                  | Tab                                | close, let the focus move on
//
//   Installation is lazy: the document/view listener pair exists only while a listbox is
//   open, so a re-mounted subtree cannot accumulate listeners (the old implementation added
//   three permanent document/window listeners per select per mount).
//
// Lifecycle (issue #409 review):
//
//   * a consumer can replace the whole subtree from inside its **synchronous** `change`
//     handler (`features/bases/view.js` does), so the closing control focuses its trigger only
//     while that node is live and otherwise hands the focus to the replacement control through
//     the slot key the consumer declared (`data-focus`, mirrored onto the trigger/options). The
//     handoff is armed before the dispatch and claimed by the fresh control — no timer decides
//     the focus;
//   * a control whose surface went away without a notification must stop owning the document
//     keys: a detached or `[hidden]` ancestor releases the listener on the first
//     key/click/scroll and lets the keystroke through (the Base host stays in the DOM, hidden,
//     while a note is shown again).
//
// Explicit non-goals of this cut (audit ruling): typeahead, `aria-multiselectable`, the
// combobox shape, and hover moving the active option (a pointer commits the option it
// presses; hovering never steals the keyboard's active item).

const OPTION_CLASS = "select-option";
const OPEN_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", " "]);

// Unique trigger/menu ids for `aria-labelledby`; module-level on purpose, the counter only
// has to be unique within one document.
let selectSequence = 0;

// `Element.contains` is not implemented by every host (the Node DOM harness used by the tests
// has none), so the portable ancestor-or-self walk is the only form used here.
function isInsideOrSelf(host, node) {
  for (let current = node; current; current = current.parentNode) {
    if (current === host) return true;
  }
  return false;
}

// A keyboard activation synthesizes `click` with `detail === 0` (Enter/Space on a button).
// A pointer click carries a positive count, and a synthetic event without `detail` is treated
// as a pointer click: never swallowing a real press is the safer default of the two.
function isKeyboardActivation(event) {
  return Number.isFinite(event?.detail) && event.detail === 0;
}

// A commit can make the consumer throw the whole subtree away from inside its `change`
// handler. The committing control arms this slot key before the dispatch and the replacement
// claims it while the old trigger is detached; an unclaimed key is dropped in a microtask so
// it cannot steal the focus on a later, unrelated re-render.
let pendingFocusKey = null;

// `isConnected` is authoritative, but the Node DOM harness the tests run on has none: there
// the topmost recorded ancestor is the only "still in the same tree" signal available.
function topRoot(node) {
  let current = node;
  while (current?.parentNode) current = current.parentNode;
  return current;
}

function isAttached(node, root) {
  if (typeof node?.isConnected === "boolean") return node.isConnected;
  for (let current = node; current; current = current.parentNode) {
    if (current === root) return true;
    if (!current.parentNode) return false;
  }
  return false;
}

// The other half of "the surface is gone": `[hidden]` ancestors (the Base host is hidden,
// not unmounted, when the user navigates back to a note).
function isHidden(node) {
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeType === 9) continue; // `document.hidden` means "background tab"
    if (current.hidden === true) return true;
    if (typeof current.getAttribute === "function" && current.getAttribute("hidden") !== null) return true;
  }
  return false;
}

function isUsable(node, root) {
  return Boolean(node) && isAttached(node, root) && !isHidden(node);
}

/**
 * Turn every `select[data-select]` under `root` into the themed ARIA listbox control.
 *
 * @param {Document|HTMLElement} [root=globalThis.document] Subtree to enhance; the app shell
 *   enhances the whole document once, the Base surface re-enhances each freshly mounted
 *   subtree. A select already wrapped by `.select-control` is skipped.
 * @returns {{destroy: Function}} One handle for this call. `destroy()` closes any open
 *   listbox, removes every listener/observer the call installed and is idempotent.
 *
 * @example
 * const selects = enhanceSelects(baseHost);
 * // later, when the host subtree is thrown away
 * selects.destroy();
 */
export function enhanceSelects(root = document) {
  const controls = [];
  for (const select of root.querySelectorAll("select[data-select]")) {
    // `parentNode` rather than `parentElement`: the Node DOM harness used by the tests
    // implements the former only, and the guard has to hold in both hosts.
    if (select.parentNode?.classList?.contains("select-control")) continue;
    controls.push(createSelectControl(select));
  }
  return {
    destroy() {
      for (const control of controls.splice(0)) control.destroy();
    },
  };
}

function createSelectControl(select) {
  const doc = select.ownerDocument || globalThis.document;
  const view = doc?.defaultView || globalThis.window || globalThis;
  const uid = `select-control-${(selectSequence += 1)}`;

  const wrapper = doc.createElement("span");
  wrapper.className = "select-control";
  select.before(wrapper);
  wrapper.append(select);

  // The consumer may declare a stable focus slot for the control it builds (`data-focus`, the
  // convention in `features/bases/toolbar.js`). The module moves the key onto the nodes that
  // really take the focus, so a re-render can resolve the live replacement and the hidden
  // native select never becomes a focus target.
  const focusKey = select.getAttribute("data-focus") || null;
  const home = topRoot(wrapper); // topmost ancestor, captured while it is still attached

  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.id = `${uid}-trigger`;
  trigger.className = "select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", select.getAttribute("aria-label") || select.getAttribute("title") || "选择");
  if (focusKey) {
    trigger.setAttribute("data-focus", focusKey);
    if (typeof select.removeAttribute === "function") select.removeAttribute("data-focus");
  }

  const menu = doc.createElement("div");
  menu.className = "select-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-labelledby", trigger.id);
  menu.hidden = true;

  const chevron = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("aria-hidden", "true");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.innerHTML = '<path d="m7 10 5 5 5-5"/>';
  trigger.append(doc.createElement("span"), chevron);
  wrapper.append(trigger, menu);

  // The native select remains the canonical value source for existing controllers, but is
  // removed from the visual and keyboard surface so the popup is themed.
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  select.classList.add("select-native");

  let open = false;
  let destroyed = false;
  let activeIndex = -1;

  // --- option model ---------------------------------------------------------

  function optionItems() {
    return [...menu.querySelectorAll(`.${OPTION_CLASS}`)];
  }

  function enabledIndexes() {
    const indexes = [];
    [...select.options].forEach((option, index) => {
      if (option.disabled !== true) indexes.push(index);
    });
    return indexes;
  }

  // `select.value` is the authoritative source (this module writes it on commit); the
  // `selected` flag is only the fallback, because a host that does not re-select the option
  // when `value` is assigned would otherwise report a stale selection.
  function selectedOptionIndex() {
    const options = [...select.options];
    const byValue = options.findIndex((option) => option.value === select.value);
    if (byValue >= 0) return byValue;
    return options.findIndex((option) => option.selected === true);
  }

  // Where a keyboard open lands: the selected option, otherwise the first enabled one.
  function preferredIndex() {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return -1;
    const selected = selectedOptionIndex();
    return enabled.includes(selected) ? selected : enabled[0];
  }

  function setActive(index, { focus = false } = {}) {
    const items = optionItems();
    const enabled = enabledIndexes();
    activeIndex = enabled.includes(index) ? index : (enabled[0] ?? -1);
    items.forEach((item, position) => { item.tabIndex = position === activeIndex ? 0 : -1; });
    if (focus && activeIndex >= 0) items[activeIndex]?.focus?.();
  }

  // Re-apply the roving tabindex after the options were rebuilt; `focus` restores the DOM
  // focus the rebuild dropped (a removed node takes the focus with it).
  function syncActive({ focus = false } = {}) {
    if (!enabledIndexes().includes(activeIndex)) activeIndex = preferredIndex();
    setActive(activeIndex, { focus });
  }

  function scrollActiveIntoView() {
    optionItems()[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }

  function moveActive(key) {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    if (key === "Home") {
      setActive(enabled[0], { focus: true });
      return;
    }
    if (key === "End") {
      setActive(enabled[enabled.length - 1], { focus: true });
      return;
    }
    const step = key === "ArrowDown" ? 1 : -1;
    const position = enabled.indexOf(activeIndex);
    const next = position < 0
      ? (step > 0 ? 0 : enabled.length - 1)
      : (position + step + enabled.length) % enabled.length;
    setActive(enabled[next], { focus: true });
  }

  function commit(index) {
    const option = select.options[index];
    if (!option || option.disabled === true) return false;
    activeIndex = index;
    select.value = option.value;
    // Arm the handoff *before* the dispatch: a consumer that re-renders from its `change`
    // handler builds the replacement control synchronously, and that control claims the key
    // while this one is being detached.
    pendingFocusKey = focusKey;
    if (focusKey !== null && typeof queueMicrotask === "function") {
      queueMicrotask(() => { if (pendingFocusKey === focusKey) pendingFocusKey = null; });
    }
    select.dispatchEvent(new Event("change", { bubbles: true }));
    render();
    closeMenu();
    return true;
  }

  function render() {
    if (destroyed) return;
    const hadFocus = open && isInsideOrSelf(menu, doc.activeElement);
    const current = select.options[selectedOptionIndex()];
    trigger.firstElementChild.textContent = current?.textContent || "请选择";
    menu.replaceChildren();
    [...select.options].forEach((option, index) => {
      const item = doc.createElement("button");
      item.type = "button";
      item.className = OPTION_CLASS;
      item.setAttribute("role", "option");
      item.dataset.value = option.value;
      item.textContent = option.textContent;
      if (focusKey) item.setAttribute("data-focus", focusKey);
      item.setAttribute("aria-selected", String(option.value === select.value));
      item.disabled = option.disabled;
      item.tabIndex = -1;
      item.addEventListener("click", (event) => {
        if (option.disabled) return;
        // A host that still delivers the synthesized activation click after the keydown
        // path already committed the option must not commit it a second time.
        if (isKeyboardActivation(event) && !open) return;
        commit(index);
      });
      menu.append(item);
    });
    if (open) syncActive({ focus: hadFocus });
  }

  // --- open / close ---------------------------------------------------------

  const positionMenu = () => {
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const viewportPadding = 8;
    const availableBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
    const availableAbove = rect.top - gap - viewportPadding;
    const openUp = availableBelow < 180 && availableAbove > availableBelow;
    const available = Math.max(96, Math.min(280, openUp ? availableAbove : availableBelow));
    menu.classList.toggle("is-flipped", openUp);
    menu.style.top = `${Math.round(openUp ? rect.top - gap : rect.bottom + gap)}px`;
    menu.style.left = `${Math.round(rect.left)}px`;
    menu.style.width = `${Math.round(rect.width)}px`;
    menu.style.maxHeight = `${Math.round(available)}px`;
    menu.style.transform = openUp ? "translateY(-100%)" : "none";
  };

  function openMenu({ viaKeyboard = false } = {}) {
    if (destroyed || open || !isUsable(trigger, home)) return false;
    open = true;
    render();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    wrapper.classList.add("is-open");
    positionMenu();
    setActive(preferredIndex(), { focus: viaKeyboard });
    scrollActiveIntoView();
    // Lazy by construction: nothing is installed while the listbox is closed, so a subtree
    // that is re-mounted between renders cannot leak listeners into the shell.
    doc.addEventListener("keydown", onDocumentKeyDown, true);
    doc.addEventListener("click", onDocumentClick);
    view.addEventListener("resize", onViewportChange, { passive: true });
    view.addEventListener("scroll", onViewportChange, { passive: true, capture: true });
    return true;
  }

  function closeMenu({ returnFocus = true } = {}) {
    if (!open) return false;
    open = false;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    wrapper.classList.remove("is-open");
    menu.classList.remove("is-flipped");
    menu.style.removeProperty("top");
    menu.style.removeProperty("left");
    menu.style.removeProperty("width");
    menu.style.removeProperty("max-height");
    menu.style.removeProperty("transform");
    for (const item of optionItems()) item.tabIndex = -1;
    doc.removeEventListener("keydown", onDocumentKeyDown, true);
    doc.removeEventListener("click", onDocumentClick);
    view.removeEventListener("resize", onViewportChange);
    view.removeEventListener("scroll", onViewportChange, true);
    if (returnFocus) returnFocusToTrigger();
    return true;
  }

  // Focus return for a closing control. Never focus a detached node, and resolve a live
  // replacement through the declared slot key when the consumer already re-rendered one.
  function returnFocusToTrigger() {
    if (isUsable(trigger, home)) {
      trigger.focus?.();
      return;
    }
    if (focusKey === null) return;
    const replacement = typeof doc?.querySelector === "function" ? doc.querySelector(`[data-focus="${focusKey}"]`) : null;
    if (replacement && replacement !== trigger && !isHidden(replacement) && typeof replacement.focus === "function") replacement.focus();
  }

  // --- listeners ------------------------------------------------------------

  function onTriggerClick(event) {
    if (destroyed) return;
    if (!open) {
      openMenu({ viaKeyboard: false });
      return;
    }
    // A host that still delivers the synthesized activation click after the keydown path
    // already opened the listbox must not immediately toggle it shut again.
    if (isKeyboardActivation(event)) return;
    closeMenu();
  }

  function onTriggerKeyDown(event) {
    if (destroyed || open) return;
    if (!OPEN_KEYS.has(event?.key)) return;
    event.preventDefault?.();
    openMenu({ viaKeyboard: true });
  }

  // Self-defence for a surface that went away without telling the control (the Base host stays
  // in the DOM, hidden, when the user navigates back to a note). The first event releases the
  // listener instead of eating the keystroke.
  function releaseIfGone() {
    if (isUsable(trigger, home)) return false;
    closeMenu({ returnFocus: false });
    return true;
  }

  function onDocumentClick(event) {
    if (destroyed || !open || releaseIfGone()) return;
    if (isInsideOrSelf(wrapper, event?.target ?? null)) return;
    closeMenu({ returnFocus: false });
  }

  function onViewportChange() {
    if (destroyed || releaseIfGone()) return;
    if (open) positionMenu();
  }

  function onDocumentKeyDown(event) {
    if (destroyed || !open || releaseIfGone()) return;
    const key = event?.key;
    if (key === "Tab") {
      // Tab leaves the control: close, but never steal the browser's own focus move.
      closeMenu({ returnFocus: false });
      return;
    }
    if (key === "Escape") {
      event.preventDefault?.();
      // The innermost open layer owns Escape. The Base toolbar's Escape path and the shell's
      // transient-menu owner must not close their own layer for the same keystroke.
      event.stopPropagation?.();
      closeMenu();
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault?.();
      commit(activeIndex);
      return;
    }
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    event.preventDefault?.();
    moveActive(key);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    closeMenu({ returnFocus: false });
    trigger.removeEventListener("click", onTriggerClick);
    trigger.removeEventListener("keydown", onTriggerKeyDown);
    select.removeEventListener("change", render);
    observer?.disconnect?.();
  }

  // --- wiring ---------------------------------------------------------------

  trigger.addEventListener("click", onTriggerClick);
  trigger.addEventListener("keydown", onTriggerKeyDown);
  select.addEventListener("change", render);
  const observer = typeof MutationObserver === "function" ? new MutationObserver(render) : null;
  observer?.observe?.(select, { childList: true, subtree: true, attributes: true });
  render();

  // Claim a focus handoff armed by the control this one replaced (see `commit`).
  if (focusKey !== null && pendingFocusKey === focusKey && isUsable(trigger, home)) {
    pendingFocusKey = null;
    trigger.focus?.();
  }

  return { destroy, isOpen: () => open, trigger, menu };
}
