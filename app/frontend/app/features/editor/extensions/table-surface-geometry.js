import { ViewPlugin } from "@codemirror/view";
import { computeBalancedTableColumns } from "../../document/table-layout.js";
import {
  TABLE_PANE_SAFETY,
  computeTableOverflowGeometry,
  measureLiveTableMetrics,
} from "../../document/table-overflow-geometry.js";

function tableRows(table) {
  return [...table.rows].map((row) => [...row.cells].map((cell) => (
    cell.querySelector(".cm-table-cell-editor")?.dataset.sourceValue
      ?? cell.textContent
      ?? ""
  )));
}

function numericStyle(style, key) {
  return Number.parseFloat(style?.[key]) || 0;
}

function tableLayoutOptions(table, availableWidth) {
  const sampleCell = table.rows?.[0]?.cells?.[0] || null;
  const sampleEditor = sampleCell?.querySelector?.(".cm-table-cell-editor") || null;
  const win = table.ownerDocument?.defaultView;
  const cellStyle = sampleCell && win?.getComputedStyle ? win.getComputedStyle(sampleCell) : null;
  const editorStyle = sampleEditor && win?.getComputedStyle ? win.getComputedStyle(sampleEditor) : null;
  const fontSize = numericStyle(editorStyle, "fontSize");
  const chrome = numericStyle(editorStyle, "paddingLeft")
    + numericStyle(editorStyle, "paddingRight")
    + numericStyle(cellStyle, "borderLeftWidth")
    + numericStyle(cellStyle, "borderRightWidth");
  return {
    availableWidth,
    cellChromePx: chrome || 18,
    unitPx: fontSize > 0 ? fontSize / 2 : 7.2,
  };
}

function ensureBalancedColgroup(table, layout) {
  let colgroup = table.querySelector('colgroup[data-table-layout="balanced"]');
  if (!colgroup || colgroup.children.length !== layout.widths.length) {
    colgroup?.remove();
    colgroup = table.ownerDocument.createElement("colgroup");
    colgroup.dataset.tableLayout = "balanced";
    for (let index = 0; index < layout.widths.length; index += 1) {
      colgroup.append(table.ownerDocument.createElement("col"));
    }
    table.prepend(colgroup);
  }
  layout.widths.forEach((width, index) => {
    colgroup.children[index].style.width = `${width}px`;
  });
}

function measureTableGeometry(view, shell, metrics) {
  const viewport = shell.querySelector(".cm-table-viewport");
  const table = viewport?.querySelector(".cm-live-table-element");
  if (!viewport || !table) return null;

  // Column allocation is based on the readable prose column. The table viewport
  // may then grow symmetrically into real pane gutters, but the allocator itself
  // must not mistake those gutters for a reason to make every narrow table huge.
  const columnWidth = Math.max(1, metrics.columnWidth);
  const rows = tableRows(table);
  const sourceSignature = rows.map((row) => row.join("\u241f")).join("\u241e");
  const layout = computeBalancedTableColumns(
    rows,
    tableLayoutOptions(table, columnWidth),
  );
  if (!layout.widths.length) return null;

  const geometry = computeTableOverflowGeometry(
    layout.totalWidth,
    columnWidth,
    metrics.paneWidth,
    {
      paneLeft: metrics.paneLeft,
      paneRight: metrics.paneRight,
      columnLeft: metrics.columnLeft,
      columnRight: metrics.columnRight,
      safety: TABLE_PANE_SAFETY,
    },
  );
  const signature = [
    Math.floor(columnWidth * 2) / 2,
    Math.floor(metrics.paneWidth * 2) / 2,
    Math.floor(metrics.columnLeft * 2) / 2,
    Math.floor(geometry.visibleWidth * 2) / 2,
    geometry.overflow ? "overflow" : "fit",
    layout.widths.map((width) => Math.floor(width * 2) / 2).join(","),
    sourceSignature,
  ].join(":");
  return {
    viewport,
    table,
    layout,
    geometry,
    signature,
    columnWidth,
  };
}

