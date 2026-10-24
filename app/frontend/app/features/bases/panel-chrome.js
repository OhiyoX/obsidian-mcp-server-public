// Shared chrome for the Base action popovers (desktop Bases shape).
//
// Every panel is a floating `role="dialog"` popover anchored to its own action
// button by toolbar.js. This module owns only the repeated parts — the shell, the
// section heading, the footer row, the icon button and the property option list —
// so the four panel bodies stay small and each file stays inside the line
// architecture budget.
//
// No HTML sinks: everything goes through createElement/textContent (surface
// contract WB-10).

import { builtinPropertyName } from "../../../../src/base-builtin-names.js";
import { el, spriteIcon } from "./dom.js";

export function panelShell(doc, id, label) {
  const panel = el(doc, "div", "base-panel");
  panel.setAttribute("data-base-panel", id);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", label);
  return panel;
}

// ---------------------------------------------------------------------------
// G5/G6 — the two containers between the shell and the menu content
// ---------------------------------------------------------------------------
//
// The desktop menu is `div.menu.bases-toolbar-menu` > `div.menu-scroll`
// (asar app.js@2369180); the Bases variant makes THAT node the scroller
// (`.bases-toolbar-menu .menu-scroll{overflow-y:auto;padding:0}`, asar app.css@455560)
// while the shell itself keeps `.menu{overflow:hidden}` (@282803). So the shell never
// scrolls and the body does — which is what keeps the panel's own header put while the
// menu content moves under it. The scroll node is the panel's only body child.
export function panelScroll(doc) {
  const scroll = el(doc, "div", "base-panel-scroll menu-scroll");
  scroll.setAttribute("data-base-panel-scroll", "");
  return scroll;
}

// `.bases-toolbar-menu-container` (asar app.css@452892, built by the menu constructor at
// app.js@2366362 and by the property page at app.js@2506194): the inner column that owns
// the 300px reading width and the three local token overrides. It belongs to the menus
// that really have one — the filter/sort menus put their sections straight into
// `.menu-scroll` (app.js@2479449), which is why `max-width:300px` is NOT applied to the
// shell (that one is `max-width:100vw`, @455439).
export function panelContainer(doc) {
  const container = el(doc, "div", "base-panel-container bases-toolbar-menu-container");
  container.setAttribute("data-base-panel-container", "");
  return container;
}

// ---------------------------------------------------------------------------
// Panel chrome: the header row of a NESTED page (desktop `pageStack.length > 1`)
// ---------------------------------------------------------------------------
//
// The overlay shell is presentation only: the panel body keeps its single set of
// action semantics (surface contract D337-06), and the same nodes are added to
// every popover. Two widths read them differently, and neither is inert any more
// (lane desktop-re/bases-css-port-impl, P1):
//   * a nested page (`is-nested`) shows the header at EVERY width, exactly like the
//     desktop, which builds this header whenever its page stack is deeper than one
//     (`app.js@2371419`) — with the back button the desktop builds as
//     `back-button > back-icon + back-label` (`app.js@2369195`);
//   * the `<=480px` overlay shows it at the root page too, because a full-bleed
//     overlay has no visible "outside" to tap and needs its close control.
// The root page above `<=480px` has no header, which is the desktop's own root
// shape (its header is only ever prepended into a non-root page container).

// The header row of a panel page: the panel's own label plus the close control the
// mobile overlay needs (a phone has no visible "outside" to click when the panel
// fills the screen). `onBack` is present only for a nested page: then the label moves
// INTO the back button (`back-label` in the desktop's own structure) and clicking it
// returns to the previous page, so the back affordance is never dead.
export function panelHeader(doc, { label = null, onClose = null, onBack = null } = {}) {
  const header = el(doc, "div", "base-panel-header");
  header.setAttribute("data-base-panel-header", "");
  if (typeof onBack === "function") {
    const back = el(doc, "button", "base-panel-back");
    back.type = "button";
    back.setAttribute("data-base-panel-back", "");
    back.setAttribute("aria-label", label ? `返回上一页：${label}` : "返回上一页");
    const chevron = spriteIcon(doc, "chevron-right", "base-panel-icon");
    if (chevron) back.appendChild(chevron);
    back.appendChild(el(doc, "span", "base-panel-header-label base-panel-back-label", label ?? ""));
    back.onclick = () => onBack();
    header.appendChild(back);
  } else {
    header.appendChild(el(doc, "span", "base-panel-header-label", label ?? ""));
  }
  const close = el(doc, "button", "base-panel-close");
  close.type = "button";
  close.setAttribute("data-base-panel-close", "");
  close.setAttribute("aria-label", "关闭");
  close.setAttribute("title", "关闭");
  const glyph = spriteIcon(doc, "x", "base-panel-icon");
  if (glyph) close.appendChild(glyph);
  close.onclick = () => onClose?.();
  header.appendChild(close);
  return header;
}

