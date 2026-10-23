// Sort popover body (desktop Bases "Sort" menu).
//
// Shape: a section heading + one row per active sort (`属性 select` + `方向 select`
// + 删除) + a footer with `添加排序` / `清除排序`. The desktop's `分组依据` section is
// NOT rendered: the Base DTO reports `capabilities.grouping === false` and the
// frozen query contract has no grouping support, so drawing it would be a fake
// control. The desktop row also carries a ⠿ drag handle for re-ordering sorts;
// the shared icon sprite has no grip glyph and drag re-ordering is not
// implemented, so the handle is not drawn either (no dead affordance).
//
// The direction labels follow the property type the desktop uses (`A → Z` for
// text, `0 → 1` for numbers, `旧 → 新` for dates). The type is *inferred from the
// values of the current page* — the DTO does not carry a declared property type —
// and falls back to the text labels when the sample is empty or mixed.

import { buildSelect } from "./dom.js";
import { panelButton, panelFooter, panelScroll, panelSection, panelShell, columnOptions } from "./panel-chrome.js";
import { BASE_SORT_MAX } from "./query-state.js";

export const SORT_DIRECTION_LABELS = Object.freeze({
  text: Object.freeze({ asc: "A → Z", desc: "Z → A" }),
  number: Object.freeze({ asc: "0 → 1", desc: "1 → 0" }),
  date: Object.freeze({ asc: "旧 → 新", desc: "新 → 旧" }),
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MAX_SAMPLE = 12;

// `number` / `date` / `text` from a bounded, non-empty value sample. Mixed or
// non-decisive samples stay `text` (the neutral desktop label set).
export function inferSortKind(sample) {
  const values = (Array.isArray(sample) ? sample : []).filter((value) => value !== null && value !== undefined && value !== "");
  if (!values.length) return "text";
  if (values.every((value) => typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))))) {
    return "number";
  }
  if (values.every((value) => typeof value === "string" && DATE_PATTERN.test(value.trim()))) return "date";
  return "text";
}

export function sortDirectionLabels(kind) {
  return SORT_DIRECTION_LABELS[kind] ?? SORT_DIRECTION_LABELS.text;
}

// Values of one column across the loaded page. Row values are either an array
// aligned with `state.columns` (server projection order) or an object keyed by
// column key — the same resolution the table renderer uses.
export function columnValueSample(state, key) {
  const columns = Array.isArray(state?.columns) ? state.columns : [];
  const index = columns.findIndex((column) => column?.key === key);
  const sample = [];
  for (const row of Array.isArray(state?.rows) ? state.rows : []) {
    const values = row?.values;
    const value = Array.isArray(values)
      ? (index >= 0 ? values[index] : undefined)
      : (values && typeof values === "object" ? values[key] : undefined);
    if (value === undefined || value === null) continue;
    sample.push(value);
    if (sample.length >= MAX_SAMPLE) break;
  }
  return sample;
}

