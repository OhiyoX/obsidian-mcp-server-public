// Repository-level Tags panel (desktop Tags view replica).
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Obsidian Web 笔记信息侧栏.md
// (标签：全库标签计数、点击筛选与嵌套标签). The panel is Vault-scoped, not
// document-scoped: it keeps its content across note/Base switches.
//
// Data comes from GET /api/web/v1/tags (index-only Catalog aggregate), whose `tag`
// text is the canonical `note_tags` projection (lowercased, no leading `#`, `/`
// hierarchy preserved).
//
// Nested tags render as a `/`-grouped parent/child tree; a parent row counts itself
// plus every descendant (desktop behavior). Parent collapse is local state persisted
// in localStorage, and clicking any tag runs the existing `tag:#<path>` search by
// writing the shared search box and dispatching its real `input` event, so the
// current debounce/state flow is reused unchanged.
//
// U35 (#407): the sort menu is driven by the shared `ui/popup-menu.js` primitive, which is
// the only writer of `sortMenu.hidden` / `sortToggle[aria-expanded]` and owns the toggle
// click, outside dismissal, Escape (focus returns to the sort toggle) and Arrow/Home/End
// navigation. The menu sits in the `"context-sidebar"` interaction scope with the two
// note-context `⋮` menus, so it is independent of the topbar menus.
import { createPopupMenuController } from "../../ui/popup-menu.js";
// U38 (#571): the sprite URL (with its published content hash) comes from the one resolver.
import { spriteIcon } from "../../ui/icons.js";

export const TAGS_MESSAGES = {
  empty: "没有标签",
  noMatch: "没有匹配的标签",
  error: "标签加载失败",
};

export const TAGS_API_LIMIT = 500;
const COLLAPSED_KEY = "obsidian-web.tags-collapsed";
const SORT_KEY = "obsidian-web.tags-sort";
const DEFAULT_SORT = { sort: "count", direction: "desc" };

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sameOrChild(path, parent) {
  return path === parent || path.startsWith(`${parent}/`);
}

// `tags: [{ tag, count }]` -> `/`-grouped roots. Intermediate nodes that are not
// themselves tags keep `count: 0` but still aggregate their descendants in `total`.
export function buildTagTree(tags = []) {
  const index = new Map();
  const roots = [];
  const ensure = (path) => {
    const existing = index.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const node = { path, name: slash < 0 ? path : path.slice(slash + 1), count: 0, total: 0, children: [] };
    index.set(path, node);
    if (slash < 0) roots.push(node);
    else ensure(path.slice(0, slash)).children.push(node);
    return node;
  };
  for (const item of tags) {
    const path = String(item?.tag ?? "");
    const count = Number(item?.count ?? 0);
    if (!path || !Number.isFinite(count)) continue;
    ensure(path).count += count;
  }
  const accumulate = (node) => {
    let total = node.count;
    for (const child of node.children) total += accumulate(child);
    node.total = total;
    return total;
  };
  for (const root of roots) accumulate(root);
  return roots;
}

// In-place sibling ordering. `count` uses `total` (self + descendants) with an
// always-ascending tag name tie-break; `name` follows the requested direction.
// Deterministic: repeated sorts of the same input produce the same order.
export function sortTagTree(nodes, { sort = DEFAULT_SORT.sort, direction = DEFAULT_SORT.direction } = {}) {
  const factor = direction === "asc" ? 1 : -1;
  nodes.sort((left, right) => {
    if (sort === "name") return factor * compareText(left.path, right.path);
    return factor * (left.total - right.total) || compareText(left.path, right.path);
  });
  for (const node of nodes) sortTagTree(node.children, { sort, direction });
  return nodes;
}

// Substring filter that keeps every ancestor of a match so the hierarchy survives.
// An empty/blank filter returns the input untouched.
export function filterTagTree(nodes, filter) {
  const needle = String(filter ?? "").trim().toLowerCase();
  if (!needle) return nodes;
  const prune = (list) =>
    list
      .map((node) => ({ ...node, children: prune(node.children) }))
      .filter((node) => node.path.toLowerCase().includes(needle) || node.children.length > 0);
  return prune(nodes);
}

// Flat `[path, total]` pairs in render order — the assertion surface for tests.
export function flattenTagTree(nodes) {
  const rows = [];
  for (const node of nodes) {
    rows.push([node.path, node.total]);
    rows.push(...flattenTagTree(node.children));
  }
  return rows;
}

