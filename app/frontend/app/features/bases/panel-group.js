// Grouping popover body (desktop Bases `分组` menu, 1.14.4 shape).
//
// Shape, measured on the pinned 1.14.4 desktop sources already cited by this
// surface's other menus (the group page is a `.bases-toolbar-section` like the sort
// page: `.bases-toolbar-section-header` + `.bases-toolbar-section-content`, then the
// add action in its own `.bases-toolbar-section.bases-toolbar-menu-actions`):
//   * header label `分组依据` (bare, like `排序依据`: the tool button carries the badge);
//   * one rule row: property selector + direction selector + delete, the same row
//     frame the sort menu uses (`.base-toolbar-sort-item`);
//   * `添加分组` as a borderless menu row (`lucide-plus` + text).
//
// FROZEN DOMAIN — one rule only. The `.base` key this menu edits is exactly
// `{ property, direction?: "ASC"|"DESC" }` (`base-grouping.js`
// `readGroupByDeclaration`, matrix §6 / N8: a second key or a second rule fails
// closed server-side). So the menu can never paint a second rule row: `添加分组` is a
// real button that is DISABLED while a rule exists, with the reason on its title.
// Drawing an "add a second group level" control would be a fake control.
//
// WRITE PATH — the URL override (`?group=`), not the `.base` file. This surface has
// no PATCH client (the same ruling panel-sort.js / panel-filter.js carry): rewriting
// `views[].groupBy` is a `PATCH /api/web/v1/base` `set-view-option` operation. The
// rule row is therefore seeded from `effectiveGroupBy(state)` — the reader's own
// override, else the view's declared `groupBy` — exactly like the sort menu opens on
// `viewSort`.

import { buildSelect } from "./dom.js";
import { columnOptions, panelButton, panelFooter, panelScroll, panelSection, panelShell, propertyPickerLabel } from "./panel-chrome.js";
import { BASE_GROUP_DIRECTIONS, DEFAULT_GROUP_DIRECTION, effectiveGroupBy } from "./query-state.js";
import { columnValueSample, inferSortKind } from "./panel-sort.js";

export const GROUP_SECTION_TEXT = "分组依据";
export const GROUP_ADD_TEXT = "添加分组";
export const GROUP_EMPTY_TEXT = "尚未添加分组";

// The direction labels follow the property type exactly like the sort menu's
// (`getWidgetForIdent()`: date -> 从旧到新/从新到旧, number -> 0 → 1/1 → 0, else A → Z/Z → A),
// because 1.14.4 reuses the same widget table for `groupBy.direction`.
const GROUP_DIRECTION_LABELS = Object.freeze({
  text: Object.freeze({ ASC: "A → Z", DESC: "Z → A" }),
  number: Object.freeze({ ASC: "0 → 1", DESC: "1 → 0" }),
  date: Object.freeze({ ASC: "从旧到新", DESC: "从新到旧" }),
});

export function groupDirectionLabels(kind) {
  return GROUP_DIRECTION_LABELS[kind] ?? GROUP_DIRECTION_LABELS.text;
}

// `file.file` / `file.backlinks` are excluded from the desktop property chooser
// (`app.js@2528675`), the same exclusion the sort menu already applies.
const GROUP_EXCLUDED_KEYS = new Set(["file.file", "file.backlinks"]);