function writeTableGeometry(measurement) {
  const {
    viewport,
    table,
    layout,
    geometry,
    signature,
    columnWidth,
  } = measurement;
  if (viewport.dataset.tableLayoutSignature === signature) return false;

  ensureBalancedColgroup(table, layout);
  table.style.setProperty("--table-layout-width", `${layout.totalWidth}px`);
  table.dataset.columnLayout = "balanced";
  table.dataset.tableOverflow = geometry.overflow ? "true" : "false";

  viewport.style.setProperty("--table-v2-viewport-width", `${geometry.visibleWidth}px`);
  viewport.style.setProperty("--table-symmetric-extension", `${geometry.extension}px`);
  viewport.dataset.tableOverflow = geometry.overflow ? "true" : "false";
  if (!geometry.overflow && Math.abs(viewport.scrollLeft) > 0.5) viewport.scrollLeft = 0;
  viewport.dataset.tableLayoutSignature = signature;
  viewport.dataset.tableColumnWidth = String(columnWidth);
  viewport.dataset.tableVisibleWidth = String(geometry.visibleWidth);
  viewport.dataset.tableSymmetricExtension = String(geometry.extension);
  return true;
}

function measureTableViewports(view) {
  const metrics = measureLiveTableMetrics(view);
  return [...view.contentDOM.querySelectorAll(".cm-table-widget")]
    .map((shell) => measureTableGeometry(view, shell, metrics))
    .filter(Boolean);
}

function writeTableViewports(measurements) {
  let changed = false;
  for (const measurement of measurements) {
    changed = writeTableGeometry(measurement) || changed;
  }
  return changed;
}

function readDetachedTableGeometry(view, shell) {
  if (shell.isConnected) {
    return measureTableGeometry(view, shell, measureLiveTableMetrics(view));
  }

  // The allocator intentionally inherits Obsidian's real table/header font and
  // border tokens. A detached widget has no computed theme style, so attach it
  // for one synchronous, invisible style probe outside CodeMirror's contentDOM.
  // This preserves the exact pre-v2.11 allocator inputs without exposing an
  // unbalanced table to the editor height map or MutationObserver surface.
  const host = view.dom.closest(".markdown-source-view") || view.dom.parentElement || view.dom;
  const previous = {
    position: shell.style.position,
    visibility: shell.style.visibility,
    pointerEvents: shell.style.pointerEvents,
    inset: shell.style.inset,
  };
  shell.style.position = "absolute";
  shell.style.visibility = "hidden";
  shell.style.pointerEvents = "none";
  shell.style.inset = "0 auto auto -100000px";
  host.append(shell);
  try {
    return measureTableGeometry(view, shell, measureLiveTableMetrics(view));
  } finally {
    shell.remove();
    shell.style.position = previous.position;
    shell.style.visibility = previous.visibility;
    shell.style.pointerEvents = previous.pointerEvents;
    shell.style.inset = previous.inset;
  }
}

export function primeTableSurfaceGeometry(view, shell) {
  // WidgetType.toDOM runs before CodeMirror inserts the block into contentDOM.
  // Prime with the same theme-derived allocator inputs used by later measured
  // passes so the first observable frame already owns its final wrapping.
  const measurement = readDetachedTableGeometry(view, shell);
  if (!measurement) return false;
  return writeTableGeometry(measurement);
}

function horizontalWheelDelta(event, viewport) {
  let delta = Number(event.deltaX) || 0;
  if (Math.abs(delta) < 0.5 && event.shiftKey) delta = Number(event.deltaY) || 0;
  if (Math.abs(delta) < 0.5) return 0;
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
  return delta * factor;
}

function tableForDOMSelection(view, selection) {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  for (const table of view.contentDOM.querySelectorAll(".cm-table-widget")) {
    try {
      if (range.intersectsNode(table)) return table;
    } catch {
      // Detached widgets can race a syntax refresh. Treat them as non-owners.
    }
  }
  return null;
}