// Adds the header to a freshly built panel. Returns the same panel node, so the
// mounting layer keeps owning where the panel lives (inside its action anchor).
export function withPanelChrome(doc, panel, { label = null, onClose = null, onBack = null } = {}) {
  if (!panel || typeof panel.insertBefore !== "function") return panel;
  panel.insertBefore(panelHeader(doc, { label, onClose, onBack }), panel.firstChild ?? null);
  return panel;
}

// The tap-to-dismiss layer of the overlay. It is a sibling of the panel (both are
// children of the action anchor), so the panel keeps its own positioning context,
// and it is part of the toolbar chrome for the dismissal predicate in toolbar.js —
// this element owns the dismissal, not the generic outside-click path, so removing
// its handler is observable.
export function panelBackdrop(doc, onClose) {
  const backdrop = el(doc, "div", "base-panel-backdrop");
  backdrop.setAttribute("data-base-panel-backdrop", "");
  backdrop.setAttribute("aria-hidden", "true");
  backdrop.onclick = () => onClose?.();
  return backdrop;
}

// ---------------------------------------------------------------------------
// G7/G8 — the desktop section: wrapper + header container + content
// ---------------------------------------------------------------------------
//
// The desktop builds `.bases-toolbar-section` > `.bases-toolbar-section-header` +
// `.bases-toolbar-section-content` (asar app.js@2479465: `scrollEl.createDiv(
// "bases-toolbar-section", t => { t.createDiv("bases-toolbar-section-header", …);
// t.createDiv("bases-toolbar-section-content") })`), and THIS is the shape the previous
// cut was missing: the heading text alone had nowhere to put the desktop header's own
// box. The wrapper carries the section inset and the hairline between sections
// (app.css@455722 `padding:var(--size-2-1)` / @455797 `:not(:last-child){border-bottom}`),
// the header carries the desktop heading box (@455939).
//
// The count is the desktop `.flair`: the filter menu creates exactly one per section
// header (`n.globalFiltersFlairEl=e.createSpan({cls:"flair"})` app.js@2479449,
// `n.localFiltersFlairEl=e.createSpan({cls:"flair"})` @2479951) and fills it with the real
// number of active filters (`i=function(e,t){e.setText(String(t)),e.toggle(t>0)}`
// app.js@2480449, called as `i(this.localFiltersFlairEl,o)` @2480522). So a bare number was the
// wrong shape: the desktop paints it as a flair chip. `count` is still rendered only when
// the caller has a real number for it — never a placeholder.
//
// The SECOND half of that call site is the one the first cut dropped: `e.toggle(t>0)` means
// the flair chip at count 0 is HIDDEN, not a painted `0`. The desktop builds the span
// unconditionally and then toggles it off, so the node stays in the tree (and stays
// addressable) while it is not painted and its text is not part of the section header's
// visible text. `hidden` is this layer's toggle: the UA rule `[hidden]{display:none}` wins
// over `.base-panel-count{flex:0 0 auto}` (neither declaration touches `display`), so the
// reading is `display:none` and the string `0` never reaches the visible header.
export function panelSection(doc, { label, count = null, attribute = null, name = null }) {
  const section = el(doc, "div", "base-panel-section bases-toolbar-section");
  const header = el(doc, "div", "base-panel-section-header bases-toolbar-section-header");
  if (attribute && name) header.setAttribute(attribute, name);
  header.appendChild(el(doc, "span", "base-panel-section-label", label));
  if (count !== null) {
    const flair = el(doc, "span", "base-panel-count flair", String(count));
    flair.setAttribute("data-section-count", "");
    // `toggle(t>0)`: only a real count is painted.
    if (!(Number(count) > 0)) flair.setAttribute("hidden", "");
    header.appendChild(flair);
  }
  section.appendChild(header);
  const content = el(doc, "div", "base-panel-section-content bases-toolbar-section-content");
  content.setAttribute("data-section-content", "");
  section.appendChild(content);
  return { section, header, content };
}

