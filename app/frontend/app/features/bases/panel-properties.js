// Properties popover body (desktop Bases "Properties" menu).
//
// Shape: a property search box, the `已显示` group (currently visible columns,
// first), the `全部属性` group — the columns the view declares but does NOT show
// (the difference, so no entry is listed twice) — and a footer with `全部隐藏`.
//
// The two groups are disjoint by construction and their union is the declared
// column set, so every property is reachable exactly once: a hidden property is
// toggled back on from `全部属性`, and the group disappears (heading included)
// when the view shows every column.
//
// The search filters the two lists in place (no re-render, so the caret and the
// typed text survive). `全部隐藏` is a real action: it clears the visible columns
// through `hideAllColumns`, and every property stays listed below with an
// unchecked box so the state is undoable from the same popover.
//
// The desktop footer also offers `添加公式`. Formulas cannot be created here: the
// Web Base surface is read-only and there is no formula-write route, so the
// button is NOT rendered (no fake control). The per-row `›` submenu (property
// type / formula settings) is left out for the same reason.

import { el } from "./dom.js";
import { panelButton, panelContainer, panelFooter, panelRowAction, panelScroll, panelSection, panelShell } from "./panel-chrome.js";

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
  const all = Array.isArray(context.columns) ? context.columns : [];
  const visible = Array.isArray(context.visibleColumns) ? context.visibleColumns : [];
  const visibleKeys = new Set(visible.map((column) => column.key));

  const search = doc.createElement("input");
  search.className = "base-panel-input base-panel-search";
  search.type = "search";
  search.setAttribute("data-prop-search", "");
  search.setAttribute("data-focus", "prop-search");
  search.placeholder = "查找属性…";
  search.value = getPropertySearch();
  search.oninput = () => {
    setPropertySearch(search.value);
    renderLists();
  };
  container.appendChild(search);

  // `全部属性` is the difference `declared − shown`: the desktop-shaped popover lists
  // a property once, and the `已显示` group already owns every visible one. An empty
  // group is not drawn at all (no empty heading), which is also what keeps the
  // popover from pushing its own lists out of its `max-height`.
  const groups = [
    { key: "visible", label: "已显示", columns: visible },
  ];
  const rest = all.filter((column) => !visibleKeys.has(column.key));
  if (rest.length) groups.push({ key: "all", label: "全部属性", columns: rest });
  const lists = new Map();
  for (const group of groups) {
    const { section, content } = panelSection(doc, {
      label: group.label,
      attribute: "data-prop-section",
      name: group.key,
    });
    container.appendChild(section);
    const list = el(doc, "div", "base-panel-list");
    list.setAttribute("data-prop-group", group.key);
    lists.set(group.key, list);
    content.appendChild(list);
  }

  function propertyRow(column) {
    const shown = visibleKeys.has(column.key);
    const row = doc.createElement("label");
    row.className = "base-panel-option bases-toolbar-menu-item";
    row.setAttribute("data-prop-row", column.key);
    // G9: a property the view does not show is a HIDDEN item in the desktop menu —
    // `t.toggleClass("mod-hidden",!v)` with `v=d.contains(l)` (the visibility set) in the
    // properties menu (asar app.js@2490299), declared at app.css@467406/@467509. The
    // desktop builds the row only when it is already carrying that class, so this is the
    // class's real carrier, not a decoration.
    if (!shown) row.classList.add("mod-hidden");
    const check = doc.createElement("input");
    check.className = "base-panel-check";
    check.type = "checkbox";
    check.setAttribute("data-prop-toggle", column.key);
    check.setAttribute("data-focus", `prop-${column.key}`);
    check.checked = shown;
    // Hiding the last visible column through this control is a no-op: only the
    // explicit `全部隐藏` action may clear every column.
    check.disabled = shown && visibleKeys.size <= 1;
    check.onchange = () => onToggleColumn?.(column.key);
    // G9: the desktop marks an item whose only control cannot be used with `.is-disabled`
    // (`t.toggleClass("is-disabled",!!e.error)`, asar app.js@2512259; declared @467250).
    // Here the control really is disabled, so the row carries the class its own checkbox
    // is in and a test can read the state off the row.
    if (check.disabled) row.classList.add("is-disabled");
    // The desktop prepends the checkbox to the row and then builds the item info as a
    // SIBLING (`t.createEl("input",{type:"checkbox",prepend:!0})` +
    // `t.createDiv("bases-toolbar-menu-item-info")`, asar app.js@2488830/@2490220).
    row.appendChild(check);
    const info = el(doc, "span", "base-panel-item-info bases-toolbar-menu-item-info");
    // The desktop's type icon slot (`i.createDiv("bases-toolbar-menu-item-info-icon")`
    // app.js@2488830, styled @469227). It stays empty on purpose: the desktop fills it from
    // the property's declared TYPE (`UQ(propId).type`, app.js@2488857) and this read-only
    // DTO carries no property type, so any glyph here would be invented. The node exists
    // because the row's own text and formula slot belong to the info box, and the
    // desktop's own `:before{content:"\200B";width:0}` (@469406) shows an empty slot is
    // the intended state.
    const infoIcon = el(doc, "span", "base-panel-item-info-icon bases-toolbar-menu-item-info-icon");
    infoIcon.setAttribute("data-prop-info-icon", column.key);
    info.appendChild(infoIcon);
    info.appendChild(el(doc, "span", "base-panel-option-label base-panel-item-name bases-toolbar-menu-item-name", column.label ?? column.key));
    // Read-only formula definition (desktop `Edit formula...` gives the same
    // information; there is no formula-write route, so this only shows it).
    const expression = column.formula?.expression;
    if (typeof expression === "string" && expression) {
      const source = el(doc, "span", "base-panel-option-label base-panel-formula-source", `ƒ ${expression}`);
      source.setAttribute("data-formula-source", column.key);
      source.setAttribute("title", expression);
      info.appendChild(source);
    }
    row.appendChild(info);
    row.appendChild(panelRowAction(doc, column.key));
    return row;
  }

  function renderLists() {
    const needle = normalizePropertySearch(getPropertySearch());
    for (const group of groups) {
      const list = lists.get(group.key);
      list.replaceChildren();
      for (const column of group.columns) {
        if (!columnMatchesSearch(column, needle)) continue;
        list.appendChild(propertyRow(column));
      }
    }
  }
  renderLists();

  const footer = panelFooter(doc);
  const hideAll = panelButton(doc, {
    text: "全部隐藏",
    attributes: { "data-prop-hide-all": "" },
    focusKey: "prop-hide-all",
  });
  hideAll.disabled = visibleKeys.size === 0;
  hideAll.onclick = () => onHideAllColumns?.();
  footer.appendChild(hideAll);
  container.appendChild(footer);
  return panel;
}