function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    return raw === null || raw === undefined ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is best-effort: a blocked/absent localStorage must not break the panel.
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createTagsPanel({
  host = null,
  sortToggle = null,
  sortMenu = null,
  filterToggle = null,
  filterRow = null,
  filterInput = null,
  searchInput = null,
  fetchImpl = globalThis.fetch,
  storage = null,
  apiBase = "/api/web/v1/tags",
  limit = TAGS_API_LIMIT,
  documentRef = globalThis.document,
} = {}) {
  const store = storage ?? defaultStorage();
  const saved = readJson(store, SORT_KEY, DEFAULT_SORT);
  const savedCollapsed = readJson(store, COLLAPSED_KEY, []);
  const state = {
    sort: saved?.sort === "name" ? "name" : "count",
    direction: saved?.direction === "asc" ? "asc" : "desc",
    filter: "",
    collapsed: new Set(Array.isArray(savedCollapsed) ? savedCollapsed : []),
    tags: [],
    status: "idle",
    error: null,
  };
  let destroyed = false;

  // A page without the panel markup (older fixtures) yields a complete no-op.
  if (!host) {
    return {
      load: async () => {}, refresh: async () => {}, setFilter: () => {}, getState: () => ({ ...state }),
      isCollapsed: () => false, destroy: () => {},
    };
  }

  function syncMenu() {
    for (const option of sortMenu?.querySelectorAll?.("[data-tags-sort]") ?? []) {
      option.setAttribute("aria-checked", String(option.getAttribute("data-tags-sort") === state.sort));
    }
    for (const option of sortMenu?.querySelectorAll?.("[data-tags-direction]") ?? []) {
      option.setAttribute("aria-checked", String(option.getAttribute("data-tags-direction") === state.direction));
    }
  }

  // The primitive is the only writer of the menu's `hidden` / `aria-expanded`; a panel
  // without the sort markup (older fixtures) simply gets no controller.
  const sortPopup = sortMenu && sortToggle
    ? createPopupMenuController({
      trigger: sortToggle,
      popup: sortMenu,
      scope: "context-sidebar",
      restoreFocus: true,
      documentRef,
    })
    : null;

  function isCollapsed(path) {
    return state.collapsed.has(path);
  }

  function rowElement(node, expanded) {
    const owner = host.ownerDocument ?? globalThis.document;
    const item = owner.createElement("li");
    item.className = "tag-node";
    item.setAttribute("data-tag-path", node.path);

    const row = owner.createElement("div");
    row.className = "tag-row";

    const hasChildren = node.children.length > 0;
    // Flat tags render flush-left like desktop; only a real parent owns a twisty.
    if (hasChildren) {
      const twisty = owner.createElement("button");
      twisty.className = "tag-collapse";
      twisty.setAttribute("type", "button");
      twisty.setAttribute("tabindex", "-1");
      twisty.setAttribute("aria-label", `${expanded ? "折叠" : "展开"} ${node.path}`);
      twisty.setAttribute("aria-expanded", String(expanded));
      twisty.setAttribute("data-tag-toggle", node.path);
      // U38 (#571): the sprite URL comes from the shared resolver, never a bundle literal.
      const chevron = spriteIcon(owner, "chevron-right", `svg-icon tag-chevron${expanded ? " is-expanded" : ""}`);
      if (chevron) twisty.append(chevron);
      // Direct listener (not a delegated one) so the control works identically in the
      // real DOM and in the project's lightweight Node DOM harness.
      twisty.addEventListener("click", () => toggleCollapsed(node.path));
      row.append(twisty);
    }

    const label = owner.createElement("button");
    label.className = "tag-item";
    label.setAttribute("type", "button");
    label.setAttribute("data-tag", node.path);
    label.setAttribute("title", `tag:#${node.path}`);
    label.setAttribute("aria-label", `搜索标签 #${node.path}（${node.total}）`);
    const name = owner.createElement("span");
    name.className = "tag-name";
    name.textContent = node.name;
    const count = owner.createElement("span");
    count.className = "tag-count";
    count.textContent = String(node.total);
    label.append(name, count);
    label.addEventListener("click", () => openTag(node.path));

    row.append(label);
    item.append(row);
    if (hasChildren && expanded) {
      const children = owner.createElement("ul");
      children.className = "tag-children";
      for (const child of node.children) children.append(rowElement(child, shouldExpand(child)));
      item.append(children);
    }
    return item;
  }

  function shouldExpand(node) {
    // An active filter always reveals matches; otherwise parent collapse wins.
    return state.filter.trim().length > 0 || !isCollapsed(node.path);
  }

  function renderMessage(text) {
    host.textContent = "";
    const owner = host.ownerDocument ?? globalThis.document;
    const empty = owner.createElement("div");
    empty.className = "context-empty";
    empty.textContent = text;
    host.append(empty);
  }

  function render() {
    if (state.status === "loading" && state.tags.length === 0) return renderMessage("正在读取标签…");
    if (state.status === "error") return renderMessage(TAGS_MESSAGES.error);
    if (state.tags.length === 0) return renderMessage(TAGS_MESSAGES.empty);
    const visible = filterTagTree(sortTagTree(buildTagTree(state.tags), state), state.filter);
    if (visible.length === 0) return renderMessage(TAGS_MESSAGES.noMatch);
    host.textContent = "";
    const owner = host.ownerDocument ?? globalThis.document;
    const tree = owner.createElement("ul");
    tree.className = "tag-tree";
    for (const node of visible) tree.append(rowElement(node, shouldExpand(node)));
    host.append(tree);
    syncMenu();
  }

  async function load() {
    if (destroyed) return;
    state.status = "loading";
    render();
    const url = `${apiBase}?sort=${state.sort}&direction=${state.direction}&limit=${limit}`;
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`tags request failed: ${response.status}`);
      const payload = await response.json();
      state.tags = Array.isArray(payload?.tags) ? payload.tags : [];
      state.status = "ready";
      state.error = null;
    } catch (error) {
      state.status = "error";
      state.error = error?.message ?? String(error);
    }
    if (!destroyed) render();
  }

  function persistSort() {
    writeJson(store, SORT_KEY, { sort: state.sort, direction: state.direction });
  }

  function setSort(sort) {
    if (sort !== "name" && sort !== "count") return;
    if (state.sort === sort) return;
    state.sort = sort;
    persistSort();
    syncMenu();
    load();
  }

  function setDirection(direction) {
    if (direction !== "asc" && direction !== "desc") return;
    if (state.direction === direction) return;
    state.direction = direction;
    persistSort();
    syncMenu();
    load();
  }

  function setFilter(value) {
    state.filter = String(value ?? "");
    render();
  }

  function toggleCollapsed(path) {
    if (state.collapsed.has(path)) state.collapsed.delete(path);
    else state.collapsed.add(path);
    writeJson(store, COLLAPSED_KEY, [...state.collapsed]);
    render();
  }

  // Reuse the real search flow: the shared search controller listens for `input`
  // and owns debounce, state and loadNotes. No search semantics change here.
  function openTag(path) {
    if (!searchInput) return false;
    searchInput.value = `tag:#${path}`;
    const EventCtor = globalThis.Event;
    searchInput.dispatchEvent(
      typeof EventCtor === "function" ? new EventCtor("input", { bubbles: true }) : { type: "input" },
    );
    searchInput.focus?.();
    return true;
  }

  const onFilterToggle = () => {
    const opening = filterRow?.hidden !== false;
    if (filterRow) filterRow.hidden = !opening;
    filterToggle?.setAttribute?.("aria-pressed", String(opening));
    if (opening) filterInput?.focus?.();
    else if (state.filter) {
      if (filterInput) filterInput.value = "";
      setFilter("");
    }
  };
  const onFilterInput = (event) => setFilter(event.target?.value);

  // Static sort options keep their own listeners (again, no delegation). Picking one closes
  // the menu through the primitive, which is what returns the focus to the sort toggle.
  const sortOptionBindings = [];
  const bindSortOptions = () => {
    for (const option of sortMenu?.querySelectorAll?.("[data-tags-sort]") ?? []) {
      sortOptionBindings.push([option, "click", () => { sortPopup?.close(); setSort(option.getAttribute("data-tags-sort")); }]);
    }
    for (const option of sortMenu?.querySelectorAll?.("[data-tags-direction]") ?? []) {
      sortOptionBindings.push([option, "click", () => { sortPopup?.close(); setDirection(option.getAttribute("data-tags-direction")); }]);
    }
    for (const [element, type, listener] of sortOptionBindings) element.addEventListener(type, listener);
  };
  bindSortOptions();

  // The primitive starts the menu closed, so there is no initial write to make here.
  filterToggle?.addEventListener?.("click", onFilterToggle);
  filterInput?.addEventListener?.("input", onFilterInput);
  syncMenu();

  return {
    load,
    refresh: load,
    setSort,
    setDirection,
    setFilter,
    toggleCollapsed,
    isCollapsed,
    isSortOpen: () => sortPopup?.isOpen() ?? false,
    getState: () => ({ ...state, collapsed: [...state.collapsed] }),
    destroy() {
      destroyed = true;
      sortPopup?.destroy();
      filterToggle?.removeEventListener?.("click", onFilterToggle);
      filterInput?.removeEventListener?.("input", onFilterInput);
      for (const [element, type, listener] of sortOptionBindings) element.removeEventListener(type, listener);
    },
  };
}
