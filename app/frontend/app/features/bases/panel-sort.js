// Sort popover body (desktop Bases "Sort" menu).
//
// Shape (all offsets re-measured on the pinned 1.14.4 extract, not on the 1.13.7
// offsets the parity inventory still carries):
//   * `.bases-toolbar-section.bases-sort-container` > `.bases-toolbar-section-header`
//     (the bare `排序依据` label, NO flair: app.js@2526324 builds the page, app.js@2526548 the header text
//     only) + `.bases-toolbar-section-content` holding the rows;
//   * one row per sort = `.base-toolbar-sort-item` (app.js@2481117), a single frame with
//     the grip handle, the property combobox, the direction combobox and the trash icon;
//   * the add action is its own section, `.bases-toolbar-section.bases-toolbar-menu-actions`
//     holding one borderless menu item (`lucide-plus` + `添加排序`, app.js@2526713), so the
//     desktop's `:not(:last-child)` hairline separates it from the rows.
//
// The row list OPENS on the sort the `.base` declares for the selected view
// (`loadSort(){ return queryController.getViewConfig()?.getSort() ?? [] }`,
// app.js@2527776; the Web DTO carries it as `viewSort`). The URL override
// (`?sort=`) still wins: it is this surface's only write path, because editing or
// clearing the view's own declaration is a `PATCH /api/web/v1/base` operation.
//
// The `分组依据` section is NOT rendered: the Base DTO reports
// `capabilities.grouping === false` and the frozen query contract has no grouping
// support, so drawing it would be a fake control.
//
// The direction labels follow the property type the desktop resolves through
// `getWidgetForIdent()` (app.js@2482225: `date`/`datetime` -> 从旧到新/从新到旧,
// `number` -> 0 → 1/1 → 0, everything else -> A → Z/Z → A; the strings are the app's
// own i18n values, i18n/zh.txt:2359-2360). The type is *inferred from the values of the
// current page* — the DTO does not carry a declared property type — and falls back
// to the text labels when the sample is empty or mixed.

import { buildSelect } from "./dom.js";
import { panelButton, panelFooter, panelScroll, panelSection, panelShell, columnOptions } from "./panel-chrome.js";
import { spriteIcon } from "./dom.js";
import { BASE_SORT_MAX } from "./query-state.js";

