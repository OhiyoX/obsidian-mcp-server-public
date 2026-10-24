// Properties popover body (desktop Bases "Properties" menu).
//
// Shape (owner screenshot `02-properties-open.png`, 1.14.4): ONE flat list of every
// property the Base can address — the rows the view shows are checked, the rest are
// unchecked and muted — followed by the `全部隐藏` action. There is no `已显示` heading
// and no second group: the desktop lists each property exactly once, and the checkbox
// is the state.
//
// Where the rows come from: `context.propertyCatalog`, the additive DTO field
// (`src/base-property-catalog.js`) whose `checked` flag IS membership in the view's
// `order`. An older server sends none, and the panel then lists the declared columns
// as checked rows instead of inventing a catalog.
//
// Not ported (registered in `docs/bases/BASES-COMPATIBILITY-MATRIX.md`):
//   * `添加公式` — creating a formula needs a formula-write route; this surface has none,
//     so no fake control is rendered.
//   * the per-row `›` submenu (property type / `Edit formula...`). The row still carries
//     the desktop's trailing `›` slot because that is the row's visible shape; the slot
//     has no handler and is `aria-hidden`, so it promises nothing.
//   * the per-row property TYPE icon IS drawn, but from the catalog's INFERRED kind (the
//     desktop reads the DECLARED type). See `PROPERTY_KIND_ICONS` and matrix §14.7: a property
//     whose values are all empty keeps the text glyph even if the author declared another type.

import { el, spriteIcon } from "./dom.js";
import { panelButton, panelContainer, panelFooter, panelRowAction, panelScroll, panelShell, propertyPickerLabel } from "./panel-chrome.js";

// The desktop's per-row type glyph, rebuilt from its own rule (1.14.4 `app.js@2381738`; the
// section-5.14 review corrected the citation — `@2464900` in 1.14.4 is the filter group):
//
//   if ("note" === type)      Ag(slot, metadataTypeManager.getTypeInfo(name).expected.icon)
//   else if ("formula" === t) Ag(slot, "lucide-square-function")
//   else                      Ag(slot, "lucide-info")
//
// i.e. built-in `file.*` rows are always the info circle, formulas the ƒ square, and a
// note property takes its DECLARED TYPE's icon (date → calendar, text → the three-line
// glyph, list → tag, number → hash). This build does not carry Obsidian's declared types:
// the catalog's `kind` is INFERRED from the values the matched records hold, so the glyph
// is the observed kind's icon. Registered deviation (matrix §14.7): a property whose values
// are all empty/null keeps the text glyph even if the author declared another type.
const PROPERTY_KIND_ICONS = Object.freeze({
  // Built-in `file.*` rows are the desktop's info glyph. Our sprite has no `info` symbol, so a
  // dedicated `circle-info` (the letter i in a ring) was added; `circle-help` (the question
  // mark) was WRONG — the review caught it on 13 of 28 rows in the side-by-side.
  builtin: "circle-info",
  formula: "code",
  date: "calendar",
  text: "text",
  list: "tag",
  number: "text",
  object: "text",
  boolean: "text",
});

export function propertyIconName(kind) {
  // The fallback must name a symbol that EXISTS: `info` used to be returned here and the sprite
  // has no such id, which painted an empty slot.
  return PROPERTY_KIND_ICONS[kind] ?? "circle-info";
}

