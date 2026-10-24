// Read-only Base surface renderer. Owns only `host`'s subtree; it never touches
// other document nodes and never injects HTML. All untrusted text (path, view
// name, column label, formula label, cell value) goes through textContent.
//
// Styling is shipped as a class contract (styles.js). The wiring layer (B4) may
// inject BASE_SURFACE_CSS; tests never rely on a global stylesheet. The view
// selector is a real `<select data-select>`: the injected `enhance(root)` hook turns
// it into the app's custom dropdown right after every mount. User-facing text lives
// in labels.js (built-in property names + surface sentences).
//
// Coarse pointer (#337 Cut 3): the capability is read from the injected
// `windowObject` and only ever *adds* the touch affordance (tap selects a row);
// a fine pointer — every desktop check — renders and behaves exactly as before.

import { createCellNode, createSpriteIcon, describeCellValue, EMPTY_CELL_TOKEN } from "./cell.js";
import { createRowLayouts } from "./row-layouts.js";
import { buildKanbanLazily } from "./kanban-lazy.js";
import { BASE_SURFACE_CSS } from "./styles.js";
import {
  readViewConfig,
  resolveColumnWidths,
  hideAllColumns,
  toggleColumnVisibility,
  visibleColumns,
  withColumnWidth,
  writeViewConfig,
  readViewOptions,
  baseViewConfigKey,
} from "./view-config.js";
import { attachColumnResize, createColGroup, createResizeHandle, totalColumnWidth } from "./resize.js";
import {
  BASE_BUSY_TEXT, BASE_EMPTY_TEXT, BASE_LOAD_MORE_TEXT, BASE_RETRY_TEXT, BASE_STALE_CODE, BASE_STALE_TEXT,
} from "./labels.js";
import { isCoarsePointer, nextSelectionKey } from "./pointer-policy.js";
import { createBaseToolbar } from "./toolbar.js";
import { appendGroupedRows, rebuildsOnAppend } from "./group-heading.js";
import {
  BASE_VIEW_TYPE_CARDS,
  BASE_VIEW_TYPE_KANBAN,
  BASE_VIEW_TYPE_LIST,
  normalizeViewType,
  resolveViewOptions,
} from "./view-options.js";

export { BASE_SURFACE_CSS };

function emptyCellDescriptor() { return { type: "empty", text: EMPTY_CELL_TOKEN }; }

function valueFor(row, column, index) {
  if (!row || typeof row !== "object") return undefined;
  const values = row.values;
  if (Array.isArray(values)) return values[index];
  if (values && typeof values === "object") return values[column.key];
  return undefined;
}

// Small header glyphs only when a column can be inferred from its key; no
// invented column metaphors (desktop Bases parity, TODO DESIGN-2 item 6).
function columnIconName(column) {
  const key = String(column?.key ?? "");
  if (/^(?:date|created|updated|modified|published|due)$/i.test(key)) return "calendar";
  if (/link/i.test(key)) return "link";
  return null;
}

