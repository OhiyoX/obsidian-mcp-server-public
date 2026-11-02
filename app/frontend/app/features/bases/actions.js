// Action-row vocabulary + pure state helpers (desktop Bases parity).

import { effectiveGroupBy, normalizeQuery } from "./query-state.js";
import { BASE_VIEW_TYPE_CARDS, BASE_VIEW_TYPE_KANBAN, BASE_VIEW_TYPE_LIST, BASE_VIEW_TYPE_TABLE, normalizeViewType } from "./view-options.js";

// The layouts that actually paint the partition the `分组` rule produces:
// - table: group-heading.js paints the DTO's `groups[]` as headings;
// - kanban: kanban-runtime.js builds one column per `groups[]` entry;
// - list / cards: row-layouts.js paints one `bases-list-group` / `bases-cards-group` box per
//   group with the desktop's `bases-group-heading mod-collapsible` on top (lane
//   desktop-re/group-headings-list-cards, matrix §14.12).
// #686 had narrowed this list to table+kanban because list/cards rendered a flat list/grid and
// the button was therefore a control with no effect; that gap is ported now, so the gate opens
// again to all four layouts.
export const GROUPING_LAYOUTS = Object.freeze([
  BASE_VIEW_TYPE_TABLE,
  BASE_VIEW_TYPE_KANBAN,
  BASE_VIEW_TYPE_LIST,
  BASE_VIEW_TYPE_CARDS,
]);

export const BASE_ACTION_ITEMS = Object.freeze([
  { id: "sort", label: "排序", icon: "arrow-up-narrow-wide" },
  // Desktop 1.14.4 puts grouping in its own tool button
  // (`toolbarItem(…, QJ.labelGroup(), "lucide-stretch-horizontal")` + `bases-toolbar-group-menu`,
  // app.js@2506861), and the owner's shot 03 places it BETWEEN 排序 and 筛选 — the earlier
  // order here (sort, filter, group) contradicted that shot while its comment claimed the
  // opposite (review round 1, D2). The shared sprite (`src/app/assets/icons.svg`) has no
  // `stretch-horizontal` symbol and this surface's rule is to REGISTER a missing glyph
  // instead of inventing SVG bytes, so the button ships label-only. No `icon` key here on
  // purpose: an icon name the sprite cannot resolve fails the sprite audit.
  { id: "group", label: "分组", requiresCapability: "grouping", layouts: GROUPING_LAYOUTS },
  { id: "filter", label: "筛选", icon: "filter" },
  { id: "properties", label: "属性", icon: "list-tree" },
  { id: "search", label: "搜索", icon: "search" },
  { id: "new", label: "新建", icon: "plus" },
]);

export const GROUP_TOOL_ICON = "stretch-horizontal";
export const BASE_ACTION_GROUP_TEXT = "分组";

export const BASE_ACTION_SORT_TEXT = "排序";
export const BASE_ACTION_FILTER_TEXT = "筛选";
export const BASE_ACTION_PROPERTIES_TEXT = "属性";
export const BASE_ACTION_SEARCH_TEXT = "搜索";
export const BASE_ACTION_NEW_TEXT = "新建";

export const BASE_SORT_INDICATOR_DEFAULT_ICON = "chevrons-up-down";

// Pure helper: which direction glyph the tool-row indicator shows.
export function describeSortIndicator(sort) {
  const first = Array.isArray(sort) && sort.length ? sort[0] : null;
  if (!first) return { icon: BASE_SORT_INDICATOR_DEFAULT_ICON, active: false, dir: null };
  return { icon: first.dir === "desc" ? "arrow-down" : "arrow-up", active: true, dir: first.dir };
}

export function actionIsActive(actionId, { sort = [], filter = [], q = "", hidden = [], group = null } = {}) {
  switch (actionId) {
    case "sort": return sort.length > 0;
    case "filter": return filter.length > 0;
    case "group": return group !== null && group !== undefined;
    case "properties": return hidden.length > 0;
    case "search": return normalizeQuery(q) !== "";
    default: return false;
  }
}

// The action row is the desktop's own; an item that declares a capability appears only
// when the server reports it (`capabilities.grouping`), and an item that declares the
// layouts it can act on appears only in those layouts, so no button is ever a placeholder.
// `viewType` goes through `normalizeViewType` (unknown / missing = table), which is the
// same rule view.js dispatches the renderer on: the button set can never disagree with the
// layout that is actually mounted.
export function visibleActionItems(capabilities, viewType) {
  const layout = normalizeViewType(viewType);
  return BASE_ACTION_ITEMS.filter((item) => (
    (!item.requiresCapability || capabilities?.[item.requiresCapability] === true)
    && (!item.layouts || item.layouts.includes(layout))
  ));
}

// Effective grouping rule for the active badge: the reader's override or the view's
// declaration, i.e. exactly the partition the last response was built from.
export function activeGroup(state) {
  return effectiveGroupBy(state);
}

export function folderOfPath(path) {
  const value = String(path ?? "").replaceAll("\\", "/");
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}