export function normalizePropertySearch(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function columnMatchesSearch(column, needle) {
  if (!needle) return true;
  // The built-in display name AND the raw key match, so a reader who knows the
  // property as `mtime` and a reader who sees 修改时间 both find it.
  const label = String(column?.label ?? column?.key ?? "").toLowerCase();
  const key = String(column?.key ?? "").toLowerCase();
  return label.includes(needle) || key.includes(needle);
}

// The catalog row set. A DTO without `propertyCatalog` (older server) degrades to the
// declared columns, marked checked, because those are the only properties it can name.
export function propertyPanelRows(context) {
  const catalog = Array.isArray(context?.propertyCatalog) ? context.propertyCatalog : [];
  if (catalog.length) {
    return catalog.filter((entry) => entry && typeof entry.key === "string" && entry.key);
  }
  const declared = Array.isArray(context?.columns) ? context.columns : [];
  return declared.map((column) => ({
    key: column.key,
    // Same label rule as the catalog's CHECKED rows (`src/base-property-catalog.js`): a
    // selector row, so the picker label, not the header's displayName-first label.
    label: propertyPickerLabel(column.key, column),
    kind: column.kind ?? null,
    checked: true,
    source: "column",
  }));
}

export function buildPropertiesPanel(_state, context, {
  onToggleColumn,
  onHideAllColumns,
  getPropertySearch = () => "",
  setPropertySearch = () => {},
} = {}) {
  const doc = context.doc;
  const panel = panelShell(doc, "properties", "属性");
  // G5/G6: `div.menu-scroll` > `div.bases-toolbar-menu-container` — the properties menu is
  // the menu the desktop builds through the container class (app.js@2366362 default value,
  // and the property page at @2506194 puts its `bases-toolbar-menu-container-header` inside
  // one). The container is the node that owns `--bases-property-menu-item-radius`, which the
  // property rows below read (app.css@452892 / @455105).
  const scroll = panelScroll(doc);
  const container = panelContainer(doc);
  scroll.appendChild(container);
  panel.appendChild(scroll);

  const rows = propertyPanelRows(context);
  // The CHECKBOX is the local visibility state, not the view's `order`: a column the reader
  // hid through this menu stays in `order` and must come back with an unchecked box. So the
  // panel reads `visibleColumns` (the client's own hidden set) when the caller supplies it,
  // and only falls back to the DTO's `checked` when there is no local visibility set yet.
  const hasVisibleSet = Array.isArray(context.visibleColumns);
  const visibleKeys = new Set((hasVisibleSet ? context.visibleColumns : []).map((column) => column.key));
  const isShown = (entry) => (hasVisibleSet ? visibleKeys.has(entry.key) : entry.checked === true);
  const checkedCount = rows.filter((row) => isShown(row)).length;

  const search = doc.createElement("input");
  search.className = "base-panel-input base-panel-search";
  search.type = "search";
  search.setAttribute("data-prop-search", "");
  search.setAttribute("data-focus", "prop-search");
  // Desktop placeholder, verbatim from the 1.14.4 i18n (`zh.txt:2300` 查找或创建…): the same
  // box both filters existing properties and names a new one.
  search.placeholder = "查找或创建…";
  search.value = getPropertySearch();
  search.oninput = () => {
    setPropertySearch(search.value);
    renderList();
  };
  container.appendChild(search);

  const list = el(doc, "div", "base-panel-list");
  list.setAttribute("data-prop-group", "all");
  container.appendChild(list);

  function propertyRow(entry) {
    const shown = isShown(entry);
    const row = doc.createElement("label");
    row.className = "base-panel-option bases-toolbar-menu-item";
    row.setAttribute("data-prop-row", entry.key);
    // G9: a property the view does not show is a HIDDEN item in the desktop menu —
    // `t.toggleClass("mod-hidden",!v)` with `v=d.contains(l)` (the visibility set) in the
    // properties menu (asar app.js@2490299), declared at app.css@467406/@467509. The
    // desktop builds the row only when it is already carrying that class, so this is the
    // class's real carrier, not a decoration. `mod-hidden` is what paints the unchecked
    // row's text `--text-faint` (the owner's muted rows).
    if (!shown) row.classList.add("mod-hidden");
    const check = doc.createElement("input");
    check.className = "base-panel-check";
    check.type = "checkbox";
    check.setAttribute("data-prop-toggle", entry.key);
    check.setAttribute("data-focus", `prop-${entry.key}`);
    check.checked = shown;
    // Hiding the last visible column through this control is a no-op: only the
    // explicit `全部隐藏` action may clear every column.
    check.disabled = shown && checkedCount <= 1;
    check.onchange = () => onToggleColumn?.(entry.key);
    // G9: the desktop marks an item whose only control cannot be used with `.is-disabled`
    // (`t.toggleClass("is-disabled",!!e.error)`, asar app.js@2512259; declared @467250).
    if (check.disabled) row.classList.add("is-disabled");
    // The desktop prepends the checkbox to the row and then builds the item info as a
    // SIBLING (`t.createEl("input",{type:"checkbox",prepend:!0})` +
    // `t.createDiv("bases-toolbar-menu-item-info")`, asar app.js@2488830/@2490220).
    row.appendChild(check);
    const info = el(doc, "span", "base-panel-item-info bases-toolbar-menu-item-info");
    // The desktop's type icon slot (`i.createDiv("bases-toolbar-menu-item-info-icon")`
    // app.js@2488830, styled @469227), filled from the row's kind below.
    const infoIcon = el(doc, "span", "base-panel-item-info-icon bases-toolbar-menu-item-info-icon");
    infoIcon.setAttribute("data-prop-info-icon", entry.key);
    // The desktop fills this slot from the property's type (app.js@2464900); `entry.kind`
    // is the catalog's inferred kind, so the glyph follows the same three-way rule.
    const iconName = propertyIconName(entry.kind);
    infoIcon.setAttribute("data-prop-icon", iconName);
    infoIcon.appendChild(spriteIcon(doc, iconName, "base-panel-item-type-icon"));
    info.appendChild(infoIcon);
    info.appendChild(el(doc, "span", "base-panel-option-label base-panel-item-name bases-toolbar-menu-item-name", entry.label ?? entry.key));
    row.appendChild(info);
    // The trailing `›`: the desktop's own row shape (app.css@469509 slot, filled with the
    // item's second-level affordance). No handler — the submenu is not ported — and
    // `aria-hidden` so a screen reader is not promised a page that does not exist.
    const action = panelRowAction(doc, entry.key);
    action.setAttribute("aria-hidden", "true");
    const chevron = spriteIcon(doc, "chevron-right", "base-panel-icon");
    if (chevron) action.appendChild(chevron);
    row.appendChild(action);
    return row;
  }

  function renderList() {
    const needle = normalizePropertySearch(getPropertySearch());
    list.replaceChildren();
    for (const entry of rows) {
      if (!columnMatchesSearch(entry, needle)) continue;
      list.appendChild(propertyRow(entry));
    }
  }
  renderList();

  // Footer: the desktop's menu action row (`全部隐藏`), a borderless `.menu-item`, not a
  // framed button. `base-panel-actions` + `base-panel-button` is that skin (the filter
  // menu's add/clear actions already use it) — see `styles-panels.js`.
  const footer = panelFooter(doc);
  footer.classList.add("base-panel-actions");
  const hideAll = panelButton(doc, {
    text: "全部隐藏",
    attributes: { "data-prop-hide-all": "" },
    focusKey: "prop-hide-all",
  });
  hideAll.disabled = checkedCount === 0;
  hideAll.onclick = () => onHideAllColumns?.();
  footer.appendChild(hideAll);
  container.appendChild(footer);
  return panel;
}
