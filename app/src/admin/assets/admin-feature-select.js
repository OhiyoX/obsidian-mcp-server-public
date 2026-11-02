// Feature module: a self-drawn select popup for every `select.sel` on the Admin plane.
//
// **This is a user-decided DESIGN CHANGE, not prototype parity (2026-10-18).** The prototype uses
// native `<select>` elements (`docs/admin-ui-proto/src/5-render.js`), and a native option list cannot
// be styled, so the owner asked for the expanded list to be drawn by the plane. The comparison with
// the prototype therefore stops at the CLOSED control: the visible box must stay the prototype's
// `.sel` vocabulary (height 32 / `.sm` 28, `--field` surface, `1px --line2`, radius `--r`, the same
// chevron), while the opened list is ours. `docs/QUALITY_AUDIT.md` and `docs/admin/README.md` record
// the decision; the gate asserts "the popup exists and paints the selected row" plus "the closed
// state is still the prototype's `.sel`", and never "identical to the prototype".
//
// No-JS contract (the reason the markup is not rewritten):
//   * the real `<select>` never leaves the form — it keeps its `name`, its options and its value, so
//     a POST/GET from this form still carries the picked value and a scriptless browser is unchanged;
//   * with the script running the real control is only *visually* hidden (clipped to 1px, `aria-hidden`,
//     `tabindex="-1"`) — it is still submitted, and its `change` event is still what the rest of the
//     page listens to;
//   * the proxy control mirrors the pick back into the real select and dispatches a real `change`, so
//     `data-autosubmit` forms (the prototype's scripted auto-submit selects) and the policy editor's
//     own listeners keep working without knowing this module exists.
//
// Keyboard/ARIA are meant to be at native level: ↑/↓, Home/End, Enter/Space, Esc (close and give focus
// back), Tab (close and let the browser move on), first-letter type-ahead; `role="combobox"` +
// `aria-expanded` + `aria-controls` on the control, `role="listbox"`/`role="option"` +
// `aria-activedescendant` on the popup. The popup lives on `<body>` with `position: fixed`, so no
// table card, drawer or scroll container can clip it; scroll/resize close it instead of leaving it
// detached from its control.
import { registerFeature } from "./admin-client.js";

/** Type-ahead buffer lifetime, roughly the platform's own (about a second). */
const TYPEAHEAD_MS = 800;
/** The prototype's own menu/list ceiling (`docs/admin-ui-proto/src/1-head.html` uses 320px). */
const MAX_POPUP_HEIGHT = 320;