export function buildGroupPanel(state, context, { onGroup } = {}) {
  const panel = panelShell(context.doc, "group", "分组");
  const scroll = panelScroll(context.doc);
  panel.appendChild(scroll);
  const columns = Array.isArray(context.columns) ? context.columns : [];
  const rule = effectiveGroupBy(state);
  const options = columnOptions(columns, rule ? [rule.property] : [])
    .filter((option) => !GROUP_EXCLUDED_KEYS.has(option.value));

  const { section, content } = panelSection(context.doc, {
    label: GROUP_SECTION_TEXT,
    attribute: "data-group-section",
    name: "group",
  });
  scroll.appendChild(section);

  if (rule) {
    const row = context.doc.createElement("div");
    row.className = "base-toolbar-sort-item base-toolbar-group-item";
    row.setAttribute("data-group-row", rule.property);

    const property = buildSelect(context.doc, {
      className: "base-panel-select",
      options,
      value: rule.property,
      attributes: { "data-group-property": "", "data-group-key": rule.property, "aria-label": "分组属性" },
      focusKey: "group-property",
    });
    property.onchange = () => onGroup?.({ property: property.value, direction: rule.direction });
    row.appendChild(property);

    const labels = groupDirectionLabels(inferSortKind(columnValueSample(state, rule.property)));
    const direction = buildSelect(context.doc, {
      className: "base-panel-select",
      options: BASE_GROUP_DIRECTIONS.map((value) => ({
        value,
        label: labels[value],
        attributes: { "data-group-direction": value },
      })),
      value: rule.direction === "DESC" ? "DESC" : "ASC",
      attributes: { "data-group-direction-select": "", "aria-label": "分组方向" },
      focusKey: "group-direction",
    });
    direction.onchange = () => onGroup?.({ property: rule.property, direction: direction.value });
    row.appendChild(direction);

    const remove = panelButton(context.doc, {
      icon: "trash-2",
      attributes: { "data-group-remove": rule.property, "aria-label": `删除分组：${rule.property}` },
      focusKey: "group-remove",
      className: "base-panel-button base-panel-icon-button mod-destructive",
    });
    // Deleting the row drops the override. When the rule came from the VIEW's own
    // declaration there is no override to drop, so the button is disabled instead of
    // pretending it edited the document (the same honesty rule as the sort menu's
    // conditional clear action).
    const overridden = Boolean(state.group);
    remove.disabled = !overridden;
    if (!overridden) {
      remove.classList.add("is-disabled");
      remove.title = "分组规则来自 .base 视图配置，Web 端暂不支持写回";
    }
    remove.onclick = () => {
      if (remove.disabled) return;
      onGroup?.(null);
    };
    row.appendChild(remove);
    content.appendChild(row);
  } else {
    const empty = context.doc.createElement("div");
    empty.className = "base-panel-empty";
    empty.setAttribute("data-group-empty", "");
    empty.textContent = GROUP_EMPTY_TEXT;
    content.appendChild(empty);
  }

  const footer = panelFooter(context.doc);
  footer.classList.add("base-panel-actions");
  const unused = columns.map((column) => column.key).filter((key) => !rule && !GROUP_EXCLUDED_KEYS.has(key));
  const defaultKey = rule ? null : (unused[0] ?? null);
  const add = panelButton(context.doc, {
    text: GROUP_ADD_TEXT,
    icon: "plus",
    attributes: { "data-group-add": "" },
    focusKey: "group-add",
  });
  add.disabled = rule !== null || defaultKey === null;
  if (rule) add.title = "该视图已有分组规则，.base 只支持一级分组";
  else if (defaultKey === null) add.title = "该视图没有可分组的属性";
  if (add.disabled) add.classList.add("is-disabled");
  add.onclick = () => {
    if (add.disabled || defaultKey === null) return;
    onGroup?.({ property: defaultKey, direction: DEFAULT_GROUP_DIRECTION });
  };
  footer.appendChild(add);

  // The desktop group page has no clear action; ours appears only while an override is
  // in force, because that is the only state where it can undo something.
  if (state.group) {
    const clear = panelButton(context.doc, {
      text: "清除本次分组",
      attributes: { "data-group-clear": "" },
      focusKey: "group-clear",
    });
    clear.onclick = () => onGroup?.(null);
    footer.appendChild(clear);
  }

  scroll.appendChild(footer);
  return panel;
}

// Row label used by the tool-row badge / the group headings: the desktop's picker
// rule (built-in name, else raw key; a formula keeps its displayName).
export function groupLabel(rule, columns) {
  if (!rule) return "";
  const column = (Array.isArray(columns) ? columns : []).find((entry) => entry?.key === rule.property) ?? null;
  return propertyPickerLabel(rule.property, column);
}