// The desktop row's own action area: `div.filter-row-actions` (asar app.js@2468679) inside
// the filter row, and `div.filter-group-actions` (app.js@2465689,
// `display:flex;padding-top:var(--size-2-2)`, app.css@471185) inside the group. Our
// add/clear/advanced controls are group-wide, so they live in the group's action row.
export function panelActions(doc) {
  const actions = el(doc, "div", "base-panel-actions");
  actions.setAttribute("data-panel-actions", "");
  return actions;
}

export function panelFooter(doc) {
  return el(doc, "div", "base-panel-footer");
}

// The trailing action slot of a desktop row (`.bases-toolbar-menu-item-icon`, built as
// `t.createDiv("clickable-icon bases-toolbar-menu-item-icon")` + `LM(g,"lucide-chevron-right")`
// in the properties menu, asar app.js@2490350). It stays EMPTY here: the glyph opens the
// desktop's per-property sub-menu (type / formula settings), which a read-only surface does
// not have — drawing the chevron would be a dead affordance, the same ruling the sort
// menu's drag handle already carries.
//
// `.bases-toolbar-menu-action-icon` is NOT applied. The desktop has a rule for it
// (`.bases-toolbar-menu-item .bases-toolbar-menu-action-icon{color:…;display:flex;…}`,
// app.css@469509) but its `app.js` never builds the class (latin1 whole-string count = 0,
// re-measured on the same baseline: `app.js` sha256 958ce57f…a2df9), so the desktop paints
// nothing through it either. Sticking it on our own node to make the slot addressable was
// inventing structure: a class with a rule and no creator may stay CSS-only here too
// (registered in HANDOFF-MENU-CONTENT.md §FIX-R1 and the §14.4 deviation list). The slot is
// addressable through OUR OWN semantic class (`base-panel-action-icon`) and through the
// class the desktop really builds (`bases-toolbar-menu-item-icon`, app.js@2490335).
export function panelRowAction(doc, key) {
  const action = el(doc, "span", "base-panel-action-icon bases-toolbar-menu-item-icon");
  if (key) action.setAttribute("data-prop-action-icon", key);
  return action;
}

export function panelButton(doc, { text, icon = null, attributes = {}, focusKey = null, className = "base-panel-button" }) {
  const button = el(doc, "button", className);
  button.type = "button";
  if (icon) {
    const glyph = spriteIcon(doc, icon, "base-panel-icon");
    if (glyph) button.appendChild(glyph);
  }
  if (text) button.appendChild(el(doc, "span", null, text));
  if (focusKey) button.setAttribute("data-focus", focusKey);
  for (const [name, value] of Object.entries(attributes)) button.setAttribute(name, value);
  return button;
}

// The label a property PICKER row paints — the properties menu row, the sort row and the
// filter property dropdown — which is NOT the table header's label. Owner screenshots
// (`scratch/desktop-re/owner-shots`, 1.14.4): 02 reads `status` / `updated` / `项目`, 01 the
// filter row `kind`, 04 the sort row `updated`, while the same `.base`
// (`_Workspace/40-Projects/Projects.base`) declares `status:{displayName:状态}` and
// `updated:{displayName:更新}`. So a selector row shows the desktop built-in name, else the
// raw key; only a FORMULA row keeps its declared displayName. `view.js` keeps painting the
// header from `column.label` (displayName priority).
// `column` is the server column DTO when one exists: its `kind` selects the formula branch and
// its `label` already carries the declared displayName (or the formula key when silent).
export function propertyPickerLabel(key, column = null) {
  return (column?.kind === "formula" ? column.label : null) ?? builtinPropertyName(key) ?? key;
}

// The desktop Properties/Sort/Filter menus list every property the view declares,
// including the ones that are currently hidden — a hidden column must stay
// sortable/filterable. `keys` are the keys already referenced by the state; a key
// that is no longer declared (stale URL override) is still offered so the select
// never silently shows a different property than the one it will apply.
export function columnOptions(columns, keys = []) {
  const seen = new Set();
  const options = [];
  for (const column of Array.isArray(columns) ? columns : []) {
    const key = column && typeof column.key === "string" ? column.key : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push({
      value: key,
      label: propertyPickerLabel(key, column),
    });
  }
  for (const key of Array.isArray(keys) ? keys : []) {
    if (typeof key !== "string" || !key || seen.has(key)) continue;
    seen.add(key);
    // A key the view no longer declares (stale URL override) is still offered, under
    // the same picker rule: the desktop built-in name when the desktop has one, else the
    // raw key (see `src/base-builtin-names.js`, U5). The server cannot label this one —
    // it is by definition absent from `columns` — so the table is imported here rather
    // than a second copy being kept in the client.
    options.push({ value: key, label: propertyPickerLabel(key) });
  }
  return options;
}