registerFeature("select", (ctx) => {
  /** The one open popup: `{ select, proxy, popup, items, active, entry }`. */
  let open = null;
  let sequence = 0;
  let typeahead = { text: "", at: 0 };

  const optionText = (option) => String(option?.label ?? option?.textContent ?? "").trim();
  const selectedOption = (select) => select.options[select.selectedIndex] || null;

  function accessibleName(select) {
    const labelled = select.labels && select.labels.length ? String(select.labels[0].textContent || "").trim() : "";
    const name = select.getAttribute("aria-label") || labelled || select.getAttribute("title") || select.getAttribute("name") || "选择";
    return name.replace(/\s+/g, " ").trim();
  }

  /** Keep the proxy's face equal to the real control's value (also after someone else sets it). */
  function sync(select) {
    if (!select._selProxy) return;
    select._selProxy.textContent = optionText(selectedOption(select));
  }

  /* ---------------------------------------------------------------- popup */

  function build(select, proxy) {
    const popup = document.createElement("div");
    popup.className = "selmenu";
    popup.dataset.selectPopup = "1";
    popup.id = proxy.getAttribute("aria-controls");
    popup.setAttribute("role", "listbox");
    popup.setAttribute("aria-label", proxy.getAttribute("aria-label"));
    const items = [...select.options].map((option, index) => {
      const item = document.createElement("div");
      item.className = "sel-opt";
      item.id = `${popup.id}-${index}`;
      item.dataset.index = String(index);
      item.dataset.value = String(option.value);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", option.selected ? "true" : "false");
      if (option.selected) item.classList.add("on");
      const label = document.createElement("span");
      label.className = "sel-opt-label";
      label.textContent = optionText(option);
      const check = document.createElement("span");
      check.className = "sel-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";
      item.append(label, check);
      // Keep the caret on the control (the listbox is a passive sibling), and never let the
      // surrounding `<label>` forward this click to the real select.
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => commit(select, index));
      popup.appendChild(item);
      return item;
    });
    document.body.appendChild(popup);
    return { popup, items };
  }

  function place(popup, proxy) {
    const rect = proxy.getBoundingClientRect();
    const width = Math.max(80, Math.round(rect.width));
    const left = Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - width - 8));
    popup.style.width = `${width}px`;
    popup.style.maxWidth = `${Math.min(Math.round(window.innerWidth - left - 8), Math.max(width, 480))}px`;
    popup.style.left = `${left}px`;
    const below = Math.max(0, window.innerHeight - rect.bottom - 8);
    const above = Math.max(0, rect.top - 8);
    const height = Math.min(popup.scrollHeight, MAX_POPUP_HEIGHT);
    const flip = below < Math.min(height, 180) && above > below;
    popup.style.maxHeight = `${Math.min(MAX_POPUP_HEIGHT, Math.max(120, flip ? above : below))}px`;
    if (flip) {
      popup.style.top = "";
      popup.style.bottom = `${Math.round(window.innerHeight - rect.top + 4)}px`;
    } else {
      popup.style.bottom = "";
      popup.style.top = `${Math.round(rect.bottom + 4)}px`;
    }
  }

  function highlight(index, { scroll = false } = {}) {
    if (!open) return;
    const clamped = Math.max(0, Math.min(open.items.length - 1, index));
    open.active = clamped;
    open.items.forEach((item, at) => item.classList.toggle("act", at === clamped));
    const item = open.items[clamped];
    if (item) {
      open.proxy.setAttribute("aria-activedescendant", item.id);
      if (scroll) item.scrollIntoView({ block: "nearest" });
    }
  }

  function openPopup(select, proxy) {
    if (open) closeOpen({ restoreFocus: false });
    typeahead = { text: "", at: 0 };
    const { popup, items } = build(select, proxy);
    if (proxy.classList.contains("sm")) popup.classList.add("sm");
    const entry = {
      closed: false,
      close() {
        if (entry.closed) return;
        entry.closed = true;
        closeOpen({ restoreFocus: true });
      },
    };
    open = { select, proxy, popup, items, active: Math.max(0, select.selectedIndex), entry };
    place(popup, proxy);
    proxy.setAttribute("aria-expanded", "true");
    highlight(open.active, { scroll: true });
    // Registered in the shared overlay stack, so Esc (the plane's one Esc order) closes this list
    // before it closes anything behind it, and a second overlay cannot open under it unnoticed.
    ctx.openOverlay(entry);
  }

  function teardown(restoreFocus) {
    const current = open;
    if (!current) return;
    open = null;
    current.proxy.setAttribute("aria-expanded", "false");
    current.proxy.removeAttribute("aria-activedescendant");
    current.popup.remove();
    if (restoreFocus && document.contains(current.proxy)) {
      try { current.proxy.focus({ preventScroll: false }); } catch { /* ignore */ }
    }
  }

  function closeOpen({ restoreFocus = true } = {}) {
    const current = open;
    if (!current) return;
    teardown(restoreFocus);
    ctx.closeOverlay(current.entry);
  }

  /** Mirror one pick back into the real control and let the page react to it. */
  function commit(select, index) {
    const option = select.options[index];
    if (!option) { closeOpen({ restoreFocus: true }); return; }
    const changed = select.selectedIndex !== index || select.value !== option.value;
    select.selectedIndex = index;
    sync(select);
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    closeOpen({ restoreFocus: true });
  }

  function move(delta) {
    if (!open) return;
    highlight(open.active + delta, { scroll: true });
  }

  function typeAhead(select, proxy, character) {
    const now = Date.now();
    typeahead.text = now - typeahead.at > TYPEAHEAD_MS ? character : typeahead.text + character;
    typeahead.at = now;
    const needle = typeahead.text.toLowerCase();
    const options = [...select.options];
    if (!options.length) return;
    const start = open ? open.active : Math.max(0, select.selectedIndex);
    for (let step = 1; step <= options.length; step += 1) {
      const index = (start + step) % options.length;
      if (optionText(options[index]).toLowerCase().startsWith(needle)) {
        if (open) {
          highlight(index, { scroll: true });
        } else {
          // Closed control: native selects commit as you type, so do the same.
          commit(select, index);
        }
        return;
      }
    }
  }

  function onKeydown(select, proxy, event) {
    const key = event.key;
    const isOpen = Boolean(open) && open.proxy === proxy;
    const stop = () => { event.preventDefault(); event.stopPropagation(); };
    if (isOpen) {
      if (key === "ArrowDown") { stop(); move(1); return; }
      if (key === "ArrowUp") { stop(); move(-1); return; }
      if (key === "Home") { stop(); highlight(0, { scroll: true }); return; }
      if (key === "End") { stop(); highlight(open.items.length - 1, { scroll: true }); return; }
      if (key === "Enter" || key === " " || key === "Spacebar") { stop(); commit(select, open.active); return; }
      if (key === "Escape") { stop(); closeOpen({ restoreFocus: true }); return; }
      if (key === "Tab") { closeOpen({ restoreFocus: false }); return; }
      if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { stop(); typeAhead(select, proxy, key); return; }
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " " || key === "Spacebar") {
      stop();
      openPopup(select, proxy);
      return;
    }
    if (key === "Escape") { stop(); return; }
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { stop(); typeAhead(select, proxy, key); }
  }

  /* ---------------------------------------------------------------- per control */

  function enhance(select) {
    if (select.dataset.selectEnhanced === "1") return;
    if (select.hasAttribute("data-native-select")) return; // explicit opt-out
    const id = `sel-${++sequence}`;
    const small = select.classList.contains("sm");
    const measured = Math.round(select.getBoundingClientRect().width);
    const proxy = document.createElement("button");
    proxy.type = "button";
    proxy.className = `sel sel-proxy${small ? " sm" : ""}`;
    proxy.dataset.selectProxy = "1";
    proxy.setAttribute("role", "combobox");
    proxy.setAttribute("aria-haspopup", "listbox");
    proxy.setAttribute("aria-expanded", "false");
    proxy.setAttribute("aria-controls", `${id}-list`);
    proxy.setAttribute("aria-label", accessibleName(select));
    if (measured > 0) proxy.dataset.nativeWidth = String(measured);
    if (small && measured > 0) proxy.style.width = `${measured}px`;    if (select.style.maxWidth) proxy.style.maxWidth = select.style.maxWidth;
    if (select.style.minWidth) proxy.style.minWidth = select.style.minWidth;

    // `data-select-native`, not a class: the shape comparison normalizes classes and this state is
    // presentation plumbing, so it must not change the control's shape line.
    select.dataset.selectNative = "1";
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;
    select.dataset.selectEnhanced = "1";
    select.after(proxy);
    select._selProxy = proxy;
    sync(select);

    proxy.addEventListener("click", () => {
      if (open && open.proxy === proxy) closeOpen({ restoreFocus: true });
      else openPopup(select, proxy);
    });
    proxy.addEventListener("keydown", (event) => onKeydown(select, proxy, event));
    select.addEventListener("change", () => sync(select));
    // A `<label>` around the select ("每页 <select>") would otherwise forward the proxy's click to the
    // real (now hidden) control and open the native picker as well.
    for (const label of select.labels || []) {
      label.addEventListener("click", (event) => {
        if (event.target.closest && event.target.closest("[data-select-proxy]")) event.preventDefault();
      });
    }
    const form = select.form || select.closest("form");
    if (form) form.dataset.enhanced = "1";
  }

  for (const select of document.querySelectorAll("select.sel")) {
    try {
      enhance(select);
    } catch (error) {
      // One broken control must not cost the operator the other ones (or the fallback button).
      console.error("[admin] select enhancement failed", error);
    }
  }

  // Outside click closes (the proxy's own click toggles, so it is excluded).
  document.addEventListener("pointerdown", (event) => {
    if (!open) return;
    if (open.popup.contains(event.target)) return;
    if (open.proxy === event.target || open.proxy.contains(event.target)) return;
    closeOpen({ restoreFocus: false });
  }, true);

  // A popup pinned to the viewport is only honest while its control is where it was left.
  const closeOnMove = (event) => {
    if (!open) return;
    if (open.popup.contains(event.target)) return;
    closeOpen({ restoreFocus: false });
  };
  window.addEventListener("scroll", closeOnMove, true);
  window.addEventListener("resize", closeOnMove);
});