export const SORT_DIRECTION_LABELS = Object.freeze({
  text: Object.freeze({ asc: "A → Z", desc: "Z → A" }),
  number: Object.freeze({ asc: "0 → 1", desc: "1 → 0" }),
  date: Object.freeze({ asc: "从旧到新", desc: "从新到旧" }),
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

// The rows the menu draws: the URL override when the user has one, else the sort the
// selected view declares (`loadSort()` on the desktop). Both are `[{ key, dir }]`.
export function effectiveSortList(state) {
  const override = Array.isArray(state?.sort) ? state.sort : [];
  if (override.length) return override;
  return Array.isArray(state?.viewSort) ? state.viewSort : [];
}

export function moveSortEntry(list, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return list;
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function buildSortPanel(state, context, { onSort } = {}) {
  const panel = panelShell(context.doc, "sort", "排序");
  // G5: the sort menu is a `.menu`/`.menu-scroll` menu like the filter one (its own add row
  // is a `.bases-toolbar-section.bases-toolbar-menu-actions`, asar app.js@2526713).
  const scroll = panelScroll(context.doc);
  panel.appendChild(scroll);
  const columns = Array.isArray(context.columns) ? context.columns : [];
  const list = effectiveSortList(state);
  const columnKeys = columns.map((column) => column.key);
  // The desktop's sort rows read the RAW property key (`updated`, not the `.base` displayName
  // 更新) — the same rule the properties menu follows, and what the owner's 04 shot shows — so
  // `columnOptions` paints `propertyPickerLabel` (built-in name, else raw key; a formula keeps
  // its displayName), not the displayName-first table header label.
  // `file.file` and `file.backlinks` are filtered out of the desktop's property chooser
  // (`app.js@2528675`), so they are excluded here too instead of being registered as
  // "unreachable" (review round 1 showed they ARE reachable when a `.base` declares them).
  const SORT_EXCLUDED_KEYS = new Set(["file.file", "file.backlinks"]);
  const options = columnOptions(columns, list.map((entry) => entry.key))
    .filter((option) => !SORT_EXCLUDED_KEYS.has(option.value));

  // D8: the desktop header carries the bare `排序依据` label — its flair is the TOOLBAR
  // badge, not a section count (app.js@2526548), so no `count` is passed.
  const { section, content } = panelSection(context.doc, {
    label: "排序依据",
    attribute: "data-sort-section",
    name: "sort",
  });
  scroll.appendChild(section);

  let dragSource = null;
  list.forEach((entry, index) => {
    // D3: one frame, two segments — `.base-toolbar-sort-item` (app.js@2481117). The rows
    // carry `data-sort-row` (the frozen hook) and the desktop's own class.
    const row = context.doc.createElement("div");
    row.className = "base-toolbar-sort-item";
    row.setAttribute("data-sort-row", entry.key);

    // D2: the desktop prepends `createDiv("grip-handle")` + `LM(r,"grip-vertical")` as the
    // row's first child and wires drag re-ordering to `moveSortRow` (app.js@2528519). The
    // handle below is that node and the drop handler below is that operation.
    const grip = context.doc.createElement("span");
    grip.className = "grip-handle";
    grip.setAttribute("aria-hidden", "true");
    const glyph = spriteIcon(context.doc, "grip-vertical", "base-panel-icon");
    if (glyph) grip.appendChild(glyph);
    grip.draggable = true;
    grip.ondragstart = (event) => {
      dragSource = index;
      if (event?.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(index));
      }
    };
    grip.ondragend = () => { dragSource = null; };
    row.appendChild(grip);
    row.ondragover = (event) => { event?.preventDefault?.(); };
    row.ondrop = (event) => {
      event?.preventDefault?.();
      const raw = dragSource ?? Number(event?.dataTransfer?.getData?.("text/plain"));
      dragSource = null;
      if (!Number.isInteger(raw) || raw === index) return;
      onSort?.(moveSortEntry(list, raw, index));
    };

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
      icon: "trash-2",
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

  // D6: the add action is the desktop's borderless menu row, in its own
  // `.bases-toolbar-section.bases-toolbar-menu-actions` sibling of the rows section
  // (app.js@2526713 + `C$` row class `bases-toolbar-menu-item bases-toolbar-menu-action`,
  // app.js@2373586). Being a sibling is what gives the rows section the desktop's
  // `:not(:last-child)` hairline (app.css@455818) above the action row.
  const footer = panelFooter(context.doc);
  // The desktop action row's box (`.bases-toolbar-menu-item` + `.bases-toolbar-menu-action`,
  // app.js@2373586/app.css@466793) is the menu-item skin this sheet already carries for the
  // filter menu's action rows, so the footer joins it instead of duplicating the declarations.
  footer.classList.add("base-panel-actions");
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

  // The desktop sort page has NO clear action. We need one only because a `?sort=` override is
  // this surface's only write path: without it the reader cannot drop the override. Showing it
  // while the menu is merely echoing the VIEW's declared sort made it a fake action (clicking it
  // just re-renders the same seed row - review round 1), so it appears only when an override is
  // actually in force.
  const hasOverride = Array.isArray(state.sort) && state.sort.length > 0;
  if (hasOverride && list.length) {
    const clear = panelButton(context.doc, {
      text: "清除本次排序",
      attributes: { "data-sort-clear": "" },
      focusKey: "sort-clear",
    });
    // Like 清除筛选, clearing keeps the popover open on its empty "排序依据" list.
    clear.onclick = () => onSort?.([]);
    footer.appendChild(clear);
  }

  scroll.appendChild(footer);
  return panel;
}
