// Search results view (Phase 3A-3 + U4 desktop shape): server-ordered result groups.
//
// Deliberately does NOT reuse the v1 tree renderer: that one re-sorts notes by title,
// and the frozen contract makes the server order authoritative for search results.
//
// U4 renders the desktop shape over the same frozen payload: one group per note
// (name + `matchCount`) followed by one row per excerpt, with the query term marked.
// The group's title row stays the single `.note[data-path]` per result, so the
// server-ordered path list of the browser regression is still derivable from
// `.search-results .note[data-path]`.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
// > Phase 3A-3 契约前置决策（冻结，2026-10-04）
import { highlightSegments, extractHighlightTerms } from "./highlight.js";
import { toSearchRow } from "./search-state.js";
// U38 (#571): the sprite URL (with its published content hash) comes from the one resolver.
import { spriteIcon } from "../../ui/icons.js";

export const SEARCH_MORE_ATTR = "data-search-more";
export const SEARCH_GROUP_TOGGLE_ATTR = "data-search-group-toggle";

// U9 icon audit: the desktop draws a real chevron glyph in front of a result group, not a
// CSS triangle. The builder degrades to nothing in the Node view harness, which installs a
// document without createElementNS.
function groupChevron(doc) {
  return spriteIcon(doc, "chevron-right", "svg-icon search-group-chevron");
}

export function renderSearchResults({ host, state, isCurrent, onNote, onLoadMore, onToggleGroup }) {
  host.innerHTML = "";
  const query = typeof state?.query === "string" ? state.query : null;
  if (!state.items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    // A page can be empty while the stream still has candidates: a hard filter (e.g.
    // `published:`) may match nothing inside this candidate window. That is not "no
    // results" -- the cursor must stay reachable, otherwise the stream dead-ends on
    // an empty page. An untouched panel says how to start instead of claiming a miss.
    empty.textContent = state.loading
      ? "正在搜索…"
      : (state.nextCursor ? "本页没有匹配，可继续加载" : (query === "" ? "输入关键词开始搜索" : "没有找到笔记"));
    host.append(empty);
    appendSearchMore({ host, state, onLoadMore });
    return;
  }

  const terms = extractHighlightTerms(query ?? "");
  const caseSensitive = state.caseSensitive === true;
  const collapsed = state.collapsedGroups instanceof Set ? state.collapsedGroups : new Set();
  const list = document.createElement("div");
  list.className = "search-results";
  for (const item of state.items) {
    const row = toSearchRow(item);
    const snippets = Array.isArray(item?.snippets) ? item.snippets.map((text) => String(text ?? "")).filter(Boolean) : [];
    const isCollapsed = collapsed.has(row.path);
    list.append(buildGroup({ row, snippets, terms, caseSensitive, isCollapsed, current: Boolean(isCurrent?.(row.path)), onNote, onToggleGroup }));
  }
  host.append(list);
  appendSearchMore({ host, state, onLoadMore });
}

function buildGroup({ row, snippets, terms, caseSensitive, isCollapsed, current, onNote, onToggleGroup }) {
  const group = document.createElement("div");
  group.className = "search-group";
  group.dataset.searchGroup = row.path;

  const head = document.createElement("div");
  head.className = "search-group-head";
  head.append(buildToggle({ row, isCollapsed, onToggleGroup }));
  head.append(buildTitle({ row, current, onNote }));
  const count = document.createElement("span");
  count.className = "search-group-count";
  count.textContent = String(row.matchCount);
  count.title = `${row.matchCount} 处命中`;
  head.append(count);
  group.append(head);

  const rows = document.createElement("div");
  rows.className = "search-group-rows";
  rows.hidden = isCollapsed;
  for (const snippet of snippets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-snippet-row";
    button.dataset.path = row.path;
    button.title = row.path;
    button.hidden = isCollapsed;
    const text = document.createElement("span");
    text.className = "search-snippet";
    appendHighlighted(text, snippet, terms, caseSensitive);
    button.append(text);
    button.onclick = () => onNote(row.path);
    rows.append(button);
  }
  group.append(rows);
  return group;
}

function buildToggle({ row, isCollapsed, onToggleGroup }) {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "search-group-toggle";
  toggle.setAttribute(SEARCH_GROUP_TOGGLE_ATTR, "true");
  toggle.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  toggle.title = isCollapsed ? "展开命中摘录" : "折叠命中摘录";
  toggle.setAttribute("aria-label", `${isCollapsed ? "展开" : "折叠"} ${row.name || row.path}`);
  toggle.onclick = () => onToggleGroup?.(row.path);
  const chevron = groupChevron(toggle.ownerDocument ?? globalThis.document);
  if (chevron) toggle.append(chevron);
  return toggle;
}

function buildTitle({ row, current, onNote }) {
  const title = document.createElement("button");
  title.type = "button";
  title.className = `note search-group-title${current ? " active" : ""}`;
  if (current) title.setAttribute("aria-current", "page");
  title.dataset.path = row.path;
  title.title = row.path;
  const label = document.createElement("span");
  label.className = "note-title";
  label.textContent = row.name || row.path;
  title.append(label);
  title.onclick = () => onNote(row.path);
  return title;
}

function appendText(parent, value) {
  const doc = parent.ownerDocument ?? globalThis.document;
  if (typeof doc?.createTextNode === "function") {
    parent.append(doc.createTextNode(value));
    return;
  }
  // Minimal test shims have no createTextNode; a plain span renders the same text.
  const span = doc.createElement("span");
  span.textContent = value;
  parent.append(span);
}

function appendHighlighted(parent, text, terms, caseSensitive) {
  for (const segment of highlightSegments(text, terms, { caseSensitive })) {
    if (!segment.match) {
      appendText(parent, segment.text);
      continue;
    }
    const mark = document.createElement("mark");
    mark.textContent = segment.text;
    parent.append(mark);
  }
}

// One sentinel, owned by this module: a search page that has a cursor must offer a
// way to continue it, and it must not be re-entrant while a page is in flight.
export function appendSearchMore({ host, state, onLoadMore }) {
  if (!state.nextCursor) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-load-more search-load-more";
  button.setAttribute(SEARCH_MORE_ATTR, "true");
  button.disabled = state.loading;
  button.textContent = state.loading ? "正在加载…" : "加载更多";
  button.onclick = () => {
    if (button.disabled) return;
    onLoadMore();
  };
  host.append(button);
}

// Patch only the sentinel chrome (disabled + label) so a DOM-reusing render does not
// have to rebuild the result rows while a page is loading.
export function syncSearchChrome({ host, state }) {
  const button = host.querySelector(`.search-load-more[${SEARCH_MORE_ATTR}]`);
  if (!button) return;
  button.disabled = state.loading;
  button.textContent = state.loading ? "正在加载…" : "加载更多";
}
