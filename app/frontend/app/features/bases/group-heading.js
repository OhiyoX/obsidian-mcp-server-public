// Grouped table body (lane desktop-re/bases-grouping).
//
// The partition comes from the server DTO (`groups: [{key, keyType, count, rowPaths}]`,
// cut-4 `buildGroupingDto`), so the table paints the groups in the DTO's own group order
// and NEVER re-derives a rule: the rule shown is `effectiveGroupBy` (the reader's
// `?group=` override, else the view's declared `groupBy`), which is exactly the rule the
// server applied. When the DTO carries no `groups` the rows are rendered flat.
//
// Page windows: `state.rows` is the current page while `groups[].rowPaths` covers the
// whole retained set, so a heading is painted only for a group that has at least one row
// ON THIS page — and its flair is the group's real total (`group.count`), not the number
// of rows that happen to be loaded. That is the honest reading; a window-local count
// would under-report a group that spans two pages.
//
// The desktop class family is `bases-group-heading` (brief §2.6). Its 1.14.4 box offsets
// were NOT re-measured in this lane (no asar on this host), so the geometry is `[未证实]`
// and registered as such in HANDOFF-GROUPING.md — the row reuses the table's own tokens
// instead of pretending to be measured. A valueless bucket paints `无值` (desktop
// `labelGroupKeyNone()`, whose zh wording is likewise not verified here).

import { createSpriteIcon } from "./cell.js";
import { effectiveGroupBy } from "./query-state.js";
import { groupLabel } from "./panel-group.js";

export function groupKeyText(key) {
  if (key === null || key === undefined) return "无值";
  if (typeof key === "string") return key === "" ? "无值" : key;
  if (typeof key === "number" || typeof key === "boolean") return String(key);
  try {
    return JSON.stringify(key);
  } catch {
    return "无值";
  }
}

function createHeading(doc, groupBy, label, text, count, colspan) {
  const tr = doc.createElement("tr");
  tr.className = "base-group-heading bases-group-heading-row";
  tr.setAttribute("data-group-heading", groupBy.property);
  const th = doc.createElement("th");
  th.className = "bases-group-heading";
  th.setAttribute("scope", "colgroup");
  th.setAttribute("colspan", String(Math.max(1, colspan)));
  th.setAttribute("data-group-heading-property", groupBy.property);
  th.setAttribute("data-group-count", String(count));
  if (label) th.setAttribute("title", `${label} · 分组`);
  const span = doc.createElement("span");
  span.className = "bases-group-heading-label";
  span.textContent = text;
  th.appendChild(span);
  const flair = doc.createElement("span");
  flair.className = "flair base-group-heading-count";
  flair.setAttribute("data-group-flair", "");
  flair.textContent = String(count);
  th.appendChild(flair);
  tr.appendChild(th);
  return tr;
}

// The partition as THIS PAGE sees it: one bucket per group that has at least one loaded row,
// in the DTO's own order, plus the rows no bucket claimed. All three grouped layouts read it
// here so they cannot disagree about group order or about the page window.
//
// A row the DTO did not place in any group (a stale page stitched under a new
// partition) is returned as `floating` rather than dropped: never hide a matched row.
export function groupPage(state) {
  const groupBy = effectiveGroupBy(state);
  const groups = Array.isArray(state.groups) ? state.groups : null;
  if (!groupBy || !groups) return null;
  const rowsByPath = new Map();
  for (const row of state.rows) {
    if (row && typeof row.path === "string") rowsByPath.set(row.path, row);
  }
  const painted = new Set();
  const buckets = [];
  for (const group of groups) {
    const paths = Array.isArray(group?.rowPaths) ? group.rowPaths : [];
    const rows = paths.filter((path) => rowsByPath.has(path)).map((path) => rowsByPath.get(path));
    if (!rows.length) continue;
    rows.forEach((row) => painted.add(row.path));
    buckets.push({
      key: group?.key ?? null,
      rows,
      count: Number.isSafeInteger(group?.count) ? group.count : rows.length,
    });
  }
  return {
    groupBy,
    label: groupLabel(groupBy, state.columns),
    buckets,
    floating: state.rows.filter((row) => !row || !painted.has(row.path)),
  };
}