export function createBaseView({
  doc,
  host,
  onOpenNote,
  onSelectView,
  onLoadMore,
  onRetry,
  onSort,
  onFilter,
  onGroup,
  onQuery,
  onToggleColumn,
  onNewNote,
  onRerender,
  enhance = null,
  storage = null,
  windowObject = null,
} = {}) {
  const refs = { root: null, rowHost: null, footer: null, loadMore: null, viewSelect: null, count: null };
  let currentState = null;
  let currentColumns = [];
  let currentViewType = "table";
  let currentOptions = {};
  let currentCardsOptions = null;
  // Handed to the on-demand kanban asset: the raw stored options and the cards half.
  let currentStoredOptions = {};
  let resize = null;
  // Handle returned by the injected `enhance(root)` hook. Every render replaces the whole
  // subtree, so the previous call's document listeners must be released here (#409 review).
  let enhanceHandle = null;
  // Row identity of the tap-selected row (#337 Cut 3, coarse pointer only).
  let selectedKey = null;

  const configStorage = storage ?? (() => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  })();

  const toolbar = createBaseToolbar({
    doc,
    onSelectView,
    onSort,
    onFilter,
    onGroup,
    onQuery,
    onToggleColumn: (key) => {
      const state = currentState;
      if (!state) return;
      const keyOfConfig = configKey(state);
      const next = toggleColumnVisibility(readViewConfig(configStorage, keyOfConfig), key, state.columns);
      writeViewConfig(configStorage, keyOfConfig, next);
      onRerender?.();
    },
    // Desktop "全部隐藏": the explicit bulk action of the Properties popover. The
    // per-column checkbox path still refuses to hide the last visible column.
    onHideAllColumns: () => {
      const state = currentState;
      if (!state) return;
      const keyOfConfig = configKey(state);
      const next = hideAllColumns(readViewConfig(configStorage, keyOfConfig), state.columns);
      writeViewConfig(configStorage, keyOfConfig, next);
      onRerender?.();
    },
    onNewNote,
  });

  function configKey(state) {
    return baseViewConfigKey({ vaultId: state?.vaultId ?? null, path: state?.path ?? null, view: state?.view ?? null });
  }

  function applyColumnWidth(config, columnKey, width) {
    const state = currentState;
    if (!state) return;
    const key = configKey(state);
    writeViewConfig(configStorage, key, withColumnWidth(config, columnKey, width));
    onRerender?.();
  }

  function rowKey(row, index) {
    const path = row && typeof row === "object" ? row.path : null;
    return typeof path === "string" && path.length > 0 ? path : `#row-${index}`;
  }

  // A tap on a cell selects its row; a tap on a link cell must not, because the
  // link button stops the click at its own handler (see cell.js). The handler
  // deliberately does not inspect `event.target`: `stopPropagation` on the link is
  // the load-bearing contract, and a target check would silently duplicate it.
  function applyRowSelection(key, tr) {
    selectedKey = nextSelectionKey(selectedKey, key);
    if (refs.rowHost && typeof refs.rowHost.querySelectorAll === "function") {
      for (const row of refs.rowHost.querySelectorAll('[aria-selected="true"]')) setRowSelected(row, false);
    }
    if (selectedKey !== null) setRowSelected(tr, true);
  }

  function setRowSelected(tr, selected) {
    if (!tr) return;
    if (selected) {
      tr.setAttribute("aria-selected", "true");
      tr.classList.add("is-selected");
    } else {
      tr.removeAttribute("aria-selected");
      tr.classList.remove("is-selected");
    }
  }

  function valueNode(row, column, columnIndex) {
    const descriptor = describeCellValue(valueFor(row, column, columnIndex), column.kind);
    return createCellNode(doc, descriptor ?? emptyCellDescriptor(), { onOpenNote });
  }

  function createRow(row, columns, index = 0) {
    const tr = doc.createElement("tr");
    tr.className = "base-row";
    const key = rowKey(row, index);
    // The row identity is view-type independent: the list/cards surfaces carry the
    // same `data-row-id`, so a probe can diff the row set across view types.
    tr.setAttribute("data-row-id", key);
    if (key === selectedKey) setRowSelected(tr, true);
    if (isCoarsePointer(windowObject ?? globalThis)) {
      tr.addEventListener("click", () => applyRowSelection(key, tr));
    }
    columns.forEach((column, columnIndex) => {
      const td = doc.createElement("td");
      td.className = "base-cell";
      td.appendChild(valueNode(row, column, columnIndex));
      tr.appendChild(td);
    });
    return tr;
  }

  // ---- list + cards --------------------------------------------------------
  // The two non-table layouts live in row-layouts.js; they share this surface's row
  // identity (`data-row-id`), selection and cell codec, and only differ in boxes.
  const layouts = createRowLayouts({
    doc,
    coarse: isCoarsePointer(windowObject ?? globalThis),
    valueNode,
    valueFor,
    rowKey,
    select: (key, node) => applyRowSelection(key, node),
    isSelected: (key) => key === selectedKey,
    markSelected: (node, selected) => setRowSelected(node, selected),
  });

  // Dispatcher for the eager layouts; kanban's board is an on-demand asset (kanban-lazy.js).
  let pendingBoard = null;
  function buildRows(state, columns, widths, options) {
    if (currentViewType === BASE_VIEW_TYPE_LIST) return layouts.buildList(state, columns, options, refs);
    if (currentViewType === BASE_VIEW_TYPE_CARDS) return layouts.buildCards(state, columns, options, refs);
    if (currentViewType === BASE_VIEW_TYPE_KANBAN) {
      // The board reuses the cards layout's own item, so it gets the cards options; its
      // own `columnWidth` comes from the raw config (the lazy asset owns that slider).
      const built = buildKanbanLazily({
        doc,
        state,
        columns,
        host: refs,
        options: currentCardsOptions,
        storedOptions: currentStoredOptions,
        primitives: { createCardItem: layouts.createCardItem },
      });
      pendingBoard = built.done;
      return built;
    }
    return buildTable(state, columns, widths);
  }

  function createRowItem(row, columns, index) {
    if (currentViewType === BASE_VIEW_TYPE_LIST) return layouts.createListItem(row, columns, index, currentOptions);
    if (currentViewType === BASE_VIEW_TYPE_CARDS || currentViewType === BASE_VIEW_TYPE_KANBAN) {
      return layouts.createCardItem(row, columns, index, currentOptions);
    }
    return createRow(row, columns, index);
  }

  function renderError(state) {
    const block = doc.createElement("div");
    block.className = "base-surface-error";
    block.setAttribute("role", "alert");
    // Same rule as the stale banner: the visible sentence is user language while the
    // server `code` / status and the raw server sentence stay on the node.
    const error = state.error ?? {};
    if (error.code) block.setAttribute("data-error-code", String(error.code));
    if (error.status) block.setAttribute("data-error-status", String(error.status));
    const message = doc.createElement("span");
    message.className = "base-surface-error-message";
    message.textContent = String(error.message ?? "数据库查询失败。");
    if (typeof error.detail === "string" && error.detail) message.title = error.detail;
    block.appendChild(message);
    const retry = doc.createElement("button");
    retry.type = "button";
    retry.className = "base-retry";
    retry.textContent = BASE_RETRY_TEXT;
    retry.onclick = () => onRetry?.();
    block.appendChild(retry);
    return block;
  }

  function createFooter(state) {
    const footer = doc.createElement("div");
    footer.className = "base-surface-footer";
    if (state.nextCursor) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "base-load-more";
      // Wave C browser-contract hook (A5 selectors.loadMore).
      button.setAttribute("data-base-load-more", "");
      button.textContent = BASE_LOAD_MORE_TEXT;
      button.disabled = Boolean(state.loading);
      button.onclick = () => onLoadMore?.();
      footer.appendChild(button);
    }
    return footer;
  }

  function mount(root) {
    if (host && typeof host.replaceChildren === "function") {
      host.replaceChildren(root);
      return;
    }
    if (host && typeof host.appendChild === "function") {
      while (host.childNodes && host.childNodes.length) host.removeChild(host.childNodes[0]);
      host.appendChild(root);
    }
  }

  function buildTable(state, columns, widths) {
    const wrap = doc.createElement("div");
    wrap.className = "base-table-wrap";
    const table = doc.createElement("table");
    table.className = "base-table";
    // Wave C browser-contract hook (A5 selectors.table).
    table.setAttribute("data-base-table", "");
    table.setAttribute("role", "table");
    // `table-layout: fixed` honours the colgroup, which is what makes the drag
    // widths authoritative; min-width keeps the narrow-screen scroll intact.
    table.style.minWidth = `${totalColumnWidth(columns, widths)}px`;
    table.appendChild(createColGroup(doc, columns, widths));

    const thead = doc.createElement("thead");
    const headRow = doc.createElement("tr");
    for (const column of columns) {
      const th = doc.createElement("th");
      th.setAttribute("scope", "col");
      th.className = "base-column";
      th.setAttribute("data-column", column.key);
      const iconName = columnIconName(column);
      const glyph = iconName ? createSpriteIcon(doc, iconName, "svg-icon base-column-icon") : null;
      if (glyph) th.appendChild(glyph);
      const formula = column.kind === "formula";
      if (formula) th.setAttribute("data-column-kind", "formula");
      const label = doc.createElement("span");
      label.className = "base-column-label";
      // ƒ marks a computed column (desktop formula properties); text, so no new asset.
      label.textContent = `${formula ? "ƒ " : ""}${column.label ?? column.key ?? ""}`;
      th.appendChild(label);
      th.appendChild(createResizeHandle(doc, column.key, column.label ?? column.key));
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = doc.createElement("tbody");
    // Grouping headings live in group-heading.js (they own the desktop class family and
    // its [未证实] geometry note).
    appendGroupedRows({ doc, tbody, state, columns, createRow, valueFor });    table.appendChild(tbody);
    wrap.appendChild(table);
    refs.headRow = headRow;
    refs.table = table;
    refs.rowHost = tbody;
    return { wrap, table, headRow, tbody };
  }

  function releaseEnhance() {
    const handle = enhanceHandle; enhanceHandle = null; handle?.destroy?.();
  }
  async function render(state) {
    currentState = state;
    // The host subtree below is about to be thrown away: an open listbox must not keep eating
    // document keys after its surface was replaced.
    releaseEnhance();
    const root = doc.createElement("div");
    root.className = "base-surface";
    root.setAttribute("data-base-document-kind", "base");
    if (state.path) root.setAttribute("data-base-path", String(state.path));
    if (state.loading) root.setAttribute("aria-busy", "true");

    const config = readViewConfig(configStorage, configKey(state));
    const columns = visibleColumns(state.columns, config);
    const widths = resolveColumnWidths(columns, config);
    currentColumns = columns;
    // The declared view type is DISPLAY-METADATA (compatibility matrix §5/§12.1): it
    // selects a layout, never a different row set. Unknown / missing types keep the
    // table. The private option values are read from the per-view client store and
    // fall back to the desktop defaults (view-options.js).
    currentViewType = normalizeViewType(state.viewType);
    const storedOptions = readViewOptions(configStorage, configKey(state));
    currentOptions = resolveViewOptions(currentViewType, storedOptions);
    currentStoredOptions = storedOptions;
    currentCardsOptions = currentViewType === BASE_VIEW_TYPE_KANBAN ? resolveViewOptions(BASE_VIEW_TYPE_CARDS, storedOptions) : null;
    root.setAttribute("data-view-type", currentViewType);

    const header = toolbar.render(state, { columns, allColumns: state.columns, propertyCatalog: state.propertyCatalog, config });
    refs.viewSelect = typeof header.querySelector === "function" ? header.querySelector(".base-view-select") : null;
    refs.count = typeof header.querySelector === "function" ? header.querySelector(".base-surface-count") : null;
    root.appendChild(header);

    if (state.catalogStale) {
      const stale = doc.createElement("div");
      stale.className = "base-catalog-stale";
      stale.setAttribute("role", "status");
      // The machine-readable reason stays on the node; the sentence stays in the reader's language.
      stale.setAttribute("data-catalog-stale-code", BASE_STALE_CODE);
      stale.textContent = BASE_STALE_TEXT;
      root.appendChild(stale);
    }

    if (state.error) root.appendChild(renderError(state));

    const { wrap, table, headRow } = buildRows(state, columns, widths, currentOptions);
    root.appendChild(wrap);

    if (!state.error && !state.loading && state.rows.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "base-surface-empty";
      empty.textContent = BASE_EMPTY_TEXT;
      root.appendChild(empty);
    }

    if (state.loading) {
      const busy = doc.createElement("div");
      busy.className = "base-surface-busy";
      busy.setAttribute("role", "status");
      busy.textContent = BASE_BUSY_TEXT;
      root.appendChild(busy);
    }

    const footer = createFooter(state);
    refs.footer = footer;
    root.appendChild(footer);
    refs.root = root;
    refs.loadMore = typeof footer.querySelector === "function" ? footer.querySelector(".base-load-more") : null;

    mount(root);
    resize?.destroy?.();
    resize = headRow ? attachColumnResize({
      headRow,
      columns,
      widths,
      windowObject,
      onPreview: (key, width) => {
        const col = typeof wrap.querySelector === "function" ? wrap.querySelector(`col[data-column="${key}"]`) : null;
        if (col) col.style.width = `${width}px`;
        const next = { ...widths, [key]: width };
        table.style.minWidth = `${totalColumnWidth(columns, next)}px`;
      },
      onCommit: (key, width) => applyColumnWidth({ ...config, widths: { ...config.widths } }, key, width),
    }) : null;
    // Enhance the freshly rendered subtree (custom view dropdown), then restore
    // the toolbar's focus/interaction state.
    enhanceHandle = enhance?.(root) ?? null;
    toolbar.afterMount(header, () => render(currentState));
    // kanban: the surface is mounted; this awaits the on-demand board.
    const board = pendingBoard;
    pendingBoard = null;
    if (board) await board;
    return root;
  }

  function appendRows(rows, state) {
    currentState = state;
    // Kanban rows are grouped, so a page append cannot land at the end of the DOM:
    // the whole board is rebuilt instead (one extra render, never a mixed board).
    if (currentViewType === BASE_VIEW_TYPE_KANBAN) return render(state);
    // A grouped table cannot take a bare page append (group-heading.js).
    if (rebuildsOnAppend(state)) return render(state);
    if (!refs.rowHost || !refs.root) return render(state);
    const offset = refs.rowHost.childNodes ? refs.rowHost.childNodes.length : 0;
    rows.forEach((row, index) => refs.rowHost.appendChild(createRowItem(row, currentColumns, offset + index)));
    if (refs.count) refs.count.textContent = `${state.totalMatched} 个结果`;
    if (refs.root) {
      if (state.loading) refs.root.setAttribute("aria-busy", "true");
      else refs.root.removeAttribute("aria-busy");
    }
    const freshFooter = createFooter(state);
    if (refs.footer && refs.footer.parentNode) {
      if (typeof refs.footer.replaceWith === "function") refs.footer.replaceWith(freshFooter);
      else {
        refs.footer.parentNode.removeChild(refs.footer);
        refs.footer.parentNode.appendChild(freshFooter);
      }
    } else {
      refs.root.appendChild(freshFooter);
    }
    refs.footer = freshFooter;
    refs.loadMore = typeof freshFooter.querySelector === "function" ? freshFooter.querySelector(".base-load-more") : null;
    return refs.root;
  }

  function setBusy(state) {
    currentState = state;
    if (refs.loadMore) refs.loadMore.disabled = Boolean(state.loading);
    if (refs.root) {
      if (state.loading) refs.root.setAttribute("aria-busy", "true");
      else refs.root.removeAttribute("aria-busy");
    }
  }

  function clear() {
    currentState = null;
    currentColumns = [];
    selectedKey = null;
    releaseEnhance();
    resize?.destroy?.();
    resize = null;
    toolbar.destroy();
    refs.root = null;
    refs.rowHost = null;
    refs.footer = null;
    refs.loadMore = null;
    refs.viewSelect = null;
    refs.count = null;
    if (host && typeof host.replaceChildren === "function") host.replaceChildren();
    else if (host && host.childNodes) {
      while (host.childNodes.length) host.removeChild(host.childNodes[0]);
    }
  }

  return { render, appendRows, setBusy, clear, releaseEnhance, getCurrentState: () => currentState, getToolbar: () => toolbar, getSelectedKey: () => selectedKey };
}