// A property can appear once per sort level: a re-pick that collides with another
// level drops the older level instead of silently duplicating it (the frozen
// `normalizeSort` also de-duplicates by key, so the UI must agree with the URL).
export function replaceSortKey(list, index, key) {
  const next = list.map((entry, position) => (position === index ? { ...entry, key } : entry));
  const seen = new Set();
  return next.filter((entry) => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

export function buildSortPanel(state, context, { onSort } = {}) {
  const panel = panelShell(context.doc, "sort", "排序");
  // G5: the sort menu is a `.menu`/`.menu-scroll` menu like the filter one (its own add row
  // is a `.bases-toolbar-section.bases-toolbar-menu-actions`, asar app.js@2526713).
  const scroll = panelScroll(context.doc);
  panel.appendChild(scroll);
  const columns = Array.isArray(context.columns) ? context.columns : [];
  const list = Array.isArray(state.sort) ? state.sort : [];
  const columnKeys = columns.map((column) => column.key);
  const options = columnOptions(columns, list.map((entry) => entry.key));

  const { section, content } = panelSection(context.doc, {
    label: "排序依据",
    count: list.length,
    attribute: "data-sort-section",
    name: "sort",
  });
  scroll.appendChild(section);

  list.forEach((entry, index) => {
    const row = context.doc.createElement("div");
    row.className = "base-panel-row";
    row.setAttribute("data-sort-row", entry.key);

    const property = buildSelect(context.doc, {
      className: "base-panel-select",
      options,
      value: entry.key,
      attributes: { "data-sort-key": entry.key, "data-sort-property": "" },
      focusKey: `sort-key-${index}`,
    });
    property.onchange = () => onSort?.(replaceSortKey(list, index, property.value));
    row.appendChild(property);

    const labels = sortDirectionLabels(inferSortKind(columnValueSample(state, entry.key)));
    const direction = buildSelect(context.doc, {
      className: "base-panel-select",
      options: [
        { value: "asc", label: labels.asc, attributes: { "data-sort-key": entry.key, "data-sort-dir": "asc" } },
        { value: "desc", label: labels.desc, attributes: { "data-sort-key": entry.key, "data-sort-dir": "desc" } },
      ],
      value: entry.dir === "desc" ? "desc" : "asc",
      attributes: {
        "data-sort-key": entry.key,
        "data-sort-direction": entry.dir === "desc" ? "desc" : "asc",
        "aria-label": "排序方向",
      },
      focusKey: `sort-dir-${index}`,
    });
    direction.onchange = () => onSort?.(list.map((item, position) => (
      position === index ? { ...item, dir: direction.value } : item
    )));
    row.appendChild(direction);

    const remove = panelButton(context.doc, {
      icon: "x",
      attributes: { "data-sort-remove": entry.key, "aria-label": `删除排序：${entry.key}` },
      focusKey: `sort-remove-${index}`,
      // G9: deleting a level is the desktop's destructive action (`.mod-destructive`,
      // `n.rowEl.toggleClass("mod-destructive",e.destructive)` asar app.js@2523902,
      // declared app.css@467177). See HANDOFF-MENU-CONTENT.md §G9 for the carrier mapping.
      className: "base-panel-button base-panel-icon-button mod-destructive",
    });
    remove.onclick = () => onSort?.(list.filter((_item, position) => position !== index));
    row.appendChild(remove);
    content.appendChild(row);
  });

  const footer = panelFooter(context.doc);
  const atLimit = list.length >= BASE_SORT_MAX;
  const noColumns = columnKeys.length === 0;
  const add = panelButton(context.doc, {
    text: "添加排序",
    icon: "plus",
    attributes: { "data-sort-add": "" },
    focusKey: "sort-add",
  });
  const unused = columnKeys.find((key) => !list.some((entry) => entry.key === key));
  const defaultKey = unused ?? columnKeys[0] ?? null;
  add.disabled = atLimit || noColumns || defaultKey === null;
  if (atLimit) add.title = `最多 ${BASE_SORT_MAX} 级排序`;
  else if (noColumns) add.title = "该视图没有可排序的属性";
  add.onclick = () => {
    if (add.disabled || defaultKey === null) return;
    onSort?.([...list, { key: defaultKey, dir: "asc" }]);
  };
  footer.appendChild(add);
  if (add.disabled) add.classList.add("is-disabled");

  if (list.length) {
    const clear = panelButton(context.doc, {
      text: "清除排序",
      attributes: { "data-sort-clear": "" },
      focusKey: "sort-clear",
    });
    // Like 清除筛选, clearing keeps the popover open on its empty "排序依据" list.
    clear.onclick = () => onSort?.([]);
    footer.appendChild(clear);
  }

  // The add actions sit inside the section's content, under its rows: the desktop's own add
  // row is the LAST child of the menu there (@2526713), and keeping it out of the
  // `.base-panel-section:not(:last-child)` hairline avoids a doubled 2px divider above a
  // footer that already paints its own `border-top`.
  content.appendChild(footer);
  return panel;
}