// `createRow(row, columns, index)` is the surface's own row factory, so a grouped table
// keeps the exact row identity, selection and cell codec of the ungrouped one.
export function appendGroupedRows({ doc, tbody, state, columns, createRow }) {
  const page = groupPage(state);
  if (!page) {
    state.rows.forEach((row, index) => tbody.appendChild(createRow(row, columns, index)));
    return null;
  }
  tbody.setAttribute("data-base-group-by", page.groupBy.property);
  tbody.setAttribute("data-base-group-direction", page.groupBy.direction);
  let index = 0;
  for (const { key, rows, count } of page.buckets) {
    tbody.appendChild(createHeading(doc, page.groupBy, page.label, groupKeyText(key), count, columns.length));
    for (const row of rows) {
      tbody.appendChild(createRow(row, columns, index));
      index += 1;
    }
  }
  for (const row of page.floating) {
    tbody.appendChild(createRow(row, columns, index));
    index += 1;
  }
  return page.groupBy;
}

// Fold identity, the desktop's `getGroupId` (app.js@2499736: `${key.constructor}:${key}`,
// `null` for a falsy key). Used as the key of the collapsed set this surface keeps for the
// duration of the mount; the desktop persists the set through `saveGroupFolds()` and this
// surface does not (registered in the matrix §14.12).
export function groupFoldId(key) {
  if (key === null || key === undefined) return null;
  return `${typeof key}:${groupKeyText(key)}`;
}

// Desktop `_J.createGroupHeadingEl` (app.js@2499736) for the NON-table layouts: a
// `div.bases-group-heading.mod-collapsible` holding the group property's name, its value and
// the chevron, whose click toggles `is-collapsed` on the heading and the chevron
// (`bO` app.js@1498694) plus — through `onToggle` — the group box the caller owns.
// The table keeps its `<tr>`/`<th>` row: our table is a real <table>, the desktop's is divs.
// Desktop returns `null` for a falsy key (no heading for the valueless bucket); this surface
// paints `无值` there like its own table does (matrix §14.12, registered difference).
export function createGroupHeadingEl({ doc, label, key, collapsed, onToggle }) {
  const heading = doc.createElement("div");
  heading.className = "bases-group-heading mod-collapsible";
  const property = doc.createElement("div");
  property.className = "bases-group-property";
  property.textContent = label;
  heading.appendChild(property);
  const value = doc.createElement("div");
  value.className = "bases-group-value";
  value.textContent = groupKeyText(key);
  heading.appendChild(value);
  const indicator = doc.createElement("div");
  indicator.className = "collapse-indicator collapse-icon";
  indicator.appendChild(createSpriteIcon(doc, "chevron-right", "svg-icon"));
  heading.appendChild(indicator);
  setHeadingCollapsed(heading, collapsed);
  const id = groupFoldId(key);
  if (id && onToggle) {
    heading.setAttribute("data-group-fold", id);
    heading.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      event.preventDefault();
      onToggle(id, event);
    });
  }
  return heading;
}

// `bO` (app.js@1498694): the class goes on the heading AND on its `.collapse-icon`; the
// chevron rotation is pure CSS off those two classes (app.css@448062 / @448184).
export function setHeadingCollapsed(heading, collapsed) {
  heading.classList.toggle("is-collapsed", collapsed);
  const icon = heading.lastChild;
  if (icon) icon.classList.toggle("is-collapsed", collapsed);
}

// A grouped table can never take a bare page append: the appended rows may OPEN a new
// group, and a trailing append could not insert its heading in the right place. The
// surface rebuilds instead (the same ruling kanban rows already carry).
export function rebuildsOnAppend(state) {
  return effectiveGroupBy(state) !== null && Array.isArray(state.groups);
}
