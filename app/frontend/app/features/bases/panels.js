// Interactive popovers of the Base action row: sort, filter, properties, search
// and new-note. Each popover is rebuilt from state on every render — toolbar.js
// mounts it inside the anchor of its own action button — so the transient input
// state (search text, new-note name, property filter, debounce timer) lives in
// this closure and never in the DOM.
//
// The panel bodies themselves live in panel-*.js (one file per menu) so every
// module stays inside the architecture line budget; this file only owns the
// shared transient state, the panel context and the two small panels.

import { el } from "./dom.js";
import { normalizeQuery } from "./query-state.js";
import {
  BASE_ACTION_NEW_TEXT,
  BASE_ACTION_SEARCH_TEXT,
  folderOfPath,
} from "./actions.js";
import { panelScroll, panelSection, panelShell, panelButton, withPanelChrome } from "./panel-chrome.js";
import { buildFilterPanel } from "./panel-filter.js";
import { buildPropertiesPanel } from "./panel-properties.js";
import { buildSortPanel } from "./panel-sort.js";

export { BASE_FILTER_OP_LABELS } from "./panel-filter.js";

export function createBasePanels({
  doc,
  close,
  onSort,
  onFilter,
  onQuery,
  onToggleColumn,
  onHideAllColumns,
  onNewNote,
  queryDebounceMs = 250,
  isNested = null,
  onBack = null,
} = {}) {
  let searchDraft = null;
  let propertySearch = "";
  let newName = "未命名笔记";
  let queryTimer = null;

  function clearQueryTimer() {
    if (queryTimer === null) return;
    try {
      clearTimeout(queryTimer);
    } catch {
      // ignore
    }
    queryTimer = null;
  }

  function buildSearchPanel(state) {
    const panel = panelShell(doc, "search", BASE_ACTION_SEARCH_TEXT);
    // G5: every panel body is the shell's `.menu-scroll` child (asar app.js@2369180).
    const scroll = panelScroll(doc);
    panel.appendChild(scroll);
    const row = el(doc, "div", "base-panel-row");
    const input = doc.createElement("input");
    input.className = "base-panel-input base-search-input";
    input.type = "search";
    input.setAttribute("data-search-input", "");
    input.setAttribute("data-focus", "search-input");
    input.placeholder = "搜索当前视图…";
    input.value = searchDraft ?? normalizeQuery(state.q);
    searchDraft = input.value;
    input.oninput = () => {
      searchDraft = input.value;
      clearQueryTimer();
      queryTimer = setTimeout(() => {
        queryTimer = null;
        onQuery?.(searchDraft ?? "");
      }, queryDebounceMs);
    };
    input.onkeydown = (event) => {
      if (event?.key === "Enter") {
        event.preventDefault?.();
        clearQueryTimer();
        onQuery?.(input.value);
      }
    };
    row.appendChild(input);
    if (normalizeQuery(state.q) !== "") {
      const clear = panelButton(doc, {
        text: "清除",
        attributes: { "data-search-clear": "" },
        focusKey: "search-clear",
      });
      clear.onclick = () => {
        clearQueryTimer();
        searchDraft = "";
        input.value = "";
        onQuery?.("");
      };
      row.appendChild(clear);
    }
    scroll.appendChild(row);
    return panel;
  }

  function buildNewPanel(state) {
    const panel = panelShell(doc, "new", BASE_ACTION_NEW_TEXT);
    const scroll = panelScroll(doc);
    panel.appendChild(scroll);
    const { section, content } = panelSection(doc, { label: `在 ${folderOfPath(state.path)} 中新建笔记` });
    scroll.appendChild(section);
    const row = el(doc, "div", "base-panel-row");
    const input = doc.createElement("input");
    input.className = "base-panel-input";
    input.type = "text";
    input.setAttribute("data-new-name", "");
    input.setAttribute("data-focus", "new-name");
    input.placeholder = "笔记名称";
    input.value = newName;
    input.oninput = () => {
      newName = input.value;
    };
    const create = panelButton(doc, {
      text: "创建",
      attributes: { "data-new-create": "" },
      focusKey: "new-create",
    });
    const submit = () => {
      const name = String(input.value ?? "").trim();
      if (!name) {
        input.focus?.();
        return;
      }
      newName = "未命名笔记";
      close?.();
      onNewNote?.(name);
    };
    create.onclick = submit;
    input.onkeydown = (event) => {
      if (event?.key === "Enter") {
        event.preventDefault?.();
        submit();
      }
    };
    row.appendChild(input);
    row.appendChild(create);
    content.appendChild(row);
    return panel;
  }

  // Panels must stay usable while a column is hidden: the property menus list every
  // column the view declares (`allColumns`), while the properties popover needs the
  // visible subset for its `已显示` group.
  function panelContext(context = {}) {
    const declared = Array.isArray(context.allColumns)
      ? context.allColumns
      : (Array.isArray(context.columns) ? context.columns : []);
    const visible = Array.isArray(context.visibleColumns)
      ? context.visibleColumns
      : (Array.isArray(context.columns) ? context.columns : []);
    return {
      doc,
      columns: declared,
      visibleColumns: visible,
      config: context.config ?? {},
    };
  }

  function build(panelId, state, context) {
    const shared = panelContext(context);
    const panel = buildBody(panelId, state, shared);
    // One chrome in exactly one place, so every panel body stays untouched. A page
    // deeper than the root (`isNested`) marks the panel and hands the header a real
    // back target — the desktop's `pageStack.length > 1` shape, in the same panel
    // (never a second floating layer).
    const nested = typeof isNested === "function" && isNested();
    if (panel && nested && panel.classList) panel.classList.add("is-nested");
    return withPanelChrome(doc, panel, {
      label: panel && typeof panel.getAttribute === "function" ? panel.getAttribute("aria-label") : null,
      onClose: () => close?.(),
      onBack: nested && typeof onBack === "function" ? () => onBack() : null,
    });
  }

  function buildBody(panelId, state, shared) {
    switch (panelId) {
      case "sort":
        return buildSortPanel(state, shared, { onSort });
      case "filter":
        return buildFilterPanel(state, shared, { onFilter });
      case "properties":
        return buildPropertiesPanel(state, shared, {
          onToggleColumn,
          onHideAllColumns,
          getPropertySearch: () => propertySearch,
          setPropertySearch: (value) => { propertySearch = String(value ?? ""); },
        });
      case "search":
        return buildSearchPanel(state);
      case "new":
        return buildNewPanel(state);
      default:
        return null;
    }
  }

  return {
    build,
    initialFocusKey(panelId) {
      if (panelId === "search") return "search-input";
      if (panelId === "new") return "new-name";
      return null;
    },
    destroy() {
      clearQueryTimer();
      searchDraft = null;
      propertySearch = "";
      newName = "未命名笔记";
    },
  };
}