function rootCaretTouchesTableSource(view) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const head = selection.head;
  for (const table of view.contentDOM.querySelectorAll(".cm-table-widget")) {
    const from = Number(table.dataset.tableFrom);
    const to = Number(table.dataset.tableTo);
    if (Number.isInteger(from) && Number.isInteger(to) && head >= from && head <= to) return true;
  }
  return false;
}

export const tableSurfaceGeometry = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.measureKey = {};
    this.destroyed = false;
    this.onWheel = (event) => {
      const viewport = event.target?.closest?.(".cm-table-viewport");
      if (!viewport || !this.view.scrollDOM.contains(viewport)) return;
      if (viewport.dataset.tableOverflow !== "true") return;
      if (viewport.scrollWidth <= viewport.clientWidth + 1) return;
      const delta = horizontalWheelDelta(event, viewport);
      if (!delta) return;
      const before = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (Math.abs(viewport.scrollLeft - before) > 0.5) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Listen at the root scroller in capture phase. CodeMirror owns the outer
    // scroller and may consume wheel input before a nested widget's bubble
    // listener sees it; this guarantees horizontal trackpad input is routed to
    // the one table viewport without moving the document.
    view.scrollDOM.addEventListener("wheel", this.onWheel, { passive: false, capture: true });
    this.interactionHost = view.dom.closest(".markdown-source-view") || view.dom;
    this.onSelectionChange = () => {
      if (!this.interactionHost.classList.contains("cm-table-dom-selection-active")) return;
      const selection = view.dom.ownerDocument.getSelection?.();
      if (!tableForDOMSelection(this.view, selection)) {
        this.interactionHost.classList.remove("cm-table-dom-selection-active");
      }
    };
    this.onCopy = (event) => {
      if (!this.interactionHost.classList.contains("cm-table-dom-selection-active")) return;
      const selection = this.view.dom.ownerDocument.getSelection?.();
      if (!tableForDOMSelection(this.view, selection)) return;
      const text = selection.toString();
      if (!text || !event.clipboardData) return;

      // Cross-cell rendered selection is browser DOM state, not a mirrored
      // EditorState range. Own copy in capture phase so CodeMirror cannot
      // replace the visible selection with its hidden root selection payload.
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      event.stopPropagation();
    };
    view.dom.ownerDocument.addEventListener("selectionchange", this.onSelectionChange);
    view.dom.addEventListener("copy", this.onCopy, true);
    this.syncRootCaret = () => {
      this.interactionHost.classList.toggle(
        "cm-table-root-caret-suppressed",
        rootCaretTouchesTableSource(this.view),
      );
    };
    this.syncRootCaret();
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.resizeObserver.observe(view.scrollDOM);
    this.schedule();
  }

  schedule() {
    if (this.destroyed) return;
    this.view.requestMeasure({
      key: this.measureKey,
      read: (view) => measureTableViewports(view),
      write: (measurements, view) => {
        if (this.destroyed) return;
        const changed = writeTableViewports(measurements);
        this.syncRootCaret();
        // Balanced columns can change wrapping and therefore block height.
        // Ask CodeMirror to refresh its height map in its own next measure
        // cycle instead of leaving ResizeObserver/browser layout to race it.
        if (changed) view.requestMeasure();
      },
    });
  }

  update(update) {
    this.view = update.view;
    if (update.docChanged || update.viewportChanged || update.geometryChanged) this.schedule();
    else if (update.selectionSet) this.syncRootCaret();
  }

  docViewUpdate(view) {
    this.view = view;
    this.schedule();
  }

  destroy() {
    this.destroyed = true;
    this.view.scrollDOM.removeEventListener("wheel", this.onWheel, true);
    this.view.dom.ownerDocument.removeEventListener("selectionchange", this.onSelectionChange);
    this.view.dom.removeEventListener("copy", this.onCopy, true);
    this.interactionHost.classList.remove(
      "cm-table-dom-selection-active",
      "cm-table-dom-edit-active",
      "cm-table-root-caret-suppressed",
    );
    this.resizeObserver.disconnect();
  }
});
