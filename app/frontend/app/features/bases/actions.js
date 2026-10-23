// Action-row vocabulary + pure state helpers (desktop Bases parity).

import { normalizeQuery } from "./query-state.js";

export const BASE_ACTION_ITEMS = Object.freeze([
  { id: "sort", label: "排序", icon: "arrow-up-narrow-wide" },
  { id: "filter", label: "筛选", icon: "filter" },
  { id: "properties", label: "属性", icon: "list-tree" },
  { id: "search", label: "搜索", icon: "search" },
  { id: "new", label: "新建", icon: "plus" },
]);

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

export function actionIsActive(actionId, { sort = [], filter = [], q = "", hidden = [] } = {}) {
  switch (actionId) {
    case "sort": return sort.length > 0;
    case "filter": return filter.length > 0;
    case "properties": return hidden.length > 0;
    case "search": return normalizeQuery(q) !== "";
    default: return false;
  }
}

export function folderOfPath(path) {
  const value = String(path ?? "").replaceAll("\\", "/");
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}
